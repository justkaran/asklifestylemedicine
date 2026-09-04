import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("../lib/embeddings.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/embeddings.js")>(
    "../lib/embeddings.js",
  );
  return {
    ...actual,
    embedTexts: vi.fn(async (texts: string[]) =>
      texts.map(() => {
        const vector = new Array(384).fill(0);
        vector[382] = 1;
        return vector;
      }),
    ),
  };
});

import pool from "../lib/db.js";
import { getCurrentKnowledgeVersion } from "../lib/knowledgeVersions.js";
import { clearEmbeddingCache, retrieve } from "../lib/rag.js";
import { EMBEDDING_MODEL, toVectorLiteral } from "../lib/embeddings.js";

const slug = `knowledge-version-test-${randomUUID().slice(0, 8)}`;
let pillarId: number;

beforeAll(async () => {
  // Test files import route helpers, not the app boot path; keep this tiny
  // additive provision local so the test remains valid on a fresh dev schema.
  await pool.query(`DO $$ BEGIN
    CREATE TYPE knowledge_relation_type AS ENUM ('supports','refines','qualifies','contradicts');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge_versions (
      id SERIAL PRIMARY KEY,
      pillar_id INTEGER NOT NULL REFERENCES pillars(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      label TEXT NOT NULL,
      snapshot JSONB NOT NULL,
      claim_count INTEGER NOT NULL DEFAULT 0,
      relation_count INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      published_by_user_id INTEGER REFERENCES faculty_users(id) ON DELETE SET NULL,
      published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT knowledge_versions_pillar_version_unique
        UNIQUE (pillar_id, version)
    )`);
  await pool.query(`DO $$ BEGIN
    CREATE TYPE knowledge_version_chunk_kind AS ENUM ('interpretation','source');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge_version_chunks (
      id SERIAL PRIMARY KEY,
      knowledge_version_id INTEGER NOT NULL REFERENCES knowledge_versions(id) ON DELETE CASCADE,
      kind knowledge_version_chunk_kind NOT NULL,
      source_id INTEGER NOT NULL,
      interpretation_id INTEGER,
      pillar_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      embedding halfvec NOT NULL,
      embedding_model TEXT NOT NULL,
      source_title TEXT NOT NULL,
      source_authors TEXT,
      source_year INTEGER,
      source_journal TEXT,
      source_doi TEXT,
      source_url TEXT,
      source_retention_status TEXT NOT NULL,
      source_study_design TEXT,
      source_reliability_rubric JSONB,
      pillar_slug TEXT NOT NULL,
      pillar_name TEXT NOT NULL,
      interpretation_author TEXT,
      interpretation_origin TEXT,
      interpretation_reviewer TEXT,
      advisor_lens_slug TEXT,
      advisor_lens_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  const created = await pool.query<{ id: number }>(
    `INSERT INTO pillars (slug, name) VALUES ($1, 'Knowledge version test')
     RETURNING id`,
    [slug],
  );
  pillarId = created.rows[0]!.id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM pillars WHERE id = $1`, [pillarId]);
});

beforeEach(() => {
  clearEmbeddingCache();
});

async function insertFrozenChunk(opts: {
  knowledgeVersionId: number;
  sourceId: number;
  text: string;
  kind?: "interpretation" | "source";
  interpretationId?: number;
}): Promise<void> {
  const vector = new Array(384).fill(0);
  vector[382] = 1;
  await pool.query(
    `INSERT INTO knowledge_version_chunks (
       knowledge_version_id, kind, source_id, interpretation_id, pillar_id, chunk_index, text,
       embedding, embedding_model, source_title, source_retention_status,
       pillar_slug, pillar_name
      ) VALUES ($1, $2, $3, $4, $5, 0, $6, $7::halfvec(384), $8,
        'Frozen study', 'retained_with_rights', $9, 'Knowledge version test')`,
    [
      opts.knowledgeVersionId,
      opts.kind ?? "source",
      opts.sourceId,
      opts.interpretationId ?? null,
      pillarId,
      opts.text,
      toVectorLiteral(vector),
      EMBEDDING_MODEL,
      slug,
    ],
  );
}

describe("getCurrentKnowledgeVersion", () => {
  test("rejects an incomplete snapshot until every claim has frozen retrieval material", async () => {
    await pool.query(
      `INSERT INTO knowledge_versions
        (pillar_id, version, label, snapshot, claim_count, relation_count)
       VALUES
        ($1, 1, 'v1', $2::jsonb, 1, 0),
        ($1, 2, 'v2', $3::jsonb, 2, 1)`,
      [
        pillarId,
        JSON.stringify({
          claims: [{ interpretationId: 101, source: { id: 201 } }],
          relationships: [],
        }),
        JSON.stringify({
          claims: [
            { interpretationId: 102, source: { id: 202 } },
            { interpretationId: 103, source: { id: 203 } },
          ],
          relationships: [
            {
              fromInterpretationId: 102,
              toInterpretationId: 103,
              relation: "supports",
            },
          ],
        }),
      ],
    );

    const { rows } = await pool.query<{ id: number }>(
      `SELECT id FROM knowledge_versions
       WHERE pillar_id = $1 AND version = 2`,
      [pillarId],
    );
    await insertFrozenChunk({
      knowledgeVersionId: rows[0]!.id,
      sourceId: 202,
      text: "Frozen v2 retrieval material.",
    });
    await expect(getCurrentKnowledgeVersion(pillarId)).resolves.toBeNull();
    await insertFrozenChunk({
      knowledgeVersionId: rows[0]!.id,
      sourceId: 202,
      interpretationId: 102,
      kind: "interpretation",
      text: "Frozen v2 claim 1.",
    });
    await insertFrozenChunk({
      knowledgeVersionId: rows[0]!.id,
      sourceId: 203,
      interpretationId: 103,
      kind: "interpretation",
      text: "Frozen v2 claim 2.",
    });
    await insertFrozenChunk({
      knowledgeVersionId: rows[0]!.id,
      sourceId: 203,
      text: "Frozen v2 source 2.",
    });
    await expect(getCurrentKnowledgeVersion(pillarId)).resolves.toEqual({
      id: expect.any(Number),
      version: 2,
      label: "v2",
    });
  });

  test("refuses a malformed snapshot instead of treating it as governed knowledge", async () => {
    const malformed = await pool.query<{ id: number }>(
      `INSERT INTO pillars (slug, name) VALUES ($1, 'Malformed version test')
       RETURNING id`,
      [`${slug}-malformed`],
    );
    const malformedPillarId = malformed.rows[0]!.id;
    try {
      await pool.query(
        `INSERT INTO knowledge_versions
          (pillar_id, version, label, snapshot, claim_count, relation_count)
         VALUES ($1, 1, 'broken', $2::jsonb, 0, 0)`,
        [malformedPillarId, JSON.stringify({ claims: [] })],
      );
      await expect(getCurrentKnowledgeVersion(malformedPillarId)).resolves.toBeNull();
    } finally {
      await pool.query(`DELETE FROM pillars WHERE id = $1`, [malformedPillarId]);
    }
  });

  test("retrieves frozen v1 evidence after the live source chunk is changed", async () => {
    const liveSource = await pool.query<{ id: number }>(
      `INSERT INTO sources (pillar_id, kind, title, status)
       VALUES ($1, 'note', 'Mutable live study', 'approved')
       RETURNING id`,
      [pillarId],
    );
    const sourceId = liveSource.rows[0]!.id;
    const vector = new Array(384).fill(0);
    vector[382] = 1;
    await pool.query(
      `INSERT INTO source_chunks
        (source_id, chunk_index, text, embedding, embedding_model)
       VALUES ($1, 0, 'Original live source wording.', $2::halfvec(384), $3)`,
      [sourceId, toVectorLiteral(vector), EMBEDDING_MODEL],
    );
    const published = await pool.query<{ id: number }>(
      `INSERT INTO knowledge_versions
        (pillar_id, version, label, snapshot, claim_count, relation_count)
       VALUES ($1, 3, 'v3', $2::jsonb, 1, 0)
       RETURNING id`,
      [
        pillarId,
        JSON.stringify({
          schema: 2,
          claims: [{ interpretationId: 500, source: { id: sourceId } }],
        }),
      ],
    );
    const versionId = published.rows[0]!.id;
    await insertFrozenChunk({
      knowledgeVersionId: versionId,
      sourceId,
      text: "Frozen evidence: late caffeine can delay sleep timing.",
    });
    await pool.query(
      `UPDATE source_chunks
          SET text = 'Later live edit that must not alter historical retrieval.'
        WHERE source_id = $1`,
      [sourceId],
    );

    const result = await retrieve({
      question: "Does caffeine delay sleep?",
      pillarIds: [pillarId],
      knowledgeVersionId: versionId,
    });
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.text).toBe(
      "Frozen evidence: late caffeine can delay sleep timing.",
    );
    expect(result.chunks[0]?.sourceId).toBe(sourceId);
  });
});
