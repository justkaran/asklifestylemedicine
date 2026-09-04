import { afterAll, beforeAll, describe, test, expect, vi } from "vitest";
import { ensureCaptureLoopSchema } from "./testHelpers.js";

/**
 * Steward rubric checks: per-pillar CRUD + advisory pass/flag verdicts on
 * the review inbox. The LLM evaluator is stubbed — routes must treat its
 * verdicts as observe-only badges and never touch the approval workflow.
 */

type StubEvaluation = {
  checkId: number;
  verdict: "pass" | "flag";
  rationale: string | null;
};

const rubricMocks = vi.hoisted(() => ({
  // Default: flag every check with a fixed rationale. Tests can swap it.
  evaluate: vi.fn(
    async (
      _draft: { interpretationId: number },
      checks: Array<{ id: number }>,
    ): Promise<StubEvaluation[] | null> =>
      checks.map((c) => ({
        checkId: c.id,
        verdict: "flag" as const,
        rationale: "stubbed rationale",
      })),
  ),
}));

vi.mock("../lib/rubricChecks.js", async () => {
  const actual = await vi.importActual<
    typeof import("../lib/rubricChecks.js")
  >("../lib/rubricChecks.js");
  return {
    ...actual,
    evaluateDraftAgainstChecks: rubricMocks.evaluate,
    // Route calls evaluateAndStoreDraft, which internally calls the real
    // evaluateDraftAgainstChecks — so re-implement the store step around
    // the stub to keep the cache-write path under test.
    evaluateAndStoreDraft: async (
      draft: Parameters<typeof actual.evaluateAndStoreDraft>[0],
      checks: Parameters<typeof actual.evaluateAndStoreDraft>[1],
    ) => {
      const evals = await rubricMocks.evaluate(draft, checks);
      if (!evals) return false;
      const { sql } = await import("drizzle-orm");
      const { db } = await import("@workspace/db");
      for (const ev of evals) {
        const check = checks.find((c) => c.id === ev.checkId)!;
        const hash = actual.rubricContentHash(draft, check);
        await db.execute(sql`
          INSERT INTO rubric_check_results
            (check_id, interpretation_id, verdict, rationale, content_hash, model)
          VALUES (${ev.checkId}, ${draft.interpretationId}, ${ev.verdict}, ${ev.rationale}, ${hash}, 'stub')
          ON CONFLICT (check_id, interpretation_id) DO UPDATE SET
            verdict = EXCLUDED.verdict, rationale = EXCLUDED.rationale,
            content_hash = EXCLUDED.content_hash, model = EXCLUDED.model
        `);
      }
      return true;
    },
  };
});

// Act as a specific signed-in faculty user per test.
let stubFacultyUserId = 0;

vi.mock("../middlewares/facultyAuth.js", async () => {
  const actual = await vi.importActual<
    typeof import("../middlewares/facultyAuth.js")
  >("../middlewares/facultyAuth.js");
  return {
    ...actual,
    requireFacultyAuth: async (
      req: { faculty?: unknown },
      res: { status: (n: number) => { json: (b: unknown) => void } },
      next: () => void,
    ) => {
      const { db, facultyUsersTable, facultyMembershipsTable } = await import(
        "@workspace/db"
      );
      const { eq } = await import("drizzle-orm");
      if (!stubFacultyUserId) {
        res.status(401).json({ error: "no stub user" });
        return;
      }
      const [user] = await db
        .select()
        .from(facultyUsersTable)
        .where(eq(facultyUsersTable.id, stubFacultyUserId));
      const memberships = await db
        .select()
        .from(facultyMembershipsTable)
        .where(eq(facultyMembershipsTable.userId, stubFacultyUserId));
      (req as { faculty: unknown }).faculty = { user, memberships };
      next();
    },
  };
});

import type { Express } from "express";
import request from "supertest";
import pool from "../lib/db.js";

let app: Express;

const stamp = Date.now();
let pillarId = 0;
let otherPillarId = 0;
let stewardId = 0;
let contributorId = 0;
let outsiderId = 0;
let sourceId = 0;
let interpId = 0;
const slug = `rubric-${stamp}`;
const otherSlug = `rubric-other-${stamp}`;

async function ensureSchema(): Promise<void> {
  await ensureCaptureLoopSchema();
  await pool.query(`CREATE TABLE IF NOT EXISTS rubric_checks (
    id SERIAL PRIMARY KEY,
    pillar_id INTEGER NOT NULL REFERENCES pillars(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    instruction TEXT NOT NULL,
    created_by_id INTEGER REFERENCES faculty_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rubric_check_results (
    id SERIAL PRIMARY KEY,
    check_id INTEGER NOT NULL REFERENCES rubric_checks(id) ON DELETE CASCADE,
    interpretation_id INTEGER NOT NULL REFERENCES interpretations(id) ON DELETE CASCADE,
    verdict TEXT NOT NULL,
    rationale TEXT,
    content_hash TEXT NOT NULL,
    model TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS rubric_check_results_check_interp_unique
     ON rubric_check_results (check_id, interpretation_id)`,
  );
}

beforeAll(async () => {
  await ensureSchema();

  const { rows: pRows } = await pool.query<{ id: number }>(
    `INSERT INTO pillars (slug, name) VALUES ($1,$2),($3,$4) RETURNING id`,
    [slug, "Rubric Pillar", otherSlug, "Rubric Other"],
  );
  pillarId = pRows[0].id;
  otherPillarId = pRows[1].id;

  const { rows: uRows } = await pool.query<{ id: number }>(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name)
     VALUES ($1,$2,'Rubric Steward'),($3,$4,'Rubric Contributor'),($5,$6,'Rubric Outsider')
     RETURNING id`,
    [
      `rubric-s-${stamp}`,
      `rubric-s-${stamp}@test.local`,
      `rubric-c-${stamp}`,
      `rubric-c-${stamp}@test.local`,
      `rubric-o-${stamp}`,
      `rubric-o-${stamp}@test.local`,
    ],
  );
  stewardId = uRows[0].id;
  contributorId = uRows[1].id;
  outsiderId = uRows[2].id;

  await pool.query(
    `INSERT INTO faculty_memberships (user_id, pillar_id, role)
     VALUES ($1,$2,'steward'),($3,$2,'contributor'),($4,$5,'steward')`,
    [stewardId, pillarId, contributorId, outsiderId, otherPillarId],
  );

  const { rows: sRows } = await pool.query<{ id: number }>(
    `INSERT INTO sources (pillar_id, title, kind, status, uploaded_by_user_id)
     VALUES ($1, 'Rubric Source', 'paper', 'approved', $2) RETURNING id`,
    [pillarId, stewardId],
  );
  sourceId = sRows[0].id;

  const { rows: iRows } = await pool.query<{ id: number }>(
    `INSERT INTO interpretations (source_id, pillar_id, author_id, status, answer, interpretation)
     VALUES ($1,$2,$3,'proposed','Sleep helps memory.','Adults 18-65 showed better recall.')
     RETURNING id`,
    [sourceId, pillarId, contributorId],
  );
  interpId = iRows[0].id;

  const mod = await import("../app.js");
  app = mod.default ?? (mod as unknown as { app: Express }).app;
});

afterAll(async () => {
  await pool.query(`DELETE FROM pillars WHERE id IN ($1,$2)`, [
    pillarId,
    otherPillarId,
  ]);
});

describe("rubric check CRUD", () => {
  let checkId = 0;

  test("steward creates a check", async () => {
    stubFacultyUserId = stewardId;
    const res = await request(app)
      .post(`/api/faculty/pillars/${slug}/rubric-checks`)
      .send({
        name: "Age range stated",
        instruction: "The draft must state the study population's age range.",
      });
    expect(res.status).toBe(201);
    checkId = res.body.check.id;
    expect(res.body.check.pillarId).toBe(pillarId);
  });

  test("contributor cannot create, can list", async () => {
    stubFacultyUserId = contributorId;
    const post = await request(app)
      .post(`/api/faculty/pillars/${slug}/rubric-checks`)
      .send({ name: "x", instruction: "y" });
    expect(post.status).toBe(403);
    const get = await request(app).get(
      `/api/faculty/pillars/${slug}/rubric-checks`,
    );
    expect(get.status).toBe(200);
    expect(get.body.checks).toHaveLength(1);
  });

  test("non-member steward of another pillar is forbidden", async () => {
    stubFacultyUserId = outsiderId;
    const res = await request(app).get(
      `/api/faculty/pillars/${slug}/rubric-checks`,
    );
    expect(res.status).toBe(403);
  });

  test("steward edits and cannot cross-edit another pillar's check", async () => {
    stubFacultyUserId = stewardId;
    const patch = await request(app)
      .patch(`/api/faculty/pillars/${slug}/rubric-checks/${checkId}`)
      .send({ instruction: "Must state the exact age range studied." });
    expect(patch.status).toBe(200);
    expect(patch.body.check.instruction).toContain("exact age range");

    stubFacultyUserId = outsiderId;
    const cross = await request(app)
      .patch(`/api/faculty/pillars/${otherSlug}/rubric-checks/${checkId}`)
      .send({ name: "hijack" });
    expect(cross.status).toBe(404); // scoped to their own pillar
  });
});

describe("inbox rubric verdicts (advisory)", () => {
  test("inbox scores pending drafts and returns flag badges", async () => {
    stubFacultyUserId = stewardId;
    const res = await request(app).get(`/api/faculty/pillars/${slug}/inbox`);
    expect(res.status).toBe(200);
    expect(res.body.checks).toHaveLength(1);
    const item = res.body.pending.find(
      (p: { id: number }) => p.id === interpId,
    );
    expect(item).toBeTruthy();
    expect(item.rubric).toHaveLength(1);
    expect(item.rubric[0].verdict).toBe("flag");
    expect(item.rubric[0].rationale).toBe("stubbed rationale");
  });

  test("verdicts are cached — second read does not re-evaluate", async () => {
    rubricMocks.evaluate.mockClear();
    stubFacultyUserId = stewardId;
    const res = await request(app).get(`/api/faculty/pillars/${slug}/inbox`);
    expect(res.status).toBe(200);
    expect(rubricMocks.evaluate).not.toHaveBeenCalled();
  });

  test("editing the draft invalidates the cache and re-evaluates", async () => {
    await pool.query(
      `UPDATE interpretations SET answer = 'Sleep helps memory in adults 18-65.', updated_at = NOW() WHERE id = $1`,
      [interpId],
    );
    rubricMocks.evaluate.mockClear();
    rubricMocks.evaluate.mockImplementationOnce(
      async (_d: unknown, checks: Array<{ id: number }>) =>
        checks.map((c) => ({
          checkId: c.id,
          verdict: "pass" as const,
          rationale: "age range now stated",
        })),
    );
    stubFacultyUserId = stewardId;
    const res = await request(app).get(`/api/faculty/pillars/${slug}/inbox`);
    expect(res.status).toBe(200);
    expect(rubricMocks.evaluate).toHaveBeenCalledTimes(1);
    const item = res.body.pending.find(
      (p: { id: number }) => p.id === interpId,
    );
    expect(item.rubric[0].verdict).toBe("pass");
  });

  test("evaluator failure leaves verdicts pending, inbox still 200", async () => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO interpretations (source_id, pillar_id, author_id, status, answer, interpretation)
       VALUES ($1,$2,$3,'proposed','Second draft.','Body.') RETURNING id`,
      [sourceId, pillarId, contributorId],
    );
    const secondId = rows[0].id;
    rubricMocks.evaluate.mockImplementationOnce(async () => null);
    stubFacultyUserId = stewardId;
    const res = await request(app).get(`/api/faculty/pillars/${slug}/inbox`);
    expect(res.status).toBe(200);
    const item = res.body.pending.find(
      (p: { id: number }) => p.id === secondId,
    );
    expect(item.rubric[0].verdict).toBe("pending");
  });

  test("a flag never blocks approval-path transitions (send back works)", async () => {
    // The flagged draft can still be sent back / approved exactly as
    // before — checks are advisory. Use send-back (archive) to avoid the
    // embedding-heavy approval path in this suite.
    stubFacultyUserId = stewardId;
    const res = await request(app)
      .post(`/api/faculty/interpretations/${interpId}/transition`)
      .send({ status: "archived", note: "test send-back despite verdicts" });
    expect(res.status).toBe(200);
  });
});
