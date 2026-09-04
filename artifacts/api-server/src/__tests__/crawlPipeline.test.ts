import { beforeAll, afterAll, describe, test, expect, vi } from "vitest";
import { ensureTalkCrawlSchema } from "./testHelpers.js";

/**
 * End-to-end coverage for the talk-crawl orchestrator (`runCrawl`, driven via
 * `startCrawlRun`). Unlike `crawlTalks.test.ts` — which stubs the whole worker
 * to test the admin HTTP contract — this spec runs the REAL orchestrator with
 * only the external services stubbed (Firecrawl / Scribe / media-resolve /
 * Anthropic). It locks in:
 *   - the candidate status lifecycle (discovered → … → ingested),
 *   - the shared ingest producing a `talk` source as `draft`,
 *   - the talk-metadata mirroring (speaker→authors, event→journal, year, url),
 *   - the auto-drafted `proposed` interpretation in the steward queue.
 */

// ─── External-service stubs (set per test) ─────────────────────────────

// Deterministic, network-free embeddings so the shared ingest's `embedTexts`
// call never hits OpenAI. The exact vector is irrelevant here.
vi.mock("../lib/embeddings.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/embeddings.js")>(
      "../lib/embeddings.js",
    );
  return {
    ...actual,
    embedTexts: vi.fn(async (texts: string[]) =>
      texts.map(() => {
        const v = new Array(384).fill(0);
        v[7] = 1;
        return v;
      }),
    ),
  };
});

// Firecrawl discovery + scrape. Behavior is set per test via the hoisted
// handles below so each test fully controls discovery and transcript scraping.
const fc = vi.hoisted(() => ({
  configured: true,
  search: vi.fn(),
  scrape: vi.fn(),
}));
vi.mock("../lib/firecrawl.js", () => ({
  isFirecrawlConfigured: () => fc.configured,
  searchTalks: fc.search,
  scrapeMarkdown: fc.scrape,
}));

// ElevenLabs Scribe — exercises the audio → transcript leg without network.
const scribe = vi.hoisted(() => ({ transcribe: vi.fn() }));
vi.mock("../lib/scribe.js", () => ({
  transcribeAudioUrl: scribe.transcribe,
  TranscriptionError: class TranscriptionError extends Error {},
}));

// Podcast / YouTube media resolution.
const media = vi.hoisted(() => ({
  podcast: vi.fn(),
  ytText: vi.fn(),
  ytAudio: vi.fn(),
}));
vi.mock("../lib/mediaResolve.js", () => ({
  resolvePodcastAudioUrl: media.podcast,
  fetchYouTubeTranscript: media.ytText,
  resolveYouTubeAudioUrl: media.ytAudio,
}));

// Anthropic interpretation drafter — keep the real `AI_DRAFT_PREFIX` constant
// (the worker slices it off to store the snapshot) but stub the LLM call.
vi.mock("../lib/draftInterpretation.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/draftInterpretation.js")>(
      "../lib/draftInterpretation.js",
    );
  return {
    ...actual,
    generateInterpretationDraft: vi.fn(async () => ({
      draft:
        actual.AI_DRAFT_PREFIX +
        "Timed morning light exposure shifts the circadian clock earlier, which can make it easier to fall asleep at night.",
      usedChunks: 1,
      chunks: [],
    })),
  };
});

// ─── Imports that depend on the mocks above ────────────────────────────

import pool from "../lib/db.js";
import { startCrawlRun, startCollectPhase } from "../lib/crawlTalks.js";
import { AI_DRAFT_PREFIX } from "../lib/draftInterpretation.js";

const stamp = Date.now();
let pillarId = 0;
let adminId = 0; // the operator who triggers a crawl
let speakerId = 0; // the faculty member whose appearances get crawled

const SPEAKER_NAME = "Dr Talker";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll the run row until it reaches one of the target statuses. */
async function waitForStatus(
  runId: number,
  targets: string[],
): Promise<{ status: string; error: string | null }> {
  for (let i = 0; i < 200; i++) {
    const { rows } = await pool.query(
      `SELECT status, error FROM crawl_runs WHERE id = $1`,
      [runId],
    );
    const row = rows[0] as { status: string; error: string | null };
    if (targets.includes(row.status)) return row;
    await sleep(50);
  }
  throw new Error(
    `Timed out waiting for crawl run ${runId} to reach ${targets.join("/")}`,
  );
}

/**
 * Run both phases: wait for discovery to park the run in `review`, trigger the
 * collection phase, then wait for the worker to finish (or fail).
 */
async function runBothPhases(
  runId: number,
): Promise<{ status: string; error: string | null }> {
  const reviewed = await waitForStatus(runId, ["review", "failed"]);
  if (reviewed.status === "failed") return reviewed;
  const collect = await startCollectPhase(runId);
  if (!collect.ok) {
    throw new Error(`startCollectPhase refused: ${collect.reason}`);
  }
  return waitForStatus(runId, ["done", "failed"]);
}

beforeAll(async () => {
  await ensureTalkCrawlSchema();

  const pillar = await pool.query(
    `INSERT INTO pillars (slug, name) VALUES ($1, $2) RETURNING id`,
    [`crawl-pipeline-${stamp}`, "Crawl Pipeline Pillar"],
  );
  pillarId = pillar.rows[0].id;

  const admin = await pool.query(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name, is_platform_admin)
     VALUES ($1, $2, $3, 'true') RETURNING id`,
    [`clerk-cp-admin-${stamp}`, `cp-admin-${stamp}@example.com`, "Ada Admin"],
  );
  adminId = admin.rows[0].id;

  const speaker = await pool.query(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name, is_platform_admin)
     VALUES ($1, $2, $3, 'false') RETURNING id`,
    [`clerk-cp-speaker-${stamp}`, `cp-speaker-${stamp}@example.com`, SPEAKER_NAME],
  );
  speakerId = speaker.rows[0].id;
  await pool.query(
    `INSERT INTO faculty_memberships (user_id, pillar_id, role) VALUES ($1, $2, 'contributor')`,
    [speakerId, pillarId],
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM crawl_runs WHERE pillar_id = $1`, [pillarId]);
  await pool.query(`DELETE FROM sources WHERE pillar_id = $1`, [pillarId]);
  await pool.query(`DELETE FROM pillars WHERE id = $1`, [pillarId]);
  // Memberships cascade with the pillar; the faculty_users rows are not
  // pillar-scoped, so delete the exact rows this suite created or they leak
  // into the roster (Task #208).
  await pool.query(`DELETE FROM faculty_users WHERE id = ANY($1::int[])`, [
    [adminId, speakerId],
  ]);
});

describe("crawl pipeline end-to-end (discover → collect → ingest → draft)", () => {
  test("Firecrawl-discovered article: candidate ingested, talk source drafted with mirrored metadata, interpretation proposed", async () => {
    const url = "https://example.com/circadian-light-talk";
    fc.configured = true;
    fc.search.mockResolvedValueOnce([
      {
        url,
        title: "How Circadian Light Resets Sleep — Sleep Summit 2024",
        description: "Sleep Summit 2024",
      },
    ]);
    // A substantial published transcript on the page (>= 400 chars) so the
    // article branch accepts the scrape and never needs audio.
    fc.scrape.mockResolvedValueOnce(
      "Welcome to the Sleep Summit. " +
        "Morning light is the strongest signal for the circadian clock. ".repeat(
          12,
        ),
    );

    const runId = await startCrawlRun({
      facultyUserId: speakerId,
      pillarId,
      startedByUserId: adminId,
      speakerName: SPEAKER_NAME,
      rightsBasis: "no_documented_full_text_rights",
    });

    const run = await runBothPhases(runId);
    expect(run.status).toBe("done");

    // ----- Candidate reached `ingested` -----
    const cand = await pool.query(
      `SELECT status, source_type, primary_url, source_id, interpretation_id, transcript_available
         FROM crawl_candidates WHERE crawl_run_id = $1`,
      [runId],
    );
    expect(cand.rowCount).toBe(1);
    expect(cand.rows[0].status).toBe("ingested");
    expect(cand.rows[0].source_type).toBe("article");
    expect(cand.rows[0].primary_url).toBe(url);
    expect(cand.rows[0].transcript_available).toBe(true);
    expect(cand.rows[0].source_id).toBeTruthy();
    expect(cand.rows[0].interpretation_id).toBeTruthy();

    // ----- A `talk` source was created as `draft` with mirrored citation metadata -----
    const src = await pool.query(
      `SELECT kind, status, authors, journal, year, source_url, speaker_name, speaker_faculty_user_id
         FROM sources WHERE id = $1`,
      [cand.rows[0].source_id],
    );
    expect(src.rows[0].kind).toBe("talk");
    expect(src.rows[0].status).toBe("draft"); // not citable until a steward approves
    expect(src.rows[0].authors).toBe(SPEAKER_NAME); // speaker → authors
    expect(src.rows[0].journal).toBe("Sleep Summit 2024"); // event → journal
    expect(src.rows[0].year).toBe(2024); // year parsed from the title
    expect(src.rows[0].source_url).toBe(url);
    expect(src.rows[0].speaker_name).toBe(SPEAKER_NAME);
    expect(src.rows[0].speaker_faculty_user_id).toBe(speakerId);

    // ----- A `proposed` interpretation was auto-drafted into the steward queue -----
    const interp = await pool.query(
      `SELECT status, ai_draft, interpretation FROM interpretations WHERE id = $1`,
      [cand.rows[0].interpretation_id],
    );
    expect(interp.rows[0].status).toBe("proposed");
    // The stored body is the AI draft (carrying the unverified prefix) and the
    // snapshot is the same text with the prefix stripped.
    expect(interp.rows[0].interpretation).toContain(AI_DRAFT_PREFIX);
    expect(interp.rows[0].ai_draft).toBeTruthy();
    expect(interp.rows[0].ai_draft).not.toContain(AI_DRAFT_PREFIX);
  });

  test("pasted podcast URL: transcript comes from Scribe via resolved audio, then ingests + drafts", async () => {
    const url = "https://pods.example.com/episode/sleep-and-light-2023";
    const audioUrl = "https://cdn.example.com/audio/sleep-and-light-2023.mp3";
    fc.configured = false; // discovery off → relies on the pasted URL
    // Podcast page has no published transcript → fall through to audio.
    fc.scrape.mockResolvedValue(null);
    media.podcast.mockResolvedValueOnce(audioUrl);
    scribe.transcribe.mockResolvedValueOnce(
      "In this episode we discuss how evening light delays the circadian clock. " +
        "Dimming lights before bed helps melatonin rise on time. ".repeat(8),
    );

    const runId = await startCrawlRun({
      facultyUserId: speakerId,
      pillarId,
      startedByUserId: adminId,
      speakerName: SPEAKER_NAME,
      pastedUrls: [url],
      rightsBasis: "no_documented_full_text_rights",
    });

    const run = await runBothPhases(runId);
    expect(run.status).toBe("done");

    const cand = await pool.query(
      `SELECT status, source_type, audio_url, source_id, interpretation_id
         FROM crawl_candidates WHERE crawl_run_id = $1`,
      [runId],
    );
    expect(cand.rowCount).toBe(1);
    expect(cand.rows[0].status).toBe("ingested");
    expect(cand.rows[0].source_type).toBe("podcast");
    // The resolved audio URL is persisted for operator observability.
    expect(cand.rows[0].audio_url).toBe(audioUrl);

    // Scribe + the podcast resolver were actually used to collect the transcript.
    expect(media.podcast).toHaveBeenCalledWith(url);
    expect(scribe.transcribe).toHaveBeenCalledWith(audioUrl);

    const src = await pool.query(
      `SELECT kind, status, authors FROM sources WHERE id = $1`,
      [cand.rows[0].source_id],
    );
    expect(src.rows[0].kind).toBe("talk");
    expect(src.rows[0].status).toBe("draft");
    expect(src.rows[0].authors).toBe(SPEAKER_NAME);

    const interp = await pool.query(
      `SELECT status FROM interpretations WHERE id = $1`,
      [cand.rows[0].interpretation_id],
    );
    expect(interp.rows[0].status).toBe("proposed");
  });

  test("discovery parks the run in `review`; a discarded candidate is never collected or ingested", async () => {
    const keepUrl = "https://example.com/kept-talk";
    const dropUrl = "https://example.com/wrong-person";
    fc.configured = true;
    fc.scrape.mockReset();
    fc.search.mockReset();
    fc.search.mockResolvedValueOnce([
      { url: keepUrl, title: "Kept appearance — Sleep Summit 2022", description: null },
      { url: dropUrl, title: "Different speaker, same name", description: null },
    ]);
    // Only the kept URL ever gets a transcript; the dropped one must never be
    // scraped because it's discarded before collection.
    fc.scrape.mockImplementation(async (target: string) =>
      target === keepUrl
        ? "A substantial transcript about morning light and circadian timing. ".repeat(
            12,
          )
        : null,
    );

    const runId = await startCrawlRun({
      facultyUserId: speakerId,
      pillarId,
      startedByUserId: adminId,
      speakerName: SPEAKER_NAME,
      rightsBasis: "no_documented_full_text_rights",
    });

    // Phase 1 stops in `review` with both candidates still `discovered` — no
    // transcript was collected yet.
    const reviewed = await waitForStatus(runId, ["review", "failed"]);
    expect(reviewed.status).toBe("review");
    const afterDiscovery = await pool.query(
      `SELECT id, primary_url, status, source_id FROM crawl_candidates WHERE crawl_run_id = $1 ORDER BY id`,
      [runId],
    );
    expect(afterDiscovery.rowCount).toBe(2);
    expect(afterDiscovery.rows.every((r) => r.status === "discovered")).toBe(true);
    expect(afterDiscovery.rows.every((r) => r.source_id === null)).toBe(true);
    expect(fc.scrape).not.toHaveBeenCalled();

    // Operator discards the wrong-person candidate, then triggers collection.
    const dropId = afterDiscovery.rows.find((r) => r.primary_url === dropUrl)!.id;
    await pool.query(
      `UPDATE crawl_candidates SET status = 'discarded' WHERE id = $1`,
      [dropId],
    );

    const run = await runBothPhases(runId);
    expect(run.status).toBe("done");

    const after = await pool.query(
      `SELECT primary_url, status, source_id FROM crawl_candidates WHERE crawl_run_id = $1`,
      [runId],
    );
    const kept = after.rows.find((r) => r.primary_url === keepUrl)!;
    const dropped = after.rows.find((r) => r.primary_url === dropUrl)!;
    expect(kept.status).toBe("ingested");
    expect(kept.source_id).toBeTruthy();
    // The discarded candidate stayed discarded and was never ingested.
    expect(dropped.status).toBe("discarded");
    expect(dropped.source_id).toBeNull();
    // The expensive scrape only ran for the kept appearance.
    expect(fc.scrape).toHaveBeenCalledTimes(1);
    expect(fc.scrape).toHaveBeenCalledWith(keepUrl);
  });
});
