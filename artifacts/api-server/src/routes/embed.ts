/**
 * Public embed API. Powers the iframeable answer widget that faculty
 * stewards drop into their own sites.
 *
 * GET /api/embed/pillar/:slug
 *   → { pillar, steward, interpretations: [...] }
 *
 * No auth — returns only `approved` interpretations (already public on
 * palonur.com). CORS is wide open so the embed page works in any iframe
 * origin; nothing here is privileged.
 */
import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  pillarsTable,
  facultyMembershipsTable,
  facultyUsersTable,
  interpretationsTable,
  sourcesTable,
} from "@workspace/db";

const router: IRouter = Router();

router.get("/embed/pillar/:slug", async (req, res): Promise<void> => {
  const slug = req.params.slug;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=60");

  const pillar = (
    await db.select().from(pillarsTable).where(eq(pillarsTable.slug, slug))
  )[0];
  if (!pillar) {
    res.status(404).json({ error: "pillar_not_found" });
    return;
  }

  // First steward on the pillar — typically the canonical faculty owner
  // (Matt for communication, Allison for communication originally, etc.).
  const stewardRow = (
    await db
      .select({
        id: facultyUsersTable.id,
        fullName: facultyUsersTable.fullName,
      })
      .from(facultyMembershipsTable)
      .innerJoin(
        facultyUsersTable,
        eq(facultyUsersTable.id, facultyMembershipsTable.userId),
      )
      .where(
        and(
          eq(facultyMembershipsTable.pillarId, pillar.id),
          eq(facultyMembershipsTable.role, "steward"),
        ),
      )
      .orderBy(facultyMembershipsTable.id)
      .limit(1)
  )[0];

  const interps = await db
    .select({
      id: interpretationsTable.id,
      answer: interpretationsTable.answer,
      interpretation: interpretationsTable.interpretation,
      action: interpretationsTable.action,
      tags: interpretationsTable.tags,
      sourceId: sourcesTable.id,
      sourceTitle: sourcesTable.title,
      sourceAuthors: sourcesTable.authors,
      sourceYear: sourcesTable.year,
      sourceDoi: sourcesTable.doi,
      sourceUrl: sourcesTable.sourceUrl,
    })
    .from(interpretationsTable)
    .innerJoin(
      sourcesTable,
      eq(sourcesTable.id, interpretationsTable.sourceId),
    )
    .where(
      and(
        eq(interpretationsTable.pillarId, pillar.id),
        eq(interpretationsTable.status, "approved"),
      ),
    )
    .orderBy(sql`${interpretationsTable.approvedAt} DESC NULLS LAST`);

  res.json({
    pillar: { slug: pillar.slug, name: pillar.name },
    // Deliberately no email — this is a public, cross-origin response;
    // steward identity is `name` only.
    steward: stewardRow ? { name: stewardRow.fullName } : null,
    interpretations: interps,
  });
});

router.options("/embed/pillar/:slug", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.sendStatus(204);
});

export default router;
