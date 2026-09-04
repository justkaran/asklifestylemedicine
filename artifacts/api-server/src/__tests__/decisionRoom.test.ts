import { afterAll, beforeAll, describe, test, expect, vi } from "vitest";

// Deterministic Anthropic stub: the drafting chat asks for a JSON contract
// ({reply, pages}); the stub returns a canned draft for page 1 so we can
// assert the server applies page updates and persists them.
const anthropicMocks = vi.hoisted(() => ({
  create: vi.fn(async (_args: unknown) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          reply: "Drafted page 1 for you.",
          pages: { "1": "We recommend proceeding. The principal risk is X." },
        }),
      },
    ],
  })),
}));
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: anthropicMocks.create, stream: vi.fn() };
  }
  return { default: FakeAnthropic };
});

// Act as a specific signed-in faculty user per test.
let stubFacultyUserId = 0;

vi.mock("../middlewares/facultyAuth.js", async () => {
  const actual = await vi.importActual<
    typeof import("../middlewares/facultyAuth.js")
  >("../middlewares/facultyAuth.js");
  const { db, facultyUsersTable, facultyMembershipsTable } = await import(
    "@workspace/db"
  );
  const { eq } = await import("drizzle-orm");
  return {
    ...actual,
    requireFacultyAuth: async (
      req: { faculty?: unknown; log?: unknown },
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
      (req as { log: unknown }).log = {
        warn: () => {},
        info: () => {},
        error: () => {},
      };
      next();
    },
  };
});

import type { Express } from "express";
import request from "supertest";
import pool from "../lib/db.js";

let app: Express;
const stamp = `dr-${Date.now().toString(36)}`;
let adminId = 0;
let stewardId = 0;
let outsiderId = 0;

async function ensureSchema(): Promise<void> {
  // Tests import app.ts, not index.ts — boot DDL never runs. Self-provision.
  await pool.query(`
    DO $$ BEGIN
      CREATE TYPE decision_memo_status AS ENUM ('draft', 'shared', 'decided');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS decision_memos (
      id SERIAL PRIMARY KEY,
      owner_id INTEGER NOT NULL REFERENCES faculty_users(id),
      title TEXT NOT NULL,
      topic TEXT NOT NULL DEFAULT '',
      status decision_memo_status NOT NULL DEFAULT 'draft',
      decided_outcome TEXT,
      decided_at TIMESTAMPTZ,
      page1 TEXT NOT NULL DEFAULT '',
      page2 TEXT NOT NULL DEFAULT '',
      page3 TEXT NOT NULL DEFAULT '',
      page4 TEXT NOT NULL DEFAULT '',
      page5 TEXT NOT NULL DEFAULT '',
      page6 TEXT NOT NULL DEFAULT '',
      science_check JSONB,
      science_checked_at TIMESTAMPTZ,
      science_check_passed TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS decision_memo_shares (
      id SERIAL PRIMARY KEY,
      memo_id INTEGER NOT NULL REFERENCES decision_memos(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES faculty_users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS decision_memo_shares_unique ON decision_memo_shares (memo_id, user_id)`,
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS decision_memo_comments (
      id SERIAL PRIMARY KEY,
      memo_id INTEGER NOT NULL REFERENCES decision_memos(id) ON DELETE CASCADE,
      page INTEGER NOT NULL,
      author_id INTEGER NOT NULL REFERENCES faculty_users(id),
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

beforeAll(async () => {
  process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY ||= "stub-key";
  await ensureSchema();
  app = (await import("../app.js")).default;

  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name, is_platform_admin)
     VALUES ($1,$2,$3,'true'),($4,$5,$6,'false'),($7,$8,$9,'false')
     RETURNING id`,
    [
      `${stamp}-admin`,
      `${stamp}-admin@test.local`,
      "Decision Admin",
      `${stamp}-steward`,
      `${stamp}-steward@test.local`,
      "Shared Steward",
      `${stamp}-outsider`,
      `${stamp}-outsider@test.local`,
      "Outsider",
    ],
  );
  adminId = rows[0].id;
  stewardId = rows[1].id;
  outsiderId = rows[2].id;
});

afterAll(async () => {
  await pool.query(
    `DELETE FROM decision_memos WHERE owner_id IN ($1,$2,$3)`,
    [adminId, stewardId, outsiderId],
  );
  await pool.query(`DELETE FROM faculty_users WHERE clerk_user_id LIKE $1`, [
    `${stamp}-%`,
  ]);
});

describe("Decision Room", () => {
  let memoId = 0;

  test("non-admin cannot create a memo", async () => {
    stubFacultyUserId = stewardId;
    const res = await request(app)
      .post("/api/faculty/decision-room/memos")
      .send({ title: "Nope" });
    expect(res.status).toBe(403);
  });

  test("admin creates a memo (draft, editable)", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app)
      .post("/api/faculty/decision-room/memos")
      .send({ title: `Launch decision ${stamp}`, topic: "launch" });
    expect(res.status).toBe(200);
    expect(res.body.memo.status).toBe("draft");
    expect(res.body.memo.canEdit).toBe(true);
    expect(res.body.memo.pages).toHaveLength(6);
    memoId = res.body.memo.id;
  });

  test("unshared faculty cannot see the memo (404, not 403 — no existence leak)", async () => {
    stubFacultyUserId = outsiderId;
    const res = await request(app).get(
      `/api/faculty/decision-room/memos/${memoId}`,
    );
    expect(res.status).toBe(404);
    const list = await request(app).get("/api/faculty/decision-room/memos");
    expect(
      (list.body.memos as Array<{ id: number }>).some((m) => m.id === memoId),
    ).toBe(false);
  });

  test("owner edits pages directly", async () => {
    stubFacultyUserId = adminId;
    const pages = ["p1", "p2", "p3", "p4", "p5", "p6"];
    const res = await request(app)
      .patch(`/api/faculty/decision-room/memos/${memoId}`)
      .send({ pages });
    expect(res.status).toBe(200);
    expect(res.body.memo.pages).toEqual(pages);
  });

  test("chat drafts a page and persists it", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app)
      .post(`/api/faculty/decision-room/memos/${memoId}/chat`)
      .send({ message: "Draft page 1", history: [] });
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe("Drafted page 1 for you.");
    expect(res.body.updatedPages).toEqual([1]);
    expect(res.body.memo.pages[0]).toContain("We recommend proceeding");
    const { rows } = await pool.query(
      `SELECT page1 FROM decision_memos WHERE id = $1`,
      [memoId],
    );
    expect(rows[0].page1).toContain("We recommend proceeding");
  });

  test("sharing grants read + comment (not edit) and flips draft → shared", async () => {
    stubFacultyUserId = adminId;
    const share = await request(app)
      .put(`/api/faculty/decision-room/memos/${memoId}/shares`)
      .send({ userIds: [stewardId] });
    expect(share.status).toBe(200);
    expect(share.body.sharedWith).toEqual([stewardId]);

    stubFacultyUserId = stewardId;
    const read = await request(app).get(
      `/api/faculty/decision-room/memos/${memoId}`,
    );
    expect(read.status).toBe(200);
    expect(read.body.memo.canEdit).toBe(false);
    expect(read.body.memo.status).toBe("shared");

    const edit = await request(app)
      .patch(`/api/faculty/decision-room/memos/${memoId}`)
      .send({ pages: ["x", "x", "x", "x", "x", "x"] });
    expect(edit.status).toBe(403);
    const chat = await request(app)
      .post(`/api/faculty/decision-room/memos/${memoId}/chat`)
      .send({ message: "hack" });
    expect(chat.status).toBe(403);

    const comment = await request(app)
      .post(`/api/faculty/decision-room/memos/${memoId}/comments`)
      .send({ page: 2, body: "Consider the seasonality." });
    expect(comment.status).toBe(200);
    expect(comment.body.comment.page).toBe(2);

    const list = await request(app).get("/api/faculty/decision-room/memos");
    expect(
      (list.body.memos as Array<{ id: number }>).some((m) => m.id === memoId),
    ).toBe(true);
  });

  test("editing pages invalidates a prior science check", async () => {
    stubFacultyUserId = adminId;
    // Simulate a completed science check.
    await pool.query(
      `UPDATE decision_memos
       SET science_check = '[]'::jsonb, science_checked_at = NOW(), science_check_passed = 'true'
       WHERE id = $1`,
      [memoId],
    );
    // Direct page edit clears it.
    const edit = await request(app)
      .patch(`/api/faculty/decision-room/memos/${memoId}`)
      .send({ pages: ["changed", "p2", "p3", "p4", "p5", "p6"] });
    expect(edit.status).toBe(200);
    expect(edit.body.memo.scienceCheck).toBeNull();
    expect(edit.body.memo.scienceCheckPassed).toBeNull();
    expect(edit.body.memo.scienceCheckedAt).toBeNull();

    // Chat drafting that changes a page clears it too.
    await pool.query(
      `UPDATE decision_memos
       SET science_check = '[]'::jsonb, science_checked_at = NOW(), science_check_passed = 'true'
       WHERE id = $1`,
      [memoId],
    );
    const chat = await request(app)
      .post(`/api/faculty/decision-room/memos/${memoId}/chat`)
      .send({ message: "Draft page 1", history: [] });
    expect(chat.status).toBe(200);
    expect(chat.body.updatedPages).toEqual([1]);
    expect(chat.body.memo.scienceCheck).toBeNull();
    expect(chat.body.memo.scienceCheckPassed).toBeNull();

    // A no-op save (identical pages) does NOT clear a valid check.
    await pool.query(
      `UPDATE decision_memos
       SET science_check = '[]'::jsonb, science_checked_at = NOW(), science_check_passed = 'true'
       WHERE id = $1`,
      [memoId],
    );
    const current = await request(app).get(
      `/api/faculty/decision-room/memos/${memoId}`,
    );
    const noop = await request(app)
      .patch(`/api/faculty/decision-room/memos/${memoId}`)
      .send({ pages: current.body.memo.pages });
    expect(noop.status).toBe(200);
    expect(noop.body.memo.scienceCheckPassed).toBe(true);
  });

  test("search matches title/topic", async () => {
    stubFacultyUserId = adminId;
    const hit = await request(app).get(
      `/api/faculty/decision-room/memos?q=${encodeURIComponent(stamp)}`,
    );
    expect(
      (hit.body.memos as Array<{ id: number }>).some((m) => m.id === memoId),
    ).toBe(true);
    const miss = await request(app).get(
      `/api/faculty/decision-room/memos?q=zzz-never-matches-${stamp}`,
    );
    expect(
      (miss.body.memos as Array<{ id: number }>).some((m) => m.id === memoId),
    ).toBe(false);
  });

  test("deciding requires an outcome and records it", async () => {
    stubFacultyUserId = adminId;
    const missing = await request(app)
      .post(`/api/faculty/decision-room/memos/${memoId}/status`)
      .send({ status: "decided" });
    expect(missing.status).toBe(400);

    const decided = await request(app)
      .post(`/api/faculty/decision-room/memos/${memoId}/status`)
      .send({ status: "decided", decidedOutcome: "Approved with a phased rollout." });
    expect(decided.status).toBe(200);
    expect(decided.body.memo.status).toBe("decided");
    expect(decided.body.memo.decidedOutcome).toBe(
      "Approved with a phased rollout.",
    );
    expect(decided.body.memo.decidedAt).toBeTruthy();
  });

  test("shared member cannot change status or shares", async () => {
    stubFacultyUserId = stewardId;
    const status = await request(app)
      .post(`/api/faculty/decision-room/memos/${memoId}/status`)
      .send({ status: "draft" });
    expect(status.status).toBe(403);
    const shares = await request(app)
      .put(`/api/faculty/decision-room/memos/${memoId}/shares`)
      .send({ userIds: [outsiderId] });
    expect(shares.status).toBe(403);
  });

  test("owner deletes the memo", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app).delete(
      `/api/faculty/decision-room/memos/${memoId}`,
    );
    expect(res.status).toBe(200);
    const gone = await request(app).get(
      `/api/faculty/decision-room/memos/${memoId}`,
    );
    expect(gone.status).toBe(404);
  });
});
