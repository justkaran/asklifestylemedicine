import { beforeAll, afterAll, describe, test, expect, vi } from "vitest";
import { ensureCaptureLoopSchema } from "./testHelpers.js";

// Route/lib modules read these once at module-init time, so set them before
// the app is imported.
vi.hoisted(() => {
  process.env.RESEND_API_KEY = "stub-key";
});

vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: async () => ({ id: "stub-id" }),
    };
  },
}));

// Deterministic, network-free embeddings so the ingest path's `embedTexts`
// call doesn't hit OpenAI. The exact vector doesn't matter for these tests —
// we only assert on the persisted `study_design`.
vi.mock("../lib/embeddings.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/embeddings.js")>(
      "../lib/embeddings.js",
    );
  return {
    ...actual,
    embedTexts: vi.fn(async (texts: string[]) =>
      texts.map(() => {
        const v = new Array(384).fill(0);
        v[5] = 1;
        return v;
      }),
    ),
  };
});

// Bypass Clerk by stubbing the faculty auth middleware, exactly like the
// draft-interpretation test. The pillar-role middleware is left intact so the
// membership check still runs.
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

// ─── Imports that depend on the mocks above ────────────────────────────

import type { Express } from "express";
import request from "supertest";
import pool from "../lib/db.js";
import { buildProvenance, type RetrievedChunk } from "../lib/rag.js";

let app: Express;
let pillarId = 0;
const pillarSlug = `study-design-test-${Date.now()}`;
const stewardEmail = `study-design-steward-${Date.now()}@test.local`;

beforeAll(async () => {
  await ensureCaptureLoopSchema();

  const { rows: pRows } = await pool.query<{ id: number }>(
    `INSERT INTO pillars (slug, name) VALUES ($1, $2) RETURNING id`,
    [pillarSlug, "Study Design Test Pillar"],
  );
  pillarId = pRows[0].id;

  const { rows: uRows } = await pool.query<{ id: number }>(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [`study-design-clerk-${Date.now()}`, stewardEmail, "Study Design Steward"],
  );
  stubFacultyUserId = uRows[0].id;

  await pool.query(
    `INSERT INTO faculty_memberships (user_id, pillar_id, role)
     VALUES ($1, $2, 'steward')`,
    [stubFacultyUserId, pillarId],
  );

  app = (await import("../app.js")).default;
});

afterAll(async () => {
  if (pillarId) {
    await pool.query(
      `DELETE FROM source_chunks
        WHERE source_id IN (SELECT id FROM sources WHERE pillar_id = $1)`,
      [pillarId],
    );
    await pool.query(`DELETE FROM sources WHERE pillar_id = $1`, [pillarId]);
    await pool.query(`DELETE FROM faculty_memberships WHERE pillar_id = $1`, [
      pillarId,
    ]);
    await pool.query(`DELETE FROM pillars WHERE id = $1`, [pillarId]);
  }
  if (stubFacultyUserId) {
    await pool.query(`DELETE FROM faculty_users WHERE id = $1`, [
      stubFacultyUserId,
    ]);
  }
  await pool.end();
});

async function ingest(body: Record<string, unknown>) {
  return request(app)
    .post(`/api/faculty/pillars/${pillarSlug}/sources`)
    .send(body);
}

describe("source ingest — study_design controlled vocabulary", () => {
  test("persists a valid vocabulary value on ingest", async () => {
    const res = await ingest({
      kind: "paper",
      title: "RCT on evening light and melatonin",
      text: "A randomized controlled trial of dim evening light and melatonin.",
      studyDesign: "rct",
      rightsBasis: "open_license",
    });
    expect(res.status).toBe(201);
    const id = (res.body as { id: number }).id;

    const detail = await request(app).get(
      `/api/faculty/pillars/${pillarSlug}/sources/${id}`,
    );
    expect(detail.status).toBe(200);
    expect((detail.body as { source: { studyDesign: string | null } }).source
      .studyDesign).toBe("rct");

    // It also appears in the list response.
    const list = await request(app).get(
      `/api/faculty/pillars/${pillarSlug}/sources`,
    );
    expect(list.status).toBe(200);
    const listed = (
      list.body as { sources: Array<{ id: number; studyDesign: string | null }> }
    ).sources.find((s) => s.id === id);
    expect(listed?.studyDesign).toBe("rct");
  });

  test("coerces an empty-string study type to NULL", async () => {
    const res = await ingest({
      kind: "paper",
      title: "Source with no study type chosen",
      text: "Some sleep-science text with no study design selected.",
      studyDesign: "",
      rightsBasis: "open_license",
    });
    expect(res.status).toBe(201);
    const id = (res.body as { id: number }).id;

    const { rows } = await pool.query<{ study_design: string | null }>(
      `SELECT study_design FROM sources WHERE id = $1`,
      [id],
    );
    expect(rows[0].study_design).toBeNull();

    const detail = await request(app).get(
      `/api/faculty/pillars/${pillarSlug}/sources/${id}`,
    );
    expect((detail.body as { source: { studyDesign: string | null } }).source
      .studyDesign).toBeNull();
  });

  test("rejects an out-of-vocabulary study type with 400", async () => {
    const res = await ingest({
      kind: "paper",
      title: "Source with a bogus study type",
      text: "Text that should never be ingested because the study type is bad.",
      studyDesign: "definitely-not-a-real-design",
    });
    expect(res.status).toBe(400);

    // Nothing should have been persisted for this title.
    const { rowCount } = await pool.query(
      `SELECT 1 FROM sources WHERE pillar_id = $1 AND title = $2`,
      [pillarId, "Source with a bogus study type"],
    );
    expect(rowCount).toBe(0);
  });
});

describe("retrieval — study_design flows through buildProvenance", () => {
  test("carries sourceStudyDesign onto the provenance entry", () => {
    const chunk: RetrievedChunk = {
      kind: "source",
      chunkId: 1,
      chunkIndex: 0,
      text: "Dim evening light suppresses melatonin.",
      score: 0.9,
      weightedScore: 0.9,
      sourceId: 42,
      sourceTitle: "Evening light and melatonin",
      sourceAuthors: "Zeitzer JM et al.",
      sourceYear: 2000,
      sourceJournal: "J Physiol",
      sourceDoi: "10.1111/study-design-test",
      sourceUrl: "https://example.test/light",
      sourceRetentionStatus: "retained_with_rights",
      sourceStudyDesign: "rct",
      sourceReliabilityRubric: null,
      pillarId: 7,
      pillarSlug: "sleep",
      pillarName: "Sleep",
      interpretationId: null,
      interpretationAuthor: null,
      advisorLens: null,
    };

    const provenance = buildProvenance([chunk]);
    expect(provenance).toHaveLength(1);
    expect(provenance[0].source_id).toBe(42);
    expect(provenance[0].study_design).toBe("rct");

    // A null study type passes through as null (renders "nothing").
    const nullChunk = {
      ...chunk,
      sourceId: 43,
      sourceStudyDesign: null,
    } as RetrievedChunk;
    const nullProv = buildProvenance([nullChunk]);
    expect(nullProv[0].study_design).toBeNull();
  });
});
