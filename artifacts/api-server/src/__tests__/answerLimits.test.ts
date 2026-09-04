/**
 * Unit tests for lib/answerLimits — the amber limit notices derived from
 * existing signals (source count, near-threshold margin, pending steward
 * drafts). No new scoring: these assert the derivation rules only.
 */
import { beforeAll, afterAll, describe, test, expect } from "vitest";
import pool from "../lib/db.js";
import { ensureCaptureLoopSchema } from "./testHelpers.js";
import {
  computeAnswerLimits,
  FEW_SOURCES_MAX,
  NEAR_THRESHOLD_MARGIN,
} from "../lib/answerLimits.js";
import { RAG_MIN_SCORE } from "../lib/ragThreshold.js";
import type { ProvenanceEntry } from "../lib/rag.js";

const pillarSlug = `limits-test-${Date.now()}`;
let pillarId = 0;
let sourceId = 0;

function prov(overrides: Partial<ProvenanceEntry> = {}): ProvenanceEntry {
  return {
    source_id: sourceId,
    interpretation_id: null,
    chunk_ids: [1],
    title: "Sleep and circadian timing",
    authors: "Zeit, A.",
    year: 2020,
    journal: "J Sleep",
    doi: null,
    source_url: null,
    study_design: null,
    pillar_slug: pillarSlug,
    interpretation_author: null,
    excerpts: [],
    ...overrides,
  } as ProvenanceEntry;
}

beforeAll(async () => {
  await ensureCaptureLoopSchema();
  const { rows: p } = await pool.query<{ id: number }>(
    `INSERT INTO pillars (slug, name) VALUES ($1, $2) RETURNING id`,
    [pillarSlug, "Limits Test Pillar"],
  );
  pillarId = p[0].id;
  const { rows: s } = await pool.query<{ id: number }>(
    `INSERT INTO sources (pillar_id, kind, title)
     VALUES ($1, 'paper', 'Limits test source') RETURNING id`,
    [pillarId],
  );
  sourceId = s[0].id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM interpretations WHERE pillar_id = $1`, [
    pillarId,
  ]);
  await pool.query(`DELETE FROM sources WHERE pillar_id = $1`, [pillarId]);
  await pool.query(`DELETE FROM pillars WHERE id = $1`, [pillarId]);
});

const WELL_ABOVE = RAG_MIN_SCORE + NEAR_THRESHOLD_MARGIN + 0.05;

describe("computeAnswerLimits", () => {
  test("well-covered answer (many sources, high score) yields no notices", async () => {
    const provenance = Array.from({ length: FEW_SOURCES_MAX + 2 }, (_, i) =>
      prov({
        source_id: sourceId + i,
        title: `Distinct work ${i}`,
        authors: `Author ${i}`,
        year: 2000 + i,
      }),
    );
    const notices = await computeAnswerLimits({
      provenance,
      topScore: WELL_ABOVE,
      pillarIds: [pillarId],
    });
    expect(notices).toEqual([]);
  });

  test("few sources yields few_sources with the collapsed count", async () => {
    const notices = await computeAnswerLimits({
      provenance: [prov()],
      topScore: WELL_ABOVE,
      pillarIds: [],
    });
    expect(notices).toEqual([{ code: "few_sources", sourceCount: 1 }]);
  });

  test("chapter-split same work counts as ONE source (post-collapse)", async () => {
    // Same authors/year/journal, chapter-suffixed titles — one work.
    const provenance = [
      prov({ title: "The Book (Chapter 1)", chunk_ids: [1] }),
      prov({ source_id: sourceId + 1, title: "The Book (Chapter 2)", chunk_ids: [2] }),
    ];
    const notices = await computeAnswerLimits({
      provenance,
      topScore: WELL_ABOVE,
      pillarIds: [],
    });
    expect(notices).toEqual([{ code: "few_sources", sourceCount: 1 }]);
  });

  test("score just above threshold yields near_threshold; below margin edge does not", async () => {
    const manyProv = Array.from({ length: FEW_SOURCES_MAX + 2 }, (_, i) =>
      prov({
        source_id: sourceId + i,
        title: `Distinct work ${i}`,
        authors: `Author ${i}`,
        year: 2000 + i,
      }),
    );
    const near = await computeAnswerLimits({
      provenance: manyProv,
      topScore: RAG_MIN_SCORE + NEAR_THRESHOLD_MARGIN / 2,
      pillarIds: [],
    });
    expect(near).toEqual([{ code: "near_threshold" }]);

    const clear = await computeAnswerLimits({
      provenance: manyProv,
      topScore: RAG_MIN_SCORE + NEAR_THRESHOLD_MARGIN,
      pillarIds: [],
    });
    expect(clear).toEqual([]);
  });

  test("pending drafts attach ONLY alongside few_sources, scoped to the routed pillars", async () => {
    await pool.query(
      `INSERT INTO interpretations (pillar_id, source_id, answer, interpretation, status)
       VALUES ($1, $2, 'draft a', 'interp a', 'proposed'),
              ($1, $2, 'draft b', 'interp b', 'proposed'),
              ($1, $2, 'approved one', 'interp c', 'approved')`,
      [pillarId, sourceId],
    );

    // Few sources + pending drafts in the routed pillar → both notices.
    const withPending = await computeAnswerLimits({
      provenance: [prov()],
      topScore: WELL_ABOVE,
      pillarIds: [pillarId],
    });
    expect(withPending).toEqual([
      { code: "few_sources", sourceCount: 1 },
      { code: "pending_review", pendingCount: 2 },
    ]);

    // Same pillar, but the answer is NOT thin → pending stays silent
    // (a standalone pending notice would show on nearly every answer).
    const manyProv = Array.from({ length: FEW_SOURCES_MAX + 2 }, (_, i) =>
      prov({
        source_id: sourceId + i,
        title: `Distinct work ${i}`,
        authors: `Author ${i}`,
        year: 2000 + i,
      }),
    );
    const wellCovered = await computeAnswerLimits({
      provenance: manyProv,
      topScore: WELL_ABOVE,
      pillarIds: [pillarId],
    });
    expect(wellCovered).toEqual([]);
  });

  test("empty provenance yields no few_sources notice (boundary paths handle that)", async () => {
    const notices = await computeAnswerLimits({
      provenance: [],
      topScore: WELL_ABOVE,
      pillarIds: [pillarId],
    });
    expect(notices).toEqual([]);
  });
});
