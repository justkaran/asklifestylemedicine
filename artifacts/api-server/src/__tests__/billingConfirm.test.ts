import { afterAll, beforeAll, describe, test, expect, vi } from "vitest";

vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-billing-confirm-secret";
  process.env.BILLING_ENABLED = "true";
});

// ─── Stub the Stripe client layer ─────────────────────────────────────────
// The real billing route runs; only the Stripe SDK + sync are stubbed so the
// test can drive checkout-session shapes without hitting Stripe.
let fakeSession: Record<string, unknown> = {};

vi.mock("../lib/stripeClient.js", () => ({
  isStripeConnected: async () => true,
  getUncachableStripeClient: async () => ({
    checkout: {
      sessions: { retrieve: async () => fakeSession },
    },
  }),
  getStripeSync: async () => ({
    syncSingleEntity: async () => {},
  }),
}));

// Capture magic links instead of sending email.
const sentLinks: { to: string; token: string }[] = [];
vi.mock("../lib/consumerEmail.js", () => ({
  sendConsumerMagicLink: async (args: { to: string; token: string }) => {
    sentLinks.push(args);
  },
}));

import type { Express } from "express";
import request from "supertest";
import pool from "../lib/db.js";

let app: Express;
const stamp = Date.now().toString(36);
const victimEmail = `victim-${stamp}@test.local`;
const victimCustomer = `cus_victim_${stamp}`;
let victimAccountId = 0;

/** Pull a Set-Cookie entry by name out of a supertest response. */
function setCookie(res: request.Response, name: string): string | undefined {
  const raw = res.headers["set-cookie"];
  if (!raw) return undefined;
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.find((c) => c.startsWith(`${name}=`));
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

  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO consumer_accounts (email, stripe_customer_id)
     VALUES ($1, $2) RETURNING id`,
    [victimEmail, victimCustomer],
  );
  victimAccountId = rows[0].id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM consumer_login_tokens WHERE email = $1`, [
    victimEmail,
  ]);
  await pool.query(`DELETE FROM consumer_accounts WHERE id = $1`, [
    victimAccountId,
  ]);
});

describe("POST /billing/confirm — account-takeover guard", () => {
  test("a completed checkout for someone else's email does NOT grant a session; it emails a sign-in link instead", async () => {
    sentLinks.length = 0;
    fakeSession = {
      status: "complete",
      payment_status: "paid",
      customer: victimCustomer,
      subscription: `sub_${stamp}`,
    };

    const res = await request(app)
      .post("/api/billing/confirm")
      .set("X-Forwarded-For", "192.0.2.31")
      .send({ sessionId: `cs_test_${stamp}` });

    expect(res.status).toBe(200);
    expect(res.body.emailVerificationSent).toBe(true);
    // The crucial assertion: NO consumer session cookie is set from a checkout
    // session the caller hasn't proven they own.
    expect(setCookie(res, "palonur_consumer")).toBeUndefined();
    // A magic link to the *account's* email is the only path to a session.
    expect(sentLinks).toHaveLength(1);
    expect(sentLinks[0]?.to).toBe(victimEmail);
  });

  test("an unpaid / incomplete checkout is rejected and emails nothing", async () => {
    sentLinks.length = 0;
    fakeSession = {
      status: "open",
      payment_status: "unpaid",
      customer: victimCustomer,
    };

    const res = await request(app)
      .post("/api/billing/confirm")
      .set("X-Forwarded-For", "192.0.2.32")
      .send({ sessionId: `cs_test_unpaid_${stamp}` });

    expect(res.status).toBe(402);
    expect(setCookie(res, "palonur_consumer")).toBeUndefined();
    expect(sentLinks).toHaveLength(0);
  });
});
