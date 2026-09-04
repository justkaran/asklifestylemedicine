import { describe, test, expect, vi, beforeEach } from "vitest";

// Unit tests for the talk-crawl transcript-collection step (Task #168),
// focused on the YouTube path: caption track first, then a server-side audio
// extraction → STT fallback for caption-less videos, and a clear failure when
// neither yields audio. The collaborators are mocked so no network is touched.

const media = vi.hoisted(() => ({
  fetchYouTubeTranscript: vi.fn<(url: string) => Promise<string | null>>(),
  resolveYouTubeAudioUrl: vi.fn<(url: string) => Promise<string | null>>(),
  resolvePodcastAudioUrl: vi.fn<(url: string) => Promise<string | null>>(),
}));
vi.mock("../lib/mediaResolve.js", () => media);

const scribe = vi.hoisted(() => ({
  transcribeAudioUrl: vi.fn<(url: string) => Promise<string>>(),
}));
vi.mock("../lib/scribe.js", () => scribe);

const firecrawl = vi.hoisted(() => ({
  scrapeMarkdown: vi.fn<(url: string) => Promise<string | null>>(),
  searchTalks: vi.fn(),
  isFirecrawlConfigured: () => false,
}));
vi.mock("../lib/firecrawl.js", () => firecrawl);

const LONG = "word ".repeat(80); // > 200 chars, passes the usable-length gate

import { collectTranscript } from "../lib/crawlTalks.js";

const baseCandidate = {
  sourceType: "youtube" as const,
  primaryUrl: "https://www.youtube.com/watch?v=abc123",
  transcriptUrl: null,
  audioUrl: null,
};

describe("collectTranscript — YouTube", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("uses the caption track when one exists (no audio extraction)", async () => {
    media.fetchYouTubeTranscript.mockResolvedValue(LONG);

    const result = await collectTranscript(baseCandidate);

    expect(result.transcript).toBe(LONG);
    expect(result.transcriptAvailable).toBe(true);
    expect(result.resolvedAudioUrl).toBeNull();
    expect(media.resolveYouTubeAudioUrl).not.toHaveBeenCalled();
    expect(scribe.transcribeAudioUrl).not.toHaveBeenCalled();
  });

  test("falls back to audio extraction + STT when captions are missing", async () => {
    media.fetchYouTubeTranscript.mockResolvedValue(null);
    media.resolveYouTubeAudioUrl.mockResolvedValue(
      "https://stream.googlevideo.com/audio.webm",
    );
    scribe.transcribeAudioUrl.mockResolvedValue(LONG);

    const result = await collectTranscript(baseCandidate);

    expect(media.resolveYouTubeAudioUrl).toHaveBeenCalledWith(
      baseCandidate.primaryUrl,
    );
    expect(scribe.transcribeAudioUrl).toHaveBeenCalledWith(
      "https://stream.googlevideo.com/audio.webm",
    );
    expect(result.transcript).toBe(LONG);
    expect(result.transcriptAvailable).toBe(true);
    // The extracted stream URL is surfaced so the worker can persist it.
    expect(result.resolvedAudioUrl).toBe(
      "https://stream.googlevideo.com/audio.webm",
    );
  });

  test("throws when there are neither captions nor extractable audio", async () => {
    media.fetchYouTubeTranscript.mockResolvedValue(null);
    media.resolveYouTubeAudioUrl.mockResolvedValue(null);

    await expect(collectTranscript(baseCandidate)).rejects.toThrow(
      /audio could not be extracted/i,
    );
    expect(scribe.transcribeAudioUrl).not.toHaveBeenCalled();
  });
});
