import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock the connectors SDK so no real proxy call happens.
const proxyMock = vi.hoisted(() => vi.fn());
vi.mock("@replit/connectors-sdk", () => ({
  ReplitConnectors: class {
    proxy = proxyMock;
  },
}));

import { transcribeAudioBytes, TranscriptionError } from "../lib/scribe.js";

const AUDIO = new Uint8Array([1, 2, 3, 4]).buffer;

function okResponse(text: string): Response {
  return new Response(JSON.stringify({ text }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("scribe credential-path selection", () => {
  const originalKey = process.env.ELEVENLABS_API_KEY;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    proxyMock.mockReset();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (originalKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = originalKey;
  });

  test("uses the owner's key directly against api.elevenlabs.io when set", async () => {
    process.env.ELEVENLABS_API_KEY = "own-key-123";
    fetchSpy.mockResolvedValue(okResponse("hello from own key"));

    const text = await transcribeAudioBytes(AUDIO);

    expect(text).toBe("hello from own key");
    expect(proxyMock).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe(
      "own-key-123",
    );
    expect(init.method).toBe("POST");
  });

  test("falls back to the managed connector when the env var is unset", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    proxyMock.mockResolvedValue(okResponse("hello from connector"));

    const text = await transcribeAudioBytes(AUDIO);

    expect(text).toBe("hello from connector");
    expect(proxyMock).toHaveBeenCalledTimes(1);
    expect(proxyMock.mock.calls[0][0]).toBe("elevenlabs");
    expect(proxyMock.mock.calls[0][1]).toBe("/v1/speech-to-text");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("blank env var is treated as unset (connector path)", async () => {
    process.env.ELEVENLABS_API_KEY = "   ";
    proxyMock.mockResolvedValue(okResponse("connector again"));

    const text = await transcribeAudioBytes(AUDIO);

    expect(text).toBe("connector again");
    expect(proxyMock).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("non-OK response from the direct path surfaces a TranscriptionError", async () => {
    process.env.ELEVENLABS_API_KEY = "own-key-123";
    fetchSpy.mockResolvedValue(
      new Response("nope", { status: 401 }),
    );

    await expect(transcribeAudioBytes(AUDIO)).rejects.toThrow(
      TranscriptionError,
    );
    await expect(
      transcribeAudioBytes(AUDIO),
    ).rejects.toThrow(/Transcription service error \(401\)/);
  });
});
