import { afterAll, beforeAll, describe, test, expect } from "vitest";
import pool from "../lib/db.js";
import {
  ensureSteward,
  seedStewardRoster,
  STEWARD_ROSTER,
} from "@workspace/db/seeds/steward-roster";

const stamp = Date.now().toString(36);
const TEST_PILLAR_SLUG = `steward-seed-test-${stamp}`;
let testPillarId = 0;

/** Emails created by the decoy tests; cleaned up in afterAll. */
const testEmails: string[] = [];

async function membershipRole(
  userId: number,
  pillarId: number,
): Promise<string | null> {
  const { rows } = await pool.query<{ role: string }>(
    `SELECT role FROM faculty_memberships WHERE user_id = $1 AND pillar_id = $2`,
    [userId, pillarId],
  );
  return rows[0]?.role ?? null;
}

async function userRow(
  id: number,
): Promise<{
  email: string;
  clerk_user_id: string;
  full_name: string | null;
  institution: string | null;
}> {
  const { rows } = await pool.query<{
    email: string;
    clerk_user_id: string;
    full_name: string | null;
    institution: string | null;
  }>(
    `SELECT email, clerk_user_id, full_name, institution FROM faculty_users WHERE id = $1`,
    [id],
  );
  return rows[0];
}

beforeAll(async () => {
  // Ensure every roster pillar exists (idempotent — other suites TRUNCATE
  // shared tables mid-run, so tests must self-provision their fixtures).
  for (const entry of STEWARD_ROSTER) {
    await pool.query(
      `INSERT INTO pillars (slug, name, description)
         VALUES ($1, $1, 'test-ensured pillar')
       ON CONFLICT (slug) DO NOTHING`,
      [entry.pillarSlug],
    );
  }
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO pillars (slug, name, description)
       VALUES ($1, 'Steward Seed Test', 'decoy pillar for stewardRosterSeed tests')
     ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
     RETURNING id`,
    [TEST_PILLAR_SLUG],
  );
  testPillarId = rows[0].id;
});

afterAll(async () => {
  if (testEmails.length > 0) {
    await pool.query(
      `DELETE FROM faculty_users WHERE lower(email) = ANY($1::text[])`,
      [testEmails.map((e) => e.toLowerCase())],
    );
  }
  await pool.query(`DELETE FROM faculty_memberships WHERE pillar_id = $1`, [
    testPillarId,
  ]);
  await pool.query(`DELETE FROM pillars WHERE id = $1`, [testPillarId]);
  // Leave the shared dev DB in the intended steady state (the roster
  // deliverable): re-run the seed after any cleanup.
  await seedStewardRoster();
});

describe("seedStewardRoster (real roster)", () => {
  test("seeds the full roster idempotently — every entry gets a steward membership", async () => {
    const first = await seedStewardRoster();
    expect(first.skippedPillars).toEqual([]);
    expect(first.ensured).toHaveLength(STEWARD_ROSTER.length);

    const second = await seedStewardRoster();
    expect(second.ensured).toEqual(first.ensured);

    for (const e of first.ensured) {
      expect(await membershipRole(e.userId, e.pillarId)).toBe("steward");
    }

    // Karan's Stanford account lands on the single AI Lab pillar; Karen Parker
    // lands on autism.
    const karan = first.ensured.find(
      (e) => e.email === "kdegani@stanford.edu",
    );
    expect(karan?.pillarSlug).toBe("slm-ai-lab");
    const parker = first.ensured.find(
      (e) => e.email === "kjparker@stanford.edu",
    );
    expect(parker?.pillarSlug).toBe("autism");

    // Institution labels land (backfill-on-NULL; steady state is non-null).
    const parkerRow = await userRow(parker!.userId);
    expect(parkerRow.institution).toBeTruthy();
    expect(parkerRow.institution).not.toBe("Stanford Lifestyle Medicine");
  });
});

describe("ensureSteward (isolated decoys)", () => {
  test("never clobbers a reconciled (real) row's email/clerk id or institution", async () => {
    const email = `real-${stamp}@test.local`;
    testEmails.push(email);
    const created = await pool.query<{ id: number }>(
      `INSERT INTO faculty_users (clerk_user_id, email, full_name, institution)
         VALUES ($1, $2, $3, $4) RETURNING id`,
      [`real-clerk-${stamp}`, email, "Decoy Real", "Custom Inst"],
    );
    const id = created.rows[0].id;

    const result = await ensureSteward({
      name: "Decoy Real",
      email,
      pillarSlug: TEST_PILLAR_SLUG,
      institution: "Seeded Inst",
    });
    expect(result?.userId).toBe(id);

    const row = await userRow(id);
    expect(row.email).toBe(email);
    expect(row.clerk_user_id).toBe(`real-clerk-${stamp}`);
    expect(row.institution).toBe("Custom Inst");
    expect(await membershipRole(id, testPillarId)).toBe("steward");
  });

  test("institution is backfilled only when NULL", async () => {
    const email = `nullinst-${stamp}@test.local`;
    testEmails.push(email);
    const created = await pool.query<{ id: number }>(
      `INSERT INTO faculty_users (clerk_user_id, email, full_name)
         VALUES ($1, $2, $3) RETURNING id`,
      [`nullinst-clerk-${stamp}`, email, "Null Inst"],
    );
    const id = created.rows[0].id;

    await ensureSteward({
      name: "Null Inst",
      email,
      pillarSlug: TEST_PILLAR_SLUG,
      institution: "Seeded Inst",
    });
    expect((await userRow(id)).institution).toBe("Seeded Inst");

    await ensureSteward({
      name: "Null Inst",
      email,
      pillarSlug: TEST_PILLAR_SLUG,
      institution: "Different Inst",
    });
    expect((await userRow(id)).institution).toBe("Seeded Inst");
  });

  test("matchEmailOnly never touches a same-named row with a different email", async () => {
    const decoyEmail = `decoy-name-${stamp}@test.local`;
    const opEmail = `operator-${stamp}@test.local`;
    testEmails.push(decoyEmail, opEmail);
    const decoy = await pool.query<{ id: number }>(
      `INSERT INTO faculty_users (clerk_user_id, email, full_name)
         VALUES ($1, $2, $3) RETURNING id`,
      [`decoy-clerk-${stamp}`, decoyEmail, "Same Name Operator"],
    );
    const decoyId = decoy.rows[0].id;

    const result = await ensureSteward({
      name: "Same Name Operator",
      email: opEmail,
      pillarSlug: TEST_PILLAR_SLUG,
      matchEmailOnly: true,
    });
    expect(result?.userId).not.toBe(decoyId);

    const decoyRow = await userRow(decoyId);
    expect(decoyRow.email).toBe(decoyEmail);
    expect(decoyRow.clerk_user_id).toBe(`decoy-clerk-${stamp}`);
    expect(await membershipRole(decoyId, testPillarId)).toBeNull();

    const opRow = await userRow(result!.userId);
    expect(opRow.clerk_user_id).toBe(`pending:${opEmail}`);
  });

  test("missing pillar is skipped without throwing", async () => {
    const email = `nopillar-${stamp}@test.local`;
    testEmails.push(email);
    const result = await ensureSteward({
      name: "No Pillar",
      email,
      pillarSlug: `no-such-pillar-${stamp}`,
    });
    expect(result).toBeNull();
    const { rows } = await pool.query(
      `SELECT id FROM faculty_users WHERE lower(email) = lower($1)`,
      [email],
    );
    expect(rows).toHaveLength(0);
  });
});
