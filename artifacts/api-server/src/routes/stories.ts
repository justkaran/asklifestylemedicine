import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { randomUUID, createHash, randomBytes } from "crypto";
import { createRequire } from "module";
const archiver: (format: string, opts?: any) => any = createRequire(import.meta.url)("archiver");
import Anthropic from "@anthropic-ai/sdk";
import { eq, desc, and } from "drizzle-orm";
import {
  db,
  storiesTable,
  storyImagesTable,
  storyInvitesTable,
  storyEditorSessionsTable,
  storyEditorsTable,
} from "@workspace/db";
import { sendStoryMagicLink, sendStoryInvite } from "../lib/storyEmail";
import { emailRateLimit } from "../middlewares/emailRateLimit";

const router: IRouter = Router();

const STORIES_COOKIE = "stories_session";
const DRAFT_COOKIE = "story_draft";
const HASH_SALT = process.env.SESSION_SECRET ?? "dev-secret-change-me";
// Code/env default. This is the SEED for the admin-managed `story_editors`
// table (populated on first read) and the FALLBACK used if that table can't be
// read. Once the table is seeded, the managed list is authoritative — so an
// admin can remove a default editor and it stays removed.
const DEFAULT_EDITOR_EMAILS = (
  process.env.STORY_EDITOR_EMAILS ?? "khokhar@stanford.edu,karan@palonur.com"
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function normalizeEmail(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

// Seed the managed editor table from the env/code default exactly once — only
// when it is empty. Seeding on every read would resurrect an editor an admin
// deliberately removed, so we never re-seed a non-empty table.
async function ensureEditorsSeeded(): Promise<void> {
  const existing = await db
    .select({ id: storyEditorsTable.id })
    .from(storyEditorsTable)
    .limit(1);
  if (existing.length > 0) return;
  if (DEFAULT_EDITOR_EMAILS.length === 0) return;
  await db
    .insert(storyEditorsTable)
    .values(DEFAULT_EDITOR_EMAILS.map((email) => ({ email, addedBy: "seed" })))
    .onConflictDoNothing();
}

// The effective editor allowlist: the admin-managed DB rows, seeded from the
// env/code default. Falls back to the env/code default if the DB is
// unreachable so a transient DB blip can never lock every editor out.
async function getAllowedEditorEmails(): Promise<string[]> {
  try {
    await ensureEditorsSeeded();
    const rows = await db
      .select({ email: storyEditorsTable.email })
      .from(storyEditorsTable);
    const emails = rows.map((r) => r.email.toLowerCase());
    return emails.length > 0 ? emails : DEFAULT_EDITOR_EMAILS;
  } catch {
    return DEFAULT_EDITOR_EMAILS;
  }
}

const anthropic = new Anthropic({
  baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
});

function ipHash(req: Request): string {
  const ip =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
    req.socket.remoteAddress ??
    "unknown";
  return createHash("sha256").update(ip + ":" + HASH_SALT).digest("hex");
}

// ── Editor / admin auth ─────────────────────────────────────────────────────

async function getSessionEditor(req: Request): Promise<string | null> {
  const token = req.signedCookies?.[STORIES_COOKIE] as string | undefined;
  if (!token) return null;
  const rows = await db
    .select()
    .from(storyEditorSessionsTable)
    .where(eq(storyEditorSessionsTable.sessionToken, token))
    .limit(1);
  const s = rows[0];
  if (!s) return null;
  if (s.sessionExpiresAt && s.sessionExpiresAt.getTime() < Date.now()) return null;
  return s.email;
}

function isAdmin(req: Request): boolean {
  return req.signedCookies?.palonur_admin === "1";
}

async function requireEditorOrAdmin(req: Request, res: Response, next: NextFunction) {
  if (isAdmin(req)) {
    (req as any).editorIdentity = "admin";
    return next();
  }
  const email = await getSessionEditor(req);
  if (email) {
    (req as any).editorIdentity = email;
    return next();
  }
  return res.status(401).json({ error: "Unauthorized" });
}

// ── Magic-link auth ─────────────────────────────────────────────────────────

router.post("/stories-auth/request", emailRateLimit, async (req: Request, res: Response) => {
  const email = normalizeEmail((req.body as { email?: string }).email);
  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "Email required" });
  }
  const allowed = await getAllowedEditorEmails();
  if (!allowed.includes(email)) {
    // Don't leak who is authorised — return generic success
    req.log.warn({ email }, "story magic-link requested for non-allowed email");
    return res.json({ ok: true });
  }
  const token = randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  await db.insert(storyEditorSessionsTable).values({
    email,
    magicToken: token,
    expiresAt,
  });
  await sendStoryMagicLink({ to: email, token });
  return res.json({ ok: true });
});

router.get("/stories-auth/consume", async (req: Request, res: Response) => {
  const token = String(req.query.token ?? "");
  if (!token) return res.status(400).json({ error: "Token required" });
  const rows = await db
    .select()
    .from(storyEditorSessionsTable)
    .where(eq(storyEditorSessionsTable.magicToken, token))
    .limit(1);
  const s = rows[0];
  if (!s || s.consumedAt || s.expiresAt.getTime() < Date.now()) {
    return res.status(400).json({ error: "Link expired or already used" });
  }
  const sessionToken = randomBytes(32).toString("hex");
  const sessionExpiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
  await db
    .update(storyEditorSessionsTable)
    .set({ consumedAt: new Date(), sessionToken, sessionExpiresAt })
    .where(eq(storyEditorSessionsTable.id, s.id));
  res.cookie(STORIES_COOKIE, sessionToken, {
    signed: true,
    httpOnly: true,
    sameSite: "lax",
    maxAge: 8 * 60 * 60 * 1000,
  });
  return res.json({ ok: true, email: s.email });
});

router.get("/stories-auth/me", async (req: Request, res: Response) => {
  if (isAdmin(req)) return res.json({ email: "admin", role: "admin" });
  const email = await getSessionEditor(req);
  if (!email) return res.status(401).json({ error: "Unauthorized" });
  return res.json({ email, role: "editor" });
});

router.post("/stories-auth/logout", async (req: Request, res: Response) => {
  res.clearCookie(STORIES_COOKIE);
  return res.json({ ok: true });
});

// ── Admin: manage the editor allowlist ──────────────────────────────────────
// Platform-admin-only (palonur_admin cookie). Editor sessions deliberately do
// NOT grant access here — managing who can be an editor is an admin capability.
// Paths are namespaced (`/stories-editors`) so they never collide with the
// `/stories/:id` editor-dashboard routes.

function requireAdminOnly(req: Request, res: Response, next: NextFunction) {
  if (isAdmin(req)) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

router.get("/stories-editors", requireAdminOnly, async (req: Request, res: Response) => {
  try {
    await ensureEditorsSeeded();
    const rows = await db
      .select()
      .from(storyEditorsTable)
      .orderBy(storyEditorsTable.email);
    return res.json({ editors: rows });
  } catch (e) {
    req.log.error({ err: e }, "list editors failed");
    return res.status(500).json({ error: "Failed" });
  }
});

router.post("/stories-editors", requireAdminOnly, async (req: Request, res: Response) => {
  try {
    const email = normalizeEmail((req.body as { email?: string }).email);
    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "Valid email required" });
    }
    await ensureEditorsSeeded();
    const [row] = await db
      .insert(storyEditorsTable)
      .values({ email, addedBy: "admin" })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      // Already present — return the existing row so the UI stays idempotent.
      const existing = await db
        .select()
        .from(storyEditorsTable)
        .where(eq(storyEditorsTable.email, email))
        .limit(1);
      return res.json({ editor: existing[0], alreadyExists: true });
    }
    return res.json({ editor: row });
  } catch (e) {
    req.log.error({ err: e }, "add editor failed");
    return res.status(500).json({ error: "Failed" });
  }
});

router.delete("/stories-editors/:id", requireAdminOnly, async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Bad id" });
    await db.delete(storyEditorsTable).where(eq(storyEditorsTable.id, id));
    return res.json({ ok: true });
  } catch (e) {
    req.log.error({ err: e }, "remove editor failed");
    return res.status(500).json({ error: "Failed" });
  }
});

// ── Public intake ───────────────────────────────────────────────────────────

async function getOrCreateDraft(req: Request, res: Response): Promise<typeof storiesTable.$inferSelect> {
  const token = req.signedCookies?.[DRAFT_COOKIE] as string | undefined;
  if (token) {
    const rows = await db
      .select()
      .from(storiesTable)
      .where(eq(storiesTable.draftToken, token))
      .limit(1);
    if (rows[0] && (rows[0].status === "draft" || rows[0].status === "new")) {
      return rows[0];
    }
  }
  const newToken = randomBytes(24).toString("hex");
  const inserted = await db
    .insert(storiesTable)
    .values({
      draftToken: newToken,
      referrer: typeof req.query.ref === "string" ? req.query.ref : null,
      sleepQueryId: typeof req.query.q === "string" ? req.query.q : null,
    })
    .returning();
  res.cookie(DRAFT_COOKIE, newToken, {
    signed: true,
    httpOnly: true,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
  return inserted[0];
}

router.get("/stories/intake/draft", async (req: Request, res: Response) => {
  try {
    const draft = await getOrCreateDraft(req, res);
    // attach invite context if invite token present
    const inviteToken = typeof req.query.invite === "string" ? req.query.invite : null;
    if (inviteToken && !draft.inviteId) {
      const inv = await db
        .select()
        .from(storyInvitesTable)
        .where(eq(storyInvitesTable.token, inviteToken))
        .limit(1);
      if (inv[0] && inv[0].expiresAt.getTime() > Date.now()) {
        await db
          .update(storiesTable)
          .set({
            inviteId: inv[0].id,
            inviterNote: inv[0].contextNote,
            email: inv[0].email,
            referrer: "invite",
          })
          .where(eq(storiesTable.id, draft.id));
        draft.inviteId = inv[0].id;
        draft.inviterNote = inv[0].contextNote;
      }
    }
    const images = await db
      .select()
      .from(storyImagesTable)
      .where(eq(storyImagesTable.storyId, draft.id))
      .orderBy(storyImagesTable.position);
    return res.json({ draft, images });
  } catch (e) {
    req.log.error({ err: e }, "failed to load story draft");
    return res.status(500).json({ error: "Failed" });
  }
});

router.patch("/stories/intake/draft", async (req: Request, res: Response) => {
  try {
    const draft = await getOrCreateDraft(req, res);
    if (draft.status !== "draft" && draft.status !== "new") {
      return res.status(409).json({ error: "Submission already locked" });
    }
    const body = req.body as Partial<typeof storiesTable.$inferInsert>;
    const patch: Partial<typeof storiesTable.$inferInsert> = {};
    for (const k of [
      "firstName",
      "email",
      "anonymous",
      "goal",
      "hook",
      "struggle",
      "enablement",
      "followUps",
      "followUpAnswers",
    ] as const) {
      if (k in body) (patch as any)[k] = (body as any)[k];
    }
    if (Object.keys(patch).length === 0) return res.json({ draft });
    const [updated] = await db
      .update(storiesTable)
      .set(patch)
      .where(eq(storiesTable.id, draft.id))
      .returning();
    return res.json({ draft: updated });
  } catch (e) {
    req.log.error({ err: e }, "failed to patch story draft");
    return res.status(500).json({ error: "Failed" });
  }
});

router.post("/stories/intake/follow-up", async (req: Request, res: Response) => {
  try {
    const { section, answer } = req.body as { section?: string; answer?: string };
    const validSections = ["goal", "hook", "struggle", "enablement"] as const;
    if (!section || !validSections.includes(section as any) || !answer) {
      return res.status(400).json({ error: "Invalid section or answer" });
    }
    const labels: Record<string, string> = {
      goal: "Goal (the outcome they hoped for)",
      hook: "Hook (the moment that sparked the story)",
      struggle: "Struggle (what got in the way)",
      enablement: "Enablement (what helped them through)",
    };
    const prompt = `You are helping a Stanford Lifestyle Medicine editor collect a sleep story using Jennifer Aaker's PACE framework. The reader just answered the "${labels[section]}" prompt with:

"""
${answer.slice(0, 1200)}
"""

Write ONE warm, concrete follow-up question (≤ 22 words) that helps them add a vivid sensory or emotional detail. No multi-part questions. No preamble. Just the question.`;
    let followUp = "";
    try {
      const msg = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 120,
        messages: [{ role: "user", content: prompt }],
      });
      const part = msg.content.find((p: any) => p.type === "text") as { text?: string } | undefined;
      followUp = (part?.text ?? "").trim().replace(/^["']|["']$/g, "");
    } catch (e) {
      req.log.warn({ err: e }, "follow-up AI failed; using fallback");
    }
    if (!followUp) {
      followUp =
        section === "goal"
          ? "What would the morning after a perfect night of sleep look like for you?"
          : section === "hook"
          ? "Where were you, and what time of night was it?"
          : section === "struggle"
          ? "What's the moment you remember most clearly?"
          : "Who or what helped you turn the corner?";
    }
    return res.json({ followUp });
  } catch (e) {
    req.log.error({ err: e }, "follow-up route failed");
    return res.status(500).json({ error: "Failed" });
  }
});

router.post("/stories/intake/images", async (req: Request, res: Response) => {
  try {
    const draft = await getOrCreateDraft(req, res);
    const { objectPath, contentType, originalName } = req.body as {
      objectPath?: string;
      contentType?: string;
      originalName?: string;
    };
    if (!objectPath || !objectPath.startsWith("/objects/")) {
      return res.status(400).json({ error: "Invalid objectPath" });
    }
    const existing = await db
      .select()
      .from(storyImagesTable)
      .where(eq(storyImagesTable.storyId, draft.id));
    if (existing.length >= 3) {
      return res.status(409).json({ error: "Max 3 images" });
    }
    const [img] = await db
      .insert(storyImagesTable)
      .values({
        storyId: draft.id,
        objectPath,
        contentType: contentType ?? null,
        originalName: originalName ?? null,
        position: existing.length,
      })
      .returning();
    return res.json({ image: img });
  } catch (e) {
    req.log.error({ err: e }, "image attach failed");
    return res.status(500).json({ error: "Failed" });
  }
});

router.delete("/stories/intake/images/:id", async (req: Request, res: Response) => {
  try {
    const draft = await getOrCreateDraft(req, res);
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Bad id" });
    await db
      .delete(storyImagesTable)
      .where(and(eq(storyImagesTable.id, id), eq(storyImagesTable.storyId, draft.id)));
    return res.json({ ok: true });
  } catch (e) {
    req.log.error({ err: e }, "image delete failed");
    return res.status(500).json({ error: "Failed" });
  }
});

router.post("/stories/intake/submit", async (req: Request, res: Response) => {
  try {
    const draft = await getOrCreateDraft(req, res);
    const { consentCopyright, consentPublish, anonymous, firstName, email } = req.body as {
      consentCopyright?: boolean;
      consentPublish?: boolean;
      anonymous?: boolean;
      firstName?: string;
      email?: string;
    };
    if (!consentCopyright || !consentPublish) {
      return res.status(400).json({ error: "Both consent boxes must be checked" });
    }
    if (!draft.goal || !draft.hook || !draft.struggle || !draft.enablement) {
      return res.status(400).json({ error: "All four PACE sections required" });
    }
    const [updated] = await db
      .update(storiesTable)
      .set({
        status: "new",
        firstName: firstName ?? draft.firstName,
        email: email ?? draft.email,
        anonymous: anonymous ?? false,
        consentCopyright: true,
        consentPublish: true,
        consentTimestamp: new Date(),
        consentIpHash: ipHash(req),
        submittedAt: new Date(),
      })
      .where(eq(storiesTable.id, draft.id))
      .returning();
    // mark invite used if attached
    if (updated.inviteId) {
      await db
        .update(storyInvitesTable)
        .set({ usedAt: new Date(), storyId: updated.id })
        .where(eq(storyInvitesTable.id, updated.inviteId));
    }
    res.clearCookie(DRAFT_COOKIE);
    return res.json({ ok: true, id: updated.id });
  } catch (e) {
    req.log.error({ err: e }, "story submit failed");
    return res.status(500).json({ error: "Failed" });
  }
});

// ── Editor dashboard ────────────────────────────────────────────────────────

router.get("/stories", requireEditorOrAdmin, async (req: Request, res: Response) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : null;
    let q = db.select().from(storiesTable).$dynamic();
    if (status && ["new", "in_edit", "approved", "archived"].includes(status)) {
      q = q.where(eq(storiesTable.status, status as any));
    } else {
      // exclude unfinished drafts from list by default
      // (simple: filter in app code)
    }
    const rows = await q.orderBy(desc(storiesTable.submittedAt), desc(storiesTable.createdAt));
    const visible = status ? rows : rows.filter((r) => r.status !== "draft");
    return res.json({ stories: visible });
  } catch (e) {
    req.log.error({ err: e }, "list stories failed");
    return res.status(500).json({ error: "Failed" });
  }
});

router.get("/stories/:id", requireEditorOrAdmin, async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Bad id" });
    const rows = await db.select().from(storiesTable).where(eq(storiesTable.id, id)).limit(1);
    const story = rows[0];
    if (!story) return res.status(404).json({ error: "Not found" });
    const images = await db
      .select()
      .from(storyImagesTable)
      .where(eq(storyImagesTable.storyId, id))
      .orderBy(storyImagesTable.position);
    return res.json({ story, images });
  } catch (e) {
    req.log.error({ err: e }, "load story failed");
    return res.status(500).json({ error: "Failed" });
  }
});

router.patch("/stories/:id", requireEditorOrAdmin, async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Bad id" });
    const existing = await db.select().from(storiesTable).where(eq(storiesTable.id, id)).limit(1);
    if (!existing[0]) return res.status(404).json({ error: "Not found" });
    if (existing[0].status === "approved") {
      return res.status(409).json({ error: "Approved stories are locked" });
    }
    const body = req.body as Partial<typeof storiesTable.$inferInsert>;
    const patch: Partial<typeof storiesTable.$inferInsert> = {};
    for (const k of [
      "status",
      "firstName",
      "anonymous",
      "goal",
      "hook",
      "struggle",
      "enablement",
      "draftHtml",
      "pullQuote",
      "editorNotes",
    ] as const) {
      if (k in body) (patch as any)[k] = (body as any)[k];
    }
    if (patch.status === "approved") {
      patch.approvedAt = new Date();
      patch.approvedBy = (req as any).editorIdentity ?? "editor";
    }
    const [updated] = await db
      .update(storiesTable)
      .set(patch)
      .where(eq(storiesTable.id, id))
      .returning();
    return res.json({ story: updated });
  } catch (e) {
    req.log.error({ err: e }, "patch story failed");
    return res.status(500).json({ error: "Failed" });
  }
});

router.patch("/stories/:id/images/:imageId", requireEditorOrAdmin, async (req, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const imageId = parseInt(String(req.params.imageId), 10);
    if (!Number.isFinite(id) || !Number.isFinite(imageId)) {
      return res.status(400).json({ error: "Bad id" });
    }
    const body = req.body as { caption?: string; position?: number; isPullImage?: boolean };
    const patch: any = {};
    if (typeof body.caption === "string") patch.caption = body.caption;
    if (typeof body.position === "number") patch.position = body.position;
    if (typeof body.isPullImage === "boolean") {
      patch.isPullImage = body.isPullImage;
      if (body.isPullImage) {
        await db
          .update(storyImagesTable)
          .set({ isPullImage: false })
          .where(eq(storyImagesTable.storyId, id));
      }
    }
    const [img] = await db
      .update(storyImagesTable)
      .set(patch)
      .where(and(eq(storyImagesTable.id, imageId), eq(storyImagesTable.storyId, id)))
      .returning();
    return res.json({ image: img });
  } catch (e) {
    req.log.error({ err: e }, "image patch failed");
    return res.status(500).json({ error: "Failed" });
  }
});

router.delete("/stories/:id/images/:imageId", requireEditorOrAdmin, async (req, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const imageId = parseInt(String(req.params.imageId), 10);
    await db
      .delete(storyImagesTable)
      .where(and(eq(storyImagesTable.id, imageId), eq(storyImagesTable.storyId, id)));
    return res.json({ ok: true });
  } catch (e) {
    req.log.error({ err: e }, "image delete failed");
    return res.status(500).json({ error: "Failed" });
  }
});

router.post("/stories/:id/generate-draft", requireEditorOrAdmin, async (req, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const rows = await db.select().from(storiesTable).where(eq(storiesTable.id, id)).limit(1);
    const s = rows[0];
    if (!s) return res.status(404).json({ error: "Not found" });
    const byline = s.anonymous ? "Anonymous reader" : s.firstName ?? "Reader";
    const prompt = `You are drafting a short newsletter feature for the Stanford Lifestyle Medicine newsletter, based on a real reader's PACE story (Goal · Hook · Struggle · Enablement).

Reader's answers:
GOAL: ${s.goal ?? ""}
HOOK: ${s.hook ?? ""}
STRUGGLE: ${s.struggle ?? ""}
ENABLEMENT: ${s.enablement ?? ""}

Write a 150-250 word draft as four short paragraphs, one per PACE section, in the reader's own warm voice (third person, attributed to "${byline}"). Plain prose only, no headings, no markdown, no quotation marks around the whole piece. End with a single italic pull-quote sentence wrapped in <em>...</em>. Output HTML using only <p> and <em> tags.`;
    let html = "";
    try {
      const msg = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 800,
        messages: [{ role: "user", content: prompt }],
      });
      const part = msg.content.find((p: any) => p.type === "text") as { text?: string } | undefined;
      html = (part?.text ?? "").trim();
    } catch (e) {
      req.log.error({ err: e }, "draft generation failed");
      return res.status(502).json({ error: "AI draft failed" });
    }
    const [updated] = await db
      .update(storiesTable)
      .set({ draftHtml: html, status: s.status === "new" ? "in_edit" : s.status })
      .where(eq(storiesTable.id, id))
      .returning();
    return res.json({ story: updated });
  } catch (e) {
    req.log.error({ err: e }, "generate-draft failed");
    return res.status(500).json({ error: "Failed" });
  }
});

// Export bundle: HTML + Markdown + zipped images
function htmlToMarkdown(html: string): string {
  return html
    .replace(/<em>(.*?)<\/em>/gi, "_$1_")
    .replace(/<strong>(.*?)<\/strong>/gi, "**$1**")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
    .replace(/<p[^>]*>/gi, "")
    .replace(/<\/p>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .trim();
}

router.get("/stories/:id/export.html", requireEditorOrAdmin, async (req, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const rows = await db.select().from(storiesTable).where(eq(storiesTable.id, id)).limit(1);
    const s = rows[0];
    if (!s) return res.status(404).json({ error: "Not found" });
    const byline = s.anonymous ? "Anonymous reader" : s.firstName ?? "Reader";
    const body = s.draftHtml ?? `<p>${[s.goal, s.hook, s.struggle, s.enablement].filter(Boolean).join("</p><p>")}</p>`;
    const pull = s.pullQuote ? `<blockquote style="font-family:Georgia,serif;font-style:italic;font-size:20px;line-height:1.4;border-left:3px solid #8B1A1A;padding:8px 18px;margin:18px 0;color:#1a0505;">${s.pullQuote}</blockquote>` : "";
    const consentLine = s.consentTimestamp
      ? `<p style="font-size:11px;color:#666;margin-top:24px;">Reader gave consent to publish on ${s.consentTimestamp.toISOString().slice(0, 10)}.</p>`
      : "";
    const html = `<article style="font-family:Georgia,serif;max-width:640px;margin:0 auto;color:#1a0505;line-height:1.7;">
<h2 style="font-family:Georgia,serif;font-weight:500;font-size:28px;margin-bottom:6px;">A reader's sleep story</h2>
<p style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#8B1A1A;margin:0 0 18px;">By ${byline} · Stanford Lifestyle Medicine</p>
${pull}
${body}
${consentLine}
</article>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="story-${id}.html"`);
    return res.send(html);
  } catch (e) {
    req.log.error({ err: e }, "html export failed");
    return res.status(500).json({ error: "Failed" });
  }
});

router.get("/stories/:id/export.md", requireEditorOrAdmin, async (req, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const rows = await db.select().from(storiesTable).where(eq(storiesTable.id, id)).limit(1);
    const s = rows[0];
    if (!s) return res.status(404).json({ error: "Not found" });
    const byline = s.anonymous ? "Anonymous reader" : s.firstName ?? "Reader";
    const body = s.draftHtml
      ? htmlToMarkdown(s.draftHtml)
      : [s.goal, s.hook, s.struggle, s.enablement].filter(Boolean).join("\n\n");
    const pull = s.pullQuote ? `> _${s.pullQuote}_\n\n` : "";
    const consentLine = s.consentTimestamp
      ? `\n\n---\n\n_Reader gave consent to publish on ${s.consentTimestamp.toISOString().slice(0, 10)}._\n`
      : "";
    const md = `## A reader's sleep story\n\n*By ${byline} · Stanford Lifestyle Medicine*\n\n${pull}${body}${consentLine}\n`;
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="story-${id}.md"`);
    return res.send(md);
  } catch (e) {
    req.log.error({ err: e }, "md export failed");
    return res.status(500).json({ error: "Failed" });
  }
});

router.get("/stories/:id/images.zip", requireEditorOrAdmin, async (req, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const imgs = await db
      .select()
      .from(storyImagesTable)
      .where(eq(storyImagesTable.storyId, id))
      .orderBy(storyImagesTable.position);
    const { ObjectStorageService } = await import("../lib/objectStorage");
    const svc = new ObjectStorageService();
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="story-${id}-images.zip"`);
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (e: unknown) => {
      req.log.error({ err: e }, "zip error");
      try { res.status(500).end(); } catch {}
    });
    archive.pipe(res);
    for (const img of imgs) {
      try {
        const file = await svc.getObjectEntityFile(img.objectPath);
        const ext = (img.contentType?.split("/")[1] ?? "bin").replace(/[^a-z0-9]/gi, "") || "bin";
        const name = `${String(img.position + 1).padStart(2, "0")}-${img.originalName ?? "image"}.${ext}`;
        archive.append(file.createReadStream(), { name });
      } catch (e) {
        req.log.warn({ err: e, imgId: img.id }, "skipping missing image in zip");
      }
    }
    await archive.finalize();
  } catch (e) {
    req.log.error({ err: e }, "zip export failed");
    if (!res.headersSent) res.status(500).json({ error: "Failed" });
  }
});

// ── Invites ─────────────────────────────────────────────────────────────────

router.post("/stories-invites", requireEditorOrAdmin, async (req, res) => {
  try {
    const { email, contextNote } = req.body as { email?: string; contextNote?: string };
    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "Valid email required" });
    }
    const inviter = (req as any).editorIdentity ?? "editor";
    const token = randomBytes(20).toString("hex");
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const [inv] = await db
      .insert(storyInvitesTable)
      .values({
        token,
        email: email.toLowerCase(),
        inviterEmail: inviter,
        contextNote: contextNote ?? null,
        expiresAt,
      })
      .returning();
    await sendStoryInvite({ to: email, inviterEmail: inviter, contextNote, token });
    return res.json({ invite: inv });
  } catch (e) {
    req.log.error({ err: e }, "invite create failed");
    return res.status(500).json({ error: "Failed" });
  }
});

router.get("/stories-invites", requireEditorOrAdmin, async (_req, res) => {
  const rows = await db
    .select()
    .from(storyInvitesTable)
    .orderBy(desc(storyInvitesTable.createdAt));
  return res.json({ invites: rows });
});

export default router;
