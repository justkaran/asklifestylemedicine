import { beforeAll, afterAll, describe, test, expect, vi } from "vitest";
import { ensureTalkCrawlSchema } from "./testHelpers.js";

// Real-DB unit tests for the operator "retry a failed talk" action
// (Task #176). retryCandidate refuses to re-run a candidate that is already
// `ingested` or still `fetching` (so a re-run never creates a duplicate source
// + duplicate steward draft), and otherwise resets a `failed` candidate to
// `discovered` and re-processes it in the background into a single `talk`
// source + one PROPOSED interpretation.

vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-crawl-retry-secret";
});

// The crawl module pulls in Firecrawl / Scribe / media-resolve at import time.
// Stub the network collaborators so module init is deterministic and offline
// (same pattern as crawlDiscard.test.ts).
vi.mock("../lib/firecrawl.js", () => ({
  scrapeMarkdown: vi.fn(),
  searchTalks: vi.fn(),
  isFirecrawlConfigured: () => false,
}));
vi.mock("../lib/scribe.js", () => ({ transcribeAudioUrl: vi.fn() }));
vi.mock("../lib/mediaResolve.js", () => ({
  resolvePodcastAudioUrl: vi.fn(),
  fetchYouTubeTranscript: vi.fn(),
  resolveYouTubeAudioUrl: vi.fn(),
}));
// Stub the shared ingest pipeline (no embeddings/network) and the AI drafter so
// the only thing under test is the retry skip — not transcription or model calls.
vi.mock("../lib/ingestSource.js", () => ({ ingestSource: vi.fn() }));
vi.mock("../lib/draftInterpretation.js", () => ({
  generateInterpretationDraft: vi.fn(),
  AI_DRAFT_PREFIX: "[AI-drafted]\n\n",
}));

import pool from "../lib/db.js";
import { retryCandidate } from "../lib/crawlTalks.js";
import { scrapeMarkdown } from "../lib/firecrawl.js";
import { ingestSource } from "../lib/ingestSource.js";
import { generateInterpretationDraft } from "../lib/draftInterpretation.js";

const stamp = Date.now();
let pillarId = 0;
let speakerId = 0;
let runId = 0;

async function insertCandidate(
  status: string,
  extra: { sourceId?: number; interpretationId?: number } = {},
): Promise<number> {
  const res = await pool.query(
    `INSERT INTO crawl_candidates
       (crawl_run_id, status, title, source_type, primary_url, source_id, interpretation_id)
     VALUES ($1, $2, $3, 'article', $4, $5, $6) RETURNING id`,
    [
      runId,
      status,
      `candidate (${status})`,
      "https://example.com/talk",
      extra.sourceId ?? null,
      extra.interpretationId ?? null,
    ],
  );
  return res.rows[0].id as number;
}

async function insertSourceAndInterpretation(): Promise<{
  sourceId: number;
  interpretationId: number;
}> {
  const src = await pool.query(
    `INSERT INTO sources (pillar_id, kind, title, uploaded_by_user_id, status)
     VALUES ($1, 'talk', 'Existing talk', $2, 'draft') RETURNING id`,
    [pillarId, speakerId],
  );
  const sourceId = src.rows[0].id as number;
  const interp = await pool.query(
    `INSERT INTO interpretations
       (source_id, pillar_id, author_id, status, answer, interpretation)
     VALUES ($1, $2, $3, 'proposed', 'Existing answer', 'Existing draft') RETURNING id`,
    [sourceId, pillarId, speakerId],
  );
  return { sourceId, interpretationId: interp.rows[0].id as number };
}

/** Poll until the (fire-and-forget) re-processed candidate reaches a status. */
async function waitForCandidateStatus(
  id: number,
  statuses: string[],
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await pool.query(
      `SELECT status FROM crawl_candidates WHERE id = $1`,
      [id],
    );
    const status = r.rows[0]?.status as string | undefined;
    if (status && statuses.includes(status)) return status;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`Candidate ${id} never reached ${statuses.join("/")}`);
}

beforeAll(async () => {
  await ensureTalkCrawlSchema();

  const pillar = await pool.query(
    `INSERT INTO pillars (slug, name) VALUES ($1, $2) RETURNING id`,
    [`retry-pillar-${stamp}`, "Retry Test Pillar"],
  );
  pillarId = pillar.rows[0].id;

  const speaker = await pool.query(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [`clerk-retry-${stamp}`, `retry-${stamp}@example.com`, "Dr Retry"],
  );
  speakerId = speaker.rows[0].id;

  const run = await pool.query(
    `INSERT INTO crawl_runs
       (faculty_user_id, pillar_id, speaker_name, status, rights_basis)
     VALUES ($1, $2, $3, 'collecting', 'permission') RETURNING id`,
    [speakerId, pillarId, "Dr Retry"],
  );
  runId = run.rows[0].id;

  // A scrape that returns a usable published transcript so collectTranscript
  // succeeds for the (article) candidate without any network.
  vi.mocked(scrapeMarkdown).mockResolvedValue("Transcript body. ".repeat(40));
  // The drafter returns no draft → processCandidate uses its placeholder seed.
  vi.mocked(generateInterpretationDraft).mockResolvedValue({
    draft: "",
    usedChunks: 0,
    chunks: [],
  });
  // The shared ingest pipeline inserts a minimal real `sources` row so a
  // re-processed candidate produces a verifiable, countable source.
  vi.mocked(ingestSource).mockImplementation(async (params) => {
    const res = await pool.query(
      `INSERT INTO sources (pillar_id, kind, title, uploaded_by_user_id, status)
       VALUES ($1, 'talk', $2, $3, 'draft') RETURNING id`,
      [params.pillarId, params.fallbackTitle, params.uploadedByUserId],
    );
    return {
      source: { id: res.rows[0].id as number } as never,
      chunkCount: 0,
      embeddedCount: 1,
      charCount: 100,
      versioned: false,
    };
  });
});

afterAll(async () => {
  await pool.query(`DELETE FROM crawl_runs WHERE pillar_id = $1`, [pillarId]);
  await pool.query(`DELETE FROM interpretations WHERE pillar_id = $1`, [
    pillarId,
  ]);
  await pool.query(`DELETE FROM sources WHERE pillar_id = $1`, [pillarId]);
  await pool.query(`DELETE FROM faculty_users WHERE id = $1`, [speakerId]);
  await pool.query(`DELETE FROM pillars WHERE id = $1`, [pillarId]);
});

describe("retryCandidate (Task #176)", () => {
  test("refuses an already-ingested candidate — no duplicate source/interpretation", async () => {
    vi.mocked(ingestSource).mockClear();
    const { sourceId, interpretationId } =
      await insertSourceAndInterpretation();
    const id = await insertCandidate("ingested", { sourceId, interpretationId });

    const sourcesBefore = await pool.query(
      `SELECT COUNT(*)::int AS n FROM sources WHERE pillar_id = $1`,
      [pillarId],
    );

    const result = await retryCandidate(id);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/already ingested/i);

    // The ingest chokepoint was never touched.
    expect(vi.mocked(ingestSource)).not.toHaveBeenCalled();

    // No second source created.
    const sourcesAfter = await pool.query(
      `SELECT COUNT(*)::int AS n FROM sources WHERE pillar_id = $1`,
      [pillarId],
    );
    expect(sourcesAfter.rows[0].n).toBe(sourcesBefore.rows[0].n);

    // The candidate is untouched: still ingested, still linked to the originals.
    const row = await pool.query(
      `SELECT status, source_id, interpretation_id FROM crawl_candidates WHERE id = $1`,
      [id],
    );
    expect(row.rows[0].status).toBe("ingested");
    expect(row.rows[0].source_id).toBe(sourceId);
    expect(row.rows[0].interpretation_id).toBe(interpretationId);

    // Exactly one interpretation still references the original source.
    const interp = await pool.query(
      `SELECT COUNT(*)::int AS n FROM interpretations WHERE source_id = $1`,
      [sourceId],
    );
    expect(interp.rows[0].n).toBe(1);
  });

  test("refuses a candidate that is still fetching", async () => {
    vi.mocked(ingestSource).mockClear();
    const id = await insertCandidate("fetching");

    const result = await retryCandidate(id);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/still being collected/i);

    expect(vi.mocked(ingestSource)).not.toHaveBeenCalled();
    const row = await pool.query(
      `SELECT status, source_id, interpretation_id FROM crawl_candidates WHERE id = $1`,
      [id],
    );
    expect(row.rows[0].status).toBe("fetching");
    expect(row.rows[0].source_id).toBeNull();
    expect(row.rows[0].interpretation_id).toBeNull();
  });

  test("resets a failed candidate and re-processes it into one source + one interpretation", async () => {
    vi.mocked(ingestSource).mockClear();
    const id = await insertCandidate("failed");
    await pool.query(
      `UPDATE crawl_candidates SET error = 'previous failure' WHERE id = $1`,
      [id],
    );

    const result = await retryCandidate(id);
    expect(result.ok).toBe(true);

    // Re-processing is fire-and-forget; wait for the terminal status.
    const status = await waitForCandidateStatus(id, ["ingested", "failed"]);
    expect(status).toBe("ingested");

    const row = await pool.query(
      `SELECT status, source_id, interpretation_id, error FROM crawl_candidates WHERE id = $1`,
      [id],
    );
    expect(row.rows[0].status).toBe("ingested");
    expect(row.rows[0].source_id).not.toBeNull();
    expect(row.rows[0].interpretation_id).not.toBeNull();
    expect(row.rows[0].error).toBeNull();

    // Ingested exactly once — no duplicate source.
    expect(vi.mocked(ingestSource)).toHaveBeenCalledTimes(1);

    // Exactly one interpretation references the freshly ingested source.
    const interp = await pool.query(
      `SELECT COUNT(*)::int AS n FROM interpretations WHERE source_id = $1`,
      [row.rows[0].source_id],
    );
    expect(interp.rows[0].n).toBe(1);
  });
});
