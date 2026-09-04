import {
  Router,
  type IRouter,
  type Response,
  type NextFunction,
} from "express";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  pillarsTable,
  sourcesTable,
  facultyUsersTable,
  facultyMembershipsTable,
  interpretationsTable,
  crossPillarMergeRequestsTable,
  type FacultyMembership,
} from "@workspace/db";
import {
  requireFacultyAuth,
  type FacultyRequest,
} from "../middlewares/facultyAuth.js";
import {
  sendCrossPillarMergeRequestEmail,
  sendCrossPillarMergeOutcomeEmail,
} from "../lib/crossPillarEmail.js";

const router: IRouter = Router();

/**
 * Is the signed-in user a STEWARD of the given pillar? (admins do NOT
 * gain steward authority by virtue of being admin — governance is
 * per-pillar membership, matching the rest of the faculty surface.)
 */
function isStewardOf(req: FacultyRequest, pillarId: number): boolean {
  return req.faculty!.memberships.some(
    (m: FacultyMembership) => m.pillarId === pillarId && m.role === "steward",
  );
}

function myStewardPillarIds(req: FacultyRequest): number[] {
  return req.faculty!.memberships
    .filter((m: FacultyMembership) => m.role === "steward")
    .map((m: FacultyMembership) => m.pillarId);
}

/**
 * Which pillars should this caller see in the cross-pillar browser?
 *
 * Platform admins see everything (returns `null` = no filter). Everyone else
 * sees only "real" pillars — those with at least one NON-admin steward — plus
 * any pillar they themselves belong to. This hides "admin-only" pillars (whose
 * sole steward is a platform admin, e.g. unassigned movement/nutrition) from
 * other stewards until a real steward is assigned.
 */
async function visiblePillarIds(
  req: FacultyRequest,
): Promise<Set<number> | null> {
  if (req.faculty!.user.isPlatformAdmin === "true") return null;

  const stewardRows = await db
    .select({
      pillarId: facultyMembershipsTable.pillarId,
      isAdmin: facultyUsersTable.isPlatformAdmin,
    })
    .from(facultyMembershipsTable)
    .innerJoin(
      facultyUsersTable,
      eq(facultyUsersTable.id, facultyMembershipsTable.userId),
    )
    .where(eq(facultyMembershipsTable.role, "steward"));

  const visible = new Set<number>();
  for (const r of stewardRows) {
    if (r.isAdmin !== "true") visible.add(r.pillarId);
  }
  // Always include the caller's own pillars, whatever their role.
  for (const m of req.faculty!.memberships) visible.add(m.pillarId);
  return visible;
}

/**
 * Email the requester (the steward who proposed the adoption) that the
 * owning steward approved or declined their merge request. Best-effort;
 * callers wrap this in try/catch so email never blocks the response.
 */
async function notifyRequesterOfOutcome(
  req: FacultyRequest,
  mr: {
    requesterUserId: number | null;
    sourceInterpretationId: number;
    sourcePillarId: number;
    targetPillarId: number;
  },
  outcome: "approved" | "declined",
  declineReason: string | null,
): Promise<void> {
  if (mr.requesterUserId == null) return;
  const [requester] = await db
    .select({
      email: facultyUsersTable.email,
      fullName: facultyUsersTable.fullName,
    })
    .from(facultyUsersTable)
    .where(eq(facultyUsersTable.id, mr.requesterUserId))
    .limit(1);
  if (!requester?.email) return;

  const [interp] = await db
    .select({ answer: interpretationsTable.answer })
    .from(interpretationsTable)
    .where(eq(interpretationsTable.id, mr.sourceInterpretationId))
    .limit(1);

  const pillarRows = await db
    .select({ id: pillarsTable.id, name: pillarsTable.name })
    .from(pillarsTable)
    .where(inArray(pillarsTable.id, [mr.sourcePillarId, mr.targetPillarId]));
  const pillarNames = new Map(pillarRows.map((p) => [p.id, p.name]));

  await sendCrossPillarMergeOutcomeEmail({
    to: requester.email,
    requesterName: requester.fullName,
    reviewerName: req.faculty!.user.fullName,
    sourcePillarName: pillarNames.get(mr.sourcePillarId) ?? null,
    targetPillarName: pillarNames.get(mr.targetPillarId) ?? null,
    interpretationAnswer: interp?.answer ?? "",
    outcome,
    declineReason,
  });
}

/* ------------------------------------------------------------------ *
 * T4 — Cross-pillar browser (read-only)                              *
 * ------------------------------------------------------------------ */

/**
 * GET /api/faculty/cross-pillar/pillars — every pillar with a count of
 * its APPROVED interpretations + sources, for the browser's pillar list.
 * Available to any authenticated faculty user (read-only oversight).
 */
router.get(
  "/faculty/cross-pillar/pillars",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response, _next?: NextFunction) => {
    const rows = await db
      .select({
        id: pillarsTable.id,
        slug: pillarsTable.slug,
        name: pillarsTable.name,
        description: pillarsTable.description,
        // NOTE: the outer column is written table-qualified by hand
        // (`"pillars"."id"`) rather than interpolated as `${pillarsTable.id}`.
        // When the outer query has a single unaliased `.from(pillarsTable)`,
        // drizzle renders `${pillarsTable.id}` BARE (`"id"`), which then binds
        // to the inner subquery table's own `id` column — silently returning 0
        // for every row. See .agents/memory/drizzle-correlated-subquery-qualification.md.
        approvedInterpretations: sql<number>`(
          SELECT COUNT(*)::int FROM interpretations i
          WHERE i.pillar_id = "pillars"."id" AND i.status = 'approved'
        )`,
        approvedSources: sql<number>`(
          SELECT COUNT(*)::int FROM sources s
          WHERE s.pillar_id = "pillars"."id" AND s.status = 'approved'
            AND s.is_canary = FALSE
        )`,
        // Total uploaded sources regardless of approval status. Used by the
        // steward onboarding gate ("has the steward uploaded any data yet?"):
        // uploading is the action we measure, not approval (which comes later).
        sourceCount: sql<number>`(
          SELECT COUNT(*)::int FROM sources s
          WHERE s.pillar_id = "pillars"."id" AND s.is_canary = FALSE
        )`,
      })
      .from(pillarsTable)
      .orderBy(asc(pillarsTable.name));

    const visible = await visiblePillarIds(req);
    const filtered = visible ? rows.filter((r) => visible.has(r.id)) : rows;

    const myStewardIds = new Set(myStewardPillarIds(req));
    res.json({
      pillars: filtered.map((r) => ({
        ...r,
        isMine: myStewardIds.has(r.id),
      })),
    });
  },
);

/**
 * GET /api/faculty/cross-pillar/interpretations — every pillar's APPROVED
 * interpretations (read-only), optionally filtered to one pillar slug.
 * This is the cross-pillar discovery surface.
 */
router.get(
  "/faculty/cross-pillar/interpretations",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response, _next?: NextFunction) => {
    const slug = req.query.pillar
      ? String(req.query.pillar).trim().toLowerCase()
      : null;

    const visible = await visiblePillarIds(req);
    if (visible && visible.size === 0) {
      res.json({ interpretations: [] });
      return;
    }

    const conditions: SQL[] = [eq(interpretationsTable.status, "approved")];
    if (slug) conditions.push(eq(pillarsTable.slug, slug));
    if (visible) {
      conditions.push(
        inArray(interpretationsTable.pillarId, [...visible]),
      );
    }
    const where = and(...conditions);

    const rows = await db
      .select({
        id: interpretationsTable.id,
        answer: interpretationsTable.answer,
        interpretation: interpretationsTable.interpretation,
        action: interpretationsTable.action,
        tags: interpretationsTable.tags,
        approvedAt: interpretationsTable.approvedAt,
        pillarId: pillarsTable.id,
        pillarSlug: pillarsTable.slug,
        pillarName: pillarsTable.name,
        sourceId: sourcesTable.id,
        sourceTitle: sourcesTable.title,
        sourceAuthors: sourcesTable.authors,
        sourceYear: sourcesTable.year,
        authorName: facultyUsersTable.fullName,
      })
      .from(interpretationsTable)
      .innerJoin(
        pillarsTable,
        eq(pillarsTable.id, interpretationsTable.pillarId),
      )
      .innerJoin(
        sourcesTable,
        eq(sourcesTable.id, interpretationsTable.sourceId),
      )
      .leftJoin(
        facultyUsersTable,
        eq(facultyUsersTable.id, interpretationsTable.authorId),
      )
      .where(where)
      .orderBy(desc(interpretationsTable.approvedAt));

    const myStewardIds = new Set(myStewardPillarIds(req));
    res.json({
      interpretations: rows.map((r) => ({
        ...r,
        isMine: myStewardIds.has(r.pillarId),
      })),
    });
  },
);

/* ------------------------------------------------------------------ *
 * T6 — Cross-pillar merge requests ("pull requests for science")     *
 * ------------------------------------------------------------------ */

const proposeSchema = z.object({
  sourceInterpretationId: z.number().int().positive(),
  targetPillarId: z.number().int().positive(),
  note: z.string().max(2000).optional().nullable(),
});

const declineSchema = z.object({
  reason: z.string().max(2000).optional().nullable(),
});

/**
 * POST /api/faculty/cross-pillar/merge-requests — a steward of the
 * RECEIVING (target) pillar proposes adopting another pillar's APPROVED
 * interpretation. The OWNING (source) pillar's steward must approve.
 */
router.post(
  "/faculty/cross-pillar/merge-requests",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response, _next?: NextFunction) => {
    const parsed = proposeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { sourceInterpretationId, targetPillarId, note } = parsed.data;

    // Requester must be a steward of the target (adopting) pillar.
    if (!isStewardOf(req, targetPillarId)) {
      res.status(403).json({
        error: "Only a steward of the receiving pillar can propose an adoption.",
      });
      return;
    }

    const [interp] = await db
      .select()
      .from(interpretationsTable)
      .where(eq(interpretationsTable.id, sourceInterpretationId))
      .limit(1);
    if (!interp) {
      res.status(404).json({ error: "Interpretation not found" });
      return;
    }
    if (interp.status !== "approved") {
      res
        .status(400)
        .json({ error: "Only approved interpretations can be adopted." });
      return;
    }
    if (interp.pillarId === targetPillarId) {
      res.status(400).json({
        error: "That interpretation already belongs to your pillar.",
      });
      return;
    }
    const [source] = await db
      .select({
        rightsBasis: sourcesTable.rightsBasis,
        retentionStatus: sourcesTable.retentionStatus,
      })
      .from(sourcesTable)
      .where(eq(sourcesTable.id, interp.sourceId))
      .limit(1);
    // A no-rights paper's approved interpretation may be useful, but copying
    // its source row/chunks into another pillar would recreate the temporary
    // paper corpus. Cross-pillar adoption deliberately remains a retained-
    // material workflow; the owner can create an original interpretation in
    // the target pillar instead.
    if (
      !source ||
      source.rightsBasis === "no_documented_full_text_rights" ||
      source.retentionStatus === "purged_no_full_text_rights"
    ) {
      res.status(409).json({
        error:
          "This source cannot be adopted because its paper text is under rights-limited retention.",
      });
      return;
    }

    const [targetPillar] = await db
      .select()
      .from(pillarsTable)
      .where(eq(pillarsTable.id, targetPillarId))
      .limit(1);
    if (!targetPillar) {
      res.status(404).json({ error: "Target pillar not found" });
      return;
    }

    let created;
    try {
      [created] = await db
        .insert(crossPillarMergeRequestsTable)
        .values({
          sourceInterpretationId,
          sourcePillarId: interp.pillarId,
          targetPillarId,
          requesterUserId: req.faculty!.user.id,
          note: note ?? null,
        })
        .returning();
    } catch (e) {
      // The partial unique index (target_pillar_id, source_interpretation_id)
      // WHERE status='proposed' rejects a duplicate open request.
      req.log.warn(
        { err: e, sourceInterpretationId, targetPillarId },
        "duplicate cross-pillar merge request rejected",
      );
      res.status(409).json({
        error: "There's already an open request to adopt this interpretation.",
      });
      return;
    }

    // Notify the owning (source) pillar's steward(s). Best-effort.
    try {
      const [sourcePillar] = await db
        .select({ name: pillarsTable.name })
        .from(pillarsTable)
        .where(eq(pillarsTable.id, interp.pillarId))
        .limit(1);
      const owners = await db
        .select({
          email: facultyUsersTable.email,
          fullName: facultyUsersTable.fullName,
          userId: facultyUsersTable.id,
        })
        .from(facultyMembershipsTable)
        .innerJoin(
          facultyUsersTable,
          eq(facultyUsersTable.id, facultyMembershipsTable.userId),
        )
        .where(
          and(
            eq(facultyMembershipsTable.pillarId, interp.pillarId),
            eq(facultyMembershipsTable.role, "steward"),
          ),
        );
      for (const owner of owners) {
        if (!owner.email || owner.userId === req.faculty!.user.id) continue;
        await sendCrossPillarMergeRequestEmail({
          to: owner.email,
          ownerName: owner.fullName,
          requesterName: req.faculty!.user.fullName,
          sourcePillarName: sourcePillar?.name ?? null,
          targetPillarName: targetPillar.name,
          interpretationAnswer: interp.answer,
          note: note ?? null,
        });
      }
    } catch (e) {
      req.log.warn(
        { err: e, mergeRequestId: created?.id },
        "cross-pillar merge-request notification failed",
      );
    }

    res.status(201).json(created);
  },
);

/**
 * GET /api/faculty/cross-pillar/merge-requests?box=inbox|outbox&status=
 *  - inbox  → requests to adopt MY pillars' interpretations (I review).
 *  - outbox → requests I opened to adopt other pillars' interpretations.
 */
router.get(
  "/faculty/cross-pillar/merge-requests",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response, _next?: NextFunction) => {
    const box = req.query.box === "outbox" ? "outbox" : "inbox";
    const statusFilter =
      req.query.status === "approved" ||
      req.query.status === "declined" ||
      req.query.status === "proposed"
        ? req.query.status
        : null;

    const myStewardIds = myStewardPillarIds(req);

    const conditions: SQL[] = [];
    if (box === "inbox") {
      // Requests targeting interpretations I own (source pillar = mine).
      if (myStewardIds.length === 0) {
        res.json({ requests: [] });
        return;
      }
      conditions.push(
        inArray(crossPillarMergeRequestsTable.sourcePillarId, myStewardIds),
      );
    } else {
      conditions.push(
        eq(crossPillarMergeRequestsTable.requesterUserId, req.faculty!.user.id),
      );
    }
    if (statusFilter) {
      conditions.push(eq(crossPillarMergeRequestsTable.status, statusFilter));
    }

    const sourcePillar = pillarsTable;
    const rows = await db
      .select({
        id: crossPillarMergeRequestsTable.id,
        status: crossPillarMergeRequestsTable.status,
        note: crossPillarMergeRequestsTable.note,
        declineReason: crossPillarMergeRequestsTable.declineReason,
        createdAt: crossPillarMergeRequestsTable.createdAt,
        reviewedAt: crossPillarMergeRequestsTable.reviewedAt,
        sourceInterpretationId:
          crossPillarMergeRequestsTable.sourceInterpretationId,
        sourcePillarId: crossPillarMergeRequestsTable.sourcePillarId,
        targetPillarId: crossPillarMergeRequestsTable.targetPillarId,
        resultingInterpretationId:
          crossPillarMergeRequestsTable.resultingInterpretationId,
        interpretationAnswer: interpretationsTable.answer,
        sourcePillarName: sourcePillar.name,
        sourcePillarSlug: sourcePillar.slug,
        requesterName: facultyUsersTable.fullName,
      })
      .from(crossPillarMergeRequestsTable)
      .leftJoin(
        interpretationsTable,
        eq(
          interpretationsTable.id,
          crossPillarMergeRequestsTable.sourceInterpretationId,
        ),
      )
      .leftJoin(
        sourcePillar,
        eq(sourcePillar.id, crossPillarMergeRequestsTable.sourcePillarId),
      )
      .leftJoin(
        facultyUsersTable,
        eq(
          facultyUsersTable.id,
          crossPillarMergeRequestsTable.requesterUserId,
        ),
      )
      .where(and(...conditions))
      .orderBy(desc(crossPillarMergeRequestsTable.createdAt));

    // Attach target pillar names in a second pass (avoids a second alias).
    const targetIds = [...new Set(rows.map((r) => r.targetPillarId))];
    const targetNames = new Map<number, string>();
    if (targetIds.length > 0) {
      const tps = await db
        .select({ id: pillarsTable.id, name: pillarsTable.name })
        .from(pillarsTable)
        .where(inArray(pillarsTable.id, targetIds));
      for (const t of tps) targetNames.set(t.id, t.name);
    }

    res.json({
      requests: rows.map((r) => ({
        ...r,
        targetPillarName: targetNames.get(r.targetPillarId) ?? null,
      })),
    });
  },
);

/**
 * POST /api/faculty/cross-pillar/merge-requests/:id/approve — the OWNING
 * (source) pillar's steward approves. Atomic + idempotent: a conditional
 * `WHERE status='proposed'` update guards the whole merge, which copies
 * citation metadata plus the approved Palonur-authored interpretation into
 * the target pillar. It NEVER copies paper text/chunks: a later rights
 * conversion of the originating source must not leave a derivative corpus.
 */
router.post(
  "/faculty/cross-pillar/merge-requests/:id/approve",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response, _next?: NextFunction) => {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [mr] = await db
      .select()
      .from(crossPillarMergeRequestsTable)
      .where(eq(crossPillarMergeRequestsTable.id, id))
      .limit(1);
    if (!mr) {
      res.status(404).json({ error: "Request not found" });
      return;
    }
    // Approval authority belongs to the OWNING (source) pillar's steward.
    if (!isStewardOf(req, mr.sourcePillarId)) {
      res.status(403).json({
        error: "Only a steward of the owning pillar can approve this request.",
      });
      return;
    }
    if (mr.status !== "proposed") {
      res.status(409).json({ error: `Request already ${mr.status}.` });
      return;
    }

    const reviewerId = req.faculty!.user.id;
    try {
      const result = await db.transaction(async (tx) => {
        // Conditional resolve — the gate that makes approval idempotent and
        // race-safe: if a concurrent reviewer already resolved it, 0 rows.
        const claimed = await tx
          .update(crossPillarMergeRequestsTable)
          .set({
            status: "approved",
            reviewedByUserId: reviewerId,
            reviewedAt: new Date(),
          })
          .where(
            and(
              eq(crossPillarMergeRequestsTable.id, id),
              eq(crossPillarMergeRequestsTable.status, "proposed"),
            ),
          )
          .returning();
        if (claimed.length === 0) {
          return { conflict: true as const };
        }

        const [interp] = await tx
          .select()
          .from(interpretationsTable)
          .where(eq(interpretationsTable.id, mr.sourceInterpretationId))
          .limit(1);
        if (!interp) throw new Error("source interpretation vanished");
        // Re-check adoptability at approval time — the source could have been
        // archived or re-opened since the request was proposed. Throwing rolls
        // back the conditional claim above, leaving the request 'proposed'.
        if (
          interp.status !== "approved" ||
          interp.pillarId !== mr.sourcePillarId
        ) {
          const staleErr = new Error("source interpretation no longer adoptable");
          (staleErr as Error & { code?: string }).code = "STALE_SOURCE";
          throw staleErr;
        }
        const [origSource] = await tx
          .select()
          .from(sourcesTable)
          .where(eq(sourcesTable.id, interp.sourceId))
          .limit(1);
        if (!origSource) throw new Error("source row vanished");
        if (
          origSource.rightsBasis === "no_documented_full_text_rights" ||
          !origSource.rightsBasis ||
          origSource.retentionStatus === "needs_review" ||
          origSource.retentionStatus === "review_window" ||
          origSource.retentionStatus === "purged_no_full_text_rights"
        ) {
          const staleErr = new Error("rights-limited source cannot be adopted");
          (staleErr as Error & { code?: string }).code = "STALE_SOURCE";
          throw staleErr;
        }
        const [sourcePillar] = await tx
          .select({ slug: pillarsTable.slug, name: pillarsTable.name })
          .from(pillarsTable)
          .where(eq(pillarsTable.id, mr.sourcePillarId))
          .limit(1);

        // 1) Copy citation metadata only. Do NOT copy abstract/full text or
        // source chunks, even where the source currently has documented
        // rights: cross-pillar adoption is an interpretation-sharing
        // workflow, not a second paper ingestion. This prevents an approved
        // copy from retaining paper expression if the original's rights
        // record changes later.
        const [newSource] = await tx
          .insert(sourcesTable)
          .values({
            pillarId: mr.targetPillarId,
            kind: origSource.kind,
            title: origSource.title,
            authors: origSource.authors,
            year: origSource.year,
            journal: origSource.journal,
            doi: null,
            abstract: null,
            fullText: null,
            sourceUrl: origSource.sourceUrl,
            status: "approved",
            rightsBasis: origSource.rightsBasis,
            retentionStatus: origSource.retentionStatus,
            rightsRecordedByUserId: origSource.rightsRecordedByUserId,
            rightsRecordedAt: origSource.rightsRecordedAt,
            uploadedByUserId: interp.authorId,
            version: 1,
          })
          .returning();

        // 2) Create the attributed interpretation in the target pillar,
        // crediting the original author + linking lineage via parent id.
        const attributionTag = sourcePillar
          ? `adopted-from:${sourcePillar.slug}`
          : "adopted";
        const newTags = Array.from(
          new Set([...(interp.tags ?? []), attributionTag]),
        );
        const [newInterp] = await tx
          .insert(interpretationsTable)
          .values({
            sourceId: newSource.id,
            pillarId: mr.targetPillarId,
            authorId: interp.authorId,
            origin: interp.origin,
            draftedAt: interp.draftedAt,
            reviewedByUserId: interp.reviewedByUserId,
            reviewedAt: interp.reviewedAt,
            lastEditedByUserId: interp.lastEditedByUserId,
            lastEditedAt: interp.lastEditedAt,
            status: "approved",
            version: 1,
            answer: interp.answer,
            interpretation: interp.interpretation,
            notProven: interp.notProven,
            action: interp.action,
            tags: newTags,
            approverId: reviewerId,
            approvedAt: new Date(),
            parentInterpretationId: interp.id,
          })
          .returning();

        // 3) Copy only interpretation chunks (Palonur-authored analysis).
        await tx.execute(sql`
          INSERT INTO interpretation_chunks
            (interpretation_id, source_id, pillar_id, chunk_index, text, embedding, embedding_model, priority)
          SELECT ${newInterp.id}, ${newSource.id}, ${mr.targetPillarId}, chunk_index, text, embedding, embedding_model, priority
          FROM interpretation_chunks WHERE interpretation_id = ${interp.id}
        `);

        // 4) Audit trail on the new source.
        await tx.execute(sql`
          INSERT INTO source_audit_log
            (source_id, actor_user_id, action, to_status, note)
          VALUES (
            ${newSource.id}, ${reviewerId}, 'cross_pillar_merge', 'approved',
            ${`Adopted from the ${sourcePillar?.name ?? "another"} pillar (interpretation #${interp.id}).`}
          )
        `);

        // 5) Record the resulting ids on the merge request.
        await tx
          .update(crossPillarMergeRequestsTable)
          .set({
            resultingSourceId: newSource.id,
            resultingInterpretationId: newInterp.id,
          })
          .where(eq(crossPillarMergeRequestsTable.id, id));

        return {
          conflict: false as const,
          resultingSourceId: newSource.id,
          resultingInterpretationId: newInterp.id,
        };
      });

      if (result.conflict) {
        res.status(409).json({ error: "Request already resolved." });
        return;
      }

      // Notify the requester that their adoption request was approved.
      // Best-effort — never block or fail the response on email.
      try {
        await notifyRequesterOfOutcome(req, mr, "approved", null);
      } catch (e) {
        req.log.warn(
          { err: e, mergeRequestId: id },
          "cross-pillar merge-outcome notification failed",
        );
      }

      res.json({
        ok: true,
        resultingSourceId: result.resultingSourceId,
        resultingInterpretationId: result.resultingInterpretationId,
      });
    } catch (e) {
      if ((e as Error & { code?: string })?.code === "STALE_SOURCE") {
        res.status(409).json({
          error:
            "That interpretation is no longer approved, so it can't be adopted.",
        });
        return;
      }
      req.log.error(
        { err: e, mergeRequestId: id },
        "cross-pillar merge approval failed",
      );
      res.status(500).json({ error: "Failed to approve merge request" });
    }
  },
);

/**
 * POST /api/faculty/cross-pillar/merge-requests/:id/decline — owning
 * pillar's steward declines. Atomic + idempotent via conditional update.
 */
router.post(
  "/faculty/cross-pillar/merge-requests/:id/decline",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response, _next?: NextFunction) => {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsed = declineSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const [mr] = await db
      .select()
      .from(crossPillarMergeRequestsTable)
      .where(eq(crossPillarMergeRequestsTable.id, id))
      .limit(1);
    if (!mr) {
      res.status(404).json({ error: "Request not found" });
      return;
    }
    if (!isStewardOf(req, mr.sourcePillarId)) {
      res.status(403).json({
        error: "Only a steward of the owning pillar can decline this request.",
      });
      return;
    }
    if (mr.status !== "proposed") {
      res.status(409).json({ error: `Request already ${mr.status}.` });
      return;
    }
    const claimed = await db
      .update(crossPillarMergeRequestsTable)
      .set({
        status: "declined",
        declineReason: parsed.data.reason ?? null,
        reviewedByUserId: req.faculty!.user.id,
        reviewedAt: new Date(),
      })
      .where(
        and(
          eq(crossPillarMergeRequestsTable.id, id),
          eq(crossPillarMergeRequestsTable.status, "proposed"),
        ),
      )
      .returning();
    if (claimed.length === 0) {
      res.status(409).json({ error: "Request already resolved." });
      return;
    }

    // Notify the requester that their adoption request was declined.
    // Best-effort — never block or fail the response on email.
    try {
      await notifyRequesterOfOutcome(
        req,
        mr,
        "declined",
        parsed.data.reason ?? null,
      );
    } catch (e) {
      req.log.warn(
        { err: e, mergeRequestId: id },
        "cross-pillar merge-outcome notification failed",
      );
    }

    res.json({ ok: true });
  },
);

export default router;
