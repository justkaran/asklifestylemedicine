/**
 * Idempotent cleanup: purge leftover test faculty accounts on reserved test
 * domains (`@example.com`, `@test.local`) from the shared development database.
 *
 * Background: interrupted or crashed api-server test runs mint timestamped
 * faculty accounts on reserved test domains — `@example.com` (`admin-*`,
 * `steward-*`, `speaker-*`, `cp-admin-*`, `cp-speaker-*`) and `@test.local`
 * (`nl-fa-*`, `nl-fb-*` from the newsletter suite) — and only remove them in
 * `afterAll`. When a run never reaches `afterAll`, those rows are stranded in
 * the dev DB, where they pollute the faculty roster and counts. The test
 * suite's global setup purges them at the START of each run, but that only helps
 * when the suite actually runs — pre-existing rows need a manual sweep, and a
 * post-merge hook keeps dev clean going forward.
 *
 * `@example.com` is reserved for tests/docs (RFC 2606) and `.local` is a
 * non-routable reserved TLD (RFC 6762) used only by tests here, so no real
 * faculty can legitimately use either — purging the whole domains is always
 * safe. FK constraints on `faculty_users` are all `ON DELETE CASCADE`
 * (memberships, crawl_runs, eval_gradings) or `ON DELETE SET NULL` (sources,
 * interpretations, audit log), so a single DELETE cleans up every dependent row
 * without orphaning anything. `faculty_invitations` is keyed by email (not an
 * FK), so it is cleared separately.
 *
 * Idempotent: re-running with no matching rows is a safe no-op.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run purge-test-faculty
 *   pnpm --filter @workspace/scripts run purge-test-faculty -- --dry-run
 */

import { pool } from "@workspace/db";

// Only purge rows old enough that no in-flight test run could have minted
// them. This script runs from the post-merge hook, which can fire while
// ANOTHER task's validation `pnpm run test` is mid-run against the same shared
// dev DB — deleting freshly-minted test accounts out from under that run
// breaks it with FK violations on sources.uploaded_by_user_id. A full test
// pass takes well under 45 minutes, so anything older is genuinely stranded.
const TEST_DOMAIN_FILTER = `(lower(email) LIKE '%@example.com' OR lower(email) LIKE '%@test.local') AND created_at < NOW() - INTERVAL '45 minutes'`;

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await pool.query<{ reg: string | null }>(
    `SELECT to_regclass($1)::text AS reg`,
    [`public.${name}`],
  );
  return Boolean(rows[0]?.reg);
}

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");

  if (!(await tableExists("faculty_users"))) {
    console.log("faculty_users table does not exist yet. Nothing to purge.");
    return;
  }

  const userCount = (
    await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM faculty_users WHERE ${TEST_DOMAIN_FILTER}`,
    )
  ).rows[0]?.count;
  const usersMatched = Number(userCount ?? 0);

  const hasInvitations = await tableExists("faculty_invitations");
  let invitationsMatched = 0;
  if (hasInvitations) {
    const invCount = (
      await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM faculty_invitations WHERE ${TEST_DOMAIN_FILTER}`,
      )
    ).rows[0]?.count;
    invitationsMatched = Number(invCount ?? 0);
  }

  if (usersMatched === 0 && invitationsMatched === 0) {
    console.log(
      "No @example.com / @test.local test accounts found. Nothing to purge.",
    );
    return;
  }

  if (dryRun) {
    console.log(
      `[dry-run] would delete ${invitationsMatched} faculty_invitations row(s) ` +
        `and ${usersMatched} faculty_users row(s) on the @example.com / @test.local ` +
        `test domains. No changes written.`,
    );
    return;
  }

  let invitationsDeleted = 0;
  if (hasInvitations) {
    const res = await pool.query(
      `DELETE FROM faculty_invitations WHERE ${TEST_DOMAIN_FILTER}`,
    );
    invitationsDeleted = res.rowCount ?? 0;
  }

  const usersRes = await pool.query(
    `DELETE FROM faculty_users WHERE ${TEST_DOMAIN_FILTER}`,
  );
  const usersDeleted = usersRes.rowCount ?? 0;

  console.log(
    `Purged ${invitationsDeleted} faculty_invitations row(s) and ` +
      `${usersDeleted} faculty_users row(s) on the @example.com / @test.local ` +
      `test domains.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
