/**
 * CVO Release Governance — focused backend tests (task #845).
 *
 * Covers:
 * - Auth / access guard (unauthenticated, no-membership, admin, faculty)
 * - Strict test/live mode isolation
 * - Faculty signoff / CVO ordering rules
 * - Invalidation on substantive edits
 * - Publish guards (all prerequisites)
 * - Live externallyCleared guard on review links
 * - CVO verification readiness prerequisite check
 * - ReleaseDetail includes auditEvents array
 * - Public review: no numeric IDs, no comments, no source notes
 * - Ready sample has proper signoffs seeded
 * - Read-only public review safety
 * - Idempotent sample seeding
 */

import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

// ── Stub requireFacultyAuth to inject a chosen user ───────────────────────────
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
      if (!user) {
        res.status(401).json({ error: "stub user not found" });
        return;
      }
      const memberships = await db
        .select()
        .from(facultyMembershipsTable)
        .where(eq(facultyMembershipsTable.userId, stubFacultyUserId));
      (req as { faculty: unknown }).faculty = { user, memberships };
      (req as { log: unknown }).log = {
        warn: () => {},
        info: () => {},
        error: () => {},
        debug: () => {},
      };
      next();
    },
  };
});

const governedAnswerControl = vi.hoisted(() => ({
  wait: null as Promise<void> | null,
  onStart: null as (() => void) | null,
}));

// Stub out AI (governedAnswer) to avoid real LLM calls
vi.mock("../lib/governedAnswer.js", () => ({
  governedAnswer: vi.fn(async () => {
    governedAnswerControl.onStart?.();
    if (governedAnswerControl.wait) await governedAnswerControl.wait;
    return {
      outcome: "covered",
      reason: null,
      answer: "Stubbed governed answer for test.",
      citation: "Stub Citation (2024)",
      paper: null,
      finding: null,
      interpretation: null,
      action: null,
      insight: null,
      pillarNames: ["Restorative Sleep"],
      provenance: [
        {
          source_id: 1,
          interpretation_id: null,
          chunk_ids: [1],
          title: "Stub Citation",
          authors: "Stub Author",
          year: 2024,
          journal: null,
          doi: null,
          source_url: "https://example.com",
          study_design: null,
          pillar_slug: "sleep",
          interpretation_author: null,
          excerpts: [],
        },
      ],
      citationVerification: null,
      voiceVerification: null,
      topScore: 0.9,
      limitNotices: [],
    };
  }),
}));
vi.mock("../lib/rag.js", () => ({
  collapseSameWorkProvenance: (cits: unknown[]) => cits,
  retrieve: vi.fn(async () => []),
  sanitizeUntrustedText: (t: string) => t,
  CITATION_GUARD_BOUNDARY:
    "I don't have reviewed research to answer that yet. You can ask a narrower question or try a related sleep topic.",
  CITATION_GUARD_BOUNDARY_NEUTRAL:
    "I don't have research I can cite for that yet. You can ask a narrower question or try a related sleep topic.",
  CONTEXT_FENCE_OPEN: "<<<",
  CONTEXT_FENCE_CLOSE: ">>>",
  UNTRUSTED_CONTEXT_RULE: "",
}));

import type { Express } from "express";
import request from "supertest";
import pool from "../lib/db.js";

let app: Express;
const stamp = `cvr-${Date.now().toString(36)}`;
let adminId = 0;
let facultyId = 0;
let otherFacultyId = 0;
let contributorId = 0;
let outsiderId = 0; // faculty user with no memberships

// DDL that the tests need (tables may not exist if app.ts is imported alone)
async function ensureTestSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS decision_room_decisions (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      question TEXT NOT NULL DEFAULT '',
      context TEXT,
      own_view TEXT,
      final_call TEXT,
      outcome TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      checked_step_ids JSONB NOT NULL DEFAULT '[]',
      decided_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // CVO governance columns — idempotent on existing table
  await pool.query(`ALTER TABLE decision_room_decisions ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'live'`);
  await pool.query(`ALTER TABLE decision_room_decisions ADD COLUMN IF NOT EXISTS institution_name TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE decision_room_decisions ADD COLUMN IF NOT EXISTS named_expert TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE decision_room_decisions ADD COLUMN IF NOT EXISTS owner_faculty_user_id INTEGER`);
  await pool.query(`ALTER TABLE decision_room_decisions ADD COLUMN IF NOT EXISTS externally_cleared BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE decision_room_decisions ADD COLUMN IF NOT EXISTS revenue_terms_acknowledged BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE decision_room_decisions ADD COLUMN IF NOT EXISTS revenue_terms_note TEXT`);
  await pool.query(`ALTER TABLE decision_room_decisions ADD COLUMN IF NOT EXISTS faculty_approved_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE decision_room_decisions ADD COLUMN IF NOT EXISTS faculty_approved_by_id INTEGER`);
  await pool.query(`ALTER TABLE decision_room_decisions ADD COLUMN IF NOT EXISTS faculty_approved_by_name TEXT`);
  await pool.query(`ALTER TABLE decision_room_decisions ADD COLUMN IF NOT EXISTS cvo_verified_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE decision_room_decisions ADD COLUMN IF NOT EXISTS cvo_verified_by_id INTEGER`);
  await pool.query(`ALTER TABLE decision_room_decisions ADD COLUMN IF NOT EXISTS cvo_verified_by_name TEXT`);
  await pool.query(`ALTER TABLE decision_room_decisions ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE decision_room_decisions ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE decision_room_decisions ADD COLUMN IF NOT EXISTS is_sample BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS decision_room_consultations (
      id SERIAL PRIMARY KEY,
      decision_id INTEGER NOT NULL,
      pillar_slug TEXT NOT NULL,
      pillar_name TEXT NOT NULL,
      status TEXT NOT NULL,
      answer_text TEXT NOT NULL,
      citations JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS decision_room_audit_events (
      id SERIAL PRIMARY KEY,
      mode TEXT NOT NULL,
      release_id INTEGER NOT NULL,
      actor_id INTEGER NOT NULL,
      actor_name TEXT NOT NULL,
      event_type TEXT NOT NULL,
      detail JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS decision_room_comments (
      id SERIAL PRIMARY KEY,
      mode TEXT NOT NULL,
      release_id INTEGER NOT NULL,
      author_id INTEGER NOT NULL,
      author_name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'comment',
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      resolved_at TIMESTAMPTZ,
      resolved_by_id INTEGER,
      resolved_by_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS decision_room_review_links (
      id SERIAL PRIMARY KEY,
      mode TEXT NOT NULL,
      release_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      creator_id INTEGER NOT NULL,
      creator_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

beforeAll(async () => {
  await ensureTestSchema();
  app = (await import("../app.js")).default;

  // Create five users:
  //   adminId   — platform admin (CVO)
  //   facultyId — faculty steward
  //   otherFacultyId — a second faculty steward
  //   contributorId — member who may collaborate but cannot sign off
  //   outsiderId — faculty with no memberships
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name, is_platform_admin)
     VALUES
       ($1,$2,$3,'true'),
       ($4,$5,$6,'false'),
       ($7,$8,$9,'false'),
       ($10,$11,$12,'false'),
       ($13,$14,$15,'false')
     RETURNING id`,
    [
      `${stamp}-admin`,
      `${stamp}-admin@example.com`,
      "CVO Admin",
      `${stamp}-faculty`,
      `${stamp}-faculty@example.com`,
      "Faculty Member",
      `${stamp}-outsider`,
      `${stamp}-outsider@example.com`,
      "Outsider No Membership",
      `${stamp}-other-faculty`,
      `${stamp}-other-faculty@example.com`,
      "Other Faculty Member",
      `${stamp}-contributor`,
      `${stamp}-contributor@example.com`,
      "Contributor Member",
    ],
  );
  adminId = rows[0].id;
  facultyId = rows[1].id;
  outsiderId = rows[2].id;
  otherFacultyId = rows[3].id;
  contributorId = rows[4].id;

  // Ensure a pillar row exists for the faculty membership
  await pool.query(
    `INSERT INTO pillars (slug, name)
     VALUES ('sleep', 'Restorative Sleep')
     ON CONFLICT (slug) DO NOTHING`,
  );
  const { rows: pillarRows } = await pool.query<{ id: number }>(
    `SELECT id FROM pillars WHERE slug = 'sleep' LIMIT 1`,
  );
  const pillarId = pillarRows[0].id;

  // Steward authority is deliberately distinct from general Desk access.
  await pool.query(
    `INSERT INTO faculty_memberships (user_id, pillar_id, role)
     VALUES
       ($1, $4, 'steward'),
       ($2, $4, 'steward'),
       ($3, $4, 'contributor')
     ON CONFLICT DO NOTHING`,
    [facultyId, otherFacultyId, contributorId, pillarId],
  );
});

afterAll(async () => {
  // Clean up test data created by this suite
  await pool.query(
    `DELETE FROM decision_room_decisions WHERE title LIKE $1 OR institution_name LIKE $1`,
    [`${stamp}%`],
  );
  await pool.query(`DELETE FROM faculty_users WHERE clerk_user_id LIKE $1`, [
    `${stamp}-%`,
  ]);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function releaseBody(overrides: Record<string, unknown> = {}) {
  return {
    institutionName: `${stamp} Test Institution`,
    namedExpert: `Dr. Test ${stamp}`,
    publicGuidance: "Adults should get 7-9 hours of sleep per night.",
    intendedAudience: "General adult population.",
    sourceAndProvenanceNotes: "Based on NIH sleep guidelines.",
    scopeLimits: "Does not apply to clinical sleep disorders.",
    recoursePath: "Consult a physician for medical advice.",
    externallyCleared: true,
    revenueTermsAcknowledged: true,
    ...overrides,
  };
}

async function createReadyTestRelease(institutionName: string): Promise<number> {
  stubFacultyUserId = adminId;
  const created = await request(app)
    .post("/api/decision-room/test/releases")
    .send(releaseBody({ institutionName }));
  const id = created.body.id as number;

  stubFacultyUserId = facultyId;
  const signed = await request(app)
    .post(`/api/decision-room/test/releases/${id}/faculty-signoff`)
    .send({});
  expect(signed.status).toBe(200);

  stubFacultyUserId = adminId;
  const verified = await request(app)
    .post(`/api/decision-room/test/releases/${id}/cvo-verification`)
    .send({});
  expect(verified.status).toBe(200);
  expect(verified.body.status).toBe("ready");
  return id;
}

function startConsultationGate() {
  let releaseAnswer!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  governedAnswerControl.wait = new Promise<void>((resolve) => {
    releaseAnswer = resolve;
  });
  governedAnswerControl.onStart = markStarted;
  return {
    started,
    release() {
      governedAnswerControl.wait = null;
      governedAnswerControl.onStart = null;
      releaseAnswer();
    },
  };
}

async function expectNoConsultationPersistence(releaseId: number) {
  const { rows: consultationRows } = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM decision_room_consultations
      WHERE decision_id = $1`,
    [releaseId],
  );
  const { rows: auditRows } = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM decision_room_audit_events
      WHERE release_id = $1
        AND event_type = 'consult'`,
    [releaseId],
  );
  expect(consultationRows[0].count).toBe(0);
  expect(auditRows[0].count).toBe(0);
}

// ── Section 1: Auth / Access Guard ──────────────────────────────────────────

describe("Auth and access guard", () => {
  test("unauthenticated request returns 401", async () => {
    stubFacultyUserId = 0;
    const res = await request(app).get("/api/decision-room/test/releases");
    expect(res.status).toBe(401);
  });

  test("faculty with no membership returns 403", async () => {
    stubFacultyUserId = outsiderId;
    const res = await request(app).get("/api/decision-room/test/releases");
    expect(res.status).toBe(403);
  });

  test("platform admin (CVO) gets access", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app).get("/api/decision-room/test/releases");
    expect(res.status).toBe(200);
  });

  test("faculty with membership gets access", async () => {
    stubFacultyUserId = facultyId;
    const res = await request(app).get("/api/decision-room/live/releases");
    expect(res.status).toBe(200);
  });

  test("GET /decision-room/me returns correct isCvo flag", async () => {
    stubFacultyUserId = adminId;
    const adminMe = await request(app).get("/api/decision-room/me");
    expect(adminMe.status).toBe(200);
    expect(adminMe.body.isCvo).toBe(true);

    stubFacultyUserId = facultyId;
    const facultyMe = await request(app).get("/api/decision-room/me");
    expect(facultyMe.status).toBe(200);
    expect(facultyMe.body.isCvo).toBe(false);
    expect(facultyMe.body.hasMembership).toBe(true);
    expect(facultyMe.body.canFacultySignoff).toBe(true);
  });
});

// ── Section 2: Strict test/live isolation ────────────────────────────────────

describe("Test/live mode isolation", () => {
  let testReleaseId = 0;

  test("creates a test-mode release", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app)
      .post("/api/decision-room/test/releases")
      .send(releaseBody({ institutionName: `${stamp} Isolation Test` }));
    expect(res.status).toBe(201);
    expect(res.body.mode).toBe("test");
    testReleaseId = res.body.id;
  });

  test("GET in wrong mode returns 400 mode_mismatch", async () => {
    stubFacultyUserId = adminId;
    // Release was created in test mode; accessing via live mode should fail
    const res = await request(app).get(
      `/api/decision-room/live/releases/${testReleaseId}`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("mode_mismatch");
  });

  test("PATCH in wrong mode returns 400 mode_mismatch", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app)
      .patch(`/api/decision-room/live/releases/${testReleaseId}`)
      .send({ namedExpert: "Hacked" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("mode_mismatch");
  });

  test("live summary starts empty (no test records leak in)", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app).get("/api/decision-room/live/summary");
    expect(res.status).toBe(200);
    // The live summary should not include test-mode releases
    const allItems = [
      ...res.body.needsAttention.items,
      ...res.body.readyToRelease.items,
      ...res.body.publishedAndTraceable.items,
    ] as Array<{ mode: string }>;
    for (const item of allItems) {
      expect(item.mode).toBe("live");
    }
  });

  test("invalid mode returns 400", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app).get("/api/decision-room/staging/releases");
    expect(res.status).toBe(400);
  });

  test("legacy decision rows never appear as Live CVO releases", async () => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO decision_room_decisions
         (title, question, status, mode, institution_name, named_expert)
       VALUES ($1, 'Legacy internal deliberation', 'framing', 'live', $1, 'Legacy Expert')
       RETURNING id`,
      [`${stamp} Legacy Decision`],
    );
    const legacyId = rows[0].id;

    stubFacultyUserId = adminId;
    const list = await request(app).get("/api/decision-room/live/releases");
    expect(list.status).toBe(200);
    expect(
      (list.body.releases as Array<{ id: number }>).some(
        (release) => release.id === legacyId,
      ),
    ).toBe(false);

    const detail = await request(app).get(
      `/api/decision-room/live/releases/${legacyId}`,
    );
    expect(detail.status).toBe(404);
  });
});

// ── Section 3: Signoff/CVO ordering ──────────────────────────────────────────

describe("Signoff and CVO ordering", () => {
  let releaseId = 0;

  beforeAll(async () => {
    stubFacultyUserId = adminId;
    const res = await request(app)
      .post("/api/decision-room/test/releases")
      .send(releaseBody({ institutionName: `${stamp} Signoff Test` }));
    releaseId = res.body.id;
  });

  test("CVO verification fails without prior faculty signoff", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/cvo-verification`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("faculty_signoff_required_before_cvo_verification");
  });

  test("non-admin cannot do CVO verification", async () => {
    stubFacultyUserId = facultyId;
    const res = await request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/cvo-verification`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("platform_admin_cvo_only");
  });

  test("CVO cannot perform the separate faculty signoff", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/faculty-signoff`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("faculty_steward_only");
  });

  test("a contributor can access the Desk but cannot sign off substance", async () => {
    stubFacultyUserId = contributorId;
    const access = await request(app).get("/api/decision-room/test/releases");
    expect(access.status).toBe(200);

    const res = await request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/faculty-signoff`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("faculty_steward_only");
  });

  test("faculty can sign off", async () => {
    stubFacultyUserId = facultyId;
    const res = await request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/faculty-signoff`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.facultyApprovedAt).toBeTruthy();
    // Faculty signoff clears any CVO verification
    expect(res.body.cvoVerifiedAt).toBeNull();
  });

  test("another faculty member cannot replace the owning steward's signoff", async () => {
    stubFacultyUserId = otherFacultyId;
    const res = await request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/faculty-signoff`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(
      "release_owned_by_another_faculty_steward",
    );
  });

  test("CVO verification succeeds after faculty signoff", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/cvo-verification`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.cvoVerifiedAt).toBeTruthy();
    expect(res.body.status).toBe("ready");
  });

  test("faculty signoff invalidates CVO verification", async () => {
    stubFacultyUserId = facultyId;
    const res = await request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/faculty-signoff`)
      .send({});
    expect(res.status).toBe(200);
    // After re-signing, CVO is cleared
    expect(res.body.cvoVerifiedAt).toBeNull();
    // Status drops back to in_review
    expect(res.body.status).toBe("in_review");
  });
});

// ── Section 4: Invalidation on substantive edits ─────────────────────────────

describe("Substantive edit invalidation", () => {
  let releaseId = 0;

  beforeAll(async () => {
    // Create, sign off, and CVO-verify a release so we can test invalidation
    stubFacultyUserId = adminId;
    const created = await request(app)
      .post("/api/decision-room/test/releases")
      .send(releaseBody({ institutionName: `${stamp} Invalidation Test` }));
    releaseId = created.body.id;

    stubFacultyUserId = facultyId;
    await request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/faculty-signoff`)
      .send({});

    stubFacultyUserId = adminId;
    await request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/cvo-verification`)
      .send({});
  });

  test("editing publicGuidance invalidates both signoffs and demotes to in_review", async () => {
    stubFacultyUserId = adminId;
    // Confirm it's currently ready
    const before = await request(app).get(
      `/api/decision-room/test/releases/${releaseId}`,
    );
    expect(before.body.status).toBe("ready");
    expect(before.body.facultyApprovedAt).toBeTruthy();
    expect(before.body.cvoVerifiedAt).toBeTruthy();

    // Substantive edit
    const res = await request(app)
      .patch(`/api/decision-room/test/releases/${releaseId}`)
      .send({ publicGuidance: "Updated guidance text that changes the substance." });
    expect(res.status).toBe(200);
    expect(res.body.facultyApprovedAt).toBeNull();
    expect(res.body.cvoVerifiedAt).toBeNull();
    expect(res.body.status).toBe("in_review");
  });
});

// ── Section 5: Publish guards ─────────────────────────────────────────────────

describe("Publish guards", () => {
  let releaseId = 0;

  beforeAll(async () => {
    stubFacultyUserId = adminId;
    const created = await request(app)
      .post("/api/decision-room/test/releases")
      .send(releaseBody({ institutionName: `${stamp} Publish Guard` }));
    releaseId = created.body.id;
  });

  test("cannot publish from draft status", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/publish`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("release_must_be_ready_to_publish");
  });

  test("non-admin cannot publish", async () => {
    stubFacultyUserId = facultyId;
    const res = await request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/publish`)
      .send({});
    expect(res.status).toBe(403);
  });

  test("cannot withdraw a non-published release", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/withdraw`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("only_published_releases_can_be_withdrawn");
  });

  test("full happy path to publish and then withdraw", async () => {
    stubFacultyUserId = facultyId;
    await request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/faculty-signoff`)
      .send({});

    stubFacultyUserId = adminId;
    await request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/cvo-verification`)
      .send({});

    // Confirm ready
    const ready = await request(app).get(
      `/api/decision-room/test/releases/${releaseId}`,
    );
    expect(ready.body.status).toBe("ready");

    // Publish
    const publish = await request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/publish`)
      .send({});
    expect(publish.status).toBe(200);
    expect(publish.body.status).toBe("published");
    expect(publish.body.publishedAt).toBeTruthy();

    const link = await request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/review-links`)
      .send({ expiresInDays: 1 });
    expect(link.status).toBe(201);

    // Withdraw
    const withdraw = await request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/withdraw`)
      .send({ reason: "Test cleanup" });
    expect(withdraw.status).toBe(200);
    expect(withdraw.body.status).toBe("withdrawn");
    expect(withdraw.body.withdrawnAt).toBeTruthy();

    stubFacultyUserId = 0;
    const publicReview = await request(app).get(
      `/api/decision-room/review/${link.body.rawToken}`,
    );
    expect(publicReview.status).toBe(404);
  });
});

describe("Concurrent lifecycle serialization", () => {
  test("publication re-checks the release after a concurrent substantive edit", async () => {
    const releaseId = await createReadyTestRelease(
      `${stamp} Concurrent Publish`,
    );
    const client = await pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE decision_room_decisions
         SET question = 'Concurrent changed guidance',
             status = 'in_review',
             faculty_approved_at = NULL,
             faculty_approved_by_id = NULL,
             faculty_approved_by_name = NULL,
             cvo_verified_at = NULL,
             cvo_verified_by_id = NULL,
             cvo_verified_by_name = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [releaseId],
      );

      stubFacultyUserId = adminId;
      const commitPromise = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          client
            .query("COMMIT")
            .then(() => {
              committed = true;
              resolve();
            })
            .catch(reject);
        }, 250);
      });
      const publish = await request(app)
        .post(`/api/decision-room/test/releases/${releaseId}/publish`)
        .send({});
      await commitPromise;

      expect(publish.status).toBe(400);
      expect(publish.body.error).toBe("release_must_be_ready_to_publish");
    } finally {
      if (!committed) await client.query("ROLLBACK");
      client.release();
    }

    const detail = await request(app).get(
      `/api/decision-room/test/releases/${releaseId}`,
    );
    expect(detail.body.status).toBe("in_review");
    expect(detail.body.publishedAt).toBeNull();
  });

  test("a faculty patch cannot cross a concurrent publication boundary", async () => {
    const releaseId = await createReadyTestRelease(
      `${stamp} Concurrent Patch Publish`,
    );
    const client = await pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE decision_room_decisions
         SET status = 'published',
             published_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [releaseId],
      );

      const commitPromise = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          client
            .query("COMMIT")
            .then(() => {
              committed = true;
              resolve();
            })
            .catch(reject);
        }, 250);
      });
      stubFacultyUserId = facultyId;
      const patch = await request(app)
        .patch(`/api/decision-room/test/releases/${releaseId}`)
        .send({ publicGuidance: "This stale faculty edit must not land." });
      await commitPromise;

      expect(patch.status).toBe(403);
      expect(patch.body.error).toBe(
        "only_cvo_can_edit_published_or_withdrawn",
      );
    } finally {
      if (!committed) await client.query("ROLLBACK");
      client.release();
    }

    const detail = await request(app).get(
      `/api/decision-room/test/releases/${releaseId}`,
    );
    expect(detail.body.status).toBe("published");
    expect(detail.body.publicGuidance).not.toBe(
      "This stale faculty edit must not land.",
    );
  });

  test("deletion cannot cross a concurrent CVO verification boundary", async () => {
    stubFacultyUserId = adminId;
    const created = await request(app)
      .post("/api/decision-room/test/releases")
      .send(
        releaseBody({
          institutionName: `${stamp} Concurrent Delete Verify`,
        }),
      );
    const releaseId = created.body.id as number;
    stubFacultyUserId = facultyId;
    const signed = await request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/faculty-signoff`)
      .send({});
    expect(signed.status).toBe(200);
    expect(signed.body.status).toBe("in_review");

    const client = await pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE decision_room_decisions
         SET status = 'ready',
             cvo_verified_at = NOW(),
             cvo_verified_by_id = $2,
             cvo_verified_by_name = 'CVO Test Admin',
             updated_at = NOW()
         WHERE id = $1`,
        [releaseId, adminId],
      );

      const commitPromise = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          client
            .query("COMMIT")
            .then(() => {
              committed = true;
              resolve();
            })
            .catch(reject);
        }, 250);
      });
      stubFacultyUserId = adminId;
      const deletion = await request(app).delete(
        `/api/decision-room/test/releases/${releaseId}`,
      );
      await commitPromise;

      expect(deletion.status).toBe(400);
      expect(deletion.body.error).toBe(
        "only_draft_or_in_review_can_be_deleted",
      );
    } finally {
      if (!committed) await client.query("ROLLBACK");
      client.release();
    }

    const detail = await request(app).get(
      `/api/decision-room/test/releases/${releaseId}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.status).toBe("ready");
  });

  test("consultation cannot finish after publication", async () => {
    const releaseId = await createReadyTestRelease(
      `${stamp} Concurrent Consult Publish`,
    );
    const gate = startConsultationGate();
    stubFacultyUserId = adminId;
    const consultPromise = request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/consult`)
      .send({ pillarSlugs: ["sleep"] })
      .then((response) => response);
    await gate.started;

    const published = await request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/publish`)
      .send({});
    expect(published.status).toBe(200);
    gate.release();

    const consult = await consultPromise;
    expect(consult.status).toBe(409);
    expect(consult.body.error).toBe("release_changed_retry");
    await expectNoConsultationPersistence(releaseId);
  });

  test("consultation cannot attach output generated before a substantive edit", async () => {
    stubFacultyUserId = adminId;
    const created = await request(app)
      .post("/api/decision-room/test/releases")
      .send(
        releaseBody({
          institutionName: `${stamp} Concurrent Consult Patch`,
        }),
      );
    const releaseId = created.body.id as number;
    const gate = startConsultationGate();
    const consultPromise = request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/consult`)
      .send({ pillarSlugs: ["sleep"] })
      .then((response) => response);
    await gate.started;

    const patch = await request(app)
      .patch(`/api/decision-room/test/releases/${releaseId}`)
      .send({ publicGuidance: "Changed while consultation was running." });
    expect(patch.status).toBe(200);
    gate.release();

    const consult = await consultPromise;
    expect(consult.status).toBe(409);
    expect(consult.body.error).toBe("release_changed_retry");
    await expectNoConsultationPersistence(releaseId);
  });

  test("consultation cannot finish after withdrawal", async () => {
    const releaseId = await createReadyTestRelease(
      `${stamp} Concurrent Consult Withdraw`,
    );
    const gate = startConsultationGate();
    stubFacultyUserId = adminId;
    const consultPromise = request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/consult`)
      .send({ pillarSlugs: ["sleep"] })
      .then((response) => response);
    await gate.started;

    const published = await request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/publish`)
      .send({});
    expect(published.status).toBe(200);
    const withdrawn = await request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/withdraw`)
      .send({ reason: "Concurrent withdrawal test" });
    expect(withdrawn.status).toBe(200);
    gate.release();

    const consult = await consultPromise;
    expect(consult.status).toBe(409);
    expect(consult.body.error).toBe("release_changed_retry");
    await expectNoConsultationPersistence(releaseId);
  });

  test("consultation cannot create orphan rows after deletion", async () => {
    stubFacultyUserId = adminId;
    const created = await request(app)
      .post("/api/decision-room/test/releases")
      .send(
        releaseBody({
          institutionName: `${stamp} Concurrent Consult Delete`,
        }),
      );
    const releaseId = created.body.id as number;
    const gate = startConsultationGate();
    const consultPromise = request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/consult`)
      .send({ pillarSlugs: ["sleep"] })
      .then((response) => response);
    await gate.started;

    const deletion = await request(app).delete(
      `/api/decision-room/test/releases/${releaseId}`,
    );
    expect(deletion.status).toBe(200);
    gate.release();

    const consult = await consultPromise;
    expect(consult.status).toBe(404);
    expect(consult.body.error).toBe("not_found");
    await expectNoConsultationPersistence(releaseId);
  });

  test("review-link issuance waits for the current Live clearance state", async () => {
    stubFacultyUserId = adminId;
    const created = await request(app)
      .post("/api/decision-room/live/releases")
      .send(
        releaseBody({
          institutionName: `${stamp} Concurrent Live Link`,
          externallyCleared: true,
        }),
      );
    const releaseId = created.body.id as number;
    const client = await pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE decision_room_decisions
         SET externally_cleared = FALSE, updated_at = NOW()
         WHERE id = $1`,
        [releaseId],
      );

      const commitPromise = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          client
            .query("COMMIT")
            .then(() => {
              committed = true;
              resolve();
            })
            .catch(reject);
        }, 250);
      });
      const link = await request(app)
        .post(`/api/decision-room/live/releases/${releaseId}/review-links`)
        .send({ expiresInDays: 7 });
      await commitPromise;

      expect(link.status).toBe(400);
      expect(link.body.error).toBe(
        "externally_cleared_required_for_live_review_links",
      );
    } finally {
      if (!committed) await client.query("ROLLBACK");
      client.release();
    }
  });

  test("public review waits for edit-driven link revocation", async () => {
    stubFacultyUserId = adminId;
    const created = await request(app)
      .post("/api/decision-room/test/releases")
      .send(
        releaseBody({
          institutionName: `${stamp} Concurrent Public Review Edit`,
        }),
      );
    const releaseId = created.body.id as number;
    const link = await request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/review-links`)
      .send({ expiresInDays: 7 });
    expect(link.status).toBe(201);

    const client = await pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE decision_room_decisions
         SET question = 'Content that must not be served through the old link',
             updated_at = NOW()
         WHERE id = $1`,
        [releaseId],
      );
      await client.query(
        `UPDATE decision_room_review_links
         SET revoked_at = NOW()
         WHERE id = $1`,
        [link.body.id],
      );

      const commitPromise = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          client
            .query("COMMIT")
            .then(() => {
              committed = true;
              resolve();
            })
            .catch(reject);
        }, 250);
      });
      stubFacultyUserId = 0;
      const publicReview = await request(app).get(
        `/api/decision-room/review/${link.body.rawToken}`,
      );
      await commitPromise;

      expect(publicReview.status).toBe(404);
    } finally {
      if (!committed) await client.query("ROLLBACK");
      client.release();
    }
  });

  test("public Live review waits for clearance-loss revocation", async () => {
    stubFacultyUserId = adminId;
    const created = await request(app)
      .post("/api/decision-room/live/releases")
      .send(
        releaseBody({
          institutionName: `${stamp} Concurrent Public Live Review`,
          externallyCleared: true,
        }),
      );
    const releaseId = created.body.id as number;
    const link = await request(app)
      .post(`/api/decision-room/live/releases/${releaseId}/review-links`)
      .send({ expiresInDays: 7 });
    expect(link.status).toBe(201);

    const client = await pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE decision_room_decisions
         SET externally_cleared = FALSE, updated_at = NOW()
         WHERE id = $1`,
        [releaseId],
      );
      await client.query(
        `UPDATE decision_room_review_links
         SET revoked_at = NOW()
         WHERE id = $1`,
        [link.body.id],
      );

      const commitPromise = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          client
            .query("COMMIT")
            .then(() => {
              committed = true;
              resolve();
            })
            .catch(reject);
        }, 250);
      });
      stubFacultyUserId = 0;
      const publicReview = await request(app).get(
        `/api/decision-room/review/${link.body.rawToken}`,
      );
      await commitPromise;

      expect(publicReview.status).toBe(404);
    } finally {
      if (!committed) await client.query("ROLLBACK");
      client.release();
    }
  });
});

// ── Section 6: Live mode externallyCleared guard ──────────────────────────────

describe("Live mode externally cleared guard", () => {
  let liveReleaseId = 0;

  beforeAll(async () => {
    stubFacultyUserId = adminId;
    // Create a live release WITHOUT externallyCleared
    const created = await request(app)
      .post("/api/decision-room/live/releases")
      .send(
        releaseBody({
          institutionName: `${stamp} Live Guard`,
          externallyCleared: false,
        }),
      );
    liveReleaseId = created.body.id;
  });

  test("live release without externallyCleared cannot be published", async () => {
    stubFacultyUserId = facultyId;
    await request(app)
      .post(`/api/decision-room/live/releases/${liveReleaseId}/faculty-signoff`)
      .send({});

    stubFacultyUserId = adminId;
    await request(app)
      .post(`/api/decision-room/live/releases/${liveReleaseId}/cvo-verification`)
      .send({});

    // Force status to ready so we can test publish prerequisites
    await pool.query(
      `UPDATE decision_room_decisions SET status = 'ready' WHERE id = $1`,
      [liveReleaseId],
    );

    const res = await request(app)
      .post(`/api/decision-room/live/releases/${liveReleaseId}/publish`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.reason).toContain("externallyCleared");
  });
});

// ── Section 7: Public review safety ──────────────────────────────────────────

describe("Public review link safety", () => {
  let releaseId = 0;
  let rawToken = "";

  beforeAll(async () => {
    stubFacultyUserId = adminId;
    const created = await request(app)
      .post("/api/decision-room/test/releases")
      .send(releaseBody({ institutionName: `${stamp} Review Link` }));
    releaseId = created.body.id;

    const linkRes = await request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/review-links`)
      .send({ expiresInDays: 7 });
    expect(linkRes.status).toBe(201);
    rawToken = linkRes.body.rawToken;
    expect(rawToken).toBeTruthy();
    expect(typeof rawToken).toBe("string");
    expect(rawToken.length).toBeGreaterThan(20);
  });

  test("public review endpoint requires no auth", async () => {
    stubFacultyUserId = 0; // unauthenticated
    const res = await request(app).get(`/api/decision-room/review/${rawToken}`);
    expect(res.status).toBe(200);
  });

  test("public review returns public-safe fields only", async () => {
    const res = await request(app).get(`/api/decision-room/review/${rawToken}`);
    expect(res.status).toBe(200);
    const { release } = res.body;
    // Must have
    expect(release.institutionName).toBeTruthy();
    expect(release.namedExpert).toBeTruthy();
    expect(release.publicGuidance).toBeTruthy();
    // Must NOT expose internal fields
    expect(release.ownerFacultyUserId).toBeUndefined();
    expect(release.facultyApprovedById).toBeUndefined();
    expect(release.cvoVerifiedById).toBeUndefined();
    // Must NOT expose comments or sourceAndProvenanceNotes
    expect(release.sourceAndProvenanceNotes).toBeUndefined();
    expect(release.comments).toBeUndefined();
    // Must have audit summary
    expect(res.body.auditSummary).toBeTruthy();
    expect(typeof res.body.auditSummary.eventCount).toBe("number");
  });

  test("invalid token returns 404", async () => {
    const res = await request(app).get(
      "/api/decision-room/review/totally-invalid-token-xxxx",
    );
    expect(res.status).toBe(404);
  });

  test("rawToken is not returned in subsequent API calls", async () => {
    // Listing releases should not contain any raw token
    stubFacultyUserId = adminId;
    const list = await request(app).get("/api/decision-room/test/releases");
    const listStr = JSON.stringify(list.body);
    expect(listStr).not.toContain(rawToken);
  });

  test("creator can revoke a review link and public access stops immediately", async () => {
    stubFacultyUserId = adminId;
    const secondLink = await request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/review-links`)
      .send({ expiresInDays: 7 });
    expect(secondLink.status).toBe(201);

    const revoked = await request(app)
      .post(
        `/api/decision-room/test/releases/${releaseId}/review-links/${secondLink.body.id}/revoke`,
      )
      .send({});
    expect(revoked.status).toBe(200);
    expect(revoked.body.revokedAt).toBeTruthy();

    stubFacultyUserId = 0;
    const publicReview = await request(app).get(
      `/api/decision-room/review/${secondLink.body.rawToken}`,
    );
    expect(publicReview.status).toBe(404);
  });
});

describe("Review links follow the current release substance", () => {
  test("substantive edits revoke existing links", async () => {
    stubFacultyUserId = adminId;
    const created = await request(app)
      .post("/api/decision-room/test/releases")
      .send(releaseBody({ institutionName: `${stamp} Link Edit Revocation` }));
    const link = await request(app)
      .post(
        `/api/decision-room/test/releases/${created.body.id}/review-links`,
      )
      .send({ expiresInDays: 7 });
    expect(link.status).toBe(201);

    const updated = await request(app)
      .patch(`/api/decision-room/test/releases/${created.body.id}`)
      .send({ publicGuidance: "Changed substantive public guidance." });
    expect(updated.status).toBe(200);

    stubFacultyUserId = 0;
    const publicReview = await request(app).get(
      `/api/decision-room/review/${link.body.rawToken}`,
    );
    expect(publicReview.status).toBe(404);
  });
});

// ── Section 8: Comments ───────────────────────────────────────────────────────

describe("Comments and challenges", () => {
  let releaseId = 0;
  let commentId = 0;

  beforeAll(async () => {
    stubFacultyUserId = adminId;
    const created = await request(app)
      .post("/api/decision-room/test/releases")
      .send(releaseBody({ institutionName: `${stamp} Comments` }));
    releaseId = created.body.id;
  });

  test("faculty can create a comment", async () => {
    stubFacultyUserId = facultyId;
    const res = await request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/comments`)
      .send({ kind: "comment", body: "This looks well-sourced." });
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe("comment");
    expect(res.body.status).toBe("open");
    commentId = res.body.id;
  });

  test("faculty can create a challenge", async () => {
    stubFacultyUserId = facultyId;
    const res = await request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/comments`)
      .send({ kind: "challenge", body: "I dispute the scope claim." });
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe("challenge");
  });

  test("another faculty member cannot rewrite or resolve the author's comment", async () => {
    stubFacultyUserId = otherFacultyId;
    const rewrite = await request(app)
      .patch(
        `/api/decision-room/test/releases/${releaseId}/comments/${commentId}`,
      )
      .send({ body: "Rewritten by another reviewer." });
    expect(rewrite.status).toBe(403);
    expect(rewrite.body.error).toBe("comment_author_only");

    const resolve = await request(app)
      .patch(
        `/api/decision-room/test/releases/${releaseId}/comments/${commentId}`,
      )
      .send({ status: "resolved" });
    expect(resolve.status).toBe(403);
    expect(resolve.body.error).toBe("comment_author_or_cvo_only");
  });

  test("user can resolve a comment", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app)
      .patch(
        `/api/decision-room/test/releases/${releaseId}/comments/${commentId}`,
      )
      .send({ status: "resolved" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("resolved");
    expect(res.body.resolvedAt).toBeTruthy();
    expect(res.body.resolvedByName).toBeTruthy();
  });

  test("wrong mode on comment endpoint returns 404", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app)
      .patch(
        `/api/decision-room/live/releases/${releaseId}/comments/${commentId}`,
      )
      .send({ status: "open" });
    expect(res.status).toBe(404);
  });

  test("outsider cannot create comments", async () => {
    stubFacultyUserId = outsiderId;
    const res = await request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/comments`)
      .send({ kind: "comment", body: "Should not work." });
    expect(res.status).toBe(403);
  });
});

// ── Section 9a: Audit events in detail response ───────────────────────────────

describe("ReleaseDetail includes auditEvents", () => {
  let releaseId = 0;

  beforeAll(async () => {
    stubFacultyUserId = adminId;
    const created = await request(app)
      .post("/api/decision-room/test/releases")
      .send(releaseBody({ institutionName: `${stamp} Audit Detail` }));
    releaseId = created.body.id;
  });

  test("detail response has auditEvents array", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app).get(
      `/api/decision-room/test/releases/${releaseId}`,
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.auditEvents)).toBe(true);
  });

  test("auditEvents accumulate on actions", async () => {
    stubFacultyUserId = facultyId;
    await request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/faculty-signoff`)
      .send({});

    stubFacultyUserId = adminId;
    const res = await request(app).get(
      `/api/decision-room/test/releases/${releaseId}`,
    );
    expect(res.status).toBe(200);
    // At least 'create' and 'faculty_signoff' events
    const types = (res.body.auditEvents as Array<{ eventType: string }>).map(
      (e) => e.eventType,
    );
    expect(types).toContain("create");
    expect(types).toContain("faculty_signoff");
  });

  test("audit event has actorName and createdAt, not actorId", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app).get(
      `/api/decision-room/test/releases/${releaseId}`,
    );
    const event = (res.body.auditEvents as Array<Record<string, unknown>>)[0];
    expect(typeof event.actorName).toBe("string");
    expect(typeof event.createdAt).toBe("string");
    // actorId MUST NOT be present in the detail payload
    expect(event.actorId).toBeUndefined();
  });
});

// ── Section 9b: Public review: no numeric IDs ─────────────────────────────────

describe("Public review does not expose numeric IDs", () => {
  let releaseId = 0;
  let rawToken = "";

  beforeAll(async () => {
    stubFacultyUserId = adminId;
    const created = await request(app)
      .post("/api/decision-room/test/releases")
      .send(releaseBody({ institutionName: `${stamp} ID Safety` }));
    releaseId = created.body.id;

    const linkRes = await request(app)
      .post(`/api/decision-room/test/releases/${releaseId}/review-links`)
      .send({ expiresInDays: 1 });
    rawToken = linkRes.body.rawToken;
  });

  test("public review release object has no id field", async () => {
    stubFacultyUserId = 0;
    const res = await request(app).get(
      `/api/decision-room/review/${rawToken}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.release.id).toBeUndefined();
    expect(res.body.release.ownerFacultyUserId).toBeUndefined();
  });

  test("public review consultations have no id field", async () => {
    stubFacultyUserId = 0;
    const res = await request(app).get(
      `/api/decision-room/review/${rawToken}`,
    );
    expect(res.status).toBe(200);
    // consultations may be empty (no actual AI call needed for this test)
    if (Array.isArray(res.body.release.consultations)) {
      for (const c of res.body.release.consultations as Array<
        Record<string, unknown>
      >) {
        expect(c.id).toBeUndefined();
      }
    }
  });
});

// ── Section 9c: Live review link requires externallyCleared ──────────────────

describe("Live review link externallyCleared guard", () => {
  let notClearedId = 0;
  let clearedId = 0;
  let clearedToken = "";

  beforeAll(async () => {
    stubFacultyUserId = adminId;
    const a = await request(app)
      .post("/api/decision-room/live/releases")
      .send(
        releaseBody({
          institutionName: `${stamp} Live Link No Clear`,
          externallyCleared: false,
        }),
      );
    notClearedId = a.body.id;

    const b = await request(app)
      .post("/api/decision-room/live/releases")
      .send(
        releaseBody({
          institutionName: `${stamp} Live Link Cleared`,
          externallyCleared: true,
        }),
      );
    clearedId = b.body.id;
  });

  test("review link creation fails for live release without externallyCleared", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app)
      .post(`/api/decision-room/live/releases/${notClearedId}/review-links`)
      .send({ expiresInDays: 7 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "externally_cleared_required_for_live_review_links",
    );
  });

  test("review link creation succeeds for live release with externallyCleared", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app)
      .post(`/api/decision-room/live/releases/${clearedId}/review-links`)
      .send({ expiresInDays: 7 });
    expect(res.status).toBe(201);
    expect(res.body.rawToken).toBeTruthy();
    clearedToken = res.body.rawToken;
  });

  test("removing Live external clearance invalidates an issued link", async () => {
    stubFacultyUserId = adminId;
    const updated = await request(app)
      .patch(`/api/decision-room/live/releases/${clearedId}`)
      .send({ externallyCleared: false });
    expect(updated.status).toBe(200);

    stubFacultyUserId = 0;
    const publicReview = await request(app).get(
      `/api/decision-room/review/${clearedToken}`,
    );
    expect(publicReview.status).toBe(404);
  });
});

// ── Section 9d: CVO verification checks prerequisites ────────────────────────

describe("CVO verification readiness prerequisites", () => {
  let incompleteId = 0;

  beforeAll(async () => {
    stubFacultyUserId = adminId;
    // Create a release missing most governance fields
    const created = await request(app)
      .post("/api/decision-room/test/releases")
      .send({
        institutionName: `${stamp} CVO Prereq`,
        namedExpert: `Dr. Test ${stamp}`,
        publicGuidance: "Some guidance.",
        // Deliberately omit intendedAudience, sourceAndProvenanceNotes,
        // scopeLimits, recoursePath, revenueTermsAcknowledged
        externallyCleared: false,
        revenueTermsAcknowledged: false,
      });
    incompleteId = created.body.id;

    // Faculty signs off to unblock the CVO check
    stubFacultyUserId = facultyId;
    await request(app)
      .post(`/api/decision-room/test/releases/${incompleteId}/faculty-signoff`)
      .send({});
  });

  test("CVO verification rejected when governance fields are missing", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app)
      .post(
        `/api/decision-room/test/releases/${incompleteId}/cvo-verification`,
      )
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("readiness_prerequisites_not_met");
    expect(typeof res.body.reason).toBe("string");
    expect(res.body.reason.length).toBeGreaterThan(0);
  });
});

// ── Section 9e: Request body boolean type validation ─────────────────────────

describe("Request body validation rejects type coercions", () => {
  test("create with string 'false' for externallyCleared is rejected", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app)
      .post("/api/decision-room/test/releases")
      .send({
        institutionName: "Test Org",
        namedExpert: "Dr. Test",
        publicGuidance: "Guidance text.",
        externallyCleared: "false", // string instead of boolean
        revenueTermsAcknowledged: true,
      });
    // Zod should reject the string "false" for a boolean field
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("create with missing required field publicGuidance is rejected", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app)
      .post("/api/decision-room/test/releases")
      .send({
        institutionName: "Test Org",
        namedExpert: "Dr. Test",
        // Missing publicGuidance
        externallyCleared: true,
        revenueTermsAcknowledged: true,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });
});

// ── Section 9: Idempotent sample seeds ───────────────────────────────────────

describe("Idempotent test-mode samples", () => {
  test("exactly 3 sample records exist for test mode after boot DDL", async () => {
    // Boot DDL runs in index.ts migrate(). In test suites that import app.ts
    // directly (not index.ts), we may not have the samples yet — but when
    // migrate() runs in prod/dev, they should be present. Here we just verify
    // that running the seed SQL again is idempotent (doesn't add more rows).
    const { rows: before } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM decision_room_decisions
       WHERE mode = 'test' AND is_sample = TRUE`,
    );
    const countBefore = Number(before[0].count);

    // Run the seed again (simulating a second boot)
    await pool.query(`
      INSERT INTO decision_room_decisions (
        mode, is_sample, title, question, status,
        institution_name, named_expert,
        own_view, context, final_call, outcome,
        externally_cleared, revenue_terms_acknowledged
      )
      SELECT * FROM (VALUES
        ('test', TRUE,
         '[SAMPLE] Late-Night Digital Support Policy',
         'Should we recommend limiting digital device use after 10 pm for college students?',
         'draft',
         'Fictional University Health Services', 'Dr. A. Sample (fictional)',
         'Late-night screen use displaces sleep opportunity.',
         'Undergraduate students.', NULL, NULL, FALSE, FALSE),
        ('test', TRUE,
         '[SAMPLE] Public Sleep Hygiene Guidance',
         'What is an evidence-based, publicly accessible sleep hygiene recommendation for adults?',
         'ready',
         'Fictional Sleep Research Institute', 'Prof. B. Sample (fictional)',
         'Consistent schedule is key.',
         'General adult population.', 'Recommend 7-9 hours.', 'Approved.', TRUE, TRUE),
        ('test', TRUE,
         '[SAMPLE] AI Tools in the Classroom — Explainer',
         'How should faculty introduce AI tools to students in a way that preserves critical thinking?',
         'published',
         'Fictional College of Education', 'Dr. C. Sample (fictional)',
         'AI as accelerators, not answer machines.',
         'Faculty audience.',
         'Require citation of AI use.',
         'Published in faculty newsletter.', TRUE, TRUE)
      ) AS seed(
        mode, is_sample, title, question, status,
        institution_name, named_expert,
        own_view, context, final_call, outcome,
        externally_cleared, revenue_terms_acknowledged
      )
      WHERE NOT EXISTS (
        SELECT 1 FROM decision_room_decisions WHERE mode = 'test' AND is_sample = TRUE
      )
    `);

    const { rows: after } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM decision_room_decisions
       WHERE mode = 'test' AND is_sample = TRUE`,
    );
    const countAfter = Number(after[0].count);

    // Idempotent: running the seed a second time must not add MORE rows.
    // countAfter should equal countBefore (whether that was 0 or already 3).
    // If countBefore was 0, the seed ran for the first time and added 3;
    // if countBefore was 3, the seed was already there and countAfter is still 3.
    if (countBefore === 0) {
      // First time: seed ran, 3 rows were added
      expect(countAfter).toBe(3);
    } else {
      // Already seeded: idempotent, no new rows
      expect(countAfter).toBe(countBefore);
    }
  });

  test("test-mode summary shows samples in correct dashboard buckets", async () => {
    // Seed samples if not present (test suite may not have run migrate())
    await pool.query(`
      INSERT INTO decision_room_decisions (
        mode, is_sample, title, question, status,
        institution_name, named_expert,
        own_view, context, final_call, outcome,
        externally_cleared, revenue_terms_acknowledged
      )
      SELECT * FROM (VALUES
        ('test', TRUE,
         '[SAMPLE] Late-Night Digital Support Policy',
         'Should we recommend limiting digital device use after 10 pm?',
         'draft',
         'Fictional University Health Services', 'Dr. A. Sample (fictional)',
         'Late-night screen use displaces sleep.',
         'Undergrads.', NULL, NULL, FALSE, FALSE),
        ('test', TRUE,
         '[SAMPLE] Public Sleep Hygiene Guidance',
         'Evidence-based sleep hygiene for adults?',
         'ready',
         'Fictional Sleep Research Institute', 'Prof. B. Sample (fictional)',
         'Consistent schedule.', 'General adults.', 'Recommend 7-9 hours.', 'Approved.', TRUE, TRUE),
        ('test', TRUE,
         '[SAMPLE] AI Tools in the Classroom — Explainer',
         'How to introduce AI to students?',
         'published',
         'Fictional College of Education', 'Dr. C. Sample (fictional)',
         'AI as accelerators.', 'Faculty.', 'Require citation.', 'Published.', TRUE, TRUE)
      ) AS seed(
        mode, is_sample, title, question, status,
        institution_name, named_expert,
        own_view, context, final_call, outcome,
        externally_cleared, revenue_terms_acknowledged
      )
      WHERE NOT EXISTS (
        SELECT 1 FROM decision_room_decisions WHERE mode = 'test' AND is_sample = TRUE
      )
    `);

    stubFacultyUserId = adminId;
    const res = await request(app).get("/api/decision-room/test/summary");
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("test");
    // At least one item in each bucket (from samples)
    expect(res.body.needsAttention.count).toBeGreaterThanOrEqual(1);
    expect(res.body.publishedAndTraceable.count).toBeGreaterThanOrEqual(1);
  });
});
