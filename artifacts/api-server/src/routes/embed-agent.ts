/**
 * Embeddable expert agent — live, streaming, single-pillar answer surface.
 *
 * POST /api/embed-agent  { message, pillar }
 *
 * Unlike /api/sleep-agent (which keyword-routes across pillars and falls
 * back to the hardcoded Zeitzer corpus when governed retrieval comes up
 * short), this endpoint is HARD-LOCKED to a single pillar slug:
 *
 *   - retrieval pulls ONLY that pillar's approved sources + interpretations,
 *   - there is NO cross-pillar fallback and NO legacy Zeitzer fallback,
 *   - below-threshold / empty retrieval returns a clean UNCOVERED line.
 *
 * This is what lets an independent expert (e.g. Matt Abrahams) drop a
 * white-label "ask anything" widget on their own site that answers strictly
 * from their own approved knowledge layer. SSE shape mirrors /sleep-agent so
 * the embed frontend can reuse the same parser. CORS is wide open — the
 * widget is iframed onto third-party origins.
 */
import { partnerCanaryDoi } from "../lib/ipProtection.js";
import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { and, eq, asc } from "drizzle-orm";
import {
  db,
  pool,
  pillarsTable,
  facultyMembershipsTable,
  facultyUsersTable,
  pillarResourcesTable,
} from "@workspace/db";
import { newsletterPublicationsTable } from "@workspace/db";
import { eq as eqOp, and as andOp } from "drizzle-orm";
import { partnerKeyMiddleware } from "../middlewares/partnerKey.js";
import { isAdminRequest } from "../lib/adminBypass.js";
import { generateFollowUpSuggestions } from "../lib/followUpSuggestions.js";
import { notifyKaranOfQuestion } from "../lib/karanNotify.js";
import { getConsumerFromRequest } from "../lib/consumerAuth.js";
import { ensureSessionId } from "../lib/consumerPaywall.js";
import {
  hasStewardAccess,
  getStewardPlan,
  stewardLookupKey,
} from "../lib/stewardBilling.js";
import { agentLicensePayload, agentLicensePayloadKeyed } from "../lib/agentLicense.js";
import { RAG_MIN_SCORE } from "../lib/ragThreshold.js";
import { computeAnswerLimits } from "../lib/answerLimits.js";
import {
  retrieve,
  buildContextBlock,
  buildProvenance,
  collapseSameWorkProvenance,
  serializePublicProvenance,
  verifyCitation,
  citationGuardTripped,
  sanitizeUntrustedText,
  CITATION_GUARD_BOUNDARY,
  type CitationVerification,
  type ProvenanceEntry,
} from "../lib/rag.js";
import {
  buildExpertSystemPrompt,
  loadStewardVoiceContext,
  verifyVoice,
  hasVoiceMaterial,
  type StewardVoiceContext,
  type VoiceVerification,
} from "../lib/stewardVoice.js";

const router: IRouter = Router();

// ── Steward publication paywall ─────────────────────────────────────────────
//
// When the request carries an optional `publication` slug (sent ONLY by the
// public /p/:slug ask panel — the white-label widget and partner-key callers
// never send it), the answer is a paid steward Q&A product: subscribers to
// that publication's $9/mo steward plan are unlimited, everyone else gets a
// small per-UTC-day free allowance. Own env var, deliberately decoupled from
// both SLEEP_FREE_DAILY_QUESTION_LIMIT and FREE_QUESTION_LIMIT (see
// consumer-paywall memory: surfaces never move in lockstep).
const STEWARD_FREE_DAILY_LIMIT = (() => {
  const raw = Number(process.env.STEWARD_FREE_DAILY_QUESTION_LIMIT);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2;
})();

const FREE_COUNT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const freeQuestionCounts = new Map<
  string,
  { count: number; day: string; lastSeen: number }
>();

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Increment + return the number of gated questions this (session, publication)
 * pair has used TODAY (UTC). Mirrors the sleep-agent per-day tally: in-memory,
 * single-process, self-evicting. Exported for the daily-rollover unit test.
 */
export function consumeStewardFreeQuestion(key: string): number {
  const now = Date.now();
  const today = utcDay(now);
  const entry = freeQuestionCounts.get(key);
  if (
    !entry ||
    entry.day !== today ||
    now - entry.lastSeen >= FREE_COUNT_TTL_MS
  ) {
    freeQuestionCounts.set(key, { count: 1, day: today, lastSeen: now });
    if (freeQuestionCounts.size > 5000) {
      for (const [k, v] of freeQuestionCounts) {
        if (now - v.lastSeen >= FREE_COUNT_TTL_MS) freeQuestionCounts.delete(k);
      }
    }
    return 1;
  }
  entry.count += 1;
  entry.lastSeen = now;
  return entry.count;
}

const anthropic = new Anthropic({
  baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
});

interface EmbedPillar {
  id: number;
  slug: string;
  name: string;
  /** First steward's display name — the "expert" the widget speaks for. */
  expertName: string | null;
  /** First steward's faculty user id, used to load their voice. */
  stewardUserId: number | null;
  /** Stored profile + live style exemplars that voice the steward. Cached
   * alongside the pillar (same TTL) so a busy widget doesn't re-query per
   * keystroke. Empty context falls back to the generic baseline voice. */
  voiceContext: StewardVoiceContext;
}

// Small TTL cache so a busy widget doesn't hit the DB for pillar + steward
// metadata on every keystroke-driven question.
const pillarCache = new Map<string, { value: EmbedPillar | null; expiresAt: number }>();
const PILLAR_CACHE_TTL_MS = 60_000;

async function loadEmbedPillar(slug: string): Promise<EmbedPillar | null> {
  const now = Date.now();
  const cached = pillarCache.get(slug);
  if (cached && cached.expiresAt > now) return cached.value;

  const pillar = (
    await db.select().from(pillarsTable).where(eq(pillarsTable.slug, slug))
  )[0];
  if (!pillar) {
    pillarCache.set(slug, { value: null, expiresAt: now + PILLAR_CACHE_TTL_MS });
    return null;
  }

  const stewardRow = (
    await db
      .select({
        userId: facultyUsersTable.id,
        fullName: facultyUsersTable.fullName,
      })
      .from(facultyMembershipsTable)
      .innerJoin(
        facultyUsersTable,
        eq(facultyUsersTable.id, facultyMembershipsTable.userId),
      )
      .where(
        and(
          eq(facultyMembershipsTable.pillarId, pillar.id),
          eq(facultyMembershipsTable.role, "steward"),
        ),
      )
      .orderBy(facultyMembershipsTable.id)
      .limit(1)
  )[0];

  const stewardUserId = stewardRow?.userId ?? null;
  const voiceContext = await loadStewardVoiceContext({
    facultyUserId: stewardUserId,
    pillarId: pillar.id,
  });

  const value: EmbedPillar = {
    id: pillar.id,
    slug: pillar.slug,
    name: pillar.name,
    expertName: stewardRow?.fullName ?? null,
    stewardUserId,
    voiceContext,
  };
  pillarCache.set(slug, { value, expiresAt: now + PILLAR_CACHE_TTL_MS });
  return value;
}

/** Outcome of a single embed-agent request, for usage tracking. */
type EmbedOutcome = "covered" | "uncovered" | "refused";

/**
 * Best-effort usage row for the embed agent. Reuses the existing
 * `agent_queries` capture table (tagged `source='embed-agent'`) so a
 * single per-pillar usage summary can be computed without a parallel
 * mechanism. Refused/uncovered outcomes are encoded via `was_uncovered`
 * plus the `REFUSE:`/`UNCOVERED:` prefix already present in `answer_text`.
 * Runs fire-and-forget after res.end() — a logging failure can never break
 * a user-facing answer. No embedding is computed here: this row exists for
 * usage counting, not the uncovered-question clustering path.
 */
function logEmbedQuery(opts: {
  queryId: string;
  pillarId: number;
  question: string;
  outcome: EmbedOutcome;
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
        VALUES ($1, 'embed-agent', 'embed-agent', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (id) DO NOTHING`,
      [
        opts.queryId,
        opts.question,
        [opts.pillarId],
        opts.retrievedSourceIds,
        opts.retrievedInterpretationIds,
        opts.topScore,
        opts.outcome === "uncovered",
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

router.options("/embed-agent", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Palonur-Key");
  res.sendStatus(204);
});

router.post(
  "/embed-agent",
  partnerKeyMiddleware("embed-agent", { allowFirstPartyHuman: true }),
  async (req, res): Promise<void> => {
    const { message, pillar, history, publication, lang } = req.body as {
      message?: string;
      pillar?: string;
      lang?: string;
      history?: Array<{ role: "user" | "assistant"; content: string }>;
      /** Optional publication slug — sent ONLY by the /p/:slug ask panel. */
      publication?: string;
    };

    if (!message || typeof message !== "string" || !message.trim()) {
      res.status(400).json({ error: "message required" });
      return;
    }
    if (!pillar || typeof pillar !== "string" || !pillar.trim()) {
      res.status(400).json({ error: "pillar required" });
      return;
    }

    notifyKaranOfQuestion(req, message, "embed-agent");

    const queryId = randomUUID();
    const startedAt = Date.now();
    const partnerKeyId =
      (req as unknown as { partnerKey?: { id: number } }).partnerKey?.id ?? null;
    const isPartner = partnerKeyId != null;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Access-Control-Allow-Origin", "*");

    // ── Steward publication paywall gate ────────────────────────────────
    // Applies ONLY when the caller declares publication context (the public
    // /p/:slug ask panel). Partner-key callers and the plain white-label
    // widget (no `publication` field) are untouched. Subscribers to this
    // publication's steward plan are unlimited; everyone else gets
    // STEWARD_FREE_DAILY_LIMIT free answers per UTC day, then a paywall
    // event the client turns into the subscribe CTA. Blocked questions are
    // not logged — they never produced an answer.
    // Admin bypass: a verified signed `palonur_admin` cookie (Karan testing)
    // skips the daily free-ask limit + Stripe paywall entirely. Questions
    // still log; fail-open behavior for everyone else is unchanged.
    if (
      !isPartner &&
      !isAdminRequest(req) &&
      typeof publication === "string" &&
      publication.trim() &&
      STEWARD_FREE_DAILY_LIMIT >= 0
    ) {
      try {
        const pub = (
          await db
            .select({
              id: newsletterPublicationsTable.id,
              slug: newsletterPublicationsTable.slug,
            })
            .from(newsletterPublicationsTable)
            .where(
              andOp(
                eqOp(newsletterPublicationsTable.slug, publication.trim()),
                eqOp(newsletterPublicationsTable.isHouse, false),
              ),
            )
            .limit(1)
        )[0];
        if (pub) {
          let entitled = false;
          try {
            const account = await getConsumerFromRequest(req);
            entitled = account
              ? await hasStewardAccess(account.stripeCustomerId, pub.id)
              : false;
          } catch (e) {
            req.log.warn(
              { err: e },
              "steward entitlement check failed (treating as free)",
            );
          }
          if (!entitled) {
            const sessionId = ensureSessionId(req, res);
            const used = consumeStewardFreeQuestion(
              `${sessionId}:${pub.id}`,
            );
            if (used > STEWARD_FREE_DAILY_LIMIT) {
              const plan = await getStewardPlan(pub.id).catch(() => null);
              res.write(
                `data: ${JSON.stringify({
                  queryId,
                  paywall: true,
                  freeLimit: STEWARD_FREE_DAILY_LIMIT,
                  plan: {
                    lookupKey: plan?.lookupKey ?? stewardLookupKey(pub.id),
                    unitAmount: plan?.unitAmount ?? null,
                    currency: plan?.currency ?? "usd",
                    interval: plan?.interval ?? "month",
                  },
                  done: true,
                })}\n\n`,
              );
              res.end();
              return;
            }
          }
        }
      } catch (e) {
        // Fail open: a paywall infrastructure error must never take down the
        // answer surface (paid access is still enforced whenever checks DO
        // run; this only skips the free-tier gate on a transient failure).
        req.log.error({ err: e }, "steward paywall gate failed (skipping)");
      }
    }

    let embedPillar: EmbedPillar | null;
    try {
      embedPillar = await loadEmbedPillar(pillar.trim());
    } catch (e) {
      req.log.error({ err: e }, "embed-agent pillar lookup failed");
      res.write(
        `data: ${JSON.stringify({ error: "Lookup failed", queryId })}\n\n`,
      );
      res.end();
      return;
    }
    if (!embedPillar) {
      res.write(
        `data: ${JSON.stringify({ error: "pillar_not_found", queryId })}\n\n`,
      );
      res.end();
      return;
    }

    // Fetch curated external resource links for this pillar (e.g. ADRC links
    // for the dementia pillar). Done once after pillar lookup so resources
    // appear both on UNCOVERED (primary prompt) and on covered answers
    // (supplementary "learn more" panel). Best-effort — a failure here never
    // blocks the answer path.
    let pillarResources: Array<{
      id: number;
      title: string;
      url: string;
      description: string | null;
      category: string | null;
      displayOrder: number;
    }> = [];
    try {
      pillarResources = await db
        .select({
          id: pillarResourcesTable.id,
          title: pillarResourcesTable.title,
          url: pillarResourcesTable.url,
          description: pillarResourcesTable.description,
          category: pillarResourcesTable.category,
          displayOrder: pillarResourcesTable.displayOrder,
        })
        .from(pillarResourcesTable)
        .where(eq(pillarResourcesTable.pillarId, embedPillar.id))
        .orderBy(asc(pillarResourcesTable.displayOrder));
    } catch (e) {
      req.log.warn({ err: e }, "embed-agent: pillar resources fetch failed");
    }

    // HARD-LOCKED retrieval: a single pillar id, no router, no fallback.
    let provenance: ProvenanceEntry[] = [];
    let contextBlock: string;
    let retrievalTopScore = 0;
    try {
      const result = await retrieve({
        question: message,
        pillarIds: [embedPillar.id],
        k: 6,
        // Keyed callers get their assigned canary variant (IP attribution);
        // consumer traffic keeps the default pre-retrieval canary exclusion.
        includeCanaryDoi: isPartner ? await partnerCanaryDoi(partnerKeyId) : null,
      });

      if (result.chunks.length === 0 || result.topScore < RAG_MIN_SCORE) {
        // No cross-pillar or legacy corpus to fall back to — by design. The
        // widget answers only from this expert's approved layer, so an
        // under-threshold retrieval is an honest UNCOVERED. Stream it as a
        // content delta so the client's existing parser handles it.
        const line = `UNCOVERED: I haven't published approved material on this yet.`;
        res.write(`data: ${JSON.stringify({ content: line })}\n\n`);

        res.write(
          `data: ${JSON.stringify({
            provenance: [],
            pillarNames: [embedPillar.name],
            queryId,
            uncovered: true,
            ...(pillarResources.length > 0 ? { resources: pillarResources } : {}),
            ...(isPartner ? await agentLicensePayloadKeyed(req) : {}),
            done: true,
          })}\n\n`,
        );
        res.end();
        logEmbedQuery({
          queryId,
          pillarId: embedPillar.id,
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
      retrievalTopScore = result.topScore;
    } catch (e) {
      req.log.error({ err: e }, "embed-agent retrieval failed");
      res.write(
        `data: ${JSON.stringify({ error: "Retrieval failed", queryId })}\n\n`,
      );
      res.end();
      return;
    }

    const systemForRequest = buildExpertSystemPrompt(
      contextBlock,
      embedPillar.name,
      embedPillar.expertName,
      embedPillar.voiceContext,
      lang,
    );

    // History is client-supplied and UNTRUSTED (this is the cross-origin
    // embeddable surface): whitelist roles, require strings, strip control
    // chars / fence markers, and cap length so a tampered transcript can't
    // smuggle oversized or injected prompt structure.
    const messages = [
      ...(Array.isArray(history) ? history : [])
        .filter(
          (m): m is { role: "user" | "assistant"; content: string } =>
            !!m &&
            (m.role === "user" || m.role === "assistant") &&
            typeof m.content === "string" &&
            m.content.trim().length > 0,
        )
        .slice(-10)
        .map((m) => ({
          role: m.role,
          content: sanitizeUntrustedText(m.content).slice(0, 4000),
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

      // Citation guard runs on the covered path only — refusal / uncovered
      // answers have nothing to verify against.
      let citationVerification: CitationVerification | null = null;
      if (!wasRefused && !wasUncovered && provenance.length > 0) {
        citationVerification = verifyCitation(answerText, provenance);
        if (citationVerification.status === "unmatched") {
          req.log.warn(
            {
              queryId,
              pillar: embedPillar.slug,
              surname: citationVerification.surname,
              year: citationVerification.year,
              retrievedSourceIds: provenance.map((p) => p.source_id),
            },
            "embed-agent citation guard: citation not present in CONTEXT",
          );
        }
      }

      // Voice guard — observe-only, mirrors the citation guard. Reports whether
      // the answer actually landed in the steward's voice; it NEVER rewrites or
      // blocks. Runs on the covered path only, and only when there is voice
      // material to hold the answer to.
      let voiceVerification: VoiceVerification | null = null;
      if (
        !wasRefused &&
        !wasUncovered &&
        hasVoiceMaterial(embedPillar.voiceContext)
      ) {
        voiceVerification = verifyVoice(answerText, embedPillar.voiceContext);
        if (voiceVerification.status === "flagged") {
          req.log.warn(
            {
              queryId,
              pillar: embedPillar.slug,
              firstPersonOk: voiceVerification.firstPersonOk,
              bannedHits: voiceVerification.bannedHits,
              genericHits: voiceVerification.genericHits,
            },
            "embed-agent voice guard: answer drifted from steward voice",
          );
        }
      }

      // triageLabel drives the consumer-facing quality badge:
      //   "ai_assisted" — covered path, citation verified against approved corpus
      //   "ai_informed" — uncovered / refused / citation unmatched
      const triageLabel: "ai_assisted" | "ai_informed" =
        !wasRefused && !wasUncovered && citationVerification?.status === "verified"
          ? "ai_assisted"
          : "ai_informed";
      // Amber limit notices — covered path only, suppressed on an unmatched
      // citation guard (that answer already loses its provenance strip).
      const limitNotices =
        wasRefused || wasUncovered || citationVerification?.status === "unmatched"
          ? []
          : await computeAnswerLimits({
              provenance,
              topScore: retrievalTopScore,
              pillarIds: [embedPillar.id],
              log: req.log,
            });
      // Citation guard ENFORCEMENT: a fabricated citation means the streamed
      // answer cannot ship as-is. `correction` tells the client to replace
      // the streamed text with the honest boundary; provenance is suppressed.
      const guardFailed = citationGuardTripped(citationVerification);

      // Suggested follow-up chips — covered answers only, neutral (brand-
      // free) wording for the white-label surface. Fail-silent: [] on any
      // error means the done event simply omits the field.
      const suggestedQuestions =
        wasRefused || wasUncovered || guardFailed
          ? []
          : await generateFollowUpSuggestions({
              question: message,
              answerText: trimmed,
              contextBlock,
              style: "neutral",
            }).catch(() => [] as string[]);

      res.write(
        `data: ${JSON.stringify({
          // Display-only collapse of same-work chapter sources (one book
          // seeded as several sources must not list as several books).
          provenance:
            wasRefused || wasUncovered || guardFailed
              ? []
              : serializePublicProvenance(collapseSameWorkProvenance(provenance)),
          pillarNames: [embedPillar.name],
          queryId,
          citationVerification,
          voiceVerification,
          triageLabel,
          ...(guardFailed
            ? { correction: `UNCOVERED: ${CITATION_GUARD_BOUNDARY}` }
            : {}),
          ...(limitNotices.length > 0 ? { limitNotices } : {}),
          ...(suggestedQuestions.length > 0 ? { suggestedQuestions } : {}),
          // Include curated resources on the covered path too — they appear
          // as a supplementary "learn more" panel below the grounded answer,
          // so readers can always reach primary ADRC (or other pillar) links
          // even when the corpus is rich enough to answer directly.
          ...(pillarResources.length > 0 ? { resources: pillarResources } : {}),
          ...(isPartner ? await agentLicensePayloadKeyed(req) : {}),
          done: true,
        })}\n\n`,
      );
      res.end();
      logEmbedQuery({
        queryId,
        pillarId: embedPillar.id,
        question: message,
        inputTokens: llmInputTokens > 0 ? llmInputTokens : null,
        outputTokens: llmOutputTokens > 0 ? llmOutputTokens : null,
        outcome: wasRefused
          ? "refused"
          : wasUncovered || guardFailed
            ? "uncovered"
            : "covered",
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
        topScore: 0,
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
