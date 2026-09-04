/**
 * Palonur Decision Room — legacy decision workspace.
 *
 * Security fixes (task #845 follow-up):
 *   - ALL routes now require requireFacultyAuth + Decision Room access guard
 *     (platform admin OR faculty user with at least one membership).
 *   - List/summary/detail/mutation/consult are restricted to legacy statuses
 *     only (framing|consulting|deciding|decided).  Any record with a CVO
 *     release status (draft|in_review|ready|published|withdrawn) returns 404
 *     so the legacy router cannot enumerate or mutate new governance records.
 *   - Protocol-step writes (POST/PATCH/DELETE /decision-room/steps) are
 *     restricted to platform-admin (CVO) only.
 *   - Pillars and Steps reads (GET) now also require auth.
 *
 * The new mode-scoped CVO release endpoints live in cvoReleases.ts and are
 * unaffected by this router.
 */

import { Router, type IRouter } from "express";
import { asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  decisionsTable,
  decisionConsultationsTable,
  decisionAiStepsTable,
  pillarsTable,
} from "@workspace/db";
import {
  CreateDecisionBody,
  UpdateDecisionBody,
  ConsultPillarsBody,
  CreateAiStepBody,
  UpdateAiStepBody,
} from "@workspace/api-zod";
import {
  requireFacultyAuth,
  type FacultyRequest,
} from "../middlewares/facultyAuth.js";
import { governedAnswer } from "../lib/governedAnswer.js";
import { collapseSameWorkProvenance } from "../lib/rag.js";

const router: IRouter = Router();

/**
 * Statuses that belong to the legacy decision workspace.
 * CVO release governance statuses (draft|in_review|ready|published|withdrawn)
 * must NEVER be served or mutated by this router.
 */
const LEGACY_STATUSES = new Set([
  "framing",
  "consulting",
  "deciding",
  "decided",
]);

/**
 * Decision Room access guard: platform admins OR faculty with at least one
 * membership.  Rejects outsiders (users with no memberships) with 403.
 */
function hasDecisionRoomAccess(req: FacultyRequest): boolean {
  const { user, memberships } = req.faculty!;
  if (user.isPlatformAdmin === "true") return true;
  return memberships.length > 0;
}

/**
 * Canonical pillars offered in the Decision Room. The dev DB is flooded with
 * generated test pillars ("ask-pillar-*", "fw-booker-*", ...), so listing must
 * be allowlist-based, not "everything active". New real pillars must be added
 * here to appear.
 */
const DECISION_ROOM_PILLAR_SLUGS = [
  "sleep",
  "stress-management",
  "nutrition",
  "movement",
  "social-connection",
  "cognitive-enhancement",
  "gratitude-purpose",
  "empathy",
  "slm-ai-lab",
  "dementia",
  "autism",
] as const;

type Citation = {
  title: string;
  authors?: string | null;
  year?: number | null;
  sourceUrl?: string | null;
};

function serializeDecisionSummaryRow(row: {
  id: number;
  title: string;
  question: string;
  status: string;
  consultationCount: number;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    title: row.title,
    question: row.question,
    status: row.status,
    consultationCount: Number(row.consultationCount),
    decidedAt: row.decidedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function serializeDecisionDetail(decisionId: number) {
  const [decision] = await db
    .select()
    .from(decisionsTable)
    .where(eq(decisionsTable.id, decisionId))
    .limit(1);
  if (!decision) return null;
  // Refuse to expose CVO release governance records via the legacy router
  if (!LEGACY_STATUSES.has(decision.status)) return null;
  const consultations = await db
    .select()
    .from(decisionConsultationsTable)
    .where(eq(decisionConsultationsTable.decisionId, decisionId))
    .orderBy(desc(decisionConsultationsTable.createdAt));
  return {
    id: decision.id,
    title: decision.title,
    question: decision.question,
    context: decision.context,
    ownView: decision.ownView,
    finalCall: decision.finalCall,
    outcome: decision.outcome,
    status: decision.status,
    checkedStepIds: Array.isArray(decision.checkedStepIds)
      ? (decision.checkedStepIds as number[])
      : [],
    decidedAt: decision.decidedAt,
    consultations: consultations.map((c) => ({
      id: c.id,
      pillarSlug: c.pillarSlug,
      pillarName: c.pillarName,
      status: c.status,
      answerText: c.answerText,
      citations: (c.citations ?? []) as Citation[],
      createdAt: c.createdAt,
    })),
    createdAt: decision.createdAt,
    updatedAt: decision.updatedAt,
  };
}

async function listLegacyDecisionRows() {
  return db
    .select({
      id: decisionsTable.id,
      title: decisionsTable.title,
      question: decisionsTable.question,
      status: decisionsTable.status,
      consultationCount: sql<number>`(
        SELECT COUNT(*)::int FROM decision_room_consultations c
        WHERE c.decision_id = ${decisionsTable.id}
      )`,
      decidedAt: decisionsTable.decidedAt,
      createdAt: decisionsTable.createdAt,
      updatedAt: decisionsTable.updatedAt,
    })
    .from(decisionsTable)
    .where(
      sql`${decisionsTable.status} IN ('framing', 'consulting', 'deciding', 'decided')`,
    )
    .orderBy(desc(decisionsTable.updatedAt));
}

/**
 * GET /decision-room/pillars — active pillars offered for consultation.
 * Now requires Decision Room access.
 */
router.get(
  "/decision-room/pillars",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!hasDecisionRoomAccess(req)) {
      res.status(403).json({ error: "no_decision_room_access" });
      return;
    }
    const rows = await db
      .select({
        slug: pillarsTable.slug,
        name: pillarsTable.name,
        description: pillarsTable.description,
        available: sql<boolean>`EXISTS (
          SELECT 1 FROM interpretation_chunks ic
          JOIN interpretations i ON i.id = ic.interpretation_id
          WHERE i.pillar_id = pillars.id AND i.status = 'approved'
        )`,
      })
      .from(pillarsTable)
      .where(
        sql`${pillarsTable.retiredAt} IS NULL AND ${pillarsTable.slug} IN ${sql.raw(
          `(${DECISION_ROOM_PILLAR_SLUGS.map((s) => `'${s}'`).join(", ")})`,
        )}`,
      )
      .orderBy(asc(pillarsTable.name));
    res.json({
      pillars: rows.map((r) => ({
        slug: r.slug,
        name: r.name,
        description: r.description,
        stewardName: null,
        available: Boolean(r.available),
      })),
    });
  },
);

/**
 * GET /decision-room/summary — dashboard counts for legacy decisions only.
 * Now requires Decision Room access.
 */
router.get(
  "/decision-room/summary",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!hasDecisionRoomAccess(req)) {
      res.status(403).json({ error: "no_decision_room_access" });
      return;
    }
    const rows = await listLegacyDecisionRows();
    const byStatus = { framing: 0, consulting: 0, deciding: 0, decided: 0 };
    for (const r of rows) {
      if (r.status in byStatus) {
        byStatus[r.status as keyof typeof byStatus] += 1;
      }
    }
    res.json({
      total: rows.length,
      byStatus,
      recent: rows.slice(0, 5).map(serializeDecisionSummaryRow),
    });
  },
);

/**
 * GET /decision-room/decisions — newest-first legacy decisions only.
 * Now requires Decision Room access.
 */
router.get(
  "/decision-room/decisions",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!hasDecisionRoomAccess(req)) {
      res.status(403).json({ error: "no_decision_room_access" });
      return;
    }
    const rows = await listLegacyDecisionRows();
    res.json({ decisions: rows.map(serializeDecisionSummaryRow) });
  },
);

/**
 * POST /decision-room/decisions — frame a new legacy decision.
 * Requires Decision Room access.
 */
router.post(
  "/decision-room/decisions",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!hasDecisionRoomAccess(req)) {
      res.status(403).json({ error: "no_decision_room_access" });
      return;
    }
    const parsed = CreateDecisionBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { title, question, context } = parsed.data;
    const [row] = await db
      .insert(decisionsTable)
      .values({ title, question, context: context ?? null })
      .returning({ id: decisionsTable.id });
    const detail = await serializeDecisionDetail(row.id);
    res.status(201).json(detail);
  },
);

/** GET /decision-room/decisions/:id -- returns 404 for CVO release records. */
router.get(
  "/decision-room/decisions/:id",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!hasDecisionRoomAccess(req)) {
      res.status(403).json({ error: "no_decision_room_access" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const detail = await serializeDecisionDetail(id);
    if (!detail) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(detail);
  },
);

/** PATCH /decision-room/decisions/:id -- 404 for CVO release records. */
router.patch(
  "/decision-room/decisions/:id",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!hasDecisionRoomAccess(req)) {
      res.status(403).json({ error: "no_decision_room_access" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const parsed = UpdateDecisionBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    // Verify this is a legacy record before patching
    const [existing] = await db
      .select({ id: decisionsTable.id, status: decisionsTable.status })
      .from(decisionsTable)
      .where(eq(decisionsTable.id, id))
      .limit(1);
    if (!existing || !LEGACY_STATUSES.has(existing.status)) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const b = parsed.data;
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (b.title !== undefined) patch.title = b.title;
    if (b.question !== undefined) patch.question = b.question;
    if (b.context !== undefined) patch.context = b.context;
    if (b.ownView !== undefined) patch.ownView = b.ownView;
    if (b.finalCall !== undefined) patch.finalCall = b.finalCall;
    if (b.outcome !== undefined) patch.outcome = b.outcome;
    if (b.checkedStepIds !== undefined) patch.checkedStepIds = b.checkedStepIds;
    if (b.status !== undefined) {
      // Only allow setting legacy statuses
      if (!LEGACY_STATUSES.has(b.status)) {
        res.status(400).json({
          error: "invalid_status_for_legacy_decision",
          status: b.status,
        });
        return;
      }
      patch.status = b.status;
      patch.decidedAt = b.status === "decided" ? new Date() : null;
    }
    const [updated] = await db
      .update(decisionsTable)
      .set(patch)
      .where(eq(decisionsTable.id, id))
      .returning({ id: decisionsTable.id });
    if (!updated) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const detail = await serializeDecisionDetail(id);
    res.json(detail);
  },
);

/** DELETE /decision-room/decisions/:id -- 404 for CVO release records. */
router.delete(
  "/decision-room/decisions/:id",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!hasDecisionRoomAccess(req)) {
      res.status(403).json({ error: "no_decision_room_access" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }

    // Verify this is a legacy record before deleting
    const [existing] = await db
      .select({ id: decisionsTable.id, status: decisionsTable.status })
      .from(decisionsTable)
      .where(eq(decisionsTable.id, id))
      .limit(1);
    if (!existing || !LEGACY_STATUSES.has(existing.status)) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    await db
      .delete(decisionConsultationsTable)
      .where(eq(decisionConsultationsTable.decisionId, id));
    const deleted = await db
      .delete(decisionsTable)
      .where(eq(decisionsTable.id, id))
      .returning({ id: decisionsTable.id });
    if (deleted.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ ok: true });
  },
);

const UNCOVERED_TEXT =
  "This pillar's steward-approved corpus doesn't reach this question yet, so it offers no perspective rather than an invented one.";

/**
 * POST /decision-room/decisions/:id/consult -- governed per-pillar answers.
 * Automation-bias rule: 400s until the author's own view is recorded.
 * Returns 404 for CVO release records (legacy guard).
 */
router.post(
  "/decision-room/decisions/:id/consult",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!hasDecisionRoomAccess(req)) {
      res.status(403).json({ error: "no_decision_room_access" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const parsed = ConsultPillarsBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const [decision] = await db
      .select()
      .from(decisionsTable)
      .where(eq(decisionsTable.id, id))
      .limit(1);
    if (!decision) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // Refuse to consult on CVO governance records via the legacy endpoint
    if (!LEGACY_STATUSES.has(decision.status)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!decision.ownView || decision.ownView.trim().length === 0) {
      res.status(400).json({
        error: "own_view_required",
        message:
          "Write your own view first -- AI comes second. This guards against automation bias.",
      });
      return;
    }

    // Validate slugs against the same curated allowlist /pillars exposes
    const activePillars = await db
      .select({ slug: pillarsTable.slug, name: pillarsTable.name })
      .from(pillarsTable)
      .where(isNull(pillarsTable.retiredAt));
    const allowed = new Set<string>(DECISION_ROOM_PILLAR_SLUGS);
    const bySlug = new Map(
      activePillars
        .filter((p) => allowed.has(p.slug))
        .map((p) => [p.slug, p.name]),
    );
    const requested = [...new Set(parsed.data.pillarSlugs)];
    const unknown = requested.filter((s) => !bySlug.has(s));
    if (unknown.length > 0) {
      res.status(400).json({ error: `unknown_pillars: ${unknown.join(", ")}` });
      return;
    }

    const created: Array<{
      id: number;
      pillarSlug: string;
      pillarName: string;
      status: string;
      answerText: string;
      citations: Citation[];
      createdAt: Date;
    }> = [];

    for (const slug of requested) {
      const pillarName = bySlug.get(slug)!;
      let status = "error";
      let answerText =
        "Something went wrong consulting this pillar. Try again.";
      let citations: Citation[] = [];
      try {
        const result = await governedAnswer({
          question: decision.question,
          pillarSlug: slug,
        });
        if (result.outcome === "covered" && result.answer) {
          status = "covered";
          answerText = result.answer;
          citations = collapseSameWorkProvenance(result.provenance).map(
            (p) => ({
              title: p.title,
              authors: p.authors,
              year: p.year,
              sourceUrl: p.source_url,
            }),
          );
        } else {
          status = "uncovered";
          answerText = UNCOVERED_TEXT;
        }
      } catch (err) {
        req.log.error({ err, pillarSlug: slug }, "Legacy consult failed");
      }
      const [row] = await db
        .insert(decisionConsultationsTable)
        .values({
          decisionId: id,
          pillarSlug: slug,
          pillarName,
          status,
          answerText,
          citations,
        })
        .returning();
      created.push({
        id: row.id,
        pillarSlug: row.pillarSlug,
        pillarName: row.pillarName,
        status: row.status,
        answerText: row.answerText,
        citations: (row.citations ?? []) as Citation[],
        createdAt: row.createdAt,
      });
    }

    // Nudge the lifecycle forward once perspectives exist
    if (decision.status === "framing" || decision.status === "consulting") {
      await db
        .update(decisionsTable)
        .set({ status: "consulting", updatedAt: new Date() })
        .where(eq(decisionsTable.id, id));
    }

    res.json({ consultations: created });
  },
);

/**
 * GET /decision-room/steps -- protocol steps.
 * Now requires Decision Room access.
 */
router.get(
  "/decision-room/steps",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!hasDecisionRoomAccess(req)) {
      res.status(403).json({ error: "no_decision_room_access" });
      return;
    }
    const steps = await db
      .select({
        id: decisionAiStepsTable.id,
        text: decisionAiStepsTable.text,
        position: decisionAiStepsTable.position,
      })
      .from(decisionAiStepsTable)
      .orderBy(
        asc(decisionAiStepsTable.position),
        asc(decisionAiStepsTable.id),
      );
    res.json({ steps });
  },
);

/**
 * POST /decision-room/steps -- append a protocol step.
 * Restricted to platform-admin (CVO) only.
 */
router.post(
  "/decision-room/steps",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (req.faculty!.user.isPlatformAdmin !== "true") {
      res.status(403).json({ error: "platform_admin_cvo_only" });
      return;
    }
    const parsed = CreateAiStepBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const [{ max }] = await db
      .select({ max: sql<number>`COALESCE(MAX(position), 0)::int` })
      .from(decisionAiStepsTable);
    const [row] = await db
      .insert(decisionAiStepsTable)
      .values({ text: parsed.data.text, position: Number(max) + 1 })
      .returning({
        id: decisionAiStepsTable.id,
        text: decisionAiStepsTable.text,
        position: decisionAiStepsTable.position,
      });
    res.status(201).json(row);
  },
);

/**
 * PATCH /decision-room/steps/:id -- edit or reorder.
 * Restricted to platform-admin (CVO) only.
 */
router.patch(
  "/decision-room/steps/:id",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (req.faculty!.user.isPlatformAdmin !== "true") {
      res.status(403).json({ error: "platform_admin_cvo_only" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const parsed = UpdateAiStepBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.data.text !== undefined) patch.text = parsed.data.text;
    if (parsed.data.position !== undefined)
      patch.position = parsed.data.position;
    const [row] = await db
      .update(decisionAiStepsTable)
      .set(patch)
      .where(eq(decisionAiStepsTable.id, id))
      .returning({
        id: decisionAiStepsTable.id,
        text: decisionAiStepsTable.text,
        position: decisionAiStepsTable.position,
      });
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(row);
  },
);

/**
 * DELETE /decision-room/steps/:id
 * Restricted to platform-admin (CVO) only.
 */
router.delete(
  "/decision-room/steps/:id",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (req.faculty!.user.isPlatformAdmin !== "true") {
      res.status(403).json({ error: "platform_admin_cvo_only" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const deleted = await db
      .delete(decisionAiStepsTable)
      .where(eq(decisionAiStepsTable.id, id))
      .returning({ id: decisionAiStepsTable.id });
    if (deleted.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ ok: true });
  },
);

export default router;
