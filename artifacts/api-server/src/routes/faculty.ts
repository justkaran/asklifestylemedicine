import { Router, type IRouter } from "express";
import { randomBytes } from "crypto";
import { clerkClient } from "@clerk/express";
import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  pillarsTable,
  facultyUsersTable,
  facultyMembershipsTable,
  facultyInvitationsTable,
  facultyApplicationsTable,
  sourcesTable,
  sourceChunksTable,
  interpretationsTable,
  newsletterOffersTable,
  newsletterCreditsTable,
  communicationOffersTable,
  parentdataOffersTable,
  parentdataOfferMessagesTable,
  parentdataCallsTable,
  storyEditorSessionsTable,
  facultyChannelInterestTable,
  distributionChannelsTable,
  type FacultyMembership,
} from "@workspace/db";
import {
  requireFacultyAuth,
  requirePillarRole,
  requirePillarRoleFromBody,
  isHiddenFacultyEmail,
  isPillarDataAdmin,
  type FacultyRequest,
} from "../middlewares/facultyAuth.js";
import { sendFacultyInviteEmail } from "../lib/facultyInviteEmail.js";
import { sendCommunicationOfferNotice } from "../lib/communicationEmail.js";
import {
  sendParentDataOfferNotice,
  sendParentDataMessageNotice,
} from "../lib/parentdataEmail.js";
import {
  getFacultyRoster,
  getPillarOverview,
  getPublicPillars,
} from "../lib/facultyOverview.js";
import { SLM_PILLAR_SLUGS } from "./slm-agent.js";
import pool from "../lib/db.js";

const router: IRouter = Router();

const INVITE_TTL_DAYS = 14;

const createInviteSchema = z.object({
  email: z.string().email(),
  pillarId: z.number().int().positive(),
  role: z.enum(["steward", "contributor", "advisor", "viewer"]),
  // Optional affiliation for an outside contributor; copied onto their
  // faculty_users row when they accept (drives the "from [Institution]" byline).
  institution: z.string().trim().max(200).optional(),
  // Registration channel for the invitee. Omitted/undefined = standard
  // faculty flow; "aslm" = the invitee arrives via AskLifestyleMedicine and
  // will see the trimmed portal (Workspace + Pillar Settings only).
  channel: z.enum(["aslm"]).optional(),
});

/**
 * GET /api/faculty/public/pillars — ANONYMOUS, no auth. The live, active
 * (non-retired) pillars (slug, name, description only), used on the signed-out
 * faculty landing page. Deliberately steward-free: this surface names the
 * pillars but must never serialize steward identity (name, institution,
 * headshot) until that is an explicit product decision. Safe to expose
 * publicly.
 */
router.get(
  "/faculty/public/pillars",
  async (req, res): Promise<void> => {
    try {
      const pillars = await getPublicPillars();
      res.json({ pillars });
    } catch (err) {
      req.log.error({ err }, "Failed to load public pillars");
      res.status(500).json({ error: "Failed to load pillars" });
    }
  },
);

/**
 * Lifestyle Medicine "director" gate: platform admins plus a named email
 * allowlist (Michael Fredericson, Anne Friedlander, Amy Khokhar, Karan
 * Dehghani). Deliberately NOT derived from steward roles anymore — the ASLM
 * usage dashboard is for this specific director group, so being a steward of
 * an SLM pillar no longer grants it by itself.
 */
export const ASLM_DIRECTOR_EMAILS = new Set([
  "mfred2@stanford.edu", // Michael Fredericson
  "friedlan@stanford.edu", // Anne Friedlander
  "khokhar@stanford.edu", // Amy Khokhar
  "karan@palonur.com", // Karan Dehghani
  "kdegani@gmail.com", // Karan Dehghani (personal)
  "kdegani@stanford.edu", // Karan Dehghani (Stanford)
]);
function isAslmDirector(ctx: {
  user: { isPlatformAdmin: string; email: string | null };
}): boolean {
  if (ctx.user.isPlatformAdmin === "true") return true;
  const email = (ctx.user.email ?? "").trim().toLowerCase();
  return ASLM_DIRECTOR_EMAILS.has(email);
}

/**
 * GET /api/faculty/me — returns the signed-in faculty user, their memberships,
 * and the pillars those memberships reference.
 */
router.get(
  "/faculty/me",
  requireFacultyAuth,
  async (req: FacultyRequest, res, _next?): Promise<void> => {
    const ctx = req.faculty!;
    const pillars = await db.select().from(pillarsTable);
    const myPillars = pillars.filter((p) =>
      ctx.memberships.some((m: FacultyMembership) => m.pillarId === p.id),
    );

    // Each pillar the member can see carries its steward(s) — name + headshot —
    // so the dashboard "Your pillars" grid can show the face of who stewards
    // each domain. Lead steward (earliest membership) is listed first; the card
    // shows that face. Pillars with no steward simply get an empty array.
    const myPillarIds = myPillars.map((p) => p.id);
    const stewardRows = myPillarIds.length
      ? await db
          .select({
            pillarId: facultyMembershipsTable.pillarId,
            fullName: facultyUsersTable.fullName,
            photoUrl: facultyUsersTable.photoUrl,
            createdAt: facultyMembershipsTable.createdAt,
          })
          .from(facultyMembershipsTable)
          .innerJoin(
            facultyUsersTable,
            eq(facultyUsersTable.id, facultyMembershipsTable.userId),
          )
          .where(
            and(
              eq(facultyMembershipsTable.role, "steward"),
              inArray(facultyMembershipsTable.pillarId, myPillarIds),
            ),
          )
          // Deterministic order so the "lead" steward (earliest membership) is
          // always first, and ties break consistently across requests.
          .orderBy(
            asc(facultyMembershipsTable.createdAt),
            asc(facultyMembershipsTable.id),
          )
      : [];
    const stewardsByPillar = new Map<
      number,
      Array<{ name: string | null; photoUrl: string | null }>
    >();
    for (const r of stewardRows) {
      const list = stewardsByPillar.get(r.pillarId) ?? [];
      list.push({ name: r.fullName, photoUrl: r.photoUrl });
      stewardsByPillar.set(r.pillarId, list);
    }

    // Self-serve application funnel: surface the member's own application so
    // the portal can show an honest status instead of a dead end. Members who
    // arrived via invite/boot-seed/admin pre-seed simply have none (null) and
    // never see the funnel. Loaded for everyone because a freshly admitted
    // applicant (who now has a membership) still drives the impact-first
    // welcome from `application.status === "admitted"`.
    const [application] = await db
      .select()
      .from(facultyApplicationsTable)
      .where(eq(facultyApplicationsTable.userId, ctx.user.id));

    res.json({
      application: application
        ? {
            status: application.status,
            institution: application.institution,
            field: application.field,
            workUrl: application.workUrl,
            institutionalEmail: application.institutionalEmail,
            institutionalEmailVerified:
              application.institutionalEmailVerifiedAt != null,
            declineNote: application.declineNote,
            admittedPillarId: application.admittedPillarId,
          }
        : null,
      user: {
        id: ctx.user.id,
        email: ctx.user.email,
        fullName: ctx.user.fullName,
        institution: ctx.user.institution,
        photoUrl: ctx.user.photoUrl,
        achievements: Array.isArray(ctx.user.achievements)
          ? ctx.user.achievements
          : [],
        isPlatformAdmin: ctx.user.isPlatformAdmin === "true",
        pillarDataAdmin: isPillarDataAdmin(ctx.user),
        archivedAt: ctx.user.archivedAt?.toISOString() ?? null,
        // How this member registered: null = standard flow; "aslm" =
        // AskLifestyleMedicine (drives the trimmed portal view).
        registrationChannel: ctx.user.registrationChannel ?? null,
      },
      // Lifestyle Medicine "director" gate: platform admins plus the named
      // director allowlist may open the AskLifestyleMedicine usage dashboard.
      aslmDirector: isAslmDirector(ctx),
      memberships: ctx.memberships.map((m: FacultyMembership) => ({
        pillarId: m.pillarId,
        role: m.role,
      })),
      pillars: myPillars.map((p) => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        description: p.description,
        stewards: stewardsByPillar.get(p.id) ?? [],
      })),
      awaitingInvitation:
        ctx.memberships.length === 0 && ctx.user.isPlatformAdmin !== "true",
      onboarded: ctx.user.onboardedAt != null,
      archived: ctx.user.archivedAt != null,
    });
  },
);

const updateMyProfileSchema = z.object({
  // Display name shown in dashboard greetings and contribution bylines. The
  // app's display source of truth is faculty_users.fullName (preferred over
  // Clerk's firstName), so self-editing it here fixes the "friend" greeting for
  // accounts that never had a name. Trimmed; required when present (can't be
  // blanked to empty). Omitted → left unchanged.
  fullName: z.string().trim().min(1).max(120).optional(),
  // Empty string clears the institution; trimmed and capped. Optional so a
  // photo-only save doesn't have to resend the institution.
  institution: z.string().trim().max(200).optional(),
  // Object-storage path of an uploaded headshot ("/objects/..."); empty string
  // clears it. Omitted → left unchanged.
  photoUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === "" || v.startsWith("/objects/"), {
      message: "photoUrl must be an /objects/ path",
    })
    .optional(),
  // Ordered list of the member's remarkable achievements (awards, notable
  // findings, career highlights) shown on public surfaces behind their avatar.
  // Replaces the whole list when present (order matters); entries trimmed and
  // capped. An empty array clears the list. Omitted → left unchanged.
  achievements: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
});

/**
 * PATCH /api/faculty/me — the signed-in faculty member edits their own profile.
 * Covers the display name (greeting + byline), institution/affiliation, and
 * headshot. The name is stored on faculty_users (the app's display source of
 * truth), not pushed to Clerk, which keeps Clerk as the auth identity only.
 */
router.patch(
  "/faculty/me",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    const parsed = updateMyProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const setFields: {
      fullName?: string;
      institution?: string | null;
      photoUrl?: string | null;
      achievements?: string[];
    } = {};
    if (parsed.data.fullName !== undefined) {
      setFields.fullName = parsed.data.fullName;
    }
    if (parsed.data.institution !== undefined) {
      setFields.institution = parsed.data.institution || null;
    }
    if (parsed.data.photoUrl !== undefined) {
      setFields.photoUrl = parsed.data.photoUrl || null;
    }
    if (parsed.data.achievements !== undefined) {
      setFields.achievements = parsed.data.achievements;
    }
    if (Object.keys(setFields).length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }
    await db
      .update(facultyUsersTable)
      .set(setFields)
      .where(eq(facultyUsersTable.id, ctx.user.id));
    res.json({ id: ctx.user.id, ...setFields });
  },
);

const renameMyPillarSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

/**
 * PATCH /api/faculty/pillars/:id — a steward renames the DISPLAY NAME of a
 * pillar they steward (platform admins may rename any). Gated by
 * `requirePillarRole` so only a steward of that pillar (or an admin) may rename
 * it. The slug stays immutable — it appears in embed links and public routes —
 * so only `name` changes. The idempotent boot seed uses ON CONFLICT DO NOTHING,
 * so renaming an existing pillar is never reverted on the next deploy.
 */
router.patch(
  "/faculty/pillars/:id",
  requireFacultyAuth,
  requirePillarRole({ idParam: "id" }, ["steward"]),
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    const pillar = req.pillar!;
    const parsed = renameMyPillarSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const [updated] = await db
      .update(pillarsTable)
      .set({ name: parsed.data.name })
      .where(eq(pillarsTable.id, pillar.id))
      .returning({
        id: pillarsTable.id,
        slug: pillarsTable.slug,
        name: pillarsTable.name,
        description: pillarsTable.description,
      });
    req.log.info(
      { facultyUserId: ctx.user.id, pillarId: pillar.id },
      "Steward renamed pillar",
    );
    res.json({ pillar: updated });
  },
);

/**
 * GET /api/faculty/admin/members — platform-admin-only roster of every faculty
 * member (including admins and not-yet-onboarded invitees with zero
 * memberships), with their roles per pillar and onboarding status. Retired
 * demo/preview accounts in `HIDDEN_FACULTY_EMAILS` are excluded. Powers the
 * admin "Stewards" overview + the read-only dashboard-preview launcher.
 */
router.get(
  "/faculty/admin/members",
  requireFacultyAuth,
  async (req: FacultyRequest, res, _next?): Promise<void> => {
    const ctx = req.faculty!;
    if (ctx.user.isPlatformAdmin !== "true") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const members = await getFacultyRoster({ includeClerkStatus: true });
    res.json({ members });
  },
);

/**
 * GET /api/faculty/admin/pillars — platform-admin-only overview of EVERY pillar
 * in the system with its faculty count, independent of who has memberships.
 * Unlike the per-member roster (which is derived from memberships), this lists
 * pillars that have zero faculty assigned too, so an admin can see and plan
 * coverage for empty pillars. Faculty counts exclude retired demo/preview
 * accounts in `HIDDEN_FACULTY_EMAILS`, matching the roster. Gated identically to
 * `GET /api/faculty/admin/members` (platform-admin only).
 */
router.get(
  "/faculty/admin/pillars",
  requireFacultyAuth,
  async (req: FacultyRequest, res, _next?): Promise<void> => {
    const ctx = req.faculty!;
    if (ctx.user.isPlatformAdmin !== "true") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const pillars = await getPillarOverview();
    res.json({ pillars });
  },
);

/**
 * GET /api/faculty/admin/pillar-data — read-only inventory of the current
 * pillar → steward → source pipeline. Platform admins and the small named
 * Stanford IT-director allowlist may read it. This deliberately does not reuse
 * platform-admin promotion: access to this explanatory inventory grants no
 * mutation authority.
 *
 * Canary rows and source full text/abstracts are never serialized. Every real
 * steward is returned even when their pillar has no sources, while every pillar
 * is returned even when it has neither a steward nor a source.
 */
router.get(
  "/faculty/admin/pillar-data",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    if (!isPillarDataAdmin(ctx.user)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const [pillarRows, stewardRows, sourceRows, chunkRows] = await Promise.all([
      db
        .select({
          id: pillarsTable.id,
          slug: pillarsTable.slug,
          name: pillarsTable.name,
          description: pillarsTable.description,
          retiredAt: pillarsTable.retiredAt,
        })
        .from(pillarsTable)
        .orderBy(asc(pillarsTable.name)),
      db
        .select({
          id: facultyUsersTable.id,
          name: facultyUsersTable.fullName,
          email: facultyUsersTable.email,
          institution: facultyUsersTable.institution,
          photoUrl: facultyUsersTable.photoUrl,
          archivedAt: facultyUsersTable.archivedAt,
          deactivatedAt: facultyUsersTable.deactivatedAt,
          pillarId: pillarsTable.id,
          pillarSlug: pillarsTable.slug,
          pillarName: pillarsTable.name,
          role: facultyMembershipsTable.role,
        })
        .from(facultyMembershipsTable)
        .innerJoin(
          facultyUsersTable,
          eq(facultyUsersTable.id, facultyMembershipsTable.userId),
        )
        .innerJoin(
          pillarsTable,
          eq(pillarsTable.id, facultyMembershipsTable.pillarId),
        )
        .where(eq(facultyMembershipsTable.role, "steward"))
        .orderBy(asc(facultyUsersTable.fullName), asc(facultyUsersTable.email)),
      db
        .select({
          id: sourcesTable.id,
          pillarId: sourcesTable.pillarId,
          title: sourcesTable.title,
          kind: sourcesTable.kind,
          year: sourcesTable.year,
          journal: sourcesTable.journal,
          doi: sourcesTable.doi,
          sourceUrl: sourcesTable.sourceUrl,
          status: sourcesTable.status,
          retentionStatus: sourcesTable.retentionStatus,
          assessmentStatus: sourcesTable.assessmentStatus,
          uploadedById: facultyUsersTable.id,
          uploadedByName: facultyUsersTable.fullName,
          uploadedByEmail: facultyUsersTable.email,
          updatedAt: sourcesTable.updatedAt,
        })
        .from(sourcesTable)
        .leftJoin(
          facultyUsersTable,
          eq(facultyUsersTable.id, sourcesTable.uploadedByUserId),
        )
        .where(eq(sourcesTable.isCanary, false))
        .orderBy(asc(sourcesTable.pillarId), desc(sourcesTable.updatedAt)),
      db
        .select({
          sourceId: sourceChunksTable.sourceId,
          chunkCount: count(),
        })
        .from(sourceChunksTable)
        .groupBy(sourceChunksTable.sourceId),
    ]);

    const visibleStewardRows = stewardRows.filter(
      (row) =>
        row.deactivatedAt == null && !isHiddenFacultyEmail(row.email),
    );
    const stewardsById = new Map<
      number,
      {
        id: number;
        name: string | null;
        email: string;
        institution: string | null;
        photoUrl: string | null;
        archivedAt: string | null;
        pillars: Array<{
          id: number;
          slug: string;
          name: string;
          role: string;
        }>;
      }
    >();
    const stewardsByPillar = new Map<
      number,
      Array<{
        id: number;
        name: string | null;
        email: string;
        photoUrl: string | null;
        role: string;
      }>
    >();

    for (const row of visibleStewardRows) {
      const steward = stewardsById.get(row.id) ?? {
        id: row.id,
        name: row.name,
        email: row.email,
        institution: row.institution,
        photoUrl: row.photoUrl,
        archivedAt: row.archivedAt?.toISOString() ?? null,
        pillars: [],
      };
      steward.pillars.push({
        id: row.pillarId,
        slug: row.pillarSlug,
        name: row.pillarName,
        role: row.role,
      });
      stewardsById.set(row.id, steward);

      const pillarStewards = stewardsByPillar.get(row.pillarId) ?? [];
      pillarStewards.push({
        id: row.id,
        name: row.name,
        email: row.email,
        photoUrl: row.photoUrl,
        role: row.role,
      });
      stewardsByPillar.set(row.pillarId, pillarStewards);
    }

    const chunkCountBySource = new Map(
      chunkRows.map((row) => [row.sourceId, Number(row.chunkCount)]),
    );
    const sourcesByPillar = new Map<
      number,
      Array<{
        id: number;
        title: string;
        kind: "paper" | "slm_article" | "note" | "talk";
        year: number | null;
        journal: string | null;
        doi: string | null;
        sourceUrl: string | null;
        status: "draft" | "in_review" | "approved" | "archived";
        retentionStatus: string;
        assessmentStatus: "draft" | "approved" | null;
        chunkCount: number;
        uploadedBy: {
          id: number;
          name: string | null;
          email: string;
        } | null;
        updatedAt: string;
      }>
    >();

    for (const row of sourceRows) {
      const sources = sourcesByPillar.get(row.pillarId) ?? [];
      sources.push({
        id: row.id,
        title: row.title,
        kind: row.kind,
        year: row.year,
        journal: row.journal,
        doi: row.doi,
        sourceUrl: row.sourceUrl,
        status: row.status,
        retentionStatus: row.retentionStatus,
        assessmentStatus: row.assessmentStatus,
        chunkCount: chunkCountBySource.get(row.id) ?? 0,
        uploadedBy:
          row.uploadedById != null && row.uploadedByEmail != null
            ? {
                id: row.uploadedById,
                name: row.uploadedByName,
                email: row.uploadedByEmail,
              }
            : null,
        updatedAt: row.updatedAt.toISOString(),
      });
      sourcesByPillar.set(row.pillarId, sources);
    }

    const stewards = Array.from(stewardsById.values());
    const pillars = pillarRows.map((pillar) => ({
      ...pillar,
      retiredAt: pillar.retiredAt?.toISOString() ?? null,
      stewards: stewardsByPillar.get(pillar.id) ?? [],
      sources: sourcesByPillar.get(pillar.id) ?? [],
    }));
    const availableSourceCount = sourceRows.filter(
      (source) => source.status === "approved",
    ).length;

    res.json({
      generatedAt: new Date().toISOString(),
      totals: {
        pillarCount: pillars.length,
        stewardCount: stewards.length,
        sourceCount: sourceRows.length,
        availableSourceCount,
      },
      stewards,
      pillars,
    });
  },
);

const PILLAR_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const createPillarSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(
      PILLAR_SLUG_RE,
      "Slug must be lowercase letters, numbers, and single hyphens",
    ),
  description: z.string().trim().max(500).optional(),
});

const updatePillarSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
});

/**
 * POST /api/faculty/admin/pillars — platform-admin-only. Creates a new pillar
 * (coverage area) from the admin UI so the canonical set can evolve without an
 * engineer editing CANONICAL_PILLARS and redeploying. Slugs must be unique and
 * URL-safe (they appear in embed links and public routes).
 */
router.post(
  "/faculty/admin/pillars",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    if (ctx.user.isPlatformAdmin !== "true") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const parsed = createPillarSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { name, slug, description } = parsed.data;
    const [existing] = await db
      .select({ id: pillarsTable.id })
      .from(pillarsTable)
      .where(eq(pillarsTable.slug, slug))
      .limit(1);
    if (existing) {
      res.status(409).json({ error: `A pillar with slug "${slug}" already exists` });
      return;
    }
    const [created] = await db
      .insert(pillarsTable)
      .values({ name, slug, description: description ?? null })
      .returning({
        id: pillarsTable.id,
        slug: pillarsTable.slug,
        name: pillarsTable.name,
        description: pillarsTable.description,
      });
    req.log.info(
      { facultyUserId: ctx.user.id, pillarId: created.id, slug },
      "Platform admin created pillar",
    );
    res.status(201).json({ pillar: created });
  },
);

/**
 * PATCH /api/faculty/admin/pillars/:id — platform-admin-only. Renames a pillar
 * (display name + description). The slug is intentionally immutable to avoid
 * breaking existing embed links / public routes that reference it.
 */
router.patch(
  "/faculty/admin/pillars/:id",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    if (ctx.user.isPlatformAdmin !== "true") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid pillar id" });
      return;
    }
    const parsed = updatePillarSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { name, description } = parsed.data;
    const [updated] = await db
      .update(pillarsTable)
      .set({ name, description: description ?? null })
      .where(eq(pillarsTable.id, id))
      .returning({
        id: pillarsTable.id,
        slug: pillarsTable.slug,
        name: pillarsTable.name,
        description: pillarsTable.description,
      });
    if (!updated) {
      res.status(404).json({ error: "Pillar not found" });
      return;
    }
    req.log.info(
      { facultyUserId: ctx.user.id, pillarId: id },
      "Platform admin renamed pillar",
    );
    res.json({ pillar: updated });
  },
);

const retirePillarSchema = z.object({ retired: z.boolean() });

/**
 * POST /api/faculty/admin/pillars/:id/retire — platform-admin-only. Soft-hides
 * (or restores) a pillar by toggling `retired_at`. Retiring preserves all of
 * the pillar's content (sources, interpretations, memberships); it just takes
 * it out of rotation as an offered coverage area. This is the safe alternative
 * to deletion when a pillar is "no longer offered".
 */
router.post(
  "/faculty/admin/pillars/:id/retire",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    if (ctx.user.isPlatformAdmin !== "true") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid pillar id" });
      return;
    }
    const parsed = retirePillarSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const [updated] = await db
      .update(pillarsTable)
      .set({ retiredAt: parsed.data.retired ? new Date() : null })
      .where(eq(pillarsTable.id, id))
      .returning({
        id: pillarsTable.id,
        retiredAt: pillarsTable.retiredAt,
      });
    if (!updated) {
      res.status(404).json({ error: "Pillar not found" });
      return;
    }
    req.log.info(
      { facultyUserId: ctx.user.id, pillarId: id, retired: parsed.data.retired },
      "Platform admin toggled pillar retirement",
    );
    res.json({
      id: updated.id,
      retiredAt: updated.retiredAt ? updated.retiredAt.toISOString() : null,
    });
  },
);

/**
 * DELETE /api/faculty/admin/pillars/:id — platform-admin-only HARD delete.
 *
 * Guardrail: if the pillar still has faculty memberships, sources, or
 * interpretations, the delete is refused with 409 and a content summary unless
 * the caller explicitly confirms via `?force=true`. A forced delete cascades
 * (FK `onDelete: cascade`) and removes that dependent content — it is
 * destructive, which is why the confirmation is required. For taking a pillar
 * out of rotation without losing content, retire it instead.
 */
router.delete(
  "/faculty/admin/pillars/:id",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    if (ctx.user.isPlatformAdmin !== "true") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid pillar id" });
      return;
    }
    const [pillar] = await db
      .select({ id: pillarsTable.id })
      .from(pillarsTable)
      .where(eq(pillarsTable.id, id))
      .limit(1);
    if (!pillar) {
      res.status(404).json({ error: "Pillar not found" });
      return;
    }

    const force = req.query.force === "true";
    const [[fac], [src], [intr]] = await Promise.all([
      db
        .select({ c: count() })
        .from(facultyMembershipsTable)
        .where(eq(facultyMembershipsTable.pillarId, id)),
      db
        .select({ c: count() })
        .from(sourcesTable)
        // Canary registry rows are excluded from faculty stats.
        .where(and(eq(sourcesTable.pillarId, id), eq(sourcesTable.isCanary, false))),
      db
        .select({ c: count() })
        .from(interpretationsTable)
        .where(eq(interpretationsTable.pillarId, id)),
    ]);
    const facultyCount = fac?.c ?? 0;
    const sourceCount = src?.c ?? 0;
    const interpretationCount = intr?.c ?? 0;
    const hasContent =
      facultyCount > 0 || sourceCount > 0 || interpretationCount > 0;

    if (hasContent && !force) {
      res.status(409).json({
        error: "Pillar still has content",
        requiresConfirmation: true,
        facultyCount,
        sourceCount,
        interpretationCount,
      });
      return;
    }

    await db.delete(pillarsTable).where(eq(pillarsTable.id, id));
    req.log.warn(
      {
        facultyUserId: ctx.user.id,
        pillarId: id,
        force,
        facultyCount,
        sourceCount,
        interpretationCount,
      },
      "Platform admin deleted pillar",
    );
    res.json({ ok: true });
  },
);

const STORIES_COOKIE = "stories_session";

/**
 * POST /api/faculty/admin/newsletter-session — platform-admin-only auth bridge.
 *
 * Mints a short-lived Stories editor session for the verified platform admin's
 * own email and sets the signed `stories_session` cookie, so the existing
 * `requireEditorOrAdmin` guard on the newsletter/stories surfaces authorizes the
 * admin with no other changes. The grant is intentionally scoped to the editor
 * (newsletter/stories) surface only — it does NOT set the broader `palonur_admin`
 * cookie. Lets an admin open the embedded newsletter dashboard from the faculty
 * admin page without a second login at `/stories-login`.
 */
router.post(
  "/faculty/admin/newsletter-session",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    if (ctx.user.isPlatformAdmin !== "true") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const email = (ctx.user.email ?? "").trim().toLowerCase();
    if (!email) {
      res.status(400).json({ error: "Admin account has no email" });
      return;
    }
    const now = Date.now();
    const sessionToken = randomBytes(32).toString("hex");
    const sessionExpiresAt = new Date(now + 8 * 60 * 60 * 1000);
    // The Stories editor-session model keys on a unique `magic_token`; since this
    // session is minted directly (not via a magic link) we generate a throwaway,
    // already-consumed token to satisfy the schema.
    await db.insert(storyEditorSessionsTable).values({
      email,
      magicToken: randomBytes(24).toString("hex"),
      sessionToken,
      consumedAt: new Date(now),
      expiresAt: sessionExpiresAt,
      sessionExpiresAt,
    });
    res.cookie(STORIES_COOKIE, sessionToken, {
      signed: true,
      httpOnly: true,
      sameSite: "lax",
      maxAge: 8 * 60 * 60 * 1000,
    });
    req.log.info(
      { facultyUserId: ctx.user.id, email },
      "Minted newsletter editor session for platform admin",
    );
    res.json({ ok: true });
  },
);

const ADMIN_COOKIE = "palonur_admin";

/**
 * POST /api/faculty/admin/command-center-session — platform-admin-only auth
 * bridge for the Palonur command-center hub.
 *
 * Mints BOTH sessions a verified platform admin needs to reach every admin
 * surface without re-entering the shared admin password:
 *   - the broad `palonur_admin` cookie (powers the password-gated `/admin`
 *     pages, validated by `checkAdmin` in routes/admin.ts), and
 *   - a Stories editor session + `stories_session` cookie (powers
 *     `/newsletter-admin` and `/stories`, validated by `requireEditorOrAdmin`).
 *
 * Mirrors `/faculty/admin/newsletter-session`: the grant requires the verified
 * platform-admin Clerk identity, and the existing shared-password login for
 * other teammates is untouched.
 */
router.post(
  "/faculty/admin/command-center-session",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    if (ctx.user.isPlatformAdmin !== "true") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const email = (ctx.user.email ?? "").trim().toLowerCase();
    if (!email) {
      res.status(400).json({ error: "Admin account has no email" });
      return;
    }
    const now = Date.now();
    const eightHours = 8 * 60 * 60 * 1000;

    // Stories editor session (powers /newsletter-admin + /stories). Same
    // approach as /faculty/admin/newsletter-session: mint a directly-consumed
    // editor session row and set the signed cookie.
    const sessionToken = randomBytes(32).toString("hex");
    const sessionExpiresAt = new Date(now + eightHours);
    await db.insert(storyEditorSessionsTable).values({
      email,
      magicToken: randomBytes(24).toString("hex"),
      sessionToken,
      consumedAt: new Date(now),
      expiresAt: sessionExpiresAt,
      sessionExpiresAt,
    });
    res.cookie(STORIES_COOKIE, sessionToken, {
      signed: true,
      httpOnly: true,
      sameSite: "lax",
      maxAge: eightHours,
    });

    // Broad admin session (powers the password-gated /admin pages). Identical
    // cookie shape to the one set by the shared-password login in demo-auth.ts.
    res.cookie(ADMIN_COOKIE, "1", {
      signed: true,
      httpOnly: true,
      sameSite: "strict",
      maxAge: eightHours,
    });

    req.log.info(
      { facultyUserId: ctx.user.id, email },
      "Minted command-center sessions (admin + editor) for platform admin",
    );
    res.json({ ok: true });
  },
);

const updateMemberSchema = z.object({
  // Optional so a photo-only save doesn't require resending the name. When
  // present it's mirrored to Clerk; when omitted the name is left unchanged.
  fullName: z.string().trim().min(1).max(200).optional(),
  // Optional affiliation; empty string clears it. Omitted → left unchanged.
  institution: z.string().trim().max(200).optional(),
  // Optional headshot object path ("/objects/..."); empty string clears it.
  // Omitted → left unchanged.
  photoUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === "" || v.startsWith("/objects/"), {
      message: "photoUrl must be an /objects/ path",
    })
    .optional(),
});

const resetPasswordSchema = z.object({
  password: z.string().min(8).max(100),
});

/**
 * Extracts a human-readable message from a Clerk Backend API error so the
 * admin sees "Password has been found in an online data breach" instead of a
 * raw `[object Object]`.
 */
function clerkErrorMessage(err: unknown, fallback: string): string {
  const e = err as { errors?: Array<{ message?: string; longMessage?: string }> };
  const first = e?.errors?.[0];
  return first?.longMessage || first?.message || fallback;
}

/** Splits a full name into Clerk's first/last name fields (first token vs rest). */
function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  const firstName = parts.shift() ?? "";
  return { firstName, lastName: parts.join(" ") };
}

/**
 * PATCH /api/faculty/admin/members/:id — platform-admin-only edit of a faculty
 * member's profile. Currently updates the display name, mirrored to both the
 * local `faculty_users` row and the Clerk user (first/last name).
 */
router.patch(
  "/faculty/admin/members/:id",
  requireFacultyAuth,
  async (req: FacultyRequest, res, _next?): Promise<void> => {
    const ctx = req.faculty!;
    if (ctx.user.isPlatformAdmin !== "true") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid member id" });
      return;
    }
    const parsed = updateMemberSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const [target] = await db
      .select({
        id: facultyUsersTable.id,
        clerkUserId: facultyUsersTable.clerkUserId,
      })
      .from(facultyUsersTable)
      .where(eq(facultyUsersTable.id, id))
      .limit(1);
    if (!target) {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    const fullName = parsed.data.fullName;
    const setFields: {
      fullName?: string;
      institution?: string | null;
      photoUrl?: string | null;
    } = {};
    if (fullName !== undefined) {
      setFields.fullName = fullName;
    }
    if (parsed.data.institution !== undefined) {
      setFields.institution = parsed.data.institution || null;
    }
    if (parsed.data.photoUrl !== undefined) {
      setFields.photoUrl = parsed.data.photoUrl || null;
    }
    if (Object.keys(setFields).length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }
    await db
      .update(facultyUsersTable)
      .set(setFields)
      .where(eq(facultyUsersTable.id, id));
    // Best-effort mirror to Clerk only when the name changed. A placeholder/seed
    // clerkUserId (no matching Clerk user) shouldn't fail the local update, so
    // we log and continue.
    if (fullName !== undefined) {
      try {
        const { firstName, lastName } = splitName(fullName);
        await clerkClient.users.updateUser(target.clerkUserId, {
          firstName,
          lastName,
        });
      } catch (err) {
        req.log.warn(
          { err, memberId: id },
          "faculty admin: failed to mirror name to Clerk",
        );
      }
    }
    res.json({ id, ...setFields });
  },
);

/**
 * POST /api/faculty/admin/members/:id/reset-password — platform-admin-only.
 * Sets a new password for the member's Clerk account. The admin shares the new
 * password with the member out-of-band. Clerk enforces its own password policy
 * (length, breach checks); failures are surfaced back to the admin.
 */
router.post(
  "/faculty/admin/members/:id/reset-password",
  requireFacultyAuth,
  async (req: FacultyRequest, res, _next?): Promise<void> => {
    const ctx = req.faculty!;
    if (ctx.user.isPlatformAdmin !== "true") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid member id" });
      return;
    }
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Password must be at least 8 characters" });
      return;
    }
    const [target] = await db
      .select({
        id: facultyUsersTable.id,
        clerkUserId: facultyUsersTable.clerkUserId,
      })
      .from(facultyUsersTable)
      .where(eq(facultyUsersTable.id, id))
      .limit(1);
    if (!target) {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    try {
      await clerkClient.users.updateUser(target.clerkUserId, {
        password: parsed.data.password,
      });
    } catch (err) {
      req.log.warn({ err, memberId: id }, "faculty admin: password reset failed");
      // Clerk validation/policy rejections (e.g. weak/breached password) are
      // client errors (400); anything else is an upstream/internal failure.
      const e = err as { status?: number; errors?: unknown[] };
      const isClientError =
        Array.isArray(e?.errors) ||
        (typeof e?.status === "number" && e.status >= 400 && e.status < 500);
      res
        .status(isClientError ? 400 : 502)
        .json({ error: clerkErrorMessage(err, "Could not reset password") });
      return;
    }
    res.json({ ok: true });
  },
);

const addMembershipSchema = z.object({
  pillarId: z.number().int().positive(),
  role: z.enum(["steward", "contributor", "advisor", "viewer"]),
});

const changeRoleSchema = z.object({
  role: z.enum(["steward", "contributor", "advisor", "viewer"]),
});

/**
 * Counts the ACTIVE (non-hidden) stewards of a pillar, excluding one user. Used
 * by the guardrails to warn before an action would leave an active pillar with
 * no steward. Demo/preview accounts ({@link isHiddenFacultyEmail}) never count
 * as real coverage. Deactivated members have no memberships, so they can't
 * count either.
 */
async function countOtherStewards(
  pillarId: number,
  excludeUserId: number,
): Promise<number> {
  const rows = await db
    .select({
      userId: facultyMembershipsTable.userId,
      email: facultyUsersTable.email,
    })
    .from(facultyMembershipsTable)
    .innerJoin(
      facultyUsersTable,
      eq(facultyUsersTable.id, facultyMembershipsTable.userId),
    )
    .where(
      and(
        eq(facultyMembershipsTable.pillarId, pillarId),
        eq(facultyMembershipsTable.role, "steward"),
      ),
    );
  return rows.filter(
    (r) => r.userId !== excludeUserId && !isHiddenFacultyEmail(r.email),
  ).length;
}

/**
 * POST /api/faculty/admin/members/:id/memberships — platform-admin-only direct
 * pillar assignment (no email invite). Adds a membership + role for an existing
 * member. Rejects a duplicate (use the role-change endpoint instead) and refuses
 * to assign a deactivated member (reactivate first).
 */
router.post(
  "/faculty/admin/members/:id/memberships",
  requireFacultyAuth,
  async (req: FacultyRequest, res, _next?): Promise<void> => {
    const ctx = req.faculty!;
    if (ctx.user.isPlatformAdmin !== "true") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid member id" });
      return;
    }
    const parsed = addMembershipSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { pillarId, role } = parsed.data;
    const [target] = await db
      .select()
      .from(facultyUsersTable)
      .where(eq(facultyUsersTable.id, id))
      .limit(1);
    if (!target) {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    if (target.deactivatedAt) {
      res.status(409).json({
        error: "This member is deactivated. Reactivate them before assigning a pillar.",
      });
      return;
    }
    const [pillar] = await db
      .select()
      .from(pillarsTable)
      .where(eq(pillarsTable.id, pillarId))
      .limit(1);
    if (!pillar) {
      res.status(404).json({ error: "Pillar not found" });
      return;
    }
    const [existing] = await db
      .select()
      .from(facultyMembershipsTable)
      .where(
        and(
          eq(facultyMembershipsTable.userId, id),
          eq(facultyMembershipsTable.pillarId, pillarId),
        ),
      )
      .limit(1);
    if (existing) {
      res.status(409).json({
        error: "Already a member of this pillar. Change their role instead.",
      });
      return;
    }
    await db
      .insert(facultyMembershipsTable)
      .values({ userId: id, pillarId, role });
    req.log.info(
      { adminId: ctx.user.id, memberId: id, pillarId, role },
      "Platform admin added pillar membership",
    );
    res.status(201).json({ ok: true, pillarId, role });
  },
);

/**
 * PATCH /api/faculty/admin/members/:id/memberships/:pillarId — platform-admin-
 * only role change on a pillar the member already belongs to. Demoting the last
 * steward of an ACTIVE pillar requires `?force=true` (the UI surfaces a warning
 * first via the 409 + requiresConfirmation pattern).
 */
router.patch(
  "/faculty/admin/members/:id/memberships/:pillarId",
  requireFacultyAuth,
  async (req: FacultyRequest, res, _next?): Promise<void> => {
    const ctx = req.faculty!;
    if (ctx.user.isPlatformAdmin !== "true") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const id = Number(req.params.id);
    const pillarId = Number(req.params.pillarId);
    if (
      !Number.isInteger(id) ||
      id <= 0 ||
      !Number.isInteger(pillarId) ||
      pillarId <= 0
    ) {
      res.status(400).json({ error: "Invalid member or pillar id" });
      return;
    }
    const parsed = changeRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { role } = parsed.data;
    const [membership] = await db
      .select()
      .from(facultyMembershipsTable)
      .where(
        and(
          eq(facultyMembershipsTable.userId, id),
          eq(facultyMembershipsTable.pillarId, pillarId),
        ),
      )
      .limit(1);
    if (!membership) {
      res.status(404).json({ error: "Membership not found" });
      return;
    }
    if (membership.role === role) {
      res.json({ ok: true, pillarId, role });
      return;
    }
    // Guardrail: demoting the last steward of an active pillar leaves it with
    // no steward. Warn unless the admin explicitly confirms.
    const force = req.query.force === "true";
    if (membership.role === "steward" && role !== "steward" && !force) {
      const [pillar] = await db
        .select()
        .from(pillarsTable)
        .where(eq(pillarsTable.id, pillarId))
        .limit(1);
      if (
        pillar &&
        pillar.retiredAt == null &&
        (await countOtherStewards(pillarId, id)) === 0
      ) {
        res.status(409).json({
          requiresConfirmation: true,
          reason: "last-steward",
          pillarId,
          pillarName: pillar.name,
          error: `${pillar.name} would be left with no steward.`,
        });
        return;
      }
    }
    await db
      .update(facultyMembershipsTable)
      .set({ role })
      .where(
        and(
          eq(facultyMembershipsTable.userId, id),
          eq(facultyMembershipsTable.pillarId, pillarId),
        ),
      );
    req.log.info(
      { adminId: ctx.user.id, memberId: id, pillarId, role },
      "Platform admin changed pillar role",
    );
    res.json({ ok: true, pillarId, role });
  },
);

/**
 * DELETE /api/faculty/admin/members/:id/memberships/:pillarId — platform-admin-
 * only removal of a member from a single pillar. They keep access to their other
 * pillars. Authored content is NOT touched — only the access membership row is
 * deleted. Removing the last steward of an ACTIVE pillar requires `?force=true`.
 */
router.delete(
  "/faculty/admin/members/:id/memberships/:pillarId",
  requireFacultyAuth,
  async (req: FacultyRequest, res, _next?): Promise<void> => {
    const ctx = req.faculty!;
    if (ctx.user.isPlatformAdmin !== "true") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const id = Number(req.params.id);
    const pillarId = Number(req.params.pillarId);
    if (
      !Number.isInteger(id) ||
      id <= 0 ||
      !Number.isInteger(pillarId) ||
      pillarId <= 0
    ) {
      res.status(400).json({ error: "Invalid member or pillar id" });
      return;
    }
    const [membership] = await db
      .select()
      .from(facultyMembershipsTable)
      .where(
        and(
          eq(facultyMembershipsTable.userId, id),
          eq(facultyMembershipsTable.pillarId, pillarId),
        ),
      )
      .limit(1);
    if (!membership) {
      res.status(404).json({ error: "Membership not found" });
      return;
    }
    const force = req.query.force === "true";
    if (membership.role === "steward" && !force) {
      const [pillar] = await db
        .select()
        .from(pillarsTable)
        .where(eq(pillarsTable.id, pillarId))
        .limit(1);
      if (
        pillar &&
        pillar.retiredAt == null &&
        (await countOtherStewards(pillarId, id)) === 0
      ) {
        res.status(409).json({
          requiresConfirmation: true,
          reason: "last-steward",
          pillarId,
          pillarName: pillar.name,
          error: `${pillar.name} would be left with no steward.`,
        });
        return;
      }
    }
    await db
      .delete(facultyMembershipsTable)
      .where(
        and(
          eq(facultyMembershipsTable.userId, id),
          eq(facultyMembershipsTable.pillarId, pillarId),
        ),
      );
    req.log.info(
      { adminId: ctx.user.id, memberId: id, pillarId },
      "Platform admin removed pillar membership (content preserved)",
    );
    res.json({ ok: true });
  },
);

/**
 * POST /api/faculty/admin/members/:id/deactivate — platform-admin-only "remove
 * the person entirely". Drops ALL pillar memberships and disables their portal
 * sign-in (best-effort Clerk ban, mirroring the password-reset pattern), then
 * soft-stamps `deactivated_at`. The faculty_users row is PRESERVED — never
 * hard-deleted — so authored sources/interpretations/voice keep their
 * authorship/provenance and citations don't break.
 *
 * Guardrails: an admin cannot deactivate their own account (self-lockout), and
 * deactivating someone who is the last steward of one or more active pillars
 * requires `?force=true` (the UI warns first).
 */
router.post(
  "/faculty/admin/members/:id/deactivate",
  requireFacultyAuth,
  async (req: FacultyRequest, res, _next?): Promise<void> => {
    const ctx = req.faculty!;
    if (ctx.user.isPlatformAdmin !== "true") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid member id" });
      return;
    }
    if (id === ctx.user.id) {
      res.status(400).json({
        error: "You cannot deactivate your own account.",
      });
      return;
    }
    const [target] = await db
      .select()
      .from(facultyUsersTable)
      .where(eq(facultyUsersTable.id, id))
      .limit(1);
    if (!target) {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    if (target.deactivatedAt) {
      res.json({ ok: true, deactivatedAt: target.deactivatedAt.toISOString() });
      return;
    }

    // Guardrail: warn (unless forced) before stripping the last steward of any
    // active pillar.
    const force = req.query.force === "true";
    if (!force) {
      const stewardMemberships = await db
        .select({ pillarId: facultyMembershipsTable.pillarId })
        .from(facultyMembershipsTable)
        .where(
          and(
            eq(facultyMembershipsTable.userId, id),
            eq(facultyMembershipsTable.role, "steward"),
          ),
        );
      const orphaned: string[] = [];
      for (const m of stewardMemberships) {
        const [pillar] = await db
          .select()
          .from(pillarsTable)
          .where(eq(pillarsTable.id, m.pillarId))
          .limit(1);
        if (
          pillar &&
          pillar.retiredAt == null &&
          (await countOtherStewards(m.pillarId, id)) === 0
        ) {
          orphaned.push(pillar.name);
        }
      }
      if (orphaned.length > 0) {
        res.status(409).json({
          requiresConfirmation: true,
          reason: "last-steward",
          pillarNames: orphaned,
          error: `Removing this member leaves ${orphaned.length} active pillar${
            orphaned.length === 1 ? "" : "s"
          } with no steward.`,
        });
        return;
      }
    }

    const deactivatedAt = new Date();
    await db.transaction(async (tx) => {
      await tx
        .delete(facultyMembershipsTable)
        .where(eq(facultyMembershipsTable.userId, id));
      await tx
        .update(facultyUsersTable)
        .set({ deactivatedAt })
        .where(eq(facultyUsersTable.id, id));
    });

    // Best-effort: disable portal sign-in by banning the Clerk user. A
    // placeholder/seed clerkUserId (no matching Clerk user) shouldn't fail the
    // local deactivation — the `deactivated_at` flag is the authoritative gate
    // (the auth middleware rejects deactivated users), so we log and continue.
    let clerkWarning: string | undefined;
    try {
      await clerkClient.users.banUser(target.clerkUserId);
    } catch (err) {
      req.log.warn(
        { err, memberId: id },
        "faculty admin: failed to ban Clerk user on deactivate",
      );
      clerkWarning =
        "The member was removed locally, but blocking their sign-in in Clerk failed — they may still be able to sign in. Check their Clerk status in the roster and retry via reactivate + remove if needed.";
    }
    req.log.info(
      { adminId: ctx.user.id, memberId: id },
      "Platform admin deactivated member (content preserved)",
    );
    res.json({
      ok: true,
      deactivatedAt: deactivatedAt.toISOString(),
      ...(clerkWarning ? { clerkWarning } : {}),
    });
  },
);

/**
 * POST /api/faculty/admin/members/:id/reactivate — platform-admin-only undo of a
 * deactivation: clears `deactivated_at` and best-effort unbans the Clerk user so
 * they can sign in again. Pillar memberships are NOT restored — the admin re-adds
 * them as needed via the membership endpoints.
 */
router.post(
  "/faculty/admin/members/:id/reactivate",
  requireFacultyAuth,
  async (req: FacultyRequest, res, _next?): Promise<void> => {
    const ctx = req.faculty!;
    if (ctx.user.isPlatformAdmin !== "true") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid member id" });
      return;
    }
    const [target] = await db
      .select()
      .from(facultyUsersTable)
      .where(eq(facultyUsersTable.id, id))
      .limit(1);
    if (!target) {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    await db
      .update(facultyUsersTable)
      .set({ deactivatedAt: null })
      .where(eq(facultyUsersTable.id, id));
    let clerkWarning: string | undefined;
    try {
      await clerkClient.users.unbanUser(target.clerkUserId);
    } catch (err) {
      req.log.warn(
        { err, memberId: id },
        "faculty admin: failed to unban Clerk user on reactivate",
      );
      clerkWarning =
        "The member was reactivated locally, but lifting their Clerk sign-in block failed — they may still be locked out. Check their Clerk status in the roster and retry reactivating.";
    }
    req.log.info(
      { adminId: ctx.user.id, memberId: id },
      "Platform admin reactivated member",
    );
    res.json({ ok: true, ...(clerkWarning ? { clerkWarning } : {}) });
  },
);

/**
 * POST /api/faculty/admin/members/:id/unlock — platform-admin-only. Lifts a
 * temporary Clerk brute-force lockout (too many failed password attempts) so
 * the member can sign in again immediately instead of waiting out Clerk's
 * lockout window. Distinct from unban/reactivate: this touches ONLY the
 * lockout state — no local flags change and a deliberate ban stays in place.
 * Unlike the best-effort ban/unban calls above, a Clerk failure here is a
 * real error (the whole point is the Clerk-side unlock), so it surfaces
 * as a 502 rather than a warning.
 */
router.post(
  "/faculty/admin/members/:id/unlock",
  requireFacultyAuth,
  async (req: FacultyRequest, res, _next?): Promise<void> => {
    const ctx = req.faculty!;
    if (ctx.user.isPlatformAdmin !== "true") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid member id" });
      return;
    }
    const [target] = await db
      .select()
      .from(facultyUsersTable)
      .where(eq(facultyUsersTable.id, id))
      .limit(1);
    if (!target) {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    if (target.clerkUserId.startsWith("pending:")) {
      res.status(400).json({
        error: "This member hasn't registered a sign-in account yet.",
      });
      return;
    }
    try {
      await clerkClient.users.unlockUser(target.clerkUserId);
    } catch (err) {
      req.log.warn(
        { err, memberId: id },
        "faculty admin: Clerk unlock failed",
      );
      res.status(502).json({
        error:
          "Unlocking the member's sign-in account failed. Try again in a moment.",
      });
      return;
    }
    req.log.info(
      { adminId: ctx.user.id, memberId: id },
      "Platform admin unlocked member sign-in (Clerk lockout lifted)",
    );
    res.json({ ok: true });
  },
);

/**
 * POST /api/faculty/admin/members/:id/archive — platform-admin-only neutral
 * suspension. Sets `archived_at` on the target and adds the custodian account
 * (custodian@palonur.com) as co-steward on every pillar the target stewards.
 * Unlike deactivation, the Clerk account stays active and memberships are
 * preserved; the portal simply shows an "on leave" screen. Idempotent.
 */
router.post(
  "/faculty/admin/members/:id/archive",
  requireFacultyAuth,
  async (req: FacultyRequest, res, _next?): Promise<void> => {
    const ctx = req.faculty!;
    if (ctx.user.isPlatformAdmin !== "true") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid member id" });
      return;
    }
    if (ctx.user.id === id) {
      res.status(400).json({ error: "Cannot archive yourself" });
      return;
    }
    const [target] = await db
      .select()
      .from(facultyUsersTable)
      .where(eq(facultyUsersTable.id, id))
      .limit(1);
    if (!target) {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    if (target.deactivatedAt) {
      res
        .status(409)
        .json({ error: "Member is deactivated — reactivate first" });
      return;
    }
    if (target.archivedAt) {
      res.json({ ok: true, archivedAt: target.archivedAt.toISOString() });
      return;
    }
    const [custodian] = await db
      .select()
      .from(facultyUsersTable)
      .where(eq(facultyUsersTable.email, "custodian@palonur.com"))
      .limit(1);
    if (!custodian) {
      res
        .status(500)
        .json({ error: "Custodian account not found — contact an engineer" });
      return;
    }
    const stewardPillars = await db
      .select({ pillarId: facultyMembershipsTable.pillarId })
      .from(facultyMembershipsTable)
      .where(
        and(
          eq(facultyMembershipsTable.userId, id),
          eq(facultyMembershipsTable.role, "steward"),
        ),
      );
    const archivedAt = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(facultyUsersTable)
        .set({ archivedAt })
        .where(eq(facultyUsersTable.id, id));
      for (const { pillarId } of stewardPillars) {
        await tx
          .insert(facultyMembershipsTable)
          .values({ userId: custodian.id, pillarId, role: "steward" })
          .onConflictDoNothing();
      }
    });
    req.log.info(
      { adminId: ctx.user.id, memberId: id, pillarCount: stewardPillars.length },
      "Platform admin archived member; custodian added as co-steward",
    );
    res.json({ ok: true, archivedAt: archivedAt.toISOString() });
  },
);

/**
 * POST /api/faculty/admin/members/:id/restore — platform-admin-only undo of an
 * archive: clears `archived_at` so the member's portal resumes normally. Custodian
 * memberships are left in place (admin can remove them via the membership endpoints
 * if desired). Idempotent.
 */
router.post(
  "/faculty/admin/members/:id/restore",
  requireFacultyAuth,
  async (req: FacultyRequest, res, _next?): Promise<void> => {
    const ctx = req.faculty!;
    if (ctx.user.isPlatformAdmin !== "true") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid member id" });
      return;
    }
    const [target] = await db
      .select()
      .from(facultyUsersTable)
      .where(eq(facultyUsersTable.id, id))
      .limit(1);
    if (!target) {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    if (!target.archivedAt) {
      res.json({ ok: true });
      return;
    }
    await db
      .update(facultyUsersTable)
      .set({ archivedAt: null })
      .where(eq(facultyUsersTable.id, id));
    req.log.info(
      { adminId: ctx.user.id, memberId: id },
      "Platform admin restored archived member",
    );
    res.json({ ok: true });
  },
);

/**
 * POST /api/faculty/onboarding/complete — marks the signed-in faculty user
 * as having seen the first-login welcome story. Idempotent: only stamps
 * `onboarded_at` when it is still null, so it never overwrites the original
 * timestamp on repeat calls.
 */
router.post(
  "/faculty/onboarding/complete",
  requireFacultyAuth,
  async (req: FacultyRequest, res, _next?): Promise<void> => {
    const ctx = req.faculty!;
    // Single conditional update keeps the stamp race-safe: concurrent calls
    // can't drift the timestamp because only the first one (where
    // onboarded_at IS NULL) writes.
    await db
      .update(facultyUsersTable)
      .set({ onboardedAt: new Date() })
      .where(
        and(
          eq(facultyUsersTable.id, ctx.user.id),
          isNull(facultyUsersTable.onboardedAt),
        ),
      );
    res.json({ onboarded: true });
  },
);

/**
 * GET /api/faculty/pillars/:slug — pillar shell for a member.
 * Authorization is centralized in `requirePillarRole`.
 */
router.get(
  "/faculty/pillars/:slug",
  requireFacultyAuth,
  requirePillarRole(
    { slugParam: "slug" },
    ["steward", "contributor", "advisor", "viewer"],
  ),
  async (req: FacultyRequest, res, _next?): Promise<void> => {
    const pillar = req.pillar!;
    res.json({
      id: pillar.id,
      slug: pillar.slug,
      name: pillar.name,
      description: pillar.description,
      role: req.pillarRole,
    });
  },
);

/**
 * GET /api/faculty/aslm/usage — AskLifestyleMedicine chat usage for Lifestyle
 * Medicine directors (stewards of any SLM pillar, plus platform admins).
 *
 * Reads the existing agent_queries log for the 'slm-agent' source:
 *  - registeredUsers: distinct signed-in consumer accounts (session ids of
 *    the form 'consumer:<id>').
 *  - anonymousSessions: distinct other session keys, labeled clearly in the
 *    UI as an approximation (legacy anonymous questions share one key).
 *  - totalQuestions: every logged question.
 *  - unanswered: recent questions the governed corpus could not answer
 *    (was_uncovered = true — covers uncovered AND refused outcomes), with
 *    text and timestamp, newest first.
 *
 * Deliberately available to ASLM-channel members who pass the gate (the path
 * is NOT in ASLM_BLOCKED_PATH_PREFIXES) since directors may themselves arrive
 * via that channel.
 */
router.get(
  "/faculty/aslm/usage",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    try {
      if (!isAslmDirector(ctx)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      const [totals, unanswered] = await Promise.all([
        pool.query<{
          registered_users: number;
          anonymous_sessions: number;
          total_questions: number;
          unanswered_total: number;
        }>(
          `SELECT
             COUNT(DISTINCT session_id) FILTER (WHERE session_id LIKE 'consumer:%')::int AS registered_users,
             COUNT(DISTINCT session_id) FILTER (WHERE session_id NOT LIKE 'consumer:%')::int AS anonymous_sessions,
             COUNT(*)::int AS total_questions,
             COUNT(*) FILTER (WHERE was_uncovered = TRUE)::int AS unanswered_total
           FROM agent_queries
          WHERE source = 'slm-agent'`,
        ),
        pool.query<{ question: string; created_at: string }>(
          `SELECT question, created_at
             FROM agent_queries
            WHERE source = 'slm-agent'
              AND was_uncovered = TRUE
            ORDER BY created_at DESC
            LIMIT 50`,
        ),
      ]);
      const t = totals.rows[0];
      res.json({
        registeredUsers: t?.registered_users ?? 0,
        anonymousSessions: t?.anonymous_sessions ?? 0,
        totalQuestions: t?.total_questions ?? 0,
        unansweredTotal: t?.unanswered_total ?? 0,
        unanswered: unanswered.rows.map((r) => ({
          question: r.question,
          askedAt: r.created_at,
        })),
      });
    } catch (e) {
      req.log.error({ err: e }, "aslm usage dashboard failed");
      res.status(500).json({ error: "Failed to load usage" });
    }
  },
);

/**
 * POST /api/faculty/invitations — steward (or admin) invites a contributor
 * by email. Scoped to a pillar the steward belongs to. Authorization is
 * enforced centrally by `requirePillarRoleFromBody`.
 */
router.post(
  "/faculty/invitations",
  requireFacultyAuth,
  // Validate body shape first, then require steward role on that pillar.
  (req, res, next) => {
    const parsed = createInviteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    req.body = parsed.data;
    next();
  },
  requirePillarRoleFromBody("pillarId", ["steward"]),
  async (req: FacultyRequest, res, _next?): Promise<void> => {
    const ctx = req.faculty!;
    const pillar = req.pillar!;
    const { email, role, institution, channel } = req.body as z.infer<
      typeof createInviteSchema
    >;

    const expiresAt = new Date(
      Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000,
    );

    const [invitation] = await db
      .insert(facultyInvitationsTable)
      .values({
        email: email.toLowerCase(),
        pillarId: pillar.id,
        role,
        institution: institution?.trim() ? institution.trim() : null,
        invitedByUserId: ctx.user.id,
        registrationChannel: channel ?? null,
        expiresAt,
      })
      .returning();

    const baseUrl =
      process.env.PUBLIC_APP_URL ??
      (process.env.REPLIT_DOMAINS?.split(",")[0]
        ? `https://${process.env.REPLIT_DOMAINS.split(",")[0]}`
        : "http://localhost");
    const acceptUrl = `${baseUrl}/faculty/invite/${invitation.token}`;

    await sendFacultyInviteEmail({
      to: invitation.email,
      pillarName: pillar.name,
      inviterName: ctx.user.fullName,
      acceptUrl,
      role,
    });

    res.status(201).json({
      id: invitation.id,
      email: invitation.email,
      pillarId: invitation.pillarId,
      role: invitation.role,
      status: invitation.status,
      channel: invitation.registrationChannel,
      expiresAt: invitation.expiresAt.toISOString(),
    });
  },
);

/**
 * GET /api/faculty/invitations/:token — public preview used by the accept page.
 */
router.get(
  "/faculty/invitations/:token",
  async (req, res, _next?): Promise<void> => {
    const token = Array.isArray(req.params.token)
      ? req.params.token[0]
      : req.params.token;
    const [invitation] = await db
      .select()
      .from(facultyInvitationsTable)
      .where(eq(facultyInvitationsTable.token, token));
    if (!invitation) {
      res.status(404).json({ error: "Invitation not found" });
      return;
    }
    const [pillar] = await db
      .select()
      .from(pillarsTable)
      .where(eq(pillarsTable.id, invitation.pillarId));
    res.json({
      email: invitation.email,
      pillarName: pillar?.name ?? "",
      pillarSlug: pillar?.slug ?? "",
      role: invitation.role,
      status: invitation.status,
      expired: invitation.expiresAt.getTime() < Date.now(),
    });
  },
);

/**
 * POST /api/faculty/invitations/:token/accept — claim an invitation as the
 * currently signed-in user. Email must match.
 */
router.post(
  "/faculty/invitations/:token/accept",
  requireFacultyAuth,
  async (req: FacultyRequest, res, _next?): Promise<void> => {
    const ctx = req.faculty!;
    const token = Array.isArray(req.params.token)
      ? req.params.token[0]
      : req.params.token;
    const [invitation] = await db
      .select()
      .from(facultyInvitationsTable)
      .where(eq(facultyInvitationsTable.token, token));
    if (!invitation) {
      res.status(404).json({ error: "Invitation not found" });
      return;
    }
    if (invitation.status !== "pending") {
      res.status(409).json({ error: `Invitation already ${invitation.status}` });
      return;
    }
    if (invitation.expiresAt.getTime() < Date.now()) {
      await db
        .update(facultyInvitationsTable)
        .set({ status: "expired" })
        .where(eq(facultyInvitationsTable.id, invitation.id));
      res.status(410).json({ error: "Invitation expired" });
      return;
    }
    if (
      invitation.email.toLowerCase() !==
      (ctx.user.email ?? "").toLowerCase()
    ) {
      res.status(403).json({
        error: `This invitation was sent to ${invitation.email}. Sign in with that email to accept.`,
      });
      return;
    }

    const existing = ctx.memberships.find(
      (m: FacultyMembership) => m.pillarId === invitation.pillarId,
    );
    if (!existing) {
      await db.insert(facultyMembershipsTable).values({
        userId: ctx.user.id,
        pillarId: invitation.pillarId,
        role: invitation.role,
      });
    } else if (existing.role !== invitation.role) {
      await db
        .update(facultyMembershipsTable)
        .set({ role: invitation.role })
        .where(
          and(
            eq(facultyMembershipsTable.userId, ctx.user.id),
            eq(facultyMembershipsTable.pillarId, invitation.pillarId),
          ),
        );
    }

    await db
      .update(facultyInvitationsTable)
      .set({ status: "accepted", acceptedAt: new Date() })
      .where(eq(facultyInvitationsTable.id, invitation.id));

    // Stamp the registration channel from an ASLM-tagged invitation onto the
    // member — only if theirs is still unset, so a member who already
    // registered through the standard flow (or an earlier invite) is never
    // reclassified by a later invitation.
    if (invitation.registrationChannel && !ctx.user.registrationChannel) {
      await db
        .update(facultyUsersTable)
        .set({ registrationChannel: invitation.registrationChannel })
        .where(eq(facultyUsersTable.id, ctx.user.id));
    }

    // Seed the affiliation from the invitation only if the member hasn't set
    // their own institution yet — never clobber a self-edited value.
    if (invitation.institution && !ctx.user.institution) {
      await db
        .update(facultyUsersTable)
        .set({ institution: invitation.institution })
        .where(eq(facultyUsersTable.id, ctx.user.id));
    }

    const [pillar] = await db
      .select()
      .from(pillarsTable)
      .where(eq(pillarsTable.id, invitation.pillarId));

    res.json({
      pillar: pillar
        ? { id: pillar.id, slug: pillar.slug, name: pillar.name }
        : null,
      role: invitation.role,
    });
  },
);

// ── Newsletter contribution loop (faculty side) ─────────────────────────────
// Faculty offer a post to the SLM newsletter; editors review/accept/decline in
// the palonur newsletter-admin. Accepted posts carry the faculty byline and,
// once the issue is sent, mint a credit-ledger row the faculty member can see.

const createOfferSchema = z.object({
  title: z.string().trim().min(1).max(300),
  summary: z.string().trim().max(2000).optional(),
  bodyHtml: z.string().trim().max(50000).optional(),
  sourceMaterial: z.string().trim().max(50000).optional(),
  pillarId: z.number().int().positive().optional(),
  interpretationId: z.number().int().positive().optional(),
});

/**
 * POST /api/faculty/newsletter-offers — a faculty member offers a post to the
 * SLM newsletter. Any signed-in faculty user may contribute (no pillar role
 * gate); the offer lands in the editors' review queue.
 */
router.post(
  "/faculty/newsletter-offers",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    const parsed = createOfferSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid offer", details: parsed.error.issues });
      return;
    }
    const v = parsed.data;
    try {
      const [row] = await db
        .insert(newsletterOffersTable)
        .values({
          facultyUserId: ctx.user.id,
          authorName: ctx.user.fullName,
          authorEmail: ctx.user.email,
          authorInstitution: ctx.user.institution,
          pillarId: v.pillarId ?? null,
          interpretationId: v.interpretationId ?? null,
          title: v.title,
          summary: v.summary ?? null,
          bodyHtml: v.bodyHtml ?? null,
          sourceMaterial: v.sourceMaterial ?? null,
        })
        .returning();
      res.json({ offer: row });
    } catch (e) {
      req.log.error({ err: e }, "create newsletter offer failed");
      res.status(500).json({ error: "Failed to create offer" });
    }
  },
);

/**
 * GET /api/faculty/newsletter-offers — the signed-in faculty member's own
 * offers, newest first.
 */
router.get(
  "/faculty/newsletter-offers",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    try {
      const offers = await db
        .select()
        .from(newsletterOffersTable)
        .where(eq(newsletterOffersTable.facultyUserId, ctx.user.id))
        .orderBy(desc(newsletterOffersTable.createdAt));
      res.json({ offers });
    } catch (e) {
      req.log.error({ err: e }, "list newsletter offers failed");
      res.status(500).json({ error: "Failed to load offers" });
    }
  },
);

/**
 * GET /api/faculty/newsletter-credits — the signed-in faculty member's credit
 * ledger (minted when an issue carrying their post is sent), plus a summary.
 */
router.get(
  "/faculty/newsletter-credits",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    try {
      const credits = await db
        .select()
        .from(newsletterCreditsTable)
        .where(eq(newsletterCreditsTable.facultyUserId, ctx.user.id))
        .orderBy(desc(newsletterCreditsTable.createdAt));
      const totalCents = credits.reduce((s, c) => s + c.amountCents, 0);
      const paidCents = credits
        .filter((c) => c.status === "paid")
        .reduce((s, c) => s + c.amountCents, 0);
      res.json({
        credits,
        summary: {
          featuredCount: credits.length,
          totalCents,
          paidCents,
          outstandingCents: totalCents - paidCents,
        },
      });
    } catch (e) {
      req.log.error({ err: e }, "list newsletter credits failed");
      res.status(500).json({ error: "Failed to load credits" });
    }
  },
);

// ── Communication offers (faculty side → Matt Abrahams) ─────────────────────
// A separate destination from the newsletter: stewards offer a written article
// to Matt for communication-focused content. Matt reviews in his own queue.
// There is intentionally NO credit/ledger here.

const createCommunicationOfferSchema = z.object({
  title: z.string().trim().min(1).max(300),
  summary: z.string().trim().max(2000).optional(),
  bodyHtml: z.string().trim().max(50000).optional(),
});

/**
 * POST /api/faculty/communication-offers — a faculty member offers an article
 * to Matt Abrahams. Any signed-in faculty user may contribute; the offer lands
 * in Matt's review queue (NOT the newsletter editors' queue).
 */
router.post(
  "/faculty/communication-offers",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    const parsed = createCommunicationOfferSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid offer", details: parsed.error.issues });
      return;
    }
    const v = parsed.data;
    try {
      const [row] = await db
        .insert(communicationOffersTable)
        .values({
          facultyUserId: ctx.user.id,
          authorName: ctx.user.fullName,
          authorEmail: ctx.user.email,
          authorInstitution: ctx.user.institution,
          title: v.title,
          summary: v.summary ?? null,
          bodyHtml: v.bodyHtml ?? null,
        })
        .returning();
      // Notify Matt's reviewer allowlist (fire-and-forget; no-ops cleanly when
      // email isn't configured). Never let a notification failure fail the
      // offer.
      const reviewers = (
        process.env.COMMUNICATION_REVIEWER_EMAILS ??
        "abrahams_matt@gsb.stanford.edu"
      )
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (reviewers.length > 0) {
        try {
          await sendCommunicationOfferNotice({
            to: reviewers,
            authorName: row.authorName,
            authorEmail: row.authorEmail,
            title: row.title,
            summary: row.summary,
          });
        } catch (notifyErr) {
          req.log.error(
            { err: notifyErr },
            "communication offer notice failed",
          );
        }
      }
      res.json({ offer: row });
    } catch (e) {
      req.log.error({ err: e }, "create communication offer failed");
      res.status(500).json({ error: "Failed to create offer" });
    }
  },
);

/**
 * GET /api/faculty/communication-offers — the signed-in faculty member's own
 * article offers to Matt, newest first.
 */
router.get(
  "/faculty/communication-offers",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    try {
      const offers = await db
        .select()
        .from(communicationOffersTable)
        .where(eq(communicationOffersTable.facultyUserId, ctx.user.id))
        .orderBy(desc(communicationOffersTable.createdAt));
      res.json({ offers });
    } catch (e) {
      req.log.error({ err: e }, "list communication offers failed");
      res.status(500).json({ error: "Failed to load offers" });
    }
  },
);

// ── ParentData.org offers (faculty side → ParentData editor) ────────────────
// A separate destination from the newsletter AND from Matt's queue: stewards
// propose a written article to ParentData.org, an outside media outlet, whose
// editor reviews them in her own dashboard. Each proposal also carries a
// back-and-forth conversation thread. No credit/ledger here.

const createParentDataOfferSchema = z.object({
  title: z.string().trim().min(1).max(300),
  summary: z.string().trim().max(2000).optional(),
  bodyHtml: z.string().trim().max(50000).optional(),
  // Optional: the editor's call-for-articles this proposal answers. Validated
  // against an OPEN call below; unsolicited proposals omit it.
  callId: z.number().int().positive().optional(),
});

const parentDataMessageSchema = z.object({
  body: z.string().trim().min(1).max(5000),
});

function parentDataReviewerEmails(): string[] {
  return (process.env.PARENTDATA_REVIEWER_EMAILS ?? "hello@parentdata.org")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * POST /api/faculty/parentdata-offers — a faculty member proposes an article to
 * ParentData.org. Any signed-in faculty user may contribute; the proposal lands
 * in ParentData's editor's review queue.
 */
router.post(
  "/faculty/parentdata-offers",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    const parsed = createParentDataOfferSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid proposal", details: parsed.error.issues });
      return;
    }
    const v = parsed.data;
    try {
      // If the proposal answers a call, it must reference an OPEN one.
      if (v.callId !== undefined) {
        const [call] = await db
          .select({ status: parentdataCallsTable.status })
          .from(parentdataCallsTable)
          .where(eq(parentdataCallsTable.id, v.callId))
          .limit(1);
        if (!call || call.status !== "open") {
          res
            .status(400)
            .json({ error: "That call for articles is no longer open" });
          return;
        }
      }
      const [row] = await db
        .insert(parentdataOffersTable)
        .values({
          facultyUserId: ctx.user.id,
          authorName: ctx.user.fullName,
          authorEmail: ctx.user.email,
          authorInstitution: ctx.user.institution,
          title: v.title,
          summary: v.summary ?? null,
          bodyHtml: v.bodyHtml ?? null,
          callId: v.callId ?? null,
        })
        .returning();
      // Notify ParentData's reviewer allowlist (fire-and-forget; no-ops cleanly
      // when email isn't configured). Never let a notification failure fail the
      // proposal.
      const reviewers = parentDataReviewerEmails();
      if (reviewers.length > 0) {
        try {
          await sendParentDataOfferNotice({
            to: reviewers,
            authorName: row.authorName,
            authorEmail: row.authorEmail,
            title: row.title,
            summary: row.summary,
          });
        } catch (notifyErr) {
          req.log.error({ err: notifyErr }, "parentdata offer notice failed");
        }
      }
      res.json({ offer: row });
    } catch (e) {
      req.log.error({ err: e }, "create parentdata offer failed");
      res.status(500).json({ error: "Failed to create proposal" });
    }
  },
);

/**
 * GET /api/faculty/parentdata-offers — the signed-in faculty member's own
 * ParentData proposals, newest first.
 */
router.get(
  "/faculty/parentdata-offers",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    try {
      const offers = await db
        .select()
        .from(parentdataOffersTable)
        .where(eq(parentdataOffersTable.facultyUserId, ctx.user.id))
        .orderBy(desc(parentdataOffersTable.createdAt));
      res.json({ offers });
    } catch (e) {
      req.log.error({ err: e }, "list parentdata offers failed");
      res.status(500).json({ error: "Failed to load proposals" });
    }
  },
);

/**
 * GET /api/faculty/parentdata-calls — OPEN calls for articles the ParentData
 * editor has posted, newest first. Any signed-in faculty member can read them;
 * closed calls are never surfaced here.
 */
router.get(
  "/faculty/parentdata-calls",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    try {
      const calls = await db
        .select({
          id: parentdataCallsTable.id,
          title: parentdataCallsTable.title,
          brief: parentdataCallsTable.brief,
          budgetCents: parentdataCallsTable.budgetCents,
          createdAt: parentdataCallsTable.createdAt,
        })
        .from(parentdataCallsTable)
        .where(eq(parentdataCallsTable.status, "open"))
        .orderBy(desc(parentdataCallsTable.createdAt));
      res.json({ calls });
    } catch (e) {
      req.log.error({ err: e }, "list parentdata calls (faculty) failed");
      res.status(500).json({ error: "Failed to load calls" });
    }
  },
);

/**
 * Resolve a ParentData offer the caller owns, or send a 403/404 and return
 * null. Ownership is enforced so a faculty member can only touch the
 * conversation on their own proposals.
 */
async function ownedParentDataOffer(
  req: FacultyRequest,
  res: import("express").Response,
): Promise<typeof parentdataOffersTable.$inferSelect | null> {
  const ctx = req.faculty!;
  const offerId = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(offerId)) {
    res.status(400).json({ error: "Invalid id" });
    return null;
  }
  const [offer] = await db
    .select()
    .from(parentdataOffersTable)
    .where(eq(parentdataOffersTable.id, offerId))
    .limit(1);
  if (!offer || offer.facultyUserId !== ctx.user.id) {
    res.status(404).json({ error: "Proposal not found" });
    return null;
  }
  return offer;
}

/**
 * GET /api/faculty/parentdata-offers/:id/messages — the conversation thread on
 * one of the caller's own proposals, oldest first.
 */
router.get(
  "/faculty/parentdata-offers/:id/messages",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    try {
      const offer = await ownedParentDataOffer(req, res);
      if (!offer) return;
      const messages = await db
        .select()
        .from(parentdataOfferMessagesTable)
        .where(eq(parentdataOfferMessagesTable.offerId, offer.id))
        .orderBy(asc(parentdataOfferMessagesTable.createdAt));
      res.json({ messages });
    } catch (e) {
      req.log.error({ err: e }, "list parentdata messages (faculty) failed");
      res.status(500).json({ error: "Failed to load messages" });
    }
  },
);

/**
 * POST /api/faculty/parentdata-offers/:id/messages — the steward posts a
 * message to the ParentData editor on their own proposal.
 */
router.post(
  "/faculty/parentdata-offers/:id/messages",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    const parsed = parentDataMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Message required" });
      return;
    }
    try {
      const offer = await ownedParentDataOffer(req, res);
      if (!offer) return;
      const [message] = await db
        .insert(parentdataOfferMessagesTable)
        .values({
          offerId: offer.id,
          senderRole: "faculty",
          senderName: ctx.user.fullName ?? ctx.user.email,
          senderEmail: ctx.user.email,
          body: parsed.data.body,
        })
        .returning();
      // Notify ParentData's editor (fire-and-forget; never fail the write).
      const reviewers = parentDataReviewerEmails();
      if (reviewers.length > 0) {
        try {
          await sendParentDataMessageNotice({
            to: reviewers,
            fromName: offer.authorName ?? offer.authorEmail ?? "A steward",
            title: offer.title,
            body: parsed.data.body,
            audience: "reviewer",
          });
        } catch (notifyErr) {
          req.log.error(
            { err: notifyErr },
            "parentdata message notice (faculty) failed",
          );
        }
      }
      res.json({ message });
    } catch (e) {
      req.log.error({ err: e }, "post parentdata message (faculty) failed");
      res.status(500).json({ error: "Failed to send message" });
    }
  },
);

const channelInterestSchema = z.object({
  // Stable identifier for an upcoming ("Soon") distribution channel, defined in
  // the faculty frontend's `channels` array. Not a foreign key — Soon channels
  // don't exist as DB rows.
  channelKey: z.string().trim().min(1).max(120),
});

/**
 * POST /api/faculty/channel-interest — the signed-in faculty member registers
 * interest in an upcoming ("Soon") distribution channel. Idempotent per
 * (faculty user, channel): re-clicking does nothing thanks to the unique index.
 */
router.post(
  "/faculty/channel-interest",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    const parsed = channelInterestSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid request", details: parsed.error.issues });
      return;
    }
    try {
      await db
        .insert(facultyChannelInterestTable)
        .values({
          facultyUserId: ctx.user.id,
          channelKey: parsed.data.channelKey,
        })
        .onConflictDoNothing({
          target: [
            facultyChannelInterestTable.facultyUserId,
            facultyChannelInterestTable.channelKey,
          ],
        });
      res.json({ channelKey: parsed.data.channelKey, interested: true });
    } catch (e) {
      req.log.error({ err: e }, "register channel interest failed");
      res.status(500).json({ error: "Failed to register interest" });
    }
  },
);

/**
 * GET /api/faculty/channel-interest — the channel keys the signed-in faculty
 * member has already registered interest in, so the UI can show which Soon
 * cards they've already opted into.
 */
router.get(
  "/faculty/channel-interest",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    try {
      const rows = await db
        .select({ channelKey: facultyChannelInterestTable.channelKey })
        .from(facultyChannelInterestTable)
        .where(eq(facultyChannelInterestTable.facultyUserId, ctx.user.id));
      res.json({ channelKeys: rows.map((r) => r.channelKey) });
    } catch (e) {
      req.log.error({ err: e }, "list channel interest failed");
      res.status(500).json({ error: "Failed to load interest" });
    }
  },
);

/**
 * GET /api/faculty/admin/channel-interest — platform-admin-only. Which upcoming
 * channels stewards have registered interest in, grouped by channel with a
 * count and the interested members, so operators can see which channels to
 * prioritize. Gated identically to the other admin endpoints (platform-admin
 * only).
 */
router.get(
  "/faculty/admin/channel-interest",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    if (ctx.user.isPlatformAdmin !== "true") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    try {
      const rows = await db
        .select({
          channelKey: facultyChannelInterestTable.channelKey,
          createdAt: facultyChannelInterestTable.createdAt,
          userId: facultyUsersTable.id,
          fullName: facultyUsersTable.fullName,
          email: facultyUsersTable.email,
        })
        .from(facultyChannelInterestTable)
        .innerJoin(
          facultyUsersTable,
          eq(facultyChannelInterestTable.facultyUserId, facultyUsersTable.id),
        )
        .orderBy(desc(facultyChannelInterestTable.createdAt));

      const visible = rows.filter((r) => !isHiddenFacultyEmail(r.email));
      const byChannel = new Map<
        string,
        {
          channelKey: string;
          count: number;
          members: {
            userId: number;
            fullName: string | null;
            email: string;
            createdAt: Date;
          }[];
        }
      >();
      for (const r of visible) {
        let entry = byChannel.get(r.channelKey);
        if (!entry) {
          entry = { channelKey: r.channelKey, count: 0, members: [] };
          byChannel.set(r.channelKey, entry);
        }
        entry.count += 1;
        entry.members.push({
          userId: r.userId,
          fullName: r.fullName,
          email: r.email,
          createdAt: r.createdAt,
        });
      }
      const channels = [...byChannel.values()].sort(
        (a, b) => b.count - a.count,
      );
      res.json({ channels });
    } catch (e) {
      req.log.error({ err: e }, "list admin channel interest failed");
      res.status(500).json({ error: "Failed to load channel interest" });
    }
  },
);

// ── Distribution channels (admin CRUD) ──────────────────────────────────────
// The cards on the faculty "Distribution Channels" page are DB-backed
// (distribution_channels) so a platform admin can manage them without an
// engineer. A channel's behaviour is derived from its fields: `outlet` opens a
// bespoke in-page detail view (newsletter / matt / parentdata, which live in
// the frontend code); `href` links out; status 'soon' with neither shows an
// "I'm interested" control keyed by `key`. See lib/db/src/schema/distributionChannels.ts.

const CHANNEL_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// The bespoke, code-backed detail views a card may open. New interactive
// outlets require an engineer to add the view, so this list is intentionally
// closed — arbitrary outlet strings are rejected.
const CHANNEL_OUTLETS = ["newsletter", "matt", "parentdata"] as const;

const channelHrefSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (v) => /^https?:\/\/\S+$/i.test(v),
    "Link must be a full http(s):// URL",
  );

const channelEditableSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(600).optional(),
  category: z.string().trim().max(80).optional(),
  status: z.enum(["live", "soon"]),
  href: channelHrefSchema.nullish(),
  outlet: z.enum(CHANNEL_OUTLETS).nullish(),
  isPrimary: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
});

// A "live" card with neither an outlet nor a link would render as a dead, blank
// card — reject it. "Soon" cards are fine with neither (they show the
// interest/notify-me control).
const liveNeedsDestination = (d: {
  status: "live" | "soon";
  outlet?: string | null;
  href?: string | null;
}): boolean => d.status !== "live" || !!d.outlet || !!d.href;
const liveNeedsDestinationMsg = {
  message: "A live channel needs either an outlet or an external link.",
  path: ["href"] as PropertyKey[],
};

const createChannelSchema = channelEditableSchema
  .extend({
    key: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(
        CHANNEL_KEY_RE,
        "Key must be lowercase letters, numbers, and single hyphens",
      ),
  })
  .refine(liveNeedsDestination, liveNeedsDestinationMsg);

// `key` is intentionally absent — it is immutable after create (it anchors
// faculty_channel_interest rows).
const updateChannelSchema = channelEditableSchema.refine(
  liveNeedsDestination,
  liveNeedsDestinationMsg,
);

const channelColumns = {
  id: distributionChannelsTable.id,
  key: distributionChannelsTable.key,
  name: distributionChannelsTable.name,
  description: distributionChannelsTable.description,
  category: distributionChannelsTable.category,
  status: distributionChannelsTable.status,
  href: distributionChannelsTable.href,
  outlet: distributionChannelsTable.outlet,
  isPrimary: distributionChannelsTable.isPrimary,
  sortOrder: distributionChannelsTable.sortOrder,
} as const;

/**
 * GET /api/faculty/distribution-channels — any signed-in faculty member. The
 * channels rendered on the Distribution Channels page, ordered for display.
 */
router.get(
  "/faculty/distribution-channels",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    try {
      const channels = await db
        .select(channelColumns)
        .from(distributionChannelsTable)
        .orderBy(
          asc(distributionChannelsTable.sortOrder),
          asc(distributionChannelsTable.id),
        );
      res.json({ channels });
    } catch (e) {
      req.log.error({ err: e }, "list distribution channels failed");
      res.status(500).json({ error: "Failed to load channels" });
    }
  },
);

/**
 * GET /api/faculty/admin/distribution-channels — platform-admin-only. Same list
 * (admins manage the very channels everyone sees), kept as a distinct endpoint
 * so the admin UI has a stable, clearly-gated query key.
 */
router.get(
  "/faculty/admin/distribution-channels",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    if (ctx.user.isPlatformAdmin !== "true") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    try {
      const channels = await db
        .select(channelColumns)
        .from(distributionChannelsTable)
        .orderBy(
          asc(distributionChannelsTable.sortOrder),
          asc(distributionChannelsTable.id),
        );
      res.json({ channels });
    } catch (e) {
      req.log.error({ err: e }, "list admin distribution channels failed");
      res.status(500).json({ error: "Failed to load channels" });
    }
  },
);

/**
 * POST /api/faculty/admin/distribution-channels — platform-admin-only. Creates
 * a channel. `key` must be unique and URL-safe (it anchors interest rows and is
 * immutable thereafter). New channels sort to the end unless a sortOrder is given.
 */
router.post(
  "/faculty/admin/distribution-channels",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    if (ctx.user.isPlatformAdmin !== "true") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const parsed = createChannelSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
      return;
    }
    const d = parsed.data;
    const [existing] = await db
      .select({ id: distributionChannelsTable.id })
      .from(distributionChannelsTable)
      .where(eq(distributionChannelsTable.key, d.key))
      .limit(1);
    if (existing) {
      res
        .status(409)
        .json({ error: `A channel with key "${d.key}" already exists` });
      return;
    }
    let sortOrder = d.sortOrder;
    if (sortOrder === undefined) {
      const [{ max }] = await db
        .select({
          max: sql<number>`COALESCE(MAX(${distributionChannelsTable.sortOrder}), -1)::int`,
        })
        .from(distributionChannelsTable);
      sortOrder = max + 1;
    }
    try {
      const [created] = await db
        .insert(distributionChannelsTable)
        .values({
          key: d.key,
          name: d.name,
          description: d.description ?? "",
          category: d.category ?? "",
          status: d.status,
          // A built-in outlet wins; never persist a stale href alongside it.
          href: d.outlet ? null : (d.href ?? null),
          outlet: d.outlet ?? null,
          isPrimary: d.isPrimary ?? false,
          sortOrder,
        })
        .returning(channelColumns);
      req.log.info(
        { facultyUserId: ctx.user.id, channelId: created.id, key: d.key },
        "Platform admin created distribution channel",
      );
      res.status(201).json({ channel: created });
    } catch (e) {
      req.log.error({ err: e }, "create distribution channel failed");
      res.status(500).json({ error: "Failed to create channel" });
    }
  },
);

/**
 * PATCH /api/faculty/admin/distribution-channels/:id — platform-admin-only.
 * Updates the editable fields (everything except the immutable `key`). The form
 * sends the full editable set; sortOrder is only changed when provided.
 */
router.patch(
  "/faculty/admin/distribution-channels/:id",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    if (ctx.user.isPlatformAdmin !== "true") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid channel id" });
      return;
    }
    const parsed = updateChannelSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
      return;
    }
    const d = parsed.data;
    try {
      const [updated] = await db
        .update(distributionChannelsTable)
        .set({
          name: d.name,
          description: d.description ?? "",
          category: d.category ?? "",
          status: d.status,
          // A built-in outlet wins; never persist a stale href alongside it.
          href: d.outlet ? null : (d.href ?? null),
          outlet: d.outlet ?? null,
          isPrimary: d.isPrimary ?? false,
          ...(d.sortOrder !== undefined ? { sortOrder: d.sortOrder } : {}),
          updatedAt: new Date(),
        })
        .where(eq(distributionChannelsTable.id, id))
        .returning(channelColumns);
      if (!updated) {
        res.status(404).json({ error: "Channel not found" });
        return;
      }
      req.log.info(
        { facultyUserId: ctx.user.id, channelId: id },
        "Platform admin updated distribution channel",
      );
      res.json({ channel: updated });
    } catch (e) {
      req.log.error({ err: e }, "update distribution channel failed");
      res.status(500).json({ error: "Failed to update channel" });
    }
  },
);

/**
 * DELETE /api/faculty/admin/distribution-channels/:id — platform-admin-only.
 * Removes the card. Any faculty_channel_interest rows keyed to it are left
 * intact (loose string key, not an FK) — the admin aggregate tolerates orphans.
 */
router.delete(
  "/faculty/admin/distribution-channels/:id",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    if (ctx.user.isPlatformAdmin !== "true") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid channel id" });
      return;
    }
    const [deleted] = await db
      .delete(distributionChannelsTable)
      .where(eq(distributionChannelsTable.id, id))
      .returning({ id: distributionChannelsTable.id });
    if (!deleted) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    req.log.warn(
      { facultyUserId: ctx.user.id, channelId: id },
      "Platform admin deleted distribution channel",
    );
    res.json({ ok: true });
  },
);

export default router;
