import { Router, type IRouter } from "express";
import { eq, desc, and } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  evalRunsTable,
  evalItemsTable,
  evalGradingsTable,
  facultyUsersTable,
} from "@workspace/db";
import {
  requireFacultyAuth,
  type FacultyRequest,
} from "../middlewares/facultyAuth.js";
import { computeMetrics, type ItemForMetrics } from "../lib/evalMetrics.js";

const router: IRouter = Router();

/**
 * Auth: any signed-in faculty user can grade. Platform admins also see
 * the unblinded view (system's citation_verification + was_uncovered
 * flags), so they can spot-check the harness itself.
 */

/** GET /api/evals/runs — list every run, newest first, with metrics. */
router.get(
  "/faculty/evals/runs",
  requireFacultyAuth,
  async (_req: FacultyRequest, res, _next?): Promise<void> => {
    const runs = await db
      .select()
      .from(evalRunsTable)
      .orderBy(desc(evalRunsTable.createdAt))
      .limit(50);
    res.json({ runs });
  },
);

/**
 * GET /api/evals/runs/:id — full run detail with items. Blinded by
 * default (citation_verification and governed_used hidden). Platform
 * admins get `?unblinded=1` to see everything.
 */
router.get(
  "/faculty/evals/runs/:id",
  requireFacultyAuth,
  async (req: FacultyRequest, res, _next?): Promise<void> => {
    const runId = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(runId)) {
      res.status(400).json({ error: "invalid run id" });
      return;
    }
    const [run] = await db
      .select()
      .from(evalRunsTable)
      .where(eq(evalRunsTable.id, runId))
      .limit(1);
    if (!run) {
      res.status(404).json({ error: "run not found" });
      return;
    }

    const items = await db
      .select()
      .from(evalItemsTable)
      .where(eq(evalItemsTable.runId, runId))
      .orderBy(evalItemsTable.seedIndex);

    const myGradings = await db
      .select()
      .from(evalGradingsTable)
      .where(eq(evalGradingsTable.graderUserId, req.faculty!.user.id));

    const isAdmin = req.faculty!.user.isPlatformAdmin === "true";
    const unblinded = isAdmin && req.query.unblinded === "1";

    const gradedItemIds = new Set(myGradings.map((g) => g.itemId));

    const projected = items.map((it) => {
      const base = {
        id: it.id,
        seedIndex: it.seedIndex,
        question: it.question,
        expectedOutcome: it.expectedOutcome,
        category: it.category,
        answerText: it.answerText,
        latencyMs: it.latencyMs,
        runError: it.runError,
        alreadyGraded: gradedItemIds.has(it.id),
      };
      if (!unblinded) return base;
      return {
        ...base,
        citationVerification: it.citationVerification,
        wasUncovered: it.wasUncovered,
        wasRefused: it.wasRefused,
        governedUsed: it.governedUsed,
        topScore: it.topScore,
      };
    });

    res.json({ run, items: projected, unblinded });
  },
);

const gradingBody = z.object({
  groundedness: z.number().int().min(1).max(5),
  helpfulness: z.number().int().min(1).max(5),
  accuracy: z.number().int().min(1).max(5),
  hallucinated: z.boolean(),
  notes: z.string().max(2000).nullable().optional(),
});

/**
 * POST /api/evals/items/:id/grade — submit (or update) the calling
 * grader's grade for this item. UNIQUE(item_id, grader_user_id) on
 * the table means we upsert here so a grader can revise their own
 * scores without creating duplicate rows.
 */
router.post(
  "/faculty/evals/items/:id/grade",
  requireFacultyAuth,
  async (req: FacultyRequest, res, _next?): Promise<void> => {
    const itemId = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(itemId)) {
      res.status(400).json({ error: "invalid item id" });
      return;
    }
    const parsed = gradingBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body", details: parsed.error.issues });
      return;
    }
    const [item] = await db
      .select({ id: evalItemsTable.id })
      .from(evalItemsTable)
      .where(eq(evalItemsTable.id, itemId))
      .limit(1);
    if (!item) {
      res.status(404).json({ error: "item not found" });
      return;
    }
    const graderId = req.faculty!.user.id;
    // Atomic upsert against the (item_id, grader_user_id) unique index.
    // Read-then-write would race when a grader double-submits.
    const [row] = await db
      .insert(evalGradingsTable)
      .values({
        itemId,
        graderUserId: graderId,
        groundedness: parsed.data.groundedness,
        helpfulness: parsed.data.helpfulness,
        accuracy: parsed.data.accuracy,
        hallucinated: parsed.data.hallucinated,
        notes: parsed.data.notes ?? null,
      })
      .onConflictDoUpdate({
        target: [evalGradingsTable.itemId, evalGradingsTable.graderUserId],
        set: {
          groundedness: parsed.data.groundedness,
          helpfulness: parsed.data.helpfulness,
          accuracy: parsed.data.accuracy,
          hallucinated: parsed.data.hallucinated,
          notes: parsed.data.notes ?? null,
        },
      })
      .returning({
        id: evalGradingsTable.id,
        createdAt: evalGradingsTable.createdAt,
      });
    res.json({ id: row!.id, updatedAt: row!.createdAt });
  },
);

/**
 * GET /api/evals/runs/:id/gradings — all gradings for a run, joined to
 * grader names. Powers the per-run grading summary panel. Platform
 * admin only — individual graders shouldn't see who graded what until
 * they've graded it themselves (avoids anchoring).
 */
router.get(
  "/faculty/evals/runs/:id/gradings",
  requireFacultyAuth,
  async (req: FacultyRequest, res, _next?): Promise<void> => {
    if (req.faculty!.user.isPlatformAdmin !== "true") {
      res.status(403).json({ error: "platform admin only" });
      return;
    }
    const runId = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(runId)) {
      res.status(400).json({ error: "invalid run id" });
      return;
    }
    const rows = await db
      .select({
        gradingId: evalGradingsTable.id,
        itemId: evalGradingsTable.itemId,
        seedIndex: evalItemsTable.seedIndex,
        graderId: evalGradingsTable.graderUserId,
        graderEmail: facultyUsersTable.email,
        graderName: facultyUsersTable.fullName,
        groundedness: evalGradingsTable.groundedness,
        helpfulness: evalGradingsTable.helpfulness,
        accuracy: evalGradingsTable.accuracy,
        hallucinated: evalGradingsTable.hallucinated,
        notes: evalGradingsTable.notes,
        createdAt: evalGradingsTable.createdAt,
      })
      .from(evalGradingsTable)
      .innerJoin(
        evalItemsTable,
        eq(evalItemsTable.id, evalGradingsTable.itemId),
      )
      .innerJoin(
        facultyUsersTable,
        eq(facultyUsersTable.id, evalGradingsTable.graderUserId),
      )
      .where(eq(evalItemsTable.runId, runId));
    res.json({ gradings: rows });
  },
);

/**
 * POST /api/evals/runs/:id/recompute — re-read all items for a run,
 * compute aggregate metrics, and write them back onto the run row.
 * Called by the CLI runner after the last item lands, but also safe
 * to call manually from the UI to refresh stale numbers.
 */
router.post(
  "/faculty/evals/runs/:id/recompute",
  requireFacultyAuth,
  async (req: FacultyRequest, res, _next?): Promise<void> => {
    const runId = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(runId)) {
      res.status(400).json({ error: "invalid run id" });
      return;
    }
    const [run] = await db
      .select({ id: evalRunsTable.id })
      .from(evalRunsTable)
      .where(eq(evalRunsTable.id, runId))
      .limit(1);
    if (!run) {
      res.status(404).json({ error: "run not found" });
      return;
    }
    const items = await db
      .select({
        expectedOutcome: evalItemsTable.expectedOutcome,
        wasRefused: evalItemsTable.wasRefused,
        wasUncovered: evalItemsTable.wasUncovered,
        governedUsed: evalItemsTable.governedUsed,
        citationVerification: evalItemsTable.citationVerification,
        latencyMs: evalItemsTable.latencyMs,
      })
      .from(evalItemsTable)
      .where(eq(evalItemsTable.runId, runId));
    const metrics = computeMetrics(items as ItemForMetrics[]);
    await db
      .update(evalRunsTable)
      .set({
        citationVerifiedRate: metrics.citationVerifiedRate,
        citationUnmatchedRate: metrics.citationUnmatchedRate,
        citationMissingRate: metrics.citationMissingRate,
        coverageRate: metrics.coverageRate,
        refusalComplianceRate: metrics.refusalComplianceRate,
        uncoveredHonestyRate: metrics.uncoveredHonestyRate,
        medianLatencyMs: metrics.medianLatencyMs,
        completedAt: new Date(),
      })
      .where(eq(evalRunsTable.id, runId));
    res.json({ metrics });
  },
);

export default router;
