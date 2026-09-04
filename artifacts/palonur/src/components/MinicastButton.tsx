/**
 * MinicastButton — produces a two-voice podcast episode from a parsed answer
 * and plays it inline. A download icon appears once the episode is ready.
 */
import { useState, useRef, useEffect } from "react";
import {
  playSegmentsWithMusic,
  renderEpisodeWithMusic,
  b64ToBlob,
  concatBlobs,
} from "../lib/minicast-audio";
import { useToast } from "../hooks/use-toast";

const API_BASE = "/api";

interface Sections {
  answer?: string;
  finding?: string;
  action?: string;
}

interface MinicastButtonProps {
  question: string;
  sections: Sections;
  ready: boolean;
  /** Show variant. */
  show?: "nightly";
  /** Display name of the pillar or topic — used by the host in the episode intro. */
  pillar?: string;
  /** Full name of the faculty expert — used by the host to introduce and address them. */
  expert?: string;
  /** Called when episode production starts — lets the page stop other audio. */
  onStart?: () => void;
  /**
   * Optional ref the page can use to stop an in-progress episode (e.g. when
   * plain-listen playback starts). Set to null when nothing is playing.
   */
  stopRef?: React.MutableRefObject<(() => void) | null>;
}

type State = "idle" | "loading" | "playing" | "error";

/**
 * Module-level episode cache so a produced episode survives navigating away
 * from the answer page and back within the same SPA session. Bounded (LRU,
 * max entries) with a TTL so it can't grow without limit. The server also
 * caches produced episodes, so even a full reload avoids re-production cost.
 */
const EPISODE_CACHE_MAX = 6;
const EPISODE_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

const episodeCache = new Map<string, { blobs: Blob[]; at: number }>();

function episodeCacheKey(question: string, show?: string) {
  return `${show ?? "nightly"}|${question.trim()}`;
}

function getCachedEpisode(key: string): Blob[] | null {
  const entry = episodeCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > EPISODE_CACHE_TTL_MS) {
    episodeCache.delete(key);
    return null;
  }
  // Refresh LRU position.
  episodeCache.delete(key);
  episodeCache.set(key, entry);
  return entry.blobs;
}

function setCachedEpisode(key: string, blobs: Blob[]) {
  episodeCache.delete(key);
  episodeCache.set(key, { blobs, at: Date.now() });
  while (episodeCache.size > EPISODE_CACHE_MAX) {
    const oldest = episodeCache.keys().next().value;
    if (oldest === undefined) break;
    episodeCache.delete(oldest);
  }
}

export function MinicastButton({
  question,
  sections,
  ready,
  show,
  pillar,
  expert,
  onStart,
  stopRef: externalStopRef,
}: MinicastButtonProps) {
  const [state, setState] = useState<State>("idle");
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [downloadName, setDownloadName] = useState("palonur-minicast.mp3");
  const stopRef = useRef<(() => void) | null>(null);
  const dlUrlRef = useRef<string | null>(null);
  const cachedBlobsRef = useRef<Blob[] | null>(null);
  const [hasCached, setHasCached] = useState(false);
  const renderGenRef = useRef(0);
  const { toast } = useToast();

  // A new question swaps in that question's cached episode (if any) so
  // returning to a previously produced answer replays without re-production.
  useEffect(() => {
    if (dlUrlRef.current) {
      URL.revokeObjectURL(dlUrlRef.current);
      dlUrlRef.current = null;
    }
    const cached = getCachedEpisode(episodeCacheKey(question, show));
    cachedBlobsRef.current = cached;
    setHasCached(cached !== null);
    if (cached) {
      const url = URL.createObjectURL(concatBlobs(cached));
      dlUrlRef.current = url;
      setDownloadUrl(url);
    } else {
      setDownloadUrl(null);
    }
  }, [question, show]);

  function startPlayback(voiceBlobs: Blob[]) {
    setState("playing");
    const handle = playSegmentsWithMusic(voiceBlobs, () => {
      setState("idle");
      stopRef.current = null;
      if (externalStopRef) externalStopRef.current = null;
    });
    stopRef.current = handle.stop;
    if (externalStopRef) {
      externalStopRef.current = () => {
        handle.stop();
        stopRef.current = null;
        externalStopRef.current = null;
        setState("idle");
      };
    }
  }

  async function handleClick() {
    if (state === "playing") {
      stopRef.current?.();
      stopRef.current = null;
      if (externalStopRef) externalStopRef.current = null;
      setState("idle");
      return;
    }
    if (state === "loading") return;

    // Replay the cached episode — no new /api/tts/minicast call.
    if (cachedBlobsRef.current) {
      onStart?.();
      startPlayback(cachedBlobsRef.current);
      return;
    }

    onStart?.();
    setState("loading");

    try {
      const res = await fetch(`${API_BASE}/tts/minicast`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          sections,
          ...(show ? { show } : {}),
          ...(pillar ? { pillar } : {}),
          ...(expert ? { expert } : {}),
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }

      const data = (await res.json()) as {
        segments: Array<{ role: string; label: string; audio: string }>;
      };

      // Voice segments only — music is layered client-side from the theme track.
      const voiceBlobs = data.segments
        .filter((s) => s.role !== "music")
        .map((s) => b64ToBlob(s.audio));

      if (dlUrlRef.current) {
        URL.revokeObjectURL(dlUrlRef.current);
        dlUrlRef.current = null;
        setDownloadUrl(null);
      }

      // Render the full mix (music + voices) offline for download so the file
      // matches in-browser playback; fall back to voices-only concat on failure.
      const renderGen = ++renderGenRef.current;
      void renderEpisodeWithMusic(voiceBlobs).then((mixBlob) => {
        if (renderGen !== renderGenRef.current) return; // stale render
        if (dlUrlRef.current) URL.revokeObjectURL(dlUrlRef.current);
        const blob = mixBlob ?? concatBlobs(voiceBlobs);
        const url = URL.createObjectURL(blob);
        dlUrlRef.current = url;
        setDownloadName(
          mixBlob ? "palonur-minicast.wav" : "palonur-minicast.mp3",
        );
        setDownloadUrl(url);
      });

      cachedBlobsRef.current = voiceBlobs;
      setHasCached(true);
      setCachedEpisode(episodeCacheKey(question, show), voiceBlobs);

      startPlayback(voiceBlobs);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Could not produce episode";
      setState("idle");
      toast({
        variant: "destructive",
        title: "Podcast unavailable",
        description: msg,
      });
    }
  }

  const isPlaying = state === "playing";
  const isLoading = state === "loading";

  const btnStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    background: isPlaying ? "rgba(139,26,26,0.12)" : "rgba(139,26,26,0.07)",
    border: `1.5px solid ${isPlaying ? "rgba(139,26,26,0.45)" : "rgba(139,26,26,0.22)"}`,
    borderRadius: 22,
    cursor: isLoading || !ready ? "default" : "pointer",
    padding: "9px 18px",
    color: isPlaying ? "#8B1A1A" : "#6b3030",
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: ".02em",
    fontFamily: "system-ui, sans-serif",
    transition: "background .15s, border-color .15s, color .15s",
    opacity: !ready || isLoading ? 0.5 : 1,
    whiteSpace: "nowrap" as const,
  };

  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", minWidth: 240 }}
    >
      <button
        type="button"
        onClick={handleClick}
        disabled={!ready || isLoading}
        title={
          !ready
            ? "Waiting for answer…"
            : isLoading
              ? "Producing episode…"
              : isPlaying
                ? "Stop podcast"
                : hasCached
                  ? "Replay this podcast episode"
                  : "Listen as a podcast episode"
        }
        aria-label={
          isPlaying
            ? "Stop podcast"
            : hasCached
              ? "Replay podcast episode"
              : "Play as podcast episode"
        }
        style={btnStyle}
        onMouseEnter={(e) => {
          if (!isLoading && ready && !isPlaying) {
            (e.currentTarget as HTMLButtonElement).style.background =
              "rgba(139,26,26,0.13)";
            (e.currentTarget as HTMLButtonElement).style.borderColor =
              "rgba(139,26,26,0.38)";
          }
        }}
        onMouseLeave={(e) => {
          if (!isPlaying) {
            (e.currentTarget as HTMLButtonElement).style.background =
              "rgba(139,26,26,0.07)";
            (e.currentTarget as HTMLButtonElement).style.borderColor =
              "rgba(139,26,26,0.22)";
          }
        }}
      >
        {isLoading ? (
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ animation: "spin 1s linear infinite", flexShrink: 0 }}
          >
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        ) : isPlaying ? (
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flexShrink: 0 }}
          >
            <rect x="6" y="4" width="4" height="16" />
            <rect x="14" y="4" width="4" height="16" />
          </svg>
        ) : (
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flexShrink: 0 }}
          >
            <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2z" />
            <polygon
              points="10 8 16 12 10 16 10 8"
              fill="currentColor"
              stroke="none"
            />
          </svg>
        )}
        <span>
          {isLoading
            ? "Producing…"
            : isPlaying
              ? "Stop"
              : hasCached
                ? "Replay"
                : "Listen as Podcast"}
        </span>
      </button>

      {downloadUrl && !isLoading && (
        <a
          href={downloadUrl}
          download={downloadName}
          title="Download this podcast episode"
          style={{
            display: "inline-flex",
            alignItems: "center",
            color: "#bbb",
            padding: "6px 8px",
            borderRadius: 8,
            textDecoration: "none",
            transition: "color .15s",
            marginLeft: "auto",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "#8B1A1A";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "#bbb";
          }}
          aria-label="Download podcast episode"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </a>
      )}
    </span>
  );
}
