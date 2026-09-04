/**
 * Suggested follow-up chips — server-side coverage.
 *
 *  1. A covered embed answer's done event carries `suggestedQuestions`.
 *  2. Uncovered and refused outcomes never generate suggestions (the
 *     suggestion model is never called and the field is absent).
 *  3. When suggestion generation throws, the answer stream is unaffected:
 *     full content deltas + a normal done event, just without the field.
 *  4. parseSuggestionList unit cases.
 */
import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  test,
  expect,
  vi,
} from "vitest";
import {
  ensureCaptureLoopSchema,
  parseSseEvents,
  makeTopicEmbedding,
} from "./testHelpers.js";

// Set env BEFORE the route/lib modules load — they read these once at
// module-init time. `vi.hoisted` wins the import race.
vi.hoisted(() => {
  process.env.RESEND_API_KEY = "stub-key";
  process.env.SESSION_SECRET = "test-followups-secret";
  process.env.SLEEP_FREE_DAILY_QUESTION_LIMIT = "0";
});

vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: async () => ({ id: "stub-id" }),
    };
  },
}));

// Fake Anthropic SDK: `stream` powers the answer (structured covered text
// or a REFUSE line), `create` powers the follow-up-suggestion helper and
// can be flipped to return questions or throw.
const anthropicState = vi.hoisted(() => ({
  streamCalls: 0,
  createCalls: 0,
  mode: "covered" as "covered" | "refuse",
  createMode: "questions" as "questions" | "throw",
}));
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      stream: () => {
        anthropicState.streamCalls += 1;
        const text =
          anthropicState.mode === "refuse"
            ? "REFUSE: This assistant only answers questions about Followup Pillar."
            : [
                "ANSWER:",
                "Dim evening light suppresses melatonin and shifts your clock later.",
                "",
                "CITATION:",
                "Zeitzer et al., 2000, J Physiol",
                "",
                "PAPER:",
                '"Sensitivity of the human circadian pacemaker to nocturnal light"',
                "",
                "FINDING:",
                "Even ~100 lux at night significantly suppresses melatonin.",
                "",
                "INTERPRETATION:",
                "Keep evenings dim if you want to fall asleep on time.",
                "",
                "ACTION:",
                "Dim household lights two hours before bed tonight.",
                "",
                "INSIGHT:",
                "Q: Is dim room light really enough to matter?",
                "A: Yes, the dose-response saturates near 100 lux.",
              ].join("\n");
        async function* gen() {
          for (const piece of text.match(/[\s\S]{1,40}/g) ?? []) {
            yield {
              type: "content_block_delta",
              delta: { type: "text_delta", text: piece },
            };
          }
        }
        return gen();
      },
      create: async () => {
        anthropicState.createCalls += 1;
        if (anthropicState.createMode === "throw") {
          throw new Error("suggestion model unavailable");
        }
        return {
          content: [
            {
              type: "text",
              text: '["Does the color of evening light matter?", "How long before bed should lights go dim?"]',
            },
          ],
        };
      },
    };
  }
  return { default: FakeAnthropic };
});

// Deterministic embeddings: melatonin questions land on the seeded chunk's
// axis (covered), an unrelated "focus" question lands elsewhere (uncovered).
vi.mock("../lib/embeddings.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/embeddings.js")>(
    "../lib/embeddings.js",
  );
  return {
    ...actual,
    embedTexts: vi.fn(async (texts: string[]) => texts.map(makeTopicEmbedding)),
  };
});

// ─── Imports that depend on the mocks above ────────────────────────────

import type { Express } from "express";
import request from "supertest";
import pool from "../lib/db.js";
import { toVectorLiteral } from "../lib/embeddings.js";
import { clearEmbeddingCache } from "../lib/rag.js";
import { parseSuggestionList } from "../lib/followUpSuggestions.js";
import { __resetPartnerKeyCountersForTests } from "../middlewares/partnerKey.js";

let app: Express;
let pillarId = 0;
let stewardUserId = 0;
let sourceId = 0;

const pillarSlug = `followups-test-${Date.now()}`;
const stewardEmail = `followups-steward-${Date.now()}@test.local`;

beforeAll(async () => {
  await ensureCaptureLoopSchema();

  const { rows: pillarRows } = await pool.query<{ id: number }>(
    `INSERT INTO pillars (slug, name) VALUES ($1, 'Followup Pillar') RETURNING id`,
    [pillarSlug],
  );
  pillarId = pillarRows[0].id;

  const { rows: userRows } = await pool.query<{ id: number }>(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name)
     VALUES ($1, $2, 'Dr. Followup Steward') RETURNING id`,
    [`followups-clerk-${Date.now()}`, stewardEmail],
  );
  stewardUserId = userRows[0].id;

  await pool.query(
    `INSERT INTO faculty_memberships (user_id, pillar_id, role)
     VALUES ($1, $2, 'steward')`,
    [stewardUserId, pillarId],
  );

  const { rows: sourceRows } = await pool.query<{ id: number }>(
    `INSERT INTO sources
        (pillar_id, kind, title, authors, year, journal, doi,
         abstract, source_url, status, uploaded_by_user_id)
       VALUES ($1, 'paper',
               'Sensitivity of the human circadian pacemaker to nocturnal light',
               'Zeitzer JM et al.', 2000, 'J Physiol',
               '10.1111/followups-test', 'Stub abstract on melatonin.',
               'https://example.test/circadian-light',
               'approved', $2)
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

  clearEmbeddingCache();
  app = (await import("../app.js")).default;
});

afterAll(async () => {
  if (pillarId) {
    await pool.query(`DELETE FROM agent_queries WHERE $1 = ANY(pillar_ids)`, [
      pillarId,
    ]);
    await pool.query(`DELETE FROM source_chunks WHERE source_id = $1`, [
      sourceId,
    ]);
    await pool.query(`DELETE FROM sources WHERE pillar_id = $1`, [pillarId]);
    await pool.query(`DELETE FROM faculty_memberships WHERE pillar_id = $1`, [
      pillarId,
    ]);
    await pool.query(`DELETE FROM pillars WHERE id = $1`, [pillarId]);
  }
  if (stewardUserId) {
    await pool.query(`DELETE FROM faculty_users WHERE id = $1`, [
      stewardUserId,
    ]);
  }
  await pool.end();
});

beforeEach(() => {
  anthropicState.streamCalls = 0;
  anthropicState.createCalls = 0;
  anthropicState.mode = "covered";
  anthropicState.createMode = "questions";
  __resetPartnerKeyCountersForTests();
  clearEmbeddingCache();
});

const askEmbed = (message: string) =>
  request(app)
    .post("/api/embed-agent")
    .set("Sec-Fetch-Site", "same-origin")
    .send({ message, pillar: pillarSlug });

describe("suggested follow-up questions on the embed agent SSE", () => {
  test("covered answer's done event carries 1-2 suggestedQuestions", async () => {
    const res = await askEmbed("Does dim evening light affect melatonin?");
    expect(res.status).toBe(200);
    const events = parseSseEvents(res.text);
    const done = events.find((e) => e.done);
    expect(done).toBeTruthy();
    expect(done!.suggestedQuestions).toEqual([
      "Does the color of evening light matter?",
      "How long before bed should lights go dim?",
    ]);
    expect(anthropicState.createCalls).toBe(1);
  });

  test("uncovered answer gets no suggestions and never calls the suggestion model", async () => {
    const res = await askEmbed("How do I focus better at work?");
    expect(res.status).toBe(200);
    const events = parseSseEvents(res.text);
    const done = events.find((e) => e.done);
    expect(done).toBeTruthy();
    expect(done!.suggestedQuestions).toBeUndefined();
    expect(anthropicState.createCalls).toBe(0);
  });

  test("refused answer gets no suggestions and never calls the suggestion model", async () => {
    anthropicState.mode = "refuse";
    const res = await askEmbed("Does dim evening light affect melatonin?");
    expect(res.status).toBe(200);
    const events = parseSseEvents(res.text);
    const done = events.find((e) => e.done);
    expect(done).toBeTruthy();
    expect(done!.suggestedQuestions).toBeUndefined();
    expect(anthropicState.createCalls).toBe(0);
  });

  test("suggestion-model failure never breaks or alters the answer stream", async () => {
    anthropicState.createMode = "throw";
    const res = await askEmbed("Does dim evening light affect melatonin?");
    expect(res.status).toBe(200);
    const events = parseSseEvents(res.text);
    // Full answer text still streamed.
    const streamed = events
      .filter((e) => typeof e.content === "string")
      .map((e) => e.content)
      .join("");
    expect(streamed).toContain("ANSWER:");
    expect(streamed).toContain("Zeitzer");
    // Normal covered done event, just without the suggestions field.
    const done = events.find((e) => e.done);
    expect(done).toBeTruthy();
    expect(Array.isArray(done!.provenance)).toBe(true);
    expect((done!.provenance as unknown[]).length).toBeGreaterThan(0);
    expect(done!.suggestedQuestions).toBeUndefined();
    expect(anthropicState.createCalls).toBe(1);
  });
});

describe("parseSuggestionList", () => {
  test("extracts up to two clean questions from a JSON array", () => {
    expect(
      parseSuggestionList('Sure! ["One?", "Two?", "Three?"] hope that helps'),
    ).toEqual(["One?", "Two?"]);
  });

  test("drops non-strings, blanks, over-long items, and duplicates", () => {
    const long = `${"x".repeat(200)}?`;
    expect(
      parseSuggestionList(JSON.stringify([42, "  ", long, "One?", "one?"])),
    ).toEqual(["One?"]);
  });

  test("returns [] on non-JSON or non-array replies", () => {
    expect(parseSuggestionList("I suggest asking about naps.")).toEqual([]);
    expect(parseSuggestionList('{"a": 1}')).toEqual([]);
  });
});
