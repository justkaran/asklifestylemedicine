import { beforeAll, afterAll, describe, test, expect, vi } from "vitest";

// Set env BEFORE the route/lib modules load — they read these once at
// module-init time. `vi.hoisted` is the only way to win the import race.
vi.hoisted(() => {
  process.env.USE_GOVERNED_RAG = "true";
  process.env.RESEND_API_KEY = "stub-key";
  // Allow sendGuarded to call the mocked Resend client. Without this flag,
  // emailGuard's sendingDisabledReason() returns "test" under VITEST and
  // short-circuits ALL sends with a synthetic success — sentEmails would never
  // receive the coverage-digest email the test asserts on.
  process.env.EMAIL_LIVE_OVERRIDE = "true";
  // Raise the daily/monthly cap and zero the send interval so the shared
  // dev DB's accumulated email_sends rows never block the digest, and the
  // per-pillar sends don't wait 500 ms each (many pillars × 500 ms > 30 s).
  process.env.EMAIL_DAILY_CAP = "100000";
  process.env.EMAIL_MONTHLY_CAP = "100000";
  process.env.EMAIL_MIN_INTERVAL_MS = "0";
  // Force getResendClient() onto the env-var path (new Resend(RESEND_API_KEY))
  // instead of making a real network call to the Replit connector proxy.
  // Without this, the connector fetch can throw in the test environment and
  // getResendClient() returns null, causing the digest to be silently skipped.
  delete process.env.REPLIT_CONNECTORS_HOSTNAME;
  delete process.env.REPL_IDENTITY;
  delete process.env.WEB_REPL_RENEWAL;
  // This suite exercises the anonymous capture/clustering loop, which sends
  // several questions on one browser session. Raise both consumer paywalls'
  // free-question limits (sleep-agent's per-day SLEEP_FREE_DAILY_QUESTION_LIMIT
  // and the shared FREE_QUESTION_LIMIT) so the gate never blocks (and skips
  // logging) the questions this test asserts on.
  process.env.SLEEP_FREE_DAILY_QUESTION_LIMIT = "10000";
  process.env.FREE_QUESTION_LIMIT = "10000";
  // Clear the Clerk publishable key so the conditional Clerk middleware is NOT
  // mounted on /api/sleep-agent in the test app. When the key is present,
  // clerkMiddleware attempts to fetch JWKS from Clerk's servers on the first
  // request, which hangs indefinitely in the test environment (no real Clerk
  // session is sent). This is purely a test-isolation fix; the Clerk-bypass
  // feature is tested via the sleepAgentContactTrust suite.
  process.env.CLERK_PUBLISHABLE_KEY = "";
});

// Mock @clerk/express so clerkMiddleware() never makes JWKS network calls.
// When CLERK_PUBLISHABLE_KEY is set in the test environment, the real Clerk
// SDK fetches JWKS from Clerk's servers on the first request, which hangs
// indefinitely (no valid JWT is ever sent in this suite). The no-op stub
// keeps the middleware wiring intact without any network traffic.
// NOTE: Do NOT spread vi.importActual here — importing the real Clerk SDK
// during mock setup also triggers its JWKS initialization.
vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: null }),
  clerkMiddleware:
    (_opts: unknown) => (_req: unknown, _res: unknown, next: () => void) =>
      next(),
  clerkClient: {
    users: {
      getUser: vi.fn(async () => {
        throw new Error(
          "clerkClient.users.getUser should not be called in captureLoop suite",
        );
      }),
    },
  },
}));

// Mock slmFallback so the shortCircuitUncovered path never reaches the real
// Anthropic SDK (the module creates its anthropic instance at module scope,
// so vi.mock("@anthropic-ai/sdk") can lose the race in some environments).
vi.mock("../lib/slmFallback.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/slmFallback.js")>(
    "../lib/slmFallback.js",
  );
  const stubText = [
    "ANSWER:",
    "Stub SLM fallback answer.",
    "",
    "FINDING:",
    "Stub finding.",
    "",
    "INTERPRETATION:",
    "Stub interpretation.",
  ].join("\n");
  return {
    ...actual,
    buildSlmFallbackStream: vi.fn(() => {
      async function* gen() {
        for (const piece of stubText.match(/[\s\S]{1,40}/g) ?? []) {
          yield {
            type: "content_block_delta" as const,
            delta: { type: "text_delta" as const, text: piece },
          };
        }
      }
      return gen();
    }),
    notifyUncoveredQuestion: vi.fn(),
  };
});

// ─── Mocks (must be declared before importing the app) ─────────────────

interface SentEmail {
  from: string;
  to: string;
  subject: string;
  html: string;
}
const sentEmails: SentEmail[] = [];

vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: async (m: SentEmail) => {
        sentEmails.push(m);
        return { id: "stub-id" };
      },
    };
  },
}));

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      stream: () => {
        const text = [
          "ANSWER:",
          "Stub answer.",
          "",
          "CITATION:",
          "Zeitzer et al., 2000, J Physiol",
          "",
          "PAPER:",
          '"Stub paper title"',
          "",
          "FINDING:",
          "Stub finding.",
          "",
          "INTERPRETATION:",
          "Stub interpretation.",
          "",
          "ACTION:",
          "Do the stub thing tonight.",
          "",
          "INSIGHT:",
          "Q: Stub question?",
          "A: Stub insight answer.",
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

// Deterministic embeddings keyed by topic so similar questions cluster.
function makeMockEmbedding(text: string): number[] {
  const v = new Array(384).fill(0);
  if (/tinnitus/i.test(text)) {
    v[0] = 1;
    v[1] = 0.05;
  } else if (/concentration|focus/i.test(text)) {
    v[3] = 1;
  } else if (/snoring/i.test(text)) {
    v[5] = 1;
  } else {
    v[2] = 1;
  }
  return v;
}

vi.mock("../lib/embeddings.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/embeddings.js")>(
    "../lib/embeddings.js",
  );
  return {
    ...actual,
    embedTexts: vi.fn(async (texts: string[]) => texts.map(makeMockEmbedding)),
  };
});

// Pin the agent to ONLY the seeded test pillar so existing seeded
// pillars (e.g. "sleep") in the dev DB cannot steal routing of our
// keyword-bearing test questions.
const seededPillarRef: { id: number; slug: string; name: string } = {
  id: 0,
  slug: "",
  name: "",
};
vi.mock("../lib/pillarRouter.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/pillarRouter.js")>(
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
    })),
  };
});

// Force the governed-RAG retriever to return zero chunks deterministically
// so the test is independent of source_chunks/interpretation_chunks
// existence in the dev DB and always exercises the UNCOVERED branch.
vi.mock("../lib/rag.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/rag.js")>("../lib/rag.js");
  return {
    ...actual,
    retrieve: vi.fn(async () => ({
      chunks: [],
      topScore: 0,
      retrievalMs: 0,
    })),
  };
});

// Bypass Clerk by stubbing the faculty auth middleware. The pillar-role
// middleware is left untouched so we still exercise its membership check.
let stubFacultyUserId = 0;
vi.mock("../middlewares/facultyAuth.js", async () => {
  const actual = await vi.importActual<
    typeof import("../middlewares/facultyAuth.js")
  >("../middlewares/facultyAuth.js");
  const { db, facultyUsersTable, facultyMembershipsTable } =
    await import("@workspace/db");
  const { eq } = await import("drizzle-orm");
  return {
    ...actual,
    requireFacultyAuth: async (
      req: { faculty?: unknown },
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
      next();
    },
  };
});

// ─── Imports that depend on the mocks above ────────────────────────────

import type { Express } from "express";
import request from "supertest";
import pool from "../lib/db.js";
import { clusterPillar } from "../lib/clusterJobs.js";
import { runWeeklyCoverageDigest } from "../lib/coverageDigestEmail.js";
import { EMBEDDING_MODEL } from "../lib/embeddings.js";
import { __clearEmailSendsForTests } from "../lib/emailGuard.js";

let app: Express;
let pillarId = 0;
const pillarName = "Capture Loop Test Pillar";
const pillarSlug = `cap-test-${Date.now()}`;
const stewardEmail = `steward-${Date.now()}@test.local`;

async function ensureSchema(): Promise<void> {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
  await pool.query(`DO $$ BEGIN
    CREATE TYPE faculty_role AS ENUM ('steward','contributor','viewer');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  await pool.query(`CREATE TABLE IF NOT EXISTS pillars (
    id SERIAL PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS faculty_users (
    id SERIAL PRIMARY KEY,
    clerk_user_id TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    full_name TEXT,
    is_platform_admin TEXT NOT NULL DEFAULT 'false',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS faculty_memberships (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES faculty_users(id) ON DELETE CASCADE,
    pillar_id INTEGER NOT NULL REFERENCES pillars(id) ON DELETE CASCADE,
    role faculty_role NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS faculty_memberships_user_pillar_unique
     ON faculty_memberships (user_id, pillar_id)`,
  );
  await pool.query(`DO $$ BEGIN
    CREATE TYPE source_kind AS ENUM ('paper','slm_article','note');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  await pool.query(`DO $$ BEGIN
    CREATE TYPE source_status AS ENUM ('draft','in_review','approved','archived');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sources (
    id SERIAL PRIMARY KEY,
    pillar_id INTEGER NOT NULL REFERENCES pillars(id) ON DELETE CASCADE,
    kind source_kind NOT NULL,
    title TEXT NOT NULL,
    authors TEXT,
    year INTEGER,
    journal TEXT,
    doi TEXT,
    abstract TEXT,
    full_text TEXT,
    source_url TEXT,
    status source_status NOT NULL DEFAULT 'draft',
    uploaded_by_user_id INTEGER REFERENCES faculty_users(id) ON DELETE SET NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS agent_queries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id TEXT NOT NULL,
    question TEXT NOT NULL,
    question_embedding halfvec,
    pillar_ids INTEGER[] NOT NULL DEFAULT ARRAY[]::int[],
    retrieved_source_ids INTEGER[] NOT NULL DEFAULT ARRAY[]::int[],
    retrieved_interpretation_ids INTEGER[] NOT NULL DEFAULT ARRAY[]::int[],
    top_score REAL NOT NULL DEFAULT 0,
    was_uncovered BOOLEAN NOT NULL DEFAULT FALSE,
    answer_text TEXT NOT NULL DEFAULT '',
    latency_ms INTEGER NOT NULL DEFAULT 0,
    user_flagged BOOLEAN NOT NULL DEFAULT FALSE,
    flag_reason TEXT,
    cluster_id INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS query_clusters (
    id SERIAL PRIMARY KEY,
    pillar_id INTEGER NOT NULL REFERENCES pillars(id) ON DELETE CASCADE,
    representative_question TEXT NOT NULL,
    representative_embedding halfvec,
    size INTEGER NOT NULL DEFAULT 0,
    last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}

async function waitForRow(queryId: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const { rowCount } = await pool.query(
      `SELECT 1 FROM agent_queries WHERE id = $1::uuid`,
      [queryId],
    );
    if (rowCount && rowCount > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for agent_queries row ${queryId}`);
}

function parseSseQueryId(text: string): string {
  let queryId = "";
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const obj = JSON.parse(line.slice(6)) as { queryId?: string };
      if (obj.queryId) queryId = obj.queryId;
    } catch {
      // ignore non-JSON SSE lines
    }
  }
  return queryId;
}

beforeAll(async () => {
  // This suite asserts on rendered email content captured via the mocked Resend
  // client (vi.mock("resend") above), so opt past the production-only send gate —
  // nothing real is sent because the client itself is a mock.
  process.env.EMAIL_LIVE_OVERRIDE = "true";
  // Clear email_sends so stale rows from prior suites don't trip the daily cap
  // (the digest sends one row per active pillar; dozens of pillars × prior runs
  // can exceed the default 90/day cap before this suite even starts).
  await __clearEmailSendsForTests();
  await ensureSchema();

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
    [`test-clerk-${Date.now()}`, stewardEmail, "Cap Test Steward"],
  );
  stubFacultyUserId = userRows[0].id;

  await pool.query(
    `INSERT INTO faculty_memberships (user_id, pillar_id, role)
     VALUES ($1, $2, 'steward')`,
    [stubFacultyUserId, pillarId],
  );

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
    await pool.query(`DELETE FROM faculty_memberships WHERE pillar_id = $1`, [
      pillarId,
    ]);
    await pool.query(`DELETE FROM pillars WHERE id = $1`, [pillarId]);
  }
  if (stubFacultyUserId) {
    await pool.query(`DELETE FROM faculty_users WHERE id = $1`, [
      stubFacultyUserId,
    ]);
  }
  // Also drop the step-7 re-ensured steward (idempotent digest fixture).
  await pool.query(`DELETE FROM faculty_users WHERE clerk_user_id = $1`, [
    `test-clerk-reensure-${stewardEmail}`,
  ]);
  // Remove digest rows so subsequent suites don't inherit a bloated
  // email_sends count and trip their own daily-cap checks.
  await __clearEmailSendsForTests();
  await pool.end();
});

describe("capture loop end-to-end", () => {
  test("uncovered questions cluster, flags surface, dashboard + digest reflect both", async () => {
    const agent = request.agent(app);

    // 1. Three near-identical UNCOVERED questions on the same topic.
    const tinnitusQuestions = [
      "Why does tinnitus get louder in quiet places?",
      "Does tinnitus worsen in silent environments?",
      "How can I cope with loud tinnitus while reading?",
    ];
    const tinnitusQueryIds: string[] = [];
    for (const q of tinnitusQuestions) {
      const res = await agent
        .post("/api/sleep-agent")
        .send({ message: q })
        .set("Sec-Fetch-Site", "same-origin")
        .set("Accept", "text/event-stream");
      expect(res.status).toBe(200);
      const id = parseSseQueryId(res.text);
      expect(id).toMatch(/[0-9a-f-]{36}/);
      tinnitusQueryIds.push(id);
      await waitForRow(id);
    }

    // 2. A different uncovered question that should NOT cluster.
    const differentRes = await agent
      .post("/api/sleep-agent")
      .set("Sec-Fetch-Site", "same-origin")
      .send({ message: "How do I improve concentration during work?" });
    expect(differentRes.status).toBe(200);
    const differentId = parseSseQueryId(differentRes.text);
    await waitForRow(differentId);

    // 3. Flag the first tinnitus query (same browser session).
    const flagRes = await agent
      .post("/api/sleep-agent/flag")
      .send({ queryId: tinnitusQueryIds[0], reason: "missing context" });
    expect(flagRes.status).toBe(200);
    expect(flagRes.body.ok).toBe(true);

    // Verify the flag landed.
    const flaggedRow = await pool.query<{
      user_flagged: boolean;
      flag_reason: string | null;
    }>(
      `SELECT user_flagged, flag_reason FROM agent_queries WHERE id = $1::uuid`,
      [tinnitusQueryIds[0]],
    );
    expect(flaggedRow.rows[0].user_flagged).toBe(true);
    expect(flaggedRow.rows[0].flag_reason).toBe("missing context");

    // 4. Seed an answered, low-confidence, flagged row directly so the
    //    dashboard's lowConfidence panel (which filters was_uncovered=FALSE)
    //    has something to surface.
    const seededQuestion = "Are noise machines safe overnight?";
    await pool.query(
      `INSERT INTO agent_queries
            (session_id, question, pillar_ids, top_score, was_uncovered,
             answer_text, latency_ms, user_flagged, flag_reason)
          VALUES ($1, $2, ARRAY[$3]::int[], $4, FALSE, $5, $6, TRUE,
                  'low confidence + flagged')`,
      ["seeded-session", seededQuestion, pillarId, 0.4, "stub answer", 120],
    );

    // 5. Run the cluster job. Idempotent + scoped per-pillar.
    await clusterPillar(pillarId);

    const clusterRows = await pool.query<{
      id: number;
      size: number;
      representative_question: string;
    }>(
      `SELECT id, size, representative_question
           FROM query_clusters WHERE pillar_id = $1`,
      [pillarId],
    );
    expect(clusterRows.rows.length).toBeGreaterThanOrEqual(1);
    const tinnitusCluster = clusterRows.rows.find((r) =>
      /tinnitus/i.test(r.representative_question),
    );
    expect(tinnitusCluster).toBeDefined();
    expect(tinnitusCluster!.size).toBe(3);

    // 6. Hit the dashboard endpoint and assert all three panels.
    const dashRes = await agent.get(
      `/api/faculty/pillars/${pillarSlug}/dashboard`,
    );
    expect(dashRes.status).toBe(200);
    const body = dashRes.body as {
      pillar: { slug: string };
      totals: { total: number; uncovered: number; flagged: number };
      clusters: Array<{
        id: number;
        representativeQuestion: string;
        size: number;
        memberQuestions: string[];
      }>;
      lowConfidence: Array<{
        question: string;
        userFlagged: boolean;
        topScore: number;
      }>;
    };

    expect(body.pillar.slug).toBe(pillarSlug);
    expect(body.totals.uncovered).toBeGreaterThanOrEqual(4);
    expect(body.totals.flagged).toBeGreaterThanOrEqual(2);

    const tinnitusInDash = body.clusters.find((c) =>
      /tinnitus/i.test(c.representativeQuestion),
    );
    expect(tinnitusInDash).toBeDefined();
    expect(tinnitusInDash!.size).toBe(3);
    expect(tinnitusInDash!.memberQuestions.length).toBeGreaterThanOrEqual(1);

    const lowConfHit = body.lowConfidence.find(
      (r) => r.question === seededQuestion,
    );
    expect(lowConfHit).toBeDefined();
    expect(lowConfHit!.userFlagged).toBe(true);

    // 7. Weekly digest renders + sends to the steward via the mocked Resend.
    // Shared dev DB: another suite's TRUNCATE ... CASCADE (newsletter.test)
    // can wipe the steward fixture mid-run, making the digest silently skip
    // the pillar (0 stewards) and this assertion flake. Re-ensure the
    // steward user + membership idempotently right before EVERY digest
    // attempt — a single pre-loop re-ensure has been observed to get wiped
    // between the insert and the first digest run, leaving all retries at
    // stewards=0.
    const reEnsureSteward = async () => {
      const reUser = await pool.query<{ id: number }>(
        `INSERT INTO faculty_users (clerk_user_id, email, full_name)
           VALUES ($1, $2, 'Cap Test Steward')
           ON CONFLICT (clerk_user_id) DO UPDATE SET email = EXCLUDED.email
           RETURNING id`,
        [`test-clerk-reensure-${stewardEmail}`, stewardEmail],
      );
      await pool.query(
        `INSERT INTO faculty_memberships (user_id, pillar_id, role)
           VALUES ($1, $2, 'steward') ON CONFLICT DO NOTHING`,
        [reUser.rows[0].id, pillarId],
      );
    };
    let stewardMail: SentEmail | undefined;
    for (let attempt = 0; attempt < 3 && !stewardMail; attempt++) {
      await reEnsureSteward();
      sentEmails.length = 0;
      await runWeeklyCoverageDigest();
      stewardMail = sentEmails.find((m) => m.to === stewardEmail);
      if (!stewardMail) {
        // Self-diagnose the silent-skip path before retrying (shared dev DB
        // + live dev server can transiently perturb the inputs).
        const diag = await pool.query(
          `SELECT
               (SELECT COUNT(*)::int FROM faculty_memberships m JOIN faculty_users u ON u.id = m.user_id
                 WHERE m.pillar_id = $1 AND m.role = 'steward' AND u.email = $2) AS stewards,
               (SELECT COUNT(*)::int FROM agent_queries
                 WHERE $1 = ANY(pillar_ids) AND created_at >= NOW() - INTERVAL '7 days') AS asked,
               (SELECT COUNT(*)::int FROM query_clusters WHERE pillar_id = $1) AS clusters,
               (SELECT COUNT(*)::int FROM pillars WHERE id = $1) AS pillar_exists`,
          [pillarId, stewardEmail],
        );
        // eslint-disable-next-line no-console
        console.error(
          `digest attempt ${attempt + 1}: steward mail missing; sentEmails.to=${JSON.stringify(sentEmails.map((m) => m.to).slice(0, 20))}; state=${JSON.stringify(diag.rows[0])}`,
        );
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    expect(stewardMail).toBeDefined();
    expect(stewardMail!.html).toMatch(/Capture Loop Test Pillar/);
    expect(stewardMail!.html).toMatch(/tinnitus/i);
  }, 180_000); // this test sends several SSE requests + a digest email; even 60 s times out under full-suite + live-dev-server DB load

  test("embed-agent uncovered questions (logged without an embedding) get backfilled and clustered", async () => {
    // The embed agent logs its usage rows without a question embedding to
    // keep that write lightweight. These rows mimic that shape: an
    // uncovered question with question_embedding=NULL (tagged with a
    // distinct session_id so the test can isolate them).
    const embedSession = "embed-agent";
    const embedQuestions = [
      "Can magnesium glycinate help with restless legs at night?",
      "Does magnesium glycinate ease restless legs before bed?",
      "Will taking magnesium glycinate reduce nighttime leg restlessness?",
    ];
    for (const q of embedQuestions) {
      await pool.query(
        `INSERT INTO agent_queries
              (session_id, question, pillar_ids, top_score,
               was_uncovered, answer_text, latency_ms)
            VALUES ($1, $2, ARRAY[$3]::int[], 0, TRUE, $4, 0)`,
        [embedSession, q, pillarId, `UNCOVERED: ${q}`],
      );
    }

    // Sanity: rows landed with no embedding (the lightweight log shape).
    const beforeRows = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
           FROM agent_queries
          WHERE session_id = $1
            AND $2 = ANY(pillar_ids)
            AND question_embedding IS NULL`,
      [embedSession, pillarId],
    );
    expect(Number(beforeRows.rows[0].count)).toBe(3);

    // Run clustering: it should backfill embeddings for the embed-agent
    // rows, then group them into a single per-pillar theme.
    await clusterPillar(pillarId);

    // Every embed-agent row now carries an embedding tagged with the same
    // model the clustering uses (no cross-model mixing).
    const afterRows = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
           FROM agent_queries
          WHERE session_id = $1
            AND $2 = ANY(pillar_ids)
            AND question_embedding IS NOT NULL
            AND embedding_model = $3`,
      [embedSession, pillarId, EMBEDDING_MODEL],
    );
    expect(Number(afterRows.rows[0].count)).toBe(3);

    // The three near-identical embed-agent questions formed one cluster.
    const magnesiumCluster = await pool.query<{
      id: number;
      size: number;
      representative_question: string;
    }>(
      `SELECT id, size, representative_question
           FROM query_clusters
          WHERE pillar_id = $1
            AND representative_question ILIKE '%magnesium%'`,
      [pillarId],
    );
    expect(magnesiumCluster.rows.length).toBe(1);
    expect(magnesiumCluster.rows[0].size).toBe(3);

    const clusteredMembers = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
           FROM agent_queries
          WHERE session_id = $1
            AND $2 = ANY(pillar_ids)
            AND cluster_id = $3`,
      [embedSession, pillarId, magnesiumCluster.rows[0].id],
    );
    expect(Number(clusteredMembers.rows[0].count)).toBe(3);
  });

  test("questions embedded with a stale model survive a model rotation: re-embedded and re-clustered", async () => {
    // Simulate rows logged BEFORE an embedding-model rotation: they carry
    // a non-null embedding (unlike the NULL embed-agent shape) but tagged
    // with a previous model, so their vectors live in a different space.
    const staleSession = "stale-model-session";
    const staleModel = "text-embedding-ada-002"; // a previous model name
    const staleQuestions = [
      "Does sleeping on my side reduce snoring?",
      "Will side sleeping cut down on snoring at night?",
      "Can switching to a side position stop my snoring?",
    ];
    // An arbitrary vector in the OLD space (a single axis the current
    // mock model never uses) — it must be overwritten on re-embed.
    const oldSpaceVec = new Array(3072).fill(0);
    oldSpaceVec[99] = 1;
    const oldSpaceLit = `[${oldSpaceVec.join(",")}]`;
    for (const q of staleQuestions) {
      await pool.query(
        `INSERT INTO agent_queries
              (session_id, question, question_embedding, embedding_model,
               pillar_ids, top_score, was_uncovered, answer_text, latency_ms)
            VALUES ($1, $2, $3::halfvec(3072), $4, ARRAY[$5]::int[], 0, TRUE,
                    $6, 0)`,
        [staleSession, q, oldSpaceLit, staleModel, pillarId, `UNCOVERED: ${q}`],
      );
    }

    // Sanity: rows landed tagged with the stale model.
    const beforeRows = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
           FROM agent_queries
          WHERE session_id = $1
            AND $2 = ANY(pillar_ids)
            AND embedding_model = $3`,
      [staleSession, pillarId, staleModel],
    );
    expect(Number(beforeRows.rows[0].count)).toBe(3);

    // Run clustering: it should re-embed the stale-model rows with the
    // current model, then group them into a single per-pillar theme.
    await clusterPillar(pillarId);

    // No stale-model tags remain for this session — every row was
    // re-embedded into the current space.
    const afterStale = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
           FROM agent_queries
          WHERE session_id = $1
            AND $2 = ANY(pillar_ids)
            AND embedding_model = $3`,
      [staleSession, pillarId, staleModel],
    );
    expect(Number(afterStale.rows[0].count)).toBe(0);

    const afterCurrent = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
           FROM agent_queries
          WHERE session_id = $1
            AND $2 = ANY(pillar_ids)
            AND question_embedding IS NOT NULL
            AND embedding_model = $3`,
      [staleSession, pillarId, EMBEDDING_MODEL],
    );
    expect(Number(afterCurrent.rows[0].count)).toBe(3);

    // The three near-identical snoring questions re-entered clustering as
    // one theme — the demand history did not vanish on the rotation.
    const snoringCluster = await pool.query<{ id: number; size: number }>(
      `SELECT id, size
           FROM query_clusters
          WHERE pillar_id = $1
            AND representative_question ILIKE '%snoring%'`,
      [pillarId],
    );
    expect(snoringCluster.rows.length).toBe(1);
    expect(snoringCluster.rows[0].size).toBe(3);

    const clusteredMembers = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
           FROM agent_queries
          WHERE session_id = $1
            AND $2 = ANY(pillar_ids)
            AND cluster_id = $3`,
      [staleSession, pillarId, snoringCluster.rows[0].id],
    );
    expect(Number(clusteredMembers.rows[0].count)).toBe(3);
  });
});
