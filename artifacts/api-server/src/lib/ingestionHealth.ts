import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  embedTexts,
  toVectorLiteral,
  cosineSim,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
} from "./embeddings.js";
import { RAG_MIN_SCORE } from "./ragThreshold.js";

/**
 * Ingestion / embedding health + topic-fit guardrail.
 *
 * Everything in this module is OBSERVE-AND-FLAG only: nothing here ever
 * blocks an upload, mutates chunk embeddings, or re-embeds content. It
 * powers the admin "Ingestion Health" dashboard and the ingest-time
 * topic-fit score persisted on `sources`.
 */

/**
 * Minimum topic-fit cosine similarity before a document is flagged
 * `off_topic_suspect`. Calibrated for gte-small's compressed cosine band
 * (same geometry rationale as RAG_MIN_SCORE, but looser: a document that
 * merely *leans* off-topic should not be flagged — only clear outliers).
 * Env-overridable for production tuning.
 */
export const TOPIC_FIT_MIN_SCORE = (() => {
  const raw = Number(process.env.TOPIC_FIT_MIN_SCORE);
  return Number.isFinite(raw) && raw > 0 ? raw : 0.72;
})();

/** Parse a pgvector text literal "[1,2,3]" into number[]. */
function parseVec(text: string): number[] {
  return text
    .slice(1, -1)
    .split(",")
    .filter((s) => s.length > 0)
    .map(Number);
}

function rowsOf<T>(result: unknown): T[] {
  const r = result as { rows?: T[] };
  return (r.rows ?? (result as T[])) as T[];
}

/** Mean of a set of equal-length vectors (not normalized; cosineSim copes). */
export function meanVector(vecs: number[][]): number[] | null {
  if (vecs.length === 0) return null;
  const dim = vecs[0].length;
  const out = new Array<number>(dim).fill(0);
  for (const v of vecs) {
    if (v.length !== dim) continue;
    for (let i = 0; i < dim; i++) out[i] += v[i];
  }
  for (let i = 0; i < dim; i++) out[i] /= vecs.length;
  return out;
}

export interface TopicAnchor {
  embedding: number[];
  /** What the anchor was built from. */
  basis: "corpus" | "description";
}

/**
 * The pillar's "topic anchor": the centroid of its approved corpus chunks
 * (current embedding model only), falling back to an embedding of the
 * pillar description when the pillar has no approved corpus yet. Returns
 * null when neither exists — in that case topic fit simply cannot be
 * scored (and never flags anything).
 */
export async function pillarTopicAnchor(
  pillarId: number,
  excludeSourceId?: number,
): Promise<TopicAnchor | null> {
  const corpus = await db.execute<{ emb: string }>(sql`
    SELECT sc.embedding::text AS emb
    FROM source_chunks sc
    JOIN sources s ON s.id = sc.source_id
    WHERE s.pillar_id = ${pillarId}
      AND s.status = 'approved'
      AND s.is_canary = FALSE
       AND s.rights_basis IS NOT NULL
       AND s.retention_status = 'retained_with_rights'
      AND sc.embedding IS NOT NULL
      AND sc.embedding_model = ${EMBEDDING_MODEL}
      ${excludeSourceId ? sql`AND sc.source_id <> ${excludeSourceId}` : sql``}
    ORDER BY sc.id DESC
    LIMIT 256
  `);
  const corpusRows = rowsOf<{ emb: string }>(corpus);
  const centroid = meanVector(corpusRows.map((r) => parseVec(r.emb)));
  if (centroid) return { embedding: centroid, basis: "corpus" };

  const pillar = await db.execute<{ description: string | null }>(sql`
    SELECT description FROM pillars WHERE id = ${pillarId}
  `);
  const desc = rowsOf<{ description: string | null }>(pillar)[0]?.description;
  if (desc && desc.trim().length > 0) {
    const [emb] = await embedTexts([desc.trim()]);
    return { embedding: emb, basis: "description" };
  }
  return null;
}

export interface TopicFitResult {
  score: number;
  suspect: boolean;
  basis: "corpus" | "description";
}

/**
 * Score a document embedding against its pillar's topic anchor. Pure
 * observe-and-flag: returns null (no opinion) when no anchor exists.
 */
export async function computeTopicFit(
  pillarId: number,
  docEmbedding: number[],
  excludeSourceId?: number,
): Promise<TopicFitResult | null> {
  const anchor = await pillarTopicAnchor(pillarId, excludeSourceId);
  if (!anchor) return null;
  const score = cosineSim(docEmbedding, anchor.embedding);
  return { score, suspect: score < TOPIC_FIT_MIN_SCORE, basis: anchor.basis };
}

/**
 * Persist a topic-fit score + suspect flag on a source row. Best-effort:
 * callers on the ingest path wrap this in try/catch so a scoring failure
 * can never fail an upload.
 */
export async function persistTopicFit(
  sourceId: number,
  fit: TopicFitResult,
): Promise<void> {
  await db.execute(sql`
    UPDATE sources
    SET topic_fit_score = ${fit.score},
        off_topic_suspect = ${fit.suspect},
        topic_fit_checked_at = now()
    WHERE id = ${sourceId}
  `);
}

/**
 * Lazily score one historical (pre-guardrail) source at read time: embed a
 * sample of its text, compare to the pillar anchor, persist. Returns the
 * result or null when the source has no text or the pillar has no anchor.
 */
export async function scoreSourceTopicFit(
  sourceId: number,
): Promise<TopicFitResult | null> {
  const res = await db.execute<{
    id: number;
    pillar_id: number;
    full_text: string | null;
    abstract: string | null;
    title: string;
  }>(sql`
    SELECT id, pillar_id, full_text, abstract, title
    FROM sources
    WHERE id = ${sourceId}
      AND rights_basis IS NOT NULL
      AND retention_status IN ('review_window', 'retained_with_rights')
  `);
  const src = rowsOf<{
    id: number;
    pillar_id: number;
    full_text: string | null;
    abstract: string | null;
    title: string;
  }>(res)[0];
  if (!src) return null;
  const sample = (src.full_text || src.abstract || src.title || "")
    .trim()
    .slice(0, 4000);
  if (!sample) return null;
  const [docEmbedding] = await embedTexts([sample]);
  const fit = await computeTopicFit(src.pillar_id, docEmbedding, src.id);
  if (!fit) return null;
  await persistTopicFit(src.id, fit);
  return fit;
}

// ── Dashboard read models ───────────────────────────────────────────────

export interface PillarIngestionSummary {
  pillarId: number;
  slug: string;
  name: string;
  retired: boolean;
  sourceCount: number;
  approvedSourceCount: number;
  draftSourceCount: number;
  inReviewSourceCount: number;
  archivedSourceCount: number;
  /** True when nothing is wrong: no missing/mismatched embeddings, no off-topic flags. */
  healthy: boolean;
  sourceChunkCount: number;
  sourceChunksMissingEmbedding: number;
  sourceChunksModelMismatch: number;
  interpretationChunkCount: number;
  interpretationChunksMissingEmbedding: number;
  interpretationChunksModelMismatch: number;
  offTopicSuspectCount: number;
  topicFitUnscoredCount: number;
}

export async function getPillarIngestionSummaries(): Promise<
  PillarIngestionSummary[]
> {
  const res = await db.execute<Record<string, unknown>>(sql`
    SELECT
      p.id, p.slug, p.name,
      (p.retired_at IS NOT NULL) AS retired,
      COALESCE(s.source_count, 0)        AS source_count,
      COALESCE(s.approved_count, 0)      AS approved_count,
      COALESCE(s.draft_count, 0)         AS draft_count,
      COALESCE(s.in_review_count, 0)     AS in_review_count,
      COALESCE(s.archived_count, 0)      AS archived_count,
      COALESCE(s.suspect_count, 0)       AS suspect_count,
      COALESCE(s.unscored_count, 0)      AS unscored_count,
      COALESCE(sc.chunk_count, 0)        AS sc_count,
      COALESCE(sc.missing_embedding, 0)  AS sc_missing,
      COALESCE(sc.model_mismatch, 0)     AS sc_mismatch,
      COALESCE(ic.chunk_count, 0)        AS ic_count,
      COALESCE(ic.missing_embedding, 0)  AS ic_missing,
      COALESCE(ic.model_mismatch, 0)     AS ic_mismatch
    FROM pillars p
    LEFT JOIN (
      SELECT pillar_id,
        COUNT(*) AS source_count,
        COUNT(*) FILTER (WHERE status = 'approved') AS approved_count,
        COUNT(*) FILTER (WHERE status = 'draft') AS draft_count,
        COUNT(*) FILTER (WHERE status = 'in_review') AS in_review_count,
        COUNT(*) FILTER (WHERE status = 'archived') AS archived_count,
        COUNT(*) FILTER (WHERE off_topic_suspect) AS suspect_count,
        COUNT(*) FILTER (WHERE topic_fit_score IS NULL) AS unscored_count
      FROM sources WHERE is_canary = FALSE GROUP BY pillar_id
    ) s ON s.pillar_id = p.id
    LEFT JOIN (
      SELECT so.pillar_id,
        COUNT(*) AS chunk_count,
        COUNT(*) FILTER (WHERE c.embedding IS NULL) AS missing_embedding,
        COUNT(*) FILTER (
          WHERE c.embedding IS NOT NULL
            AND c.embedding_model IS DISTINCT FROM ${EMBEDDING_MODEL}
        ) AS model_mismatch
      FROM source_chunks c JOIN sources so ON so.id = c.source_id
       WHERE so.is_canary = FALSE
         AND so.rights_basis IS NOT NULL
         AND so.retention_status IN ('review_window', 'retained_with_rights')
      GROUP BY so.pillar_id
    ) sc ON sc.pillar_id = p.id
    LEFT JOIN (
      SELECT pillar_id,
        COUNT(*) AS chunk_count,
        COUNT(*) FILTER (WHERE embedding IS NULL) AS missing_embedding,
        COUNT(*) FILTER (
          WHERE embedding IS NOT NULL
            AND embedding_model IS DISTINCT FROM ${EMBEDDING_MODEL}
        ) AS model_mismatch
      FROM interpretation_chunks GROUP BY pillar_id
    ) ic ON ic.pillar_id = p.id
    ORDER BY p.name ASC
  `);
  return rowsOf<Record<string, unknown>>(res).map((r) => ({
    pillarId: Number(r.id),
    slug: String(r.slug),
    name: String(r.name),
    retired: Boolean(r.retired),
    sourceCount: Number(r.source_count),
    approvedSourceCount: Number(r.approved_count),
    draftSourceCount: Number(r.draft_count),
    inReviewSourceCount: Number(r.in_review_count),
    archivedSourceCount: Number(r.archived_count),
    healthy:
      Number(r.sc_missing) === 0 &&
      Number(r.sc_mismatch) === 0 &&
      Number(r.ic_missing) === 0 &&
      Number(r.ic_mismatch) === 0 &&
      Number(r.suspect_count) === 0,
    sourceChunkCount: Number(r.sc_count),
    sourceChunksMissingEmbedding: Number(r.sc_missing),
    sourceChunksModelMismatch: Number(r.sc_mismatch),
    interpretationChunkCount: Number(r.ic_count),
    interpretationChunksMissingEmbedding: Number(r.ic_missing),
    interpretationChunksModelMismatch: Number(r.ic_mismatch),
    offTopicSuspectCount: Number(r.suspect_count),
    topicFitUnscoredCount: Number(r.unscored_count),
  }));
}

export interface DocumentIngestionDetail {
  sourceId: number;
  title: string;
  kind: string;
  status: string;
  version: number;
  createdAt: string;
  uploaderName: string | null;
  uploaderEmail: string | null;
  /** Distinct embedding_model values on this document's source chunks. */
  embeddingModels: string[];
  chunkCount: number;
  chunksMissingEmbedding: number;
  chunksModelMismatch: number;
  interpretationChunkCount: number;
  interpretationChunksMissingEmbedding: number;
  interpretationChunksModelMismatch: number;
  topicFitScore: number | null;
  offTopicSuspect: boolean;
  topicFitCheckedAt: string | null;
}

/** How many historical docs to lazily topic-fit-score per dashboard read. */
const LAZY_SCORE_BATCH = 10;

/**
 * Per-document drill-down for one pillar. Also lazily scores topic fit for
 * up to LAZY_SCORE_BATCH not-yet-scored documents (best-effort; a scoring
 * failure never fails the read).
 */
export async function getPillarDocuments(
  pillarId: number,
): Promise<DocumentIngestionDetail[]> {
  // Lazy topic-fit backfill for historical documents.
  const unscored = await db.execute<{ id: number }>(sql`
    SELECT id FROM sources
    WHERE pillar_id = ${pillarId} AND topic_fit_checked_at IS NULL
      AND is_canary = FALSE
    ORDER BY id ASC
    LIMIT ${LAZY_SCORE_BATCH}
  `);
  for (const row of rowsOf<{ id: number }>(unscored)) {
    try {
      await scoreSourceTopicFit(Number(row.id));
    } catch {
      // Observe-only: never fail the dashboard read over a scoring error.
    }
  }

  const res = await db.execute<Record<string, unknown>>(sql`
    SELECT
      s.id, s.title, s.kind, s.status, s.version, s.created_at,
      s.topic_fit_score, s.off_topic_suspect, s.topic_fit_checked_at,
      fu.name AS uploader_name, fu.email AS uploader_email,
      COALESCE(sc.models, ARRAY[]::text[]) AS models,
      COALESCE(sc.chunk_count, 0)       AS sc_count,
      COALESCE(sc.missing_embedding, 0) AS sc_missing,
      COALESCE(sc.model_mismatch, 0)    AS sc_mismatch,
      COALESCE(ic.chunk_count, 0)       AS ic_count,
      COALESCE(ic.missing_embedding, 0) AS ic_missing,
      COALESCE(ic.model_mismatch, 0)    AS ic_mismatch
    FROM sources s
    LEFT JOIN faculty_users fu ON fu.id = s.uploaded_by_user_id
    LEFT JOIN (
      SELECT source_id,
        COUNT(*) AS chunk_count,
        COUNT(*) FILTER (WHERE embedding IS NULL) AS missing_embedding,
        COUNT(*) FILTER (
          WHERE embedding IS NOT NULL
            AND embedding_model IS DISTINCT FROM ${EMBEDDING_MODEL}
        ) AS model_mismatch,
        ARRAY_AGG(DISTINCT embedding_model) FILTER (WHERE embedding_model IS NOT NULL) AS models
       FROM source_chunks sc
       JOIN sources chunk_source ON chunk_source.id = sc.source_id
       WHERE chunk_source.rights_basis IS NOT NULL
         AND chunk_source.retention_status IN ('review_window', 'retained_with_rights')
       GROUP BY sc.source_id
    ) sc ON sc.source_id = s.id
    LEFT JOIN (
      SELECT source_id,
        COUNT(*) AS chunk_count,
        COUNT(*) FILTER (WHERE embedding IS NULL) AS missing_embedding,
        COUNT(*) FILTER (
          WHERE embedding IS NOT NULL
            AND embedding_model IS DISTINCT FROM ${EMBEDDING_MODEL}
        ) AS model_mismatch
      FROM interpretation_chunks GROUP BY source_id
    ) ic ON ic.source_id = s.id
    WHERE s.pillar_id = ${pillarId} AND s.is_canary = FALSE
    ORDER BY s.created_at DESC
  `);
  return rowsOf<Record<string, unknown>>(res).map((r) => ({
    sourceId: Number(r.id),
    title: String(r.title),
    kind: String(r.kind),
    status: String(r.status),
    version: Number(r.version),
    createdAt: String(r.created_at),
    uploaderName: r.uploader_name == null ? null : String(r.uploader_name),
    uploaderEmail: r.uploader_email == null ? null : String(r.uploader_email),
    embeddingModels: Array.isArray(r.models) ? (r.models as string[]) : [],
    chunkCount: Number(r.sc_count),
    chunksMissingEmbedding: Number(r.sc_missing),
    chunksModelMismatch: Number(r.sc_mismatch),
    interpretationChunkCount: Number(r.ic_count),
    interpretationChunksMissingEmbedding: Number(r.ic_missing),
    interpretationChunksModelMismatch: Number(r.ic_mismatch),
    topicFitScore: r.topic_fit_score == null ? null : Number(r.topic_fit_score),
    offTopicSuspect: Boolean(r.off_topic_suspect),
    topicFitCheckedAt:
      r.topic_fit_checked_at == null ? null : String(r.topic_fit_checked_at),
  }));
}

// ── Self-retrieval verification probe ──────────────────────────────────

export interface SelfRetrievalProbeResult {
  sourceId: number;
  title: string;
  status: string;
  probedChunkId: number;
  probedChunkIndex: number;
  /** Similarity of the probe embedding to the best hit in the pillar. */
  topScore: number;
  /** Whether the best hit belongs to the probed document. */
  selfHit: boolean;
  /** selfHit AND topScore clears the retrieval threshold. */
  ok: boolean;
}

export interface SelfRetrievalReport {
  threshold: number;
  probed: number;
  passed: number;
  results: SelfRetrievalProbeResult[];
}

const PROBE_MAX_DOCS = 25;

/**
 * One-click verification: for each document in the pillar (capped), take a
 * stored chunk's text, re-embed it, and run the same cosine search retrieval
 * uses — the chunk should retrieve its own document above RAG_MIN_SCORE.
 * A failure means the stored embedding and a fresh embedding of the same
 * text disagree (corrupt/stale embedding) or the chunk is invisible to the
 * current-model index. Read-only; never mutates anything.
 */
export async function verifyPillarSelfRetrieval(
  pillarId: number,
): Promise<SelfRetrievalReport> {
  const probes = await db.execute<{
    chunk_id: number;
    chunk_index: number;
    text: string;
    source_id: number;
    title: string;
    status: string;
  }>(sql`
    SELECT DISTINCT ON (sc.source_id)
      sc.id AS chunk_id, sc.chunk_index, sc.text,
      s.id AS source_id, s.title, s.status
    FROM source_chunks sc
    JOIN sources s ON s.id = sc.source_id
    WHERE s.pillar_id = ${pillarId} AND s.is_canary = FALSE
      AND s.rights_basis IS NOT NULL
      AND s.retention_status IN ('review_window', 'retained_with_rights')
      AND sc.embedding IS NOT NULL
      AND sc.embedding_model = ${EMBEDDING_MODEL}
    ORDER BY sc.source_id ASC, sc.chunk_index ASC
    LIMIT ${PROBE_MAX_DOCS}
  `);
  const probeRows = rowsOf<{
    chunk_id: number;
    chunk_index: number;
    text: string;
    source_id: number;
    title: string;
    status: string;
  }>(probes);

  if (probeRows.length === 0) {
    return { threshold: RAG_MIN_SCORE, probed: 0, passed: 0, results: [] };
  }

  const embeddings = await embedTexts(probeRows.map((p) => p.text));
  const results: SelfRetrievalProbeResult[] = [];

  for (let i = 0; i < probeRows.length; i++) {
    const p = probeRows[i];
    const lit = toVectorLiteral(embeddings[i]);
    const hit = await db.execute<{ chunk_id: number; source_id: number; distance: number }>(sql`
      SELECT sc.id AS chunk_id, sc.source_id,
        (sc.embedding <=> ${lit}::halfvec(${sql.raw(String(EMBEDDING_DIMENSIONS))})) AS distance
      FROM source_chunks sc
      JOIN sources s ON s.id = sc.source_id
      WHERE s.pillar_id = ${pillarId} AND s.is_canary = FALSE
        AND s.rights_basis IS NOT NULL
        AND s.retention_status IN ('review_window', 'retained_with_rights')
        AND sc.embedding IS NOT NULL
        AND sc.embedding_model = ${EMBEDDING_MODEL}
      ORDER BY sc.embedding <=> ${lit}::halfvec(${sql.raw(String(EMBEDDING_DIMENSIONS))})
      LIMIT 1
    `);
    const top = rowsOf<{ chunk_id: number; source_id: number; distance: number }>(hit)[0];
    const topScore = top ? 1 - Number(top.distance) : 0;
    const selfHit = top ? Number(top.source_id) === Number(p.source_id) : false;
    results.push({
      sourceId: Number(p.source_id),
      title: p.title,
      status: p.status,
      probedChunkId: Number(p.chunk_id),
      probedChunkIndex: Number(p.chunk_index),
      topScore,
      selfHit,
      ok: selfHit && topScore >= RAG_MIN_SCORE,
    });
  }

  return {
    threshold: RAG_MIN_SCORE,
    probed: results.length,
    passed: results.filter((r) => r.ok).length,
    results,
  };
}
