import { Router, type IRouter } from "express";
import { randomUUID } from "crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  pillarsTable,
  facultyUsersTable,
  facultyMembershipsTable,
  facultyApplicationsTable,
  institutionAgreementsTable,
} from "@workspace/db";
import {
  requireFacultyAuth,
  requirePillarRole,
  type FacultyRequest,
} from "../middlewares/facultyAuth.js";
import {
  sendApplicationVerificationEmail,
  sendApplicationAdmittedEmail,
  sendApplicationDeclinedEmail,
  sendNewApplicationAdminEmail,
} from "../lib/facultyApplicationEmail.js";
import pool from "../lib/db.js";

const router: IRouter = Router();

// Institutional-email link validity. Human review is the real gate; this only
// proves the applicant can read mail at the address they claim.
const VERIFICATION_TTL_DAYS = 7;

function baseUrl(): string {
  return (
    process.env.PUBLIC_APP_URL ??
    (process.env.REPLIT_DOMAINS?.split(",")[0]
      ? `https://${process.env.REPLIT_DOMAINS.split(",")[0]}`
      : "http://localhost")
  );
}

const applySchema = z.object({
  institution: z.string().trim().min(2).max(200),
  field: z.string().trim().min(2).max(200),
  workUrl: z
    .string()
    .trim()
    .url()
    .max(500)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  institutionalEmail: z.string().trim().toLowerCase().email().max(320),
});

/**
 * POST /api/faculty/application — submit (or update) the signed-in user's
 * application. Fast track guarantee: anyone who already holds a membership
 * (invited, boot-seeded, or admin pre-seeded) or is a platform admin never
 * needs an application, so this endpoint refuses for them.
 */
router.post(
  "/faculty/application",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    if (ctx.memberships.length > 0 || ctx.user.isPlatformAdmin === "true") {
      res.status(409).json({
        error: "You are already a member. No application is needed.",
      });
      return;
    }
    const parsed = applySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { institution, field, workUrl, institutionalEmail } = parsed.data;

    const [existing] = await db
      .select()
      .from(facultyApplicationsTable)
      .where(eq(facultyApplicationsTable.userId, ctx.user.id));

    if (existing && existing.status === "admitted") {
      res.status(409).json({ error: "Your application was already admitted." });
      return;
    }

    const expiresAt = new Date(
      Date.now() + VERIFICATION_TTL_DAYS * 24 * 60 * 60 * 1000,
    );
    // Keep an already-proven address proven; changing it requires re-proving.
    const emailChanged =
      !existing || existing.institutionalEmail !== institutionalEmail;
    const token = randomUUID();

    let application;
    if (!existing) {
      [application] = await db
        .insert(facultyApplicationsTable)
        .values({
          userId: ctx.user.id,
          institution,
          field,
          workUrl: workUrl ?? null,
          institutionalEmail,
          verificationToken: token,
          verificationExpiresAt: expiresAt,
        })
        .returning();
    } else {
      // Re-apply after a decline resets to "applied"; edits while applied or
      // under review keep the review status but refresh the details.
      [application] = await db
        .update(facultyApplicationsTable)
        .set({
          institution,
          field,
          workUrl: workUrl ?? null,
          institutionalEmail,
          ...(emailChanged
            ? {
                institutionalEmailVerifiedAt: null,
                verificationToken: token,
                verificationExpiresAt: expiresAt,
              }
            : {}),
          ...(existing.status === "declined"
            ? { status: "applied" as const, declineNote: null, decidedAt: null }
            : {}),
        })
        .where(eq(facultyApplicationsTable.id, existing.id))
        .returning();
    }

    if (emailChanged && application) {
      const verifyUrl = `${baseUrl()}/api/faculty/applications/verify/${application.verificationToken}`;
      // Fire-and-forget: the application stands even if email delivery fails;
      // the applicant can resend from their status view.
      void sendApplicationVerificationEmail({
        to: institutionalEmail,
        applicantName: ctx.user.fullName,
        verifyUrl,
      }).catch((err) =>
        req.log.error({ err }, "Failed to send application verification"),
      );
    }

    // Nudge admins once for brand-new applications only (not edits).
    if (!existing && application) {
      void (async () => {
        try {
          const adminRows = await db
            .select({ email: facultyUsersTable.email })
            .from(facultyUsersTable)
            .where(
              and(
                eq(facultyUsersTable.isPlatformAdmin, "true"),
                isNull(facultyUsersTable.deactivatedAt),
              ),
            );
          const adminEmails = adminRows
            .map((r) => r.email)
            .filter((e): e is string => !!e);
          await sendNewApplicationAdminEmail({
            adminEmails,
            applicantName: ctx.user.fullName,
            applicantEmail: ctx.user.email ?? institutionalEmail,
            institution,
            field,
            reviewUrl: `${baseUrl()}/admin/admissions`,
          });
        } catch (err) {
          req.log.error({ err }, "Failed to send admin application nudge");
        }
      })();
    }

    res.status(existing ? 200 : 201).json({
      status: application?.status,
      institutionalEmailVerified:
        application?.institutionalEmailVerifiedAt != null,
    });
  },
);

/**
 * POST /api/faculty/application/resend-verification — re-send (regenerating an
 * expired token) the institutional-email confirmation link.
 */
router.post(
  "/faculty/application/resend-verification",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    const [application] = await db
      .select()
      .from(facultyApplicationsTable)
      .where(eq(facultyApplicationsTable.userId, ctx.user.id));
    if (!application) {
      res.status(404).json({ error: "No application found" });
      return;
    }
    if (application.institutionalEmailVerifiedAt) {
      res.status(409).json({ error: "This email is already confirmed." });
      return;
    }
    let token = application.verificationToken;
    if (application.verificationExpiresAt.getTime() < Date.now()) {
      token = randomUUID();
      await db
        .update(facultyApplicationsTable)
        .set({
          verificationToken: token,
          verificationExpiresAt: new Date(
            Date.now() + VERIFICATION_TTL_DAYS * 24 * 60 * 60 * 1000,
          ),
        })
        .where(eq(facultyApplicationsTable.id, application.id));
    }
    await sendApplicationVerificationEmail({
      to: application.institutionalEmail,
      applicantName: ctx.user.fullName,
      verifyUrl: `${baseUrl()}/api/faculty/applications/verify/${token}`,
    });
    res.json({ ok: true });
  },
);

/**
 * GET /api/faculty/applications/verify/:token — PUBLIC. Clicked from the
 * institutional inbox (possibly a different browser with no Clerk session),
 * so the token itself is the proof. Marks the address verified and bounces
 * to the faculty portal.
 */
router.get(
  "/faculty/applications/verify/:token",
  async (req, res): Promise<void> => {
    const raw = Array.isArray(req.params.token)
      ? req.params.token[0]
      : req.params.token;
    const portal = `${baseUrl()}/faculty/`;
    // Guard the UUID cast: a malformed token must 404, not 500.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw ?? "")) {
      res.redirect(`${portal}?verified=invalid`);
      return;
    }
    const [application] = await db
      .select()
      .from(facultyApplicationsTable)
      .where(eq(facultyApplicationsTable.verificationToken, raw));
    if (!application) {
      res.redirect(`${portal}?verified=invalid`);
      return;
    }
    if (application.verificationExpiresAt.getTime() < Date.now()) {
      res.redirect(`${portal}?verified=expired`);
      return;
    }
    if (!application.institutionalEmailVerifiedAt) {
      await db
        .update(facultyApplicationsTable)
        .set({ institutionalEmailVerifiedAt: new Date() })
        .where(eq(facultyApplicationsTable.id, application.id));
    }
    res.redirect(`${portal}?verified=1`);
  },
);

// ---------- Admin review queue ----------

function requireAdmin(req: FacultyRequest, res: {
  status: (n: number) => { json: (b: unknown) => void };
}): boolean {
  if (req.faculty!.user.isPlatformAdmin !== "true") {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  return true;
}

/**
 * GET /api/faculty/admin/applications — platform-admin-only review queue.
 */
router.get(
  "/faculty/admin/applications",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!requireAdmin(req, res)) return;
    const rows = await db
      .select({
        id: facultyApplicationsTable.id,
        status: facultyApplicationsTable.status,
        institution: facultyApplicationsTable.institution,
        field: facultyApplicationsTable.field,
        workUrl: facultyApplicationsTable.workUrl,
        institutionalEmail: facultyApplicationsTable.institutionalEmail,
        institutionalEmailVerifiedAt:
          facultyApplicationsTable.institutionalEmailVerifiedAt,
        declineNote: facultyApplicationsTable.declineNote,
        createdAt: facultyApplicationsTable.createdAt,
        decidedAt: facultyApplicationsTable.decidedAt,
        applicantName: facultyUsersTable.fullName,
        applicantEmail: facultyUsersTable.email,
        userId: facultyUsersTable.id,
      })
      .from(facultyApplicationsTable)
      .innerJoin(
        facultyUsersTable,
        eq(facultyUsersTable.id, facultyApplicationsTable.userId),
      )
      .orderBy(desc(facultyApplicationsTable.createdAt));
    res.json({
      applications: rows.map((r) => ({
        ...r,
        institutionalEmailVerified: r.institutionalEmailVerifiedAt != null,
        createdAt: r.createdAt.toISOString(),
        decidedAt: r.decidedAt?.toISOString() ?? null,
      })),
    });
  },
);

/**
 * POST /api/faculty/admin/applications/:id/review — mark as under review so
 * the applicant honestly sees a human has picked it up.
 */
router.post(
  "/faculty/admin/applications/:id/review",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!requireAdmin(req, res)) return;
    const id = Number(req.params.id);
    const [updated] = await db
      .update(facultyApplicationsTable)
      .set({ status: "under_review" })
      .where(
        and(
          eq(facultyApplicationsTable.id, id),
          eq(facultyApplicationsTable.status, "applied"),
        ),
      )
      .returning();
    if (!updated) {
      res.status(409).json({ error: "Application is not awaiting review" });
      return;
    }
    res.json({ status: updated.status });
  },
);

const admitSchema = z.object({
  pillarId: z.number().int().positive(),
  role: z.enum(["steward", "contributor", "advisor", "viewer"]),
});

/**
 * POST /api/faculty/admin/applications/:id/admit — admit into a pillar with a
 * role. Creates the membership exactly like invitation acceptance does
 * (insert-or-update-role, seed institution only if unset) and sends a warm
 * admission email.
 */
router.post(
  "/faculty/admin/applications/:id/admit",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!requireAdmin(req, res)) return;
    const parsed = admitSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const id = Number(req.params.id);
    const [application] = await db
      .select()
      .from(facultyApplicationsTable)
      .where(eq(facultyApplicationsTable.id, id));
    if (!application) {
      res.status(404).json({ error: "Application not found" });
      return;
    }
    if (application.status === "admitted") {
      res.status(409).json({ error: "Already admitted" });
      return;
    }
    const [pillar] = await db
      .select()
      .from(pillarsTable)
      .where(eq(pillarsTable.id, parsed.data.pillarId));
    if (!pillar || pillar.retiredAt) {
      res.status(400).json({ error: "Pillar not found or retired" });
      return;
    }
    const [applicant] = await db
      .select()
      .from(facultyUsersTable)
      .where(eq(facultyUsersTable.id, application.userId));
    if (!applicant) {
      res.status(404).json({ error: "Applicant no longer exists" });
      return;
    }

    // Same membership path as invitation acceptance: create the membership,
    // or align the role if one somehow exists already.
    const [existingMembership] = await db
      .select()
      .from(facultyMembershipsTable)
      .where(
        and(
          eq(facultyMembershipsTable.userId, applicant.id),
          eq(facultyMembershipsTable.pillarId, pillar.id),
        ),
      );
    if (!existingMembership) {
      await db.insert(facultyMembershipsTable).values({
        userId: applicant.id,
        pillarId: pillar.id,
        role: parsed.data.role,
      });
    } else if (existingMembership.role !== parsed.data.role) {
      await db
        .update(facultyMembershipsTable)
        .set({ role: parsed.data.role })
        .where(eq(facultyMembershipsTable.id, existingMembership.id));
    }
    // Seed the affiliation from the application only if the member hasn't set
    // their own institution yet, mirroring invitation acceptance.
    if (application.institution && !applicant.institution) {
      await db
        .update(facultyUsersTable)
        .set({ institution: application.institution })
        .where(eq(facultyUsersTable.id, applicant.id));
    }

    await db
      .update(facultyApplicationsTable)
      .set({
        status: "admitted",
        admittedPillarId: pillar.id,
        decidedByUserId: req.faculty!.user.id,
        decidedAt: new Date(),
        declineNote: null,
      })
      .where(eq(facultyApplicationsTable.id, application.id));

    void sendApplicationAdmittedEmail({
      to: applicant.email,
      applicantName: applicant.fullName,
      pillarName: pillar.name,
      role: parsed.data.role,
      portalUrl: `${baseUrl()}/faculty/`,
    }).catch((err) =>
      req.log.error({ err }, "Failed to send admission email"),
    );

    res.json({ status: "admitted", pillarId: pillar.id, role: parsed.data.role });
  },
);

const declineSchema = z.object({
  note: z.string().trim().max(2000).optional(),
});

/**
 * POST /api/faculty/admin/applications/:id/decline — decline with an optional
 * warm note. The applicant keeps an honest status view (never a dead end) and
 * may re-apply, which resets the record to "applied".
 */
router.post(
  "/faculty/admin/applications/:id/decline",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!requireAdmin(req, res)) return;
    const parsed = declineSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const id = Number(req.params.id);
    const [application] = await db
      .select()
      .from(facultyApplicationsTable)
      .where(eq(facultyApplicationsTable.id, id));
    if (!application) {
      res.status(404).json({ error: "Application not found" });
      return;
    }
    if (application.status === "admitted") {
      res.status(409).json({ error: "Already admitted" });
      return;
    }
    const note = parsed.data.note?.trim() || null;
    await db
      .update(facultyApplicationsTable)
      .set({
        status: "declined",
        declineNote: note,
        decidedByUserId: req.faculty!.user.id,
        decidedAt: new Date(),
      })
      .where(eq(facultyApplicationsTable.id, application.id));

    const [applicant] = await db
      .select()
      .from(facultyUsersTable)
      .where(eq(facultyUsersTable.id, application.userId));
    if (applicant) {
      void sendApplicationDeclinedEmail({
        to: applicant.email,
        applicantName: applicant.fullName,
        note,
      }).catch((err) =>
        req.log.error({ err }, "Failed to send decline email"),
      );
    }
    res.json({ status: "declined" });
  },
);

// ---------- Institution agreements (admin-only, business-level) ----------

/** GET /api/faculty/admin/institution-agreements */
router.get(
  "/faculty/admin/institution-agreements",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!requireAdmin(req, res)) return;
    const rows = await db
      .select()
      .from(institutionAgreementsTable)
      .orderBy(institutionAgreementsTable.institution);
    res.json({
      agreements: rows.map((r) => ({
        id: r.id,
        institution: r.institution,
        agreementActive: r.agreementActive === "true",
        note: r.note,
        updatedAt: r.updatedAt.toISOString(),
      })),
    });
  },
);

const agreementSchema = z.object({
  institution: z.string().trim().min(2).max(200),
  agreementActive: z.boolean(),
  note: z.string().trim().max(2000).optional(),
});

/**
 * PUT /api/faculty/admin/institution-agreements — upsert by institution name.
 * Select-then-write on purpose: the unique index may be provisioned after the
 * table on older DBs, so ON CONFLICT is avoided (42P10 risk).
 */
router.put(
  "/faculty/admin/institution-agreements",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!requireAdmin(req, res)) return;
    const parsed = agreementSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { institution, agreementActive, note } = parsed.data;
    const [existing] = await db
      .select()
      .from(institutionAgreementsTable)
      .where(eq(institutionAgreementsTable.institution, institution));
    const values = {
      agreementActive: agreementActive ? "true" : "false",
      note: note?.trim() || null,
    };
    const [row] = existing
      ? await db
          .update(institutionAgreementsTable)
          .set(values)
          .where(eq(institutionAgreementsTable.id, existing.id))
          .returning()
      : await db
          .insert(institutionAgreementsTable)
          .values({ institution, ...values })
          .returning();
    res.json({
      agreement: {
        id: row.id,
        institution: row.institution,
        agreementActive: row.agreementActive === "true",
        note: row.note,
      },
    });
  },
);

// ---------- Impact-first welcome data ----------

/**
 * GET /api/faculty/pillars/:slug/impact — the newly admitted member's first
 * "why this matters" view: how many questions readers asked in this pillar
 * (30 days) and how many the governed corpus could not answer, plus a few
 * example gaps. Requires any membership on the pillar.
 */
router.get(
  "/faculty/pillars/:slug/impact",
  requireFacultyAuth,
  requirePillarRole({ slugParam: "slug" }, [
    "steward",
    "contributor",
    "advisor",
    "viewer",
  ]),
  async (req: FacultyRequest, res): Promise<void> => {
    const pillar = req.pillar!;
    const windowDays = 30;
    const [totals, examples] = await Promise.all([
      pool.query<{ total: number; uncovered: number }>(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE was_uncovered = TRUE)::int AS uncovered
           FROM agent_queries
          WHERE $1 = ANY(pillar_ids)
            AND created_at >= NOW() - make_interval(days => $2::int)`,
        [pillar.id, windowDays],
      ),
      pool.query<{ question: string; count: number }>(
        `SELECT question, COUNT(*)::int AS count
           FROM agent_queries
          WHERE $1 = ANY(pillar_ids)
            AND was_uncovered = TRUE
            AND created_at >= NOW() - make_interval(days => $2::int)
          GROUP BY question
          ORDER BY count DESC, MAX(created_at) DESC
          LIMIT 5`,
        [pillar.id, windowDays],
      ),
    ]);
    res.json({
      windowDays,
      totalQuestions: totals.rows[0]?.total ?? 0,
      uncoveredQuestions: totals.rows[0]?.uncovered ?? 0,
      exampleGaps: examples.rows,
    });
  },
);

export default router;
