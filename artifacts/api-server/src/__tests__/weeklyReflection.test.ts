import { beforeAll, afterAll, describe, test, expect, vi } from "vitest";
import { makeTopicEmbedding } from "./testHelpers.js";

// Env must be set BEFORE the lib/route modules load (they read it once at init).
// `messagesCreate` is created inside vi.hoisted so the (hoisted) vi.mock factory
// below can reference it without a TDZ error. The grounded note is generated
// through a NON-streaming Anthropic call (messages.create), unlike the live
// agent's streaming path — emit a structured covered-path answer so the parser
// + citation guard run.
const { messagesCreate } = vi.hoisted(() => {
  process.env.RAG_MIN_SCORE = "0.25";
  const fakeText = [
    "ANSWER:",
    "Keeping a steady sleep and wake time anchors your circadian clock.",
    "",
    "CITATION:",
    "Zeitzer et al., 2000, J Physiol",
    "",
    "PAPER:",
    '"Sensitivity of the human circadian pacemaker to nocturnal light"',
    "",
    "FINDING:",
    "Consistent timing strengthens the clock's signal night to night.",
  ].join("\n");
  return {
    messagesCreate: vi.fn(async () => ({
      content: [{ type: "text", text: fakeText }],
    })),
  };
});
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: messagesCreate, stream: () => (async function* () {})() };
  }
  return { default: FakeAnthropic };
});

// Deterministic embeddings so the seeded sleep-pillar chunks land on the same
// axis as the anchor question — guaranteed to clear RAG_MIN_SCORE offline.
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

import pool from "../lib/db.js";
import { toVectorLiteral } from "../lib/embeddings.js";
import { clearEmbeddingCache } from "../lib/rag.js";
import {
  computeWeeklyReflection,
  generateGroundedNote,
} from "../lib/weeklyReflection.js";
import { runWeeklyReflections } from "../lib/jobs.js";

let pillarId = 0;
let sourceId = 0;
let stewardId = 0;
const pillarSlug = "sleep";
const pillarName = "Restorative Sleep";
const stamp = Date.now();

async function ensureSchema(): Promise<void> {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
  await pool.query(`DO $$ BEGIN
    CREATE TYPE faculty_role AS ENUM ('steward','contributor','viewer');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  await pool.query(`DO $$ BEGIN
    CREATE TYPE source_kind AS ENUM ('paper','slm_article','note');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  await pool.query(`DO $$ BEGIN
    CREATE TYPE source_status AS ENUM ('draft','in_review','approved','archived');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  await pool.query(`DO $$ BEGIN
    CREATE TYPE interpretation_status AS ENUM ('proposed','approved','archived');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  await pool.query(`CREATE TABLE IF NOT EXISTS pillars (
    id SERIAL PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    description TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS faculty_users (
    id SERIAL PRIMARY KEY, clerk_user_id TEXT NOT NULL UNIQUE, email TEXT NOT NULL,
    full_name TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sources (
    id SERIAL PRIMARY KEY,
    pillar_id INTEGER NOT NULL REFERENCES pillars(id) ON DELETE CASCADE,
    kind source_kind NOT NULL, title TEXT NOT NULL, authors TEXT, year INTEGER,
    journal TEXT, doi TEXT, abstract TEXT, full_text TEXT, source_url TEXT,
    status source_status NOT NULL DEFAULT 'draft',
    uploaded_by_user_id INTEGER REFERENCES faculty_users(id) ON DELETE SET NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS source_chunks (
    id SERIAL PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL, text TEXT NOT NULL, embedding halfvec,
    page INTEGER, section TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS interpretations (
    id SERIAL PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    pillar_id INTEGER NOT NULL REFERENCES pillars(id) ON DELETE CASCADE,
    author_id INTEGER REFERENCES faculty_users(id) ON DELETE SET NULL,
    status interpretation_status NOT NULL DEFAULT 'proposed',
    version INTEGER NOT NULL DEFAULT 1, answer TEXT NOT NULL,
    interpretation TEXT NOT NULL, not_proven TEXT, action TEXT,
    tags TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
    approver_id INTEGER REFERENCES faculty_users(id) ON DELETE SET NULL,
    approved_at TIMESTAMPTZ, parent_interpretation_id INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS interpretation_chunks (
    id SERIAL PRIMARY KEY,
    interpretation_id INTEGER NOT NULL REFERENCES interpretations(id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    pillar_id INTEGER NOT NULL REFERENCES pillars(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL, text TEXT NOT NULL, embedding halfvec,
    priority INTEGER NOT NULL DEFAULT 100,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);

  // Consumer-side palonur tables (boot DDL in index.ts never runs in tests).
  await pool.query(`CREATE TABLE IF NOT EXISTS palonur_users (
    id SERIAL PRIMARY KEY, first_name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
    timezone TEXT, email_opted_out BOOLEAN NOT NULL DEFAULT FALSE,
    last_weekly_reflection_sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`ALTER TABLE palonur_users
    ADD COLUMN IF NOT EXISTS last_weekly_reflection_sent_at TIMESTAMPTZ`);
  await pool.query(`CREATE TABLE IF NOT EXISTS palonur_sleep_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES palonur_users(id) ON DELETE CASCADE,
    log_date DATE NOT NULL, quality SMALLINT NOT NULL CHECK (quality BETWEEN 1 AND 5),
    note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, log_date))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS palonur_commitments (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES palonur_users(id) ON DELETE CASCADE,
    action_text TEXT NOT NULL, sleep_question TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS palonur_checkins (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES palonur_users(id) ON DELETE CASCADE,
    commitment_id INTEGER REFERENCES palonur_commitments(id) ON DELETE CASCADE,
    checkin_date DATE NOT NULL DEFAULT CURRENT_DATE, did_it BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, commitment_id, checkin_date))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS palonur_tonights_focus (
    user_id INTEGER NOT NULL REFERENCES palonur_users(id) ON DELETE CASCADE,
    focus_date DATE NOT NULL,
    commitment_id INTEGER NOT NULL REFERENCES palonur_commitments(id) ON DELETE CASCADE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, focus_date))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS palonur_weekly_reflections (
    user_id INTEGER NOT NULL REFERENCES palonur_users(id) ON DELETE CASCADE,
    week_start DATE NOT NULL, question TEXT NOT NULL, note JSONB,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, week_start))`);
}

async function seedUser(opts: {
  optedOut?: boolean;
  withLog?: boolean;
  withCommitment?: boolean;
}): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO palonur_users (first_name, email, email_opted_out)
     VALUES ($1, $2, $3) RETURNING id`,
    [`Weekly`, `weekly-${stamp}-${Math.random()}@test.local`, opts.optedOut ?? false],
  );
  const uid = rows[0].id;
  if (opts.withLog) {
    await pool.query(
      `INSERT INTO palonur_sleep_logs (user_id, log_date, quality)
       VALUES ($1, CURRENT_DATE - 1, 4), ($1, CURRENT_DATE - 2, 3)`,
      [uid],
    );
  }
  if (opts.withCommitment) {
    await pool.query(
      `INSERT INTO palonur_commitments (user_id, action_text, sleep_question)
       VALUES ($1, $2, $3)`,
      [
        uid,
        "Keep a consistent wake time",
        "Does keeping a consistent wake time help my circadian clock?",
      ],
    );
  }
  return uid;
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for weeklyReflection.test.ts");
  }
  await ensureSchema();

  const { rows: pr } = await pool.query<{ id: number }>(
    `INSERT INTO pillars (slug, name) VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [pillarSlug, pillarName],
  );
  pillarId = pr[0].id;

  const { rows: ur } = await pool.query<{ id: number }>(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [`wk-clerk-${stamp}`, `wk-steward-${stamp}@test.local`, "Weekly Steward"],
  );
  stewardId = ur[0].id;

  const { rows: sr } = await pool.query<{ id: number }>(
    `INSERT INTO sources
       (pillar_id, kind, title, authors, year, journal, doi, abstract,
        source_url, status, uploaded_by_user_id)
     VALUES ($1, 'paper', $2, 'Zeitzer JM et al.', 2000, 'J Physiol',
             '10.1111/wk-test', 'Stub abstract.',
             'https://example.test/consistency', 'approved', $3)
     RETURNING id`,
    [pillarId, "Sensitivity of the human circadian pacemaker to nocturnal light", stewardId],
  );
  sourceId = sr[0].id;

  const chunkText =
    "A consistent wake time anchors the circadian clock and stabilizes sleep timing night to night.";
  await pool.query(
    `INSERT INTO source_chunks (source_id, chunk_index, text, embedding, embedding_model)
     VALUES ($1, 0, $2, $3::halfvec(384), 'Xenova/gte-small')`,
    [sourceId, chunkText, toVectorLiteral(makeTopicEmbedding(chunkText))],
  );

  const { rows: ir } = await pool.query<{ id: number }>(
    `INSERT INTO interpretations
       (source_id, pillar_id, author_id, status, answer, interpretation,
        action, approver_id, approved_at)
     VALUES ($1, $2, $3, 'approved',
             'A steady wake time anchors your clock.',
             'Consistency is the lever.', 'Wake at the same time daily.',
             $3, NOW()) RETURNING id`,
    [sourceId, pillarId, stewardId],
  );
  const interpChunk =
    "Faculty take: a consistent wake time anchors the circadian clock and stabilizes sleep timing.";
  await pool.query(
    `INSERT INTO interpretation_chunks
       (interpretation_id, source_id, pillar_id, chunk_index, text, embedding, embedding_model, priority)
     VALUES ($1, $2, $3, 0, $4, $5::halfvec(384), 'Xenova/gte-small', 100)`,
    [ir[0].id, sourceId, pillarId, interpChunk, toVectorLiteral(makeTopicEmbedding(interpChunk))],
  );

  clearEmbeddingCache();
});

afterAll(async () => {
  await pool.query(`DELETE FROM palonur_users WHERE email LIKE $1`, [`weekly-${stamp}-%`]);
  if (pillarId) {
    await pool.query(`DELETE FROM interpretation_chunks WHERE pillar_id = $1`, [pillarId]);
    await pool.query(`DELETE FROM interpretations WHERE pillar_id = $1`, [pillarId]);
    await pool.query(`DELETE FROM source_chunks WHERE source_id = $1`, [sourceId]);
    await pool.query(`DELETE FROM sources WHERE pillar_id = $1`, [pillarId]);
  }
  if (stewardId) await pool.query(`DELETE FROM faculty_users WHERE id = $1`, [stewardId]);
  await pool.end();
});

describe("weekly reflection — grounded coaching loop", () => {
  test("user with data + commitment gets a grounded, cited note", async () => {
    const uid = await seedUser({ withLog: true, withCommitment: true });
    const reflection = await computeWeeklyReflection(uid);

    expect(reflection).not.toBeNull();
    expect(reflection!.hasData).toBe(true);
    expect(reflection!.emptyPrompt).toBeNull();
    expect(reflection!.nights.count).toBe(2);
    expect(reflection!.groundedNote).not.toBeNull();
    // Citation guard passed: the emitted citation maps to the retrieved source.
    expect(reflection!.groundedNote!.citation).toMatch(/Zeitzer/);
    expect(reflection!.groundedNote!.answer).toMatch(/consistent|circadian|clock/i);
    expect(reflection!.groundedNote!.sourceUrl).toBe("https://example.test/consistency");
  });

  test("grounded note is cached per week (one generation reused)", async () => {
    const uid = await seedUser({ withLog: true, withCommitment: true });
    messagesCreate.mockClear();
    await computeWeeklyReflection(uid);
    const callsAfterFirst = messagesCreate.mock.calls.length;
    expect(callsAfterFirst).toBe(1);
    await computeWeeklyReflection(uid);
    // Second compute reuses the cached note — no new LLM call.
    expect(messagesCreate.mock.calls.length).toBe(callsAfterFirst);
  });

  test("empty-data user gets a gentle prompt, never a fabricated note", async () => {
    const uid = await seedUser({});
    const reflection = await computeWeeklyReflection(uid);

    expect(reflection!.hasData).toBe(false);
    expect(reflection!.groundedNote).toBeNull();
    expect(reflection!.emptyPrompt).toBeTruthy();
    expect(reflection!.emptyPrompt).toMatch(/log a night|experiment/i);
  });

  test("citation guard drops a note whose citation is unverifiable", async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: [
            "ANSWER:",
            "Some plausible-sounding but uncited claim about sleep timing.",
            "",
            "CITATION:",
            "Imaginary et al., 1999, Fake Journal",
            "",
            "FINDING:",
            "A finding with no backing source.",
          ].join("\n"),
        },
      ],
    });
    const note = await generateGroundedNote(
      "Does keeping a consistent wake time help my circadian clock?",
    );
    expect(note).toBeNull();
  });

  test("REFUSE response yields no note (refusal behavior preserved)", async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "REFUSE: That's outside sleep science." }],
    });
    const note = await generateGroundedNote("What stock should I buy?");
    expect(note).toBeNull();
  });

  test("runWeeklyReflections skips opted-out users and respects cooldown", async () => {
    const optedOut = await seedUser({ optedOut: true, withLog: true, withCommitment: true });
    const eligible = await seedUser({ withLog: true, withCommitment: true });

    await runWeeklyReflections();

    // The opted-out user must never be considered: no cooldown stamp...
    const { rows: optedRow } = await pool.query<{ ts: string | null }>(
      `SELECT last_weekly_reflection_sent_at AS ts FROM palonur_users WHERE id = $1`,
      [optedOut],
    );
    expect(optedRow[0].ts).toBeNull();

    // ...and no cached reflection row (computeWeeklyReflection never ran for it).
    const { rows: optedCache } = await pool.query(
      `SELECT 1 FROM palonur_weekly_reflections WHERE user_id = $1`,
      [optedOut],
    );
    expect(optedCache.length).toBe(0);

    // The opted-in user with data IS processed: a reflection row was generated.
    const { rows: cached } = await pool.query(
      `SELECT 1 FROM palonur_weekly_reflections WHERE user_id = $1`,
      [eligible],
    );
    expect(cached.length).toBe(1);
  });
});
