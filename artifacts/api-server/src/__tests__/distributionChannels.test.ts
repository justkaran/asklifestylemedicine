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
// Channels created by this suite share this key prefix so afterAll can purge
// them without touching the seeded production-shape rows.
const keyPrefix = `dc-test-${stamp}-`;

beforeAll(async () => {
  // The additive sync derives distribution_channels straight from the Drizzle
  // barrel, so importing app.ts (no boot DDL) still finds the table.
  await ensureCaptureLoopSchema();
  app = (await import("../app.js")).default;

  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name, is_platform_admin)
     VALUES ($1,$2,$3,'true'),($4,$5,$6,'false')
     RETURNING id`,
    [
      `dc-admin-${stamp}`,
      `dc-admin-${stamp}@test.local`,
      "Channel Admin",
      `dc-steward-${stamp}`,
      `dc-steward-${stamp}@test.local`,
      "Channel Steward",
    ],
  );
  adminId = rows[0].id;
  stewardId = rows[1].id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM distribution_channels WHERE key LIKE $1`, [
    `${keyPrefix}%`,
  ]);
  await pool.query(
    `DELETE FROM faculty_users WHERE clerk_user_id IN ($1,$2)`,
    [`dc-admin-${stamp}`, `dc-steward-${stamp}`],
  );
});

async function createChannel(
  body: Record<string, unknown>,
): Promise<request.Response> {
  return request(app)
    .post("/api/faculty/admin/distribution-channels")
    .send(body);
}

describe("distribution channels — read access", () => {
  test("any signed-in faculty member can list channels", async () => {
    stubFacultyUserId = stewardId;
    const res = await request(app).get("/api/faculty/distribution-channels");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.channels)).toBe(true);
  });

  test("an unauthenticated request is rejected", async () => {
    stubFacultyUserId = 0;
    const res = await request(app).get("/api/faculty/distribution-channels");
    expect(res.status).toBe(401);
  });

  test("a non-admin cannot reach the admin list", async () => {
    stubFacultyUserId = stewardId;
    const res = await request(app).get(
      "/api/faculty/admin/distribution-channels",
    );
    expect(res.status).toBe(403);
  });
});

describe("distribution channels — admin CRUD", () => {
  test("admin can create, then sees the channel in both lists", async () => {
    stubFacultyUserId = adminId;
    const key = `${keyPrefix}create`;
    const res = await createChannel({
      key,
      name: "Test Outlet",
      description: "A test channel",
      category: "News outlet",
      status: "soon",
    });
    expect(res.status).toBe(201);
    expect(res.body.channel.key).toBe(key);
    expect(res.body.channel.status).toBe("soon");
    expect(typeof res.body.channel.sortOrder).toBe("number");

    const adminList = await request(app).get(
      "/api/faculty/admin/distribution-channels",
    );
    expect(
      (adminList.body.channels as Array<{ key: string }>).some(
        (c) => c.key === key,
      ),
    ).toBe(true);

    // A regular steward sees the same row on the public faculty list.
    stubFacultyUserId = stewardId;
    const facultyList = await request(app).get(
      "/api/faculty/distribution-channels",
    );
    expect(
      (facultyList.body.channels as Array<{ key: string }>).some(
        (c) => c.key === key,
      ),
    ).toBe(true);
  });

  test("a non-admin cannot create a channel", async () => {
    stubFacultyUserId = stewardId;
    const res = await createChannel({
      key: `${keyPrefix}forbidden`,
      name: "Nope",
      status: "soon",
    });
    expect(res.status).toBe(403);
  });

  test("duplicate key is rejected with 409", async () => {
    stubFacultyUserId = adminId;
    const key = `${keyPrefix}dupe`;
    const first = await createChannel({ key, name: "First", status: "soon" });
    expect(first.status).toBe(201);
    const second = await createChannel({
      key,
      name: "Second",
      status: "soon",
    });
    expect(second.status).toBe(409);
  });

  test("an invalid key shape is rejected", async () => {
    stubFacultyUserId = adminId;
    const res = await createChannel({
      key: `${keyPrefix}Bad Key`,
      name: "Bad",
      status: "soon",
    });
    expect(res.status).toBe(400);
  });

  test("an unknown outlet is rejected", async () => {
    stubFacultyUserId = adminId;
    const res = await createChannel({
      key: `${keyPrefix}badoutlet`,
      name: "Bad Outlet",
      status: "live",
      outlet: "tiktok",
    });
    expect(res.status).toBe(400);
  });

  test("a non-http href is rejected", async () => {
    stubFacultyUserId = adminId;
    const res = await createChannel({
      key: `${keyPrefix}badhref`,
      name: "Bad Href",
      status: "live",
      href: "example.com",
    });
    expect(res.status).toBe(400);
  });

  test("a live channel with neither outlet nor href is rejected", async () => {
    stubFacultyUserId = adminId;
    const res = await createChannel({
      key: `${keyPrefix}deadlive`,
      name: "Dead Live",
      status: "live",
    });
    expect(res.status).toBe(400);
  });

  test("a live channel with a valid href is accepted", async () => {
    stubFacultyUserId = adminId;
    const res = await createChannel({
      key: `${keyPrefix}livehref`,
      name: "Live Href",
      status: "live",
      href: "https://example.com/feed",
    });
    expect(res.status).toBe(201);
    expect(res.body.channel.href).toBe("https://example.com/feed");
  });

  test("admin can patch editable fields but key stays immutable", async () => {
    stubFacultyUserId = adminId;
    const key = `${keyPrefix}patch`;
    const created = await createChannel({
      key,
      name: "Before",
      status: "soon",
    });
    const id = created.body.channel.id as number;

    const res = await request(app)
      .patch(`/api/faculty/admin/distribution-channels/${id}`)
      .send({
        key: `${keyPrefix}patched-key`, // should be ignored
        name: "After",
        status: "live",
        href: "https://example.com/after",
        isPrimary: true,
      });
    expect(res.status).toBe(200);
    expect(res.body.channel.name).toBe("After");
    expect(res.body.channel.status).toBe("live");
    expect(res.body.channel.isPrimary).toBe(true);
    // key never changes
    expect(res.body.channel.key).toBe(key);
  });

  test("patching a missing channel returns 404", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app)
      .patch("/api/faculty/admin/distribution-channels/99999999")
      .send({ name: "Ghost", status: "soon" });
    expect(res.status).toBe(404);
  });

  test("a non-admin cannot patch", async () => {
    stubFacultyUserId = adminId;
    const created = await createChannel({
      key: `${keyPrefix}patchguard`,
      name: "Guarded",
      status: "soon",
    });
    const id = created.body.channel.id as number;
    stubFacultyUserId = stewardId;
    const res = await request(app)
      .patch(`/api/faculty/admin/distribution-channels/${id}`)
      .send({ name: "Hacked", status: "soon" });
    expect(res.status).toBe(403);
  });

  test("admin can delete a channel; a second delete 404s", async () => {
    stubFacultyUserId = adminId;
    const created = await createChannel({
      key: `${keyPrefix}delete`,
      name: "To Delete",
      status: "soon",
    });
    const id = created.body.channel.id as number;

    const del = await request(app).delete(
      `/api/faculty/admin/distribution-channels/${id}`,
    );
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    const again = await request(app).delete(
      `/api/faculty/admin/distribution-channels/${id}`,
    );
    expect(again.status).toBe(404);
  });

  test("a non-admin cannot delete", async () => {
    stubFacultyUserId = adminId;
    const created = await createChannel({
      key: `${keyPrefix}deleteguard`,
      name: "Guarded Delete",
      status: "soon",
    });
    const id = created.body.channel.id as number;
    stubFacultyUserId = stewardId;
    const res = await request(app).delete(
      `/api/faculty/admin/distribution-channels/${id}`,
    );
    expect(res.status).toBe(403);
  });
});
