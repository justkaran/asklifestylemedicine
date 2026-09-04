/**
 * Backfill every legacy newsletter subscriber + issue onto the single "house"
 * publication (the original Stanford Lifestyle Medicine newsletter).
 *
 *   pnpm --filter @workspace/scripts run backfill-publications
 *   pnpm --filter @workspace/scripts run backfill-publications -- --dry-run
 *
 * Idempotent:
 *   - The house publication is found-or-created by `is_house = true`.
 *   - Only rows with a NULL publication_id are touched, so a second run is a
 *     no-op (0 rows updated).
 *
 * Safe to run before the schema migration has been applied: if the
 * newsletter_publications table or the publication_id columns don't yet exist
 * (e.g. a fresh checkout where dev `push` hasn't run), the script logs and
 * exits cleanly so the post-merge setup stays green.
 */
import { db, pool, newsletterPublicationsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

const DRY_RUN = process.argv.includes("--dry-run");

const HOUSE_SLUG = "stanford-lifestyle-medicine";
const HOUSE_NAME = "Stanford Lifestyle Medicine";

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [name],
  );
  return Boolean(rows[0]?.exists);
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_name = $1 AND column_name = $2
     ) AS exists`,
    [table, column],
  );
  return Boolean(rows[0]?.exists);
}

async function ensureHousePublication(): Promise<number> {
  const existing = await db
    .select({ id: newsletterPublicationsTable.id })
    .from(newsletterPublicationsTable)
    .where(eq(newsletterPublicationsTable.isHouse, true))
    .limit(1);
  if (existing[0]) return existing[0].id;

  if (DRY_RUN) {
    console.log("  [dry-run] would create the house publication");
    return -1;
  }
  const [row] = await db
    .insert(newsletterPublicationsTable)
    .values({
      isHouse: true,
      facultyUserId: null,
      name: HOUSE_NAME,
      slug: HOUSE_SLUG,
      bylineName: HOUSE_NAME,
      bylineInstitution: "Stanford University",
      tagline: "Evidence-based lifestyle medicine from Stanford.",
    })
    .returning({ id: newsletterPublicationsTable.id });
  console.log(`  created house publication #${row.id}`);
  return row.id;
}

async function backfillColumn(
  table: string,
  publicationId: number,
): Promise<number> {
  if (!(await columnExists(table, "publication_id"))) {
    console.log(`  skip ${table}: publication_id column not present yet`);
    return 0;
  }
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM ${table} WHERE publication_id IS NULL`,
  );
  if (rows.length === 0) {
    console.log(`  ${table}: already backfilled (0 rows)`);
    return 0;
  }
  if (DRY_RUN) {
    console.log(`  [dry-run] would set ${rows.length} ${table} rows → house`);
    return rows.length;
  }
  await db.execute(
    sql.raw(
      `UPDATE ${table} SET publication_id = ${publicationId} WHERE publication_id IS NULL`,
    ),
  );
  console.log(`  ${table}: backfilled ${rows.length} rows → house`);
  return rows.length;
}

async function main() {
  if (!(await tableExists("newsletter_publications"))) {
    console.log(
      "newsletter_publications table not present yet — skipping backfill.",
    );
    process.exit(0);
  }

  const houseId = await ensureHousePublication();
  if (houseId === -1) {
    // dry-run with no existing house; nothing concrete to point rows at.
    await backfillColumn("newsletter_subscribers", houseId);
    await backfillColumn("newsletter_issues", houseId);
    console.log("Dry run complete.");
    process.exit(0);
  }

  const subs = await backfillColumn("newsletter_subscribers", houseId);
  const issues = await backfillColumn("newsletter_issues", houseId);
  console.log(
    `Done. House publication #${houseId}; ${subs} subscribers + ${issues} issues backfilled.`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
