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
  process.env.SESSION_SECRET = "test-newsletter-qa-secret";
});

// ─── Mocks (must be declared before importing the app) ─────────────────

vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: async () => ({ id: "stub-id" }),
    };
  },
}));

// Both the streaming route (messages.stream) and the one-shot governed-answer
// path (messages.create) flow through the same client, so the fake exposes
// BOTH. `mode` flips the covered structured answer to a bare REFUSE: line. The
// covered answer is first-person + cites the seeded Zeitzer source so the
// citation guard verifies and the voice guard reads as "ok".
const anthropicState = vi.hoisted(
  () => ({ streamCalls: 0, createCalls: 0, mode: "covered" as "covered" | "refuse" }),
);
vi.mock("@anthropic-ai/sdk", () => {
  const buildText = (mode: "covered" | "refuse") =>
    mode === "refuse"
      ? "REFUSE: I only answer questions grounded in my approved material."
      : [
          "ANSWER:",
          "In my experience, dim evening light quietly suppresses melatonin and nudges your clock later.",
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
          "I tell my patients to keep evenings dim so they fall asleep on time.",
          "",
          "ACTION:",
          "Tonight, I'd dim the household lights two hours before bed.",
          "",
          "INSIGHT:",
          "Q: Is dim room light really enough to matter?",
          "A: Yes, in my clinic the dose-response saturates near 100 lux.",
        ].join("\n");

  class FakeAnthropic {
    messages = {
      stream: () => {
        anthropicState.streamCalls += 1;
        const text = buildText(anthropicState.mode);
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
        return {
          content: [{ type: "text", text: buildText(anthropicState.mode) }],
        };
      },
    };
  }
  return { default: FakeAnthropic };
});

// Deterministic embeddings (see makeTopicEmbedding): melatonin/circadian/light
// → axis 10, tinnitus → axis 0, focus → axis 3, everything else → axis 20.
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

// Spy on retrieve while delegating to the real implementation, so we can assert
// the router searches ALL active pillars, then the answer locks to ONE.
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
import { randomBytes } from "node:crypto";
import pool from "../lib/db.js";
import { toVectorLiteral } from "../lib/embeddings.js";
import { clearEmbeddingCache } from "../lib/rag.js";
import { __resetPartnerKeyCountersForTests } from "../middlewares/partnerKey.js";
import {
  routeBestPillar,
  answerNewsletterQuestion,
} from "../lib/newsletterQa.js";

// A self-contained pillar + steward + approved source/interpretation, seeded on
// a chosen topic axis so retrieval lands deterministically.
interface SeededPillar {
  pillarId: number;
  stewardUserId: number;
  sourceId: number;
  interpretationId: number;
  slug: string;
  name: string;
  expertName: string;
}

async function seedPillar(opts: {
  slug: string;
  name: string;
  expertName: string;
  topicText: string;
  authors: string;
  retired?: boolean;
}): Promise<SeededPillar> {
  const stamp = `${Date.now()}-${randomBytes(4).toString("hex")}`;

  const { rows: pillarRows } = await pool.query<{ id: number }>(
    `INSERT INTO pillars (slug, name, retired_at)
     VALUES ($1, $2, ${opts.retired ? "NOW()" : "NULL"}) RETURNING id`,
    [opts.slug, opts.name],
  );
  const pillarId = pillarRows[0].id;

  const { rows: userRows } = await pool.query<{ id: number }>(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [`nq-clerk-${stamp}`, `nq-steward-${stamp}@test.local`, opts.expertName],
  );
  const stewardUserId = userRows[0].id;

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
               $2, 2000, 'J Physiol', $3, 'Stub abstract.',
               'https://example.test/nq', 'approved', $4)
       RETURNING id`,
    [pillarId, opts.authors, `10.1111/nq-${stamp}`, stewardUserId],
  );
  const sourceId = sourceRows[0].id;

  await pool.query(
    `INSERT INTO source_chunks
       (source_id, chunk_index, text, embedding, embedding_model)
     VALUES ($1, 0, $2, $3::halfvec(384), 'Xenova/gte-small')`,
    [sourceId, opts.topicText, toVectorLiteral(makeTopicEmbedding(opts.topicText))],
  );

  const { rows: interpRows } = await pool.query<{ id: number }>(
    `INSERT INTO interpretations
        (source_id, pillar_id, author_id, status, answer, interpretation,
         action, approver_id, approved_at)
       VALUES ($1, $2, $3, 'approved',
               'In my experience this is what matters most.',
               'I keep my own routine simple and consistent.',
               'Try one small change tonight.',
               $3, NOW())
       RETURNING id`,
    [sourceId, pillarId, stewardUserId],
  );
  const interpretationId = interpRows[0].id;

  await pool.query(
    `INSERT INTO interpretation_chunks
        (interpretation_id, source_id, pillar_id, chunk_index, text,
         embedding, embedding_model, priority)
       VALUES ($1, $2, $3, 0, $4, $5::halfvec(384), 'Xenova/gte-small', 100)`,
    [
      interpretationId,
      sourceId,
      pillarId,
      opts.topicText,
      toVectorLiteral(makeTopicEmbedding(opts.topicText)),
    ],
  );

  return {
    pillarId,
    stewardUserId,
    sourceId,
    interpretationId,
    slug: opts.slug,
    name: opts.name,
    expertName: opts.expertName,
  };
}

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

let app: Express;
let sleep: SeededPillar; // active, melatonin axis
let ear: SeededPillar; // active, tinnitus axis
let retired: SeededPillar; // retired, "else" (axis 20) — must never be picked

beforeAll(async () => {
  await ensureCaptureLoopSchema();
  await ensurePartnerKeysSchema();

  // Remove stale test pillars left by interrupted previous runs. These share
  // the same slug prefixes as the fixtures below. Stale interpretation_chunks
  // from sourceAssessment.test, sleepzeitNeutral.test, and
  // governedRagCovered.test can pollute routing (they seed on the same
  // melatonin/circadian axis and win the routing match otherwise).
  // fileParallelism=false so these suites never run concurrently — safe to
  // delete their leftovers here.
  await pool.query(`
    DELETE FROM interpretation_chunks
    WHERE pillar_id IN (SELECT id FROM pillars WHERE slug ~ '^(nq-|asm-|neutral-test-|cov-test-)' )
  `);
  await pool.query(`
    DELETE FROM interpretations
    WHERE pillar_id IN (SELECT id FROM pillars WHERE slug ~ '^(nq-|asm-|neutral-test-|cov-test-)' )
  `);
  await pool.query(`
    DELETE FROM source_chunks
    WHERE source_id IN (
      SELECT id FROM sources
      WHERE pillar_id IN (SELECT id FROM pillars WHERE slug ~ '^(nq-|asm-|neutral-test-|cov-test-)' )
    )
  `);
  await pool.query(`
    DELETE FROM sources
    WHERE pillar_id IN (SELECT id FROM pillars WHERE slug ~ '^(nq-|asm-|neutral-test-|cov-test-)' )
  `);
  await pool.query(`
    DELETE FROM faculty_memberships
    WHERE pillar_id IN (SELECT id FROM pillars WHERE slug ~ '^(nq-|asm-|neutral-test-|cov-test-)' )
  `);
  await pool.query(`DELETE FROM pillars WHERE slug ~ '^(nq-|asm-|neutral-test-|cov-test-)' `);

  sleep = await seedPillar({
    slug: `nq-sleep-${Date.now()}`,
    name: "NQ Sleep",
    expertName: "Dr. Sleep Steward",
    topicText:
      "Even very dim room light at night suppresses melatonin and shifts the circadian clock.",
    authors: "Zeitzer JM et al.",
  });

  ear = await seedPillar({
    slug: `nq-ear-${Date.now()}`,
    name: "NQ Hearing",
    expertName: "Dr. Ear Steward",
    topicText:
      "Persistent tinnitus is best managed with sound therapy and attention retraining.",
    authors: "Hearing JM et al.",
  });

  // Retired pillar holds the ONLY content matching a generic "ergonomic" query.
  // Because it is retired it must be invisible to routing, so that query must
  // come back uncovered rather than routing to this pillar.
  retired = await seedPillar({
    slug: `nq-retired-${Date.now()}`,
    name: "NQ Retired",
    expertName: "Dr. Retired Steward",
    topicText: "Ergonomic desk posture and standing breaks reduce back strain.",
    authors: "Posture JM et al.",
    retired: true,
  });

  clearEmbeddingCache();
  app = (await import("../app.js")).default;
});

afterAll(async () => {
  for (const p of [sleep, ear, retired]) {
    if (!p?.pillarId) continue;
    await pool.query(`DELETE FROM interpretation_chunks WHERE pillar_id = $1`, [
      p.pillarId,
    ]);
    await pool.query(`DELETE FROM interpretations WHERE pillar_id = $1`, [
      p.pillarId,
    ]);
    await pool.query(
      `DELETE FROM source_chunks WHERE source_id IN
         (SELECT id FROM sources WHERE pillar_id = $1)`,
      [p.pillarId],
    );
    await pool.query(`DELETE FROM sources WHERE pillar_id = $1`, [p.pillarId]);
    await pool.query(`DELETE FROM faculty_memberships WHERE pillar_id = $1`, [
      p.pillarId,
    ]);
    await pool.query(`DELETE FROM pillars WHERE id = $1`, [p.pillarId]);
    await pool.query(`DELETE FROM faculty_users WHERE id = $1`, [
      p.stewardUserId,
    ]);
  }
  await pool.end();
});

beforeEach(async () => {
  anthropicState.streamCalls = 0;
  anthropicState.createCalls = 0;
  anthropicState.mode = "covered";
  retrieveSpy.calls.length = 0;
  __resetPartnerKeyCountersForTests();
  clearEmbeddingCache();

  // Parallel-suite CASCADE deletes can wipe faculty_users mid-run. Re-ensure
  // each seeded steward user + membership so expertName JOINs keep returning
  // non-null values. Uses explicit ids (SERIAL allows re-insert after delete).
  for (const p of [sleep, ear, retired].filter(Boolean)) {
    await pool.query(
      `INSERT INTO faculty_users (id, clerk_user_id, email, full_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [
        p.stewardUserId,
        `nq-reseed-${p.stewardUserId}`,
        `nq-reseed-${p.stewardUserId}@test.local`,
        p.expertName,
      ],
    );
    await pool.query(
      `INSERT INTO faculty_memberships (user_id, pillar_id, role)
       VALUES ($1, $2, 'steward')
       ON CONFLICT (user_id, pillar_id) DO NOTHING`,
      [p.stewardUserId, p.pillarId],
    );
  }
});

describe("POST /api/newsletter-qa — input validation", () => {
  test("missing message returns 400 and never calls the LLM", async () => {
    const res = await request(app)
      .post("/api/newsletter-qa")
      .set("Sec-Fetch-Site", "same-origin")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_request" });
    expect(anthropicState.streamCalls).toBe(0);
  });
});

describe("POST /api/newsletter-qa — auto-routing", () => {
  test("a melatonin question routes to the sleep expert and answers in voice", async () => {
    const res = await request(app)
      .post("/api/newsletter-qa")
      .send({ message: "Does evening light shift my circadian clock?" })
      .set("Sec-Fetch-Site", "same-origin")
      .set("Accept", "text/event-stream");
    expect(res.status).toBe(200);

    const events = parseSseEvents(res.text);

    // The client learns who is answering before any tokens stream.
    const routed = events.find((e) => e.routed === true);
    expect(routed).toBeDefined();
    expect(routed!.expertName).toBe(sleep.expertName);
    expect(routed!.pillarSlug).toBe(sleep.slug);

    const streamed = events
      .map((e) => (typeof e.content === "string" ? e.content : ""))
      .join("");
    expect(streamed).toMatch(/melatonin/i);
    expect(streamed).not.toMatch(/UNCOVERED:/);

    expect(anthropicState.streamCalls).toBe(1);

    // Router searched ALL active pillars (sleep + ear, NOT the retired one),
    // then the answer locked to the single chosen pillar.
    const searchedAll = retrieveSpy.calls.find(
      (c) => c.pillarIds.length > 1,
    );
    expect(searchedAll).toBeDefined();
    expect(searchedAll!.pillarIds).toEqual(
      expect.arrayContaining([sleep.pillarId, ear.pillarId]),
    );
    expect(searchedAll!.pillarIds).not.toContain(retired.pillarId);
    expect(
      retrieveSpy.calls.some(
        (c) => c.pillarIds.length === 1 && c.pillarIds[0] === sleep.pillarId,
      ),
    ).toBe(true);

    const done = events.find((e) => e.done === true);
    expect(done).toBeDefined();
    expect(done!.pillarNames).toEqual([sleep.name]);
    expect(done!.expertName).toBe(sleep.expertName);

    const provenance = (done!.provenance ?? []) as Array<{ source_id: number }>;
    expect(provenance.some((p) => p.source_id === sleep.sourceId)).toBe(true);

    const cv = done!.citationVerification as { status: string } | null;
    expect(cv).not.toBeNull();
    expect(cv!.status).toBe("verified");

    // Voice guard ran (steward has approved interpretations as exemplars) and
    // the first-person answer reads as in-voice.
    const vv = done!.voiceVerification as {
      status: string;
      firstPersonOk: boolean;
    } | null;
    expect(vv).not.toBeNull();
    expect(vv!.firstPersonOk).toBe(true);
  });

  test("a tinnitus question routes to a DIFFERENT expert (no blending)", async () => {
    const res = await request(app)
      .post("/api/newsletter-qa")
      .send({ message: "What helps with tinnitus ringing in my ears?" })
      .set("Sec-Fetch-Site", "same-origin")
      .set("Accept", "text/event-stream");
    expect(res.status).toBe(200);

    const events = parseSseEvents(res.text);
    const routed = events.find((e) => e.routed === true);
    expect(routed).toBeDefined();
    expect(routed!.pillarSlug).toBe(ear.slug);
    expect(routed!.expertName).toBe(ear.expertName);

    const done = events.find((e) => e.done === true);
    expect(done!.pillarNames).toEqual([ear.name]);

    // Locked to exactly the ear pillar — one expert, never blended.
    expect(
      retrieveSpy.calls.some(
        (c) => c.pillarIds.length === 1 && c.pillarIds[0] === ear.pillarId,
      ),
    ).toBe(true);
  });

  test("an off-topic question is answered by the SLM AI Lab fallback", async () => {
    const res = await request(app)
      .post("/api/newsletter-qa")
      .send({ message: "How do I fix a leaking kitchen faucet at home?" })
      .set("Sec-Fetch-Site", "same-origin")
      .set("Accept", "text/event-stream");
    expect(res.status).toBe(200);

    const events = parseSseEvents(res.text);
    const streamed = events
      .map((e) => (typeof e.content === "string" ? e.content : ""))
      .join("");
    // The SLM AI Lab fallback now streams an answer instead of a bare UNCOVERED line.
    expect(streamed).not.toMatch(/^UNCOVERED:/);
    // The fallback calls the LLM (one stream call).
    expect(anthropicState.streamCalls).toBe(1);

    const done = events.find((e) => e.done === true);
    expect(done!.slmFallback).toBe(true);
    expect(done!.provenance).toEqual([]);
    // The SLM AI Lab is named as the expert.
    expect(done!.expertName).toBe("Stanford Lifestyle Medicine AI Lab");
  });
});

describe("routeBestPillar — retired pillars are never selectable", () => {
  test("a query whose only match is in a retired pillar comes back uncovered", async () => {
    const routing = await routeBestPillar(
      "What about ergonomic desk posture and standing breaks?",
    );

    // The retired pillar holds the only matching content, but it must be
    // excluded from the candidate set, so routing cannot land on it.
    expect(routing.status).toBe("uncovered");
    if (routing.status === "uncovered") {
      expect(routing.pillarIds).toContain(sleep.pillarId);
      expect(routing.pillarIds).toContain(ear.pillarId);
      expect(routing.pillarIds).not.toContain(retired.pillarId);
    }
  });
});

describe("answerNewsletterQuestion — one-shot (email pipeline)", () => {
  test("routes + answers a covered question without streaming", async () => {
    const result = await answerNewsletterQuestion(
      "Does evening light suppress my melatonin?",
    );

    expect(result.outcome).toBe("answered");
    expect(result.expert).not.toBeNull();
    expect(result.expert!.pillarSlug).toBe(sleep.slug);
    expect(result.expert!.name).toBe(sleep.expertName);
    expect(result.answer).toMatch(/melatonin/i);

    // One-shot uses messages.create, not the stream.
    expect(anthropicState.createCalls).toBe(1);
    expect(anthropicState.streamCalls).toBe(0);

    expect(result.citationVerification?.status).toBe("verified");
    expect(result.provenance.some((p) => p.source_id === sleep.sourceId)).toBe(
      true,
    );
    expect(result.voiceVerification).not.toBeNull();
    expect(result.voiceVerification!.firstPersonOk).toBe(true);
  });

  test("an off-topic question returns uncovered with no expert", async () => {
    const result = await answerNewsletterQuestion(
      "How do I fix a leaking kitchen faucet?",
    );
    expect(result.outcome).toBe("uncovered");
    expect(result.expert).toBeNull();
    expect(result.answer).toBeNull();
    expect(anthropicState.createCalls).toBe(0);
  });
});

describe("POST /api/newsletter-qa — partner-key gate", () => {
  test("a bogus X-Palonur-Key returns 401 and never calls the LLM", async () => {
    const res = await request(app)
      .post("/api/newsletter-qa")
      .set("X-Palonur-Key", `plnr_test_${randomBytes(16).toString("hex")}`)
      .send({ message: "Does evening light shift my circadian clock?" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "invalid_key" });
    expect(anthropicState.streamCalls).toBe(0);
  });
});
