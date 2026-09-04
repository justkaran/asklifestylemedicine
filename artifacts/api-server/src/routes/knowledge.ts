import { Router, type IRouter, type Response } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  agentQueriesTable,
  db,
  facultyMembershipsTable,
  facultyUsersTable,
  interpretationsTable,
  knowledgeRelationsTable,
  knowledgeVersionsTable,
  pillarsTable,
  sourcesTable,
} from "@workspace/db";
import {
  requireFacultyAuth,
  type FacultyRequest,
} from "../middlewares/facultyAuth.js";

const router: IRouter = Router();

type Role = "steward" | "contributor" | "advisor" | "viewer";

const relationshipSchema = z.object({
  fromInterpretationId: z.number().int().positive(),
  toInterpretationId: z.number().int().positive(),
  relation: z.enum(["supports", "refines", "qualifies", "contradicts"]),
  note: z.string().trim().max(1000).optional().nullable(),
});

const publishSchema = z.object({
  label: z.string().trim().min(1).max(160).optional(),
  note: z.string().trim().max(2000).optional().nullable(),
});

async function resolvePillar(req: FacultyRequest, slug: string) {
  const [pillar] = await db
    .select()
    .from(pillarsTable)
    .where(eq(pillarsTable.slug, slug))
    .limit(1);
  if (!pillar) return { error: "Pillar not found", status: 404 } as const;

  const ctx = req.faculty!;
  const membership = ctx.memberships.find((m) => m.pillarId === pillar.id);
  const isAdmin = ctx.user.isPlatformAdmin === "true";
  if (!membership && !isAdmin) {
    return { error: "Forbidden", status: 403 } as const;
  }
  return {
    pillar,
    role: (membership?.role as Role | undefined) ?? null,
    canPublish: membership?.role === "steward",
  } as const;
}

async function listClaims(pillarId: number, approvedOnly = false) {
  const predicates = [
    eq(interpretationsTable.pillarId, pillarId),
    eq(sourcesTable.isCanary, false),
  ];
  if (approvedOnly) {
    predicates.push(eq(interpretationsTable.status, "approved"));
    predicates.push(eq(sourcesTable.status, "approved"));
  }
  return db
    .select({
      id: interpretationsTable.id,
      status: interpretationsTable.status,
      version: interpretationsTable.version,
      answer: interpretationsTable.answer,
      interpretation: interpretationsTable.interpretation,
      notProven: interpretationsTable.notProven,
      action: interpretationsTable.action,
      tags: interpretationsTable.tags,
      sourceId: sourcesTable.id,
      sourceTitle: sourcesTable.title,
      sourceAuthors: sourcesTable.authors,
      sourceYear: sourcesTable.year,
      sourceJournal: sourcesTable.journal,
      sourceDoi: sourcesTable.doi,
      sourceUrl: sourcesTable.sourceUrl,
      authorName: facultyUsersTable.fullName,
      updatedAt: interpretationsTable.updatedAt,
      approvedAt: interpretationsTable.approvedAt,
    })
    .from(interpretationsTable)
    .innerJoin(sourcesTable, eq(sourcesTable.id, interpretationsTable.sourceId))
    .leftJoin(facultyUsersTable, eq(facultyUsersTable.id, interpretationsTable.authorId))
    .where(and(...predicates))
    .orderBy(desc(interpretationsTable.approvedAt), desc(interpretationsTable.updatedAt));
}

async function listRelationships(pillarId: number) {
  return db
    .select()
    .from(knowledgeRelationsTable)
    .where(eq(knowledgeRelationsTable.pillarId, pillarId))
    .orderBy(desc(knowledgeRelationsTable.createdAt));
}

function snapshotClaims(claims: Awaited<ReturnType<typeof listClaims>>) {
  return claims.map((claim) => ({
    interpretationId: claim.id,
    interpretationVersion: claim.version,
    answer: claim.answer,
    interpretation: claim.interpretation,
    notProven: claim.notProven,
    action: claim.action,
    tags: claim.tags,
    source: {
      id: claim.sourceId,
      title: claim.sourceTitle,
      authors: claim.sourceAuthors,
      year: claim.sourceYear,
      journal: claim.sourceJournal,
      doi: claim.sourceDoi,
      url: claim.sourceUrl,
    },
    authorName: claim.authorName,
    approvedAt: claim.approvedAt?.toISOString() ?? null,
  }));
}

/**
 * The knowledge workspace intentionally treats an existing interpretation as
 * the atomic claim. That keeps every graph node attached to the source,
 * discussion, approval status, and interpretation version faculty already use.
 */
router.get(
  "/faculty/pillars/:slug/knowledge",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response) => {
    const resolved = await resolvePillar(req, String(req.params.slug));
    if ("error" in resolved) {
      res.status(resolved.status ?? 500).json({ error: resolved.error });
      return;
    }
    const [claims, relationships, versions] = await Promise.all([
      listClaims(resolved.pillar.id),
      listRelationships(resolved.pillar.id),
      db
        .select({
          id: knowledgeVersionsTable.id,
          version: knowledgeVersionsTable.version,
          label: knowledgeVersionsTable.label,
          claimCount: knowledgeVersionsTable.claimCount,
          relationCount: knowledgeVersionsTable.relationCount,
          note: knowledgeVersionsTable.note,
          publishedAt: knowledgeVersionsTable.publishedAt,
        })
        .from(knowledgeVersionsTable)
        .where(eq(knowledgeVersionsTable.pillarId, resolved.pillar.id))
        .orderBy(desc(knowledgeVersionsTable.version))
        .limit(30),
    ]);
    res.json({
      pillar: resolved.pillar,
      role: resolved.role,
      canPublish: resolved.canPublish,
      claims,
      relationships,
      versions,
    });
  },
);

router.get(
  "/faculty/pillars/:slug/knowledge/versions/:version",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response) => {
    const resolved = await resolvePillar(req, String(req.params.slug));
    const version = Number(req.params.version);
    if ("error" in resolved) {
      res.status(resolved.status ?? 500).json({ error: resolved.error });
      return;
    }
    if (!Number.isInteger(version) || version < 1) {
      res.status(400).json({ error: "Invalid version" });
      return;
    }
    const [knowledgeVersion] = await db
      .select()
      .from(knowledgeVersionsTable)
      .where(
        and(
          eq(knowledgeVersionsTable.pillarId, resolved.pillar.id),
          eq(knowledgeVersionsTable.version, version),
        ),
      )
      .limit(1);
    if (!knowledgeVersion) {
      res.status(404).json({ error: "Knowledge version not found" });
      return;
    }
    res.json({ knowledgeVersion });
  },
);

/**
 * The replay record is intentionally a read-only reconstruction, not a
 * second model invocation. It lets a reviewer see the exact stored answer,
 * the knowledge snapshot that governed it, and the claims/sources selected
 * at the time, even after the live corpus changes.
 */
router.get(
  "/faculty/pillars/:slug/knowledge/answers",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response) => {
    const resolved = await resolvePillar(req, String(req.params.slug));
    if ("error" in resolved) {
      res.status(resolved.status ?? 500).json({ error: resolved.error });
      return;
    }
    const answers = await db
      .select({
        id: agentQueriesTable.id,
        question: agentQueriesTable.question,
        answerText: agentQueriesTable.answerText,
        retrievedSourceIds: agentQueriesTable.retrievedSourceIds,
        retrievedInterpretationIds: agentQueriesTable.retrievedInterpretationIds,
        topScore: agentQueriesTable.topScore,
        createdAt: agentQueriesTable.createdAt,
        knowledgeVersionId: knowledgeVersionsTable.id,
        knowledgeVersion: knowledgeVersionsTable.version,
        knowledgeLabel: knowledgeVersionsTable.label,
      })
      .from(agentQueriesTable)
      .innerJoin(
        knowledgeVersionsTable,
        eq(agentQueriesTable.knowledgeVersionId, knowledgeVersionsTable.id),
      )
      .where(eq(knowledgeVersionsTable.pillarId, resolved.pillar.id))
      .orderBy(desc(agentQueriesTable.createdAt))
      .limit(30);
    res.json({ answers });
  },
);

router.post(
  "/faculty/pillars/:slug/knowledge/relationships",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response) => {
    const resolved = await resolvePillar(req, String(req.params.slug));
    if ("error" in resolved) {
      res.status(resolved.status ?? 500).json({ error: resolved.error });
      return;
    }
    if (!resolved.canPublish) {
      res.status(403).json({ error: "Only this pillar's steward can map claim relationships" });
      return;
    }
    const body = relationshipSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Invalid relationship", details: body.error.flatten() });
      return;
    }
    if (body.data.fromInterpretationId === body.data.toInterpretationId) {
      res.status(400).json({ error: "A claim cannot relate to itself" });
      return;
    }
    const claims = await db
      .select({ id: interpretationsTable.id })
      .from(interpretationsTable)
      .where(
        and(
          eq(interpretationsTable.pillarId, resolved.pillar.id),
          inArray(interpretationsTable.id, [
            body.data.fromInterpretationId,
            body.data.toInterpretationId,
          ]),
        ),
      );
    if (claims.length !== 2) {
      res.status(400).json({ error: "Both claims must belong to this pillar" });
      return;
    }
    const [created] = await db
      .insert(knowledgeRelationsTable)
      .values({
        pillarId: resolved.pillar.id,
        fromInterpretationId: body.data.fromInterpretationId,
        toInterpretationId: body.data.toInterpretationId,
        relation: body.data.relation,
        note: body.data.note ?? null,
        createdByUserId: req.faculty!.user.id,
      })
      .onConflictDoNothing()
      .returning();
    if (!created) {
      res.status(409).json({ error: "That relationship already exists" });
      return;
    }
    res.status(201).json({ relationship: created });
  },
);

router.delete(
  "/faculty/pillars/:slug/knowledge/relationships/:id",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response) => {
    const resolved = await resolvePillar(req, String(req.params.slug));
    const id = Number(req.params.id);
    if ("error" in resolved) {
      res.status(resolved.status ?? 500).json({ error: resolved.error });
      return;
    }
    if (!resolved.canPublish) {
      res.status(403).json({ error: "Only this pillar's steward can edit claim relationships" });
      return;
    }
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid relationship" });
      return;
    }
    const deleted = await db
      .delete(knowledgeRelationsTable)
      .where(
        and(
          eq(knowledgeRelationsTable.id, id),
          eq(knowledgeRelationsTable.pillarId, resolved.pillar.id),
        ),
      )
      .returning({ id: knowledgeRelationsTable.id });
    if (!deleted.length) {
      res.status(404).json({ error: "Relationship not found" });
      return;
    }
    res.status(204).end();
  },
);

router.post(
  "/faculty/pillars/:slug/knowledge/publish",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response) => {
    const resolved = await resolvePillar(req, String(req.params.slug));
    if ("error" in resolved) {
      res.status(resolved.status ?? 500).json({ error: resolved.error });
      return;
    }
    if (!resolved.canPublish) {
      res.status(403).json({ error: "Only this pillar's steward can publish knowledge" });
      return;
    }
    const body = publishSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Invalid version details", details: body.error.flatten() });
      return;
    }

    const claims = await listClaims(resolved.pillar.id, true);
    if (!claims.length) {
      res.status(400).json({ error: "Approve at least one claim before publishing a knowledge version" });
      return;
    }
    const claimIds = claims.map((claim) => claim.id);
    const relationships = (await listRelationships(resolved.pillar.id)).filter(
      (edge) =>
        claimIds.includes(edge.fromInterpretationId) &&
        claimIds.includes(edge.toInterpretationId),
    );
    const [latest] = await db
      .select({ version: knowledgeVersionsTable.version })
      .from(knowledgeVersionsTable)
      .where(eq(knowledgeVersionsTable.pillarId, resolved.pillar.id))
      .orderBy(desc(knowledgeVersionsTable.version))
      .limit(1);
    const version = (latest?.version ?? 0) + 1;
    const knowledgeVersion = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(knowledgeVersionsTable)
        .values({
          pillarId: resolved.pillar.id,
          version,
          label: body.data.label || `${resolved.pillar.name} knowledge v${version}`,
          note: body.data.note ?? null,
          claimCount: claims.length,
          relationCount: relationships.length,
          publishedByUserId: req.faculty!.user.id,
          snapshot: {
            schema: 2,
            pillar: {
              id: resolved.pillar.id,
              slug: resolved.pillar.slug,
              name: resolved.pillar.name,
            },
            claims: snapshotClaims(claims),
            relationships: relationships.map((edge) => ({
              fromInterpretationId: edge.fromInterpretationId,
              toInterpretationId: edge.toInterpretationId,
              relation: edge.relation,
              note: edge.note,
            })),
          },
        })
        .returning();

      // Snapshot every eligible retrieval chunk in the same transaction as the
      // version row. Historical retrieval never joins these rows back to the
      // mutable corpus, so later edits/re-embedding cannot alter this version.
      await tx.execute(sql`
        INSERT INTO knowledge_version_chunks (
          knowledge_version_id, kind, source_id, interpretation_id, pillar_id,
          chunk_index, text, embedding, embedding_model,
          source_title, source_authors, source_year, source_journal, source_doi,
          source_url, source_retention_status, source_study_design,
          source_reliability_rubric, pillar_slug, pillar_name,
          interpretation_author, interpretation_origin, interpretation_reviewer,
          advisor_lens_slug, advisor_lens_name
        )
        SELECT
          ${created.id}, 'interpretation', ic.source_id, ic.interpretation_id,
          ic.pillar_id, ic.chunk_index, ic.text, ic.embedding, ic.embedding_model,
          s.title, s.authors, s.year, s.journal, s.doi, s.source_url,
          s.retention_status, s.study_design,
          CASE WHEN s.assessment_status = 'approved' THEN s.assessment_rubric ELSE NULL END,
          p.slug, p.name, au.full_name, i.origin, ar.full_name,
          lens.lens_slug, lens.lens_name
        FROM interpretation_chunks ic
        JOIN interpretations i ON i.id = ic.interpretation_id
        JOIN sources s ON s.id = ic.source_id
        JOIN pillars p ON p.id = ic.pillar_id
        LEFT JOIN faculty_users au ON au.id = i.author_id
        LEFT JOIN faculty_users ar ON ar.id = i.approver_id
        LEFT JOIN LATERAL (
          SELECT lp.slug AS lens_slug, lp.name AS lens_name
          FROM faculty_memberships fm
          JOIN pillars lp ON lp.id = fm.pillar_id
          WHERE fm.user_id = i.author_id
            AND fm.role = 'steward'
            AND fm.pillar_id <> ic.pillar_id
          ORDER BY fm.id ASC
          LIMIT 1
        ) lens ON TRUE
        WHERE i.id IN (${sql.join(claimIds.map((id) => sql`${id}`), sql`, `)})
          AND i.status = 'approved'
          AND s.status = 'approved'
          AND ic.embedding IS NOT NULL
          AND ic.embedding_model IS NOT NULL
      `);
      await tx.execute(sql`
        INSERT INTO knowledge_version_chunks (
          knowledge_version_id, kind, source_id, interpretation_id, pillar_id,
          chunk_index, text, embedding, embedding_model,
          source_title, source_authors, source_year, source_journal, source_doi,
          source_url, source_retention_status, source_study_design,
          source_reliability_rubric, pillar_slug, pillar_name,
          interpretation_author, interpretation_origin, interpretation_reviewer,
          advisor_lens_slug, advisor_lens_name
        )
        SELECT
          ${created.id}, 'source', sc.source_id, NULL, s.pillar_id,
          sc.chunk_index, sc.text, sc.embedding, sc.embedding_model,
          s.title, s.authors, s.year, s.journal, s.doi, s.source_url,
          s.retention_status, s.study_design,
          CASE WHEN s.assessment_status = 'approved' THEN s.assessment_rubric ELSE NULL END,
          p.slug, p.name, NULL, NULL, NULL, NULL, NULL
        FROM source_chunks sc
        JOIN sources s ON s.id = sc.source_id
        JOIN pillars p ON p.id = s.pillar_id
        WHERE s.id IN (${sql.join(claims.map((claim) => sql`${claim.sourceId}`), sql`, `)})
          AND s.status = 'approved'
          AND sc.embedding IS NOT NULL
          AND sc.embedding_model IS NOT NULL
      `);
      const coverageResult = await tx.execute<{
        count: string;
        interpretation_count: string;
        source_count: string;
      }>(sql`
        SELECT
          COUNT(*)::text AS count,
          COUNT(DISTINCT interpretation_id)
            FILTER (WHERE kind = 'interpretation')::text AS interpretation_count,
          COUNT(DISTINCT source_id)
            FILTER (WHERE kind = 'source')::text AS source_count
        FROM knowledge_version_chunks
        WHERE knowledge_version_id = ${created.id}
      `);
      const rows = (coverageResult as unknown as {
        rows?: Array<{
          count: string;
          interpretation_count: string;
          source_count: string;
        }>;
      }).rows ?? [];
      const coverage = rows[0];
      const expectedSourceCount = new Set(claims.map((claim) => claim.sourceId)).size;
      if (
        Number(coverage?.count ?? 0) === 0 ||
        Number(coverage?.interpretation_count ?? 0) !== claims.length ||
        Number(coverage?.source_count ?? 0) !== expectedSourceCount
      ) {
        throw new Error(
          "Cannot publish knowledge without complete frozen retrieval material for every claim",
        );
      }
      return created;
    });
    res.status(201).json({ knowledgeVersion });
  },
);

export default router;
