import { beforeAll, afterAll, describe, test, expect, vi } from "vitest";
import { ensureTalkCrawlSchema } from "./testHelpers.js";

// Route/lib modules read these once at module-init time, so set them before
// the app is imported.
vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-crawl-talks-secret";
});

// Deterministic, network-free embeddings so the interpretation-approval path's
// `embedTexts` call doesn't hit OpenAI. The exact vector doesn't matter — the
// approval-hook tests only assert on the persisted talk-source status.
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
        v[7] = 1;
        return v;
      }),
    ),
  };
});

// The crawl orchestrator is fire-and-forget and reaches out to Firecrawl /
// Scribe / Anthropic. The route tests only care about the HTTP contract
// (gating, validation, the run row), so stub the worker entry point.
const startCrawlRunMock = vi.hoisted(() => ({
  fn: vi.fn(async (_args: unknown) => 4242),
  collect: vi.fn(
    async (_id: number): Promise<{ ok: boolean; reason?: string }> => ({
      ok: true,
    }),
  ),
  retry: vi.fn(async (_id: number) => ({ ok: true })),
  discard: vi.fn(async (_id: number) => ({ ok: true })),
}));
vi.mock("../lib/crawlTalks.js", () => ({
  startCrawlRun: startCrawlRunMock.fn,
  startCollectPhase: startCrawlRunMock.collect,
  retryCandidate: startCrawlRunMock.retry,
  discardCandidate: startCrawlRunMock.discard,
}));

// Keep discovery deterministically "off" so the warning surface + response
// flag are stable regardless of whether FIRECRAWL_API_KEY is set in CI.
vi.mock("../lib/firecrawl.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/firecrawl.js")>(
      "../lib/firecrawl.js",
    );
  return {
    ...actual,
    isFirecrawlConfigured: () => false,
  };
});

// Bypass Clerk by stubbing the faculty auth middleware (same pattern as the
// other faculty route tests). `stubFacultyUserId` lets each test act as a
// specific signed-in faculty member; the real membership rows still load so
// the pillar-steward governance check runs unchanged.
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
let pillarId = 0;
let adminId = 0; // platform admin (the operator who triggers a crawl)
let stewardId = 0; // pillar steward (approves interpretations)
let speakerId = 0; // faculty member whose talks get crawled

beforeAll(async () => {
  await ensureTalkCrawlSchema();
  app = (await import("../app.js")).default;

  const pillar = await pool.query(
    `INSERT INTO pillars (slug, name) VALUES ($1, $2) RETURNING id`,
    [`crawl-pillar-${stamp}`, "Crawl Test Pillar"],
  );
  pillarId = pillar.rows[0].id;

  const admin = await pool.query(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name, is_platform_admin)
     VALUES ($1, $2, $3, 'true') RETURNING id`,
    [`clerk-admin-${stamp}`, `admin-${stamp}@example.com`, "Ada Admin"],
  );
  adminId = admin.rows[0].id;

  const steward = await pool.query(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name, is_platform_admin)
     VALUES ($1, $2, $3, 'false') RETURNING id`,
    [`clerk-steward-${stamp}`, `steward-${stamp}@example.com`, "Stu Steward"],
  );
  stewardId = steward.rows[0].id;
  await pool.query(
    `INSERT INTO faculty_memberships (user_id, pillar_id, role) VALUES ($1, $2, 'steward')`,
    [stewardId, pillarId],
  );

  const speaker = await pool.query(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name, is_platform_admin)
     VALUES ($1, $2, $3, 'false') RETURNING id`,
    [`clerk-speaker-${stamp}`, `speaker-${stamp}@example.com`, "Dr Talker"],
  );
  speakerId = speaker.rows[0].id;
  await pool.query(
    `INSERT INTO faculty_memberships (user_id, pillar_id, role) VALUES ($1, $2, 'contributor')`,
    [speakerId, pillarId],
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM crawl_runs WHERE pillar_id = $1`, [pillarId]);
  await pool.query(`DELETE FROM sources WHERE pillar_id = $1`, [pillarId]);
  await pool.query(`DELETE FROM pillars WHERE id = $1`, [pillarId]);
  // Memberships cascade with the pillar; the faculty_users rows are not
  // pillar-scoped, so delete the exact rows this suite created or they leak
  // into the roster (Task #208).
  await pool.query(`DELETE FROM faculty_users WHERE id = ANY($1::int[])`, [
    [adminId, stewardId, speakerId],
  ]);
});

describe("admin crawl routes — gating + contract", () => {
  test("POST /crawls rejects a non-admin faculty member with 403", async () => {
    stubFacultyUserId = stewardId;
    const res = await request(app)
      .post("/api/faculty/admin/crawls")
      .send({
        facultyUserId: speakerId,
        pillarId,
        rightsBasis: "permission",
      });
    expect(res.status).toBe(403);
    expect(startCrawlRunMock.fn).not.toHaveBeenCalled();
  });

  test("GET /crawls rejects a non-admin faculty member with 403", async () => {
    stubFacultyUserId = stewardId;
    const res = await request(app).get("/api/faculty/admin/crawls");
    expect(res.status).toBe(403);
  });

  test("POST /crawls 404s for an unknown faculty member", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app)
      .post("/api/faculty/admin/crawls")
      .send({
        facultyUserId: 99999999,
        pillarId,
        rightsBasis: "permission",
      });
    expect(res.status).toBe(404);
  });

  test("POST /crawls starts a run for a valid faculty + pillar", async () => {
    stubFacultyUserId = adminId;
    startCrawlRunMock.fn.mockClear();
    const res = await request(app)
      .post("/api/faculty/admin/crawls")
      .send({
        facultyUserId: speakerId,
        pillarId,
        rightsBasis: "permission",
      });
    expect(res.status).toBe(201);
    expect(res.body.runId).toBe(4242);
    expect(res.body.speakerName).toBe("Dr Talker");
    expect(res.body.firecrawlConfigured).toBe(false);
    expect(startCrawlRunMock.fn).toHaveBeenCalledTimes(1);
    expect(startCrawlRunMock.fn).toHaveBeenCalledWith(
      expect.objectContaining({
        facultyUserId: speakerId,
        pillarId,
        speakerName: "Dr Talker",
        startedByUserId: adminId,
      }),
    );
  });

  test("POST /crawls/:id/collect rejects a non-admin with 403", async () => {
    stubFacultyUserId = stewardId;
    startCrawlRunMock.collect.mockClear();
    const res = await request(app).post("/api/faculty/admin/crawls/5/collect");
    expect(res.status).toBe(403);
    expect(startCrawlRunMock.collect).not.toHaveBeenCalled();
  });

  test("POST /crawls/:id/collect dispatches the collect phase for an admin", async () => {
    stubFacultyUserId = adminId;
    startCrawlRunMock.collect.mockClear();
    const res = await request(app).post("/api/faculty/admin/crawls/5/collect");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(startCrawlRunMock.collect).toHaveBeenCalledWith(5);
  });

  test("POST /crawls/:id/collect surfaces a 409 when not in review", async () => {
    stubFacultyUserId = adminId;
    startCrawlRunMock.collect.mockResolvedValueOnce({
      ok: false,
      reason: "This run is not awaiting review.",
    });
    const res = await request(app).post("/api/faculty/admin/crawls/5/collect");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/awaiting review/i);
  });

  test("PATCH /crawls/candidates/:id rejects a non-admin with 403", async () => {
    stubFacultyUserId = stewardId;
    startCrawlRunMock.retry.mockClear();
    startCrawlRunMock.discard.mockClear();
    const res = await request(app)
      .patch("/api/faculty/admin/crawls/candidates/1")
      .send({ action: "discard" });
    expect(res.status).toBe(403);
    expect(startCrawlRunMock.discard).not.toHaveBeenCalled();
  });

  test("PATCH /crawls/candidates/:id validates the action", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app)
      .patch("/api/faculty/admin/crawls/candidates/1")
      .send({ action: "nope" });
    expect(res.status).toBe(400);
  });

  test("PATCH /crawls/candidates/:id dispatches retry/discard for an admin", async () => {
    stubFacultyUserId = adminId;
    startCrawlRunMock.retry.mockClear();
    startCrawlRunMock.discard.mockClear();

    const retryRes = await request(app)
      .patch("/api/faculty/admin/crawls/candidates/7")
      .send({ action: "retry" });
    expect(retryRes.status).toBe(200);
    expect(startCrawlRunMock.retry).toHaveBeenCalledWith(7);

    const discardRes = await request(app)
      .patch("/api/faculty/admin/crawls/candidates/9")
      .send({ action: "discard" });
    expect(discardRes.status).toBe(200);
    expect(startCrawlRunMock.discard).toHaveBeenCalledWith(9);
  });

  test("crawls-targets lists faculty with their pillars for the admin", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app).get("/api/faculty/admin/crawls-targets");
    expect(res.status).toBe(200);
    const target = (res.body.targets as Array<{ id: number; pillars: unknown[] }>).find(
      (t) => t.id === speakerId,
    );
    expect(target).toBeTruthy();
    expect(target!.pillars).toContainEqual(
      expect.objectContaining({ id: pillarId }),
    );
  });
});

describe("steward approval promotes the linked talk source (Task #168)", () => {
  /** Insert a draft source of the given kind + a proposed interpretation on it. */
  async function seedDraft(
    kind: "talk" | "paper",
    rightsBasis: "permission" | "no_documented_full_text_rights" = "permission",
  ): Promise<{
    sourceId: number;
    interpId: number;
  }> {
    const src = await pool.query(
      `INSERT INTO sources
         (pillar_id, kind, title, status, source_url, authors, journal, year,
          rights_basis, retention_status, full_text)
       VALUES ($1, $2, $3, 'draft', $4, $5, $6, $7, $8::source_rights_basis,
          CASE WHEN $8::source_rights_basis = 'no_documented_full_text_rights'
            THEN 'review_window'::source_retention_status
            ELSE 'retained_with_rights'::source_retention_status END,
          'A raw crawl transcript that must not survive a no-rights approval.')
       RETURNING id`,
      [
        pillarId,
        kind,
        `${kind} on circadian light`,
        "https://example.com/talk",
        "Dr Talker",
        "The Sleep Podcast",
        2024,
        rightsBasis,
      ],
    );
    const sourceId = src.rows[0].id;
    const interp = await pool.query(
      `INSERT INTO interpretations
        (source_id, pillar_id, author_id, status, answer, interpretation)
       VALUES ($1, $2, $3, 'proposed', $4, $5) RETURNING id`,
      [
        sourceId,
        pillarId,
        speakerId,
        "Morning light advances the circadian clock.",
        "In this talk the speaker explains that timed morning light exposure shifts circadian phase earlier.",
      ],
    );
    return { sourceId, interpId: interp.rows[0].id };
  }

  test("approving a talk interpretation flips its draft source to approved + audit row", async () => {
    const { sourceId, interpId } = await seedDraft("talk");
    stubFacultyUserId = stewardId;
    const res = await request(app)
      .post(`/api/faculty/interpretations/${interpId}/transition`)
      .send({ status: "approved" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");

    const src = await pool.query(
      `SELECT status FROM sources WHERE id = $1`,
      [sourceId],
    );
    expect(src.rows[0].status).toBe("approved");

    const audit = await pool.query(
      `SELECT action, to_status FROM source_audit_log
        WHERE source_id = $1 AND action = 'approved'`,
      [sourceId],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].action).toBe("approved");
    expect(audit.rows[0].to_status).toBe("approved");
  });

  test("approving a NON-talk interpretation leaves its source status untouched", async () => {
    const { sourceId, interpId } = await seedDraft("paper");
    stubFacultyUserId = stewardId;
    const res = await request(app)
      .post(`/api/faculty/interpretations/${interpId}/transition`)
      .send({ status: "approved" });
    expect(res.status).toBe(200);

    const src = await pool.query(
      `SELECT status FROM sources WHERE id = $1`,
      [sourceId],
    );
    // The talk-only hook must NOT fire for papers — they keep the existing
    // two-step (source-approve + interpretation-approve) flow.
    expect(src.rows[0].status).toBe("draft");

    const audit = await pool.query(
      `SELECT 1 FROM source_audit_log
        WHERE source_id = $1 AND action = 'approved'`,
      [sourceId],
    );
    expect(audit.rowCount).toBe(0);
  });

  test("approving a no-rights talk atomically purges its transcript material", async () => {
    const { sourceId, interpId } = await seedDraft(
      "talk",
      "no_documented_full_text_rights",
    );
    await pool.query(
      `INSERT INTO source_chunks (source_id, chunk_index, text, embedding_model)
       VALUES ($1, 0, 'raw transcript passage', 'Xenova/gte-small')`,
      [sourceId],
    );
    // Simulate the narrow worker window before it has written source_id on the
    // candidate. The purge must still clear an unlinked transcript matching the
    // canonical source URL.
    const run = await pool.query(
      `INSERT INTO crawl_runs
         (faculty_user_id, pillar_id, started_by_user_id, speaker_name, rights_basis, status)
       VALUES ($1, $2, $3, 'Dr Talker', 'no_documented_full_text_rights', 'done')
       RETURNING id`,
      [speakerId, pillarId, adminId],
    );
    const candidateId = run.rows[0].id;
    await pool.query(
      `INSERT INTO crawl_candidates
         (crawl_run_id, title, source_type, primary_url, status, transcript)
       VALUES ($1, 'Talk awaiting link', 'podcast', 'https://example.com/talk',
               'transcribed', 'Raw transcript before the source link was saved.')`,
      [candidateId],
    );
    stubFacultyUserId = stewardId;
    const res = await request(app)
      .post(`/api/faculty/interpretations/${interpId}/transition`)
      .send({ status: "approved" });
    expect(res.status).toBe(200);
    const source = await pool.query(
      `SELECT status, retention_status, full_text FROM sources WHERE id = $1`,
      [sourceId],
    );
    expect(source.rows[0]).toMatchObject({
      status: "approved",
      retention_status: "purged_no_full_text_rights",
      full_text: null,
    });
    const chunks = await pool.query(
      `SELECT 1 FROM source_chunks WHERE source_id = $1`,
      [sourceId],
    );
    expect(chunks.rowCount).toBe(0);
    const candidate = await pool.query(
      `SELECT transcript FROM crawl_candidates WHERE crawl_run_id = $1`,
      [candidateId],
    );
    expect(candidate.rows[0].transcript).toBeNull();
  });
});
