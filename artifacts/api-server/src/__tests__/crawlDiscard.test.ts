import { beforeAll, afterAll, describe, test, expect, vi } from "vitest";
import { ensureTalkCrawlSchema } from "./testHelpers.js";

// Real-DB unit tests for the operator "discard a discovered talk" action
// (Task #169). Discovered/failed candidates can be dismissed before ingest so
// they never create a `talk` source or a steward draft; already-ingested ones
// can't be discarded (their drafted interpretation is handled in the steward
// queue instead).

vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-crawl-discard-secret";
});

// The crawl module pulls in Firecrawl / Scribe / media-resolve at import time.
// discardCandidate only touches the DB, so stub the network collaborators to
// keep module init deterministic and offline (same pattern as the collect test).
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
// The orchestrator test drives the real startCollectPhase / processCandidate
// path. Stub the shared ingest pipeline (no embeddings/network) and the AI
// drafter so the only thing under test is the discard skip — not transcription
// or model calls.
vi.mock("../lib/ingestSource.js", () => ({ ingestSource: vi.fn() }));
vi.mock("../lib/draftInterpretation.js", () => ({
  generateInterpretationDraft: vi.fn(),
  AI_DRAFT_PREFIX: "[AI-drafted]\n\n",
}));

import pool from "../lib/db.js";
import {
  discardCandidate,
  startCollectPhase,
  processCandidate,
} from "../lib/crawlTalks.js";
import { scrapeMarkdown } from "../lib/firecrawl.js";
import { ingestSource } from "../lib/ingestSource.js";
import { generateInterpretationDraft } from "../lib/draftInterpretation.js";
import type { CrawlCandidate } from "@workspace/db";

const stamp = Date.now();
let pillarId = 0;
let speakerId = 0;
let runId = 0;

async function insertCandidate(status: string): Promise<number> {
  const res = await pool.query(
    `INSERT INTO crawl_candidates (crawl_run_id, status, title, primary_url)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [runId, status, `candidate (${status})`, "https://example.com/talk"],
  );
  return res.rows[0].id as number;
}

/** Poll until the (fire-and-forget) collection worker drives a run's status. */
async function waitForRunStatus(
  id: number,
  status: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await pool.query(`SELECT status FROM crawl_runs WHERE id = $1`, [
      id,
    ]);
    if (r.rows[0]?.status === status) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`Run ${id} never reached ${status}`);
}

beforeAll(async () => {
  await ensureTalkCrawlSchema();

  const pillar = await pool.query(
    `INSERT INTO pillars (slug, name) VALUES ($1, $2) RETURNING id`,
    [`discard-pillar-${stamp}`, "Discard Test Pillar"],
  );
  pillarId = pillar.rows[0].id;

  const speaker = await pool.query(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [`clerk-discard-${stamp}`, `discard-${stamp}@example.com`, "Dr Discard"],
  );
  speakerId = speaker.rows[0].id;

  const run = await pool.query(
    `INSERT INTO crawl_runs (faculty_user_id, pillar_id, speaker_name, status, rights_basis)
     VALUES ($1, $2, $3, 'collecting', 'permission') RETURNING id`,
    [speakerId, pillarId, "Dr Discard"],
  );
  runId = run.rows[0].id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM crawl_runs WHERE pillar_id = $1`, [pillarId]);
  await pool.query(`DELETE FROM sources WHERE pillar_id = $1`, [pillarId]);
  await pool.query(`DELETE FROM faculty_users WHERE id = $1`, [speakerId]);
  await pool.query(`DELETE FROM pillars WHERE id = $1`, [pillarId]);
});

describe("discardCandidate (Task #169)", () => {
  test("flips a discovered candidate to discarded", async () => {
    const id = await insertCandidate("discovered");
    const result = await discardCandidate(id);
    expect(result.ok).toBe(true);
    const row = await pool.query(
      `SELECT status FROM crawl_candidates WHERE id = $1`,
      [id],
    );
    expect(row.rows[0].status).toBe("discarded");
  });

  test("flips a failed candidate to discarded too", async () => {
    const id = await insertCandidate("failed");
    const result = await discardCandidate(id);
    expect(result.ok).toBe(true);
    const row = await pool.query(
      `SELECT status FROM crawl_candidates WHERE id = $1`,
      [id],
    );
    expect(row.rows[0].status).toBe("discarded");
  });

  test("refuses to discard an already-ingested candidate", async () => {
    const id = await insertCandidate("ingested");
    const result = await discardCandidate(id);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/already ingested/i);
    const row = await pool.query(
      `SELECT status FROM crawl_candidates WHERE id = $1`,
      [id],
    );
    // Status is untouched — the interpretation must be handled in the queue.
    expect(row.rows[0].status).toBe("ingested");
  });

  test("returns not_found for an unknown candidate", async () => {
    const result = await discardCandidate(99999999);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_found");
  });
});

// Orchestrator-level guarantee (Task #175): a candidate discarded mid-run is
// never collected, ingested, or drafted for a steward, while a kept candidate
// produces both a `talk` source and a PROPOSED interpretation. Covers the two
// guards independently: the runCollection loop re-check skip and the
// processCandidate conditional-`fetching` flip (the chokepoint the retry path
// also flows through). Discovery parks the run in `review`; an operator triggers
// the collection phase via startCollectPhase.
describe("startCollectPhase skips discarded candidates (Task #175)", () => {
  const KEEP_URL = "https://example.com/keep-talk";
  const DISCARD_URL = "https://example.com/discard-talk";

  beforeAll(() => {
    // A scrape that returns a usable published transcript so collectTranscript
    // succeeds for the kept (article) candidate without any network.
    vi.mocked(scrapeMarkdown).mockResolvedValue("Transcript body. ".repeat(40));
    // The drafter returns no draft → processCandidate uses its placeholder seed.
    vi.mocked(generateInterpretationDraft).mockResolvedValue({
      draft: "",
      usedChunks: 0,
      chunks: [],
    });
    // The shared ingest pipeline is stubbed to insert a minimal real `sources`
    // row (so the kept candidate produces a verifiable row) AND, on its single
    // call for the kept candidate, to discard the sibling candidate — exactly
    // the operator-discards-mid-run scenario the loop re-check must catch.
    vi.mocked(ingestSource).mockImplementation(async (params) => {
      await pool.query(
        `UPDATE crawl_candidates SET status = 'discarded'
           WHERE crawl_run_id = $1 AND primary_url = $2 AND status <> 'ingested'`,
        [orchestratorRunId, DISCARD_URL],
      );
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

  let orchestratorRunId = 0;

  test("discarded candidate is never ingested; kept candidate is", async () => {
    // The run is parked in `review` after discovery; the operator keeps both
    // candidates, then triggers the collection phase.
    const run = await pool.query(
      `INSERT INTO crawl_runs
         (faculty_user_id, pillar_id, speaker_name, status, rights_basis)
       VALUES ($1, $2, $3, 'review', 'permission') RETURNING id`,
      [speakerId, pillarId, "Dr Discard"],
    );
    orchestratorRunId = run.rows[0].id;

    // Discovery already inserted these two candidates (in order). The kept
    // candidate (lower id → processed first) discards the second before the
    // collection loop reaches it (via the ingestSource mock above).
    await pool.query(
      `INSERT INTO crawl_candidates
         (crawl_run_id, status, title, source_type, primary_url)
       VALUES ($1, 'discovered', 'Keep talk', 'article', $2),
              ($1, 'discovered', 'Discard talk', 'article', $3)`,
      [orchestratorRunId, KEEP_URL, DISCARD_URL],
    );

    const started = await startCollectPhase(orchestratorRunId);
    expect(started.ok).toBe(true);

    // Collection runs fire-and-forget; wait for the run to finish.
    await waitForRunStatus(orchestratorRunId, "done");

    const cands = await pool.query(
      `SELECT primary_url, status, source_id, interpretation_id
         FROM crawl_candidates WHERE crawl_run_id = $1`,
      [orchestratorRunId],
    );
    const byUrl = new Map(
      cands.rows.map((r) => [r.primary_url as string, r]),
    );

    const kept = byUrl.get(KEEP_URL)!;
    expect(kept.status).toBe("ingested");
    expect(kept.source_id).not.toBeNull();
    expect(kept.interpretation_id).not.toBeNull();

    const discarded = byUrl.get(DISCARD_URL)!;
    expect(discarded.status).toBe("discarded");
    expect(discarded.source_id).toBeNull();
    expect(discarded.interpretation_id).toBeNull();

    // The discarded candidate never reached the ingest chokepoint.
    expect(vi.mocked(ingestSource)).toHaveBeenCalledTimes(1);

    // Exactly one source + one interpretation for this run's pillar came from
    // the kept candidate — the discarded one left no trace.
    const interp = await pool.query(
      `SELECT id FROM interpretations WHERE source_id = $1`,
      [kept.source_id],
    );
    expect(interp.rows).toHaveLength(1);
    expect(kept.interpretation_id).toBe(interp.rows[0].id);
  });

  test("processCandidate's fetching guard refuses an already-discarded candidate", async () => {
    vi.mocked(ingestSource).mockClear();
    const id = await insertCandidate("discarded");
    const [row] = (
      await pool.query(`SELECT * FROM crawl_candidates WHERE id = $1`, [id])
    ).rows as CrawlCandidate[];

    await processCandidate(row, {
      facultyUserId: speakerId,
      pillarId,
      speakerName: "Dr Discard",
      rightsBasis: "no_documented_full_text_rights",
    });

    // The conditional `status <> 'discarded'` flip matched no rows → early
    // return before any collection or ingest.
    expect(vi.mocked(ingestSource)).not.toHaveBeenCalled();
    const after = await pool.query(
      `SELECT status, source_id, interpretation_id FROM crawl_candidates WHERE id = $1`,
      [id],
    );
    expect(after.rows[0].status).toBe("discarded");
    expect(after.rows[0].source_id).toBeNull();
    expect(after.rows[0].interpretation_id).toBeNull();
  });
});
