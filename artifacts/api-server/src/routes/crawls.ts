import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  crawlRunsTable,
  crawlCandidatesTable,
  facultyUsersTable,
  facultyMembershipsTable,
  pillarsTable,
  type SourceRightsBasis,
} from "@workspace/db";
import {
  requireFacultyAuth,
  type FacultyRequest,
} from "../middlewares/facultyAuth.js";
import {
  startCrawlRun,
  startCollectPhase,
  retryCandidate,
  discardCandidate,
} from "../lib/crawlTalks.js";
import { isFirecrawlConfigured } from "../lib/firecrawl.js";

const router: IRouter = Router();

const startSchema = z.object({
  facultyUserId: z.coerce.number().int().positive(),
  pillarId: z.coerce.number().int().positive(),
  pastedUrls: z.array(z.string().url()).max(20).optional(),
  rightsBasis: z.enum([
    "open_license",
    "permission",
    "public_domain",
    "no_documented_full_text_rights",
  ]),
});

/**
 * Talk-crawl admin routes (Task #168). All platform-admin-only — an operator
 * triggers a per-faculty crawl, then polls run + candidate status. Mirrors the
 * hand-written `/api/faculty/admin/*` gating (requireFacultyAuth + the user's
 * isPlatformAdmin flag); these are not OpenAPI-codegen routes.
 */

/**
 * POST /api/faculty/admin/crawls — start a crawl for one faculty member.
 * Returns the run id immediately; the worker runs in the background.
 */
router.post(
  "/faculty/admin/crawls",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    if (ctx.user.isPlatformAdmin !== "true") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const parsed = startSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { facultyUserId, pillarId, pastedUrls, rightsBasis } = parsed.data;

    const [speaker] = await db
      .select({
        id: facultyUsersTable.id,
        fullName: facultyUsersTable.fullName,
      })
      .from(facultyUsersTable)
      .where(eq(facultyUsersTable.id, facultyUserId))
      .limit(1);
    if (!speaker) {
      res.status(404).json({ error: "Faculty member not found" });
      return;
    }
    const speakerName = (speaker.fullName ?? "").trim();
    if (!speakerName) {
      res.status(400).json({
        error: "This faculty member has no name on file to search for.",
      });
      return;
    }

    const [pillar] = await db
      .select({ id: pillarsTable.id })
      .from(pillarsTable)
      .where(eq(pillarsTable.id, pillarId))
      .limit(1);
    if (!pillar) {
      res.status(404).json({ error: "Pillar not found" });
      return;
    }

    const runId = await startCrawlRun({
      facultyUserId,
      pillarId,
      startedByUserId: ctx.user.id,
      speakerName,
      pastedUrls,
      rightsBasis: rightsBasis as SourceRightsBasis,
    });

    res.status(201).json({
      runId,
      speakerName,
      firecrawlConfigured: isFirecrawlConfigured(),
    });
  },
);

/**
 * GET /api/faculty/admin/crawls — recent runs with candidate counts, for the
 * admin overview list.
 */
router.get(
  "/faculty/admin/crawls",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    if (ctx.user.isPlatformAdmin !== "true") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const runs = await db
      .select({
        id: crawlRunsTable.id,
        facultyUserId: crawlRunsTable.facultyUserId,
        pillarId: crawlRunsTable.pillarId,
        speakerName: crawlRunsTable.speakerName,
        rightsBasis: crawlRunsTable.rightsBasis,
        status: crawlRunsTable.status,
        error: crawlRunsTable.error,
        createdAt: crawlRunsTable.createdAt,
        updatedAt: crawlRunsTable.updatedAt,
        pillarName: pillarsTable.name,
      })
      .from(crawlRunsTable)
      .leftJoin(pillarsTable, eq(pillarsTable.id, crawlRunsTable.pillarId))
      .orderBy(desc(crawlRunsTable.createdAt))
      .limit(50);

    res.json({
      firecrawlConfigured: isFirecrawlConfigured(),
      runs: runs.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
    });
  },
);

/**
 * GET /api/faculty/admin/crawls/:id — one run with its candidates, for polling.
 */
router.get(
  "/faculty/admin/crawls/:id",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    if (ctx.user.isPlatformAdmin !== "true") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid run id" });
      return;
    }
    const [run] = await db
      .select({
        id: crawlRunsTable.id,
        facultyUserId: crawlRunsTable.facultyUserId,
        pillarId: crawlRunsTable.pillarId,
        speakerName: crawlRunsTable.speakerName,
        rightsBasis: crawlRunsTable.rightsBasis,
        status: crawlRunsTable.status,
        error: crawlRunsTable.error,
        createdAt: crawlRunsTable.createdAt,
        updatedAt: crawlRunsTable.updatedAt,
        pillarSlug: pillarsTable.slug,
        pillarName: pillarsTable.name,
      })
      .from(crawlRunsTable)
      .leftJoin(pillarsTable, eq(pillarsTable.id, crawlRunsTable.pillarId))
      .where(eq(crawlRunsTable.id, id))
      .limit(1);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    const candidates = await db
      .select({
        id: crawlCandidatesTable.id,
        status: crawlCandidatesTable.status,
        title: crawlCandidatesTable.title,
        sourceType: crawlCandidatesTable.sourceType,
        eventName: crawlCandidatesTable.eventName,
        primaryUrl: crawlCandidatesTable.primaryUrl,
        transcriptAvailable: crawlCandidatesTable.transcriptAvailable,
        sourceId: crawlCandidatesTable.sourceId,
        interpretationId: crawlCandidatesTable.interpretationId,
        error: crawlCandidatesTable.error,
      })
      .from(crawlCandidatesTable)
      .where(eq(crawlCandidatesTable.crawlRunId, id))
      .orderBy(crawlCandidatesTable.id);

    res.json({
      run: {
        ...run,
        createdAt: run.createdAt.toISOString(),
        updatedAt: run.updatedAt.toISOString(),
      },
      candidates,
    });
  },
);

/**
 * POST /api/faculty/admin/crawls/:id/collect — start phase 2 (collection) for a
 * run parked in `review`. Processes only the non-discarded candidates, so the
 * operator's review survives: the expensive transcription / ingest / AI-draft
 * cost is spent only on the appearances they kept.
 */
router.post(
  "/faculty/admin/crawls/:id/collect",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    if (ctx.user.isPlatformAdmin !== "true") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid run id" });
      return;
    }
    const result = await startCollectPhase(id);
    if (!result.ok) {
      if (result.reason === "not_found") {
        res.status(404).json({ error: "Run not found" });
        return;
      }
      res.status(409).json({ error: result.reason ?? "Action not allowed" });
      return;
    }
    res.json({ ok: true });
  },
);

const candidateActionSchema = z.object({
  action: z.enum(["retry", "discard"]),
});

/**
 * PATCH /api/faculty/admin/crawls/candidates/:id — operator-level candidate
 * actions: `retry` re-runs collection for a failed appearance, `discard`
 * dismisses a discovered/failed one before it is ingested.
 */
router.patch(
  "/faculty/admin/crawls/candidates/:id",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    if (ctx.user.isPlatformAdmin !== "true") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid candidate id" });
      return;
    }
    const parsed = candidateActionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const result =
      parsed.data.action === "retry"
        ? await retryCandidate(id)
        : await discardCandidate(id);
    if (!result.ok) {
      if (result.reason === "not_found") {
        res.status(404).json({ error: "Candidate not found" });
        return;
      }
      res.status(409).json({ error: result.reason ?? "Action not allowed" });
      return;
    }
    res.json({ ok: true });
  },
);

/**
 * GET /api/faculty/admin/crawls-targets — faculty + their pillars, to populate
 * the "who to crawl / which pillar" pickers in the admin UI.
 */
router.get(
  "/faculty/admin/crawls-targets",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    if (ctx.user.isPlatformAdmin !== "true") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const rows = await db
      .select({
        userId: facultyUsersTable.id,
        fullName: facultyUsersTable.fullName,
        email: facultyUsersTable.email,
        pillarId: pillarsTable.id,
        pillarName: pillarsTable.name,
        pillarSlug: pillarsTable.slug,
      })
      .from(facultyUsersTable)
      .leftJoin(
        facultyMembershipsTable,
        eq(facultyMembershipsTable.userId, facultyUsersTable.id),
      )
      .leftJoin(
        pillarsTable,
        eq(pillarsTable.id, facultyMembershipsTable.pillarId),
      );

    type Target = {
      id: number;
      fullName: string | null;
      email: string;
      pillars: Array<{ id: number; name: string; slug: string }>;
    };
    const byUser = new Map<number, Target>();
    for (const r of rows) {
      let t = byUser.get(r.userId);
      if (!t) {
        t = { id: r.userId, fullName: r.fullName, email: r.email, pillars: [] };
        byUser.set(r.userId, t);
      }
      if (r.pillarId != null && r.pillarName != null && r.pillarSlug != null) {
        if (!t.pillars.some((p) => p.id === r.pillarId)) {
          t.pillars.push({
            id: r.pillarId,
            name: r.pillarName,
            slug: r.pillarSlug,
          });
        }
      }
    }
    const targets = Array.from(byUser.values())
      .filter((t) => (t.fullName ?? "").trim().length > 0)
      .sort((a, b) =>
        (a.fullName ?? a.email).localeCompare(b.fullName ?? b.email),
      );

    res.json({ targets });
  },
);

export default router;
