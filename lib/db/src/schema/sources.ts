import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
  pgEnum,
  index,
  jsonb,
  customType,
  real,
  boolean,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sql } from "drizzle-orm";
import { pillarsTable, facultyUsersTable } from "./faculty";
import type { ReliabilityRubric } from "../source-rigor";

export const sourceKindEnum = pgEnum("source_kind", [
  "paper",
  "slm_article",
  "note",
  "talk",
]);

export const sourceStatusEnum = pgEnum("source_status", [
  "draft",
  "in_review",
  "approved",
  "archived",
]);

/** Basis recorded by the contributor before paper text is processed. */
export const sourceRightsBasisEnum = pgEnum("source_rights_basis", [
  "open_license",
  "permission",
  "public_domain",
  "no_documented_full_text_rights",
]);

/**
 * Retention is separate from publication status. `review_window` is the
 * temporary state used while a steward fact-checks a first draft.
 */
export const sourceRetentionStatusEnum = pgEnum("source_retention_status", [
  "needs_review",
  "review_window",
  "retained_with_rights",
  "purged_no_full_text_rights",
]);

/**
 * Lifecycle of a source's three-axis reliability assessment. INDEPENDENT of
 * `source_status` (the source-content lifecycle) and must never be conflated
 * with it. `null` = never assessed, `draft` = AI-seeded or steward work in
 * progress (NOT public), `approved` = steward-approved and public.
 */
export const sourceAssessmentStatusEnum = pgEnum("source_assessment_status", [
  "draft",
  "approved",
]);

/**
 * Embeddings are produced entirely in-house by a self-hosted ONNX model
 * (gte-small) — approved research text is never sent to a third-party
 * embedding API. These two constants are the single source of truth for the
 * local fallback identity + storage width. Runtime provider identity is
 * deliberately computed in api-server (it includes provider/model/dimension);
 * these static values only support legacy/schema indexes. The boot migration
 * creates the active provider-specific partial indexes.
 */
export const EMBEDDING_MODEL = "Xenova/gte-small";
export const STORAGE_EMBEDDING_DIMENSIONS = 384;
/** @deprecated Use STORAGE_EMBEDDING_DIMENSIONS for new storage code. */
export const EMBEDDING_DIMENSIONS = STORAGE_EMBEDDING_DIMENSIONS;

/**
 * Dimensionless pgvector `halfvec` column. drizzle's built-in `halfvec`
 * helper bakes a fixed width into the DDL (`halfvec(N)`), which turns a later
 * model rotation into a destructive `ALTER ... TYPE halfvec(M)` that fails on
 * existing rows. A dimensionless `halfvec` column accepts any width, so a
 * rotation (e.g. 3072-d → 384-d) is a non-destructive widen that preserves the
 * not-yet-re-embedded rows. The per-row `embedding_model` guard plus a partial
 * expression HNSW index (cast to the current width, scoped to the current
 * model) keep retrieval correct across the transient mix.
 */
export const halfvecDimensionless = customType<{
  data: number[];
  driverData: string;
}>({
  dataType() {
    return "halfvec";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value
      .slice(1, -1)
      .split(",")
      .filter((s) => s.length > 0)
      .map(Number);
  },
});

export const sourcesTable = pgTable(
  "sources",
  {
    id: serial("id").primaryKey(),
    pillarId: integer("pillar_id")
      .notNull()
      .references(() => pillarsTable.id, { onDelete: "cascade" }),
    kind: sourceKindEnum("kind").notNull(),
    title: text("title").notNull(),
    authors: text("authors"),
    year: integer("year"),
    journal: text("journal"),
    doi: text("doi"),
    abstract: text("abstract"),
    fullText: text("full_text"),
    sourceUrl: text("source_url"),
    /** Controlled-vocabulary study type (see `study-design.ts`). Nullable:
     * a steward picks it when adding/editing a source; never inferred. */
    studyDesign: text("study_design"),
    /** Contributor-confirmed basis for processing full text. Nullable only
     * for historical rows that predate rights-aware ingestion. */
    rightsBasis: sourceRightsBasisEnum("rights_basis"),
    retentionStatus: sourceRetentionStatusEnum("retention_status")
      .notNull()
      .default("needs_review"),
    rightsRecordedByUserId: integer("rights_recorded_by_user_id").references(
      () => facultyUsersTable.id,
      { onDelete: "set null" },
    ),
    rightsRecordedAt: timestamp("rights_recorded_at", { withTimezone: true }),
    purgedByUserId: integer("purged_by_user_id").references(
      () => facultyUsersTable.id,
      { onDelete: "set null" },
    ),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
    /** Talk citation metadata (only populated for `kind = 'talk'`). The
     * speaker is also mirrored into `authors`, the event into `journal`, and
     * the talk year into `year` so the existing citation rendering works
     * unchanged; these columns preserve the structured originals. */
    speakerFacultyUserId: integer("speaker_faculty_user_id").references(
      () => facultyUsersTable.id,
      { onDelete: "set null" },
    ),
    speakerName: text("speaker_name"),
    eventName: text("event_name"),
    /** Free-text talk date (e.g. "2023", "May 2023", "2023-05-14"). Kept as
     * text because talk appearances are often only approximately dated. */
    talkDate: text("talk_date"),
    status: sourceStatusEnum("status").notNull().default("draft"),
    uploadedByUserId: integer("uploaded_by_user_id").references(
      () => facultyUsersTable.id,
      { onDelete: "set null" },
    ),
    // ── Scientific reliability assessment (three-axis, steward-governed) ──
    // Based on Stanford's SPORR / CORES framework: rigor, reproducibility,
    // and open science are three SEPARATE axes, never collapsed. AI may
    // draft; a steward must approve. None of these are public until
    // `assessmentStatus = 'approved'`. See `@workspace/db/source-rigor` for
    // the rubric definition + pure scoring helpers.
    /** 0..100, recomputed server-side from the rubric on every write. */
    rigorScore: integer("rigor_score"),
    reproducibilityScore: integer("reproducibility_score"),
    opennessScore: integer("openness_score"),
    /** Current working rubric (per-axis item answers + one-line rationale).
     * May hold a draft; public only when assessmentStatus = 'approved'. */
    assessmentRubric: jsonb("assessment_rubric").$type<ReliabilityRubric>(),
    assessmentStatus: sourceAssessmentStatusEnum("assessment_status"),
    assessedByUserId: integer("assessed_by_user_id").references(
      () => facultyUsersTable.id,
      { onDelete: "set null" },
    ),
    assessedAt: timestamp("assessed_at", { withTimezone: true }),
    /** Snapshot of the original AI-suggested rubric, for draft-vs-final
     * acceptance scoring. null when the steward assessed by hand. */
    assessmentAiDraft: jsonb("assessment_ai_draft").$type<ReliabilityRubric>(),
    /** 'unedited' | 'light' | 'rewritten' | 'no_draft', computed on approval. */
    assessmentAiAcceptance: text("assessment_ai_acceptance"),
    // ── Topic-fit guardrail (observe-and-flag, NEVER blocks ingestion) ──
    // Cosine similarity of the document's mean chunk embedding vs the pillar's
    // topic anchor (approved-corpus centroid, falling back to the pillar
    // description embedding). Scored at ingest for new uploads and lazily at
    // read time for historical documents. `null` = not yet scored (or no
    // anchor was available). The flag marks a document that looks off-topic
    // for its pillar so an admin can review it — content is never blocked.
    topicFitScore: real("topic_fit_score"),
    offTopicSuspect: boolean("off_topic_suspect").notNull().default(false),
    topicFitCheckedAt: timestamp("topic_fit_checked_at", {
      withTimezone: true,
    }),
    /** sha256 hex of `full_text`, computed on every (re-)ingest and
     * backfilled at boot. Feeds the append-only corpus manifest
     * (hash-of-hashes) so Palonur can prove what the corpus contained at a
     * given time. Statistical evidence, not proof of copying. */
    contentHash: text("content_hash"),
    /** Synthetic canary document (IP-protection registry). Canaries appear
     * in licensee-facing retrieval and corpus exports, but are excluded
     * PRE-RETRIEVAL from consumer-facing answers, public citations, steward
     * review queues, and coverage/gap/analytics surfaces. */
    isCanary: boolean("is_canary").notNull().default(false),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    pillarDoiUnique: uniqueIndex("sources_pillar_doi_unique")
      .on(t.pillarId, t.doi)
      .where(sql`${t.doi} IS NOT NULL`),
    pillarStatusIdx: index("sources_pillar_status_idx").on(
      t.pillarId,
      t.status,
    ),
    pillarAssessmentIdx: index("sources_pillar_assessment_idx").on(
      t.pillarId,
      t.assessmentStatus,
    ),
  }),
);

export const sourceChunksTable = pgTable(
  "source_chunks",
  {
    id: serial("id").primaryKey(),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sourcesTable.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    text: text("text").notNull(),
    embedding: halfvecDimensionless("embedding"),
    /** Name of the embedding model that produced `embedding`. Pinned per
     * row so the system stays correct across upstream model rotations:
     * retrieval can detect and skip / re-embed mixed-model chunks instead
     * of silently comparing vectors from different embedding spaces. */
    embeddingModel: text("embedding_model"),
    /** sha256 hex of `text` — per-chunk content hash for the manifest. */
    contentHash: text("content_hash"),
    page: integer("page"),
    section: text("section"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    sourceChunkUnique: uniqueIndex("source_chunks_source_chunk_unique").on(
      t.sourceId,
      t.chunkIndex,
    ),
    embeddingHnswIdx: index("source_chunks_embedding_hnsw_idx")
      .using(
        "hnsw",
        sql`(${t.embedding}::halfvec(${sql.raw(String(EMBEDDING_DIMENSIONS))})) halfvec_cosine_ops`,
      )
      .where(sql`embedding_model = ${sql.raw(`'${EMBEDDING_MODEL}'`)}`),
  }),
);

export const sourceVersionsTable = pgTable(
  "source_versions",
  {
    id: serial("id").primaryKey(),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sourcesTable.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    sourceVersionUnique: uniqueIndex(
      "source_versions_source_version_unique",
    ).on(t.sourceId, t.version),
  }),
);

export const sourceAuditLogTable = pgTable("source_audit_log", {
  id: serial("id").primaryKey(),
  sourceId: integer("source_id")
    .notNull()
    .references(() => sourcesTable.id, { onDelete: "cascade" }),
  actorUserId: integer("actor_user_id").references(
    () => facultyUsersTable.id,
    { onDelete: "set null" },
  ),
  action: text("action").notNull(),
  fromStatus: sourceStatusEnum("from_status"),
  toStatus: sourceStatusEnum("to_status"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertSourceSchema = createInsertSchema(sourcesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSource = z.infer<typeof insertSourceSchema>;
export type Source = typeof sourcesTable.$inferSelect;
export type SourceChunk = typeof sourceChunksTable.$inferSelect;
export type SourceVersion = typeof sourceVersionsTable.$inferSelect;
export type SourceAuditLogRow = typeof sourceAuditLogTable.$inferSelect;

export type SourceStatus =
  | "draft"
  | "in_review"
  | "approved"
  | "archived";
export type SourceKind = "paper" | "slm_article" | "note" | "talk";
export type SourceRightsBasis =
  | "open_license"
  | "permission"
  | "public_domain"
  | "no_documented_full_text_rights";
export type SourceRetentionStatus =
  | "needs_review"
  | "review_window"
  | "retained_with_rights"
  | "purged_no_full_text_rights";
