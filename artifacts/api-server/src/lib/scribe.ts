import { ReplitConnectors } from "@replit/connectors-sdk";
import { logger } from "./logger.js";

/**
 * ElevenLabs Scribe speech-to-text for the talk-crawl pipeline (Task #168).
 *
 * Reuses the same Replit-managed ElevenLabs connector as the TTS route
 * (`/v1/text-to-speech`), so no extra API key is required — the connector
 * supplies credentials. We POST the audio bytes as multipart to
 * `/v1/speech-to-text` with `model_id = scribe_v1` and read back the
 * transcript text.
 */
const connectors = new ReplitConnectors();

const SCRIBE_MODEL = "scribe_v1";

/** Cap downloaded audio so a runaway feed can't exhaust memory. */
const MAX_AUDIO_BYTES = 80 * 1024 * 1024; // 80 MB

export class TranscriptionError extends Error {}

/**
 * Download an audio URL and transcribe it via ElevenLabs Scribe. Throws
 * `TranscriptionError` with a human-readable message on any failure so the
 * crawl worker can record it on the candidate row and surface it in the UI.
 */
export async function transcribeAudioUrl(audioUrl: string): Promise<string> {
  let bytes: ArrayBuffer;
  try {
    const audioRes = await fetch(audioUrl, { redirect: "follow" });
    if (!audioRes.ok) {
      throw new TranscriptionError(
        `Could not download audio (${audioRes.status})`,
      );
    }
    const lenHeader = audioRes.headers.get("content-length");
    if (lenHeader && Number(lenHeader) > MAX_AUDIO_BYTES) {
      throw new TranscriptionError(
        `Audio too large to transcribe (${Math.round(Number(lenHeader) / 1e6)} MB)`,
      );
    }
    bytes = await audioRes.arrayBuffer();
  } catch (err) {
    if (err instanceof TranscriptionError) throw err;
    throw new TranscriptionError(
      `Failed to download audio: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (bytes.byteLength === 0) {
    throw new TranscriptionError("Downloaded audio was empty");
  }

  return transcribeAudioBytes(bytes);
}

/**
 * Transcribe raw audio bytes (any container ElevenLabs Scribe accepts —
 * webm/opus, mp4/aac, mp3, wav ...) via the Replit-managed ElevenLabs
 * connector. Shared by the talk-crawl URL path above and live microphone upload routes. Throws `TranscriptionError`
 * with a human-readable message on any failure.
 */
export async function transcribeAudioBytes(
  bytes: ArrayBuffer | Buffer,
): Promise<string> {
  const byteLength =
    bytes instanceof ArrayBuffer ? bytes.byteLength : bytes.length;
  if (byteLength === 0) {
    throw new TranscriptionError("Audio was empty");
  }
  if (byteLength > MAX_AUDIO_BYTES) {
    throw new TranscriptionError("Audio too large to transcribe");
  }

  const payload =
    bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes);

  try {
    const form = new FormData();
    form.append("model_id", SCRIBE_MODEL);
    form.append(
      "file",
      new Blob([payload], { type: "application/octet-stream" }),
      "talk-audio",
    );
    // Note: do NOT set Content-Type — fetch/FormData sets the multipart
    // boundary header automatically.
    //
    // Credential path: the Replit-managed ElevenLabs connector key is
    // TTS-only (speech-to-text 401s with missing_permissions), so when the
    // owner's own key is present we call the ElevenLabs API directly.
    // Resolve the env var per-call, never at module scope.
    const ownKey = process.env.ELEVENLABS_API_KEY?.trim();
    const res = ownKey
      ? await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
          method: "POST",
          headers: { "xi-api-key": ownKey },
          body: form,
        })
      : await connectors.proxy("elevenlabs", "/v1/speech-to-text", {
          method: "POST",
          body: form,
        });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, body: body.slice(0, 500) },
        "ElevenLabs Scribe STT failed",
      );
      throw new TranscriptionError(
        `Transcription service error (${res.status})`,
      );
    }
    const json = (await res.json()) as { text?: string };
    const text = (json.text ?? "").trim();
    if (!text) throw new TranscriptionError("Transcription returned no text");
    return text;
  } catch (err) {
    if (err instanceof TranscriptionError) throw err;
    throw new TranscriptionError(
      `Transcription failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
