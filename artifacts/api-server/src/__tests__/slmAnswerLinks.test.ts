import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

vi.hoisted(() => {
  process.env.SESSION_SECRET ||= "test-slm-answer-links-secret";
  // Small budget so the rate-limit case can trip it quickly.
  process.env.SLM_SHARE_LINK_IP_LIMIT = "6";
});

// ---------------------------------------------------------------------------
// /api/slm-answer-links — durable public answer permalinks for /slm.
// Contract under guard:
//   - create requires a valid queryId of an EXISTING 'slm-agent' row
//     (400 malformed, 404 unknown / non-slm sources),
//   - REFUSE answers are never shareable (422),
//   - creation is idempotent per queryId (same link twice),
//   - creation is rate limited per IP (429),
//   - the public snapshot leaks NOTHING internal: citations carry only the
//     seven public fields; chapter-split same-work sources collapse to one.
// ---------------------------------------------------------------------------

import type { Express } from "express";
import request from "supertest";
import pool from "../lib/db.js";
import { ensureCaptureLoopSchema } from "./testHelpers.js";

let app: Express;
let pillarId: number;

const PILLAR_SLUG = "slm-share-links-test-pillar";

async function seedSource(title: string): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO sources (pillar_id, title, authors, year, journal, source_url, status, kind)
     VALUES ($1, $2, 'Test Author', 2024, 'Test Journal', 'https://example.org/x', 'approved', 'paper')
     RETURNING id`,
    [pillarId, title],
  );
  return (rows[0] as { id: number }).id;
}

async function seedSlmQuery(args: {
  answer?: string;
  sourceIds?: number[];
  source?: string;
}): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO agent_queries (session_id, question, answer_text, source, retrieved_source_ids)
     VALUES ('slm-agent', $1, $2, $3, $4)
     RETURNING id`,
    [
      "Why do I wake up at 3 a.m.?",
      args.answer ??
        "ANSWER: Sleep drive declines in the early morning.\n\nCITATION: Author, 2024",
      args.source ?? "slm-agent",
      args.sourceIds ?? [],
    ],
  );
  return (rows[0] as { id: string }).id;
}

async function ensureFixtures(): Promise<void> {
  const { rows } = await pool.query(
    `INSERT INTO pillars (slug, name, description)
     VALUES ($1, 'Share Links Test', 'test pillar')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [PILLAR_SLUG],
  );
  pillarId = (rows[0] as { id: number }).id;
  // Additive schema sync creates the table but not the UNIQUE constraint the
  // idempotent upsert relies on — provision it explicitly (matches boot DDL).
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS slm_answer_links_query_id_key
       ON slm_answer_links (query_id)`,
  );
}

beforeAll(async () => {
  await ensureCaptureLoopSchema();
  app = (await import("../app.js")).default;
}, 60_000);

beforeEach(async () => {
  // Other suites TRUNCATE ... CASCADE mid-run; re-ensure fixtures idempotently.
  await ensureFixtures();
});

describe("POST /api/slm-answer-links", () => {
  test("400 on malformed queryId", async () => {
    const res = await request(app)
      .post("/api/slm-answer-links")
      .send({ queryId: "not-a-uuid" });
    expect(res.status).toBe(400);
  });

  test("404 on unknown queryId", async () => {
    const res = await request(app)
      .post("/api/slm-answer-links")
      .send({ queryId: crypto.randomUUID() });
    expect(res.status).toBe(404);
  });

  test("404 for non-slm sources (sleep-agent answers are not shareable here)", async () => {
    const queryId = await seedSlmQuery({ source: "sleep-agent" });
    const res = await request(app)
      .post("/api/slm-answer-links")
      .send({ queryId });
    expect(res.status).toBe(404);
  });

  test("422 for REFUSE answers", async () => {
    const queryId = await seedSlmQuery({
      answer: "REFUSE: This is outside what the faculty covers.",
    });
    const res = await request(app)
      .post("/api/slm-answer-links")
      .send({ queryId });
    expect(res.status).toBe(422);
  });

  test("create + fetch round-trip; idempotent per queryId; no internal leakage; same-work collapse", async () => {
    // Two chapter-split sources of the SAME work must collapse to one citation.
    const s1 = await seedSource("The Good Book (Chapter 1)");
    const s2 = await seedSource("The Good Book (Chapter 2)");
    const queryId = await seedSlmQuery({ sourceIds: [s1, s2] });

    const created = await request(app)
      .post("/api/slm-answer-links")
      .send({ queryId });
    expect(created.status).toBe(200);
    const id = created.body.id as string;
    expect(id).toMatch(/^[A-Za-z0-9_-]{10,64}$/);

    // Idempotent: same queryId → same link.
    const again = await request(app)
      .post("/api/slm-answer-links")
      .send({ queryId });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(id);

    const fetched = await request(app).get(`/api/slm-answer-links/${id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.question).toContain("3 a.m.");
    expect(fetched.body.answer).toContain("ANSWER:");

    const citations = fetched.body.citations as Array<Record<string, unknown>>;
    expect(citations).toHaveLength(1); // same-work collapsed
    expect(citations[0].title).toBe("The Good Book");
    // ONLY the public fields — nothing steward-internal may ride along.
    expect(Object.keys(citations[0]).sort()).toEqual(
      ["authors", "doi", "journal", "pillar_slug", "source_url", "title", "year"].sort(),
    );
    // The snapshot itself exposes only the public envelope.
    expect(Object.keys(fetched.body).sort()).toEqual(
      ["answer", "citations", "createdAt", "question"].sort(),
    );
  });

  test("429 once the per-IP creation budget is exhausted", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      const queryId = await seedSlmQuery({});
      const res = await request(app)
        .post("/api/slm-answer-links")
        .send({ queryId });
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
  });
});

describe("GET /api/slm-answer-links/:id", () => {
  test("404 on unknown id", async () => {
    const res = await request(app).get(
      "/api/slm-answer-links/AAAAAAAAAAAAAAAAAAAAAA",
    );
    expect(res.status).toBe(404);
  });

  test("404 on malformed id", async () => {
    const res = await request(app).get("/api/slm-answer-links/%20");
    expect(res.status).toBe(404);
  });
});
