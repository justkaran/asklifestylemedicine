/**
 * Nightly episode client-side audio engine.
 *
 * Decodes a series of voice MP3 blobs into AudioBuffers, queues them with
 * short silence gaps, and layers the show theme around them:
 *
 *   0s ──── theme entry (full volume, ~5s) ────┐
 *        hook voice starts over the music at ~2.5s
 *   5s ──── theme ducks to a quiet bed under the conversation
 *   ... voices with short gaps ...
 *   lastVoiceEnd ──── theme outro: full-volume 30s pass, fading out at the end
 *
 * Theme track: /sounds/minicast-theme.mp3 (30s). If it can't be loaded the
 * episode plays voices-only — never blocks on music.
 */

const THEME_URL = `${import.meta.env.BASE_URL}sounds/minicast-theme.mp3`;
const SILENCE_DURATION_S = 0.45;
/** Full-volume music entry length before ducking under the voices. */
const ENTRY_S = 5.0;
/** The hook line starts speaking over the entry music at this offset. */
const HOOK_START_S = 2.5;
const ENTRY_VOLUME = 0.85;
/** Quiet music bed under the conversation. */
const BED_VOLUME = 0.09;
const OUTRO_VOLUME = 0.85;
const OUTRO_RAMP_S = 1.2;
const OUTRO_FADE_S = 4.0;

/** Fetch and decode the theme track. Returns null on any failure. */
async function loadTheme(ctx: AudioContext): Promise<AudioBuffer | null> {
  try {
    const resp = await fetch(THEME_URL, { cache: "force-cache" });
    if (!resp.ok) return null;
    const ab = await resp.arrayBuffer();
    return await ctx.decodeAudioData(ab);
  } catch {
    return null;
  }
}

/** Build a silent AudioBuffer of the given duration. */
function silenceBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  return ctx.createBuffer(1, length, ctx.sampleRate);
}

export interface PlayHandle {
  stop: () => void;
  /** Promise that resolves when the episode finishes (or stop() is called). */
  done: Promise<void>;
}

/**
 * Play a full Nightly episode: theme entry → voices over a quiet bed → 30s
 * theme outro with fade.
 */
export function playSegmentsWithMusic(
  voiceBlobs: Blob[],
  onDone: () => void,
): PlayHandle {
  let stopped = false;
  let ctx: AudioContext | null = null;
  let bedSource: AudioBufferSourceNode | null = null;
  let outroSource: AudioBufferSourceNode | null = null;
  const scheduledSources: AudioBufferSourceNode[] = [];

  let resolveHandle!: () => void;
  const done = new Promise<void>((res) => {
    resolveHandle = res;
  });

  const finish = () => {
    if (!stopped) {
      stopped = true;
      onDone();
      resolveHandle();
      void ctx?.close();
    }
  };

  (async () => {
    try {
      ctx = new AudioContext();
      if (ctx.state === "suspended") await ctx.resume();

      const [theme, ...voiceBuffers] = await Promise.all([
        loadTheme(ctx),
        ...voiceBlobs.map((b) => b.arrayBuffer().then((ab) => ctx!.decodeAudioData(ab))),
      ]);
      if (stopped) return;

      const masterOut = ctx.destination;
      const t0 = ctx.currentTime;

      let voiceStart = t0;
      let bedGain: GainNode | null = null;

      if (theme) {
        // Music bed: entry at full volume, then ducked under conversation.
        bedGain = ctx.createGain();
        bedGain.connect(masterOut);
        bedSource = ctx.createBufferSource();
        bedSource.buffer = theme;
        bedSource.loop = true;
        bedSource.connect(bedGain);
        bedSource.start(t0);

        bedGain.gain.setValueAtTime(ENTRY_VOLUME, t0);
        bedGain.gain.setValueAtTime(ENTRY_VOLUME, t0 + ENTRY_S - 1.5);
        bedGain.gain.linearRampToValueAtTime(BED_VOLUME, t0 + ENTRY_S);

        voiceStart = t0 + HOOK_START_S;
      }

      // Sequential voices with short silence gaps.
      const silence = silenceBuffer(ctx, SILENCE_DURATION_S);
      const allBuffers: AudioBuffer[] = [];
      for (let i = 0; i < voiceBuffers.length; i++) {
        allBuffers.push(voiceBuffers[i]);
        if (i < voiceBuffers.length - 1) allBuffers.push(silence);
      }

      let cursor = voiceStart;
      for (const buf of allBuffers) {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(masterOut);
        src.start(cursor);
        scheduledSources.push(src);
        cursor += buf.duration;
      }
      const lastEnd = cursor;

      let totalEnd = lastEnd;

      if (theme && bedGain) {
        // Bed fades out as the outro takes over.
        bedGain.gain.setValueAtTime(BED_VOLUME, lastEnd);
        bedGain.gain.linearRampToValueAtTime(0, lastEnd + OUTRO_RAMP_S);
        bedSource!.stop(lastEnd + OUTRO_RAMP_S + 0.1);

        // Outro: a fresh full pass of the theme (30s), fading out at the end.
        const outroGain = ctx.createGain();
        outroGain.connect(masterOut);
        outroSource = ctx.createBufferSource();
        outroSource.buffer = theme;
        outroSource.connect(outroGain);

        const outroEnd = lastEnd + theme.duration;
        outroGain.gain.setValueAtTime(0, lastEnd);
        outroGain.gain.linearRampToValueAtTime(OUTRO_VOLUME, lastEnd + OUTRO_RAMP_S);
        outroGain.gain.setValueAtTime(OUTRO_VOLUME, outroEnd - OUTRO_FADE_S);
        outroGain.gain.linearRampToValueAtTime(0, outroEnd);

        outroSource.start(lastEnd);
        totalEnd = outroEnd;

        outroSource.addEventListener("ended", finish, { once: true });
      } else {
        const last = scheduledSources[scheduledSources.length - 1];
        if (last) last.addEventListener("ended", finish, { once: true });
      }

      // Timeout fallback in case 'ended' never fires.
      const delay = Math.max(0, (totalEnd - ctx.currentTime) * 1000);
      window.setTimeout(finish, delay + 250);
    } catch {
      finish();
    }
  })();

  function stop() {
    if (stopped) return;
    stopped = true;
    for (const src of scheduledSources) {
      try { src.stop(); } catch { /* already stopped */ }
    }
    if (bedSource) { try { bedSource.stop(); } catch { /* already stopped */ } }
    if (outroSource) { try { outroSource.stop(); } catch { /* already stopped */ } }
    resolveHandle();
    void ctx?.close();
  }

  return { stop, done };
}

/**
 * Render the full episode mix (theme entry → voices over the quiet bed →
 * theme outro with fade) offline and encode it as a WAV Blob for download,
 * so the downloaded file sounds identical to in-browser playback.
 *
 * Returns null on any failure (e.g. theme missing, decode error) so callers
 * can fall back to the voices-only concatenated MP3.
 */
export async function renderEpisodeWithMusic(voiceBlobs: Blob[]): Promise<Blob | null> {
  try {
    // A tiny throwaway offline context just for decoding.
    const decodeCtx = new OfflineAudioContext(1, 1, 44100);
    const sampleRate = 44100;

    const [theme, ...voiceBuffers] = await Promise.all([
      (async () => {
        try {
          const resp = await fetch(THEME_URL, { cache: "force-cache" });
          if (!resp.ok) return null;
          return await decodeCtx.decodeAudioData(await resp.arrayBuffer());
        } catch {
          return null;
        }
      })(),
      ...voiceBlobs.map((b) => b.arrayBuffer().then((ab) => decodeCtx.decodeAudioData(ab))),
    ]);
    if (voiceBuffers.length === 0) return null;

    const voicesTotal =
      voiceBuffers.reduce((s, b) => s + b.duration, 0) +
      SILENCE_DURATION_S * Math.max(0, voiceBuffers.length - 1);

    const voiceStart = theme ? HOOK_START_S : 0;
    const lastEnd = voiceStart + voicesTotal;
    const totalEnd = theme ? lastEnd + theme.duration : lastEnd;

    const ctx = new OfflineAudioContext(
      2,
      Math.ceil(totalEnd * sampleRate) + sampleRate,
      sampleRate,
    );
    const masterOut = ctx.destination;

    if (theme) {
      // Music bed: entry at full volume, then ducked under conversation.
      const bedGain = ctx.createGain();
      bedGain.connect(masterOut);
      const bedSource = ctx.createBufferSource();
      bedSource.buffer = theme;
      bedSource.loop = true;
      bedSource.connect(bedGain);
      bedSource.start(0);

      bedGain.gain.setValueAtTime(ENTRY_VOLUME, 0);
      bedGain.gain.setValueAtTime(ENTRY_VOLUME, ENTRY_S - 1.5);
      bedGain.gain.linearRampToValueAtTime(BED_VOLUME, ENTRY_S);

      // Bed fades out as the outro takes over.
      bedGain.gain.setValueAtTime(BED_VOLUME, lastEnd);
      bedGain.gain.linearRampToValueAtTime(0, lastEnd + OUTRO_RAMP_S);
      bedSource.stop(lastEnd + OUTRO_RAMP_S + 0.1);

      // Outro: a fresh full pass of the theme, fading out at the end.
      const outroGain = ctx.createGain();
      outroGain.connect(masterOut);
      const outroSource = ctx.createBufferSource();
      outroSource.buffer = theme;
      outroSource.connect(outroGain);

      const outroEnd = lastEnd + theme.duration;
      outroGain.gain.setValueAtTime(0, lastEnd);
      outroGain.gain.linearRampToValueAtTime(OUTRO_VOLUME, lastEnd + OUTRO_RAMP_S);
      outroGain.gain.setValueAtTime(OUTRO_VOLUME, outroEnd - OUTRO_FADE_S);
      outroGain.gain.linearRampToValueAtTime(0, outroEnd);
      outroSource.start(lastEnd);
    }

    let cursor = voiceStart;
    for (let i = 0; i < voiceBuffers.length; i++) {
      const src = ctx.createBufferSource();
      src.buffer = voiceBuffers[i];
      src.connect(masterOut);
      src.start(cursor);
      cursor += voiceBuffers[i].duration;
      if (i < voiceBuffers.length - 1) cursor += SILENCE_DURATION_S;
    }

    const rendered = await ctx.startRendering();
    return audioBufferToWavBlob(rendered, totalEnd);
  } catch {
    return null;
  }
}

/** Encode an AudioBuffer as 16-bit PCM WAV, trimmed to `seconds`. */
function audioBufferToWavBlob(buffer: AudioBuffer, seconds: number): Blob {
  const numChannels = Math.min(2, buffer.numberOfChannels);
  const sampleRate = buffer.sampleRate;
  const frames = Math.min(buffer.length, Math.ceil(seconds * sampleRate));
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = frames * blockAlign;

  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch));

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const s = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: "audio/wav" });
}

/** Base64 string → Blob (audio/mpeg). Returns an empty Blob for empty input. */
export function b64ToBlob(b64: string): Blob {
  if (!b64) return new Blob([], { type: "audio/mpeg" });
  const byteChars = atob(b64);
  const byteArr = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    byteArr[i] = byteChars.charCodeAt(i);
  }
  return new Blob([byteArr], { type: "audio/mpeg" });
}

/** Concatenate an array of MP3 Blobs into one downloadable Blob. */
export function concatBlobs(blobs: Blob[]): Blob {
  return new Blob(blobs, { type: "audio/mpeg" });
}
