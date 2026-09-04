/**
 * One-shot backfill: recover steward display names from a legacy
 * `faculty_users.name` column into the canonical `faculty_users.full_name`.
 *
 * Background: the public source-sheet (rendered by the sleep-agent route in
 * `artifacts/api-server/src/routes/sleep-agent.ts`) reads `full_name` for the
 * interpretation author/approver. Earlier deployments stored the steward's
 * display name in a legacy `name` column. After we standardized on
 * `full_name`, any row whose name lived only in the old column would render
 * with a blank author. This script copies `name` into `full_name` wherever
 * `full_name IS NULL` so no real steward gets dropped during the changeover.
 *
 * Behavior:
 * - If the legacy `name` column does not exist (fresh environments), the
 *   script logs and exits successfully — nothing to do.
 * - If it exists, runs a single UPDATE copying `name` into `full_name`
 *   wherever `full_name IS NULL` and `name` is non-empty.
 * - After the update (or if there was nothing to update), reports any
 *   `faculty_users` row tied to an approved interpretation that still has a
 *   null/empty `full_name` so we can spot-check.
 * - Idempotent: re-running after a successful copy finds 0 rows to update.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run recover-faculty-names
 *   pnpm --filter @workspace/scripts run recover-faculty-names -- --dry-run
 */

import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";

async function legacyNameColumnExists(): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'faculty_users'
      AND column_name = 'name'
    LIMIT 1
  `);
  return result.rows.length > 0;
}

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");

  const hasLegacy = await legacyNameColumnExists();
  if (!hasLegacy) {
    console.log(
      "Legacy faculty_users.name column not found. Nothing to recover.",
    );
    return;
  }

  const candidates = await db.execute(sql`
    SELECT id, email, name
    FROM faculty_users
    WHERE full_name IS NULL
      AND name IS NOT NULL
      AND length(trim(name)) > 0
  `);

  console.log(
    `Legacy column present. ${candidates.rows.length} row(s) need recovery.`,
  );
  for (const row of candidates.rows) {
    console.log(
      `  faculty_users #${row.id} (${row.email}) → full_name = ${JSON.stringify(row.name)}`,
    );
  }

  if (!dryRun && candidates.rows.length > 0) {
    const updated = await db.execute(sql`
      UPDATE faculty_users
      SET full_name = name,
          updated_at = NOW()
      WHERE full_name IS NULL
        AND name IS NOT NULL
        AND length(trim(name)) > 0
    `);
    console.log(
      `Copied legacy name → full_name for ${updated.rowCount ?? candidates.rows.length} row(s).`,
    );
  } else if (dryRun) {
    console.log("[dry-run] no changes written.");
  } else {
    console.log("Nothing to copy.");
  }

  const stillBlank = await db.execute(sql`
    SELECT DISTINCT fu.id, fu.email, fu.clerk_user_id
    FROM faculty_users fu
    JOIN interpretations i
      ON i.author_id = fu.id OR i.approver_id = fu.id
    WHERE i.status = 'approved'
      AND (fu.full_name IS NULL OR length(trim(fu.full_name)) = 0)
    ORDER BY fu.id
  `);

  if (stillBlank.rows.length === 0) {
    console.log(
      "Verification: every faculty_users row tied to an approved interpretation has a non-null full_name.",
    );
  } else {
    console.log(
      `Verification: ${stillBlank.rows.length} faculty_users row(s) tied to approved interpretations still have a blank full_name:`,
    );
    for (const row of stillBlank.rows) {
      console.log(
        `  faculty_users #${row.id} (${row.email}, clerk=${row.clerk_user_id})`,
      );
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
