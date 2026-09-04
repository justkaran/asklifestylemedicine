import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  test,
  expect,
  vi,
} from "vitest";

/**
 * POST /api/tts/minicast — show variant coverage.
 *
 * Verifies voice selection and script branding for the two show variants:
 *   - default / "nightly": pinned Nightly expert voice, Nightly-branded script
 *
 * ElevenLabs is mocked at the connector boundary, so no real audio is made.
 */

// Captures every ElevenLabs call: { path, text }.
const proxyCalls = vi.hoisted(
  () => [] as Array<{ path: string; text: string }>,
);
// When set, calls to this voice id fail with the given status.
const failVoice = vi.hoisted(() => ({ id: "", status: 0 }));

vi.mock("@replit/connectors-sdk", () => {
  class ReplitConnectors {
    async proxy(_connector: string, path: string, opts: { body: string }) {
      const { text } = JSON.parse(opts.body) as { text: string };
      proxyCalls.push({ path, text });
      const voiceId = path.split("/").pop() ?? "";
      if (failVoice.id && voiceId === failVoice.id) {
        return {
          ok: false,
          status: failVoice.status,
          text: async () =>
            JSON.stringify({ detail: { status: "voice_not_found" } }),
        };
      }
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      };
    }
  }
  return { ReplitConnectors };
});

import type { Express } from "express";
import request from "supertest";

const ARIA = "S8fvCTNkUyToiumExm4N"; // female expert voice — both fallback + Nightly expert
const SARAH = ARIA; // alias kept so fallback-path assertions still read clearly
const NIGHTLY = ARIA; // pinned Nightly expert voice

let app: Express;
const prevMinicastLimitEnv = process.env.MINICAST_DAILY_IP_LIMIT;

// The per-IP daily episode allowance is read at module load. Set it high
// enough that the functional tests (all from the same supertest IP) never
// trip it; the dedicated allowance tests below use their own forwarded IPs.
const MINICAST_LIMIT = 30;

beforeAll(async () => {
  process.env.MINICAST_DAILY_IP_LIMIT = String(MINICAST_LIMIT);
  app = (await import("../app.js")).default;
});

afterAll(() => {
  if (prevMinicastLimitEnv === undefined)
    delete process.env.MINICAST_DAILY_IP_LIMIT;
  else process.env.MINICAST_DAILY_IP_LIMIT = prevMinicastLimitEnv;
});

beforeEach(() => {
  proxyCalls.length = 0;
  failVoice.id = "";
  failVoice.status = 0;
});

// Produced episodes are cached server-side (keyed by question+sections+show),
// so each test uses a unique question to get a fresh production run.
let uniqueCounter = 0;
function freshBody() {
  uniqueCounter += 1;
  return {
    question: `How do I stay connected as I get older? (case ${uniqueCounter})`,
    sections: {
      answer: "Connection is a practice, not an accident.",
      finding: "Loneliness research shows small weekly rituals matter.",
      action: "Call one person you care about this week.",
    },
  };
}

function expertVoices() {
  // The expert turns are every call not made to the host voice (George).
  const hostVoice = "JBFqnCBsd6RMkjVDRZzb";
  return proxyCalls
    .map((c) => c.path.split("/").pop() ?? "")
    .filter((v) => v !== hostVoice);
}

function allText() {
  return proxyCalls.map((c) => c.text).join(" ");
}

describe("POST /api/tts/minicast — Nightly default", () => {
  test("no show param keeps the pinned Nightly expert voice and Nightly script", async () => {
    const res = await request(app).post("/api/tts/minicast").send(freshBody());
    expect(res.status).toBe(200);
    expect(res.body.segments).toHaveLength(10);

    const voices = new Set(expertVoices());
    expect(voices).toEqual(new Set([NIGHTLY]));

    const text = allText();
    expect(text).toContain("Welcome to Pal");
    expect(text).toContain("Sleep well tonight");

    // The hook opens with the listener's question, and the welcome carries
    // the Palonur production credit + poses the exact question to the expert.
    // (proxyCalls order is not deterministic under the concurrency pool, so
    // find the turns by content.)
    const hook = proxyCalls.find((c) =>
      c.text.startsWith("Tonight a listener wants to know:"),
    );
    expect(hook).toBeDefined();
    const welcome = proxyCalls.find((c) => c.text.includes("Welcome to Pal"));
    expect(welcome).toBeDefined();
    expect(welcome!.text).toContain(
      "produced by Palonur, where you get vetted answers from scientists",
    );
    expect(welcome!.text).toContain(
      "let me put our listener's exact question to you",
    );
  });
});

describe("POST /api/tts/minicast — single-language episodes", () => {
  function germanBody(extra = "") {
    uniqueCounter += 1;
    return {
      question: `Warum wache ich jede Nacht um drei Uhr auf?${extra} (Fall ${uniqueCounter})`,
      sections: {
        answer:
          "Ihr Körper folgt einem inneren Rhythmus, und kurzes Aufwachen in der Nacht ist völlig normal und kein Grund zur Sorge.",
        finding:
          "Die Forschung zeigt, dass kurze nächtliche Wachphasen Teil eines gesunden Schlafzyklus sind.",
        action:
          "Bleiben Sie ruhig liegen, schauen Sie nicht auf die Uhr und stehen Sie erst auf, wenn Sie länger als zwanzig Minuten wach sind.",
      },
    };
  }

  test("German answer content produces an all-German Nightly script", async () => {
    const res = await request(app).post("/api/tts/minicast").send(germanBody());
    expect(res.status).toBe(200);
    expect(res.body.segments).toHaveLength(10);

    const text = allText();
    // Every host line is German — no English framing anywhere.
    expect(text).toContain("Willkommen bei Pal");
    expect(text).toContain("Schlafen Sie gut heute Nacht");
    expect(text).not.toContain("Welcome to");
    expect(text).not.toContain("That's such a good question");
    expect(text).not.toContain("Stay with us");
    const hook = proxyCalls.find((c) =>
      c.text.startsWith("Heute Nacht möchte ein Hörer wissen:"),
    );
    expect(hook).toBeDefined();
  });

  test("English content keeps a fully English script (no German lines)", async () => {
    const res = await request(app).post("/api/tts/minicast").send(freshBody());
    expect(res.status).toBe(200);

    const text = allText();
    expect(text).toContain("Welcome to Pal");
    expect(text).not.toContain("Willkommen");
  });
});

describe("POST /api/tts/minicast — episode cache", () => {
  test("repeating the same request replays the cached episode without new ElevenLabs calls", async () => {
    const body = freshBody();

    const res1 = await request(app).post("/api/tts/minicast").send(body);
    expect(res1.status).toBe(200);
    expect(res1.body.segments).toHaveLength(10);
    expect(proxyCalls.length).toBe(10);

    proxyCalls.length = 0;
    const res2 = await request(app).post("/api/tts/minicast").send(body);
    expect(res2.status).toBe(200);
    expect(proxyCalls.length).toBe(0);
    expect(res2.body.segments).toEqual(res1.body.segments);
  });

  test("a different question is a cache miss and produces fresh audio", async () => {
    const body = freshBody();
    await request(app).post("/api/tts/minicast").send(body);

    proxyCalls.length = 0;
    const res = await request(app)
      .post("/api/tts/minicast")
      .send({ ...body, question: `${body.question} (variation)` });
    expect(res.status).toBe(200);
    expect(proxyCalls.length).toBe(10);
  });
});

describe("POST /api/tts/minicast — per-IP daily episode allowance", () => {
  // trust proxy = 1 is set app-wide, and supertest connects from loopback
  // (a trusted hop), so X-Forwarded-For controls req.ip in tests. The real
  // endpoint keys on req.ip only — clients behind the proxy can't spoof it.
  const LIMITED_IP = "203.0.113.9";
  const OTHER_IP = "203.0.113.77";

  test("over-limit fresh episodes get 429, cache replays stay free, other IPs unaffected", async () => {
    const bodies: Array<ReturnType<typeof freshBody>> = [];
    for (let i = 0; i < MINICAST_LIMIT; i++) {
      const body = freshBody();
      bodies.push(body);
      const res = await request(app)
        .post("/api/tts/minicast")
        .set("X-Forwarded-For", LIMITED_IP)
        .send(body);
      expect(res.status).toBe(200);
    }

    // The next FRESH episode from the same IP is rejected with a clear error.
    proxyCalls.length = 0;
    const over = await request(app)
      .post("/api/tts/minicast")
      .set("X-Forwarded-For", LIMITED_IP)
      .send(freshBody());
    expect(over.status).toBe(429);
    expect(over.body.error).toMatch(/daily episode limit/i);
    // No ElevenLabs calls were made for the rejected request.
    expect(proxyCalls.length).toBe(0);

    // Cache hits do NOT spend the allowance: replaying an already-produced
    // episode still works even though the IP is out of fresh-episode budget.
    proxyCalls.length = 0;
    const replay = await request(app)
      .post("/api/tts/minicast")
      .set("X-Forwarded-For", LIMITED_IP)
      .send(bodies[bodies.length - 1]);
    expect(replay.status).toBe(200);
    expect(replay.body.segments).toHaveLength(10);
    expect(proxyCalls.length).toBe(0);

    // A different IP still has its own allowance.
    const other = await request(app)
      .post("/api/tts/minicast")
      .set("X-Forwarded-For", OTHER_IP)
      .send(freshBody());
    expect(other.status).toBe(200);
  });
});
