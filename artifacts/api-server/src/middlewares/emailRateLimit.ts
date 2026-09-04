import type { Request, Response, NextFunction } from "express";
import { createHash } from "node:crypto";
import { logger } from "../lib/logger";
import pool from "../lib/db.js";

/**
 * Per-IP + per-email throttle for the anonymous, email-triggering auth
 * endpoints (`/consumer/auth/request`, `/billing/confirm`,
 * `/stories-auth/request`, `/investor-auth/request`).
 *
 * Each of those fires a Resend send on every request with no authentication,
 * so without a throttle a single client can email-bomb any address and burn the
 * account's monthly quota. This limiter caps how often the *endpoint* can be
 * called — it is purely request-rate based and reveals nothing about whether an
 * account/email exists, so the routes keep their generic "never leak existence"
 * success bodies. A throttled caller gets a 429 with `Retry-After`.
 *
 * Counts are backed by the `email_rate_limit_hits` table (one row per ALLOWED
 * hit) as a DB-backed sliding window: it counts rows for a `(scope, key)` whose
 * `hit_at` falls in the last window before each request. Unlike the old
 * in-memory Map, this is SHARED across instances and survives restarts — an
 * in-memory counter reset to zero on every redeploy/restart and counted
 * per-process, so once the api-server scaled past one instance an attacker could
 * get N× the limit. The keys are SHA-256 hashes (never the raw IP/email), so the
 * throttle log carries no PII.
 *
 * The DB-backed send caps in `emailGuard` remain the hard backstop; this throttle
 * is best-effort and fails OPEN on a DB error so a transient blip can't lock real
 * users out of sign-in.
 */

// Conservative defaults. A real user needs ~1 link per sign-in attempt; these
// leave generous headroom for typos/retries while stopping a flood.
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const IP_LIMIT = 5; // requests per IP per window
const EMAIL_LIMIT = 3; // tighter cap per target email per window

type Scope = "ip" | "email";

function clientIp(req: Request): string {
  // `trust proxy` is set in app.ts, so req.ip is the real client (untrusted
  // client-supplied X-Forwarded-For hops can't spoof it).
  return req.ip || req.socket.remoteAddress || "unknown";
}

/**
 * SHA-256 of the bucket value salted with SESSION_SECRET — same privacy posture
 * as the Stories IP hash and the `email_sends` recipient hash, so the throttle
 * log never stores a raw IP or email address.
 */
function hashKey(value: string): string {
  const salt = process.env.SESSION_SECRET ?? "dev-secret-change-me";
  return createHash("sha256").update(`${value}${salt}`).digest("hex");
}

/**
 * Record a hit against one bucket using a DB-backed sliding window. Returns the
 * retry-after seconds when the caller is over the limit, or null when the hit is
 * allowed (and a row was recorded). Fails OPEN (returns null) on any DB error.
 *
 * The count → decide → insert sequence is made atomic *per bucket* by taking a
 * Postgres transaction-scoped advisory lock keyed on `(scope, key)` first.
 * Advisory locks are cluster-wide, so this serializes every concurrent decision
 * for the same IP/email across ALL api-server instances — without it, N parallel
 * requests would each read the same pre-insert count, all pass the check, and all
 * insert, overshooting the cap by N× (precisely the horizontal-scaling bypass
 * this throttle exists to prevent). The lock is released automatically on
 * COMMIT/ROLLBACK.
 */
async function hit(
  scope: string,
  rawKey: string,
  limit: number,
  now: number,
  windowMs: number = WINDOW_MS,
): Promise<number | null> {
  const key = hashKey(rawKey);
  const windowStart = new Date(now - windowMs).toISOString();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize all decisions for this bucket, cluster-wide, for the duration of
    // the transaction. `hashtextextended` gives a stable 64-bit lock key.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`${scope}:${key}`],
    );

    // Count hits still inside the sliding window and find the oldest one (used
    // to compute when the caller drops back under the limit).
    const { rows } = await client.query<{ cnt: string; oldest: string | null }>(
      `SELECT count(*) AS cnt, min(hit_at) AS oldest
         FROM email_rate_limit_hits
        WHERE scope = $1 AND key = $2 AND hit_at >= $3`,
      [scope, key, windowStart],
    );
    const count = Number(rows[0]?.cnt ?? 0);
    if (count >= limit) {
      const oldest = rows[0]?.oldest ? new Date(rows[0].oldest).getTime() : now;
      await client.query("COMMIT"); // nothing written; just release the lock
      return Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
    }
    // Allowed: record the hit and opportunistically prune rows that have aged
    // out of the window so the table stays small.
    await client.query(
      `INSERT INTO email_rate_limit_hits (scope, key, hit_at) VALUES ($1, $2, $3)`,
      [scope, key, new Date(now).toISOString()],
    );
    await client.query(
      `DELETE FROM email_rate_limit_hits
        WHERE scope = $1 AND key = $2 AND hit_at < $3`,
      [scope, key, windowStart],
    );
    await client.query("COMMIT");
    return null;
  } catch (err) {
    // Fail open: a DB blip must not break sign-in. The emailGuard send caps are
    // the hard backstop against quota burn.
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore — the connection is being released anyway
    }
    logger.warn({ err, scope }, "emailRateLimit DB check failed — failing open");
    return null;
  } finally {
    client.release();
  }
}

/**
 * Programmatic per-bucket throttle for callers that aren't the auth-endpoint
 * middleware (e.g. the inbound newsletter-reply webhook rate-limiting per
 * sender). Reuses the same DB-backed sliding window + advisory lock as the
 * middleware, so it shares the `email_rate_limit_hits` table and fails OPEN on a
 * DB error. Pick a distinct `scope` so buckets don't collide with the auth caps.
 */
export async function enforceRateLimit(args: {
  scope: string;
  key: string;
  limit: number;
  windowMs?: number;
}): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const retry = await hit(
    args.scope,
    args.key,
    args.limit,
    Date.now(),
    args.windowMs ?? WINDOW_MS,
  );
  return retry === null
    ? { allowed: true, retryAfterSec: 0 }
    : { allowed: false, retryAfterSec: retry };
}

function reject(res: Response, retryAfterSec: number): void {
  res.setHeader("Retry-After", String(retryAfterSec));
  res.status(429).json({
    error: "rate_limited",
    message: "Too many requests. Please wait a few minutes and try again.",
    retry_after: retryAfterSec,
  });
}

/**
 * Express middleware enforcing the per-IP and (when the body carries one)
 * per-email caps. Mount it before any handler that sends an email on an
 * unauthenticated request.
 */
export function emailRateLimit(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const now = Date.now();
  const ip = clientIp(req);

  void (async () => {
    const ipRetry = await hit("ip", ip, IP_LIMIT, now);
    if (ipRetry !== null) {
      reject(res, ipRetry);
      return;
    }

    const rawEmail = (req.body as { email?: unknown } | undefined)?.email;
    if (typeof rawEmail === "string" && rawEmail.trim()) {
      const email = rawEmail.trim().toLowerCase();
      const emailRetry = await hit("email", email, EMAIL_LIMIT, now);
      if (emailRetry !== null) {
        reject(res, emailRetry);
        return;
      }
    }

    next();
  })().catch((err: unknown) => {
    // Defensive: any unexpected error must not hang the request. Fail open.
    logger.warn({ err }, "emailRateLimit unexpected error — failing open");
    next();
  });
}

/**
 * Periodic sweep: delete every `email_rate_limit_hits` row that has aged out of
 * the sliding window. The per-request path in `hit()` only prunes the specific
 * `(scope, key)` it touches, so buckets that go permanently quiet (e.g. a
 * one-off flood from an IP that never comes back) would otherwise leave rows
 * behind forever and slowly grow the table. This global sweep reclaims them.
 *
 * Safe to run concurrently across instances: a plain windowed DELETE is
 * idempotent and only removes rows already too old to count toward any live
 * window, so overlapping runs (or a request inserting a fresh row mid-sweep)
 * can't drop anything still in use. Best-effort — a DB error is logged and
 * swallowed so the cron job never throws.
 */
export async function pruneStaleEmailRateLimitHits(): Promise<void> {
  const windowStart = new Date(Date.now() - WINDOW_MS).toISOString();
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM email_rate_limit_hits WHERE hit_at < $1`,
      [windowStart],
    );
    if (rowCount) {
      logger.info({ deleted: rowCount }, "Pruned stale email rate-limit hits");
    }
  } catch (err) {
    logger.warn({ err }, "pruneStaleEmailRateLimitHits failed");
  }
}

/**
 * Test-only: clear the throttle counters between tests. Not exported from any
 * package barrel; only the api-server's own tests should reach for this.
 */
export async function __resetEmailRateLimitForTests(): Promise<void> {
  await pool.query(`DELETE FROM email_rate_limit_hits`);
}
