import pool from "../lib/db";
import {
  embedTexts,
  toVectorLiteral,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
} from "../lib/embeddings";
import { logger } from "../lib/logger";

/**
 * One-shot dev backfill: re-embed every stored chunk with the in-house model so
 * the corpus lives entirely in the gte-small vector space. Idempotent — re-running
 * simply recomputes the same vectors. Stamps `embedding_model` so the partial
 * HNSW indexes (which key on it) pick the rows up. Production re-embedding is
 * handled the same way after the Publish migration; this script targets the dev DB
 * via DATABASE_URL.
 */

type ChunkRow = { id: string; text: string };

async function reembedTable(table: "source_chunks" | "interpretation_chunks"): Promise<number> {
  const query =
    table === "source_chunks"
      ? `SELECT sc.id, sc.text
           FROM source_chunks sc
           JOIN sources s ON s.id = sc.source_id
          WHERE sc.text IS NOT NULL AND length(trim(sc.text)) > 0
            AND s.rights_basis IS NOT NULL
            AND s.retention_status IN ('review_window', 'retained_with_rights')
          ORDER BY sc.id`
      : `SELECT id, text FROM interpretation_chunks
          WHERE text IS NOT NULL AND length(trim(text)) > 0 ORDER BY id`;
  const { rows } = await pool.query<ChunkRow>(
    query,
  );
  if (rows.length === 0) {
    logger.info({ table }, "No chunks to re-embed");
    return 0;
  }
  const vectors = await embedTexts(rows.map((r) => r.text));
  if (vectors.length !== rows.length) {
    throw new Error(`Embedding count mismatch for ${table}: got ${vectors.length} for ${rows.length} rows`);
  }
  let updated = 0;
  for (let i = 0; i < rows.length; i++) {
    const vec = vectors[i];
    if (vec.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`Unexpected dim ${vec.length} (want ${EMBEDDING_DIMENSIONS}) for ${table} id=${rows[i].id}`);
    }
    await pool.query(
      `UPDATE ${table}
         SET embedding = $1::halfvec(${EMBEDDING_DIMENSIONS}), embedding_model = $2
       WHERE id = $3`,
      [toVectorLiteral(vec), EMBEDDING_MODEL, rows[i].id],
    );
    updated++;
  }
  logger.info({ table, updated }, "Re-embedded table");
  return updated;
}

async function main(): Promise<void> {
  logger.info({ model: EMBEDDING_MODEL, dims: EMBEDDING_DIMENSIONS }, "Re-embedding corpus in-house");
  const source = await reembedTable("source_chunks");
  const interpretation = await reembedTable("interpretation_chunks");
  logger.info({ source, interpretation, total: source + interpretation }, "Re-embed complete");
  await pool.end();
}

main().catch((err) => {
  logger.error({ err }, "Re-embed failed");
  process.exitCode = 1;
  void pool.end();
});
