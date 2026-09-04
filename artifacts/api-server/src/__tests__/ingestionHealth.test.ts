import { afterAll, beforeAll, describe, test, expect, vi } from "vitest";
import { ensureCaptureLoopSchema, makeTopicEmbedding } from "./testHelpers.js";

vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-ingestion-health-secret";
});

// Deterministic, network-free embeddings: texts sharing a topic word land on
// the same axis (cosine 1), unrelated texts on different axes (cosine 0).
vi.mock("../lib/embeddings.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/embeddings.js")>(
    "../lib/embeddings.js",
  );
  return {
    ...actual,
    embedTexts: vi.fn(async (texts: string[]) =>
      texts.map((t) => makeTopicEmbedding(t)),
    ),
  };
});

import type { Express } from "express";
import request from "supertest";
import { createHmac } from "crypto";
import pool from "../lib/db.js";
import { toVectorLiteral, EMBEDDING_MODEL } from "../lib/embeddings.js";

let app: Express;
const stamp = Date.now().toString(36);
let pillarId = 0;
let healthySourceId = 0; // 2 chunks, both embedded, current model, on-topic
let brokenSourceId = 0; // 1 chunk missing embedding + 1 chunk on an old model
let offTopicSourceId = 0; // unscored historical doc whose text is off-topic
let testerUserId = 0;

function signCookie(val: string, secret: string): string {
  const hash = createHmac("sha256", secret)
    .update(val)
    .digest("base64")
    .replace(/=+$/, "");
  return val + "." + hash;
}
function signed(value: string): string {
  return "s:" + signCookie(value, process.env.SESSION_SECRET as string);
}
const adminCookie = () => `palonur_admin=${encodeURIComponent(signed("1"))}`;

async function seedFixtures() {
  // Pillar + sources are keyed by `stamp`, so re-seeding after a CASCADE
  // truncation from a parallel suite is safe (fresh ids each run).
  const { rows: pr } = await pool.query<{ id: number }>(
    `INSERT INTO pillars (slug, name, description)
     VALUES ($1, $2, 'Melatonin, circadian rhythm and light exposure')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [`ingest-health-${stamp}`, `Ingestion Health Pillar ${stamp}`],
  );
  pillarId = pr[0].id;

  // Healthy, approved, on-topic doc — its chunks form the pillar's topic
  // anchor (melatonin axis).
  const { rows: h } = await pool.query<{ id: number }>(
    `INSERT INTO sources
       (pillar_id, kind, title, status, full_text, rights_basis, retention_status)
     VALUES ($1, 'paper', $2, 'approved', $3, 'permission', 'retained_with_rights')
     RETURNING id`,
    [
      pillarId,
      `Melatonin and light exposure ${stamp}`,
      "Melatonin suppression under evening light. More melatonin circadian detail.",
    ],
  );
  healthySourceId = h[0].id;
  const mel = toVectorLiteral(makeTopicEmbedding("melatonin"));
  await pool.query(
    `INSERT INTO source_chunks (source_id, chunk_index, text, embedding, embedding_model)
     VALUES ($1, 0, $2, $3::halfvec, $4), ($1, 1, $5, $3::halfvec, $4)`,
    [
      healthySourceId,
      "Melatonin suppression under evening light exposure.",
      mel,
      EMBEDDING_MODEL,
      "Circadian phase shifts from timed light.",
    ],
  );

  // Broken doc: one chunk missing its embedding, one on an old model.
  const { rows: b } = await pool.query<{ id: number }>(
    `INSERT INTO sources
       (pillar_id, kind, title, status, full_text, rights_basis, retention_status)
     VALUES ($1, 'paper', $2, 'draft', $3, 'permission', 'retained_with_rights')
     RETURNING id`,
    [
      pillarId,
      `Broken embeddings doc ${stamp}`,
      "Circadian light chunk text for the broken doc.",
    ],
  );
  brokenSourceId = b[0].id;
  await pool.query(
    `INSERT INTO source_chunks (source_id, chunk_index, text, embedding, embedding_model)
     VALUES ($1, 0, 'missing embedding chunk', NULL, $3),
            ($1, 1, 'old model chunk about circadian light', $2::halfvec, 'text-embedding-3-large')`,
    [brokenSourceId, mel, EMBEDDING_MODEL],
  );

  // Historical off-topic doc: never scored; text is on the tinnitus axis.
  const { rows: o } = await pool.query<{ id: number }>(
    `INSERT INTO sources
       (pillar_id, kind, title, status, full_text, rights_basis, retention_status)
     VALUES ($1, 'paper', $2, 'draft', $3, 'permission', 'retained_with_rights')
     RETURNING id`,
    [
      pillarId,
      `Tinnitus treatment doc ${stamp}`,
      "Tinnitus masking therapy outcomes in adults.",
    ],
  );
  offTopicSourceId = o[0].id;

  // Interpretation chunk with a model mismatch (drill-down coverage).
  const testerEmail = `ingest-health-${stamp}@example.com`;
  const { rows: existing } = await pool.query<{ id: number }>(
    `SELECT id FROM faculty_users WHERE email = $1`,
    [testerEmail],
  );
  if (existing.length > 0) {
    testerUserId = existing[0].id;
  } else {
    const { rows: fu } = await pool.query<{ id: number }>(
      `INSERT INTO faculty_users (email, name, clerk_user_id)
       VALUES ($1, 'Ingest Health Tester', $2) RETURNING id`,
      [testerEmail, `clerk-ingest-health-${stamp}`],
    );
    testerUserId = fu[0].id;
  }
  const { rows: ir } = await pool.query<{ id: number }>(
    `INSERT INTO interpretations
       (source_id, pillar_id, author_id, status, answer, interpretation, action, tags, approver_id, approved_at)
     VALUES ($1, $2, $3, 'approved', 'a', 'i', 'act', ARRAY['sleep']::text[], $3, NOW())
     RETURNING id`,
    [healthySourceId, pillarId, testerUserId],
  );
  await pool.query(
    `INSERT INTO interpretation_chunks (pillar_id, source_id, interpretation_id, chunk_index, text, embedding, embedding_model)
     VALUES ($1, $2, $3, 0, 'interp chunk on old model', $4::halfvec, 'text-embedding-3-large')`,
    [pillarId, healthySourceId, ir[0].id, mel],
  );
}

beforeAll(async () => {
  await ensureCaptureLoopSchema();
  // Tests import app.ts (no boot DDL) — self-provision the topic-fit columns.
  await pool.query(
    `ALTER TABLE sources
       ADD COLUMN IF NOT EXISTS topic_fit_score real,
       ADD COLUMN IF NOT EXISTS off_topic_suspect boolean NOT NULL DEFAULT false,
       ADD COLUMN IF NOT EXISTS topic_fit_checked_at timestamptz`,
  );
  app = (await import("../app.js")).default;
  await seedFixtures();
});

afterAll(async () => {
  await pool.query(`DELETE FROM pillars WHERE slug = $1`, [
    `ingest-health-${stamp}`,
  ]);
});

describe("admin gating", () => {
  test("all three endpoints 401 without the admin cookie", async () => {
    await request(app).get("/api/admin/ingestion-health").expect(401);
    await request(app)
      .get(`/api/admin/ingestion-health/pillars/${pillarId}/documents`)
      .expect(401);
    await request(app)
      .post(`/api/admin/ingestion-health/pillars/${pillarId}/verify`)
      .expect(401);
  });

  test("rejects an invalid pillar id", async () => {
    await request(app)
      .get(`/api/admin/ingestion-health/pillars/nope/documents`)
      .set("Cookie", adminCookie())
      .expect(400);
  });
});

describe("per-pillar summaries", () => {
  test("reports chunk counts, embedding coverage and model mismatch for both chunk kinds", async () => {
    const res = await request(app)
      .get("/api/admin/ingestion-health")
      .set("Cookie", adminCookie())
      .expect(200);
    expect(res.body.embeddingModel).toBe(EMBEDDING_MODEL);
    expect(typeof res.body.retrievalThreshold).toBe("number");
    expect(typeof res.body.topicFitThreshold).toBe("number");

    const p = res.body.pillars.find(
      (x: { pillarId: number }) => x.pillarId === pillarId,
    );
    expect(p).toBeTruthy();
    expect(p.sourceCount).toBe(3);
    expect(p.approvedSourceCount).toBe(1);
    expect(p.draftSourceCount).toBe(2);
    expect(p.inReviewSourceCount).toBe(0);
    expect(p.archivedSourceCount).toBe(0);
    // This pillar has missing + mismatched embeddings → flagged unhealthy.
    expect(p.healthy).toBe(false);
    expect(p.sourceChunkCount).toBe(4);
    expect(p.sourceChunksMissingEmbedding).toBe(1);
    expect(p.sourceChunksModelMismatch).toBe(1);
    expect(p.interpretationChunkCount).toBe(1);
    expect(p.interpretationChunksMissingEmbedding).toBe(0);
    expect(p.interpretationChunksModelMismatch).toBe(1);
  });
});

describe("document drill-down + lazy topic-fit scoring", () => {
  test("lazily scores historical docs and flags the off-topic one; never blocks anything", async () => {
    const res = await request(app)
      .get(`/api/admin/ingestion-health/pillars/${pillarId}/documents`)
      .set("Cookie", adminCookie())
      .expect(200);
    const docs: Array<{
      sourceId: number;
      chunkCount: number;
      chunksMissingEmbedding: number;
      chunksModelMismatch: number;
      topicFitScore: number | null;
      offTopicSuspect: boolean;
      uploaderName: string | null;
      uploaderEmail: string | null;
      embeddingModels: string[];
    }> = res.body.documents;

    const healthy = docs.find((d) => d.sourceId === healthySourceId)!;
    const broken = docs.find((d) => d.sourceId === brokenSourceId)!;
    const offTopic = docs.find((d) => d.sourceId === offTopicSourceId)!;

    expect(healthy.chunkCount).toBe(2);
    expect(healthy.chunksMissingEmbedding).toBe(0);
    expect(broken.chunksMissingEmbedding).toBe(1);
    expect(broken.chunksModelMismatch).toBe(1);

    // Provenance surfaced per document: embedding model(s) actually used.
    expect(healthy.embeddingModels).toEqual([EMBEDDING_MODEL]);
    expect(broken.embeddingModels).toContain("text-embedding-3-large");
    // Seeded rows have no uploader (nullable) — the field is present.
    expect(healthy.uploaderName).toBeNull();
    expect(healthy.uploaderEmail).toBeNull();

    // Lazy scoring ran at read time: the on-topic docs score high (their
    // text shares the melatonin/circadian axis with the approved corpus),
    // the tinnitus doc lands on a different axis → flagged, never deleted.
    expect(healthy.topicFitScore).toBeGreaterThan(0.9);
    expect(healthy.offTopicSuspect).toBe(false);
    expect(broken.topicFitScore).toBeGreaterThan(0.9);
    expect(broken.offTopicSuspect).toBe(false);
    expect(offTopic.topicFitScore).not.toBeNull();
    expect(offTopic.topicFitScore!).toBeLessThan(0.2);
    expect(offTopic.offTopicSuspect).toBe(true);

    // Flag is observe-only: the row still exists with its chunks intact.
    const { rows } = await pool.query(
      `SELECT status FROM sources WHERE id = $1`,
      [offTopicSourceId],
    );
    expect(rows).toHaveLength(1);
  });

  test("scores are persisted — a second read returns the same values without rescoring", async () => {
    const { rows: before } = await pool.query(
      `SELECT topic_fit_checked_at FROM sources WHERE id = $1`,
      [offTopicSourceId],
    );
    const res = await request(app)
      .get(`/api/admin/ingestion-health/pillars/${pillarId}/documents`)
      .set("Cookie", adminCookie())
      .expect(200);
    const offTopic = res.body.documents.find(
      (d: { sourceId: number }) => d.sourceId === offTopicSourceId,
    );
    expect(offTopic.offTopicSuspect).toBe(true);
    const { rows: after } = await pool.query(
      `SELECT topic_fit_checked_at FROM sources WHERE id = $1`,
      [offTopicSourceId],
    );
    expect(String(after[0].topic_fit_checked_at)).toBe(
      String(before[0].topic_fit_checked_at),
    );
  });
});

describe("topic-fit at ingest time", () => {
  test("a new off-topic upload is flagged but still ingests successfully", async () => {
    const { ingestSource } = await import("../lib/ingestSource.js");
    const result = await ingestSource({
      pillarId,
      uploadedByUserId: testerUserId,
      meta: {
        kind: "note",
        title: `Ingest tinnitus note ${stamp}`,
        rightsBasis: "permission",
      },
      fullText:
        "Tinnitus is a perception of sound without external stimulus. Tinnitus management options vary.",
      fallbackTitle: "tinnitus note",
    });

    expect(result.chunkCount).toBeGreaterThan(0);
    const { rows } = await pool.query(
      `SELECT topic_fit_score, off_topic_suspect FROM sources WHERE id = $1`,
      [result.source.id],
    );
    expect(rows[0].off_topic_suspect).toBe(true);
    expect(Number(rows[0].topic_fit_score)).toBeLessThan(0.2);
    await pool.query(`DELETE FROM sources WHERE id = $1`, [result.source.id]);
  });

  test("a new on-topic upload is scored high and not flagged", async () => {
    const { ingestSource } = await import("../lib/ingestSource.js");
    const result = await ingestSource({
      pillarId,
      uploadedByUserId: testerUserId,
      meta: {
        kind: "note",
        title: `Ingest melatonin note ${stamp}`,
        rightsBasis: "permission",
      },
      fullText:
        "Melatonin onset shifts with evening light. Circadian timing matters for melatonin release.",
      fallbackTitle: "melatonin note",
    });
    const { rows } = await pool.query(
      `SELECT topic_fit_score, off_topic_suspect FROM sources WHERE id = $1`,
      [result.source.id],
    );
    expect(rows[0].off_topic_suspect).toBe(false);
    expect(Number(rows[0].topic_fit_score)).toBeGreaterThan(0.9);
    await pool.query(`DELETE FROM sources WHERE id = $1`, [result.source.id]);
  });
});

describe("self-retrieval verification probe", () => {
  test("never re-embeds a stale chunk from a purged source", async () => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO sources
         (pillar_id, kind, title, status, rights_basis, retention_status)
       VALUES ($1, 'paper', 'Purged stale fixture', 'approved',
               'no_documented_full_text_rights', 'purged_no_full_text_rights')
       RETURNING id`,
      [pillarId],
    );
    const purgedSourceId = rows[0].id;
    await pool.query(
      `INSERT INTO source_chunks
         (source_id, chunk_index, text, embedding, embedding_model)
       VALUES ($1, 0, 'Purged melatonin text must never be re-embedded.',
               $2::halfvec, $3)`,
      [
        purgedSourceId,
        toVectorLiteral(makeTopicEmbedding("melatonin")),
        EMBEDDING_MODEL,
      ],
    );

    const res = await request(app)
      .post(`/api/admin/ingestion-health/pillars/${pillarId}/verify`)
      .set("Cookie", adminCookie())
      .expect(200);

    expect(res.body.results).not.toContainEqual(
      expect.objectContaining({ sourceId: purgedSourceId }),
    );
  });

  test("re-embedded chunks retrieve their own document above the threshold", async () => {
    const res = await request(app)
      .post(`/api/admin/ingestion-health/pillars/${pillarId}/verify`)
      .set("Cookie", adminCookie())
      .expect(200);
    // Only current-model embedded chunks are probeable: the healthy doc.
    // (The broken doc's chunks are NULL / old-model, so it is skipped.)
    expect(res.body.probed).toBeGreaterThanOrEqual(1);
    const healthy = res.body.results.find(
      (r: { sourceId: number }) => r.sourceId === healthySourceId,
    );
    expect(healthy).toBeTruthy();
    expect(healthy.selfHit).toBe(true);
    expect(healthy.topScore).toBeGreaterThan(0.99);
    expect(healthy.ok).toBe(true);
    expect(res.body.threshold).toBeGreaterThan(0);
  });

  test("verify is read-only — no rows change", async () => {
    const { rows: before } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM source_chunks sc
       JOIN sources s ON s.id = sc.source_id WHERE s.pillar_id = $1`,
      [pillarId],
    );
    await request(app)
      .post(`/api/admin/ingestion-health/pillars/${pillarId}/verify`)
      .set("Cookie", adminCookie())
      .expect(200);
    const { rows: after } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM source_chunks sc
       JOIN sources s ON s.id = sc.source_id WHERE s.pillar_id = $1`,
      [pillarId],
    );
    expect(after[0].n).toBe(before[0].n);
  });
});
