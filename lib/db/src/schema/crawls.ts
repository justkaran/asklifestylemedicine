import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  boolean,
  pgEnum,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pillarsTable, facultyUsersTable } from "./faculty";
import { sourceRightsBasisEnum, sourcesTable } from "./sources";
import { interpretationsTable } from "./interpretations";

/**
 * Talk-crawl pipeline (Task #168). An operator triggers a per-faculty crawl
 * that discovers talks / podcasts / interviews, collects + transcribes them,
 * ingests each as a citable `talk` source, and auto-drafts a PROPOSED
 * interpretation into the existing pillar steward approval queue. A human
 * steward always approves before anything becomes citable.
 *
 * A run fans out into candidates. The run tracks the overall lifecycle; each
 * candidate tracks one discovered appearance through collect → transcribe →
 * ingest. Both run and worker run as a fire-and-forget background job; the
 * admin UI polls the run + candidate rows for status.
 */
export const crawlRunStatusEnum = pgEnum("crawl_run_status", [
  "pending",
  "discovering",
  "review",
  "collecting",
  "done",
  "failed",
]);

/**
 * discovered  — found by Firecrawl search or pasted by the operator.
 * fetching    — collecting the transcript / audio.
 * transcribed — transcript text is in hand, awaiting ingest.
 * ingested    — became a `talk` source + a proposed interpretation.
 * failed      — could not be collected/transcribed (flagged for the operator).
 * discarded   — operator dismissed it before ingest.
 */
export const crawlCandidateStatusEnum = pgEnum("crawl_candidate_status", [
  "discovered",
  "fetching",
  "transcribed",
  "ingested",
  "failed",
  "discarded",
]);

export const crawlRunsTable = pgTable(
  "crawl_runs",
  {
    id: serial("id").primaryKey(),
    /** The faculty member whose talks are being crawled. */
    facultyUserId: integer("faculty_user_id")
      .notNull()
      .references(() => facultyUsersTable.id, { onDelete: "cascade" }),
    /** Pillar the discovered talks (and their interpretations) land in. */
    pillarId: integer("pillar_id")
      .notNull()
      .references(() => pillarsTable.id, { onDelete: "cascade" }),
    /** Operator (platform admin) who triggered the run. */
    startedByUserId: integer("started_by_user_id").references(
      () => facultyUsersTable.id,
      { onDelete: "set null" },
    ),
    /** Snapshot of the speaker name searched (so the run reads standalone). */
    speakerName: text("speaker_name").notNull(),
    /** Operator-recorded rights decision applied to every collected transcript. */
    rightsBasis: sourceRightsBasisEnum("rights_basis"),
    status: crawlRunStatusEnum("status").notNull().default("pending"),
    /** Free-text error when status = failed. */
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    facultyIdx: index("crawl_runs_faculty_idx").on(t.facultyUserId),
    statusIdx: index("crawl_runs_status_idx").on(t.status),
  }),
);

export const crawlCandidatesTable = pgTable(
  "crawl_candidates",
  {
    id: serial("id").primaryKey(),
    crawlRunId: integer("crawl_run_id")
      .notNull()
      .references(() => crawlRunsTable.id, { onDelete: "cascade" }),
    status: crawlCandidateStatusEnum("status").notNull().default("discovered"),
    title: text("title").notNull(),
    /** podcast | youtube | article | interview | other — best-effort. */
    sourceType: text("source_type").notNull().default("other"),
    /** Show / event / venue name, used as the citation "journal". */
    eventName: text("event_name"),
    talkDate: text("talk_date"),
    /** The appearance page URL the operator/searcher landed on. */
    primaryUrl: text("primary_url").notNull(),
    /** Resolved direct audio URL (podcast enclosure / mp3), when known. */
    audioUrl: text("audio_url"),
    /** A transcript page URL, when one was discovered. */
    transcriptUrl: text("transcript_url"),
    transcriptAvailable: boolean("transcript_available")
      .notNull()
      .default(false),
    /** Collected transcript text (kept for audit; the source gets the canonical copy). */
    transcript: text("transcript"),
    /** Set on successful ingest. */
    sourceId: integer("source_id").references(() => sourcesTable.id, {
      onDelete: "set null",
    }),
    interpretationId: integer("interpretation_id").references(
      () => interpretationsTable.id,
      { onDelete: "set null" },
    ),
    /** Free-text reason when status = failed. */
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    runIdx: index("crawl_candidates_run_idx").on(t.crawlRunId),
    statusIdx: index("crawl_candidates_status_idx").on(t.status),
  }),
);

export type CrawlRun = typeof crawlRunsTable.$inferSelect;
export type CrawlCandidate = typeof crawlCandidatesTable.$inferSelect;

export type CrawlRunStatus =
  | "pending"
  | "discovering"
  | "review"
  | "collecting"
  | "done"
  | "failed";

export type CrawlCandidateStatus =
  | "discovered"
  | "fetching"
  | "transcribed"
  | "ingested"
  | "failed"
  | "discarded";

/** Metadata-only scholarly discovery. Provider pages are never collected. */
export const researchDiscoveryRunStatusEnum = pgEnum("research_discovery_run_status", [
  "pending",
  "discovering",
  "done",
  "failed",
]);
export const researchDiscoveryCandidateStatusEnum = pgEnum("research_discovery_candidate_status", [
  "discovered",
  "review",
  "ingested",
  "auto_approved",
  "duplicate",
  "failed",
]);

export const researchDiscoveryRunsTable = pgTable(
  "research_discovery_runs",
  {
    id: serial("id").primaryKey(),
    facultyUserId: integer("faculty_user_id").notNull().references(() => facultyUsersTable.id, { onDelete: "cascade" }),
    pillarId: integer("pillar_id").notNull().references(() => pillarsTable.id, { onDelete: "cascade" }),
    startedByUserId: integer("started_by_user_id").references(() => facultyUsersTable.id, { onDelete: "set null" }),
    facultyName: text("faculty_name").notNull(),
    pillarTopic: text("pillar_topic").notNull(),
    status: researchDiscoveryRunStatusEnum("status").notNull().default("pending"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => ({
    targetIdx: index("research_discovery_runs_target_idx").on(t.facultyUserId, t.pillarId, t.createdAt),
    oneActiveTarget: uniqueIndex("research_discovery_one_active_target")
      .on(t.facultyUserId, t.pillarId)
      .where(sql`${t.status} IN ('pending', 'discovering')`),
  }),
);

export const researchDiscoveryCandidatesTable = pgTable(
  "research_discovery_candidates",
  {
    id: serial("id").primaryKey(),
    discoveryRunId: integer("discovery_run_id").notNull().references(() => researchDiscoveryRunsTable.id, { onDelete: "cascade" }),
    pillarId: integer("pillar_id").notNull().references(() => pillarsTable.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerId: text("provider_id").notNull(),
    doi: text("doi"),
    pmid: text("pmid"),
    title: text("title").notNull(),
    authors: text("authors"),
    journal: text("journal"),
    year: integer("year"),
    abstract: text("abstract"),
    sourceUrl: text("source_url"),
    status: researchDiscoveryCandidateStatusEnum("status").notNull().default("discovered"),
    reviewReason: text("review_reason"),
    sourceId: integer("source_id").references(() => sourcesTable.id, { onDelete: "set null" }),
    interpretationId: integer("interpretation_id").references(() => interpretationsTable.id, { onDelete: "set null" }),
    excludedAt: timestamp("excluded_at", { withTimezone: true }),
    excludedByUserId: integer("excluded_by_user_id").references(() => facultyUsersTable.id, { onDelete: "set null" }),
    exclusionReason: text("exclusion_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => ({
    providerUnique: uniqueIndex("research_discovery_provider_unique").on(t.pillarId, t.provider, t.providerId),
    pillarDoiUnique: uniqueIndex("research_discovery_pillar_doi_unique").on(t.pillarId, t.doi).where(sql`${t.doi} IS NOT NULL`),
    runIdx: index("research_discovery_candidates_run_idx").on(t.discoveryRunId),
  }),
);

export type ResearchDiscoveryRun = typeof researchDiscoveryRunsTable.$inferSelect;
export type ResearchDiscoveryCandidate = typeof researchDiscoveryCandidatesTable.$inferSelect;
