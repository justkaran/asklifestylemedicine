import { Pool } from "pg";

/**
 * Vitest global setup — runs ONCE at the start of every test run, before any
 * suite's `beforeAll`. Several suites mint timestamped test faculty accounts on
 * reserved test domains — the crawl + faculty-admin suites use `@example.com`
 * (admins, stewards, speakers) and the newsletter suite uses `@test.local`
 * (`nl-fa-*`, `nl-fb-*`) — and only remove them in `afterAll`. When a run is
 * interrupted or crashes before `afterAll` executes, that batch is stranded in
 * the shared dev DB, where it pollutes the faculty roster. Per-suite `afterAll`
 * cleanup can't recover from a previous run that never finished, so we purge
 * here for a guaranteed clean slate regardless of how the prior run ended.
 *
 * `@example.com` is reserved for tests/docs (RFC 2606) and `.local` is a
 * non-routable reserved TLD (RFC 6762) used only by tests here, so no real
 * faculty can legitimately use either — purging the whole domains is always
 * safe. FK constraints on `faculty_users` are all `ON DELETE CASCADE`
 * (memberships, crawl_runs, eval_gradings) or `ON DELETE SET NULL` (sources,
 * interpretations, audit log), so a single DELETE cleans up every dependent row
 * without orphaning anything.
 */
export default async function globalSetup(): Promise<void> {
  const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
  try {
    // The table may not exist yet on a brand-new DB; skip silently if so.
    const { rows } = await pool.query<{ reg: string | null }>(
      `SELECT to_regclass('public.faculty_users')::text AS reg`,
    );
    if (!rows[0]?.reg) return;

    // Invitations are keyed by email (not an FK to faculty_users), so clear any
    // test-domain invitations separately.
    if (
      (
        await pool.query<{ reg: string | null }>(
          `SELECT to_regclass('public.faculty_invitations')::text AS reg`,
        )
      ).rows[0]?.reg
    ) {
      await pool.query(
        `DELETE FROM faculty_invitations
          WHERE (lower(email) LIKE '%@example.com' OR lower(email) LIKE '%@test.local')
            AND created_at < NOW() - INTERVAL '45 minutes'`,
      );
    }

    const res = await pool.query(
      `DELETE FROM faculty_users
        WHERE (lower(email) LIKE '%@example.com' OR lower(email) LIKE '%@test.local')
          AND created_at < NOW() - INTERVAL '45 minutes'`,
    );
    if (res.rowCount && res.rowCount > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[globalSetup] purged ${res.rowCount} stranded @example.com / @test.local faculty account(s)`,
      );
    }
  } finally {
    await pool.end();
  }
}
