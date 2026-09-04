/**
 * One-off import: local markdown files (Michael Fredericson materials) into
 * the `movement` pillar as DRAFT sources awaiting steward approval.
 *
 * Usage (from artifacts/api-server):
 *   node run-script.mjs ingestFredericsonMd -- --dir=../../attached_assets --match=1786390591
 */
import fs from "node:fs";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  pillarsTable,
  sourcesTable,
  facultyUsersTable,
  type SourceRightsBasis,
} from "@workspace/db";
import { ingestSource } from "../lib/ingestSource.js";
import { logger } from "../lib/logger.js";

const CUSTODIAN_EMAIL = "custodian@palonur.com";

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : null;
}

const RIGHTS_BASIS_VALUES = new Set<SourceRightsBasis>([
  "open_license",
  "permission",
  "public_domain",
  "no_documented_full_text_rights",
]);

interface Frontmatter {
  [key: string]: string;
}

function parseFrontmatter(raw: string): { fm: Frontmatter; body: string } {
  const fm: Frontmatter = {};
  if (!raw.startsWith("---")) return { fm, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { fm, body: raw };
  const header = raw.slice(3, end);
  const body = raw.slice(end + 4).trim();
  for (const line of header.split("\n")) {
    const m = line.match(/^([A-Za-z_]+):\s*"?(.*?)"?\s*$/);
    if (m) fm[m[1]] = m[2];
  }
  return { fm, body };
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
  return created.id;
}

async function main() {
  const dir = arg("dir") ?? "../../attached_assets";
  const match = arg("match") ?? "";
  const rightsBasis = arg("rights-basis") as SourceRightsBasis | null;
  if (!rightsBasis || !RIGHTS_BASIS_VALUES.has(rightsBasis)) {
    throw new Error(
      "Pass --rights-basis=open_license|permission|public_domain|no_documented_full_text_rights before importing source text.",
    );
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md") && (!match || f.includes(match)))
    .sort();
  if (files.length === 0) throw new Error(`No matching .md files in ${dir}`);

  const [pillar] = await db
    .select({ id: pillarsTable.id })
    .from(pillarsTable)
    .where(and(eq(pillarsTable.slug, "movement"), isNull(pillarsTable.retiredAt)))
    .limit(1);
  if (!pillar) throw new Error("Active 'movement' pillar not found");

  const uploaderId = await ensureUploader();

  let ingested = 0;
  let skipped = 0;
  for (const file of files) {
    const raw = fs.readFileSync(path.join(dir, file), "utf8");
    const { fm, body } = parseFrontmatter(raw);
    const title = fm.title || file.replace(/_\d+\.md$/, "").replace(/-/g, " ");
    const sourceUrl = fm.url || null;
    const yearMatch = (fm.date || "").match(/\d{4}/);
    const year = yearMatch ? Number(yearMatch[0]) : null;

    // Idempotency: skip if a source with this title already exists on the pillar.
    const [existing] = await db
      .select({ id: sourcesTable.id })
      .from(sourcesTable)
      .where(and(eq(sourcesTable.pillarId, pillar.id), eq(sourcesTable.title, title.slice(0, 1000))))
      .limit(1);
    if (existing) {
      logger.info({ file, title }, "Already ingested — skipping");
      skipped++;
      continue;
    }

    const result = await ingestSource({
      pillarId: pillar.id,
      uploadedByUserId: uploaderId,
      meta: {
        kind: "note",
        title,
        authors: "Michael Fredericson",
        year,
        journal: fm.publisher || null,
        sourceUrl,
        rightsBasis,
      },
      fullText: body,
      fallbackTitle: title,
    });
    logger.info(
      { file, title, sourceId: result.source.id, chunks: result.chunkCount },
      "Ingested as draft",
    );
    ingested++;
  }
  logger.info({ ingested, skipped, total: files.length }, "Done");
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "ingestFredericsonMd failed");
  process.exit(1);
});
