import { afterAll, beforeAll, beforeEach, describe, test, expect, vi } from "vitest";
import { ensureCaptureLoopSchema } from "./testHelpers.js";

// Exercises the REAL requireFacultyAuth middleware (the ASLM route-group
// deny lives inside it). Only Clerk is mocked: `getAuth` returns whichever
// clerk user id the test selects; every seeded faculty_users row already
// carries a clerk_user_id so `getUser` is never needed.
const authState = vi.hoisted(() => ({ clerkUserId: "" }));

vi.mock("@clerk/express", async () => {
  const actual =
    await vi.importActual<typeof import("@clerk/express")>("@clerk/express");
  return {
    ...actual,
    getAuth: () => ({ userId: authState.clerkUserId || null }),
    clerkClient: {
      users: {
        getUser: vi.fn(async () => ({
          primaryEmailAddress: null,
          emailAddresses: [],
          firstName: "",
          lastName: "",
        })),
        updateUser: vi.fn(async () => ({})),
        getUserList: vi.fn(async () => ({ data: [] })),
      },
    },
  };
});

// Never send real invite emails from tests.
vi.mock("../lib/facultyInviteEmail.js", () => ({
  sendFacultyInviteEmail: vi.fn(async () => {}),
}));

import type { Express } from "express";
import request from "supertest";
import pool from "../lib/db.js";
import { AUTO_PLATFORM_ADMIN_EMAILS } from "../middlewares/facultyAuth.js";

let app: Express;
const stamp = Date.now().toString(36);

const adminClerkId = `aslm-admin-${stamp}`;
const adminEmail = `aslm-admin-${stamp}@test.local`;
const stewardClerkId = `aslm-steward-${stamp}`; // steward of an SLM pillar
const aslmClerkId = `aslm-member-${stamp}`; // registration_channel = 'aslm'
const normalClerkId = `aslm-normal-${stamp}`; // regular member, non-SLM pillar
const inviteeClerkId = `aslm-invitee-${stamp}`;
const inviteeEmail = `aslm-invitee-${stamp}@test.local`;

let adminId = 0;
let stewardId = 0;
let aslmId = 0;
let normalId = 0;
let inviteeId = 0;
let slmPillarId = 0; // a pillar whose slug is in SLM_PILLAR_SLUGS ('sleep')
let plainPillarId = 0; // a non-SLM pillar unique to this suite
const userIds: number[] = [];
const queryIds: string[] = [];

const as = (clerkId: string) => {
  authState.clerkUserId = clerkId;
};

async function ensureUser(
  clerkId: string,
  email: string,
  name: string,
  opts: { admin?: boolean; channel?: string | null } = {},
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name, is_platform_admin, registration_channel)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (clerk_user_id) DO UPDATE SET registration_channel = EXCLUDED.registration_channel
     RETURNING id`,
    [clerkId, email, name, opts.admin ? "true" : "false", opts.channel ?? null],
  );
  return rows[0].id;
}

async function ensureMembership(
  userId: number,
  pillarId: number,
  role: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO faculty_memberships (user_id, pillar_id, role)
     VALUES ($1,$2,$3::faculty_role)
     ON CONFLICT (user_id, pillar_id) DO UPDATE SET role = EXCLUDED.role`,
    [userId, pillarId, role],
  );
}

// Shared-dev-DB convention: another suite's CASCADE truncation can wipe our
// beforeAll fixtures mid-run, so re-ensure them idempotently before each test.
async function ensureFixtures(): Promise<void> {
  await pool.query(
    `INSERT INTO pillars (slug, name) VALUES ('sleep', 'Sleep')
     ON CONFLICT (slug) DO NOTHING`,
  );
  const slm = await pool.query<{ id: number }>(
    `SELECT id FROM pillars WHERE slug = 'sleep'`,
  );
  slmPillarId = slm.rows[0].id;
  const plain = await pool.query<{ id: number }>(
    `INSERT INTO pillars (slug, name) VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [`aslm-plain-${stamp}`, "ASLM Plain Pillar"],
  );
  plainPillarId = plain.rows[0].id;

  adminId = await ensureUser(adminClerkId, adminEmail, "ASLM Admin", { admin: true });
  stewardId = await ensureUser(stewardClerkId, `aslm-steward-${stamp}@test.local`, "SLM Steward");
  aslmId = await ensureUser(aslmClerkId, `aslm-member-${stamp}@test.local`, "ASLM Member", { channel: "aslm" });
  normalId = await ensureUser(normalClerkId, `aslm-normal-${stamp}@test.local`, "Normal Member");
  inviteeId = await ensureUser(inviteeClerkId, inviteeEmail, "ASLM Invitee");
  userIds.splice(0, userIds.length, adminId, stewardId, aslmId, normalId, inviteeId);

  await ensureMembership(stewardId, slmPillarId, "steward");
  await ensureMembership(aslmId, plainPillarId, "contributor");
  await ensureMembership(normalId, plainPillarId, "steward");
}

beforeAll(async () => {
  // This suite verifies platform-admin behavior with an isolated fixture. The
  // production allowlist remains the single canonical Stanford identity.
  AUTO_PLATFORM_ADMIN_EMAILS.add(adminEmail);
  await ensureCaptureLoopSchema();
  // Tests import app.ts, not index.ts, so boot-time DDL never runs —
  // self-provision the columns this suite depends on.
  await pool.query(
    `ALTER TABLE faculty_users ADD COLUMN IF NOT EXISTS registration_channel TEXT`,
  );
  await pool.query(
    `ALTER TABLE faculty_invitations ADD COLUMN IF NOT EXISTS registration_channel TEXT`,
  );
  await ensureFixtures();
  ({ default: app } = await import("../app.js"));
});

beforeEach(async () => {
  await ensureFixtures();
});

afterAll(async () => {
  AUTO_PLATFORM_ADMIN_EMAILS.delete(adminEmail);
  if (queryIds.length > 0) {
    await pool.query(`DELETE FROM agent_queries WHERE id = ANY($1::uuid[])`, [
      queryIds,
    ]);
  }
  await pool.query(
    `DELETE FROM faculty_invitations WHERE email LIKE $1`,
    [`aslm-%-${stamp}@test.local`],
  );
  await pool.query(`DELETE FROM faculty_memberships WHERE user_id = ANY($1::int[])`, [userIds]);
  await pool.query(`DELETE FROM faculty_users WHERE id = ANY($1::int[])`, [userIds]);
  await pool.query(`DELETE FROM pillars WHERE slug = $1`, [`aslm-plain-${stamp}`]);
});

describe("ASLM registration channel through the invite flow", () => {
  test("admin can create an invitation tagged with the aslm channel", async () => {
    as(adminClerkId);
    const res = await request(app)
      .post("/api/faculty/invitations")
      .send({
        email: inviteeEmail,
        pillarId: plainPillarId,
        role: "contributor",
        channel: "aslm",
      });
    expect(res.status).toBe(201);
    expect(res.body.channel).toBe("aslm");
  });

  test("accepting an aslm invitation stamps the channel onto the member", async () => {
    // Fresh invite for this test (idempotent across reruns of the suite).
    as(adminClerkId);
    const created = await request(app)
      .post("/api/faculty/invitations")
      .send({
        email: inviteeEmail,
        pillarId: plainPillarId,
        role: "contributor",
        channel: "aslm",
      });
    expect(created.status).toBe(201);
    const { rows } = await pool.query<{ token: string }>(
      `SELECT token FROM faculty_invitations WHERE id = $1`,
      [created.body.id],
    );

    as(inviteeClerkId);
    const accepted = await request(app).post(
      `/api/faculty/invitations/${rows[0].token}/accept`,
    );
    expect(accepted.status).toBe(200);

    const user = await pool.query<{ registration_channel: string | null }>(
      `SELECT registration_channel FROM faculty_users WHERE id = $1`,
      [inviteeId],
    );
    expect(user.rows[0].registration_channel).toBe("aslm");

    const me = await request(app).get("/api/faculty/me");
    expect(me.status).toBe(200);
    expect(me.body.user.registrationChannel).toBe("aslm");
  });

  test("a standard invitation leaves the channel null", async () => {
    as(adminClerkId);
    const res = await request(app)
      .post("/api/faculty/invitations")
      .send({
        email: `aslm-other-${stamp}@test.local`,
        pillarId: plainPillarId,
        role: "viewer",
      });
    expect(res.status).toBe(201);
    expect(res.body.channel).toBeNull();
  });
});

describe("server-side deny of hidden route groups for ASLM members", () => {
  // One representative endpoint per hidden route family (Explore/cross-pillar,
  // Requests, Decision Room, Admin, Evals, newsletter/distribution surfaces,
  // communication + parentdata queues).
  const blocked = [
    "/api/faculty/cross-pillar/pillars",
    "/api/faculty/cross-pillar/merge-requests",
    "/api/faculty/decision-room/memos",
    "/api/faculty/admin/members",
    "/api/faculty/evals/runs",
    "/api/faculty/publication",
    "/api/faculty/distribution-channels",
    "/api/faculty/channel-interest",
    "/api/faculty/newsletter-offers",
    "/api/faculty/newsletter-credits",
    "/api/faculty/communication-offers",
    "/api/faculty/parentdata-offers",
  ];

  test("ASLM-channel member gets 403 on each hidden group", async () => {
    as(aslmClerkId);
    for (const path of blocked) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(403);
      expect(res.body.aslmRestricted, path).toBe(true);
    }
  });

  test("ASLM-channel member keeps the allowed essentials", async () => {
    as(aslmClerkId);
    const me = await request(app).get("/api/faculty/me");
    expect(me.status).toBe(200);
    expect(me.body.user.registrationChannel).toBe("aslm");
  });

  test("normal members are unaffected by the deny list", async () => {
    as(normalClerkId);
    const res = await request(app).get("/api/faculty/cross-pillar/pillars");
    expect(res.status).toBe(200);
  });
});

describe("director dashboard: GET /api/faculty/aslm/usage", () => {
  const uncoveredQuestion = `Does moon dust affect sleep? [${stamp}]`;

  beforeAll(async () => {
    const seed = [
      { session: `consumer:aslm-${stamp}-1`, q: "covered a", uncovered: false },
      { session: `consumer:aslm-${stamp}-2`, q: "covered b", uncovered: false },
      { session: `anon-${stamp}`, q: uncoveredQuestion, uncovered: true },
    ];
    for (const row of seed) {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO agent_queries (session_id, question, source, was_uncovered)
         VALUES ($1, $2, 'slm-agent', $3) RETURNING id`,
        [row.session, row.q, row.uncovered],
      );
      queryIds.push(rows[0].id);
    }
  });

  test("non-SLM members are denied", async () => {
    as(normalClerkId); // steward, but of a non-SLM pillar
    const res = await request(app).get("/api/faculty/aslm/usage");
    expect(res.status).toBe(403);
  });

  test("ASLM-channel member without SLM stewardship is denied", async () => {
    as(aslmClerkId);
    const res = await request(app).get("/api/faculty/aslm/usage");
    expect(res.status).toBe(403);
  });

  test("SLM stewardship alone no longer grants director access", async () => {
    // Director access is a named email allowlist (+ platform admins) now.
    as(stewardClerkId);
    const res = await request(app).get("/api/faculty/aslm/usage");
    expect(res.status).toBe(403);
  });

  test("platform admin sees the aggregation", async () => {
    for (const clerkId of [adminClerkId]) {
      as(clerkId);
      const res = await request(app).get("/api/faculty/aslm/usage");
      expect(res.status, clerkId).toBe(200);
      // Shared dev DB: other rows may exist, so assert lower bounds.
      expect(res.body.registeredUsers).toBeGreaterThanOrEqual(2);
      expect(res.body.anonymousSessions).toBeGreaterThanOrEqual(1);
      expect(res.body.totalQuestions).toBeGreaterThanOrEqual(3);
      expect(res.body.unansweredTotal).toBeGreaterThanOrEqual(1);
      const found = (
        res.body.unanswered as Array<{ question: string; askedAt: string }>
      ).find((u) => u.question === uncoveredQuestion);
      expect(found, clerkId).toBeTruthy();
      expect(found!.askedAt).toBeTruthy();
    }
  });

  test("/me reports aslmDirector for the admin, not the SLM steward", async () => {
    as(adminClerkId);
    const admin = await request(app).get("/api/faculty/me");
    expect(admin.body.aslmDirector).toBe(true);

    // Steward of an SLM pillar but not on the director email allowlist.
    as(stewardClerkId);
    const steward = await request(app).get("/api/faculty/me");
    expect(steward.body.aslmDirector).toBe(false);

    as(normalClerkId);
    const normal = await request(app).get("/api/faculty/me");
    expect(normal.body.aslmDirector).toBe(false);
  });
});
