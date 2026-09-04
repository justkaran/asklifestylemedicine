/**
 * Pillar Resource Links
 *
 * GET /api/pillars/:slug/resources             — public, read-only
 * GET /api/pillars/:slug/coach-videos          — public designated coach videos
 * GET /api/faculty/pillars/:slug/resources     — steward resource list
 * PUT /api/faculty/pillars/:slug/coach-lessons/:lessonId/video
 *                                                — steward selects or clears video
 * POST /api/admin/pillars/:slug/resources      — admin: create a resource
 * PATCH /api/admin/pillars/:slug/resources/:id — admin: update a resource
 * DELETE /api/admin/pillars/:slug/resources/:id — admin: delete a resource
 * PUT /api/admin/pillars/:slug/resources/reorder — admin: bulk reorder
 */
import { Router, type IRouter } from "express";
import { db, pillarsTable, pillarResourcesTable } from "@workspace/db";
import { eq, and, isNotNull } from "drizzle-orm";
import { asc } from "drizzle-orm";
import { checkAdmin } from "./admin";
import {
  requireFacultyAuth,
  requirePillarRole,
  type FacultyRequest,
} from "../middlewares/facultyAuth";

const router: IRouter = Router();

const COACH_LESSON_PILLARS: Record<string, string> = {
  "sleep-daylight": "sleep",
  "nutrition-pattern": "nutrition",
  "movement-walk": "movement",
  "stress-mindfulness": "stress-management",
  "connection-relationships": "social-connection",
  "cognition-brain-health": "cognitive-enhancement",
  "purpose-giving-back": "gratitude-purpose",
};

function paramStr(v: string | string[]): string {
  return Array.isArray(v) ? v[0] : v;
}

function isVideoCategory(category: string | null): boolean {
  return typeof category === "string" && /video/i.test(category);
}

async function resolvePillar(slug: string) {
  return (
    await db
      .select({ id: pillarsTable.id, slug: pillarsTable.slug })
      .from(pillarsTable)
      .where(eq(pillarsTable.slug, slug))
      .limit(1)
  )[0] ?? null;
}

// ── Shared resource fetcher ───────────────────────────────────────────────────

async function fetchResources(pillarId: number) {
  const rows = await db
    .select({
      id: pillarResourcesTable.id,
      title: pillarResourcesTable.title,
      url: pillarResourcesTable.url,
      description: pillarResourcesTable.description,
      category: pillarResourcesTable.category,
      coachLessonId: pillarResourcesTable.coachLessonId,
      displayOrder: pillarResourcesTable.displayOrder,
    })
    .from(pillarResourcesTable)
    .where(eq(pillarResourcesTable.pillarId, pillarId))
    .orderBy(asc(pillarResourcesTable.displayOrder));

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    url: r.url,
    description: r.description ?? null,
    category: r.category ?? null,
    coachLessonId: r.coachLessonId ?? null,
    displayOrder: r.displayOrder,
  }));
}

// ── Public: list resources for a pillar ───────────────────────────────────────

router.get(
  "/pillars/:slug/resources",
  async (req, res): Promise<void> => {
    const slug = paramStr(req.params.slug);

    const pillar = await resolvePillar(slug);
    if (!pillar) {
      res.status(404).json({ error: "pillar_not_found" });
      return;
    }

    res.json({ resources: await fetchResources(pillar.id) });
  },
);

// ── Public: designated coach videos only ─────────────────────────────────────

router.get(
  "/pillars/:slug/coach-videos",
  async (req, res): Promise<void> => {
    const slug = paramStr(req.params.slug);
    const pillar = await resolvePillar(slug);
    if (!pillar) {
      res.status(404).json({ error: "pillar_not_found" });
      return;
    }

    const rows = await db
      .select({
        lessonId: pillarResourcesTable.coachLessonId,
        title: pillarResourcesTable.title,
        url: pillarResourcesTable.url,
        category: pillarResourcesTable.category,
      })
      .from(pillarResourcesTable)
      .where(
        and(
          eq(pillarResourcesTable.pillarId, pillar.id),
          isNotNull(pillarResourcesTable.coachLessonId),
        ),
      );

    // This additional category check is deliberately at the public boundary.
    // A resource being reclassified or unapproved must disappear even if an old
    // assignment somehow survives a concurrent edit.
    res.json({
      videos: rows
        .filter((row) => isVideoCategory(row.category) && row.lessonId != null)
        .map((row) => ({
          lessonId: row.lessonId!,
          title: row.title,
          url: row.url,
        })),
    });
  },
);

// ── Faculty: steward resource list and lesson-level assignment ───────────────

router.get(
  "/faculty/pillars/:slug/resources",
  requireFacultyAuth,
  requirePillarRole({ slugParam: "slug" }, ["steward"]),
  async (req: FacultyRequest, res): Promise<void> => {
    res.json({ resources: await fetchResources(req.pillar!.id) });
  },
);

router.put(
  "/faculty/pillars/:slug/coach-lessons/:lessonId/video",
  requireFacultyAuth,
  requirePillarRole({ slugParam: "slug" }, ["steward"]),
  async (req: FacultyRequest, res): Promise<void> => {
    const pillar = req.pillar!;
    const lessonId = paramStr(req.params.lessonId);
    if (COACH_LESSON_PILLARS[lessonId] !== pillar.slug) {
      res.status(422).json({ error: "lesson_not_in_pillar" });
      return;
    }

    const rawResourceId = (req.body as { resourceId?: unknown } | undefined)
      ?.resourceId;
    if (
      rawResourceId !== null &&
      (typeof rawResourceId !== "number" ||
        !Number.isInteger(rawResourceId) ||
        rawResourceId <= 0)
    ) {
      res.status(400).json({ error: "resource_id_must_be_positive_integer_or_null" });
      return;
    }
    const resourceId: number | null = rawResourceId === null ? null : rawResourceId;

    if (resourceId === null) {
      await db
        .update(pillarResourcesTable)
        .set({ coachLessonId: null })
        .where(
          and(
            eq(pillarResourcesTable.pillarId, pillar.id),
            eq(pillarResourcesTable.coachLessonId, lessonId),
          ),
        );
      res.json({ video: null });
      return;
    }

    const [resource] = await db
      .select({
        id: pillarResourcesTable.id,
        title: pillarResourcesTable.title,
        url: pillarResourcesTable.url,
        category: pillarResourcesTable.category,
      })
      .from(pillarResourcesTable)
      .where(
        and(
          eq(pillarResourcesTable.id, resourceId),
          eq(pillarResourcesTable.pillarId, pillar.id),
        ),
      );
    if (!resource) {
      res.status(404).json({ error: "resource_not_found" });
      return;
    }
    if (!isVideoCategory(resource.category)) {
      res.status(422).json({ error: "resource_must_be_video" });
      return;
    }

    await db.transaction(async (tx) => {
      await tx
        .update(pillarResourcesTable)
        .set({ coachLessonId: null })
        .where(
          and(
            eq(pillarResourcesTable.pillarId, pillar.id),
            eq(pillarResourcesTable.coachLessonId, lessonId),
          ),
        );
      await tx
        .update(pillarResourcesTable)
        .set({ coachLessonId: lessonId })
        .where(eq(pillarResourcesTable.id, resource.id));
    });

    res.json({
      video: { lessonId, title: resource.title, url: resource.url },
    });
  },
);

// ── Admin: list resources for a pillar ───────────────────────────────────────

router.get(
  "/admin/pillars/:slug/resources",
  checkAdmin,
  async (req, res): Promise<void> => {
    const slug = paramStr(req.params.slug);

    const pillar = await resolvePillar(slug);
    if (!pillar) {
      res.status(404).json({ error: "pillar_not_found" });
      return;
    }

    res.json({ resources: await fetchResources(pillar.id) });
  },
);

// ── Admin: create resource ────────────────────────────────────────────────────

router.post(
  "/admin/pillars/:slug/resources",
  checkAdmin,
  async (req, res): Promise<void> => {
    const slug = paramStr(req.params.slug);
    const { title, url, description, category, displayOrder } = req.body as {
      title?: unknown;
      url?: unknown;
      description?: unknown;
      category?: unknown;
      displayOrder?: unknown;
    };

    if (typeof title !== "string" || !title.trim()) {
      res.status(400).json({ error: "title_required" });
      return;
    }
    if (typeof url !== "string" || !url.trim()) {
      res.status(400).json({ error: "url_required" });
      return;
    }

    const pillar = await resolvePillar(slug);
    if (!pillar) {
      res.status(404).json({ error: "pillar_not_found" });
      return;
    }

    try {
      const [row] = await db
        .insert(pillarResourcesTable)
        .values({
          pillarId: pillar.id,
          title: title.trim(),
          url: url.trim(),
          description: typeof description === "string" && description.trim() ? description.trim() : null,
          category: typeof category === "string" && category.trim() ? category.trim() : null,
          displayOrder: typeof displayOrder === "number" ? displayOrder : 0,
        })
        .returning();

      res.status(201).json({ resource: row });
    } catch (e: unknown) {
      const msg = (e as Error).message ?? "";
      if (msg.includes("pillar_resources_url_idx")) {
        res.status(409).json({ error: "url_already_exists" });
        return;
      }
      req.log.error({ err: e }, "pillar-resource create failed");
      res.status(500).json({ error: "internal_error" });
    }
  },
);

// ── Admin: update resource ────────────────────────────────────────────────────

router.patch(
  "/admin/pillars/:slug/resources/:id",
  checkAdmin,
  async (req, res): Promise<void> => {
    const slug = paramStr(req.params.slug);
    const resourceId = parseInt(paramStr(req.params.id), 10);
    if (isNaN(resourceId)) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }

    const pillar = await resolvePillar(slug);
    if (!pillar) {
      res.status(404).json({ error: "pillar_not_found" });
      return;
    }

    const { title, url, description, category, displayOrder } = req.body as {
      title?: unknown;
      url?: unknown;
      description?: unknown;
      category?: unknown;
      displayOrder?: unknown;
    };

    const patch: Partial<{
      title: string;
      url: string;
      description: string | null;
      category: string | null;
      coachLessonId: string | null;
      displayOrder: number;
    }> = {};

    if (typeof title === "string" && title.trim()) patch.title = title.trim();
    if (typeof url === "string" && url.trim()) patch.url = url.trim();
    if ("description" in req.body) patch.description = typeof description === "string" && description.trim() ? description.trim() : null;
    if ("category" in req.body) {
      patch.category = typeof category === "string" && category.trim() ? category.trim() : null;
      // A coach action is valid only while this remains a video resource.
      if (!isVideoCategory(patch.category)) patch.coachLessonId = null;
    }
    if (typeof displayOrder === "number") patch.displayOrder = displayOrder;

    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "no_fields" });
      return;
    }

    try {
      const [updated] = await db
        .update(pillarResourcesTable)
        .set(patch)
        .where(
          and(
            eq(pillarResourcesTable.id, resourceId),
            eq(pillarResourcesTable.pillarId, pillar.id),
          ),
        )
        .returning();

      if (!updated) {
        res.status(404).json({ error: "resource_not_found" });
        return;
      }

      res.json({ resource: updated });
    } catch (e: unknown) {
      const msg = (e as Error).message ?? "";
      if (msg.includes("pillar_resources_url_idx")) {
        res.status(409).json({ error: "url_already_exists" });
        return;
      }
      req.log.error({ err: e }, "pillar-resource update failed");
      res.status(500).json({ error: "internal_error" });
    }
  },
);

// ── Admin: delete resource ────────────────────────────────────────────────────

router.delete(
  "/admin/pillars/:slug/resources/:id",
  checkAdmin,
  async (req, res): Promise<void> => {
    const slug = paramStr(req.params.slug);
    const resourceId = parseInt(paramStr(req.params.id), 10);
    if (isNaN(resourceId)) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }

    const pillar = await resolvePillar(slug);
    if (!pillar) {
      res.status(404).json({ error: "pillar_not_found" });
      return;
    }

    const [deleted] = await db
      .delete(pillarResourcesTable)
      .where(
        and(
          eq(pillarResourcesTable.id, resourceId),
          eq(pillarResourcesTable.pillarId, pillar.id),
        ),
      )
      .returning({ id: pillarResourcesTable.id });

    if (!deleted) {
      res.status(404).json({ error: "resource_not_found" });
      return;
    }

    res.json({ ok: true });
  },
);

// ── Admin: bulk reorder ───────────────────────────────────────────────────────

router.put(
  "/admin/pillars/:slug/resources/reorder",
  checkAdmin,
  async (req, res): Promise<void> => {
    const slug = paramStr(req.params.slug);
    const { order } = req.body as { order?: unknown };

    if (!Array.isArray(order) || order.some((x) => typeof x !== "number")) {
      res.status(400).json({ error: "order_must_be_array_of_ids" });
      return;
    }

    const pillar = await resolvePillar(slug);
    if (!pillar) {
      res.status(404).json({ error: "pillar_not_found" });
      return;
    }

    const ids = order as number[];
    await db.transaction(async (tx) => {
      for (let i = 0; i < ids.length; i++) {
        await tx
          .update(pillarResourcesTable)
          .set({ displayOrder: i })
          .where(
            and(
              eq(pillarResourcesTable.id, ids[i]),
              eq(pillarResourcesTable.pillarId, pillar.id),
            ),
          );
      }
    });

    res.json({ ok: true });
  },
);

export default router;
