import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { Express } from "express";
import request from "supertest";
import pool from "../lib/db.js";
import { ensureCaptureLoopSchema } from "./testHelpers.js";

// Exercise the real faculty and pillar-role middleware without reaching Clerk.
// Each test switches this value to represent the currently signed-in faculty
// member; leaving it blank represents an unauthenticated visitor.
const authState = vi.hoisted(() => ({ clerkUserId: "" }));

vi.mock("@clerk/express", async () => {
  const actual =
    await vi.importActual<typeof import("@clerk/express")>("@clerk/express");
  return {
    ...actual,
    getAuth: () => ({ userId: authState.clerkUserId || null }),
    clerkClient: {
      users: {
        getUser: vi.fn(async () => ({
          primaryEmailAddress: null,
          emailAddresses: [],
          firstName: "",
          lastName: "",
        })),
        updateUser: vi.fn(async () => ({})),
        banUser: vi.fn(async () => ({})),
        unbanUser: vi.fn(async () => ({})),
        getUserList: vi.fn(async () => ({ data: [] })),
      },
    },
  };
});

const stamp = Date.now().toString(36);
const slug = "sleep";
const otherSlug = "nutrition";
const clerkIds = {
  viewer: `coach-video-viewer-${stamp}`,
  contributor: `coach-video-contributor-${stamp}`,
  steward: `coach-video-steward-${stamp}`,
  otherSteward: `coach-video-other-steward-${stamp}`,
};

let app: Express;
let pillarId = 0;
let otherPillarId = 0;
let videoId = 0;
let otherVideoId = 0;
let facultyUserIds: number[] = [];

function as(clerkUserId: string): void {
  authState.clerkUserId = clerkUserId;
}

beforeAll(async () => {
  await ensureCaptureLoopSchema();
  app = (await import("../app.js")).default;

  // Coach lessons have canonical pillar ownership. Use those real slugs so the
  // successful assignment exercises the route's lesson-to-pillar contract too.
  await pool.query(
    `INSERT INTO pillars (slug, name)
     VALUES ($1, $2), ($3, $4)
     ON CONFLICT (slug) DO NOTHING`,
    [slug, "Sleep", otherSlug, "Nutrition"],
  );
  const { rows: pillars } = await pool.query<{ id: number; slug: string }>(
    `SELECT id, slug FROM pillars WHERE slug = ANY($1::text[])`,
    [[slug, otherSlug]],
  );
  pillarId = pillars.find((pillar) => pillar.slug === slug)!.id;
  otherPillarId = pillars.find((pillar) => pillar.slug === otherSlug)!.id;

  const { rows: ownResources } = await pool.query<{ id: number }>(
    `INSERT INTO pillar_resources (pillar_id, title, url, category)
     VALUES ($1, 'Own pillar video', $2, 'Video')
     RETURNING id`,
    [
      pillarId,
      `https://example.test/coach-video-auth-${stamp}`,
    ],
  );
  videoId = ownResources[0].id;
  const { rows: otherResources } = await pool.query<{ id: number }>(
    `INSERT INTO pillar_resources (pillar_id, title, url, category)
     VALUES ($1, 'Other pillar video', $2, 'Video')
     RETURNING id`,
    [
      otherPillarId,
      `https://example.test/coach-video-auth-other-${stamp}`,
    ],
  );
  otherVideoId = otherResources[0].id;

  const { rows: users } = await pool.query<{ id: number }>(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name, is_platform_admin)
     VALUES
       ($1, $2, 'Coach video viewer', 'false'),
       ($3, $4, 'Coach video contributor', 'false'),
       ($5, $6, 'Coach video steward', 'false'),
       ($7, $8, 'Other coach video steward', 'false')
     RETURNING id`,
    [
      clerkIds.viewer,
      `coach-video-viewer-${stamp}@test.local`,
      clerkIds.contributor,
      `coach-video-contributor-${stamp}@test.local`,
      clerkIds.steward,
      `coach-video-steward-${stamp}@test.local`,
      clerkIds.otherSteward,
      `coach-video-other-steward-${stamp}@test.local`,
    ],
  );
  facultyUserIds = users.map((user) => user.id);

  await pool.query(
    `INSERT INTO faculty_memberships (user_id, pillar_id, role)
     VALUES
       ($1, $5, 'viewer'),
       ($2, $5, 'contributor'),
       ($3, $5, 'steward'),
       ($4, $6, 'steward')`,
    [
      facultyUserIds[0],
      facultyUserIds[1],
      facultyUserIds[2],
      facultyUserIds[3],
      pillarId,
      otherPillarId,
    ],
  );
});

afterAll(async () => {
  authState.clerkUserId = "";
  if (facultyUserIds.length > 0) {
    await pool.query(`DELETE FROM faculty_users WHERE id = ANY($1::int[])`, [
      facultyUserIds,
    ]);
  }
  if (videoId > 0 || otherVideoId > 0) {
    await pool.query(`DELETE FROM pillar_resources WHERE id = ANY($1::int[])`, [
      [videoId, otherVideoId].filter(Boolean),
    ]);
  }
});

describe("coach-video assignment authorization (real faculty middleware)", () => {
  const resourcesRoute = `/api/faculty/pillars/${slug}/resources`;
  const assignmentRoute = `/api/faculty/pillars/${slug}/coach-lessons/sleep-daylight/video`;
  const otherAssignmentRoute =
    `/api/faculty/pillars/${otherSlug}/coach-lessons/nutrition-pattern/video`;

  test("rejects unauthenticated resource-list and video-assignment requests", async () => {
    as("");

    await request(app)
      .get(resourcesRoute)
      .expect(401, { error: "Unauthorized" });
    await request(app)
      .put(assignmentRoute)
      .send({ resourceId: videoId })
      .expect(401, { error: "Unauthorized" });
  });

  test.each([
    ["viewer", clerkIds.viewer],
    ["contributor", clerkIds.contributor],
  ])("%s membership cannot list or change coach videos", async (_role, clerkUserId) => {
    as(clerkUserId);

    await request(app)
      .get(resourcesRoute)
      .expect(403, { error: "Forbidden" });
    await request(app)
      .put(assignmentRoute)
      .send({ resourceId: videoId })
      .expect(403, { error: "Forbidden" });
  });

  test("a steward lists and assigns a video only within their own pillar", async () => {
    as(clerkIds.steward);

    const resources = await request(app).get(resourcesRoute).expect(200);
    expect(resources.body.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: videoId, title: "Own pillar video" }),
      ]),
    );

    await request(app)
      .put(assignmentRoute)
      .send({ resourceId: videoId })
      .expect(200, {
        video: {
          lessonId: "sleep-daylight",
          title: "Own pillar video",
          url: `https://example.test/coach-video-auth-${stamp}`,
        },
      });

    // This steward has no membership in the other pillar, so neither a different
    // lesson nor a resource ID can be used to change its public coach video.
    await request(app)
      .put(otherAssignmentRoute)
      .send({ resourceId: otherVideoId })
      .expect(403, { error: "Forbidden" });

    const { rows } = await pool.query<{ coach_lesson_id: string | null }>(
      `SELECT coach_lesson_id
       FROM pillar_resources
       WHERE id = $1`,
      [otherVideoId],
    );
    expect(rows[0].coach_lesson_id).toBeNull();
  });

  test("a steward of a different pillar cannot list or change this pillar's video", async () => {
    as(clerkIds.otherSteward);

    await request(app)
      .get(resourcesRoute)
      .expect(403, { error: "Forbidden" });
    await request(app)
      .put(assignmentRoute)
      .send({ resourceId: videoId })
      .expect(403, { error: "Forbidden" });
  });
});