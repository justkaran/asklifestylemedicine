import { beforeAll, afterAll, describe, test, expect, vi } from "vitest";
import {
  ensureCaptureLoopSchema,
  parseSseEvents,
  parseSseQueryId,
  waitForAgentQueryRow,
  makeTopicEmbedding,
} from "./testHelpers.js";

// Set env BEFORE the route/lib modules load — they read these once at
// module-init time. `vi.hoisted` is the only way to win the import race.
vi.hoisted(() => {
  process.env.USE_GOVERNED_RAG = "true";
  process.env.RESEND_API_KEY = "stub-key";
});

// ─── Mocks (must be declared before importing the app) ─────────────────

vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: async () => ({ id: "stub-id" }),
    };
  },
}));

// Stream a fully-structured ANSWER block so the route's downstream
// post-processing (UNCOVERED/REFUSE detection, provenance shipping)
// runs the covered-path code, not the refusal short-circuit.
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      stream: () => {
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
          "A: Yes — the dose-response is non-linear and saturates near 100 lux.",
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

// Deterministic embeddings so the seeded source/interpretation chunks
// land on the same axis as the test question — guaranteed to clear the
// RAG_MIN_SCORE threshold without external network calls.
vi.mock("../lib/embeddings.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/embeddings.js")>(
      "../lib/embeddings.js",
    );
  return {
    ...actual,
    embedTexts: vi.fn(async (texts: string[]) =>
      texts.map(makeTopicEmbedding),
    ),
  };
});

// Pin the agent to the seeded test pillar so the existing dev DB's
// pillars don't intercept routing.
const seededPillarRef: { id: number; slug: string; name: string } = {
  id: 0,
  slug: "",
  name: "",
};
vi.mock("../lib/pillarRouter.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/pillarRouter.js")>(
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

// Bypass Clerk; the pillar-role middleware still runs and is exercised.
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
import { toVectorLiteral, EMBEDDING_MODEL } from "../lib/embeddings.js";
import { clearEmbeddingCache } from "../lib/rag.js";

let app: Express;
let pillarId = 0;
let sourceId = 0;
let interpretationId = 0;
const pillarName = "Governed RAG Covered Pillar";
const pillarSlug = `cov-test-${Date.now()}`;
const stewardEmail = `cov-steward-${Date.now()}@test.local`;
const sourceTitle = "Sensitivity of the human circadian pacemaker to nocturnal light";

beforeAll(async () => {
  await ensureCaptureLoopSchema();

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
    [`cov-clerk-${Date.now()}`, stewardEmail, "Cov Test Steward"],
  );
  stubFacultyUserId = userRows[0].id;

  await pool.query(
    `INSERT INTO faculty_memberships (user_id, pillar_id, role)
     VALUES ($1, $2, 'steward')`,
    [stubFacultyUserId, pillarId],
  );

  // Approved source the agent should retrieve + cite.
  const { rows: sourceRows } = await pool.query<{ id: number }>(
    `INSERT INTO sources
        (pillar_id, kind, title, authors, year, journal, doi,
         abstract, source_url, status, uploaded_by_user_id)
       VALUES ($1, 'paper', $2, 'Zeitzer JM et al.', 2000, 'J Physiol',
               '10.1111/cov-test', 'Stub abstract on melatonin.',
               'https://example.test/circadian-light',
               'approved', $3)
       RETURNING id`,
    [pillarId, sourceTitle, stubFacultyUserId],
  );
  sourceId = sourceRows[0].id;

  const sourceChunkText =
    "Even very dim ordinary room light at night significantly suppresses melatonin and shifts the human circadian clock.";
  const sourceVec = toVectorLiteral(makeTopicEmbedding(sourceChunkText));
  await pool.query(
    `INSERT INTO source_chunks
       (source_id, chunk_index, text, embedding, embedding_model)
      VALUES ($1, 0, $2, $3::halfvec(384), $4)`,
     [sourceId, sourceChunkText, sourceVec, EMBEDDING_MODEL],
  );

  // Approved interpretation hung off that source — this is what the
  // weighted retriever should prefer over the raw paper chunk.
  const { rows: interpRows } = await pool.query<{ id: number }>(
    `INSERT INTO interpretations
        (source_id, pillar_id, author_id, status, answer, interpretation,
         action, approver_id, approved_at)
       VALUES ($1, $2, $3, 'approved',
               'Dim evening light suppresses melatonin.',
               'Keep evenings dim to protect your circadian clock.',
               'Dim household lights two hours before bed.',
               $3, NOW())
       RETURNING id`,
    [sourceId, pillarId, stubFacultyUserId],
  );
  interpretationId = interpRows[0].id;

  const interpChunkText =
    "Dim evening light protects melatonin and your circadian rhythm — dim the lights two hours before bed.";
  const interpVec = toVectorLiteral(makeTopicEmbedding(interpChunkText));
  await pool.query(
    `INSERT INTO interpretation_chunks
        (interpretation_id, source_id, pillar_id, chunk_index, text,
         embedding, embedding_model, priority)
       VALUES ($1, $2, $3, 0, $4, $5::halfvec(384), $6, 100)`,
    [
      interpretationId,
      sourceId,
      pillarId,
      interpChunkText,
      interpVec,
      EMBEDDING_MODEL,
    ],
  );

  // Make sure no prior cached embedding from another test bleeds in.
  clearEmbeddingCache();

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
    await pool.query(
      `DELETE FROM interpretation_chunks WHERE pillar_id = $1`,
      [pillarId],
    );
    await pool.query(`DELETE FROM interpretations WHERE pillar_id = $1`, [
      pillarId,
    ]);
    await pool.query(
      `DELETE FROM source_chunks WHERE source_id IN
         (SELECT id FROM sources WHERE pillar_id = $1)`,
      [pillarId],
    );
    await pool.query(`DELETE FROM sources WHERE pillar_id = $1`, [pillarId]);
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

describe("governed RAG covered path end-to-end", () => {
  test(
    "retrieved chunks ground the answer, provenance ships, dashboard top topics counts the source",
    async () => {
      const agent = request.agent(app);

      const question = "Does evening melatonin shift the circadian clock?";
      const res = await agent
        .post("/api/sleep-agent")
        .set("Sec-Fetch-Site", "same-origin")
        .send({ message: question })
        .set("Accept", "text/event-stream");
      expect(res.status).toBe(200);

      const events = parseSseEvents(res.text);
      const queryId = parseSseQueryId(res.text);
      expect(queryId).toMatch(/[0-9a-f-]{36}/);

      // Streamed answer text reached the client.
      const streamed = events
        .map((e) => (typeof e.content === "string" ? e.content : ""))
        .join("");
      expect(streamed).toMatch(/melatonin/i);
      expect(streamed).not.toMatch(/^UNCOVERED:/);
      expect(streamed).not.toMatch(/^REFUSE:/);

      // The `done` event must carry provenance pointing at the seeded
      // source — this is what powers the /sleep "Stanford sources" strip.
      const done = events.find((e) => e.done === true);
      expect(done).toBeDefined();
      const provenance = (done!.provenance ?? []) as Array<{
        source_id: number;
        interpretation_id: number | null;
        title: string;
        authors: string | null;
        year: number | null;
        journal: string | null;
        pillar_slug: string;
        interpretation_note: string | null;
      }>;
      expect(provenance.length).toBeGreaterThanOrEqual(1);
      const cited = provenance.find((p) => p.source_id === sourceId);
      expect(cited).toBeDefined();
      expect(cited!.title).toBe(sourceTitle);
      expect(cited!.authors).toBe("Zeitzer JM et al.");
      expect(cited!.year).toBe(2000);
      expect(cited!.journal).toBe("J Physiol");
      expect(cited!.pillar_slug).toBe(pillarSlug);
      expect(cited!.interpretation_id).toBe(interpretationId);
      // Public provenance is citation metadata plus an approved
      // interpretation, never a retrieved verbatim source chunk.
      expect(cited).not.toHaveProperty("excerpts");
      expect(JSON.stringify(cited)).not.toMatch(/faculty take/i);
      expect(cited!.interpretation_note).toMatch(/dim evening light/i);

      // Done event echoes the pillar name we routed through.
      expect(done!.pillarNames).toEqual([pillarName]);

      // The answer is grounded AND the citation guard matched the model's
      // CITATION to the retrieved provenance, so the client is cleared to
      // stamp the named-expert attribution ("Verified by Prof. Jamie
      // Zeitzer"). This is the ONLY path that may set facultyVerified true.
      expect(
        (done!.citationVerification as { status?: string } | null)?.status,
      ).toBe("verified");
      expect(done!.facultyVerified).toBe(true);

      // Wait for the best-effort log row to land, then assert the
      // covered-path columns the dashboard + analytics rely on.
      await waitForAgentQueryRow(pool, queryId);
      const { rows: logged } = await pool.query<{
        was_uncovered: boolean;
        retrieved_source_ids: number[];
        retrieved_interpretation_ids: number[];
        top_score: number;
        pillar_ids: number[];
        answer_text: string;
      }>(
        `SELECT was_uncovered, retrieved_source_ids,
                retrieved_interpretation_ids, top_score, pillar_ids,
                answer_text
           FROM agent_queries WHERE id = $1::uuid`,
        [queryId],
      );
      expect(logged).toHaveLength(1);
      const row = logged[0];
      expect(row.was_uncovered).toBe(false);
      expect(row.pillar_ids).toEqual([pillarId]);
      expect(row.retrieved_source_ids).toContain(sourceId);
      expect(row.retrieved_interpretation_ids).toContain(interpretationId);
      // Cosine similarity between identical unit vectors → score ~1,
      // comfortably above the 0.32 RAG threshold.
      expect(row.top_score).toBeGreaterThan(0.9);
      expect(row.answer_text).toMatch(/melatonin/i);

      // Dashboard "top topics" should reflect the cited source.
      const dashRes = await agent.get(
        `/api/faculty/pillars/${pillarSlug}/dashboard`,
      );
      expect(dashRes.status).toBe(200);
      const body = dashRes.body as {
        totals: { total: number; uncovered: number };
        topTopics: Array<{ sourceId: number; title: string; count: number }>;
      };
      expect(body.totals.total).toBeGreaterThanOrEqual(1);
      expect(body.totals.uncovered).toBe(0);
      const topHit = body.topTopics.find((t) => t.sourceId === sourceId);
      expect(topHit).toBeDefined();
      expect(topHit!.title).toBe(sourceTitle);
      expect(topHit!.count).toBeGreaterThanOrEqual(1);
    },
  );
});
