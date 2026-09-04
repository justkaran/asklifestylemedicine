/**
 * Answer-limit notices — turn silent pipeline limits into small amber
 * notices under a covered answer.
 *
 * The pipeline already knows when an answer is working near its limits:
 *   - it drew on very few approved sources,
 *   - relevant drafts are still sitting in the steward review queue,
 *   - the retrieval score barely cleared the coverage threshold.
 *
 * These signals ALREADY exist (provenance, interpretations.status,
 * raw topScore vs RAG_MIN_SCORE) — this module only derives notices from
 * them, no new scoring. Notices are shipped as structured codes so each
 * client localizes the wording (EN + DE) itself.
 *
 * Principles:
 *   - Covered answers only. Refusals / UNCOVERED / legacy-fallback answers
 *     already carry their own boundary labels; a limit notice under them
 *     would double-label or imply grounding that isn't there.
 *   - A notice frames what is still under review — it must never read as
 *     "this answer is unsafe". Well-covered answers get NO notice.
 *   - Fail silent: a DB hiccup while counting pending drafts drops the
 *     notice, never the answer.
 */
import { count, eq, inArray, and } from "drizzle-orm";
import { db, interpretationsTable } from "@workspace/db";
import { RAG_MIN_SCORE } from "./ragThreshold.js";
import {
  collapseSameWorkProvenance,
  type ProvenanceEntry,
} from "./rag.js";

export type AnswerLimitCode =
  | "few_sources"
  | "near_threshold"
  | "pending_review";

export interface AnswerLimitNotice {
  code: AnswerLimitCode;
  /** Distinct approved works the answer drew on (few_sources only). */
  sourceCount?: number;
  /** Drafts awaiting steward review in the routed pillar(s) (pending_review only). */
  pendingCount?: number;
}

/**
 * An answer counts as "few sources" when it drew on this many distinct
 * approved works or fewer. Counted AFTER same-work collapse so the number
 * matches the source cards the reader actually sees.
 */
export const FEW_SOURCES_MAX = 2;

/**
 * How far above RAG_MIN_SCORE still counts as "near the coverage
 * threshold". gte-small packs cosine similarity into a narrow band
 * (on-topic ~0.797–0.902 vs threshold 0.79 — see ragThreshold.ts), so the
 * margin is deliberately small. Env-overridable alongside RAG_MIN_SCORE.
 */
export const NEAR_THRESHOLD_MARGIN = (() => {
  const raw = Number(process.env.RAG_NEAR_THRESHOLD_MARGIN);
  return Number.isFinite(raw) && raw > 0 ? raw : 0.015;
})();

/** Cap so the pending-drafts count never dominates the notice copy. */
const PENDING_COUNT_CAP = 9;

export async function computeAnswerLimits(opts: {
  provenance: ProvenanceEntry[];
  topScore: number;
  /** Pillars the answer was actually routed/locked to. */
  pillarIds: number[];
  /** Structured logger with a warn method (req.log); optional. */
  log?: { warn: (obj: unknown, msg?: string) => void };
}): Promise<AnswerLimitNotice[]> {
  const notices: AnswerLimitNotice[] = [];

  // Distinct works as the reader sees them (post same-work collapse).
  const sourceCount = collapseSameWorkProvenance(opts.provenance).length;
  const fewSources = sourceCount > 0 && sourceCount <= FEW_SOURCES_MAX;
  if (fewSources) {
    notices.push({ code: "few_sources", sourceCount });
  }

  if (
    opts.topScore >= RAG_MIN_SCORE &&
    opts.topScore < RAG_MIN_SCORE + NEAR_THRESHOLD_MARGIN
  ) {
    notices.push({ code: "near_threshold" });
  }

  // Pending steward-queue drafts complement the few-sources message
  // ("…and more material is awaiting faculty review"). Only attach it when
  // the answer is ALREADY thin — busy pillars almost always have proposed
  // drafts in flight, so a standalone pending notice would show on nearly
  // every answer and stop meaning anything.
  if (fewSources && opts.pillarIds.length > 0) {
    try {
      const [row] = await db
        .select({ c: count() })
        .from(interpretationsTable)
        .where(
          and(
            inArray(interpretationsTable.pillarId, opts.pillarIds),
            eq(interpretationsTable.status, "proposed"),
          ),
        );
      const pending = row?.c ?? 0;
      if (pending > 0) {
        notices.push({
          code: "pending_review",
          pendingCount: Math.min(pending, PENDING_COUNT_CAP),
        });
      }
    } catch (e) {
      // Fail silent — the answer ships without the pending notice.
      opts.log?.warn({ err: e }, "answer-limits pending-draft count failed");
    }
  }

  return notices;
}
