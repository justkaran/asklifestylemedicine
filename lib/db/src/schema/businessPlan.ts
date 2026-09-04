import {
  pgTable,
  text,
  jsonb,
  timestamp,
  serial,
  boolean,
  index,
} from "drizzle-orm/pg-core";

type AttributionMeta = Record<string, { by: string; at: string }>;

/**
 * Single shared collaborative document for a business plan (id = "slm").
 * Holds the canonical assumptions + narrative edits plus per-field attribution
 * so the UI can show who last entered each value.
 */
export const businessPlanState = pgTable("business_plan_state", {
  id: text("id").primaryKey(),
  assumptions: jsonb("assumptions")
    .$type<Record<string, string>>()
    .default({})
    .notNull(),
  narrative: jsonb("narrative")
    .$type<Record<string, string>>()
    .default({})
    .notNull(),
  assumptionsMeta: jsonb("assumptions_meta")
    .$type<AttributionMeta>()
    .default({})
    .notNull(),
  narrativeMeta: jsonb("narrative_meta")
    .$type<AttributionMeta>()
    .default({})
    .notNull(),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/** Section-anchored async discussion between collaborators. */
export const businessPlanComments = pgTable(
  "business_plan_comments",
  {
    id: serial("id").primaryKey(),
    planId: text("plan_id").notNull().default("slm"),
    section: text("section").notNull(),
    sectionLabel: text("section_label"),
    author: text("author").notNull(),
    body: text("body").notNull(),
    resolved: boolean("resolved").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    bySection: index("bp_comments_section_idx").on(t.planId, t.section),
  }),
);
