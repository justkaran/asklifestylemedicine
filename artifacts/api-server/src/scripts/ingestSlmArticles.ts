import { createRequire } from "node:module";
import path from "node:path";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  pillarsTable,
  sourcesTable,
  sourceChunksTable,
  sourceAuditLogTable,
  facultyUsersTable,
} from "@workspace/db";
import { ingestSource } from "../lib/ingestSource";
import { chunkText } from "../lib/chunker";
import {
  embedTexts,
  toVectorLiteral,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
} from "../lib/embeddings";
import { scrapeMarkdown, isFirecrawlConfigured } from "../lib/firecrawl";
import { logger } from "../lib/logger";
import pool from "../lib/db";

/** The operator-approved SLM newsletter archive is the recorded policy for
 * this curated source list, not an inference based on article kind or URL. */
const SLM_ARCHIVE_RIGHTS_BASIS = "permission" as const;

/**
 * One-shot bulk import: download every Stanford Lifestyle Medicine newsletter
 * article listed in the operator-provided spreadsheet (URL embedded as the
 * title cell's hyperlink) via Firecrawl and ingest each one into the canonical
 * pillar(s) its category columns mark, as an APPROVED `slm_article` source.
 *
 * Approved-on-import is deliberate (operator decision): these are SLM's own
 * published newsletter articles, and the point of the import is that question
 * routing (routePillars / alsoCovered pointer cards) can guide visitors to the
 * right pillar — draft sources are invisible to retrieval. Each approval is
 * recorded in the normal source audit log, attributed to the custodian
 * account, so the provenance trail matches steward-approved sources.
 *
 * Idempotent: an article is skipped for a pillar when a source with the same
 * (pillar_id, source_url) already exists there, so re-running only fills gaps.
 *
 * Usage (from artifacts/api-server):
 *   node run-script.mjs ingestSlmArticles [-- --dry-run] [--limit=N] [--file=path.xlsx]
 */

const DEFAULT_XLSX = path.resolve(
  process.cwd(),
  "../../attached_assets/SLM_NEWSLETTER_ARTICLES_(2)_1784581664295.xlsx",
);

const CUSTODIAN_EMAIL = "custodian@palonur.com";

/** Spreadsheet category header → canonical pillar slug. The "Gratutude"
 * misspelling is verbatim from the sheet; the corrected spelling is included
 * defensively in case the sheet is ever fixed. */
const CATEGORY_TO_SLUG: Record<string, string> = {
  "Cognitive Enhancement": "cognitive-enhancement",
  "Gratutude & Purpose": "gratitude-purpose",
  "Gratitude & Purpose": "gratitude-purpose",
  "Healthful Nutrition": "nutrition",
  "Movement & Exercise": "movement",
  "Restorative Sleep": "sleep",
  "Social Engagement": "social-connection",
  "Stress Management": "stress-management",
};

interface ParsedArticle {
  rowIndex: number;
  title: string;
  url: string | null;
  authors: string | null;
  year: number | null;
  pillarSlugs: string[];
  unmappedCategories: string[];
}

function excelSerialToYear(serial: unknown): number | null {
  if (typeof serial !== "number" || !Number.isFinite(serial)) return null;
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const year = new Date(ms).getUTCFullYear();
  return year >= 1990 && year <= 2100 ? year : null;
}

function parseArticles(xlsxPath: string): ParsedArticle[] {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const XLSX = require("xlsx") as typeof import("xlsx");
  const wb = XLSX.readFile(xlsxPath);
  const ws = wb.Sheets["SLM ARTICLES ALL TIME"] ?? wb.Sheets[wb.SheetNames[0]];
  if (!ws || !ws["!ref"]) throw new Error("Spreadsheet has no readable sheet");
  const range = XLSX.utils.decode_range(ws["!ref"]);

  const headers: string[] = [];
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
    headers.push(cell ? String(cell.v).trim() : "");
  }

  const articles: ParsedArticle[] = [];
  for (let r = 1; r <= range.e.r; r++) {
    const titleCell = ws[XLSX.utils.encode_cell({ r, c: 0 })];
    const title = titleCell ? String(titleCell.v ?? "").trim() : "";
    if (!title) continue;
    const url: string | null = titleCell?.l?.Target ?? null;
    const authorCell = ws[XLSX.utils.encode_cell({ r, c: 1 })];
    const authors = authorCell?.v ? String(authorCell.v).trim() : null;
    const year = excelSerialToYear(ws[XLSX.utils.encode_cell({ r, c: 2 })]?.v);

    const pillarSlugs: string[] = [];
    const unmappedCategories: string[] = [];
    for (let c = 3; c <= range.e.c; c++) {
      const marked = ws[XLSX.utils.encode_cell({ r, c })]?.v;
      if (!marked) continue;
      const header = headers[c];
      const slug = CATEGORY_TO_SLUG[header];
      if (slug) {
        if (!pillarSlugs.includes(slug)) pillarSlugs.push(slug);
      } else {
        unmappedCategories.push(header);
      }
    }
    articles.push({
      rowIndex: r + 1,
      title,
      url,
      authors,
      year,
      pillarSlugs,
      unmappedCategories,
    });
  }
  return articles;
}

/** Light markdown cleanup so chunks read as prose: drop images, unwrap links,
 * strip the site's boilerplate (related-article "Link to:" carousels, "Scroll
 * to top" widgets, empty-link remnants), collapse blank-line runs. Applied at
 * ingest time AND by `--rechunk` to already-stored full_text, so it must be
 * idempotent (cleaning cleaned text is a no-op). */
function cleanMarkdown(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[\]\([^)]*\)/g, "")
    .split("\n")
    .filter((line) => {
      if (line.includes("Link to:")) return false;
      const t = line.trim();
      if (/^(Scroll to top)+$/i.test(t)) return false;
      if (t === '")') return false;
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function ensureUploader(): Promise<number> {
  const [existing] = await db
    .select({ id: facultyUsersTable.id })
    .from(facultyUsersTable)
    .where(eq(facultyUsersTable.email, CUSTODIAN_EMAIL))
    .limit(1);
  if (existing) return existing.id;
  const [created] = await db
    .insert(facultyUsersTable)
    .values({
      clerkUserId: `pending:${CUSTODIAN_EMAIL}`,
      email: CUSTODIAN_EMAIL,
      fullName: "Palonur Custodian",
    })
    .returning({ id: facultyUsersTable.id });
  logger.info({ id: created.id }, "Bootstrapped custodian faculty account");
  return created.id;
}

async function scrapeWithRetry(url: string): Promise<string | null> {
  const first = await scrapeMarkdown(url);
  if (first) return first;
  await new Promise((resolve) => setTimeout(resolve, 3000));
  return scrapeMarkdown(url);
}

/**
 * `--rechunk`: re-apply cleanMarkdown to the stored full_text of every SLM
 * newsletter source and, where the text changes, rewrite full_text and
 * rebuild its chunks + embeddings in place — no re-scraping, no status or
 * audit changes. Restart-safe: already-clean sources are skipped, so a killed
 * run just resumes on the next invocation.
 */
async function rechunkExisting(): Promise<void> {
  const rows = await db
    .select({
      id: sourcesTable.id,
      title: sourcesTable.title,
      fullText: sourcesTable.fullText,
    })
    .from(sourcesTable)
    .where(
      and(
        eq(sourcesTable.journal, "Stanford Lifestyle Medicine Newsletter"),
        eq(sourcesTable.retentionStatus, "retained_with_rights"),
      ),
    )
    .orderBy(sourcesTable.id);

  let cleaned = 0;
  let unchanged = 0;
  for (const row of rows) {
    const next = cleanMarkdown(row.fullText ?? "");
    if (!next || next === row.fullText) {
      unchanged++;
      continue;
    }
    const chunks = chunkText(next);
    if (chunks.length === 0) {
      logger.warn({ id: row.id, title: row.title }, "Rechunk produced no chunks — skipping");
      unchanged++;
      continue;
    }
    const embeddings = await embedTexts(chunks);
    await db.transaction(async (tx) => {
      await tx
        .update(sourcesTable)
        .set({ fullText: next })
        .where(eq(sourcesTable.id, row.id));
      await tx
        .delete(sourceChunksTable)
        .where(eq(sourceChunksTable.sourceId, row.id));
      for (let i = 0; i < chunks.length; i++) {
        const lit = toVectorLiteral(embeddings[i]);
        await tx.execute(sql`
          INSERT INTO source_chunks
            (source_id, chunk_index, text, embedding, embedding_model)
          VALUES (
            ${row.id}, ${i}, ${chunks[i]},
            ${lit}::halfvec(${sql.raw(String(EMBEDDING_DIMENSIONS))}), ${EMBEDDING_MODEL}
          )
        `);
      }
    });
    cleaned++;
    logger.info(
      { id: row.id, title: row.title, chunks: chunks.length },
      `[rechunk ${cleaned}] cleaned + re-embedded`,
    );
  }
  logger.info({ cleaned, unchanged, total: rows.length }, "SLM rechunk complete");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--rechunk")) {
    await rechunkExisting();
    await pool.end();
    return;
  }
  const dryRun = args.includes("--dry-run");
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : Infinity;
  const fileArg = args.find((a) => a.startsWith("--file="));
  const xlsxPath = fileArg ? path.resolve(fileArg.split("=")[1]) : DEFAULT_XLSX;

  if (!dryRun && !isFirecrawlConfigured()) {
    throw new Error("FIRECRAWL_API_KEY is not set — cannot download articles");
  }

  const articles = parseArticles(xlsxPath);
  logger.info(
    { total: articles.length, xlsxPath, dryRun, limit },
    "Parsed SLM article spreadsheet",
  );

  const slugs = [...new Set(Object.values(CATEGORY_TO_SLUG))];
  const pillars = await db
    .select({ id: pillarsTable.id, slug: pillarsTable.slug })
    .from(pillarsTable)
    .where(and(inArray(pillarsTable.slug, slugs), isNull(pillarsTable.retiredAt)));
  const pillarBySlug = new Map(pillars.map((p) => [p.slug, p.id]));
  const missing = slugs.filter((s) => !pillarBySlug.has(s));
  if (missing.length > 0) {
    throw new Error(`Active pillars missing from DB: ${missing.join(", ")}`);
  }

  const uploaderId = dryRun ? -1 : await ensureUploader();

  const skippedNoUrl: string[] = [];
  const skippedNoCategory: string[] = [];
  const scrapeFailed: string[] = [];
  let ingested = 0;
  let approved = 0;
  let skippedExisting = 0;
  let processed = 0;

  for (const article of articles) {
    if (processed >= limit) break;
    if (article.unmappedCategories.some((c) => c !== "No Category")) {
      logger.warn(
        { title: article.title, categories: article.unmappedCategories },
        "Unmapped category column (ignored)",
      );
    }
    if (!article.url) {
      skippedNoUrl.push(article.title);
      continue;
    }
    if (article.pillarSlugs.length === 0) {
      skippedNoCategory.push(article.title);
      continue;
    }
    processed++;

    // Which target pillars still need this article? Status-aware: a row
    // stuck in `draft` (killed between ingest and approve on a previous run)
    // is finished off here instead of being skipped forever.
    const targets: Array<{ slug: string; pillarId: number }> = [];
    for (const slug of article.pillarSlugs) {
      const pillarId = pillarBySlug.get(slug)!;
      const [existing] = await db
        .select({
          id: sourcesTable.id,
          status: sourcesTable.status,
          rightsBasis: sourcesTable.rightsBasis,
        })
        .from(sourcesTable)
        .where(
          and(
            eq(sourcesTable.pillarId, pillarId),
            eq(sourcesTable.sourceUrl, article.url),
          ),
        )
        .limit(1);
      if (existing && existing.status !== "draft") {
        skippedExisting++;
      } else if (existing) {
        if (!dryRun) {
          await db.transaction(async (tx) => {
            await tx
              .update(sourcesTable)
              .set({
                status: "approved",
                rightsBasis: SLM_ARCHIVE_RIGHTS_BASIS,
                retentionStatus: "retained_with_rights",
                rightsRecordedByUserId: uploaderId,
                rightsRecordedAt: new Date(),
              })
              .where(eq(sourcesTable.id, existing.id));
            await tx.insert(sourceAuditLogTable).values({
              sourceId: existing.id,
              actorUserId: uploaderId,
              action: "rights_recorded",
              note: `Rights basis recorded by curated SLM import: ${SLM_ARCHIVE_RIGHTS_BASIS}; retention: retained_with_rights.`,
            });
            await tx.insert(sourceAuditLogTable).values({
              sourceId: existing.id,
              actorUserId: uploaderId,
              action: "status_change",
              fromStatus: "draft",
              toStatus: "approved",
              note: "Bulk import: Stanford Lifestyle Medicine newsletter archive (operator-approved, resumed after interrupted run)",
            });
          });
          approved++;
          logger.info(
            { title: article.title, pillar: slug, id: existing.id },
            "Approved orphan draft from an interrupted earlier run",
          );
        }
        skippedExisting++;
      } else {
        targets.push({ slug, pillarId });
      }
    }
    if (targets.length === 0) {
      logger.info(
        { title: article.title },
        `[${processed}/${Math.min(limit, articles.length)}] already ingested everywhere, skipping`,
      );
      continue;
    }

    if (dryRun) {
      logger.info(
        { title: article.title, pillars: targets.map((t) => t.slug) },
        `[dry-run ${processed}] would scrape + ingest`,
      );
      continue;
    }

    const markdown = await scrapeWithRetry(article.url);
    const text = markdown ? cleanMarkdown(markdown) : "";
    if (text.length < 400) {
      logger.warn(
        { title: article.title, url: article.url, chars: text.length },
        "Scrape failed or too short — skipping article",
      );
      scrapeFailed.push(article.title);
      continue;
    }

    for (const target of targets) {
      try {
        const result = await ingestSource({
          pillarId: target.pillarId,
          uploadedByUserId: uploaderId,
          meta: {
            kind: "slm_article",
            title: article.title,
            authors: article.authors,
            year: article.year,
            journal: "Stanford Lifestyle Medicine Newsletter",
            sourceUrl: article.url,
            rightsBasis: SLM_ARCHIVE_RIGHTS_BASIS,
          },
          fullText: text,
          fallbackTitle: article.title,
        });
        ingested++;

        await db.transaction(async (tx) => {
          await tx
            .update(sourcesTable)
            .set({ status: "approved" })
            .where(eq(sourcesTable.id, result.source.id));
          await tx.insert(sourceAuditLogTable).values({
            sourceId: result.source.id,
            actorUserId: uploaderId,
            action: "status_change",
            fromStatus: result.source.status,
            toStatus: "approved",
            note: "Bulk import: Stanford Lifestyle Medicine newsletter archive (operator-approved)",
          });
        });
        approved++;
        logger.info(
          {
            title: article.title,
            pillar: target.slug,
            chunks: result.chunkCount,
            chars: result.charCount,
          },
          `[${processed}] ingested + approved`,
        );
      } catch (err) {
        logger.error(
          { err, title: article.title, pillar: target.slug },
          "Ingest failed for pillar",
        );
        scrapeFailed.push(`${article.title} → ${target.slug}`);
      }
    }

    // Gentle pacing between articles to stay clear of Firecrawl rate limits.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  logger.info(
    {
      ingested,
      approved,
      skippedExisting,
      skippedNoUrl,
      skippedNoCategory,
      scrapeFailed,
    },
    "SLM article import complete",
  );
  await pool.end();
  if (ingested === 0 && skippedExisting === 0 && !dryRun) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  logger.error({ err }, "SLM article import failed");
  process.exit(1);
});
