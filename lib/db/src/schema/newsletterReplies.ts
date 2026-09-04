import {
  pgTable,
  serial,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Dedup + audit ledger for inbound newsletter replies handled by the email
 * Q&A loop (`routes/newsletter-reply.ts`).
 *
 * A reader replies to a newsletter; AgentMail receives it in its hosted inbox
 * and POSTs a `message.received` webhook. AgentMail may deliver the same event
 * more than once on transient failures, so the handler claims `event_id` with an
 * `INSERT ... ON CONFLICT (event_id) DO NOTHING` BEFORE doing any work: the
 * unique index makes the claim atomic and cluster-wide, so a retried webhook can
 * never double-answer. The row is then updated with the resolved `outcome` once
 * processing finishes.
 *
 * `from_hash` is a SHA-256 of the sender address salted with SESSION_SECRET
 * (same privacy posture as `email_sends.recipient_hash` and the Stories IP
 * hash), so this ledger never stores a raw inbound email address.
 */
export const newsletterReplyEventsTable = pgTable(
  "newsletter_reply_events",
  {
    id: serial("id").primaryKey(),
    /** AgentMail `event_id` (falls back to the inbound message id). Dedup key. */
    eventId: text("event_id").notNull(),
    /** The inbound message id (`message.message_id`). */
    messageId: text("message_id"),
    /** The AgentMail inbox that received the reply (`message.inbox_id`). */
    inboxId: text("inbox_id"),
    /** SHA-256(sender_email + SESSION_SECRET); never the raw address. */
    fromHash: text("from_hash"),
    /**
     * How the reply was resolved:
     * `answered` | `uncovered` | `unavailable` (Q&A outcomes) or
     * `ignored` (auto-reply / self / empty) | `rate_limited` | `error`.
     * Starts `processing` at claim time, updated when done.
     */
    outcome: text("outcome").notNull().default("processing"),
    /** Routed pillar slug on the answered/uncovered paths (audit only). */
    pillarSlug: text("pillar_slug"),
    /** Expert who answered (audit only). */
    expertName: text("expert_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    eventIdUx: uniqueIndex("newsletter_reply_events_event_id_ux").on(t.eventId),
    createdAtIdx: index("newsletter_reply_events_created_at_idx").on(t.createdAt),
  }),
);
