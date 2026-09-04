import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Public, read-only snapshots of /slm answers behind a durable share link
 * ("answer permalink"). A row is created when a visitor clicks "Share this
 * answer": we snapshot the question, the raw answer text, and the PUBLIC
 * citation fields (same-work-collapsed) at creation time so the link keeps
 * working even if the underlying sources are later edited or archived.
 *
 * `id` is an unguessable random token (base64url, 22 chars). `queryId`
 * references the agent_queries row the snapshot came from and is UNIQUE so
 * sharing the same answer twice returns the same link.
 *
 * The `citations` jsonb holds ONLY public display fields (title, authors,
 * year, journal, doi, source_url, pillar_slug) — never steward-internal
 * data, excerpts, or scores.
 */
export const slmAnswerLinksTable = pgTable("slm_answer_links", {
  id: text("id").primaryKey(),
  queryId: uuid("query_id").notNull().unique(),
  question: text("question").notNull(),
  answerText: text("answer_text").notNull(),
  citations: jsonb("citations").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type SlmAnswerLink = typeof slmAnswerLinksTable.$inferSelect;
