/**
 * pillarResources.test.ts
 *
 * Covers:
 *   (a) GET /api/pillars/:slug/resources returns seeded resources for dementia.
 *   (b) GET /api/pillars/:slug/resources returns [] for a pillar with no resources.
 *   (c) UNCOVERED SSE done event includes resources when the pillar has them.
 *   (d) UNCOVERED SSE done event omits resources when none exist.
 *   (e) POST /api/uncovered-escalation with surface='dementia' creates a DB row.
 *   (f) Embed-agent UNCOVERED for dementia pillar logs was_uncovered=true to
 *       agent_queries, so the dementia pillar surfaces in the coverage-gap tracker.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { pool } from "@workspace/db";
import app from "../app.js";
import {
  ensureCaptureLoopSchema,
  waitForAgentQueryRow,
  parseSseQueryId,
} from "./testHelpers.js";

let dementiaId: number;
let emptyPillarId: number;

// Unique question texts so parallel test runs don't step on each other.
const stamp = Date.now().toString(36);
const ESCALATION_QUESTION = `What are early Alzheimer signs ${stamp}?`;

beforeAll(async () => {
  // Provision uncovered_escalations and agent_queries tables/columns if they
  // are missing in the test DB (tests import app.ts not index.ts, so the
  // boot-time DDL never runs automatically).
  await ensureCaptureLoopSchema();

  // Ensure dementia pillar exists (boot seed may not have run in test env).
  const dp = await pool.query<{ id: number }>(
    `INSERT INTO pillars (slug, name)
       VALUES ('dementia-test-pillar', 'Dementia Test')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
  );
  dementiaId = dp.rows[0].id;

  // Seed a couple of test resources for the dementia test pillar.
  await pool.query(
    `INSERT INTO pillar_resources (pillar_id, title, url, description, category, display_order)
       VALUES
         ($1, 'Stanford ADRC Home', 'https://med.stanford.edu/adrc-test.html', 'Test resource', 'About', 0),
          ($1, 'ADRC Clinical Core', 'https://med.stanford.edu/adrc-test-clinical.html', 'Clinical detail', 'Research', 1),
          ($1, 'Approved video', 'https://med.stanford.edu/adrc-test-video.html', 'A video', 'Video', 2)
       ON CONFLICT (url) DO NOTHING`,
    [dementiaId],
  );

  // A second pillar with no resources.
  const ep = await pool.query<{ id: number }>(
    `INSERT INTO pillars (slug, name)
       VALUES ('empty-resources-test-pillar', 'Empty Resources Test')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
  );
  emptyPillarId = ep.rows[0].id;
});

afterAll(async () => {
  await pool.query(
    `DELETE FROM pillar_resources WHERE pillar_id IN ($1, $2)
       AND url LIKE 'https://med.stanford.edu/adrc-test%'`,
    [dementiaId, emptyPillarId],
  );
  // Clean up escalation rows created by test (e).
  await pool.query(
    `DELETE FROM uncovered_escalations WHERE question = $1 AND surface = 'dementia'`,
    [ESCALATION_QUESTION],
  );
  await pool.query(
    `DELETE FROM pillars WHERE slug IN ('dementia-test-pillar', 'empty-resources-test-pillar')`,
  );
});

describe("GET /api/pillars/:slug/resources", () => {
  it("(a) returns seeded resources for a pillar that has them", async () => {
    const res = await request(app)
      .get("/api/pillars/dementia-test-pillar/resources")
      .expect(200);

    expect(Array.isArray(res.body.resources)).toBe(true);
    expect(res.body.resources.length).toBeGreaterThanOrEqual(2);

    const first = res.body.resources[0];
    expect(first).toHaveProperty("id");
    expect(first).toHaveProperty("title");
    expect(first).toHaveProperty("url");
    expect(first).toHaveProperty("displayOrder");
    // Ordered by display_order ascending.
    expect(res.body.resources[0].displayOrder).toBeLessThanOrEqual(
      res.body.resources[1].displayOrder,
    );
  });

  it("(b) returns empty array for a pillar with no resources", async () => {
    const res = await request(app)
      .get("/api/pillars/empty-resources-test-pillar/resources")
      .expect(200);

    expect(res.body.resources).toEqual([]);
  });

  it("returns 404 for an unknown pillar slug", async () => {
    await request(app)
      .get("/api/pillars/totally-unknown-pillar-xyz/resources")
      .expect(404);
  });
});

describe("GET /api/pillars/:slug/coach-videos", () => {
  it("returns only a designated video and removes it when it is no longer approved as Video", async () => {
    await pool.query(
      `UPDATE pillar_resources
          SET coach_lesson_id = 'sleep-daylight'
        WHERE pillar_id = $1 AND url = 'https://med.stanford.edu/adrc-test-video.html'`,
      [dementiaId],
    );

    const selected = await request(app)
      .get("/api/pillars/dementia-test-pillar/coach-videos")
      .expect(200);
    expect(selected.body.videos).toEqual([
      {
        lessonId: "sleep-daylight",
        title: "Approved video",
        url: "https://med.stanford.edu/adrc-test-video.html",
      },
    ]);

    // A reclassification is the public approval boundary: no stale coach link
    // may survive after a video is unapproved.
    await pool.query(
      `UPDATE pillar_resources
          SET category = 'Article'
        WHERE pillar_id = $1 AND url = 'https://med.stanford.edu/adrc-test-video.html'`,
      [dementiaId],
    );
    const unapproved = await request(app)
      .get("/api/pillars/dementia-test-pillar/coach-videos")
      .expect(200);
    expect(unapproved.body.videos).toEqual([]);
  });
});

// ── SSE embed-agent UNCOVERED event tests ────────────────────────────────────
//
// These tests POST to /api/embed-agent with pillar slugs that have no RAG
// corpus (so retrieval always falls below threshold → UNCOVERED). We parse the
// SSE stream and check the done event payload.

async function collectSseDoneEvent(
  pillarSlug: string,
): Promise<Record<string, unknown>> {
  const res = await request(app)
    .post("/api/embed-agent")
    .set("Content-Type", "application/json")
    .set("Sec-Fetch-Site", "same-origin")
    .send({ message: "What are early signs of Alzheimer's disease?", pillar: pillarSlug });

  const text: string = res.text;
  const lines = text.split("\n\n").filter((s) => s.startsWith("data:"));
  let doneEvent: Record<string, unknown> = {};
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
      if (parsed.done) doneEvent = parsed;
    } catch {
      // skip malformed frames
    }
  }
  return doneEvent;
}

describe("embed-agent UNCOVERED SSE done event — resource attachment", () => {
  it("(c) includes resources array when the pillar has resource rows", async () => {
    const done = await collectSseDoneEvent("dementia-test-pillar");
    expect(done.uncovered).toBe(true);
    expect(Array.isArray(done.resources)).toBe(true);
    expect((done.resources as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  it("(d) omits resources key when the pillar has no resource rows", async () => {
    const done = await collectSseDoneEvent("empty-resources-test-pillar");
    expect(done.uncovered).toBe(true);
    expect(done.resources).toBeUndefined();
  });
});

// ── Uncovered-escalation row — dementia surface ───────────────────────────────
//
// The frontend auto-fires POST /api/uncovered-escalation after every UNCOVERED
// response, sending the question and the surface label (e.g. 'dementia').
// These tests confirm the server endpoint writes the row and that the surface
// field is preserved exactly as sent.

describe("POST /api/uncovered-escalation — dementia escalation row", () => {
  it("(e) creates an uncovered_escalations row with surface='dementia'", async () => {
    const res = await request(app)
      .post("/api/uncovered-escalation")
      .send({ question: ESCALATION_QUESTION, surface: "dementia" })
      .expect(200);

    expect(res.body.ok).toBe(true);

    const { rows } = await pool.query<{ surface: string; question: string }>(
      `SELECT surface, question FROM uncovered_escalations
         WHERE surface = 'dementia' AND question = $1
         ORDER BY created_at DESC LIMIT 1`,
      [ESCALATION_QUESTION],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].surface).toBe("dementia");
    expect(rows[0].question).toBe(ESCALATION_QUESTION);
  });
});

// ── Coverage-gap tracker: embed-agent UNCOVERED logs to agent_queries ─────────
//
// The admin/faculty coverage-gap view reads agent_queries WHERE was_uncovered=true
// grouped by pillar_ids. Confirm that after an UNCOVERED embed-agent response the
// log row lands with was_uncovered=true AND the correct pillar id, so the dementia
// pillar appears in the coverage-gap tracker without any manual intervention.

describe("embed-agent UNCOVERED logs to agent_queries (coverage-gap tracker)", () => {
  it(
    "(f) UNCOVERED response for dementia pillar writes was_uncovered=true to agent_queries",
    async () => {
      const res = await request(app)
        .post("/api/embed-agent")
        .set("Content-Type", "application/json")
        .set("Sec-Fetch-Site", "same-origin")
        .send({
          message: "Can dementia be reversed with diet?",
          pillar: "dementia-test-pillar",
        });

      // Extract the queryId from the SSE stream so we can poll for the row.
      const queryId = parseSseQueryId(res.text);
      expect(queryId).toBeTruthy();

      // logEmbedQuery runs fire-and-forget after res.end(); poll until the row
      // lands (up to ~3 s).
      await waitForAgentQueryRow(pool, queryId);

      const { rows } = await pool.query<{
        was_uncovered: boolean;
        pillar_ids: number[];
        source: string;
      }>(
        `SELECT was_uncovered, pillar_ids, source
           FROM agent_queries WHERE id = $1::uuid`,
        [queryId],
      );

      expect(rows.length).toBe(1);
      expect(rows[0].was_uncovered).toBe(true);
      // The pillar_ids array must contain the dementia test pillar id so the
      // coverage-gap queries (which filter by pillar) can surface this question.
      expect(rows[0].pillar_ids).toContain(dementiaId);
      expect(rows[0].source).toBe("embed-agent");
    },
  );
});
