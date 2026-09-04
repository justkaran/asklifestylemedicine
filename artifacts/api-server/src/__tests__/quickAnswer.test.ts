import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  test,
  expect,
  vi,
} from "vitest";
import { ensureVoiceProfileSchema, makeTopicEmbedding } from "./testHelpers.js";

// Env must be set before the route/lib modules read it at import time.
vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-quick-answer-secret";
  process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY = "stub-qa-key";
});

// ─── Mocks (declared before importing the app) ─────────────────────────

// The quick-answer drafter only ever calls the non-streaming
// `messages.create`. Return a fully structured HEADLINE/READING/LIMITS/ACTION
// reply so `parseQuickAnswer` yields a populated draft.
const anthropicState = vi.hoisted(() => ({ createCalls: 0 }));
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      create: async () => {
        anthropicState.createCalls += 1;
        return {
          content: [
            {
              type: "text",
              text: [
                "HEADLINE: Dim evening light helps you fall asleep on time.",
                "READING: Even ordinary room light at night suppresses melatonin and nudges your clock later. Keeping evenings dim protects that signal.",
                "LIMITS: This source does not prove dim light cures clinical insomnia.",
                "ACTION: Dim the household lights two hours before bed.",
              ].join("\n"),
            },
          ],
        };
      },
    };
  }
  return { default: FakeAnthropic };
});

// Deterministic embeddings so the seeded chunks land on the melatonin axis
// and the question matches them.
vi.mock("../lib/embeddings.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/embeddings.js")>(
      "../lib/embeddings.js",
    );
  return {
    ...actual,
    embedTexts: vi.fn(async (texts: string[]) => texts.map(makeTopicEmbedding)),
  };
});

// `stubFacultyUserId` lets each test act as a specific signed-in faculty user.
// `requirePillarRole` stays REAL so the steward/contributor membership gate is
// exercised end-to-end.
let stubFacultyUserId = 0;
vi.mock("../middlewares/facultyAuth.js", async () => {
  const actual =
    await vi.importActual<typeof import("../middlewares/facultyAuth.js")>(
      "../middlewares/facultyAuth.js",
    );
  const { db, facultyUsersTable, facultyMembershipsTable } = await import(
    "@workspace/db"
  );
  const { eq } = await import("drizzle-orm");
  return {
    ...actual,
    requireFacultyAuth: async (
      req: { faculty?: unknown; log?: unknown },
      res: { status: (n: number) => { json: (b: unknown) => void } },
      next: () => void,
    ) => {
      if (!stubFacultyUserId) {
        res.status(401).json({ error: "no stub user" });
        return;
      }
      const [user] = await db
        .select()
        .from(facultyUsersTable)
        .where(eq(facultyUsersTable.id, stubFacultyUserId));
      const memberships = await db
        .select()
        .from(facultyMembershipsTable)
        .where(eq(facultyMembershipsTable.userId, stubFacultyUserId));
      (req as { faculty: unknown }).faculty = { user, memberships };
      (req as { log: unknown }).log = {
        warn: () => {},
        info: () => {},
        error: () => {},
      };
      next();
    },
  };
});

// ─── Imports that depend on the mocks above ────────────────────────────

import type { Express } from "express";
import request from "supertest";
import pool from "../lib/db.js";
import { toVectorLiteral } from "../lib/embeddings.js";
import { clearEmbeddingCache } from "../lib/rag.js";

let app: Express;
const stamp = Date.now().toString(36);

let pillarId = 0; // pillar with an embedded source
let emptyPillarId = 0; // pillar with no embedded chunks
let stewardUserId = 0; // steward of `pillarId`
let outsiderUserId = 0; // faculty user with NO membership on `pillarId`
let sourceId = 0;

const pillarSlug = `qa-test-${stamp}`;
const emptyPillarSlug = `qa-empty-${stamp}`;

beforeAll(async () => {
  await ensureVoiceProfileSchema();
  app = (await import("../app.js")).default;

  const { rows: pillarRows } = await pool.query<{ id: number }>(
    `INSERT INTO pillars (slug, name) VALUES ($1,$2),($3,$4) RETURNING id`,
    [pillarSlug, "QA Test Pillar", emptyPillarSlug, "QA Empty Pillar"],
  );
  pillarId = pillarRows[0].id;
  emptyPillarId = pillarRows[1].id;

  const { rows: userRows } = await pool.query<{ id: number }>(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name, is_platform_admin)
     VALUES ($1,$2,$3,'false'),($4,$5,$6,'false')
     RETURNING id`,
    [
      `qa-steward-${stamp}`,
      `qa-steward-${stamp}@test.local`,
      "Dr. QA Steward",
      `qa-outsider-${stamp}`,
      `qa-outsider-${stamp}@test.local`,
      "Dr. No Membership",
    ],
  );
  stewardUserId = userRows[0].id;
  outsiderUserId = userRows[1].id;

  await pool.query(
    `INSERT INTO faculty_memberships (user_id, pillar_id, role)
     VALUES ($1,$2,'steward'),($1,$3,'steward')`,
    [stewardUserId, pillarId, emptyPillarId],
  );

  const { rows: sourceRows } = await pool.query<{ id: number }>(
    `INSERT INTO sources
        (pillar_id, kind, title, authors, year, journal, status, uploaded_by_user_id,
         rights_basis, retention_status)
       VALUES ($1, 'paper',
               'Sensitivity of the human circadian pacemaker to nocturnal light',
                'Zeitzer JM et al.', 2000, 'J Physiol', 'approved', $2,
                'permission', 'retained_with_rights')
       RETURNING id`,
    [pillarId, stewardUserId],
  );
  sourceId = sourceRows[0].id;

  const chunkText =
    "Even very dim ordinary room light at night significantly suppresses melatonin and shifts the human circadian clock.";
  await pool.query(
    `INSERT INTO source_chunks
       (source_id, chunk_index, text, embedding, embedding_model)
     VALUES ($1, 0, $2, $3::halfvec(384), 'Xenova/gte-small')`,
    [sourceId, chunkText, toVectorLiteral(makeTopicEmbedding(chunkText))],
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM source_chunks WHERE source_id = $1`, [sourceId]);
  await pool.query(`DELETE FROM sources WHERE pillar_id = ANY($1::int[])`, [
    [pillarId, emptyPillarId],
  ]);
  await pool.query(`DELETE FROM faculty_memberships WHERE user_id = $1`, [
    stewardUserId,
  ]);
  await pool.query(`DELETE FROM faculty_users WHERE id = ANY($1::int[])`, [
    [stewardUserId, outsiderUserId],
  ]);
  await pool.query(`DELETE FROM pillars WHERE id = ANY($1::int[])`, [
    [pillarId, emptyPillarId],
  ]);
});

beforeEach(() => {
  stubFacultyUserId = 0;
  anthropicState.createCalls = 0;
  clearEmbeddingCache();
  process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY = "stub-qa-key";
});

function draft(slug: string, body: Record<string, unknown>) {
  return request(app)
    .post(`/api/faculty/pillars/${slug}/quick-answer/draft`)
    .send(body);
}

describe("quick-answer draft route", () => {
  test("401 without a signed-in faculty user", async () => {
    const res = await draft(pillarSlug, { question: "Does dim light help?" });
    expect(res.status).toBe(401);
  });

  test("403 for a faculty user with no role on the pillar", async () => {
    stubFacultyUserId = outsiderUserId;
    const res = await draft(pillarSlug, { question: "Does dim light help?" });
    expect(res.status).toBe(403);
  });

  test("400 on an empty question", async () => {
    stubFacultyUserId = stewardUserId;
    const res = await draft(pillarSlug, { question: "" });
    expect(res.status).toBe(400);
  });

  test("drafts a structured in-voice answer grounded in the best source", async () => {
    stubFacultyUserId = stewardUserId;
    const res = await draft(pillarSlug, {
      question: "Does dim evening light help with melatonin and sleep?",
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.aiAvailable).toBe(true);
    expect(res.body.source).toMatchObject({ id: sourceId });
    expect(res.body.suggestions.length).toBeGreaterThan(0);
    expect(res.body.draft).toMatchObject({
      answer: "Dim evening light helps you fall asleep on time.",
    });
    expect(res.body.draft.interpretation).toContain("melatonin");
    expect(res.body.draft.notProven).toContain("does not prove");
    expect(res.body.draft.action).toContain("two hours before bed");
    expect(res.body.usedChunks).toBeGreaterThan(0);
    expect(anthropicState.createCalls).toBe(1);
  });

  test("drafts privately from an approved source while its rights record is pending", async () => {
    stubFacultyUserId = stewardUserId;
    await pool.query(
      `UPDATE sources
          SET rights_basis = NULL, retention_status = 'needs_review'
        WHERE id = $1`,
      [sourceId],
    );
    clearEmbeddingCache();
    try {
      const res = await draft(pillarSlug, {
        question: "Does dim evening light help with melatonin and sleep?",
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.source).toMatchObject({ id: sourceId });
      expect(res.body.usedChunks).toBeGreaterThan(0);
      expect(anthropicState.createCalls).toBe(1);
    } finally {
      await pool.query(
        `UPDATE sources
            SET rights_basis = 'permission', retention_status = 'retained_with_rights'
          WHERE id = $1`,
        [sourceId],
      );
      clearEmbeddingCache();
    }
  });

  test("reason:no_source when the pillar has no embedded chunks", async () => {
    stubFacultyUserId = stewardUserId;
    const res = await draft(emptyPillarSlug, {
      question: "Anything about melatonin?",
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.reason).toBe("no_source");
    expect(res.body.suggestions).toEqual([]);
  });

  test("aiAvailable:false when no AI key is configured", async () => {
    stubFacultyUserId = stewardUserId;
    delete process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
    const res = await draft(pillarSlug, {
      question: "Does dim evening light help with melatonin and sleep?",
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.aiAvailable).toBe(false);
    expect(res.body.draft).toBeNull();
    expect(res.body.source).toMatchObject({ id: sourceId });
    expect(anthropicState.createCalls).toBe(0);
  });
});
