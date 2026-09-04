/**
 * Background visitor records for the consumer agent surfaces ("auto-create").
 *
 * Every anonymous browser asking the sleep agent already has
 * a `palonur_session` cookie. These helpers persist that session as a
 * `visitor_sessions` row — created silently on the first ask — and later link
 * it to a `consumer_accounts` identity when the visitor saves an answer, then
 * stamp `claimed_at` when their emailed magic link is consumed (email proven).
 *
 * Every write here is best-effort: a visitor-record failure must never break
 * an answer or a sign-in.
 */
import { db, visitorSessionsTable } from "@workspace/db";
import { logger } from "./logger.js";

/**
 * Fire-and-forget upsert: ensure a visitor row exists for this session and
 * bump `last_seen_at`. Called from the agent routes on every browser ask;
 * never awaited on the answer path.
 */
export function touchVisitorSession(sessionId: string): void {
  if (!sessionId) return;
  void db
    .insert(visitorSessionsTable)
    .values({ sessionId })
    .onConflictDoUpdate({
      target: visitorSessionsTable.sessionId,
      set: { lastSeenAt: new Date() },
    })
    .catch((err) => {
      logger.warn({ err }, "visitor_sessions touch failed (non-fatal)");
    });
}

/**
 * Link a visitor session to a consumer account (the visitor typed their email
 * to save an answer — ownership not yet proven, so `claimed_at` stays null).
 */
export async function linkVisitorSessionToAccount(
  sessionId: string,
  consumerAccountId: number,
): Promise<void> {
  if (!sessionId) return;
  await db
    .insert(visitorSessionsTable)
    .values({ sessionId, consumerAccountId })
    .onConflictDoUpdate({
      target: visitorSessionsTable.sessionId,
      set: { consumerAccountId, lastSeenAt: new Date() },
    });
}

/**
 * Fire-and-forget claim: the magic link was consumed in this browser, so the
 * email is proven — link the session to the account and stamp `claimed_at`.
 */
export function claimVisitorSession(
  sessionId: string | undefined,
  consumerAccountId: number,
): void {
  if (!sessionId) return;
  const now = new Date();
  void db
    .insert(visitorSessionsTable)
    .values({ sessionId, consumerAccountId, claimedAt: now })
    .onConflictDoUpdate({
      target: visitorSessionsTable.sessionId,
      set: { consumerAccountId, claimedAt: now, lastSeenAt: now },
    })
    .catch((err) => {
      logger.warn({ err }, "visitor_sessions claim failed (non-fatal)");
    });
}
