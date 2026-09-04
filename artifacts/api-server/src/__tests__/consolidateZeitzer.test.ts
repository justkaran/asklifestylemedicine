import { afterEach, describe, test, expect } from "vitest";
import { pool } from "@workspace/db";
import { consolidateZeitzerAccounts } from "../lib/consolidateZeitzer.js";

/**
 * Exercises the guarded boot-time consolidation of the two diverged Jamie
 * Zeitzer faculty accounts. The function targets fixed emails in production, but
 * is parameterized so this test can drive it with throwaway fixtures that never
 * collide with the shared dev DB's real `jzeitzer@stanford.edu` row.
 */

const stamp = Date.now().toString(36);
const DOTTED = `dotted-${stamp}@zeit.test`;
const CANONICAL = `canonical-${stamp}@zeit.test`;
const DOTTED_CLERK = `pending:${DOTTED}`;
const CANONICAL_CLERK = `user_real_${stamp}`;

const createdUserClerkIds = new Set<string>();
const createdPillarSlugs = new Set<string>();

async function makePillar(slug: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO pillars (slug, name) VALUES ($1,$2) RETURNING id`,
    [slug, `Pillar ${slug}`],
  );
  createdPillarSlugs.add(slug);
  return rows[0].id;
}

async function makeUser(email: string, clerk: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name)
       VALUES ($1,$2,$3) RETURNING id`,
    [clerk, email, "Jamie Zeitzer"],
  );
  createdUserClerkIds.add(clerk);
  return rows[0].id;
}

async function addMembership(userId: number, pillarId: number): Promise<void> {
  await pool.query(
    `INSERT INTO faculty_memberships (user_id, pillar_id, role) VALUES ($1,$2,'steward')`,
    [userId, pillarId],
  );
}

async function addSource(pillarId: number, uploadedBy: number): Promise<void> {
  await pool.query(
    `INSERT INTO sources (pillar_id, kind, title, status, uploaded_by_user_id)
       VALUES ($1,'paper',$2,'approved',$3)`,
    [pillarId, `Source ${stamp}`, uploadedBy],
  );
}

async function addInvitation(pillarId: number, invitedBy: number): Promise<void> {
  await pool.query(
    `INSERT INTO faculty_invitations (email, pillar_id, role, invited_by_user_id, expires_at)
       VALUES ($1,$2,'contributor',$3, now() + interval '7 days')`,
    [`invitee-${stamp}@zeit.test`, pillarId, invitedBy],
  );
}

async function userById(
  id: number,
): Promise<{ id: number; email: string; clerk_user_id: string } | undefined> {
  const { rows } = await pool.query<{
    id: number;
    email: string;
    clerk_user_id: string;
  }>(`SELECT id, email, clerk_user_id FROM faculty_users WHERE id = $1`, [id]);
  return rows[0];
}

async function pillarIdsFor(userId: number): Promise<number[]> {
  const { rows } = await pool.query<{ pillar_id: number }>(
    `SELECT pillar_id FROM faculty_memberships WHERE user_id = $1 ORDER BY pillar_id`,
    [userId],
  );
  return rows.map((r) => r.pillar_id);
}

afterEach(async () => {
  // Remove dependent rows before users/pillars. Invitations cascade on pillar
  // delete, but clear them explicitly so a SET NULL on user delete can't leave
  // a stray row pinned to a pillar we're about to remove.
  if (createdPillarSlugs.size) {
    const slugs = [...createdPillarSlugs];
    await pool.query(
      `DELETE FROM faculty_invitations WHERE pillar_id IN (SELECT id FROM pillars WHERE slug = ANY($1::text[]))`,
      [slugs],
    );
    await pool.query(
      `DELETE FROM sources WHERE pillar_id IN (SELECT id FROM pillars WHERE slug = ANY($1::text[]))`,
      [slugs],
    );
  }
  if (createdUserClerkIds.size) {
    await pool.query(`DELETE FROM faculty_users WHERE clerk_user_id = ANY($1::text[])`, [
      [...createdUserClerkIds],
    ]);
  }
  if (createdPillarSlugs.size) {
    await pool.query(`DELETE FROM pillars WHERE slug = ANY($1::text[])`, [
      [...createdPillarSlugs],
    ]);
  }
  createdUserClerkIds.clear();
  createdPillarSlugs.clear();
});

describe("consolidateZeitzerAccounts", () => {
  test("merges content row onto canonical email + real Clerk login, dropping the empty row", async () => {
    const sleep = await makePillar(`zeit-sleep-${stamp}`);
    const extra = await makePillar(`zeit-extra-${stamp}`);

    // Content row under the dotted email: holds a source + two memberships.
    const dottedId = await makeUser(DOTTED, DOTTED_CLERK);
    await addMembership(dottedId, sleep);
    await addSource(sleep, dottedId);

    // Empty canonical row under the real Clerk login: shares the sleep pillar
    // (duplicate → dropped) and has one unique pillar (→ moved).
    const canonicalId = await makeUser(CANONICAL, CANONICAL_CLERK);
    await addMembership(canonicalId, sleep);
    await addMembership(canonicalId, extra);

    const res = await consolidateZeitzerAccounts({
      dottedEmail: DOTTED,
      canonicalEmail: CANONICAL,
    });

    expect(res.merged).toBe(true);
    expect(res.keptUserId).toBe(dottedId);
    expect(res.removedUserId).toBe(canonicalId);
    expect(res.membershipsMoved).toBe(1); // the unique "extra" pillar
    expect(res.membershipsDropped).toBe(1); // the duplicate "sleep" pillar

    // Canonical (empty) row is gone.
    expect(await userById(canonicalId)).toBeUndefined();

    // The surviving content row now carries the canonical email + real Clerk id.
    const survivor = await userById(dottedId);
    expect(survivor?.email).toBe(CANONICAL);
    expect(survivor?.clerk_user_id).toBe(CANONICAL_CLERK);

    // Content is preserved and re-homed under the surviving row.
    const { rows: srcRows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sources WHERE uploaded_by_user_id = $1`,
      [dottedId],
    );
    expect(srcRows[0].n).toBe(1);

    // Memberships are the union of both rows' pillars, no duplicates.
    expect(await pillarIdsFor(dottedId)).toEqual(
      [sleep, extra].sort((a, b) => a - b),
    );
  });

  test("is idempotent: a second run is a no-op once consolidated", async () => {
    const sleep = await makePillar(`zeit-sleep-${stamp}`);
    const dottedId = await makeUser(DOTTED, DOTTED_CLERK);
    await addMembership(dottedId, sleep);
    await addSource(sleep, dottedId);
    const canonicalId = await makeUser(CANONICAL, CANONICAL_CLERK);
    await addMembership(canonicalId, sleep);

    const first = await consolidateZeitzerAccounts({
      dottedEmail: DOTTED,
      canonicalEmail: CANONICAL,
    });
    expect(first.merged).toBe(true);

    const second = await consolidateZeitzerAccounts({
      dottedEmail: DOTTED,
      canonicalEmail: CANONICAL,
    });
    expect(second.merged).toBe(false);
    expect(second.reason).toBe("nothing-to-merge");
    void canonicalId;

    // Survivor still intact.
    expect((await userById(dottedId))?.email).toBe(CANONICAL);
  });

  test("aborts without changes if the canonical row unexpectedly holds content", async () => {
    const sleep = await makePillar(`zeit-sleep-${stamp}`);
    const dottedId = await makeUser(DOTTED, DOTTED_CLERK);
    await addMembership(dottedId, sleep);
    const canonicalId = await makeUser(CANONICAL, CANONICAL_CLERK);
    // Canonical row is NOT empty — it owns a source. Must abort.
    await addSource(sleep, canonicalId);

    const res = await consolidateZeitzerAccounts({
      dottedEmail: DOTTED,
      canonicalEmail: CANONICAL,
    });

    expect(res.merged).toBe(false);
    expect(res.reason).toBe("canonical-not-empty");

    // Both rows untouched.
    expect((await userById(dottedId))?.email).toBe(DOTTED);
    expect((await userById(canonicalId))?.email).toBe(CANONICAL);
  });

  test("aborts on ANY other inbound reference (e.g. an invitation invited_by the canonical row)", async () => {
    const sleep = await makePillar(`zeit-sleep-${stamp}`);
    const dottedId = await makeUser(DOTTED, DOTTED_CLERK);
    await addMembership(dottedId, sleep);
    const canonicalId = await makeUser(CANONICAL, CANONICAL_CLERK);
    // An invitation whose invited_by_user_id points at canonical. This FK is
    // ON DELETE SET NULL, so a naive delete would silently detach it — the
    // catalog-driven guard must catch it instead.
    await addInvitation(sleep, canonicalId);

    const res = await consolidateZeitzerAccounts({
      dottedEmail: DOTTED,
      canonicalEmail: CANONICAL,
    });

    expect(res.merged).toBe(false);
    expect(res.reason).toBe("canonical-has-references");

    // Both rows untouched.
    expect((await userById(dottedId))?.email).toBe(DOTTED);
    expect((await userById(canonicalId))?.email).toBe(CANONICAL);
  });

  test("aborts when an email resolves to more than one row (ambiguous)", async () => {
    const sleep = await makePillar(`zeit-sleep-${stamp}`);
    await makeUser(DOTTED, DOTTED_CLERK);
    await makeUser(CANONICAL, CANONICAL_CLERK);
    // A duplicate canonical-email row with a different Clerk id.
    await makeUser(CANONICAL, `${CANONICAL_CLERK}-dup`);
    void sleep;

    const res = await consolidateZeitzerAccounts({
      dottedEmail: DOTTED,
      canonicalEmail: CANONICAL,
    });

    expect(res.merged).toBe(false);
    expect(res.reason).toBe("ambiguous-rows");
  });

  test("aborts when the dotted row has a real (non-pending) Clerk id", async () => {
    const dottedId = await makeUser(DOTTED, `user_dotted_real_${stamp}`);
    const canonicalId = await makeUser(CANONICAL, CANONICAL_CLERK);

    const res = await consolidateZeitzerAccounts({
      dottedEmail: DOTTED,
      canonicalEmail: CANONICAL,
    });

    expect(res.merged).toBe(false);
    expect(res.reason).toBe("dotted-not-pending");
    expect((await userById(dottedId))?.email).toBe(DOTTED);
    expect((await userById(canonicalId))?.email).toBe(CANONICAL);
  });

  test("aborts when the canonical row has no real Clerk login yet", async () => {
    const dottedId = await makeUser(DOTTED, DOTTED_CLERK);
    const canonicalId = await makeUser(CANONICAL, `pending:${CANONICAL}`);

    const res = await consolidateZeitzerAccounts({
      dottedEmail: DOTTED,
      canonicalEmail: CANONICAL,
    });

    expect(res.merged).toBe(false);
    expect(res.reason).toBe("canonical-pending");
    expect((await userById(dottedId))?.email).toBe(DOTTED);
    expect((await userById(canonicalId))?.email).toBe(CANONICAL);
  });
});
