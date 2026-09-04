/**
 * Shared consumer paywall helpers for governed agent routes.
 *
 * The sleep-agent pioneered a "few free questions, then a Palonur Nightly
 * paywall" gate for consumer browser traffic. This module factors out the two
 * pieces shared governed surfaces need:
 *
 *   - FREE_QUESTION_LIMIT — the env-driven number of free answers a browser
 *     session gets, scoped to shared consumers (session-total). NOTE:
 *     the sleep-agent has since DIVERGED — it owns a separate per-day limit
 *     (SLEEP_FREE_DAILY_QUESTION_LIMIT, default 1, resets at UTC midnight) and
 *     no longer reads this value, so the two surfaces are intentionally
 *     decoupled and never move in lockstep,
 *   - ensureSessionId — the anonymous `palonur_session` cookie used to key the
 *     tally (shared with the sleep-agent so a session is one identity),
 *   - makeFreeQuestionCounter — a namespaced in-memory tally so each surface
 *     counts its own free questions independently.
 *
 * Subscription/entitlement state still comes from the existing consumer auth
 * helpers (getRequestEntitlement); one active Palonur Nightly subscription
 * unlocks unlimited answers on every surface.
 */
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";

/** Anonymous browser-session cookie, shared with the sleep-agent. */
const SESSION_COOKIE = "palonur_session";
const SESSION_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Number of free premium answers a browser session gets before the paywall for shared consumer surfaces. The sleep-agent does NOT
 * read this — it owns its own per-day SLEEP_FREE_DAILY_QUESTION_LIMIT — so the
 * two surfaces are intentionally decoupled. Only applies to consumer browser
 * traffic — partner-key callers and active subscribers are never gated.
 */
export const FREE_QUESTION_LIMIT = (() => {
  const raw = Number(process.env.FREE_QUESTION_LIMIT);
  return Number.isFinite(raw) && raw >= 0 ? raw : 3;
})();

/**
 * Resolve (or mint) the anonymous browser-session id, persisting it as an
 * httpOnly cookie. Must be called before the first `res.write`.
 */
export function ensureSessionId(req: Request, res: Response): string {
  const existing = req.cookies?.[SESSION_COOKIE];
  if (typeof existing === "string" && existing.length > 0) return existing;
  const fresh = randomUUID();
  res.cookie(SESSION_COOKIE, fresh, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE_MS,
    path: "/",
  });
  return fresh;
}

const FREE_COUNT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Build a per-surface free-question tally. Same single-process tradeoff as the
 * partner-key rate counters: correct for the current single Node process; would
 * need Redis/DB if we scale horizontally. Entries self-evict after 30 days of
 * inactivity so the map stays bounded. The returned function increments and
 * returns the number of gated questions this session has used.
 */
export function makeFreeQuestionCounter(): (sessionId: string) => number {
  const counts = new Map<string, { count: number; lastSeen: number }>();
  return (sessionId: string): number => {
    const now = Date.now();
    const entry = counts.get(sessionId);
    if (!entry || now - entry.lastSeen >= FREE_COUNT_TTL_MS) {
      counts.set(sessionId, { count: 1, lastSeen: now });
      if (counts.size > 5000) {
        for (const [k, v] of counts) {
          if (now - v.lastSeen >= FREE_COUNT_TTL_MS) counts.delete(k);
        }
      }
      return 1;
    }
    entry.count += 1;
    entry.lastSeen = now;
    return entry.count;
  };
}
