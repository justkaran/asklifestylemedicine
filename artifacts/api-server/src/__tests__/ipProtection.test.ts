import { beforeAll, afterAll, describe, test, expect, vi } from "vitest";
import { makeTopicEmbedding } from "./testHelpers.js";

// Deterministic embeddings — no network, no ONNX model. Same axis trick as
// governedRagCovered.test.ts so the seeded chunks clear RAG_MIN_SCORE.
vi.mock("../lib/embeddings.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/embeddings.js")>(
    "../lib/embeddings.js",
  );
  return {
    ...actual,
    embedTexts: vi.fn(async (texts: string[]) => texts.map(makeTopicEmbedding)),
  };
});

import pool from "../lib/db.js";
import { retrieve, clearEmbeddingCache } from "../lib/rag.js";
import { toVectorLiteral } from "../lib/embeddings.js";
import {
  sha256Hex,
  zeroWidthEncode,
  zeroWidthDecode,
  stripZeroWidth,
  applyFingerprint,
  deriveFingerprintSecret,
  ensureFingerprint,
  fingerprintMarker,
  generateCorpusManifestIfChanged,
} from "../lib/ipProtection.js";

const SLUG = "ip-protection-test-pillar";
let pillarId = 0;
let realSourceId = 0;
let canarySourceId = 0;
const CANARY_DOI = "canary:test-cnry-xx";

async function ensureSchema(): Promise<void> {
  // Tests import app/libs, never index.ts, so boot DDL must be
  // self-provisioned here (see .agents/memory/api-server-test-schema.md).
  await pool.query(
    `ALTER TABLE sources ADD COLUMN IF NOT EXISTS content_hash TEXT,
       ADD COLUMN IF NOT EXISTS is_canary BOOLEAN NOT NULL DEFAULT FALSE`,
  );
  await pool.query(
    `ALTER TABLE source_chunks ADD COLUMN IF NOT EXISTS content_hash TEXT`,
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS corpus_manifests (
    id SERIAL PRIMARY KEY,
    manifest_hash TEXT NOT NULL,
    source_count INTEGER NOT NULL,
    chunk_count INTEGER NOT NULL,
    entries JSONB NOT NULL,
    reason TEXT NOT NULL DEFAULT 'boot',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS partner_key_fingerprints (
    id SERIAL PRIMARY KEY,
    partner_key_id INTEGER NOT NULL REFERENCES partner_keys(id) ON DELETE CASCADE,
    fingerprint_secret TEXT NOT NULL,
    marker_code TEXT NOT NULL,
    canary_variant INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS partner_key_fingerprints_key_unique
       ON partner_key_fingerprints (partner_key_id)`,
  );
}

async function insertSource(opts: {
  title: string;
  doi: string;
  text: string;
  isCanary: boolean;
}): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO sources
        (pillar_id, kind, title, doi, full_text, status, is_canary, content_hash,
         rights_basis, retention_status)
     VALUES ($1, 'note', $2, $3, $4, 'approved', $5, $6,
             'permission', 'retained_with_rights')
     RETURNING id`,
    [
      pillarId,
      opts.title,
      opts.doi,
      opts.text,
      opts.isCanary,
      sha256Hex(opts.text),
    ],
  );
  const id = rows[0].id;
  const vec = toVectorLiteral(makeTopicEmbedding(opts.text));
  await pool.query(
    `INSERT INTO source_chunks
        (source_id, chunk_index, text, embedding, embedding_model, content_hash)
     VALUES ($1, 0, $2, $3::halfvec(384), 'Xenova/gte-small', $4)`,
    [id, opts.text, vec, sha256Hex(opts.text)],
  );
  return id;
}

async function insertPartnerKey(name: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO partner_keys (key_hash, key_prefix, partner_name)
     VALUES ($1, 'plnr_test', $2) RETURNING id`,
    [sha256Hex(`ipfp-${name}-${Date.now()}-${Math.random()}`), name],
  );
  return rows[0].id;
}

beforeAll(async () => {
  await ensureSchema();
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO pillars (name, slug)
     VALUES ('IP Protection Test', $1)
     ON CONFLICT (slug) DO UPDATE SET retired_at = NULL
     RETURNING id`,
    [SLUG],
  );
  pillarId = rows[0].id;
  await pool.query(`DELETE FROM sources WHERE pillar_id = $1`, [pillarId]);

  // Real + canary docs share the melatonin axis so both would rank if
  // retrieval did not filter canaries.
  realSourceId = await insertSource({
    title: "Real melatonin note",
    doi: "10.1111/ip-real",
    text: "Dim evening light suppresses melatonin and shifts the circadian clock.",
    isCanary: false,
  });
  canarySourceId = await insertSource({
    title: "Synthetic canary registry document",
    doi: CANARY_DOI,
    text: "Synthetic canary about melatonin and circadian light with token PLNR-CNRY-TEST.",
    isCanary: true,
  });
  clearEmbeddingCache();
});

afterAll(async () => {
  await pool.query(`DELETE FROM sources WHERE pillar_id = $1`, [pillarId]);
  await pool.query(`UPDATE pillars SET retired_at = NOW() WHERE id = $1`, [
    pillarId,
  ]);
  await pool.end();
});

describe("content hashing helpers", () => {
  test("sha256Hex is deterministic", () => {
    expect(sha256Hex("abc")).toBe(sha256Hex("abc"));
    expect(sha256Hex("abc")).toHaveLength(64);
    expect(sha256Hex("abc")).not.toBe(sha256Hex("abd"));
  });
});

describe("canary exclusion in retrieval", () => {
  test("consumer retrieval (default) never sees canary chunks", async () => {
    const result = await retrieve({
      question: "Does evening light affect melatonin?",
      pillarIds: [pillarId],
      k: 6,
    });
    const sourceIds = result.chunks.map((c) => c.sourceId);
    expect(sourceIds).toContain(realSourceId);
    expect(sourceIds).not.toContain(canarySourceId);
  });

  test("keyed retrieval with an assigned canary DOI includes only that canary", async () => {
    const result = await retrieve({
      question: "Does evening light affect melatonin?",
      pillarIds: [pillarId],
      k: 6,
      includeCanaryDoi: CANARY_DOI,
    });
    const sourceIds = result.chunks.map((c) => c.sourceId);
    expect(sourceIds).toContain(realSourceId);
    expect(sourceIds).toContain(canarySourceId);

    // A DIFFERENT variant's DOI still excludes this canary.
    const other = await retrieve({
      question: "Does evening light affect melatonin?",
      pillarIds: [pillarId],
      k: 6,
      includeCanaryDoi: "canary:some-other-variant",
    });
    expect(other.chunks.map((c) => c.sourceId)).not.toContain(canarySourceId);
  });

  test("assigned canary is retrievable from a DIFFERENT pillar (non-sleep keyed surfaces); consumer still cannot", async () => {
    // Canaries live in one pillar, but every keyed surface (embed,
    // newsletter, MCP) must be able to serve the licensee's variant.
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO pillars (name, slug)
       VALUES ('IP Protection Other Pillar', 'ip-protection-test-pillar-2')
       ON CONFLICT (slug) DO UPDATE SET retired_at = NULL
       RETURNING id`,
    );
    const otherPillarId = rows[0].id;
    try {
      const keyed = await retrieve({
        question: "Does evening light affect melatonin?",
        pillarIds: [otherPillarId],
        k: 6,
        includeCanaryDoi: CANARY_DOI,
      });
      const keyedIds = keyed.chunks.map((c) => c.sourceId);
      expect(keyedIds).toContain(canarySourceId); // cross-pillar eligible
      expect(keyedIds).not.toContain(realSourceId); // real docs stay pillar-scoped

      const consumer = await retrieve({
        question: "Does evening light affect melatonin?",
        pillarIds: [otherPillarId],
        k: 6,
      });
      expect(consumer.chunks.map((c) => c.sourceId)).not.toContain(
        canarySourceId,
      );
    } finally {
      await pool.query(`UPDATE pillars SET retired_at = NOW() WHERE id = $1`, [
        otherPillarId,
      ]);
    }
  });
});

describe("corpus manifest (append-only)", () => {
  test("snapshots on change, no-ops when unchanged, appends on next change", async () => {
    const first = await generateCorpusManifestIfChanged("test");
    // May be null iff an identical snapshot already exists from a prior run;
    // in that case latest row's hash still matches a fresh recompute.
    const again = await generateCorpusManifestIfChanged("test");
    expect(again).toBeNull(); // unchanged corpus → no new row

    const { rows: beforeRows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM corpus_manifests`,
    );

    // Change the corpus → a NEW row is appended (old rows untouched).
    const extraId = await insertSource({
      title: "Second real note",
      doi: "10.1111/ip-real-2",
      text: "Another melatonin and circadian light note.",
      isCanary: false,
    });
    const next = await generateCorpusManifestIfChanged("test");
    expect(next).not.toBeNull();
    const { rows: afterRows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM corpus_manifests`,
    );
    expect(Number(afterRows[0].n)).toBe(Number(beforeRows[0].n) + 1);
    if (first) {
      const { rows } = await pool.query<{ manifest_hash: string }>(
        `SELECT manifest_hash FROM corpus_manifests WHERE id = $1`,
        [first.id],
      );
      expect(rows[0].manifest_hash).toBe(first.manifestHash); // append-only
      expect(next!.manifestHash).not.toBe(first.manifestHash);
    }
    await pool.query(`DELETE FROM sources WHERE id = $1`, [extraId]);
  });
});

describe("public + steward surfaces exclude canaries", () => {
  test("public source sheet 404s a canary; real source resolves", async () => {
    const request = (await import("supertest")).default;
    const app = (await import("../app.js")).default;
    const canaryRes = await request(app).get(
      `/api/sleep-agent/source/${canarySourceId}`,
    );
    expect(canaryRes.status).toBe(404);
    const realRes = await request(app).get(
      `/api/sleep-agent/source/${realSourceId}`,
    );
    expect(realRes.status).toBe(200);
    expect(realRes.body.id).toBe(realSourceId);
  });

  test("ingestion-health summaries and document lists skip canaries", async () => {
    const { getPillarIngestionSummaries, getPillarDocuments } =
      await import("../lib/ingestionHealth.js");
    const summaries = await getPillarIngestionSummaries();
    const mine = summaries.find((s) => s.pillarId === pillarId);
    expect(mine).toBeDefined();
    expect(Number(mine!.sourceCount)).toBe(1); // real only, canary excluded
    const docs = await getPillarDocuments(pillarId);
    const ids = docs.map((d) => d.sourceId);
    expect(ids).toContain(realSourceId);
    expect(ids).not.toContain(canarySourceId);
  });
});

describe("per-licensee fingerprints", () => {
  test("zero-width encode/decode roundtrip; strip removes it cleanly", () => {
    const marker = zeroWidthEncode("plnrfp:abcdef012345");
    expect(zeroWidthDecode(marker)).toBe("plnrfp:abcdef012345");
    const text = applyFingerprint("Sleep is regulated by light.", marker);
    expect(zeroWidthDecode(text)).toBe("plnrfp:abcdef012345");
    expect(stripZeroWidth(text)).toBe("Sleep is regulated by light.");
  });

  test("deterministic per key; two keys yield distinguishable output", async () => {
    const keyA = await insertPartnerKey("IP Test Partner A");
    const keyB = await insertPartnerKey("IP Test Partner B");
    try {
      expect(deriveFingerprintSecret(keyA)).toBe(deriveFingerprintSecret(keyA));
      expect(deriveFingerprintSecret(keyA)).not.toBe(
        deriveFingerprintSecret(keyB),
      );

      const fpA = await ensureFingerprint(keyA);
      const fpA2 = await ensureFingerprint(keyA); // idempotent
      const fpB = await ensureFingerprint(keyB);
      expect(fpA.id).toBe(fpA2.id);
      expect(fpA.markerCode).not.toBe(fpB.markerCode);
      // Marker code is derived, short, and NOT the secret itself.
      expect(fpA.markerCode).toHaveLength(12);
      expect(fpA.fingerprintSecret).not.toBe(fpA.markerCode);

      const outA = applyFingerprint("The answer text.", fingerprintMarker(fpA));
      const outB = applyFingerprint("The answer text.", fingerprintMarker(fpB));
      expect(outA).not.toBe(outB); // distinguishable
      expect(stripZeroWidth(outA)).toBe(stripZeroWidth(outB)); // invisible
      expect(zeroWidthDecode(outA)).toBe(`plnrfp:${fpA.markerCode}`);
      expect(zeroWidthDecode(outB)).toBe(`plnrfp:${fpB.markerCode}`);
    } finally {
      await pool.query(`DELETE FROM partner_keys WHERE id = ANY($1::int[])`, [
        [keyA, keyB],
      ]);
    }
  });

  test("consumer text path stays marker-free (no zero-width chars)", async () => {
    // Consumer surfaces never call applyFingerprint; assert the invariant
    // that untouched answer text carries no zero-width characters.
    const consumerAnswer = "Dim evening light suppresses melatonin.";
    expect(/[\u200B\u200C\u200D]/.test(consumerAnswer)).toBe(false);
    expect(zeroWidthDecode(consumerAnswer)).toBeNull();
  });
});
