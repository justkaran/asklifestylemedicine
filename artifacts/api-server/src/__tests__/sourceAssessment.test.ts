import { afterAll, beforeAll, describe, test, expect, vi } from "vitest";
import {
  ensureCaptureLoopSchema,
  makeTopicEmbedding,
} from "./testHelpers.js";
import {
  normalizeRubric,
  scoreRubric,
  type ReliabilityRubric,
} from "@workspace/db/source-rigor";

vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-assessment-secret";
});

// Acts as whichever signed-in member each test selects.
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

// The AI draft scorer is stubbed so POST /assessment/draft is deterministic.
// `stubDraft = null` simulates the integration being unavailable.
let stubDraft: ReliabilityRubric | null = null;
// Lets the batch-draft route believe the AI scorer is configured (env-less in
// tests). Flip to false to exercise the "AI unavailable" branch.
let aiConfigured = true;
vi.mock("../lib/scoreSource.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/scoreSource.js")>(
      "../lib/scoreSource.js",
    );
  return {
    ...actual,
    generateSourceAssessmentDraft: vi.fn(async () =>
      stubDraft ? { rubric: stubDraft } : null,
    ),
    isAssessmentAiConfigured: vi.fn(() => aiConfigured),
  };
});

// Deterministic embeddings so the seeded chunk clears the retrieval threshold.
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

import type { Express } from "express";
import request from "supertest";
import pool from "../lib/db.js";
import { toVectorLiteral } from "../lib/embeddings.js";
import {
  retrieve,
  buildProvenance,
  clearEmbeddingCache,
} from "../lib/rag.js";
import {
  findUnassessedApprovedSources,
  runPillarAssessmentDrafts,
} from "../lib/batchAssessSources.js";

let app: Express;

const stamp = Date.now();
let pillarSlug = "";
let pillarId = 0;
let stewardId = 0;
let contributorId = 0;
let viewerId = 0;
let sourceId = 0;

// A rubric with a known score per axis:
//   rigor:           yes(1) + no(0) over 2 assessed  -> 50
//   reproducibility: yes(1) over 1 assessed          -> 100
//   openness:        partial(0.5) over 1 assessed    -> 50
const KNOWN_DRAFT: ReliabilityRubric = normalizeRubric({
  rigor: {
    items: [
      { id: "sample_power", answer: "yes", rationale: "n=200, powered" },
      { id: "bias_control", answer: "no", rationale: "no blinding" },
    ],
  },
  reproducibility: {
    items: [{ id: "data_available", answer: "yes", rationale: "on OSF" }],
  },
  openness: {
    items: [{ id: "open_access", answer: "partial", rationale: "green OA" }],
  },
});

const assessmentUrl = (sid: number) =>
  `/api/faculty/pillars/${pillarSlug}/sources/${sid}/assessment`;

beforeAll(async () => {
  await ensureCaptureLoopSchema();

  pillarSlug = `asm-${stamp}`;
  const { rows: pRows } = await pool.query<{ id: number }>(
    `INSERT INTO pillars (slug, name) VALUES ($1,$2) RETURNING id`,
    [pillarSlug, "Assessment Pillar"],
  );
  pillarId = pRows[0].id;

  const { rows: uRows } = await pool.query<{ id: number }>(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name)
     VALUES ($1,$2,$3),($4,$5,$6),($7,$8,$9) RETURNING id`,
    [
      `asm-steward-clerk-${stamp}`,
      `asm-steward-${stamp}@test.local`,
      "Asm Steward",
      `asm-contrib-clerk-${stamp}`,
      `asm-contrib-${stamp}@test.local`,
      "Asm Contributor",
      `asm-viewer-clerk-${stamp}`,
      `asm-viewer-${stamp}@test.local`,
      "Asm Viewer",
    ],
  );
  stewardId = uRows[0].id;
  contributorId = uRows[1].id;
  viewerId = uRows[2].id;

  await pool.query(
    `INSERT INTO faculty_memberships (user_id, pillar_id, role)
     VALUES ($1,$2,'steward'),($3,$4,'contributor'),($5,$6,'viewer')`,
    [stewardId, pillarId, contributorId, pillarId, viewerId, pillarId],
  );

  const { rows: sRows } = await pool.query<{ id: number }>(
    `INSERT INTO sources (pillar_id, kind, title, authors, year, journal,
        status, uploaded_by_user_id)
     VALUES ($1,'paper',$2,'Zeitzer JM et al.',2000,'J Physiol','approved',$3)
     RETURNING id`,
    [pillarId, `Circadian light paper ${stamp}`, stewardId],
  );
  sourceId = sRows[0].id;

  // An approved interpretation + chunk so retrieve() returns the source and
  // we can prove the assessment gating on the consumer retrieval path.
  const { rows: iRows } = await pool.query<{ id: number }>(
    `INSERT INTO interpretations
        (source_id, pillar_id, author_id, status, answer, interpretation,
         approver_id, approved_at)
       VALUES ($1,$2,$3,'approved',
               'Dim evening light suppresses melatonin.',
               'Keep evenings dim to protect your circadian clock.',
               $3, NOW())
       RETURNING id`,
    [sourceId, pillarId, stewardId],
  );
  const interpretationId = iRows[0].id;

  const chunkText =
    "Dim evening light suppresses melatonin and shifts the circadian clock.";
  const vec = toVectorLiteral(makeTopicEmbedding(chunkText));
  await pool.query(
    `INSERT INTO interpretation_chunks
        (interpretation_id, source_id, pillar_id, chunk_index, text,
         embedding, embedding_model, priority)
       VALUES ($1,$2,$3,0,$4,$5::halfvec(384),'Xenova/gte-small',100)`,
    [interpretationId, sourceId, pillarId, chunkText, vec],
  );

  clearEmbeddingCache();
  app = (await import("../app.js")).default;
});

afterAll(async () => {
  await pool.query(
    `
    WITH tp AS (SELECT id FROM pillars WHERE slug = $1),
         ts AS (SELECT id FROM sources WHERE pillar_id IN (SELECT id FROM tp)),
         d0 AS (DELETE FROM interpretation_chunks WHERE pillar_id IN (SELECT id FROM tp)),
         d1 AS (DELETE FROM interpretations WHERE pillar_id IN (SELECT id FROM tp)),
         d2 AS (DELETE FROM source_audit_log WHERE source_id IN (SELECT id FROM ts)),
         d3 AS (DELETE FROM source_chunks WHERE source_id IN (SELECT id FROM ts)),
         d4 AS (DELETE FROM sources WHERE id IN (SELECT id FROM ts)),
         d5 AS (DELETE FROM faculty_memberships WHERE pillar_id IN (SELECT id FROM tp)),
         d6 AS (DELETE FROM faculty_users WHERE email LIKE $2)
    DELETE FROM pillars WHERE id IN (SELECT id FROM tp)
  `,
    [pillarSlug, `asm-%-${stamp}@test.local`],
  );
});

describe("canary sources are invisible to steward direct-ID endpoints", () => {
  test("detail, assessment, and transition 404 a canary source", async () => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO sources (pillar_id, kind, title, status, is_canary,
          uploaded_by_user_id)
       VALUES ($1,'note',$2,'approved',TRUE,$3) RETURNING id`,
      [pillarId, `Canary decoy ${stamp}`, stewardId],
    );
    const canaryId = rows[0].id;
    try {
      stubFacultyUserId = stewardId;
      const detail = await request(app).get(
        `/api/faculty/pillars/${pillarSlug}/sources/${canaryId}`,
      );
      expect(detail.status).toBe(404);
      const assess = await request(app).get(assessmentUrl(canaryId));
      expect(assess.status).toBe(404);
      const transition = await request(app)
        .post(
          `/api/faculty/pillars/${pillarSlug}/sources/${canaryId}/transition`,
        )
        .send({ status: "archived" });
      expect(transition.status).toBe(404);
    } finally {
      await pool.query(`DELETE FROM sources WHERE id = $1`, [canaryId]);
    }
  });
});

describe("source reliability assessment — governance", () => {
  test("starts unassessed; any member can read, only steward can edit", async () => {
    stubFacultyUserId = viewerId;
    const res = await request(app).get(assessmentUrl(sourceId));
    expect(res.status).toBe(200);
    expect(res.body.assessmentStatus).toBeNull();
    expect(res.body.rubric).toBeNull();
    expect(res.body.scores).toBeNull();
    expect(res.body.canEdit).toBe(false);

    stubFacultyUserId = stewardId;
    const stewardRes = await request(app).get(assessmentUrl(sourceId));
    expect(stewardRes.body.canEdit).toBe(true);
  });

  test("a contributor cannot generate a draft (403)", async () => {
    stubFacultyUserId = contributorId;
    stubDraft = KNOWN_DRAFT;
    const res = await request(app).post(`${assessmentUrl(sourceId)}/draft`);
    expect(res.status).toBe(403);
  });

  test("steward generates an AI draft; status becomes draft, scores recomputed", async () => {
    stubFacultyUserId = stewardId;
    stubDraft = KNOWN_DRAFT;
    const res = await request(app).post(`${assessmentUrl(sourceId)}/draft`);
    expect(res.status).toBe(200);
    expect(res.body.generated).toBe(true);
    expect(res.body.assessmentStatus).toBe("draft");
    expect(res.body.scores.rigor.score).toBe(50);
    expect(res.body.scores.reproducibility.score).toBe(100);
    expect(res.body.scores.openness.score).toBe(50);
    // The AI baseline is frozen for the acceptance comparison at approval.
    expect(res.body.aiDraft).not.toBeNull();
    // A fresh draft is never auto-approved.
    expect(res.body.assessedAt).toBeNull();

    const { rows } = await pool.query<{
      assessment_status: string | null;
      rigor_score: number | null;
    }>(`SELECT assessment_status, rigor_score FROM sources WHERE id = $1`, [
      sourceId,
    ]);
    expect(rows[0].assessment_status).toBe("draft");
    expect(rows[0].rigor_score).toBe(50);
  });

  test("draft degrades cleanly when the AI is unavailable", async () => {
    // Use a second, untouched source so we observe the no-op cleanly.
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO sources (pillar_id, kind, title, status, uploaded_by_user_id)
       VALUES ($1,'paper',$2,'approved',$3) RETURNING id`,
      [pillarId, `Unscored paper ${stamp}`, stewardId],
    );
    const otherId = rows[0].id;
    stubFacultyUserId = stewardId;
    stubDraft = null;
    const res = await request(app).post(`${assessmentUrl(otherId)}/draft`);
    expect(res.status).toBe(200);
    expect(res.body.generated).toBe(false);
    expect(res.body.assessmentStatus).toBeNull();
  });

  test("steward recalculates a SINGLE axis, preserving the other two", async () => {
    // Dedicated source so we never collide with the shared sourceId state.
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO sources (pillar_id, kind, title, status, uploaded_by_user_id)
       VALUES ($1,'paper',$2,'approved',$3) RETURNING id`,
      [pillarId, `Per-axis recalc paper ${stamp}`, stewardId],
    );
    const sid = rows[0].id;
    stubFacultyUserId = stewardId;

    // 1) Full AI draft: rigor 50, reproducibility 100, openness 50.
    stubDraft = KNOWN_DRAFT;
    const full = await request(app).post(`${assessmentUrl(sid)}/draft`);
    expect(full.status).toBe(200);
    expect(full.body.scores.reproducibility.score).toBe(100);

    // 2) Recalc ONLY reproducibility with a different AI result (repro -> 0).
    //    The AI also "changes its mind" about rigor/openness, but those axes
    //    must NOT move because we only asked for reproducibility.
    stubDraft = normalizeRubric({
      rigor: {
        items: [
          { id: "sample_power", answer: "yes", rationale: "x" },
          { id: "bias_control", answer: "yes", rationale: "x" },
        ],
      },
      reproducibility: {
        items: [{ id: "data_available", answer: "no", rationale: "none" }],
      },
      openness: {
        items: [{ id: "open_access", answer: "no", rationale: "paywalled" }],
      },
    });
    const res = await request(app)
      .post(`${assessmentUrl(sid)}/draft`)
      .send({ axis: "reproducibility" });
    expect(res.status).toBe(200);
    expect(res.body.generated).toBe(true);
    expect(res.body.axis).toBe("reproducibility");
    expect(res.body.assessmentStatus).toBe("draft");
    // Only reproducibility took the new AI answer.
    expect(res.body.scores.reproducibility.score).toBe(0);
    // Rigor + openness are preserved from the original full draft (50 / 50),
    // NOT overwritten by the second draft's 100 / 0.
    expect(res.body.scores.rigor.score).toBe(50);
    expect(res.body.scores.openness.score).toBe(50);
    // The AI baseline (assessmentAiDraft, used to score acceptance at approval)
    // is merged the same way: only its reproducibility axis moved.
    const aiScores = scoreRubric(normalizeRubric(res.body.aiDraft));
    expect(aiScores.reproducibility.score).toBe(0);
    expect(aiScores.rigor.score).toBe(50);
    expect(aiScores.openness.score).toBe(50);
  });

  test("single-axis recalc un-publishes an APPROVED assessment", async () => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO sources (pillar_id, kind, title, status, uploaded_by_user_id)
       VALUES ($1,'paper',$2,'approved',$3) RETURNING id`,
      [pillarId, `Per-axis unpublish paper ${stamp}`, stewardId],
    );
    const sid = rows[0].id;
    stubFacultyUserId = stewardId;

    // Draft, then PUBLISH (approve) so we have an approval stamp to clear.
    stubDraft = KNOWN_DRAFT;
    await request(app).post(`${assessmentUrl(sid)}/draft`);
    const approved = await request(app)
      .put(assessmentUrl(sid))
      .send({ rubric: KNOWN_DRAFT, status: "approved" });
    expect(approved.body.assessmentStatus).toBe("approved");
    expect(approved.body.assessedAt).not.toBeNull();

    // Recalculating a single axis must pull the whole assessment back to draft
    // and clear the approval stamp (no stale public badge).
    const res = await request(app)
      .post(`${assessmentUrl(sid)}/draft`)
      .send({ axis: "openness" });
    expect(res.status).toBe(200);
    expect(res.body.assessmentStatus).toBe("draft");
    expect(res.body.assessedAt).toBeNull();
    expect(res.body.assessedByName).toBeNull();
    expect(res.body.aiAcceptance).toBeNull();
  });

  test("a contributor cannot recalculate a single axis (403)", async () => {
    stubFacultyUserId = contributorId;
    stubDraft = KNOWN_DRAFT;
    const res = await request(app)
      .post(`${assessmentUrl(sourceId)}/draft`)
      .send({ axis: "rigor" });
    expect(res.status).toBe(403);
  });

  test("steward approval recomputes scores server-side and ignores client numbers", async () => {
    stubFacultyUserId = stewardId;
    // Client tries to smuggle a perfect score via a bogus extra field AND by
    // flipping the rigor 'no' to 'yes' is legitimate editing; but a fabricated
    // top-level score must never be trusted — only the item answers count.
    const editedRubric = normalizeRubric({
      ...KNOWN_DRAFT,
      // bogus injected score field the server must ignore
      rigorScore: 100,
    });
    const res = await request(app)
      .put(assessmentUrl(sourceId))
      .send({ rubric: { ...editedRubric, rigorScore: 100 }, status: "approved" });
    expect(res.status).toBe(200);
    expect(res.body.assessmentStatus).toBe("approved");
    // Recomputed from the (unchanged) item answers, NOT the injected 100.
    expect(res.body.scores.rigor.score).toBe(50);
    expect(res.body.assessedAt).not.toBeNull();
    expect(res.body.assessedByName).toBe("Asm Steward");
    expect(res.body.aiAcceptance).toBeTruthy();

    const { rows } = await pool.query<{
      assessment_status: string | null;
      assessed_by_user_id: number | null;
    }>(
      `SELECT assessment_status, assessed_by_user_id FROM sources WHERE id = $1`,
      [sourceId],
    );
    expect(rows[0].assessment_status).toBe("approved");
    expect(rows[0].assessed_by_user_id).toBe(stewardId);
  });

  test("re-saving as draft un-approves and clears the approval stamp", async () => {
    stubFacultyUserId = stewardId;
    const res = await request(app)
      .put(assessmentUrl(sourceId))
      .send({ rubric: KNOWN_DRAFT, status: "draft" });
    expect(res.status).toBe(200);
    expect(res.body.assessmentStatus).toBe("draft");
    expect(res.body.assessedAt).toBeNull();
    expect(res.body.assessedByName).toBeNull();
    expect(res.body.aiAcceptance).toBeNull();
  });

  test("a contributor cannot save an assessment (403)", async () => {
    stubFacultyUserId = contributorId;
    const res = await request(app)
      .put(assessmentUrl(sourceId))
      .send({ rubric: KNOWN_DRAFT, status: "approved" });
    expect(res.status).toBe(403);
  });
});

describe("source reliability assessment — public gating on retrieval", () => {
  test("a DRAFT assessment never reaches the consumer provenance", async () => {
    // Ensure the source is in draft (not approved) for this check.
    await pool.query(
      `UPDATE sources SET assessment_status = 'draft' WHERE id = $1`,
      [sourceId],
    );
    clearEmbeddingCache();
    const result = await retrieve({
      question: "Does evening light suppress melatonin?",
      pillarIds: [pillarId],
    });
    expect(result.chunks.length).toBeGreaterThan(0);
    for (const c of result.chunks) {
      expect(c.sourceReliabilityRubric).toBeNull();
    }
    const prov = buildProvenance(result.chunks);
    expect(prov.every((p) => p.reliability === null)).toBe(true);
  });

  test("an APPROVED assessment surfaces the reliability badge in provenance", async () => {
    await pool.query(
      `UPDATE sources
         SET assessment_status = 'approved',
             assessment_rubric = $2::jsonb
       WHERE id = $1`,
      [sourceId, JSON.stringify(KNOWN_DRAFT)],
    );
    clearEmbeddingCache();
    const result = await retrieve({
      question: "Does evening light suppress melatonin?",
      pillarIds: [pillarId],
    });
    const withRubric = result.chunks.filter(
      (c) => c.sourceReliabilityRubric !== null,
    );
    expect(withRubric.length).toBeGreaterThan(0);

    const prov = buildProvenance(result.chunks);
    const entry = prov.find((p) => p.source_id === sourceId);
    expect(entry?.reliability).not.toBeNull();
    const axes = entry?.reliability?.axes ?? [];
    const rigor = axes.find((a) => a.key === "rigor");
    expect(rigor?.score).toBe(50);
    // The public object describes the paper only — no steward identity.
    expect(JSON.stringify(entry?.reliability)).not.toContain("Steward");
  });
});

describe("source reliability assessment — batch drafting", () => {
  const batchUrl = () =>
    `/api/faculty/pillars/${pillarSlug}/sources/assessments/batch-draft`;

  // A small dedicated set of approved sources so the batch tests never collide
  // with the per-source governance tests above.
  let batchA = 0;
  let batchB = 0;
  let batchDraftAlready = 0;
  let batchInReview = 0;

  beforeAll(async () => {
    const ins = async (
      title: string,
      status: string,
      assessment: "draft" | null = null,
    ): Promise<number> => {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO sources
            (pillar_id, kind, title, status, assessment_status, uploaded_by_user_id)
         VALUES ($1,'paper',$2,$3,$4,$5) RETURNING id`,
        [pillarId, title, status, assessment, stewardId],
      );
      return rows[0].id;
    };
    batchA = await ins(`Batch approved A ${stamp}`, "approved");
    batchB = await ins(`Batch approved B ${stamp}`, "approved");
    batchDraftAlready = await ins(
      `Batch already-draft ${stamp}`,
      "approved",
      "draft",
    );
    batchInReview = await ins(`Batch in-review ${stamp}`, "in_review");
  });

  test("findUnassessedApprovedSources returns only approved + unassessed", async () => {
    const candidates = await findUnassessedApprovedSources(pillarId);
    const ids = candidates.map((c) => c.id);
    expect(ids).toContain(batchA);
    expect(ids).toContain(batchB);
    // Already drafted -> excluded; in-review (not approved) -> excluded.
    expect(ids).not.toContain(batchDraftAlready);
    expect(ids).not.toContain(batchInReview);
  });

  test("a contributor cannot trigger a batch draft (403)", async () => {
    stubFacultyUserId = contributorId;
    const res = await request(app).post(batchUrl());
    expect(res.status).toBe(403);
  });

  test("worker drafts every approved+unassessed source, never auto-approves", async () => {
    stubDraft = KNOWN_DRAFT;
    const candidates = await findUnassessedApprovedSources(pillarId);
    const result = await runPillarAssessmentDrafts({
      pillarId,
      actorUserId: stewardId,
      candidates,
    });
    expect(result.drafted).toBe(candidates.length);
    expect(result.failed).toBe(0);

    const { rows } = await pool.query<{
      id: number;
      assessment_status: string | null;
      rigor_score: number | null;
      assessed_by_user_id: number | null;
    }>(
      `SELECT id, assessment_status, rigor_score, assessed_by_user_id
         FROM sources WHERE id = ANY($1::int[])`,
      [[batchA, batchB]],
    );
    for (const r of rows) {
      expect(r.assessment_status).toBe("draft");
      expect(r.rigor_score).toBe(50);
      // Nothing is auto-published.
      expect(r.assessed_by_user_id).toBeNull();
    }
  });

  test("worker is idempotent — a second run picks up nothing new", async () => {
    stubDraft = KNOWN_DRAFT;
    const candidates = await findUnassessedApprovedSources(pillarId);
    expect(candidates.length).toBe(0);
    const result = await runPillarAssessmentDrafts({
      pillarId,
      actorUserId: stewardId,
      candidates,
    });
    expect(result.drafted).toBe(0);
  });

  test("route reports zero candidates once all are drafted", async () => {
    stubFacultyUserId = stewardId;
    const res = await request(app).post(batchUrl());
    expect(res.status).toBe(200);
    expect(res.body.candidates).toBe(0);
    expect(res.body.queued).toBe(0);
  });

  test("route reports AI unavailable without queueing work", async () => {
    // A fresh approved+unassessed source so there's a real candidate.
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO sources (pillar_id, kind, title, status, uploaded_by_user_id)
       VALUES ($1,'paper',$2,'approved',$3) RETURNING id`,
      [pillarId, `Batch AI-down ${stamp}`, stewardId],
    );
    const downId = rows[0].id;
    stubFacultyUserId = stewardId;
    aiConfigured = false;
    try {
      const res = await request(app).post(batchUrl());
      expect(res.status).toBe(200);
      expect(res.body.candidates).toBeGreaterThanOrEqual(1);
      expect(res.body.generated).toBe(false);
      expect(res.body.queued).toBe(0);
      // The candidate was left untouched.
      const { rows: after } = await pool.query<{
        assessment_status: string | null;
      }>(`SELECT assessment_status FROM sources WHERE id = $1`, [downId]);
      expect(after[0].assessment_status).toBeNull();
    } finally {
      aiConfigured = true;
    }
  });
});
