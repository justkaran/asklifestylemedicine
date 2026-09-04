import { afterAll, beforeAll, describe, test, expect, vi } from "vitest";
import { ensureCaptureLoopSchema } from "./testHelpers.js";

vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-study-design-secret";
});

// `stubFacultyUserId` lets each test act as a specific signed-in member.
let stubFacultyUserId = 0;

vi.mock("../middlewares/facultyAuth.js", async () => {
  const actual =
    await vi.importActual<typeof import("../middlewares/facultyAuth.js")>(
      "../middlewares/facultyAuth.js",
    );
  const { db, facultyUsersTable, facultyMembershipsTable } = await import(
    "@workspace/db"
  );
  const { eq } = await import("drizzle-orm");
  return {
    ...actual,
    requireFacultyAuth: async (
      req: { faculty?: unknown },
      res: { status: (n: number) => { json: (b: unknown) => void } },
      next: () => void,
    ) => {
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
let pillarSlug = "";
let pillarId = 0;
let stewardId = 0;
let contributorId = 0;
let sourceId = 0;

beforeAll(async () => {
  await ensureCaptureLoopSchema();
  // `study_design` is added at server boot via index.ts bootstrap, which the
  // tests (importing app.ts) don't run — ensure it idempotently here.
  await pool.query(
    `ALTER TABLE sources ADD COLUMN IF NOT EXISTS study_design TEXT`,
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS source_audit_log (
    id SERIAL PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    actor_user_id INTEGER REFERENCES faculty_users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    from_status source_status,
    to_status source_status,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  pillarSlug = `sd-${stamp}`;
  const { rows: pRows } = await pool.query<{ id: number }>(
    `INSERT INTO pillars (slug, name) VALUES ($1,$2) RETURNING id`,
    [pillarSlug, "Study Design Pillar"],
  );
  pillarId = pRows[0].id;

  const { rows: uRows } = await pool.query<{ id: number }>(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name)
     VALUES ($1,$2,$3),($4,$5,$6) RETURNING id`,
    [
      `sd-steward-clerk-${stamp}`,
      `sd-steward-${stamp}@test.local`,
      "Steward",
      `sd-contrib-clerk-${stamp}`,
      `sd-contrib-${stamp}@test.local`,
      "Contributor",
    ],
  );
  stewardId = uRows[0].id;
  contributorId = uRows[1].id;

  await pool.query(
    `INSERT INTO faculty_memberships (user_id, pillar_id, role)
     VALUES ($1,$2,'steward'),($3,$4,'contributor')`,
    [stewardId, pillarId, contributorId, pillarId],
  );

  const { rows: sRows } = await pool.query<{ id: number }>(
    `INSERT INTO sources (pillar_id, kind, title, status, uploaded_by_user_id, study_design)
     VALUES ($1,'paper',$2,'draft',$3,NULL) RETURNING id`,
    [pillarId, `Mistagged paper ${stamp}`, stewardId],
  );
  sourceId = sRows[0].id;

  app = (await import("../app")).default;
});

// This suite writes to the real dev database. Remove this run's footprint
// (scoped to its `stamp`) so it doesn't pollute the faculty admin roster.
afterAll(async () => {
  await pool.query(
    `
    WITH tp AS (SELECT id FROM pillars WHERE slug = $1),
         tu AS (SELECT id FROM faculty_users WHERE email LIKE $2),
         ts AS (SELECT id FROM sources WHERE pillar_id IN (SELECT id FROM tp)),
         d1 AS (DELETE FROM source_audit_log WHERE source_id IN (SELECT id FROM ts)),
         d2 AS (DELETE FROM sources WHERE id IN (SELECT id FROM ts)),
         d3 AS (DELETE FROM faculty_memberships WHERE pillar_id IN (SELECT id FROM tp)),
         d4 AS (DELETE FROM faculty_users WHERE id IN (SELECT id FROM tu))
    DELETE FROM pillars WHERE id IN (SELECT id FROM tp)
  `,
    [pillarSlug, `sd-%-${stamp}@test.local`],
  );
});

describe("PATCH study-design (in-place edit, no re-ingest)", () => {
  test("steward sets a study type", async () => {
    stubFacultyUserId = stewardId;
    const res = await request(app)
      .patch(`/api/faculty/pillars/${pillarSlug}/sources/${sourceId}/study-design`)
      .send({ studyDesign: "rct" });
    expect(res.status).toBe(200);
    expect(res.body.studyDesign).toBe("rct");

    const { rows } = await pool.query<{ study_design: string | null; version: number }>(
      `SELECT study_design, version FROM sources WHERE id = $1`,
      [sourceId],
    );
    expect(rows[0].study_design).toBe("rct");
    // No version bump — this is an in-place edit, not a re-upload.
    expect(rows[0].version).toBe(1);
  });

  test("an audit row records the change", async () => {
    const { rows } = await pool.query<{ action: string; note: string | null }>(
      `SELECT action, note FROM source_audit_log
       WHERE source_id = $1 AND action = 'study_design_change'
       ORDER BY created_at DESC LIMIT 1`,
      [sourceId],
    );
    expect(rows[0].action).toBe("study_design_change");
    expect(rows[0].note).toContain("rct");
  });

  test("steward clears the study type (null)", async () => {
    stubFacultyUserId = stewardId;
    const res = await request(app)
      .patch(`/api/faculty/pillars/${pillarSlug}/sources/${sourceId}/study-design`)
      .send({ studyDesign: null });
    expect(res.status).toBe(200);
    expect(res.body.studyDesign).toBeNull();

    const { rows } = await pool.query<{ study_design: string | null }>(
      `SELECT study_design FROM sources WHERE id = $1`,
      [sourceId],
    );
    expect(rows[0].study_design).toBeNull();
  });

  test("empty string also clears to null", async () => {
    stubFacultyUserId = stewardId;
    // First set something, then clear via empty string.
    await request(app)
      .patch(`/api/faculty/pillars/${pillarSlug}/sources/${sourceId}/study-design`)
      .send({ studyDesign: "cohort" });
    const res = await request(app)
      .patch(`/api/faculty/pillars/${pillarSlug}/sources/${sourceId}/study-design`)
      .send({ studyDesign: "" });
    expect(res.status).toBe(200);
    expect(res.body.studyDesign).toBeNull();
  });

  test("an unknown value is rejected (400)", async () => {
    stubFacultyUserId = stewardId;
    const res = await request(app)
      .patch(`/api/faculty/pillars/${pillarSlug}/sources/${sourceId}/study-design`)
      .send({ studyDesign: "not-a-real-design" });
    expect(res.status).toBe(400);
  });

  test("a contributor cannot edit the study type (403)", async () => {
    stubFacultyUserId = contributorId;
    const res = await request(app)
      .patch(`/api/faculty/pillars/${pillarSlug}/sources/${sourceId}/study-design`)
      .send({ studyDesign: "rct" });
    expect(res.status).toBe(403);
  });

  test("a no-op change reports unchanged", async () => {
    stubFacultyUserId = stewardId;
    // Source is currently null (cleared above) → setting null again is a no-op.
    const res = await request(app)
      .patch(`/api/faculty/pillars/${pillarSlug}/sources/${sourceId}/study-design`)
      .send({ studyDesign: null });
    expect(res.status).toBe(200);
    expect(res.body.unchanged).toBe(true);
  });
});
