import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import {
  db,
  doorwayEventsTable,
  doorwayLinksTable,
  crisisTermsTable,
  phoneSubscribersTable,
  type CrisisTerm,
} from "@workspace/db";
import { buildTermRegex } from "./adviceGuard.js";
import { sendImessage } from "./imessage.js";
import { logger } from "./logger.js";

/**
 * Reply-as-doorway: a registered consumer texts our number in a hard moment
 * (canonically 3am) and instantly gets a short CANNED acknowledgment — never
 * an AI-generated message, never the steward's voice — plus one magic link
 * that opens the governed answer surface (/sleep) with their
 * message prefilled and comped past the free-question paywall.
 *
 * Standing product rule (unchanged): the text thread NEVER delivers agent
 * answers. The ack is a doorway; the answer always renders on-page.
 *
 * Pipeline order (each inbound message):
 *   1. Match sender → active phone_subscribers row (unknown/opted-out → log
 *      + ignore, no reply — spend/abuse control).
 *   2. Crisis screen, FAIL-CLOSED: a phrase match OR a screening error gets
 *      the static resources reply, no magic link, never the agent. Flagged
 *      events (with a text excerpt) surface in the admin review area.
 *   3. Rolling per-night cap (3 acks / 12h per sender): beyond it, a gentle
 *      final reply without a link.
 *   4. Otherwise: mint a 60-minute doorway link + send the canned ack.
 */

const BASE_URL = process.env.PUBLIC_URL ?? "https://palonur.replit.app";

/** Max acknowledged reply-cycles per sender per rolling 12h window. */
export const DOORWAY_NIGHT_CAP = 3;
const CAP_WINDOW_MS = 12 * 60 * 60 * 1000;

/** Doorway links live one hour; enough for "tap it now", useless tomorrow. */
export const DOORWAY_LINK_TTL_MS = 60 * 60 * 1000;
/**
 * NOT single-use: Apple fetches a URL preview before the user taps, and the
 * page may be refreshed. GET redirects and agent-route bypass checks share
 * this budget via an atomic increment.
 */
export const DOORWAY_LINK_MAX_USES = 8;

/** Product surface a doorway opens. Mirrors phone_subscribers.product. */
export type DoorwayProduct = "nightly";

export function doorwayPagePath(product: DoorwayProduct): string {
  return "/sleep";
}

/** SHA-256(phone + SESSION_SECRET) — raw numbers are never stored. */
export function phoneHash(phone: string): string {
  const salt = process.env.SESSION_SECRET ?? "dev-secret-change-me";
  return createHash("sha256").update(`${phone}${salt}`).digest("hex");
}

/**
 * Webhook-retry dedup key: the provider's message handle when present, else a
 * hash of sender + content + minute bucket (Sendblue has no reliable event id).
 */
export function doorwayDedupKey(
  body: Record<string, unknown>,
  phone: string,
  text: string,
): string {
  const handle =
    (typeof body.message_handle === "string" && body.message_handle) ||
    (typeof body.message_id === "string" && body.message_id) ||
    "";
  if (handle) return `handle:${handle}`;
  const minute = new Date().toISOString().slice(0, 16);
  return `derived:${createHash("sha256")
    .update(`${phone}|${text}|${minute}`)
    .digest("hex")}`;
}

// ── Crisis screen ────────────────────────────────────────────────────────────

/**
 * Code defaults. These SEED the admin-managed `crisis_terms` table when it is
 * empty and are the FALLBACK if the table can't be read — the screen can
 * never silently go blind. Matched case-insensitively on word boundaries.
 */
export const DEFAULT_CRISIS_TERMS: ReadonlyArray<string> = [
  "kill myself",
  "killing myself",
  "suicide",
  "suicidal",
  "end my life",
  "ending my life",
  "take my own life",
  "want to die",
  "wanna die",
  "wish i was dead",
  "wish i were dead",
  "better off dead",
  "no reason to live",
  "nothing to live for",
  "don't want to be alive",
  "dont want to be alive",
  "don't want to live",
  "dont want to live",
  "end it all",
  "hurt myself",
  "hurting myself",
  "harm myself",
  "harming myself",
  "self harm",
  "self-harm",
  "cut myself",
  "cutting myself",
  "overdose",
];

async function ensureCrisisTermsSeeded(): Promise<void> {
  const existing = await db
    .select({ id: crisisTermsTable.id })
    .from(crisisTermsTable)
    .limit(1);
  if (existing.length > 0) return;
  await db
    .insert(crisisTermsTable)
    .values(DEFAULT_CRISIS_TERMS.map((phrase) => ({ phrase, addedBy: "seed" })))
    .onConflictDoNothing();
}

/**
 * The effective crisis phrase list: admin-managed DB rows, seeded from the
 * code defaults, falling back to the defaults if the DB is unreachable.
 */
export async function getCrisisTerms(): Promise<
  Array<Pick<CrisisTerm, "id" | "phrase" | "addedBy">>
> {
  try {
    await ensureCrisisTermsSeeded();
    const rows = await db.select().from(crisisTermsTable);
    if (rows.length > 0) return rows;
  } catch {
    /* fall through to defaults */
  }
  return DEFAULT_CRISIS_TERMS.map((phrase, i) => ({
    id: -(i + 1),
    phrase,
    addedBy: "fallback",
  }));
}

/** True when the message matches any crisis phrase (word-boundary, ci). */
export async function screensAsCrisis(text: string): Promise<boolean> {
  const terms = await getCrisisTerms();
  return terms.some((t) => buildTermRegex(t.phrase).test(text));
}

// ── Canned copy (neutral Palonur voice — never the steward, never AI) ────────

export function ackMessage(link: string): string {
  return (
    "We hear you — hard moments like this are real, and they pass. " +
    "We've set up your answer here, ready when you are: " +
    link +
    " (Answers live on the page, not in this thread.)"
  );
}

export const CRISIS_REPLY =
  "We're not able to help with this by text, but real people can, right now: " +
  "call or text 988 (Suicide & Crisis Lifeline, 24/7), or text HOME to 741741 " +
  "(Crisis Text Line). If you're in immediate danger, call 911. Please reach out — " +
  "you matter.";

export function cappedMessage(): string {
  return (
    "We're going to pause this thread for tonight. Your earlier links still " +
    "work, and everything is waiting for you at " +
    BASE_URL +
    ". Be gentle with yourself tonight."
  );
}

// ── Doorway links ────────────────────────────────────────────────────────────

/**
 * Grace window after expiry during which a stale link still carries the
 * question (?q= redirect without the comp). Past it, the stored message is
 * blanked — the user's raw despair text should not persist indefinitely.
 */
export const DOORWAY_QUESTION_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Blank the stored question on links well past expiry. Best-effort and
 * opportunistic (piggybacks on each new mint) so no scheduler is needed;
 * the row itself stays for the shared use-count/audit trail.
 */
export async function pruneStaleDoorwayQuestions(): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - DOORWAY_QUESTION_RETENTION_MS);
    const rows = await db
      .update(doorwayLinksTable)
      .set({ question: "" })
      .where(
        and(
          sql`${doorwayLinksTable.expiresAt} < ${cutoff}`,
          sql`${doorwayLinksTable.question} <> ''`,
        ),
      )
      .returning({ id: doorwayLinksTable.id });
    return rows.length;
  } catch (err) {
    logger.warn({ err }, "doorway question prune failed");
    return 0;
  }
}

export async function mintDoorwayLink(opts: {
  doorwayEventId: number;
  product: DoorwayProduct;
  question: string;
}): Promise<string> {
  const token = randomBytes(24).toString("hex");
  await db.insert(doorwayLinksTable).values({
    token,
    doorwayEventId: opts.doorwayEventId,
    product: opts.product,
    question: opts.question,
    expiresAt: new Date(Date.now() + DOORWAY_LINK_TTL_MS),
  });
  // Fire-and-forget: each new doorway sweeps yesterday's stored questions.
  void pruneStaleDoorwayQuestions();
  return token;
}

export interface DoorwayLinkUse {
  product: DoorwayProduct;
  question: string;
}

/**
 * Atomically consume one use of a doorway token. Returns the link payload
 * while the token is valid (unexpired, under the use budget), else null.
 * Shared by the GET redirect and the agent-route paywall bypass so the total
 * budget is one counter.
 */
export async function useDoorwayToken(
  token: string,
): Promise<DoorwayLinkUse | null> {
  if (!token || token.length > 128) return null;
  try {
    const rows = await db
      .update(doorwayLinksTable)
      .set({ usedCount: sql`${doorwayLinksTable.usedCount} + 1` })
      .where(
        and(
          eq(doorwayLinksTable.token, token),
          gt(doorwayLinksTable.expiresAt, new Date()),
          sql`${doorwayLinksTable.usedCount} < ${DOORWAY_LINK_MAX_USES}`,
        ),
      )
      .returning({
        product: doorwayLinksTable.product,
        question: doorwayLinksTable.question,
      });
    const row = rows[0];
    if (!row) return null;
    const product: DoorwayProduct = "nightly";
    return { product, question: row.question };
  } catch (err) {
    logger.warn({ err }, "doorway token use failed");
    return null;
  }
}

/**
 * Read-only peek at an expired/exhausted link so the GET redirect can still
 * land the user on the right page with their question (without the comp).
 */
export async function peekDoorwayToken(
  token: string,
): Promise<DoorwayLinkUse | null> {
  if (!token || token.length > 128) return null;
  try {
    const rows = await db
      .select({
        product: doorwayLinksTable.product,
        question: doorwayLinksTable.question,
      })
      .from(doorwayLinksTable)
      .where(eq(doorwayLinksTable.token, token))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const product: DoorwayProduct = "nightly";
    return { product, question: row.question };
  } catch {
    return null;
  }
}

// ── Inbound pipeline ─────────────────────────────────────────────────────────

export type DoorwayOutcome =
  | "ack"
  | "crisis"
  | "capped"
  | "ignored"
  | "duplicate";

export interface DoorwayInboundResult {
  outcome: DoorwayOutcome;
}

interface MatchedSender {
  product: DoorwayProduct;
  consumerAccountId: number | null;
}

/**
 * Match the sender to a registered (active) phone opt-in. The phone row's
 * Registered numbers open the sleep surface.
 */
async function matchSender(phone: string): Promise<MatchedSender | null> {
  const rows = await db
    .select({
      product: phoneSubscribersTable.product,
      status: phoneSubscribersTable.status,
      consumerAccountId: phoneSubscribersTable.consumerAccountId,
    })
    .from(phoneSubscribersTable)
    .where(eq(phoneSubscribersTable.phone, phone));
  const active = rows.filter((r) => r.status === "active");
  if (active.length === 0) return null;
  const product: DoorwayProduct = "nightly";
  const withAccount = active.find((r) => r.consumerAccountId != null);
  return {
    product,
    consumerAccountId: withAccount?.consumerAccountId ?? null,
  };
}

async function countRecentAcks(hash: string): Promise<number> {
  const since = new Date(Date.now() - CAP_WINDOW_MS);
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(doorwayEventsTable)
    .where(
      and(
        eq(doorwayEventsTable.fromPhoneHash, hash),
        eq(doorwayEventsTable.outcome, "ack"),
        gt(doorwayEventsTable.createdAt, since),
      ),
    );
  return rows[0]?.n ?? 0;
}

/** Insert the event row; returns null when the dedup key already exists. */
async function recordEvent(values: {
  fromPhoneHash: string;
  consumerAccountId: number | null;
  product: DoorwayProduct;
  bodyExcerpt: string | null;
  crisisFlagged: boolean;
  outcome: DoorwayOutcome;
  providerEventId: string;
}): Promise<number | null> {
  const rows = await db
    .insert(doorwayEventsTable)
    .values(values)
    .onConflictDoNothing({ target: doorwayEventsTable.providerEventId })
    .returning({ id: doorwayEventsTable.id });
  return rows[0]?.id ?? null;
}

/**
 * Handle one trusted (webhook-authenticated) inbound message that is not a
 * STOP/START consent command. Never throws; always resolves to an outcome.
 */
export async function handleDoorwayInbound(opts: {
  phone: string;
  text: string;
  providerEventId: string;
}): Promise<DoorwayInboundResult> {
  const { phone, providerEventId } = opts;
  const text = String(opts.text ?? "").trim();
  const hash = phoneHash(phone);

  try {
    if (!text) return { outcome: "ignored" };

    const sender = await matchSender(phone);
    if (!sender) {
      // Unknown or opted-out sender: log only, never reply (spend/abuse
      // control — a reply to an unverified number is paid spam).
      await recordEvent({
        fromPhoneHash: hash,
        consumerAccountId: null,
        product: "nightly",
        bodyExcerpt: null,
        crisisFlagged: false,
        outcome: "ignored",
        providerEventId,
      });
      logger.info("doorway: ignored inbound from unregistered number");
      return { outcome: "ignored" };
    }

    // Crisis screen — FAIL CLOSED: any error in screening is treated as a
    // match. A crisis reply to a non-crisis message is a tolerable mistake;
    // the reverse is not.
    let crisis = true;
    try {
      crisis = await screensAsCrisis(text);
    } catch (err) {
      logger.error({ err }, "doorway crisis screen errored — failing closed");
      crisis = true;
    }

    if (crisis) {
      const id = await recordEvent({
        fromPhoneHash: hash,
        consumerAccountId: sender.consumerAccountId,
        product: sender.product,
        bodyExcerpt: text.slice(0, 500),
        crisisFlagged: true,
        outcome: "crisis",
        providerEventId,
      });
      if (id == null) return { outcome: "duplicate" };
      await sendImessage({
        to: phone,
        body: CRISIS_REPLY,
        label: "doorway crisis resources",
      });
      return { outcome: "crisis" };
    }

    const recentAcks = await countRecentAcks(hash);
    if (recentAcks >= DOORWAY_NIGHT_CAP) {
      const id = await recordEvent({
        fromPhoneHash: hash,
        consumerAccountId: sender.consumerAccountId,
        product: sender.product,
        bodyExcerpt: null,
        crisisFlagged: false,
        outcome: "capped",
        providerEventId,
      });
      if (id == null) return { outcome: "duplicate" };
      await sendImessage({
        to: phone,
        body: cappedMessage(),
        label: "doorway capped notice",
      });
      return { outcome: "capped" };
    }

    const eventId = await recordEvent({
      fromPhoneHash: hash,
      consumerAccountId: sender.consumerAccountId,
      product: sender.product,
      bodyExcerpt: null,
      crisisFlagged: false,
      outcome: "ack",
      providerEventId,
    });
    if (eventId == null) return { outcome: "duplicate" };

    const token = await mintDoorwayLink({
      doorwayEventId: eventId,
      product: sender.product,
      question: text.slice(0, 2000),
    });
    await sendImessage({
      to: phone,
      body: ackMessage(`${BASE_URL}/api/doorway/${token}`),
      label: "doorway acknowledgment",
    });
    return { outcome: "ack" };
  } catch (err) {
    logger.error({ err }, "doorway inbound pipeline failed");
    return { outcome: "ignored" };
  }
}
