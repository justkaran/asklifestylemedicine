import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  test,
  expect,
  vi,
} from "vitest";

vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-account-all-access-secret";
});

import type { Express } from "express";
import request from "supertest";
import { createHmac } from "node:crypto";
import pool from "../lib/db.js";
import {
  capabilitiesForPlanKey,
  subscriptionsHaveAllAccess,
  getConsumerCapabilities,
  listActiveSubscriptionsForCustomer,
  type ActiveSubscription,
} from "../lib/consumerAuth.js";
import { getPaidNewsletterCustomerIds } from "../lib/newsletterBilling.js";

let app: Express;
const stamp = Date.now().toString(36);

// ── Stripe schema seeding (mirrors newsletter.test.ts) ──────────────────────
// The dev DB carries the REAL stripe schema (synced by stripe-replit-sync),
// where every business column is GENERATED ALWAYS from a `_raw_data` jsonb blob,
// so explicit inserts into e.g. `active` are rejected. When that schema is
// present we seed through `_raw_data`; otherwise we self-provision a minimal
// plain-column schema and seed explicitly.
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

// Clean up ONLY the rows this suite seeded (every id carries `stamp`). Avoids a
// `TRUNCATE stripe.*` that would clobber a concurrently-running stripe-dependent
// suite (e.g. newsletter.test.ts) under vitest's parallel file pool.
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

/**
 * Seed one active monthly subscription for `customer` to a product carrying the
 * given `palonur_plan` metadata. `key` namespaces all the ids so multiple plans
 * can coexist in one reset window.
 */
async function seedSubscription(opts: {
  key: string;
  customer: string;
  planKey: string;
  unitAmount?: number;
}): Promise<void> {
  const { key, customer, planKey, unitAmount = 900 } = opts;
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
          unit_amount: unitAmount,
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
     VALUES ($1,$2,true,'recurring',$3,'usd','{"interval":"month"}'::jsonb)`,
    [priceId, prodId, unitAmount],
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

// ── Consumer + newsletter test fixtures ─────────────────────────────────────
const allAccessCustomer = `cus_all_${stamp}`;
const nightlyCustomer = `cus_nightly_${stamp}`;
const accountEmail = `account-${stamp}@test.local`;
const accountCustomer = `cus_account_${stamp}`;
let accountId = 0;
let pubAId = 0;
let pubBId = 0;

// Replicate cookie-signature.sign (what cookie-parser uses for signed cookies):
// `<val>.<base64 HMAC-SHA256 with trailing '=' stripped>`, sent with the `s:`
// prefix and URL-encoded. Avoids depending on the undeclared cookie-signature.
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
    throw new Error("DATABASE_URL is required for accountAllAccess tests");
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

  const acc = await pool.query<{ id: number }>(
    `INSERT INTO consumer_accounts (email, stripe_customer_id)
     VALUES ($1, $2) RETURNING id`,
    [accountEmail, accountCustomer],
  );
  accountId = acc.rows[0].id;

  // Create the two publications and the account's membership. These are
  // re-ensured before every test (see beforeEach) so a sibling suite's
  // `TRUNCATE newsletter_publications ... CASCADE` can't leave the membership /
  // unsubscribe tests pointing at a publication row that no longer exists.
  await ensureNewsletterFixtures();

  // Preserve the two independent active-plan fixtures after removing the
  // retired product plans.
  await seedSubscription({
    key: `all_${stamp}`,
    customer: allAccessCustomer,
    planKey: "all_access",
  });
  await seedSubscription({
    key: `nl_${stamp}`,
    customer: nightlyCustomer,
    planKey: "premium",
  });
});

const otherEmail = `other-${stamp}@test.local`;

/**
 * Idempotently (re)create publications A + B and reset the account's newsletter
 * membership to "subscribed to A only (active)". newsletter_publications has no
 * unique constraint on slug and `newsletter.test.ts` TRUNCATEs the table
 * `RESTART IDENTITY CASCADE` in its own beforeEach, so a row this suite seeded
 * can vanish mid-run on the shared dev DB (cascading to its subscriber). We
 * detect a missing publication by id and recreate it, recapturing the new id,
 * then rebuild the membership against the current id — fixing the foreign-key
 * violation at its source instead of assuming beforeAll state survives.
 */
async function ensureNewsletterFixtures(): Promise<void> {
  const ensurePub = async (
    id: number,
    name: string,
    slug: string,
  ): Promise<number> => {
    if (id) {
      const found = await pool.query(
        `SELECT 1 FROM newsletter_publications WHERE id = $1`,
        [id],
      );
      if ((found.rowCount ?? 0) > 0) return id;
    }
    const ins = await pool.query<{ id: number }>(
      `INSERT INTO newsletter_publications (is_house, name, slug)
       VALUES (false, $1, $2) RETURNING id`,
      [name, slug],
    );
    return ins.rows[0].id;
  };
  pubAId = await ensurePub(pubAId, `Letter A ${stamp}`, `letter-a-${stamp}`);
  pubBId = await ensurePub(pubBId, `Letter ${stamp}`, `letter-${stamp}`);

  // Reset the membership: account is subscribed to publication A only (active).
  // Clearing both test emails also recovers from a unsubscribe test that
  // crashed before its own cleanup ran.
  await pool.query(`DELETE FROM newsletter_subscribers WHERE email = ANY($1)`, [
    [accountEmail, otherEmail],
  ]);
  await pool.query(
    `INSERT INTO newsletter_subscribers (email, unsubscribe_token, status, publication_id)
     VALUES ($1, $2, 'active', $3)`,
    [accountEmail, `tok-a-${stamp}`, pubAId],
  );
}

beforeEach(async () => {
  await ensureNewsletterFixtures();
});

afterAll(async () => {
  await pool.query(`DELETE FROM newsletter_subscribers WHERE email = $1`, [
    accountEmail,
  ]);
  await pool.query(
    `DELETE FROM newsletter_publications WHERE id = ANY($1::int[])`,
    [[pubAId, pubBId]],
  );
  await pool.query(`DELETE FROM consumer_accounts WHERE id = $1`, [accountId]);
  await cleanupSeededStripe();
});

describe("capability mapping (pure)", () => {
  test("each current plan key grants its capabilities", () => {
    expect(capabilitiesForPlanKey("nightly")).toEqual(["nightly"]);
    expect(capabilitiesForPlanKey("premium")).toEqual(["nightly"]);
    expect(capabilitiesForPlanKey("newsletter")).toEqual(["newsletter"]);
    expect(new Set(capabilitiesForPlanKey("all_access"))).toEqual(
      new Set(["nightly", "newsletter", "social_brain"]),
    );
  });

  test("unknown / null plan keys grant nothing", () => {
    expect(capabilitiesForPlanKey("mystery")).toEqual([]);
    expect(capabilitiesForPlanKey(null)).toEqual([]);
  });

  test("subscriptionsHaveAllAccess detects the top tier", () => {
    const mk = (planKey: string): ActiveSubscription => ({
      subscriptionId: "s",
      status: "active",
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      productId: "p",
      productName: "n",
      palonurPlan: planKey,
      priceId: "pr",
      unitAmount: 900,
      currency: "usd",
      interval: "month",
      intervalCount: 1,
      plan: "monthly",
      stewardPublicationId: null,
    });
    expect(subscriptionsHaveAllAccess([mk("nightly"), mk("newsletter")])).toBe(
      false,
    );
    expect(subscriptionsHaveAllAccess([mk("all_access")])).toBe(true);
  });
});

describe("capabilities derived from Stripe", () => {
  test("all_access unlocks nightly and newsletter", async () => {
    const caps = await getConsumerCapabilities(allAccessCustomer);
    expect(caps.has("nightly")).toBe(true);
    expect(caps.has("newsletter")).toBe(true);
  });

  test("Nightly does not unlock newsletter", async () => {
    const caps = await getConsumerCapabilities(nightlyCustomer);
    expect(caps.has("nightly")).toBe(true);
    expect(caps.has("newsletter")).toBe(false);
  });

  test("graceful empty for an unknown customer / no stripe rows", async () => {
    const caps = await getConsumerCapabilities(`cus_nobody_${stamp}`);
    expect(caps.size).toBe(0);
    expect(await listActiveSubscriptionsForCustomer(null)).toEqual([]);
  });
});

describe("newsletter all_access access", () => {
  test("an all_access holder counts as a paid newsletter customer", async () => {
    const ids = await getPaidNewsletterCustomerIds();
    expect(ids.has(allAccessCustomer)).toBe(true);
    // a Nightly-only customer must NOT be treated as a paid newsletter reader
    expect(ids.has(nightlyCustomer)).toBe(false);
  });
});

describe("GET /api/account", () => {
  test("401 without a consumer cookie", async () => {
    const res = await request(app).get("/api/account");
    expect(res.status).toBe(401);
  });

  test("signed-in consumer sees memberships + available publications", async () => {
    const res = await request(app)
      .get("/api/account")
      .set("Cookie", consumerCookie(accountId));
    expect(res.status).toBe(200);
    expect(res.body.email).toBe(accountEmail);
    const membershipIds = (
      res.body.newsletterMemberships as { publicationId: number }[]
    ).map((m) => m.publicationId);
    expect(membershipIds).toContain(pubAId);
    expect(membershipIds).not.toContain(pubBId);
    const availableIds = (
      res.body.availablePublications as { id: number }[]
    ).map((p) => p.id);
    expect(availableIds).toEqual(expect.arrayContaining([pubAId, pubBId]));
  });
});

describe("POST /api/account/newsletters/:publicationId/unsubscribe", () => {
  test("only ever touches the caller's own membership", async () => {
    // Seed a second account subscribed to the same publication; it must survive.
    await pool.query(
      `INSERT INTO newsletter_subscribers (email, unsubscribe_token, status, publication_id)
       VALUES ($1, $2, 'active', $3)`,
      [otherEmail, `tok-other-${stamp}`, pubAId],
    );

    const res = await request(app)
      .post(`/api/account/newsletters/${pubAId}/unsubscribe`)
      .set("Cookie", consumerCookie(accountId));
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(true);

    const mine = await pool.query(
      `SELECT status FROM newsletter_subscribers WHERE email = $1 AND publication_id = $2`,
      [accountEmail, pubAId],
    );
    expect(mine.rows[0].status).toBe("unsubscribed");

    const theirs = await pool.query(
      `SELECT status FROM newsletter_subscribers WHERE email = $1 AND publication_id = $2`,
      [otherEmail, pubAId],
    );
    expect(theirs.rows[0].status).toBe("active");

    await pool.query(`DELETE FROM newsletter_subscribers WHERE email = $1`, [
      otherEmail,
    ]);
  });

  test("401 without a consumer cookie", async () => {
    const res = await request(app).post(
      `/api/account/newsletters/${pubAId}/unsubscribe`,
    );
    expect(res.status).toBe(401);
  });
});
