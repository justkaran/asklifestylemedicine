import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { pillarsTable } from "./faculty";
import { sourcesTable } from "./sources";

/**
 * One row per gap-discovery run that actually QUEUED Stanford material —
 * the durable record of "a real refusal, what triggered it, what happened
 * next". The triggering question was previously only emailed (never
 * persisted), so the refusal-evidence surface had nothing real to show.
 *
 * The "what happened next" half is NOT stored here: it is derived live by
 * joining `sources.status` on `source_id` (draft = still in the steward
 * queue, approved = a steward signed it off). That keeps the story truthful
 * even if a steward later rejects/archives the material.
 *
 * Questions are raw reader input. Display surfaces MUST pass them through
 * the privacy guard (no emails/phone-like digit runs, length caps) before
 * showing them publicly.
 */
export const gapDiscoveryEventsTable = pgTable(
  "gap_discovery_events",
  {
    id: serial("id").primaryKey(),
    question: text("question").notNull(),
    pillarId: integer("pillar_id")
      .notNull()
      .references(() => pillarsTable.id, { onDelete: "cascade" }),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sourcesTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    createdIdx: index("gap_discovery_events_created_idx").on(t.createdAt),
  }),
);

export type GapDiscoveryEvent = typeof gapDiscoveryEventsTable.$inferSelect;
