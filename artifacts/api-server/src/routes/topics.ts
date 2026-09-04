/**
 * Public topic entry points — one page per ACTIVE pillar at /t/:slug.
 *
 * Each topic funnels readers to the steward's publication page (/p/:slug)
 * and its paid Q&A. Unlike the deliberately steward-free
 * /faculty/public/pillars endpoint, THIS surface intentionally names the
 * lead steward — that is the explicit product decision of the topic pages
 * (the /p page already exposes the same identity publicly). Retired pillars
 * 404 / are excluded, matching the rest of the public surfaces.
 */
import { Router, type IRouter } from "express";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@workspace/db";
import { pillarsTable } from "@workspace/db";
import { loadLeadStewards } from "../lib/stewardLookup.js";

const router: IRouter = Router();

// GET /api/topics — every active pillar with its lead steward + publication
// link (steward null when the pillar has none). Powers the homepage pillar
// strip and the /pillars grid links.
router.get("/topics", async (req, res) => {
  try {
    const pillars = await db
      .select({
        id: pillarsTable.id,
        slug: pillarsTable.slug,
        name: pillarsTable.name,
        description: pillarsTable.description,
      })
      .from(pillarsTable)
      .where(isNull(pillarsTable.retiredAt))
      .orderBy(asc(pillarsTable.name));
    const stewards = await loadLeadStewards(pillars.map((p) => p.id));
    return res.json({
      topics: pillars.map((p) => ({
        slug: p.slug,
        name: p.name,
        description: p.description,
        steward: stewards.get(p.id) ?? null,
      })),
    });
  } catch (e) {
    req.log.error({ err: e }, "topics list failed");
    return res.status(500).json({ error: "Failed to load topics" });
  }
});

// GET /api/topics/:slug — one active pillar; 404 for unknown or retired.
router.get("/topics/:slug", async (req, res) => {
  try {
    const [pillar] = await db
      .select({
        id: pillarsTable.id,
        slug: pillarsTable.slug,
        name: pillarsTable.name,
        description: pillarsTable.description,
      })
      .from(pillarsTable)
      .where(
        and(
          eq(pillarsTable.slug, req.params.slug),
          isNull(pillarsTable.retiredAt),
        ),
      );
    if (!pillar) return res.status(404).json({ error: "Topic not found" });
    const stewards = await loadLeadStewards([pillar.id]);
    return res.json({
      topic: {
        slug: pillar.slug,
        name: pillar.name,
        description: pillar.description,
        steward: stewards.get(pillar.id) ?? null,
      },
    });
  } catch (e) {
    req.log.error({ err: e }, "topic load failed");
    return res.status(500).json({ error: "Failed to load topic" });
  }
});

export default router;
