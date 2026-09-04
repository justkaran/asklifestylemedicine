import { pool } from "@workspace/db";
import { logger } from "./logger";

/**
 * One-time, guarded, idempotent consolidation of the two Jamie Zeitzer
 * `faculty_users` rows that diverged in production.
 *
 * Background: production ended up with TWO rows for Jamie:
 *   - the "dotted" row (email `jamie.zeitzer@stanford.edu`) holds ALL of his
 *     real content — sources, interpretations, pillar memberships — but only a
 *     `pending:` placeholder Clerk id (it was never the row he signed in on);
 *   - the "canonical" row (email `jzeitzer@stanford.edu`) is EMPTY of content
 *     but carries his REAL Clerk login (minted when he first signed in against
 *     the seeded placeholder for that email).
 * The faculty auth middleware matches by email, so the desired end-state is a
 * SINGLE row under `jzeitzer@stanford.edu` that keeps all the content AND the
 * real Clerk login. Publishing migrates schema (not row data) and production
 * data is otherwise read-only to tooling, so — like the pillar content seeds —
 * this self-heals at boot.
 *
 * Strategy (minimal blast radius): keep the content-bearing dotted row, move
 * the empty canonical row's identity (email + Clerk id) onto it, then delete
 * the canonical row. Content is never moved, so it can never be lost.
 *
 * Safety — it ONLY proceeds when the production state matches the exact, known
 * divergence, and the row it DELETES (canonical) provably has no references:
 *   - No-op unless EXACTLY ONE row exists for each email (so it never fires in
 *     dev — only the canonical row exists there — and never again once merged;
 *     `email` is not unique, so duplicates abort rather than guess).
 *   - The dotted row must carry a `pending:` Clerk id and the canonical row a
 *     real (non-pending) one; any other shape aborts.
 *   - The canonical row (the delete target) must hold ZERO authored content AND
 *     have ZERO inbound foreign-key references of ANY kind except the pillar
 *     memberships we explicitly re-home. The FK check is driven by the live
 *     catalog (`pg_constraint`), so it covers every table that references
 *     `faculty_users` today or in the future — including `ON DELETE SET NULL`
 *     / `CASCADE` relations that would otherwise silently detach or delete data
 *     without raising an error.
 *   - Everything runs in one transaction with `FOR UPDATE` row locks (which
 *     also block concurrent inserts of new child rows referencing the canonical
 *     row); any unexpected error rolls the whole thing back (fail-closed).
 *
 * The emails are parameterized only so the test can drive it with throwaway
 * fixtures; the boot path always uses the real defaults.
 */
export interface ConsolidateZeitzerResult {
  merged: boolean;
  reason?:
    | "nothing-to-merge"
    | "same-row"
    | "ambiguous-rows"
    | "dotted-not-pending"
    | "canonical-pending"
    | "canonical-not-empty"
    | "canonical-has-references"
    | "error";
  keptUserId?: number;
  removedUserId?: number;
  membershipsMoved?: number;
  membershipsDropped?: number;
}

export async function consolidateZeitzerAccounts(
  opts: { dottedEmail?: string; canonicalEmail?: string } = {},
): Promise<ConsolidateZeitzerResult> {
  const dottedEmail = (
    opts.dottedEmail ?? "jamie.zeitzer@stanford.edu"
  ).toLowerCase();
  const canonicalEmail = (
    opts.canonicalEmail ?? "jzeitzer@stanford.edu"
  ).toLowerCase();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const dottedRes = await client.query<{ id: number; clerk_user_id: string }>(
      `SELECT id, clerk_user_id FROM faculty_users WHERE lower(email) = $1 FOR UPDATE`,
      [dottedEmail],
    );
    const canonicalRes = await client.query<{
      id: number;
      clerk_user_id: string;
      email: string;
    }>(
      `SELECT id, clerk_user_id, email FROM faculty_users WHERE lower(email) = $1 FOR UPDATE`,
      [canonicalEmail],
    );

    // Nothing to merge: already consolidated, or dev where only the canonical
    // row exists. Never touch the surviving row.
    if (dottedRes.rows.length === 0 || canonicalRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return { merged: false, reason: "nothing-to-merge" };
    }

    // `email` is not unique. If either side resolves to more than one row the
    // state is ambiguous — abort rather than guess which to keep/delete.
    if (dottedRes.rows.length > 1 || canonicalRes.rows.length > 1) {
      await client.query("ROLLBACK");
      logger.warn(
        {
          dottedCount: dottedRes.rows.length,
          canonicalCount: canonicalRes.rows.length,
        },
        "Zeitzer consolidation skipped: duplicate rows for an email (ambiguous)",
      );
      return { merged: false, reason: "ambiguous-rows" };
    }

    const dotted = dottedRes.rows[0];
    const canonical = canonicalRes.rows[0];

    if (dotted.id === canonical.id) {
      await client.query("ROLLBACK");
      return { merged: false, reason: "same-row" };
    }

    // The dotted row must be the never-signed-in content row, and the canonical
    // row must carry the real login. Any other shape isn't the divergence we
    // know how to repair — abort.
    if (!dotted.clerk_user_id.startsWith("pending:")) {
      await client.query("ROLLBACK");
      logger.warn(
        { dottedId: dotted.id },
        "Zeitzer consolidation skipped: dotted row has a real (non-pending) Clerk id",
      );
      return { merged: false, reason: "dotted-not-pending" };
    }
    if (canonical.clerk_user_id.startsWith("pending:")) {
      await client.query("ROLLBACK");
      logger.warn(
        { canonicalId: canonical.id },
        "Zeitzer consolidation skipped: canonical row has no real Clerk login yet",
      );
      return { merged: false, reason: "canonical-pending" };
    }

    // The canonical row is the one we DELETE — it MUST be empty of authored
    // content. This explicit check gives a precise signal for the expected
    // failure mode; the catalog-driven check below is the exhaustive backstop.
    const guard = await client.query<{ content: number }>(
      `SELECT (
           (SELECT count(*) FROM sources
              WHERE uploaded_by_user_id = $1
                 OR speaker_faculty_user_id = $1
                 OR assessed_by_user_id = $1)
         + (SELECT count(*) FROM interpretations
              WHERE author_id = $1 OR approver_id = $1)
         + (SELECT count(*) FROM faculty_voice_profiles
              WHERE faculty_user_id = $1)
       )::int AS content`,
      [canonical.id],
    );
    if (Number(guard.rows[0]?.content ?? 0) > 0) {
      await client.query("ROLLBACK");
      logger.warn(
        { canonicalId: canonical.id, content: guard.rows[0]?.content },
        "Zeitzer consolidation skipped: canonical row unexpectedly holds content",
      );
      return { merged: false, reason: "canonical-not-empty" };
    }

    // Exhaustive backstop: count EVERY inbound foreign-key reference to the
    // canonical row, discovered from the live catalog so newly-added tables are
    // covered automatically. We exclude only `faculty_memberships` (re-homed
    // below). Any other reference — even `ON DELETE SET NULL`/`CASCADE`, which
    // would silently detach/delete instead of erroring — aborts the merge.
    const fkCols = await client.query<{
      relname: string;
      qualified: string;
      quoted_column: string;
    }>(
      `SELECT cl.relname AS relname,
              format('%I.%I', n.nspname, cl.relname) AS qualified,
              format('%I', a.attname) AS quoted_column
         FROM pg_constraint c
         JOIN pg_class cl ON cl.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = cl.relnamespace
         JOIN pg_attribute a
           ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
        WHERE c.contype = 'f'
          AND c.confrelid = 'faculty_users'::regclass`,
    );

    const offending: string[] = [];
    for (const fk of fkCols.rows) {
      if (fk.relname === "faculty_memberships") continue;
      const refRes = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${fk.qualified} WHERE ${fk.quoted_column} = $1`,
        [canonical.id],
      );
      const n = Number(refRes.rows[0]?.n ?? 0);
      if (n > 0) offending.push(`${fk.qualified}.${fk.quoted_column}=${n}`);
    }
    if (offending.length > 0) {
      await client.query("ROLLBACK");
      logger.warn(
        { canonicalId: canonical.id, offending },
        "Zeitzer consolidation skipped: canonical row has inbound references",
      );
      return { merged: false, reason: "canonical-has-references" };
    }

    // Move the canonical row's pillar memberships onto the content row, dropping
    // any that would duplicate a pillar it already holds (mirrors the
    // merge-orphan-stewards conflict logic so no role is ever lost). Any
    // leftover canonical memberships are cleaned up by the ON DELETE CASCADE
    // when the row is removed below.
    const dropRes = await client.query(
      `DELETE FROM faculty_memberships c
         WHERE c.user_id = $1
           AND EXISTS (
             SELECT 1 FROM faculty_memberships d
              WHERE d.user_id = $2 AND d.pillar_id = c.pillar_id
           )`,
      [canonical.id, dotted.id],
    );
    const moveRes = await client.query(
      `UPDATE faculty_memberships SET user_id = $2 WHERE user_id = $1`,
      [canonical.id, dotted.id],
    );

    // Delete the now-empty canonical row, freeing its UNIQUE clerk_user_id.
    await client.query(`DELETE FROM faculty_users WHERE id = $1`, [
      canonical.id,
    ]);

    // Relabel the content row onto the canonical email and adopt the real Clerk
    // login so Jamie keeps portal access (auth matches by email; the Clerk id is
    // the durable link).
    await client.query(
      `UPDATE faculty_users
          SET email = $2, clerk_user_id = $3, updated_at = now()
        WHERE id = $1`,
      [dotted.id, canonical.email, canonical.clerk_user_id],
    );

    await client.query("COMMIT");

    const result: ConsolidateZeitzerResult = {
      merged: true,
      keptUserId: dotted.id,
      removedUserId: canonical.id,
      membershipsMoved: moveRes.rowCount ?? 0,
      membershipsDropped: dropRes.rowCount ?? 0,
    };
    logger.info(
      result,
      "Zeitzer accounts consolidated onto the canonical email with the real Clerk login",
    );
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    logger.error({ err }, "Zeitzer consolidation failed (rolled back)");
    return { merged: false, reason: "error" };
  } finally {
    client.release();
  }
}
