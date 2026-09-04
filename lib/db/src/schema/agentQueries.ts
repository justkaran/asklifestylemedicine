import {
  pgTable,
  serial,
  text,
  integer,
  real,
  boolean,
  timestamp,
  index,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pillarsTable } from "./faculty";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  halfvecDimensionless,
} from "./sources";

/**
 * Per-request log of every public /api/sleep-agent question. Best-effort,
 * written after res.end(); never blocks the user response. PII-free:
 * `session_id` is a random cookie token, never a user account, and we
 * deliberately do not capture IP, UA, or geolocation.
 */
export const agentQueriesTable = pgTable(
  "agent_queries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: text("session_id").notNull(),
    question: text("question").notNull(),
    questionEmbedding: halfvecDimensionless("question_embedding"),
    /** Name of the embedding model that produced `question_embedding`.
     * Pinned per row so cluster jobs and reuse-matching can refuse to
     * mix vectors from different embedding spaces across model rotations. */
    embeddingModel: text("embedding_model"),
    /** Which agent surface produced this query — `sleep-agent` (the public
     * cross-pillar consumer agent) or `embed-agent` (a single-pillar
     * white-label widget). Lets the faculty dashboard report per-pillar
     * usage of an expert's embedded agent without mixing in sleep-agent
     * traffic. */
    source: text("source").notNull().default("sleep-agent"),
    pillarIds: integer("pillar_ids")
      .array()
      .notNull()
      .default(sql`ARRAY[]::int[]`),
    retrievedSourceIds: integer("retrieved_source_ids")
      .array()
      .notNull()
      .default(sql`ARRAY[]::int[]`),
    retrievedInterpretationIds: integer("retrieved_interpretation_ids")
      .array()
      .notNull()
      .default(sql`ARRAY[]::int[]`),
    /** Published knowledge snapshot that governed this answer, when the
     * selected pillar has entered versioned knowledge mode. Null preserves
     * historical rows and legacy/fan-out answer paths. */
    knowledgeVersionId: integer("knowledge_version_id"),
    topScore: real("top_score").notNull().default(0),
    wasUncovered: boolean("was_uncovered").notNull().default(false),
    answerText: text("answer_text").notNull().default(""),
    latencyMs: integer("latency_ms").notNull().default(0),
    userFlagged: boolean("user_flagged").notNull().default(false),
    flagReason: text("flag_reason"),
    clusterId: integer("cluster_id"),
    /** Partner key this query was billed to, if it came through a keyed
     * (programmatic / external-agent) request. Null for first-party humans.
     * FK-less on purpose so log writes never fail on a since-deleted key. */
    partnerKeyId: integer("partner_key_id"),
    /** LLM token usage for the answer, captured from the Anthropic stream
     * (message_start / message_delta usage). NULL for rows logged before
     * tracking began and for paths that never call the LLM (short-circuit
     * UNCOVERED, refusals decided pre-stream). */
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pillarUncoveredCreatedIdx: index(
      "agent_queries_pillar_uncovered_created_idx",
    ).on(t.wasUncovered, t.createdAt),
    sessionIdx: index("agent_queries_session_idx").on(t.sessionId),
    embeddingHnswIdx: index("agent_queries_embedding_hnsw_idx")
      .using(
        "hnsw",
        sql`(${t.questionEmbedding}::halfvec(${sql.raw(String(EMBEDDING_DIMENSIONS))})) halfvec_cosine_ops`,
      )
      .where(sql`embedding_model = ${sql.raw(`'${EMBEDDING_MODEL}'`)}`),
  }),
);

/**
 * Stable clusters of uncovered/low-confidence queries per pillar. Re-running
 * the cluster job is idempotent: existing clusters are matched by cosine
 * proximity of their representative embedding so dashboard cards don't
 * reshuffle randomly between runs.
 */
export const queryClustersTable = pgTable(
  "query_clusters",
  {
    id: serial("id").primaryKey(),
    pillarId: integer("pillar_id")
      .notNull()
      .references(() => pillarsTable.id, { onDelete: "cascade" }),
    representativeQuestion: text("representative_question").notNull(),
    representativeEmbedding: halfvecDimensionless("representative_embedding"),
    /** Name of the embedding model that produced
     * `representative_embedding`. Pinned per row so a cluster job after a
     * model rotation can detect mixed-model clusters instead of silently
     * matching them via cosine across different embedding spaces. */
    embeddingModel: text("embedding_model"),
    size: integer("size").notNull().default(0),
    lastUpdated: timestamp("last_updated", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pillarIdx: index("query_clusters_pillar_idx").on(t.pillarId),
  }),
);

export type AgentQuery = typeof agentQueriesTable.$inferSelect;
export type QueryCluster = typeof queryClustersTable.$inferSelect;
