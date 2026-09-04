import { beforeAll, afterAll, describe, test, expect, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { ensureCaptureLoopSchema, makeTopicEmbedding } from "./testHelpers.js";

// Env must be set before the route/lib modules load.
vi.hoisted(() => {
  process.env.USE_GOVERNED_RAG = "true";
  process.env.RESEND_API_KEY = "stub-key";
});

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: async () => ({ id: "stub-id" }) };
  },
}));

// governedAnswer calls anthropic.messages.create (non-streaming). Return a
// fully-structured covered answer so the covered-path branch runs.
vi.mock("@anthropic-ai/sdk", () => {
  const text = [
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
    "A: Yes — the dose-response saturates near 100 lux.",
  ].join("\n");
  class FakeAnthropic {
    messages = {
      create: async () => ({ content: [{ type: "text", text }] }),
    };
  }
  return { default: FakeAnthropic };
});

// Deterministic embeddings so the seeded chunk clears RAG_MIN_SCORE.
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

// ─── Imports that depend on the mocks above ────────────────────────────
import type { Express } from "express";
import request from "supertest";
import pool from "../lib/db.js";
import { toVectorLiteral } from "../lib/embeddings.js";
import { clearEmbeddingCache } from "../lib/rag.js";

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

let app: Express;
let pillarId = 0;
let sourceId = 0;
let keyId = 0;
let keyRaw = "";
const pillarName = "MCP Test Pillar";
const pillarSlug = `mcp-test-${Date.now()}`;
const stewardEmail = `mcp-steward-${Date.now()}@test.local`;
const sourceTitle = "Sensitivity of the human circadian pacemaker to nocturnal light";

async function mcp(body: unknown, key?: string) {
  const req = request(app).post("/api/mcp").send(body as object);
  if (key) req.set("X-Palonur-Key", key);
  return req;
}

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
    [`mcp-clerk-${Date.now()}`, stewardEmail, "MCP Test Steward"],
  );
  const stewardId = userRows[0].id;

  await pool.query(
    `INSERT INTO faculty_memberships (user_id, pillar_id, role)
     VALUES ($1, $2, 'steward')`,
    [stewardId, pillarId],
  );

  const { rows: sourceRows } = await pool.query<{ id: number }>(
    `INSERT INTO sources
        (pillar_id, kind, title, authors, year, journal, doi,
         abstract, source_url, status, uploaded_by_user_id)
       VALUES ($1, 'paper', $2, 'Zeitzer JM et al.', 2000, 'J Physiol',
               '10.1111/mcp-test', 'Stub abstract on melatonin.',
               'https://example.test/circadian-light',
               'approved', $3)
       RETURNING id`,
    [pillarId, sourceTitle, stewardId],
  );
  sourceId = sourceRows[0].id;

  const sourceChunkText =
    "Even very dim ordinary room light at night significantly suppresses melatonin and shifts the human circadian clock.";
  const sourceVec = toVectorLiteral(makeTopicEmbedding(sourceChunkText));
  await pool.query(
    `INSERT INTO source_chunks
       (source_id, chunk_index, text, embedding, embedding_model)
     VALUES ($1, 0, $2, $3::halfvec(384), 'Xenova/gte-small')`,
    [sourceId, sourceChunkText, sourceVec],
  );

  const inserted = await insertPartnerKey("mcp-partner");
  keyId = inserted.id;
  keyRaw = inserted.raw;

  clearEmbeddingCache();
  app = (await import("../app.js")).default;
});

afterAll(async () => {
  if (pillarId) {
    await pool.query(`DELETE FROM agent_queries WHERE $1 = ANY(pillar_ids)`, [pillarId]);
    await pool.query(
      `DELETE FROM source_chunks WHERE source_id IN
         (SELECT id FROM sources WHERE pillar_id = $1)`,
      [pillarId],
    );
    await pool.query(`DELETE FROM sources WHERE pillar_id = $1`, [pillarId]);
    await pool.query(`DELETE FROM faculty_memberships WHERE pillar_id = $1`, [pillarId]);
    await pool.query(
      `DELETE FROM faculty_users WHERE email = $1`,
      [stewardEmail],
    );
    await pool.query(`DELETE FROM pillars WHERE id = $1`, [pillarId]);
  }
  if (keyId) {
    await pool.query(`DELETE FROM partner_keys WHERE id = $1`, [keyId]);
  }
  await pool.end();
});

describe("MCP endpoint", () => {
  test("rejects unauthenticated requests with 401", async () => {
    const res = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("key_required");
  });

  test("initialize returns protocol version + serverInfo", async () => {
    const res = await mcp(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      keyRaw,
    );
    expect(res.status).toBe(200);
    expect(res.body.result.protocolVersion).toBe("2025-06-18");
    expect(res.body.result.serverInfo.name).toBe("palonur-governed-science");
    expect(res.body.result.capabilities.tools).toBeDefined();
  });

  test("notifications/initialized is accepted with 202 and no body", async () => {
    const res = await mcp(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      keyRaw,
    );
    expect(res.status).toBe(202);
    expect(res.text).toBe("");
  });

  test("tools/list returns ask_palonur and list_pillars", async () => {
    const res = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" }, keyRaw);
    expect(res.status).toBe(200);
    const names = (res.body.result.tools as Array<{ name: string; inputSchema: unknown }>).map(
      (t) => t.name,
    );
    expect(names).toContain("ask_palonur");
    expect(names).toContain("list_pillars");
    // Every tool advertises a JSON-Schema input.
    for (const t of res.body.result.tools as Array<{ inputSchema: unknown }>) {
      expect(t.inputSchema).toBeTruthy();
    }
  });

  test("tools/call list_pillars includes the seeded active pillar + license", async () => {
    const res = await mcp(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_pillars", arguments: {} },
      },
      keyRaw,
    );
    expect(res.status).toBe(200);
    const sc = res.body.result.structuredContent as {
      pillars: Array<{ slug: string; name: string }>;
      usage_policy: string;
    };
    expect(sc.pillars.some((p) => p.slug === pillarSlug)).toBe(true);
    // Steward identity must NEVER be serialized here.
    expect(JSON.stringify(sc.pillars)).not.toMatch(/steward|email/i);
    expect(sc.usage_policy).toBe("no-training");
  });

  test("tools/call ask_palonur returns a covered answer with provenance + license", async () => {
    const res = await mcp(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "ask_palonur",
          arguments: {
            question: "Does evening light shift the circadian clock?",
            pillar: pillarSlug,
          },
        },
      },
      keyRaw,
    );
    expect(res.status).toBe(200);
    const result = res.body.result as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
      structuredContent: {
        outcome: string;
        provenance: Array<{ source_id: number; title: string; pillar_slug: string }>;
        usage_policy: string;
        license: { policy: string; terms_url: string; attribution: string };
        citation_verification: unknown;
        limit_notices?: Array<{ code: string }>;
      };
    };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.outcome).toBe("covered");
    expect(result.content[0].text).toMatch(/melatonin/i);

    const cited = result.structuredContent.provenance.find((p) => p.source_id === sourceId);
    expect(cited).toBeDefined();
    expect(cited!.title).toBe(sourceTitle);
    expect(cited!.pillar_slug).toBe(pillarSlug);

    // No-training usage POLICY rides along (license term, not a guarantee).
    expect(result.structuredContent.usage_policy).toBe("no-training");
    expect(result.structuredContent.license.policy).toBe("no-training");
    expect(result.structuredContent.license.terms_url).toMatch(/\/agent-license$/);

    // Amber limit notices ride along on tool surfaces too. The seeded corpus
    // is deliberately thin (a single source), so the few_sources honest-
    // limitation signal must reach MCP consumers, not just the web UIs.
    const notices = result.structuredContent.limit_notices;
    expect(Array.isArray(notices)).toBe(true);
    expect(notices!.map((n) => n.code)).toContain("few_sources");
  });

  test("tools/call ask_palonur on an unknown pillar returns uncovered (no throw)", async () => {
    const res = await mcp(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "ask_palonur",
          arguments: { question: "anything", pillar: "no-such-pillar-xyz" },
        },
      },
      keyRaw,
    );
    expect(res.status).toBe(200);
    expect(res.body.result.structuredContent.outcome).toBe("uncovered");
  });

  test("tools/call ask_palonur with too-short question → tool error result", async () => {
    const res = await mcp(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "ask_palonur", arguments: { question: "a" } },
      },
      keyRaw,
    );
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toMatch(/invalid arguments/i);
  });

  test("tools/call on an unknown tool → isError result", async () => {
    const res = await mcp(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "nope", arguments: {} },
      },
      keyRaw,
    );
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toMatch(/unknown tool/i);
  });

  test("unknown method → JSON-RPC method-not-found error", async () => {
    const res = await mcp(
      { jsonrpc: "2.0", id: 8, method: "does/not/exist" },
      keyRaw,
    );
    expect(res.status).toBe(200);
    expect(res.body.error.code).toBe(-32601);
  });
});

describe("agent discovery documents", () => {
  test("GET /llms.txt is public and advertises MCP + no-training policy", async () => {
    const res = await request(app).get("/llms.txt");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.text).toMatch(/Model Context Protocol/);
    expect(res.text).toMatch(/\/api\/mcp/);
    expect(res.text).toMatch(/no-training/);
  });

  test("GET /.well-known/mcp.json is public and lists the tools", async () => {
    const res = await request(app).get("/.well-known/mcp.json");
    expect(res.status).toBe(200);
    expect(res.body.protocol).toBe("mcp");
    expect(res.body.endpoint).toMatch(/\/api\/mcp$/);
    const toolNames = (res.body.tools as Array<{ name: string }>).map((t) => t.name);
    expect(toolNames).toContain("ask_palonur");
    expect(toolNames).toContain("list_pillars");
    expect(res.body.usagePolicy.policy).toBe("no-training");
  });

  test("GET /api/agent/spec covers the MCP + streaming agent endpoints", async () => {
    const res = await request(app).get("/api/agent/spec");
    expect(res.status).toBe(200);
    const paths = res.body.paths as Record<string, unknown>;
    expect(paths["/mcp"]).toBeDefined();
    expect(paths["/sleep-agent"]).toBeDefined();
    expect(paths["/embed-agent"]).toBeDefined();
    expect(paths["/embed/pillar/{slug}"]).toBeDefined();
  });
});
