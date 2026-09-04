import { boolean, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * "Do you feel you can trust this answer?" — one row per (answer, visitor).
 *
 * `query_id` is the agent_queries UUID for the answered turn (validated
 * UUID-shaped in the route; blocked/errored turns have no queryId and are
 * never voteable). `voter_hash` is a SHA-256 of the visitor IP salted with
 * SESSION_SECRET (same privacy posture as answer_format_votes) — no PII.
 * The UNIQUE index on (query_id, voter_hash) makes it one vote per answer
 * per visitor: re-voting UPDATEs the existing row, which also makes the
 * endpoint self-rate-limiting.
 */
export const answerTrustVotesTable = pgTable(
  "answer_trust_votes",
  {
    id: serial("id").primaryKey(),
    queryId: text("query_id").notNull(),
    trusted: boolean("trusted").notNull(),
    voterHash: text("voter_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    queryVoterIdx: uniqueIndex("answer_trust_votes_query_voter_idx").on(
      t.queryId,
      t.voterHash,
    ),
  }),
);

export type AnswerTrustVote = typeof answerTrustVotesTable.$inferSelect;
