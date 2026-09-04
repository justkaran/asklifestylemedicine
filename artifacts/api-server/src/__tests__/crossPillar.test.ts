import { afterAll, beforeAll, describe, test, expect, vi } from "vitest";
import { ensureCaptureLoopSchema } from "./testHelpers.js";

const emailMocks = vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-cross-pillar-secret";
  return {
    sendCrossPillarMergeRequestEmail: vi.fn(async (_args: unknown) => true),
    sendCrossPillarCommentEmail: vi.fn(async (_args: unknown) => true),
    sendCrossPillarMergeOutcomeEmail: vi.fn(
      async (_args: Record<string, unknown>) => true,
    ),
  };
});

// Cross-pillar propose/approve/decline notify stewards via Resend through
// this lib — stub it so the routes succeed without network.
vi.mock("../lib/crossPillarEmail", () => emailMocks);

// `stubFacultyUserId` lets each test act as a specific signed-in steward.
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

let app: Express;

const stamp = Date.now();
let pillarAId = 0; // owned by steward A (holds an approved interpretation)
let pillarBId = 0; // owned by steward B (wants to adopt)
let stewardAId = 0;
let stewardBId = 0;
let sourceAId = 0;
let interpAId = 0;

async function ensureSchema(): Promise<void> {
  await ensureCaptureLoopSchema();
  await pool.query(`DO $$ BEGIN
    CREATE TYPE cross_pillar_request_status AS ENUM ('proposed','approved','declined');
  EXCEPTION WHEN duplicate_object THEN NULL; WHEN unique_violation THEN NULL; END $$;`);
  await pool.query(`CREATE TABLE IF NOT EXISTS cross_pillar_merge_requests (
    id SERIAL PRIMARY KEY,
    source_interpretation_id INTEGER NOT NULL REFERENCES interpretations(id) ON DELETE CASCADE,
    source_pillar_id INTEGER NOT NULL REFERENCES pillars(id) ON DELETE CASCADE,
    target_pillar_id INTEGER NOT NULL REFERENCES pillars(id) ON DELETE CASCADE,
    requester_user_id INTEGER REFERENCES faculty_users(id) ON DELETE SET NULL,
    status cross_pillar_request_status NOT NULL DEFAULT 'proposed',
    note TEXT,
    decline_reason TEXT,
    reviewed_by_user_id INTEGER REFERENCES faculty_users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,
    resulting_source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
    resulting_interpretation_id INTEGER REFERENCES interpretations(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS cpmr_one_open_per_target
     ON cross_pillar_merge_requests (target_pillar_id, source_interpretation_id)
     WHERE status = 'proposed'`,
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
}

beforeAll(async () => {
  await ensureSchema();

  const { rows: pRows } = await pool.query<{ id: number }>(
    `INSERT INTO pillars (slug, name) VALUES ($1,$2),($3,$4) RETURNING id`,
    [
      `xp-a-${stamp}`,
      "Cross Pillar A",
      `xp-b-${stamp}`,
      "Cross Pillar B",
    ],
  );
  pillarAId = pRows[0].id;
  pillarBId = pRows[1].id;

  const { rows: uRows } = await pool.query<{ id: number }>(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name)
     VALUES ($1,$2,$3),($4,$5,$6) RETURNING id`,
    [
      `xp-a-clerk-${stamp}`,
      `xp-a-${stamp}@test.local`,
      "Steward A",
      `xp-b-clerk-${stamp}`,
      `xp-b-${stamp}@test.local`,
      "Steward B",
    ],
  );
  stewardAId = uRows[0].id;
  stewardBId = uRows[1].id;

  await pool.query(
    `INSERT INTO faculty_memberships (user_id, pillar_id, role)
     VALUES ($1,$2,'steward'),($3,$4,'steward')`,
    [stewardAId, pillarAId, stewardBId, pillarBId],
  );

  // Pillar A has an APPROVED source + interpretation with one embedded chunk.
  const { rows: sRows } = await pool.query<{ id: number }>(
    `INSERT INTO sources
       (pillar_id, kind, title, authors, year, status, uploaded_by_user_id,
        rights_basis, retention_status)
     VALUES ($1,'paper',$2,'Roberts',2021,'approved',$3,
             'permission', 'retained_with_rights') RETURNING id`,
    [pillarAId, "How tone shapes trust", stewardAId],
  );
  sourceAId = sRows[0].id;
  await pool.query(
    `INSERT INTO source_chunks (source_id, chunk_index, text, embedding, embedding_model)
     VALUES ($1,0,'chunk text',NULL,'test-model')`,
    [sourceAId],
  );
  const { rows: iRows } = await pool.query<{ id: number }>(
    `INSERT INTO interpretations
       (source_id, pillar_id, author_id, status, answer, interpretation, action, tags, approver_id, approved_at)
     VALUES ($1,$2,$3,'approved',$4,$5,$6,ARRAY['communication']::text[],$3,NOW())
     RETURNING id`,
    [
      sourceAId,
      pillarAId,
      stewardAId,
      "Warm openings raise trust.",
      "A warm first sentence measurably increases perceived trust.",
      "Open with one warm sentence before your ask.",
    ],
  );
  interpAId = iRows[0].id;
  await pool.query(
    `INSERT INTO interpretation_chunks
       (interpretation_id, source_id, pillar_id, chunk_index, text, embedding, embedding_model, priority)
     VALUES ($1,$2,$3,0,'interp chunk',NULL,'test-model',100)`,
    [interpAId, sourceAId, pillarAId],
  );

  app = (await import("../app")).default;
});

describe("cross-pillar browser (T4)", () => {
  test("pillars list carries approved counts + isMine for the viewer", async () => {
    stubFacultyUserId = stewardAId;
    const res = await request(app).get("/api/faculty/cross-pillar/pillars");
    expect(res.status).toBe(200);
    const a = res.body.pillars.find(
      (p: { id: number }) => p.id === pillarAId,
    );
    const b = res.body.pillars.find(
      (p: { id: number }) => p.id === pillarBId,
    );
    expect(a.approvedInterpretations).toBeGreaterThanOrEqual(1);
    expect(a.approvedSources).toBeGreaterThanOrEqual(1);
    expect(a.isMine).toBe(true);
    expect(b.isMine).toBe(false);
  });

  test("interpretations list returns approved items, filterable by pillar", async () => {
    stubFacultyUserId = stewardBId;
    const all = await request(app).get(
      "/api/faculty/cross-pillar/interpretations",
    );
    expect(all.status).toBe(200);
    const mine = all.body.interpretations.find(
      (i: { id: number }) => i.id === interpAId,
    );
    expect(mine).toBeTruthy();
    expect(mine.isMine).toBe(false); // viewer is steward B
    expect(mine.pillarName).toBe("Cross Pillar A");

    const filtered = await request(app).get(
      `/api/faculty/cross-pillar/interpretations?pillar=xp-a-${stamp}`,
    );
    expect(filtered.status).toBe(200);
    expect(
      filtered.body.interpretations.every(
        (i: { pillarId: number }) => i.pillarId === pillarAId,
      ),
    ).toBe(true);
  });
});

describe("merge requests (T6)", () => {
  let requestId = 0;

  test("non-steward of the target pillar cannot propose", async () => {
    // Steward A is not a steward of pillar B → cannot propose INTO B.
    stubFacultyUserId = stewardAId;
    const res = await request(app)
      .post("/api/faculty/cross-pillar/merge-requests")
      .send({ sourceInterpretationId: interpAId, targetPillarId: pillarBId });
    expect(res.status).toBe(403);
  });

  test("target-pillar steward proposes adoption", async () => {
    stubFacultyUserId = stewardBId;
    const res = await request(app)
      .post("/api/faculty/cross-pillar/merge-requests")
      .send({
        sourceInterpretationId: interpAId,
        targetPillarId: pillarBId,
        note: "Relevant to our pillar too.",
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("proposed");
    requestId = res.body.id;
  });

  test("rights-limited paper interpretations cannot be adopted", async () => {
    const { rows: sourceRows } = await pool.query<{ id: number }>(
      `INSERT INTO sources
        (pillar_id, kind, title, status, full_text, rights_basis, retention_status)
       VALUES ($1, 'paper', 'No-rights source', 'approved', 'Temporary paper text',
               'no_documented_full_text_rights', 'review_window')
       RETURNING id`,
      [pillarAId],
    );
    const { rows: interpRows } = await pool.query<{ id: number }>(
      `INSERT INTO interpretations
        (source_id, pillar_id, status, origin, answer, interpretation, approver_id, approved_at)
       VALUES ($1, $2, 'approved', 'palonur_ai', 'Approved original analysis',
               'Jamie-approved interpretation.', $3, NOW())
       RETURNING id`,
      [sourceRows[0].id, pillarAId, stewardAId],
    );
    stubFacultyUserId = stewardBId;
    const response = await request(app)
      .post("/api/faculty/cross-pillar/merge-requests")
      .send({
        sourceInterpretationId: interpRows[0].id,
        targetPillarId: pillarBId,
      });
    expect(response.status).toBe(409);
    expect(response.body.error).toContain("rights-limited");
  });

  test("a duplicate open request is rejected (409)", async () => {
    stubFacultyUserId = stewardBId;
    const res = await request(app)
      .post("/api/faculty/cross-pillar/merge-requests")
      .send({ sourceInterpretationId: interpAId, targetPillarId: pillarBId });
    expect(res.status).toBe(409);
  });

  test("inbox shows the request to the owning steward; outbox to the requester", async () => {
    stubFacultyUserId = stewardAId;
    const inbox = await request(app).get(
      "/api/faculty/cross-pillar/merge-requests?box=inbox",
    );
    expect(inbox.status).toBe(200);
    expect(
      inbox.body.requests.some((r: { id: number }) => r.id === requestId),
    ).toBe(true);

    stubFacultyUserId = stewardBId;
    const outbox = await request(app).get(
      "/api/faculty/cross-pillar/merge-requests?box=outbox",
    );
    expect(
      outbox.body.requests.some((r: { id: number }) => r.id === requestId),
    ).toBe(true);
  });

  test("only the owning steward may approve (not the requester)", async () => {
    stubFacultyUserId = stewardBId;
    const res = await request(app).post(
      `/api/faculty/cross-pillar/merge-requests/${requestId}/approve`,
    );
    expect(res.status).toBe(403);
  });

  test("owning steward approves → attributed copy lands in the target pillar", async () => {
    stubFacultyUserId = stewardAId;
    emailMocks.sendCrossPillarMergeOutcomeEmail.mockClear();
    const res = await request(app).post(
      `/api/faculty/cross-pillar/merge-requests/${requestId}/approve`,
    );
    expect(res.status).toBe(200);
    expect(res.body.resultingInterpretationId).toBeTruthy();

    // The requester (steward B) is emailed that their request was approved.
    expect(emailMocks.sendCrossPillarMergeOutcomeEmail).toHaveBeenCalledTimes(1);
    const approvedArgs =
      emailMocks.sendCrossPillarMergeOutcomeEmail.mock.calls[0][0];
    expect(approvedArgs).toMatchObject({
      to: `xp-b-${stamp}@test.local`,
      outcome: "approved",
      reviewerName: "Steward A",
    });

    const { rows } = await pool.query<{
      pillar_id: number;
      tags: string[];
      parent_interpretation_id: number | null;
      status: string;
    }>(
      `SELECT pillar_id, tags, parent_interpretation_id, status
       FROM interpretations WHERE id = $1`,
      [res.body.resultingInterpretationId],
    );
    expect(rows[0].pillar_id).toBe(pillarBId);
    expect(rows[0].status).toBe("approved");
    expect(rows[0].parent_interpretation_id).toBe(interpAId);
    expect(rows[0].tags).toContain(`adopted-from:xp-a-${stamp}`);

    // Cross-pillar adoption intentionally carries no paper text/chunks; only
    // the approved interpretation's chunks travel to the receiving pillar.
    const { rows: chunkRows } = await pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM source_chunks WHERE source_id = $1`,
      [res.body.resultingSourceId],
    );
    expect(Number(chunkRows[0].n)).toBe(0);
  });

  test("re-approving a resolved request is idempotent (409, no second copy)", async () => {
    const before = await pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM interpretations WHERE pillar_id = $1`,
      [pillarBId],
    );
    stubFacultyUserId = stewardAId;
    const res = await request(app).post(
      `/api/faculty/cross-pillar/merge-requests/${requestId}/approve`,
    );
    expect(res.status).toBe(409);
    const after = await pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM interpretations WHERE pillar_id = $1`,
      [pillarBId],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  test("approval re-check blocks a source converted to no-rights after proposal", async () => {
    const { rows: sourceRows } = await pool.query<{ id: number }>(
      `INSERT INTO sources
        (pillar_id, kind, title, status, full_text, rights_basis, retention_status)
       VALUES ($1, 'paper', 'Rights changed during review', 'approved', 'Retained temporarily',
               'permission', 'retained_with_rights')
       RETURNING id`,
      [pillarAId],
    );
    const sourceId = sourceRows[0].id;
    await pool.query(
      `INSERT INTO source_chunks (source_id, chunk_index, text, embedding_model)
       VALUES ($1, 0, 'Chunk that must never be copied after rights change.', 'test-model')`,
      [sourceId],
    );
    const { rows: interpRows } = await pool.query<{ id: number }>(
      `INSERT INTO interpretations
        (source_id, pillar_id, status, answer, interpretation, approver_id, approved_at)
       VALUES ($1, $2, 'approved', 'Original analysis', 'Approved analysis', $3, NOW())
       RETURNING id`,
      [sourceId, pillarAId, stewardAId],
    );
    stubFacultyUserId = stewardBId;
    const proposed = await request(app)
      .post("/api/faculty/cross-pillar/merge-requests")
      .send({
        sourceInterpretationId: interpRows[0].id,
        targetPillarId: pillarBId,
      });
    expect(proposed.status).toBe(201);

    // Model an administrative rights conversion/purge between proposal and
    // steward approval. The approve transaction must re-check it.
    await pool.query(
      `UPDATE sources
          SET rights_basis = 'no_documented_full_text_rights',
              retention_status = 'purged_no_full_text_rights',
              full_text = NULL
        WHERE id = $1`,
      [sourceId],
    );
    stubFacultyUserId = stewardAId;
    const approved = await request(app).post(
      `/api/faculty/cross-pillar/merge-requests/${proposed.body.id}/approve`,
    );
    expect(approved.status).toBe(409);
    const { rows: copies } = await pool.query<{ count: string }>(
      `SELECT count(*) FROM sources
        WHERE pillar_id = $1 AND title = 'Rights changed during review'`,
      [pillarBId],
    );
    expect(Number(copies[0].count)).toBe(0);
  });

  test("a completed adoption never retains paper text after the original rights change", async () => {
    const { rows: sourceRows } = await pool.query<{ id: number }>(
      `INSERT INTO sources
        (pillar_id, kind, title, status, full_text, rights_basis, retention_status)
       VALUES ($1, 'paper', 'Later rights conversion', 'approved', 'Original paper expression',
               'permission', 'retained_with_rights')
       RETURNING id`,
      [pillarAId],
    );
    const sourceId = sourceRows[0].id;
    await pool.query(
      `INSERT INTO source_chunks (source_id, chunk_index, text, embedding_model)
       VALUES ($1, 0, 'Original paper chunk.', 'test-model')`,
      [sourceId],
    );
    const { rows: interpRows } = await pool.query<{ id: number }>(
      `INSERT INTO interpretations
        (source_id, pillar_id, status, answer, interpretation, approver_id, approved_at)
       VALUES ($1, $2, 'approved', 'Original interpretation', 'Original approved analysis', $3, NOW())
       RETURNING id`,
      [sourceId, pillarAId, stewardAId],
    );
    stubFacultyUserId = stewardBId;
    const proposed = await request(app)
      .post("/api/faculty/cross-pillar/merge-requests")
      .send({
        sourceInterpretationId: interpRows[0].id,
        targetPillarId: pillarBId,
      });
    expect(proposed.status).toBe(201);
    stubFacultyUserId = stewardAId;
    const adopted = await request(app).post(
      `/api/faculty/cross-pillar/merge-requests/${proposed.body.id}/approve`,
    );
    expect(adopted.status).toBe(200);

    await pool.query(
      `UPDATE sources
          SET rights_basis = 'no_documented_full_text_rights',
              retention_status = 'purged_no_full_text_rights',
              full_text = NULL
        WHERE id = $1`,
      [sourceId],
    );
    const { rows: adoptedMaterial } = await pool.query<{
      full_text: string | null;
      chunks: string;
    }>(
      `SELECT s.full_text,
              (SELECT count(*) FROM source_chunks WHERE source_id = s.id) AS chunks
         FROM sources s WHERE s.id = $1`,
      [adopted.body.resultingSourceId],
    );
    expect(adoptedMaterial[0]).toEqual({ full_text: null, chunks: "0" });
  });

  test("declining a fresh request moves it to declined with a reason", async () => {
    // Open a new request (the previous one is approved), then decline it.
    stubFacultyUserId = stewardBId;
    const created = await request(app)
      .post("/api/faculty/cross-pillar/merge-requests")
      .send({ sourceInterpretationId: interpAId, targetPillarId: pillarBId });
    expect(created.status).toBe(201);
    const rid = created.body.id;

    stubFacultyUserId = stewardAId;
    emailMocks.sendCrossPillarMergeOutcomeEmail.mockClear();
    const declined = await request(app)
      .post(`/api/faculty/cross-pillar/merge-requests/${rid}/decline`)
      .send({ reason: "Out of scope for now." });
    expect(declined.status).toBe(200);

    const { rows } = await pool.query<{
      status: string;
      decline_reason: string;
    }>(
      `SELECT status, decline_reason FROM cross_pillar_merge_requests WHERE id = $1`,
      [rid],
    );
    expect(rows[0].status).toBe("declined");
    expect(rows[0].decline_reason).toBe("Out of scope for now.");

    // The requester (steward B) is emailed that their request was declined,
    // with the reason carried through.
    expect(emailMocks.sendCrossPillarMergeOutcomeEmail).toHaveBeenCalledTimes(1);
    const declinedArgs =
      emailMocks.sendCrossPillarMergeOutcomeEmail.mock.calls[0][0];
    expect(declinedArgs).toMatchObject({
      to: `xp-b-${stamp}@test.local`,
      outcome: "declined",
      declineReason: "Out of scope for now.",
    });
  });

  test("a non-approved interpretation cannot be adopted", async () => {
    // Create a proposed (not approved) interpretation in pillar A.
    const { rows: iRows } = await pool.query<{ id: number }>(
      `INSERT INTO interpretations
         (source_id, pillar_id, author_id, status, answer, interpretation)
       VALUES ($1,$2,$3,'proposed',$4,$5) RETURNING id`,
      [sourceAId, pillarAId, stewardAId, "draft answer", "draft body"],
    );
    stubFacultyUserId = stewardBId;
    const res = await request(app)
      .post("/api/faculty/cross-pillar/merge-requests")
      .send({ sourceInterpretationId: iRows[0].id, targetPillarId: pillarBId });
    expect(res.status).toBe(400);
  });

  test("approving a request whose source was archived after proposal fails (409, no copy, stays proposed)", async () => {
    // A fresh approved interpretation in pillar A → propose adopting it into B.
    const { rows: srcRows } = await pool.query<{ id: number }>(
      `INSERT INTO sources (pillar_id, kind, title, authors, year, status, uploaded_by_user_id)
       VALUES ($1,'paper',$2,'Drift',2022,'approved',$3) RETURNING id`,
      [pillarAId, `Drifting source ${stamp}`, stewardAId],
    );
    const { rows: iRows } = await pool.query<{ id: number }>(
      `INSERT INTO interpretations
         (source_id, pillar_id, author_id, status, answer, interpretation, approver_id, approved_at)
       VALUES ($1,$2,$3,'approved',$4,$5,$3,NOW()) RETURNING id`,
      [srcRows[0].id, pillarAId, stewardAId, "drift answer", "drift body"],
    );
    stubFacultyUserId = stewardBId;
    const created = await request(app)
      .post("/api/faculty/cross-pillar/merge-requests")
      .send({ sourceInterpretationId: iRows[0].id, targetPillarId: pillarBId });
    expect(created.status).toBe(201);
    const rid = created.body.id;

    // Source interpretation is archived AFTER the request was opened.
    await pool.query(
      `UPDATE interpretations SET status = 'archived' WHERE id = $1`,
      [iRows[0].id],
    );

    const before = await pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM interpretations WHERE pillar_id = $1`,
      [pillarBId],
    );
    stubFacultyUserId = stewardAId;
    const res = await request(app).post(
      `/api/faculty/cross-pillar/merge-requests/${rid}/approve`,
    );
    expect(res.status).toBe(409);

    // No copy landed in B, and the request remains 'proposed' (claim rolled back).
    const after = await pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM interpretations WHERE pillar_id = $1`,
      [pillarBId],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const { rows: mrRows } = await pool.query<{ status: string }>(
      `SELECT status FROM cross_pillar_merge_requests WHERE id = $1`,
      [rid],
    );
    expect(mrRows[0].status).toBe("proposed");
  });
});

describe("cross-steward discussion permissions (T5)", () => {
  let viewerUserId = 0; // only a 'viewer' membership → never a "steward somewhere"
  let adminUserId = 0; // platform admin, no membership
  let outsiderUserId = 0; // a real faculty user with zero memberships
  let proposedInterpId = 0; // a NON-approved interpretation in pillar A

  beforeAll(async () => {
    const { rows: uRows } = await pool.query<{ id: number }>(
      `INSERT INTO faculty_users (clerk_user_id, email, full_name, is_platform_admin)
       VALUES ($1,$2,$3,'false'),($4,$5,$6,'true'),($7,$8,$9,'false')
       RETURNING id`,
      [
        `xp-viewer-clerk-${stamp}`,
        `xp-viewer-${stamp}@test.local`,
        "Pure Viewer",
        `xp-admin-clerk-${stamp}`,
        `xp-admin-${stamp}@test.local`,
        "Platform Admin",
        `xp-outsider-clerk-${stamp}`,
        `xp-outsider-${stamp}@test.local`,
        "Outsider",
      ],
    );
    viewerUserId = uRows[0].id;
    adminUserId = uRows[1].id;
    outsiderUserId = uRows[2].id;

    // The viewer's only membership is a 'viewer' role on pillar B.
    await pool.query(
      `INSERT INTO faculty_memberships (user_id, pillar_id, role)
       VALUES ($1,$2,'viewer')`,
      [viewerUserId, pillarBId],
    );

    // A proposed (non-approved) interpretation in pillar A.
    const { rows: iRows } = await pool.query<{ id: number }>(
      `INSERT INTO interpretations
         (source_id, pillar_id, author_id, status, answer, interpretation)
       VALUES ($1,$2,$3,'proposed',$4,$5) RETURNING id`,
      [sourceAId, pillarAId, stewardAId, "draft answer", "draft body"],
    );
    proposedInterpId = iRows[0].id;
  });

  test("a steward of another pillar may post on an APPROVED interpretation", async () => {
    stubFacultyUserId = stewardBId; // steward of B, not a member of A
    const res = await request(app)
      .post(`/api/faculty/interpretations/${interpAId}/comments`)
      .send({ body: "Great framing — we see this in our pillar too." });
    expect(res.status).toBe(201);
  });

  test("a pure viewer (no steward role anywhere) cannot post cross-pillar", async () => {
    stubFacultyUserId = viewerUserId;
    const res = await request(app)
      .post(`/api/faculty/interpretations/${interpAId}/comments`)
      .send({ body: "I'd like to comment." });
    expect(res.status).toBe(403);
  });

  test("a platform admin may READ a cross-pillar thread but cannot post", async () => {
    stubFacultyUserId = adminUserId;
    const read = await request(app).get(
      `/api/faculty/interpretations/${interpAId}/comments`,
    );
    expect(read.status).toBe(200);
    const post = await request(app)
      .post(`/api/faculty/interpretations/${interpAId}/comments`)
      .send({ body: "Admin note." });
    expect(post.status).toBe(403);
  });

  test("a non-member, non-admin cannot read or post on a NON-approved interpretation", async () => {
    stubFacultyUserId = stewardBId; // steward elsewhere, but the item isn't approved
    const read = await request(app).get(
      `/api/faculty/interpretations/${proposedInterpId}/comments`,
    );
    expect(read.status).toBe(403);
    const post = await request(app)
      .post(`/api/faculty/interpretations/${proposedInterpId}/comments`)
      .send({ body: "Should be blocked." });
    expect(post.status).toBe(403);
  });

  test("a faculty user with zero memberships cannot post cross-pillar", async () => {
    stubFacultyUserId = outsiderUserId;
    const res = await request(app)
      .post(`/api/faculty/interpretations/${interpAId}/comments`)
      .send({ body: "Outsider comment." });
    expect(res.status).toBe(403);
  });

  test("the owning pillar's steward can post in their own thread", async () => {
    stubFacultyUserId = stewardAId; // member + steward of pillar A
    const res = await request(app)
      .post(`/api/faculty/interpretations/${interpAId}/comments`)
      .send({ body: "Thanks for the note." });
    expect(res.status).toBe(201);
  });
});

describe("admin-only pillar visibility", () => {
  let adminOnlyPillarId = 0;
  let adminStewardId = 0;

  beforeAll(async () => {
    const { rows: pRows } = await pool.query<{ id: number }>(
      `INSERT INTO pillars (slug, name) VALUES ($1,$2) RETURNING id`,
      [`xp-adminonly-${stamp}`, "Cross Pillar Admin Only"],
    );
    adminOnlyPillarId = pRows[0].id;

    // The ONLY steward of this pillar is a platform admin → "admin-only".
    const { rows: uRows } = await pool.query<{ id: number }>(
      `INSERT INTO faculty_users (clerk_user_id, email, full_name, is_platform_admin)
       VALUES ($1,$2,$3,'true') RETURNING id`,
      [
        `xp-adminonly-clerk-${stamp}`,
        `xp-adminonly-${stamp}@test.local`,
        "Admin Steward",
      ],
    );
    adminStewardId = uRows[0].id;
    await pool.query(
      `INSERT INTO faculty_memberships (user_id, pillar_id, role)
       VALUES ($1,$2,'steward')`,
      [adminStewardId, adminOnlyPillarId],
    );
  });

  test("a non-admin steward does NOT see an admin-only pillar", async () => {
    stubFacultyUserId = stewardBId; // non-admin steward of pillar B
    const res = await request(app).get("/api/faculty/cross-pillar/pillars");
    expect(res.status).toBe(200);
    expect(
      res.body.pillars.some(
        (p: { id: number }) => p.id === adminOnlyPillarId,
      ),
    ).toBe(false);
    // Sanity: it still sees a "real" pillar (B, stewarded by a non-admin).
    expect(
      res.body.pillars.some((p: { id: number }) => p.id === pillarBId),
    ).toBe(true);
  });

  test("a platform admin DOES see the admin-only pillar", async () => {
    stubFacultyUserId = adminStewardId; // platform admin
    const res = await request(app).get("/api/faculty/cross-pillar/pillars");
    expect(res.status).toBe(200);
    expect(
      res.body.pillars.some(
        (p: { id: number }) => p.id === adminOnlyPillarId,
      ),
    ).toBe(true);
  });
});

// This suite writes to the real dev database (tests run against the live
// DATABASE_URL). Without teardown, every run leaves "Cross Pillar A/B"
// stewards + pillars behind, which pollute the faculty admin roster. Remove
// this run's entire footprint, scoped tightly to this run's `stamp`.
afterAll(async () => {
  const pillarSlugLike = `xp-%-${stamp}`;
  const emailLike = `%-${stamp}@test.local`;
  await pool.query(
    `
    WITH tp AS (SELECT id FROM pillars WHERE slug LIKE $1),
         tu AS (SELECT id FROM faculty_users WHERE email LIKE $2),
         ti AS (SELECT id FROM interpretations WHERE pillar_id IN (SELECT id FROM tp)),
         ts AS (SELECT id FROM sources WHERE pillar_id IN (SELECT id FROM tp)),
         d1 AS (DELETE FROM interpretation_comments WHERE interpretation_id IN (SELECT id FROM ti)),
         d2 AS (DELETE FROM interpretation_versions WHERE interpretation_id IN (SELECT id FROM ti)),
         d3 AS (DELETE FROM cross_pillar_merge_requests
                  WHERE source_pillar_id IN (SELECT id FROM tp)
                     OR target_pillar_id IN (SELECT id FROM tp)),
         d4 AS (DELETE FROM interpretations WHERE id IN (SELECT id FROM ti)),
         d5 AS (DELETE FROM source_audit_log WHERE source_id IN (SELECT id FROM ts)),
         d6 AS (DELETE FROM source_chunks WHERE source_id IN (SELECT id FROM ts)),
         d7 AS (DELETE FROM source_versions WHERE source_id IN (SELECT id FROM ts)),
         d8 AS (DELETE FROM sources WHERE id IN (SELECT id FROM ts)),
         d9 AS (DELETE FROM eval_gradings WHERE grader_user_id IN (SELECT id FROM tu)),
         d10 AS (DELETE FROM faculty_memberships
                   WHERE user_id IN (SELECT id FROM tu)
                      OR pillar_id IN (SELECT id FROM tp)),
         d11 AS (DELETE FROM pillars WHERE id IN (SELECT id FROM tp))
    DELETE FROM faculty_users WHERE id IN (SELECT id FROM tu);
    `,
    [pillarSlugLike, emailLike],
  );
});
