import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pillarsTable } from "./faculty";

/**
 * Curated external resource links attached to a pillar.
 *
 * Used to surface "Learn more" panels when the agent has no approved RAG
 * corpus to draw from (UNCOVERED path). The dementia pillar ships with
 * Stanford ADRC links seeded by seed-dementia-resources; other pillars may
 * grow their own resource lists over time.
 *
 * Stewards can also designate a Video resource for one coach lesson in the
 * same pillar. The nullable lesson id is intentionally held on the resource:
 * deleting it or changing it out of the Video category removes the public
 * action without leaving a stale mapping behind.
 */
export const pillarResourcesTable = pgTable(
  "pillar_resources",
  {
    id: serial("id").primaryKey(),
    pillarId: integer("pillar_id")
      .notNull()
      .references(() => pillarsTable.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    url: text("url").notNull(),
    description: text("description"),
    category: text("category"),
    coachLessonId: text("coach_lesson_id"),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("pillar_resources_url_idx").on(t.url),
    uniqueIndex("pillar_resources_coach_lesson_idx")
      .on(t.coachLessonId)
      .where(sql`${t.coachLessonId} IS NOT NULL`),
  ],
);

export type PillarResource = typeof pillarResourcesTable.$inferSelect;
export type PillarResourceInsert = typeof pillarResourcesTable.$inferInsert;
