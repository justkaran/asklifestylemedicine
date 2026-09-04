import pool from "./db";
import { logger } from "./logger";
import {
  toVectorLiteral,
  cosineSim,
  embedTexts,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
} from "./embeddings";

/**
 * Greedy cosine clustering over the last 7 days of UNCOVERED queries per
 * pillar. Idempotent: each freshly-formed cluster is matched against
 * existing `query_clusters` rows in the same pillar by cosine similarity
 * of its representative embedding (>= REUSE_THRESHOLD), so ids stay
 * stable across runs and the dashboard doesn't reshuffle.
 */

const WINDOW_DAYS = 7;
const MIN_CLUSTER_SIZE = 2;
const CLUSTER_THRESHOLD = 0.78; // cosine sim within a cluster
const REUSE_THRESHOLD = 0.85; // cosine sim to reuse an existing cluster id

interface CandidateRow {
  id: string;
  question: string;
  embedding: number[];
}

interface ExistingCluster {
  id: number;
  embedding: number[];
}

function parseHalfvec(raw: unknown): number[] {
  if (!raw) return [];
  const s = typeof raw === "string" ? raw : String(raw);
  const inner = s.replace(/^\[/, "").replace(/\]$/, "");
  if (!inner) return [];
  return inner.split(",").map((x) => Number(x));
}

/**
 * Bring this pillar's in-window uncovered rows into the CURRENT embedding
 * space so they can enter the clustering pipeline below. Two cases:
 *
 *  1. Rows logged without any embedding — the embed-agent deliberately logs
 *     its usage rows with no embedding (to keep that fire-and-forget write
 *     lightweight), so without this they'd never enter clustering.
 *  2. Rows embedded with a DIFFERENT model (`embedding_model` != the current
 *     `EMBEDDING_MODEL`) — left behind by an embedding-model rotation.
 *     Without re-embedding, the clustering select below (which filters
 *     `embedding_model = EMBEDDING_MODEL`) would silently drop all of an
 *     expert's accumulated unanswered-question history the day the model is
 *     rotated, until those exact questions happened to be asked again.
 *
 * Both cases are (re-)embedded with the current `EMBEDDING_MODEL`, writing
 * `question_embedding` + `embedding_model` in lockstep, so the rows land in
 * the same vector space as everything else — there is never a cross-model
 * cosine comparison. Rows already in the current space are untouched.
 */
async function backfillEmbeddings(pillarId: number): Promise<void> {
  const stale = await pool.query<{ id: string; question: string }>(
    `SELECT id, question
       FROM agent_queries
      WHERE was_uncovered = TRUE
        AND $1 = ANY(pillar_ids)
        AND created_at >= NOW() - INTERVAL '${WINDOW_DAYS} days'
        AND (question_embedding IS NULL OR embedding_model IS DISTINCT FROM $2)
      ORDER BY created_at DESC
      LIMIT 500`,
    [pillarId, EMBEDDING_MODEL],
  );

  if (stale.rows.length === 0) return;

  let vectors: number[][];
  try {
    vectors = await embedTexts(stale.rows.map((r) => r.question));
  } catch (e) {
    // Best-effort: a failed embed call just means these rows wait for the
    // next clustering run. Never throw out of the cron job.
    logger.error({ err: e, pillarId }, "backfillEmbeddings failed");
    return;
  }

  for (let i = 0; i < stale.rows.length; i++) {
    const vec = vectors[i];
    if (!vec || vec.length === 0) continue;
    await pool.query(
      `UPDATE agent_queries
          SET question_embedding = $1::halfvec(${EMBEDDING_DIMENSIONS}),
              embedding_model = $2
        WHERE id = $3::uuid`,
      [toVectorLiteral(vec), EMBEDDING_MODEL, stale.rows[i].id],
    );
  }
}

export async function clusterPillar(pillarId: number): Promise<void> {
  // (Re-)embed rows that aren't in the current embedding space yet — rows
  // logged without an embedding (notably embed-agent uncovered questions)
  // and rows left behind by an embedding-model rotation — so they can join
  // the clustering below.
  await backfillEmbeddings(pillarId);

  const candidates = await pool.query<{
    id: string;
    question: string;
    embedding: string;
  }>(
    `SELECT id, question, question_embedding::text AS embedding
       FROM agent_queries
      WHERE was_uncovered = TRUE
        AND $1 = ANY(pillar_ids)
        AND question_embedding IS NOT NULL
        -- Skip rows embedded with a different model; their vectors live
        -- in a different space and cosine-comparing would be silently
        -- wrong. After a model rotation, those rows have to be
        -- re-embedded before they can re-enter clustering.
        AND embedding_model = '${EMBEDDING_MODEL}'
        AND created_at >= NOW() - INTERVAL '${WINDOW_DAYS} days'
      ORDER BY created_at DESC
      LIMIT 500`,
    [pillarId],
  );

  const rows: CandidateRow[] = candidates.rows.map((r) => ({
    id: r.id,
    question: r.question,
    embedding: parseHalfvec(r.embedding),
  }));

  if (rows.length === 0) return;

  // Greedy: walk newest-first, assign to first cluster within threshold;
  // otherwise start a new cluster seeded by this row.
  const buckets: Array<{ seed: CandidateRow; members: CandidateRow[] }> = [];
  for (const row of rows) {
    let assigned = false;
    for (const b of buckets) {
      if (cosineSim(row.embedding, b.seed.embedding) >= CLUSTER_THRESHOLD) {
        b.members.push(row);
        assigned = true;
        break;
      }
    }
    if (!assigned) buckets.push({ seed: row, members: [row] });
  }

  const newClusters = buckets.filter((b) => b.members.length >= MIN_CLUSTER_SIZE);

  // Pull existing clusters for this pillar so we can re-use ids.
  const existing = await pool.query<{ id: number; embedding: string }>(
    `SELECT id, representative_embedding::text AS embedding
       FROM query_clusters
      WHERE pillar_id = $1
        -- Same rationale as the agent_queries filter above: do not
        -- reuse cluster ids whose representative vector lives in a
        -- different embedding space than the one we're clustering in.
        AND embedding_model = $2`,
    [pillarId, EMBEDDING_MODEL],
  );
  const existingClusters: ExistingCluster[] = existing.rows.map((r) => ({
    id: r.id,
    embedding: parseHalfvec(r.embedding),
  }));
  const usedExistingIds = new Set<number>();

  // Reset cluster_id for this pillar's recent uncovered rows; we'll
  // re-assign below. Outside the window stays untouched.
  await pool.query(
    `UPDATE agent_queries
        SET cluster_id = NULL
      WHERE was_uncovered = TRUE
        AND $1 = ANY(pillar_ids)
        AND created_at >= NOW() - INTERVAL '${WINDOW_DAYS} days'`,
    [pillarId],
  );

  for (const b of newClusters) {
    // Find best matching existing cluster id (idempotency).
    let reuseId: number | null = null;
    let bestSim = REUSE_THRESHOLD;
    for (const e of existingClusters) {
      if (usedExistingIds.has(e.id)) continue;
      const sim = cosineSim(b.seed.embedding, e.embedding);
      if (sim >= bestSim) {
        bestSim = sim;
        reuseId = e.id;
      }
    }

    const lit = toVectorLiteral(b.seed.embedding);
    let clusterId: number;
    if (reuseId != null) {
      usedExistingIds.add(reuseId);
      await pool.query(
        `UPDATE query_clusters
            SET representative_question = $1,
                representative_embedding = $2::halfvec(${EMBEDDING_DIMENSIONS}),
                embedding_model = $5,
                size = $3,
                last_updated = NOW()
          WHERE id = $4`,
        [b.seed.question, lit, b.members.length, reuseId, EMBEDDING_MODEL],
      );
      clusterId = reuseId;
    } else {
      const ins = await pool.query<{ id: number }>(
        `INSERT INTO query_clusters
            (pillar_id, representative_question, representative_embedding,
             embedding_model, size)
          VALUES ($1, $2, $3::halfvec(${EMBEDDING_DIMENSIONS}), $5, $4)
          RETURNING id`,
        [pillarId, b.seed.question, lit, b.members.length, EMBEDDING_MODEL],
      );
      clusterId = ins.rows[0].id;
    }

    const memberIds = b.members.map((m) => m.id);
    await pool.query(
      `UPDATE agent_queries SET cluster_id = $1 WHERE id = ANY($2::uuid[])`,
      [clusterId, memberIds],
    );
  }

  // Drop stale clusters that no longer attracted any current members
  // (their old members fell out of the window).
  await pool.query(
    `DELETE FROM query_clusters
       WHERE pillar_id = $1
         AND last_updated < NOW() - INTERVAL '${WINDOW_DAYS * 2} days'`,
    [pillarId],
  );
}

export async function runQueryClustering(): Promise<void> {
  const pillars = await pool.query<{ id: number }>(`SELECT id FROM pillars`);
  for (const p of pillars.rows) {
    try {
      await clusterPillar(p.id);
    } catch (e) {
      logger.error({ err: e, pillarId: p.id }, "clusterPillar failed");
    }
  }
}
