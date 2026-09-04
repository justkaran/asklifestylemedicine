import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  test,
  expect,
  vi,
} from "vitest";
import { ensureCaptureLoopSchema } from "./testHelpers.js";

// Set env BEFORE the route/lib modules load — they read these once at
// module-init time. `vi.hoisted` is the only way to win the import race.
vi.hoisted(() => {
  process.env.RESEND_API_KEY = "stub-key";
});

// ─── Mocks (must be declared before importing the app) ─────────────────

// Toggleable Anthropic stub. The drafter calls `anthropic.messages.create`;
// other routes (sleep agent, etc.) use `messages.stream`. We provide both
// so importing the app doesn't crash, but only `create` matters here.
type AnthropicMode = "ok" | "throw" | "empty";
const anthropicState: { mode: AnthropicMode; calls: number } = {
  mode: "ok",
  calls: 0,
};

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      create: async () => {
        anthropicState.calls++;
        if (anthropicState.mode === "throw") {
          throw new Error("anthropic boom (test stub)");
        }
        if (anthropicState.mode === "empty") {
          return { content: [{ type: "text", text: "" }] };
        }
        return {
          content: [{ type: "text", text: "Stub draft answer body." }],
        };
      },
      stream: () => {
        async function* gen() {
          yield {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "ANSWER:\nstub\n" },
          };
        }
        return gen();
      },
    };
  }
  return { default: FakeAnthropic };
});

// Deterministic embedding axis: any text mentioning circadian/melatonin/light
// lands on axis 10 — so the seeded source chunk and the test question land on
// the same axis and clear cosine distance ordering trivially. Other text
// goes on axis 20 so it can't accidentally match.
function makeEmbedding(text: string): number[] {
  const v = new Array(384).fill(0);
  if (/circadian|melatonin|light/i.test(text)) {
    v[10] = 1;
  } else {
    v[20] = 1;
  }
  return v;
}

vi.mock("../lib/embeddings.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/embeddings.js")>(
      "../lib/embeddings.js",
    );
  return {
    ...actual,
    embedTexts: vi.fn(async (texts: string[]) => texts.map(makeEmbedding)),
  };
});

// Bypass Clerk by stubbing the faculty auth middleware. The pillar-role
// middleware is left untouched so we still exercise its membership check.
let stubFacultyUserId = 0;
vi.mock("../middlewares/facultyAuth.js", async () => {
  const actual =
    await vi.importActual<typeof import("../middlewares/facultyAuth.js")>(
      "../middlewares/facultyAuth.js",
    );
  const { db, facultyUsersTable, facultyMembershipsTable } = await import(
    "@workspace/db"
  );
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
import {
  AI_DRAFT_PREFIX,
  fetchTopSourceChunks,
  generateInterpretationDraft,
} from "../lib/draftInterpretation.js";
import { clearEmbeddingCache, retrieve } from "../lib/rag.js";
import { toVectorLiteral } from "../lib/embeddings.js";

let app: Express;
let pillarId = 0;
let sourceWithChunksId = 0;
let sourceNoChunksId = 0;
let clusterId = 0;
const pillarSlug = `draft-test-${Date.now()}`;
const stewardEmail = `draft-steward-${Date.now()}@test.local`;

beforeAll(async () => {
  await ensureCaptureLoopSchema();

  const { rows: pRows } = await pool.query<{ id: number }>(
    `INSERT INTO pillars (slug, name) VALUES ($1, $2) RETURNING id`,
    [pillarSlug, "Draft Test Pillar"],
  );
  pillarId = pRows[0].id;

  const { rows: uRows } = await pool.query<{ id: number }>(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [`draft-clerk-${Date.now()}`, stewardEmail, "Draft Test Steward"],
  );
  stubFacultyUserId = uRows[0].id;

  await pool.query(
    `INSERT INTO faculty_memberships (user_id, pillar_id, role)
     VALUES ($1, $2, 'steward')`,
    [stubFacultyUserId, pillarId],
  );

  // Source A — has one embedded chunk on the circadian axis.
  const { rows: s1 } = await pool.query<{ id: number }>(
    `INSERT INTO sources
       (pillar_id, kind, title, rights_basis, retention_status)
      VALUES ($1, 'paper', 'Source w/ chunks', 'permission', 'retained_with_rights')
      RETURNING id`,
    [pillarId],
  );
  sourceWithChunksId = s1[0].id;
  const chunkText =
    "Dim evening light suppresses melatonin and shifts the circadian clock later.";
  const chunkEmbeddingLit = `[${makeEmbedding(chunkText).join(",")}]`;
  await pool.query(
    `INSERT INTO source_chunks
       (source_id, chunk_index, text, embedding, embedding_model)
     VALUES ($1, 0, $2, $3::halfvec(384), 'Xenova/gte-small')`,
    [sourceWithChunksId, chunkText, chunkEmbeddingLit],
  );

  // Source B — exists, but no embedded chunks. Drives the empty-draft and
  // /redraft 422 paths.
  const { rows: s2 } = await pool.query<{ id: number }>(
    `INSERT INTO sources
       (pillar_id, kind, title, rights_basis, retention_status)
      VALUES ($1, 'paper', 'Source no chunks', 'permission', 'retained_with_rights')
      RETURNING id`,
    [pillarId],
  );
  sourceNoChunksId = s2[0].id;

  // Cluster the /promote route can hang an interpretation off.
  const repQuestion = "How does evening light affect circadian rhythm?";
  const repEmbeddingLit = `[${makeEmbedding(repQuestion).join(",")}]`;
  const { rows: cRows } = await pool.query<{ id: number }>(
    `INSERT INTO query_clusters
       (pillar_id, representative_question, representative_embedding,
        embedding_model, size)
     VALUES ($1, $2, $3::halfvec(384), 'Xenova/gte-small', 3)
     RETURNING id`,
    [pillarId, repQuestion, repEmbeddingLit],
  );
  clusterId = cRows[0].id;

  app = (await import("../app.js")).default;
});

afterAll(async () => {
  if (pillarId) {
    await pool.query(`DELETE FROM interpretation_chunks WHERE pillar_id = $1`, [
      pillarId,
    ]);
    await pool.query(`DELETE FROM interpretations WHERE pillar_id = $1`, [
      pillarId,
    ]);
    await pool.query(
      `DELETE FROM source_chunks
        WHERE source_id IN (SELECT id FROM sources WHERE pillar_id = $1)`,
      [pillarId],
    );
    await pool.query(`DELETE FROM sources WHERE pillar_id = $1`, [pillarId]);
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
  await pool.end();
});

beforeEach(() => {
  anthropicState.mode = "ok";
  anthropicState.calls = 0;
});

describe("generateInterpretationDraft", () => {
  test("returns empty draft when source has no embedded chunks", async () => {
    const r = await generateInterpretationDraft({
      sourceId: sourceNoChunksId,
      question: "How does evening light affect circadian rhythm?",
    });
    expect(r.draft).toBe("");
    expect(r.usedChunks).toBe(0);
    expect(r.chunks).toEqual([]);
    // Critical: we must NOT spend a Claude call when we have no chunks
    // to ground the draft in.
    expect(anthropicState.calls).toBe(0);
  });

  test("prepends AI_DRAFT_PREFIX when Claude returns text", async () => {
    const r = await generateInterpretationDraft({
      sourceId: sourceWithChunksId,
      question: "How does evening light affect circadian rhythm?",
    });
    expect(r.usedChunks).toBeGreaterThan(0);
    expect(r.chunks.length).toBeGreaterThan(0);
    expect(r.draft.startsWith(AI_DRAFT_PREFIX)).toBe(true);
    expect(r.draft.slice(AI_DRAFT_PREFIX.length)).toBe(
      "Stub draft answer body.",
    );
    expect(anthropicState.calls).toBe(1);
  });
});

describe("/promote interpretation seeding", () => {
  test("falls back to placeholder seed when the drafter throws", async () => {
    anthropicState.mode = "throw";
    const res = await request(app)
      .post(
        `/api/faculty/pillars/${pillarSlug}/clusters/${clusterId}/promote`,
      )
      .send({ sourceId: sourceWithChunksId });

    expect(res.status).toBe(201);
    const interpretationId: number = res.body.interpretationId;
    expect(interpretationId).toBeTruthy();

    const { rows } = await pool.query<{
      interpretation: string;
      ai_draft: string | null;
    }>(`SELECT interpretation, ai_draft FROM interpretations WHERE id = $1`, [
      interpretationId,
    ]);
    expect(rows.length).toBe(1);
    // Drafter threw → we must store NULL for ai_draft so the approval
    // scorer correctly buckets this as `no_draft` rather than scoring
    // the steward against a draft that never existed.
    expect(rows[0].ai_draft).toBeNull();
    // And the body must be the human-readable placeholder seed, not
    // the AI-prefixed banner.
    expect(rows[0].interpretation).not.toContain(AI_DRAFT_PREFIX);
    expect(rows[0].interpretation).toMatch(
      /Replace this with the Stanford-grounded interpretation/,
    );
  });
});

describe("/redraft", () => {
  test("allows a private redraft and passage review while a legacy rights record is pending", async () => {
    await pool.query(
      `UPDATE sources
          SET rights_basis = NULL, retention_status = 'needs_review'
        WHERE id = $1`,
      [sourceWithChunksId],
    );
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO interpretations
         (source_id, pillar_id, author_id, status, answer, interpretation)
       VALUES ($1, $2, $3, 'proposed', $4, $5)
       RETURNING id`,
      [
        sourceWithChunksId,
        pillarId,
        stubFacultyUserId,
        "How does evening light affect circadian rhythm?",
        "seed body",
      ],
    );
    const id = rows[0].id;
    try {
      const redraft = await request(app)
        .post(`/api/faculty/interpretations/${id}/redraft`)
        .send({});
      expect(redraft.status).toBe(200);
      expect(redraft.body.usedChunks).toBeGreaterThan(0);

      const passages = await request(app).get(
        `/api/faculty/interpretations/${id}/source-chunks`,
      );
      expect(passages.status).toBe(200);
      expect(passages.body.chunks).toHaveLength(1);
    } finally {
      await pool.query(
        `UPDATE sources
            SET rights_basis = 'permission', retention_status = 'retained_with_rights'
          WHERE id = $1`,
        [sourceWithChunksId],
      );
    }
  });

  test("returns 422 when no source chunks match the question", async () => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO interpretations
         (source_id, pillar_id, author_id, status, answer, interpretation)
       VALUES ($1, $2, $3, 'proposed', $4, $5)
       RETURNING id`,
      [
        sourceNoChunksId,
        pillarId,
        stubFacultyUserId,
        "How does evening light affect circadian rhythm?",
        "seed body",
      ],
    );
    const id = rows[0].id;

    const res = await request(app)
      .post(`/api/faculty/interpretations/${id}/redraft`)
      .send({});
    expect(res.status).toBe(422);
    expect(String(res.body.error)).toMatch(/No source chunks/i);
    // We must not have spent a Claude call when there were no chunks
    // to ground the redraft in.
    expect(anthropicState.calls).toBe(0);
  });

  test("returns 409 when the interpretation isn't proposed", async () => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO interpretations
         (source_id, pillar_id, author_id, status, answer, interpretation,
          approver_id, approved_at)
       VALUES ($1, $2, $3, 'approved', $4, $5, $3, NOW())
       RETURNING id`,
      [
        sourceWithChunksId,
        pillarId,
        stubFacultyUserId,
        "How does evening light affect circadian rhythm?",
        "approved body",
      ],
    );
    const id = rows[0].id;

    const res = await request(app)
      .post(`/api/faculty/interpretations/${id}/redraft`)
      .send({});
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toMatch(/Cannot redraft/i);
    expect(anthropicState.calls).toBe(0);
  });
});

describe("rights-aware paper ingestion", () => {
  test("creates an AI first draft, purges no-rights material after approval, and starts a clean re-upload review window", async () => {
    const doi = `10.1000/rights-${Date.now()}`;
    const originalText =
      "Circadian light timing can affect melatonin. This is a private review passage.";
    const uploaded = await request(app)
      .post(`/api/faculty/pillars/${pillarSlug}/sources`)
      .send({
        kind: "paper",
        title: "Rights-aware circadian paper",
        doi,
        sourceUrl: "https://example.test/rights-aware-paper",
        text: originalText,
        rightsBasis: "no_documented_full_text_rights",
      });

    expect(uploaded.status).toBe(201);
    expect(uploaded.body.firstDraftId).toBeTruthy();
    const sourceId = Number(uploaded.body.id);
    const interpretationId = Number(uploaded.body.firstDraftId);

    const { rows: before } = await pool.query<{
      full_text: string | null;
      retention_status: string;
      rights_basis: string;
      origin: string;
      author_id: number | null;
      ai_draft: string | null;
    }>(
      `SELECT s.full_text, s.retention_status, s.rights_basis,
              i.origin, i.author_id, i.ai_draft
         FROM sources s JOIN interpretations i ON i.id = $2
        WHERE s.id = $1`,
      [sourceId, interpretationId],
    );
    expect(before[0]).toMatchObject({
      full_text: originalText,
      retention_status: "review_window",
      rights_basis: "no_documented_full_text_rights",
      origin: "palonur_ai",
      author_id: null,
    });
    expect(before[0].ai_draft).toBe("Stub draft answer body.");

    // Approval is the steward's decision; the row continues to identify the
    // original creator as Palonur/AI rather than rewriting authorship.
    const approveInterpretation = await request(app)
      .post(`/api/faculty/interpretations/${interpretationId}/transition`)
      .send({ status: "approved" });
    expect(approveInterpretation.status).toBe(200);

    const approveSource = await request(app)
      .post(`/api/faculty/pillars/${pillarSlug}/sources/${sourceId}/transition`)
      .send({ status: "approved" });
    expect(approveSource.status).toBe(200);
    expect(approveSource.body).toMatchObject({
      purged: true,
      retentionStatus: "purged_no_full_text_rights",
    });

    const { rows: purged } = await pool.query<{
      full_text: string | null;
      abstract: string | null;
      content_hash: string | null;
      retention_status: string;
      source_url: string | null;
      ai_draft: string | null;
      origin: string;
    }>(
      `SELECT s.full_text, s.abstract, s.content_hash, s.retention_status,
              s.source_url, i.ai_draft, i.origin
         FROM sources s JOIN interpretations i ON i.source_id = s.id
        WHERE s.id = $1 AND i.status = 'approved'`,
      [sourceId],
    );
    expect(purged[0]).toMatchObject({
      full_text: null,
      abstract: null,
      content_hash: null,
      retention_status: "purged_no_full_text_rights",
      source_url: "https://example.test/rights-aware-paper",
      ai_draft: null,
      origin: "palonur_ai",
    });
    const { rows: counts } = await pool.query<{
      raw_chunks: number;
      snapshots: number;
      purge_events: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM source_chunks WHERE source_id = $1) AS raw_chunks,
         (SELECT count(*)::int FROM source_versions WHERE source_id = $1) AS snapshots,
         (SELECT count(*)::int FROM source_audit_log
            WHERE source_id = $1 AND action = 'rights_purge') AS purge_events`,
      [sourceId],
    );
    expect(counts[0]).toMatchObject({
      raw_chunks: 0,
      snapshots: 0,
      purge_events: 1,
    });

    // Belt-and-suspenders retrieval rule: even a stale raw chunk inserted by a
    // failed old worker must not be eligible once the no-rights source is purged.
    const staleText = "Circadian light raw paper text that must not be retrieved.";
    const vec = toVectorLiteral(makeEmbedding(staleText));
    await pool.query(
      `INSERT INTO source_chunks
         (source_id, chunk_index, text, embedding, embedding_model)
       VALUES ($1, 999, $2, $3::halfvec(384), 'Xenova/gte-small')`,
      [sourceId, staleText, vec],
    );
    expect(
      await fetchTopSourceChunks({
        sourceId,
        question: "circadian light and melatonin",
      }),
    ).toEqual([]);
    const staleDetail = await request(app).get(
      `/api/faculty/pillars/${pillarSlug}/sources/${sourceId}`,
    );
    expect(staleDetail.status).toBe(200);
    expect(staleDetail.body).toMatchObject({
      chunkCount: 0,
      chunks: [],
      reviewPassagesAvailable: false,
      source: { fullText: null },
    });
    clearEmbeddingCache();
    const retrieved = await retrieve({
      question: "circadian light and melatonin",
      pillarIds: [pillarId],
      k: 12,
    });
    expect(
      retrieved.chunks.some(
        (chunk) => chunk.sourceId === sourceId && chunk.kind === "source",
      ),
    ).toBe(false);
    const suggestions = await request(app).get(
      `/api/faculty/pillars/${pillarSlug}/clusters/${clusterId}/source-suggestions`,
    );
    expect(suggestions.status).toBe(200);
    expect(suggestions.body.suggestions).not.toContainEqual(
      expect.objectContaining({ sourceId }),
    );
    expect(
      retrieved.chunks.some(
        (chunk) =>
          chunk.sourceId === sourceId && chunk.kind === "interpretation",
      ),
    ).toBe(true);

    // Re-uploading the same paper opens a fresh, temporary review window and
    // creates another private first draft without recreating a historical text
    // snapshot of the already-purged version.
    const reuploaded = await request(app)
      .post(`/api/faculty/pillars/${pillarSlug}/sources`)
      .send({
        kind: "paper",
        title: "Rights-aware circadian paper",
        doi,
        sourceUrl: "https://example.test/rights-aware-paper",
        text: "Circadian light timing review window two.",
        rightsBasis: "no_documented_full_text_rights",
      });
    expect(reuploaded.status).toBe(201);
    expect(reuploaded.body.versioned).toBe(true);
    expect(reuploaded.body.firstDraftId).toBeTruthy();
    const { rows: reuploadState } = await pool.query<{
      retention_status: string;
      full_text: string | null;
      snapshots: number;
    }>(
      `SELECT s.retention_status, s.full_text,
              (SELECT count(*)::int FROM source_versions WHERE source_id = s.id) AS snapshots
         FROM sources s WHERE s.id = $1`,
      [sourceId],
    );
    expect(reuploadState[0]).toMatchObject({
      retention_status: "review_window",
      full_text: "Circadian light timing review window two.",
      snapshots: 0,
    });

    // Existing archived sources are also final records: selecting no-rights
    // on the conversion control must purge them, not leave a hidden raw copy.
    const { rows: archivedRows } = await pool.query<{ id: number }>(
      `INSERT INTO sources
         (pillar_id, kind, title, status, full_text, retention_status)
       VALUES ($1, 'paper', 'Archived rights conversion', 'archived',
               'Archived paper text to purge.', 'needs_review')
       RETURNING id`,
      [pillarId],
    );
    const archivedId = archivedRows[0].id;
    await pool.query(
      `INSERT INTO source_chunks
         (source_id, chunk_index, text, embedding, embedding_model)
       VALUES ($1, 0, 'Archived raw paper chunk.', $2::halfvec(384), 'Xenova/gte-small')`,
      [archivedId, toVectorLiteral(makeEmbedding("Archived raw paper chunk."))],
    );
    const converted = await request(app)
      .patch(`/api/faculty/pillars/${pillarSlug}/sources/${archivedId}/rights`)
      .send({ rightsBasis: "no_documented_full_text_rights" });
    expect(converted.status).toBe(200);
    expect(converted.body).toMatchObject({
      purged: true,
      retentionStatus: "purged_no_full_text_rights",
    });
    const { rows: archivedPurge } = await pool.query<{
      full_text: string | null;
      chunks: number;
    }>(
      `SELECT s.full_text,
              (SELECT count(*)::int FROM source_chunks WHERE source_id = s.id) AS chunks
         FROM sources s WHERE s.id = $1`,
      [archivedId],
    );
    expect(archivedPurge[0]).toMatchObject({ full_text: null, chunks: 0 });
  });
});
