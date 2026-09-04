import { pgTable, serial, text, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Append-only log of every ALLOWED hit against the anonymous email-triggering
 * endpoints, written by `middlewares/emailRateLimit.ts`.
 *
 * It backs the per-IP + per-email request throttle as a DB-backed sliding
 * window: the limiter counts rows for a `(scope, key)` whose `hit_at` falls in
 * the last window before each request. Counting rows in a shared table means the
 * throttle is shared across instances and survives restarts, unlike the old
 * in-memory Map (which reset to zero on every redeploy/restart and counted
 * per-process, so an attacker could get N× the limit once the api-server scaled
 * past one instance).
 *
 * `scope` is `"ip"` or `"email"`. `key` is a SHA-256 hash of the IP / normalized
 * email salted with SESSION_SECRET (same privacy posture as the Stories IP hash
 * and the `email_sends` recipient hash), so this throttle log carries no PII and
 * a 429 still leaks nothing about whether an account exists. Old rows are pruned
 * opportunistically once they fall outside the window.
 */
export const emailRateLimitHitsTable = pgTable(
  "email_rate_limit_hits",
  {
    id: serial("id").primaryKey(),
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    hitAt: timestamp("hit_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scopeKeyHitAtIdx: index("email_rate_limit_hits_scope_key_hit_at_idx").on(
      t.scope,
      t.key,
      t.hitAt,
    ),
  }),
);
