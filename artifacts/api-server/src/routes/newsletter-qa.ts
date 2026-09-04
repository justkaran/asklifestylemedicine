/**
 * Auto-routing newsletter Q&A — live, streaming web surface.
 *
 * POST /api/newsletter-qa  { message, history?, publication? }
 *
 * Unlike /api/embed-agent (which is HARD-LOCKED to a
 * single pillar passed in by the caller), this endpoint takes a free-form
 * reader question with NO pillar pre-chosen and AUTO-ROUTES it to the single
 * best-matching active expert (see lib/newsletterQa.ts), then streams the
 * answer in that one steward's first-person voice with the usual governed-RAG
 * citation + voice guards.
 *
 * The routing decision is computed first (non-streamed). Once an expert is
 * chosen we emit a `routed` SSE event (so the client can render "Answered by
 * X" immediately), then stream the answer. The SSE shape otherwise mirrors
 * /sleep-agent and /embed-agent so the existing client parser is reusable.
 *
 * The one-shot, non-streamed variant for the downstream email-reply pipeline
 * is the exported `answerNewsletterQuestion` from lib/newsletterQa.ts — not an
 * HTTP route — so a server-side caller never has to parse an SSE stream.
 *
 * `publication` is accepted as optional reader context (which publication the
 * question came from); routing is global across all active pillars and is NOT
 * biased by it, so the engine always picks the genuine best match.
 */
import { partnerCanaryDoi } from "../lib/ipProtection.js";
import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod/v4";
import { pool } from "@workspace/db";
import { partnerKeyMiddleware } from "../middlewares/partnerKey.js";
import { notifyKaranOfQuestion } from "../lib/karanNotify.js";
import {
  agentLicensePayload,
  agentLicensePayloadKeyed,
} from "../lib/agentLicense.js";
import {
  retrieve,
  buildContextBlock,
  buildProvenance,
  collapseSameWorkProvenance,
  serializePublicProvenance,
  verifyCitation,
  citationGuardTripped,
  CITATION_GUARD_BOUNDARY,
  type CitationVerification,
  type ProvenanceEntry,
} from "../lib/rag.js";
import {
  buildExpertSystemPrompt,
  verifyVoice,
  hasVoiceMaterial,
  type VoiceVerification,
} from "../lib/stewardVoice.js";
import { routeBestPillar, type RoutedExpert } from "../lib/newsletterQa.js";
import {
  buildSlmFallbackStream,
  notifyUncoveredQuestion,
  SLM_FALLBACK_EXPERT_NAME,
  SLM_FALLBACK_PILLAR_SLUG,
} from "../lib/slmFallback.js";

const router: IRouter = Router();

const anthropic = new Anthropic({
  baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
});

// Bound + validate the body before any SSE headers are written, so a malformed
// payload returns a clean 400 instead of throwing mid-stream and so anonymous
// callers can't send unbounded prompts.
const newsletterQaSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  lang: z.string().trim().max(10).optional(),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(4000),
      }),
    )
    .max(20)
    .optional(),
  /** Optional reader context: the publication slug the question came from. */
  publication: z.string().trim().max(200).optional(),
});

type QaOutcome = "covered" | "uncovered" | "unavailable";

/**
 * Best-effort usage row, reusing the shared `agent_queries` capture table
 * tagged `source='newsletter-qa'`. Fire-and-forget after res.end(); a logging
 * failure can never break a user-facing answer. No embedding is computed here:
 * this row exists for usage counting, not the uncovered-clustering path.
 */
function logNewsletterQaQuery(opts: {
  queryId: string;
  pillarId: number | null;
  question: string;
  outcome: QaOutcome;
  retrievedSourceIds: number[];
  retrievedInterpretationIds: number[];
  topScore: number;
  answerText: string;
  latencyMs: number;
  partnerKeyId?: number | null;
  /** LLM token usage from the Anthropic stream; null when no LLM ran. */
  inputTokens?: number | null;
  outputTokens?: number | null;
}): void {
  void pool
    .query(
      `INSERT INTO agent_queries
          (id, source, session_id, question, pillar_ids,
           retrieved_source_ids, retrieved_interpretation_ids,
           top_score, was_uncovered, answer_text, latency_ms, partner_key_id,
           input_tokens, output_tokens)
        VALUES ($1, 'newsletter-qa', 'newsletter-qa', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (id) DO NOTHING`,
      [
        opts.queryId,
        opts.question,
        opts.pillarId != null ? [opts.pillarId] : [],
        opts.retrievedSourceIds,
        opts.retrievedInterpretationIds,
        opts.topScore,
        opts.outcome !== "covered",
        opts.answerText,
        opts.latencyMs,
        opts.partnerKeyId ?? null,
        opts.inputTokens ?? null,
        opts.outputTokens ?? null,
      ],
    )
    .catch(() => {
      // Best-effort: swallow logging failures, never surface to the client.
    });
}

router.post(
  "/newsletter-qa",
  partnerKeyMiddleware("newsletter-qa", { allowFirstPartyHuman: true }),
  async (req, res): Promise<void> => {
    const parsed = newsletterQaSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    const { message, history, lang } = parsed.data;

    notifyKaranOfQuestion(req, message, "newsletter-qa");

    const queryId = randomUUID();
    const startedAt = Date.now();
    const partnerKeyId =
      (req as unknown as { partnerKey?: { id: number } }).partnerKey?.id ??
      null;
    const isPartner = partnerKeyId != null;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    // ── 1. Auto-route to the single best active expert ──────────────────
    let expert: RoutedExpert;
    let routeTopScore = 0;
    try {
      const routing = await routeBestPillar(message);

      if (routing.status === "unavailable" || routing.status === "uncovered") {
        // Fire notification email — fire-and-forget, never blocks the response.
        notifyUncoveredQuestion(message);

        // Emit routing attribution before streaming.
        res.write(
          `data: ${JSON.stringify({
            routed: true,
            expertName: SLM_FALLBACK_EXPERT_NAME,
            pillarSlug: SLM_FALLBACK_PILLAR_SLUG,
            pillarName: SLM_FALLBACK_EXPERT_NAME,
            slmFallback: true,
            queryId,
          })}

`,
        );

        let fallbackText = "";
        let fallbackInputTokens = 0;
        let fallbackOutputTokens = 0;
        try {
          const fallbackStream = buildSlmFallbackStream(message);
          for await (const event of fallbackStream) {
            if (event.type === "message_start") {
              fallbackInputTokens = event.message.usage.input_tokens;
            } else if (event.type === "message_delta") {
              fallbackOutputTokens = event.usage.output_tokens;
            } else if (
              event.type === "content_block_delta" &&
              event.delta.type === "text_delta"
            ) {
              fallbackText += event.delta.text;
              res.write(
                `data: ${JSON.stringify({ content: event.delta.text })}

`,
              );
            }
          }
        } catch (e) {
          req.log.error({ err: e }, "newsletter-qa slm-fallback stream failed");
        }

        res.write(
          `data: ${JSON.stringify({
            provenance: [],
            pillarNames: [],
            expertName: SLM_FALLBACK_EXPERT_NAME,
            pillarSlug: SLM_FALLBACK_PILLAR_SLUG,
            queryId,
            slmFallback: true,
            ...(isPartner ? await agentLicensePayloadKeyed(req) : {}),
            done: true,
          })}

`,
        );
        res.end();
        logNewsletterQaQuery({
          queryId,
          pillarId: null,
          question: message,
          outcome: "uncovered",
          retrievedSourceIds: [],
          retrievedInterpretationIds: [],
          topScore: routing.status === "uncovered" ? routing.topScore : 0,
          answerText: fallbackText.trim(),
          latencyMs: Date.now() - startedAt,
          partnerKeyId,
          inputTokens: fallbackInputTokens > 0 ? fallbackInputTokens : null,
          outputTokens: fallbackOutputTokens > 0 ? fallbackOutputTokens : null,
        });
        return;
      }

      expert = routing.expert;
      routeTopScore = routing.topScore;
    } catch (e) {
      req.log.error({ err: e }, "newsletter-qa routing failed");
      res.write(
        `data: ${JSON.stringify({ error: "Routing failed", queryId })}\n\n`,
      );
      res.end();
      return;
    }

    // Tell the client who is answering before any tokens stream.
    res.write(
      `data: ${JSON.stringify({
        routed: true,
        expertName: expert.expertName,
        pillarSlug: expert.pillarSlug,
        pillarName: expert.pillarName,
        queryId,
      })}\n\n`,
    );

    // ── 2. Single-pillar grounding, locked to the chosen expert ─────────
    let provenance: ProvenanceEntry[] = [];
    let contextBlock: string;
    try {
      const result = await retrieve({
        question: message,
        pillarIds: [expert.pillarId],
        k: 6,
        // Keyed callers get their assigned canary variant (IP attribution);
        // consumer traffic keeps the default pre-retrieval canary exclusion.
        includeCanaryDoi: isPartner
          ? await partnerCanaryDoi(partnerKeyId)
          : null,
      });
      // The router already cleared the threshold for this pillar's top chunk,
      // so this single-pillar retrieve will too; guard defensively anyway.
      if (result.chunks.length === 0) {
        const line = `UNCOVERED: I haven't published approved material on this yet.`;
        res.write(`data: ${JSON.stringify({ content: line })}\n\n`);
        res.write(
          `data: ${JSON.stringify({
            provenance: [],
            pillarNames: [expert.pillarName],
            expertName: expert.expertName,
            pillarSlug: expert.pillarSlug,
            queryId,
            uncovered: true,
            ...(isPartner ? await agentLicensePayloadKeyed(req) : {}),
            done: true,
          })}\n\n`,
        );
        res.end();
        logNewsletterQaQuery({
          queryId,
          pillarId: expert.pillarId,
          question: message,
          outcome: "uncovered",
          retrievedSourceIds: [],
          retrievedInterpretationIds: [],
          topScore: result.topScore,
          answerText: line,
          latencyMs: Date.now() - startedAt,
          partnerKeyId,
        });
        return;
      }
      provenance = buildProvenance(result.chunks);
      contextBlock = buildContextBlock(result.chunks);
    } catch (e) {
      req.log.error({ err: e }, "newsletter-qa retrieval failed");
      res.write(
        `data: ${JSON.stringify({ error: "Retrieval failed", queryId })}\n\n`,
      );
      res.end();
      return;
    }

    // ── 3. Stream the answer in the chosen steward's voice ──────────────
    const systemForRequest = buildExpertSystemPrompt(
      contextBlock,
      expert.pillarName,
      expert.expertName,
      expert.voiceContext,
      lang,
    );

    const messages = [
      ...(history ?? []).slice(-10).map((m) => ({
        role: m.role,
        content: m.content,
      })),
      { role: "user" as const, content: message },
    ];

    try {
      let answerText = "";
      let llmInputTokens = 0;
      let llmOutputTokens = 0;
      const stream = anthropic.messages.stream({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: systemForRequest,
        messages,
      });

      for await (const event of stream) {
        if (event.type === "message_start") {
          llmInputTokens = event.message.usage.input_tokens;
        } else if (event.type === "message_delta") {
          // Cumulative for the message — overwrite, don't sum.
          llmOutputTokens = event.usage.output_tokens;
        } else if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          answerText += event.delta.text;
          res.write(
            `data: ${JSON.stringify({ content: event.delta.text })}\n\n`,
          );
        }
      }

      const trimmed = answerText.trim();
      const wasRefused = trimmed.startsWith("REFUSE:");
      const wasUncovered = trimmed.startsWith("UNCOVERED:");

      // Citation guard — covered path only.
      let citationVerification: CitationVerification | null = null;
      if (!wasRefused && !wasUncovered && provenance.length > 0) {
        citationVerification = verifyCitation(answerText, provenance);
        if (citationVerification.status === "unmatched") {
          req.log.warn(
            {
              queryId,
              pillar: expert.pillarSlug,
              surname: citationVerification.surname,
              year: citationVerification.year,
              retrievedSourceIds: provenance.map((p) => p.source_id),
            },
            "newsletter-qa citation guard: citation not present in CONTEXT",
          );
        }
      }

      // Voice guard — observe-only, covered path only, with voice material.
      let voiceVerification: VoiceVerification | null = null;
      if (
        !wasRefused &&
        !wasUncovered &&
        hasVoiceMaterial(expert.voiceContext)
      ) {
        voiceVerification = verifyVoice(answerText, expert.voiceContext);
        if (voiceVerification.status === "flagged") {
          req.log.warn(
            {
              queryId,
              pillar: expert.pillarSlug,
              firstPersonOk: voiceVerification.firstPersonOk,
              bannedHits: voiceVerification.bannedHits,
              genericHits: voiceVerification.genericHits,
            },
            "newsletter-qa voice guard: answer drifted from steward voice",
          );
        }
      }

      // Citation guard ENFORCEMENT: a fabricated citation means the streamed
      // answer cannot ship as-is. `correction` tells the client to replace
      // the streamed text with the honest boundary; provenance is suppressed.
      const guardFailed = citationGuardTripped(citationVerification);
      res.write(
        `data: ${JSON.stringify({
          // Display-only collapse of same-work chapter sources (one book
          // seeded as several sources must not list as several books).
          provenance:
            wasRefused || wasUncovered || guardFailed
              ? []
              : serializePublicProvenance(
                  collapseSameWorkProvenance(provenance),
                ),
          pillarNames: [expert.pillarName],
          expertName: expert.expertName,
          pillarSlug: expert.pillarSlug,
          queryId,
          citationVerification,
          voiceVerification,
          ...(guardFailed
            ? { correction: `UNCOVERED: ${CITATION_GUARD_BOUNDARY}` }
            : {}),
          uncovered: wasUncovered || guardFailed,
          ...(isPartner ? await agentLicensePayloadKeyed(req) : {}),
          done: true,
        })}\n\n`,
      );
      res.end();
      logNewsletterQaQuery({
        queryId,
        pillarId: expert.pillarId,
        question: message,
        inputTokens: llmInputTokens > 0 ? llmInputTokens : null,
        outputTokens: llmOutputTokens > 0 ? llmOutputTokens : null,
        outcome:
          wasRefused || wasUncovered || guardFailed ? "uncovered" : "covered",
        retrievedSourceIds:
          wasRefused || wasUncovered || guardFailed
            ? []
            : provenance.map((p) => p.source_id),
        retrievedInterpretationIds:
          wasRefused || wasUncovered || guardFailed
            ? []
            : provenance
                .map((p) => p.interpretation_id)
                .filter((id): id is number => typeof id === "number"),
        topScore: routeTopScore,
        answerText: trimmed,
        latencyMs: Date.now() - startedAt,
        partnerKeyId,
      });
    } catch (e) {
      res.write(
        `data: ${JSON.stringify({ error: String((e as Error).message ?? e), queryId })}\n\n`,
      );
      res.end();
    }
  },
);

export default router;
