import { and, eq, inArray, isNull, or } from "drizzle-orm";
import {
  db,
  sourcesTable,
  sourceAuditLogTable,
  scoreRubric,
} from "@workspace/db";
import { generateSourceAssessmentDraft } from "./scoreSource.js";
import { logger } from "./logger.js";

/**
 * Batch reliability drafting: draft AI assessments for EVERY approved source
 * in a pillar that has no assessment yet, in one steward action, so a steward
 * can review a draft queue instead of opening each source one at a time.
 *
 * Like the talk crawl, there is no job queue in this codebase: the route fires
 * `runPillarAssessmentDrafts` in the background and returns immediately. Each
 * result lands in `draft` status for per-source steward review — nothing is
 * ever auto-approved, preserving governance.
 */

/** Shape pulled per candidate source — exactly what the AI scorer needs. */
export interface BatchDraftCandidate {
  id: number;
  title: string;
  authors: string | null;
  year: number | null;
  journal: string | null;
  doi: string | null;
  abstract: string | null;
  fullText: string | null;
}

/**
 * Approved sources in a pillar that carry no reliability assessment yet.
 * "Un-assessed" means `assessment_status IS NULL` — a source already in
 * `draft` or `approved` is left alone so the batch never clobbers a steward's
 * in-progress or published work.
 */
export async function findUnassessedApprovedSources(
  pillarId: number,
): Promise<BatchDraftCandidate[]> {
  return db
    .select({
      id: sourcesTable.id,
      title: sourcesTable.title,
      authors: sourcesTable.authors,
      year: sourcesTable.year,
      journal: sourcesTable.journal,
      doi: sourcesTable.doi,
      abstract: sourcesTable.abstract,
      fullText: sourcesTable.fullText,
    })
    .from(sourcesTable)
    .where(
      and(
        eq(sourcesTable.pillarId, pillarId),
        eq(sourcesTable.status, "approved"),
        or(
          eq(sourcesTable.retentionStatus, "needs_review"),
          inArray(sourcesTable.retentionStatus, [
            "review_window",
            "retained_with_rights",
          ]),
        ),
        // Canaries are synthetic registry rows — never assess them.
        eq(sourcesTable.isCanary, false),
        isNull(sourcesTable.assessmentStatus),
      ),
    )
    .orderBy(sourcesTable.id);
}

/**
 * Draft an AI reliability assessment for each candidate source and persist it
 * as a `draft` (frozen as the AI baseline too). Processed SEQUENTIALLY to
 * avoid hammering the AI proxy; each source is guarded so one failure never
 * aborts the rest of the batch.
 *
 * Idempotent + race-safe: the persist is conditional on the source still being
 * `approved` with `assessment_status IS NULL`, so a steward who assessed a
 * source after the batch was queued is never overwritten, and re-running only
 * picks up what remains. Returns counts for logging.
 */
export async function runPillarAssessmentDrafts(opts: {
  pillarId: number;
  actorUserId: number;
  candidates: BatchDraftCandidate[];
}): Promise<{ drafted: number; skipped: number; failed: number }> {
  const { pillarId, actorUserId, candidates } = opts;
  let drafted = 0;
  let skipped = 0;
  let failed = 0;

  for (const source of candidates) {
    try {
      const draft = await generateSourceAssessmentDraft({
        title: source.title,
        authors: source.authors,
        year: source.year,
        journal: source.journal,
        doi: source.doi,
        abstract: source.abstract,
        fullText: source.fullText,
      });
      if (!draft) {
        failed += 1;
        continue;
      }
      const rubric = draft.rubric;
      const scores = scoreRubric(rubric);
      const updated = await db.transaction(async (tx) => {
        const [u] = await tx
          .update(sourcesTable)
          .set({
            assessmentRubric: rubric,
            assessmentAiDraft: rubric,
            assessmentStatus: "draft",
            rigorScore: scores.rigor.score,
            reproducibilityScore: scores.reproducibility.score,
            opennessScore: scores.openness.score,
            // A fresh draft is never auto-approved.
            assessedByUserId: null,
            assessedAt: null,
            assessmentAiAcceptance: null,
          })
          .where(
            and(
              eq(sourcesTable.id, source.id),
              eq(sourcesTable.pillarId, pillarId),
              eq(sourcesTable.status, "approved"),
              isNull(sourcesTable.assessmentStatus),
            ),
          )
          .returning({ id: sourcesTable.id });
        if (!u) return null;
        await tx.insert(sourceAuditLogTable).values({
          sourceId: source.id,
          actorUserId,
          action: "assessment_draft",
          note: "AI reliability draft generated (batch)",
        });
        return u;
      });
      if (updated) drafted += 1;
      else skipped += 1;
    } catch (err) {
      failed += 1;
      logger.error(
        { err, sourceId: source.id, pillarId },
        "Batch reliability draft failed for source",
      );
    }
  }

  logger.info(
    { pillarId, drafted, skipped, failed, total: candidates.length },
    "Batch reliability drafting finished",
  );
  return { drafted, skipped, failed };
}
