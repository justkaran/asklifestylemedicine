import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const reputationTopicsTable = pgTable("reputation_topics", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  signalKeywords: text("signal_keywords").array().notNull().default([]),
  seedDomains: text("seed_domains").array().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const reputationPromptsTable = pgTable("reputation_prompts", {
  id: serial("id").primaryKey(),
  topicId: integer("topic_id")
    .notNull()
    .references(() => reputationTopicsTable.id, { onDelete: "cascade" }),
  prompt: text("prompt").notNull(),
  category: text("category"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const reputationRunsTable = pgTable("reputation_runs", {
  id: serial("id").primaryKey(),
  topicId: integer("topic_id")
    .notNull()
    .references(() => reputationTopicsTable.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"),
  engines: text("engines").array().notNull().default([]),
  triggeredBy: text("triggered_by"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  errorMessage: text("error_message"),
  totals: jsonb("totals"),
});

export const reputationAnswersTable = pgTable("reputation_answers", {
  id: serial("id").primaryKey(),
  runId: integer("run_id")
    .notNull()
    .references(() => reputationRunsTable.id, { onDelete: "cascade" }),
  promptId: integer("prompt_id")
    .notNull()
    .references(() => reputationPromptsTable.id, { onDelete: "cascade" }),
  engine: text("engine").notNull(),
  model: text("model").notNull(),
  status: text("status").notNull(),
  answerText: text("answer_text"),
  errorMessage: text("error_message"),
  latencyMs: integer("latency_ms"),
  mentionsStanford: boolean("mentions_stanford").notNull().default(false),
  mentionsZeitzer: boolean("mentions_zeitzer").notNull().default(false),
  mentionsPalonur: boolean("mentions_palonur").notNull().default(false),
  signalHits: text("signal_hits").array().notNull().default([]),
  citedUrls: text("cited_urls").array().notNull().default([]),
  citedDomains: text("cited_domains").array().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertReputationTopicSchema = createInsertSchema(reputationTopicsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertReputationTopic = z.infer<typeof insertReputationTopicSchema>;
export type ReputationTopic = typeof reputationTopicsTable.$inferSelect;

export const insertReputationPromptSchema = createInsertSchema(reputationPromptsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertReputationPrompt = z.infer<typeof insertReputationPromptSchema>;
export type ReputationPrompt = typeof reputationPromptsTable.$inferSelect;

export type ReputationRun = typeof reputationRunsTable.$inferSelect;
export type ReputationAnswer = typeof reputationAnswersTable.$inferSelect;
