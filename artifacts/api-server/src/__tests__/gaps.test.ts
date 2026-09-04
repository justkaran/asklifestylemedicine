import { afterAll, beforeAll, describe, test, expect, vi } from "vitest";
import { ensureCaptureLoopSchema } from "./testHelpers.js";

// Act as a specific signed-in faculty user per assertion. The pillar-role
// middleware is left REAL so we still exercise its membership/role gate.
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
      (req as { log: unknown }).log = { warn: () => {}, info: () => {} };
      next();
    },
  };
});

import type { Express } from "express";
import request from "supertest";
import pool from "../lib/db.js";

let app: Express;
const stamp = Date.now().toString(36);
const pillarSlug = `gaps-test-${stamp}`;
let pillarId = 0;
const pillarSlug2 = `gaps-recon-${stamp}`;
let pillarId2 = 0;
let agedClusterId = 0;
let stewardId = 0;
let viewerId = 0;
let outsiderId = 0;
let clusterId = 0;

// Reusable insert: one uncovered (or covered) agent_queries row, aged by `days`.
async function insertQuery(opts: {
  question: string;
  uncovered: boolean;
  daysAgo: number;
  cluster?: number | null;
  pillar?: number;
}): Promise<void> {
  await pool.query(
    `INSERT INTO agent_queries
        (session_id, question, pillar_ids, was_uncovered, cluster_id, created_at)
      VALUES ($1, $2, ARRAY[$3]::int[], $4, $5,
              NOW() - make_interval(days => $6::int))`,
    [
      "gaps-test-session",
      opts.question,
      opts.pillar ?? pillarId,
      opts.uncovered,
      opts.cluster ?? null,
      opts.daysAgo,
    ],
  );
}

interface GapsBody {
  pillar: { id: number; slug: string; name: string };
  windowDays: number;
  totalUncovered: number;
  distinctQuestions: number;
  clusters: Array<{
    id: number;
    representativeQuestion: string;
    askedInWindow: number;
    memberQuestions: string[];
  }>;
  ungroupedUncovered: Array<{
    question: string;
    count: number;
    lastAsked: string;
  }>;
}

interface DashboardBody {
  pillar: { id: number; slug: string; name: string };
  totals: { total: number; uncovered: number; flagged: number };
  gaps: {
    windowDays: number;
    totalUncovered: number;
    distinctQuestions: number;
    clusters: Array<{
      id: number;
      representativeQuestion: string;
      askedInWindow: number;
      memberQuestions: string[];
    }>;
    ungroupedUncovered: Array<{
      question: string;
      count: number;
      lastAsked: string;
    }>;
  };
  clusters: Array<{ id: number; size: number }>;
}

beforeAll(async () => {
  await ensureCaptureLoopSchema();

  const { rows: pillarRows } = await pool.query<{ id: number }>(
    `INSERT INTO pillars (slug, name) VALUES ($1, $2) RETURNING id`,
    [pillarSlug, "Gaps Test Pillar"],
  );
  pillarId = pillarRows[0].id;

  const mkUser = async (role: string | null): Promise<number> => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO faculty_users (clerk_user_id, email, full_name)
       VALUES ($1, $2, $3) RETURNING id`,
      [
        `gaps-${role ?? "out"}-${stamp}`,
        `gaps-${role ?? "out"}-${stamp}@test.local`,
        `Gaps ${role ?? "Outsider"}`,
      ],
    );
    const id = rows[0].id;
    if (role) {
      await pool.query(
        `INSERT INTO faculty_memberships (user_id, pillar_id, role)
         VALUES ($1, $2, $3::faculty_role)`,
        [id, pillarId, role],
      );
    }
    return id;
  };
  stewardId = await mkUser("steward");
  viewerId = await mkUser("viewer");
  outsiderId = await mkUser(null);

  // A cluster whose stored `size` (99) is deliberately wrong for any real
  // window — the endpoint must report a true windowed count, never `size`.
  await pool.query(
    `ALTER TABLE query_clusters
       ADD COLUMN IF NOT EXISTS embedding_model TEXT NOT NULL DEFAULT 'test-model'`,
  );
  const { rows: clusterRows } = await pool.query<{ id: number }>(
    `INSERT INTO query_clusters
        (pillar_id, representative_question, size, last_updated, embedding_model)
     VALUES ($1, $2, 99, NOW() - INTERVAL '2 days', 'test-model') RETURNING id`,
    [pillarId, "Why does melatonin timing matter?"],
  );
  clusterId = clusterRows[0].id;

  // 3 distinct clustered uncovered questions (recent → in every window).
  await insertQuery({
    question: "Why does melatonin timing matter?",
    uncovered: true,
    daysAgo: 1,
    cluster: clusterId,
  });
  await insertQuery({
    question: "When should I take melatonin?",
    uncovered: true,
    daysAgo: 1,
    cluster: clusterId,
  });
  await insertQuery({
    question: "Does melatonin timing affect deep sleep?",
    uncovered: true,
    daysAgo: 2,
    cluster: clusterId,
  });

  // Ungrouped (cluster_id NULL): "a" asked twice, "b" once → 3 rows, 2 distinct.
  await insertQuery({ question: "Is mouth taping safe?", uncovered: true, daysAgo: 1 });
  await insertQuery({ question: "Is mouth taping safe?", uncovered: true, daysAgo: 1 });
  await insertQuery({ question: "Do weighted blankets help?", uncovered: true, daysAgo: 3 });

  // A COVERED question (recent) — must never be counted as a gap.
  await insertQuery({
    question: "How long is a sleep cycle?",
    uncovered: false,
    daysAgo: 1,
  });

  // An OLD uncovered question (40 days) — outside 30d, inside 90d.
  await insertQuery({
    question: "What is sleep debt?",
    uncovered: true,
    daysAgo: 40,
  });

  // --- Reconciliation pillar -------------------------------------------------
  // A cluster whose last_updated is OUTSIDE a 30d window but INSIDE 90d, with a
  // member miss that IS inside the 30d window. The miss must surface in the
  // ungrouped list for 30d (so the total reconciles) and flip into the cluster
  // list for 90d (where the cluster itself is shown). Exercises the windowed
  // exclusion subquery.
  const { rows: pillar2Rows } = await pool.query<{ id: number }>(
    `INSERT INTO pillars (slug, name) VALUES ($1, $2) RETURNING id`,
    [pillarSlug2, "Gaps Reconciliation Pillar"],
  );
  pillarId2 = pillar2Rows[0].id;
  await pool.query(
    `INSERT INTO faculty_memberships (user_id, pillar_id, role)
     VALUES ($1, $2, 'steward'::faculty_role)`,
    [stewardId, pillarId2],
  );
  const { rows: agedRows } = await pool.query<{ id: number }>(
    `INSERT INTO query_clusters
        (pillar_id, representative_question, size, last_updated, embedding_model)
     VALUES ($1, $2, 5, NOW() - INTERVAL '40 days', 'test-model') RETURNING id`,
    [pillarId2, "Why won’t my CPAP mask stay sealed?"],
  );
  agedClusterId = agedRows[0].id;
  await insertQuery({
    question: "Why won’t my CPAP mask stay sealed?",
    uncovered: true,
    daysAgo: 1,
    cluster: agedClusterId,
    pillar: pillarId2,
  });

  app = (await import("../app.js")).default;
});

afterAll(async () => {
  for (const id of [pillarId, pillarId2]) {
    if (!id) continue;
    await pool.query(`DELETE FROM agent_queries WHERE $1 = ANY(pillar_ids)`, [
      id,
    ]);
    await pool.query(`DELETE FROM query_clusters WHERE pillar_id = $1`, [id]);
    await pool.query(`DELETE FROM faculty_memberships WHERE pillar_id = $1`, [
      id,
    ]);
    await pool.query(`DELETE FROM pillars WHERE id = $1`, [id]);
  }
  for (const id of [stewardId, viewerId, outsiderId]) {
    if (id) await pool.query(`DELETE FROM faculty_users WHERE id = $1`, [id]);
  }
  await pool.end();
});

describe("GET /api/faculty/pillars/:slug/gaps", () => {
  test("default 30d window: counts only recent uncovered, excludes covered + aged-out", async () => {
    stubFacultyUserId = stewardId;
    const res = await request(app).get(`/api/faculty/pillars/${pillarSlug}/gaps`);
    expect(res.status).toBe(200);
    const body = res.body as GapsBody;

    expect(body.windowDays).toBe(30);
    expect(body.pillar.slug).toBe(pillarSlug);
    // 3 clustered + 3 ungrouped rows = 6; covered + 40-day-old excluded.
    expect(body.totalUncovered).toBe(6);
    // 3 clustered + 2 distinct ungrouped = 5 distinct texts.
    expect(body.distinctQuestions).toBe(5);
  });

  test("cluster reports a REAL windowed count, never the stale stored size", async () => {
    stubFacultyUserId = stewardId;
    const res = await request(app).get(`/api/faculty/pillars/${pillarSlug}/gaps`);
    const body = res.body as GapsBody;
    const cluster = body.clusters.find((c) => c.id === clusterId);
    expect(cluster).toBeDefined();
    // Real count of clustered uncovered rows in the window — NOT 99.
    expect(cluster!.askedInWindow).toBe(3);
    expect(cluster!.memberQuestions.length).toBeGreaterThanOrEqual(1);
  });

  test("ungrouped misses are grouped by question text and ordered by demand", async () => {
    stubFacultyUserId = stewardId;
    const res = await request(app).get(`/api/faculty/pillars/${pillarSlug}/gaps`);
    const body = res.body as GapsBody;
    expect(body.ungroupedUncovered).toHaveLength(2);
    expect(body.ungroupedUncovered[0].question).toBe("Is mouth taping safe?");
    expect(body.ungroupedUncovered[0].count).toBe(2);
    const blanket = body.ungroupedUncovered.find(
      (u) => u.question === "Do weighted blankets help?",
    );
    expect(blanket?.count).toBe(1);
  });

  test("90d window pulls in the aged-out question that 30d hides", async () => {
    stubFacultyUserId = stewardId;
    const res = await request(app).get(
      `/api/faculty/pillars/${pillarSlug}/gaps?days=90`,
    );
    const body = res.body as GapsBody;
    expect(body.windowDays).toBe(90);
    expect(body.totalUncovered).toBe(7); // +1 the 40-day-old miss
    expect(
      body.ungroupedUncovered.some((u) => u.question === "What is sleep debt?"),
    ).toBe(true);
  });

  test("out-of-range or invalid days falls back to the default 30", async () => {
    stubFacultyUserId = stewardId;
    const tooBig = await request(app).get(
      `/api/faculty/pillars/${pillarSlug}/gaps?days=1000`,
    );
    expect((tooBig.body as GapsBody).windowDays).toBe(30);
    const bogus = await request(app).get(
      `/api/faculty/pillars/${pillarSlug}/gaps?days=abc`,
    );
    expect((bogus.body as GapsBody).windowDays).toBe(30);
    const valid = await request(app).get(
      `/api/faculty/pillars/${pillarSlug}/gaps?days=7`,
    );
    expect((valid.body as GapsBody).windowDays).toBe(7);
  });

  test("a viewer of the pillar may read the gaps", async () => {
    stubFacultyUserId = viewerId;
    const res = await request(app).get(`/api/faculty/pillars/${pillarSlug}/gaps`);
    expect(res.status).toBe(200);
  });

  test("a non-member is refused", async () => {
    stubFacultyUserId = outsiderId;
    const res = await request(app).get(`/api/faculty/pillars/${pillarSlug}/gaps`);
    expect(res.status).toBe(403);
  });

  test("30d: an in-window miss on an out-of-window cluster surfaces in ungrouped (total reconciles)", async () => {
    stubFacultyUserId = stewardId;
    const res = await request(app).get(
      `/api/faculty/pillars/${pillarSlug2}/gaps?days=30`,
    );
    expect(res.status).toBe(200);
    const body = res.body as GapsBody;
    // The cluster's last_updated is 40d old, so it is NOT shown for 30d...
    expect(body.clusters.find((c) => c.id === agedClusterId)).toBeUndefined();
    // ...but its in-window member miss must not vanish — it shows as ungrouped,
    // so clusters + ungrouped reconcile with the real total of 1.
    expect(body.totalUncovered).toBe(1);
    expect(body.ungroupedUncovered).toHaveLength(1);
    expect(body.ungroupedUncovered[0].question).toBe(
      "Why won’t my CPAP mask stay sealed?",
    );
  });

  test("90d: the same cluster is shown and its member no longer double-lists as ungrouped", async () => {
    stubFacultyUserId = stewardId;
    const res = await request(app).get(
      `/api/faculty/pillars/${pillarSlug2}/gaps?days=90`,
    );
    const body = res.body as GapsBody;
    const cluster = body.clusters.find((c) => c.id === agedClusterId);
    expect(cluster).toBeDefined();
    expect(cluster!.askedInWindow).toBe(1);
    // Now that the cluster is shown, its member is excluded from ungrouped.
    expect(
      body.ungroupedUncovered.some(
        (u) => u.question === "Why won’t my CPAP mask stay sealed?",
      ),
    ).toBe(false);
    expect(body.totalUncovered).toBe(1);
  });
});

describe("GET /api/faculty/pillars/:slug/dashboard — embedded gaps", () => {
  test("dashboard carries a 30d gaps block that surfaces ungrouped demand, not just clusters", async () => {
    stubFacultyUserId = stewardId;
    const res = await request(app).get(
      `/api/faculty/pillars/${pillarSlug}/dashboard`,
    );
    expect(res.status).toBe(200);
    const body = res.body as DashboardBody;

    expect(body.gaps).toBeDefined();
    expect(body.gaps.windowDays).toBe(30);
    // Same windowed truth as the standalone /gaps endpoint: 3 clustered + 3
    // ungrouped rows = 6; covered + the 40-day-old miss are excluded.
    expect(body.gaps.totalUncovered).toBe(6);

    // Ungrouped (never-clustered) demand must appear — this is the whole point
    // of the task: it only lived on /gaps before, never on the dashboard.
    expect(body.gaps.ungroupedUncovered).toHaveLength(2);
    expect(
      body.gaps.ungroupedUncovered.some((u) => u.question === "Is mouth taping safe?"),
    ).toBe(true);
  });

  test("dashboard gaps report a real windowed cluster count, never query_clusters.size", async () => {
    stubFacultyUserId = stewardId;
    const res = await request(app).get(
      `/api/faculty/pillars/${pillarSlug}/dashboard`,
    );
    const body = res.body as DashboardBody;
    const cluster = body.gaps.clusters.find((c) => c.id === clusterId);
    expect(cluster).toBeDefined();
    // Real windowed count (3), NOT the deliberately-stale stored size (99).
    expect(cluster!.askedInWindow).toBe(3);
    // The legacy auto-fire picker still sees the raw stored size separately.
    const legacy = body.clusters.find((c) => c.id === clusterId);
    expect(legacy?.size).toBe(99);
  });

  test("clustered + ungrouped reconcile to totalUncovered (no double count, no orphan)", async () => {
    stubFacultyUserId = stewardId;
    const res = await request(app).get(
      `/api/faculty/pillars/${pillarSlug}/dashboard`,
    );
    const { gaps } = res.body as DashboardBody;
    const clustered = gaps.clusters.reduce((n, c) => n + c.askedInWindow, 0);
    const ungrouped = gaps.ungroupedUncovered.reduce((n, u) => n + u.count, 0);
    expect(clustered + ungrouped).toBe(gaps.totalUncovered);
  });

  test("a viewer may read the dashboard gaps; a non-member is refused", async () => {
    stubFacultyUserId = viewerId;
    const ok = await request(app).get(
      `/api/faculty/pillars/${pillarSlug}/dashboard`,
    );
    expect(ok.status).toBe(200);
    expect((ok.body as DashboardBody).gaps.windowDays).toBe(30);

    stubFacultyUserId = outsiderId;
    const denied = await request(app).get(
      `/api/faculty/pillars/${pillarSlug}/dashboard`,
    );
    expect(denied.status).toBe(403);
  });
});
