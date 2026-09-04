import { and, eq, ne, sql } from "drizzle-orm";
import {
  db,
  crawlCandidatesTable,
  interpretationsTable,
  interpretationCommentsTable,
  interpretationVersionsTable,
  sourceAuditLogTable,
  sourceChunksTable,
  sourceVersionsTable,
  sourcesTable,
  type SourceRightsBasis,
} from "@workspace/db";

type RetentionExecutor = Pick<
  typeof db,
  "select" | "insert" | "update" | "delete"
  | "execute"
>;

/** The only two states in which raw source expression may be read. */
export function hasReadableSourceMaterial(
  retentionStatus:
    | "needs_review"
    | "review_window"
    | "retained_with_rights"
    | "purged_no_full_text_rights",
): boolean {
  return (
    retentionStatus === "review_window" ||
    retentionStatus === "retained_with_rights"
  );
}

/**
 * Faculty-only review and drafting may read a legacy source while its rights
 * decision is still pending. It never reopens an explicitly purged source.
 */
export function hasDraftableSourceMaterial(
  retentionStatus:
    | "needs_review"
    | "review_window"
    | "retained_with_rights"
    | "purged_no_full_text_rights",
): boolean {
  return retentionStatus !== "purged_no_full_text_rights";
}

/** Derive retention from a recorded decision; never infer it from source kind. */
export function retentionForRightsBasis(
  rightsBasis: SourceRightsBasis,
): "review_window" | "retained_with_rights" {
  return rightsBasis === "no_documented_full_text_rights"
    ? "review_window"
    : "retained_with_rights";
}

/**
 * Permanently remove material derived from a source's full text when no
 * documented full-text rights were recorded. This deliberately preserves only
 * citation metadata and any already-approved, Palonur-authored interpretation.
 *
 * The source audit contains operational events and never stores source text.
 * This is a data-retention control, not a claim about legal permissibility.
 */
async function purgeWithExecutor(
  tx: RetentionExecutor,
  opts: {
  sourceId: number;
  actorUserId: number | null;
  reason: "source_approved" | "source_archived" | "rights_conversion";
  },
): Promise<{ purged: boolean; retainedApprovedInterpretationIds: number[] }> {
    const [source] = await tx
      .select()
      .from(sourcesTable)
      .where(eq(sourcesTable.id, opts.sourceId))
      .limit(1);
    if (!source) throw new Error("Source not found");

    if (
      source.rightsBasis !== "no_documented_full_text_rights" ||
      source.retentionStatus === "purged_no_full_text_rights"
    ) {
      return { purged: false, retainedApprovedInterpretationIds: [] };
    }

    const approved = await tx
      .select({ id: interpretationsTable.id })
      .from(interpretationsTable)
      .where(
        and(
          eq(interpretationsTable.sourceId, source.id),
          eq(interpretationsTable.status, "approved"),
        ),
      );
    const approvedIds = approved.map((row) => row.id);

    // Proposed/archived drafts are neither approved analysis nor needed after
    // the review decision. Their chunks, comments and versions cascade away.
    await tx
      .delete(interpretationsTable)
      .where(
        and(
          eq(interpretationsTable.sourceId, source.id),
          ne(interpretationsTable.status, "approved"),
        ),
      );

    // A quoted source passage can be pasted into a discussion or an old
    // interpretation snapshot. Drop both instead of trying to determine
    // whether any particular sentence is a close reconstruction of the paper.
    for (const interpretationId of approvedIds) {
      await tx
        .delete(interpretationCommentsTable)
        .where(
          eq(interpretationCommentsTable.interpretationId, interpretationId),
        );
      await tx
        .delete(interpretationVersionsTable)
        .where(
          eq(interpretationVersionsTable.interpretationId, interpretationId),
        );
      await tx
        .update(interpretationsTable)
        .set({ aiDraft: null })
        .where(eq(interpretationsTable.id, interpretationId));
    }

    await tx
      .delete(sourceChunksTable)
      .where(eq(sourceChunksTable.sourceId, source.id));
    await tx
      .delete(sourceVersionsTable)
      .where(eq(sourceVersionsTable.sourceId, source.id));
    // Crawl candidates retain a working transcript independently from the
    // canonical source row. It is still raw source expression, so leaving it
    // behind would defeat the same policy for talks and podcasts.
    await tx.execute(sql`
      UPDATE crawl_candidates
         SET transcript = NULL
       WHERE source_id = ${source.id}
          OR (
            source_id IS NULL
            AND primary_url = ${source.sourceUrl}
          )
    `);

    await tx
      .update(sourcesTable)
      .set({
        abstract: null,
        fullText: null,
        contentHash: null,
        topicFitScore: null,
        topicFitCheckedAt: null,
        offTopicSuspect: false,
        assessmentRubric: null,
        assessmentAiDraft: null,
        assessmentStatus: null,
        rigorScore: null,
        reproducibilityScore: null,
        opennessScore: null,
        assessedByUserId: null,
        assessedAt: null,
        assessmentAiAcceptance: null,
        retentionStatus: "purged_no_full_text_rights",
        purgedByUserId: opts.actorUserId,
        purgedAt: new Date(),
      })
      .where(eq(sourcesTable.id, source.id));

    await tx.insert(sourceAuditLogTable).values({
      sourceId: source.id,
      actorUserId: opts.actorUserId,
      action: "rights_purge",
      note: `No documented full-text rights; removed source-derived material after ${opts.reason}.`,
    });
    return {
      purged: true,
      retainedApprovedInterpretationIds: approvedIds,
    };
}

/** Use this from a caller's transaction when approval and purge must commit together. */
export async function purgeUnlicensedSourceMaterialInTransaction(
  tx: RetentionExecutor,
  opts: {
    sourceId: number;
    actorUserId: number | null;
    reason: "source_approved" | "source_archived" | "rights_conversion";
  },
): Promise<{ purged: boolean; retainedApprovedInterpretationIds: number[] }> {
  return purgeWithExecutor(tx, opts);
}

export async function purgeUnlicensedSourceMaterial(opts: {
  sourceId: number;
  actorUserId: number | null;
  reason: "source_approved" | "source_archived" | "rights_conversion";
}): Promise<{ purged: boolean; retainedApprovedInterpretationIds: number[] }> {
  return db.transaction((tx) => purgeWithExecutor(tx, opts));
}