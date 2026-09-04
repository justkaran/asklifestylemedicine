import { beforeAll, afterAll, describe, test, expect, vi } from "vitest";
import {
  ensureCaptureLoopSchema,
  parseSseEvents,
  makeTopicEmbedding,
} from "./testHelpers.js";

// Set env BEFORE the route/lib modules load — they read these once at
// module-init time. `vi.hoisted` is the only way to win the import race.
vi.hoisted(() => {
  process.env.USE_GOVERNED_RAG = "true";
  process.env.RESEND_API_KEY = "stub-key";
});

// ─── Mocks (must be declared before importing the app) ─────────────────

vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: async () => ({ id: "stub-id" }),
    };
  },
}));

// The model always streams the same structured phones answer, citing
// Jamie's 2026 Stanford interview. On the grounded path this CITATION
// matches the retrieved provenance (→ verified); on the ungrounded
// fallback path the citation guard never runs, so the SAME answer must
// NOT be reported as faculty-verified.
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      stream: () => {
        const text = [
          "ANSWER:",
          "For adults it's mostly the content, not the screen light.",
          "",
          "CITATION:",
          "Zeitzer, 2026, Stanford Lifestyle Medicine",
          "",
          "PAPER:",
          '"Screen Time and Sleep — It\'s Different for Adults"',
          "",
          "FINDING:",
          "Phone screens emit ~25-50 lux vs 10,000-100,000 lux of daylight.",
          "",
          "INTERPRETATION:",
          "Stimulating content drives dopamine, not the dim screen light.",
          "",
          "ACTION:",
          "Skip exciting feeds for an hour before bed; get daylight by day.",
          "",
          "INSIGHT:",
          "Q: Is blue light the real problem for adults?",
          "A: No — the content keeping you engaged is.",
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
    };
  }
  return { default: FakeAnthropic };
});

// Deterministic embeddings: the seeded interview chunks mention
// "melatonin"/"light" → axis 10. A question that also mentions light lands
// on axis 10 (cosine ~1, covered); an off-topic question lands on axis 20
// (no match → below threshold → governed fallback).
vi.mock("../lib/embeddings.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/embeddings.js")>(
      "../lib/embeddings.js",
    );
  return {
    ...actual,
    embedTexts: vi.fn(async (texts: string[]) =>
      texts.map(makeTopicEmbedding),
    ),
  };
});

// Pin the agent to the seeded test pillar so the dev DB's pillars don't
// intercept routing.
const seededPillarRef: { id: number; slug: string; name: string } = {
  id: 0,
  slug: "",
  name: "",
};
vi.mock("../lib/pillarRouter.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/pillarRouter.js")>(
      "../lib/pillarRouter.js",
    );
  return {
    ...actual,
    routePillars: vi.fn(async () => ({
      pillars: [
        {
          id: seededPillarRef.id,
          slug: seededPillarRef.slug,
          name: seededPillarRef.name,
        },
      ],
      matchedKeywords: [],
      // Declare the mocked route a no-keyword fan-out (consistent with
      // matchedKeywords: []). This keeps the legacy Zeitzer fallback
      // eligible on the below-threshold path — the second test exercises
      // exactly that ungrounded fallback answer. A non-fallback route to
      // an exclusively non-sleep pillar would instead short-circuit a
      // deterministic UNCOVERED (see sleep-agent.ts legacySleepFallbackOk).
      fallback: true,
    })),
  };
});

// ─── Imports that depend on the mocks above ────────────────────────────

import type { Express } from "express";
import request from "supertest";
import pool from "../lib/db.js";
import { toVectorLiteral } from "../lib/embeddings.js";
import { clearEmbeddingCache } from "../lib/rag.js";

let app: Express;
let pillarId = 0;
let sourceId = 0;
let interpretationId = 0;
const pillarName = "Faculty Verified Pillar";
const pillarSlug = `fv-test-${Date.now()}`;
const stewardEmail = `fv-steward-${Date.now()}@test.local`;
const sourceTitle = "Screen Time and Sleep — It's Different for Adults";

beforeAll(async () => {
  await ensureCaptureLoopSchema();

  const { rows: pillarRows } = await pool.query<{ id: number }>(
    `INSERT INTO pillars (slug, name) VALUES ($1, $2) RETURNING id`,
    [pillarSlug, pillarName],
  );
  pillarId = pillarRows[0].id;
  seededPillarRef.id = pillarId;
  seededPillarRef.slug = pillarSlug;
  seededPillarRef.name = pillarName;

  const { rows: userRows } = await pool.query<{ id: number }>(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [`fv-clerk-${Date.now()}`, stewardEmail, "Jamie Zeitzer (test)"],
  );
  const stewardId = userRows[0].id;

  await pool.query(
    `INSERT INTO faculty_memberships (user_id, pillar_id, role)
     VALUES ($1, $2, 'steward')`,
    [stewardId, pillarId],
  );

  // Jamie's real Stanford interview, ingested as an approved slm_article.
  const { rows: sourceRows } = await pool.query<{ id: number }>(
    `INSERT INTO sources
        (pillar_id, kind, title, authors, year, journal, doi,
         abstract, source_url, status, uploaded_by_user_id)
       VALUES ($1, 'slm_article', $2, 'Zeitzer JM', 2026,
               'Stanford Lifestyle Medicine',
               'slm:screen-time-and-sleep-its-different-for-adults',
               'Why the screen-light-before-bed claim holds for children but not adults.',
               'https://lifestylemedicine.stanford.edu/screen-time-and-sleep-its-different-for-adults/',
               'approved', $3)
       RETURNING id`,
    [pillarId, sourceTitle, stewardId],
  );
  sourceId = sourceRows[0].id;

  const sourceChunkText =
    "Screen light at night is only ~25-50 lux versus 10,000-100,000 lux of daylight, so it has little impact on adult melatonin; the light is not the driver.";
  const sourceVec = toVectorLiteral(makeTopicEmbedding(sourceChunkText));
  await pool.query(
    `INSERT INTO source_chunks
       (source_id, chunk_index, text, embedding, embedding_model)
     VALUES ($1, 0, $2, $3::halfvec(384), 'Xenova/gte-small')`,
    [sourceId, sourceChunkText, sourceVec],
  );

  const { rows: interpRows } = await pool.query<{ id: number }>(
    `INSERT INTO interpretations
        (source_id, pillar_id, author_id, status, answer, interpretation,
         action, approver_id, approved_at)
       VALUES ($1, $2, $3, 'approved',
               'For adults it is mostly the content, not the screen light.',
               'Adults are less light-sensitive; the dim screen light barely affects melatonin.',
               'Skip exciting content an hour before bed; get daylight during the day.',
               $3, NOW())
       RETURNING id`,
    [sourceId, pillarId, stewardId],
  );
  interpretationId = interpRows[0].id;

  const interpChunkText =
    "Faculty take: for adults, dim screen light barely affects melatonin — stimulating content and dopamine keep you awake, not the light.";
  const interpVec = toVectorLiteral(makeTopicEmbedding(interpChunkText));
  await pool.query(
    `INSERT INTO interpretation_chunks
        (interpretation_id, source_id, pillar_id, chunk_index, text,
         embedding, embedding_model, priority)
       VALUES ($1, $2, $3, 0, $4, $5::halfvec(384), $6, 100)`,
    [
      interpretationId,
      sourceId,
      pillarId,
      interpChunkText,
      interpVec,
      "Xenova/gte-small",
    ],
  );

  clearEmbeddingCache();

  app = (await import("../app.js")).default;
});

afterAll(async () => {
  if (pillarId) {
    await pool.query(`DELETE FROM agent_queries WHERE $1 = ANY(pillar_ids)`, [
      pillarId,
    ]);
    await pool.query(`DELETE FROM query_clusters WHERE pillar_id = $1`, [
      pillarId,
    ]);
    await pool.query(
      `DELETE FROM interpretation_chunks WHERE pillar_id = $1`,
      [pillarId],
    );
    await pool.query(`DELETE FROM interpretations WHERE pillar_id = $1`, [
      pillarId,
    ]);
    await pool.query(
      `DELETE FROM source_chunks WHERE source_id IN
         (SELECT id FROM sources WHERE pillar_id = $1)`,
      [pillarId],
    );
    await pool.query(`DELETE FROM sources WHERE pillar_id = $1`, [pillarId]);
    await pool.query(`DELETE FROM faculty_memberships WHERE pillar_id = $1`, [
      pillarId,
    ]);
    await pool.query(`DELETE FROM faculty_users WHERE email = $1`, [
      stewardEmail,
    ]);
    await pool.query(`DELETE FROM pillars WHERE id = $1`, [pillarId]);
  }
  await pool.end();
});

describe("facultyVerified gating on /sleep-agent", () => {
  test(
    "grounded + citation-verified phones answer reports facultyVerified true",
    async () => {
      const agent = request.agent(app);

      // Mentions "light" → lands on the seeded chunks' axis → covered path.
      const question =
        "Does my phone's screen light before bed really hurt my sleep?";
      const res = await agent
        .post("/api/sleep-agent")
        .set("Sec-Fetch-Site", "same-origin")
        .send({ message: question })
        .set("Accept", "text/event-stream");
      expect(res.status).toBe(200);

      const events = parseSseEvents(res.text);
      const done = events.find((e) => e.done === true);
      expect(done).toBeDefined();

      // Resolved to the seeded interview interpretation/source.
      const provenance = (done!.provenance ?? []) as Array<{
        source_id: number;
        interpretation_id: number | null;
        title: string;
        authors: string | null;
        year: number | null;
      }>;
      const cited = provenance.find((p) => p.source_id === sourceId);
      expect(cited).toBeDefined();
      expect(cited!.title).toBe(sourceTitle);
      expect(cited!.authors).toBe("Zeitzer JM");
      expect(cited!.year).toBe(2026);
      expect(cited!.interpretation_id).toBe(interpretationId);

      // The single signal the client gates the "Verified by Prof. Jamie
      // Zeitzer" stamp on must be true here.
      expect(
        (done!.citationVerification as { status?: string } | null)?.status,
      ).toBe("verified");
      expect(done!.facultyVerified).toBe(true);
    },
  );

  test(
    "ungrounded fallback answer is NOT reported as faculty-verified",
    async () => {
      const agent = request.agent(app);

      // Off-axis question (no melatonin/light/circadian) → no approved chunk
      // clears the threshold → governed RAG falls back to the legacy corpus.
      // The model still streams a structured answer, but because it didn't
      // ride the governed covered path, the named-expert stamp must NOT show.
      const question = "What snacks should I eat for better sleep?";
      const res = await agent
        .post("/api/sleep-agent")
        .set("Sec-Fetch-Site", "same-origin")
        .send({ message: question })
        .set("Accept", "text/event-stream");
      expect(res.status).toBe(200);

      const events = parseSseEvents(res.text);
      const done = events.find((e) => e.done === true);
      expect(done).toBeDefined();

      // Fallback path: governedMiss set, no citation verification produced.
      expect(done!.governedMiss).toBe(true);
      expect(done!.citationVerification ?? null).toBeNull();
      // The crux: an ungrounded answer is never stamped "Verified by …".
      expect(done!.facultyVerified).not.toBe(true);
    },
  );
});
