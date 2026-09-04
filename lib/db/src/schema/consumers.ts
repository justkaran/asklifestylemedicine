import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Lightweight consumer billing identity for the paywalled sleep agent.
 *
 * This is intentionally separate from the faculty Clerk auth (which gates the
 * steward portal) and from `palonur_users` (the anonymous journey profile).
 * A consumer account owns the email→Stripe-customer mapping. Entitlement is
 * NEVER stored here — it is always derived at read time by querying the
 * `stripe.subscriptions` table (synced by stripe-replit-sync) for this
 * account's `stripe_customer_id`.
 */
export const consumerAccountsTable = pgTable("consumer_accounts", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  /** Optional friendly display name the consumer sets on their account page. */
  displayName: text("display_name"),
  /**
   * When the account's email was proven (magic-link consumed). NULL means the
   * account was self-registered (SLM chat onboarding) and is still unverified:
   * it may only chat on the provisional browser-session cookie issued at
   * registration — a returning browser gets no new session until the emailed
   * link is clicked. Pre-existing accounts were all created by consuming a
   * magic link, so the boot migration backfills them as verified.
   */
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  stripeCustomerId: text("stripe_customer_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * One journey pass = one paid outcome-focused session. The buyer pays once,
 * asks unlimited questions, and calls /api/journey/complete when they feel they
 * have reached their goal. A 90-day expires_at is a backstop — the pass is
 * never locked early; only the user decides when they're done.
 *
 * product: 'sleep'
 * status:  'active' | 'completed'
 */
export const journeyPassesTable = pgTable("journey_passes", {
  id: serial("id").primaryKey(),
  consumerAccountId: integer("consumer_account_id").notNull(),
  product: text("product").notNull(),
  stripeSessionId: text("stripe_session_id"),
  status: text("status").notNull().default("active"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * One-time magic-link login tokens for consumer accounts. Mirrors the Stories
 * editor magic-link pattern: a token is emailed, consumed once, and exchanged
 * for a signed session cookie.
 */
export const consumerLoginTokensTable = pgTable("consumer_login_tokens", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  magicToken: text("magic_token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
