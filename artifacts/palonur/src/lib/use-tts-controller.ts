import { useRef, useState } from "react";

const API_BASE = "/api";

/**
 * Encapsulates the TTS play/stop lifecycle with a generation-counter guard that
 * prevents a stale in-flight fetch from playing over a newer answer when
 * questions arrive quickly.
 *
 * Invariant: stopAudio() increments the generation counter synchronously;
 * playText() captures the counter value AFTER that increment and bails before
 * touching the audio element if the counter has advanced since capture.
 */
export function useTtsController() {
  const [speaking, setSpeaking] = useState(false);
  const [ttsLoading, setTtsLoading] = useState(false);
  // Human-readable reason the last playText attempt failed (e.g. the daily
  // listen limit). Cleared when a new attempt starts, so a successful play
  // never shows a stale message.
  const [ttsError, setTtsError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ttsGenerationRef = useRef(0);

  function stopAudio() {
    ttsGenerationRef.current += 1;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    setSpeaking(false);
    setTtsLoading(false);
  }

  async function playText(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    stopAudio();
    setTtsError(null);
    const generation = ttsGenerationRef.current;
    setTtsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: trimmed }),
      });
      if (!res.ok) {
        // Surface the server's JSON error message (429 daily limit, 413
        // over-long text, 502 provider trouble) instead of failing silently.
        let message = "Audio is unavailable right now. Please try again later.";
        try {
          const data = (await res.json()) as { error?: unknown };
          if (typeof data.error === "string" && data.error.trim()) {
            message = data.error;
          }
        } catch {
          // Non-JSON body — keep the generic message.
        }
        // A stale in-flight failure must not touch state — a newer attempt
        // owns speaking/loading/error now.
        if (ttsGenerationRef.current === generation) {
          setTtsError(message);
          setSpeaking(false);
          setTtsLoading(false);
        }
        return;
      }
      const blob = await res.blob();
      if (ttsGenerationRef.current !== generation) {
        return;
      }
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      const cleanup = () => {
        URL.revokeObjectURL(url);
        setSpeaking(false);
        setTtsLoading(false);
        audioRef.current = null;
      };
      audio.onended = cleanup;
      audio.onerror = cleanup;
      setTtsLoading(false);
      setSpeaking(true);
      void audio.play();
    } catch {
      if (ttsGenerationRef.current === generation) {
        setTtsError("Audio is unavailable right now. Please try again later.");
        setSpeaking(false);
        setTtsLoading(false);
      }
    }
  }

  return { speaking, ttsLoading, ttsError, stopAudio, playText };
}
