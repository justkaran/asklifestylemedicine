import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  test,
  expect,
  vi,
} from "vitest";
import { ensureCaptureLoopSchema } from "./testHelpers.js";

// Capture outbound application emails instead of sending them.
const emailMocks = vi.hoisted(() => ({
  verification: vi.fn(async (_args: unknown) => {}),
  admitted: vi.fn(async (_args: unknown) => {}),
  declined: vi.fn(async (_args: unknown) => {}),
  adminNudge: vi.fn(async (_args: unknown) => {}),
}));
vi.mock("../lib/facultyApplicationEmail.js", () => ({
  sendApplicationVerificationEmail: emailMocks.verification,
  sendApplicationAdmittedEmail: emailMocks.admitted,
  sendApplicationDeclinedEmail: emailMocks.declined,
  sendNewApplicationAdminEmail: emailMocks.adminNudge,
}));

// `stubFacultyUserId` lets each test act as a specific signed-in faculty user.
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
const stamp = Date.now().toString(36);
let adminId = 0;
let applicantId = 0;
let invitedMemberId = 0;
let nudgeApplicantId = 0;
let pillarId = 0;

async function ensureFixtures(): Promise<void> {
  // Idempotent: re-ensure after any CASCADE truncation by other suites.
  const { rows: userRows } = await pool.query<{ id: number; email: string }>(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name, is_platform_admin)
     VALUES ($1,$2,'App Admin','true'),($3,$4,'Prof Applicant','false'),($5,$6,'Invited Member','false'),($7,$8,'Nudge Applicant','false')
     ON CONFLICT (clerk_user_id) DO UPDATE SET email = EXCLUDED.email
     RETURNING id, email`,
    [
      `fap-admin-${stamp}`,
      `fap-admin-${stamp}@test.local`,
      `fap-applicant-${stamp}`,
      `fap-applicant-${stamp}@test.local`,
      `fap-member-${stamp}`,
      `fap-member-${stamp}@test.local`,
      `fap-nudge-${stamp}`,
      `fap-nudge-${stamp}@test.local`,
    ],
  );
  adminId = userRows[0].id;
  applicantId = userRows[1].id;
  invitedMemberId = userRows[2].id;
  nudgeApplicantId = userRows[3].id;

  const { rows: pillarRows } = await pool.query<{ id: number }>(
    `INSERT INTO pillars (slug, name, description)
     VALUES ($1, 'App Test Pillar', 'test')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [`fap-pillar-${stamp}`],
  );
  pillarId = pillarRows[0].id;

  // The invited/pre-seeded member already holds a membership (fast track).
  await pool.query(
    `INSERT INTO faculty_memberships (user_id, pillar_id, role)
     SELECT $1, $2, 'steward'
     WHERE NOT EXISTS (
       SELECT 1 FROM faculty_memberships WHERE user_id = $1 AND pillar_id = $2
     )`,
    [invitedMemberId, pillarId],
  );
}

beforeAll(async () => {
  await ensureCaptureLoopSchema();
  // syncSchemaAdditive may not add unique indexes on pre-existing tables;
  // provision them explicitly so the suite matches boot DDL.
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS faculty_applications_user_unique ON faculty_applications (user_id)`,
  );
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS institution_agreements_institution_unique ON institution_agreements (institution)`,
  );
  app = (await import("../app.js")).default;
  await ensureFixtures();
});

afterAll(async () => {
  await pool.query(
    `DELETE FROM faculty_users WHERE clerk_user_id IN ($1,$2,$3,$4)`,
    [`fap-admin-${stamp}`, `fap-applicant-${stamp}`, `fap-member-${stamp}`, `fap-nudge-${stamp}`],
  );
  await pool.query(`DELETE FROM pillars WHERE slug = $1`, [
    `fap-pillar-${stamp}`,
  ]);
  await pool.query(`DELETE FROM institution_agreements WHERE institution LIKE $1`, [
    `Fap University ${stamp}%`,
  ]);
});

beforeEach(async () => {
  emailMocks.verification.mockClear();
  emailMocks.admitted.mockClear();
  emailMocks.declined.mockClear();
  emailMocks.adminNudge.mockClear();
  await ensureFixtures();
});

const goodApplication = {
  institution: "Fap University",
  field: "Sleep science",
  workUrl: "https://example.edu/prof",
  institutionalEmail: `prof-${stamp}@fap-university.edu`,
};

describe("faculty application funnel", () => {
  test("member with a membership is fast-tracked: application refused", async () => {
    stubFacultyUserId = invitedMemberId;
    const res = await request(app)
      .post("/api/faculty/application")
      .send(goodApplication);
    expect(res.status).toBe(409);
  });

  test("platform admin never needs an application", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app)
      .post("/api/faculty/application")
      .send(goodApplication);
    expect(res.status).toBe(409);
  });

  test("applicant can submit; verification email goes to the institutional address", async () => {
    stubFacultyUserId = applicantId;
    const res = await request(app)
      .post("/api/faculty/application")
      .send(goodApplication);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("applied");
    expect(res.body.institutionalEmailVerified).toBe(false);
    // Fire-and-forget send: allow the microtask to run.
    await new Promise((r) => setTimeout(r, 20));
    expect(emailMocks.verification).toHaveBeenCalledTimes(1);
    const args = emailMocks.verification.mock.calls[0][0] as {
      to: string;
      verifyUrl: string;
    };
    expect(args.to).toBe(goodApplication.institutionalEmail);
    expect(args.verifyUrl).toContain("/api/faculty/applications/verify/");

    // /faculty/me surfaces the honest status.
    const me = await request(app).get("/api/faculty/me");
    expect(me.status).toBe(200);
    expect(me.body.awaitingInvitation).toBe(true);
    expect(me.body.application.status).toBe("applied");
    expect(me.body.application.institutionalEmailVerified).toBe(false);
  });

  test("public verify link marks the institutional email verified", async () => {
    const { rows } = await pool.query<{ verification_token: string }>(
      `SELECT verification_token FROM faculty_applications WHERE user_id = $1`,
      [applicantId],
    );
    const token = rows[0].verification_token;
    const res = await request(app).get(
      `/api/faculty/applications/verify/${token}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("verified=1");
    const { rows: after } = await pool.query(
      `SELECT institutional_email_verified_at FROM faculty_applications WHERE user_id = $1`,
      [applicantId],
    );
    expect(after[0].institutional_email_verified_at).not.toBeNull();
  });

  test("malformed or unknown verify token redirects as invalid, never 500s", async () => {
    const bad = await request(app).get(
      "/api/faculty/applications/verify/not-a-uuid",
    );
    expect(bad.status).toBe(302);
    expect(bad.headers.location).toContain("verified=invalid");
    const unknown = await request(app).get(
      "/api/faculty/applications/verify/00000000-0000-4000-8000-000000000000",
    );
    expect(unknown.headers.location).toContain("verified=invalid");
  });

  test("non-admin cannot see the review queue", async () => {
    stubFacultyUserId = applicantId;
    const res = await request(app).get("/api/faculty/admin/applications");
    expect(res.status).toBe(403);
  });

  test("admin queue lists the application with verification state", async () => {
    stubFacultyUserId = adminId;
    const res = await request(app).get("/api/faculty/admin/applications");
    expect(res.status).toBe(200);
    const mine = res.body.applications.find(
      (a: { userId: number }) => a.userId === applicantId,
    );
    expect(mine).toBeTruthy();
    expect(mine.status).toBe("applied");
    expect(mine.institutionalEmailVerified).toBe(true);
    expect(mine.applicantEmail).toContain("fap-applicant");
  });

  test("admin can mark under review; applicant sees it honestly", async () => {
    stubFacultyUserId = adminId;
    const { rows } = await pool.query<{ id: number }>(
      `SELECT id FROM faculty_applications WHERE user_id = $1`,
      [applicantId],
    );
    const res = await request(app).post(
      `/api/faculty/admin/applications/${rows[0].id}/review`,
    );
    expect(res.status).toBe(200);
    stubFacultyUserId = applicantId;
    const me = await request(app).get("/api/faculty/me");
    expect(me.body.application.status).toBe("under_review");
  });

  test("decline records the note and emails the applicant; re-apply resets", async () => {
    stubFacultyUserId = adminId;
    const { rows } = await pool.query<{ id: number }>(
      `SELECT id FROM faculty_applications WHERE user_id = $1`,
      [applicantId],
    );
    const res = await request(app)
      .post(`/api/faculty/admin/applications/${rows[0].id}/decline`)
      .send({ note: "Please add a publications link." });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(emailMocks.declined).toHaveBeenCalledTimes(1);

    stubFacultyUserId = applicantId;
    const me = await request(app).get("/api/faculty/me");
    expect(me.body.application.status).toBe("declined");
    expect(me.body.application.declineNote).toBe(
      "Please add a publications link.",
    );

    // Re-apply resets to applied without changing the verified email state.
    const reapply = await request(app)
      .post("/api/faculty/application")
      .send(goodApplication);
    expect(reapply.status).toBe(200);
    expect(reapply.body.status).toBe("applied");
    expect(reapply.body.institutionalEmailVerified).toBe(true);
    expect(emailMocks.verification).not.toHaveBeenCalled();
  });

  test("admit creates the membership like invite acceptance and emails warmly", async () => {
    stubFacultyUserId = adminId;
    const { rows } = await pool.query<{ id: number }>(
      `SELECT id FROM faculty_applications WHERE user_id = $1`,
      [applicantId],
    );
    const res = await request(app)
      .post(`/api/faculty/admin/applications/${rows[0].id}/admit`)
      .send({ pillarId, role: "contributor" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("admitted");

    const { rows: memberships } = await pool.query(
      `SELECT role FROM faculty_memberships WHERE user_id = $1 AND pillar_id = $2`,
      [applicantId, pillarId],
    );
    expect(memberships).toHaveLength(1);
    expect(memberships[0].role).toBe("contributor");

    // Institution seeded only-if-unset, mirroring invitation acceptance.
    const { rows: users } = await pool.query(
      `SELECT institution FROM faculty_users WHERE id = $1`,
      [applicantId],
    );
    expect(users[0].institution).toBe("Fap University");

    await new Promise((r) => setTimeout(r, 20));
    expect(emailMocks.admitted).toHaveBeenCalledTimes(1);

    // The admitted member now passes the fast-track gate everywhere.
    stubFacultyUserId = applicantId;
    const me = await request(app).get("/api/faculty/me");
    expect(me.body.awaitingInvitation).toBe(false);
    expect(me.body.application.status).toBe("admitted");
    const again = await request(app)
      .post("/api/faculty/application")
      .send(goodApplication);
    expect(again.status).toBe(409);

    // Second admit refuses.
    stubFacultyUserId = adminId;
    const twice = await request(app)
      .post(`/api/faculty/admin/applications/${rows[0].id}/admit`)
      .send({ pillarId, role: "steward" });
    expect(twice.status).toBe(409);
  });

  test("impact endpoint reports question volume and gaps for the pillar", async () => {
    await pool.query(
      `INSERT INTO agent_queries (session_id, question, pillar_ids, was_uncovered, created_at)
       VALUES ('fap-imp-1', 'How much deep sleep do I need?', ARRAY[$1]::int[], TRUE, NOW()),
              ('fap-imp-2', 'Is melatonin safe nightly?', ARRAY[$1]::int[], FALSE, NOW())`,
      [pillarId],
    );
    stubFacultyUserId = applicantId;
    const res = await request(app).get(
      `/api/faculty/pillars/fap-pillar-${stamp}/impact`,
    );
    expect(res.status).toBe(200);
    expect(res.body.totalQuestions).toBeGreaterThanOrEqual(2);
    expect(res.body.uncoveredQuestions).toBeGreaterThanOrEqual(1);
    expect(
      res.body.exampleGaps.some(
        (g: { question: string }) =>
          g.question === "How much deep sleep do I need?",
      ),
    ).toBe(true);
  });

  test("new application triggers admin nudge with active admin emails", async () => {
    // Use the dedicated nudge applicant (never admitted, always starts clean).
    await pool.query(
      `DELETE FROM faculty_applications WHERE user_id = $1`,
      [nudgeApplicantId],
    );
    stubFacultyUserId = nudgeApplicantId;
    const res = await request(app)
      .post("/api/faculty/application")
      .send(goodApplication);
    expect(res.status).toBe(201);
    // Fire-and-forget: allow the microtask queue to drain.
    await new Promise((r) => setTimeout(r, 50));
    expect(emailMocks.adminNudge).toHaveBeenCalledTimes(1);
    const nudgeArgs = emailMocks.adminNudge.mock.calls[0][0] as {
      adminEmails: string[];
      applicantEmail: string;
      institution: string;
      field: string;
    };
    // The active admin's email must be in the recipient list.
    expect(nudgeArgs.adminEmails).toContain(`fap-admin-${stamp}@test.local`);
    expect(nudgeArgs.institution).toBe(goodApplication.institution);
    expect(nudgeArgs.field).toBe(goodApplication.field);
  });

  test("editing an existing application does not re-trigger the admin nudge", async () => {
    // Start clean for the nudge applicant.
    await pool.query(
      `DELETE FROM faculty_applications WHERE user_id = $1`,
      [nudgeApplicantId],
    );
    stubFacultyUserId = nudgeApplicantId;
    // First submission creates the row.
    const first = await request(app)
      .post("/api/faculty/application")
      .send(goodApplication);
    expect(first.status).toBe(201);
    await new Promise((r) => setTimeout(r, 50));
    emailMocks.adminNudge.mockClear();

    // Edit: same user submits again (updates the existing row).
    const edit = await request(app)
      .post("/api/faculty/application")
      .send({ ...goodApplication, field: "Chronobiology" });
    expect(edit.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(emailMocks.adminNudge).not.toHaveBeenCalled();
  });

  test("deactivated admin is excluded from nudge recipients", async () => {
    await pool.query(
      `DELETE FROM faculty_applications WHERE user_id = $1`,
      [nudgeApplicantId],
    );
    // Deactivate the admin mid-test to verify the filter.
    await pool.query(
      `UPDATE faculty_users SET deactivated_at = NOW() WHERE id = $1`,
      [adminId],
    );
    try {
      stubFacultyUserId = nudgeApplicantId;
      const res = await request(app)
        .post("/api/faculty/application")
        .send(goodApplication);
      expect(res.status).toBe(201);
      await new Promise((r) => setTimeout(r, 50));
      expect(emailMocks.adminNudge).toHaveBeenCalledTimes(1);
      const { adminEmails } = emailMocks.adminNudge.mock.calls[0][0] as {
        adminEmails: string[];
      };
      expect(adminEmails).not.toContain(`fap-admin-${stamp}@test.local`);
    } finally {
      // Restore the admin so other tests are unaffected.
      await pool.query(
        `UPDATE faculty_users SET deactivated_at = NULL WHERE id = $1`,
        [adminId],
      );
    }
  });

  test("institution agreements: admin upsert + list, non-admin forbidden", async () => {
    stubFacultyUserId = applicantId;
    const forbidden = await request(app).get(
      "/api/faculty/admin/institution-agreements",
    );
    expect(forbidden.status).toBe(403);

    stubFacultyUserId = adminId;
    const name = `Fap University ${stamp}`;
    const create = await request(app)
      .put("/api/faculty/admin/institution-agreements")
      .send({ institution: name, agreementActive: true, note: "Signed 2026" });
    expect(create.status).toBe(200);
    expect(create.body.agreement.agreementActive).toBe(true);

    const update = await request(app)
      .put("/api/faculty/admin/institution-agreements")
      .send({ institution: name, agreementActive: false });
    expect(update.status).toBe(200);
    expect(update.body.agreement.agreementActive).toBe(false);

    const list = await request(app).get(
      "/api/faculty/admin/institution-agreements",
    );
    const row = list.body.agreements.find(
      (a: { institution: string }) => a.institution === name,
    );
    expect(row).toBeTruthy();
    expect(row.agreementActive).toBe(false);
  });
});
