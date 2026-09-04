import { pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * One row per visitor for the "how do you want your answers?" poll shown under
 * agent answers (avatar / podcast / text).
 *
 * `voter_hash` is a SHA-256 of the visitor IP salted with SESSION_SECRET (same
 * privacy posture as the Stories IP hash) — no PII is stored. The UNIQUE index
 * on it makes the poll one-vote-per-visitor: re-voting UPDATEs the existing row
 * (people are allowed to change their mind), so counts are of distinct
 * visitors, not clicks. That also makes the endpoint self-rate-limiting.
 */
export const answerFormatVotesTable = pgTable(
  "answer_format_votes",
  {
    id: serial("id").primaryKey(),
    /** 'avatar' | 'podcast' | 'text' — validated in the route. */
    option: text("option").notNull(),
    voterHash: text("voter_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    voterHashIdx: uniqueIndex("answer_format_votes_voter_hash_idx").on(
      t.voterHash,
    ),
  }),
);

export type AnswerFormatVote = typeof answerFormatVotesTable.$inferSelect;
