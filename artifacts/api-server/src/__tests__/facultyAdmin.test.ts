import { afterAll, beforeAll, beforeEach, describe, test, expect, vi } from "vitest";
import { ensureCaptureLoopSchema } from "./testHelpers.js";

// Stub the Clerk backend client so the admin edit / reset-password routes
// don't make network calls. `@clerk/express` is otherwise left intact so
// app.ts (clerkMiddleware) and the real facultyAuth module still load.
const clerkMocks = vi.hoisted(() => ({
  updateUser: vi.fn(async (_id: string, _body: unknown) => ({})),
  banUser: vi.fn(async (_id: string) => ({})),
  unbanUser: vi.fn(async (_id: string) => ({})),
  getUserList: vi.fn(
    async (
      _params: unknown,
    ): Promise<{
      data: Array<{ id: string; banned: boolean; locked?: boolean }>;
    }> => ({
      data: [],
    }),
  ),
  unlockUser: vi.fn(async (_id: string) => ({})),
}));
vi.mock("@clerk/express", async () => {
  const actual =
    await vi.importActual<typeof import("@clerk/express")>("@clerk/express");
  return {
    ...actual,
    clerkClient: {
      users: {
        updateUser: clerkMocks.updateUser,
        banUser: clerkMocks.banUser,
        unbanUser: clerkMocks.unbanUser,
        getUserList: clerkMocks.getUserList,
        unlockUser: clerkMocks.unlockUser,
      },
    },
  };
});

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
      // Routes call req.log.warn on best-effort Clerk failures.
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
let adminId = 0;
let stewardId = 0;
let demoId = 0;

beforeAll(async () => {
  await ensureCaptureLoopSchema();
  app = (await import("../app.js")).default;

  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name, is_platform_admin)
     VALUES ($1,$2,$3,'true'),($4,$5,$6,'false'),($7,$8,$9,'false'),($10,$11,$12,'false')
     RETURNING id`,
    [
      `fa-admin-${stamp}`,
      `fa-admin-${stamp}@test.local`,
      "Faculty Admin",
      `fa-steward-${stamp}`,
      `fa-steward-${stamp}@test.local`,
      "Regular Steward",
      // A retired demo account — must be hidden from the roster.
      `fa-demo-${stamp}`,
      "demo-allison@palonur.com",
      "Allison Demo",
      // A leftover test-suite account on the reserved @example.com domain —
      // must be hidden by the domain rule, not an exact-match allowlist.
      `fa-example-${stamp}`,
      `admin-${stamp}@example.com`,
      "Ada Admin",
    ],
  );
  adminId = rows[0].id;
  stewardId = rows[1].id;
  demoId = rows[2].id;
});

afterAll(async () => {
  await pool.query(
    `DELETE FROM faculty_users WHERE clerk_user_id IN ($1,$2,$3,$4)`,
    [
      `fa-admin-${stamp}`,
      `fa-steward-${stamp}`,
      `fa-demo-${stamp}`,
      `fa-example-${stamp}`,
    ],
  );
});

beforeEach(() => {
  clerkMocks.updateUser.mockClear();
  clerkMocks.banUser.mockClear();
  clerkMocks.banUser.mockImplementation(async () => ({}));
  clerkMocks.unbanUser.mockClear();
  clerkMocks.unbanUser.mockImplementation(async () => ({}));
  clerkMocks.getUserList.mockClear();
  clerkMocks.getUserList.mockImplementation(async () => ({ data: [] }));
  clerkMocks.unlockUser.mockClear();
  clerkMocks.unlockUser.mockImplementation(async () => ({}));
});

describe("faculty admin roster + member editing", () => {
  test("roster includes real faculty but hides retired demo accounts", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app).get("/api/faculty/admin/members");
    expect(res.status).toBe(200);
    const emails = (res.body.members as Array<{ email: string }>).map(
      (m) => m.email,
    );
    expect(emails).toContain(`fa-admin-${stamp}@test.local`);
    expect(emails).toContain(`fa-steward-${stamp}@test.local`);
    expect(emails).not.toContain("demo-allison@palonur.com");
    // Leftover test-suite accounts on the reserved @example.com domain must be
    // hidden by pattern, even though their timestamped email isn't allowlisted.
    expect(emails).not.toContain(`admin-${stamp}@example.com`);
  });

  test("roster reports Clerk ban status and flags a banned-but-active mismatch", async () => {
    stubFacultyUserId = adminId;
    // The steward is banned in Clerk but active locally → silent lockout.
    clerkMocks.getUserList.mockImplementation(async () => ({
      data: [
        { id: `fa-admin-${stamp}`, banned: false },
        { id: `fa-steward-${stamp}`, banned: true },
      ],
    }));
    const res = await request(app).get("/api/faculty/admin/members");
    expect(res.status).toBe(200);
    const members = res.body.members as Array<{
      email: string;
      clerkStatus: string;
      clerkMismatch: boolean;
    }>;
    const admin = members.find(
      (m) => m.email === `fa-admin-${stamp}@test.local`,
    );
    const steward = members.find(
      (m) => m.email === `fa-steward-${stamp}@test.local`,
    );
    expect(admin?.clerkStatus).toBe("active");
    expect(admin?.clerkMismatch).toBe(false);
    expect(steward?.clerkStatus).toBe("banned");
    expect(steward?.clerkMismatch).toBe(true);
  });

  test("roster reports a temporarily locked account without a mismatch (ban wins over lock)", async () => {
    stubFacultyUserId = adminId;
    clerkMocks.getUserList.mockImplementation(async () => ({
      data: [
        // Locked but not banned → "locked", never a mismatch.
        { id: `fa-steward-${stamp}`, banned: false, locked: true },
        // Banned AND locked → ban takes precedence.
        { id: `fa-admin-${stamp}`, banned: true, locked: true },
      ],
    }));
    const res = await request(app).get("/api/faculty/admin/members");
    expect(res.status).toBe(200);
    const members = res.body.members as Array<{
      email: string;
      clerkStatus: string;
      clerkMismatch: boolean;
    }>;
    const steward = members.find(
      (m) => m.email === `fa-steward-${stamp}@test.local`,
    );
    const admin = members.find(
      (m) => m.email === `fa-admin-${stamp}@test.local`,
    );
    expect(steward?.clerkStatus).toBe("locked");
    expect(steward?.clerkMismatch).toBe(false);
    expect(admin?.clerkStatus).toBe("banned");
  });

  test("admin can unlock a locked member; non-admins cannot", async () => {
    // Non-admin → 403, and Clerk is never called.
    stubFacultyUserId = stewardId;
    const forbidden = await request(app).post(
      `/api/faculty/admin/members/${adminId}/unlock`,
    );
    expect(forbidden.status).toBe(403);
    expect(clerkMocks.unlockUser).not.toHaveBeenCalled();

    // Admin → unlocks via the Clerk backend API.
    stubFacultyUserId = adminId;
    const ok = await request(app).post(
      `/api/faculty/admin/members/${stewardId}/unlock`,
    );
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(clerkMocks.unlockUser).toHaveBeenCalledWith(`fa-steward-${stamp}`);
  });

  test("unlock surfaces a Clerk failure as an error (not a silent success)", async () => {
    stubFacultyUserId = adminId;
    clerkMocks.unlockUser.mockImplementation(async () => {
      throw new Error("clerk down");
    });
    const res = await request(app).post(
      `/api/faculty/admin/members/${stewardId}/unlock`,
    );
    expect(res.status).toBe(502);
  });

  test("roster survives a Clerk lookup failure with status unknown", async () => {
    stubFacultyUserId = adminId;
    clerkMocks.getUserList.mockImplementation(async () => {
      throw new Error("clerk down");
    });
    const res = await request(app).get("/api/faculty/admin/members");
    expect(res.status).toBe(200);
    const members = res.body.members as Array<{
      email: string;
      clerkStatus: string;
      clerkMismatch: boolean;
    }>;
    expect(members.length).toBeGreaterThan(0);
    for (const m of members) {
      expect(m.clerkStatus).toBe("unknown");
      expect(m.clerkMismatch).toBe(false);
    }
  });

  test("a member missing from the Clerk lookup stays unknown without a mismatch", async () => {
    stubFacultyUserId = adminId;
    clerkMocks.getUserList.mockImplementation(async () => ({
      data: [{ id: `fa-admin-${stamp}`, banned: false }],
    }));
    const res = await request(app).get("/api/faculty/admin/members");
    expect(res.status).toBe(200);
    const steward = (
      res.body.members as Array<{
        email: string;
        clerkStatus: string;
        clerkMismatch: boolean;
      }>
    ).find((m) => m.email === `fa-steward-${stamp}@test.local`);
    expect(steward?.clerkStatus).toBe("unknown");
    expect(steward?.clerkMismatch).toBe(false);
  });

  test("a non-admin cannot read the roster", async () => {
    stubFacultyUserId = stewardId;
    const res = await request(app).get("/api/faculty/admin/members");
    expect(res.status).toBe(403);
  });

  test("admin pillars overview lists every pillar incl. empty ones with counts", async () => {
    stubFacultyUserId = adminId;
    // A pillar nobody is a member of must still appear with a 0 count.
    const emptySlug = `fa-empty-${stamp}`;
    await pool.query(
      `INSERT INTO pillars (slug, name, description) VALUES ($1,$2,$3)
       ON CONFLICT (slug) DO NOTHING`,
      [emptySlug, "Empty Pillar", "no faculty yet"],
    );
    // A pillar with one real member.
    const staffedSlug = `fa-staffed-${stamp}`;
    const { rows: pr } = await pool.query<{ id: number }>(
      `INSERT INTO pillars (slug, name, description) VALUES ($1,$2,$3)
       ON CONFLICT (slug) DO NOTHING RETURNING id`,
      [staffedSlug, "Staffed Pillar", "has faculty"],
    );
    const staffedId =
      pr[0]?.id ??
      (
        await pool.query<{ id: number }>(
          `SELECT id FROM pillars WHERE slug = $1`,
          [staffedSlug],
        )
      ).rows[0].id;
    await pool.query(
      `INSERT INTO faculty_memberships (user_id, pillar_id, role) VALUES ($1,$2,'steward')`,
      [stewardId, staffedId],
    );

    const res = await request(app).get("/api/faculty/admin/pillars");
    expect(res.status).toBe(200);
    const pillars = res.body.pillars as Array<{
      slug: string;
      facultyCount: number;
      pendingInviteCount: number;
    }>;
    const empty = pillars.find((p) => p.slug === emptySlug);
    const staffed = pillars.find((p) => p.slug === staffedSlug);
    expect(empty?.facultyCount).toBe(0);
    expect(empty?.pendingInviteCount).toBe(0);
    expect(staffed?.facultyCount).toBe(1);

    await pool.query(`DELETE FROM faculty_memberships WHERE pillar_id = $1`, [
      staffedId,
    ]);
    await pool.query(`DELETE FROM pillars WHERE slug IN ($1,$2)`, [
      emptySlug,
      staffedSlug,
    ]);
  });

  test("an empty pillar with a pending invite reports pendingInviteCount", async () => {
    stubFacultyUserId = adminId;
    const slug = `fa-pending-${stamp}`;
    const { rows: pr } = await pool.query<{ id: number }>(
      `INSERT INTO pillars (slug, name, description) VALUES ($1,$2,$3)
       ON CONFLICT (slug) DO NOTHING RETURNING id`,
      [slug, "Pending Pillar", "invite in flight"],
    );
    const pillarId =
      pr[0]?.id ??
      (
        await pool.query<{ id: number }>(
          `SELECT id FROM pillars WHERE slug = $1`,
          [slug],
        )
      ).rows[0].id;

    // A live pending invite, an expired one, and a non-pending one — only the
    // first should count toward pendingInviteCount.
    await pool.query(
      `INSERT INTO faculty_invitations
         (email, pillar_id, role, invited_by_user_id, status, expires_at)
       VALUES
         ($1,$2,'steward',$3,'pending', now() + interval '7 days'),
         ($4,$2,'steward',$3,'pending', now() - interval '1 day'),
         ($5,$2,'steward',$3,'accepted', now() + interval '7 days')`,
      [
        `invitee-${stamp}@test.local`,
        pillarId,
        adminId,
        `expired-${stamp}@test.local`,
        `accepted-${stamp}@test.local`,
      ],
    );

    const res = await request(app).get("/api/faculty/admin/pillars");
    expect(res.status).toBe(200);
    const pillars = res.body.pillars as Array<{
      slug: string;
      facultyCount: number;
      pendingInviteCount: number;
    }>;
    const pending = pillars.find((p) => p.slug === slug);
    expect(pending?.facultyCount).toBe(0);
    expect(pending?.pendingInviteCount).toBe(1);

    await pool.query(`DELETE FROM faculty_invitations WHERE pillar_id = $1`, [
      pillarId,
    ]);
    await pool.query(`DELETE FROM pillars WHERE slug = $1`, [slug]);
  });

  test("a non-admin cannot read the pillars overview", async () => {
    stubFacultyUserId = stewardId;
    const res = await request(app).get("/api/faculty/admin/pillars");
    expect(res.status).toBe(403);
  });

  test("public pillars endpoint is anonymous, lists active pillars by name only, and never surfaces stewards", async () => {
    // No stub user — this is the signed-out surface.
    stubFacultyUserId = 0;

    const activeSlug = `fa-pub-active-${stamp}`;
    const retiredSlug = `fa-pub-retired-${stamp}`;
    const { rows: ar } = await pool.query<{ id: number }>(
      `INSERT INTO pillars (slug, name, description) VALUES ($1,$2,$3)
       ON CONFLICT (slug) DO NOTHING RETURNING id`,
      [activeSlug, "Public Active Pillar", "live"],
    );
    const activeId =
      ar[0]?.id ??
      (
        await pool.query<{ id: number }>(
          `SELECT id FROM pillars WHERE slug = $1`,
          [activeSlug],
        )
      ).rows[0].id;
    await pool.query(
      `INSERT INTO pillars (slug, name, description, retired_at)
       VALUES ($1,$2,$3, now()) ON CONFLICT (slug) DO NOTHING`,
      [retiredSlug, "Public Retired Pillar", "gone"],
    );
    // Put real + demo stewards on the active pillar to prove no steward
    // identity leaks through this anonymous surface.
    await pool.query(
      `INSERT INTO faculty_memberships (user_id, pillar_id, role)
       VALUES ($1,$2,'steward'),($3,$2,'steward')`,
      [stewardId, activeId, demoId],
    );

    const res = await request(app).get("/api/faculty/public/pillars");
    expect(res.status).toBe(200);
    const pillars = res.body.pillars as Array<{
      slug: string;
      name: string;
      description: string | null;
    }>;
    const active = pillars.find((p) => p.slug === activeSlug);
    expect(active).toBeTruthy();
    expect(active!.name).toBe("Public Active Pillar");
    // Stewards are deliberately not surfaced yet — no field, no names.
    expect((active as Record<string, unknown>).stewards).toBeUndefined();
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("Regular Steward");
    expect(body).not.toContain("Allison Demo");
    // Retired pillars never appear on the public surface.
    expect(pillars.find((p) => p.slug === retiredSlug)).toBeUndefined();

    await pool.query(`DELETE FROM faculty_memberships WHERE pillar_id = $1`, [
      activeId,
    ]);
    await pool.query(`DELETE FROM pillars WHERE slug IN ($1,$2)`, [
      activeSlug,
      retiredSlug,
    ]);
  });

  test("a non-admin cannot edit a member", async () => {
    stubFacultyUserId = stewardId;
    const res = await request(app)
      .patch(`/api/faculty/admin/members/${adminId}`)
      .send({ fullName: "Hacked" });
    expect(res.status).toBe(403);
    expect(clerkMocks.updateUser).not.toHaveBeenCalled();
  });

  test("an admin renames a member (DB updated + mirrored to Clerk)", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app)
      .patch(`/api/faculty/admin/members/${stewardId}`)
      .send({ fullName: "Renamed Steward" });
    expect(res.status).toBe(200);
    expect(res.body.fullName).toBe("Renamed Steward");
    const { rows } = await pool.query<{ full_name: string }>(
      `SELECT full_name FROM faculty_users WHERE id = $1`,
      [stewardId],
    );
    expect(rows[0].full_name).toBe("Renamed Steward");
    expect(clerkMocks.updateUser).toHaveBeenCalledWith(`fa-steward-${stamp}`, {
      firstName: "Renamed",
      lastName: "Steward",
    });
  });

  test("a non-admin cannot reset a password", async () => {
    stubFacultyUserId = stewardId;
    const res = await request(app)
      .post(`/api/faculty/admin/members/${adminId}/reset-password`)
      .send({ password: "longenough123" });
    expect(res.status).toBe(403);
    expect(clerkMocks.updateUser).not.toHaveBeenCalled();
  });

  test("an admin reset rejects a too-short password before calling Clerk", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app)
      .post(`/api/faculty/admin/members/${stewardId}/reset-password`)
      .send({ password: "short" });
    expect(res.status).toBe(400);
    expect(clerkMocks.updateUser).not.toHaveBeenCalled();
  });

  test("an admin resets a member's password via Clerk", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app)
      .post(`/api/faculty/admin/members/${stewardId}/reset-password`)
      .send({ password: "longenough123" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(clerkMocks.updateUser).toHaveBeenCalledWith(`fa-steward-${stamp}`, {
      password: "longenough123",
    });
  });
});

describe("faculty admin pillar management", () => {
  const createdSlug = `fa-new-${stamp}`;

  afterAll(async () => {
    await pool.query(`DELETE FROM pillars WHERE slug LIKE $1`, [
      `fa-%-${stamp}`,
    ]);
  });

  test("a non-admin cannot create a pillar", async () => {
    stubFacultyUserId = stewardId;
    const res = await request(app)
      .post("/api/faculty/admin/pillars")
      .send({ name: "Nope", slug: `fa-nope-${stamp}` });
    expect(res.status).toBe(403);
  });

  test("an admin creates a pillar", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app)
      .post("/api/faculty/admin/pillars")
      .send({ name: "Purpose", slug: createdSlug, description: "meaning" });
    expect(res.status).toBe(201);
    expect(res.body.pillar.slug).toBe(createdSlug);
    expect(res.body.pillar.name).toBe("Purpose");
  });

  test("a duplicate slug is rejected with 409", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app)
      .post("/api/faculty/admin/pillars")
      .send({ name: "Dup", slug: createdSlug });
    expect(res.status).toBe(409);
  });

  test("an invalid slug is rejected with 400", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app)
      .post("/api/faculty/admin/pillars")
      .send({ name: "Bad", slug: "Not A Slug!" });
    expect(res.status).toBe(400);
  });

  test("an admin renames a pillar (slug unchanged)", async () => {
    stubFacultyUserId = adminId;
    const { rows } = await pool.query<{ id: number }>(
      `SELECT id FROM pillars WHERE slug = $1`,
      [createdSlug],
    );
    const id = rows[0].id;
    const res = await request(app)
      .patch(`/api/faculty/admin/pillars/${id}`)
      .send({ name: "Purpose & Meaning", description: "updated" });
    expect(res.status).toBe(200);
    expect(res.body.pillar.name).toBe("Purpose & Meaning");
    expect(res.body.pillar.slug).toBe(createdSlug);
  });

  test("an admin retires then restores a pillar", async () => {
    stubFacultyUserId = adminId;
    const { rows } = await pool.query<{ id: number }>(
      `SELECT id FROM pillars WHERE slug = $1`,
      [createdSlug],
    );
    const id = rows[0].id;
    const retire = await request(app)
      .post(`/api/faculty/admin/pillars/${id}/retire`)
      .send({ retired: true });
    expect(retire.status).toBe(200);
    expect(retire.body.retiredAt).not.toBeNull();

    const overview = await request(app).get("/api/faculty/admin/pillars");
    const found = (
      overview.body.pillars as Array<{ slug: string; retiredAt: string | null }>
    ).find((p) => p.slug === createdSlug);
    expect(found?.retiredAt).not.toBeNull();

    const restore = await request(app)
      .post(`/api/faculty/admin/pillars/${id}/retire`)
      .send({ retired: false });
    expect(restore.status).toBe(200);
    expect(restore.body.retiredAt).toBeNull();
  });

  test("an empty pillar deletes immediately", async () => {
    stubFacultyUserId = adminId;
    const slug = `fa-empty-del-${stamp}`;
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO pillars (slug, name) VALUES ($1,$2) RETURNING id`,
      [slug, "Empty Del"],
    );
    const id = rows[0].id;
    const res = await request(app).delete(`/api/faculty/admin/pillars/${id}`);
    expect(res.status).toBe(200);
    const { rows: after } = await pool.query(
      `SELECT id FROM pillars WHERE id = $1`,
      [id],
    );
    expect(after.length).toBe(0);
  });

  test("a populated pillar refuses delete without force, then deletes with force", async () => {
    stubFacultyUserId = adminId;
    const slug = `fa-pop-${stamp}`;
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO pillars (slug, name) VALUES ($1,$2) RETURNING id`,
      [slug, "Populated"],
    );
    const id = rows[0].id;
    await pool.query(
      `INSERT INTO faculty_memberships (user_id, pillar_id, role) VALUES ($1,$2,'steward')`,
      [stewardId, id],
    );

    const blocked = await request(app).delete(
      `/api/faculty/admin/pillars/${id}`,
    );
    expect(blocked.status).toBe(409);
    expect(blocked.body.requiresConfirmation).toBe(true);
    expect(blocked.body.facultyCount).toBe(1);

    const still = await pool.query(`SELECT id FROM pillars WHERE id = $1`, [id]);
    expect(still.rows.length).toBe(1);

    const forced = await request(app).delete(
      `/api/faculty/admin/pillars/${id}?force=true`,
    );
    expect(forced.status).toBe(200);
    const after = await pool.query(`SELECT id FROM pillars WHERE id = $1`, [id]);
    expect(after.rows.length).toBe(0);
    // Membership cascaded away with the pillar.
    const mem = await pool.query(
      `SELECT id FROM faculty_memberships WHERE pillar_id = $1`,
      [id],
    );
    expect(mem.rows.length).toBe(0);
  });

  test("a non-admin cannot delete a pillar", async () => {
    stubFacultyUserId = stewardId;
    const { rows } = await pool.query<{ id: number }>(
      `SELECT id FROM pillars WHERE slug = $1`,
      [createdSlug],
    );
    const res = await request(app).delete(
      `/api/faculty/admin/pillars/${rows[0].id}`,
    );
    expect(res.status).toBe(403);
  });
});

// Task #389: a platform admin manages a member's pillar roles and access from
// /admin — change a role, add a pillar directly (no invite), remove from one
// pillar, and remove the person entirely (soft deactivate + Clerk ban). The
// guardrails (last-steward-of-active-pillar, no self-deactivation) and the
// invariant that removing access never deletes authored content are covered.
describe("faculty admin role + access management", () => {
  // A dedicated target member plus a co-steward so we can exercise both the
  // "would orphan the pillar" and "another steward exists" branches.
  let targetId = 0;
  let coStewardId = 0;
  // soloPillar: target is the ONLY steward (active) → guardrail fires.
  // sharedPillar: target + co-steward both steward (active) → no guardrail.
  // retiredPillar: target is sole steward but pillar is retired → no guardrail.
  let soloPillarId = 0;
  let sharedPillarId = 0;
  let retiredPillarId = 0;
  let spareePillarId = 0; // an empty active pillar to add the member to

  beforeAll(async () => {
    const { rows: u } = await pool.query<{ id: number }>(
      `INSERT INTO faculty_users (clerk_user_id, email, full_name, is_platform_admin)
       VALUES ($1,$2,$3,'false'),($4,$5,$6,'false') RETURNING id`,
      [
        `fa-target-${stamp}`,
        `fa-target-${stamp}@test.local`,
        "Target Member",
        `fa-costew-${stamp}`,
        `fa-costew-${stamp}@test.local`,
        "Co Steward",
      ],
    );
    targetId = u[0].id;
    coStewardId = u[1].id;

    const mkPillar = async (suffix: string, retired = false) => {
      const slug = `fa-rm-${suffix}-${stamp}`;
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO pillars (slug, name, description, retired_at)
         VALUES ($1,$2,$3,${retired ? "now()" : "NULL"}) RETURNING id`,
        [slug, `RM ${suffix}`, "role mgmt test pillar"],
      );
      return rows[0].id;
    };
    soloPillarId = await mkPillar("solo");
    sharedPillarId = await mkPillar("shared");
    retiredPillarId = await mkPillar("retired", true);
    spareePillarId = await mkPillar("spare");

    await pool.query(
      `INSERT INTO faculty_memberships (user_id, pillar_id, role) VALUES
         ($1,$2,'steward'),
         ($1,$3,'steward'),
         ($4,$3,'steward'),
         ($1,$5,'steward')`,
      [targetId, soloPillarId, sharedPillarId, coStewardId, retiredPillarId],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM faculty_users WHERE clerk_user_id IN ($1,$2)`, [
      `fa-target-${stamp}`,
      `fa-costew-${stamp}`,
    ]);
    await pool.query(`DELETE FROM pillars WHERE slug LIKE $1`, [
      `fa-rm-%-${stamp}`,
    ]);
  });

  beforeEach(() => {
    clerkMocks.banUser.mockClear();
    clerkMocks.unbanUser.mockClear();
  });

  test("a non-admin cannot change a role, add, remove, or deactivate", async () => {
    stubFacultyUserId = stewardId;
    const role = await request(app)
      .patch(`/api/faculty/admin/members/${targetId}/memberships/${sharedPillarId}`)
      .send({ role: "viewer" });
    expect(role.status).toBe(403);
    const add = await request(app)
      .post(`/api/faculty/admin/members/${targetId}/memberships`)
      .send({ pillarId: spareePillarId, role: "steward" });
    expect(add.status).toBe(403);
    const remove = await request(app).delete(
      `/api/faculty/admin/members/${targetId}/memberships/${sharedPillarId}`,
    );
    expect(remove.status).toBe(403);
    const deact = await request(app).post(
      `/api/faculty/admin/members/${targetId}/deactivate`,
    );
    expect(deact.status).toBe(403);
    expect(clerkMocks.banUser).not.toHaveBeenCalled();
  });

  test("an admin adds a member to a pillar directly (no invite)", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app)
      .post(`/api/faculty/admin/members/${targetId}/memberships`)
      .send({ pillarId: spareePillarId, role: "contributor" });
    expect(res.status).toBe(201);
    expect(res.body.pillarId).toBe(spareePillarId);
    expect(res.body.role).toBe("contributor");
    const { rows } = await pool.query<{ role: string }>(
      `SELECT role FROM faculty_memberships WHERE user_id = $1 AND pillar_id = $2`,
      [targetId, spareePillarId],
    );
    expect(rows[0]?.role).toBe("contributor");
  });

  test("adding a member to a pillar they already belong to is rejected (409)", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app)
      .post(`/api/faculty/admin/members/${targetId}/memberships`)
      .send({ pillarId: spareePillarId, role: "steward" });
    expect(res.status).toBe(409);
  });

  test("an admin changes a member's role on a pillar with another steward", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app)
      .patch(`/api/faculty/admin/members/${targetId}/memberships/${sharedPillarId}`)
      .send({ role: "viewer" });
    expect(res.status).toBe(200);
    const { rows } = await pool.query<{ role: string }>(
      `SELECT role FROM faculty_memberships WHERE user_id = $1 AND pillar_id = $2`,
      [targetId, sharedPillarId],
    );
    expect(rows[0].role).toBe("viewer");
    // restore for later tests
    await pool.query(
      `UPDATE faculty_memberships SET role = 'steward' WHERE user_id = $1 AND pillar_id = $2`,
      [targetId, sharedPillarId],
    );
  });

  test("demoting the sole steward of an active pillar warns, then proceeds with force", async () => {
    stubFacultyUserId = adminId;
    const warn = await request(app)
      .patch(`/api/faculty/admin/members/${targetId}/memberships/${soloPillarId}`)
      .send({ role: "viewer" });
    expect(warn.status).toBe(409);
    expect(warn.body.requiresConfirmation).toBe(true);
    expect(warn.body.reason).toBe("last-steward");
    // unchanged until forced
    let { rows } = await pool.query<{ role: string }>(
      `SELECT role FROM faculty_memberships WHERE user_id = $1 AND pillar_id = $2`,
      [targetId, soloPillarId],
    );
    expect(rows[0].role).toBe("steward");

    const forced = await request(app)
      .patch(
        `/api/faculty/admin/members/${targetId}/memberships/${soloPillarId}?force=true`,
      )
      .send({ role: "viewer" });
    expect(forced.status).toBe(200);
    ({ rows } = await pool.query<{ role: string }>(
      `SELECT role FROM faculty_memberships WHERE user_id = $1 AND pillar_id = $2`,
      [targetId, soloPillarId],
    ));
    expect(rows[0].role).toBe("viewer");
    // restore
    await pool.query(
      `UPDATE faculty_memberships SET role = 'steward' WHERE user_id = $1 AND pillar_id = $2`,
      [targetId, soloPillarId],
    );
  });

  test("removing a member from a pillar with a co-steward preserves their other pillars", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app).delete(
      `/api/faculty/admin/members/${targetId}/memberships/${sharedPillarId}`,
    );
    expect(res.status).toBe(200);
    const gone = await pool.query(
      `SELECT 1 FROM faculty_memberships WHERE user_id = $1 AND pillar_id = $2`,
      [targetId, sharedPillarId],
    );
    expect(gone.rows.length).toBe(0);
    // other memberships intact
    const others = await pool.query(
      `SELECT 1 FROM faculty_memberships WHERE user_id = $1 AND pillar_id = $2`,
      [targetId, soloPillarId],
    );
    expect(others.rows.length).toBe(1);
    // re-add for cleanliness
    await pool.query(
      `INSERT INTO faculty_memberships (user_id, pillar_id, role) VALUES ($1,$2,'steward')`,
      [targetId, sharedPillarId],
    );
  });

  test("removing the sole steward of an active pillar warns, then proceeds with force", async () => {
    stubFacultyUserId = adminId;
    const warn = await request(app).delete(
      `/api/faculty/admin/members/${targetId}/memberships/${soloPillarId}`,
    );
    expect(warn.status).toBe(409);
    expect(warn.body.requiresConfirmation).toBe(true);
    expect(
      (
        await pool.query(
          `SELECT 1 FROM faculty_memberships WHERE user_id = $1 AND pillar_id = $2`,
          [targetId, soloPillarId],
        )
      ).rows.length,
    ).toBe(1);

    const forced = await request(app).delete(
      `/api/faculty/admin/members/${targetId}/memberships/${soloPillarId}?force=true`,
    );
    expect(forced.status).toBe(200);
    expect(
      (
        await pool.query(
          `SELECT 1 FROM faculty_memberships WHERE user_id = $1 AND pillar_id = $2`,
          [targetId, soloPillarId],
        )
      ).rows.length,
    ).toBe(0);
    // re-add for the deactivate tests
    await pool.query(
      `INSERT INTO faculty_memberships (user_id, pillar_id, role) VALUES ($1,$2,'steward')`,
      [targetId, soloPillarId],
    );
  });

  test("an admin cannot deactivate their own account", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app).post(
      `/api/faculty/admin/members/${adminId}/deactivate`,
    );
    expect(res.status).toBe(400);
    expect(clerkMocks.banUser).not.toHaveBeenCalled();
  });

  test("deactivating a sole-steward warns, then removes access + bans Clerk while preserving authored content", async () => {
    stubFacultyUserId = adminId;
    // Seed authored content so we can prove it survives the removal.
    const { rows: src } = await pool.query<{ id: number }>(
      `INSERT INTO sources (pillar_id, kind, title, status, uploaded_by_user_id)
       VALUES ($1,'paper',$2,'approved',$3) RETURNING id`,
      [soloPillarId, `Authored by target ${stamp}`, targetId],
    );
    const sourceId = src[0].id;
    const { rows: interp } = await pool.query<{ id: number }>(
      `INSERT INTO interpretations (source_id, pillar_id, author_id, status, answer, interpretation)
       VALUES ($1,$2,$3,'approved',$4,$5) RETURNING id`,
      [sourceId, soloPillarId, targetId, "answer", "interpretation body"],
    );
    const interpId = interp[0].id;

    // Sole steward of soloPillar → guardrail fires.
    const warn = await request(app).post(
      `/api/faculty/admin/members/${targetId}/deactivate`,
    );
    expect(warn.status).toBe(409);
    expect(warn.body.requiresConfirmation).toBe(true);
    expect(Array.isArray(warn.body.pillarNames)).toBe(true);
    expect(clerkMocks.banUser).not.toHaveBeenCalled();

    const forced = await request(app).post(
      `/api/faculty/admin/members/${targetId}/deactivate?force=true`,
    );
    expect(forced.status).toBe(200);
    expect(forced.body.deactivatedAt).toBeTruthy();

    // Sign-in disabled: deactivated_at stamped + Clerk banned.
    const { rows: after } = await pool.query<{ deactivated_at: string | null }>(
      `SELECT deactivated_at FROM faculty_users WHERE id = $1`,
      [targetId],
    );
    expect(after[0].deactivated_at).not.toBeNull();
    expect(clerkMocks.banUser).toHaveBeenCalledWith(`fa-target-${stamp}`);

    // All memberships dropped.
    const mem = await pool.query(
      `SELECT 1 FROM faculty_memberships WHERE user_id = $1`,
      [targetId],
    );
    expect(mem.rows.length).toBe(0);

    // Authored content is PRESERVED — never deleted.
    const srcStill = await pool.query(
      `SELECT uploaded_by_user_id FROM sources WHERE id = $1`,
      [sourceId],
    );
    expect(srcStill.rows.length).toBe(1);
    expect(srcStill.rows[0].uploaded_by_user_id).toBe(targetId);
    const interpStill = await pool.query(
      `SELECT author_id FROM interpretations WHERE id = $1`,
      [interpId],
    );
    expect(interpStill.rows.length).toBe(1);
    expect(interpStill.rows[0].author_id).toBe(targetId);

    // cleanup authored rows
    await pool.query(`DELETE FROM interpretations WHERE id = $1`, [interpId]);
    await pool.query(`DELETE FROM sources WHERE id = $1`, [sourceId]);
  });

  test("a deactivated member cannot be added to a pillar until reactivated", async () => {
    stubFacultyUserId = adminId;
    const blocked = await request(app)
      .post(`/api/faculty/admin/members/${targetId}/memberships`)
      .send({ pillarId: spareePillarId, role: "steward" });
    expect(blocked.status).toBe(409);
  });

  test("reactivating a member clears the flag and unbans Clerk (pillars not auto-restored)", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app).post(
      `/api/faculty/admin/members/${targetId}/reactivate`,
    );
    expect(res.status).toBe(200);
    const { rows } = await pool.query<{ deactivated_at: string | null }>(
      `SELECT deactivated_at FROM faculty_users WHERE id = $1`,
      [targetId],
    );
    expect(rows[0].deactivated_at).toBeNull();
    expect(clerkMocks.unbanUser).toHaveBeenCalledWith(`fa-target-${stamp}`);
    // memberships are NOT auto-restored
    const mem = await pool.query(
      `SELECT 1 FROM faculty_memberships WHERE user_id = $1`,
      [targetId],
    );
    expect(mem.rows.length).toBe(0);
  });

  test("deactivate reports a clerkWarning when the Clerk ban call fails (local removal still succeeds)", async () => {
    stubFacultyUserId = adminId;
    clerkMocks.banUser.mockImplementation(async () => {
      throw new Error("clerk exploded");
    });
    const res = await request(app).post(
      `/api/faculty/admin/members/${targetId}/deactivate`,
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.clerkWarning).toMatch(/sign-in/i);
    const { rows } = await pool.query<{ deactivated_at: string | null }>(
      `SELECT deactivated_at FROM faculty_users WHERE id = $1`,
      [targetId],
    );
    expect(rows[0].deactivated_at).not.toBeNull();
  });

  test("reactivate reports a clerkWarning when the Clerk unban call fails (local reactivation still succeeds)", async () => {
    stubFacultyUserId = adminId;
    clerkMocks.unbanUser.mockImplementation(async () => {
      throw new Error("clerk exploded");
    });
    const res = await request(app).post(
      `/api/faculty/admin/members/${targetId}/reactivate`,
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.clerkWarning).toMatch(/locked out/i);
    const { rows } = await pool.query<{ deactivated_at: string | null }>(
      `SELECT deactivated_at FROM faculty_users WHERE id = $1`,
      [targetId],
    );
    expect(rows[0].deactivated_at).toBeNull();
  });

  test("deactivate/reactivate omit clerkWarning when the Clerk calls succeed", async () => {
    stubFacultyUserId = adminId;
    const off = await request(app).post(
      `/api/faculty/admin/members/${targetId}/deactivate`,
    );
    expect(off.status).toBe(200);
    expect(off.body.clerkWarning).toBeUndefined();
    const on = await request(app).post(
      `/api/faculty/admin/members/${targetId}/reactivate`,
    );
    expect(on.status).toBe(200);
    expect(on.body.clerkWarning).toBeUndefined();
  });
});

// End-to-end coverage for Task #244: a platform admin invites a steward onto
// the auto-seeded `slm-ai-lab` ("AI Lab for Education and Leadership") pillar
// through the canonical invitation flow, and the invitee accepting grants the
// `steward` role on that pillar. The invite email funnels through the
// production-gated email guard, so in dev/test it no-ops with a warn rather than
// sending — exactly the behavior the live production invite will exercise.
describe("steward invitation onto the slm-ai-lab pillar", () => {
  const inviteEmail = `karan+slm-${stamp}@test.local`;
  let slmPillarId = 0;
  let inviteeId = 0;

  beforeAll(async () => {
    // The pillar is auto-seeded at server boot (CANONICAL_PILLARS), but tests
    // import app.ts (not index.ts), so the boot seed never runs here. Ensure the
    // canonical row exists so the invite resolves against the real slug.
    const { rows: pillarRows } = await pool.query<{ id: number }>(
      `INSERT INTO pillars (slug, name, description)
         VALUES ('slm-ai-lab', 'AI Lab for Education and Leadership',
                 'Stanford Lifestyle Medicine''s AI Lab.')
       ON CONFLICT (slug) DO UPDATE SET retired_at = NULL
       RETURNING id`,
    );
    slmPillarId = pillarRows[0].id;

    const { rows: userRows } = await pool.query<{ id: number }>(
      `INSERT INTO faculty_users (clerk_user_id, email, full_name)
         VALUES ($1, $2, $3) RETURNING id`,
      [`fa-slm-${stamp}`, inviteEmail, "Karan SLM"],
    );
    inviteeId = userRows[0].id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM faculty_invitations WHERE email = $1`, [
      inviteEmail,
    ]);
    // Membership cascades away with the invitee user.
    await pool.query(`DELETE FROM faculty_users WHERE clerk_user_id = $1`, [
      `fa-slm-${stamp}`,
    ]);
  });

  test("admin creates a steward invite, invitee accepts, and gains the steward role", async () => {
    // 1. Platform admin issues the steward invitation via the canonical flow.
    stubFacultyUserId = adminId;
    const created = await request(app)
      .post("/api/faculty/invitations")
      .send({ email: inviteEmail, pillarId: slmPillarId, role: "steward" });
    expect(created.status).toBe(201);
    expect(created.body.role).toBe("steward");
    expect(created.body.pillarId).toBe(slmPillarId);
    expect(created.body.status).toBe("pending");

    // The invitation row exists; pull its token (not returned in the response).
    const { rows: invRows } = await pool.query<{ token: string }>(
      `SELECT token FROM faculty_invitations
         WHERE email = $1 AND pillar_id = $2 AND status = 'pending'`,
      [inviteEmail, slmPillarId],
    );
    expect(invRows.length).toBe(1);
    const token = invRows[0].token;

    // 2. The invitee signs in and accepts the invitation.
    stubFacultyUserId = inviteeId;
    const accepted = await request(app).post(
      `/api/faculty/invitations/${token}/accept`,
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body.role).toBe("steward");
    expect(accepted.body.pillar.slug).toBe("slm-ai-lab");

    // 3. The invitee now holds the steward role on slm-ai-lab.
    const { rows: memRows } = await pool.query<{ role: string }>(
      `SELECT role FROM faculty_memberships WHERE user_id = $1 AND pillar_id = $2`,
      [inviteeId, slmPillarId],
    );
    expect(memRows.length).toBe(1);
    expect(memRows[0].role).toBe("steward");

    // The invitation is now marked accepted (no longer pending).
    const { rows: doneRows } = await pool.query<{ status: string }>(
      `SELECT status FROM faculty_invitations WHERE token = $1`,
      [token],
    );
    expect(doneRows[0].status).toBe("accepted");
  });
});

// Steward self-service Settings: a steward edits their own profile name and
// renames a pillar they steward, without an engineer or platform admin. The
// pillar rename is gated by `requirePillarRole` (the real middleware runs here —
// the mock only stubs requireFacultyAuth), so a non-steward member or a
// non-member is forbidden, and the slug stays immutable.
describe("steward self-service settings", () => {
  const myPillarSlug = `fa-self-${stamp}`;
  let myPillarId = 0;
  let viewerUserId = 0;

  beforeAll(async () => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO pillars (slug, name, description) VALUES ($1,$2,$3) RETURNING id`,
      [myPillarSlug, "Self Pillar", "owned by steward"],
    );
    myPillarId = rows[0].id;
    await pool.query(
      `INSERT INTO faculty_memberships (user_id, pillar_id, role) VALUES ($1,$2,'steward')`,
      [stewardId, myPillarId],
    );
    // A viewer-only member on the same pillar must NOT be able to rename it.
    const { rows: vr } = await pool.query<{ id: number }>(
      `INSERT INTO faculty_users (clerk_user_id, email, full_name)
         VALUES ($1,$2,$3) RETURNING id`,
      [`fa-viewer-${stamp}`, `fa-viewer-${stamp}@test.local`, "Pillar Viewer"],
    );
    viewerUserId = vr[0].id;
    await pool.query(
      `INSERT INTO faculty_memberships (user_id, pillar_id, role) VALUES ($1,$2,'viewer')`,
      [viewerUserId, myPillarId],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM faculty_memberships WHERE pillar_id = $1`, [
      myPillarId,
    ]);
    await pool.query(`DELETE FROM pillars WHERE id = $1`, [myPillarId]);
    await pool.query(`DELETE FROM faculty_users WHERE clerk_user_id = $1`, [
      `fa-viewer-${stamp}`,
    ]);
  });

  test("a steward updates their own name + institution via PATCH /faculty/me", async () => {
    stubFacultyUserId = stewardId;
    const res = await request(app)
      .patch("/api/faculty/me")
      .send({ fullName: "Self Named Steward", institution: "Stanford" });
    expect(res.status).toBe(200);
    expect(res.body.fullName).toBe("Self Named Steward");
    const { rows } = await pool.query<{
      full_name: string;
      institution: string | null;
    }>(`SELECT full_name, institution FROM faculty_users WHERE id = $1`, [
      stewardId,
    ]);
    expect(rows[0].full_name).toBe("Self Named Steward");
    expect(rows[0].institution).toBe("Stanford");
    // The display name is the app's source of truth — never pushed to Clerk.
    expect(clerkMocks.updateUser).not.toHaveBeenCalled();
  });

  test("PATCH /faculty/me with a blank fullName is rejected (400)", async () => {
    stubFacultyUserId = stewardId;
    const res = await request(app)
      .patch("/api/faculty/me")
      .send({ fullName: "   " });
    expect(res.status).toBe(400);
  });

  test("a steward renames a pillar they steward (slug unchanged)", async () => {
    stubFacultyUserId = stewardId;
    const res = await request(app)
      .patch(`/api/faculty/pillars/${myPillarId}`)
      .send({ name: "Renamed By Steward" });
    expect(res.status).toBe(200);
    expect(res.body.pillar.name).toBe("Renamed By Steward");
    expect(res.body.pillar.slug).toBe(myPillarSlug);
    const { rows } = await pool.query<{ name: string; slug: string }>(
      `SELECT name, slug FROM pillars WHERE id = $1`,
      [myPillarId],
    );
    expect(rows[0].name).toBe("Renamed By Steward");
    expect(rows[0].slug).toBe(myPillarSlug);
  });

  test("a steward rename with a blank name is rejected (400)", async () => {
    stubFacultyUserId = stewardId;
    const res = await request(app)
      .patch(`/api/faculty/pillars/${myPillarId}`)
      .send({ name: "   " });
    expect(res.status).toBe(400);
  });

  test("a viewer-only member cannot rename the pillar (403)", async () => {
    stubFacultyUserId = viewerUserId;
    const res = await request(app)
      .patch(`/api/faculty/pillars/${myPillarId}`)
      .send({ name: "Hacked" });
    expect(res.status).toBe(403);
  });

  test("a non-member cannot rename the pillar (403)", async () => {
    stubFacultyUserId = demoId;
    const res = await request(app)
      .patch(`/api/faculty/pillars/${myPillarId}`)
      .send({ name: "Hacked" });
    expect(res.status).toBe(403);
  });

  test("a platform admin can rename any pillar without membership", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app)
      .patch(`/api/faculty/pillars/${myPillarId}`)
      .send({ name: "Renamed By Admin" });
    expect(res.status).toBe(200);
    expect(res.body.pillar.name).toBe("Renamed By Admin");
  });
});

describe("steward archive + custodian handoff", () => {
  let archiveTargetId = 0;
  let archivePillarId = 0;
  let custodianId = 0;

  beforeAll(async () => {
    // Ensure custodian account exists (boot seed from index.ts doesn't run in tests).
    await pool.query(`
      INSERT INTO faculty_users (clerk_user_id, email, full_name)
      VALUES ('custodian-palonur', 'custodian@palonur.com', 'Custodian')
      ON CONFLICT (clerk_user_id) DO NOTHING
    `);
    const { rows: cu } = await pool.query<{ id: number }>(
      `SELECT id FROM faculty_users WHERE email = 'custodian@palonur.com'`,
    );
    custodianId = cu[0].id;

    const { rows: u } = await pool.query<{ id: number }>(
      `INSERT INTO faculty_users (clerk_user_id, email, full_name, is_platform_admin)
       VALUES ($1,$2,$3,'false') RETURNING id`,
      [
        `fa-arch-${stamp}`,
        `fa-arch-${stamp}@test.local`,
        "Archive Target",
      ],
    );
    archiveTargetId = u[0].id;

    const { rows: p } = await pool.query<{ id: number }>(
      `INSERT INTO pillars (slug, name, description) VALUES ($1,$2,$3) RETURNING id`,
      [
        `fa-arch-${stamp}`,
        `Archive Test ${stamp}`,
        "archive test pillar",
      ],
    );
    archivePillarId = p[0].id;

    await pool.query(
      `INSERT INTO faculty_memberships (user_id, pillar_id, role) VALUES ($1,$2,'steward')`,
      [archiveTargetId, archivePillarId],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM faculty_users WHERE clerk_user_id = $1`, [
      `fa-arch-${stamp}`,
    ]);
    await pool.query(`DELETE FROM pillars WHERE slug = $1`, [
      `fa-arch-${stamp}`,
    ]);
  });

  test("archive adds custodian as co-steward; roster flags isCustodianHeld; restore clears archived_at", async () => {
    stubFacultyUserId = adminId;

    // Archive the target member
    const archRes = await request(app).post(
      `/api/faculty/admin/members/${archiveTargetId}/archive`,
    );
    expect(archRes.status).toBe(200);
    expect(archRes.body.ok).toBe(true);
    expect(archRes.body.archivedAt).toBeTruthy();

    // DB: archived_at is stamped
    const { rows: afterArchive } = await pool.query<{
      archived_at: string | null;
    }>(
      `SELECT archived_at FROM faculty_users WHERE id = $1`,
      [archiveTargetId],
    );
    expect(afterArchive[0].archived_at).not.toBeNull();

    // DB: custodian gained a steward membership on the archived member's pillar
    const { rows: custMem } = await pool.query<{ role: string }>(
      `SELECT role FROM faculty_memberships WHERE user_id = $1 AND pillar_id = $2`,
      [custodianId, archivePillarId],
    );
    expect(custMem.length).toBe(1);
    expect(custMem[0].role).toBe("steward");

    // Roster: archived member's pillar has isCustodianHeld: true
    const rosterRes = await request(app).get("/api/faculty/admin/members");
    expect(rosterRes.status).toBe(200);
    const archiveMember = rosterRes.body.members.find(
      (m: { id: number }) => m.id === archiveTargetId,
    );
    expect(archiveMember).toBeTruthy();
    expect(archiveMember.archivedAt).toBeTruthy();
    const archivedPillar = archiveMember.memberships.find(
      (mm: { pillarId: number }) => mm.pillarId === archivePillarId,
    );
    expect(archivedPillar).toBeTruthy();
    expect(archivedPillar.isCustodianHeld).toBe(true);

    // Archive is idempotent (re-archiving returns 200 without error)
    const idempotentRes = await request(app).post(
      `/api/faculty/admin/members/${archiveTargetId}/archive`,
    );
    expect(idempotentRes.status).toBe(200);

    // Restore clears archived_at
    const restoreRes = await request(app).post(
      `/api/faculty/admin/members/${archiveTargetId}/restore`,
    );
    expect(restoreRes.status).toBe(200);
    expect(restoreRes.body.ok).toBe(true);

    const { rows: afterRestore } = await pool.query<{
      archived_at: string | null;
    }>(
      `SELECT archived_at FROM faculty_users WHERE id = $1`,
      [archiveTargetId],
    );
    expect(afterRestore[0].archived_at).toBeNull();

    // Custodian membership is preserved after restore (admin removes manually)
    const { rows: custMemAfter } = await pool.query(
      `SELECT role FROM faculty_memberships WHERE user_id = $1 AND pillar_id = $2`,
      [custodianId, archivePillarId],
    );
    expect(custMemAfter.length).toBe(1);

    // After restore: archivedAt null, isCustodianHeld still true (custodian still has membership)
    const afterRosterRes = await request(app).get("/api/faculty/admin/members");
    expect(afterRosterRes.status).toBe(200);
    const restoredMember = afterRosterRes.body.members.find(
      (m: { id: number }) => m.id === archiveTargetId,
    );
    expect(restoredMember.archivedAt).toBeNull();
    const restoredPillar = restoredMember.memberships.find(
      (mm: { pillarId: number }) => mm.pillarId === archivePillarId,
    );
    expect(restoredPillar.isCustodianHeld).toBe(true);
  });

  test("a non-admin cannot archive or restore a member", async () => {
    stubFacultyUserId = stewardId;
    const archiveRes = await request(app).post(
      `/api/faculty/admin/members/${archiveTargetId}/archive`,
    );
    expect(archiveRes.status).toBe(403);
    const restoreRes = await request(app).post(
      `/api/faculty/admin/members/${archiveTargetId}/restore`,
    );
    expect(restoreRes.status).toBe(403);
  });

  test("an admin cannot archive themselves", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app).post(
      `/api/faculty/admin/members/${adminId}/archive`,
    );
    expect(res.status).toBe(400);
  });
});
