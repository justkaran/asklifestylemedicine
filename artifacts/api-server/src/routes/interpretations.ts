import { Router, type IRouter, type Response, type NextFunction } from "express";
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  sourcesTable,
  sourceAuditLogTable,
  pillarsTable,
  facultyMembershipsTable,
  facultyUsersTable,
  interpretationsTable,
  interpretationVersionsTable,
  interpretationCommentsTable,
  interpretationChunksTable,
  rubricChecksTable,
  rubricCheckResultsTable,
  type Interpretation,
  type FacultyMembership,
} from "@workspace/db";
import {
  requireFacultyAuth,
  requirePillarRole,
  type FacultyRequest,
} from "../middlewares/facultyAuth.js";
import {
  RUBRIC_LAZY_BATCH,
  evaluateAndStoreDraft,
  rubricContentHash,
  type RubricCheckLine,
} from "../lib/rubricChecks.js";
import { chunkText } from "../lib/chunker.js";
import {
  embedTexts,
  toVectorLiteral,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
} from "../lib/embeddings.js";
import {
  AI_DRAFT_PREFIX,
  generateInterpretationDraft,
  fetchTopSourceChunks,
} from "../lib/draftInterpretation.js";
import { scoreDraftAcceptance } from "../lib/draftSimilarity.js";
import { sendCrossPillarCommentEmail } from "../lib/crossPillarEmail.js";
import {
  hasDraftableSourceMaterial,
  purgeUnlicensedSourceMaterialInTransaction,
} from "../lib/sourceRetention.js";

const router: IRouter = Router();

type Role = "steward" | "contributor" | "advisor" | "viewer";

interface ResolvedSource {
  source: typeof sourcesTable.$inferSelect;
  pillar: typeof pillarsTable.$inferSelect;
  role: Role | null;
  isAdmin: boolean;
}

async function resolveSource(
  req: FacultyRequest,
  sourceId: number,
): Promise<ResolvedSource | { error: string; status: number }> {
  const ctx = req.faculty!;
  const [source] = await db
    .select()
    .from(sourcesTable)
    .where(and(eq(sourcesTable.id, sourceId), eq(sourcesTable.isCanary, false)))
    .limit(1);
  if (!source) return { error: "Source not found", status: 404 };
  const [pillar] = await db
    .select()
    .from(pillarsTable)
    .where(eq(pillarsTable.id, source.pillarId))
    .limit(1);
  if (!pillar) return { error: "Pillar missing", status: 500 };
  const isAdmin = ctx.user.isPlatformAdmin === "true";
  const m = ctx.memberships.find(
    (x: FacultyMembership) => x.pillarId === pillar.id,
  );
  // Platform admins can READ across pillars (for oversight) but never
  // get steward authority by virtue of being admin — interpretation
  // governance is per-pillar membership only. So `role` reflects only
  // actual membership; the admin gets `null` if not a member, which
  // keeps every write/approval path correctly locked to membership.
  const role = (m?.role as Role) ?? null;
  if (!isAdmin && !m) {
    return { error: "Forbidden", status: 403 };
  }
  return { source, pillar, role, isAdmin };
}

async function resolveInterpretation(
  req: FacultyRequest,
  interpId: number,
): Promise<
  | (ResolvedSource & { interp: Interpretation })
  | { error: string; status: number }
> {
  const [interp] = await db
    .select()
    .from(interpretationsTable)
    .where(eq(interpretationsTable.id, interpId))
    .limit(1);
  if (!interp) return { error: "Interpretation not found", status: 404 };
  const r = await resolveSource(req, interp.sourceId);
  if ("error" in r) return r;
  return { ...r, interp };
}

interface DiscussionAccess {
  interp: Interpretation;
  source: typeof sourcesTable.$inferSelect;
  pillar: typeof pillarsTable.$inferSelect;
  membership: FacultyMembership | undefined;
  isAdmin: boolean;
  isCrossPillar: boolean;
  canPost: boolean;
}

/**
 * Resolve read/write access to an interpretation's DISCUSSION thread,
 * with cross-pillar rules layered on top of the in-pillar governance:
 *
 *   - Pillar member            → read; post unless role === 'viewer'.
 *   - Platform admin (non-mbr) → read across pillars; never post.
 *   - Steward of another pillar→ read + post ONLY on APPROVED items
 *                                (cross-pillar discussion). Owning pillar
 *                                steward gets notified on post.
 *   - Anyone else              → 403/404.
 *
 * Returning the full interp/source/pillar even when the caller is a
 * non-member is the key difference from `resolveInterpretation` (which
 * 403s before exposing the row): cross-pillar discussion needs the row.
 */
async function resolveDiscussionAccess(
  req: FacultyRequest,
  interpId: number,
): Promise<DiscussionAccess | { error: string; status: number }> {
  const ctx = req.faculty!;
  const [interp] = await db
    .select()
    .from(interpretationsTable)
    .where(eq(interpretationsTable.id, interpId))
    .limit(1);
  if (!interp) return { error: "Interpretation not found", status: 404 };
  const [source] = await db
    .select()
    .from(sourcesTable)
    .where(and(eq(sourcesTable.id, interp.sourceId), eq(sourcesTable.isCanary, false)))
    .limit(1);
  if (!source) return { error: "Source not found", status: 404 };
  const [pillar] = await db
    .select()
    .from(pillarsTable)
    .where(eq(pillarsTable.id, interp.pillarId))
    .limit(1);
  if (!pillar) return { error: "Pillar missing", status: 500 };

  const isAdmin = ctx.user.isPlatformAdmin === "true";
  const membership = ctx.memberships.find(
    (m: FacultyMembership) => m.pillarId === pillar.id,
  );

  if (membership) {
    return {
      interp,
      source,
      pillar,
      membership,
      isAdmin,
      isCrossPillar: false,
      canPost: membership.role !== "viewer",
    };
  }

  if (isAdmin) {
    // Oversight read across pillars, but admins never gain post authority
    // by virtue of being admin — matches the per-pillar governance rule.
    return {
      interp,
      source,
      pillar,
      membership: undefined,
      isAdmin,
      isCrossPillar: true,
      canPost: false,
    };
  }

  // Non-member, non-admin: cross-pillar access is gated to APPROVED items.
  if (interp.status !== "approved") {
    return { error: "Forbidden", status: 403 };
  }
  // Only people who actually steward content somewhere (a non-viewer
  // membership in any pillar) may open a cross-pillar discussion. A pure
  // viewer of other pillars stays read-only everywhere.
  const isStewardSomewhere = ctx.memberships.some(
    (m: FacultyMembership) => m.role !== "viewer",
  );
  return {
    interp,
    source,
    pillar,
    membership: undefined,
    isAdmin,
    isCrossPillar: true,
    canPost: isStewardSomewhere,
  };
}

/**
 * Look up the email/name of every STEWARD of a pillar (for cross-pillar
 * notifications). Excludes a given user id (don't notify yourself).
 */
async function pillarStewards(
  pillarId: number,
  excludeUserId: number,
): Promise<Array<{ email: string; fullName: string | null }>> {
  const rows = await db
    .select({
      email: facultyUsersTable.email,
      fullName: facultyUsersTable.fullName,
      userId: facultyUsersTable.id,
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
  return rows
    .filter((r) => r.userId !== excludeUserId && !!r.email)
    .map((r) => ({ email: r.email, fullName: r.fullName }));
}

const bodySchema = z.object({
  answer: z.string().min(1).max(2000),
  interpretation: z.string().min(1).max(20000),
  notProven: z.string().max(5000).optional().nullable(),
  action: z.string().max(2000).optional().nullable(),
  tags: z.array(z.string().min(1).max(80)).max(40).optional().default([]),
  aiDraft: z.string().max(20000).optional().nullable(),
});

const transitionSchema = z.object({
  status: z.enum(["proposed", "approved", "archived"]),
  note: z.string().max(2000).optional(),
});

async function nextVersion(
  tx: Pick<typeof db, "execute">,
  interpretationId: number,
  currentVersion: number,
): Promise<number> {
  const result = await tx.execute<{ maxV: number | null }>(sql`
    SELECT COALESCE(MAX(version), 0)::int AS "maxV"
    FROM interpretation_versions
    WHERE interpretation_id = ${interpretationId}
  `);
  const rows = (result as unknown as { rows: Array<{ maxV: number | null }> })
    .rows;
  const maxV = rows[0]?.maxV ?? 0;
  // First transition keeps the row at v1 (rows start at version=1);
  // every subsequent transition bumps from the highest known version.
  if (maxV === 0) return Math.max(currentVersion, 1);
  return Math.max(currentVersion, maxV) + 1;
}

const commentSchema = z.object({
  body: z.string().min(1).max(10000),
  quotedText: z.string().max(5000).optional().nullable(),
  parentCommentId: z.number().int().positive().optional().nullable(),
});

/**
 * Embed the approved interpretation body and persist into
 * `interpretation_chunks` with a higher priority than raw paper chunks
 * so the public retriever weights faculty voice above paper text.
 *
 * Strategy: drop any existing chunks for this interpretation and rebuild
 * from the just-approved body. This keeps version-N chunks live without
 * having to track per-chunk versioning.
 */
/**
 * Build the chunk-ready composite text for an interpretation body.
 * Pulled out so we can pre-compute embeddings before opening a DB
 * transaction (embedding calls the external embedding API and we don't
 * want a long-running HTTP request inside a Postgres transaction).
 */
function buildInterpretationChunks(interp: {
  answer: string;
  interpretation: string;
  notProven: string | null;
  action: string | null;
  tags: string[] | null;
}): string[] {
  const composite = [
    `ANSWER: ${interp.answer}`,
    `INTERPRETATION: ${interp.interpretation}`,
    interp.notProven ? `NOT PROVEN: ${interp.notProven}` : null,
    interp.action ? `ACTION: ${interp.action}` : null,
    interp.tags && interp.tags.length > 0
      ? `TAGS: ${interp.tags.join(", ")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");
  return chunkText(composite, { chunkTokens: 350, overlapTokens: 30 });
}

/**
 * GET /api/faculty/sources/:id/interpretations — list every interpretation
 * for a source. Any pillar member can read.
 */
router.get(
  "/faculty/sources/:id/interpretations",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response, _next?: NextFunction) => {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const r = await resolveSource(req, id);
    if ("error" in r) {
      res.status(r.status).json({ error: r.error });
      return;
    }
    const rows = await db
      .select({
        id: interpretationsTable.id,
        status: interpretationsTable.status,
        version: interpretationsTable.version,
        answer: interpretationsTable.answer,
        interpretation: interpretationsTable.interpretation,
        notProven: interpretationsTable.notProven,
        action: interpretationsTable.action,
        tags: interpretationsTable.tags,
        authorId: interpretationsTable.authorId,
        authorName: facultyUsersTable.fullName,
        authorEmail: facultyUsersTable.email,
        origin: interpretationsTable.origin,
        draftedAt: interpretationsTable.draftedAt,
        reviewedByUserId: interpretationsTable.reviewedByUserId,
        reviewedAt: interpretationsTable.reviewedAt,
        lastEditedByUserId: interpretationsTable.lastEditedByUserId,
        lastEditedAt: interpretationsTable.lastEditedAt,
        approvedAt: interpretationsTable.approvedAt,
        createdAt: interpretationsTable.createdAt,
        updatedAt: interpretationsTable.updatedAt,
      })
      .from(interpretationsTable)
      .leftJoin(
        facultyUsersTable,
        eq(facultyUsersTable.id, interpretationsTable.authorId),
      )
      .where(eq(interpretationsTable.sourceId, id))
      .orderBy(
        // Approved rows first (have a non-null approved_at), then
        // proposed/archived. NULLS LAST is required because Postgres
        // sorts NULLS FIRST by default with DESC, which would push
        // approved rows below the others. Then by recency within group.
        sql`${interpretationsTable.approvedAt} DESC NULLS LAST`,
        desc(interpretationsTable.updatedAt),
      );
    res.json({
      interpretations: rows,
      role: r.role,
      pillar: { id: r.pillar.id, slug: r.pillar.slug, name: r.pillar.name },
    });
  },
);

/**
 * POST /api/faculty/sources/:id/interpretations — create a proposed
 * interpretation. Contributors and stewards (in that pillar) can create.
 */
router.post(
  "/faculty/sources/:id/interpretations",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response, _next?: NextFunction) => {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const r = await resolveSource(req, id);
    if ("error" in r) {
      res.status(r.status).json({ error: r.error });
      return;
    }
    if (
      r.role !== "steward" &&
      r.role !== "contributor" &&
      r.role !== "advisor"
    ) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const body = parsed.data;
    const [created] = await db
      .insert(interpretationsTable)
      .values({
        sourceId: id,
        pillarId: r.pillar.id,
        authorId: req.faculty!.user.id,
        origin: "faculty",
        status: "proposed",
        answer: body.answer,
        interpretation: body.interpretation,
        notProven: body.notProven ?? null,
        action: body.action ?? null,
        tags: body.tags ?? [],
        aiDraft: body.aiDraft ?? null,
      })
      .returning();
    res.status(201).json(created);
  },
);

/**
 * PATCH /api/faculty/interpretations/:id — edit body fields. Only allowed
 * while status = `proposed`. Author or any steward in the pillar can edit.
 */
router.patch(
  "/faculty/interpretations/:id",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response, _next?: NextFunction) => {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const r = await resolveInterpretation(req, id);
    if ("error" in r) {
      res.status(r.status).json({ error: r.error });
      return;
    }
    if (r.interp.status !== "proposed") {
      res.status(409).json({
        error: `Cannot edit a ${r.interp.status} interpretation. Approved versions are immutable; create a new draft.`,
      });
      return;
    }
    const isAuthor = r.interp.authorId === req.faculty!.user.id;
    const isSteward = r.role === "steward";
    if (!isAuthor && !isSteward) {
      res.status(403).json({ error: "Only the author or a steward can edit" });
      return;
    }
    const parsed = bodySchema.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const updates = parsed.data;
    const [updated] = await db
      .update(interpretationsTable)
      .set({
        ...(updates.answer != null ? { answer: updates.answer } : {}),
        ...(updates.interpretation != null
          ? { interpretation: updates.interpretation }
          : {}),
        ...(updates.notProven !== undefined
          ? { notProven: updates.notProven ?? null }
          : {}),
        ...(updates.action !== undefined
          ? { action: updates.action ?? null }
          : {}),
        ...(updates.tags !== undefined ? { tags: updates.tags } : {}),
        ...(r.interp.origin === "palonur_ai"
          ? {
              reviewedByUserId: req.faculty!.user.id,
              reviewedAt: new Date(),
            }
          : {}),
        lastEditedByUserId: req.faculty!.user.id,
        lastEditedAt: new Date(),
      })
      .where(eq(interpretationsTable.id, id))
      .returning();
    if (r.interp.origin === "palonur_ai") {
      await db.insert(sourceAuditLogTable).values({
        sourceId: r.source.id,
        actorUserId: req.faculty!.user.id,
        action: "palonur_draft_reviewed",
        note: "Steward edited the private Palonur/AI first draft.",
      });
    }
    res.json(updated);
  },
);

/**
 * POST /api/faculty/interpretations/:id/redraft — re-run the AI draft
 * generator against the same source. Only allowed while status =
 * `proposed`. Author or any pillar steward/contributor can call this.
 *
 * Body (optional): { question?: string } — defaults to the
 * interpretation's current `answer` field (which was set to the
 * cluster's representative question on promote).
 *
 * Returns the new draft text — does NOT save it. The editor patches
 * the interpretation only after the steward accepts the draft.
 */
router.post(
  "/faculty/interpretations/:id/redraft",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response, _next?: NextFunction) => {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const r = await resolveInterpretation(req, id);
    if ("error" in r) {
      res.status(r.status).json({ error: r.error });
      return;
    }
    if (r.interp.status !== "proposed") {
      res.status(409).json({
        error: `Cannot redraft a ${r.interp.status} interpretation. Only proposed drafts can be regenerated.`,
      });
      return;
    }
    if (!hasDraftableSourceMaterial(r.source.retentionStatus)) {
      res.status(409).json({
        error:
          "Source passages are unavailable until a rights basis is recorded, or after rights-limited material has been purged.",
      });
      return;
    }
    // Mirror PATCH /interpretations/:id permissions: only the author
    // or a pillar steward can re-run the drafter. Keeps model usage
    // scoped to people who could actually save the result.
    const isAuthor = r.interp.authorId === req.faculty!.user.id;
    const isSteward = r.role === "steward";
    if (!isAuthor && !isSteward) {
      res.status(403).json({ error: "Only the author or a steward can redraft" });
      return;
    }
    const question =
      (req.body as { question?: unknown })?.question != null
        ? String((req.body as { question?: unknown }).question).trim()
        : r.interp.answer.trim();
    if (!question) {
      res.status(400).json({ error: "No question to draft from" });
      return;
    }
    try {
      const { draft, usedChunks, chunks } = await generateInterpretationDraft({
        sourceId: r.interp.sourceId,
        question,
        allowUnrecordedRights: true,
      });
      if (!draft) {
        res.status(422).json({
          error:
            "No source chunks matched the question. Add the source's text/PDF before drafting.",
        });
        return;
      }
      // Persist the new draft snapshot (banner stripped) so the
      // approval handler can score it against the final approved body
      // — even if the steward calls /redraft multiple times, we only
      // care about the most recent draft they were offered.
      const snapshot = draft.startsWith(AI_DRAFT_PREFIX)
        ? draft.slice(AI_DRAFT_PREFIX.length)
        : draft;
      await db
        .update(interpretationsTable)
        .set({ aiDraft: snapshot })
        .where(eq(interpretationsTable.id, id));
      res.json({ draft, usedChunks, chunks });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  },
);

/**
 * GET /api/faculty/interpretations/:id/source-chunks?question=...
 *
 * Return the top source-chunks (text + chunk_index) most similar to
 * the question, scoped to the interpretation's source. Powers the
 * editor's "passages this draft was built from" side panel so the
 * steward can fact-check sentence-by-sentence without re-reading the
 * paper.
 *
 * `question` defaults to the interpretation's `answer` field — i.e.
 * the same question the AI drafter was seeded with on promote — so
 * the chunks shown match the chunks Claude saw.
 *
 * Read-only; any pillar member (or platform admin) can call it.
 */
router.get(
  "/faculty/interpretations/:id/source-chunks",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response, _next?: NextFunction) => {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const r = await resolveInterpretation(req, id);
    if ("error" in r) {
      res.status(r.status).json({ error: r.error });
      return;
    }
    const qParam = (req.query as { question?: unknown })?.question;
    if (r.source.retentionStatus === "purged_no_full_text_rights") {
      res.status(410).json({
        error:
          "Review passages are no longer retained for this source under its rights setting.",
      });
      return;
    }
    const question =
      typeof qParam === "string" && qParam.trim().length > 0
        ? qParam.trim()
        : r.interp.answer.trim();
    if (!question) {
      res.json({ sourceId: r.interp.sourceId, question: "", chunks: [] });
      return;
    }
    try {
      const chunks = await fetchTopSourceChunks({
        sourceId: r.interp.sourceId,
        question,
        allowUnrecordedRights: true,
      });
      res.json({ sourceId: r.interp.sourceId, question, chunks });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  },
);

/**
 * POST /api/faculty/interpretations/:id/transition — move along the
 * lifecycle. Approval is **steward-only**, even platform admins cannot
 * approve in another pillar (governance promise from the spec).
 *
 * - `proposed → approved` (steward only): snapshots the body into
 *   `interpretation_versions`, sets approverId/approvedAt, embeds the
 *   body into `interpretation_chunks`.
 * - `approved → archived` (steward only): public agent stops using it.
 * - `proposed → archived` (steward or author): drop the draft.
 * - `archived → proposed` (steward): re-open for editing.
 */
router.post(
  "/faculty/interpretations/:id/transition",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response, _next?: NextFunction) => {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsed = transitionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const r = await resolveInterpretation(req, id);
    if ("error" in r) {
      res.status(r.status).json({ error: r.error });
      return;
    }
    const ctx = req.faculty!;
    const { status: to } = parsed.data;
    const from = r.interp.status;

    // Membership-based steward check (admin bypass intentionally NOT applied
    // for approval/archive — governance is per-pillar and only the pillar's
    // steward can decide what speaks in the public answer).
    const myMembership = ctx.memberships.find(
      (m: FacultyMembership) => m.pillarId === r.pillar.id,
    );
    const isPillarSteward = myMembership?.role === "steward";

    const isAuthor = r.interp.authorId === ctx.user.id;

    // Steward "send back" is special: it does NOT archive the row
    // (which would lock the contributor out of editing). Instead the
    // row stays `proposed`, an immutable `sent_back` version event is
    // recorded with the steward's note, and the contributor can keep
    // revising. The inbox filters the row out until the contributor
    // edits it again, at which point it returns to the steward's
    // queue. Author-initiated `proposed -> archived` is still a true
    // withdraw and remains an archive.
    const isSendBack =
      from === "proposed" && to === "archived" && isPillarSteward && !isAuthor;

    let allowed = false;
    if (from === to) allowed = true;
    else if (from === "proposed" && to === "approved") allowed = isPillarSteward;
    else if (from === "approved" && to === "archived") allowed = isPillarSteward;
    else if (from === "archived" && to === "proposed") allowed = isPillarSteward;
    else if (from === "proposed" && to === "archived")
      allowed = isPillarSteward || isAuthor;
    else if (from === "archived" && to === "approved") allowed = isPillarSteward;

    if (!allowed) {
      res.status(403).json({
        error: `Not permitted to move ${from} → ${to}`,
      });
      return;
    }
    if (from === to && !isSendBack) {
      res.json({ id: r.interp.id, status: from, unchanged: true });
      return;
    }

    const note = parsed.data.note ?? null;

    if (isSendBack) {
      // Send-back must include a reason — the whole point is for the
      // contributor to know what to fix. Enforced at the API level so
      // it's consistent across all clients (the inbox UI also blocks
      // submission, but we don't trust UI alone).
      if (!note || note.trim().length === 0) {
        res.status(400).json({
          error: "A note is required when sending an interpretation back.",
        });
        return;
      }
      // Record the send-back as an immutable version event but keep
      // status = proposed so the contributor can revise.
      const updated = await db.transaction(async (tx) => {
        const newVersion = await nextVersion(tx, r.interp.id, r.interp.version);
        const [u] = await tx
          .update(interpretationsTable)
          .set({ version: newVersion })
          .where(eq(interpretationsTable.id, r.interp.id))
          .returning();
        await tx.insert(interpretationVersionsTable).values({
          interpretationId: r.interp.id,
          version: newVersion,
          approverId: ctx.user.id,
          snapshot: {
            event: "sent_back",
            fromStatus: from,
            toStatus: "proposed",
            note,
            answer: r.interp.answer,
            interpretation: r.interp.interpretation,
            notProven: r.interp.notProven,
            action: r.interp.action,
            tags: r.interp.tags,
            authorId: r.interp.authorId,
            approverId: ctx.user.id,
            parentInterpretationId: r.interp.parentInterpretationId,
          },
        });
        return u;
      });
      res.json({
        id: updated.id,
        status: updated.status,
        version: updated.version,
        sentBack: true,
      });
      return;
    }

    if (to === "approved") {
      // Pre-compute embeddings BEFORE opening the transaction so the
      // external embedding API call doesn't run inside Postgres. If the
      // embedding fails, the approval never happens — no half-state
      // where the row is "approved" but missing from retrieval.
      const chunkTexts = buildInterpretationChunks(r.interp);
      let embeddings: number[][] = [];
      if (chunkTexts.length > 0) {
        try {
          embeddings = await embedTexts(chunkTexts);
        } catch (e) {
          req.log.error(
            { err: e, interpretationId: r.interp.id },
            "Embedding failed; refusing to approve interpretation",
          );
          res.status(503).json({
            error:
              "Could not embed the approved interpretation. Approval " +
              "rolled back; please retry shortly.",
          });
          return;
        }
      }

      // Approval is a true new immutable version: increment the row's
      // `version`, snapshot the body + transition metadata, demote any
      // prior approved row on the same source (and pull its chunks out
      // of the live retrieval index), link the new canonical row to
      // its predecessor via `parent_interpretation_id`, AND insert the
      // new retrieval chunks — all in one transaction.
      const { updated, demotedIds } = await db.transaction(async (tx) => {
        // 1. Find the predecessor (prior approved on same source).
        const priorApproved = await tx
          .select({ id: interpretationsTable.id })
          .from(interpretationsTable)
          .where(
            and(
              eq(interpretationsTable.sourceId, r.interp.sourceId),
              eq(interpretationsTable.status, "approved"),
            ),
          );
        const demotedIds = priorApproved
          .map((p) => p.id)
          .filter((pid) => pid !== r.interp.id);
        const parentId = demotedIds[0] ?? r.interp.parentInterpretationId ?? null;

        // 2. Demote prior approved rows AND give each its own
        // immutable version snapshot so the audit trail of the
        // demoted row records when, by whom, and why it was
        // superseded.
        const demotedRows = await tx
          .select()
          .from(interpretationsTable)
          .where(
            demotedIds.length > 0
              ? inArray(interpretationsTable.id, demotedIds)
              : sql`false`,
          );
        for (const drow of demotedRows) {
          const dNewVersion = await nextVersion(tx, drow.id, drow.version);
          await tx
            .update(interpretationsTable)
            .set({ status: "archived", version: dNewVersion })
            .where(eq(interpretationsTable.id, drow.id));
          await tx.insert(interpretationVersionsTable).values({
            interpretationId: drow.id,
            version: dNewVersion,
            approverId: ctx.user.id,
            snapshot: {
              event: "superseded",
              fromStatus: "approved",
              toStatus: "archived",
              note,
              answer: drow.answer,
              interpretation: drow.interpretation,
              notProven: drow.notProven,
              action: drow.action,
              tags: drow.tags,
              authorId: drow.authorId,
              approverId: ctx.user.id,
              parentInterpretationId: drow.parentInterpretationId,
              supersededByInterpretationId: r.interp.id,
            },
          });
        }

        // 3. Compute next version (monotonic across the row's life).
        const newVersion = await nextVersion(tx, r.interp.id, r.interp.version);

        // 4. Score how much of the AI draft survived into the
        // approved body. `r.interp.aiDraft` is the most recent draft
        // the steward saw (set on /promote, overwritten on /redraft);
        // null means they wrote it by hand. Persisted on the row so
        // the dashboard can aggregate without re-walking history.
        const { similarity, acceptance } = scoreDraftAcceptance(
          r.interp.aiDraft,
          r.interp.interpretation,
        );

        // 5. Promote this row to approved with new version + parent link.
        const [u] = await tx
          .update(interpretationsTable)
          .set({
            status: "approved",
            version: newVersion,
            parentInterpretationId: parentId,
            approverId: ctx.user.id,
            approvedAt: new Date(),
            reviewedByUserId:
              r.interp.reviewedByUserId ?? ctx.user.id,
            reviewedAt: r.interp.reviewedAt ?? new Date(),
            aiDraftSimilarity: similarity,
            aiDraftAcceptance: acceptance,
          })
          .where(eq(interpretationsTable.id, r.interp.id))
          .returning();

        // 6. Snapshot the new immutable version with transition metadata.
        await tx.insert(interpretationVersionsTable).values({
          interpretationId: r.interp.id,
          version: newVersion,
          approverId: ctx.user.id,
          snapshot: {
            event: "approved",
            fromStatus: from,
            toStatus: to,
            note,
            answer: r.interp.answer,
            interpretation: r.interp.interpretation,
            notProven: r.interp.notProven,
            action: r.interp.action,
            tags: r.interp.tags,
            authorId: r.interp.authorId,
            approverId: ctx.user.id,
            parentInterpretationId: parentId,
            supersededIds: demotedIds,
          },
        });
        await tx.insert(sourceAuditLogTable).values({
          sourceId: r.source.id,
          actorUserId: ctx.user.id,
          action: "interpretation_approved",
          note:
            r.interp.origin === "palonur_ai"
              ? "Steward reviewed and approved a Palonur/AI-created first draft."
              : "Steward approved an interpretation.",
        });

        // 6. Pull demoted interpretations out of the live retrieval
        // index so only the new canonical row contributes to public
        // answers. Done inside the transaction so it rolls back with
        // everything else if anything fails.
        for (const pid of demotedIds) {
          await tx
            .delete(interpretationChunksTable)
            .where(eq(interpretationChunksTable.interpretationId, pid));
        }

        // 7. Replace this interpretation's own chunks with the new
        // pre-computed embeddings. If chunk insertion fails, the whole
        // approval is rolled back.
        await tx
          .delete(interpretationChunksTable)
          .where(eq(interpretationChunksTable.interpretationId, r.interp.id));
        for (let i = 0; i < chunkTexts.length; i++) {
          const lit = toVectorLiteral(embeddings[i]);
          await tx.execute(sql`
            INSERT INTO interpretation_chunks
              (interpretation_id, source_id, pillar_id, chunk_index, text,
               embedding, embedding_model, priority)
            VALUES (
              ${r.interp.id}, ${r.interp.sourceId}, ${r.interp.pillarId},
              ${i}, ${chunkTexts[i]}, ${lit}::halfvec(${sql.raw(String(EMBEDDING_DIMENSIONS))}),
              ${EMBEDDING_MODEL}, 100
            )
          `);
        }

        // 8. Talk-crawl pipeline: a `talk` source is ingested as
        // `draft` and is deliberately NOT made citable until a human steward
        // approves its auto-drafted interpretation. Retrieval (lib/rag.ts)
        // gates BOTH source_chunks AND interpretation_chunks on the source
        // being `approved`, so approving the interpretation alone wouldn't
        // surface the talk. Here — and ONLY here, as part of the single human
        // approval — we promote the linked unapproved talk source to
        // `approved` so the talk becomes citable. Non-talk sources keep their
        // existing two-step (source-approve + interpretation-approve) flow.
        if (r.source.kind === "talk" && r.source.status !== "approved") {
          // The talk path is a source-approval shortcut, not an exception to
          // source rights. Check and finalize it inside this same transaction
          // as the interpretation approval so raw transcript text can never
          // become public between the two operations.
          const [currentSource] = await tx
            .select()
            .from(sourcesTable)
            .where(eq(sourcesTable.id, r.source.id))
            .limit(1);
          if (!currentSource?.rightsBasis) {
            throw new Error(
              "Cannot approve a talk without a recorded full-text rights basis.",
            );
          }
          await tx
            .update(sourcesTable)
            .set({ status: "approved" })
            .where(eq(sourcesTable.id, r.source.id));
          await tx.insert(sourceAuditLogTable).values({
            sourceId: r.source.id,
            actorUserId: ctx.user.id,
            action: "approved",
            fromStatus: r.source.status,
            toStatus: "approved",
            note: "Approved with its crawl-drafted interpretation",
          });
          if (
            currentSource.rightsBasis ===
            "no_documented_full_text_rights"
          ) {
            await purgeUnlicensedSourceMaterialInTransaction(tx, {
              sourceId: currentSource.id,
              actorUserId: ctx.user.id,
              reason: "source_approved",
            });
          }
        }

        return { updated: u, demotedIds };
      });

      res.json({
        id: updated.id,
        status: updated.status,
        version: updated.version,
        chunks: chunkTexts.length,
      });
      return;
    }

    if (to === "archived") {
      const updated = await db.transaction(async (tx) => {
        const newVersion = await nextVersion(tx, r.interp.id, r.interp.version);
        const [u] = await tx
          .update(interpretationsTable)
          .set({ status: "archived", version: newVersion })
          .where(eq(interpretationsTable.id, id))
          .returning();
        await tx.insert(interpretationVersionsTable).values({
          interpretationId: r.interp.id,
          version: newVersion,
          approverId: ctx.user.id,
          snapshot: {
            event: from === "approved" ? "retracted" : "sent_back",
            fromStatus: from,
            toStatus: to,
            note,
            answer: r.interp.answer,
            interpretation: r.interp.interpretation,
            notProven: r.interp.notProven,
            action: r.interp.action,
            tags: r.interp.tags,
            authorId: r.interp.authorId,
          },
        });
        // Pull retracted interpretations out of the live retrieval
        // index in the SAME transaction as the status flip so the row
        // is never archived-but-still-indexed (spec: "public agent
        // stops using it immediately").
        await tx
          .delete(interpretationChunksTable)
          .where(eq(interpretationChunksTable.interpretationId, id));
        return u;
      });
      res.json({ id: updated.id, status: updated.status, version: updated.version });
      return;
    }

    // proposed (re-open from archive) — strip approval metadata and
    // record the reopen event so the audit chain is unbroken.
    const reopened = await db.transaction(async (tx) => {
      const newVersion = await nextVersion(tx, r.interp.id, r.interp.version);
      const [u] = await tx
        .update(interpretationsTable)
        .set({
          status: "proposed",
          version: newVersion,
          approverId: null,
          approvedAt: null,
        })
        .where(eq(interpretationsTable.id, id))
        .returning();
      await tx.insert(interpretationVersionsTable).values({
        interpretationId: r.interp.id,
        version: newVersion,
        approverId: ctx.user.id,
        snapshot: {
          event: "reopened",
          fromStatus: from,
          toStatus: to,
          note,
          answer: r.interp.answer,
          interpretation: r.interp.interpretation,
          notProven: r.interp.notProven,
          action: r.interp.action,
          tags: r.interp.tags,
          authorId: r.interp.authorId,
        },
      });
      return u;
    });
    res.json({ id: reopened.id, status: reopened.status, version: reopened.version });
  },
);

/**
 * GET /api/faculty/interpretations/:id/versions — full audit history.
 */
router.get(
  "/faculty/interpretations/:id/versions",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response, _next?: NextFunction) => {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const r = await resolveInterpretation(req, id);
    if ("error" in r) {
      res.status(r.status).json({ error: r.error });
      return;
    }
    const versions = await db
      .select()
      .from(interpretationVersionsTable)
      .where(eq(interpretationVersionsTable.interpretationId, id))
      .orderBy(desc(interpretationVersionsTable.version));
    res.json({ versions });
  },
);

/**
 * GET /api/faculty/interpretations/:id/comments — discussion thread.
 */
router.get(
  "/faculty/interpretations/:id/comments",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response, _next?: NextFunction) => {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const access = await resolveDiscussionAccess(req, id);
    if ("error" in access) {
      res.status(access.status).json({ error: access.error });
      return;
    }
    const rows = await db
      .select({
        id: interpretationCommentsTable.id,
        body: interpretationCommentsTable.body,
        quotedText: interpretationCommentsTable.quotedText,
        parentCommentId: interpretationCommentsTable.parentCommentId,
        authorId: interpretationCommentsTable.authorId,
        authorName: facultyUsersTable.fullName,
        authorEmail: facultyUsersTable.email,
        createdAt: interpretationCommentsTable.createdAt,
      })
      .from(interpretationCommentsTable)
      .leftJoin(
        facultyUsersTable,
        eq(facultyUsersTable.id, interpretationCommentsTable.authorId),
      )
      .where(eq(interpretationCommentsTable.interpretationId, id))
      .orderBy(asc(interpretationCommentsTable.createdAt));
    res.json({ comments: rows });
  },
);

/**
 * POST /api/faculty/interpretations/:id/comments — add a threaded
 * comment, optionally with a quoted snippet from the source text.
 */
router.post(
  "/faculty/interpretations/:id/comments",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response, _next?: NextFunction) => {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const access = await resolveDiscussionAccess(req, id);
    if ("error" in access) {
      res.status(access.status).json({ error: access.error });
      return;
    }
    // Posting is gated by `canPost`: in-pillar members (non-viewer) post
    // normally; a steward of another pillar may post on APPROVED items
    // (cross-pillar discussion); admins and viewers stay read-only.
    if (!access.canPost) {
      res.status(403).json({
        error: access.isCrossPillar
          ? "Only stewards can join a cross-pillar discussion, and only on approved interpretations."
          : "Only pillar members can post comments in this discussion.",
      });
      return;
    }
    const parsed = commentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const data = parsed.data;
    // Ensure parent comment (if any) belongs to the same interpretation —
    // prevents threading a reply onto an unrelated discussion.
    if (data.parentCommentId != null) {
      const [parent] = await db
        .select({ interpretationId: interpretationCommentsTable.interpretationId })
        .from(interpretationCommentsTable)
        .where(eq(interpretationCommentsTable.id, data.parentCommentId))
        .limit(1);
      if (!parent || parent.interpretationId !== id) {
        res.status(400).json({
          error: "parentCommentId does not belong to this interpretation",
        });
        return;
      }
    }
    const [created] = await db
      .insert(interpretationCommentsTable)
      .values({
        interpretationId: id,
        authorId: req.faculty!.user.id,
        body: data.body,
        quotedText: data.quotedText ?? null,
        parentCommentId: data.parentCommentId ?? null,
      })
      .returning();

    // Cross-pillar discussion: notify the owning pillar's steward(s) so a
    // comment from outside their pillar doesn't go unseen. Best-effort —
    // never blocks or fails the request.
    if (access.isCrossPillar) {
      try {
        const commenterPillar = req.faculty!.memberships.find(
          (m: FacultyMembership) => m.role !== "viewer",
        );
        let commenterPillarName: string | null = null;
        if (commenterPillar) {
          const [cp] = await db
            .select({ name: pillarsTable.name })
            .from(pillarsTable)
            .where(eq(pillarsTable.id, commenterPillar.pillarId))
            .limit(1);
          commenterPillarName = cp?.name ?? null;
        }
        const owners = await pillarStewards(
          access.pillar.id,
          req.faculty!.user.id,
        );
        for (const owner of owners) {
          await sendCrossPillarCommentEmail({
            to: owner.email,
            ownerName: owner.fullName,
            commenterName: req.faculty!.user.fullName,
            commenterPillarName,
            interpretationAnswer: access.interp.answer,
            commentBody: data.body,
          });
        }
      } catch (e) {
        req.log.warn(
          { err: e, interpretationId: id },
          "cross-pillar comment notification failed",
        );
      }
    }
    res.status(201).json(created);
  },
);

/**
 * GET /api/faculty/pillars/:slug/inbox — steward review queue.
 *
 * Lists every `proposed` interpretation across the steward's pillar's
 * sources, oldest first, so the longest-waiting items get attention.
 */
router.get(
  "/faculty/pillars/:slug/inbox",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response, _next?: NextFunction) => {
    const ctx = req.faculty!;
    const slug = String(req.params.slug);
    const [pillar] = await db
      .select()
      .from(pillarsTable)
      .where(eq(pillarsTable.slug, slug));
    if (!pillar) {
      res.status(404).json({ error: "Pillar not found" });
      return;
    }
    const m = ctx.memberships.find(
      (x: FacultyMembership) => x.pillarId === pillar.id,
    );
    const isPillarSteward = m?.role === "steward";
    const isAdmin = ctx.user.isPlatformAdmin === "true";
    // Platform admins get read-only oversight across pillars (matches
    // the resolveSource pattern at the top of this file). They still
    // cannot approve, edit, or redraft — those paths remain locked to
    // the pillar's steward by design.
    if (!isPillarSteward && !isAdmin) {
      res.status(403).json({ error: "Steward only" });
      return;
    }
    // Filter out items that the steward already sent back AND the
    // contributor hasn't revised since (so the inbox doesn't keep
    // showing items waiting on the author). The subquery finds the
    // latest sent_back event per interpretation; we exclude rows where
    // updatedAt has not advanced past it.
    const lastSentBack = db
      .select({
        interpretationId: interpretationVersionsTable.interpretationId,
        lastSentBackAt: sql<Date>`MAX(${interpretationVersionsTable.approvedAt})`.as(
          "last_sent_back_at",
        ),
      })
      .from(interpretationVersionsTable)
      .where(sql`${interpretationVersionsTable.snapshot}->>'event' = 'sent_back'`)
      .groupBy(interpretationVersionsTable.interpretationId)
      .as("last_sent_back");

    const rows = await db
      .select({
        id: interpretationsTable.id,
        sourceId: interpretationsTable.sourceId,
        sourceTitle: sourcesTable.title,
        sourceAuthors: sourcesTable.authors,
        sourceYear: sourcesTable.year,
        answer: interpretationsTable.answer,
        version: interpretationsTable.version,
        authorId: interpretationsTable.authorId,
        authorName: facultyUsersTable.fullName,
        authorEmail: facultyUsersTable.email,
        createdAt: interpretationsTable.createdAt,
        updatedAt: interpretationsTable.updatedAt,
      })
      .from(interpretationsTable)
      .innerJoin(
        sourcesTable,
        eq(sourcesTable.id, interpretationsTable.sourceId),
      )
      .leftJoin(
        facultyUsersTable,
        eq(facultyUsersTable.id, interpretationsTable.authorId),
      )
      .leftJoin(
        lastSentBack,
        eq(lastSentBack.interpretationId, interpretationsTable.id),
      )
      .where(
        and(
          eq(interpretationsTable.pillarId, pillar.id),
          eq(interpretationsTable.status, "proposed"),
          or(
            isNull(lastSentBack.lastSentBackAt),
            gt(interpretationsTable.updatedAt, lastSentBack.lastSentBackAt),
          ),
        ),
      )
      .orderBy(asc(interpretationsTable.createdAt));

    // ── Advisory rubric checks (observe-only) ────────────────────────
    // Score each pending draft against the pillar's steward-authored
    // rubric checks. Results are cached per (check, draft, content
    // hash); up to RUBRIC_LAZY_BATCH stale/missing drafts are lazily
    // evaluated per read, best-effort — a scoring failure never fails
    // the inbox, and verdicts never gate the approval workflow.
    const checks = await db
      .select()
      .from(rubricChecksTable)
      .where(eq(rubricChecksTable.pillarId, pillar.id))
      .orderBy(asc(rubricChecksTable.createdAt));

    type RubricEntry = {
      checkId: number;
      name: string;
      verdict: "pass" | "flag" | "pending";
      rationale: string | null;
    };
    const rubricByInterp = new Map<number, RubricEntry[]>();

    if (checks.length > 0 && rows.length > 0) {
      const drafts = await db
        .select({
          id: interpretationsTable.id,
          answer: interpretationsTable.answer,
          interpretation: interpretationsTable.interpretation,
          notProven: interpretationsTable.notProven,
          action: interpretationsTable.action,
        })
        .from(interpretationsTable)
        .where(
          inArray(
            interpretationsTable.id,
            rows.map((r) => r.id),
          ),
        );
      const draftById = new Map(drafts.map((d) => [d.id, d]));

      const results = await db
        .select()
        .from(rubricCheckResultsTable)
        .where(
          inArray(
            rubricCheckResultsTable.interpretationId,
            rows.map((r) => r.id),
          ),
        );
      const resultKey = (interpId: number, checkId: number) =>
        `${interpId}:${checkId}`;
      const resultMap = new Map(
        results.map((r) => [resultKey(r.interpretationId, r.checkId), r]),
      );

      const checkLines: RubricCheckLine[] = checks.map((c) => ({
        id: c.id,
        name: c.name,
        instruction: c.instruction,
      }));

      // Which drafts still need (re-)evaluation? Missing rows or rows
      // whose content hash no longer matches the current draft/check.
      const staleIds: number[] = [];
      for (const r of rows) {
        const draft = draftById.get(r.id);
        if (!draft) continue;
        const stale = checks.some((c) => {
          const existing = resultMap.get(resultKey(r.id, c.id));
          return (
            !existing ||
            existing.contentHash !== rubricContentHash(draft, c)
          );
        });
        if (stale) staleIds.push(r.id);
      }

      for (const interpId of staleIds.slice(0, RUBRIC_LAZY_BATCH)) {
        const draft = draftById.get(interpId)!;
        const row = rows.find((r) => r.id === interpId)!;
        try {
          const stored = await evaluateAndStoreDraft(
            {
              interpretationId: interpId,
              answer: draft.answer,
              interpretation: draft.interpretation,
              notProven: draft.notProven,
              action: draft.action,
              sourceTitle: row.sourceTitle,
            },
            checkLines,
          );
          if (stored) {
            const fresh = await db
              .select()
              .from(rubricCheckResultsTable)
              .where(eq(rubricCheckResultsTable.interpretationId, interpId));
            for (const fr of fresh) {
              resultMap.set(resultKey(fr.interpretationId, fr.checkId), fr);
            }
          }
        } catch (e) {
          req.log.warn(
            { err: e, interpretationId: interpId },
            "rubric check evaluation failed (observe-only, ignored)",
          );
        }
      }

      for (const r of rows) {
        const draft = draftById.get(r.id);
        rubricByInterp.set(
          r.id,
          checks.map((c) => {
            const existing = resultMap.get(resultKey(r.id, c.id));
            const current =
              draft &&
              existing &&
              existing.contentHash === rubricContentHash(draft, c);
            return {
              checkId: c.id,
              name: c.name,
              verdict: current
                ? (existing.verdict as "pass" | "flag")
                : "pending",
              rationale: current ? existing.rationale : null,
            };
          }),
        );
      }
    }

    res.json({
      pillar: { id: pillar.id, slug: pillar.slug, name: pillar.name },
      checks: checks.map((c) => ({
        id: c.id,
        name: c.name,
        instruction: c.instruction,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      })),
      pending: rows.map((r) => ({
        ...r,
        rubric: rubricByInterp.get(r.id) ?? [],
      })),
    });
  },
);

// ── Steward rubric checks: per-pillar CRUD ───────────────────────────
//
// Named, steward-editable review criteria ("always state the study's age
// range"). Advisory only: they surface as pass/flag badges on the review
// queue and never touch the approval workflow. `requirePillarRole` locks
// writes to the pillar's steward (platform admins pass through, matching
// the rest of pillar administration).

const rubricCheckSchema = z.object({
  name: z.string().trim().min(1).max(120),
  instruction: z.string().trim().min(1).max(1000),
});

router.get(
  "/faculty/pillars/:slug/rubric-checks",
  requireFacultyAuth,
  requirePillarRole({ slugParam: "slug" }, [
    "steward",
    "contributor",
    "advisor",
    "viewer",
  ]),
  async (req: FacultyRequest, res: Response) => {
    const pillar = req.pillar!;
    const checks = await db
      .select()
      .from(rubricChecksTable)
      .where(eq(rubricChecksTable.pillarId, pillar.id))
      .orderBy(asc(rubricChecksTable.createdAt));
    res.json({ checks });
  },
);

router.post(
  "/faculty/pillars/:slug/rubric-checks",
  requireFacultyAuth,
  requirePillarRole({ slugParam: "slug" }, ["steward"]),
  async (req: FacultyRequest, res: Response) => {
    const parsed = rubricCheckSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "name and instruction are required" });
      return;
    }
    const pillar = req.pillar!;
    const [created] = await db
      .insert(rubricChecksTable)
      .values({
        pillarId: pillar.id,
        name: parsed.data.name,
        instruction: parsed.data.instruction,
        createdById: req.faculty!.user.id,
      })
      .returning();
    res.status(201).json({ check: created });
  },
);

router.patch(
  "/faculty/pillars/:slug/rubric-checks/:id",
  requireFacultyAuth,
  requirePillarRole({ slugParam: "slug" }, ["steward"]),
  async (req: FacultyRequest, res: Response) => {
    const checkId = parseInt(String(req.params.id), 10);
    if (Number.isNaN(checkId)) {
      res.status(400).json({ error: "Invalid check id" });
      return;
    }
    const parsed = rubricCheckSchema.partial().safeParse(req.body);
    if (
      !parsed.success ||
      (parsed.data.name === undefined && parsed.data.instruction === undefined)
    ) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }
    const pillar = req.pillar!;
    const [updated] = await db
      .update(rubricChecksTable)
      .set(parsed.data)
      .where(
        and(
          eq(rubricChecksTable.id, checkId),
          eq(rubricChecksTable.pillarId, pillar.id),
        ),
      )
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Check not found" });
      return;
    }
    // Editing the instruction invalidates cached verdicts implicitly via
    // the content hash — no explicit cleanup needed. (A pure rename keeps
    // verdicts, which is correct: the criterion didn't change.)
    res.json({ check: updated });
  },
);

router.delete(
  "/faculty/pillars/:slug/rubric-checks/:id",
  requireFacultyAuth,
  requirePillarRole({ slugParam: "slug" }, ["steward"]),
  async (req: FacultyRequest, res: Response) => {
    const checkId = parseInt(String(req.params.id), 10);
    if (Number.isNaN(checkId)) {
      res.status(400).json({ error: "Invalid check id" });
      return;
    }
    const pillar = req.pillar!;
    const [deleted] = await db
      .delete(rubricChecksTable)
      .where(
        and(
          eq(rubricChecksTable.id, checkId),
          eq(rubricChecksTable.pillarId, pillar.id),
        ),
      )
      .returning({ id: rubricChecksTable.id });
    if (!deleted) {
      res.status(404).json({ error: "Check not found" });
      return;
    }
    res.json({ ok: true });
  },
);

export default router;

/**
 * Helper exported for the cron digest job — gather every steward's
 * pending review queue across all pillars they steward.
 */
export interface StewardDigestPending {
  id: number;
  sourceId: number;
  sourceTitle: string;
  answer: string;
  authorEmail: string | null;
  authorName: string | null;
  createdAt: Date;
}
export interface StewardDigestPillar {
  id: number;
  slug: string;
  name: string;
  pending: StewardDigestPending[];
}
export interface StewardDigest {
  user: { id: number; email: string; fullName: string | null };
  pillars: StewardDigestPillar[];
}

export async function collectStewardDigests(): Promise<StewardDigest[]> {
  const stewardships = await db
    .select({
      userId: facultyMembershipsTable.userId,
      userEmail: facultyUsersTable.email,
      userFullName: facultyUsersTable.fullName,
      pillarId: pillarsTable.id,
      pillarSlug: pillarsTable.slug,
      pillarName: pillarsTable.name,
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
    .where(eq(facultyMembershipsTable.role, "steward"));

  const byUser = new Map<number, StewardDigest>();

  for (const s of stewardships) {
    // Same "sent back but not yet revised" exclusion as the live
    // inbox so the email doesn't nag stewards about items currently
    // waiting on the contributor.
    const lastSentBack = db
      .select({
        interpretationId: interpretationVersionsTable.interpretationId,
        lastSentBackAt: sql<Date>`MAX(${interpretationVersionsTable.approvedAt})`.as(
          "last_sent_back_at",
        ),
      })
      .from(interpretationVersionsTable)
      .where(sql`${interpretationVersionsTable.snapshot}->>'event' = 'sent_back'`)
      .groupBy(interpretationVersionsTable.interpretationId)
      .as("last_sent_back");
    const pending = await db
      .select({
        id: interpretationsTable.id,
        sourceId: interpretationsTable.sourceId,
        sourceTitle: sourcesTable.title,
        answer: interpretationsTable.answer,
        createdAt: interpretationsTable.createdAt,
        authorEmail: facultyUsersTable.email,
        authorName: facultyUsersTable.fullName,
      })
      .from(interpretationsTable)
      .innerJoin(
        sourcesTable,
        eq(sourcesTable.id, interpretationsTable.sourceId),
      )
      .leftJoin(
        facultyUsersTable,
        eq(facultyUsersTable.id, interpretationsTable.authorId),
      )
      .leftJoin(
        lastSentBack,
        eq(lastSentBack.interpretationId, interpretationsTable.id),
      )
      .where(
        and(
          eq(interpretationsTable.pillarId, s.pillarId),
          eq(interpretationsTable.status, "proposed"),
          or(
            isNull(lastSentBack.lastSentBackAt),
            gt(interpretationsTable.updatedAt, lastSentBack.lastSentBackAt),
          ),
        ),
      )
      .orderBy(asc(interpretationsTable.createdAt));

    if (pending.length === 0) continue;
    let entry = byUser.get(s.userId);
    if (!entry) {
      entry = {
        user: {
          id: s.userId,
          email: s.userEmail,
          fullName: s.userFullName,
        },
        pillars: [],
      };
      byUser.set(s.userId, entry);
    }
    entry.pillars.push({
      id: s.pillarId,
      slug: s.pillarSlug,
      name: s.pillarName,
      pending,
    });
  }
  return Array.from(byUser.values());
}
