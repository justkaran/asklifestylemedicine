import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { facultyUsersTable, pillarsTable } from "./faculty";
import { interpretationsTable } from "./interpretations";
import { halfvecDimensionless } from "./sources";

/**
 * A relationship is an explicit faculty judgement about how two approved
 * interpretation-level claims fit together. Claims remain the existing,
 * reviewable interpretation records; this table adds the graph edge without
 * duplicating their provenance or approval lifecycle.
 */
export const knowledgeRelationTypeEnum = pgEnum("knowledge_relation_type", [
  "supports",
  "refines",
  "qualifies",
  "contradicts",
]);

/**
 * The immutable material used to answer from a published knowledge version.
 * Unlike a claim snapshot, this freezes the exact chunk text, embedding and
 * citation-facing fields so later source edits, re-embedding, or retirement
 * cannot rewrite the evidence behind an already-published version.
 */
export const knowledgeVersionChunkKindEnum = pgEnum("knowledge_version_chunk_kind", [
  "interpretation",
  "source",
]);

export const knowledgeRelationsTable = pgTable(
  "knowledge_relations",
  {
    id: serial("id").primaryKey(),
    pillarId: integer("pillar_id")
      .notNull()
      .references(() => pillarsTable.id, { onDelete: "cascade" }),
    fromInterpretationId: integer("from_interpretation_id")
      .notNull()
      .references(() => interpretationsTable.id, { onDelete: "cascade" }),
    toInterpretationId: integer("to_interpretation_id")
      .notNull()
      .references(() => interpretationsTable.id, { onDelete: "cascade" }),
    relation: knowledgeRelationTypeEnum("relation").notNull(),
    note: text("note"),
    createdByUserId: integer("created_by_user_id").references(
      () => facultyUsersTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pillarIdx: index("knowledge_relations_pillar_idx").on(t.pillarId),
    uniqueEdge: uniqueIndex("knowledge_relations_unique_edge").on(
      t.fromInterpretationId,
      t.toInterpretationId,
      t.relation,
    ),
  }),
);

/**
 * A published knowledge version is a complete immutable JSON snapshot of the
 * approved claims and graph edges in one pillar. The snapshot deliberately
 * carries citation-facing source metadata so historical answer replays do not
 * depend on mutable source or faculty profile rows.
 */
export const knowledgeVersionsTable = pgTable(
  "knowledge_versions",
  {
    id: serial("id").primaryKey(),
    pillarId: integer("pillar_id")
      .notNull()
      .references(() => pillarsTable.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    label: text("label").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    claimCount: integer("claim_count").notNull().default(0),
    relationCount: integer("relation_count").notNull().default(0),
    note: text("note"),
    publishedByUserId: integer("published_by_user_id").references(
      () => facultyUsersTable.id,
      { onDelete: "set null" },
    ),
    publishedAt: timestamp("published_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pillarVersionUnique: uniqueIndex("knowledge_versions_pillar_version_unique").on(
      t.pillarId,
      t.version,
    ),
    latestByPillarIdx: index("knowledge_versions_pillar_published_idx").on(
      t.pillarId,
      t.publishedAt,
    ),
  }),
);

export const knowledgeVersionChunksTable = pgTable(
  "knowledge_version_chunks",
  {
    id: serial("id").primaryKey(),
    knowledgeVersionId: integer("knowledge_version_id")
      .notNull()
      .references(() => knowledgeVersionsTable.id, { onDelete: "cascade" }),
    kind: knowledgeVersionChunkKindEnum("kind").notNull(),
    sourceId: integer("source_id").notNull(),
    interpretationId: integer("interpretation_id"),
    pillarId: integer("pillar_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    text: text("text").notNull(),
    embedding: halfvecDimensionless("embedding").notNull(),
    embeddingModel: text("embedding_model").notNull(),
    sourceTitle: text("source_title").notNull(),
    sourceAuthors: text("source_authors"),
    sourceYear: integer("source_year"),
    sourceJournal: text("source_journal"),
    sourceDoi: text("source_doi"),
    sourceUrl: text("source_url"),
    sourceRetentionStatus: text("source_retention_status").notNull(),
    sourceStudyDesign: text("source_study_design"),
    sourceReliabilityRubric: jsonb("source_reliability_rubric"),
    pillarSlug: text("pillar_slug").notNull(),
    pillarName: text("pillar_name").notNull(),
    interpretationAuthor: text("interpretation_author"),
    interpretationOrigin: text("interpretation_origin"),
    interpretationReviewer: text("interpretation_reviewer"),
    advisorLensSlug: text("advisor_lens_slug"),
    advisorLensName: text("advisor_lens_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    versionKindChunkUnique: uniqueIndex(
      "knowledge_version_chunks_version_kind_source_chunk_unique",
    ).on(t.knowledgeVersionId, t.kind, t.sourceId, t.chunkIndex),
    versionIdx: index("knowledge_version_chunks_version_idx").on(
      t.knowledgeVersionId,
    ),
    embeddingHnswIdx: index("knowledge_version_chunks_embedding_hnsw_idx").using(
      "hnsw",
      sql`(${t.embedding}::halfvec(384)) halfvec_cosine_ops`,
    ),
  }),
);

export type KnowledgeRelation = typeof knowledgeRelationsTable.$inferSelect;
export type KnowledgeVersion = typeof knowledgeVersionsTable.$inferSelect;
export type KnowledgeVersionChunk = typeof knowledgeVersionChunksTable.$inferSelect;
export const insertKnowledgeRelationSchema = createInsertSchema(
  knowledgeRelationsTable,
).omit({ id: true, createdAt: true });
export const insertKnowledgeVersionSchema = createInsertSchema(
  knowledgeVersionsTable,
).omit({ id: true, publishedAt: true });
export type InsertKnowledgeRelation = z.infer<
  typeof insertKnowledgeRelationSchema
>;
export type InsertKnowledgeVersion = z.infer<typeof insertKnowledgeVersionSchema>;
export type KnowledgeRelationType =
  | "supports"
  | "refines"
  | "qualifies"
  | "contradicts";
