import slmSeedJson from "../seeds/slm-articles.json";
import { and, asc, eq, isNull, inArray, sql } from "drizzle-orm";
import {
  db,
  pillarsTable,
  sourceAuditLogTable,
  sourcesTable,
  sourceChunksTable,
} from "@workspace/db";
import {
  embedTexts,
  toVectorLiteral,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
} from "./embeddings";
import { logger } from "./logger";

/** Explicit operational decision for the curated SLM archive only. Other
 * articles must bring their own recorded decision at ingestion time. */
export const SLM_ARCHIVE_RIGHTS_BASIS = "permission" as const;

/**
 * Best-effort, idempotent boot seed for the Stanford Lifestyle Medicine
 * newsletter corpus (181 approved `slm_article` sources across the six
 * lifestyle-medicine pillars).
 *
 * Why: publishing migrates schema, not row data. The SLM archive was bulk
 * imported into the DEV database by the one-shot `ingestSlmArticles` operator
 * script, so a fresh production database has the pillars but none of their
 * content — every non-sleep home-hero question falls below the retrieval
 * threshold and the agent answers with a boundary line instead of grounded
 * material. This seed ships the corpus (chunk TEXTS in
 * `src/seeds/slm-articles.json`, inlined into the bundle) and re-embeds it
 * in-process with the in-house model at boot, so prod self-heals using the same idempotent seed process.
 *
 * Safety rules:
 * - INSERT-ONLY. An existing (pillar_id, source_url) row is never updated —
 *   not its status, not its text. A later steward edit is never reverted.
 * - An existing row with ZERO chunks is healed from the JSON chunk texts
 *   (covers a boot killed between source insert and chunk insert).
 * - Pillars are resolved by SLUG at boot (prod ids differ from dev); a
 *   missing/retired pillar skips its articles rather than throwing.
 * - Embeddings are produced entirely in-house — no third-party key needed.
 *   Callers run this post-listen fire-and-forget so embedding latency
 *   (~1–2 min cold) can never block boot or a deploy health check.
 *
 * Not yet hardened: concurrent first-boot across multiple instances could
 * race on source insertion. Fine for the current single-instance deploy.
 */

export interface SlmSeedArticle {
  pillarSlug: string;
  kind: string;
  title: string;
  authors: string | null;
  year: number | null;
  sourceUrl: string;
  chunks: string[];
}

export interface SlmSeedData {
  journal: string;
  articles: SlmSeedArticle[];
}

export interface SlmSeedResult {
  inserted: number;
  healed: number;
  skippedExisting: number;
  skippedPillarMissing: number;
  failed: number;
  missingSlugs: string[];
}

function loadSeedData(): SlmSeedData {
  // Static import so esbuild inlines the 1.6MB JSON into the production
  // bundle (a createRequire() runtime require is NOT bundled and 404s from
  // dist/). The wildcard d.ts in src/types/ keeps it `unknown` to tsc, so the
  // JSON stays out of the type graph.
  return slmSeedJson as SlmSeedData;
}

async function insertChunks(
  sourceId: number,
  chunks: string[],
  embed: (texts: string[]) => Promise<number[][]>,
): Promise<void> {
  if (chunks.length === 0) return;
  const embeddings = await embed(chunks);
  await db.transaction(async (tx) => {
    for (let i = 0; i < chunks.length; i++) {
      const lit = toVectorLiteral(embeddings[i]);
      await tx.execute(sql`
        INSERT INTO source_chunks
          (source_id, chunk_index, text, embedding, embedding_model)
        VALUES (
          ${sourceId}, ${i}, ${chunks[i]},
          ${lit}::halfvec(${sql.raw(String(EMBEDDING_DIMENSIONS))}),
          ${EMBEDDING_MODEL}
        )
      `);
    }
  });
}

export async function seedSlmArticles(opts?: {
  data?: SlmSeedData;
  embed?: (texts: string[]) => Promise<number[][]>;
}): Promise<SlmSeedResult> {
  const data = opts?.data ?? loadSeedData();
  const embed = opts?.embed ?? embedTexts;

  const result: SlmSeedResult = {
    inserted: 0,
    healed: 0,
    skippedExisting: 0,
    skippedPillarMissing: 0,
    failed: 0,
    missingSlugs: [],
  };

  const slugs = [...new Set(data.articles.map((a) => a.pillarSlug))];
  const pillars = await db
    .select({ id: pillarsTable.id, slug: pillarsTable.slug })
    .from(pillarsTable)
    .where(
      and(inArray(pillarsTable.slug, slugs), isNull(pillarsTable.retiredAt)),
    );
  const pillarBySlug = new Map(pillars.map((p) => [p.slug, p.id]));
  result.missingSlugs = slugs.filter((s) => !pillarBySlug.has(s));

  for (const article of data.articles) {
    const pillarId = pillarBySlug.get(article.pillarSlug);
    if (pillarId == null) {
      result.skippedPillarMissing++;
      continue;
    }

    // One dropped DB connection (e.g. Neon terminating backends with 57P01
    // while a slow embedding batch left the pool idle) must not abort the
    // whole seed run: retry the article once on a fresh connection, and if
    // it still fails, count it and move on. The next boot heals leftovers —
    // the source/chunk writes are idempotent (INSERT-only + chunk-heal).
    try {
      await seedOneArticle(article, pillarId, data.journal, embed, result);
    } catch (firstErr) {
      logger.warn(
        { err: firstErr, title: article.title, pillar: article.pillarSlug },
        "SLM seed: article failed, retrying once",
      );
      await new Promise((r) => setTimeout(r, 2000));
      try {
        await seedOneArticle(article, pillarId, data.journal, embed, result);
      } catch (retryErr) {
        result.failed++;
        logger.error(
          { err: retryErr, title: article.title, pillar: article.pillarSlug },
          "SLM seed: article failed after retry; continuing with the rest",
        );
      }
    }
  }

  return result;
}

async function seedOneArticle(
  article: SlmSeedArticle,
  pillarId: number,
  journal: string,
  embed: (texts: string[]) => Promise<number[][]>,
  result: SlmSeedResult,
): Promise<void> {
  const [existing] = await db
    .select({ id: sourcesTable.id })
    .from(sourcesTable)
    .where(
      and(
        eq(sourcesTable.pillarId, pillarId),
        eq(sourcesTable.sourceUrl, article.sourceUrl),
      ),
    )
    .limit(1);

  if (existing) {
    const [existingSource] = await db
      .select({
        rightsBasis: sourcesTable.rightsBasis,
        retentionStatus: sourcesTable.retentionStatus,
      })
      .from(sourcesTable)
      .where(eq(sourcesTable.id, existing.id))
      .limit(1);
    // A boot seed must never restore raw chunks to an unknown legacy row or a
    // purged review-only row. A steward can record documented rights through
    // the library before a future seed run is allowed to heal it.
    if (
      existingSource?.rightsBasis !== SLM_ARCHIVE_RIGHTS_BASIS ||
      existingSource.retentionStatus !== "retained_with_rights"
    ) {
      result.skippedExisting++;
      return;
    }
    const [chunkRow] = await db
      .select({ id: sourceChunksTable.id })
      .from(sourceChunksTable)
      .where(eq(sourceChunksTable.sourceId, existing.id))
      .orderBy(asc(sourceChunksTable.id))
      .limit(1);
    if (chunkRow) {
      result.skippedExisting++;
      return;
    }
    // Interrupted earlier run: source row exists but chunks never landed.
    // Heal chunks only — never touch the row's status or text.
    await insertChunks(existing.id, article.chunks, embed);
    result.healed++;
    logger.info(
      {
        title: article.title,
        pillar: article.pillarSlug,
        chunks: article.chunks.length,
      },
      "SLM seed: healed chunkless source",
    );
    return;
  }

  const embeddings = await embed(article.chunks);
  await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(sourcesTable)
      .values({
        pillarId,
        kind: article.kind as (typeof sourcesTable.$inferInsert)["kind"],
        title: article.title,
        authors: article.authors,
        year: article.year,
        journal,
        sourceUrl: article.sourceUrl,
        status: "approved",
        rightsBasis: SLM_ARCHIVE_RIGHTS_BASIS,
        retentionStatus: "retained_with_rights",
        rightsRecordedAt: new Date(),
      })
      .returning({ id: sourcesTable.id });
    for (let i = 0; i < article.chunks.length; i++) {
      const lit = toVectorLiteral(embeddings[i]);
      await tx.execute(sql`
        INSERT INTO source_chunks
          (source_id, chunk_index, text, embedding, embedding_model)
        VALUES (
          ${inserted.id}, ${i}, ${article.chunks[i]},
          ${lit}::halfvec(${sql.raw(String(EMBEDDING_DIMENSIONS))}),
          ${EMBEDDING_MODEL}
        )
      `);
    }
    await tx.insert(sourceAuditLogTable).values([
      {
        sourceId: inserted.id,
        actorUserId: null,
        action: "rights_recorded",
        note: `Rights basis recorded by curated SLM seed: ${SLM_ARCHIVE_RIGHTS_BASIS}; retention: retained_with_rights.`,
      },
      {
        sourceId: inserted.id,
        actorUserId: null,
        action: "approved",
        toStatus: "approved",
        note: "Curated SLM archive seed: operator-approved source.",
      },
    ]);
  });
  result.inserted++;
  logger.info(
    {
      title: article.title,
      pillar: article.pillarSlug,
      chunks: article.chunks.length,
    },
    `SLM seed: inserted approved article (${result.inserted})`,
  );
}

/** Boot wrapper: logs the summary, never throws (callers still .catch). */
export async function seedSlmArticlesAtBoot(): Promise<void> {
  const result = await seedSlmArticles();
  if (result.failed > 0) {
    logger.warn(
      { result },
      "SLM articles content seed finished with failures; next boot will heal",
    );
    return;
  }
  logger.info({ result }, "SLM articles content seed finished");
}
