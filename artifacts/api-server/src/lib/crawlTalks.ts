import { and, eq, ne } from "drizzle-orm";
import {
  db,
  crawlRunsTable,
  crawlCandidatesTable,
  facultyUsersTable,
  interpretationsTable,
  type CrawlCandidate,
  type SourceRightsBasis,
} from "@workspace/db";
import { logger } from "./logger.js";
import { ingestSource } from "./ingestSource.js";
import {
  generateInterpretationDraft,
  AI_DRAFT_PREFIX,
} from "./draftInterpretation.js";
import { searchTalks, scrapeMarkdown, isFirecrawlConfigured } from "./firecrawl.js";
import { transcribeAudioUrl } from "./scribe.js";
import {
  resolvePodcastAudioUrl,
  fetchYouTubeTranscript,
  resolveYouTubeAudioUrl,
} from "./mediaResolve.js";

/**
 * Talk-crawl orchestrator (Task #168).
 *
 * `startCrawlRun` creates a `crawl_runs` row and kicks off a fire-and-forget
 * background worker (`runCrawl`). There is no job queue in this codebase
 * (jobs.ts holds cron functions), so we use a detached async task and let the
 * admin UI poll the run + candidate rows for progress.
 *
 * The pipeline runs in two operator-gated phases:
 *
 *   Phase 1 — discovery (`runDiscovery`, kicked off by `startCrawlRun`):
 *     1. discovers candidate appearance pages (Firecrawl search + operator-pasted
 *        URLs) and inserts them as `discovered` candidates, then
 *     2. STOPS in a `review` run state. No transcription, ingest, or steward
 *        draft happens yet — only the (cheap) Firecrawl discovery cost is spent.
 *
 *   Phase 2 — collection (`runCollection`, kicked off by `startCollectPhase`
 *     once an operator has weeded out wrong-person/off-topic/duplicate hits):
 *     3. collects a transcript per kept candidate (published transcript via
 *        scrape, podcast audio resolved from the episode page / RSS enclosure
 *        then sent to ElevenLabs Scribe, or a YouTube caption track flattened
 *        to text),
 *     4. ingests each transcript as a citable `talk` source through the SHARED
 *        ingest pipeline, then
 *     5. auto-drafts a PROPOSED interpretation into the pillar steward queue.
 *
 * Splitting discovery from collection means the expensive transcription /
 * AI-draft cost is only spent on candidates the operator chose to keep.
 *
 * Nothing becomes citable here — a human steward must approve the drafted
 * interpretation (which also approves the talk source; see interpretations.ts).
 */

const MAX_DISCOVERED = 12;

/** Heuristic classification of a candidate URL into a coarse source type. */
function classifyUrl(url: string): {
  sourceType: "podcast" | "youtube" | "audio" | "article";
  audioUrl: string | null;
} {
  const u = url.toLowerCase();
  if (/\.(mp3|m4a|wav|aac|ogg)(\?|$)/.test(u)) {
    return { sourceType: "audio", audioUrl: url };
  }
  if (u.includes("youtube.com") || u.includes("youtu.be")) {
    return { sourceType: "youtube", audioUrl: null };
  }
  if (
    u.includes("podcast") ||
    u.includes("/episode") ||
    u.includes("spotify.com") ||
    u.includes("apple.com/")
  ) {
    return { sourceType: "podcast", audioUrl: null };
  }
  return { sourceType: "article", audioUrl: null };
}

function yearFromText(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.match(/(19|20)\d{2}/);
  if (!m) return null;
  const y = Number(m[0]);
  return y >= 1900 && y <= 2100 ? y : null;
}

/**
 * Create a crawl run row and start the background worker. Returns the run id
 * immediately; the worker runs detached.
 */
export async function startCrawlRun(opts: {
  facultyUserId: number;
  pillarId: number;
  startedByUserId: number;
  speakerName: string;
  rightsBasis: SourceRightsBasis;
  pastedUrls?: string[];
}): Promise<number> {
  const [run] = await db
    .insert(crawlRunsTable)
    .values({
      facultyUserId: opts.facultyUserId,
      pillarId: opts.pillarId,
      startedByUserId: opts.startedByUserId,
      speakerName: opts.speakerName,
      rightsBasis: opts.rightsBasis,
      status: "pending",
    })
    .returning();

  // Fire-and-forget. Errors are caught inside runDiscovery and recorded on the
  // run row; the catch here is a last-resort guard so an unhandled rejection
  // never crashes the server.
  void runDiscovery(run!.id, {
    speakerName: opts.speakerName,
    pastedUrls: opts.pastedUrls ?? [],
  }).catch((err) => {
    logger.error({ err, runId: run!.id }, "Talk crawl discovery crashed");
    void db
      .update(crawlRunsTable)
      .set({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      })
      .where(eq(crawlRunsTable.id, run!.id));
  });

  return run!.id;
}

/**
 * Phase 1 — discovery. Finds candidate appearances (Firecrawl + pasted URLs),
 * inserts them as `discovered`, and parks the run in `review`. NOTHING is
 * transcribed, ingested, or drafted here: an operator must weed out the
 * candidates and then trigger the collection phase (see `startCollectPhase`).
 */
async function runDiscovery(
  runId: number,
  ctx: { speakerName: string; pastedUrls: string[] },
): Promise<void> {
  await db
    .update(crawlRunsTable)
    .set({ status: "discovering" })
    .where(eq(crawlRunsTable.id, runId));

  const discovered = new Map<
    string,
    { title: string; description: string | null }
  >();
  for (const raw of ctx.pastedUrls) {
    const url = raw.trim();
    if (url) discovered.set(url, { title: url, description: null });
  }

  if (isFirecrawlConfigured()) {
    const query = `"${ctx.speakerName}" (podcast OR interview OR talk OR lecture OR keynote)`;
    const hits = await searchTalks(query, { limit: MAX_DISCOVERED });
    for (const h of hits) {
      if (!discovered.has(h.url)) {
        discovered.set(h.url, { title: h.title, description: h.description });
      }
    }
  }

  if (discovered.size === 0) {
    await db
      .update(crawlRunsTable)
      .set({
        status: "failed",
        error: isFirecrawlConfigured()
          ? "No talks, podcasts, or interviews were discovered for this speaker."
          : "Discovery is unavailable (FIRECRAWL_API_KEY not set) and no URLs were pasted. Paste one or more appearance URLs to crawl.",
      })
      .where(eq(crawlRunsTable.id, runId));
    return;
  }

  // Insert candidate rows.
  await db.insert(crawlCandidatesTable).values(
    Array.from(discovered.entries())
      .slice(0, MAX_DISCOVERED)
      .map(([url, meta]) => {
        const { sourceType, audioUrl } = classifyUrl(url);
        return {
          crawlRunId: runId,
          status: "discovered" as const,
          title: meta.title.slice(0, 1000),
          sourceType,
          primaryUrl: url,
          audioUrl,
          eventName: meta.description?.slice(0, 500) ?? null,
        };
      }),
  );

  // Park in `review`: the operator reviews the discovered candidates and
  // triggers collection for the ones they keep.
  await db
    .update(crawlRunsTable)
    .set({ status: "review" })
    .where(eq(crawlRunsTable.id, runId));
}

/**
 * Trigger phase 2 (collection) for a run that is parked in `review` (operator
 * action). Flips the run to `collecting` and kicks off the background worker
 * that processes only the non-discarded candidates. Idempotent-ish: refuses
 * when the run is not in `review` so a double-click can't double-collect.
 */
export async function startCollectPhase(
  runId: number,
): Promise<{ ok: boolean; reason?: string }> {
  const [run] = await db
    .select()
    .from(crawlRunsTable)
    .where(eq(crawlRunsTable.id, runId))
    .limit(1);
  if (!run) return { ok: false, reason: "not_found" };
  if (run.status !== "review") {
    return {
      ok: false,
      reason:
        "This run is not awaiting review. Collection can only be started from the review state.",
    };
  }
  if (!run.rightsBasis) {
    return {
      ok: false,
      reason:
        "Record a full-text rights basis before collecting this legacy crawl.",
    };
  }

  // Flip to `collecting` only if still in `review`, so two concurrent triggers
  // can't both start the worker.
  const flipped = await db
    .update(crawlRunsTable)
    .set({ status: "collecting" })
    .where(
      and(
        eq(crawlRunsTable.id, runId),
        eq(crawlRunsTable.status, "review"),
      ),
    )
    .returning({ id: crawlRunsTable.id });
  if (flipped.length === 0) {
    return {
      ok: false,
      reason: "This run is already being collected.",
    };
  }

  const ctx = {
    facultyUserId: run.facultyUserId,
    pillarId: run.pillarId,
    speakerName: run.speakerName,
    rightsBasis: run.rightsBasis,
  };
  // Fire-and-forget; errors are recorded on the run row.
  void runCollection(runId, ctx).catch((err) => {
    logger.error({ err, runId }, "Talk crawl collection crashed");
    void db
      .update(crawlRunsTable)
      .set({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      })
      .where(eq(crawlRunsTable.id, runId));
  });

  return { ok: true };
}

/**
 * Phase 2 — collection. Processes every kept (non-discarded, not-yet-ingested)
 * candidate of a run: collect → transcribe → ingest → draft, then marks the
 * run `done`. Discarded candidates are skipped, so the expensive work only
 * runs on the appearances the operator chose to keep.
 */
async function runCollection(
  runId: number,
  ctx: {
    facultyUserId: number;
    pillarId: number;
    speakerName: string;
    rightsBasis: SourceRightsBasis;
  },
): Promise<void> {
  const candidateRows = await db
    .select()
    .from(crawlCandidatesTable)
    .where(eq(crawlCandidatesTable.crawlRunId, runId))
    .orderBy(crawlCandidatesTable.id);

  for (const cand of candidateRows) {
    // Re-read the candidate's current status: an operator may have discarded it
    // during the (potentially long) collecting phase. Discarded (and already
    // ingested) candidates must never be collected, ingested, or drafted.
    const [current] = await db
      .select({ status: crawlCandidatesTable.status })
      .from(crawlCandidatesTable)
      .where(eq(crawlCandidatesTable.id, cand.id))
      .limit(1);
    if (
      !current ||
      current.status === "discarded" ||
      current.status === "ingested"
    )
      continue;
    try {
      await processCandidate(cand, ctx);
    } catch (err) {
      logger.warn(
        { err, candidateId: cand.id, runId },
        "Talk candidate processing failed",
      );
      await db
        .update(crawlCandidatesTable)
        .set({
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        })
        .where(eq(crawlCandidatesTable.id, cand.id));
    }
  }

  await db
    .update(crawlRunsTable)
    .set({ status: "done" })
    .where(eq(crawlRunsTable.id, runId));
}

/** Minimum usable transcript length (chars) before we accept a collection. */
const MIN_TRANSCRIPT_CHARS = 200;

/** The subset of a candidate the collection step needs. */
type CollectableCandidate = Pick<
  CrawlCandidate,
  "sourceType" | "primaryUrl" | "transcriptUrl" | "audioUrl"
>;

/**
 * Collect a usable transcript for a candidate WITHOUT touching the DB, so it is
 * unit-testable in isolation. Strategy per source type:
 *   - youtube: caption track first; if absent, extract the audio stream
 *     server-side (yt-dlp-equivalent) and run STT — only flag when BOTH fail.
 *   - article/podcast: scrape a published transcript first.
 *   - podcast w/o transcript: resolve the episode page / RSS to a direct audio
 *     enclosure.
 *   - any resolved audio: transcribe via ElevenLabs Scribe.
 *
 * Returns the transcript plus a `resolvedAudioUrl` the caller should persist
 * (null when nothing new was resolved). Throws with an operator-facing message
 * when no usable transcript could be produced.
 */
export async function collectTranscript(cand: CollectableCandidate): Promise<{
  transcript: string;
  transcriptAvailable: boolean;
  resolvedAudioUrl: string | null;
}> {
  let transcript: string | null = null;
  let transcriptAvailable = false;
  let audioUrl = cand.audioUrl;
  let resolvedAudioUrl: string | null = null;

  // YouTube: caption track first (no download). If the video has no captions,
  // fall back to server-side audio extraction → STT before giving up, so
  // caption-less talks are still transcribed.
  if (cand.sourceType === "youtube") {
    const captions = await fetchYouTubeTranscript(cand.primaryUrl);
    if (captions && captions.trim().length >= MIN_TRANSCRIPT_CHARS) {
      transcript = captions;
      transcriptAvailable = true;
    } else {
      const extracted = await resolveYouTubeAudioUrl(cand.primaryUrl);
      if (!extracted) {
        throw new Error(
          "No captions are available for this YouTube video and its audio could not be extracted for transcription. Paste a transcript page URL or a direct audio (mp3) link instead.",
        );
      }
      audioUrl = extracted;
      resolvedAudioUrl = extracted;
    }
  }

  // Prefer a published transcript: scrape the page (or an explicit transcript
  // URL) to markdown and use it if it's substantial.
  const scrapeTarget = cand.transcriptUrl ?? cand.primaryUrl;
  if (
    !transcript &&
    (cand.sourceType === "article" || cand.sourceType === "podcast")
  ) {
    const md = await scrapeMarkdown(scrapeTarget);
    if (md && md.length >= 400) {
      transcript = md;
      transcriptAvailable = true;
    }
  }

  // Podcast with no published transcript: resolve the episode page (or its RSS
  // feed) to a direct audio enclosure so we can transcribe the bytes.
  if (!transcript && !audioUrl && cand.sourceType === "podcast") {
    const resolved = await resolvePodcastAudioUrl(cand.primaryUrl);
    if (resolved) {
      audioUrl = resolved;
      resolvedAudioUrl = resolved;
    }
  }

  // Fall back to audio transcription via ElevenLabs Scribe (covers resolved
  // podcast enclosures AND extracted YouTube audio streams).
  if (!transcript && audioUrl) {
    transcript = await transcribeAudioUrl(audioUrl);
    transcriptAvailable = true;
  }

  if (!transcript || transcript.trim().length < MIN_TRANSCRIPT_CHARS) {
    throw new Error(
      "Could not collect a usable transcript (no published transcript found and no audio could be resolved to transcribe).",
    );
  }

  return { transcript, transcriptAvailable, resolvedAudioUrl };
}

export async function processCandidate(
  cand: CrawlCandidate,
  ctx: {
    facultyUserId: number;
    pillarId: number;
    speakerName: string;
    rightsBasis: SourceRightsBasis;
  },
): Promise<void> {
  // Final guard at the single ingestion chokepoint: if an operator discarded
  // this candidate (the orchestrator loop and the retry path both flow through
  // here), never collect, ingest, or draft it. The `fetching` flip is gated on
  // the candidate NOT already being discarded so a discard that lands mid-run
  // is not silently overwritten.
  const flipped = await db
    .update(crawlCandidatesTable)
    .set({ status: "fetching" })
    .where(
      and(
        eq(crawlCandidatesTable.id, cand.id),
        ne(crawlCandidatesTable.status, "discarded"),
      ),
    )
    .returning({ id: crawlCandidatesTable.id });
  if (flipped.length === 0) return;

  const { transcript, transcriptAvailable, resolvedAudioUrl } =
    await collectTranscript(cand);

  // Persist any newly resolved/extracted audio URL for operator observability.
  if (resolvedAudioUrl && resolvedAudioUrl !== cand.audioUrl) {
    await db
      .update(crawlCandidatesTable)
      .set({ audioUrl: resolvedAudioUrl })
      .where(eq(crawlCandidatesTable.id, cand.id));
  }

  await db
    .update(crawlCandidatesTable)
    .set({ status: "transcribed", transcript, transcriptAvailable })
    .where(eq(crawlCandidatesTable.id, cand.id));

  // ----- Ingest as a citable `talk` source (shared pipeline) -----
  const talkYear = yearFromText(cand.talkDate) ?? yearFromText(cand.title);
  const ingest = await ingestSource({
    pillarId: ctx.pillarId,
    uploadedByUserId: ctx.facultyUserId,
    fullText: transcript,
    fallbackTitle: cand.title,
    meta: {
      kind: "talk",
      title: cand.title,
      // Mirror talk metadata into the standard citation fields so the
      // existing provenance/citation rendering works with zero changes.
      authors: ctx.speakerName,
      journal: cand.eventName ?? null,
      year: talkYear,
      sourceUrl: cand.primaryUrl,
      // Structured originals preserved on dedicated columns.
      speakerFacultyUserId: ctx.facultyUserId,
      speakerName: ctx.speakerName,
      eventName: cand.eventName ?? null,
      talkDate: cand.talkDate ?? null,
      rightsBasis: ctx.rightsBasis,
    },
  });
  // Attach the candidate before any AI draft or interpretation row is created.
  // If a steward acts unusually quickly (or a worker is interrupted), the
  // final rights purge still finds and removes this retained crawl transcript.
  await db
    .update(crawlCandidatesTable)
    .set({ sourceId: ingest.source.id })
    .where(eq(crawlCandidatesTable.id, cand.id));

  // ----- Auto-draft a PROPOSED interpretation into the steward queue -----
  let seed = `Auto-drafted from a talk by ${ctx.speakerName}. Steward: review and edit before approving.`;
  let aiDraftSnapshot: string | null = null;
  try {
    const { draft } = await generateInterpretationDraft({
      sourceId: ingest.source.id,
      question: cand.title,
    });
    if (draft) {
      seed = draft;
      aiDraftSnapshot = draft.startsWith(AI_DRAFT_PREFIX)
        ? draft.slice(AI_DRAFT_PREFIX.length)
        : draft;
    }
  } catch (err) {
    logger.warn(
      { err, sourceId: ingest.source.id },
      "Failed to AI-draft interpretation for talk; using placeholder",
    );
  }

  const [interp] = await db
    .insert(interpretationsTable)
    .values({
      sourceId: ingest.source.id,
      pillarId: ctx.pillarId,
      authorId: ctx.facultyUserId,
      status: "proposed",
      answer: cand.title,
      interpretation: seed,
      aiDraft: aiDraftSnapshot,
    })
    .returning();

  await db
    .update(crawlCandidatesTable)
    .set({
      status: "ingested",
      sourceId: ingest.source.id,
      interpretationId: interp!.id,
    })
    .where(eq(crawlCandidatesTable.id, cand.id));
}

/**
 * Re-run collection for a single failed candidate (operator action). Resets the
 * candidate and re-processes it in the background using its run's context.
 * Refuses when the candidate is already ingested or still in flight.
 */
export async function retryCandidate(
  candidateId: number,
): Promise<{ ok: boolean; reason?: string }> {
  const [cand] = await db
    .select()
    .from(crawlCandidatesTable)
    .where(eq(crawlCandidatesTable.id, candidateId))
    .limit(1);
  if (!cand) return { ok: false, reason: "not_found" };
  if (cand.status === "ingested")
    return { ok: false, reason: "This appearance was already ingested." };
  if (cand.status === "fetching")
    return { ok: false, reason: "This appearance is still being collected." };

  const [run] = await db
    .select()
    .from(crawlRunsTable)
    .where(eq(crawlRunsTable.id, cand.crawlRunId))
    .limit(1);
  if (!run) return { ok: false, reason: "not_found" };
  if (!run.rightsBasis) {
    return {
      ok: false,
      reason:
        "Record a full-text rights basis before retrying this legacy crawl.",
    };
  }

  await db
    .update(crawlCandidatesTable)
    .set({ status: "discovered", error: null })
    .where(eq(crawlCandidatesTable.id, candidateId));

  const ctx = {
    facultyUserId: run.facultyUserId,
    pillarId: run.pillarId,
    speakerName: run.speakerName,
    rightsBasis: run.rightsBasis,
  };
  void processCandidate({ ...cand, status: "discovered", error: null }, ctx).catch(
    async (err) => {
      logger.warn({ err, candidateId }, "Talk candidate retry failed");
      await db
        .update(crawlCandidatesTable)
        .set({
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        })
        .where(eq(crawlCandidatesTable.id, candidateId));
    },
  );
  return { ok: true };
}

/**
 * Discard a discovered/failed candidate so it never gets ingested (operator
 * action). Ingested candidates can't be discarded — their drafted
 * interpretation must be handled in the steward queue instead.
 */
export async function discardCandidate(
  candidateId: number,
): Promise<{ ok: boolean; reason?: string }> {
  const [cand] = await db
    .select({ id: crawlCandidatesTable.id, status: crawlCandidatesTable.status })
    .from(crawlCandidatesTable)
    .where(eq(crawlCandidatesTable.id, candidateId))
    .limit(1);
  if (!cand) return { ok: false, reason: "not_found" };
  if (cand.status === "ingested")
    return {
      ok: false,
      reason:
        "This appearance was already ingested; remove its drafted interpretation in the steward queue instead.",
    };

  await db
    .update(crawlCandidatesTable)
    .set({ status: "discarded", error: null })
    .where(eq(crawlCandidatesTable.id, candidateId));
  return { ok: true };
}

/** Resolve a faculty member's display name for the run snapshot. */
export async function facultyDisplayName(
  facultyUserId: number,
): Promise<string | null> {
  const [row] = await db
    .select({ fullName: facultyUsersTable.fullName })
    .from(facultyUsersTable)
    .where(eq(facultyUsersTable.id, facultyUserId))
    .limit(1);
  return row?.fullName ?? null;
}
