import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { interpretationsTable } from "@workspace/db/schema";
import pool from "../lib/db.js";
import { EMBEDDING_MODEL } from "../lib/embeddings.js";
import {
  requireFacultyAuth,
  requirePillarRole,
  type FacultyRequest,
} from "../middlewares/facultyAuth.js";
import {
  AI_DRAFT_PREFIX,
  generateInterpretationDraft,
} from "../lib/draftInterpretation.js";

const router: IRouter = Router();

const LOW_CONFIDENCE_MAX_SCORE = 0.45;

// The window the dashboard previews the unanswered backlog over. Matches the
// default window of the dedicated /gaps surface so the two reconcile.
const DASHBOARD_GAP_WINDOW_DAYS = 30;

interface PillarGaps {
  windowDays: number;
  totalUncovered: number;
  distinctQuestions: number;
  clusters: Array<{
    id: number;
    representativeQuestion: string;
    askedInWindow: number;
    lastUpdated: string;
    memberQuestions: string[];
  }>;
  ungroupedUncovered: Array<{
    question: string;
    count: number;
    lastAsked: string;
  }>;
}

/**
 * Load every reader question the governed RAG could NOT answer for one pillar
 * over the last `windowDays`, split into promotable clusters (with a REAL
 * windowed count, never `query_clusters.size`) and still-ungrouped demand.
 *
 * The window filters are kept consistent across all three sub-queries so that
 * clustered + ungrouped reconcile against `totalUncovered`. In particular the
 * ungrouped exclusion is scoped to the SAME window as the shown clusters, so an
 * in-window miss attached to a live-but-out-of-window cluster surfaces as
 * ungrouped rather than vanishing from both lists. Shared by the dedicated
 * /gaps surface and the dashboard preview so they can never disagree.
 */
async function loadPillarGaps(
  pillarId: number,
  windowDays: number,
): Promise<PillarGaps> {
  const [totals, clusters, ungrouped] = await Promise.all([
    pool.query<{ total: number; distinct_questions: number }>(
      `SELECT COUNT(*)::int                         AS total,
              COUNT(DISTINCT question)::int         AS distinct_questions
         FROM agent_queries
        WHERE $1 = ANY(pillar_ids)
          AND was_uncovered = TRUE
          AND created_at >= NOW() - make_interval(days => $2::int)`,
      [pillarId, windowDays],
    ),
    pool.query<{
      id: number;
      representative_question: string;
      last_updated: string;
      member_questions: string[];
      asked_in_window: number;
    }>(
      `SELECT c.id,
              c.representative_question,
              c.last_updated,
              COALESCE(
                (SELECT array_agg(q.question ORDER BY q.created_at DESC)
                   FROM (
                     SELECT question, created_at
                       FROM agent_queries
                      WHERE cluster_id = c.id
                      ORDER BY created_at DESC
                      LIMIT 5
                   ) q),
                ARRAY[]::text[]
              ) AS member_questions,
              (SELECT COUNT(*)::int
                 FROM agent_queries aq
                WHERE aq.cluster_id = c.id
                  AND aq.was_uncovered = TRUE
                  AND aq.created_at >= NOW() - make_interval(days => $2::int)
              ) AS asked_in_window
         FROM query_clusters c
        WHERE c.pillar_id = $1
          AND c.last_updated >= NOW() - make_interval(days => $2::int)
        ORDER BY asked_in_window DESC, c.size DESC, c.last_updated DESC
        LIMIT 100`,
      [pillarId, windowDays],
    ),
    pool.query<{
      question: string;
      count: number;
      last_asked: string;
    }>(
      `SELECT question,
              COUNT(*)::int AS count,
              MAX(created_at) AS last_asked
         FROM agent_queries
        WHERE $1 = ANY(pillar_ids)
          AND was_uncovered = TRUE
          AND created_at >= NOW() - make_interval(days => $2::int)
          AND (
            cluster_id IS NULL
            OR cluster_id NOT IN (
              -- Only exclude rows belonging to a cluster we actually SHOW
              -- (i.e. one updated within the window). A miss attached to a
              -- live-but-out-of-window cluster would otherwise appear in
              -- neither list while still counted in the total, breaking the
              -- "every gap" reconciliation. Surface it here instead.
              SELECT id FROM query_clusters
               WHERE pillar_id = $1
                 AND last_updated >= NOW() - make_interval(days => $2::int)
            )
          )
        GROUP BY question
        ORDER BY count DESC, last_asked DESC
        LIMIT 50`,
      [pillarId, windowDays],
    ),
  ]);

  return {
    windowDays,
    totalUncovered: totals.rows[0]?.total ?? 0,
    distinctQuestions: totals.rows[0]?.distinct_questions ?? 0,
    clusters: clusters.rows.map((r) => ({
      id: r.id,
      representativeQuestion: r.representative_question,
      askedInWindow: r.asked_in_window,
      lastUpdated: r.last_updated,
      memberQuestions: r.member_questions ?? [],
    })),
    ungroupedUncovered: ungrouped.rows.map((r) => ({
      question: r.question,
      count: r.count,
      lastAsked: r.last_asked,
    })),
  };
}

/**
 * GET /api/faculty/pillars/:slug/dashboard — live panels for the pillar's
 * coverage loop:
 *   1. Coverage gaps — clustered UNCOVERED questions PLUS still-ungrouped
 *      demand, over a consistent window (see `gaps`), so freshly-asked and
 *      aged-out questions are never hidden.
 *   2. Low-confidence answers (top_score below threshold OR flagged)
 *   3. Top topics (most-retrieved sources this week)
 */
router.get(
  "/faculty/pillars/:slug/dashboard",
  requireFacultyAuth,
  requirePillarRole({ slugParam: "slug" }, ["steward", "contributor", "viewer"]),
  async (req: FacultyRequest, res, _next?): Promise<void> => {
    const pillar = req.pillar!;

    const [clusters, lowConfidence, topTopics, totals, gaps] =
      await Promise.all([
        pool.query<{
          id: number;
          representative_question: string;
          size: number;
          last_updated: string;
          member_questions: string[];
        }>(
          `SELECT c.id,
                c.representative_question,
                c.size,
                c.last_updated,
                COALESCE(
                  (SELECT array_agg(q.question ORDER BY q.created_at DESC)
                     FROM (
                       SELECT question, created_at
                         FROM agent_queries
                        WHERE cluster_id = c.id
                        ORDER BY created_at DESC
                        LIMIT 5
                     ) q),
                  ARRAY[]::text[]
                ) AS member_questions
           FROM query_clusters c
          WHERE c.pillar_id = $1
            AND c.last_updated >= NOW() - INTERVAL '14 days'
          ORDER BY c.size DESC, c.last_updated DESC
          LIMIT 20`,
          [pillar.id],
        ),
        pool.query<{
          id: string;
          question: string;
          top_score: number;
          user_flagged: boolean;
          flag_reason: string | null;
          created_at: string;
        }>(
          `SELECT id, question, top_score, user_flagged, flag_reason, created_at
           FROM agent_queries
          WHERE $1 = ANY(pillar_ids)
            AND was_uncovered = FALSE
            AND created_at >= NOW() - INTERVAL '14 days'
            AND (top_score < $2 OR user_flagged = TRUE)
          ORDER BY user_flagged DESC, top_score ASC, created_at DESC
          LIMIT 20`,
          [pillar.id, LOW_CONFIDENCE_MAX_SCORE],
        ),
        pool.query<{
          source_id: number;
          title: string;
          count: number;
        }>(
          `SELECT s.id AS source_id, s.title, COUNT(*)::int AS count
           FROM agent_queries q
           CROSS JOIN LATERAL UNNEST(q.retrieved_source_ids) AS sid
           JOIN sources s ON s.id = sid AND s.is_canary = FALSE
          WHERE $1 = ANY(q.pillar_ids)
            AND q.was_uncovered = FALSE
            AND q.created_at >= NOW() - INTERVAL '7 days'
          GROUP BY s.id, s.title
          ORDER BY count DESC
          LIMIT 10`,
          [pillar.id],
        ),
        pool.query<{
          total: number;
          uncovered: number;
          flagged: number;
        }>(
          `SELECT
            COUNT(*)::int                                                AS total,
            COUNT(*) FILTER (WHERE was_uncovered = TRUE)::int            AS uncovered,
            COUNT(*) FILTER (WHERE user_flagged = TRUE)::int             AS flagged
           FROM agent_queries
          WHERE $1 = ANY(pillar_ids)
            AND created_at >= NOW() - INTERVAL '7 days'`,
          [pillar.id],
        ),
        loadPillarGaps(pillar.id, DASHBOARD_GAP_WINDOW_DAYS),
      ]);

    res.json({
      pillar: { id: pillar.id, slug: pillar.slug, name: pillar.name },
      totals: totals.rows[0] ?? { total: 0, uncovered: 0, flagged: 0 },
      // The honest, windowed unanswered backlog (clustered + still-ungrouped),
      // reconciled against `gaps.totalUncovered`. Surfaced so the dashboard can
      // show freshly-asked and aged-out demand the 14-day `clusters` list above
      // (kept for the auto-fire question picker) would otherwise hide.
      gaps,
      clusters: clusters.rows.map((r) => ({
        id: r.id,
        representativeQuestion: r.representative_question,
        size: r.size,
        lastUpdated: r.last_updated,
        memberQuestions: r.member_questions ?? [],
      })),
      lowConfidence: lowConfidence.rows.map((r) => ({
        id: r.id,
        question: r.question,
        topScore: r.top_score,
        userFlagged: r.user_flagged,
        flagReason: r.flag_reason,
        createdAt: r.created_at,
      })),
      topTopics: topTopics.rows.map((r) => ({
        sourceId: r.source_id,
        title: r.title,
        count: r.count,
      })),
    });
  },
);

/**
 * GET /api/faculty/pillars/:slug/gaps?days=N — the full "answers the secured
 * RAG could NOT give" backlog for one pillar, over a selectable window
 * (default 30 days, max 90). This is the dedicated, complete demand surface
 * the dashboard only previews: the dashboard shows the top few hot clusters
 * over a short window, this shows EVERY unanswered reader question in the
 * window so a steward can clear the backlog.
 *
 * Every number is a real count of real logged queries. In particular we never
 * surface `query_clusters.size` against a window label — that field is the
 * member count from the clustering run that last touched the cluster (a 7-day
 * window as of that run), which is only "this week" for a cluster updated
 * today. Instead we compute a true `askedInWindow` per cluster straight from
 * `agent_queries.created_at`.
 *
 * Returns:
 *   - totalUncovered: every was_uncovered question in this pillar in the window
 *   - clusters: grouped, PROMOTABLE gaps (carry a clusterId), with a real
 *     windowed count; the actionable list
 *   - ungroupedUncovered: was_uncovered questions in the window NOT in any live
 *     cluster yet (clustering runs hourly, so fresh demand lands here first, as
 *     do orphans whose cluster aged out). Shown read-only so no demand is
 *     hidden — they become promotable once the hourly job groups them.
 */
router.get(
  "/faculty/pillars/:slug/gaps",
  requireFacultyAuth,
  requirePillarRole({ slugParam: "slug" }, ["steward", "contributor", "viewer"]),
  async (req: FacultyRequest, res, _next?): Promise<void> => {
    const pillar = req.pillar!;
    const daysRaw = Number(req.query.days);
    const windowDays =
      Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 90
        ? Math.floor(daysRaw)
        : 30;

    const gaps = await loadPillarGaps(pillar.id, windowDays);

    res.json({
      pillar: { id: pillar.id, slug: pillar.slug, name: pillar.name },
      ...gaps,
    });
  },
);

/**
 * GET /api/faculty/pillars/:slug/clusters/:clusterId/source-suggestions
 * — return the top sources in this pillar whose chunks best match the
 * cluster's representative question. Used by the "Promote to library"
 * modal to suggest which source the new interpretation should hang off.
 */
router.get(
  "/faculty/pillars/:slug/clusters/:clusterId/source-suggestions",
  requireFacultyAuth,
  requirePillarRole({ slugParam: "slug" }, ["steward", "contributor", "viewer"]),
  async (req: FacultyRequest, res, _next?): Promise<void> => {
    const pillar = req.pillar!;
    const clusterId = parseInt(String(req.params.clusterId), 10);
    if (!Number.isFinite(clusterId)) {
      res.status(400).json({ error: "Invalid clusterId" });
      return;
    }
    const { rows } = await pool.query<{
      source_id: number;
      title: string;
      best_score: number;
    }>(
      `WITH cluster AS (
         SELECT representative_embedding
           FROM query_clusters
           WHERE id = $1 AND pillar_id = $2 AND embedding_model = $3
       )
       SELECT s.id   AS source_id,
              s.title,
              MAX(1 - (sc.embedding <=> (SELECT representative_embedding FROM cluster)))::float AS best_score
         FROM source_chunks sc
         JOIN sources s ON s.id = sc.source_id AND s.is_canary = FALSE
        WHERE s.pillar_id = $2
           AND sc.embedding IS NOT NULL
           AND sc.embedding_model = $3
          AND (
            s.retention_status IN ('review_window', 'retained_with_rights')
            OR (s.rights_basis IS NULL AND s.retention_status = 'needs_review')
          )
          AND (SELECT representative_embedding FROM cluster) IS NOT NULL
        GROUP BY s.id, s.title
        ORDER BY best_score DESC
        LIMIT 3`,
       [clusterId, pillar.id, EMBEDDING_MODEL],
    );
    res.json({
      suggestions: rows.map((r) => ({
        sourceId: r.source_id,
        title: r.title,
        score: r.best_score,
      })),
    });
  },
);

/**
 * POST /api/faculty/pillars/:slug/clusters/:clusterId/promote
 * Body: { sourceId: number }
 *
 * Server-side loop closure: creates a `proposed` interpretation hung
 * off the chosen source, seeded with the cluster's representative
 * question + a few member questions in the body so the steward sees
 * exactly what the readers asked. Returns the new interpretation id so
 * the dashboard can deep-link straight into the editor.
 */
router.post(
  "/faculty/pillars/:slug/clusters/:clusterId/promote",
  requireFacultyAuth,
  requirePillarRole({ slugParam: "slug" }, ["steward", "contributor"]),
  async (req: FacultyRequest, res, _next?): Promise<void> => {
    const pillar = req.pillar!;
    const clusterId = parseInt(String(req.params.clusterId), 10);
    const sourceId = Number((req.body as { sourceId?: unknown })?.sourceId);
    if (!Number.isFinite(clusterId) || !Number.isFinite(sourceId)) {
      res.status(400).json({ error: "clusterId and sourceId required" });
      return;
    }

    const cluster = await pool.query<{
      representative_question: string;
      member_questions: string[];
    }>(
      `SELECT c.representative_question,
              COALESCE(
                (SELECT array_agg(q.question ORDER BY q.created_at DESC)
                   FROM (
                     SELECT question, created_at
                       FROM agent_queries
                      WHERE cluster_id = c.id
                      ORDER BY created_at DESC
                      LIMIT 5
                   ) q),
                ARRAY[]::text[]
              ) AS member_questions
         FROM query_clusters c
        WHERE c.id = $1 AND c.pillar_id = $2`,
      [clusterId, pillar.id],
    );
    if (cluster.rows.length === 0) {
      res.status(404).json({ error: "Cluster not found in this pillar" });
      return;
    }
    const c = cluster.rows[0]!;

    // Defence: source must belong to this pillar.
    const src = await pool.query<{ id: number }>(
      `SELECT id FROM sources WHERE id = $1 AND pillar_id = $2`,
      [sourceId, pillar.id],
    );
    if (src.rows.length === 0) {
      res.status(400).json({ error: "Source not in this pillar" });
      return;
    }

    const memberLines = (c.member_questions ?? [])
      .filter((q) => q !== c.representative_question)
      .slice(0, 4)
      .map((q) => `- ${q}`)
      .join("\n");
    const placeholderSeed =
      `Reader question (asked ${c.member_questions?.length ?? 1}× recently):\n` +
      `"${c.representative_question}"` +
      (memberLines ? `\n\nVariants we've seen:\n${memberLines}` : "") +
      `\n\n[Replace this with the Stanford-grounded interpretation of the source above.]`;

    // Try to seed the new interpretation with an AI-drafted answer
    // grounded in the chosen source's chunks. If the source has no
    // embedded chunks yet, or Claude/embedding fails for any reason,
    // we fall back to the original placeholder so promotion always
    // succeeds — the steward is never worse off than before.
    let seedInterpretation = placeholderSeed;
    // Snapshot of the raw AI-drafted body (without the AI_DRAFT_PREFIX
    // banner) so the approval handler can score how much of it the
    // steward kept. NULL when we fell back to the placeholder.
    let aiDraftSnapshot: string | null = null;
    try {
      const { draft } = await generateInterpretationDraft({
        sourceId,
        question: c.representative_question,
        allowUnrecordedRights: true,
      });
      if (draft) {
        seedInterpretation = draft;
        aiDraftSnapshot = draft.startsWith(AI_DRAFT_PREFIX)
          ? draft.slice(AI_DRAFT_PREFIX.length)
          : draft;
      }
    } catch (err) {
      req.log?.warn?.(
        { err, sourceId, clusterId },
        "Failed to generate AI draft for promoted interpretation; using placeholder",
      );
    }

    const [created] = await db
      .insert(interpretationsTable)
      .values({
        sourceId,
        pillarId: pillar.id,
        authorId: req.faculty!.user.id,
        status: "proposed",
        answer: c.representative_question,
        interpretation: seedInterpretation,
        aiDraft: aiDraftSnapshot,
      })
      .returning();

    res.status(201).json({
      interpretationId: created!.id,
      sourceId,
      pillarSlug: pillar.slug,
    });
  },
);

/**
 * GET /api/faculty/pillars/:slug/draft-acceptance
 *
 * Aggregate counts of how often the AI-drafted seed survived approval
 * in this pillar. Powers the "AI draft acceptance" panel on the
 * coverage dashboard so the team can see whether the drafter is
 * actually saving steward time or producing slop the steward always
 * rewrites.
 *
 * Returns counts for every approved interpretation in the pillar
 * (including ones that pre-date Task #31 — those land in `noDraft`).
 */
router.get(
  "/faculty/pillars/:slug/draft-acceptance",
  requireFacultyAuth,
  requirePillarRole({ slugParam: "slug" }, ["steward", "contributor", "viewer"]),
  async (req: FacultyRequest, res, _next?): Promise<void> => {
    const pillar = req.pillar!;
    const { rows } = await pool.query<{
      bucket: string | null;
      n: number;
      avg_sim: number | null;
    }>(
      `SELECT
         COALESCE(ai_draft_acceptance, 'no_draft') AS bucket,
         COUNT(*)::int                              AS n,
         AVG(ai_draft_similarity)::float            AS avg_sim
       FROM interpretations
       WHERE pillar_id = $1
         AND status = 'approved'
       GROUP BY 1`,
      [pillar.id],
    );
    const buckets = {
      unedited: 0,
      light: 0,
      rewritten: 0,
      no_draft: 0,
    };
    let total = 0;
    let simSum = 0;
    let simCount = 0;
    for (const r of rows) {
      const key = (r.bucket ?? "no_draft") as keyof typeof buckets;
      if (key in buckets) buckets[key] += r.n;
      total += r.n;
      if (key !== "no_draft" && r.avg_sim != null) {
        simSum += r.avg_sim * r.n;
        simCount += r.n;
      }
    }
    const withDraft = buckets.unedited + buckets.light + buckets.rewritten;
    res.json({
      pillar: { id: pillar.id, slug: pillar.slug, name: pillar.name },
      total,
      withDraft,
      unedited: buckets.unedited,
      light: buckets.light,
      rewritten: buckets.rewritten,
      noDraft: buckets.no_draft,
      avgSimilarity: simCount > 0 ? simSum / simCount : null,
    });
  },
);

export default router;
