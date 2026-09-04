import {
  pgTable,
  text,
  boolean,
  timestamp,
  uuid,
  index,
} from "drizzle-orm/pg-core";

/**
 * Soft payment-intent signals from the brand-neutral SleepZeit pilot.
 *
 * This is a willingness-to-pay probe, NOT a transaction: we show the reader a
 * price, capture their email and a yes/no "I would pay this", and store it
 * here. Nothing is ever charged and no Stripe customer is created.
 *
 * `query_id` loosely points at the `agent_queries` row that prompted the
 * capture (the question the reader had just asked). It is intentionally NOT a
 * foreign key — agent-query logging is best-effort and runs after res.end(),
 * so the row may not exist yet when the intent lands.
 */
export const sleepzeitIntentsTable = pgTable(
  "sleepzeit_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    wouldPay: boolean("would_pay").notNull(),
    /** The exact price string the reader saw, e.g. "$5/month". */
    priceLabel: text("price_label").notNull(),
    /** Loose ref to agent_queries.id (no FK — see note above). */
    queryId: uuid("query_id"),
    /** Random per-browser session token from the sleep-agent cookie. */
    sessionId: text("session_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    createdIdx: index("sleepzeit_intents_created_idx").on(t.createdAt),
    emailIdx: index("sleepzeit_intents_email_idx").on(t.email),
  }),
);

export type SleepzeitIntent = typeof sleepzeitIntentsTable.$inferSelect;
