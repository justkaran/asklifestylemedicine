/**
 * Faculty-owned newsletters ("self-publish").
 *
 * Each faculty member gets ONE publication of their own (isHouse = false) that
 * owns its own subscribers + issues + branding, with a public signup/unsubscribe
 * surface, all hosted + sent by Palonur. This is entirely separate from the
 * house Stanford Lifestyle Medicine newsletter and the offer→accept→send credit
 * loop: **faculty self-publish mints NO reimbursement credits.**
 *
 * Every route is gated by `requireFacultyAuth` and scoped to the caller's own
 * publication, so faculty A can never read or mutate faculty B's subscribers,
 * issues or posts. The public per-publication signup endpoints live in
 * routes/newsletter.ts (no auth); unsubscribe reuses the shared token endpoint.
 */
import { Router, type IRouter } from "express";
import { randomBytes } from "crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  newsletterPublicationsTable,
  newsletterSubscribersTable,
  newsletterIssuesTable,
  newsletterPostsTable,
} from "@workspace/db";
import {
  requireFacultyAuth,
  type FacultyRequest,
} from "../middlewares/facultyAuth.js";
import {
  buildIssueHtml,
  buildWelcomeEmail,
  sendWelcomeEmail,
  htmlToText,
  unsubscribeUrlFor,
  sendNewsletterEmail,
  brandingForPublication,
  publicationAskUrl,
  newsletterResendConfigured,
  type IssueForEmail,
  type PostForEmail,
} from "../lib/newsletterEmail.js";
import { loadStewardAskEligibility } from "../lib/stewardAsk.js";
import {
  generateLandingCopy,
  generateLandingImages,
  generateLandingImage,
  landingContentEditSchema,
  normalizeEditedLanding,
  isImageGenAvailable,
} from "../lib/newsletterLanding.js";

const router: IRouter = Router();

type PublicationRow = typeof newsletterPublicationsTable.$inferSelect;

function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Find-or-create the signed-in faculty member's single publication. The slug is
 * deterministic and unique (base + faculty user id), so creation never collides
 * and the public link is stable.
 */
async function ensureFacultyPublication(
  facultyUserId: number,
  fullName: string | null,
  institution: string | null,
): Promise<PublicationRow> {
  const existing = await db
    .select()
    .from(newsletterPublicationsTable)
    .where(eq(newsletterPublicationsTable.facultyUserId, facultyUserId))
    .limit(1);
  if (existing[0]) return existing[0];

  const base = slugify(fullName ?? "") || "newsletter";
  const slug = `${base}-${facultyUserId}`;
  const name = fullName ? `${fullName}'s Newsletter` : "My Newsletter";
  try {
    const [row] = await db
      .insert(newsletterPublicationsTable)
      .values({
        isHouse: false,
        facultyUserId,
        name,
        slug,
        bylineName: fullName,
        bylineInstitution: institution,
      })
      .returning();
    return row;
  } catch {
    // Lost a race — re-read the now-existing row.
    const again = await db
      .select()
      .from(newsletterPublicationsTable)
      .where(eq(newsletterPublicationsTable.facultyUserId, facultyUserId))
      .limit(1);
    if (again[0]) return again[0];
    throw new Error("Failed to ensure faculty publication");
  }
}

/**
 * Resolve the caller's own issue by id, or null if it doesn't exist OR belongs
 * to another publication (ownership isolation).
 */
async function ownIssue(publicationId: number, issueId: number) {
  const rows = await db
    .select()
    .from(newsletterIssuesTable)
    .where(
      and(
        eq(newsletterIssuesTable.id, issueId),
        eq(newsletterIssuesTable.publicationId, publicationId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// ── Publication (branding) ───────────────────────────────────────────────────

router.get(
  "/faculty/publication",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    try {
      const pub = await ensureFacultyPublication(
        ctx.user.id,
        ctx.user.fullName,
        ctx.user.institution,
      );
      res.json({ publication: pub });
    } catch (e) {
      req.log.error({ err: e }, "load faculty publication failed");
      res.status(500).json({ error: "Failed to load publication" });
    }
  },
);

const updatePublicationSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  bylineName: z.string().trim().max(200).nullable().optional(),
  bylineInstitution: z.string().trim().max(200).nullable().optional(),
  tagline: z.string().trim().max(400).nullable().optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  accentColor: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{3,8}$/)
    .nullable()
    .optional(),
  fromAddress: z.string().trim().max(200).nullable().optional(),
});

router.patch(
  "/faculty/publication",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    const parsed = updatePublicationSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid update", details: parsed.error.issues });
      return;
    }
    if (Object.keys(parsed.data).length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }
    try {
      const pub = await ensureFacultyPublication(
        ctx.user.id,
        ctx.user.fullName,
        ctx.user.institution,
      );
      const [row] = await db
        .update(newsletterPublicationsTable)
        .set(parsed.data)
        .where(eq(newsletterPublicationsTable.id, pub.id))
        .returning();
      res.json({ publication: row });
    } catch (e) {
      req.log.error({ err: e }, "update faculty publication failed");
      res.status(500).json({ error: "Failed to update publication" });
    }
  },
);

// ── Welcome email (preview + test send to self) ──────────────────────────────
// New confirmed subscribers receive a one-time branded welcome email. These two
// routes let the steward see exactly what that first touchpoint looks like —
// either a rendered HTML preview, or a test send to their own inbox — both built
// from the SAME buildWelcomeEmail / brandingForPublication derivation subscribers
// receive, so the preview can never drift from the real email. The steward's own
// publication byline names them; a placeholder unsubscribe link keeps the footer
// faithful. Writes run as the real caller (view-as is GET-only) scoped to the
// caller's own publication.

router.get(
  "/faculty/publication/welcome-preview",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    try {
      const pub = await ensureFacultyPublication(
        ctx.user.id,
        ctx.user.fullName,
        ctx.user.institution,
      );
      const branding = brandingForPublication(pub);
      const built = buildWelcomeEmail({
        unsubscribeUrl: unsubscribeUrlFor("preview"),
        branding,
        stewardName: pub.bylineName,
      });
      res.json({
        subject: built.subject,
        html: built.html,
        fromAddress: branding.fromAddress,
      });
    } catch (e) {
      req.log.error({ err: e }, "welcome email preview failed");
      res.status(500).json({ error: "Failed to build preview" });
    }
  },
);

router.post(
  "/faculty/publication/welcome-test",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    if (!(await newsletterResendConfigured())) {
      res.status(503).json({
        error: "Email sending isn't configured yet, so a test can't be sent.",
      });
      return;
    }
    try {
      const pub = await ensureFacultyPublication(
        ctx.user.id,
        ctx.user.fullName,
        ctx.user.institution,
      );
      const ok = await sendWelcomeEmail({
        to: ctx.user.email,
        name: ctx.user.fullName,
        unsubscribeUrl: unsubscribeUrlFor("preview"),
        branding: brandingForPublication(pub),
        stewardName: pub.bylineName,
      });
      if (!ok) {
        res
          .status(502)
          .json({ error: "The test email could not be delivered." });
        return;
      }
      res.json({ ok: true, to: ctx.user.email });
    } catch (e) {
      req.log.error({ err: e }, "welcome email test send failed");
      res.status(500).json({ error: "Failed to send test email" });
    }
  },
);

// ── Landing page (Topic → auto-generated editorial landing) ──────────────────
// A faculty owner sets a Topic and we auto-generate (then they fully edit) a
// rich editorial landing page rendered at /p/:slug. Mirrors the house routes in
// routes/newsletter.ts (same lib). All writes run as the real caller (view-as is
// GET-only), scoped to the caller's own publication. AI degrades gracefully.

const facultyLandingGenerateSchema = z.object({
  topic: z.string().trim().min(2).max(160),
});

const facultyLandingImageSchema = z.object({
  target: z.union([z.literal("hero"), z.coerce.number().int().min(0).max(7)]),
  prompt: z.string().trim().min(2).max(600),
});

router.post(
  "/faculty/publication/landing/generate",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    const parsed = facultyLandingGenerateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "A topic is required" });
      return;
    }
    try {
      const pub = await ensureFacultyPublication(
        ctx.user.id,
        ctx.user.fullName,
        ctx.user.institution,
      );
      const draft = await generateLandingCopy({
        topic: parsed.data.topic,
        publicationName: pub.name,
        bylineName: pub.bylineName,
        bylineInstitution: pub.bylineInstitution,
      });
      if (!draft) {
        res
          .status(502)
          .json({ error: "Could not generate landing copy right now. Try again." });
        return;
      }
      const { heroImagePath, content } = await generateLandingImages(draft);
      const [row] = await db
        .update(newsletterPublicationsTable)
        .set({
          topic: parsed.data.topic,
          landingContent: content,
          heroImagePath,
          heroImagePrompt: draft.heroImagePrompt,
          landingGeneratedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(newsletterPublicationsTable.id, pub.id))
        .returning();
      res.json({ publication: row });
    } catch (e) {
      req.log.error({ err: e }, "generate faculty landing failed");
      res.status(500).json({ error: "Failed" });
    }
  },
);

router.put(
  "/faculty/publication/landing",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    const body = req.body as { topic?: unknown; landingContent?: unknown };
    const parsed = landingContentEditSchema.safeParse(body.landingContent);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid landing content" });
      return;
    }
    try {
      const pub = await ensureFacultyPublication(
        ctx.user.id,
        ctx.user.fullName,
        ctx.user.institution,
      );
      const topic =
        typeof body.topic === "string" ? body.topic.trim().slice(0, 160) : pub.topic;
      const [row] = await db
        .update(newsletterPublicationsTable)
        .set({
          topic: topic || null,
          landingContent: normalizeEditedLanding(parsed.data),
          updatedAt: new Date(),
        })
        .where(eq(newsletterPublicationsTable.id, pub.id))
        .returning();
      res.json({ publication: row });
    } catch (e) {
      req.log.error({ err: e }, "save faculty landing failed");
      res.status(500).json({ error: "Failed" });
    }
  },
);

router.post(
  "/faculty/publication/landing/image",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    const parsed = facultyLandingImageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "An image prompt is required" });
      return;
    }
    if (!isImageGenAvailable()) {
      res.status(503).json({ error: "Image generation is not configured" });
      return;
    }
    try {
      const pub = await ensureFacultyPublication(
        ctx.user.id,
        ctx.user.fullName,
        ctx.user.institution,
      );
      const objectPath = await generateLandingImage(parsed.data.prompt);
      if (!objectPath) {
        res.status(502).json({ error: "Image generation failed" });
        return;
      }
      if (parsed.data.target === "hero") {
        const [row] = await db
          .update(newsletterPublicationsTable)
          .set({
            heroImagePath: objectPath,
            heroImagePrompt: parsed.data.prompt,
            updatedAt: new Date(),
          })
          .where(eq(newsletterPublicationsTable.id, pub.id))
          .returning();
        res.json({ publication: row });
        return;
      }
      const content = pub.landingContent;
      if (!content || !content.sections?.[parsed.data.target]) {
        res.status(400).json({ error: "Section not found" });
        return;
      }
      const sections = content.sections.map((s, i) =>
        i === parsed.data.target
          ? { ...s, imagePath: objectPath, imagePrompt: parsed.data.prompt }
          : s,
      );
      const [row] = await db
        .update(newsletterPublicationsTable)
        .set({ landingContent: { ...content, sections }, updatedAt: new Date() })
        .where(eq(newsletterPublicationsTable.id, pub.id))
        .returning();
      res.json({ publication: row });
    } catch (e) {
      req.log.error({ err: e }, "faculty landing image failed");
      res.status(500).json({ error: "Failed" });
    }
  },
);

// Slugs a faculty member must never be able to claim for their public signup
// handle: the house publication's slug plus a small set of obvious reserved
// words (app paths / official-looking names).
const RESERVED_SLUGS = new Set<string>([
  "stanford-lifestyle-medicine",
  "stanford",
  "palonur",
  "admin",
  "api",
  "newsletter",
  "house",
  "subscribe",
  "unsubscribe",
  "login",
  "settings",
  "p",
]);

const updateSlugSchema = z.object({
  slug: z.string().trim().min(1).max(60),
});

router.patch(
  "/faculty/publication/slug",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    const parsed = updateSlugSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Enter a handle for your signup page." });
      return;
    }
    const slug = slugify(parsed.data.slug);
    if (!slug) {
      res.status(400).json({
        error:
          "That handle can't be used — use letters and numbers (e.g. your name).",
      });
      return;
    }
    if (RESERVED_SLUGS.has(slug)) {
      res.status(409).json({ error: "That handle is taken — try another." });
      return;
    }
    try {
      const pub = await ensureFacultyPublication(
        ctx.user.id,
        ctx.user.fullName,
        ctx.user.institution,
      );
      const [row] = await db
        .update(newsletterPublicationsTable)
        .set({ slug })
        .where(eq(newsletterPublicationsTable.id, pub.id))
        .returning();
      res.json({ publication: row });
    } catch (e: any) {
      const code = e?.code ?? e?.cause?.code;
      if (String(code) === "23505") {
        res.status(409).json({ error: "That handle is taken — try another." });
        return;
      }
      req.log.error({ err: e }, "update faculty publication slug failed");
      res.status(500).json({ error: "Failed to update handle" });
    }
  },
);

// ── Subscribers ──────────────────────────────────────────────────────────────

router.get(
  "/faculty/publication/subscribers",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    try {
      const pub = await ensureFacultyPublication(
        ctx.user.id,
        ctx.user.fullName,
        ctx.user.institution,
      );
      const rows = await db
        .select()
        .from(newsletterSubscribersTable)
        .where(eq(newsletterSubscribersTable.publicationId, pub.id))
        .orderBy(desc(newsletterSubscribersTable.createdAt));
      const active = rows.filter((r) => r.status === "active").length;
      res.json({
        subscribers: rows,
        counts: {
          total: rows.length,
          active,
          unsubscribed: rows.filter((r) => r.status === "unsubscribed").length,
        },
      });
    } catch (e) {
      req.log.error({ err: e }, "list faculty subscribers failed");
      res.status(500).json({ error: "Failed to load subscribers" });
    }
  },
);

router.post(
  "/faculty/publication/subscribers",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    const { email, name } = req.body as { email?: string; name?: string };
    const emailClean = String(email ?? "").trim().toLowerCase();
    if (!emailClean || !isEmail(emailClean)) {
      res.status(400).json({ error: "A valid email is required" });
      return;
    }
    try {
      const pub = await ensureFacultyPublication(
        ctx.user.id,
        ctx.user.fullName,
        ctx.user.institution,
      );
      const existing = await db
        .select()
        .from(newsletterSubscribersTable)
        .where(
          and(
            eq(newsletterSubscribersTable.publicationId, pub.id),
            eq(newsletterSubscribersTable.email, emailClean),
          ),
        )
        .limit(1);
      if (existing[0]) {
        await db
          .update(newsletterSubscribersTable)
          .set({ status: "active", unsubscribedAt: null })
          .where(eq(newsletterSubscribersTable.id, existing[0].id));
        res.json({ ok: true, alreadyExists: true });
        return;
      }
      const [row] = await db
        .insert(newsletterSubscribersTable)
        .values({
          publicationId: pub.id,
          email: emailClean,
          name: name ? String(name).trim().slice(0, 200) : null,
          source: "manual",
          unsubscribeToken: randomBytes(24).toString("hex"),
          confirmedAt: new Date(),
        })
        .returning();
      res.json({ ok: true, subscriber: row });
    } catch (e) {
      req.log.error({ err: e }, "add faculty subscriber failed");
      res.status(500).json({ error: "Failed to add subscriber" });
    }
  },
);

router.delete(
  "/faculty/publication/subscribers/:id",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Bad id" });
      return;
    }
    try {
      const pub = await ensureFacultyPublication(
        ctx.user.id,
        ctx.user.fullName,
        ctx.user.institution,
      );
      await db
        .delete(newsletterSubscribersTable)
        .where(
          and(
            eq(newsletterSubscribersTable.id, id),
            eq(newsletterSubscribersTable.publicationId, pub.id),
          ),
        );
      res.json({ ok: true });
    } catch (e) {
      req.log.error({ err: e }, "delete faculty subscriber failed");
      res.status(500).json({ error: "Failed to delete subscriber" });
    }
  },
);

// ── Issues ───────────────────────────────────────────────────────────────────

router.get(
  "/faculty/publication/issues",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    try {
      const pub = await ensureFacultyPublication(
        ctx.user.id,
        ctx.user.fullName,
        ctx.user.institution,
      );
      const issues = await db
        .select()
        .from(newsletterIssuesTable)
        .where(eq(newsletterIssuesTable.publicationId, pub.id))
        .orderBy(desc(newsletterIssuesTable.createdAt));
      res.json({ issues });
    } catch (e) {
      req.log.error({ err: e }, "list faculty issues failed");
      res.status(500).json({ error: "Failed to load issues" });
    }
  },
);

router.post(
  "/faculty/publication/issues",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    const { title } = req.body as { title?: string };
    const t = String(title ?? "").trim() || "Untitled issue";
    try {
      const pub = await ensureFacultyPublication(
        ctx.user.id,
        ctx.user.fullName,
        ctx.user.institution,
      );
      const [row] = await db
        .insert(newsletterIssuesTable)
        .values({
          publicationId: pub.id,
          title: t,
          createdBy: ctx.user.email,
        })
        .returning();
      res.json({ issue: row });
    } catch (e) {
      req.log.error({ err: e }, "create faculty issue failed");
      res.status(500).json({ error: "Failed to create issue" });
    }
  },
);

router.get(
  "/faculty/publication/issues/:id",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    const id = parseInt(String(req.params.id), 10);
    try {
      const pub = await ensureFacultyPublication(
        ctx.user.id,
        ctx.user.fullName,
        ctx.user.institution,
      );
      const issue = await ownIssue(pub.id, id);
      if (!issue) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      const posts = await db
        .select()
        .from(newsletterPostsTable)
        .where(eq(newsletterPostsTable.issueId, id))
        .orderBy(
          asc(newsletterPostsTable.position),
          asc(newsletterPostsTable.id),
        );
      const activeSubscribers = (
        await db
          .select({ id: newsletterSubscribersTable.id })
          .from(newsletterSubscribersTable)
          .where(
            and(
              eq(newsletterSubscribersTable.publicationId, pub.id),
              eq(newsletterSubscribersTable.status, "active"),
            ),
          )
      ).length;
      res.json({ issue, posts, activeSubscribers });
    } catch (e) {
      req.log.error({ err: e }, "get faculty issue failed");
      res.status(500).json({ error: "Failed to load issue" });
    }
  },
);

const patchIssueSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  subjectLine: z.string().trim().max(300).nullable().optional(),
  previewText: z.string().trim().max(400).nullable().optional(),
  introHtml: z.string().max(20000).nullable().optional(),
  heroImagePath: z.string().trim().max(500).nullable().optional(),
});

router.patch(
  "/faculty/publication/issues/:id",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    const id = parseInt(String(req.params.id), 10);
    const parsed = patchIssueSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid update", details: parsed.error.issues });
      return;
    }
    if (Object.keys(parsed.data).length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }
    try {
      const pub = await ensureFacultyPublication(
        ctx.user.id,
        ctx.user.fullName,
        ctx.user.institution,
      );
      const issue = await ownIssue(pub.id, id);
      if (!issue) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      if (issue.status === "sent") {
        res.status(409).json({ error: "This issue was already sent" });
        return;
      }
      const [row] = await db
        .update(newsletterIssuesTable)
        .set(parsed.data)
        .where(eq(newsletterIssuesTable.id, id))
        .returning();
      res.json({ issue: row });
    } catch (e) {
      req.log.error({ err: e }, "patch faculty issue failed");
      res.status(500).json({ error: "Failed to update issue" });
    }
  },
);

router.delete(
  "/faculty/publication/issues/:id",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    const id = parseInt(String(req.params.id), 10);
    try {
      const pub = await ensureFacultyPublication(
        ctx.user.id,
        ctx.user.fullName,
        ctx.user.institution,
      );
      const issue = await ownIssue(pub.id, id);
      if (!issue) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      await db
        .delete(newsletterIssuesTable)
        .where(eq(newsletterIssuesTable.id, id));
      res.json({ ok: true });
    } catch (e) {
      req.log.error({ err: e }, "delete faculty issue failed");
      res.status(500).json({ error: "Failed to delete issue" });
    }
  },
);

// ── Posts ────────────────────────────────────────────────────────────────────

const createPostSchema = z.object({
  title: z.string().trim().max(300).nullable().optional(),
  bodyHtml: z.string().max(40000).nullable().optional(),
  pullQuote: z.string().trim().max(1000).nullable().optional(),
  authorName: z.string().trim().max(200).nullable().optional(),
  authorInstitution: z.string().trim().max(200).nullable().optional(),
  imagePath: z.string().trim().max(500).nullable().optional(),
});

router.post(
  "/faculty/publication/issues/:id/posts",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    const issueId = parseInt(String(req.params.id), 10);
    const parsed = createPostSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid post", details: parsed.error.issues });
      return;
    }
    try {
      const pub = await ensureFacultyPublication(
        ctx.user.id,
        ctx.user.fullName,
        ctx.user.institution,
      );
      const issue = await ownIssue(pub.id, issueId);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      const maxPos = (
        await db
          .select({ position: newsletterPostsTable.position })
          .from(newsletterPostsTable)
          .where(eq(newsletterPostsTable.issueId, issueId))
          .orderBy(desc(newsletterPostsTable.position))
          .limit(1)
      )[0];
      const [row] = await db
        .insert(newsletterPostsTable)
        .values({
          issueId,
          kind: "article",
          position: (maxPos?.position ?? -1) + 1,
          title: parsed.data.title ?? null,
          bodyHtml: parsed.data.bodyHtml ?? null,
          pullQuote: parsed.data.pullQuote ?? null,
          authorName: parsed.data.authorName ?? ctx.user.fullName,
          authorInstitution:
            parsed.data.authorInstitution ?? ctx.user.institution,
          imagePath: parsed.data.imagePath ?? null,
        })
        .returning();
      res.json({ post: row });
    } catch (e) {
      req.log.error({ err: e }, "create faculty post failed");
      res.status(500).json({ error: "Failed to create post" });
    }
  },
);

const patchPostSchema = createPostSchema.extend({
  position: z.number().int().min(0).optional(),
});

/**
 * Resolve a post id back to the caller's publication (post → issue →
 * publication) before any mutation, so faculty B can't edit faculty A's posts.
 */
async function ownPost(publicationId: number, postId: number) {
  const rows = await db
    .select({
      post: newsletterPostsTable,
      issuePublicationId: newsletterIssuesTable.publicationId,
    })
    .from(newsletterPostsTable)
    .innerJoin(
      newsletterIssuesTable,
      eq(newsletterPostsTable.issueId, newsletterIssuesTable.id),
    )
    .where(eq(newsletterPostsTable.id, postId))
    .limit(1);
  const row = rows[0];
  if (!row || row.issuePublicationId !== publicationId) return null;
  return row.post;
}

router.patch(
  "/faculty/publication/posts/:id",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    const id = parseInt(String(req.params.id), 10);
    const parsed = patchPostSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid update", details: parsed.error.issues });
      return;
    }
    if (Object.keys(parsed.data).length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }
    try {
      const pub = await ensureFacultyPublication(
        ctx.user.id,
        ctx.user.fullName,
        ctx.user.institution,
      );
      const post = await ownPost(pub.id, id);
      if (!post) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      const [row] = await db
        .update(newsletterPostsTable)
        .set(parsed.data)
        .where(eq(newsletterPostsTable.id, id))
        .returning();
      res.json({ post: row });
    } catch (e) {
      req.log.error({ err: e }, "patch faculty post failed");
      res.status(500).json({ error: "Failed to update post" });
    }
  },
);

router.delete(
  "/faculty/publication/posts/:id",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    const id = parseInt(String(req.params.id), 10);
    try {
      const pub = await ensureFacultyPublication(
        ctx.user.id,
        ctx.user.fullName,
        ctx.user.institution,
      );
      const post = await ownPost(pub.id, id);
      if (!post) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      await db
        .delete(newsletterPostsTable)
        .where(eq(newsletterPostsTable.id, id));
      res.json({ ok: true });
    } catch (e) {
      req.log.error({ err: e }, "delete faculty post failed");
      res.status(500).json({ error: "Failed to delete post" });
    }
  },
);

// ── Send ─────────────────────────────────────────────────────────────────────
// Faculty self-publish has no premium tier and — critically — mints NO credits.
// Only the house offer→accept→send path in routes/newsletter.ts mints the
// reimbursement ledger.

router.post(
  "/faculty/publication/issues/:id/send",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    const id = parseInt(String(req.params.id), 10);
    try {
      const pub = await ensureFacultyPublication(
        ctx.user.id,
        ctx.user.fullName,
        ctx.user.institution,
      );
      const issue = await ownIssue(pub.id, id);
      if (!issue) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      if (issue.status === "sent") {
        res.status(409).json({ error: "This issue was already sent" });
        return;
      }
      const postRows = await db
        .select()
        .from(newsletterPostsTable)
        .where(eq(newsletterPostsTable.issueId, id))
        .orderBy(
          asc(newsletterPostsTable.position),
          asc(newsletterPostsTable.id),
        );
      if (postRows.length === 0) {
        res.status(400).json({ error: "Add at least one post before sending" });
        return;
      }
      const subs = await db
        .select()
        .from(newsletterSubscribersTable)
        .where(
          and(
            eq(newsletterSubscribersTable.publicationId, pub.id),
            eq(newsletterSubscribersTable.status, "active"),
          ),
        );
      if (subs.length === 0) {
        res.status(400).json({ error: "No active subscribers" });
        return;
      }

      const branding = brandingForPublication(pub);
      const issueForEmail: IssueForEmail = {
        id: issue.id,
        title: issue.title,
        subjectLine: issue.subjectLine,
        previewText: issue.previewText,
        introHtml: issue.introHtml,
        heroImagePath: issue.heroImagePath,
      };
      const posts: PostForEmail[] = postRows.map((p) => ({
        id: p.id,
        kind: p.kind,
        title: p.title,
        authorName: p.authorName,
        authorInstitution: p.authorInstitution,
        bodyHtml: p.bodyHtml,
        pullQuote: p.pullQuote,
        imagePath: p.imagePath,
      }));
      const subject = issue.subjectLine || issue.title;

      // Surface an "Ask <steward> a question" CTA only when the publication's
      // owner is ask-eligible (published voice + approved pillar content), so
      // the email never links readers to a panel that can't answer.
      const ask = await loadStewardAskEligibility(pub.facultyUserId);
      const askCta =
        ask.eligible && ask.stewardName
          ? { url: publicationAskUrl(pub.slug), name: ask.stewardName }
          : null;

      let sent = 0;
      let failed = 0;
      for (const sub of subs) {
        const html = buildIssueHtml({
          issue: issueForEmail,
          posts,
          unsubscribeUrl: unsubscribeUrlFor(sub.unsubscribeToken),
          branding,
          askCta,
        });
        const ok = await sendNewsletterEmail({
          to: sub.email,
          subject,
          html,
          text: htmlToText(html),
          from: branding.fromAddress,
        });
        if (ok) sent += 1;
        else failed += 1;
      }

      if (sent === 0) {
        res.status(502).json({
          error:
            "No emails could be delivered. Check email configuration and try again.",
          sent,
          failed,
          total: subs.length,
        });
        return;
      }

      await db
        .update(newsletterIssuesTable)
        .set({ status: "sent", sentAt: new Date(), recipientCount: sent })
        .where(eq(newsletterIssuesTable.id, id));

      // NOTE: deliberately no credit minting here.
      res.json({ ok: true, sent, failed, total: subs.length });
    } catch (e) {
      req.log.error({ err: e }, "send faculty issue failed");
      res.status(500).json({ error: "Failed to send issue" });
    }
  },
);

export default router;
