import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  pgEnum,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const referralEventTypeEnum = pgEnum("referral_event_type", [
  "click",
  "signup",
  "convert",
]);

/**
 * One row per referrer: a unique, human-shareable code tied to their email.
 * Created lazily on first GET /api/referral/code. Code is a short alphanumeric
 * string generated at creation time.
 */
export const referralCodesTable = pgTable("referral_codes", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  ownerEmail: text("owner_email").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * One event row per lifecycle moment per referral.
 *
 * event_type:
 *   click   — a browser visited /sleep?ref=CODE or /subscribe?ref=CODE
 *   signup  — the referred user created/signed in to an account
 *   convert — the referred user completed a paid checkout
 *
 * recipient_email: set on signup/convert; null on click (anonymous at that point).
 * credited_cents:  set on convert; the Stripe balance credit applied to the
 *                  referrer (negative = credit applied).
 * ip_hash:         md5 of client IP, set on click events for deduplication.
 */
export const referralEventsTable = pgTable(
  "referral_events",
  {
    id: serial("id").primaryKey(),
    code: text("code").notNull(),
    eventType: referralEventTypeEnum("event_type").notNull(),
    recipientEmail: text("recipient_email"),
    creditedCents: integer("credited_cents"),
    ipHash: text("ip_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Partial unique index: only one credited conversion per (code, recipient).
    // Enforces idempotency for applyReferralConversion even under concurrent
    // /billing/confirm requests.
    uniqueIndex("referral_events_convert_unique")
      .on(table.code, table.recipientEmail)
      .where(sql`event_type = 'convert'`),
    // Index for fast per-code event scans.
    index("referral_events_code_idx").on(table.code),
  ],
);

/**
 * Bonus questions granted to a consumer account via referral, stored
 * separately from the account row so it never collides with account upserts.
 * One row per consumer_account_id; upserted at signup time.
 */
export const referralBonusTable = pgTable("referral_bonus", {
  id: serial("id").primaryKey(),
  consumerAccountId: integer("consumer_account_id").notNull().unique(),
  bonusQuestionsRemaining: integer("bonus_questions_remaining")
    .notNull()
    .default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
