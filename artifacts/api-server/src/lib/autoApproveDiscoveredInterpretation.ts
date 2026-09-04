import { eq, sql } from "drizzle-orm";
import {
  db, interpretationChunksTable, interpretationVersionsTable,
  interpretationsTable, sourceAuditLogTable, sourcesTable,
} from "@workspace/db";
import { chunkText } from "./chunker.js";
import { embedTexts, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, toVectorLiteral } from "./embeddings.js";
import { scoreDraftAcceptance } from "./draftSimilarity.js";
import { purgeUnlicensedSourceMaterialInTransaction } from "./sourceRetention.js";

/**
 * System-only counterpart to the interpretation approval transaction. It is
 * intentionally not an HTTP action: discovered records have passed the narrow
 * metadata/grounding policy before arriving here. Embed the original claim
 * before removing no-rights source text, preserving retrievability solely via
 * the approved interpretation index.
 */
export async function autoApproveDiscoveredInterpretation(opts: {
  sourceId: number; interpretationId: number;
}): Promise<void> {
  const [interp] = await db.select().from(interpretationsTable)
    .where(eq(interpretationsTable.id, opts.interpretationId)).limit(1);
  if (!interp || interp.sourceId !== opts.sourceId) throw new Error("Interpretation missing or does not belong to source.");
  const chunks = chunkText([interp.answer, interp.interpretation, interp.notProven, interp.action].filter(Boolean).join("\n\n"));
  if (!chunks.length) throw new Error("Unable to embed an empty interpretation claim.");
  const embeddings = await embedTexts(chunks);
  await db.transaction(async (tx) => {
    const [source] = await tx.select().from(sourcesTable).where(eq(sourcesTable.id, opts.sourceId)).limit(1);
    if (!source?.rightsBasis) throw new Error("Cannot approve without recorded rights.");
    const { similarity, acceptance } = scoreDraftAcceptance(interp.aiDraft, interp.interpretation);
    const version = interp.version + 1;
    await tx.update(interpretationsTable).set({
      status: "approved", version, approverId: null, approvedAt: new Date(),
      reviewedByUserId: null, reviewedAt: new Date(),
      aiDraftSimilarity: similarity, aiDraftAcceptance: acceptance,
    }).where(eq(interpretationsTable.id, interp.id));
    await tx.insert(interpretationVersionsTable).values({
      interpretationId: interp.id, version, approverId: null,
      snapshot: { event: "auto_approved_discovery", fromStatus: interp.status, toStatus: "approved",
        answer: interp.answer, interpretation: interp.interpretation, notProven: interp.notProven,
        action: interp.action, tags: interp.tags, authorId: interp.authorId, approverId: null,
        parentInterpretationId: interp.parentInterpretationId },
    });
    await tx.delete(interpretationChunksTable).where(eq(interpretationChunksTable.interpretationId, interp.id));
    for (let i = 0; i < chunks.length; i++) {
      await tx.execute(sql`
        INSERT INTO interpretation_chunks
          (interpretation_id, source_id, pillar_id, chunk_index, text, embedding, embedding_model, priority)
        VALUES (${interp.id}, ${interp.sourceId}, ${interp.pillarId}, ${i}, ${chunks[i]},
          ${toVectorLiteral(embeddings[i])}::halfvec(${sql.raw(String(EMBEDDING_DIMENSIONS))}), ${EMBEDDING_MODEL}, 100)
      `);
    }
    await tx.update(sourcesTable).set({ status: "approved" }).where(eq(sourcesTable.id, source.id));
    await tx.insert(sourceAuditLogTable).values({
      sourceId: source.id, actorUserId: null, action: "approved",
      fromStatus: source.status, toStatus: "approved",
      note: "System auto-approved a metadata-discovered grounded interpretation.",
    });
    await tx.insert(sourceAuditLogTable).values({
      sourceId: source.id, actorUserId: null, action: "interpretation_approved",
      note: "System auto-approved a metadata-discovered grounded interpretation.",
    });
    await purgeUnlicensedSourceMaterialInTransaction(tx, {
      sourceId: source.id, actorUserId: null, reason: "source_approved",
    });
  });
}