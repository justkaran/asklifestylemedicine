import { beforeAll, beforeEach, afterAll, describe, test, expect, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";

// ── Mock governedAnswer so route-shape tests don't need a seeded corpus ────
// /api/agent/query is a thin shell over governedAnswer(); these tests pin the
// RESPONSE SHAPE contract (legacy fields + new pillars/provenance + license)
// for each outcome. The governed retrieval pipeline itself is covered by
// governedRagCovered.test.ts / mcp.test.ts against real retrieval.
const governedAnswerMock = vi.fn();
vi.mock("../lib/governedAnswer.js", () => ({
  governedAnswer: (...args: unknown[]) => governedAnswerMock(...args),
}));

// ── Imports that depend on the mock above ─────────────────────────────────
import express from "express";
import type { Express } from "express";
import request from "supertest";
import pool from "../lib/db.js";
import agentRouter from "../routes/agent.js";
import { __resetPartnerKeyCountersForTests } from "../middlewares/partnerKey.js";
import type { ProvenanceEntry } from "../lib/rag.js";

async function ensurePartnerKeysSchema(): Promise<void> {
  await pool.query(`DO $$ BEGIN
    CREATE TYPE partner_key_tier AS ENUM ('pilot','production');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  await pool.query(`DO $$ BEGIN
    CREATE TYPE partner_key_origin AS ENUM ('granted','paid');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  await pool.query(`DO $$ BEGIN
    CREATE TYPE partner_key_billing AS ENUM ('none','subscription','credits');
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
  // Self-provision post-launch columns (this suite never runs index.ts boot
  // DDL). See .agents/memory/api-server-test-schema.md.
  await pool.query(
    `ALTER TABLE partner_keys
       ADD COLUMN IF NOT EXISTS origin partner_key_origin NOT NULL DEFAULT 'granted',
       ADD COLUMN IF NOT EXISTS requires_payment BOOLEAN NOT NULL DEFAULT false,
       ADD COLUMN IF NOT EXISTS billing_mode partner_key_billing NOT NULL DEFAULT 'none',
       ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
       ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT,
       ADD COLUMN IF NOT EXISTS credits_total INTEGER,
       ADD COLUMN IF NOT EXISTS credits_used INTEGER NOT NULL DEFAULT 0`,
  );
}

async function insertPartnerKey(partnerName: string): Promise<{ id: number; raw: string }> {
  const raw = `plnr_test_${randomBytes(16).toString("hex")}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  const prefix = raw.slice(0, 14);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO partner_keys
       (key_hash, key_prefix, partner_name, scopes, tier,
        rate_per_minute, rate_per_day, concurrent_streams)
     VALUES ($1, $2, $3, ARRAY['sleep-agent']::text[], 'pilot', 1000, 50000, 50)
     RETURNING id`,
    [hash, prefix, partnerName],
  );
  return { id: rows[0].id, raw };
}

function makeProvenance(overrides: Partial<ProvenanceEntry> = {}): ProvenanceEntry {
  return {
    source_id: 1,
    interpretation_id: null,
    chunk_ids: [11],
    title: "Sensitivity of the human circadian pacemaker to nocturnal light",
    authors: "Zeitzer et al.",
    year: 2000,
    journal: "J Physiol",
    doi: "10.1111/j.1469-7793.2000.00695.x",
    source_url: null,
    study_design: null,
    pillar_slug: "sleep",
    interpretation_author: null,
    excerpts: [
      {
        chunk_id: 11,
        kind: "source",
        text: "Even ~100 lux at night significantly suppresses melatonin.",
      },
    ],
    ...overrides,
  } as ProvenanceEntry;
}

// Base result shape mirroring GovernedAnswerResult.
function coveredResult() {
  return {
    outcome: "covered" as const,
    reason: null,
    answer: "Evening light exposure shifts your circadian clock later.",
    citation: "Zeitzer et al., 2000, J Physiol",
    paper: "Sensitivity of the human circadian pacemaker to nocturnal light",
    finding: "Even ~100 lux at night significantly suppresses melatonin.",
    interpretation: "Keep evenings dim to fall asleep on time.",
    action: "Dim household lights two hours before bed.",
    insight: "Dim room light is enough to matter.",
    pillarNames: ["Sleep", "Nutrition"],
    provenance: [makeProvenance()],
    citationVerification: null,
    voiceVerification: null,
    topScore: 0.83,
    limitNotices: [] as Array<Record<string, unknown>>,
  };
}

let app: Express;
let key: { id: number; raw: string };

beforeAll(async () => {
  await ensurePartnerKeysSchema();
  key = await insertPartnerKey("agent-query-shape-partner");
  app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use("/api", agentRouter);
});

beforeEach(() => {
  __resetPartnerKeyCountersForTests();
  governedAnswerMock.mockReset();
});

afterAll(async () => {
  await pool.query(`DELETE FROM partner_keys WHERE id = $1`, [key.id]);
});

function expectLicense(body: Record<string, unknown>): void {
  expect(body.usage_policy).toBe("no-training");
  const license = body.license as Record<string, string>;
  expect(license.policy).toBe("no-training");
  expect(typeof license.terms_url).toBe("string");
  expect(license.terms_url).toMatch(/\/agent-license$/);
  expect(license.attribution).toMatch(/Palonur/);
}

describe("/api/agent/query response shape", () => {
  test("POST covered path includes answer/citation/pillars/provenance + license", async () => {
    governedAnswerMock.mockResolvedValueOnce(coveredResult());

    const res = await request(app)
      .post("/api/agent/query")
      .set("X-Palonur-Key", key.raw)
      .send({ query: "Why do I wake up at 3am?" });

    expect(res.status).toBe(200);
    expect(governedAnswerMock).toHaveBeenCalledWith(
      // Keyed callers also thread their canary policy (IP protection);
      // null when the fingerprint table isn't provisioned in this suite.
      expect.objectContaining({ question: "Why do I wake up at 3am?" }),
    );
    // Keyed responses carry an invisible per-licensee zero-width fingerprint
    // marker; visible text is unchanged.
    expect(res.body.answer.replace(/[\u200B\u200C\u200D]/g, "")).toBe(
      "Evening light exposure shifts your circadian clock later.",
    );
    expect(res.body.citation).toBe("Zeitzer et al., 2000, J Physiol");
    expect(res.body.paper).toMatch(/circadian pacemaker/);
    expect(res.body.finding).toMatch(/melatonin/);
    expect(res.body.interpretation).toMatch(/dim/i);
    expect(res.body.action).toMatch(/Dim household lights/);
    expect(res.body.insight).toMatch(/enough to matter/);
    expect(res.body.pillars).toEqual(["Sleep", "Nutrition"]);
    expect(Array.isArray(res.body.provenance)).toBe(true);
    expect(res.body.provenance).toHaveLength(1);
    expect(res.body.provenance[0]).toMatchObject({
      source_id: 1,
      pillar_slug: "sleep",
      authors: "Zeitzer et al.",
      year: 2000,
    });
    expect(res.body.provenance[0]).not.toHaveProperty("excerpts");
    expect(JSON.stringify(res.body.provenance)).not.toContain(
      "Even ~100 lux at night significantly suppresses melatonin.",
    );
    expect(res.body.source).toMatch(/Stanford Lifestyle Medicine/);
    expect(res.body.refused).toBeUndefined();
    expect(res.body.uncovered).toBeUndefined();
    expectLicense(res.body);
  });

  test("covered path passes limitNotices through only when non-empty", async () => {
    // Empty notices → key absent entirely (mirrors the SSE surfaces).
    governedAnswerMock.mockResolvedValueOnce(coveredResult());
    const clean = await request(app)
      .post("/api/agent/query")
      .set("X-Palonur-Key", key.raw)
      .send({ query: "Why do I wake up at 3am?" });
    expect(clean.status).toBe(200);
    expect(clean.body.limitNotices).toBeUndefined();

    // Non-empty notices → forwarded verbatim.
    governedAnswerMock.mockResolvedValueOnce({
      ...coveredResult(),
      limitNotices: [
        { code: "few_sources", sourceCount: 1 },
        { code: "pending_review", pendingCount: 2 },
      ],
    });
    const thin = await request(app)
      .post("/api/agent/query")
      .set("X-Palonur-Key", key.raw)
      .send({ query: "Why do I wake up at 3am?" });
    expect(thin.status).toBe(200);
    expect(thin.body.limitNotices).toEqual([
      { code: "few_sources", sourceCount: 1 },
      { code: "pending_review", pendingCount: 2 },
    ]);
  });

  test("GET covered path returns the same shape", async () => {
    governedAnswerMock.mockResolvedValueOnce(coveredResult());

    const res = await request(app)
      .get("/api/agent/query")
      .query({ q: "Why do I wake up at 3am?" })
      .set("X-Palonur-Key", key.raw);

    expect(res.status).toBe(200);
    expect(governedAnswerMock).toHaveBeenCalledWith(
      // Keyed callers also thread their canary policy (IP protection);
      // null when the fingerprint table isn't provisioned in this suite.
      expect.objectContaining({ question: "Why do I wake up at 3am?" }),
    );
    expect(res.body.answer).toMatch(/circadian clock/);
    expect(res.body.citation).toBe("Zeitzer et al., 2000, J Physiol");
    expect(res.body.pillars).toEqual(["Sleep", "Nutrition"]);
    expect(res.body.provenance).toHaveLength(1);
    expectLicense(res.body);
  });

  test("covered path collapses same-work chapter provenance at the boundary", async () => {
    // Two chapter-split sources of the SAME book must render as one entry.
    governedAnswerMock.mockResolvedValueOnce({
      ...coveredResult(),
      provenance: [
        makeProvenance({
          source_id: 1,
          chunk_ids: [11],
          title: "The Good Life (the Grow pillar)",
          authors: "Waldinger & Schulz",
          year: 2023,
          journal: null,
          doi: null,
        }),
        makeProvenance({
          source_id: 2,
          chunk_ids: [12],
          title: "The Good Life (the Connect pillar)",
          authors: "Waldinger & Schulz",
          year: 2023,
          journal: null,
          doi: null,
        }),
      ],
    });

    const res = await request(app)
      .post("/api/agent/query")
      .set("X-Palonur-Key", key.raw)
      .send({ query: "What makes a good life?" });

    expect(res.status).toBe(200);
    expect(res.body.provenance).toHaveLength(1);
    expect(res.body.provenance[0].title).toBe("The Good Life");
    expect(res.body.provenance[0].chunk_ids).toEqual([11, 12]);
  });

  test("refused path returns refused + reason + pillars + license (no answer fields)", async () => {
    governedAnswerMock.mockResolvedValueOnce({
      outcome: "refused",
      reason: "This question is outside lifestyle medicine.",
      answer: null,
      citation: null,
      paper: null,
      finding: null,
      interpretation: null,
      action: null,
      insight: null,
      pillarNames: ["Sleep", "Nutrition"],
      provenance: [],
      citationVerification: null,
      voiceVerification: null,
      topScore: 0,
    });

    const res = await request(app)
      .post("/api/agent/query")
      .set("X-Palonur-Key", key.raw)
      .send({ query: "What stocks should I buy?" });

    expect(res.status).toBe(200);
    expect(res.body.refused).toBe(true);
    expect(res.body.reason).toBe("This question is outside lifestyle medicine.");
    expect(res.body.pillars).toEqual(["Sleep", "Nutrition"]);
    expect(res.body.answer).toBeUndefined();
    expect(res.body.citation).toBeUndefined();
    expect(res.body.provenance).toBeUndefined();
    expect(res.body.uncovered).toBeUndefined();
    expectLicense(res.body);
  });

  test("uncovered path returns uncovered + reason + pillars + license", async () => {
    governedAnswerMock.mockResolvedValueOnce({
      outcome: "uncovered",
      reason:
        "The approved knowledge layer does not yet cover this topic.",
      answer: null,
      citation: null,
      paper: null,
      finding: null,
      interpretation: null,
      action: null,
      insight: null,
      pillarNames: ["Sleep"],
      provenance: [],
      citationVerification: null,
      voiceVerification: null,
      topScore: 0.21,
    });

    const res = await request(app)
      .get("/api/agent/query")
      .query({ q: "Does magnesium threonate cross the blood-brain barrier?" })
      .set("X-Palonur-Key", key.raw);

    expect(res.status).toBe(200);
    expect(res.body.uncovered).toBe(true);
    expect(res.body.reason).toMatch(/does not yet cover/);
    expect(res.body.pillars).toEqual(["Sleep"]);
    expect(res.body.answer).toBeUndefined();
    expect(res.body.refused).toBeUndefined();
    expectLicense(res.body);
  });

  test("governedAnswer failure → 500 with error message, never a silent fallback", async () => {
    governedAnswerMock.mockRejectedValueOnce(new Error("retrieval exploded"));

    const res = await request(app)
      .post("/api/agent/query")
      .set("X-Palonur-Key", key.raw)
      .send({ query: "Why do I wake up at 3am?" });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("retrieval exploded");
  });

  test("POST missing/short query → 400 and governedAnswer never runs", async () => {
    const missing = await request(app)
      .post("/api/agent/query")
      .set("X-Palonur-Key", key.raw)
      .send({});
    expect(missing.status).toBe(400);

    const short = await request(app)
      .post("/api/agent/query")
      .set("X-Palonur-Key", key.raw)
      .send({ query: "hi" });
    expect(short.status).toBe(400);

    const getMissing = await request(app)
      .get("/api/agent/query")
      .set("X-Palonur-Key", key.raw);
    expect(getMissing.status).toBe(400);

    expect(governedAnswerMock).not.toHaveBeenCalled();
  });

  test("endpoint requires a key — no anonymous or first-party access", async () => {
    const res = await request(app)
      .post("/api/agent/query")
      .set("Sec-Fetch-Site", "same-origin")
      .send({ query: "Why do I wake up at 3am?" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("key_required");
    expect(governedAnswerMock).not.toHaveBeenCalled();
  });

  test("Bearer key works end-to-end on /api/agent/query", async () => {
    governedAnswerMock.mockResolvedValueOnce(coveredResult());

    const res = await request(app)
      .post("/api/agent/query")
      .set("Authorization", `Bearer ${key.raw}`)
      .send({ query: "Why do I wake up at 3am?" });

    expect(res.status).toBe(200);
    expect(res.body.answer).toMatch(/circadian clock/);
    expect(res.headers["x-palonur-usage-policy"]).toBe("no-training");
    expectLicense(res.body);
  });
});
