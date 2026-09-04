/**
 * Journey Pass — auto-renewing $49-every-90-days subscription.
 *
 * Covers the new subscription-backed journey model:
 *  - GET /api/journey/status reports active for a live 90-day subscription
 *    current_period_end and renewing = !cancel_at_period_end.
 *  - Legacy one-time journey_passes rows are still honored until expiry.
 *  - POST /api/journey/complete still completes legacy rows (Stripe cancel is
 *    exercised only when a Stripe client is connected — degraded here).
 *  - listActiveSubscriptionsForCustomer exposes intervalCount so /account can
 *    label the plan "every 90 days" rather than "/ day".
 */
import { afterAll, beforeAll, describe, test, expect, vi } from "vitest";

vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-journey-subscription-secret";
});

import type { Express } from "express";
import request from "supertest";
import { createHmac } from "node:crypto";
import pool from "../lib/db.js";
import { listActiveSubscriptionsForCustomer } from "../lib/consumerAuth.js";

let app: Express;
const stamp = `jny${Date.now().toString(36)}`;

// ── Stripe schema seeding (mirrors accountAllAccess.test.ts) ────────────────
let stripeUsesRawData = false;
async function ensureStripeSchema(): Promise<void> {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS stripe`);
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'stripe' AND table_name = 'products'
       AND column_name = '_raw_data' LIMIT 1`,
  );
  stripeUsesRawData = rows.length > 0;
  if (stripeUsesRawData) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS stripe.products (
    id TEXT PRIMARY KEY,
    name TEXT,
    description TEXT,
    active BOOLEAN,
    metadata JSONB
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS stripe.prices (
    id TEXT PRIMARY KEY,
    product TEXT,
    active BOOLEAN,
    type TEXT,
    unit_amount INTEGER,
    currency TEXT,
    recurring JSONB
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS stripe.subscriptions (
    id TEXT PRIMARY KEY,
    customer TEXT,
    status TEXT
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS stripe.subscription_items (
    id TEXT PRIMARY KEY,
    subscription TEXT,
    price TEXT
  )`);
  // Columns the journey status query reads; another suite may have created the
  // plain-column tables without them.
  await pool.query(
    `ALTER TABLE stripe.prices ADD COLUMN IF NOT EXISTS lookup_key TEXT`,
  );
  await pool.query(
    `ALTER TABLE stripe.prices ADD COLUMN IF NOT EXISTS metadata JSONB`,
  );
  await pool.query(
    `ALTER TABLE stripe.subscriptions ADD COLUMN IF NOT EXISTS current_period_end BIGINT`,
  );
  await pool.query(
    `ALTER TABLE stripe.subscriptions ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN`,
  );
  await pool.query(
    `ALTER TABLE stripe.subscriptions ADD COLUMN IF NOT EXISTS created BIGINT`,
  );
}

async function cleanupSeededStripe(): Promise<void> {
  for (const table of [
    "subscription_items",
    "subscriptions",
    "prices",
    "products",
  ]) {
    await pool.query(`DELETE FROM stripe.${table} WHERE id LIKE $1`, [
      `%${stamp}%`,
    ]);
  }
}

async function ensureStripeAccountId(): Promise<string> {
  const found = await pool.query(`SELECT id FROM stripe.accounts LIMIT 1`);
  if (found.rows[0]) return found.rows[0].id as string;
  const ins = await pool.query(
    `INSERT INTO stripe.accounts (_raw_data, _last_synced_at, _updated_at)
     VALUES ($1::jsonb, now(), now()) RETURNING id`,
    [JSON.stringify({ id: "acct_test", object: "account" })],
  );
  return ins.rows[0].id as string;
}

/** Seed one journey subscription (recurring 90-day price with a lookup key). */
async function seedJourneySubscription(opts: {
  key: string;
  customer: string;
  planKey: string;
  lookupKey: string;
  currentPeriodEnd: number;
  cancelAtPeriodEnd?: boolean;
}): Promise<void> {
  const {
    key,
    customer,
    planKey,
    lookupKey,
    currentPeriodEnd,
    cancelAtPeriodEnd = false,
  } = opts;
  const prodId = `prod_${key}`;
  const priceId = `price_${key}`;
  const subId = `sub_${key}`;
  const siId = `si_${key}`;
  const price = {
    id: priceId,
    object: "price",
    product: prodId,
    active: true,
    type: "recurring",
    unit_amount: 4900,
    currency: "usd",
    lookup_key: lookupKey,
    recurring: { interval: "day", interval_count: 90 },
    metadata: { palonur_plan: planKey, hidden: "true", journey: "true" },
  };
  const sub = {
    id: subId,
    object: "subscription",
    customer,
    status: "active",
    current_period_end: currentPeriodEnd,
    cancel_at_period_end: cancelAtPeriodEnd,
    created: Math.floor(Date.now() / 1000),
  };
  if (stripeUsesRawData) {
    const accountId = await ensureStripeAccountId();
    await pool.query(
      `INSERT INTO stripe.products (_account_id, _raw_data) VALUES ($1, $2::jsonb)`,
      [
        accountId,
        JSON.stringify({
          id: prodId,
          object: "product",
          name: `Plan ${planKey}`,
          active: true,
          metadata: { palonur_plan: planKey },
        }),
      ],
    );
    await pool.query(
      `INSERT INTO stripe.prices (_account_id, _raw_data) VALUES ($1, $2::jsonb)`,
      [accountId, JSON.stringify(price)],
    );
    await pool.query(
      `INSERT INTO stripe.subscriptions (_account_id, _raw_data) VALUES ($1, $2::jsonb)`,
      [accountId, JSON.stringify(sub)],
    );
    await pool.query(
      `INSERT INTO stripe.subscription_items (_account_id, _raw_data) VALUES ($1, $2::jsonb)`,
      [
        accountId,
        JSON.stringify({
          id: siId,
          object: "subscription_item",
          subscription: subId,
          price: priceId,
        }),
      ],
    );
    return;
  }
  await pool.query(
    `INSERT INTO stripe.products (id, name, active, metadata)
     VALUES ($1,$2,true,$3::jsonb)`,
    [prodId, `Plan ${planKey}`, JSON.stringify({ palonur_plan: planKey })],
  );
  await pool.query(
    `INSERT INTO stripe.prices (id, product, active, type, unit_amount, currency, recurring, lookup_key, metadata)
     VALUES ($1,$2,true,'recurring',4900,'usd',$3::jsonb,$4,$5::jsonb)`,
    [
      priceId,
      prodId,
      JSON.stringify({ interval: "day", interval_count: 90 }),
      lookupKey,
      JSON.stringify(price.metadata),
    ],
  );
  await pool.query(
    `INSERT INTO stripe.subscriptions (id, customer, status, current_period_end, cancel_at_period_end, created)
     VALUES ($1,$2,'active',$3,$4,$5)`,
    [subId, customer, currentPeriodEnd, cancelAtPeriodEnd, sub.created],
  );
  await pool.query(
    `INSERT INTO stripe.subscription_items (id, subscription, price) VALUES ($1,$2,$3)`,
    [siId, subId, priceId],
  );
}

// ── Consumer fixtures ────────────────────────────────────────────────────────
const sleepEmail = `journey-sleep-${stamp}@test.local`;
const sleepCustomer = `cus_sleep_${stamp}`;
let sleepAccountId = 0;

const joyEmail = `journey-joy-${stamp}@test.local`;
const joyCustomer = `cus_joy_${stamp}`;
let joyAccountId = 0;

const legacyEmail = `journey-legacy-${stamp}@test.local`;
let legacyAccountId = 0;

const noneEmail = `journey-none-${stamp}@test.local`;
let noneAccountId = 0;

const periodEnd = Math.floor(Date.now() / 1000) + 60 * 24 * 60 * 60;

function consumerCookie(id: number): string {
  const val = String(id);
  const mac = createHmac("sha256", process.env.SESSION_SECRET!)
    .update(val)
    .digest("base64")
    .replace(/=+$/, "");
  return `palonur_consumer=s%3A${val}.${encodeURIComponent(mac)}`;
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for journeySubscription tests");
  }
  await ensureStripeSchema();
  await cleanupSeededStripe();

  await pool.query(`CREATE TABLE IF NOT EXISTS consumer_accounts (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    stripe_customer_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  // Tests import app.js, so boot-time DDL never runs — provision journey_passes.
  await pool.query(`CREATE TABLE IF NOT EXISTS journey_passes (
    id SERIAL PRIMARY KEY,
    consumer_account_id INTEGER NOT NULL,
    product TEXT NOT NULL,
    stripe_session_id TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'active',
    expires_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  app = (await import("../app.js")).default;

  const mkAccount = async (
    email: string,
    customer: string | null,
  ): Promise<number> => {
    const r = await pool.query<{ id: number }>(
      `INSERT INTO consumer_accounts (email, stripe_customer_id)
       VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id
       RETURNING id`,
      [email, customer],
    );
    return r.rows[0].id;
  };
  sleepAccountId = await mkAccount(sleepEmail, sleepCustomer);
  joyAccountId = await mkAccount(joyEmail, joyCustomer);
  legacyAccountId = await mkAccount(legacyEmail, null);
  noneAccountId = await mkAccount(noneEmail, null);

  await seedJourneySubscription({
    key: `slp_${stamp}`,
    customer: sleepCustomer,
    planKey: "premium",
    lookupKey: "journey-sleep-90d",
    currentPeriodEnd: periodEnd,
  });

  // Legacy one-time pass, still active.
  await pool.query(
    `INSERT INTO journey_passes (consumer_account_id, product, stripe_session_id, status, expires_at)
     VALUES ($1, 'sleep', $2, 'active', NOW() + INTERVAL '30 days')`,
    [legacyAccountId, `cs_legacy_${stamp}`],
  );
});

afterAll(async () => {
  await pool.query(
    `DELETE FROM journey_passes WHERE consumer_account_id = ANY($1::int[])`,
    [[sleepAccountId, joyAccountId, legacyAccountId, noneAccountId]],
  );
  await pool.query(`DELETE FROM consumer_accounts WHERE id = ANY($1::int[])`, [
    [sleepAccountId, joyAccountId, legacyAccountId, noneAccountId],
  ]);
  await cleanupSeededStripe();
});

describe("GET /api/journey/status — subscription-backed passes", () => {
  test("active 90-day subscription on the premium product maps to sleep", async () => {
    const res = await request(app)
      .get("/api/journey/status")
      .set("Cookie", consumerCookie(sleepAccountId));
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(true);
    expect(res.body.product).toBe("sleep");
    expect(res.body.renewing).toBe(true);
    expect(new Date(res.body.expiresAt).getTime()).toBe(periodEnd * 1000);
  });

  test("legacy one-time pass is still honored", async () => {
    const res = await request(app)
      .get("/api/journey/status")
      .set("Cookie", consumerCookie(legacyAccountId));
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(true);
    expect(res.body.product).toBe("sleep");
    expect(res.body.renewing).toBe(false);
  });

  test("no pass at all reports inactive", async () => {
    const res = await request(app)
      .get("/api/journey/status")
      .set("Cookie", consumerCookie(noneAccountId));
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
  });

  test("anonymous callers get active:false", async () => {
    const res = await request(app).get("/api/journey/status");
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
  });
});

describe("POST /api/journey/complete", () => {
  test("completes a legacy one-time pass", async () => {
    const res = await request(app)
      .post("/api/journey/complete")
      .set("Cookie", consumerCookie(legacyAccountId));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const row = await pool.query(
      `SELECT status FROM journey_passes WHERE consumer_account_id = $1`,
      [legacyAccountId],
    );
    expect(row.rows[0].status).toBe("completed");

    const after = await request(app)
      .get("/api/journey/status")
      .set("Cookie", consumerCookie(legacyAccountId));
    expect(after.body.active).toBe(false);
  });

  test("requires authentication", async () => {
    const res = await request(app).post("/api/journey/complete");
    expect(res.status).toBe(401);
  });
});

describe("subscription entitlement plumbing", () => {
  test("the journey subscription rides the normal capability path (premium → nightly)", async () => {
    const subs = await listActiveSubscriptionsForCustomer(sleepCustomer);
    const journey = subs.find((s) => s.palonurPlan === "premium");
    expect(journey).toBeDefined();
    expect(journey!.interval).toBe("day");
    expect(journey!.intervalCount).toBe(90);
    expect(journey!.unitAmount).toBe(4900);
  });
});
