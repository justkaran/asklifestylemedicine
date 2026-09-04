import { afterAll, beforeAll, describe, test, expect, vi } from "vitest";

vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-consumer-session-secret";
});

// Capture magic links instead of sending email.
const sentLinks: { to: string; token: string; next?: string }[] = [];
vi.mock("../lib/consumerEmail.js", () => ({
  sendConsumerMagicLink: async (args: {
    to: string;
    token: string;
    next?: string;
  }) => {
    sentLinks.push(args);
  },
}));

import type { Express } from "express";
import request from "supertest";
import pool from "../lib/db.js";

let app: Express;
const stamp = Date.now().toString(36);
const email = `session-${stamp}@test.local`;

/** Pull a Set-Cookie entry by name out of a supertest response. */
function setCookie(res: request.Response, name: string): string | undefined {
  const raw = res.headers["set-cookie"];
  if (!raw) return undefined;
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.find((c) => c.startsWith(`${name}=`));
}

/** Max-Age (seconds) from a Set-Cookie string, or null. */
function maxAgeOf(cookie: string): number | null {
  const m = /max-age=(\d+)/i.exec(cookie);
  return m ? Number(m[1]) : null;
}

beforeAll(async () => {
  // Self-provision the consumer tables (tests import app.ts, not index.ts, so
  // the boot-time migrate() never runs). Idempotent.
  await pool.query(`CREATE TABLE IF NOT EXISTS consumer_accounts (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    stripe_customer_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS consumer_login_tokens (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    magic_token TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  app = (await import("../app.js")).default;
});

afterAll(async () => {
  await pool.query(`DELETE FROM consumer_login_tokens WHERE email = $1`, [
    email,
  ]);
  await pool.query(`DELETE FROM consumer_accounts WHERE email = $1`, [email]);
});

describe("consumer session lifecycle (sign in until logout)", () => {
  let sessionCookie = "";

  test("auth request forwards a validated next path to the magic link", async () => {
    sentLinks.length = 0;
    const res = await request(app)
      .post("/api/consumer/auth/request")
      .set("X-Forwarded-For", "192.0.2.61")
      .send({ email, next: "/account" });
    expect(res.status).toBe(200);
    expect(sentLinks).toHaveLength(1);
    expect(sentLinks[0]?.next).toBe("/account");
  });

  test("auth request rejects an external next URL", async () => {
    const res = await request(app)
      .post("/api/consumer/auth/request")
      .set("X-Forwarded-For", "192.0.2.62")
      .send({ email, next: "https://evil.example/phish" });
    expect(res.status).toBe(400);
  });

  test("consuming the link sets a long-lived (until-logout) session cookie", async () => {
    const token = sentLinks[0]!.token;
    const res = await request(app)
      .get(`/api/consumer/auth/consume?token=${token}`)
      .set("X-Forwarded-For", "192.0.2.63");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toContain("no-store");
    const cookie = setCookie(res, "palonur_consumer");
    expect(cookie).toBeDefined();
    // ~400 days, the browser maximum — effectively "until logout".
    const maxAge = maxAgeOf(cookie!);
    expect(maxAge).toBeGreaterThan(365 * 24 * 60 * 60);
    sessionCookie = cookie!.split(";")[0];
  });

  test("an authenticated request slides the session window forward", async () => {
    const res = await request(app)
      .get("/api/consumer/me")
      .set("Cookie", sessionCookie);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.body.authenticated).toBe(true);
    expect(res.body.email).toBe(email);
    const renewed = setCookie(res, "palonur_consumer");
    expect(renewed).toBeDefined();
    expect(maxAgeOf(renewed!)).toBeGreaterThan(365 * 24 * 60 * 60);
  });

  test("a request without a session cookie gets no renewal cookie", async () => {
    const res = await request(app).get("/api/consumer/me");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.body.authenticated).toBe(false);
    expect(setCookie(res, "palonur_consumer")).toBeUndefined();
  });

  test("logout clears the cookie and is not raced by the sliding renewal", async () => {
    const res = await request(app)
      .post("/api/consumer/auth/logout")
      .set("Cookie", sessionCookie);
    expect(res.status).toBe(200);
    const cookie = setCookie(res, "palonur_consumer");
    // The only Set-Cookie must be the clearing one (empty value / expired).
    expect(cookie).toBeDefined();
    expect(cookie!.startsWith("palonur_consumer=;")).toBe(true);
  });

  test("a used or unknown token never signs anyone in", async () => {
    const token = sentLinks[0]!.token;
    const reuse = await request(app).get(
      `/api/consumer/auth/consume?token=${token}`,
    );
    expect(reuse.status).toBe(400);
    expect(setCookie(reuse, "palonur_consumer")).toBeUndefined();
  });
});
