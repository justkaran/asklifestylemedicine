import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  pgEnum,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ── Phone opt-ins (iMessage) ─────────────────────────────────────────────────
// Phone capture is ADDITIVE to the existing email newsletter/waitlist capture —
// a separate, consent-gated list of numbers that opted in to receive texts on a
// specific consumer product surface. The actual marketing/notification content
// is deliberately NOT decided here: this stores numbers responsibly with
// consent and supports a single opt-in/confirmation iMessage (the one piece of
// plumbing that proves the send pipe works and records consent).
//
// Mirrors the newsletter-subscriber double-opt-in shape:
//   • "pending"  — captured + consented via a public form, sent a confirmation
//                  iMessage, but has NOT yet confirmed. Never receives sends.
//   • "active"   — confirmed (replied to / clicked the confirmation). The only
//                  status any future send path is allowed to target.
//   • "opted_out" — replied STOP (or the provider's standard opt-out). Excluded
//                  from every send forever unless they re-subscribe.

/** Which consumer product surface the number was captured on. */
export const phoneSubscriberProductEnum = pgEnum("phone_subscriber_product", [
  "nightly",
]);

export const phoneSubscriberStatusEnum = pgEnum("phone_subscriber_status", [
  "pending",
  "active",
  "opted_out",
]);

export const phoneSubscribersTable = pgTable(
  "phone_subscribers",
  {
    id: serial("id").primaryKey(),
    // Normalized E.164 number (e.g. +14155550123). Always store normalized so
    // idempotency + opt-out lookups are exact regardless of how it was typed.
    phone: text("phone").notNull(),
    product: phoneSubscriberProductEnum("product").notNull(),
    // Loose ref to consumer_accounts.id. Set when a signed-in consumer opts in
    // (from /account or a product page while logged in) so the number is linked
    // to their account rather than captured anonymously. Nullable: anonymous
    // capture for logged-out visitors stays fully supported.
    consumerAccountId: integer("consumer_account_id"),
    status: phoneSubscriberStatusEnum("status").notNull().default("pending"),
    // Free-text capture surface tag (e.g. "sleep-agent").
    source: text("source"),
    // When the visitor ticked the explicit opt-in consent box.
    consentAt: timestamp("consent_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Random token minted on capture. Used for the confirmation link in the
    // opt-in iMessage; flipping pending → active is gated on it.
    confirmToken: text("confirm_token"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    optedOutAt: timestamp("opted_out_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    // A number may opt in only once per product — re-submitting the same number
    // on the same surface is
    // idempotent (no duplicate row, no re-spam).
    productPhoneUniq: uniqueIndex("phone_subscribers_product_phone_uniq").on(
      t.product,
      t.phone,
    ),
  }),
);

// ── Per-account notification channel preferences ─────────────────────────────
// A signed-in consumer chooses, per product, HOW they want to be notified:
//   • "email"    — only the account email
//   • "imessage" — only their confirmed phone (requires an active phone link)
//   • "both"     — both channels
// The absence of a row means the safe default (email): we always have a verified
// account email, but never assume a phone exists. Switching to "imessage"/"both"
// is gated server-side on a confirmed account-linked number.

export const notificationChannelEnum = pgEnum("notification_channel", [
  "email",
  "imessage",
  "both",
]);

export const notificationPreferencesTable = pgTable(
  "notification_preferences",
  {
    id: serial("id").primaryKey(),
    // Loose ref to consumer_accounts.id (the signed-in consumer this pref is for).
    consumerAccountId: integer("consumer_account_id").notNull(),
    product: phoneSubscriberProductEnum("product").notNull(),
    channel: notificationChannelEnum("channel").notNull().default("email"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    // One channel preference per (account, product).
    accountProductUniq: uniqueIndex(
      "notification_preferences_account_product_uniq",
    ).on(t.consumerAccountId, t.product),
  }),
);
