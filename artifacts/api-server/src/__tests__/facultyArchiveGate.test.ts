import { afterAll, beforeAll, describe, test, expect, vi } from "vitest";
import { ensureCaptureLoopSchema } from "./testHelpers.js";

// These tests exercise the REAL requireFacultyAuth middleware (unlike
// facultyAdmin.test.ts, which stubs it), because the archived-account gate
// lives inside the middleware itself. Only Clerk is mocked: `getAuth` returns
// whichever clerk user id the test selects, and `clerkClient` is stubbed so
// no network calls happen.
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
        banUser: vi.fn(async () => ({})),
        unbanUser: vi.fn(async () => ({})),
        getUserList: vi.fn(async () => ({ data: [] })),
      },
    },
  };
});

import type { Express } from "express";
import request from "supertest";
import pool from "../lib/db.js";
import { AUTO_PLATFORM_ADMIN_EMAILS } from "../middlewares/facultyAuth.js";

let app: Express;
const stamp = Date.now().toString(36);
const adminClerkId = `archgate-admin-${stamp}`;
const adminEmail = `archgate-admin-${stamp}@test.local`;
const memberClerkId = `archgate-member-${stamp}`;
let adminId = 0;
let memberId = 0;

const asAdmin = () => {
  authState.clerkUserId = adminClerkId;
};
const asMember = () => {
  authState.clerkUserId = memberClerkId;
};

beforeAll(async () => {
  // Exercise the real admin gate without broadening the production allowlist.
  AUTO_PLATFORM_ADMIN_EMAILS.add(adminEmail);
  await ensureCaptureLoopSchema();
  // Tests import app.ts, not index.ts, so boot-time DDL never runs —
  // self-provision the columns this suite depends on.
  await pool.query(
    `ALTER TABLE faculty_users ADD COLUMN IF NOT EXISTS archived_at timestamptz`,
  );
  await pool.query(
    `ALTER TABLE faculty_users ADD COLUMN IF NOT EXISTS deactivated_at timestamptz`,
  );
  await pool.query(
    `ALTER TABLE faculty_users ADD COLUMN IF NOT EXISTS onboarded_at timestamptz`,
  );
  app = (await import("../app.js")).default;

  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name, is_platform_admin)
     VALUES ($1,$2,$3,'true'),($4,$5,$6,'false')
     RETURNING id`,
    [
      adminClerkId,
      adminEmail,
      "Archive Gate Admin",
      memberClerkId,
      `archgate-member-${stamp}@test.local`,
      "Archive Gate Member",
    ],
  );
  adminId = rows[0].id;
  memberId = rows[1].id;

  // The archive route requires the custodian account (normally created by
  // the boot seed in index.ts, which tests don't run). Idempotent.
  const existing = await pool.query(
    `SELECT id FROM faculty_users WHERE email = 'custodian@palonur.com'`,
  );
  if (existing.rows.length === 0) {
    await pool.query(
      `INSERT INTO faculty_users (clerk_user_id, email, full_name, is_platform_admin)
       VALUES ($1, 'custodian@palonur.com', 'Palonur Custodian', 'false')
       ON CONFLICT (clerk_user_id) DO NOTHING`,
      [`pending:custodian@palonur.com`],
    );
  }
});

afterAll(async () => {
  AUTO_PLATFORM_ADMIN_EMAILS.delete(adminEmail);
  await pool.query(
    `DELETE FROM faculty_memberships WHERE user_id IN ($1, $2)`,
    [adminId, memberId],
  );
  await pool.query(`DELETE FROM faculty_users WHERE id IN ($1, $2)`, [
    adminId,
    memberId,
  ]);
});

describe("archived faculty account gate (real middleware)", () => {
  test("baseline: member has normal portal access before archive", async () => {
    asMember();
    const me = await request(app).get("/api/faculty/me");
    expect(me.status).toBe(200);
    expect(me.body.archived).toBe(false);

    const onboard = await request(app).post("/api/faculty/onboarding/complete");
    expect(onboard.status).toBe(200);
  });

  test("admin archives the member", async () => {
    asAdmin();
    const res = await request(app).post(
      `/api/faculty/admin/members/${memberId}/archive`,
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.archivedAt).toBeTruthy();
  });

  test("archived member can still read /faculty/me (on-leave screen data)", async () => {
    asMember();
    const me = await request(app).get("/api/faculty/me");
    expect(me.status).toBe(200);
    expect(me.body.archived).toBe(true);
    expect(me.body.user.archivedAt).toBeTruthy();
  });

  test("archived member is denied every other faculty endpoint — reads and writes", async () => {
    asMember();
    // Mutation
    const onboard = await request(app).post("/api/faculty/onboarding/complete");
    expect(onboard.status).toBe(403);
    expect(onboard.body.archived).toBe(true);

    // Plain member read
    const credits = await request(app).get("/api/faculty/newsletter-credits");
    expect(credits.status).toBe(403);
    expect(credits.body.archived).toBe(true);

    // Steward-management surface (blocked by the archive gate BEFORE any
    // role check — the dedicated `archived` flag proves which gate fired)
    const roster = await request(app).get("/api/faculty/admin/members");
    expect(roster.status).toBe(403);
    expect(roster.body.archived).toBe(true);
  });

  test("archived member cannot self-restore", async () => {
    asMember();
    const res = await request(app).post(
      `/api/faculty/admin/members/${memberId}/restore`,
    );
    expect(res.status).toBe(403);
    expect(res.body.archived).toBe(true);
  });

  test("admin view-as preview of the archived member still works (gate checks the REAL caller)", async () => {
    asAdmin();
    const me = await request(app)
      .get("/api/faculty/me")
      .set("x-faculty-view-as", String(memberId));
    expect(me.status).toBe(200);
    expect(me.body.archived).toBe(true);
  });

  test("restore immediately resumes access", async () => {
    asAdmin();
    const restore = await request(app).post(
      `/api/faculty/admin/members/${memberId}/restore`,
    );
    expect(restore.status).toBe(200);
    expect(restore.body.ok).toBe(true);

    asMember();
    const me = await request(app).get("/api/faculty/me");
    expect(me.status).toBe(200);
    expect(me.body.archived).toBe(false);

    const onboard = await request(app).post("/api/faculty/onboarding/complete");
    expect(onboard.status).toBe(200);

    const credits = await request(app).get("/api/faculty/newsletter-credits");
    expect(credits.status).not.toBe(403);
  });
});
