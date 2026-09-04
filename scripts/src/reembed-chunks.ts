/**
 * Heal a dev database that predates the in-house gte-small embedding migration.
 *
 *   pnpm --filter @workspace/scripts run reembed-chunks
 *   pnpm --filter @workspace/scripts run reembed-chunks -- --dry-run
 *
 * Older dev DBs pin every halfvec column to a fixed-width `halfvec(3072)` and
 * hold vectors from the retired OpenAI `text-embedding-3-large` model. The schema
 * now declares those columns as DIMENSIONLESS `halfvec` and the runtime embeds
 * in-process with gte-small (384-d). Until the dev DB is healed, any 384-d insert
 * or update throws on the fixed width — which is why `frameworks.test.ts` skips
 * its grounded-success assertion and why the captureLoop / draftInterpretation /
 * governedRagCovered suites 500 on the query-side embedding columns.
 *
 * This rotation updates every persisted embedding space (corpus, query,
 * cluster, and immutable knowledge-version snapshots) before traffic is
 * switched by setting EMBEDDING_PROVIDER=openai.
 *   - CORPUS  (source_chunks.embedding, interpretation_chunks.embedding) — these
 *     must be retrievable, so they are widened AND re-embedded to gte-small.
 *   - QUERY / CLUSTER / VERSION snapshots are re-embedded too, so analytics,
 *     clustering, and published-version retrieval are already in the target
 *     space at cutover.
 *
 * Steps per column, non-destructively:
 *   1. ALTER the column to dimensionless `halfvec` (widen, preserves rows).
 *   2. (corpus only) Re-embed in-process with gte-small (384-d), stamping
 *      `embedding_model = 'Xenova/gte-small'`.
 *   3. Rebuild the partial expression HNSW index (cast to 384, scoped to the
 *      current model) so retrieval over the new space is correct.
 *
 * Idempotent: rows already on the current model are skipped, the ALTERs are
 * no-ops once dimensionless, and the indexes are dropped-and-recreated to match
 * the schema. Safe to run repeatedly.
 */
import { pool } from "@workspace/db";
import {
  embedTexts,
  toVectorLiteral,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
} from "./embeddings.js";

const DRY_RUN = process.argv.includes("--dry-run");

interface EmbeddingColumn {
  table: string;
  column: string;
  textColumn: string;
  /** Partial expression HNSW index name, or null when the schema has none. */
  hnswIndex: string | null;
}

const COLUMNS: EmbeddingColumn[] = [
  {
    table: "source_chunks",
    column: "embedding",
    textColumn: "text",
    hnswIndex: "source_chunks_embedding_hnsw_idx",
  },
  {
    table: "interpretation_chunks",
    column: "embedding",
    textColumn: "text",
    hnswIndex: "interpretation_chunks_embedding_hnsw_idx",
  },
  {
    table: "agent_queries",
    column: "question_embedding",
    textColumn: "question",
    hnswIndex: "agent_queries_embedding_hnsw_idx",
  },
  {
    table: "query_clusters",
    column: "representative_embedding",
    textColumn: "representative_question",
    hnswIndex: null,
  },
  {
    table: "knowledge_version_chunks",
    column: "embedding",
    textColumn: "text",
    hnswIndex: "knowledge_version_chunks_embedding_hnsw_idx",
  },
];

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [name],
  );
  return Boolean(rows[0]?.exists);
}

/** Current declared dimension of the column, or null if dimensionless. */
async function embeddingDimension(
  table: string,
  column: string,
): Promise<number | null> {
  const { rows } = await pool.query<{ atttypmod: number }>(
    `SELECT a.atttypmod
       FROM pg_attribute a
      WHERE a.attrelid = $1::regclass
        AND a.attname = $2`,
    [table, column],
  );
  const mod = rows[0]?.atttypmod ?? -1;
  // For halfvec, atttypmod is the dimension (or -1 when dimensionless).
  return mod > 0 ? mod : null;
}

/** Widen a fixed-width halfvec column to dimensionless, preserving rows. */
async function makeDimensionless(table: string, column: string): Promise<void> {
  const dim = await embeddingDimension(table, column);
  if (dim === null) {
    console.log(`  ${table}.${column} already dimensionless — skip ALTER`);
    return;
  }
  if (DRY_RUN) {
    console.log(
      `  [dry-run] would ALTER ${table}.${column} halfvec(${dim}) → halfvec`,
    );
    return;
  }
  await pool.query(
    `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE halfvec`,
  );
  console.log(`  ${table}.${column}: halfvec(${dim}) → dimensionless halfvec`);
}

/** Re-embed every row not already on the current model (corpus columns only). */
async function reembed(table: string, column: string, textColumn: string): Promise<number> {
  const { rows } = await pool.query<{ id: number; text: string }>(
    `SELECT id, ${textColumn} AS text FROM ${table}
      WHERE embedding_model IS DISTINCT FROM $1`,
    [EMBEDDING_MODEL],
  );
  if (rows.length === 0) {
    console.log(`  ${table}: already on ${EMBEDDING_MODEL} (0 rows)`);
    return 0;
  }
  if (DRY_RUN) {
    console.log(`  [dry-run] would re-embed ${rows.length} ${table} rows`);
    return rows.length;
  }

  const BATCH = 32;
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const vectors = await embedTexts(batch.map((r) => r.text));
    for (let j = 0; j < batch.length; j++) {
      const lit = toVectorLiteral(vectors[j]);
      await pool.query(
        `UPDATE ${table}
            SET ${column} = $1::halfvec(${EMBEDDING_DIMENSIONS}),
                embedding_model = $2
          WHERE id = $3`,
        [lit, EMBEDDING_MODEL, batch[j].id],
      );
    }
    done += batch.length;
    console.log(`  ${table}: re-embedded ${done}/${rows.length}`);
  }
  return done;
}

/** Drop an embedding HNSW index. Must run BEFORE re-embedding / widening: a
 * legacy non-partial index built over the old (3072-d) vectors rejects a 384-d
 * UPDATE with "different halfvec dimensions". */
async function dropIndex(indexName: string): Promise<void> {
  if (DRY_RUN) {
    console.log(`  [dry-run] would drop ${indexName}`);
    return;
  }
  await pool.query(`DROP INDEX IF EXISTS ${indexName}`);
  console.log(`  ${indexName}: dropped`);
}

/** Create the partial expression HNSW index to match the schema. Runs AFTER
 * re-embedding so it indexes only current-model 384-d vectors. */
async function createIndex(
  table: string,
  column: string,
  indexName: string,
): Promise<void> {
  if (DRY_RUN) {
    console.log(`  [dry-run] would create ${indexName}`);
    return;
  }
  await pool.query(
    `CREATE INDEX ${indexName} ON ${table}
       USING hnsw ((${column}::halfvec(${EMBEDDING_DIMENSIONS})) halfvec_cosine_ops)
       WHERE embedding_model = '${EMBEDDING_MODEL}'`,
  );
  console.log(
    `  ${indexName}: created (partial, ${EMBEDDING_DIMENSIONS}-d, ${EMBEDDING_MODEL})`,
  );
}

async function main(): Promise<void> {
  console.log(
    `Re-embed chunks → ${EMBEDDING_MODEL} (${EMBEDDING_DIMENSIONS}-d)${DRY_RUN ? " [dry run]" : ""}`,
  );

  for (const { table, column, textColumn, hnswIndex } of COLUMNS) {
    if (!(await tableExists(table))) {
      console.log(`  ${table} not present yet — skip`);
      continue;
    }
    console.log(`\n${table}.${column}:`);
    if (hnswIndex) await dropIndex(hnswIndex);
    await makeDimensionless(table, column);
    await reembed(table, column, textColumn);
    if (hnswIndex) await createIndex(table, column, hnswIndex);
  }

  console.log("\nDone.");
  await pool.end();
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  try {
    await pool.end();
  } catch {
    // ignore
  }
  process.exit(1);
});
