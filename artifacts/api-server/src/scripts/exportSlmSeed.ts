import fs from "node:fs";
import path from "node:path";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import {
  db,
  pillarsTable,
  sourcesTable,
  sourceChunksTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import pool from "../lib/db";

/**
 * One-shot exporter: dump the approved Stanford Lifestyle Medicine newsletter
 * corpus (sources + chunk TEXTS, no embeddings, no full_text) from the dev
 * database into `src/seeds/slm-articles.json`, the data file consumed by the
 * boot-time `seedSlmArticles` seed (src/lib/slmArticlesSeed.ts).
 *
 * Why texts only: embeddings are recomputed in-process at seed time by the
 * in-house model, so the JSON never goes stale when the embedding model
 * rotates; full_text is skipped because chunks ship directly (the operator
 * `--rechunk` path stays a dev-only tool).
 *
 * Pillars are keyed by SLUG (not id) — production pillar ids differ from dev.
 *
 * Usage (from artifacts/api-server):
 *   node run-script.mjs exportSlmSeed
 */

const SLM_JOURNAL = "Stanford Lifestyle Medicine Newsletter";

const OUT_PATH = path.resolve(process.cwd(), "src/seeds/slm-articles.json");

interface ExportedArticle {
  pillarSlug: string;
  kind: string;
  title: string;
  authors: string | null;
  year: number | null;
  sourceUrl: string;
  chunks: string[];
}

async function main(): Promise<void> {
  const rows = await db
    .select({
      id: sourcesTable.id,
      pillarSlug: pillarsTable.slug,
      kind: sourcesTable.kind,
      title: sourcesTable.title,
      authors: sourcesTable.authors,
      year: sourcesTable.year,
      sourceUrl: sourcesTable.sourceUrl,
    })
    .from(sourcesTable)
    .innerJoin(pillarsTable, eq(pillarsTable.id, sourcesTable.pillarId))
    .where(
      and(
        eq(sourcesTable.journal, SLM_JOURNAL),
        eq(sourcesTable.status, "approved"),
        eq(sourcesTable.isCanary, false),
        isNotNull(sourcesTable.rightsBasis),
        inArray(sourcesTable.retentionStatus, [
          "review_window",
          "retained_with_rights",
        ]),
      ),
    )
    .orderBy(asc(sourcesTable.id));

  const articles: ExportedArticle[] = [];
  let skippedNoUrl = 0;
  let skippedNotApproved = 0;
  let totalChunks = 0;

  for (const row of rows) {
    if (!row.sourceUrl) {
      skippedNoUrl++;
      continue;
    }
    const chunkRows = await db
      .select({ text: sourceChunksTable.text })
      .from(sourceChunksTable)
      .where(eq(sourceChunksTable.sourceId, row.id))
      .orderBy(asc(sourceChunksTable.chunkIndex));
    const chunks = chunkRows.map((c) => c.text);
    if (chunks.length === 0) {
      logger.warn({ id: row.id, title: row.title }, "Source has no chunks — exported without chunks");
    }
    totalChunks += chunks.length;
    articles.push({
      pillarSlug: row.pillarSlug,
      kind: row.kind,
      title: row.title,
      authors: row.authors,
      year: row.year,
      sourceUrl: row.sourceUrl,
      chunks,
    });
  }

  const payload = {
    journal: SLM_JOURNAL,
    exportedAt: new Date().toISOString(),
    articles,
  };
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload));

  logger.info(
    {
      outPath: OUT_PATH,
      articles: articles.length,
      totalChunks,
      skippedNoUrl,
      skippedNotApproved,
      bytes: fs.statSync(OUT_PATH).size,
    },
    "SLM seed export complete",
  );
}

main()
  .then(() => pool.end())
  .catch((err) => {
    logger.error({ err }, "exportSlmSeed failed");
    process.exitCode = 1;
    return pool.end();
  });
