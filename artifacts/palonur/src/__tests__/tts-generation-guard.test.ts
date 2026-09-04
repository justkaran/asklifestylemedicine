import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Regression guard for the TTS generation-counter in useTtsController
//// imports and uses directly. The non-negotiables:
//
//   - When a second question arrives while the first TTS fetch is still in
//     flight, the first fetch result is DISCARDED — its Audio is never
//     constructed and never played.
//   - Only the most-recently-submitted question's audio plays.
//   - stopAudio() prevents any stale in-flight result from sneaking through,
//     even after a partial race.
//   - The generation counter is captured AFTER stopAudio() increments it,
//     so concurrent in-flight fetches always see a stale value.
//
// Tests drive the real hook via renderHook and mock fetch + Audio so that
// assertions observe actual side-effects of the production code.
// ---------------------------------------------------------------------------

import { useTtsController } from "../lib/use-tts-controller.js";

// Controlled promise pair: resolve/reject externally to simulate in-flight delay.
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeBlob() {
  return new Blob(["audio-data"], { type: "audio/mpeg" });
}

function okResponse(blob = makeBlob()) {
  return new Response(blob, { status: 200 });
}

interface AudioSpy {
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  src: string;
}

let audioInstances: AudioSpy[];
let AudioMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  audioInstances = [];
  AudioMock = vi.fn(() => {
    const inst: AudioSpy = {
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
      onended: null,
      onerror: null,
      src: "",
    };
    audioInstances.push(inst);
    return inst;
  });
  vi.stubGlobal("Audio", AudioMock);
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:fake-url"),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useTtsController — generation-counter guard", () => {
  test("single question: plays audio and sets speaking=true", async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(okResponse()));
    vi.stubGlobal("fetch", fetchSpy);

    const { result } = renderHook(() => useTtsController());

    await act(async () => {
      await result.current.playText("How do I sleep better?");
    });

    expect(audioInstances).toHaveLength(1);
    expect(audioInstances[0].play).toHaveBeenCalledTimes(1);
    expect(result.current.speaking).toBe(true);
    expect(result.current.ttsLoading).toBe(false);
  });

  test("second question cancels first in-flight fetch — first Audio never constructed", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();

    const calls: Array<() => Promise<Response>> = [
      () => first.promise,
      () => second.promise,
    ];
    let callIndex = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => calls[callIndex++]()),
    );

    const { result } = renderHook(() => useTtsController());

    let p1: Promise<void>;
    let p2: Promise<void>;

    act(() => {
      p1 = result.current.playText("First question");
    });
    act(() => {
      p2 = result.current.playText("Second question");
    });

    await act(async () => {
      second.resolve(okResponse());
      await p2!;
    });

    await act(async () => {
      first.resolve(okResponse());
      await p1!;
    });

    // Only the second question's audio was ever constructed.
    expect(audioInstances).toHaveLength(1);
    expect(audioInstances[0].play).toHaveBeenCalledTimes(1);
    expect(result.current.speaking).toBe(true);
  });

  test("three rapid questions — only the last one plays", async () => {
    const d1 = deferred<Response>();
    const d2 = deferred<Response>();
    const d3 = deferred<Response>();

    const calls = [() => d1.promise, () => d2.promise, () => d3.promise];
    let ci = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => calls[ci++]()),
    );

    const { result } = renderHook(() => useTtsController());

    let p1: Promise<void>, p2: Promise<void>, p3: Promise<void>;
    act(() => {
      p1 = result.current.playText("Q1");
    });
    act(() => {
      p2 = result.current.playText("Q2");
    });
    act(() => {
      p3 = result.current.playText("Q3");
    });

    await act(async () => {
      d3.resolve(okResponse());
      await p3!;
    });
    await act(async () => {
      d2.resolve(okResponse());
      await p2!;
    });
    await act(async () => {
      d1.resolve(okResponse());
      await p1!;
    });

    expect(audioInstances).toHaveLength(1);
    expect(audioInstances[0].play).toHaveBeenCalledTimes(1);
  });

  test("stopAudio() mid-fetch prevents in-flight result from playing", async () => {
    const d = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => d.promise),
    );

    const { result } = renderHook(() => useTtsController());

    let p: Promise<void>;
    act(() => {
      p = result.current.playText("Some question");
    });

    act(() => {
      result.current.stopAudio();
    });

    await act(async () => {
      d.resolve(okResponse());
      await p!;
    });

    expect(audioInstances).toHaveLength(0);
    expect(result.current.speaking).toBe(false);
  });

  test("failed TTS fetch does not corrupt the generation counter for the next ask", async () => {
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        callCount++;
        if (callCount === 1)
          return Promise.resolve(new Response(null, { status: 500 }));
        return Promise.resolve(okResponse());
      }),
    );

    const { result } = renderHook(() => useTtsController());

    await act(async () => {
      await result.current.playText("Question");
    });

    expect(audioInstances).toHaveLength(0);
    expect(result.current.speaking).toBe(false);

    await act(async () => {
      await result.current.playText("Follow-up");
    });

    expect(audioInstances).toHaveLength(1);
    expect(audioInstances[0].play).toHaveBeenCalledTimes(1);
  });

  test("empty text is a no-op — fetch never called, generation counter unchanged", async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(okResponse()));
    vi.stubGlobal("fetch", fetchSpy);

    const { result } = renderHook(() => useTtsController());

    await act(async () => {
      await result.current.playText("   ");
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(audioInstances).toHaveLength(0);

    await act(async () => {
      await result.current.playText("Real question");
    });

    expect(audioInstances).toHaveLength(1);
    expect(audioInstances[0].play).toHaveBeenCalledTimes(1);
  });

  test("generation captured AFTER stopAudio ensures concurrent fetches see a stale counter", async () => {
    // If playText captured generation BEFORE the internal stopAudio call, a
    // concurrent in-flight fetch from the previous call would read its own
    // (now-matching) value and slip through. This test fails if ordering is wrong.
    const d1 = deferred<Response>();
    const d2 = deferred<Response>();
    const calls = [() => d1.promise, () => d2.promise];
    let ci = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => calls[ci++]()),
    );

    const { result } = renderHook(() => useTtsController());

    let p1: Promise<void>, p2: Promise<void>;
    act(() => {
      p1 = result.current.playText("First");
    });
    act(() => {
      p2 = result.current.playText("Second");
    });

    await act(async () => {
      d1.resolve(okResponse());
      d2.resolve(okResponse());
      await Promise.all([p1!, p2!]);
    });

    // Regardless of micro-task ordering, only one Audio instance is allowed.
    expect(audioInstances).toHaveLength(1);
    expect(result.current.speaking).toBe(true);
  });
});

describe("useTtsController — honest error surfacing (ttsError)", () => {
  test("non-OK JSON response surfaces the server's error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: "Daily listen limit reached. Please try again tomorrow.",
            }),
            {
              status: 429,
              headers: { "Content-Type": "application/json" },
            },
          ),
        ),
      ),
    );

    const { result } = renderHook(() => useTtsController());
    await act(async () => {
      await result.current.playText("Question");
    });

    expect(result.current.ttsError).toBe(
      "Daily listen limit reached. Please try again tomorrow.",
    );
    expect(result.current.speaking).toBe(false);
    expect(result.current.ttsLoading).toBe(false);
    expect(audioInstances).toHaveLength(0);
  });

  test("non-OK non-JSON response falls back to a generic message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("nope", { status: 502 }))),
    );

    const { result } = renderHook(() => useTtsController());
    await act(async () => {
      await result.current.playText("Question");
    });

    expect(result.current.ttsError).toBe(
      "Audio is unavailable right now. Please try again later.",
    );
  });

  test("network failure sets the generic message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down"))),
    );

    const { result } = renderHook(() => useTtsController());
    await act(async () => {
      await result.current.playText("Question");
    });

    expect(result.current.ttsError).toBe(
      "Audio is unavailable right now. Please try again later.",
    );
  });

  test("error clears on the next successful play", async () => {
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ error: "Text is too long to read aloud" }),
              {
                status: 413,
                headers: { "Content-Type": "application/json" },
              },
            ),
          );
        }
        return Promise.resolve(okResponse());
      }),
    );

    const { result } = renderHook(() => useTtsController());
    await act(async () => {
      await result.current.playText("Long text");
    });
    expect(result.current.ttsError).toBe("Text is too long to read aloud");

    await act(async () => {
      await result.current.playText("Short text");
    });
    expect(result.current.ttsError).toBeNull();
    expect(result.current.speaking).toBe(true);
    expect(audioInstances).toHaveLength(1);
  });

  test("stale in-flight failure never overwrites the newer attempt's state", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const calls = [() => first.promise, () => second.promise];
    let ci = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => calls[ci++]()),
    );

    const { result } = renderHook(() => useTtsController());

    let p1: Promise<void>, p2: Promise<void>;
    act(() => {
      p1 = result.current.playText("First");
    });
    act(() => {
      p2 = result.current.playText("Second");
    });

    await act(async () => {
      second.resolve(okResponse());
      await p2!;
    });
    await act(async () => {
      first.resolve(
        new Response(JSON.stringify({ error: "Daily listen limit reached." }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        }),
      );
      await p1!;
    });

    // The stale 429 must not surface an error over the successful newer play.
    expect(result.current.ttsError).toBeNull();
    expect(result.current.speaking).toBe(true);
  });
});
