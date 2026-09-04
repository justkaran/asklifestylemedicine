import { and, eq, sql } from "drizzle-orm";
import {
  db,
  sourcesTable,
  sourceChunksTable,
  sourceVersionsTable,
  sourceAuditLogTable,
  interpretationsTable,
  researchDiscoveryCandidatesTable,
  type Source,
  type SourceKind,
  type SourceRightsBasis,
} from "@workspace/db";
import { chunkText } from "./chunker.js";
import { embedTexts, toVectorLiteral, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "./embeddings.js";
import { computeTopicFit, persistTopicFit, meanVector } from "./ingestionHealth.js";
import { sha256Hex, scheduleManifestSnapshot } from "./ipProtection.js";
import { generateSourceFirstDraft } from "./draftInterpretation.js";
import { retentionForRightsBasis } from "./sourceRetention.js";

/**
 * Shared source-ingest pipeline. This is the SINGLE place that turns raw
 * source text into an embedded, citable `sources` row + `source_chunks`. It
 * is used by the faculty upload route (`POST /faculty/pillars/:slug/sources`)
 * and by the talk-crawl worker (Task #168) so both paths produce identical,
 * approval-gated sources — there is no parallel ingest.
 *
 * Talk metadata (speaker / event / date) is optional and only set by the
 * crawl worker. For talks we ALSO mirror the speaker into `authors`, the
 * event into `journal`, and the talk year into `year` (caller's job) so the
 * existing citation rendering works unchanged.
 */
export interface IngestSourceMeta {
  kind: SourceKind;
  title?: string;
  authors?: string | null;
  year?: number | null;
  journal?: string | null;
  doi?: string | null;
  abstract?: string | null;
  sourceUrl?: string | null;
  studyDesign?: string | null;
  /** Every raw-text ingest must carry an explicit, recorded decision. */
  rightsBasis: SourceRightsBasis;
  /** Talk-only structured citation metadata. */
  speakerFacultyUserId?: number | null;
  speakerName?: string | null;
  eventName?: string | null;
  talkDate?: string | null;
}

export interface IngestSourceResult {
  source: Source;
  chunkCount: number;
  /** How many chunks were stored with an embedding (all, on success). */
  embeddedCount: number;
  /** Characters of extracted text that were ingested. */
  charCount: number;
  versioned: boolean;
  /** Private, unverified Palonur first draft created from this upload. */
  firstDraftId?: number | null;
}

export async function ingestSource(params: {
  pillarId: number;
  uploadedByUserId: number;
  meta: IngestSourceMeta;
  fullText: string;
  fallbackTitle: string;
  /**
   * A deliberate Faculty upload supersedes automatic-discovery provenance for
   * the current source row. The candidate is retained (and still suppresses
   * future provider re-imports), but no longer controls visibility/exclusion of
   * the manually curated source.
   */
  detachResearchDiscoveryCandidates?: boolean;
}): Promise<IngestSourceResult> {
  const {
    pillarId,
    uploadedByUserId,
    meta,
    fullText,
    fallbackTitle,
    detachResearchDiscoveryCandidates = false,
  } = params;

  if (!fullText.trim()) {
    throw new Error("No extractable text from upload");
  }

  const title = (meta.title ?? fallbackTitle).slice(0, 1000);
  const doi = meta.doi?.trim() || null;
  const retentionStatus = retentionForRightsBasis(meta.rightsBasis);

  // Build chunks + embeddings up front (outside the transaction so the
  // OpenAI call's latency doesn't hold a DB connection).
  const chunkTexts = chunkText(fullText);
  if (chunkTexts.length === 0) {
    throw new Error("No chunks produced from input text");
  }
  const embeddings = await embedTexts(chunkTexts);

  // IP-protection content hashes: sha256 of the full text + each chunk.
  // Computed on every (re-)ingest so re-ingestion updates hashes while
  // existing version snapshots (which store the previous text) keep working.
  const contentHash = sha256Hex(fullText);
  const chunkHashes = chunkTexts.map((t) => sha256Hex(t));

  // De-duplicate by (pillar_id, doi). Re-uploading the same DOI bumps the
  // version and snapshots the previous full_text + chunks. Talks rarely have
  // a DOI, so they always take the insert branch.
  const existing = doi
    ? await db
        .select()
        .from(sourcesTable)
        .where(
          and(eq(sourcesTable.pillarId, pillarId), eq(sourcesTable.doi, doi)),
        )
        .limit(1)
    : [];

  return await db.transaction(async (tx) => {
    let source: Source;
    let versioned = false;

    if (existing[0]) {
      const prev = existing[0];
      // A source already purged under the no-rights policy cannot grow a new
      // historical text snapshot during re-upload. Fresh material is kept only
      // for the new review window and purged again after the new decision.
      if (prev.retentionStatus !== "purged_no_full_text_rights") {
        const prevChunks = await tx
          .select()
          .from(sourceChunksTable)
          .where(eq(sourceChunksTable.sourceId, prev.id));
        await tx.insert(sourceVersionsTable).values({
          sourceId: prev.id,
          version: prev.version,
          snapshot: {
            source: {
              kind: prev.kind,
              title: prev.title,
              authors: prev.authors,
              year: prev.year,
              journal: prev.journal,
              doi: prev.doi,
              abstract: prev.abstract,
              fullText: prev.fullText,
              sourceUrl: prev.sourceUrl,
              studyDesign: prev.studyDesign,
              speakerName: prev.speakerName,
              eventName: prev.eventName,
              talkDate: prev.talkDate,
              status: prev.status,
              version: prev.version,
            },
            chunks: prevChunks.map((c) => ({
              chunkIndex: c.chunkIndex,
              text: c.text,
              page: c.page,
              section: c.section,
            })),
          },
        });
      }
      await tx
        .delete(sourceChunksTable)
        .where(eq(sourceChunksTable.sourceId, prev.id));
      const [updated] = await tx
        .update(sourcesTable)
        .set({
          kind: meta.kind,
          title,
          authors: meta.authors ?? null,
          year: meta.year ?? null,
          journal: meta.journal ?? null,
          abstract: meta.abstract ?? null,
          fullText,
          sourceUrl: meta.sourceUrl ?? null,
          studyDesign: meta.studyDesign ?? null,
          rightsBasis: meta.rightsBasis,
          retentionStatus,
          rightsRecordedByUserId: uploadedByUserId,
          rightsRecordedAt: new Date(),
          purgedByUserId: null,
          purgedAt: null,
          speakerFacultyUserId: meta.speakerFacultyUserId ?? null,
          speakerName: meta.speakerName ?? null,
          eventName: meta.eventName ?? null,
          talkDate: meta.talkDate ?? null,
          contentHash,
          version: prev.version + 1,
          status: prev.status === "draft" ? "draft" : "in_review",
        })
        .where(eq(sourcesTable.id, prev.id))
        .returning();
      source = updated;
      versioned = true;
      await tx.insert(sourceAuditLogTable).values({
        sourceId: source.id,
        actorUserId: uploadedByUserId,
        action: "reuploaded",
        fromStatus: prev.status,
        toStatus: source.status,
        note: `Bumped to version ${source.version}`,
      });
      await tx.insert(sourceAuditLogTable).values({
        sourceId: source.id,
        actorUserId: uploadedByUserId,
        action: "rights_recorded",
        note: `Rights basis recorded: ${meta.rightsBasis}; retention: ${source.retentionStatus}.`,
      });
    } else {
      const [inserted] = await tx
        .insert(sourcesTable)
        .values({
          pillarId,
          kind: meta.kind,
          title,
          authors: meta.authors ?? null,
          year: meta.year ?? null,
          journal: meta.journal ?? null,
          doi,
          abstract: meta.abstract ?? null,
          fullText,
          sourceUrl: meta.sourceUrl ?? null,
          studyDesign: meta.studyDesign ?? null,
          rightsBasis: meta.rightsBasis,
          retentionStatus,
          rightsRecordedByUserId: uploadedByUserId,
          rightsRecordedAt: new Date(),
          speakerFacultyUserId: meta.speakerFacultyUserId ?? null,
          speakerName: meta.speakerName ?? null,
          eventName: meta.eventName ?? null,
          talkDate: meta.talkDate ?? null,
          contentHash,
          uploadedByUserId,
          status: "draft",
          version: 1,
        })
        .returning();
      source = inserted;
      await tx.insert(sourceAuditLogTable).values({
        sourceId: source.id,
        actorUserId: uploadedByUserId,
        action: "uploaded",
        toStatus: "draft",
      });
      await tx.insert(sourceAuditLogTable).values({
        sourceId: source.id,
        actorUserId: uploadedByUserId,
        action: "rights_recorded",
        note: `Rights basis recorded: ${meta.rightsBasis}; retention: ${retentionStatus}.`,
      });
    }

    if (detachResearchDiscoveryCandidates) {
      await tx
        .update(researchDiscoveryCandidatesTable)
        .set({ sourceId: null })
        .where(eq(researchDiscoveryCandidatesTable.sourceId, source.id));
    }

    for (let i = 0; i < chunkTexts.length; i++) {
      const lit = toVectorLiteral(embeddings[i]);
      await tx.execute(sql`
        INSERT INTO source_chunks
          (source_id, chunk_index, text, embedding, embedding_model, content_hash)
        VALUES (
          ${source.id}, ${i}, ${chunkTexts[i]},
          ${lit}::halfvec(${sql.raw(String(EMBEDDING_DIMENSIONS))}), ${EMBEDDING_MODEL}, ${chunkHashes[i]}
        )
      `);
    }

    return {
      source,
      chunkCount: chunkTexts.length,
      embeddedCount: embeddings.length,
      charCount: fullText.length,
      versioned,
      firstDraftId: null,
    };
  }).then(async (result: IngestSourceResult) => {
    // Every rights-limited non-talk source receives a private first pass. It is deliberately
    // attributed to Palonur/AI (never the uploader), has no public retrieval
    // chunks, and stays proposed until a pillar steward approves it.
    if (
      meta.rightsBasis === "no_documented_full_text_rights" &&
      meta.kind !== "talk"
    ) {
      let firstDraft;
      try {
        firstDraft = await generateSourceFirstDraft({
          sourceId: result.source.id,
          title: result.source.title,
        });
      } catch {
        firstDraft = {
          answer: `What does “${result.source.title}” suggest?`,
          interpretation:
            "Palonur could not create a first draft from this upload. A steward can write an original interpretation during review.",
          usedChunks: 0,
          chunks: [],
        };
      }
      const [created] = await db
        .insert(interpretationsTable)
        .values({
          sourceId: result.source.id,
          pillarId,
          authorId: null,
          origin: "palonur_ai",
          draftedAt: new Date(),
          status: "proposed",
          answer: firstDraft.answer,
          interpretation: firstDraft.interpretation || "A steward must write an original interpretation before approval.",
          aiDraft: firstDraft.interpretation || null,
        })
        .returning({ id: interpretationsTable.id });
      await db.insert(sourceAuditLogTable).values({
        sourceId: result.source.id,
        actorUserId: null,
        action: "palonur_first_draft_created",
        note: "Private Palonur/AI first draft created; pending steward review.",
      });
      result.firstDraftId = created!.id;
    }
    // Topic-fit guardrail: score the new document against its pillar's
    // topic anchor and flag (never block) apparent off-topic uploads. The
    // document embedding reuses the chunk embeddings we just computed —
    // no extra embed call. Strictly best-effort: any failure here must
    // never fail an already-committed ingest.
    try {
      const docEmbedding = meanVector(embeddings);
      if (docEmbedding) {
        const fit = await computeTopicFit(
          pillarId,
          docEmbedding,
          result.source.id,
        );
        if (fit) await persistTopicFit(result.source.id, fit);
      }
    } catch {
      // Observe-and-flag only — swallow scoring errors.
    }
    // Append-only corpus manifest: snapshot when approved content changed
    // (cheap no-op otherwise). Best-effort — never fails a committed ingest.
    scheduleManifestSnapshot("ingest");
    return result;
  });
}
