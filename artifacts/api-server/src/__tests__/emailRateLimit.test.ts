import { afterAll, beforeAll, beforeEach, describe, test, expect, vi } from "vitest";

vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-email-rate-limit-secret";
});

// Stub the email senders so allowed requests never touch Resend or the DB
// audit table — this suite is only about the request-rate throttle.
vi.mock("../lib/consumerEmail.js", () => ({
  sendConsumerMagicLink: async () => {},
}));
vi.mock("../lib/storyEmail.js", () => ({
  sendStoryMagicLink: async () => {},
  sendStoryInvite: async () => {},
}));
vi.mock("../lib/investorEmail.js", () => ({
  sendInvestorMagicLink: async () => {},
}));

import type { Express } from "express";
import request from "supertest";
import { ensureCaptureLoopSchema } from "./testHelpers.js";
import {
  __resetEmailRateLimitForTests,
  pruneStaleEmailRateLimitHits,
} from "../middlewares/emailRateLimit.js";
import pool from "../lib/db.js";

let app: Express;

beforeAll(async () => {
  await ensureCaptureLoopSchema();
  app = (await import("../app.js")).default;
});

beforeEach(async () => {
  await __resetEmailRateLimitForTests();
});

afterAll(async () => {
  await __resetEmailRateLimitForTests();
});

/**
 * The per-IP cap is 5 / 15 min. Because supertest opens a fresh socket per
 * request, set an explicit X-Forwarded-For so each test pins its own IP bucket
 * and tests don't bleed into each other. (app.ts sets `trust proxy`, so this is
 * the client IP Express sees.)
 */
function post(path: string, ip: string, body: Record<string, unknown>) {
  return request(app)
    .post(path)
    .set("X-Forwarded-For", ip)
    .send(body);
}

describe("emailRateLimit — per-IP throttle", () => {
  test("throttles /consumer/auth/request after the per-IP cap, returning 429", async () => {
    const ip = "203.0.113.10";
    // 5 distinct emails from one IP — stays under the per-email cap so only the
    // per-IP cap can trip.
    for (let i = 0; i < 5; i++) {
      const res = await post("/api/consumer/auth/request", ip, {
        email: `ip-test-${i}@test.local`,
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    }
    const blocked = await post("/api/consumer/auth/request", ip, {
      email: "ip-test-final@test.local",
    });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe("rate_limited");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });

  test("a different IP is unaffected by another IP's throttle", async () => {
    const busyIp = "203.0.113.20";
    for (let i = 0; i < 6; i++) {
      await post("/api/consumer/auth/request", busyIp, {
        email: `busy-${i}@test.local`,
      });
    }
    const other = await post("/api/consumer/auth/request", "203.0.113.21", {
      email: "fresh@test.local",
    });
    expect(other.status).toBe(200);
  });
});

describe("emailRateLimit — per-email throttle", () => {
  test("throttles a single target email after the tighter per-email cap", async () => {
    const email = "victim@test.local";
    // Spread across IPs so the per-IP cap never trips first; only the per-email
    // cap (3) can trigger the 429.
    const r1 = await post("/api/consumer/auth/request", "198.51.100.1", { email });
    const r2 = await post("/api/consumer/auth/request", "198.51.100.2", { email });
    const r3 = await post("/api/consumer/auth/request", "198.51.100.3", { email });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);

    const blocked = await post("/api/consumer/auth/request", "198.51.100.4", {
      email,
    });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe("rate_limited");
  });
});

describe("emailRateLimit — concurrency safety", () => {
  test("parallel requests from one IP never exceed the per-IP cap", async () => {
    // Fire many requests at once from a single IP with distinct emails (so only
    // the per-IP cap can trip). Without an atomic per-bucket decision, concurrent
    // requests all read the same pre-insert count and overshoot the cap — this is
    // the exact bypass that breaks once the server scales past one instance.
    const ip = "203.0.113.99";
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        post("/api/consumer/auth/request", ip, {
          email: `conc-${i}@test.local`,
        }),
      ),
    );
    const ok = results.filter((r) => r.status === 200).length;
    const blocked = results.filter((r) => r.status === 429).length;
    // Exactly the per-IP cap (5) get through; the rest are throttled.
    expect(ok).toBe(5);
    expect(blocked).toBe(N - 5);
  });

  test("parallel requests for one target email never exceed the per-email cap", async () => {
    // Same target email, spread across distinct IPs so only the per-email cap (3)
    // can trip, all fired concurrently.
    const email = "concurrent-victim@test.local";
    const N = 15;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        post("/api/consumer/auth/request", `198.51.100.${100 + i}`, { email }),
      ),
    );
    const ok = results.filter((r) => r.status === 200).length;
    expect(ok).toBe(3);
  });
});

describe("pruneStaleEmailRateLimitHits — periodic sweep", () => {
  async function insertHit(scope: string, key: string, ageMinutes: number) {
    await pool.query(
      `INSERT INTO email_rate_limit_hits (scope, key, hit_at)
       VALUES ($1, $2, NOW() - ($3 || ' minutes')::interval)`,
      [scope, key, String(ageMinutes)],
    );
  }

  async function count(): Promise<number> {
    const { rows } = await pool.query<{ cnt: string }>(
      `SELECT count(*) AS cnt FROM email_rate_limit_hits`,
    );
    return Number(rows[0]?.cnt ?? 0);
  }

  test("deletes rows older than the 15-minute window but keeps fresh ones", async () => {
    // Two rows aged well past the window (one from a bucket that never came
    // back, exactly the leak this sweep cleans up) and one fresh row.
    await insertHit("ip", "stale-bucket-a", 20);
    await insertHit("email", "stale-bucket-b", 60);
    await insertHit("ip", "fresh-bucket", 1);

    await pruneStaleEmailRateLimitHits();

    const { rows } = await pool.query<{ scope: string; key: string }>(
      `SELECT scope, key FROM email_rate_limit_hits`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scope: "ip", key: "fresh-bucket" });
  });

  test("is idempotent — a second sweep with nothing stale is a no-op", async () => {
    await insertHit("ip", "old", 30);
    await pruneStaleEmailRateLimitHits();
    expect(await count()).toBe(0);
    // Running again must not throw and must leave the table untouched.
    await pruneStaleEmailRateLimitHits();
    expect(await count()).toBe(0);
  });
});

describe("emailRateLimit — non-existence-leaking", () => {
  test("throttle response is identical for allowlisted and unknown story editors", async () => {
    // /stories-auth/request returns generic {ok:true} for both known and unknown
    // emails. The throttle must not change that: a 429 reveals only request rate.
    const ip = "192.0.2.50";
    for (let i = 0; i < 5; i++) {
      const res = await post("/api/stories-auth/request", ip, {
        email: `unknown-${i}@test.local`,
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    }
    const blocked = await post("/api/stories-auth/request", ip, {
      email: "still-unknown@test.local",
    });
    // 429 is purely about rate; it carries no account-existence signal.
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe("rate_limited");
    expect(blocked.body).not.toHaveProperty("ok");
  });
});
