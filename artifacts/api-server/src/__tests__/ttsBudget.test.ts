import { beforeAll, beforeEach, describe, test, expect, vi } from "vitest";

/**
 * POST /api/tts — per-IP daily allowance + text-length cap.
 *
 * The Listen endpoint is unauthenticated and every call costs ElevenLabs
 * credits, so it enforces an in-memory per-IP per-UTC-day budget keyed on
 * req.ip (trust proxy = 1 app-wide) and rejects oversized bodies. ElevenLabs
 * is mocked at the connector boundary, so no real audio is made.
 */

const proxyCalls = vi.hoisted(() => [] as Array<{ path: string; text: string }>);

vi.mock("@replit/connectors-sdk", () => {
  class ReplitConnectors {
    async proxy(_connector: string, path: string, opts: { body: string }) {
      const { text } = JSON.parse(opts.body) as { text: string };
      proxyCalls.push({ path, text });
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      };
    }
  }
  return { ReplitConnectors };
});

// Must be set BEFORE the route module loads (limit is read at module scope).
process.env.TTS_DAILY_IP_LIMIT = "3";

import type { Express } from "express";
import request from "supertest";

let app: Express;

beforeAll(async () => {
  app = (await import("../app.js")).default;
});

beforeEach(() => {
  proxyCalls.length = 0;
});

// Distinct per-test IPs so daily counters never bleed between tests.
let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

function post(ip: string, text: string) {
  return request(app)
    .post("/api/tts")
    .set("X-Forwarded-For", ip)
    .send({ text });
}

describe("POST /api/tts budget", () => {
  test("serves audio under the limit, then 429s over it", async () => {
    const ip = freshIp();
    for (let i = 0; i < 3; i++) {
      const res = await post(ip, `hello world ${i}`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("audio/mpeg");
    }
    const over = await post(ip, "one too many");
    expect(over.status).toBe(429);
    expect(over.body.error).toMatch(/limit/i);
    // The over-limit request never reached ElevenLabs.
    expect(proxyCalls).toHaveLength(3);
  });

  test("budget is per-IP: a different IP is unaffected", async () => {
    const exhausted = freshIp();
    for (let i = 0; i < 4; i++) await post(exhausted, "spend it all");
    const other = await post(freshIp(), "fresh caller");
    expect(other.status).toBe(200);
  });

  test("rejects oversized text without spending budget or credits", async () => {
    const ip = freshIp();
    const res = await post(ip, "a".repeat(5001));
    expect(res.status).toBe(413);
    expect(proxyCalls).toHaveLength(0);
    // A normal request from the same IP still works.
    const ok = await post(ip, "normal length");
    expect(ok.status).toBe(200);
  });
});
