/**
 * CVO Release Governance routes.
 *
 * Endpoints live at /decision-room/{mode}/... where mode is "test" or "live".
 * Mode is a required path segment on every operation; a request in one mode
 * cannot read or mutate the other mode.
 *
 * Semantic column mapping (API <-> DB):
 *   publicGuidance           <- question
 *   intendedAudience         <- context
 *   sourceAndProvenanceNotes <- own_view
 *   scopeLimits              <- final_call
 *   recoursePath             <- outcome
 *
 * Status values (API/DB): draft | in_review | ready | published | withdrawn
 *   Legacy statuses (framing|consulting|deciding|decided) belong to the old
 *   decision-room sub-system and are never created or returned here.
 *
 * Access guard: platform admins (CVO) OR faculty users with at least one
 * membership.  Only platform admins can verify, publish, or withdraw.
 * Faculty signoff uses the current signed-in faculty identity.
 *
 * Body parsing: all incoming bodies are validated with Zod schemas
 * (generated from the OpenAPI spec via @workspace/api-zod) or explicit
 * type-checked helpers to prevent type coercion bugs (e.g. "false" -> true).
 */

import { createHash, randomBytes } from "crypto";
import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  db,
  decisionsTable,
  decisionConsultationsTable,
  decisionRoomAuditEventsTable,
  decisionRoomCommentsTable,
  decisionRoomReviewLinksTable,
  pillarsTable,
} from "@workspace/db";
import { z } from "zod";
import {
  requireFacultyAuth,
  type FacultyRequest,
} from "../middlewares/facultyAuth.js";
import { governedAnswer } from "../lib/governedAnswer.js";
import { collapseSameWorkProvenance } from "../lib/rag.js";

const router: IRouter = Router();

// ── Zod body schemas ─────────────────────────────────────────────────────────
// Validate request bodies explicitly so that type coercion (e.g. the string
// "false" arriving as a boolean column value) is rejected at the boundary.

const ReleaseCreateSchema = z.object({
  institutionName: z.string().min(1).max(200),
  namedExpert: z.string().min(1).max(200),
  publicGuidance: z.string().min(1).max(10_000),
  intendedAudience: z.string().max(4_000).optional(),
  sourceAndProvenanceNotes: z.string().max(8_000).optional(),
  scopeLimits: z.string().max(8_000).optional(),
  recoursePath: z.string().max(4_000).optional(),
  externallyCleared: z.boolean().optional(),
  revenueTermsAcknowledged: z.boolean().optional(),
  revenueTermsNote: z.string().max(2_000).optional(),
});

const ReleaseUpdateSchema = z.object({
  institutionName: z.string().min(1).max(200).optional(),
  namedExpert: z.string().min(1).max(200).optional(),
  publicGuidance: z.string().min(1).max(10_000).optional(),
  intendedAudience: z.string().max(4_000).nullable().optional(),
  sourceAndProvenanceNotes: z.string().max(8_000).nullable().optional(),
  scopeLimits: z.string().max(8_000).nullable().optional(),
  recoursePath: z.string().max(4_000).nullable().optional(),
  externallyCleared: z.boolean().optional(),
  revenueTermsAcknowledged: z.boolean().optional(),
  revenueTermsNote: z.string().max(2_000).nullable().optional(),
});

const ConsultSchema = z.object({
  pillarSlugs: z.array(z.string()).min(1).max(12),
});

const CommentCreateSchema = z.object({
  kind: z.enum(["comment", "challenge"]),
  body: z.string().min(1).max(10_000),
});

const CommentUpdateSchema = z.object({
  status: z.enum(["open", "resolved"]).optional(),
  body: z.string().min(1).max(10_000).optional(),
});

const ReviewLinkCreateSchema = z.object({
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

const SignoffNoteSchema = z.object({
  note: z.string().max(2_000).optional(),
});

// ── Types ────────────────────────────────────────────────────────────────────

type Mode = "test" | "live";
const CVO_RELEASE_STATUSES = [
  "draft",
  "in_review",
  "ready",
  "published",
  "withdrawn",
] as const;

type Citation = {
  title: string;
  authors?: string | null;
  year?: number | null;
  sourceUrl?: string | null;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function isValidMode(v: unknown): v is Mode {
  return v === "test" || v === "live";
}

function cvoReleaseIdCondition(id: number) {
  return and(
    eq(decisionsTable.id, id),
    inArray(decisionsTable.status, [...CVO_RELEASE_STATUSES]),
  );
}

type CvoReleaseRow = typeof decisionsTable.$inferSelect;
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function withLockedCvoRelease<T>(
  id: number,
  action: (tx: DbTransaction, release: CvoReleaseRow | null) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT id FROM decision_room_decisions WHERE id = ${id} FOR UPDATE`,
    );
    const [release] = await tx
      .select()
      .from(decisionsTable)
      .where(cvoReleaseIdCondition(id))
      .limit(1);
    return action(tx, release ?? null);
  });
}

function routeFailure(status: number, body: Record<string, unknown>) {
  return { ok: false as const, status, body };
}

/** Platform admin = CVO */
function isCvo(req: FacultyRequest): boolean {
  return req.faculty!.user.isPlatformAdmin === "true";
}

/**
 * Decision Room access guard: platform admins OR faculty users with at
 * least one active membership.
 */
function hasDecisionRoomAccess(req: FacultyRequest): boolean {
  const { user, memberships } = req.faculty!;
  if (user.isPlatformAdmin === "true") return true;
  return memberships.length > 0;
}

/** Only an active pillar steward may approve a release's substance. */
function canFacultySignoff(req: FacultyRequest): boolean {
  return (
    !isCvo(req) &&
    req.faculty!.memberships.some((membership) => membership.role === "steward")
  );
}

/** Map DB row to the API ReleaseSummary shape */
function toReleaseSummary(row: typeof decisionsTable.$inferSelect) {
  return {
    id: row.id,
    mode: row.mode as Mode,
    status: row.status,
    institutionName: row.institutionName,
    namedExpert: row.namedExpert,
    publicGuidance: row.question,
    isSample: row.isSample,
    facultyApprovedAt: row.facultyApprovedAt ?? null,
    cvoVerifiedAt: row.cvoVerifiedAt ?? null,
    publishedAt: row.publishedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Map DB row + related data to the API ReleaseDetail shape */
function toReleaseDetail(
  row: typeof decisionsTable.$inferSelect,
  consultations: Array<{
    id: number;
    pillarSlug: string;
    pillarName: string;
    status: string;
    answerText: string;
    citations: unknown;
    createdAt: Date;
  }>,
  comments: Array<{
    id: number;
    mode: string;
    releaseId: number;
    authorId: number;
    authorName: string;
    kind: string;
    body: string;
    status: string;
    resolvedAt: Date | null;
    resolvedById: number | null;
    resolvedByName: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>,
  auditEvents: Array<{
    id: number;
    mode: string;
    releaseId: number;
    actorName: string;
    eventType: string;
    detail: unknown;
    createdAt: Date;
  }>,
) {
  return {
    id: row.id,
    mode: row.mode as Mode,
    status: row.status,
    institutionName: row.institutionName,
    namedExpert: row.namedExpert,
    ownerFacultyUserId: row.ownerFacultyUserId ?? null,
    publicGuidance: row.question,
    intendedAudience: row.context ?? null,
    sourceAndProvenanceNotes: row.ownView ?? null,
    scopeLimits: row.finalCall ?? null,
    recoursePath: row.outcome ?? null,
    externallyCleared: row.externallyCleared,
    revenueTermsAcknowledged: row.revenueTermsAcknowledged,
    revenueTermsNote: row.revenueTermsNote ?? null,
    facultyApprovedAt: row.facultyApprovedAt ?? null,
    facultyApprovedById: row.facultyApprovedById ?? null,
    facultyApprovedByName: row.facultyApprovedByName ?? null,
    cvoVerifiedAt: row.cvoVerifiedAt ?? null,
    cvoVerifiedById: row.cvoVerifiedById ?? null,
    cvoVerifiedByName: row.cvoVerifiedByName ?? null,
    publishedAt: row.publishedAt ?? null,
    withdrawnAt: row.withdrawnAt ?? null,
    isSample: row.isSample,
    consultations: consultations.map((c) => ({
      id: c.id,
      pillarSlug: c.pillarSlug,
      pillarName: c.pillarName,
      status: c.status,
      answerText: c.answerText,
      citations: c.citations as Citation[],
      createdAt: c.createdAt,
    })),
    comments: comments.map((c) => ({
      id: c.id,
      releaseId: c.releaseId,
      mode: c.mode as Mode,
      authorId: c.authorId,
      authorName: c.authorName,
      kind: c.kind,
      body: c.body,
      status: c.status,
      resolvedAt: c.resolvedAt ?? null,
      resolvedById: c.resolvedById ?? null,
      resolvedByName: c.resolvedByName ?? null,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    })),
    // Bounded newest-first audit history — max 50 events per detail load
    auditEvents: auditEvents.map((e) => ({
      id: e.id,
      mode: e.mode as Mode,
      releaseId: e.releaseId,
      actorName: e.actorName,
      eventType: e.eventType,
      detail: e.detail ?? null,
      createdAt: e.createdAt,
    })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function loadReleaseDetail(id: number) {
  const [row] = await db
    .select()
    .from(decisionsTable)
    .where(cvoReleaseIdCondition(id))
    .limit(1);
  if (!row) return null;
  const [consultations, comments, auditEvents] = await Promise.all([
    db
      .select()
      .from(decisionConsultationsTable)
      .where(eq(decisionConsultationsTable.decisionId, id))
      .orderBy(desc(decisionConsultationsTable.createdAt)),
    db
      .select()
      .from(decisionRoomCommentsTable)
      .where(
        and(
          eq(decisionRoomCommentsTable.releaseId, id),
          eq(decisionRoomCommentsTable.mode, row.mode),
        ),
      )
      .orderBy(desc(decisionRoomCommentsTable.createdAt)),
    db
      .select()
      .from(decisionRoomAuditEventsTable)
      .where(
        and(
          eq(decisionRoomAuditEventsTable.releaseId, id),
          eq(decisionRoomAuditEventsTable.mode, row.mode),
        ),
      )
      .orderBy(desc(decisionRoomAuditEventsTable.createdAt))
      .limit(50),
  ]);
  return toReleaseDetail(row, consultations, comments, auditEvents);
}

async function recordAudit(
  mode: string,
  releaseId: number,
  actorId: number,
  actorName: string,
  eventType: string,
  detail: Record<string, unknown> = {},
) {
  await db.insert(decisionRoomAuditEventsTable).values({
    mode,
    releaseId,
    actorId,
    actorName,
    eventType,
    detail,
  });
}

/**
 * Check all ready/publish prerequisites (except CVO verification itself,
 * which is already assumed present when publishing).
 * Returns null if all satisfied, or a human-readable reason string.
 */
function checkReadyPrerequisites(
  row: typeof decisionsTable.$inferSelect,
  skipCvoCheck = false,
): string | null {
  if (!row.question || row.question.trim().length === 0)
    return "publicGuidance is required";
  if (!row.namedExpert || row.namedExpert.trim().length === 0)
    return "namedExpert is required";
  if (!row.context || row.context.trim().length === 0)
    return "intendedAudience is required";
  if (!row.ownView || row.ownView.trim().length === 0)
    return "sourceAndProvenanceNotes is required";
  if (!row.finalCall || row.finalCall.trim().length === 0)
    return "scopeLimits is required";
  if (!row.outcome || row.outcome.trim().length === 0)
    return "recoursePath is required";
  if (!row.revenueTermsAcknowledged)
    return "revenueTermsAcknowledged is required";
  if (row.mode === "live" && !row.externallyCleared)
    return "externallyCleared acknowledgement is required for Live mode";
  if (!row.facultyApprovedAt) return "faculty signoff is required";
  if (!skipCvoCheck && !row.cvoVerifiedAt)
    return "CVO verification is required";
  return null;
}

// ── Substantive fields that invalidate signoffs when changed ─────────────────
const API_TO_COL: Record<string, keyof typeof decisionsTable.$inferSelect> = {
  publicGuidance: "question",
  intendedAudience: "context",
  sourceAndProvenanceNotes: "ownView",
  scopeLimits: "finalCall",
  recoursePath: "outcome",
  institutionName: "institutionName",
  namedExpert: "namedExpert",
  externallyCleared: "externallyCleared",
  revenueTermsAcknowledged: "revenueTermsAcknowledged",
  revenueTermsNote: "revenueTermsNote",
} as const;

// ── Canonical pillars for consultation ───────────────────────────────────────
const DECISION_ROOM_PILLAR_SLUGS = [
  "sleep",
  "stress-management",
  "nutrition",
  "movement",
  "social-connection",
  "cognitive-enhancement",
  "gratitude-purpose",
  "empathy",
  "slm-ai-lab",
  "dementia",
  "autism",
] as const;

const UNCOVERED_TEXT =
  "This pillar's steward-approved corpus doesn't reach this question yet, so it offers no perspective rather than an invented one.";

// ── GET /decision-room/me ─────────────────────────────────────────────────────
router.get(
  "/decision-room/me",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!hasDecisionRoomAccess(req)) {
      res.status(403).json({ error: "no_decision_room_access" });
      return;
    }
    const { user, memberships } = req.faculty!;
    res.json({
      userId: user.id,
      fullName: user.fullName ?? "",
      isCvo: user.isPlatformAdmin === "true",
      hasMembership: memberships.length > 0,
      canFacultySignoff: canFacultySignoff(req),
    });
  },
);

// ── GET /decision-room/{mode}/summary ────────────────────────────────────────
router.get(
  "/decision-room/:mode/summary",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!hasDecisionRoomAccess(req)) {
      res.status(403).json({ error: "no_decision_room_access" });
      return;
    }
    const mode = req.params.mode as string;
    if (!isValidMode(mode)) {
      res
        .status(400)
        .json({ error: "invalid_mode", validModes: ["test", "live"] });
      return;
    }
    const rows = await db
      .select()
      .from(decisionsTable)
      .where(
        and(
          eq(decisionsTable.mode, mode),
          inArray(decisionsTable.status, [...CVO_RELEASE_STATUSES]),
        ),
      )
      .orderBy(desc(decisionsTable.updatedAt));

    const needsAttentionRows = rows.filter((r) =>
      ["draft", "in_review"].includes(r.status),
    );
    const readyToReleaseRows = rows.filter((r) => r.status === "ready");
    const publishedRows = rows.filter((r) => r.status === "published");
    const recent = rows.slice(0, 10).map(toReleaseSummary);

    res.json({
      mode,
      needsAttention: {
        count: needsAttentionRows.length,
        items: needsAttentionRows.slice(0, 10).map(toReleaseSummary),
      },
      readyToRelease: {
        count: readyToReleaseRows.length,
        items: readyToReleaseRows.slice(0, 10).map(toReleaseSummary),
      },
      publishedAndTraceable: {
        count: publishedRows.length,
        items: publishedRows.slice(0, 10).map(toReleaseSummary),
      },
      recent,
    });
  },
);

// ── GET /decision-room/{mode}/releases ───────────────────────────────────────
router.get(
  "/decision-room/:mode/releases",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!hasDecisionRoomAccess(req)) {
      res.status(403).json({ error: "no_decision_room_access" });
      return;
    }
    const mode = req.params.mode as string;
    if (!isValidMode(mode)) {
      res.status(400).json({ error: "invalid_mode" });
      return;
    }
    const rows = await db
      .select()
      .from(decisionsTable)
      .where(
        and(
          eq(decisionsTable.mode, mode),
          inArray(decisionsTable.status, [...CVO_RELEASE_STATUSES]),
        ),
      )
      .orderBy(desc(decisionsTable.createdAt));
    res.json({ releases: rows.map(toReleaseSummary) });
  },
);

// ── POST /decision-room/{mode}/releases ──────────────────────────────────────
router.post(
  "/decision-room/:mode/releases",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!hasDecisionRoomAccess(req)) {
      res.status(403).json({ error: "no_decision_room_access" });
      return;
    }
    const mode = req.params.mode as string;
    if (!isValidMode(mode)) {
      res.status(400).json({ error: "invalid_mode" });
      return;
    }

    const parsed = ReleaseCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_body", details: parsed.error.flatten() });
      return;
    }
    const {
      institutionName,
      namedExpert,
      publicGuidance,
      intendedAudience,
      sourceAndProvenanceNotes,
      scopeLimits,
      recoursePath,
      externallyCleared,
      revenueTermsAcknowledged,
      revenueTermsNote,
    } = parsed.data;

    const { user } = req.faculty!;

    const [newRow] = await db
      .insert(decisionsTable)
      .values({
        mode,
        title: `${institutionName}: ${namedExpert}`,
        question: publicGuidance,
        context: intendedAudience ?? null,
        ownView: sourceAndProvenanceNotes ?? null,
        finalCall: scopeLimits ?? null,
        outcome: recoursePath ?? null,
        institutionName,
        namedExpert,
        // A CVO-created release remains unassigned until a faculty steward
        // claims substantive responsibility by signing off. Faculty-created
        // releases belong to their creator from the start.
        ownerFacultyUserId: isCvo(req) ? null : user.id,
        externallyCleared: externallyCleared === true,
        revenueTermsAcknowledged: revenueTermsAcknowledged === true,
        revenueTermsNote: revenueTermsNote ?? null,
        status: "draft",
        isSample: false,
      })
      .returning();

    await recordAudit(mode, newRow.id, user.id, user.fullName ?? "", "create", {
      institutionName,
      namedExpert,
      mode,
    });

    const detail = await loadReleaseDetail(newRow.id);
    res.status(201).json(detail);
  },
);

// ── GET /decision-room/{mode}/releases/:id ───────────────────────────────────
router.get(
  "/decision-room/:mode/releases/:id",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!hasDecisionRoomAccess(req)) {
      res.status(403).json({ error: "no_decision_room_access" });
      return;
    }
    const mode = req.params.mode as string;
    if (!isValidMode(mode)) {
      res.status(400).json({ error: "invalid_mode" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const detail = await loadReleaseDetail(id);
    if (!detail) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (detail.mode !== mode) {
      res.status(400).json({ error: "mode_mismatch" });
      return;
    }
    res.json(detail);
  },
);

// ── PATCH /decision-room/{mode}/releases/:id ─────────────────────────────────
router.patch(
  "/decision-room/:mode/releases/:id",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!hasDecisionRoomAccess(req)) {
      res.status(403).json({ error: "no_decision_room_access" });
      return;
    }
    const mode = req.params.mode as string;
    if (!isValidMode(mode)) {
      res.status(400).json({ error: "invalid_mode" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }

    const parsed = ReleaseUpdateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_body", details: parsed.error.flatten() });
      return;
    }

    const body = parsed.data;
    const { user } = req.faculty!;
    const result = await withLockedCvoRelease(id, async (tx, existing) => {
      if (!existing) return routeFailure(404, { error: "not_found" });
      if (existing.mode !== mode)
        return routeFailure(400, { error: "mode_mismatch" });
      if (["published", "withdrawn"].includes(existing.status) && !isCvo(req)) {
        return routeFailure(403, {
          error: "only_cvo_can_edit_published_or_withdrawn",
        });
      }

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      const changedSubstantive: string[] = [];
      const apiKeyMap: Record<string, string | null | undefined> = {
        publicGuidance: body.publicGuidance,
        intendedAudience: body.intendedAudience,
        sourceAndProvenanceNotes: body.sourceAndProvenanceNotes,
        scopeLimits: body.scopeLimits,
        recoursePath: body.recoursePath,
        institutionName: body.institutionName,
        namedExpert: body.namedExpert,
      };
      for (const [apiKey, newVal] of Object.entries(apiKeyMap)) {
        if (newVal !== undefined) {
          const colKey = API_TO_COL[apiKey]!;
          const oldVal = existing[colKey as keyof typeof existing];
          if (newVal !== oldVal) changedSubstantive.push(apiKey);
          patch[colKey] = newVal ?? null;
        }
      }
      if (body.externallyCleared !== undefined) {
        if (body.externallyCleared !== existing.externallyCleared)
          changedSubstantive.push("externallyCleared");
        patch.externallyCleared = body.externallyCleared === true;
      }
      if (body.revenueTermsAcknowledged !== undefined) {
        if (body.revenueTermsAcknowledged !== existing.revenueTermsAcknowledged)
          changedSubstantive.push("revenueTermsAcknowledged");
        patch.revenueTermsAcknowledged = body.revenueTermsAcknowledged === true;
      }
      if (body.revenueTermsNote !== undefined) {
        if (body.revenueTermsNote !== existing.revenueTermsNote)
          changedSubstantive.push("revenueTermsNote");
        patch.revenueTermsNote = body.revenueTermsNote ?? null;
      }

      if (changedSubstantive.length > 0) {
        if (existing.facultyApprovedAt) {
          patch.facultyApprovedAt = null;
          patch.facultyApprovedById = null;
          patch.facultyApprovedByName = null;
        }
        if (existing.cvoVerifiedAt) {
          patch.cvoVerifiedAt = null;
          patch.cvoVerifiedById = null;
          patch.cvoVerifiedByName = null;
        }
        if (["ready", "published"].includes(existing.status)) {
          patch.status = "in_review";
          patch.publishedAt = null;
        }
        if (changedSubstantive.includes("namedExpert")) {
          patch.ownerFacultyUserId = null;
        }
      }

      const [updatedRow] = await tx
        .update(decisionsTable)
        .set(patch)
        .where(
          and(
            cvoReleaseIdCondition(id),
            eq(decisionsTable.mode, mode),
            eq(decisionsTable.status, existing.status),
          ),
        )
        .returning({ id: decisionsTable.id });
      if (!updatedRow)
        return routeFailure(409, { error: "release_changed_retry" });

      if (changedSubstantive.length > 0) {
        await tx
          .update(decisionRoomReviewLinksTable)
          .set({ revokedAt: patch.updatedAt as Date })
          .where(
            and(
              eq(decisionRoomReviewLinksTable.releaseId, id),
              eq(decisionRoomReviewLinksTable.mode, mode),
              isNull(decisionRoomReviewLinksTable.revokedAt),
            ),
          );
      }

      await tx.insert(decisionRoomAuditEventsTable).values({
        mode,
        releaseId: id,
        actorId: user.id,
        actorName: user.fullName ?? "",
        eventType: "update",
        detail: {
          changedFields: Object.keys(patch).filter((k) => k !== "updatedAt"),
          substantiveFieldsChanged: changedSubstantive,
          signoffsInvalidated: changedSubstantive.length > 0,
        },
      });
      return { ok: true as const };
    });

    if (!result.ok) {
      res.status(result.status).json(result.body);
      return;
    }

    const detail = await loadReleaseDetail(id);
    res.json(detail);
  },
);

// ── DELETE /decision-room/{mode}/releases/:id ────────────────────────────────
router.delete(
  "/decision-room/:mode/releases/:id",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!hasDecisionRoomAccess(req)) {
      res.status(403).json({ error: "no_decision_room_access" });
      return;
    }
    const mode = req.params.mode as string;
    if (!isValidMode(mode)) {
      res.status(400).json({ error: "invalid_mode" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    if (!isCvo(req)) {
      res.status(403).json({ error: "only_cvo_can_delete" });
      return;
    }
    const { user } = req.faculty!;
    const now = new Date();
    const result = await withLockedCvoRelease(id, async (tx, existing) => {
      if (!existing) return routeFailure(404, { error: "not_found" });
      if (existing.mode !== mode)
        return routeFailure(400, { error: "mode_mismatch" });
      if (!["draft", "in_review"].includes(existing.status)) {
        return routeFailure(400, {
          error: "only_draft_or_in_review_can_be_deleted",
          status: existing.status,
        });
      }

      await tx
        .update(decisionRoomReviewLinksTable)
        .set({ revokedAt: now })
        .where(
          and(
            eq(decisionRoomReviewLinksTable.releaseId, id),
            eq(decisionRoomReviewLinksTable.mode, mode),
            isNull(decisionRoomReviewLinksTable.revokedAt),
          ),
        );
      await tx
        .delete(decisionConsultationsTable)
        .where(eq(decisionConsultationsTable.decisionId, id));
      await tx
        .delete(decisionRoomCommentsTable)
        .where(eq(decisionRoomCommentsTable.releaseId, id));
      const [deleted] = await tx
        .delete(decisionsTable)
        .where(
          and(
            cvoReleaseIdCondition(id),
            eq(decisionsTable.mode, mode),
            inArray(decisionsTable.status, ["draft", "in_review"]),
          ),
        )
        .returning({ id: decisionsTable.id });
      if (!deleted)
        return routeFailure(409, { error: "release_changed_retry" });

      await tx.insert(decisionRoomAuditEventsTable).values({
        mode,
        releaseId: id,
        actorId: user.id,
        actorName: user.fullName ?? "",
        eventType: "delete",
        detail: { title: existing.title },
      });
      return { ok: true as const };
    });

    if (!result.ok) {
      res.status(result.status).json(result.body);
      return;
    }

    res.json({ ok: true });
  },
);

// ── POST /decision-room/{mode}/releases/:id/consult ──────────────────────────
router.post(
  "/decision-room/:mode/releases/:id/consult",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!hasDecisionRoomAccess(req)) {
      res.status(403).json({ error: "no_decision_room_access" });
      return;
    }
    const mode = req.params.mode as string;
    if (!isValidMode(mode)) {
      res.status(400).json({ error: "invalid_mode" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }

    const parsedBody = ConsultSchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      res
        .status(400)
        .json({ error: "invalid_body", details: parsedBody.error.flatten() });
      return;
    }

    const [release] = await db
      .select({
        id: decisionsTable.id,
        mode: decisionsTable.mode,
        status: decisionsTable.status,
        question: decisionsTable.question,
        ownView: decisionsTable.ownView,
        revision: sql<string>`xmin::text`,
      })
      .from(decisionsTable)
      .where(cvoReleaseIdCondition(id))
      .limit(1);
    if (!release) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (release.mode !== mode) {
      res.status(400).json({ error: "mode_mismatch" });
      return;
    }
    if (["published", "withdrawn"].includes(release.status)) {
      res.status(400).json({
        error: "consultation_not_allowed_after_publication",
        status: release.status,
      });
      return;
    }
    // Anti-automation rule: sourceAndProvenanceNotes (own view) must be set
    if (!release.ownView || release.ownView.trim().length === 0) {
      res.status(400).json({
        error: "own_view_required",
        message:
          "Record your source and provenance notes before consulting pillar science.",
      });
      return;
    }

    const { pillarSlugs } = parsedBody.data;
    const validSlugs = pillarSlugs.filter((s) =>
      (DECISION_ROOM_PILLAR_SLUGS as readonly string[]).includes(s),
    );
    if (validSlugs.length === 0) {
      res.status(400).json({
        error: "no_valid_pillar_slugs",
        validSlugs: DECISION_ROOM_PILLAR_SLUGS,
      });
      return;
    }

    const { user } = req.faculty!;

    const pillarRows = await db
      .select({
        id: pillarsTable.id,
        slug: pillarsTable.slug,
        name: pillarsTable.name,
      })
      .from(pillarsTable)
      .where(inArray(pillarsTable.slug, validSlugs));
    const pillarMap = new Map(pillarRows.map((p) => [p.slug, p]));

    const pendingConsultations: Array<{
      decisionId: number;
      pillarSlug: string;
      pillarName: string;
      status: string;
      answerText: string;
      citations: Citation[];
    }> = [];
    for (const slug of validSlugs) {
      const pillar = pillarMap.get(slug);
      const pillarName = pillar?.name ?? slug;

      let status: string;
      let answerText: string;
      let citations: Citation[] = [];

      try {
        const result = await governedAnswer({
          question: release.question,
          pillarSlug: slug,
        });
        if (result.outcome === "covered" && result.answer) {
          status = "covered";
          answerText = result.answer;
          const rawCitations = collapseSameWorkProvenance(
            result.provenance,
          ).slice(0, 5);
          citations = rawCitations.map((p) => ({
            title: p.title ?? "",
            authors: p.authors ?? null,
            year: p.year ?? null,
            sourceUrl: p.source_url ?? null,
          }));
        } else {
          status = "uncovered";
          answerText = UNCOVERED_TEXT;
        }
      } catch (e) {
        req.log.error({ err: e, pillarSlug: slug }, "Consult pillar failed");
        status = "error";
        answerText = "Consultation failed; please try again.";
      }

      pendingConsultations.push({
        decisionId: id,
        pillarSlug: slug,
        pillarName,
        status,
        answerText,
        citations,
      });
    }

    // AI work happens outside the transaction. Before persisting any result,
    // lock the release and require the same PostgreSQL row revision that the
    // consultation was generated from.
    const persistResult = await withLockedCvoRelease(
      id,
      async (tx, currentRelease) => {
        if (!currentRelease) return routeFailure(404, { error: "not_found" });
        if (currentRelease.mode !== mode)
          return routeFailure(400, { error: "mode_mismatch" });
        if (["published", "withdrawn"].includes(currentRelease.status)) {
          return routeFailure(409, {
            error: "release_changed_retry",
            message:
              "The release changed while consultation was running. Review the current release before consulting again.",
          });
        }
        const [lockedRevision] = await tx
          .select({ revision: sql<string>`xmin::text` })
          .from(decisionsTable)
          .where(cvoReleaseIdCondition(id))
          .limit(1);
        if (!lockedRevision || lockedRevision.revision !== release.revision) {
          return routeFailure(409, {
            error: "release_changed_retry",
            message:
              "The release changed while consultation was running. Review the current release before consulting again.",
          });
        }

        const now = new Date();
        const [updatedRelease] = await tx
          .update(decisionsTable)
          .set({
            facultyApprovedAt: null,
            facultyApprovedById: null,
            facultyApprovedByName: null,
            cvoVerifiedAt: null,
            cvoVerifiedById: null,
            cvoVerifiedByName: null,
            status:
              currentRelease.status === "ready"
                ? "in_review"
                : currentRelease.status,
            updatedAt: now,
          })
          .where(
            and(
              cvoReleaseIdCondition(id),
              eq(decisionsTable.mode, mode),
              eq(decisionsTable.status, currentRelease.status),
            ),
          )
          .returning({ id: decisionsTable.id });
        if (!updatedRelease)
          return routeFailure(409, { error: "release_changed_retry" });

        const newConsultations = await tx
          .insert(decisionConsultationsTable)
          .values(pendingConsultations)
          .returning();
        await tx
          .update(decisionRoomReviewLinksTable)
          .set({ revokedAt: now })
          .where(
            and(
              eq(decisionRoomReviewLinksTable.releaseId, id),
              eq(decisionRoomReviewLinksTable.mode, mode),
              isNull(decisionRoomReviewLinksTable.revokedAt),
            ),
          );
        await tx.insert(decisionRoomAuditEventsTable).values({
          mode,
          releaseId: id,
          actorId: user.id,
          actorName: user.fullName ?? "",
          eventType: "consult",
          detail: {
            pillarSlugs: validSlugs,
            count: newConsultations.length,
          },
        });
        return { ok: true as const, consultations: newConsultations };
      },
    );

    if (!persistResult.ok) {
      res.status(persistResult.status).json(persistResult.body);
      return;
    }
    const newConsultations = persistResult.consultations;

    res.json({
      consultations: newConsultations.map((c) => ({
        id: c.id,
        pillarSlug: c.pillarSlug,
        pillarName: c.pillarName,
        status: c.status,
        answerText: c.answerText,
        citations: c.citations as Citation[],
        createdAt: c.createdAt,
      })),
    });
  },
);

// ── POST /decision-room/{mode}/releases/:id/faculty-signoff ──────────────────
router.post(
  "/decision-room/:mode/releases/:id/faculty-signoff",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!hasDecisionRoomAccess(req)) {
      res.status(403).json({ error: "no_decision_room_access" });
      return;
    }
    if (!canFacultySignoff(req)) {
      res.status(403).json({
        error: "faculty_steward_only",
        message:
          "Faculty substantive sign-off requires an active steward role and must remain separate from CVO process verification.",
      });
      return;
    }
    const mode = req.params.mode as string;
    if (!isValidMode(mode)) {
      res.status(400).json({ error: "invalid_mode" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }

    const parsedNote = SignoffNoteSchema.safeParse(req.body ?? {});
    if (!parsedNote.success) {
      res
        .status(400)
        .json({ error: "invalid_body", details: parsedNote.error.flatten() });
      return;
    }

    const { user } = req.faculty!;
    const now = new Date();
    const result = await withLockedCvoRelease(id, async (tx, release) => {
      if (!release) return routeFailure(404, { error: "not_found" });
      if (release.mode !== mode)
        return routeFailure(400, { error: "mode_mismatch" });
      if (["published", "withdrawn"].includes(release.status)) {
        return routeFailure(400, {
          error: "cannot_sign_off_published_or_withdrawn",
          status: release.status,
        });
      }
      if (
        release.ownerFacultyUserId !== null &&
        release.ownerFacultyUserId !== user.id
      ) {
        return routeFailure(403, {
          error: "release_owned_by_another_faculty_steward",
        });
      }

      let newStatus = release.status;
      if (release.status === "draft") newStatus = "in_review";
      if (release.cvoVerifiedAt && release.status === "ready")
        newStatus = "in_review";

      const [signedOff] = await tx
        .update(decisionsTable)
        .set({
          facultyApprovedAt: now,
          facultyApprovedById: user.id,
          facultyApprovedByName: user.fullName ?? "",
          ownerFacultyUserId: release.ownerFacultyUserId ?? user.id,
          cvoVerifiedAt: null,
          cvoVerifiedById: null,
          cvoVerifiedByName: null,
          status: newStatus,
          updatedAt: now,
        })
        .where(
          and(
            cvoReleaseIdCondition(id),
            eq(decisionsTable.mode, mode),
            or(
              isNull(decisionsTable.ownerFacultyUserId),
              eq(decisionsTable.ownerFacultyUserId, user.id),
            ),
          ),
        )
        .returning({ id: decisionsTable.id });
      if (!signedOff) {
        return routeFailure(409, { error: "release_changed_retry" });
      }

      await tx.insert(decisionRoomAuditEventsTable).values({
        mode,
        releaseId: id,
        actorId: user.id,
        actorName: user.fullName ?? "",
        eventType: "faculty_signoff",
        detail: { note: parsedNote.data.note ?? null },
      });
      return { ok: true as const };
    });

    if (!result.ok) {
      res.status(result.status).json(result.body);
      return;
    }

    const detail = await loadReleaseDetail(id);
    res.json(detail);
  },
);

// ── POST /decision-room/{mode}/releases/:id/cvo-verification ─────────────────
router.post(
  "/decision-room/:mode/releases/:id/cvo-verification",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!isCvo(req)) {
      res.status(403).json({ error: "platform_admin_cvo_only" });
      return;
    }
    const mode = req.params.mode as string;
    if (!isValidMode(mode)) {
      res.status(400).json({ error: "invalid_mode" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }

    const parsedNote = SignoffNoteSchema.safeParse(req.body ?? {});
    if (!parsedNote.success) {
      res
        .status(400)
        .json({ error: "invalid_body", details: parsedNote.error.flatten() });
      return;
    }

    const { user } = req.faculty!;
    const now = new Date();
    const result = await withLockedCvoRelease(id, async (tx, release) => {
      if (!release) return routeFailure(404, { error: "not_found" });
      if (release.mode !== mode)
        return routeFailure(400, { error: "mode_mismatch" });
      if (!release.facultyApprovedAt) {
        return routeFailure(400, {
          error: "faculty_signoff_required_before_cvo_verification",
        });
      }
      if (["published", "withdrawn"].includes(release.status)) {
        return routeFailure(400, {
          error: "cannot_verify_published_or_withdrawn",
          status: release.status,
        });
      }
      const prereq = checkReadyPrerequisites(release, /* skipCvoCheck */ true);
      if (prereq) {
        return routeFailure(400, {
          error: "readiness_prerequisites_not_met",
          reason: prereq,
        });
      }

      await tx
        .update(decisionsTable)
        .set({
          cvoVerifiedAt: now,
          cvoVerifiedById: user.id,
          cvoVerifiedByName: user.fullName ?? "",
          status: release.status === "in_review" ? "ready" : release.status,
          updatedAt: now,
        })
        .where(and(cvoReleaseIdCondition(id), eq(decisionsTable.mode, mode)));
      await tx.insert(decisionRoomAuditEventsTable).values({
        mode,
        releaseId: id,
        actorId: user.id,
        actorName: user.fullName ?? "",
        eventType: "cvo_verification",
        detail: { note: parsedNote.data.note ?? null },
      });
      return { ok: true as const };
    });

    if (!result.ok) {
      res.status(result.status).json(result.body);
      return;
    }

    const detail = await loadReleaseDetail(id);
    res.json(detail);
  },
);

// ── POST /decision-room/{mode}/releases/:id/publish ──────────────────────────
router.post(
  "/decision-room/:mode/releases/:id/publish",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!isCvo(req)) {
      res.status(403).json({ error: "platform_admin_cvo_only" });
      return;
    }
    const mode = req.params.mode as string;
    if (!isValidMode(mode)) {
      res.status(400).json({ error: "invalid_mode" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }

    const { user } = req.faculty!;
    const now = new Date();
    const result = await withLockedCvoRelease(id, async (tx, release) => {
      if (!release) return routeFailure(404, { error: "not_found" });
      if (release.mode !== mode)
        return routeFailure(400, { error: "mode_mismatch" });
      if (release.status !== "ready") {
        return routeFailure(400, {
          error: "release_must_be_ready_to_publish",
          status: release.status,
        });
      }
      const prereq = checkReadyPrerequisites(release);
      if (prereq) {
        return routeFailure(400, {
          error: "publish_requirements_not_met",
          reason: prereq,
        });
      }

      await tx
        .update(decisionsTable)
        .set({ status: "published", publishedAt: now, updatedAt: now })
        .where(
          and(
            cvoReleaseIdCondition(id),
            eq(decisionsTable.mode, mode),
            eq(decisionsTable.status, "ready"),
          ),
        );
      await tx.insert(decisionRoomAuditEventsTable).values({
        mode,
        releaseId: id,
        actorId: user.id,
        actorName: user.fullName ?? "",
        eventType: "publish",
        detail: { note: req.body?.note ?? null },
      });
      return { ok: true as const };
    });

    if (!result.ok) {
      res.status(result.status).json(result.body);
      return;
    }

    const detail = await loadReleaseDetail(id);
    res.json(detail);
  },
);

// ── POST /decision-room/{mode}/releases/:id/withdraw ─────────────────────────
router.post(
  "/decision-room/:mode/releases/:id/withdraw",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!isCvo(req)) {
      res.status(403).json({ error: "platform_admin_cvo_only" });
      return;
    }
    const mode = req.params.mode as string;
    if (!isValidMode(mode)) {
      res.status(400).json({ error: "invalid_mode" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }

    const { user } = req.faculty!;
    const now = new Date();
    const result = await withLockedCvoRelease(id, async (tx, release) => {
      if (!release) return routeFailure(404, { error: "not_found" });
      if (release.mode !== mode)
        return routeFailure(400, { error: "mode_mismatch" });
      if (release.status !== "published") {
        return routeFailure(400, {
          error: "only_published_releases_can_be_withdrawn",
          status: release.status,
        });
      }

      await tx
        .update(decisionsTable)
        .set({ status: "withdrawn", withdrawnAt: now, updatedAt: now })
        .where(
          and(
            cvoReleaseIdCondition(id),
            eq(decisionsTable.mode, mode),
            eq(decisionsTable.status, "published"),
          ),
        );
      await tx
        .update(decisionRoomReviewLinksTable)
        .set({ revokedAt: now })
        .where(
          and(
            eq(decisionRoomReviewLinksTable.releaseId, id),
            eq(decisionRoomReviewLinksTable.mode, mode),
            isNull(decisionRoomReviewLinksTable.revokedAt),
          ),
        );
      await tx.insert(decisionRoomAuditEventsTable).values({
        mode,
        releaseId: id,
        actorId: user.id,
        actorName: user.fullName ?? "",
        eventType: "withdraw",
        detail: { reason: req.body?.reason ?? null },
      });
      return { ok: true as const };
    });

    if (!result.ok) {
      res.status(result.status).json(result.body);
      return;
    }

    const detail = await loadReleaseDetail(id);
    res.json(detail);
  },
);

// ── POST /decision-room/{mode}/releases/:id/comments ─────────────────────────
router.post(
  "/decision-room/:mode/releases/:id/comments",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!hasDecisionRoomAccess(req)) {
      res.status(403).json({ error: "no_decision_room_access" });
      return;
    }
    const mode = req.params.mode as string;
    if (!isValidMode(mode)) {
      res.status(400).json({ error: "invalid_mode" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }

    const parsedBody = CommentCreateSchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      res
        .status(400)
        .json({ error: "invalid_body", details: parsedBody.error.flatten() });
      return;
    }

    const [release] = await db
      .select({ id: decisionsTable.id, mode: decisionsTable.mode })
      .from(decisionsTable)
      .where(cvoReleaseIdCondition(id))
      .limit(1);
    if (!release) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (release.mode !== mode) {
      res.status(400).json({ error: "mode_mismatch" });
      return;
    }

    const { kind, body: commentBody } = parsedBody.data;
    const { user } = req.faculty!;

    const [comment] = await db
      .insert(decisionRoomCommentsTable)
      .values({
        mode,
        releaseId: id,
        authorId: user.id,
        authorName: user.fullName ?? "",
        kind,
        body: commentBody,
        status: "open",
      })
      .returning();

    await recordAudit(
      mode,
      id,
      user.id,
      user.fullName ?? "",
      `comment_create_${kind}`,
      { commentId: comment.id, kind },
    );

    res.status(201).json({
      id: comment.id,
      releaseId: comment.releaseId,
      mode: comment.mode,
      authorId: comment.authorId,
      authorName: comment.authorName,
      kind: comment.kind,
      body: comment.body,
      status: comment.status,
      resolvedAt: comment.resolvedAt ?? null,
      resolvedById: comment.resolvedById ?? null,
      resolvedByName: comment.resolvedByName ?? null,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    });
  },
);

// ── PATCH /decision-room/{mode}/releases/:id/comments/:commentId ─────────────
router.patch(
  "/decision-room/:mode/releases/:id/comments/:commentId",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!hasDecisionRoomAccess(req)) {
      res.status(403).json({ error: "no_decision_room_access" });
      return;
    }
    const mode = req.params.mode as string;
    if (!isValidMode(mode)) {
      res.status(400).json({ error: "invalid_mode" });
      return;
    }
    const id = Number(req.params.id);
    const commentId = Number(req.params.commentId);
    if (
      !Number.isInteger(id) ||
      id <= 0 ||
      !Number.isInteger(commentId) ||
      commentId <= 0
    ) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }

    const parsedBody = CommentUpdateSchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      res
        .status(400)
        .json({ error: "invalid_body", details: parsedBody.error.flatten() });
      return;
    }

    const [release] = await db
      .select({ id: decisionsTable.id, mode: decisionsTable.mode })
      .from(decisionsTable)
      .where(cvoReleaseIdCondition(id))
      .limit(1);
    if (!release) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (release.mode !== mode) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const [existingComment] = await db
      .select()
      .from(decisionRoomCommentsTable)
      .where(
        and(
          eq(decisionRoomCommentsTable.id, commentId),
          eq(decisionRoomCommentsTable.releaseId, id),
          eq(decisionRoomCommentsTable.mode, mode),
        ),
      )
      .limit(1);
    if (!existingComment) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const { user } = req.faculty!;
    const { status: newStatus, body: newBody } = parsedBody.data;
    const isAuthor = existingComment.authorId === user.id;
    if (newBody !== undefined && !isAuthor) {
      res.status(403).json({ error: "comment_author_only" });
      return;
    }
    if (newStatus !== undefined && !isAuthor && !isCvo(req)) {
      res.status(403).json({ error: "comment_author_or_cvo_only" });
      return;
    }
    const now = new Date();
    const patch: Record<string, unknown> = { updatedAt: now };

    if (newBody !== undefined) patch.body = newBody;
    if (newStatus !== undefined) {
      patch.status = newStatus;
      if (newStatus === "resolved") {
        patch.resolvedAt = now;
        patch.resolvedById = user.id;
        patch.resolvedByName = user.fullName ?? "";
      } else {
        patch.resolvedAt = null;
        patch.resolvedById = null;
        patch.resolvedByName = null;
      }
    }

    const [updated] = await db
      .update(decisionRoomCommentsTable)
      .set(patch)
      .where(eq(decisionRoomCommentsTable.id, commentId))
      .returning();

    await recordAudit(
      mode,
      id,
      user.id,
      user.fullName ?? "",
      "comment_update",
      {
        commentId,
        newStatus: newStatus ?? null,
        bodyChanged: newBody !== undefined,
      },
    );

    res.json({
      id: updated.id,
      releaseId: updated.releaseId,
      mode: updated.mode,
      authorId: updated.authorId,
      authorName: updated.authorName,
      kind: updated.kind,
      body: updated.body,
      status: updated.status,
      resolvedAt: updated.resolvedAt ?? null,
      resolvedById: updated.resolvedById ?? null,
      resolvedByName: updated.resolvedByName ?? null,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    });
  },
);

// ── POST /decision-room/{mode}/releases/:id/review-links ─────────────────────
router.post(
  "/decision-room/:mode/releases/:id/review-links",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!hasDecisionRoomAccess(req)) {
      res.status(403).json({ error: "no_decision_room_access" });
      return;
    }
    const mode = req.params.mode as string;
    if (!isValidMode(mode)) {
      res.status(400).json({ error: "invalid_mode" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }

    const parsedBody = ReviewLinkCreateSchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      res
        .status(400)
        .json({ error: "invalid_body", details: parsedBody.error.flatten() });
      return;
    }

    const expiresInDays = parsedBody.data.expiresInDays ?? 30;
    const { user } = req.faculty!;

    // Generate high-entropy raw token; store only its SHA-256 hash
    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const expiresAt = new Date(Date.now() + expiresInDays * 86_400_000);

    // Serialize issuance with substantive edits. The row lock means either the
    // link is created first and the edit revokes it, or the edit completes
    // first and this link is issued against the current release state.
    const linkResult = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM decision_room_decisions WHERE id = ${id} FOR UPDATE`,
      );
      const [release] = await tx
        .select({
          id: decisionsTable.id,
          mode: decisionsTable.mode,
          status: decisionsTable.status,
          externallyCleared: decisionsTable.externallyCleared,
        })
        .from(decisionsTable)
        .where(cvoReleaseIdCondition(id))
        .limit(1);
      if (!release) {
        return {
          link: null,
          errorStatus: 404,
          errorBody: { error: "not_found" },
        };
      }
      if (release.mode !== mode) {
        return {
          link: null,
          errorStatus: 400,
          errorBody: { error: "mode_mismatch" },
        };
      }
      if (release.status === "withdrawn") {
        return {
          link: null,
          errorStatus: 400,
          errorBody: { error: "withdrawn_release_cannot_be_shared" },
        };
      }
      if (mode === "live" && !release.externallyCleared) {
        return {
          link: null,
          errorStatus: 400,
          errorBody: {
            error: "externally_cleared_required_for_live_review_links",
            message:
              "Live releases must have externallyCleared=true before a review link can be created.",
          },
        };
      }

      const [link] = await tx
        .insert(decisionRoomReviewLinksTable)
        .values({
          mode,
          releaseId: id,
          tokenHash,
          expiresAt,
          creatorId: user.id,
          creatorName: user.fullName ?? "",
        })
        .returning();
      return { link, errorStatus: null, errorBody: null };
    });

    if (!linkResult.link) {
      res
        .status(linkResult.errorStatus ?? 500)
        .json(linkResult.errorBody ?? { error: "review_link_create_failed" });
      return;
    }
    const link = linkResult.link;

    await recordAudit(
      mode,
      id,
      user.id,
      user.fullName ?? "",
      "review_link_create",
      { linkId: link.id, expiresAt: expiresAt.toISOString() },
    );

    // rawToken is returned ONCE only -- never stored in plaintext
    res.status(201).json({
      id: link.id,
      rawToken,
      expiresAt: link.expiresAt,
      createdAt: link.createdAt,
    });
  },
);

// ── POST /decision-room/{mode}/releases/:id/review-links/:linkId/revoke ──────
router.post(
  "/decision-room/:mode/releases/:id/review-links/:linkId/revoke",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!hasDecisionRoomAccess(req)) {
      res.status(403).json({ error: "no_decision_room_access" });
      return;
    }
    const mode = req.params.mode as string;
    if (!isValidMode(mode)) {
      res.status(400).json({ error: "invalid_mode" });
      return;
    }
    const id = Number(req.params.id);
    const linkId = Number(req.params.linkId);
    if (
      !Number.isInteger(id) ||
      id <= 0 ||
      !Number.isInteger(linkId) ||
      linkId <= 0
    ) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }

    const [release] = await db
      .select({ id: decisionsTable.id, mode: decisionsTable.mode })
      .from(decisionsTable)
      .where(cvoReleaseIdCondition(id))
      .limit(1);
    if (!release) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (release.mode !== mode) {
      res.status(400).json({ error: "mode_mismatch" });
      return;
    }

    const [link] = await db
      .select()
      .from(decisionRoomReviewLinksTable)
      .where(
        and(
          eq(decisionRoomReviewLinksTable.id, linkId),
          eq(decisionRoomReviewLinksTable.releaseId, id),
          eq(decisionRoomReviewLinksTable.mode, mode),
        ),
      )
      .limit(1);
    if (!link) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const { user } = req.faculty!;
    if (!isCvo(req) && link.creatorId !== user.id) {
      res.status(403).json({ error: "review_link_creator_or_cvo_only" });
      return;
    }

    const revokedAt = link.revokedAt ?? new Date();
    if (!link.revokedAt) {
      await db
        .update(decisionRoomReviewLinksTable)
        .set({ revokedAt })
        .where(eq(decisionRoomReviewLinksTable.id, linkId));
      await recordAudit(
        mode,
        id,
        user.id,
        user.fullName ?? "",
        "review_link_revoke",
        { linkId },
      );
    }

    res.json({ id: linkId, revokedAt });
  },
);

// ── GET /decision-room/review/:token (public, no auth required) ───────────────
router.get("/decision-room/review/:token", async (req, res): Promise<void> => {
  const rawToken = req.params.token;
  if (!rawToken || rawToken.length < 8) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const now = new Date();

  const review = await db.transaction(async (tx) => {
    // First probe resolves the release ID without locking the link. Release
    // mutations always lock the release before revoking links, so taking the
    // release lock next preserves that order and avoids a deadlock.
    const [probe] = await tx
      .select({ releaseId: decisionRoomReviewLinksTable.releaseId })
      .from(decisionRoomReviewLinksTable)
      .where(eq(decisionRoomReviewLinksTable.tokenHash, tokenHash))
      .limit(1);
    if (!probe) return null;

    await tx.execute(
      sql`SELECT id FROM decision_room_decisions WHERE id = ${probe.releaseId} FOR UPDATE`,
    );

    // Re-read the bearer authorization after the release lock is held. If an
    // edit or clearance removal committed first, its revocation is visible.
    const [link] = await tx
      .select()
      .from(decisionRoomReviewLinksTable)
      .where(eq(decisionRoomReviewLinksTable.tokenHash, tokenHash))
      .limit(1);
    if (!link || link.revokedAt || link.expiresAt < now) return null;

    const [releaseRow] = await tx
      .select()
      .from(decisionsTable)
      .where(cvoReleaseIdCondition(link.releaseId))
      .limit(1);
    if (
      !releaseRow ||
      releaseRow.mode !== link.mode ||
      releaseRow.status === "withdrawn" ||
      (releaseRow.mode === "live" && !releaseRow.externallyCleared)
    ) {
      return null;
    }

    const [consultations, auditRows] = await Promise.all([
      tx
        .select()
        .from(decisionConsultationsTable)
        .where(eq(decisionConsultationsTable.decisionId, link.releaseId))
        .orderBy(desc(decisionConsultationsTable.createdAt)),
      tx
        .select({ createdAt: decisionRoomAuditEventsTable.createdAt })
        .from(decisionRoomAuditEventsTable)
        .where(eq(decisionRoomAuditEventsTable.releaseId, link.releaseId)),
    ]);

    await tx.insert(decisionRoomAuditEventsTable).values({
      mode: link.mode,
      releaseId: link.releaseId,
      actorId: 0,
      actorName: "public_review_link",
      eventType: "review_link_view",
      detail: { linkId: link.id },
    });
    return { link, releaseRow, consultations, auditRows };
  });

  // 404 for invalid / expired / revoked -- no existence information leaked
  if (!review) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const { releaseRow, consultations, auditRows } = review;

  // Only externally safe fields returned -- no numeric IDs on release or
  // consultations, no emails, no internal source notes, no comments,
  // no private identifiers.
  res.json({
    release: {
      // No id, no ownerFacultyUserId, no actor IDs
      institutionName: releaseRow.institutionName,
      namedExpert: releaseRow.namedExpert,
      publicGuidance: releaseRow.question,
      intendedAudience: releaseRow.context ?? null,
      scopeLimits: releaseRow.finalCall ?? null,
      recoursePath: releaseRow.outcome ?? null,
      status: releaseRow.status,
      // Named reviewer public name only -- no IDs
      facultyApprovedByName: releaseRow.facultyApprovedByName ?? null,
      cvoVerifiedByName: releaseRow.cvoVerifiedByName ?? null,
      publishedAt: releaseRow.publishedAt ?? null,
      // Consultations without numeric IDs
      consultations: consultations.map((c) => ({
        pillarSlug: c.pillarSlug,
        pillarName: c.pillarName,
        status: c.status,
        answerText: c.answerText,
        citations: c.citations as Citation[],
        createdAt: c.createdAt,
      })),
    },
    auditSummary: {
      eventCount: auditRows.length,
      lastEventAt:
        auditRows.length > 0
          ? auditRows.reduce(
              (max, r) => (r.createdAt > max ? r.createdAt : max),
              auditRows[0].createdAt,
            )
          : null,
    },
  });
});

export default router;
