import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Records questions that hit UNCOVERED on any agent surface, optionally
 * capturing the visitor's email so Palonur can follow up with the right expert.
 */
export const uncoveredEscalationsTable = pgTable("uncovered_escalations", {
  id: serial("id").primaryKey(),
  question: text("question").notNull(),
  surface: text("surface").notNull(),
  userEmail: text("user_email"),
  sessionId: text("session_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type UncoveredEscalation =
  typeof uncoveredEscalationsTable.$inferSelect;
