import { afterAll, beforeAll, describe, test, expect, vi } from "vitest";
import { ensureCaptureLoopSchema } from "./testHelpers.js";

vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-notifications-secret";
  // No iMessage provider configured — the confirmation send must degrade
  // gracefully (warn + no-op) while the link/verify flow still works.
  delete process.env.SENDBLUE_API_KEY_ID;
  delete process.env.SENDBLUE_API_SECRET_KEY;
  delete process.env.LOOPMESSAGE_AUTH_KEY;
  delete process.env.LOOPMESSAGE_SECRET_KEY;
  delete process.env.LOOPMESSAGE_SENDER_NAME;
  delete process.env.IMESSAGE_WEBHOOK_SECRET;
});

import type { Express } from "express";
import request from "supertest";
import { createHmac, randomInt } from "node:crypto";
import pool from "../lib/db.js";
import {
  getAccountPhone,
  getProductPreferences,
  resolveTargets,
  getNotificationAudience,
} from "../lib/notifications.js";

let app: Express;
let accountId: number;
let otherAccountId: number;

// The development test database is shared and can retain rows from an
// interrupted run. A clock-derived suffix repeats often enough to collide;
// use a full seven-digit random suffix for this suite's email and phone data.
const stamp = randomInt(1_000_000, 10_000_000);
const accountEmail = `notif-${stamp}@test.local`;
const otherEmail = `notif-other-${stamp}@test.local`;
// Unique numbers per run so the (product, phone) unique index never collides.
function num(offset: number): string {
  return `+1415${String(1000000 + ((stamp + offset) % 9000000)).slice(0, 7)}`;
}

function consumerCookie(id: number): string {
  const val = String(id);
  const mac = createHmac("sha256", process.env.SESSION_SECRET!)
    .update(val)
    .digest("base64")
    .replace(/=+$/, "");
  return `palonur_consumer=s%3A${val}.${encodeURIComponent(mac)}`;
}

async function pendingTokenFor(id: number): Promise<string> {
  const { rows } = await pool.query<{ confirm_token: string }>(
    `SELECT confirm_token FROM phone_subscribers
     WHERE consumer_account_id = $1 AND status = 'pending'
     ORDER BY id DESC LIMIT 1`,
    [id],
  );
  return rows[0]?.confirm_token;
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for notifications tests");
  }
  await ensureCaptureLoopSchema();
  await pool.query(`CREATE TABLE IF NOT EXISTS consumer_accounts (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    stripe_customer_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  app = (await import("../app.js")).default;

  const a = await pool.query<{ id: number }>(
    `INSERT INTO consumer_accounts (email) VALUES ($1) RETURNING id`,
    [accountEmail],
  );
  accountId = a.rows[0].id;
  const b = await pool.query<{ id: number }>(
    `INSERT INTO consumer_accounts (email) VALUES ($1) RETURNING id`,
    [otherEmail],
  );
  otherAccountId = b.rows[0].id;
});

afterAll(async () => {
  await pool.query(
    `DELETE FROM notification_preferences WHERE consumer_account_id = ANY($1::int[])`,
    [[accountId, otherAccountId]],
  );
  await pool.query(
    `DELETE FROM phone_subscribers WHERE consumer_account_id = ANY($1::int[])`,
    [[accountId, otherAccountId]],
  );
  await pool.query(`DELETE FROM consumer_accounts WHERE id = ANY($1::int[])`, [
    [accountId, otherAccountId],
  ]);
});

describe("GET /account/notifications", () => {
  test("401 when not signed in", async () => {
    const res = await request(app).get("/api/account/notifications");
    expect(res.status).toBe(401);
  });
});

describe("PUT /account/notifications/:product channel gating", () => {
  test("rejects iMessage without a confirmed phone", async () => {
    const res = await request(app)
      .put("/api/account/notifications/nightly")
      .set("Cookie", consumerCookie(accountId))
      .send({ channel: "imessage" });
    expect(res.status).toBe(400);
  });

  test("allows switching to email even without a phone", async () => {
    const res = await request(app)
      .put("/api/account/notifications/nightly")
      .set("Cookie", consumerCookie(accountId))
      .send({ channel: "email" });
    expect(res.status).toBe(200);
  });

  test("rejects an unknown product", async () => {
    const res = await request(app)
      .put("/api/account/notifications/bogus")
      .set("Cookie", consumerCookie(accountId))
      .send({ channel: "email" });
    expect(res.status).toBe(400);
  });
});

describe("POST /account/phone link + verify", () => {
  test("requires consent", async () => {
    const res = await request(app)
      .post("/api/account/phone")
      .set("Cookie", consumerCookie(accountId))
      .send({ phone: num(1), consent: false });
    expect(res.status).toBe(400);
  });

  test("links a pending Nightly number and enables iMessage after confirmation", async () => {
    const phone = num(2);
    const add = await request(app)
      .post("/api/account/phone")
      .set("Cookie", consumerCookie(accountId))
      .send({ phone, consent: true });
    expect(add.status).toBe(200);
    expect(add.body.pending).toBe(true);

    let st = await getAccountPhone(accountId);
    expect(st).toEqual({ number: phone, status: "pending" });

    const blocked = await request(app)
      .put("/api/account/notifications/nightly")
      .set("Cookie", consumerCookie(accountId))
      .send({ channel: "imessage" });
    expect(blocked.status).toBe(400);

    const token = await pendingTokenFor(accountId);
    expect(token).toBeTruthy();
    const confirm = await request(app).get(`/api/phone/confirm?token=${token}`);
    expect(confirm.status).toBe(200);

    st = await getAccountPhone(accountId);
    expect(st).toEqual({ number: phone, status: "active" });

    const enabled = await request(app)
      .put("/api/account/notifications/nightly")
      .set("Cookie", consumerCookie(accountId))
      .send({ channel: "imessage" });
    expect(enabled.status).toBe(200);
    expect(
      enabled.body.products.find(
        (product: { product: string }) => product.product === "nightly",
      ).channel,
    ).toBe("imessage");
  });

  test("re-adding an already-confirmed number reports alreadyConfirmed", async () => {
    const st = await getAccountPhone(accountId);
    const res = await request(app)
      .post("/api/account/phone")
      .set("Cookie", consumerCookie(accountId))
      .send({ phone: st.number, consent: true });
    expect(res.status).toBe(200);
    expect(res.body.alreadyConfirmed).toBe(true);
  });
});

describe("STOP/opt-out is honored at the account level", () => {
  test("a STOP webhook opts the number out and re-blocks iMessage", async () => {
    const st = await getAccountPhone(accountId);
    const wh = await request(app)
      .post("/api/phone/webhook")
      .send({ number: st.number, content: "STOP" });
    expect(wh.status).toBe(200);

    const after = await getAccountPhone(accountId);
    expect(after.status).toBe("opted_out");

    const blocked = await request(app)
      .put("/api/account/notifications/nightly")
      .set("Cookie", consumerCookie(accountId))
      .send({ channel: "imessage" });
    expect(blocked.status).toBe(400);
  });
});

describe("cross-account ownership is never stolen", () => {
  test("POST /account/phone rejects a number owned by another account (409)", async () => {
    const phone = num(80);
    // otherAccount confirms the number first.
    await pool.query(
      `INSERT INTO phone_subscribers (phone, product, status, source, consumer_account_id, confirmed_at)
       VALUES ($1, 'nightly', 'active', 'test', $2, NOW())`,
      [phone, otherAccountId],
    );
    const res = await request(app)
      .post("/api/account/phone")
      .set("Cookie", consumerCookie(accountId))
      .send({ phone, consent: true });
    expect(res.status).toBe(409);

    // The foreign row is untouched — still owned by otherAccount, still active.
    const { rows } = await pool.query<{
      consumer_account_id: number;
      status: string;
    }>(
      `SELECT consumer_account_id, status FROM phone_subscribers WHERE phone = $1`,
      [phone],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].consumer_account_id).toBe(otherAccountId);
    expect(rows[0].status).toBe("active");
  });
});

describe("lib/notifications helpers", () => {
  test("resolveTargets honors channel + phone confirmation", () => {
    const active = { number: "+14155550123", status: "active" as const };
    expect(resolveTargets("email", "a@b.co", active)).toEqual({
      email: "a@b.co",
      imessage: null,
    });
    expect(resolveTargets("imessage", "a@b.co", active)).toEqual({
      email: null,
      imessage: "+14155550123",
    });
    expect(resolveTargets("both", "a@b.co", active)).toEqual({
      email: "a@b.co",
      imessage: "+14155550123",
    });
    // iMessage requested but no confirmed phone → falls back to no text.
    expect(
      resolveTargets("imessage", "a@b.co", { number: null, status: null }),
    ).toEqual({ email: null, imessage: null });
    // Pending number is NOT usable for iMessage.
    expect(
      resolveTargets("both", "a@b.co", {
        number: "+14155550199",
        status: "pending",
      }),
    ).toEqual({ email: "a@b.co", imessage: null });
  });

  test("getProductPreferences returns the Nightly default", async () => {
    const prefs = await getProductPreferences(otherAccountId);
    expect(prefs.nightly).toBe("email");
  });

  test("getNotificationAudience resolves Nightly delivery targets", async () => {
    const audience = await getNotificationAudience("nightly", [
      { id: otherAccountId, email: otherEmail },
    ]);
    expect(audience).toHaveLength(1);
    expect(audience[0].accountId).toBe(otherAccountId);
    expect(audience[0].targets.email).toBe(otherEmail);
  });
});
