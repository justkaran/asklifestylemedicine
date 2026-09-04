import { afterAll, beforeAll, describe, test, expect, vi } from "vitest";
import { ensureCaptureLoopSchema } from "./testHelpers.js";

// `stubFacultyUserId` lets each test act as a specific signed-in faculty user.
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
const stamp = Date.now().toString(36);
let adminId = 0;
let stewardId = 0;
let otherStewardId = 0;

beforeAll(async () => {
  await ensureCaptureLoopSchema();
  // The channel-interest table isn't created at app boot (see
  // api-server-test-schema memory), so self-provision it here.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS faculty_channel_interest (
      id serial PRIMARY KEY,
      faculty_user_id integer NOT NULL REFERENCES faculty_users(id) ON DELETE CASCADE,
      channel_key text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS faculty_channel_interest_user_channel_unique
      ON faculty_channel_interest (faculty_user_id, channel_key);
  `);
  app = (await import("../app.js")).default;

  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name, is_platform_admin)
     VALUES ($1,$2,$3,'true'),($4,$5,$6,'false'),($7,$8,$9,'false')
     RETURNING id`,
    [
      `ci-admin-${stamp}`,
      `ci-admin-${stamp}@test.local`,
      "Channel Admin",
      `ci-steward-${stamp}`,
      `ci-steward-${stamp}@test.local`,
      "Channel Steward",
      `ci-other-${stamp}`,
      `ci-other-${stamp}@test.local`,
      "Other Steward",
    ],
  );
  adminId = rows[0].id;
  stewardId = rows[1].id;
  otherStewardId = rows[2].id;
});

afterAll(async () => {
  await pool.query(
    `DELETE FROM faculty_users WHERE clerk_user_id IN ($1,$2,$3)`,
    [`ci-admin-${stamp}`, `ci-steward-${stamp}`, `ci-other-${stamp}`],
  );
});

describe("faculty channel interest", () => {
  test("registering interest is idempotent per channel", async () => {
    stubFacultyUserId = stewardId;
    const first = await request(app)
      .post("/api/faculty/channel-interest")
      .send({ channelKey: "think-fast-talk-smart" });
    expect(first.status).toBe(200);
    expect(first.body.interested).toBe(true);

    // Re-registering the same channel must not error or duplicate.
    const second = await request(app)
      .post("/api/faculty/channel-interest")
      .send({ channelKey: "think-fast-talk-smart" });
    expect(second.status).toBe(200);

    const list = await request(app).get("/api/faculty/channel-interest");
    expect(list.status).toBe(200);
    const keys = list.body.channelKeys as string[];
    expect(keys.filter((k) => k === "think-fast-talk-smart")).toHaveLength(1);
  });

  test("rejects an empty channel key", async () => {
    stubFacultyUserId = stewardId;
    const res = await request(app)
      .post("/api/faculty/channel-interest")
      .send({ channelKey: "" });
    expect(res.status).toBe(400);
  });

  test("a steward only sees their own interest keys", async () => {
    stubFacultyUserId = otherStewardId;
    await request(app)
      .post("/api/faculty/channel-interest")
      .send({ channelKey: "new-york-times" });

    const mine = await request(app).get("/api/faculty/channel-interest");
    expect(mine.body.channelKeys).toEqual(["new-york-times"]);
  });

  test("admin sees interest grouped by channel with members; non-admin is forbidden", async () => {
    // Non-admin steward cannot view the admin rollup.
    stubFacultyUserId = stewardId;
    const forbidden = await request(app).get(
      "/api/faculty/admin/channel-interest",
    );
    expect(forbidden.status).toBe(403);

    stubFacultyUserId = adminId;
    const res = await request(app).get("/api/faculty/admin/channel-interest");
    expect(res.status).toBe(200);
    const channels = res.body.channels as Array<{
      channelKey: string;
      count: number;
      members: Array<{ email: string }>;
    }>;
    const tfts = channels.find((c) => c.channelKey === "think-fast-talk-smart");
    expect(tfts).toBeTruthy();
    expect(tfts!.count).toBeGreaterThanOrEqual(1);
    expect(
      tfts!.members.some((m) => m.email === `ci-steward-${stamp}@test.local`),
    ).toBe(true);
  });
});
