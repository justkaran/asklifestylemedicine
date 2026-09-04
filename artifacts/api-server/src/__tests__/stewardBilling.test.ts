import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { ensureCaptureLoopSchema, parseSseEvents } from "./testHelpers.js";

// Set env BEFORE the route modules load — they read these once at module-init
// time. Free allowance of 1 so the SECOND publication-context question hits
// the paywall while the first passes through.
vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-steward-billing-secret";
  process.env.STEWARD_FREE_DAILY_QUESTION_LIMIT = "1";
});

import type { Express } from "express";
import request from "supertest";
import { createHmac } from "node:crypto";
import pool from "../lib/db.js";
import {
  splitGross,
  stewardLookupKey,
  hasStewardAccess,
  mintStewardEarnings,
  listStewardEarningsSummaries,
  STEWARD_SHARE,
} from "../lib/stewardBilling.js";
import { consumeStewardFreeQuestion } from "../routes/embed-agent.js";

let app: Express;
const stamp = Date.now().toString(36);

// ── Stripe schema seeding (mirrors accountAllAccess.test.ts) ────────────────
// The dev DB carries the REAL stripe schema (stripe-replit-sync), where every
// business column is GENERATED ALWAYS from `_raw_data` jsonb. When present we
// seed through `_raw_data`; otherwise we self-provision minimal plain columns.
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
    id TEXT PRIMARY KEY, name TEXT, active BOOLEAN, metadata JSONB
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS stripe.prices (
    id TEXT PRIMARY KEY, product TEXT, active BOOLEAN, type TEXT,
    unit_amount INTEGER, currency TEXT, recurring JSONB, lookup_key TEXT,
    created INTEGER
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS stripe.subscriptions (
    id TEXT PRIMARY KEY, customer TEXT, status TEXT
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS stripe.subscription_items (
    id TEXT PRIMARY KEY, subscription TEXT, price TEXT
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS stripe.invoices (
    id TEXT PRIMARY KEY, subscription TEXT, status TEXT,
    amount_paid INTEGER, currency TEXT, created INTEGER
  )`);
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

async function insertRaw(table: string, obj: Record<string, unknown>) {
  if (stripeUsesRawData) {
    const accountId = await ensureStripeAccountId();
    await pool.query(
      `INSERT INTO stripe.${table} (_account_id, _raw_data) VALUES ($1, $2::jsonb)`,
      [accountId, JSON.stringify(obj)],
    );
    return;
  }
  const cols = Object.keys(obj).filter((k) => k !== "object");
  await pool.query(
    `INSERT INTO stripe.${table} (${cols.join(",")})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`,
    cols.map((c) =>
      typeof obj[c] === "object" && obj[c] !== null
        ? JSON.stringify(obj[c])
        : obj[c],
    ),
  );
}

/** Seed a full steward-product subscription chain for one publication. */
async function seedStewardSubscription(opts: {
  key: string;
  customer: string;
  publicationId: number;
}): Promise<{ subId: string }> {
  const { key, customer, publicationId } = opts;
  await insertRaw("products", {
    id: `prod_${key}`,
    object: "product",
    name: `Steward ${key}`,
    active: true,
    metadata: {
      palonur_plan: "steward",
      palonur_publication_id: String(publicationId),
    },
  });
  await insertRaw("prices", {
    id: `price_${key}`,
    object: "price",
    product: `prod_${key}`,
    active: true,
    type: "recurring",
    unit_amount: 900,
    currency: "usd",
    recurring: { interval: "month" },
    lookup_key: stewardLookupKey(publicationId),
    created: Math.floor(Date.now() / 1000),
  });
  await insertRaw("subscriptions", {
    id: `sub_${key}`,
    object: "subscription",
    customer,
    status: "active",
  });
  await insertRaw("subscription_items", {
    id: `si_${key}`,
    object: "subscription_item",
    subscription: `sub_${key}`,
    price: `price_${key}`,
  });
  return { subId: `sub_${key}` };
}

async function cleanupSeededStripe(): Promise<void> {
  for (const table of [
    "invoices",
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

// ── Fixtures ────────────────────────────────────────────────────────────────
let pubId = 0;
let otherPubId = 0;
let facultyUserId = 0;
let otherFacultyUserId = 0;
const pubSlug = `steward-billing-${stamp}`;
const otherPubSlug = `steward-billing-other-${stamp}`;

beforeAll(async () => {
  await ensureCaptureLoopSchema(); // additive sync provisions steward_earnings
  await ensureStripeSchema();

  const fu = await pool.query(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [
      `clerk_steward_billing_${stamp}`,
      `steward-billing-${stamp}@test.local`,
      "Billing Test Steward",
    ],
  );
  facultyUserId = fu.rows[0].id as number;

  const pub = await pool.query(
    `INSERT INTO newsletter_publications (is_house, faculty_user_id, name, slug)
     VALUES (false, $1, $2, $3) RETURNING id`,
    [facultyUserId, "Billing Test Publication", pubSlug],
  );
  pubId = pub.rows[0].id as number;

  // Publications are unique per faculty user — the second one needs its own.
  const fu2 = await pool.query(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [
      `clerk_steward_billing2_${stamp}`,
      `steward-billing2-${stamp}@test.local`,
      "Other Billing Steward",
    ],
  );
  otherFacultyUserId = fu2.rows[0].id as number;

  const other = await pool.query(
    `INSERT INTO newsletter_publications (is_house, faculty_user_id, name, slug)
     VALUES (false, $1, $2, $3) RETURNING id`,
    [otherFacultyUserId, "Other Billing Publication", otherPubSlug],
  );
  otherPubId = other.rows[0].id as number;

  const mod = await import("../app.js");
  app = mod.default;
});

afterAll(async () => {
  await cleanupSeededStripe();
  await pool.query(`DELETE FROM steward_earnings WHERE publication_id IN ($1, $2)`, [
    pubId,
    otherPubId,
  ]);
  await pool.query(`DELETE FROM newsletter_publications WHERE id IN ($1, $2)`, [
    pubId,
    otherPubId,
  ]);
  await pool.query(`DELETE FROM faculty_users WHERE id IN ($1, $2)`, [
    facultyUserId,
    otherFacultyUserId,
  ]);
});

// ── 80/20 split ─────────────────────────────────────────────────────────────
describe("splitGross", () => {
  test("splits 80/20 and always sums to gross", () => {
    expect(STEWARD_SHARE).toBe(0.8);
    expect(splitGross(900)).toEqual({ stewardCents: 720, palonurCents: 180 });
    expect(splitGross(0)).toEqual({ stewardCents: 0, palonurCents: 0 });
    // Rounding never loses a cent: remainder goes to Palonur.
    for (const gross of [1, 7, 99, 901, 1234]) {
      const { stewardCents, palonurCents } = splitGross(gross);
      expect(stewardCents + palonurCents).toBe(gross);
    }
  });
});

// ── Free-allowance daily window ─────────────────────────────────────────────
describe("steward free-question daily window", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("accumulates within a UTC day, resets after midnight, per-key", () => {
    const key = `unit-${Math.random().toString(36).slice(2)}:42`;
    vi.setSystemTime(new Date("2026-07-01T08:00:00.000Z"));
    expect(consumeStewardFreeQuestion(key)).toBe(1);
    expect(consumeStewardFreeQuestion(key)).toBe(2);
    vi.setSystemTime(new Date("2026-07-02T00:00:01.000Z"));
    expect(consumeStewardFreeQuestion(key)).toBe(1);
    // Same session, different publication id = independent tally.
    const otherKey = `unit-${Math.random().toString(36).slice(2)}:43`;
    expect(consumeStewardFreeQuestion(otherKey)).toBe(1);
  });
});

// ── Entitlement ─────────────────────────────────────────────────────────────
describe("hasStewardAccess", () => {
  test("subscriber of THIS publication's product only", async () => {
    const customer = `cus_entitle_${stamp}`;
    await seedStewardSubscription({
      key: `entitle_${stamp}`,
      customer,
      publicationId: pubId,
    });
    expect(await hasStewardAccess(customer, pubId)).toBe(true);
    // Individual steward plans never cascade to another publication.
    expect(await hasStewardAccess(customer, otherPubId)).toBe(false);
    expect(await hasStewardAccess(`cus_stranger_${stamp}`, pubId)).toBe(false);
    expect(await hasStewardAccess(null, pubId)).toBe(false);
  });
});

// ── Publication-context paywall gate ────────────────────────────────────────
describe("publication ask paywall", () => {
  test("free allowance passes, then paywall frame; widget path untouched", async () => {
    const agent = request.agent(app);
    // First ask in publication context: within the allowance — the request
    // proceeds past the gate (unknown pillar → non-paywall outcome).
    const first = await agent
      .post("/api/embed-agent")
      .set("Sec-Fetch-Site", "same-origin")
      .send({
        message: "How does sleep work?",
        pillar: `no-such-pillar-${stamp}`,
        publication: pubSlug,
      });
    expect(first.status).toBe(200);
    const firstEvents = parseSseEvents(first.text);
    expect(firstEvents.some((e) => e.paywall === true)).toBe(false);

    // Second ask (same session cookie): allowance exhausted → paywall frame
    // carrying the steward plan lookup key; no answer surface.
    const second = await agent
      .post("/api/embed-agent")
      .set("Sec-Fetch-Site", "same-origin")
      .send({
        message: "And what about naps?",
        pillar: `no-such-pillar-${stamp}`,
        publication: pubSlug,
      });
    expect(second.status).toBe(200);
    const paywall = parseSseEvents(second.text).find(
      (e) => e.paywall === true,
    );
    expect(paywall).toBeTruthy();
    expect(paywall!.freeLimit).toBe(1);
    expect(
      (paywall!.plan as { lookupKey: string }).lookupKey,
    ).toBe(stewardLookupKey(pubId));

    // The plain white-label widget path (no `publication` field) is never
    // gated — same session, repeated asks, no paywall frame.
    for (let i = 0; i < 3; i++) {
      const res = await agent
        .post("/api/embed-agent")
        .set("Sec-Fetch-Site", "same-origin")
        .send({
          message: `widget ask ${i}`,
          pillar: `no-such-pillar-${stamp}`,
        });
      expect(res.status).toBe(200);
      expect(
        parseSseEvents(res.text).some((e) => e.paywall === true),
      ).toBe(false);
    }
  });
});

// ── Admin testing bypass ────────────────────────────────────────────────────
// A verified signed `palonur_admin` cookie skips the daily free-ask limit +
// Stripe paywall on publication-context asks (Karan testing). A forged
// cookie gets no bypass. Mirrors the cookie-signature scheme cookie-parser
// verifies with SESSION_SECRET.
function adminCookie(): string {
  const mac = createHmac("sha256", process.env.SESSION_SECRET!)
    .update("1")
    .digest("base64")
    .replace(/=+$/, "");
  return `palonur_admin=s%3A1.${encodeURIComponent(mac)}`;
}

describe("publication ask admin bypass", () => {
  test("admin cookie: unlimited publication asks, no paywall", async () => {
    const agent = request.agent(app);
    // Free allowance is 1 — asks 2 and 3 would paywall without the bypass.
    for (let i = 0; i < 3; i++) {
      const res = await agent
        .post("/api/embed-agent")
        .set("Sec-Fetch-Site", "same-origin")
        .set("Cookie", adminCookie())
        .send({
          message: `admin ask ${i}`,
          pillar: `no-such-pillar-${stamp}`,
          publication: pubSlug,
        });
      expect(res.status).toBe(200);
      expect(
        parseSseEvents(res.text).some((e) => e.paywall === true),
      ).toBe(false);
    }
  });

  test("forged admin cookie: paywall still applies", async () => {
    const agent = request.agent(app);
    const forged = "palonur_admin=s%3A1.notarealsignature";
    const first = await agent
      .post("/api/embed-agent")
      .set("Sec-Fetch-Site", "same-origin")
      .set("Cookie", forged)
      .send({
        message: "forged ask 1",
        pillar: `no-such-pillar-${stamp}`,
        publication: pubSlug,
      });
    expect(first.status).toBe(200);
    const second = await agent
      .post("/api/embed-agent")
      .set("Sec-Fetch-Site", "same-origin")
      .set("Cookie", forged)
      .send({
        message: "forged ask 2",
        pillar: `no-such-pillar-${stamp}`,
        publication: pubSlug,
      });
    expect(second.status).toBe(200);
    expect(
      parseSseEvents(second.text).some((e) => e.paywall === true),
    ).toBe(true);
  });
});

// ── Ledger minting ──────────────────────────────────────────────────────────
describe("steward earnings ledger", () => {
  test("mints one 80/20 row per paid invoice, idempotently", async () => {
    const customer = `cus_ledger_${stamp}`;
    const { subId } = await seedStewardSubscription({
      key: `ledger_${stamp}`,
      customer,
      publicationId: pubId,
    });
    await insertRaw("invoices", {
      id: `in_ledger_${stamp}`,
      object: "invoice",
      subscription: subId,
      status: "paid",
      amount_paid: 900,
      currency: "usd",
      created: 1_780_000_000,
    });
    // Unpaid invoices never mint.
    await insertRaw("invoices", {
      id: `in_open_${stamp}`,
      object: "invoice",
      subscription: subId,
      status: "open",
      amount_paid: 0,
      currency: "usd",
      created: 1_780_000_100,
    });

    await mintStewardEarnings();
    const { rows } = await pool.query(
      `SELECT * FROM steward_earnings WHERE stripe_invoice_id = $1`,
      [`in_ledger_${stamp}`],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].publication_id).toBe(pubId);
    expect(rows[0].faculty_user_id).toBe(facultyUserId);
    expect(rows[0].publication_slug).toBe(pubSlug);
    expect(Number(rows[0].gross_cents)).toBe(900);
    expect(Number(rows[0].steward_cents)).toBe(720);
    expect(Number(rows[0].palonur_cents)).toBe(180);

    // Re-processing the same mirror never double-credits.
    await mintStewardEarnings();
    await mintStewardEarnings();
    const again = await pool.query(
      `SELECT COUNT(*)::int AS n FROM steward_earnings WHERE stripe_invoice_id = $1`,
      [`in_ledger_${stamp}`],
    );
    expect(again.rows[0].n).toBe(1);
    const open = await pool.query(
      `SELECT COUNT(*)::int AS n FROM steward_earnings WHERE stripe_invoice_id = $1`,
      [`in_open_${stamp}`],
    );
    expect(open.rows[0].n).toBe(0);

    // Rollup surfaces the same totals.
    const summaries = await listStewardEarningsSummaries();
    const mine = summaries.find((s) => s.publicationId === pubId);
    expect(mine).toBeTruthy();
    expect(mine!.grossCents).toBe(900);
    expect(mine!.stewardCents).toBe(720);
    expect(mine!.palonurCents).toBe(180);
    expect(mine!.invoiceCount).toBe(1);
  });
});
