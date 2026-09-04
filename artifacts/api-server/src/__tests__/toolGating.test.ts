import { afterAll, beforeAll, describe, test, expect, vi } from "vitest";

// Set env BEFORE the route/lib modules load — they read these once at
// module-init time. `vi.hoisted` wins the import race.
//   - SESSION_SECRET signs the consumer cookie we forge below.
//   - SLEEP_FREE_DAILY_QUESTION_LIMIT=0 makes a non-entitled consumer hit the
//     paywall on the first question.
// USE_GOVERNED_RAG is deliberately left unset so the sleep-agent takes its
// legacy (baked-corpus) path and streams the mocked Anthropic answer below for
// the entitled-positive case, with no retrieval/network dependency.
vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-tool-gating-secret";
  process.env.SLEEP_FREE_DAILY_QUESTION_LIMIT = "0";
  process.env.FREE_QUESTION_LIMIT = "0";
});

// Stream a fully-structured ANSWER block so an ENTITLED sleep-agent request
// produces a real answer (not a paywall, not an error) without hitting the
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      stream: () => {
        const text = [
          "ANSWER:",
          "Dim evening light suppresses melatonin and shifts your clock later.",
          "",
          "CITATION:",
          "Zeitzer et al., 2000, J Physiol",
          "",
          "PAPER:",
          '"Sensitivity of the human circadian pacemaker to nocturnal light"',
          "",
          "FINDING:",
          "Even ~100 lux at night significantly suppresses melatonin.",
          "",
          "INTERPRETATION:",
          "Keep evenings dim if you want to fall asleep on time.",
          "",
          "ACTION:",
          "Dim household lights two hours before bed tonight.",
          "",
          "INSIGHT:",
          "Q: Is dim room light really enough to matter?",
          "A: Yes, the dose-response is non-linear and saturates near 100 lux.",
        ].join("\n");
        async function* gen() {
          for (const piece of text.match(/[\s\S]{1,40}/g) ?? []) {
            yield {
              type: "content_block_delta",
              delta: { type: "text_delta", text: piece },
            };
          }
        }
        return gen();
      },
    };
  }
  return { default: FakeAnthropic };
});

// Keep embedding calls local and deterministic.
vi.mock("../lib/embeddings.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/embeddings.js")>(
    "../lib/embeddings.js",
  );
  return {
    ...actual,
    embedTexts: vi.fn(async (texts: string[]) =>
      texts.map(() => {
        const v = new Array(384).fill(0);
        v[0] = 1;
        return v;
      }),
    ),
  };
});

import type { Express } from "express";
import request from "supertest";
import { createHmac } from "node:crypto";
import pool from "../lib/db.js";
import {
  capabilitiesForPlanKey,
  getConsumerCapabilities,
} from "../lib/consumerAuth.js";
import { parseSseEvents } from "./testHelpers.js";

let app: Express;
const stamp = Date.now().toString(36);

// ── Stripe schema seeding (mirrors accountAllAccess.test.ts) ────────────────
// The dev DB may carry the REAL stripe schema (synced by stripe-replit-sync),
// where business columns are GENERATED ALWAYS from a `_raw_data` jsonb blob, so
// explicit inserts are rejected. Probe for `_raw_data`; if present seed through
// it (+ a reused/minted accounts row for the `_account_id` FK), else provision a
// minimal plain-column schema.
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
}

// Clean up ONLY the rows this suite seeded (every id carries `stamp`) so a
// concurrently-runnable stripe-dependent suite isn't clobbered.
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

/** Seed one active monthly subscription for `customer` to a product carrying
 * the given `palonur_plan` metadata. `key` namespaces all ids. */
async function seedSubscription(opts: {
  key: string;
  customer: string;
  planKey: string;
}): Promise<void> {
  const { key, customer, planKey } = opts;
  const prodId = `prod_${key}`;
  const priceId = `price_${key}`;
  const subId = `sub_${key}`;
  const siId = `si_${key}`;
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
      [
        accountId,
        JSON.stringify({
          id: priceId,
          object: "price",
          product: prodId,
          active: true,
          type: "recurring",
          unit_amount: 900,
          currency: "usd",
          recurring: { interval: "month" },
        }),
      ],
    );
    await pool.query(
      `INSERT INTO stripe.subscriptions (_account_id, _raw_data) VALUES ($1, $2::jsonb)`,
      [
        accountId,
        JSON.stringify({
          id: subId,
          object: "subscription",
          customer,
          status: "active",
        }),
      ],
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
    `INSERT INTO stripe.prices (id, product, active, type, unit_amount, currency, recurring)
     VALUES ($1,$2,true,'recurring',900,'usd','{"interval":"month"}'::jsonb)`,
    [priceId, prodId],
  );
  await pool.query(
    `INSERT INTO stripe.subscriptions (id, customer, status) VALUES ($1,$2,'active')`,
    [subId, customer],
  );
  await pool.query(
    `INSERT INTO stripe.subscription_items (id, subscription, price) VALUES ($1,$2,$3)`,
    [siId, subId, priceId],
  );
}

// ── Consumer fixtures: one account per single-tool plan ─────────────────────
const plans = {
  nightly: {
    customer: `cus_night_${stamp}`,
    email: `night-${stamp}@test.local`,
    accountId: 0,
  },
  all_access: {
    customer: `cus_all_${stamp}`,
    email: `all-${stamp}@test.local`,
    accountId: 0,
  },
};

// Replicate cookie-signature.sign (what cookie-parser uses for signed cookies):
// `<val>.<base64 HMAC-SHA256 with trailing '=' stripped>`, sent with the `s:`
// prefix and URL-encoded.
function consumerCookie(id: number): string {
  const val = String(id);
  const mac = createHmac("sha256", process.env.SESSION_SECRET!)
    .update(val)
    .digest("base64")
    .replace(/=+$/, "");
  return `palonur_consumer=s%3A${val}.${encodeURIComponent(mac)}`;
}

// Signed admin cookie (same cookie-signature scheme). A forged variant uses a
// bad MAC so cookie-parser rejects the signature.
function adminCookie(): string {
  const mac = createHmac("sha256", process.env.SESSION_SECRET!)
    .update("1")
    .digest("base64")
    .replace(/=+$/, "");
  return `palonur_admin=s%3A1.${encodeURIComponent(mac)}`;
}
const FORGED_ADMIN_COOKIE = "palonur_admin=s%3A1.notarealsignature";

// A real browser sends Sec-Fetch-Site, which the partner-key middleware uses to
// recognise a first-party human (no X-Palonur-Key required); the consumer
// paywall then governs the request.
const FIRST_PARTY = { "Sec-Fetch-Site": "same-origin" } as const;

/** True if any SSE `data:` event in the response carried `paywall: true`. */
function isPaywalled(text: string): boolean {
  return parseSseEvents(text).some((e) => e.paywall === true);
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for toolGating tests");
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

  app = (await import("../app.js")).default;

  for (const [planKey, fix] of Object.entries(plans)) {
    const acc = await pool.query<{ id: number }>(
      `INSERT INTO consumer_accounts (email, stripe_customer_id)
       VALUES ($1, $2) RETURNING id`,
      [fix.email, fix.customer],
    );
    fix.accountId = acc.rows[0].id;
    await seedSubscription({
      key: `${planKey}_${stamp}`,
      customer: fix.customer,
      planKey,
    });
  }
});

afterAll(async () => {
  await pool.query(
    `DELETE FROM consumer_accounts WHERE email = ANY($1::text[])`,
    [Object.values(plans).map((p) => p.email)],
  );
  await cleanupSeededStripe();
});

// ── 1. Capability mapping (pure) ────────────────────────────────────────────
describe("plan-key → capability mapping", () => {
  test("individual plans grant only their own capability", () => {
    expect(capabilitiesForPlanKey("nightly")).toEqual(["nightly"]);
    expect(capabilitiesForPlanKey("premium")).toEqual(["nightly"]);
    expect(capabilitiesForPlanKey("newsletter")).toEqual(["newsletter"]);
  });

  test("all_access grants all current capabilities", () => {
    expect(new Set(capabilitiesForPlanKey("all_access"))).toEqual(
      new Set(["nightly", "newsletter", "social_brain"]),
    );
  });
});

// ── 2. Capabilities derived from live Stripe rows ───────────────────────────
describe("consumer capabilities from active subscriptions", () => {
  test("Nightly grants only sleep access", async () => {
    const caps = await getConsumerCapabilities(plans.nightly.customer);
    expect(caps.has("nightly")).toBe(true);
    expect(caps.has("newsletter")).toBe(false);
  });

  test("all_access grants all current subscription capabilities", async () => {
    const caps = await getConsumerCapabilities(plans.all_access.customer);
    expect(caps.has("nightly")).toBe(true);
    expect(caps.has("newsletter")).toBe(true);
    expect(caps.has("social_brain")).toBe(true);
  });
});

// ── 3. Agent route gates: the wrong capability is paywalled ──────────────────
// FREE_QUESTION_LIMIT=0 means a non-entitled consumer is paywalled on the first
// question, so each request below probes the gate directly.
describe("POST /api/sleep-agent capability gate", () => {
  test("a Nightly subscriber reaches the sleep agent (not paywalled)", async () => {
    const res = await request(app)
      .post("/api/sleep-agent")
      .set(FIRST_PARTY)
      .set("Cookie", consumerCookie(plans.nightly.accountId))
      .send({ message: "Why do I wake up at 3am?" });
    expect(res.status).toBe(200);
    expect(isPaywalled(res.text)).toBe(false);
  });

  test("an all_access subscriber reaches the sleep agent (not paywalled)", async () => {
    const res = await request(app)
      .post("/api/sleep-agent")
      .set(FIRST_PARTY)
      .set("Cookie", consumerCookie(plans.all_access.accountId))
      .send({ message: "Why do I wake up at 3am?" });
    expect(res.status).toBe(200);
    expect(isPaywalled(res.text)).toBe(false);
  });
});

// ── 4. Admin testing bypass ──────────────────────────────────────────────────
// A verified signed `palonur_admin` cookie skips the free-question limit +
// paywall entirely (Karan testing). With FREE limits at 0, a non-entitled
// request is paywalled on its very first question UNLESS the bypass applies —
// so each probe below is deterministic. A forged/unsigned cookie gets nothing.
describe("admin cookie bypasses consumer paywalls", () => {
  test("sleep-agent: admin cookie → never paywalled", async () => {
    const res = await request(app)
      .post("/api/sleep-agent")
      .set(FIRST_PARTY)
      .set("Cookie", adminCookie())
      .send({ message: "Why do I wake up at 3am?" });
    expect(res.status).toBe(200);
    expect(isPaywalled(res.text)).toBe(false);
  });

  test("sleep-agent: forged admin cookie → still paywalled", async () => {
    const res = await request(app)
      .post("/api/sleep-agent")
      .set(FIRST_PARTY)
      .set("Cookie", FORGED_ADMIN_COOKIE)
      .send({ message: "Why do I wake up at 3am?" });
    expect(res.status).toBe(200);
    expect(isPaywalled(res.text)).toBe(true);
  });
});
