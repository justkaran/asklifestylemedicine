import { afterAll, beforeAll, describe, test, expect, vi } from "vitest";

vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-sponsored-price-secret";
  process.env.BILLING_ENABLED = "true";
});

// ─── Stub the Stripe client layer ─────────────────────────────────────────
// /billing/plans reads only the synced stripe.* tables (no SDK), but checkout
// needs the SDK for lookup-key resolution, customer creation, and session
// creation — all stubbed so the test drives the shapes without hitting Stripe.
let lookupPriceId: string | null = null;
let lastSessionArgs: Record<string, unknown> | null = null;
let createdCustomers = 0;

vi.mock("../lib/stripeClient.js", () => ({
  isStripeConnected: async () => true,
  getUncachableStripeClient: async () => ({
    prices: {
      list: async (args: { lookup_keys?: string[] }) => ({
        data:
          args.lookup_keys?.[0] === "nightly-sponsored-11" && lookupPriceId
            ? [{ id: lookupPriceId }]
            : [],
      }),
    },
    customers: {
      create: async () => {
        createdCustomers += 1;
        return { id: `cus_spons_${stamp}_${createdCustomers}` };
      },
    },
    checkout: {
      sessions: {
        create: async (args: Record<string, unknown>) => {
          lastSessionArgs = args;
          return { url: "https://checkout.stripe.com/c/pay/test" };
        },
      },
    },
  }),
  getStripeSync: async () => ({ syncSingleEntity: async () => {} }),
}));

import type { Express } from "express";
import request from "supertest";
import pool from "../lib/db.js";

let app: Express;
const stamp = Date.now().toString(36);
const planKey = `spons_test_${stamp}`;
const prodId = `prod_spv_${stamp}`;
const visiblePriceId = `price_spv_vis_${stamp}`;
const hiddenPriceId = `price_spv_hid_${stamp}`;
const memberEmail = `sponsored-member-${stamp}@test.local`;

// ── Stripe schema seeding (mirrors accountAllAccess.test.ts) ────────────────
// The dev DB carries the REAL stripe-replit-sync schema where business columns
// are GENERATED from `_raw_data`; otherwise self-provision a minimal schema.
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
  // Older self-provisioned tables (from other suites) may miss these columns
  // that /billing/plans depends on (`pr.created` ordering, `pr.metadata`
  // hidden filter).
  await pool.query(
    `ALTER TABLE stripe.prices ADD COLUMN IF NOT EXISTS created INTEGER`,
  );
  await pool.query(
    `ALTER TABLE stripe.prices ADD COLUMN IF NOT EXISTS metadata JSONB`,
  );
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

async function seedCatalog(): Promise<void> {
  const productRaw = {
    id: prodId,
    object: "product",
    name: `Sponsored Test ${stamp}`,
    active: true,
    metadata: { palonur_plan: planKey },
  };
  // The hidden price is deliberately NEWER than the visible one: without the
  // hidden filter, DISTINCT ON (product, interval) would surface IT as the
  // storefront price — the exact leak this feature must prevent.
  const nowEpoch = Math.floor(Date.now() / 1000);
  const visibleRaw = {
    id: visiblePriceId,
    object: "price",
    product: prodId,
    active: true,
    type: "recurring",
    unit_amount: 900,
    currency: "usd",
    recurring: { interval: "month" },
    metadata: {},
    created: nowEpoch - 1000,
  };
  const hiddenRaw = {
    id: hiddenPriceId,
    object: "price",
    product: prodId,
    active: true,
    type: "recurring",
    unit_amount: 1100,
    currency: "usd",
    recurring: { interval: "month" },
    metadata: { hidden: "true", cohort: "sponsored-pilot" },
    created: nowEpoch,
  };
  if (stripeUsesRawData) {
    const accountId = await ensureStripeAccountId();
    await pool.query(
      `INSERT INTO stripe.products (_account_id, _raw_data) VALUES ($1, $2::jsonb)`,
      [accountId, JSON.stringify(productRaw)],
    );
    for (const raw of [visibleRaw, hiddenRaw]) {
      await pool.query(
        `INSERT INTO stripe.prices (_account_id, _raw_data) VALUES ($1, $2::jsonb)`,
        [accountId, JSON.stringify(raw)],
      );
    }
    return;
  }
  await pool.query(
    `INSERT INTO stripe.products (id, name, active, metadata)
     VALUES ($1,$2,true,$3::jsonb)`,
    [prodId, productRaw.name, JSON.stringify(productRaw.metadata)],
  );
  for (const raw of [visibleRaw, hiddenRaw]) {
    await pool.query(
      `INSERT INTO stripe.prices (id, product, active, type, unit_amount, currency, recurring, metadata, created)
       VALUES ($1,$2,true,'recurring',$3,'usd',$4::jsonb,$5::jsonb,$6)`,
      [
        raw.id,
        prodId,
        raw.unit_amount,
        JSON.stringify(raw.recurring),
        JSON.stringify(raw.metadata),
        raw.created,
      ],
    );
  }
}

beforeAll(async () => {
  // Tests import app.ts, not index.ts, so boot-time provisioning never runs.
  await pool.query(`CREATE TABLE IF NOT EXISTS consumer_accounts (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    stripe_customer_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await ensureStripeSchema();
  await seedCatalog();
  app = (await import("../app.js")).default;
});

afterAll(async () => {
  await pool.query(`DELETE FROM stripe.prices WHERE id LIKE $1`, [
    `%${stamp}%`,
  ]);
  await pool.query(`DELETE FROM stripe.products WHERE id LIKE $1`, [
    `%${stamp}%`,
  ]);
  await pool.query(`DELETE FROM consumer_accounts WHERE email LIKE $1`, [
    `%${stamp}%`,
  ]);
});

describe("GET /billing/plans — hidden prices never reach the storefront", () => {
  test("lists the visible price and excludes the newer hidden price", async () => {
    const res = await request(app).get("/api/billing/plans");
    expect(res.status).toBe(200);
    const plans = res.body.plans as { productId: string; priceId: string; unitAmount: number }[];
    const mine = plans.filter((p) => p.productId === prodId);
    // Exactly one monthly row for this product — and it is the visible $9
    // price, even though the hidden $11 price is newer (DISTINCT ON would
    // otherwise have picked the hidden one).
    expect(mine).toHaveLength(1);
    expect(mine[0]!.priceId).toBe(visiblePriceId);
    expect(mine[0]!.unitAmount).toBe(900);
    expect(plans.some((p) => p.priceId === hiddenPriceId)).toBe(false);
  });
});

describe("POST /billing/checkout — lookupKey resolution", () => {
  test("resolves a lookup key to its price and pre-links the member account", async () => {
    lookupPriceId = hiddenPriceId;
    lastSessionArgs = null;
    const res = await request(app)
      .post("/api/billing/checkout")
      .send({ email: memberEmail, lookupKey: "nightly-sponsored-11" });
    expect(res.status).toBe(200);
    expect(res.body.url).toContain("https://checkout.stripe.com/");
    // The session bills the hidden sponsored price… (read through a cast:
    // the assignment happens inside the mock, invisible to TS narrowing)
    const session = lastSessionArgs as unknown as {
      line_items: { price: string }[];
      mode: string;
      customer: string;
    } | null;
    expect(session?.line_items[0]?.price).toBe(hiddenPriceId);
    expect(session?.mode).toBe("subscription");
    // …and the member's consumer account is already linked to the Stripe
    // customer, so access resolves for THEIR email no matter who pays.
    const { rows } = await pool.query(
      `SELECT stripe_customer_id FROM consumer_accounts WHERE email = $1`,
      [memberEmail],
    );
    expect(rows[0]?.stripe_customer_id).toMatch(/^cus_spons_/);
    expect(session?.customer).toBe(rows[0]?.stripe_customer_id);
  });

  test("unknown lookup key → 404 with zero side effects", async () => {
    lookupPriceId = hiddenPriceId;
    const ghost = `ghost-${stamp}@test.local`;
    const res = await request(app)
      .post("/api/billing/checkout")
      .send({ email: ghost, lookupKey: "no-such-plan" });
    expect(res.status).toBe(404);
    const { rows } = await pool.query(
      `SELECT 1 FROM consumer_accounts WHERE email = $1`,
      [ghost],
    );
    expect(rows).toHaveLength(0);
  });

  test("rejects both priceId and lookupKey together, and neither", async () => {
    const both = await request(app)
      .post("/api/billing/checkout")
      .send({ email: memberEmail, priceId: "price_x", lookupKey: "k" });
    expect(both.status).toBe(400);
    const neither = await request(app)
      .post("/api/billing/checkout")
      .send({ email: memberEmail });
    expect(neither.status).toBe(400);
  });
});
