import { beforeAll, beforeEach, afterAll, describe, test, expect } from "vitest";
import express from "express";
import type { Express } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { createHash, createHmac, randomBytes } from "node:crypto";
import pool from "../lib/db.js";
import {
  partnerKeyMiddleware,
  __resetPartnerKeyCountersForTests,
} from "../middlewares/partnerKey.js";

async function ensurePartnerKeysSchema(): Promise<void> {
  await pool.query(`DO $$ BEGIN
    CREATE TYPE partner_key_tier AS ENUM ('pilot','production');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  await pool.query(`DO $$ BEGIN
    CREATE TYPE partner_key_origin AS ENUM ('granted','paid');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  await pool.query(`DO $$ BEGIN
    CREATE TYPE partner_key_billing AS ENUM ('none','subscription','credits');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  await pool.query(`CREATE TABLE IF NOT EXISTS partner_keys (
    id SERIAL PRIMARY KEY,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    partner_name TEXT NOT NULL,
    contact_email TEXT,
    scopes TEXT[] NOT NULL DEFAULT ARRAY['sleep-agent']::text[],
    tier partner_key_tier NOT NULL DEFAULT 'pilot',
    rate_per_minute INTEGER NOT NULL DEFAULT 60,
    rate_per_day INTEGER NOT NULL DEFAULT 50000,
    concurrent_streams INTEGER NOT NULL DEFAULT 10,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ
  )`);
  // The payment columns post-date the original table; self-provision them so
  // this suite (which builds its own express app and never runs index.ts boot
  // DDL) passes even on a dev DB that predates the gate. See
  // .agents/memory/api-server-test-schema.md.
  await pool.query(
    `ALTER TABLE partner_keys
       ADD COLUMN IF NOT EXISTS origin partner_key_origin NOT NULL DEFAULT 'granted',
       ADD COLUMN IF NOT EXISTS requires_payment BOOLEAN NOT NULL DEFAULT false,
       ADD COLUMN IF NOT EXISTS billing_mode partner_key_billing NOT NULL DEFAULT 'none',
       ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
       ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT,
       ADD COLUMN IF NOT EXISTS credits_total INTEGER,
       ADD COLUMN IF NOT EXISTS credits_used INTEGER NOT NULL DEFAULT 0`,
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS partner_key_payments (
    id SERIAL PRIMARY KEY,
    partner_key_id INTEGER NOT NULL REFERENCES partner_keys(id) ON DELETE CASCADE,
    stripe_session_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    credits_added INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}

interface InsertedKey {
  id: number;
  raw: string;
}

async function insertPartnerKey(opts: {
  partnerName: string;
  scopes?: string[];
  ratePerMinute?: number;
  ratePerDay?: number;
  concurrentStreams?: number;
  revoked?: boolean;
  requiresPayment?: boolean;
  billingMode?: "none" | "subscription" | "credits";
  stripeSubscriptionId?: string | null;
  creditsTotal?: number | null;
  creditsUsed?: number;
}): Promise<InsertedKey> {
  const raw = `plnr_test_${randomBytes(16).toString("hex")}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  const prefix = raw.slice(0, 14);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO partner_keys
       (key_hash, key_prefix, partner_name, scopes, tier,
        rate_per_minute, rate_per_day, concurrent_streams, revoked_at,
        requires_payment, billing_mode, stripe_subscription_id,
        credits_total, credits_used)
     VALUES ($1, $2, $3, $4, 'pilot', $5, $6, $7, $8,
        $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      hash,
      prefix,
      opts.partnerName,
      opts.scopes ?? ["sleep-agent"],
      opts.ratePerMinute ?? 60,
      opts.ratePerDay ?? 50_000,
      opts.concurrentStreams ?? 10,
      opts.revoked ? new Date() : null,
      opts.requiresPayment ?? false,
      opts.billingMode ?? "none",
      opts.stripeSubscriptionId ?? null,
      opts.creditsTotal ?? null,
      opts.creditsUsed ?? 0,
    ],
  );
  return { id: rows[0].id, raw };
}

const pendingReleases: Array<() => void> = [];

// Mirror app.ts: cookie-parser (signed with SESSION_SECRET) runs before the
// partner-key middleware, so the admin-bypass check can read signedCookies.
const COOKIE_SECRET = "test-partner-key-secret";

function adminCookie(): string {
  const mac = createHmac("sha256", COOKIE_SECRET)
    .update("1")
    .digest("base64")
    .replace(/=+$/, "");
  return `palonur_admin=s%3A1.${encodeURIComponent(mac)}`;
}

function makeApp(): Express {
  const app = express();
  app.set("trust proxy", 1);
  app.use(cookieParser(COOKIE_SECRET));
  // Pure programmatic endpoint — every request needs a key (no first-party
  // bypass). This is the /api/agent/query posture.
  app.get(
    "/api/sleep-agent",
    partnerKeyMiddleware("sleep-agent"),
    (_req, res) => {
      res.status(200).json({ ok: true });
    },
  );
  app.get(
    "/api/sleep-agent-hang",
    partnerKeyMiddleware("sleep-agent"),
    (_req, res) => {
      pendingReleases.push(() => {
        res.status(200).json({ ok: true });
      });
    },
  );
  // Consumer-facing endpoint — first-party browsers without a key fall through
  // to the (downstream) paywall, subject to the anonymous IP cap. This is the
  // /api/sleep-agent posture.
  app.get(
    "/api/sleep-agent-fp",
    partnerKeyMiddleware("sleep-agent", { allowFirstPartyHuman: true }),
    (_req, res) => {
      res.status(200).json({ ok: true });
    },
  );
  return app;
}

function flushHangingResponses(): void {
  while (pendingReleases.length > 0) {
    const fn = pendingReleases.shift();
    fn?.();
  }
}

let app: Express;
const insertedKeyIds: number[] = [];

beforeAll(async () => {
  await ensurePartnerKeysSchema();
  app = makeApp();
});

beforeEach(() => {
  __resetPartnerKeyCountersForTests();
});

afterAll(async () => {
  if (insertedKeyIds.length > 0) {
    await pool.query(`DELETE FROM partner_keys WHERE id = ANY($1::int[])`, [
      insertedKeyIds,
    ]);
  }
});

describe("partnerKeyMiddleware", () => {
  test("valid key passes through", async () => {
    const key = await insertPartnerKey({ partnerName: "valid-partner" });
    insertedKeyIds.push(key.id);

    const res = await request(app)
      .get("/api/sleep-agent")
      .set("X-Palonur-Key", key.raw);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test("revoked key → 401", async () => {
    const key = await insertPartnerKey({
      partnerName: "revoked-partner",
      revoked: true,
    });
    insertedKeyIds.push(key.id);

    const res = await request(app)
      .get("/api/sleep-agent")
      .set("X-Palonur-Key", key.raw);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "revoked_key" });
  });

  test("unknown key → 401", async () => {
    const res = await request(app)
      .get("/api/sleep-agent")
      .set("X-Palonur-Key", `plnr_test_${randomBytes(16).toString("hex")}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "invalid_key" });
  });

  test("per-minute cap → 429 with Retry-After", async () => {
    const key = await insertPartnerKey({
      partnerName: "per-minute-partner",
      ratePerMinute: 2,
    });
    insertedKeyIds.push(key.id);

    const ok1 = await request(app)
      .get("/api/sleep-agent")
      .set("X-Palonur-Key", key.raw);
    expect(ok1.status).toBe(200);

    const ok2 = await request(app)
      .get("/api/sleep-agent")
      .set("X-Palonur-Key", key.raw);
    expect(ok2.status).toBe(200);

    const limited = await request(app)
      .get("/api/sleep-agent")
      .set("X-Palonur-Key", key.raw);
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe("rate_limited");
    expect(limited.body.reason).toMatch(/Per-minute cap/);
    const retryAfter = Number(limited.headers["retry-after"]);
    expect(Number.isFinite(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(limited.body.retry_after).toBe(retryAfter);
  });

  test("per-day cap → 429 with Retry-After", async () => {
    const key = await insertPartnerKey({
      partnerName: "per-day-partner",
      ratePerMinute: 1000,
      ratePerDay: 2,
    });
    insertedKeyIds.push(key.id);

    const ok1 = await request(app)
      .get("/api/sleep-agent")
      .set("X-Palonur-Key", key.raw);
    expect(ok1.status).toBe(200);

    const ok2 = await request(app)
      .get("/api/sleep-agent")
      .set("X-Palonur-Key", key.raw);
    expect(ok2.status).toBe(200);

    const limited = await request(app)
      .get("/api/sleep-agent")
      .set("X-Palonur-Key", key.raw);
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe("rate_limited");
    expect(limited.body.reason).toMatch(/Daily cap/);
    const retryAfter = Number(limited.headers["retry-after"]);
    expect(Number.isFinite(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(limited.body.retry_after).toBe(retryAfter);
  });

  test("concurrent-streams cap → 429", async () => {
    const key = await insertPartnerKey({
      partnerName: "concurrent-partner",
      ratePerMinute: 1000,
      ratePerDay: 1000,
      concurrentStreams: 2,
    });
    insertedKeyIds.push(key.id);

    try {
      // Fire two requests that hang in the handler so `active` stays at 2.
      // Supertest only sends the request once `.then()` is called, so we
      // chain `.then(r => r)` to actually kick them off without awaiting.
      const p1 = request(app)
        .get("/api/sleep-agent-hang")
        .set("X-Palonur-Key", key.raw)
        .then((r) => r);
      const p2 = request(app)
        .get("/api/sleep-agent-hang")
        .set("X-Palonur-Key", key.raw)
        .then((r) => r);

      // Wait for both handlers to register their pending releases.
      const deadline = Date.now() + 2000;
      while (pendingReleases.length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(pendingReleases.length).toBe(2);

      const limited = await request(app)
        .get("/api/sleep-agent-hang")
        .set("X-Palonur-Key", key.raw);
      expect(limited.status).toBe(429);
      expect(limited.body.error).toBe("rate_limited");
      expect(limited.body.reason).toMatch(/Concurrent stream cap/);

      flushHangingResponses();
      await p1;
      await p2;
    } finally {
      flushHangingResponses();
    }
  });

  test("first-party human (no key) passes; anonymous IP cap → 429", async () => {
    // First-party = Sec-Fetch-Site: same-origin (browser-set). Default
    // ANON_LIMIT_PER_HOUR is 20. Burn through all 20, then expect the 21st to
    // be rate-limited.
    for (let i = 0; i < 20; i++) {
      const ok = await request(app)
        .get("/api/sleep-agent-fp")
        .set("Sec-Fetch-Site", "same-origin");
      expect(ok.status).toBe(200);
    }
    const limited = await request(app)
      .get("/api/sleep-agent-fp")
      .set("Sec-Fetch-Site", "same-origin");
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe("rate_limited");
    expect(limited.body.reason).toMatch(/Anonymous evaluation cap/);
    const retryAfter = Number(limited.headers["retry-after"]);
    expect(Number.isFinite(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
  });

  test("admin cookie exempts first-party requests from the anonymous IP cap", async () => {
    // 25 back-to-back asks (over the 20/hr cap) all pass with the signed
    // admin cookie present.
    for (let i = 0; i < 25; i++) {
      const ok = await request(app)
        .get("/api/sleep-agent-fp")
        .set("Sec-Fetch-Site", "same-origin")
        .set("Cookie", adminCookie());
      expect(ok.status).toBe(200);
    }
    // And the bypass never consumed the anonymous allowance: a cookie-less
    // request from the same IP still has its full 20 available.
    const anon = await request(app)
      .get("/api/sleep-agent-fp")
      .set("Sec-Fetch-Site", "same-origin");
    expect(anon.status).toBe(200);
  });

  test("forged admin cookie gets no rate-cap bypass", async () => {
    const forged = "palonur_admin=s%3A1.notarealsignature";
    for (let i = 0; i < 20; i++) {
      const ok = await request(app)
        .get("/api/sleep-agent-fp")
        .set("Sec-Fetch-Site", "same-origin")
        .set("Cookie", forged);
      expect(ok.status).toBe(200);
    }
    const limited = await request(app)
      .get("/api/sleep-agent-fp")
      .set("Sec-Fetch-Site", "same-origin")
      .set("Cookie", forged);
    expect(limited.status).toBe(429);
    expect(limited.body.reason).toMatch(/Anonymous evaluation cap/);
  });

  test("admin cookie does NOT bypass keyed programmatic gates", async () => {
    // A programmatic caller (no first-party signal) with an admin cookie but
    // no key is still rejected — the bypass only covers the anon IP cap.
    const res = await request(app)
      .get("/api/sleep-agent")
      .set("Cookie", adminCookie());
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("key_required");
  });

  test("programmatic request with no key → 401 key_required", async () => {
    // No key + no first-party signal on a pure-programmatic endpoint.
    const res = await request(app).get("/api/sleep-agent");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("key_required");
    expect(typeof res.body.license_terms).toBe("string");
  });

  test("no key on a first-party-allowed endpoint, but programmatic → 401", async () => {
    // allowFirstPartyHuman is true, but with no Sec-Fetch-Site and no
    // first-party Origin the caller is treated as programmatic → must key.
    const res = await request(app).get("/api/sleep-agent-fp");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("key_required");
  });

  test("keyed success attaches no-training license headers", async () => {
    const key = await insertPartnerKey({ partnerName: "license-partner" });
    insertedKeyIds.push(key.id);

    const res = await request(app)
      .get("/api/sleep-agent")
      .set("X-Palonur-Key", key.raw);

    expect(res.status).toBe(200);
    expect(res.headers["x-palonur-usage-policy"]).toBe("no-training");
    expect(typeof res.headers["x-palonur-license"]).toBe("string");
    expect(res.headers["x-palonur-license"]).toMatch(/\/agent-license$/);
    expect(res.headers["x-palonur-attribution"]).toMatch(/Palonur/);
  });

  test("valid key via Authorization: Bearer plnr_… passes (ChatGPT connector fallback)", async () => {
    const key = await insertPartnerKey({ partnerName: "bearer-partner" });
    insertedKeyIds.push(key.id);

    const res = await request(app)
      .get("/api/sleep-agent")
      .set("Authorization", `Bearer ${key.raw}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // Keyed success still attaches the license headers on the bearer path.
    expect(res.headers["x-palonur-usage-policy"]).toBe("no-training");
  });

  test("bearer token without the plnr_ prefix is ignored → 401 key_required", async () => {
    // e.g. an OAuth JWT — must NOT be treated as a Palonur key.
    const res = await request(app)
      .get("/api/sleep-agent")
      .set("Authorization", "Bearer eyJhbGciOiJIUzI1NiJ9.not-a-palonur-key");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("key_required");
  });

  test("malformed Authorization header (no Bearer scheme) → 401 key_required", async () => {
    const res = await request(app)
      .get("/api/sleep-agent")
      .set("Authorization", "Basic cGxucl9ub3RhYmVhcmVy");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("key_required");
  });

  test("bearer plnr_ key that doesn't exist → 401 invalid_key", async () => {
    const res = await request(app)
      .get("/api/sleep-agent")
      .set("Authorization", `Bearer plnr_test_${randomBytes(16).toString("hex")}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "invalid_key" });
  });

  test("X-Palonur-Key wins when both headers are present", async () => {
    const key = await insertPartnerKey({ partnerName: "both-headers-partner" });
    insertedKeyIds.push(key.id);

    // Valid X-Palonur-Key + garbage bearer → the header key is used, passes.
    const ok = await request(app)
      .get("/api/sleep-agent")
      .set("X-Palonur-Key", key.raw)
      .set("Authorization", `Bearer plnr_${randomBytes(16).toString("hex")}`);
    expect(ok.status).toBe(200);

    // Invalid X-Palonur-Key + VALID bearer → header still wins → invalid_key.
    const bad = await request(app)
      .get("/api/sleep-agent")
      .set("X-Palonur-Key", `plnr_test_${randomBytes(16).toString("hex")}`)
      .set("Authorization", `Bearer ${key.raw}`);
    expect(bad.status).toBe(401);
    expect(bad.body).toEqual({ error: "invalid_key" });
  });

  test("revoked key via bearer → 401 revoked_key", async () => {
    const key = await insertPartnerKey({
      partnerName: "bearer-revoked-partner",
      revoked: true,
    });
    insertedKeyIds.push(key.id);

    const res = await request(app)
      .get("/api/sleep-agent")
      .set("Authorization", `Bearer ${key.raw}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "revoked_key" });
  });

  test("subscription key with no active subscription → 402", async () => {
    const key = await insertPartnerKey({
      partnerName: "sub-inactive-partner",
      requiresPayment: true,
      billingMode: "subscription",
      stripeSubscriptionId: "sub_does_not_exist",
    });
    insertedKeyIds.push(key.id);

    const res = await request(app)
      .get("/api/sleep-agent")
      .set("X-Palonur-Key", key.raw);

    expect(res.status).toBe(402);
    expect(res.body.error).toBe("payment_required");
    expect(res.body.reason).toBe("subscription_inactive");
  });

  test("credits key burns one credit per request then 402 when exhausted", async () => {
    const key = await insertPartnerKey({
      partnerName: "credits-partner",
      requiresPayment: true,
      billingMode: "credits",
      creditsTotal: 2,
      creditsUsed: 0,
    });
    insertedKeyIds.push(key.id);

    const ok1 = await request(app)
      .get("/api/sleep-agent")
      .set("X-Palonur-Key", key.raw);
    expect(ok1.status).toBe(200);
    const ok2 = await request(app)
      .get("/api/sleep-agent")
      .set("X-Palonur-Key", key.raw);
    expect(ok2.status).toBe(200);

    const exhausted = await request(app)
      .get("/api/sleep-agent")
      .set("X-Palonur-Key", key.raw);
    expect(exhausted.status).toBe(402);
    expect(exhausted.body.error).toBe("payment_required");
    expect(exhausted.body.reason).toBe("credits_exhausted");

    const { rows } = await pool.query<{ credits_used: number }>(
      `SELECT credits_used FROM partner_keys WHERE id = $1`,
      [key.id],
    );
    expect(Number(rows[0].credits_used)).toBe(2);
  });

  test("requires_payment with billing_mode none → 402 billing_not_configured", async () => {
    const key = await insertPartnerKey({
      partnerName: "misconfigured-partner",
      requiresPayment: true,
      billingMode: "none",
    });
    insertedKeyIds.push(key.id);

    const res = await request(app)
      .get("/api/sleep-agent")
      .set("X-Palonur-Key", key.raw);

    expect(res.status).toBe(402);
    expect(res.body.error).toBe("payment_required");
    expect(res.body.reason).toBe("billing_not_configured");
  });
});
