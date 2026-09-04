import { beforeAll, afterAll, describe, test, expect, vi } from "vitest";
import { ensureCaptureLoopSchema } from "./testHelpers.js";

// Match the env shape the other route tests rely on so the app boots
// the same way it does in the covered-path test.
vi.hoisted(() => {
  process.env.USE_GOVERNED_RAG = "true";
  process.env.RESEND_API_KEY = "stub-key";
});

vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: async () => ({ id: "stub-id" }),
    };
  },
}));

import type { Express } from "express";
import request from "supertest";
import pool from "../lib/db.js";

let app: Express;
let pillarId = 0;
let stewardUserId = 0;
let approvedSourceId = 0;
let approvedInterpretationId = 0;
let draftSourceId = 0;

const pillarSlug = `src-test-${Date.now()}`;
const pillarName = "Source Lookup Pillar";
const stewardEmail = `src-steward-${Date.now()}@test.local`;
const stewardName = "Dr. Source Steward";
const sourceTitle = "Sensitivity of the human circadian pacemaker to nocturnal light";

beforeAll(async () => {
  await ensureCaptureLoopSchema();

  const { rows: pillarRows } = await pool.query<{ id: number }>(
    `INSERT INTO pillars (slug, name) VALUES ($1, $2) RETURNING id`,
    [pillarSlug, pillarName],
  );
  pillarId = pillarRows[0].id;

  const { rows: userRows } = await pool.query<{ id: number }>(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [`src-clerk-${Date.now()}`, stewardEmail, stewardName],
  );
  stewardUserId = userRows[0].id;

  // Approved source the public sheet should expose.
  const { rows: sourceRows } = await pool.query<{ id: number }>(
    `INSERT INTO sources
        (pillar_id, kind, title, authors, year, journal, doi,
         abstract, source_url, status, uploaded_by_user_id)
       VALUES ($1, 'paper', $2, 'Zeitzer JM et al.', 2000, 'J Physiol',
               '10.1111/src-test',
               'Even very dim ordinary room light at night significantly suppresses melatonin.',
               'https://example.test/circadian-light',
               'approved', $3)
       RETURNING id`,
    [pillarId, sourceTitle, stewardUserId],
  );
  approvedSourceId = sourceRows[0].id;

  const { rows: interpRows } = await pool.query<{ id: number }>(
    `INSERT INTO interpretations
        (source_id, pillar_id, author_id, status, answer, interpretation,
         not_proven, action, approver_id, approved_at)
       VALUES ($1, $2, $3, 'approved',
               'Dim evening light suppresses melatonin.',
               'Keep evenings dim to protect your circadian clock.',
               'A causal effect on long-term sleep quality is not yet proven.',
               'Dim household lights two hours before bed.',
               $3, NOW())
       RETURNING id`,
    [approvedSourceId, pillarId, stewardUserId],
  );
  approvedInterpretationId = interpRows[0].id;

  // Draft source — same pillar, same shape, but not approved. The
  // endpoint must hide it.
  const { rows: draftRows } = await pool.query<{ id: number }>(
    `INSERT INTO sources
        (pillar_id, kind, title, authors, year, journal, status, uploaded_by_user_id)
       VALUES ($1, 'paper', 'Draft preprint', 'Anonymous', 2025, 'bioRxiv',
               'draft', $2)
       RETURNING id`,
    [pillarId, stewardUserId],
  );
  draftSourceId = draftRows[0].id;

  app = (await import("../app.js")).default;
});

afterAll(async () => {
  if (pillarId) {
    await pool.query(
      `DELETE FROM interpretations WHERE pillar_id = $1`,
      [pillarId],
    );
    await pool.query(`DELETE FROM sources WHERE pillar_id = $1`, [pillarId]);
    await pool.query(`DELETE FROM pillars WHERE id = $1`, [pillarId]);
  }
  if (stewardUserId) {
    await pool.query(`DELETE FROM faculty_users WHERE id = $1`, [
      stewardUserId,
    ]);
  }
  await pool.end();
});

describe("GET /api/sleep-agent/source/:id", () => {
  test("returns the full citation + abstract + nested interpretation for an approved source", async () => {
    const res = await request(app).get(
      `/api/sleep-agent/source/${approvedSourceId}`,
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      id: number;
      title: string;
      authors: string | null;
      year: number | null;
      journal: string | null;
      doi: string | null;
      abstract: string | null;
      kind: string;
      pillar_slug: string;
      pillar_name: string;
      interpretation: {
        id: number;
        answer: string;
        interpretation: string;
        not_proven: string | null;
        action: string | null;
        author_name: string | null;
      } | null;
    };
    expect(body.id).toBe(approvedSourceId);
    expect(body.title).toBe(sourceTitle);
    expect(body.authors).toBe("Zeitzer JM et al.");
    expect(body.year).toBe(2000);
    expect(body.journal).toBe("J Physiol");
    expect(body.doi).toBe("10.1111/src-test");
    expect(body.abstract).toMatch(/melatonin/i);
    expect(body.kind).toBe("paper");
    expect(body.pillar_slug).toBe(pillarSlug);
    expect(body.pillar_name).toBe(pillarName);

    expect(body.interpretation).not.toBeNull();
    const interp = body.interpretation!;
    expect(interp.id).toBe(approvedInterpretationId);
    expect(interp.answer).toMatch(/dim evening light/i);
    expect(interp.interpretation).toMatch(/circadian/i);
    expect(interp.not_proven).toMatch(/not yet proven/i);
    expect(interp.action).toMatch(/two hours before bed/i);
    expect(interp.author_name).toBe(stewardName);
  });

  test("returns 404 for a non-approved (draft) source id", async () => {
    const res = await request(app).get(
      `/api/sleep-agent/source/${draftSourceId}`,
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not found" });
  });

  test("returns 404 for an unknown source id", async () => {
    const res = await request(app).get(`/api/sleep-agent/source/999999999`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not found" });
  });
});
