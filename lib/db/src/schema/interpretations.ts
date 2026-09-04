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
  real,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sql } from "drizzle-orm";
import { pillarsTable, facultyUsersTable } from "./faculty";
import {
  sourcesTable,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  halfvecDimensionless,
} from "./sources";

export const interpretationStatusEnum = pgEnum("interpretation_status", [
  "proposed",
  "approved",
  "archived",
]);

/** Whether the first body came from Palonur's drafter or a faculty author. */
export const interpretationOriginEnum = pgEnum("interpretation_origin", [
  "palonur_ai",
  "faculty",
]);

export const interpretationsTable = pgTable(
  "interpretations",
  {
    id: serial("id").primaryKey(),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sourcesTable.id, { onDelete: "cascade" }),
    pillarId: integer("pillar_id")
      .notNull()
      .references(() => pillarsTable.id, { onDelete: "cascade" }),
    authorId: integer("author_id").references(() => facultyUsersTable.id, {
      onDelete: "set null",
    }),
    origin: interpretationOriginEnum("origin").notNull().default("faculty"),
    draftedAt: timestamp("drafted_at", { withTimezone: true }),
    reviewedByUserId: integer("reviewed_by_user_id").references(
      () => facultyUsersTable.id,
      { onDelete: "set null" },
    ),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    lastEditedByUserId: integer("last_edited_by_user_id").references(
      () => facultyUsersTable.id,
      { onDelete: "set null" },
    ),
    lastEditedAt: timestamp("last_edited_at", { withTimezone: true }),
    status: interpretationStatusEnum("status").notNull().default("proposed"),
    version: integer("version").notNull().default(1),
    answer: text("answer").notNull(),
    interpretation: text("interpretation").notNull(),
    notProven: text("not_proven"),
    action: text("action"),
    tags: text("tags").array().notNull().default(sql`ARRAY[]::text[]`),
    approverId: integer("approver_id").references(() => facultyUsersTable.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    parentInterpretationId: integer("parent_interpretation_id"),
    /** The most recent AI-drafted interpretation snapshot offered for
     * this row (without the AI_DRAFT_PREFIX banner). Set on /promote
     * (initial seed) and overwritten on /redraft (re-roll). NULL means
     * the steward wrote this interpretation by hand without ever asking
     * the drafter. Compared against the final approved body to compute
     * `aiDraftSimilarity` and `aiDraftAcceptance` on approval. */
    aiDraft: text("ai_draft"),
    /** Normalized Levenshtein similarity (0..1) between `aiDraft` and
     * the approved `interpretation` body, computed in the
     * proposed→approved transition. NULL until the row is approved (or
     * if there was no AI draft to compare against). */
    aiDraftSimilarity: real("ai_draft_similarity"),
    /** Bucketed acceptance label, computed alongside
     * `aiDraftSimilarity` on approval. One of:
     *   - 'unedited'  (similarity ≥ 0.95)
     *   - 'light'     (0.7 ≤ similarity < 0.95)
     *   - 'rewritten' (similarity < 0.7)
     *   - 'no_draft'  (no AI draft was ever generated for this row) */
    aiDraftAcceptance: text("ai_draft_acceptance"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    sourceStatusIdx: index("interpretations_source_status_idx").on(
      t.sourceId,
      t.status,
    ),
    pillarStatusIdx: index("interpretations_pillar_status_idx").on(
      t.pillarId,
      t.status,
    ),
    // Hard invariant: at most one approved interpretation per source.
    // Backstops the transactional demotion in the transition route
    // against concurrent approvals racing to a double-approved state.
    oneApprovedPerSource: uniqueIndex(
      "interpretations_one_approved_per_source",
    )
      .on(t.sourceId)
      .where(sql`status = 'approved'`),
  }),
);

export const interpretationVersionsTable = pgTable(
  "interpretation_versions",
  {
    id: serial("id").primaryKey(),
    interpretationId: integer("interpretation_id")
      .notNull()
      .references(() => interpretationsTable.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    approverId: integer("approver_id").references(
      () => facultyUsersTable.id,
      { onDelete: "set null" },
    ),
    approvedAt: timestamp("approved_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    interpretationVersionUnique: uniqueIndex(
      "interpretation_versions_interp_version_unique",
    ).on(t.interpretationId, t.version),
  }),
);

export const interpretationCommentsTable = pgTable(
  "interpretation_comments",
  {
    id: serial("id").primaryKey(),
    interpretationId: integer("interpretation_id")
      .notNull()
      .references(() => interpretationsTable.id, { onDelete: "cascade" }),
    authorId: integer("author_id").references(() => facultyUsersTable.id, {
      onDelete: "set null",
    }),
    body: text("body").notNull(),
    quotedText: text("quoted_text"),
    parentCommentId: integer("parent_comment_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    interpIdx: index("interpretation_comments_interp_idx").on(
      t.interpretationId,
    ),
  }),
);

export const interpretationChunksTable = pgTable(
  "interpretation_chunks",
  {
    id: serial("id").primaryKey(),
    interpretationId: integer("interpretation_id")
      .notNull()
      .references(() => interpretationsTable.id, { onDelete: "cascade" }),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sourcesTable.id, { onDelete: "cascade" }),
    pillarId: integer("pillar_id")
      .notNull()
      .references(() => pillarsTable.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    text: text("text").notNull(),
    embedding: halfvecDimensionless("embedding"),
    /** Name of the embedding model that produced `embedding`. See
     * source_chunks.embedding_model — same rationale: pin the model per
     * row so retrieval stays correct across upstream model rotations. */
    embeddingModel: text("embedding_model"),
    /** Higher = preferred. Faculty interpretations are priority 100; raw
     * paper chunks are 0. The public retriever weights this above raw text. */
    priority: integer("priority").notNull().default(100),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    interpIdx: index("interpretation_chunks_interp_idx").on(t.interpretationId),
    pillarIdx: index("interpretation_chunks_pillar_idx").on(t.pillarId),
    embeddingHnswIdx: index("interpretation_chunks_embedding_hnsw_idx")
      .using(
        "hnsw",
        sql`(${t.embedding}::halfvec(${sql.raw(String(EMBEDDING_DIMENSIONS))})) halfvec_cosine_ops`,
      )
      .where(sql`embedding_model = ${sql.raw(`'${EMBEDDING_MODEL}'`)}`),
  }),
);

/**
 * Steward-authored rubric checks (Task: recurring feedback → automatic
 * draft checks). Each row is one named, per-pillar review criterion
 * ("always state the study's age range"). Every proposed interpretation
 * in the steward's queue is scored against these by an observe-only LLM
 * pass — checks are ADVISORY flags on the review screen, never a gate:
 * the approval workflow itself is untouched.
 */
export const rubricChecksTable = pgTable(
  "rubric_checks",
  {
    id: serial("id").primaryKey(),
    pillarId: integer("pillar_id")
      .notNull()
      .references(() => pillarsTable.id, { onDelete: "cascade" }),
    /** Short display name, e.g. "Age range stated". */
    name: text("name").notNull(),
    /** The criterion itself, phrased as the steward would phrase feedback. */
    instruction: text("instruction").notNull(),
    createdById: integer("created_by_id").references(
      () => facultyUsersTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    pillarIdx: index("rubric_checks_pillar_idx").on(t.pillarId),
  }),
);

/**
 * Cached evaluation of one draft against one rubric check. `contentHash`
 * pins the result to the exact draft text + check instruction it was
 * computed for, so an edit to either side invalidates the cache and the
 * draft is lazily re-scored on the next inbox read. Observe-only, like
 * topic-fit: rows here never block or change any workflow.
 */
export const rubricCheckResultsTable = pgTable(
  "rubric_check_results",
  {
    id: serial("id").primaryKey(),
    checkId: integer("check_id")
      .notNull()
      .references(() => rubricChecksTable.id, { onDelete: "cascade" }),
    interpretationId: integer("interpretation_id")
      .notNull()
      .references(() => interpretationsTable.id, { onDelete: "cascade" }),
    /** 'pass' | 'flag' */
    verdict: text("verdict").notNull(),
    /** One-line model rationale for a flag (or pass). */
    rationale: text("rationale"),
    /** sha256 of draft content + check instruction at evaluation time. */
    contentHash: text("content_hash").notNull(),
    model: text("model"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    onePerCheckPerDraft: uniqueIndex(
      "rubric_check_results_check_interp_unique",
    ).on(t.checkId, t.interpretationId),
    interpIdx: index("rubric_check_results_interp_idx").on(t.interpretationId),
  }),
);

export type RubricCheck = typeof rubricChecksTable.$inferSelect;
export type RubricCheckResult = typeof rubricCheckResultsTable.$inferSelect;

export const insertInterpretationSchema = createInsertSchema(
  interpretationsTable,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  version: true,
  approverId: true,
  approvedAt: true,
});
export type InsertInterpretation = z.infer<typeof insertInterpretationSchema>;
export type Interpretation = typeof interpretationsTable.$inferSelect;
export type InterpretationVersion =
  typeof interpretationVersionsTable.$inferSelect;
export type InterpretationComment =
  typeof interpretationCommentsTable.$inferSelect;
export type InterpretationChunk =
  typeof interpretationChunksTable.$inferSelect;
export type InterpretationStatus = "proposed" | "approved" | "archived";
export type InterpretationOrigin = "palonur_ai" | "faculty";
