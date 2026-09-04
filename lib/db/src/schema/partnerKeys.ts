import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  pgEnum,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { partnerAccountsTable } from "./partnerAccounts";

export const partnerKeyTierEnum = pgEnum("partner_key_tier", [
  "pilot",
  "production",
]);

/**
 * How a key came to exist. `granted` keys are turned on by an admin and
 * work immediately (the user directive: admin always grants access first).
 * `paid` keys are also admin-created but are intended to be tied to a
 * Stripe payment link sent to the partner. Origin is descriptive; whether
 * a key is actually GATED on payment is controlled by `requiresPayment`
 * (so an admin can hand out a paid-tier pilot that isn't enforced yet).
 */
export const partnerKeyOriginEnum = pgEnum("partner_key_origin", [
  "granted",
  "paid",
]);

/**
 * Payment shape for a key that requires payment:
 *   - `none`        — not metered by payment (admin grant).
 *   - `subscription`— gated on a specific active Stripe subscription
 *                     (`stripeSubscriptionId`), e.g. monthly MCP access.
 *   - `credits`     — one-time request credits, decremented per accepted
 *                     keyed request until `creditsUsed >= creditsTotal`.
 */
export const partnerKeyBillingEnum = pgEnum("partner_key_billing", [
  "none",
  "subscription",
  "credits",
]);

/**
 * Partner API keys for B2B access to /api/sleep-agent (and future B2B
 * endpoints). The raw key is never stored — only its sha256 hash, plus a
 * short non-secret prefix for display ("plnr_live_a1b2c3...") so stewards
 * can identify a key in admin output without seeing the secret.
 *
 * Tier columns drive per-key rate limiting in the middleware. The
 * defaults match the table on /platforms (60/min, 50k/day, 10 concurrent
 * streams for pilot keys); production keys can be tuned per partner.
 */
export const partnerKeysTable = pgTable("partner_keys", {
  id: serial("id").primaryKey(),
  keyHash: text("key_hash").notNull().unique(),
  keyPrefix: text("key_prefix").notNull(),
  partnerName: text("partner_name").notNull(),
  contactEmail: text("contact_email"),
  scopes: text("scopes").array().notNull().default(["sleep-agent"]),
  tier: partnerKeyTierEnum("tier").notNull().default("pilot"),
  ratePerMinute: integer("rate_per_minute").notNull().default(60),
  ratePerDay: integer("rate_per_day").notNull().default(50_000),
  concurrentStreams: integer("concurrent_streams").notNull().default(10),
  notes: text("notes"),
  /** How the key was created (admin grant vs. paid). Descriptive only. */
  origin: partnerKeyOriginEnum("origin").notNull().default("granted"),
  /** When true, the key only works while its payment is active (an active
   * `subscription` or remaining `credits`). Admin grants leave this false. */
  requiresPayment: boolean("requires_payment").notNull().default(false),
  billingMode: partnerKeyBillingEnum("billing_mode").notNull().default("none"),
  /** Stripe customer minted for this partner (by contact email) so payment
   * links + subscription lookups attach to a stable customer. */
  stripeCustomerId: text("stripe_customer_id"),
  /** The specific subscription a `subscription`-billed key is gated on. We
   * gate on THIS id (not "any active sub for the customer") so a partner's
   * unrelated/consumer subscription can't accidentally unlock partner access. */
  stripeSubscriptionId: text("stripe_subscription_id"),
  /** Total purchased request credits for a `credits`-billed key (null = not
   * credit-metered). `creditsUsed` is decremented atomically per request. */
  creditsTotal: integer("credits_total"),
  creditsUsed: integer("credits_used").notNull().default(0),
  /** When set, this key is owned by a self-serve partner account and its
   * secret is minted/rotated from the partner portal. NULL for admin
   * hand-minted keys (that path is unchanged). */
  partnerAccountId: integer("partner_account_id").references(
    () => partnerAccountsTable.id,
    { onDelete: "set null" },
  ),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

/**
 * Idempotency + audit ledger for completed Stripe payments applied to a
 * partner key. Keyed by `stripeSessionId` (unique) so a buyer reloading the
 * success page can't double-apply a one-time credit top-up, and so a
 * subscription link is recorded exactly once. No money is moved here — Stripe
 * is the source of truth; this only records WHICH session we already acted on.
 */
export const partnerKeyPaymentsTable = pgTable("partner_key_payments", {
  id: serial("id").primaryKey(),
  partnerKeyId: integer("partner_key_id")
    .notNull()
    .references(() => partnerKeysTable.id, { onDelete: "cascade" }),
  stripeSessionId: text("stripe_session_id").notNull().unique(),
  /** "credits" | "subscription" — what the payment unlocked. */
  kind: text("kind").notNull(),
  /** Credits granted by this payment (null for subscriptions). */
  creditsAdded: integer("credits_added"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => ({
  keyIdx: index("partner_key_payments_key_idx").on(t.partnerKeyId),
}));

export const insertPartnerKeySchema = createInsertSchema(partnerKeysTable).omit(
  { id: true, createdAt: true, revokedAt: true },
);
export type InsertPartnerKey = z.infer<typeof insertPartnerKeySchema>;
export type PartnerKey = typeof partnerKeysTable.$inferSelect;
export type PartnerKeyPayment = typeof partnerKeyPaymentsTable.$inferSelect;
