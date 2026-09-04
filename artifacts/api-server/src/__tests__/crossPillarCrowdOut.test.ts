import { beforeAll, beforeEach, afterAll, describe, test, expect, vi } from "vitest";
import { ensureCaptureLoopSchema } from "./testHelpers.js";

/**
 * Regression lock for the cross-pillar "crowd-out" ranking bug.
 *
 * Retrieval used to prefer interpretation chunks with a MULTIPLICATIVE
 * weight (×1.25). In multi-pillar fan-out, loosely-related interpretation
 * chunks from other pillars (raw cosine ~0.85 → weighted ~1.06) beat a
 * near-perfect on-topic SOURCE chunk (~0.95) out of the top-k entirely,
 * so questions with an excellent match came back UNCOVERED. The fix is a
 * small ADDITIVE tie-breaker bonus (`INTERPRETATION_BONUS = +0.02` in
 * lib/rag.ts). These tests fail if anyone reintroduces a relevance-
 * overriding preference: with the geometry seeded below, ×1.25 would put
 * every off-pillar interpretation above the on-topic source chunk again.
 */

// Deterministic embeddings: the question maps to the base axis; seeded
// chunk vectors are constructed directly at exact cosine similarities to
// that axis. No network, no model download.
vi.mock("../lib/embeddings.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/embeddings.js")>(
    "../lib/embeddings.js",
  );
  return {
    ...actual,
    embedTexts: vi.fn(async (texts: string[]) =>
      texts.map(() => {
        const v = new Array(384).fill(0);
        // Private axis pair (200/201): other suites' deterministic
        // embeddings use low axes (0/1/3/10/20 in makeTopicEmbedding);
        // sharing an axis would let this suite's high-similarity chunks
        // hijack routing in suites running in parallel on the shared DB.
        v[200] = 1; // every embedded QUESTION lands on the base axis
        return v;
      }),
    ),
  };
});

import pool from "../lib/db.js";
import { toVectorLiteral, EMBEDDING_MODEL } from "../lib/embeddings.js";
import { retrieve, buildProvenance, clearEmbeddingCache } from "../lib/rag.js";
import { RAG_MIN_SCORE } from "../lib/ragThreshold.js";

/** Unit vector at exact cosine `c` to the question axis (axis 200). */
function vecAtCosine(c: number): number[] {
  const v = new Array(384).fill(0);
  v[200] = c;
  v[201] = Math.sqrt(1 - c * c);
  return v;
}

// halfvec(384) storage is half-precision; allow a small tolerance when
// comparing scores that round-trip through Postgres.
const EPS = 0.005;

const runTag = `crowdout-${Date.now()}`;

// Geometry: on-topic source chunk at 0.95; six off-pillar interpretation
// chunks at 0.85. New additive scheme: 0.95 > 0.85 + 0.02 → source wins.
// Old multiplicative scheme: 0.85 × 1.25 = 1.0625 > 0.95 → all six
// interpretations fill the default top-k (6) and the source vanishes.
const SOURCE_COS = 0.95;
const INTERP_COS = 0.85;
const OFF_PILLAR_COUNT = 2;
const INTERPS_PER_PILLAR = 3;

// Boundary geometry: raw score just BELOW the coverage threshold, but
// weighted (raw + 0.02) just ABOVE it.
const BOUNDARY_COS = RAG_MIN_SCORE - 0.01;

interface Fixture {
  nutritionPillarId: number;
  nutritionSourceId: number;
  nutritionChunkId: number;
  offPillarIds: number[];
  boundaryPillarId: number;
  allPillarIds: number[];
}

let fx: Fixture;
let stewardId = 0;

/**
 * Idempotent fixture ensure (shared-DB convention): another suite's
 * TRUNCATE ... CASCADE can wipe beforeAll-seeded rows mid-run, so we
 * re-check and re-seed in beforeEach.
 */
async function ensureFixtures(): Promise<Fixture> {
  // Steward login row (interpretations need an author).
  const { rows: existingUser } = await pool.query<{ id: number }>(
    `SELECT id FROM faculty_users WHERE email = $1`,
    [`${runTag}@test.local`],
  );
  if (existingUser.length > 0) {
    stewardId = existingUser[0].id;
  } else {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO faculty_users (clerk_user_id, email, full_name)
       VALUES ($1, $2, 'Crowd Out Steward') RETURNING id`,
      [`clerk-${runTag}`, `${runTag}@test.local`],
    );
    stewardId = rows[0].id;
  }

  async function ensurePillar(slug: string, name: string): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO pillars (slug, name) VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [slug, name],
    );
    return rows[0].id;
  }

  async function ensureSource(
    pillarId: number,
    title: string,
  ): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `SELECT id FROM sources WHERE pillar_id = $1 AND title = $2`,
      [pillarId, title],
    );
    if (rows.length > 0) return rows[0].id;
    const { rows: ins } = await pool.query<{ id: number }>(
      `INSERT INTO sources
         (pillar_id, kind, title, authors, year, journal,
          abstract, status, uploaded_by_user_id)
       VALUES ($1, 'paper', $2, 'Crowd Out et al.', 2021, 'Test J',
               'Stub abstract.', 'approved', $3)
       RETURNING id`,
      [pillarId, title, stewardId],
    );
    return ins[0].id;
  }

  async function ensureSourceChunk(
    sourceId: number,
    text: string,
    cos: number,
  ): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `SELECT id FROM source_chunks WHERE source_id = $1 AND chunk_index = 0`,
      [sourceId],
    );
    if (rows.length > 0) return rows[0].id;
    const { rows: ins } = await pool.query<{ id: number }>(
      `INSERT INTO source_chunks
         (source_id, chunk_index, text, embedding, embedding_model)
       VALUES ($1, 0, $2, $3::halfvec(384), $4)
       RETURNING id`,
      [sourceId, text, toVectorLiteral(vecAtCosine(cos)), EMBEDDING_MODEL],
    );
    return ins[0].id;
  }

  async function ensureInterpChunk(
    sourceId: number,
    pillarId: number,
    chunkIndex: number,
    text: string,
    cos: number,
  ): Promise<void> {
    const { rows: interpRows } = await pool.query<{ id: number }>(
      `SELECT id FROM interpretations WHERE source_id = $1 AND pillar_id = $2`,
      [sourceId, pillarId],
    );
    let interpretationId: number;
    if (interpRows.length > 0) {
      interpretationId = interpRows[0].id;
    } else {
      const { rows: ins } = await pool.query<{ id: number }>(
        `INSERT INTO interpretations
           (source_id, pillar_id, author_id, status, answer, interpretation,
            action, approver_id, approved_at)
         VALUES ($1, $2, $3, 'approved', 'Stub answer.', 'Stub take.',
                 'Stub action.', $3, NOW())
         RETURNING id`,
        [sourceId, pillarId, stewardId],
      );
      interpretationId = ins[0].id;
    }
    const { rowCount } = await pool.query(
      `SELECT 1 FROM interpretation_chunks
        WHERE interpretation_id = $1 AND chunk_index = $2`,
      [interpretationId, chunkIndex],
    );
    if (rowCount && rowCount > 0) return;
    await pool.query(
      `INSERT INTO interpretation_chunks
         (interpretation_id, source_id, pillar_id, chunk_index, text,
          embedding, embedding_model, priority)
       VALUES ($1, $2, $3, $4, $5, $6::halfvec(384), $7, 100)`,
      [
        interpretationId,
        sourceId,
        pillarId,
        chunkIndex,
        text,
        toVectorLiteral(vecAtCosine(cos)),
        EMBEDDING_MODEL,
      ],
    );
  }

  // ── Nutrition-style pillar: one near-perfect approved SOURCE chunk ──
  const nutritionPillarId = await ensurePillar(
    `${runTag}-nutrition`,
    "Crowd Out Nutrition",
  );
  const nutritionSourceId = await ensureSource(
    nutritionPillarId,
    `${runTag} protein needs in older adults`,
  );
  const nutritionChunkId = await ensureSourceChunk(
    nutritionSourceId,
    "Older adults need roughly 1.0-1.2 g/kg of protein per day to preserve muscle.",
    SOURCE_COS,
  );

  // ── Off-topic pillars: lower-similarity approved INTERPRETATION chunks ──
  const offPillarIds: number[] = [];
  for (let p = 0; p < OFF_PILLAR_COUNT; p++) {
    const pillarId = await ensurePillar(
      `${runTag}-off-${p}`,
      `Crowd Out Off Pillar ${p}`,
    );
    offPillarIds.push(pillarId);
    const srcId = await ensureSource(pillarId, `${runTag} off-topic paper ${p}`);
    for (let i = 0; i < INTERPS_PER_PILLAR; i++) {
      await ensureInterpChunk(
        srcId,
        pillarId,
        i,
        `Loosely related steward take ${p}-${i} about general wellbeing.`,
        INTERP_COS,
      );
    }
  }

  // ── Boundary pillar: single interpretation chunk hugging the threshold ──
  const boundaryPillarId = await ensurePillar(
    `${runTag}-boundary`,
    "Crowd Out Boundary",
  );
  const boundarySourceId = await ensureSource(
    boundaryPillarId,
    `${runTag} boundary paper`,
  );
  await ensureInterpChunk(
    boundarySourceId,
    boundaryPillarId,
    0,
    "Boundary steward take sitting just under the coverage threshold.",
    BOUNDARY_COS,
  );

  return {
    nutritionPillarId,
    nutritionSourceId,
    nutritionChunkId,
    offPillarIds,
    boundaryPillarId,
    allPillarIds: [nutritionPillarId, ...offPillarIds],
  };
}

beforeAll(async () => {
  await ensureCaptureLoopSchema();
});

beforeEach(async () => {
  fx = await ensureFixtures();
  // The question embedding cache is keyed by text and survives across
  // tests; drop it so every test embeds fresh via the mock.
  clearEmbeddingCache();
});

afterAll(async () => {
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM pillars WHERE slug LIKE $1`,
    [`${runTag}-%`],
  );
  const pillarIds = rows.map((r) => r.id);
  if (pillarIds.length > 0) {
    await pool.query(
      `DELETE FROM interpretation_chunks WHERE pillar_id = ANY($1::int[])`,
      [pillarIds],
    );
    await pool.query(
      `DELETE FROM interpretations WHERE pillar_id = ANY($1::int[])`,
      [pillarIds],
    );
    await pool.query(
      `DELETE FROM source_chunks WHERE source_id IN
         (SELECT id FROM sources WHERE pillar_id = ANY($1::int[]))`,
      [pillarIds],
    );
    await pool.query(`DELETE FROM sources WHERE pillar_id = ANY($1::int[])`, [
      pillarIds,
    ]);
    await pool.query(`DELETE FROM pillars WHERE id = ANY($1::int[])`, [
      pillarIds,
    ]);
  }
  if (stewardId) {
    await pool.query(`DELETE FROM faculty_users WHERE id = $1`, [stewardId]);
  }
  await pool.end();
});

describe("cross-pillar crowd-out regression", () => {
  test("high-similarity source chunk survives multi-pillar fan-out against off-pillar interpretations", async () => {
    const result = await retrieve({
      question: "How much protein should I eat as I age?",
      pillarIds: fx.allPillarIds,
    });

    // The on-topic source chunk must be in the top-k — under the old
    // ×1.25 multiplicative weighting the six off-pillar interpretation
    // chunks (0.85 × 1.25 ≈ 1.06) would fill all six slots and evict it.
    const sourceHit = result.chunks.find(
      (c) => c.kind === "source" && c.chunkId === fx.nutritionChunkId,
    );
    expect(sourceHit).toBeDefined();
    expect(sourceHit!.pillarId).toBe(fx.nutritionPillarId);
    expect(sourceHit!.score).toBeCloseTo(SOURCE_COS, 2);

    // And it must RANK FIRST: an additive +0.02 bonus on a 0.85 raw
    // score (→ 0.87) may not outrank a 0.95 on-topic source chunk.
    expect(result.chunks[0].chunkId).toBe(fx.nutritionChunkId);
    expect(result.chunks[0].kind).toBe("source");

    // topScore is the raw (unweighted) score of the winner, well above
    // the coverage threshold — the fan-out answer stays COVERED.
    expect(result.topScore).toBeGreaterThan(RAG_MIN_SCORE);
    expect(result.topScore).toBeCloseTo(SOURCE_COS, 2);

    // The winning pillar shows up in provenance.
    const provenance = buildProvenance(result.chunks);
    const entry = provenance.find((p) => p.source_id === fx.nutritionSourceId);
    expect(entry).toBeDefined();
    expect(entry!.pillar_slug).toBe(`${runTag}-nutrition`);
  });

  test("interpretation bonus stays a tie-breaker: equal relevance still prefers the interpretation", async () => {
    // Sanity lock on the intended behavior: among comparably relevant
    // chunks the interpretation should still win (that is what the
    // +0.02 bonus is FOR). The off-pillar interps (0.85 + 0.02) must
    // outrank nothing on-topic here, so query only the off pillars.
    const result = await retrieve({
      question: "How much protein should I eat as I age?",
      pillarIds: fx.offPillarIds,
    });
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks[0].kind).toBe("interpretation");
    expect(result.chunks[0].weightedScore).toBeCloseTo(INTERP_COS + 0.02, 2);
  });

  test("coverage gating uses raw topScore: the additive bonus never flips covered/uncovered at the threshold edge", async () => {
    const result = await retrieve({
      question: "How much protein should I eat as I age?",
      pillarIds: [fx.boundaryPillarId],
    });

    expect(result.chunks.length).toBe(1);
    const chunk = result.chunks[0];
    expect(chunk.kind).toBe("interpretation");

    // Raw score sits just BELOW the threshold…
    expect(chunk.score).toBeLessThan(RAG_MIN_SCORE);
    expect(chunk.score).toBeCloseTo(BOUNDARY_COS, 2);
    // …while the weighted score (raw + 0.02) sits ABOVE it.
    expect(chunk.weightedScore).toBeGreaterThan(RAG_MIN_SCORE - EPS);
    expect(chunk.weightedScore).toBeCloseTo(BOUNDARY_COS + 0.02, 2);

    // The coverage gate reads `topScore`, which must be the RAW score —
    // so this pillar is (correctly) UNCOVERED. If a future change made
    // topScore reflect the weighted score, this assertion flips.
    expect(result.topScore).toBe(chunk.score);
    expect(result.topScore).toBeLessThan(RAG_MIN_SCORE);
  });
});
