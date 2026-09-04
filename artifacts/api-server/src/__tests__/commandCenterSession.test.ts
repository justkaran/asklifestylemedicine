import { afterAll, beforeAll, describe, test, expect, vi } from "vitest";
import { ensureCaptureLoopSchema } from "./testHelpers.js";

vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-command-center-secret";
});

// `stubFacultyUserId` lets each test act as a specific signed-in faculty user,
// or as a signed-out caller when 0. Mirrors the facultyAdmin.test.ts approach:
// the real route + cookie wiring run; only the Clerk-backed auth is stubbed.
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
import { createHmac } from "crypto";
import pool from "../lib/db.js";

let app: Express;
const stamp = Date.now().toString(36);
let adminId = 0;
let stewardId = 0;

function signCookie(val: string, secret: string): string {
  const hash = createHmac("sha256", secret)
    .update(val)
    .digest("base64")
    .replace(/=+$/, "");
  return val + "." + hash;
}
function signed(value: string): string {
  return "s:" + signCookie(value, process.env.SESSION_SECRET as string);
}

/** Pull a Set-Cookie entry by name out of a supertest response. */
function setCookie(res: request.Response, name: string): string | undefined {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  if (!raw) return undefined;
  return raw.find((c) => c.startsWith(`${name}=`));
}

beforeAll(async () => {
  await ensureCaptureLoopSchema();
  await pool.query(`CREATE TABLE IF NOT EXISTS story_editor_sessions (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    magic_token TEXT NOT NULL UNIQUE,
    session_token TEXT UNIQUE,
    consumed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    session_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  app = (await import("../app.js")).default;

  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name, is_platform_admin)
     VALUES ($1,$2,$3,'true'),($4,$5,$6,'false')
     RETURNING id`,
    [
      `cc-admin-${stamp}`,
      `cc-admin-${stamp}@test.local`,
      "Command Center Admin",
      `cc-steward-${stamp}`,
      `cc-steward-${stamp}@test.local`,
      "Regular Steward",
    ],
  );
  adminId = rows[0].id;
  stewardId = rows[1].id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM story_editor_sessions WHERE email LIKE $1`, [
    `cc-%-${stamp}@test.local`,
  ]);
  await pool.query(`DELETE FROM faculty_users WHERE clerk_user_id IN ($1,$2)`, [
    `cc-admin-${stamp}`,
    `cc-steward-${stamp}`,
  ]);
});

describe("command-center session bridge", () => {
  test("mints BOTH palonur_admin and stories_session cookies for a platform admin", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app).post(
      "/api/faculty/admin/command-center-session",
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const adminCk = setCookie(res, "palonur_admin");
    const storiesCk = setCookie(res, "stories_session");
    expect(adminCk).toBeDefined();
    expect(storiesCk).toBeDefined();
    // Both must be signed (cookie-parser `s:` prefix, URL-encoded) and httpOnly.
    expect(adminCk).toContain("HttpOnly");
    expect(storiesCk).toContain("HttpOnly");
    expect(adminCk).toContain(encodeURIComponent("s:"));
    expect(storiesCk).toContain(encodeURIComponent("s:"));

    // The editor session must be persisted so requireEditorOrAdmin can verify it.
    const email = `cc-admin-${stamp}@test.local`;
    const { rowCount } = await pool.query(
      `SELECT 1 FROM story_editor_sessions WHERE email = $1 AND consumed_at IS NOT NULL`,
      [email],
    );
    expect(rowCount).toBeGreaterThan(0);
  });

  test("rejects a non-admin and sets NO cookies", async () => {
    stubFacultyUserId = stewardId;
    const res = await request(app).post(
      "/api/faculty/admin/command-center-session",
    );
    expect(res.status).toBe(403);
    expect(setCookie(res, "palonur_admin")).toBeUndefined();
    expect(setCookie(res, "stories_session")).toBeUndefined();
  });

  test("rejects a signed-out caller and sets NO cookies", async () => {
    stubFacultyUserId = 0;
    const res = await request(app).post(
      "/api/faculty/admin/command-center-session",
    );
    expect(res.status).toBe(401);
    expect(setCookie(res, "palonur_admin")).toBeUndefined();
    expect(setCookie(res, "stories_session")).toBeUndefined();
  });
});

describe("GET /api/admin/session probe", () => {
  test("returns ok with a valid palonur_admin cookie", async () => {
    const res = await request(app)
      .get("/api/admin/session")
      .set("Cookie", `palonur_admin=${encodeURIComponent(signed("1"))}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test("the cookie minted by the bridge authenticates the probe end-to-end", async () => {
    stubFacultyUserId = adminId;
    const mint = await request(app).post(
      "/api/faculty/admin/command-center-session",
    );
    const adminCk = setCookie(mint, "palonur_admin");
    expect(adminCk).toBeDefined();
    // Replay only the name=value pair, as a browser would.
    const cookiePair = (adminCk as string).split(";")[0];
    const res = await request(app)
      .get("/api/admin/session")
      .set("Cookie", cookiePair);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test("rejects when no cookie is present", async () => {
    const res = await request(app).get("/api/admin/session");
    expect(res.status).toBe(401);
  });

  test("rejects a cookie with an invalid signature", async () => {
    const tampered =
      "s:" + signCookie("1", "wrong-secret").replace(/=+$/, "");
    const res = await request(app)
      .get("/api/admin/session")
      .set("Cookie", `palonur_admin=${encodeURIComponent(tampered)}`);
    expect(res.status).toBe(401);
  });

  test("rejects a forged unsigned cookie value", async () => {
    const res = await request(app)
      .get("/api/admin/session")
      .set("Cookie", "palonur_admin=1");
    expect(res.status).toBe(401);
  });
});
