import { createHash } from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  db,
  pillarsTable,
  sourcesTable,
  facultyUsersTable,
  gapDiscoveryEventsTable,
  agentQueriesTable,
} from "@workspace/db";
import { searchTalks, scrapeMarkdown, isFirecrawlConfigured } from "./firecrawl.js";
import { ingestSource } from "./ingestSource.js";
import { getResendClient } from "./resendClient.js";
import { sendGuarded } from "./emailGuard.js";
import { logger } from "./logger.js";

/**
 * Gap-triggered Stanford material discovery (owner directive: "never show a
 * refusal, only show boundaries; search for Stanford material if we don't
 * have it yet indexed; always notify karan@palonur.com").
 *
 * Fired fire-and-forget when the sleep-agent answers UNCOVERED for a question
 * that routed to specific pillars. GOVERNED path, explicitly chosen by the
 * owner: discovered material is ingested as a DRAFT source into the routed
 * pillar's steward approval queue and is NEVER quoted before a steward
 * approves it (retrieval gates on status='approved'). The reader-visible
 * answer stays a boundary line; the escalation card explains material goes
 * to review.
 *
 * Email policy: karanNotify already emails Karan on EVERY question and the
 * frontend auto-fires /uncovered-escalation on every UNCOVERED — so this
 * module sends email ONLY when it actually queues new draft material (a
 * distinct event), via sendGuarded.
 *
 * Abuse bounds:
 * - Hardcoded Stanford domain allowlist — the search domain is never derived
 *   from user input (no SSRF-shaped drift), and off-allowlist search results
 *   are dropped.
 * - URL dedupe against `sources` in ANY status (an already-rejected URL is
 *   never re-queued).
 * - In-memory 24h per-question-hash guard + a daily discovery-run cap.
 *   Single-process tradeoff, same as freeQuestionCounts: a restart resets
 *   them, which at worst allows a few duplicate searches (URL dedupe still
 *   prevents duplicate drafts).
 */

const STANFORD_DOMAIN_ALLOWLIST = [
  "lifestylemedicine.stanford.edu",
  "med.stanford.edu",
  "longevity.stanford.edu",
] as const;

/** Domain the search query is scoped to (primary SLM site). */
const SEARCH_DOMAIN = "lifestylemedicine.stanford.edu";

const KARAN = "karan@palonur.com";
const CUSTODIAN_EMAIL = "custodian@palonur.com";
const QUESTION_GUARD_MS = 24 * 60 * 60 * 1000;
const MIN_SCRAPE_CHARS = 400;

function dailyCap(): number {
  const raw = Number(process.env.GAP_DISCOVERY_DAILY_CAP ?? "12");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 12;
}

const recentQuestionHashes = new Map<string, number>();
let dailyWindow = { day: "", count: 0 };

function questionHash(question: string): string {
  return createHash("sha256")
    .update(question.trim().toLowerCase().replace(/\s+/g, " "))
    .digest("hex");
}

function underDailyCap(): boolean {
  const day = new Date().toISOString().slice(0, 10);
  if (dailyWindow.day !== day) dailyWindow = { day, count: 0 };
  return dailyWindow.count < dailyCap();
}

function chargeDaily(): void {
  dailyWindow.count++;
}

function isAllowlistedUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return STANFORD_DOMAIN_ALLOWLIST.some(
      (d) => host === d || host.endsWith(`.${d}`),
    );
  } catch {
    return false;
  }
}

function normalizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.hash = "";
    let out = u.toString();
    if (out.endsWith("/")) out = out.slice(0, -1);
    return out;
  } catch {
    return rawUrl;
  }
}

async function urlAlreadyKnown(url: string): Promise<boolean> {
  // Dedupe in ANY status and across ALL pillars: a URL a steward already
  // rejected (or that sits in review) must never be re-queued.
  const [row] = await db
    .select({ id: sourcesTable.id })
    .from(sourcesTable)
    .where(eq(sourcesTable.sourceUrl, url))
    .limit(1);
  return Boolean(row);
}

async function ensureCustodian(): Promise<number> {
  const [existing] = await db
    .select({ id: facultyUsersTable.id })
    .from(facultyUsersTable)
    .where(eq(facultyUsersTable.email, CUSTODIAN_EMAIL))
    .limit(1);
  if (existing) return existing.id;
  const [created] = await db
    .insert(facultyUsersTable)
    .values({
      clerkUserId: `pending:${CUSTODIAN_EMAIL}`,
      email: CUSTODIAN_EMAIL,
      fullName: "Palonur Custodian",
    })
    .returning({ id: facultyUsersTable.id });
  logger.info({ id: created.id }, "Bootstrapped custodian faculty account");
  return created.id;
}

export interface GapDiscoveryResult {
  outcome:
    | "queued"
    | "skipped_guard"
    | "skipped_cap"
    | "skipped_unconfigured"
    | "no_candidates"
    | "scrape_failed"
    | "pillar_missing";
  sourceId?: number;
  url?: string;
  title?: string;
  pillarSlug?: string;
}

async function emailKaranMaterialQueued(params: {
  question: string;
  pillarSlug: string;
  pillarName: string;
  title: string;
  url: string;
  sourceId: number;
}): Promise<void> {
  const conn = await getResendClient();
  if (!conn) {
    logger.warn("Resend unconfigured — gap-discovery email skipped");
    return;
  }
  const publicUrl = process.env.PUBLIC_URL ?? "https://palonur.replit.app";
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const from =
    process.env.STORY_FROM ??
    (conn.fromEmail.includes("<")
      ? conn.fromEmail
      : `Palonur <${conn.fromEmail}>`);
  await sendGuarded(
    conn.client,
    {
      from,
      to: KARAN,
      subject: `Gap filled: Stanford material queued for steward review (${params.pillarName})`,
      html: [
        `<p>A reader question hit the edge of the reviewed knowledge map, and the gap-discovery search found Stanford material for it.</p>`,
        `<p><strong>Question:</strong> ${esc(params.question)}</p>`,
        `<p><strong>Pillar:</strong> ${esc(params.pillarName)} (${esc(params.pillarSlug)})</p>`,
        `<p><strong>Material found:</strong> <a href="${esc(params.url)}">${esc(params.title)}</a></p>`,
        `<p>It is now a <strong>draft source (#${params.sourceId})</strong> in the ${esc(params.pillarName)} steward approval queue. Nothing is quoted to readers until a steward approves it.</p>`,
        `<p><a href="${publicUrl.replace(/\/$/, "")}/faculty">Open the faculty portal</a></p>`,
      ].join("\n"),
    },
    { label: "stanford-gap-discovery" },
  );
}

/** Awaitable core (exported for tests; production callers use the
 * fire-and-forget `maybeDiscoverStanfordMaterial` wrapper). */
export async function runGapDiscovery(params: {
  question: string;
  pillarIds: number[];
}): Promise<GapDiscoveryResult> {
  const { question, pillarIds } = params;

  const hash = questionHash(question);
  const seenAt = recentQuestionHashes.get(hash);
  if (seenAt && Date.now() - seenAt < QUESTION_GUARD_MS) {
    return { outcome: "skipped_guard" };
  }
  if (!underDailyCap()) return { outcome: "skipped_cap" };
  if (!isFirecrawlConfigured()) return { outcome: "skipped_unconfigured" };

  // Record the attempt up front so racing duplicates of the same question
  // don't fan out into parallel searches; expired entries are pruned lazily.
  recentQuestionHashes.set(hash, Date.now());
  for (const [k, ts] of recentQuestionHashes) {
    if (Date.now() - ts > QUESTION_GUARD_MS) recentQuestionHashes.delete(k);
  }
  chargeDaily();

  const [pillar] = await db
    .select({
      id: pillarsTable.id,
      slug: pillarsTable.slug,
      name: pillarsTable.name,
    })
    .from(pillarsTable)
    .where(eq(pillarsTable.id, pillarIds[0]))
    .limit(1);
  if (!pillar) return { outcome: "pillar_missing" };

  const results = await searchTalks(
    `${question} site:${SEARCH_DOMAIN}`,
    { limit: 5 },
  );
  const candidates = results
    .filter((r) => isAllowlistedUrl(r.url))
    .map((r) => ({ ...r, url: normalizeUrl(r.url) }));

  let picked: { url: string; title: string } | null = null;
  for (const c of candidates) {
    if (!(await urlAlreadyKnown(c.url))) {
      picked = c;
      break;
    }
  }
  if (!picked) return { outcome: "no_candidates" };

  const markdown = await scrapeMarkdown(picked.url);
  if (!markdown || markdown.trim().length < MIN_SCRAPE_CHARS) {
    return { outcome: "scrape_failed", url: picked.url };
  }

  const custodianId = await ensureCustodian();
  const result = await ingestSource({
    pillarId: pillar.id,
    uploadedByUserId: custodianId,
    meta: {
      kind: "slm_article",
      title: picked.title,
      journal: "Stanford Lifestyle Medicine",
      sourceUrl: picked.url,
      // Discovery has no evidence of reusable full-text rights. It can create
      // a private review draft, but final approval atomically purges raw text.
      rightsBasis: "no_documented_full_text_rights",
    },
    fullText: markdown,
    fallbackTitle: picked.url,
  });

  // Persist the trigger→material link so the refusal-evidence surface can
  // show a REAL story (question → queued → steward-approved). Best-effort:
  // evidence bookkeeping must never break the discovery run itself.
  try {
    await db.insert(gapDiscoveryEventsTable).values({
      question: question.trim(),
      pillarId: pillar.id,
      sourceId: result.source.id,
    });
  } catch (err) {
    logger.warn({ err }, "Failed to record gap discovery event");
  }

  await emailKaranMaterialQueued({
    question,
    pillarSlug: pillar.slug,
    pillarName: pillar.name,
    title: result.source.title,
    url: picked.url,
    sourceId: result.source.id,
  });

  return {
    outcome: "queued",
    sourceId: result.source.id,
    url: picked.url,
    title: result.source.title,
    pillarSlug: pillar.slug,
  };
}

/**
 * Fire-and-forget entry point. Never throws, never blocks the response.
 * Call AFTER the final UNCOVERED classification with the pillar ids captured
 * BEFORE the fallback scrub (fallback fan-outs are unattributed gaps and
 * must skip discovery rather than guess a pillar).
 */
export function maybeDiscoverStanfordMaterial(params: {
  question: string;
  pillarIds: number[];
}): void {
  if (params.pillarIds.length === 0) return;
  void runGapDiscovery(params)
    .then((result) => {
      if (result.outcome === "queued") {
        logger.info({ result }, "Gap discovery queued Stanford material for review");
      } else if (result.outcome !== "skipped_guard") {
        logger.info({ result }, "Gap discovery finished without queuing");
      }
    })
    .catch((err) => logger.warn({ err }, "Gap discovery failed"));
}

/** Test-only: reset the in-memory guards. */
export function __resetGapDiscoveryGuardsForTests(): void {
  recentQuestionHashes.clear();
  dailyWindow = { day: "", count: 0 };
}

// ---------------------------------------------------------------------------
// Refusal evidence — the public "a real refusal, what it triggered, what
// happened next" story shown on the answer page's boundary states.
// ---------------------------------------------------------------------------

export type RefusalEvidence = {
  /** Latest displayable real case, preferring one whose material a steward
   * has since APPROVED (the completed story). Null until data accumulates. */
  story: {
    question: string;
    pillarName: string;
    sourceTitle: string;
    queuedAt: string;
    approved: boolean;
  } | null;
  /** Real telemetry: questions that hit the knowledge edge in the last 30
   * days. Null when the count query fails (never fabricate a number). */
  uncoveredCount30d: number | null;
};

/**
 * Privacy guard for publicly displaying a reader's question verbatim.
 * Conservative: skip anything with an email, a phone-like digit run, an URL,
 * or unusual length. Questions are anonymous, but readers occasionally type
 * personal details — those must never surface on a public page.
 */
export function isDisplayableQuestion(q: string): boolean {
  const t = q.trim();
  if (t.length < 12 || t.length > 200) return false;
  if (/@/.test(t)) return false;
  if (/(?:\d[\s\-.()]*){7,}/.test(t)) return false;
  if (/https?:\/\//i.test(t)) return false;
  return true;
}

/**
 * Best real story available right now. Scans recent queued events (joined to
 * the source's CURRENT status so the story stays truthful if a steward later
 * archives the material), filters through the privacy guard, prefers an
 * approved (completed) story, and falls back to the newest pending one.
 */
export async function getRefusalEvidence(): Promise<RefusalEvidence> {
  const rows = await db
    .select({
      question: gapDiscoveryEventsTable.question,
      queuedAt: gapDiscoveryEventsTable.createdAt,
      pillarName: pillarsTable.name,
      sourceTitle: sourcesTable.title,
      sourceStatus: sourcesTable.status,
    })
    .from(gapDiscoveryEventsTable)
    .innerJoin(sourcesTable, eq(gapDiscoveryEventsTable.sourceId, sourcesTable.id))
    .innerJoin(pillarsTable, eq(gapDiscoveryEventsTable.pillarId, pillarsTable.id))
    .orderBy(desc(gapDiscoveryEventsTable.createdAt))
    .limit(25);

  const displayable = rows.filter(
    (r) =>
      isDisplayableQuestion(r.question) &&
      (r.sourceStatus === "approved" ||
        r.sourceStatus === "draft" ||
        r.sourceStatus === "in_review"),
  );
  const picked =
    displayable.find((r) => r.sourceStatus === "approved") ??
    displayable[0] ??
    null;

  let uncoveredCount30d: number | null = null;
  try {
    const [agg] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(agentQueriesTable)
      .where(
        and(
          eq(agentQueriesTable.wasUncovered, true),
          gte(agentQueriesTable.createdAt, sql`now() - interval '30 days'`),
        ),
      );
    uncoveredCount30d = agg?.n ?? 0;
  } catch (err) {
    logger.warn({ err }, "Refusal-evidence uncovered count failed");
  }

  return {
    story: picked
      ? {
          question: picked.question,
          pillarName: picked.pillarName,
          sourceTitle: picked.sourceTitle,
          queuedAt: picked.queuedAt.toISOString(),
          approved: picked.sourceStatus === "approved",
        }
      : null,
    uncoveredCount30d,
  };
}
