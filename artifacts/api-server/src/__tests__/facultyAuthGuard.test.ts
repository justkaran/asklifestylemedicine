import { afterAll, beforeAll, describe, test, expect, vi } from "vitest";
import { ensureCaptureLoopSchema } from "./testHelpers.js";

// Exercise the REAL requireFacultyAuth middleware (the admin-edit suite mocks
// it away). We only stub Clerk: `getAuth` decides which signed-in user the
// request belongs to, and `clerkClient.users.getUser` is never expected to be
// hit because every faculty_users row we seed already carries a clerk_user_id.
const authMocks = vi.hoisted(() => ({
  userId: null as string | null,
}));
vi.mock("@clerk/express", async () => {
  const actual =
    await vi.importActual<typeof import("@clerk/express")>("@clerk/express");
  return {
    ...actual,
    getAuth: () => ({ userId: authMocks.userId }),
    clerkClient: {
      users: {
        getUser: vi.fn(async () => {
          throw new Error("getUser should not be called in this suite");
        }),
      },
    },
  };
});

import pool from "../lib/db.js";
import { requireFacultyAuth } from "../middlewares/facultyAuth.js";

const stamp = Date.now().toString(36);
let adminId = 0;
let adminClerkId = "";
let targetId = 0;
let targetPillarId = 0;

function makeReqRes(opts: {
  method: string;
  viewAs?: string;
}): {
  req: Record<string, unknown>;
  res: {
    statusCode: number | null;
    body: unknown;
    status: (n: number) => { json: (b: unknown) => void };
  };
  next: () => void;
  nextCalled: () => boolean;
} {
  let called = false;
  const res = {
    statusCode: null as number | null,
    body: undefined as unknown,
    status(n: number) {
      this.statusCode = n;
      return {
        json: (b: unknown) => {
          res.body = b;
        },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    cookie(_name: string, _value: string, _opts?: unknown) {},
  };
  const req: Record<string, unknown> = {
    method: opts.method,
    path: "/faculty/x",
    header: (name: string) =>
      name.toLowerCase() === "x-faculty-view-as" ? opts.viewAs : undefined,
    log: { warn: () => {}, info: () => {}, error: () => {} },
  };
  return {
    req,
    res,
    next: () => {
      called = true;
    },
    nextCalled: () => called,
  };
}

beforeAll(async () => {
  await ensureCaptureLoopSchema();
  adminClerkId = `fag-admin-${stamp}`;
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name, is_platform_admin)
     VALUES ($1,$2,$3,'true'),($4,$5,$6,'false')
     RETURNING id`,
    [
      adminClerkId,
      "kdegani@stanford.edu",
      "Guard Admin",
      `fag-target-${stamp}`,
      `fag-target-${stamp}@test.local`,
      "Guard Target",
    ],
  );
  adminId = rows[0].id;
  targetId = rows[1].id;
  const pillar = await pool.query<{ id: number }>(
    `INSERT INTO pillars (slug, name) VALUES ($1, $2) RETURNING id`,
    [`fag-${stamp}`, "Faculty auth guard"],
  );
  targetPillarId = pillar.rows[0].id;
  await pool.query(
    `INSERT INTO faculty_memberships (user_id, pillar_id, role)
     VALUES ($1, $2, 'contributor')`,
    [targetId, targetPillarId],
  );
});

afterAll(async () => {
  await pool.query(
    `DELETE FROM faculty_users WHERE id = ANY($1::int[])`,
    [[adminId, targetId]],
  );
  await pool.query(`DELETE FROM pillars WHERE id = $1`, [targetPillarId]);
});

describe("platform-admin allowlist authority", () => {
  test("demotes a stale non-allowlisted admin without removing memberships", async () => {
    await pool.query(
      `UPDATE faculty_users SET is_platform_admin = 'true' WHERE id = $1`,
      [targetId],
    );
    authMocks.userId = `fag-target-${stamp}`;
    const { req, res, next, nextCalled } = makeReqRes({ method: "GET" });
    await requireFacultyAuth(req as never, res as never, next as never);
    expect(res.statusCode).toBeNull();
    const state = await pool.query<{
      is_platform_admin: string;
      memberships: string;
    }>(
      `SELECT u.is_platform_admin,
              count(m.id)::text AS memberships
         FROM faculty_users u
         LEFT JOIN faculty_memberships m ON m.user_id = u.id
        WHERE u.id = $1
        GROUP BY u.id`,
      [targetId],
    );
    expect(state.rows[0]).toEqual({
      is_platform_admin: "false",
      memberships: "1",
    });
    expect(nextCalled()).toBe(true);
  });
});

describe("requireFacultyAuth deactivation backstop", () => {
  test("a deactivated user is rejected with 403 on any request", async () => {
    await pool.query(
      `UPDATE faculty_users SET deactivated_at = now() WHERE id = $1`,
      [targetId],
    );
    authMocks.userId = `fag-target-${stamp}`;
    const { req, res, next, nextCalled } = makeReqRes({ method: "GET" });
    await requireFacultyAuth(req as never, res as never, next as never);
    expect(res.statusCode).toBe(403);
    expect(nextCalled()).toBe(false);
    expect(req.faculty).toBeUndefined();
    // Restore so later assertions about view-as use an active target.
    await pool.query(
      `UPDATE faculty_users SET deactivated_at = NULL WHERE id = $1`,
      [targetId],
    );
  });
});

describe("requireFacultyAuth view-as is GET-only", () => {
  test("GET with x-faculty-view-as swaps identity to the target", async () => {
    authMocks.userId = adminClerkId;
    const { req, res, next, nextCalled } = makeReqRes({
      method: "GET",
      viewAs: String(targetId),
    });
    await requireFacultyAuth(req as never, res as never, next as never);
    expect(nextCalled()).toBe(true);
    expect(res.statusCode).toBeNull();
    expect((req.faculty as { user: { id: number } }).user.id).toBe(targetId);
    expect(req.viewAsAdminUserId).toBe(adminId);
  });

  test("POST with x-faculty-view-as runs as the real admin (no swap)", async () => {
    authMocks.userId = adminClerkId;
    const { req, res, next, nextCalled } = makeReqRes({
      method: "POST",
      viewAs: String(targetId),
    });
    await requireFacultyAuth(req as never, res as never, next as never);
    expect(nextCalled()).toBe(true);
    expect((req.faculty as { user: { id: number } }).user.id).toBe(adminId);
    expect(req.viewAsAdminUserId).toBeUndefined();
  });

  test("DELETE with x-faculty-view-as runs as the real admin (no swap)", async () => {
    authMocks.userId = adminClerkId;
    const { req, res, next, nextCalled } = makeReqRes({
      method: "DELETE",
      viewAs: String(targetId),
    });
    await requireFacultyAuth(req as never, res as never, next as never);
    expect(nextCalled()).toBe(true);
    expect((req.faculty as { user: { id: number } }).user.id).toBe(adminId);
    expect(req.viewAsAdminUserId).toBeUndefined();
  });
});
