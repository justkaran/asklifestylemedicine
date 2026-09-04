import { index, pgTable, text, timestamp, integer } from "drizzle-orm/pg-core";
import { consumerAccountsTable } from "./consumers";

/**
 * Background visitor record for the consumer AI agent surfaces ("auto-create").
 *
 * Every anonymous browser that asks the sleep agent a question
 * already carries a `palonur_session` httpOnly cookie (see consumerPaywall's
 * ensureSessionId). This table persists that session as a first-class visitor
 * row — created silently on the first ask, never blocking the answer — so a
 * visitor exists BEFORE we ask them for anything.
 *
 * When the visitor later saves an answer by email, the row is linked to a
 * `consumer_accounts` identity (`consumer_account_id`) and, once they click the
 * magic link, stamped `claimed_at`. No entitlement lives here — capabilities
 * are always derived from Stripe at read time.
 */
export const visitorSessionsTable = pgTable(
  "visitor_sessions",
  {
    /** The `palonur_session` cookie value (UUID minted by ensureSessionId). */
    sessionId: text("session_id").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Linked once the visitor saves an answer with their email. */
    consumerAccountId: integer("consumer_account_id").references(
      () => consumerAccountsTable.id,
      { onDelete: "set null" },
    ),
    /** Stamped when the emailed magic link is consumed (email proven). */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
  },
  (table) => [
    index("visitor_sessions_consumer_account_idx").on(table.consumerAccountId),
  ],
);
