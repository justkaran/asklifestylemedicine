/**
 * Combined Stanford Lifestyle Medicine ask surface.
 *
 * POST /api/slm-agent  { message, history? }
 *
 * Retrieves from ALL active SLM pillar approved sources simultaneously
 * (sleep, nutrition, movement, stress-management, social-connection,
 * cognitive-enhancement, gratitude-purpose). Autism has its own dedicated surface and is never included here.
 *
 * Since answers may draw on multiple pillars there is no single steward voice.
 * The system prompt presents a neutral "Stanford Lifestyle Medicine science
 * communicator" persona and always credits the specific researcher in the
 * CITATION line. SSE shape mirrors /embed-agent and /sleep-agent.
 *
 * No partner-key gate (first-party consumer surface). No per-day paywall on
 * initial launch. Citation guard runs on the covered path exactly as on all
 * other governed surfaces.
 */
import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { and, isNull, inArray } from "drizzle-orm";
import { db, pool, pillarsTable } from "@workspace/db";
import { RAG_MIN_SCORE } from "../lib/ragThreshold.js";
import { generateFollowUpSuggestions } from "../lib/followUpSuggestions.js";
import {
  CITATION_GUARD_BOUNDARY,
  citationGuardTripped,
  sanitizeUntrustedText,
  retrieve,
  buildContextBlock,
  buildProvenance,
  collapseSameWorkProvenance,
  serializePublicProvenance,
  verifyCitation,
  type CitationVerification,
  type ProvenanceEntry,
  UNTRUSTED_CONTEXT_RULE,
} from "../lib/rag.js";
import {
  buildSlmFallbackStream,
  notifyUncoveredQuestion,
  SLM_FALLBACK_EXPERT_NAME,
  SLM_FALLBACK_STEWARD_NAME,
  SLM_FALLBACK_PILLAR_SLUG,
} from "../lib/slmFallback.js";
import { getConsumerFromRequest } from "../lib/consumerAuth.js";
import { loadLeadStewards } from "../lib/stewardLookup.js";
import { langOverride } from "../lib/stewardVoice.js";

const router: IRouter = Router();

/** Normalize the SLM_DOMAIN env value: hostname only, lowercase, no port. */
export function normalizeSlmDomain(raw: string | undefined): string {
  return (raw || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
}

/**
 * Does this request arrive via the standalone SLM domain? Mirrors the
 * palonur server's host dispatch: X-Forwarded-Host can be client-appended;
 * only the RIGHTMOST entry was set by our one trusted platform proxy.
 */
export function isSlmStandaloneHost(headers: {
  "x-forwarded-host"?: string | string[];
  host?: string;
}): boolean {
  const slmDomain = normalizeSlmDomain(process.env.SLM_DOMAIN);
  if (!slmDomain) return false;
  const fwd = String(headers["x-forwarded-host"] ?? "");
  const parts = fwd
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const host = String(
    parts.length ? parts[parts.length - 1] : (headers.host ?? ""),
  )
    .toLowerCase()
    .replace(/:\d+$/, "");
  return host === slmDomain;
}

export const SLM_PILLAR_SLUGS = [
  "sleep",
  "stress-management",
  "nutrition",
  "movement",
  "social-connection",
  "cognitive-enhancement",
  "gratitude-purpose",
  "empathy",
] as const;

const anthropic = new Anthropic({
  baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
});

export function buildSlmSystemPrompt(
  contextBlock: string,
  lang?: string,
): string {
  return `You are a science communicator for Stanford Lifestyle Medicine, presenting peer-reviewed evidence on sleep, nutrition, movement, stress management, social connection, cognitive health, empathy, and purpose.

Answer questions using ONLY the research in CONTEXT below. Be direct, warm, and precise. Write for a curious adult who wants real science, not generic wellness advice.

Format every response with these exact labels on their own lines:
ANSWER: [2-4 sentence evidence-based answer]
CITATION: [Copy one source's author and date exactly from its CONTEXT header, for example "Zeitzer et al., 2020" or "Stanford Health Care Sleep Medicine, n.d."]
PAPER: [Full paper title]
FINDING: [The key finding in one sentence]
INTERPRETATION: [What this means in practice, one sentence]

Rules:
- Never invent or extend beyond CONTEXT.
- Copy the CITATION author and date exactly from one source header. Cite one
  source only. When the header says "(n.d.)", write "n.d."; never invent a year.
- When the user explicitly asks for steps, a plan, a protocol, or a list, give
  a concise numbered list under ANSWER. Include the complete sequence supported
  by CONTEXT, even when that takes more than the usual 2–4 sentences.
- If the question is unrelated to lifestyle medicine or health, respond only with: REFUSE: [brief reason]
- If it is a lifestyle medicine topic but CONTEXT has no relevant material, respond only with: UNCOVERED: [brief acknowledgment]
- Do not use em dashes. Use a comma, colon, or period instead.

CONTEXT:
${contextBlock}

${UNTRUSTED_CONTEXT_RULE}${langOverride(lang)}`;
}

/**
 * Strip anything but plain name-like characters from a request-supplied
 * value before it is interpolated into a system prompt. Length slicing is
 * NOT sanitization — this removes newlines, quotes, and control characters
 * that could carry prompt-injection payloads.
 */
export function sanitizePromptField(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[^\p{L}\p{N} .,'&()\-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Conversational variant for the steward chat panel: short chat replies
 * grounded in the same governed CONTEXT, no section labels.
 * opts.stewardName / opts.pillarName must be pre-sanitized with
 * sanitizePromptField — they may originate from the request body.
 */
export function buildSlmChatSystemPrompt(
  contextBlock: string,
  opts?: { stewardName?: string; pillarName?: string; lang?: string },
): string {
  const persona = opts?.stewardName
    ? `You are the research voice of ${opts.stewardName}'s Stanford Lifestyle Medicine pillar${opts.pillarName ? ` (${opts.pillarName})` : ""}. You present ${opts.stewardName}'s approved research; you are an AI, never claim to literally be them.`
    : `You are a science communicator for Stanford Lifestyle Medicine.`;
  return `${persona}

You are replying inside a short follow-up chat next to a cited answer the visitor already received. Reply conversationally in 2-4 sentences using ONLY the research in CONTEXT below. When you state a finding, credit it inline like (Author, Year).

Rules:
- Never invent or extend beyond CONTEXT.
- No section labels, no bullet lists, just a short chat reply.
- If the question is unrelated to lifestyle medicine or health, respond only with: REFUSE: [brief reason]
- If it is a lifestyle medicine topic but CONTEXT has no relevant material, respond only with: UNCOVERED: [brief acknowledgment]
- Do not use em dashes. Use a comma, colon, or period instead.

CONTEXT:
${contextBlock}

${UNTRUSTED_CONTEXT_RULE}${langOverride(opts?.lang)}`;
}

const PILLAR_TAGS: Record<string, string[]> = {
  sleep: ["sleep quality", "circadian rhythm", "insomnia", "rest"],
  "stress-management": ["stress", "mindfulness", "cortisol", "resilience"],
  nutrition: ["diet", "gut health", "metabolism", "longevity"],
  movement: ["exercise", "strength", "cardio", "mobility"],
  "social-connection": [
    "loneliness",
    "relationships",
    "community",
    "belonging",
  ],
  "cognitive-enhancement": [
    "brain health",
    "memory",
    "focus",
    "neuroplasticity",
  ],
  "gratitude-purpose": ["meaning", "gratitude", "purpose", "wellbeing"],
  empathy: ["empathy", "compassion", "perspective taking", "connection"],
};

interface SlmPillarSet {
  ids: number[];
  slugToName: Record<string, string>;
  slugToId: Record<string, number>;
}

let slmPillarCache: (SlmPillarSet & { expiresAt: number }) | null = null;
const SLM_PILLAR_CACHE_TTL_MS = 60_000;

async function loadSlmPillars(): Promise<SlmPillarSet> {
  const now = Date.now();
  if (slmPillarCache && slmPillarCache.expiresAt > now) {
    return {
      ids: slmPillarCache.ids,
      slugToName: slmPillarCache.slugToName,
      slugToId: slmPillarCache.slugToId,
    };
  }
  const rows = await db
    .select({
      id: pillarsTable.id,
      slug: pillarsTable.slug,
      name: pillarsTable.name,
    })
    .from(pillarsTable)
    .where(
      and(
        isNull(pillarsTable.retiredAt),
        inArray(pillarsTable.slug, [...SLM_PILLAR_SLUGS]),
      ),
    );
  const ids = rows.map((r) => r.id);
  const slugToName: Record<string, string> = {};
  const slugToId: Record<string, number> = {};
  for (const r of rows) {
    slugToName[r.slug] = r.name;
    slugToId[r.slug] = r.id;
  }
  slmPillarCache = {
    ids,
    slugToName,
    slugToId,
    expiresAt: now + SLM_PILLAR_CACHE_TTL_MS,
  };
  return { ids, slugToName, slugToId };
}

type SlmOutcome = "covered" | "uncovered" | "refused";

/**
 * Session key for a standalone-chat consumer's rows in agent_queries.
 * Deliberately NOT UUID-shaped: save-answer ownership checks only honor
 * UUID-shaped session ids, so these rows can never be claimed through that
 * path — history access goes through the authenticated endpoint below.
 */
function consumerSessionKey(consumerId: number): string {
  return `consumer:${consumerId}`;
}

/**
 * Anonymous free-question allowance for the standalone chat: a visitor's
 * opening question streams without registration so the first answer can
 * land before the sign-in ask. Per-IP per-UTC-day, in-memory (resets on
 * restart — this paces UX, it does not meter anything billable).
 */
const ANON_FREE_DAILY_LIMIT = 5;
/** Hard bound on tracked IPs: beyond this, anonymous questions are denied
 * (fail closed) rather than growing memory — registration still works. */
const ANON_FREE_MAX_KEYS = 20_000;
const anonFreeHits = new Map<string, { day: string; count: number }>();

function takeAnonFreeQuestion(ip: string): boolean {
  const day = new Date().toISOString().slice(0, 10);
  if (anonFreeHits.size >= ANON_FREE_MAX_KEYS) {
    // Drop stale days first; if the map is still full of TODAY's keys we are
    // under a flood — refuse new anonymous callers instead of growing.
    for (const [k, v] of anonFreeHits) {
      if (v.day !== day) anonFreeHits.delete(k);
    }
    if (anonFreeHits.size >= ANON_FREE_MAX_KEYS && !anonFreeHits.has(ip)) {
      return false;
    }
  }
  const rec = anonFreeHits.get(ip);
  const count = rec && rec.day === day ? rec.count : 0;
  if (count >= ANON_FREE_DAILY_LIMIT) return false;
  anonFreeHits.set(ip, { day, count: count + 1 });
  return true;
}

// ── Per-account velocity rail (standalone chat) ────────────────────────────
// Signed-in questions stay "free and unlimited" for humans, but scripts get
// paced: a minimum gap between questions plus a generous daily ceiling.
// In-memory (resets on restart — abuse rail, not billing), keyed by account.
const ACCOUNT_MIN_INTERVAL_MS = Number(
  process.env.SLM_ACCOUNT_MIN_INTERVAL_MS ?? 15_000,
);
const ACCOUNT_DAILY_LIMIT = Number(
  process.env.SLM_ACCOUNT_DAILY_QUESTION_LIMIT ?? 300,
);
const ACCOUNT_PACE_MAX_KEYS = 50_000;
/** Chat turns (avatar panel) get their OWN, shorter pace — `chat:true` is an
 *  untrusted body flag, so it must never grant an unpaced lane, only a lane
 *  paced independently of the main composer. */
const CHAT_MIN_INTERVAL_MS = Number(
  process.env.SLM_CHAT_MIN_INTERVAL_MS ?? 3_000,
);
const accountPace = new Map<
  number,
  { day: string; count: number; lastAt: number; chatLastAt: number }
>();

/** Returns null when allowed (and charges the slot), else a reader-facing
 *  message explaining the pause.
 *
 *  `chatTurn` (avatar-panel replies): paced on a separate, shorter interval
 *  and never blocks or resets the main 15-second gap — so using the avatar
 *  panel never locks the MAIN composer out. Chat turns still count toward
 *  (and are blocked by) the shared daily ceiling. */
export function takeAccountQuestionSlot(
  accountId: number,
  now = Date.now(),
  opts: { chatTurn?: boolean } = {},
): string | null {
  const day = new Date(now).toISOString().slice(0, 10);
  if (accountPace.size >= ACCOUNT_PACE_MAX_KEYS) {
    for (const [k, v] of accountPace) {
      if (v.day !== day) accountPace.delete(k);
    }
    // Still full of TODAY's keys → account flood; fail closed for accounts
    // we are not already tracking rather than growing without bound.
    if (
      accountPace.size >= ACCOUNT_PACE_MAX_KEYS &&
      !accountPace.has(accountId)
    ) {
      return "We're seeing unusually high traffic. Please try again later.";
    }
  }
  const rec = accountPace.get(accountId);
  const sameDay = rec && rec.day === day;
  if (opts.chatTurn) {
    if (rec && now - rec.chatLastAt < CHAT_MIN_INTERVAL_MS) {
      return "You're asking very quickly. Please wait a few seconds and try again.";
    }
  } else if (rec && now - rec.lastAt < ACCOUNT_MIN_INTERVAL_MS) {
    return "You're asking very quickly. Please wait a few seconds and try again.";
  }
  if (sameDay && rec.count >= ACCOUNT_DAILY_LIMIT) {
    return "You've reached today's question limit. Please come back tomorrow.";
  }
  accountPace.set(accountId, {
    day,
    count: sameDay ? rec.count + 1 : 1,
    // Chat turns don't reset the main gap (and vice versa) — a main-composer
    // question right after an avatar chat reply must not be told to wait.
    lastAt: opts.chatTurn ? (rec?.lastAt ?? 0) : now,
    chatLastAt: opts.chatTurn ? now : (rec?.chatLastAt ?? 0),
  });
  return null;
}

function logSlmQuery(opts: {
  queryId: string;
  sessionId: string;
  pillarIds: number[];
  question: string;
  outcome: SlmOutcome;
  retrievedSourceIds: number[];
  retrievedInterpretationIds: number[];
  topScore: number;
  answerText: string;
  latencyMs: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
}): void {
  void pool
    .query(
      `INSERT INTO agent_queries
         (id, source, session_id, question, pillar_ids,
          retrieved_source_ids, retrieved_interpretation_ids,
          top_score, was_uncovered, answer_text, latency_ms,
          input_tokens, output_tokens)
       VALUES ($1, 'slm-agent', $12, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO NOTHING`,
      [
        opts.queryId,
        opts.question,
        opts.pillarIds,
        opts.retrievedSourceIds,
        opts.retrievedInterpretationIds,
        opts.topScore,
        opts.outcome !== "covered",
        opts.answerText,
        opts.latencyMs,
        opts.inputTokens ?? null,
        opts.outputTokens ?? null,
        opts.sessionId,
      ],
    )
    .catch(() => {});
}

// ── GET /api/slm-agent/history ──────────────────────────────────────────────
// A signed-in standalone-chat consumer's own past questions and answers,
// oldest first, so the client can restore the conversation on return visits.
// Provisional (unverified) sessions may read their own history too — it only
// contains what that same browser session asked.
router.get("/slm-agent/history", async (req, res): Promise<void> => {
  try {
    const account = await getConsumerFromRequest(req, {
      allowProvisional: true,
    });
    if (!account) {
      res
        .status(401)
        .json({ error: "Sign in to see your conversation history." });
      return;
    }
    const { rows } = await pool.query<{
      question: string;
      answer_text: string | null;
      pillar_ids: number[] | null;
      created_at: Date;
    }>(
      `SELECT question, answer_text, pillar_ids, created_at
         FROM agent_queries
        WHERE source = 'slm-agent' AND session_id = $1
          -- Covered answers only. Fallback/refused/guard-corrected rows store
          -- text that must not be re-shown as a governed pillar answer (the
          -- guard's stored text is pre-correction, and fallbacks are the AI
          -- Lab's voice, not the stewards').
          AND was_uncovered = false
        ORDER BY created_at DESC
        LIMIT 100`,
      [consumerSessionKey(account.id)],
    );
    let idToName: Record<number, string> = {};
    try {
      const pillars = await loadSlmPillars();
      idToName = Object.fromEntries(
        Object.entries(pillars.slugToId).map(([slug, id]) => [
          id,
          pillars.slugToName[slug] ?? slug,
        ]),
      );
    } catch {
      /* pillar names are cosmetic on restored turns */
    }
    res.json({
      turns: rows
        .reverse()
        .filter((r) => r.answer_text && r.answer_text.trim().length > 0)
        .map((r) => ({
          question: r.question,
          answer: r.answer_text,
          pillarNames: (r.pillar_ids ?? [])
            .map((id) => idToName[id])
            .filter((n): n is string => !!n),
          askedAt: r.created_at,
        })),
    });
  } catch (e) {
    req.log.error({ err: e }, "slm-agent history lookup failed");
    res.status(500).json({ error: "Failed to load history" });
  }
});

// ── GET /api/slm-agent/stewards ─────────────────────────────────────────────
// Returns each active SLM pillar's lead steward with photo, institution, and
// topic tags. Used by the client-side steward picker before starting a chat.
router.get("/slm-agent/stewards", async (req, res): Promise<void> => {
  try {
    const rows = await db
      .select({
        id: pillarsTable.id,
        slug: pillarsTable.slug,
        name: pillarsTable.name,
      })
      .from(pillarsTable)
      .where(
        and(
          isNull(pillarsTable.retiredAt),
          inArray(pillarsTable.slug, [...SLM_PILLAR_SLUGS]),
        ),
      );

    const pillarIds = rows.map((r) => r.id);
    const stewardMap = await loadLeadStewards(pillarIds);

    // Preserve the canonical pillar order
    const ordered = [...SLM_PILLAR_SLUGS]
      .map((slug) => rows.find((r) => r.slug === slug))
      .filter((r): r is NonNullable<typeof r> => !!r);

    const stewards = ordered
      .map((r) => {
        const steward = stewardMap.get(r.id);
        if (!steward) return null; // omit pillars without a lead steward
        return {
          pillarSlug: r.slug,
          pillarName: r.name,
          stewardName: steward.fullName,
          institution: steward.institution,
          photoUrl: steward.photoUrl,
          tags: PILLAR_TAGS[r.slug] ?? [],
        };
      })
      .filter(Boolean);

    res.json({ stewards });
  } catch (e) {
    req.log.error({ err: e }, "slm-agent/stewards lookup failed");
    res.status(500).json({ error: "Failed to load stewards" });
  }
});

// ── POST /api/slm-agent ──────────────────────────────────────────────────────
router.post("/slm-agent", async (req, res): Promise<void> => {
  const {
    message,
    history: rawHistory,
    pillarSlugs,
    lang,
    chat,
    stewardName,
    pillarName,
  } = req.body as {
    message?: string;
    history?: Array<{ role: "user" | "assistant"; content: string }>;
    pillarSlugs?: string[];
    /** Explicit user-selected UI language ("en", "de", ...). Only sent when
     * the visitor picked a language; forces answers into that language. */
    lang?: string;
    /** Steward chat panel mode: short conversational replies, no labels. */
    chat?: boolean;
    /** Display-only persona hints for chat mode (validated as strings). */
    stewardName?: string;
    pillarName?: string;
  };
  const chatMode = chat === true;

  if (!message || typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "message required" });
    return;
  }

  // History arrives from the client and is UNTRUSTED: whitelist roles,
  // require strings, strip control chars / fence markers, and cap length so
  // a tampered transcript can't smuggle oversized or injected content.
  const boundedHistory = (Array.isArray(rawHistory) ? rawHistory : [])
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
    }));

  // Standalone SLM domain: questions are unlimited and free, but require a
  // registered consumer account (magic-link sign-in). No payment gate — the
  // check is registration only. The palonur.com /slm surface is unaffected.
  //
  // The gate keys on the TRUSTED request host (SLM_DOMAIN, rightmost
  // X-Forwarded-Host — only that entry was set by our proxy), so a visitor on
  // the standalone domain cannot bypass it by omitting the client flag. The
  // `standalone: true` body flag is additive (it drives the dev ?slmHost=1
  // preview, where there is no host dispatch).
  // When a signed-in consumer asks, their questions are keyed to their
  // account so the standalone chat can restore past conversations. Anonymous
  // (non-standalone /slm) questions keep the legacy shared session key.
  let logSessionId = "slm-agent";
  if (
    (req.body as { standalone?: unknown }).standalone === true ||
    isSlmStandaloneHost(req.headers)
  ) {
    // The standalone SLM chat is the ONLY answer surface that accepts a
    // provisional (unverified, browser-session) registration — it is free
    // and unlimited, so a provisional session grants nothing billable.
    const account = await getConsumerFromRequest(req, {
      allowProvisional: true,
    });
    if (!account) {
      // First taste is free: an unregistered visitor may ask ONE opening
      // question (no conversation history yet) so the first answer — with
      // citations and faculty faces — lands before any sign-in ask. A small
      // per-IP daily allowance backstops reload abuse; key on req.ip, never
      // client-supplied headers.
      const isOpeningQuestion = boundedHistory.length === 0;
      if (!isOpeningQuestion || !takeAnonFreeQuestion(req.ip ?? "unknown")) {
        res.status(401).json({
          registerRequired: true,
          error: "Please sign in with your email to ask questions.",
        });
        return;
      }
      // Anonymous rows keep the legacy shared session key: they are not
      // claimable as account history (and never restored on return visits).
    } else {
      const paceMsg = takeAccountQuestionSlot(account.id, Date.now(), {
        chatTurn: chatMode,
      });
      if (paceMsg) {
        res.status(429).json({ error: paceMsg });
        return;
      }
      logSessionId = consumerSessionKey(account.id);
    }
  }

  const queryId = randomUUID();
  const startedAt = Date.now();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  let slmPillars: SlmPillarSet;
  try {
    slmPillars = await loadSlmPillars();
  } catch (e) {
    req.log.error({ err: e }, "slm-agent pillar lookup failed");
    res.write(
      `data: ${JSON.stringify({ error: "Lookup failed", queryId })}\n\n`,
    );
    res.end();
    return;
  }

  // Apply pillar filter when the client supplied specific slugs (max 3).
  let activePillarIds = slmPillars.ids;
  let activeSlugToName = slmPillars.slugToName;
  if (Array.isArray(pillarSlugs) && pillarSlugs.length > 0) {
    const validSlugs = pillarSlugs.filter(
      (s): s is (typeof SLM_PILLAR_SLUGS)[number] =>
        (SLM_PILLAR_SLUGS as readonly string[]).includes(s),
    );
    if (validSlugs.length > 0) {
      activePillarIds = validSlugs
        .map((s) => slmPillars.slugToId[s])
        .filter((id): id is number => typeof id === "number");
      const filtered: Record<string, string> = {};
      for (const s of validSlugs) {
        if (slmPillars.slugToName[s]) filtered[s] = slmPillars.slugToName[s];
      }
      activeSlugToName = filtered;
    }
  }

  if (activePillarIds.length === 0) {
    const line =
      "UNCOVERED: No Stanford Lifestyle Medicine approved content is available yet.";
    res.write(`data: ${JSON.stringify({ content: line })}\n\n`);
    res.write(
      `data: ${JSON.stringify({
        provenance: [],
        pillarNames: [],
        queryId,
        uncovered: true,
        done: true,
      })}\n\n`,
    );
    res.end();
    return;
  }

  let provenance: ProvenanceEntry[] = [];
  let contextBlock: string;
  try {
    let result = await retrieve({
      question: message,
      pillarIds: activePillarIds,
      k: 8,
    });

    // NOTE: no history-contextualized retrieval retry here. Prepending prior
    // user turns to a below-threshold question lets an UNRELATED follow-up
    // ride the previous topic's coverage into the governed path (and client
    // history is untrusted, so it could be forced) — the coverage decision
    // must rest on the current question alone.

    if (result.chunks.length === 0 || result.topScore < RAG_MIN_SCORE) {
      // Outside the governed corpus — hand off to SLM AI Lab fallback.
      notifyUncoveredQuestion(message);

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
        const fallbackStream = buildSlmFallbackStream(message, {
          chat: chatMode,
          history: boundedHistory,
        });
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
        req.log.error({ err: e }, "slm-agent slm-fallback stream failed");
      }

      res.write(
        `data: ${JSON.stringify({
          provenance: [],
          // No governed pillar contributed to a fallback answer — an empty
          // list keeps the client from attributing it to pillar stewards.
          pillarNames: [],
          expertName: SLM_FALLBACK_EXPERT_NAME,
          stewardName: SLM_FALLBACK_STEWARD_NAME,
          pillarSlug: SLM_FALLBACK_PILLAR_SLUG,
          queryId,
          slmFallback: true,
          done: true,
        })}

`,
      );
      res.end();
      logSlmQuery({
        queryId,
        sessionId: logSessionId,
        pillarIds: activePillarIds,
        question: message,
        outcome: "uncovered",
        retrievedSourceIds: [],
        retrievedInterpretationIds: [],
        topScore: result.topScore,
        answerText: fallbackText.trim(),
        latencyMs: Date.now() - startedAt,
        inputTokens: fallbackInputTokens > 0 ? fallbackInputTokens : null,
        outputTokens: fallbackOutputTokens > 0 ? fallbackOutputTokens : null,
      });
      return;
    }

    provenance = buildProvenance(result.chunks);
    contextBlock = buildContextBlock(result.chunks);
  } catch (e) {
    req.log.error({ err: e }, "slm-agent retrieval failed");
    res.write(
      `data: ${JSON.stringify({ error: "Retrieval failed", queryId })}\n\n`,
    );
    res.end();
    return;
  }

  const langCode = typeof lang === "string" ? lang.slice(0, 10) : undefined;
  const systemPrompt = chatMode
    ? buildSlmChatSystemPrompt(contextBlock!, {
        stewardName: sanitizePromptField(stewardName, 120) || undefined,
        pillarName: sanitizePromptField(pillarName, 120) || undefined,
        lang: langCode,
      })
    : buildSlmSystemPrompt(contextBlock!, langCode);
  const messages = [
    ...boundedHistory,
    { role: "user" as const, content: message },
  ];

  try {
    let answerText = "";
    let llmInputTokens = 0;
    let llmOutputTokens = 0;
    const stream = anthropic.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });

    for await (const event of stream) {
      if (event.type === "message_start") {
        llmInputTokens = event.message.usage.input_tokens;
      } else if (event.type === "message_delta") {
        llmOutputTokens = event.usage.output_tokens;
      } else if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        answerText += event.delta.text;
        res.write(`data: ${JSON.stringify({ content: event.delta.text })}\n\n`);
      }
    }

    const trimmed = answerText.trim();
    const wasRefused = trimmed.startsWith("REFUSE:");
    const wasUncovered = trimmed.startsWith("UNCOVERED:");

    let citationVerification: CitationVerification | null = null;
    if (!wasRefused && !wasUncovered && provenance.length > 0) {
      citationVerification = verifyCitation(answerText, provenance);
      if (citationVerification.status === "unmatched") {
        req.log.warn(
          {
            queryId,
            surname: citationVerification.surname,
            year: citationVerification.year,
          },
          "slm-agent citation guard: citation not present in CONTEXT",
        );
      }
    }

    const contributingSlugs = new Set(
      provenance.map((p) => p.pillar_slug).filter(Boolean),
    );
    const pillarNames = [...contributingSlugs]
      .map((s) => activeSlugToName[s])
      .filter(Boolean) as string[];

    // Citation guard ENFORCEMENT: a fabricated citation means the streamed
    // answer cannot ship as-is. The done event carries a `correction` line
    // the client renders IN PLACE of the streamed text, and provenance is
    // suppressed entirely.
    const guardFailed = citationGuardTripped(citationVerification);

    // Suggested follow-up chips — covered answers only. Fallback, refused,
    // uncovered, and guard-failed outcomes never get chips. Fail-silent: []
    // on any error means the done event simply omits the field.
    const suggestedQuestions =
      wasRefused || wasUncovered || guardFailed
        ? []
        : await generateFollowUpSuggestions({
            question: message,
            answerText: trimmed,
            contextBlock: contextBlock!,
          }).catch(() => [] as string[]);

    res.write(
      `data: ${JSON.stringify({
        provenance:
          wasRefused || wasUncovered || guardFailed
            ? []
            : serializePublicProvenance(collapseSameWorkProvenance(provenance)),
        pillarNames,
        queryId,
        citationVerification,
        ...(guardFailed
          ? { correction: `UNCOVERED: ${CITATION_GUARD_BOUNDARY}` }
          : {}),
        ...(suggestedQuestions.length > 0 ? { suggestedQuestions } : {}),
        done: true,
      })}\n\n`,
    );
    res.end();

    logSlmQuery({
      queryId,
      sessionId: logSessionId,
      pillarIds: activePillarIds,
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
    });
  } catch (e) {
    res.write(
      `data: ${JSON.stringify({
        error: String((e as Error).message ?? e),
        queryId,
      })}\n\n`,
    );
    res.end();
  }
});

export default router;
