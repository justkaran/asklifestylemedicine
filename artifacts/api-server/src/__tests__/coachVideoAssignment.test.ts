import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import request from "supertest";
import { pool } from "@workspace/db";
import { ensureCaptureLoopSchema } from "./testHelpers.js";

// This route-contract suite supplies a narrowly scoped steward context so it
// can exercise assignment validation without relying on an external Clerk
// session. The real pillar-role middleware is covered independently.
vi.mock("../middlewares/facultyAuth.js", async (importActual) => {
  const actual = await importActual<typeof import("../middlewares/facultyAuth.js")>();
  return {
    ...actual,
    requireFacultyAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
    requirePillarRole:
      () =>
      (req: { params: { slug: string }; header: (name: string) => string | undefined; pillar?: unknown }, _res: unknown, next: () => void) => {
        req.pillar = {
          id: Number(req.header("x-test-pillar-id")),
          // The isolated test pillar stands in for the named canonical pillar.
          slug: req.header("x-test-pillar-slug"),
        };
        next();
      },
  };
});

import app from "../app.js";

const stamp = Date.now().toString(36);
const slug = `coach-video-test-${stamp}`;
let pillarId = 0;
let videoId = 0;
let articleId = 0;

beforeAll(async () => {
  await ensureCaptureLoopSchema();
  const pillar = await pool.query<{ id: number }>(
    `INSERT INTO pillars (slug, name) VALUES ($1, $2) RETURNING id`,
    [slug, "Coach Video Test"],
  );
  pillarId = pillar.rows[0].id;
  const resources = await pool.query<{ id: number }>(
    `INSERT INTO pillar_resources (pillar_id, title, url, category)
     VALUES
       ($1, 'Watch this', $2, 'Video'),
       ($1, 'Read this', $3, 'Article')
     RETURNING id`,
    [
      pillarId,
      `https://example.test/coach-video-${stamp}`,
      `https://example.test/coach-article-${stamp}`,
    ],
  );
  videoId = resources.rows[0].id;
  articleId = resources.rows[1].id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM pillars WHERE id = $1`, [pillarId]);
});

describe("steward coach-video selection", () => {
  const route = `/api/faculty/pillars/${slug}/coach-lessons`;
  const coachLessons = [
    ["sleep-daylight", "sleep"],
    ["nutrition-pattern", "nutrition"],
    ["movement-walk", "movement"],
    ["stress-mindfulness", "stress-management"],
    ["connection-relationships", "social-connection"],
    ["cognition-brain-health", "cognitive-enhancement"],
    ["purpose-giving-back", "gratitude-purpose"],
  ] as const;

  test("rejects a same-pillar resource that is not categorized Video", async () => {
    await request(app)
      .put(`${route}/sleep-daylight/video`)
      .set({
        "x-test-pillar-id": String(pillarId),
        "x-test-pillar-slug": "sleep",
      })
      .send({ resourceId: articleId })
      .expect(422, { error: "resource_must_be_video" });
  });

  test.each(coachLessons)(
    "designates and clears a Video resource for %s",
    async (lessonId, pillarSlug) => {
      const headers = {
        "x-test-pillar-id": String(pillarId),
        "x-test-pillar-slug": pillarSlug,
      };
      const selected = await request(app)
        .put(`${route}/${lessonId}/video`)
        .set(headers)
        .send({ resourceId: videoId })
        .expect(200);
      expect(selected.body.video).toEqual({
        lessonId,
        title: "Watch this",
        url: `https://example.test/coach-video-${stamp}`,
      });

      const publicFeed = await request(app)
        .get(`/api/pillars/${slug}/coach-videos`)
        .expect(200);
      expect(publicFeed.body.videos).toEqual([
        {
          lessonId,
          title: "Watch this",
          url: `https://example.test/coach-video-${stamp}`,
        },
      ]);

      await request(app)
        .put(`${route}/${lessonId}/video`)
        .set(headers)
        .send({ resourceId: null })
        .expect(200, { video: null });

      const cleared = await request(app)
        .get(`/api/pillars/${slug}/coach-videos`)
        .expect(200);
      expect(cleared.body.videos).toEqual([]);
    },
  );

  test("rejects a lesson belonging to a different pillar", async () => {
    await request(app)
      .put(`${route}/nutrition-pattern/video`)
      .set({
        "x-test-pillar-id": String(pillarId),
        "x-test-pillar-slug": "sleep",
      })
      .send({ resourceId: videoId })
      .expect(422, { error: "lesson_not_in_pillar" });
  });
});