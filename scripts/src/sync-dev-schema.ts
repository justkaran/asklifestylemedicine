/**
 * Additive, non-interactive dev-database schema sync (CLI wrapper).
 *
 *   pnpm --filter @workspace/scripts run sync-dev-schema
 *   pnpm --filter @workspace/scripts run sync-dev-schema -- --dry-run
 *
 * Thin wrapper around `syncSchemaAdditive` (in @workspace/db) — the same engine
 * the api-server test bootstrap uses. It corrects dev-DB drift after merges by
 * applying ONLY additive changes (CREATE TYPE/TABLE/INDEX, ADD COLUMN, ADD
 * VALUE); it never drops anything and never prompts, so legacy objects survive
 * and post-merge can't stall. Idempotent: a no-op once dev is in sync.
 *
 * See the header of lib/db/src/sync-schema.ts for why `drizzle-kit push` can't
 * be used here.
 */
import { pool } from "@workspace/db";
import { syncSchemaAdditive } from "@workspace/db/sync-schema";

const DRY_RUN = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  const { applied, skipped, warnings } = await syncSchemaAdditive(pool, {
    dryRun: DRY_RUN,
    log: (l) => console.log(l),
  });

  console.log(`\nApplied (${applied.length}):`);
  for (const a of applied) console.log(`  + ${a}`);
  if (applied.length === 0) console.log("  (nothing — dev DB already in sync)");
  if (skipped.length) {
    console.log(`\nSkipped (${skipped.length}):`);
    for (const s of skipped) console.log(`  · ${s}`);
  }
  if (warnings.length) {
    console.log(`\nWarnings (${warnings.length}):`);
    for (const w of warnings) console.log(`  ! ${w}`);
  }
  console.log("\nDev schema sync complete.");
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
