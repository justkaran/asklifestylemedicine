/**
 * Decision Room — chat-built Amazon-style six-page decision memos.
 *
 * The platform admin drafts a memo through a chat with Pal (section-by-
 * section interview → prose pages), can check the memo's claims against the
 * governed science corpus (supported / contradicted / not covered, with real
 * citations only — never invented support), and shares the memo with
 * selected faculty members who get read + per-page-comment access.
 *
 * Everything here is admin/faculty-only (Clerk faculty auth); nothing is
 * exposed on public surfaces. Prompt security follows the agent-route
 * conventions: memo text and chat history are UNTRUSTED — fenced, sanitized,
 * and covered by UNTRUSTED_CONTEXT_RULE.
 */
import { Router, type IRouter, type Response } from "express";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import {
  db,
  decisionMemosTable,
  decisionMemoSharesTable,
  decisionMemoCommentsTable,
  facultyUsersTable,
  pillarsTable,
  type DecisionMemo,
} from "@workspace/db";
import {
  requireFacultyAuth,
  isHiddenFacultyEmail,
  type FacultyRequest,
} from "../middlewares/facultyAuth.js";
import {
  retrieve,
  sanitizeUntrustedText,
  CONTEXT_FENCE_OPEN,
  CONTEXT_FENCE_CLOSE,
  UNTRUSTED_CONTEXT_RULE,
  type RetrievedChunk,
} from "../lib/rag.js";
import { RAG_MIN_SCORE } from "../lib/ragThreshold.js";

const router: IRouter = Router();

const anthropic = new Anthropic({
  baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
});

const PAGE_TITLES: Record<number, string> = {
  1: "Decision & recommendation (incl. headline expected impact and the principal risk)",
  2: "Context (why now, what changed, the window)",
  3: "Proposal details",
  4: "Top risks with specific mitigations",
  5: "Numbers & sensitivity (the model, the 2-3 variables most likely wrong, rollout metrics with pause thresholds)",
  6: "Implementation plan, impact on the people involved, and the explicit ask",
};

// ── Access helpers ──────────────────────────────────────────────────────────

function isAdmin(req: FacultyRequest): boolean {
  return req.faculty!.user.isPlatformAdmin === "true";
}

/**
 * Load a memo and the caller's access level, or null when the caller may not
 * see it. `edit` = owner or platform admin; `read` = shared member.
 */
async function loadMemoAccess(
  req: FacultyRequest,
  memoId: number,
): Promise<{ memo: DecisionMemo; canEdit: boolean } | null> {
  const [memo] = await db
    .select()
    .from(decisionMemosTable)
    .where(eq(decisionMemosTable.id, memoId));
  if (!memo) return null;
  const userId = req.faculty!.user.id;
  const canEdit = memo.ownerId === userId || isAdmin(req);
  if (canEdit) return { memo, canEdit: true };
  const [share] = await db
    .select({ id: decisionMemoSharesTable.id })
    .from(decisionMemoSharesTable)
    .where(
      and(
        eq(decisionMemoSharesTable.memoId, memoId),
        eq(decisionMemoSharesTable.userId, userId),
      ),
    );
  if (!share) return null;
  return { memo, canEdit: false };
}

function serializeMemo(memo: DecisionMemo, canEdit: boolean) {
  return {
    id: memo.id,
    title: memo.title,
    topic: memo.topic,
    status: memo.status,
    decidedOutcome: memo.decidedOutcome,
    decidedAt: memo.decidedAt,
    pages: [memo.page1, memo.page2, memo.page3, memo.page4, memo.page5, memo.page6],
    scienceCheck: memo.scienceCheck ?? null,
    scienceCheckedAt: memo.scienceCheckedAt,
    scienceCheckPassed:
      memo.scienceCheckPassed == null ? null : memo.scienceCheckPassed === "true",
    createdAt: memo.createdAt,
    updatedAt: memo.updatedAt,
    canEdit,
  };
}

// ── Library list ────────────────────────────────────────────────────────────

/**
 * GET /api/faculty/decision-room/memos?q=
 * Every memo the viewer can see: owned, shared-with-them, or (admin) all.
 */
router.get(
  "/faculty/decision-room/memos",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response): Promise<void> => {
    const userId = req.faculty!.user.id;
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

    const visibility = isAdmin(req)
      ? undefined
      : or(
          eq(decisionMemosTable.ownerId, userId),
          sql`EXISTS (SELECT 1 FROM decision_memo_shares s
                WHERE s.memo_id = ${decisionMemosTable.id} AND s.user_id = ${userId})`,
        );
    const search =
      q.length > 0
        ? or(
            ilike(decisionMemosTable.title, `%${q}%`),
            ilike(decisionMemosTable.topic, `%${q}%`),
          )
        : undefined;

    const where =
      visibility && search
        ? and(visibility, search)
        : (visibility ?? search);

    const rows = await db
      .select({
        memo: decisionMemosTable,
        ownerName: facultyUsersTable.fullName,
        ownerEmail: facultyUsersTable.email,
      })
      .from(decisionMemosTable)
      .innerJoin(
        facultyUsersTable,
        eq(facultyUsersTable.id, decisionMemosTable.ownerId),
      )
      .where(where)
      .orderBy(desc(decisionMemosTable.updatedAt));

    res.json({
      memos: rows.map((r) => ({
        id: r.memo.id,
        title: r.memo.title,
        topic: r.memo.topic,
        status: r.memo.status,
        owner: r.ownerName || r.ownerEmail,
        decidedAt: r.memo.decidedAt,
        decidedOutcome: r.memo.decidedOutcome,
        scienceCheckPassed:
          r.memo.scienceCheckPassed == null
            ? null
            : r.memo.scienceCheckPassed === "true",
        updatedAt: r.memo.updatedAt,
      })),
    });
  },
);

// ── CRUD ────────────────────────────────────────────────────────────────────

const createSchema = z.object({
  title: z.string().trim().min(1).max(300),
  topic: z.string().trim().max(300).optional(),
});

/** POST /api/faculty/decision-room/memos — platform-admin only. */
router.post(
  "/faculty/decision-room/memos",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response): Promise<void> => {
    if (!isAdmin(req)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const [memo] = await db
      .insert(decisionMemosTable)
      .values({
        ownerId: req.faculty!.user.id,
        title: parsed.data.title,
        topic: parsed.data.topic ?? "",
      })
      .returning();
    res.json({ memo: serializeMemo(memo, true) });
  },
);

/** GET /api/faculty/decision-room/memos/:id */
router.get(
  "/faculty/decision-room/memos/:id",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response): Promise<void> => {
    const memoId = Number(req.params.id);
    if (!Number.isInteger(memoId)) {
      res.status(400).json({ error: "Invalid memo id" });
      return;
    }
    const access = await loadMemoAccess(req, memoId);
    if (!access) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ memo: serializeMemo(access.memo, access.canEdit) });
  },
);

const updateSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  topic: z.string().trim().max(300).optional(),
  pages: z.array(z.string().max(40_000)).length(6).optional(),
});

/** PATCH /api/faculty/decision-room/memos/:id — owner/admin only. */
router.patch(
  "/faculty/decision-room/memos/:id",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response): Promise<void> => {
    const memoId = Number(req.params.id);
    const access = Number.isInteger(memoId)
      ? await loadMemoAccess(req, memoId)
      : null;
    if (!access) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!access.canEdit) {
      res.status(403).json({ error: "Read-only access" });
      return;
    }
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const set: Partial<typeof decisionMemosTable.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (parsed.data.title !== undefined) set.title = parsed.data.title;
    if (parsed.data.topic !== undefined) set.topic = parsed.data.topic;
    if (parsed.data.pages) {
      const [p1, p2, p3, p4, p5, p6] = parsed.data.pages;
      Object.assign(set, {
        page1: p1,
        page2: p2,
        page3: p3,
        page4: p4,
        page5: p5,
        page6: p6,
      });
      // Page content is changing — any prior science check no longer applies
      // to the new text. Clear it so a stale "passed" verdict can never be
      // presented against unreviewed content; a fresh check must be run.
      const current = [
        access.memo.page1,
        access.memo.page2,
        access.memo.page3,
        access.memo.page4,
        access.memo.page5,
        access.memo.page6,
      ];
      const changed = parsed.data.pages.some((p, i) => p !== current[i]);
      if (changed) {
        Object.assign(set, {
          scienceCheck: null,
          scienceCheckedAt: null,
          scienceCheckPassed: null,
        });
      }
    }
    const [memo] = await db
      .update(decisionMemosTable)
      .set(set)
      .where(eq(decisionMemosTable.id, memoId))
      .returning();
    res.json({ memo: serializeMemo(memo, true) });
  },
);

/** DELETE /api/faculty/decision-room/memos/:id — owner/admin only. */
router.delete(
  "/faculty/decision-room/memos/:id",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response): Promise<void> => {
    const memoId = Number(req.params.id);
    const access = Number.isInteger(memoId)
      ? await loadMemoAccess(req, memoId)
      : null;
    if (!access) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!access.canEdit) {
      res.status(403).json({ error: "Read-only access" });
      return;
    }
    await db.delete(decisionMemosTable).where(eq(decisionMemosTable.id, memoId));
    res.json({ ok: true });
  },
);

// ── Lifecycle ───────────────────────────────────────────────────────────────

const statusSchema = z.object({
  status: z.enum(["draft", "shared", "decided"]),
  decidedOutcome: z.string().trim().max(4000).optional(),
});

/** POST /api/faculty/decision-room/memos/:id/status — owner/admin only. */
router.post(
  "/faculty/decision-room/memos/:id/status",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response): Promise<void> => {
    const memoId = Number(req.params.id);
    const access = Number.isInteger(memoId)
      ? await loadMemoAccess(req, memoId)
      : null;
    if (!access) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!access.canEdit) {
      res.status(403).json({ error: "Read-only access" });
      return;
    }
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { status, decidedOutcome } = parsed.data;
    if (status === "decided" && !decidedOutcome?.trim()) {
      res
        .status(400)
        .json({ error: "Recording a decision requires the outcome." });
      return;
    }
    const [memo] = await db
      .update(decisionMemosTable)
      .set({
        status,
        decidedOutcome: status === "decided" ? decidedOutcome!.trim() : null,
        decidedAt: status === "decided" ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(decisionMemosTable.id, memoId))
      .returning();
    res.json({ memo: serializeMemo(memo, true) });
  },
);

// ── Sharing ─────────────────────────────────────────────────────────────────

/**
 * GET /api/faculty/decision-room/members — owner-facing picker of active
 * faculty accounts a memo can be shared with (platform-admin only, since only
 * admins own memos). Hidden/demo accounts excluded.
 */
router.get(
  "/faculty/decision-room/members",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response): Promise<void> => {
    if (!isAdmin(req)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const rows = await db
      .select({
        id: facultyUsersTable.id,
        fullName: facultyUsersTable.fullName,
        email: facultyUsersTable.email,
      })
      .from(facultyUsersTable)
      .where(
        and(
          isNull(facultyUsersTable.deactivatedAt),
          isNull(facultyUsersTable.archivedAt),
        ),
      );
    res.json({
      members: rows
        .filter((r) => !isHiddenFacultyEmail(r.email) || r.id === req.faculty!.user.id)
        .filter((r) => r.id !== req.faculty!.user.id)
        .map((r) => ({ id: r.id, name: r.fullName || r.email, email: r.email })),
    });
  },
);

/** GET /api/faculty/decision-room/memos/:id/shares */
router.get(
  "/faculty/decision-room/memos/:id/shares",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response): Promise<void> => {
    const memoId = Number(req.params.id);
    const access = Number.isInteger(memoId)
      ? await loadMemoAccess(req, memoId)
      : null;
    if (!access) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const rows = await db
      .select({
        userId: decisionMemoSharesTable.userId,
        name: facultyUsersTable.fullName,
        email: facultyUsersTable.email,
      })
      .from(decisionMemoSharesTable)
      .innerJoin(
        facultyUsersTable,
        eq(facultyUsersTable.id, decisionMemoSharesTable.userId),
      )
      .where(eq(decisionMemoSharesTable.memoId, memoId));
    res.json({
      shares: rows.map((r) => ({
        userId: r.userId,
        name: r.name || r.email,
        email: r.email,
      })),
    });
  },
);

const sharesSchema = z.object({
  userIds: z.array(z.number().int().positive()).max(200),
});

/**
 * PUT /api/faculty/decision-room/memos/:id/shares — owner/admin only.
 * Replaces the share list. Shared members get read + comment access only.
 */
router.put(
  "/faculty/decision-room/memos/:id/shares",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response): Promise<void> => {
    const memoId = Number(req.params.id);
    const access = Number.isInteger(memoId)
      ? await loadMemoAccess(req, memoId)
      : null;
    if (!access) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!access.canEdit) {
      res.status(403).json({ error: "Read-only access" });
      return;
    }
    const parsed = sharesSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const wanted = [...new Set(parsed.data.userIds)].filter(
      (id) => id !== access.memo.ownerId,
    );
    // Validate targets are real, active faculty accounts.
    const valid =
      wanted.length > 0
        ? await db
            .select({ id: facultyUsersTable.id })
            .from(facultyUsersTable)
            .where(
              and(
                inArray(facultyUsersTable.id, wanted),
                isNull(facultyUsersTable.deactivatedAt),
              ),
            )
        : [];
    const validIds = valid.map((v) => v.id);
    await db
      .delete(decisionMemoSharesTable)
      .where(eq(decisionMemoSharesTable.memoId, memoId));
    if (validIds.length > 0) {
      await db
        .insert(decisionMemoSharesTable)
        .values(validIds.map((userId) => ({ memoId, userId })))
        .onConflictDoNothing();
    }
    // A draft that gains shares becomes "shared" automatically (never
    // regresses a decided memo).
    if (validIds.length > 0 && access.memo.status === "draft") {
      await db
        .update(decisionMemosTable)
        .set({ status: "shared", updatedAt: new Date() })
        .where(eq(decisionMemosTable.id, memoId));
    }
    res.json({ ok: true, sharedWith: validIds });
  },
);

// ── Comments ────────────────────────────────────────────────────────────────

/** GET /api/faculty/decision-room/memos/:id/comments */
router.get(
  "/faculty/decision-room/memos/:id/comments",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response): Promise<void> => {
    const memoId = Number(req.params.id);
    const access = Number.isInteger(memoId)
      ? await loadMemoAccess(req, memoId)
      : null;
    if (!access) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const rows = await db
      .select({
        id: decisionMemoCommentsTable.id,
        page: decisionMemoCommentsTable.page,
        body: decisionMemoCommentsTable.body,
        createdAt: decisionMemoCommentsTable.createdAt,
        authorName: facultyUsersTable.fullName,
        authorEmail: facultyUsersTable.email,
      })
      .from(decisionMemoCommentsTable)
      .innerJoin(
        facultyUsersTable,
        eq(facultyUsersTable.id, decisionMemoCommentsTable.authorId),
      )
      .where(eq(decisionMemoCommentsTable.memoId, memoId))
      .orderBy(decisionMemoCommentsTable.createdAt);
    res.json({
      comments: rows.map((r) => ({
        id: r.id,
        page: r.page,
        body: r.body,
        author: r.authorName || r.authorEmail,
        createdAt: r.createdAt,
      })),
    });
  },
);

const commentSchema = z.object({
  page: z.number().int().min(1).max(6),
  body: z.string().trim().min(1).max(8000),
});

/** POST /api/faculty/decision-room/memos/:id/comments — anyone with access. */
router.post(
  "/faculty/decision-room/memos/:id/comments",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response): Promise<void> => {
    const memoId = Number(req.params.id);
    const access = Number.isInteger(memoId)
      ? await loadMemoAccess(req, memoId)
      : null;
    if (!access) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const parsed = commentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const [comment] = await db
      .insert(decisionMemoCommentsTable)
      .values({
        memoId,
        page: parsed.data.page,
        authorId: req.faculty!.user.id,
        body: parsed.data.body,
      })
      .returning();
    res.json({
      comment: {
        id: comment.id,
        page: comment.page,
        body: comment.body,
        author:
          req.faculty!.user.fullName || req.faculty!.user.email,
        createdAt: comment.createdAt,
      },
    });
  },
);

// ── Chat-guided drafting ────────────────────────────────────────────────────

function fenceMemoPages(memo: DecisionMemo): string {
  const pages = [memo.page1, memo.page2, memo.page3, memo.page4, memo.page5, memo.page6];
  const lines: string[] = [];
  for (let i = 0; i < 6; i++) {
    lines.push(`PAGE ${i + 1} — ${PAGE_TITLES[i + 1]}:`);
    lines.push(CONTEXT_FENCE_OPEN);
    lines.push(pages[i].trim() ? sanitizeUntrustedText(pages[i]) : "(empty)");
    lines.push(CONTEXT_FENCE_CLOSE);
  }
  return lines.join("\n");
}

function buildDraftingSystemPrompt(memo: DecisionMemo): string {
  return `You are Pal, a decision-memo coach inside the Palonur faculty portal. You help the author turn a decision into an Amazon-style six-page memo. Each page is PROSE (full paragraphs), never bullet lists.

The six pages:
${Object.entries(PAGE_TITLES)
  .map(([n, t]) => `${n}. ${t}`)
  .join("\n")}

HOW TO WORK:
- Interview the author section by section: ask ONE focused question at a time about the next section that lacks material. Be concise and specific.
- Once you have enough material for a section (or the author asks you to draft), write that page's prose. When the author asks for a full draft and you have material for the whole memo, draft all six pages.
- When the author asks you to revise a specific page, rewrite just that page.
- Page 5 numbers are AUTHOR-ENTERED: you help structure the model, the 2-3 variables most likely wrong, and rollout metrics with pause thresholds — never invent figures the author did not give you. Use placeholders like [X%] when a number is missing and ask for it.
- Do not use em dashes. Use a comma, colon, or period instead.

OUTPUT FORMAT (HARD RULES): respond with ONLY a JSON object, no markdown fences, of the shape:
{"reply": "<your short chat message to the author>", "pages": {"1": "<full new prose for page 1>", ...}}
Include a page number key in "pages" ONLY when you are drafting or revising that page, and always include that page's COMPLETE new text (it replaces the page). When you are only asking a question, "pages" must be an empty object.

CURRENT MEMO (title: ${sanitizeUntrustedText(memo.title).slice(0, 300)}):
${fenceMemoPages(memo)}

${UNTRUSTED_CONTEXT_RULE}`;
}

const chatSchema = z.object({
  message: z.string().trim().min(1).max(8000),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      }),
    )
    .optional(),
});

/**
 * POST /api/faculty/decision-room/memos/:id/chat — owner/admin only.
 * Returns { reply, pages } where pages maps "1".."6" to full replacement
 * prose. The server applies page updates to the memo and returns the fresh
 * memo alongside.
 */
router.post(
  "/faculty/decision-room/memos/:id/chat",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response): Promise<void> => {
    const memoId = Number(req.params.id);
    const access = Number.isInteger(memoId)
      ? await loadMemoAccess(req, memoId)
      : null;
    if (!access) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!access.canEdit) {
      res.status(403).json({ error: "Read-only access" });
      return;
    }
    if (!process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY) {
      res.status(503).json({ error: "AI drafting is not configured" });
      return;
    }
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    // History is client-supplied and UNTRUSTED: bound, sanitize, cap.
    const boundedHistory = (parsed.data.history ?? [])
      .filter((m) => m.content.trim().length > 0)
      .slice(-12)
      .map((m) => ({
        role: m.role,
        content: sanitizeUntrustedText(m.content).slice(0, 6000),
      }));

    try {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: buildDraftingSystemPrompt(access.memo),
        messages: [
          ...boundedHistory,
          { role: "user" as const, content: parsed.data.message },
        ],
      });
      const raw = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      let reply = "";
      let pageUpdates: Record<string, string> = {};
      try {
        const jsonStart = raw.indexOf("{");
        const jsonEnd = raw.lastIndexOf("}");
        const parsedJson = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)) as {
          reply?: unknown;
          pages?: unknown;
        };
        reply = typeof parsedJson.reply === "string" ? parsedJson.reply : "";
        if (parsedJson.pages && typeof parsedJson.pages === "object") {
          for (const [k, v] of Object.entries(
            parsedJson.pages as Record<string, unknown>,
          )) {
            const n = Number(k);
            if (Number.isInteger(n) && n >= 1 && n <= 6 && typeof v === "string") {
              pageUpdates[String(n)] = v.slice(0, 40_000);
            }
          }
        }
      } catch {
        // Model ignored the JSON contract: treat the whole text as the reply.
        reply = raw;
        pageUpdates = {};
      }
      if (!reply.trim() && Object.keys(pageUpdates).length === 0) {
        res.status(502).json({ error: "Drafting failed, try again" });
        return;
      }

      let memo = access.memo;
      if (Object.keys(pageUpdates).length > 0) {
        const set: Partial<typeof decisionMemosTable.$inferInsert> = {
          updatedAt: new Date(),
        };
        const cols = ["page1", "page2", "page3", "page4", "page5", "page6"] as const;
        let changed = false;
        for (const [k, v] of Object.entries(pageUpdates)) {
          const col = cols[Number(k) - 1];
          set[col] = v;
          if (access.memo[col] !== v) changed = true;
        }
        // Chat rewrote page content — invalidate any prior science check so a
        // stale "passed" verdict is never shown against unreviewed prose.
        if (changed) {
          set.scienceCheck = null;
          set.scienceCheckedAt = null;
          set.scienceCheckPassed = null;
        }
        const [updated] = await db
          .update(decisionMemosTable)
          .set(set)
          .where(eq(decisionMemosTable.id, memoId))
          .returning();
        memo = updated;
      }
      res.json({
        reply,
        updatedPages: Object.keys(pageUpdates).map(Number).sort(),
        memo: serializeMemo(memo, true),
      });
    } catch (err) {
      req.log?.error?.({ err }, "decision-room chat failed");
      res.status(502).json({ error: "Drafting failed, try again" });
    }
  },
);

// ── Science check ───────────────────────────────────────────────────────────

interface ScienceClaim {
  page: number;
  claim: string;
}

export interface ScienceVerdict {
  page: number;
  claim: string;
  verdict: "supported" | "contradicted" | "not_covered";
  citation: {
    sourceId: number;
    title: string;
    authors: string | null;
    year: number | null;
    journal: string | null;
    doi: string | null;
  } | null;
  note: string;
}

const MAX_CLAIMS = 12;

async function extractClaims(memo: DecisionMemo): Promise<ScienceClaim[]> {
  const system = `You extract CHECKABLE SCIENTIFIC CLAIMS from a business decision memo. A checkable scientific claim asserts something about health, behavior, biology, psychology, or research findings that could be verified against a scientific corpus (e.g. "morning light exposure advances circadian phase"). Business projections, pricing, internal plans, and opinions are NOT scientific claims.

OUTPUT FORMAT (HARD RULES): only a JSON array, no markdown fences:
[{"page": <1-6>, "claim": "<the claim in one sentence>"}]
At most ${MAX_CLAIMS} claims. Return [] if there are none.

MEMO:
${fenceMemoPages(memo)}

${UNTRUSTED_CONTEXT_RULE}`;
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    system,
    messages: [{ role: "user", content: "Extract the checkable scientific claims." }],
  });
  const raw = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end < 0) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(
      (c): c is { page: number; claim: string } =>
        !!c &&
        typeof c === "object" &&
        Number.isInteger((c as { page?: unknown }).page) &&
        (c as { page: number }).page >= 1 &&
        (c as { page: number }).page <= 6 &&
        typeof (c as { claim?: unknown }).claim === "string" &&
        (c as { claim: string }).claim.trim().length > 0,
    )
    .slice(0, MAX_CLAIMS)
    .map((c) => ({ page: c.page, claim: c.claim.trim().slice(0, 600) }));
}

function citationFromChunk(c: RetrievedChunk) {
  return {
    sourceId: c.sourceId,
    title: c.sourceTitle,
    authors: c.sourceAuthors,
    year: c.sourceYear,
    journal: c.sourceJournal,
    doi: c.sourceDoi,
  };
}

/**
 * Judge one claim against its retrieved governed context. The verdict's
 * citation is ALWAYS taken from the retrieved chunk set (never model-invented):
 * the model may only reference source_ids that appear in the fenced context,
 * and any unmatched id downgrades the verdict to not_covered — the same
 * honesty rule as the agents' citation guard.
 */
async function judgeClaim(
  claim: ScienceClaim,
  chunks: RetrievedChunk[],
): Promise<ScienceVerdict> {
  const contextLines: string[] = [];
  for (const c of chunks) {
    contextLines.push(
      `[source_id=${c.sourceId}] ${sanitizeUntrustedText(
        [c.sourceAuthors, c.sourceYear ? `(${c.sourceYear})` : null, c.sourceTitle]
          .filter(Boolean)
          .join(" "),
      ).slice(0, 300)}`,
    );
    contextLines.push(CONTEXT_FENCE_OPEN);
    contextLines.push(sanitizeUntrustedText(c.text.trim()));
    contextLines.push(CONTEXT_FENCE_CLOSE);
  }
  const system = `You verify ONE claim against approved research excerpts.

Verdicts:
- "supported": the excerpts clearly support the claim. You MUST name the supporting source_id from the excerpts.
- "contradicted": the excerpts clearly contradict the claim. You MUST name the contradicting source_id.
- "not_covered": the excerpts neither clearly support nor clearly contradict the claim. Use this whenever in doubt. NEVER stretch loosely-related material into support.

OUTPUT FORMAT (HARD RULES): only a JSON object, no markdown fences:
{"verdict": "supported"|"contradicted"|"not_covered", "sourceId": <number or null>, "note": "<one sentence why>"}

EXCERPTS:
${contextLines.join("\n")}

${UNTRUSTED_CONTEXT_RULE}`;
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 512,
    system,
    messages: [{ role: "user", content: `CLAIM: ${sanitizeUntrustedText(claim.claim)}` }],
  });
  const raw = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  let verdict: ScienceVerdict["verdict"] = "not_covered";
  let sourceId: number | null = null;
  let note = "";
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    const parsed = JSON.parse(raw.slice(start, end + 1)) as {
      verdict?: unknown;
      sourceId?: unknown;
      note?: unknown;
    };
    if (
      parsed.verdict === "supported" ||
      parsed.verdict === "contradicted" ||
      parsed.verdict === "not_covered"
    ) {
      verdict = parsed.verdict;
    }
    if (typeof parsed.sourceId === "number") sourceId = parsed.sourceId;
    if (typeof parsed.note === "string") note = parsed.note.slice(0, 500);
  } catch {
    // Unparseable → honest not_covered below.
  }

  // Citation guard: supported/contradicted verdicts must cite a source that
  // was actually retrieved. A missing or unmatched id means the model could
  // not ground the verdict — downgrade to not_covered, never invent support.
  let citation: ScienceVerdict["citation"] = null;
  if (verdict !== "not_covered") {
    const match = sourceId != null ? chunks.find((c) => c.sourceId === sourceId) : undefined;
    if (!match) {
      verdict = "not_covered";
      note = "Could not verify against an approved source.";
    } else {
      citation = citationFromChunk(match);
    }
  }
  return { page: claim.page, claim: claim.claim, verdict, citation, note };
}

/**
 * POST /api/faculty/decision-room/memos/:id/science-check — owner/admin only.
 * Extracts the memo's checkable scientific claims and verifies each against
 * the approved corpus across all active pillars. Results stored on the memo.
 */
router.post(
  "/faculty/decision-room/memos/:id/science-check",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response): Promise<void> => {
    const memoId = Number(req.params.id);
    const access = Number.isInteger(memoId)
      ? await loadMemoAccess(req, memoId)
      : null;
    if (!access) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!access.canEdit) {
      res.status(403).json({ error: "Read-only access" });
      return;
    }
    if (!process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY) {
      res.status(503).json({ error: "AI checking is not configured" });
      return;
    }
    try {
      const claims = await extractClaims(access.memo);

      // Retrieve against every active (non-retired) pillar's approved corpus.
      const pillars = await db
        .select({ id: pillarsTable.id })
        .from(pillarsTable)
        .where(isNull(pillarsTable.retiredAt));
      const pillarIds = pillars.map((p) => p.id);

      const results: ScienceVerdict[] = [];
      for (const claim of claims) {
        if (pillarIds.length === 0) {
          results.push({
            page: claim.page,
            claim: claim.claim,
            verdict: "not_covered",
            citation: null,
            note: "No approved corpus available.",
          });
          continue;
        }
        const retrieval = await retrieve({
          question: claim.claim,
          pillarIds,
          k: 6,
        });
        if (retrieval.chunks.length === 0 || retrieval.topScore < RAG_MIN_SCORE) {
          results.push({
            page: claim.page,
            claim: claim.claim,
            verdict: "not_covered",
            citation: null,
            note: "The approved corpus does not cover this claim.",
          });
          continue;
        }
        results.push(await judgeClaim(claim, retrieval.chunks));
      }

      const passed = results.every((r) => r.verdict !== "contradicted");
      const [memo] = await db
        .update(decisionMemosTable)
        .set({
          scienceCheck: results,
          scienceCheckedAt: new Date(),
          scienceCheckPassed: passed ? "true" : "false",
          updatedAt: new Date(),
        })
        .where(eq(decisionMemosTable.id, memoId))
        .returning();
      res.json({ memo: serializeMemo(memo, true), results, passed });
    } catch (err) {
      req.log?.error?.({ err }, "decision-room science check failed");
      res.status(502).json({ error: "Science check failed, try again" });
    }
  },
);

export default router;
