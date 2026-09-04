import { Router, type IRouter, type Request, type Response } from "express";
import { eq, desc, and } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  reputationTopicsTable,
  reputationPromptsTable,
  reputationRunsTable,
  reputationAnswersTable,
} from "@workspace/db/schema";
import {
  ALL_ENGINES,
  callEngine,
  analyzeAnswer,
  logEngineResult,
  type EngineId,
} from "../services/reputationEngines.js";
import { logger as rootLogger } from "../lib/logger.js";

const router: IRouter = Router();

interface RunSummaryRow {
  id: number;
  topicId: number;
  status: string;
  engines: string[];
  triggeredBy: string | null;
  startedAt: Date;
  completedAt: Date | null;
  errorMessage: string | null;
  totals: unknown;
}

function summarizeRun(r: RunSummaryRow) {
  return {
    id: r.id,
    topicId: r.topicId,
    status: r.status,
    engines: r.engines,
    triggeredBy: r.triggeredBy,
    startedAt: r.startedAt.toISOString(),
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    errorMessage: r.errorMessage,
    totals: (r.totals as Record<string, unknown> | null) ?? {},
  };
}

router.get("/reputation/topics/:slug", async (req: Request, res: Response): Promise<void> => {
  const slug = String(req.params.slug);
  const [topic] = await db
    .select()
    .from(reputationTopicsTable)
    .where(eq(reputationTopicsTable.slug, slug))
    .limit(1);
  if (!topic) {
    res.status(404).json({ status: "not_found" });
    return;
  }
  const prompts = await db
    .select()
    .from(reputationPromptsTable)
    .where(eq(reputationPromptsTable.topicId, topic.id))
    .orderBy(reputationPromptsTable.id);
  const runs = await db
    .select()
    .from(reputationRunsTable)
    .where(eq(reputationRunsTable.topicId, topic.id))
    .orderBy(desc(reputationRunsTable.startedAt))
    .limit(10);
  res.json({
    id: topic.id,
    slug: topic.slug,
    name: topic.name,
    description: topic.description,
    signalKeywords: topic.signalKeywords,
    seedDomains: topic.seedDomains,
    prompts: prompts.map((p) => ({
      id: p.id,
      prompt: p.prompt,
      category: p.category,
    })),
    latestRun: runs[0] ? summarizeRun(runs[0]) : null,
    recentRuns: runs.map(summarizeRun),
  });
});

router.post("/reputation/topics/:slug/runs", async (req: Request, res: Response): Promise<void> => {
  const slug = String(req.params.slug);
  const [topic] = await db
    .select()
    .from(reputationTopicsTable)
    .where(eq(reputationTopicsTable.slug, slug))
    .limit(1);
  if (!topic) {
    res.status(404).json({ status: "not_found" });
    return;
  }
  const prompts = await db
    .select()
    .from(reputationPromptsTable)
    .where(eq(reputationPromptsTable.topicId, topic.id))
    .orderBy(reputationPromptsTable.id);
  if (prompts.length === 0) {
    res.status(400).json({ status: "no_prompts" });
    return;
  }

  const requestedEngines = (req.body?.engines as string[] | undefined) ?? null;
  const engines: EngineId[] = (requestedEngines && requestedEngines.length > 0
    ? requestedEngines.filter((e): e is EngineId => (ALL_ENGINES as string[]).includes(e))
    : ALL_ENGINES);

  if (engines.length === 0) {
    res.status(400).json({ status: "no_valid_engines" });
    return;
  }

  const triggeredBy =
    (req.headers["x-triggered-by"] as string | undefined) ??
    req.ip ??
    "manual";

  const [run] = await db
    .insert(reputationRunsTable)
    .values({
      topicId: topic.id,
      status: "running",
      engines,
      triggeredBy,
    })
    .returning();

  res.status(202).json(summarizeRun(run));

  // Fire-and-forget background execution.
  void (async () => {
    const log = rootLogger.child({ runId: run.id, topicSlug: slug });
    log.info({ engines, prompts: prompts.length }, "reputation run started");
    let errorMessage: string | null = null;
    const totals: Record<string, number> = {
      total: 0,
      ok: 0,
      errors: 0,
      mentionsStanford: 0,
      mentionsZeitzer: 0,
      mentionsPalonur: 0,
    };
    try {
      for (const prompt of prompts) {
        const results = await Promise.all(
          engines.map((e) => callEngine(e, prompt.prompt)),
        );
        for (const r of results) {
          logEngineResult(log, r, prompt.id);
          const analysis = analyzeAnswer(r.answerText, topic.signalKeywords);
          totals.total += 1;
          if (r.status === "ok") totals.ok += 1;
          else totals.errors += 1;
          if (analysis.mentionsStanford) totals.mentionsStanford += 1;
          if (analysis.mentionsZeitzer) totals.mentionsZeitzer += 1;
          if (analysis.mentionsPalonur) totals.mentionsPalonur += 1;
          await db.insert(reputationAnswersTable).values({
            runId: run.id,
            promptId: prompt.id,
            engine: r.engine,
            model: r.model,
            status: r.status,
            answerText: r.answerText,
            errorMessage: r.errorMessage,
            latencyMs: r.latencyMs,
            mentionsStanford: analysis.mentionsStanford,
            mentionsZeitzer: analysis.mentionsZeitzer,
            mentionsPalonur: analysis.mentionsPalonur,
            signalHits: analysis.signalHits,
            citedUrls: analysis.citedUrls,
            citedDomains: analysis.citedDomains,
          });
        }
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      log.error({ err: errorMessage }, "reputation run failed");
    }
    await db
      .update(reputationRunsTable)
      .set({
        status: errorMessage ? "failed" : "completed",
        completedAt: new Date(),
        errorMessage,
        totals,
      })
      .where(eq(reputationRunsTable.id, run.id));
    log.info({ totals }, "reputation run finished");
  })();
});

router.get("/reputation/runs/:id", async (req: Request, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ status: "bad_id" });
    return;
  }
  const [run] = await db
    .select()
    .from(reputationRunsTable)
    .where(eq(reputationRunsTable.id, id))
    .limit(1);
  if (!run) {
    res.status(404).json({ status: "not_found" });
    return;
  }
  const answers = await db
    .select({
      a: reputationAnswersTable,
      promptText: reputationPromptsTable.prompt,
    })
    .from(reputationAnswersTable)
    .leftJoin(
      reputationPromptsTable,
      eq(reputationAnswersTable.promptId, reputationPromptsTable.id),
    )
    .where(eq(reputationAnswersTable.runId, run.id))
    .orderBy(reputationAnswersTable.promptId, reputationAnswersTable.engine);

  res.json({
    run: summarizeRun(run),
    answers: answers.map((row) => ({
      id: row.a.id,
      promptId: row.a.promptId,
      promptText: row.promptText,
      engine: row.a.engine,
      model: row.a.model,
      status: row.a.status,
      answerText: row.a.answerText,
      errorMessage: row.a.errorMessage,
      latencyMs: row.a.latencyMs,
      mentionsStanford: row.a.mentionsStanford,
      mentionsZeitzer: row.a.mentionsZeitzer,
      mentionsPalonur: row.a.mentionsPalonur,
      signalHits: row.a.signalHits,
      citedUrls: row.a.citedUrls,
      citedDomains: row.a.citedDomains,
      createdAt: row.a.createdAt.toISOString(),
    })),
  });
});

// Suppress unused-import warning for `and` (kept available for future filters).
void and;

export default router;
