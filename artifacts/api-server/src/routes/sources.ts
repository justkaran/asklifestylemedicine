import { Router, type IRouter, type Response } from "express";
import multer from "multer";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { scheduleManifestSnapshot } from "../lib/ipProtection.js";
import { z } from "zod/v4";
import {
  db,
  sourcesTable,
  sourceChunksTable,
  sourceAuditLogTable,
  interpretationsTable,
  facultyUsersTable,
  researchDiscoveryCandidatesTable,
  STUDY_DESIGN_VALUES,
  scoreRubric,
  normalizeRubric,
  canonicalizeRubric,
  type SourceStatus,
  type SourceRightsBasis,
  type ReliabilityRubric,
} from "@workspace/db";
import {
  requireFacultyAuth,
  requirePillarRole,
  type FacultyRequest,
} from "../middlewares/facultyAuth.js";
import { ingestSource } from "../lib/ingestSource.js";
import {
  generateSourceAssessmentDraft,
  isAssessmentAiConfigured,
} from "../lib/scoreSource.js";
import {
  findUnassessedApprovedSources,
  runPillarAssessmentDrafts,
} from "../lib/batchAssessSources.js";
import { scoreDraftAcceptance } from "../lib/draftSimilarity.js";
import { purgeUnlicensedSourceMaterialInTransaction } from "../lib/sourceRetention.js";
import {
  hasDraftableSourceMaterial,
  hasReadableSourceMaterial,
  retentionForRightsBasis,
} from "../lib/sourceRetention.js";

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB cap for v1
});

const SOURCE_KINDS = ["paper", "slm_article", "talk", "note"] as const;
const RIGHTS_BASIS_VALUES = [
  "open_license",
  "permission",
  "public_domain",
  "no_documented_full_text_rights",
] as const satisfies readonly SourceRightsBasis[];
const STATUS_VALUES = [
  "draft",
  "in_review",
  "approved",
  "archived",
] as const satisfies readonly SourceStatus[];

const ingestBodySchema = z.object({
  kind: z.enum(SOURCE_KINDS).default("paper"),
  title: z.string().min(1).max(1000).optional(),
  authors: z.string().max(2000).optional(),
  year: z.coerce.number().int().min(1800).max(2200).optional(),
  journal: z.string().max(500).optional(),
  doi: z.string().max(500).optional(),
  abstract: z.string().max(20000).optional(),
  sourceUrl: z.string().url().max(2000).optional(),
  /** Controlled-vocabulary study type. Empty string (unselected dropdown)
   * is coerced to undefined so it persists as NULL. */
  studyDesign: z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    z.enum(STUDY_DESIGN_VALUES).optional(),
  ),
  rightsBasis: z.enum(RIGHTS_BASIS_VALUES),
  /** When no PDF is attached, the caller must supply text. */
  text: z.string().max(2_000_000).optional(),
});

const transitionSchema = z.object({
  status: z.enum(STATUS_VALUES),
  note: z.string().max(2000).optional(),
});

/** Focused metadata edit: change/clear study type without re-ingesting.
 * `null` (or empty string) clears it back to NULL. */
const studyDesignSchema = z.object({
  studyDesign: z.preprocess(
    (v) => (v === "" ? null : v),
    z.enum(STUDY_DESIGN_VALUES).nullable(),
  ),
});

const rightsSchema = z.object({
  rightsBasis: z.enum(RIGHTS_BASIS_VALUES),
});

const excludeDiscoveredSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

const DISCOVERY_SOURCE_STATUSES = [
  "review",
  "ingested",
  "auto_approved",
] as const;

/** Save (draft) or approve a reliability assessment. The `rubric` is
 * coerced server-side via `normalizeRubric`, so we accept loose JSON here;
 * the numeric scores are ALWAYS recomputed from the item answers and never
 * read from the client. Saving with `status: "approved"` IS the approval. */
const assessmentSchema = z.object({
  rubric: z.unknown(),
  status: z.enum(["draft", "approved"]),
});

/** Optional body for the AI draft route. When `axis` is supplied, only that
 * one axis is re-drafted and merged into the existing rubric; the steward's
 * work on the other two axes is preserved. Omit `axis` to draft all three.
 * The literals mirror RELIABILITY_AXIS_KEYS from `@workspace/db`. */
const draftAxisSchema = z.object({
  axis: z.enum(["rigor", "reproducibility", "openness"]).optional(),
});

/** Allowed status transitions per role. Steward can do anything. */
function isAllowedTransition(
  from: SourceStatus,
  to: SourceStatus,
  role: "steward" | "contributor" | "advisor" | "viewer" | null | undefined,
): boolean {
  if (role === "steward") return true;
  if (role === "contributor") {
    if (from === "draft" && to === "in_review") return true;
    if (from === "in_review" && to === "draft") return true;
  }
  return false;
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  // pdf-parse is a CJS module; externalized in build.mjs so its top-level
  // debug shim doesn't run inside esbuild's bundle.
  const mod: unknown = await import("pdf-parse");
  const fn = (
    mod as { default?: (b: Buffer) => Promise<{ text: string }> }
  ).default;
  if (!fn) throw new Error("pdf-parse default export missing");
  const result = await fn(buffer);
  return result.text ?? "";
}

/**
 * GET /api/faculty/pillars/:slug/sources — list sources in a pillar,
 * filterable by status. Members of the pillar can list.
 */
router.get(
  "/faculty/pillars/:slug/sources",
  requireFacultyAuth,
  requirePillarRole({ slugParam: "slug" }, [
    "steward",
    "contributor",
    "viewer",
  ]),
  async (req: FacultyRequest, res: Response): Promise<void> => {
    const pillar = req.pillar!;
    const statusParam = req.query.status;
    const statusFilter =
      typeof statusParam === "string" &&
      (STATUS_VALUES as readonly string[]).includes(statusParam)
        ? (statusParam as SourceStatus)
        : undefined;

    // Synthetic canary documents (IP protection) never appear in steward
    // review queues — they are machine-facing registry rows, not science.
    const baseWhere = statusFilter
      ? and(
          eq(sourcesTable.pillarId, pillar.id),
          eq(sourcesTable.status, statusFilter),
          eq(sourcesTable.isCanary, false),
        )
      : and(
          eq(sourcesTable.pillarId, pillar.id),
          eq(sourcesTable.isCanary, false),
        );
    const where =
      statusFilter === "archived"
        ? baseWhere
        : and(
            baseWhere,
            isNull(researchDiscoveryCandidatesTable.excludedAt),
          );

    const rows = await db
      .select({
        id: sourcesTable.id,
        kind: sourcesTable.kind,
        title: sourcesTable.title,
        authors: sourcesTable.authors,
        year: sourcesTable.year,
        journal: sourcesTable.journal,
        doi: sourcesTable.doi,
        sourceUrl: sourcesTable.sourceUrl,
        studyDesign: sourcesTable.studyDesign,
        rightsBasis: sourcesTable.rightsBasis,
        retentionStatus: sourcesTable.retentionStatus,
        rightsRecordedAt: sourcesTable.rightsRecordedAt,
        purgedAt: sourcesTable.purgedAt,
        status: sourcesTable.status,
        version: sourcesTable.version,
        assessmentStatus: sourcesTable.assessmentStatus,
        rigorScore: sourcesTable.rigorScore,
        reproducibilityScore: sourcesTable.reproducibilityScore,
        opennessScore: sourcesTable.opennessScore,
        createdAt: sourcesTable.createdAt,
        updatedAt: sourcesTable.updatedAt,
        automaticallyDiscovered: sql<boolean>`${researchDiscoveryCandidatesTable.id} IS NOT NULL`,
        excluded: sql<boolean>`${researchDiscoveryCandidatesTable.excludedAt} IS NOT NULL`,
        excludedAt: researchDiscoveryCandidatesTable.excludedAt,
        exclusionReason: researchDiscoveryCandidatesTable.exclusionReason,
      })
      .from(sourcesTable)
      .leftJoin(
        researchDiscoveryCandidatesTable,
        and(
          eq(researchDiscoveryCandidatesTable.sourceId, sourcesTable.id),
          eq(researchDiscoveryCandidatesTable.pillarId, pillar.id),
          inArray(
            researchDiscoveryCandidatesTable.status,
            DISCOVERY_SOURCE_STATUSES,
          ),
        ),
      )
      .where(where)
      .orderBy(desc(sourcesTable.updatedAt));
    res.json({ sources: rows });
  },
);

/**
 * Exclude an automatically-discovered source from the pillar corpus.
 * The candidate row is retained permanently so later discovery runs continue
 * to suppress the same provider record/DOI.
 */
router.post(
  "/faculty/pillars/:slug/sources/:id/exclude",
  requireFacultyAuth,
  requirePillarRole({ slugParam: "slug" }, ["steward"]),
  async (req: FacultyRequest, res: Response): Promise<void> => {
    const ctx = req.faculty!;
    const pillar = req.pillar!;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsed = excludeDiscoveredSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const result = await db.transaction(async (tx) => {
      const [source] = await tx
        .select()
        .from(sourcesTable)
        .where(
          and(
            eq(sourcesTable.id, id),
            eq(sourcesTable.pillarId, pillar.id),
            eq(sourcesTable.isCanary, false),
          ),
        )
        .limit(1);
      if (!source) return { kind: "missing" as const };

      const [candidate] = await tx
        .select()
        .from(researchDiscoveryCandidatesTable)
        .where(
          and(
            eq(researchDiscoveryCandidatesTable.sourceId, source.id),
            eq(researchDiscoveryCandidatesTable.pillarId, pillar.id),
            inArray(
              researchDiscoveryCandidatesTable.status,
              DISCOVERY_SOURCE_STATUSES,
            ),
          ),
        )
        .limit(1);
      if (!candidate) return { kind: "not-discovered" as const };
      if (candidate.excludedAt) {
        return {
          kind: "ok" as const,
          source,
          candidate,
          unchanged: true,
          purged: false,
          wasApproved: false,
        };
      }

      const excludedAt = new Date();
      const [updatedCandidate] = await tx
        .update(researchDiscoveryCandidatesTable)
        .set({
          excludedAt,
          excludedByUserId: ctx.user.id,
          exclusionReason: parsed.data.reason || null,
        })
        .where(
          and(
            eq(researchDiscoveryCandidatesTable.id, candidate.id),
            isNull(researchDiscoveryCandidatesTable.excludedAt),
          ),
        )
        .returning();
      // A concurrent identical request won the exclusion update. Treat this as
      // the same idempotent success and do not duplicate audit/purge work.
      if (!updatedCandidate) {
        const [current] = await tx
          .select()
          .from(researchDiscoveryCandidatesTable)
          .where(eq(researchDiscoveryCandidatesTable.id, candidate.id))
          .limit(1);
        const [currentSource] = await tx
          .select()
          .from(sourcesTable)
          .where(eq(sourcesTable.id, source.id))
          .limit(1);
        return {
          kind: "ok" as const,
          source: currentSource!,
          candidate: current!,
          unchanged: true,
          purged: false,
          wasApproved: false,
        };
      }
      const [updatedSource] = await tx
        .update(sourcesTable)
        .set({ status: "archived" })
        .where(eq(sourcesTable.id, source.id))
        .returning();
      await tx.insert(sourceAuditLogTable).values({
        sourceId: source.id,
        actorUserId: ctx.user.id,
        action: "discovery_excluded",
        fromStatus: source.status,
        toStatus: "archived",
        note: parsed.data.reason
          ? `Discovered work excluded: ${parsed.data.reason}`
          : "Discovered work excluded.",
      });
      const purge =
        source.rightsBasis === "no_documented_full_text_rights"
          ? await purgeUnlicensedSourceMaterialInTransaction(tx, {
              sourceId: source.id,
              actorUserId: ctx.user.id,
              reason: "source_archived",
            })
          : { purged: false, retainedApprovedInterpretationIds: [] };
      return {
        kind: "ok" as const,
        source: updatedSource!,
        candidate: updatedCandidate!,
        unchanged: false,
        purged: purge.purged,
        wasApproved: source.status === "approved",
      };
    });

    if (result.kind === "missing") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (result.kind === "not-discovered") {
      res.status(409).json({
        error: "Only automatically discovered sources can be excluded.",
      });
      return;
    }
    if (!result.unchanged && result.wasApproved) {
      scheduleManifestSnapshot("discovery-excluded");
    }
    res.json({
      id: result.source.id,
      status: result.source.status,
      automaticallyDiscovered: true,
      excluded: true,
      excludedAt: result.candidate.excludedAt,
      exclusionReason: result.candidate.exclusionReason,
      unchanged: result.unchanged,
      purged: result.purged,
    });
  },
);

/**
 * POST /api/faculty/pillars/:slug/sources — ingest a new source.
 * Accepts multipart with optional `file` (PDF) and JSON metadata fields,
 * or JSON body with `text`. Contributor or steward role required.
 */
router.post(
  "/faculty/pillars/:slug/sources",
  requireFacultyAuth,
  requirePillarRole({ slugParam: "slug" }, ["steward", "contributor"]),
  upload.single("file"),
  async (req: FacultyRequest, res: Response): Promise<void> => {
    const ctx = req.faculty!;
    const pillar = req.pillar!;

    // Multer/multipart fields arrive as strings. Coerce known numeric
    // fields before parsing so zod's `.coerce.number()` works on plain
    // JSON too.
    const raw: Record<string, unknown> = { ...(req.body ?? {}) };
    const parsed = ingestBodySchema.safeParse(raw);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const body = parsed.data;
    let fullText = "";
    let fallbackTitle = "Untitled source";
    try {
      if (req.file) {
        if (req.file.mimetype !== "application/pdf") {
          res.status(400).json({ error: "Only PDF uploads are supported" });
          return;
        }
        fullText = await extractPdfText(req.file.buffer);
        fallbackTitle =
          req.file.originalname.replace(/\.pdf$/i, "") || fallbackTitle;
      } else if (body.text) {
        fullText = body.text;
        fallbackTitle = body.title ?? fallbackTitle;
      } else if (body.abstract) {
        // No file, no body text — fall back to abstract so DOI-only entries
        // still get embedded into searchable chunks.
        fullText = body.abstract;
        fallbackTitle = body.title ?? fallbackTitle;
      } else {
        res
          .status(400)
          .json({ error: "Provide a PDF file, `text`, or `abstract`" });
        return;
      }
    } catch (e) {
      // Do not attach parser errors: some libraries embed document excerpts in
      // their error strings, and upload bytes are never retained in logs.
      req.log.error("PDF text extraction failed");
      res.status(400).json({ error: "Failed to extract text from PDF" });
      return;
    }

    try {
      const result = await ingestSource({
        pillarId: pillar.id,
        uploadedByUserId: ctx.user.id,
        meta: {
          kind: body.kind,
          title: body.title,
          authors: body.authors ?? null,
          year: body.year ?? null,
          journal: body.journal ?? null,
          doi: body.doi ?? null,
          abstract: body.abstract ?? null,
          sourceUrl: body.sourceUrl ?? null,
          studyDesign: body.studyDesign ?? null,
          rightsBasis: body.rightsBasis,
        },
        fullText,
        fallbackTitle,
        detachResearchDiscoveryCandidates: true,
      });
      res.status(201).json({
        id: result.source.id,
        title: result.source.title,
        status: result.source.status,
        version: result.source.version,
        chunkCount: result.chunkCount,
        embeddedCount: result.embeddedCount,
        charCount: result.charCount,
        versioned: result.versioned,
        rightsBasis: result.source.rightsBasis,
        retentionStatus: result.source.retentionStatus,
        firstDraftId: result.firstDraftId,
      });
    } catch (e) {
      req.log.error({ err: e }, "Source ingestion failed");
      const msg = e instanceof Error ? e.message : "Ingestion failed";
      res.status(500).json({ error: msg });
    }
  },
);

/**
 * POST /api/faculty/pillars/:slug/sources/assessments/batch-draft — draft AI
 * reliability assessments for EVERY approved source in the pillar that has no
 * assessment yet, in one steward action, so a steward can review a draft queue
 * instead of opening each source. Steward-only.
 *
 * There is no job queue in this codebase, so (like the talk crawl) the drafting
 * runs in the BACKGROUND: the route returns the candidate count immediately and
 * the library's "Drafts" queue fills in as the worker progresses. Each result
 * lands in `draft` status for per-source steward review — nothing is ever
 * auto-published. Idempotent: re-running only picks up sources still unassessed.
 */
router.post(
  "/faculty/pillars/:slug/sources/assessments/batch-draft",
  requireFacultyAuth,
  requirePillarRole({ slugParam: "slug" }, ["steward"]),
  async (req: FacultyRequest, res: Response): Promise<void> => {
    const ctx = req.faculty!;
    const pillar = req.pillar!;

    const candidates = await findUnassessedApprovedSources(pillar.id);
    if (candidates.length === 0) {
      res.json({ candidates: 0, queued: 0, generated: true });
      return;
    }
    // Tell the steward up front when the AI scorer is unavailable rather than
    // queueing background work that would silently produce nothing.
    if (!isAssessmentAiConfigured()) {
      res.json({ candidates: candidates.length, queued: 0, generated: false });
      return;
    }

    void runPillarAssessmentDrafts({
      pillarId: pillar.id,
      actorUserId: ctx.user.id,
      candidates,
    }).catch((err) => {
      req.log.error(
        { err, pillarId: pillar.id },
        "Batch reliability drafting crashed",
      );
    });

    res
      .status(202)
      .json({ candidates: candidates.length, queued: candidates.length, generated: true });
  },
);

/**
 * GET /api/faculty/pillars/:slug/sources/:id — full source detail with
 * chunk previews (text only, never embeddings).
 */
router.get(
  "/faculty/pillars/:slug/sources/:id",
  requireFacultyAuth,
  requirePillarRole({ slugParam: "slug" }, [
    "steward",
    "contributor",
    "viewer",
  ]),
  async (req: FacultyRequest, res: Response): Promise<void> => {
    const pillar = req.pillar!;
    const rawId = req.params.id;
    const id = parseInt(Array.isArray(rawId) ? rawId[0] : (rawId ?? ""), 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [source] = await db
      .select()
      .from(sourcesTable)
      .where(and(eq(sourcesTable.id, id), eq(sourcesTable.pillarId, pillar.id), eq(sourcesTable.isCanary, false)))
      .limit(1);
    if (!source) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    // The retention state is authoritative even if a legacy/interrupted worker
    // left a stale chunk behind. Purged paper passages must never cross this
    // review-only API boundary.
    const reviewPassagesAvailable = hasDraftableSourceMaterial(
      source.retentionStatus,
    );
    const chunks = reviewPassagesAvailable
      ? await db
          .select({
            id: sourceChunksTable.id,
            chunkIndex: sourceChunksTable.chunkIndex,
            text: sourceChunksTable.text,
            page: sourceChunksTable.page,
            section: sourceChunksTable.section,
          })
          .from(sourceChunksTable)
          .where(eq(sourceChunksTable.sourceId, source.id))
          .orderBy(sourceChunksTable.chunkIndex)
      : [];
    const audit = await db
      .select()
      .from(sourceAuditLogTable)
      .where(eq(sourceAuditLogTable.sourceId, source.id))
      .orderBy(desc(sourceAuditLogTable.createdAt));
    res.json({
      source: {
        id: source.id,
        kind: source.kind,
        title: source.title,
        authors: source.authors,
        year: source.year,
        journal: source.journal,
        doi: source.doi,
        abstract: reviewPassagesAvailable ? source.abstract : null,
        fullText: reviewPassagesAvailable ? source.fullText : null,
        sourceUrl: source.sourceUrl,
        studyDesign: source.studyDesign,
        rightsBasis: source.rightsBasis,
        retentionStatus: source.retentionStatus,
        rightsRecordedAt: source.rightsRecordedAt,
        purgedAt: source.purgedAt,
        status: source.status,
        version: source.version,
        assessmentStatus: source.assessmentStatus,
        rigorScore: source.rigorScore,
        reproducibilityScore: source.reproducibilityScore,
        opennessScore: source.opennessScore,
        createdAt: source.createdAt,
        updatedAt: source.updatedAt,
      },
      chunkCount: chunks.length,
      chunks: chunks.slice(0, 50),
      reviewPassagesAvailable,
      audit,
      role: req.pillarRole,
    });
  },
);

/**
 * POST /api/faculty/pillars/:slug/sources/:id/transition — move a source
 * along the status workflow. Role-gated.
 */
router.post(
  "/faculty/pillars/:slug/sources/:id/transition",
  requireFacultyAuth,
  requirePillarRole({ slugParam: "slug" }, ["steward", "contributor"]),
  async (req: FacultyRequest, res: Response): Promise<void> => {
    const ctx = req.faculty!;
    const pillar = req.pillar!;
    const rawId = req.params.id;
    const id = parseInt(Array.isArray(rawId) ? rawId[0] : (rawId ?? ""), 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsed = transitionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { status: toStatus, note } = parsed.data;

    const [source] = await db
      .select()
      .from(sourcesTable)
      .where(and(eq(sourcesTable.id, id), eq(sourcesTable.pillarId, pillar.id), eq(sourcesTable.isCanary, false)))
      .limit(1);
    if (!source) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const role = req.pillarRole;
    if (!isAllowedTransition(source.status, toStatus, role)) {
      res.status(403).json({
        error: `Role '${role}' cannot transition ${source.status} → ${toStatus}`,
      });
      return;
    }
    if (
      source.retentionStatus === "purged_no_full_text_rights" &&
      (toStatus === "draft" || toStatus === "in_review")
    ) {
      res.status(409).json({
        error:
          "This source's material was purged under its rights setting. Re-upload it to begin another review window.",
      });
      return;
    }
    if (!source.rightsBasis && toStatus === "approved") {
      res.status(409).json({
        error:
          "Record the full-text rights basis before approving this source.",
      });
      return;
    }
    if (
      source.rightsBasis === "no_documented_full_text_rights" &&
      toStatus === "approved"
    ) {
      const [approvedInterpretation] = await db
        .select({ id: interpretationsTable.id })
        .from(interpretationsTable)
        .where(
          and(
            eq(interpretationsTable.sourceId, source.id),
            eq(interpretationsTable.status, "approved"),
          ),
        )
        .limit(1);
      if (!approvedInterpretation) {
        res.status(409).json({
          error:
            "Approve a steward-reviewed original interpretation before approving this no-rights source; the paper passages will then be purged.",
        });
        return;
      }
    }
    if (source.status === toStatus) {
      res.json({ id: source.id, status: source.status, unchanged: true });
      return;
    }

    const { updated, purge } = await db.transaction(async (tx) => {
      const [u] = await tx
        .update(sourcesTable)
        .set({ status: toStatus })
        .where(eq(sourcesTable.id, source.id))
        .returning();
      await tx.insert(sourceAuditLogTable).values({
        sourceId: source.id,
        actorUserId: ctx.user.id,
        action: "status_change",
        fromStatus: source.status,
        toStatus,
        note: note ?? null,
      });
      const purge =
        source.rightsBasis === "no_documented_full_text_rights" &&
        (toStatus === "approved" || toStatus === "archived")
          ? await purgeUnlicensedSourceMaterialInTransaction(tx, {
              sourceId: source.id,
              actorUserId: ctx.user.id,
              reason:
                toStatus === "approved" ? "source_approved" : "source_archived",
            })
          : { purged: false, retainedApprovedInterpretationIds: [] };
      return { updated: u!, purge };
    });
    // Approved-corpus membership changed → append-only manifest snapshot
    // (best-effort, never blocks the response).
    if (source.status === "approved" || toStatus === "approved") {
      scheduleManifestSnapshot("status-change");
    }
    res.json({
      id: updated.id,
      status: updated.status,
      retentionStatus: purge.purged
        ? "purged_no_full_text_rights"
        : updated.retentionStatus,
      purged: purge.purged,
    });
  },
);

/**
 * Record or correct the rights basis on an existing source. This is the
 * faculty-admin conversion path for material that predates rights-aware
 * ingestion. A final no-rights source is purged immediately.
 */
router.patch(
  "/faculty/pillars/:slug/sources/:id/rights",
  requireFacultyAuth,
  requirePillarRole({ slugParam: "slug" }, ["steward"]),
  async (req: FacultyRequest, res: Response): Promise<void> => {
    const ctx = req.faculty!;
    const pillar = req.pillar!;
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsed = rightsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const source = await loadPillarSource(id, pillar.id);
    if (!source) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (source.retentionStatus === "purged_no_full_text_rights") {
      res.status(409).json({
        error: "A purged source cannot be reclassified without a fresh upload.",
      });
      return;
    }

    const retentionStatus = retentionForRightsBasis(parsed.data.rightsBasis);
    const { updated, purge } = await db.transaction(async (tx) => {
      const [u] = await tx
        .update(sourcesTable)
        .set({
          rightsBasis: parsed.data.rightsBasis,
          retentionStatus,
          rightsRecordedByUserId: ctx.user.id,
          rightsRecordedAt: new Date(),
        })
        .where(eq(sourcesTable.id, source.id))
        .returning();
      await tx.insert(sourceAuditLogTable).values({
        sourceId: source.id,
        actorUserId: ctx.user.id,
        action: "rights_recorded",
        note: `Rights basis recorded: ${parsed.data.rightsBasis}; retention: ${retentionStatus}.`,
      });
      const purge =
        parsed.data.rightsBasis === "no_documented_full_text_rights" &&
        (source.status === "approved" || source.status === "archived")
          ? await purgeUnlicensedSourceMaterialInTransaction(tx, {
              sourceId: source.id,
              actorUserId: ctx.user.id,
              reason: "rights_conversion",
            })
          : { purged: false, retainedApprovedInterpretationIds: [] };
      return { updated: u!, purge };
    });
    res.json({
      id: updated.id,
      rightsBasis: updated.rightsBasis,
      retentionStatus: purge.purged
        ? "purged_no_full_text_rights"
        : updated.retentionStatus,
      purged: purge.purged,
    });
  },
);

/**
 * PATCH /api/faculty/pillars/:slug/sources/:id/study-design — change or
 * clear a source's study type in place, without re-uploading or bumping the
 * version. Steward-only. Passing `null`/empty clears it back to NULL.
 */
router.patch(
  "/faculty/pillars/:slug/sources/:id/study-design",
  requireFacultyAuth,
  requirePillarRole({ slugParam: "slug" }, ["steward"]),
  async (req: FacultyRequest, res: Response): Promise<void> => {
    const ctx = req.faculty!;
    const pillar = req.pillar!;
    const rawId = req.params.id;
    const id = parseInt(Array.isArray(rawId) ? rawId[0] : (rawId ?? ""), 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsed = studyDesignSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const nextStudyDesign = parsed.data.studyDesign;

    const [source] = await db
      .select()
      .from(sourcesTable)
      .where(and(eq(sourcesTable.id, id), eq(sourcesTable.pillarId, pillar.id), eq(sourcesTable.isCanary, false)))
      .limit(1);
    if (!source) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    if ((source.studyDesign ?? null) === nextStudyDesign) {
      res.json({
        id: source.id,
        studyDesign: source.studyDesign,
        unchanged: true,
      });
      return;
    }

    const updated = await db.transaction(async (tx) => {
      const [u] = await tx
        .update(sourcesTable)
        .set({ studyDesign: nextStudyDesign })
        .where(eq(sourcesTable.id, source.id))
        .returning();
      await tx.insert(sourceAuditLogTable).values({
        sourceId: source.id,
        actorUserId: ctx.user.id,
        action: "study_design_change",
        note: `${source.studyDesign ?? "—"} → ${nextStudyDesign ?? "—"}`,
      });
      return u;
    });
    res.json({ id: updated.id, studyDesign: updated.studyDesign });
  },
);

type SourceRow = typeof sourcesTable.$inferSelect;

/**
 * Shared serializer for the faculty-facing assessment view. Returns the
 * working rubric (draft or approved), server-recomputed per-axis scores, the
 * frozen AI baseline, the acceptance bucket, and the approval stamp. The
 * steward name is included here because this is the FACULTY surface; it is
 * never threaded into the consumer provenance (see rag.ts `reliability`).
 */
async function buildAssessmentResponse(source: SourceRow, role: string | null) {
  const rubric: ReliabilityRubric | null = source.assessmentRubric ?? null;
  const scores = rubric ? scoreRubric(rubric) : null;
  let assessedByName: string | null = null;
  if (source.assessedByUserId != null) {
    const [u] = await db
      .select({ fullName: facultyUsersTable.fullName })
      .from(facultyUsersTable)
      .where(eq(facultyUsersTable.id, source.assessedByUserId))
      .limit(1);
    assessedByName = u?.fullName ?? null;
  }
  return {
    assessmentStatus: source.assessmentStatus ?? null,
    rubric,
    scores,
    aiDraft: source.assessmentAiDraft ?? null,
    aiAcceptance: source.assessmentAiAcceptance ?? null,
    assessedAt: source.assessedAt,
    assessedByName,
    canEdit: role === "steward",
  };
}

async function loadPillarSource(
  id: number,
  pillarId: number,
): Promise<SourceRow | null> {
  const [source] = await db
    .select()
    .from(sourcesTable)
    .where(and(eq(sourcesTable.id, id), eq(sourcesTable.pillarId, pillarId), eq(sourcesTable.isCanary, false)))
    .limit(1);
  return source ?? null;
}

function fmtScore(s: { score: number | null }): string {
  return s.score == null ? "n/a" : `${s.score}%`;
}

/**
 * GET /api/faculty/pillars/:slug/sources/:id/assessment — current three-axis
 * reliability assessment. Any pillar member may view.
 */
router.get(
  "/faculty/pillars/:slug/sources/:id/assessment",
  requireFacultyAuth,
  requirePillarRole({ slugParam: "slug" }, [
    "steward",
    "contributor",
    "viewer",
  ]),
  async (req: FacultyRequest, res: Response): Promise<void> => {
    const pillar = req.pillar!;
    const rawId = req.params.id;
    const id = parseInt(Array.isArray(rawId) ? rawId[0] : (rawId ?? ""), 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const source = await loadPillarSource(id, pillar.id);
    if (!source) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(await buildAssessmentResponse(source, req.pillarRole ?? null));
  },
);

/**
 * POST /api/faculty/pillars/:slug/sources/:id/assessment/draft — generate an
 * AI first-pass reliability draft. Steward-only. Persists the draft as the
 * working rubric (status 'draft') and freezes it as the AI baseline used to
 * measure steward edits at approval time. Degrades to the current (possibly
 * empty) assessment with `generated: false` when the AI is unavailable, so
 * the steward can still assess by hand.
 */
router.post(
  "/faculty/pillars/:slug/sources/:id/assessment/draft",
  requireFacultyAuth,
  requirePillarRole({ slugParam: "slug" }, ["steward"]),
  async (req: FacultyRequest, res: Response): Promise<void> => {
    const ctx = req.faculty!;
    const pillar = req.pillar!;
    const rawId = req.params.id;
    const id = parseInt(Array.isArray(rawId) ? rawId[0] : (rawId ?? ""), 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsedBody = draftAxisSchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      res.status(400).json({ error: parsedBody.error.message });
      return;
    }
    const onlyAxis = parsedBody.data.axis ?? null;

    const source = await loadPillarSource(id, pillar.id);
    if (!source) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!hasDraftableSourceMaterial(source.retentionStatus)) {
      res.status(source.retentionStatus === "purged_no_full_text_rights" ? 410 : 409).json({
        error:
          "Source passages are unavailable until a rights basis is recorded, or after rights-limited material has been purged.",
      });
      return;
    }

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
      res.json({
        generated: false,
        axis: onlyAxis,
        ...(await buildAssessmentResponse(source, req.pillarRole ?? null)),
      });
      return;
    }

    // For a single-axis recalculation, merge only that axis's freshly drafted
    // answers into the existing rubric so the steward's hand-graded work on the
    // other two axes survives. The AI baseline (used to score draft acceptance
    // at approval) is merged the same way. A full draft replaces everything.
    let rubric: ReliabilityRubric;
    let aiBaseline: ReliabilityRubric;
    if (onlyAxis) {
      const current = normalizeRubric(source.assessmentRubric ?? null);
      rubric = normalizeRubric({ ...current, [onlyAxis]: draft.rubric[onlyAxis] });
      const priorBaseline = source.assessmentAiDraft ?? source.assessmentRubric;
      aiBaseline = normalizeRubric({
        ...normalizeRubric(priorBaseline ?? null),
        [onlyAxis]: draft.rubric[onlyAxis],
      });
    } else {
      rubric = draft.rubric;
      aiBaseline = draft.rubric;
    }

    const scores = scoreRubric(rubric);
    const updated = await db.transaction(async (tx) => {
      const [u] = await tx
        .update(sourcesTable)
        .set({
          assessmentRubric: rubric,
          assessmentAiDraft: aiBaseline,
          assessmentStatus: "draft",
          rigorScore: scores.rigor.score,
          reproducibilityScore: scores.reproducibility.score,
          opennessScore: scores.openness.score,
          // A fresh AI draft is never auto-approved; clear any prior approval
          // so the public badge drops until a steward re-approves. This also
          // applies to a single-axis recalc: changing one axis pulls the whole
          // assessment back to draft and requires a re-publish.
          assessedByUserId: null,
          assessedAt: null,
          assessmentAiAcceptance: null,
        })
        .where(eq(sourcesTable.id, source.id))
        .returning();
      await tx.insert(sourceAuditLogTable).values({
        sourceId: source.id,
        actorUserId: ctx.user.id,
        action: "assessment_draft",
        note: onlyAxis
          ? `AI ${onlyAxis} draft regenerated`
          : "AI reliability draft generated",
      });
      return u;
    });
    res.json({
      generated: true,
      axis: onlyAxis,
      ...(await buildAssessmentResponse(updated, req.pillarRole ?? null)),
    });
  },
);

/**
 * PUT /api/faculty/pillars/:slug/sources/:id/assessment — save (draft) or
 * approve a reliability assessment. Steward-only. The rubric is normalized
 * server-side and the numeric scores are ALWAYS recomputed from the item
 * answers (never trusted from the client or the AI). Saving with
 * `status: "approved"` IS the approval: it stamps the steward + time, records
 * the AI-acceptance bucket, and (via rag.ts gating) turns on the public
 * badge. Re-saving an approved assessment as `draft` clears the approval and
 * pulls the public badge until re-approved.
 */
router.put(
  "/faculty/pillars/:slug/sources/:id/assessment",
  requireFacultyAuth,
  requirePillarRole({ slugParam: "slug" }, ["steward"]),
  async (req: FacultyRequest, res: Response): Promise<void> => {
    const ctx = req.faculty!;
    const pillar = req.pillar!;
    const rawId = req.params.id;
    const id = parseInt(Array.isArray(rawId) ? rawId[0] : (rawId ?? ""), 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsed = assessmentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const source = await loadPillarSource(id, pillar.id);
    if (!source) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const rubric = normalizeRubric(parsed.data.rubric);
    const scores = scoreRubric(rubric);
    const toStatus = parsed.data.status;
    const note = `rigor ${fmtScore(scores.rigor)}, reproducibility ${fmtScore(
      scores.reproducibility,
    )}, openness ${fmtScore(scores.openness)}`;

    const updated = await db.transaction(async (tx) => {
      if (toStatus === "approved") {
        const aiDraft: ReliabilityRubric | null = source.assessmentAiDraft ?? null;
        const acceptance = scoreDraftAcceptance(
          aiDraft ? canonicalizeRubric(aiDraft) : null,
          canonicalizeRubric(rubric),
        ).acceptance;
        const [u] = await tx
          .update(sourcesTable)
          .set({
            assessmentRubric: rubric,
            assessmentStatus: "approved",
            rigorScore: scores.rigor.score,
            reproducibilityScore: scores.reproducibility.score,
            opennessScore: scores.openness.score,
            assessedByUserId: ctx.user.id,
            assessedAt: new Date(),
            assessmentAiAcceptance: acceptance,
          })
          .where(eq(sourcesTable.id, source.id))
          .returning();
        await tx.insert(sourceAuditLogTable).values({
          sourceId: source.id,
          actorUserId: ctx.user.id,
          action: "assessment_approved",
          note,
        });
        return u;
      }
      const [u] = await tx
        .update(sourcesTable)
        .set({
          assessmentRubric: rubric,
          assessmentStatus: "draft",
          rigorScore: scores.rigor.score,
          reproducibilityScore: scores.reproducibility.score,
          opennessScore: scores.openness.score,
          // Saving as draft un-approves: never leave a stale public badge up.
          assessedByUserId: null,
          assessedAt: null,
          assessmentAiAcceptance: null,
        })
        .where(eq(sourcesTable.id, source.id))
        .returning();
      await tx.insert(sourceAuditLogTable).values({
        sourceId: source.id,
        actorUserId: ctx.user.id,
        action: "assessment_save",
        note,
      });
      return u;
    });
    res.json(await buildAssessmentResponse(updated, req.pillarRole ?? null));
  },
);

export default router;
