import { beforeAll, afterAll, beforeEach, describe, test, expect, vi } from "vitest";
import {
  ensureCaptureLoopSchema,
  parseSseEvents,
  makeTopicEmbedding,
} from "./testHelpers.js";

// Set env BEFORE the route/lib modules load — they read these once at
// module-init time. `vi.hoisted` wins the import race.
vi.hoisted(() => {
  process.env.RESEND_API_KEY = "stub-key";
  process.env.SESSION_SECRET = "test-embed-secret";
});

// ─── Mocks (must be declared before importing the app) ─────────────────

vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: async () => ({ id: "stub-id" }),
    };
  },
}));

// Track how many times the LLM stream is opened so the UNCOVERED
// short-circuit can be asserted to make NO model call. `mode` lets a test
// flip the stream between the structured covered answer (default) and a
// bare REFUSE: line, so the refusal branch can be exercised end-to-end
// without a real model. The covered text streams a fully structured,
// citation-bearing ANSWER block so the route's citation guard runs and
// verifies against the seeded source.
const anthropicState = vi.hoisted(
  () => ({ streamCalls: 0, mode: "covered" as "covered" | "refuse" }),
);
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      stream: () => {
        anthropicState.streamCalls += 1;
        const text =
          anthropicState.mode === "refuse"
            ? "REFUSE: This assistant only answers questions about Embed Agent Pillar."
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
    };
  }
  return { default: FakeAnthropic };
});

// Deterministic embeddings so the seeded chunks land on the same axis as
// a melatonin question (cosine ~1, clears RAG_MIN_SCORE) and an unrelated
// "focus" question lands on a different axis (cosine 0, UNCOVERED).
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

// Spy on retrieve while delegating to the real implementation. This lets
// us assert the embed agent locks retrieval to EXACTLY one pillar id with
// no cross-pillar / legacy fallback — the safety-critical guarantee.
const retrieveSpy = vi.hoisted(
  () => ({ calls: [] as Array<{ pillarIds: number[] }> }),
);
vi.mock("../lib/rag.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/rag.js")>("../lib/rag.js");
  return {
    ...actual,
    retrieve: vi.fn(async (opts: Parameters<typeof actual.retrieve>[0]) => {
      retrieveSpy.calls.push({ pillarIds: opts.pillarIds });
      return actual.retrieve(opts);
    }),
  };
});

// ─── Imports that depend on the mocks above ────────────────────────────

import type { Express } from "express";
import request from "supertest";
import { createHash, randomBytes } from "node:crypto";
import pool from "../lib/db.js";
import { toVectorLiteral } from "../lib/embeddings.js";
import { clearEmbeddingCache } from "../lib/rag.js";
import { __resetPartnerKeyCountersForTests } from "../middlewares/partnerKey.js";

// ─── Partner-key seeding (mirrors partnerKeyMiddleware.test.ts) ─────────
async function ensurePartnerKeysSchema(): Promise<void> {
  await pool.query(`DO $$ BEGIN
    CREATE TYPE partner_key_tier AS ENUM ('pilot','production');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  await pool.query(`CREATE TABLE IF NOT EXISTS partner_keys (
    id SERIAL PRIMARY KEY,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    partner_name TEXT NOT NULL,
    contact_email TEXT,
    scopes TEXT[] NOT NULL DEFAULT ARRAY['sleep-agent']::text[],
    tier partner_key_tier NOT NULL DEFAULT 'pilot',
    rate_per_minute INTEGER NOT NULL DEFAULT 60,
    rate_per_day INTEGER NOT NULL DEFAULT 50000,
    concurrent_streams INTEGER NOT NULL DEFAULT 10,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ
  )`);
}

const insertedKeyIds: number[] = [];

async function insertPartnerKey(opts: {
  partnerName: string;
  scopes?: string[];
}): Promise<string> {
  const raw = `plnr_test_${randomBytes(16).toString("hex")}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  const prefix = raw.slice(0, 14);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO partner_keys
       (key_hash, key_prefix, partner_name, scopes, tier,
        rate_per_minute, rate_per_day, concurrent_streams)
     VALUES ($1, $2, $3, $4, 'pilot', 60, 50000, 10)
     RETURNING id`,
    [hash, prefix, opts.partnerName, opts.scopes ?? ["embed-agent"]],
  );
  insertedKeyIds.push(rows[0].id);
  return raw;
}

let app: Express;
let pillarId = 0;
let stewardUserId = 0;
let sourceId = 0;
let interpretationId = 0;

const pillarSlug = `embed-test-${Date.now()}`;
const pillarName = "Embed Agent Pillar";
const expertName = "Dr. Embed Steward";
const stewardEmail = `embed-steward-${Date.now()}@test.local`;
const sourceTitle =
  "Sensitivity of the human circadian pacemaker to nocturnal light";

beforeAll(async () => {
  await ensureCaptureLoopSchema();
  await ensurePartnerKeysSchema();

  const { rows: pillarRows } = await pool.query<{ id: number }>(
    `INSERT INTO pillars (slug, name) VALUES ($1, $2) RETURNING id`,
    [pillarSlug, pillarName],
  );
  pillarId = pillarRows[0].id;

  const { rows: userRows } = await pool.query<{ id: number }>(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [`embed-clerk-${Date.now()}`, stewardEmail, expertName],
  );
  stewardUserId = userRows[0].id;

  await pool.query(
    `INSERT INTO faculty_memberships (user_id, pillar_id, role)
     VALUES ($1, $2, 'steward')`,
    [stewardUserId, pillarId],
  );

  // Approved source the embed agent should retrieve + cite.
  const { rows: sourceRows } = await pool.query<{ id: number }>(
    `INSERT INTO sources
        (pillar_id, kind, title, authors, year, journal, doi,
         abstract, source_url, status, uploaded_by_user_id)
       VALUES ($1, 'paper', $2, 'Zeitzer JM et al.', 2000, 'J Physiol',
               '10.1111/embed-test', 'Stub abstract on melatonin.',
               'https://example.test/circadian-light',
               'approved', $3)
       RETURNING id`,
    [pillarId, sourceTitle, stewardUserId],
  );
  sourceId = sourceRows[0].id;

  const sourceChunkText =
    "Even very dim ordinary room light at night significantly suppresses melatonin and shifts the human circadian clock.";
  await pool.query(
    `INSERT INTO source_chunks
       (source_id, chunk_index, text, embedding, embedding_model)
     VALUES ($1, 0, $2, $3::halfvec(384), 'Xenova/gte-small')`,
    [sourceId, sourceChunkText, toVectorLiteral(makeTopicEmbedding(sourceChunkText))],
  );

  const { rows: interpRows } = await pool.query<{ id: number }>(
    `INSERT INTO interpretations
        (source_id, pillar_id, author_id, status, answer, interpretation,
         action, approver_id, approved_at)
       VALUES ($1, $2, $3, 'approved',
               'Dim evening light suppresses melatonin.',
               'Keep evenings dim to protect your circadian clock.',
               'Dim household lights two hours before bed.',
               $3, NOW())
       RETURNING id`,
    [sourceId, pillarId, stewardUserId],
  );
  interpretationId = interpRows[0].id;

  const interpChunkText =
    "Faculty take: dim evening light protects melatonin and your circadian rhythm — dim the lights two hours before bed.";
  await pool.query(
    `INSERT INTO interpretation_chunks
        (interpretation_id, source_id, pillar_id, chunk_index, text,
         embedding, embedding_model, priority)
       VALUES ($1, $2, $3, 0, $4, $5::halfvec(384), 'Xenova/gte-small', 100)`,
    [
      interpretationId,
      sourceId,
      pillarId,
      interpChunkText,
      toVectorLiteral(makeTopicEmbedding(interpChunkText)),
    ],
  );

  clearEmbeddingCache();
  app = (await import("../app.js")).default;
});

afterAll(async () => {
  if (pillarId) {
    await pool.query(`DELETE FROM interpretation_chunks WHERE pillar_id = $1`, [
      pillarId,
    ]);
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
    await pool.query(`DELETE FROM pillars WHERE id = $1`, [pillarId]);
  }
  if (stewardUserId) {
    await pool.query(`DELETE FROM faculty_users WHERE id = $1`, [stewardUserId]);
  }
  if (insertedKeyIds.length > 0) {
    await pool.query(`DELETE FROM partner_keys WHERE id = ANY($1::int[])`, [
      insertedKeyIds,
    ]);
  }
  await pool.end();
});

beforeEach(() => {
  anthropicState.streamCalls = 0;
  anthropicState.mode = "covered";
  retrieveSpy.calls.length = 0;
  __resetPartnerKeyCountersForTests();
  clearEmbeddingCache();
});

describe("POST /api/embed-agent — input validation", () => {
  test("missing message returns 400", async () => {
    const res = await request(app)
      .post("/api/embed-agent")
      .set("Sec-Fetch-Site", "same-origin")
      .send({ pillar: pillarSlug });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "message required" });
    expect(anthropicState.streamCalls).toBe(0);
  });

  test("blank message returns 400", async () => {
    const res = await request(app)
      .post("/api/embed-agent")
      .set("Sec-Fetch-Site", "same-origin")
      .send({ message: "   ", pillar: pillarSlug });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "message required" });
  });

  test("missing pillar returns 400", async () => {
    const res = await request(app)
      .post("/api/embed-agent")
      .set("Sec-Fetch-Site", "same-origin")
      .send({ message: "Does evening light matter?" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "pillar required" });
    expect(anthropicState.streamCalls).toBe(0);
  });
});

describe("POST /api/embed-agent — unknown pillar", () => {
  test("unknown pillar slug streams pillar_not_found and never calls the LLM", async () => {
    const res = await request(app)
      .post("/api/embed-agent")
      .send({ message: "Does evening light matter?", pillar: "no-such-pillar" })
      .set("Sec-Fetch-Site", "same-origin")
      .set("Accept", "text/event-stream");
    expect(res.status).toBe(200);

    const events = parseSseEvents(res.text);
    expect(events.some((e) => e.error === "pillar_not_found")).toBe(true);
    expect(anthropicState.streamCalls).toBe(0);
  });
});

describe("POST /api/embed-agent — covered path", () => {
  test("streams an answer + verified citationVerification, locked to one pillar", async () => {
    const res = await request(app)
      .post("/api/embed-agent")
      .send({
        message: "Does evening melatonin shift the circadian clock?",
        pillar: pillarSlug,
      })
      .set("Sec-Fetch-Site", "same-origin")
      .set("Accept", "text/event-stream");
    expect(res.status).toBe(200);

    const events = parseSseEvents(res.text);

    // Streamed answer text reached the client and is NOT a refusal.
    const streamed = events
      .map((e) => (typeof e.content === "string" ? e.content : ""))
      .join("");
    expect(streamed).toMatch(/melatonin/i);
    expect(streamed).not.toMatch(/UNCOVERED:/);
    expect(streamed).not.toMatch(/REFUSE:/);

    // The LLM was invoked exactly once on the covered path.
    expect(anthropicState.streamCalls).toBe(1);

    // Retrieval was hard-locked to EXACTLY this one pillar id — no
    // cross-pillar routing, no legacy-corpus fallback.
    expect(retrieveSpy.calls).toHaveLength(1);
    expect(retrieveSpy.calls[0].pillarIds).toEqual([pillarId]);

    // The done event carries provenance for the seeded source and a
    // verified citation guard result.
    const done = events.find((e) => e.done === true);
    expect(done).toBeDefined();
    expect(done!.pillarNames).toEqual([pillarName]);

    const provenance = (done!.provenance ?? []) as Array<{
      source_id: number;
      title: string;
    }>;
    expect(provenance.some((p) => p.source_id === sourceId)).toBe(true);

    const cv = done!.citationVerification as {
      status: string;
      matchedSourceIds: number[];
    } | null;
    expect(cv).not.toBeNull();
    expect(cv!.status).toBe("verified");
    expect(cv!.matchedSourceIds).toContain(sourceId);
  });
});

describe("POST /api/embed-agent — uncovered short-circuit", () => {
  test("below-threshold retrieval streams UNCOVERED with NO LLM call", async () => {
    const res = await request(app)
      .post("/api/embed-agent")
      .send({
        // Lands on the "focus" embedding axis — orthogonal to the seeded
        // melatonin chunks, so retrieval falls below RAG_MIN_SCORE.
        message: "How do I improve concentration and focus at work?",
        pillar: pillarSlug,
      })
      .set("Sec-Fetch-Site", "same-origin")
      .set("Accept", "text/event-stream");
    expect(res.status).toBe(200);

    const events = parseSseEvents(res.text);
    const streamed = events
      .map((e) => (typeof e.content === "string" ? e.content : ""))
      .join("");
    expect(streamed).toMatch(/^UNCOVERED:/);

    // The honest "not published yet" path makes NO model call — by design,
    // there is nothing to fall back to.
    expect(anthropicState.streamCalls).toBe(0);

    // Retrieval still ran, still locked to the single pillar id.
    expect(retrieveSpy.calls).toHaveLength(1);
    expect(retrieveSpy.calls[0].pillarIds).toEqual([pillarId]);

    const done = events.find((e) => e.done === true);
    expect(done).toBeDefined();
    expect(done!.uncovered).toBe(true);
    expect(done!.provenance).toEqual([]);
  });
});

describe("POST /api/embed-agent — refuse path", () => {
  test("a REFUSE: answer ships no provenance and runs no citation guard", async () => {
    // The question lands on the melatonin axis so retrieval clears the
    // threshold and the LLM is actually invoked; the mock then returns a
    // bare REFUSE: line, exercising the route's refusal branch.
    anthropicState.mode = "refuse";

    const res = await request(app)
      .post("/api/embed-agent")
      .send({
        message: "Does evening melatonin shift the circadian clock?",
        pillar: pillarSlug,
      })
      .set("Sec-Fetch-Site", "same-origin")
      .set("Accept", "text/event-stream");
    expect(res.status).toBe(200);

    const events = parseSseEvents(res.text);
    const streamed = events
      .map((e) => (typeof e.content === "string" ? e.content : ""))
      .join("");
    expect(streamed).toMatch(/^REFUSE:/);

    // The LLM was invoked exactly once (retrieval cleared the threshold).
    expect(anthropicState.streamCalls).toBe(1);

    // A refusal carries nothing to attribute, so the done event must strip
    // provenance and skip the citation guard entirely.
    const done = events.find((e) => e.done === true);
    expect(done).toBeDefined();
    expect(done!.provenance).toEqual([]);
    expect(done!.citationVerification).toBeNull();
  });
});

describe("POST /api/embed-agent — partner-key gate", () => {
  test("a bogus X-Palonur-Key returns 401 and never calls the LLM", async () => {
    const res = await request(app)
      .post("/api/embed-agent")
      .set("X-Palonur-Key", `plnr_test_${randomBytes(16).toString("hex")}`)
      .send({
        message: "Does evening melatonin shift the circadian clock?",
        pillar: pillarSlug,
      });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "invalid_key" });
    expect(anthropicState.streamCalls).toBe(0);
  });

  test("a key without the embed-agent scope returns 403", async () => {
    const raw = await insertPartnerKey({
      partnerName: "scope-test-partner",
      scopes: ["sleep-agent"],
    });

    const res = await request(app)
      .post("/api/embed-agent")
      .set("X-Palonur-Key", raw)
      .send({
        message: "Does evening melatonin shift the circadian clock?",
        pillar: pillarSlug,
      });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "scope_forbidden", scope: "embed-agent" });
    expect(anthropicState.streamCalls).toBe(0);
  });

  test("the anonymous per-IP cap returns 429 after the limit", async () => {
    // Default ANON_LIMIT_PER_HOUR is 20. Twenty anonymous requests pass the
    // gate (each fails body validation with 400, which is fine — the cap is
    // enforced in the middleware before the handler); the 21st is throttled.
    for (let i = 0; i < 20; i++) {
      const ok = await request(app)
        .post("/api/embed-agent")
        .set("Sec-Fetch-Site", "same-origin")
        .send({});
      expect(ok.status).toBe(400);
    }
    const limited = await request(app)
      .post("/api/embed-agent")
      .set("Sec-Fetch-Site", "same-origin")
      .send({});
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe("rate_limited");
    expect(limited.body.reason).toMatch(/Anonymous evaluation cap/);
    expect(anthropicState.streamCalls).toBe(0);
  });
});
