import { beforeAll, describe, test, expect, vi } from "vitest";
import { ensureCaptureLoopSchema } from "./testHelpers.js";

vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-phone-secret";
  // Ensure no provider is configured for the default suite — the send module
  // must degrade gracefully (warn + no-op) and the capture flow must still work.
  delete process.env.SENDBLUE_API_KEY_ID;
  delete process.env.SENDBLUE_API_SECRET_KEY;
  delete process.env.LOOPMESSAGE_AUTH_KEY;
  delete process.env.LOOPMESSAGE_SECRET_KEY;
  delete process.env.LOOPMESSAGE_SENDER_NAME;
  // Default suite runs with no webhook secret configured (the graceful path:
  // opt-OUT honored, reply-based activation refused). Individual tests opt in.
  delete process.env.IMESSAGE_WEBHOOK_SECRET;
});

import type { Express } from "express";
import request from "supertest";
import { createHmac } from "crypto";
import pool from "../lib/db.js";
import { normalizeE164 } from "../routes/phone.js";
import {
  sendImessage,
  imessageConfigured,
  imessageSendingDisabledReason,
} from "../lib/imessage.js";
import * as imessageModule from "../lib/imessage.js";

let app: Express;

function signCookie(val: string, secret: string): string {
  const hash = createHmac("sha256", secret)
    .update(val)
    .digest("base64")
    .replace(/=+$/, "");
  return val + "." + hash;
}
const ADMIN_COOKIE = `palonur_admin=${encodeURIComponent(
  "s:" + signCookie("1", process.env.SESSION_SECRET as string),
)}`;

// Unique numbers per run so the (product, phone) unique index never collides
// with a parallel suite or a previous run on the shared dev DB.
const stamp = Date.now() % 1000000;
function num(offset: number): string {
  return `+1415${String(1000000 + ((stamp + offset) % 9000000)).slice(0, 7)}`;
}

beforeAll(async () => {
  await ensureCaptureLoopSchema();
  app = (await import("../app.js")).default;
});

describe("normalizeE164", () => {
  test("coerces common US formats and rejects junk", () => {
    expect(normalizeE164("(415) 555-0123")).toBe("+14155550123");
    expect(normalizeE164("4155550123")).toBe("+14155550123");
    expect(normalizeE164("14155550123")).toBe("+14155550123");
    expect(normalizeE164("+44 7911 123456")).toBe("+447911123456");
    expect(normalizeE164("123")).toBeNull();
    expect(normalizeE164("")).toBeNull();
  });
});

describe("iMessage send module (graceful degradation)", () => {
  test("no-ops when no provider is configured", async () => {
    expect(imessageConfigured()).toBe(false);
    const res = await sendImessage({
      to: "+14155550123",
      body: "hi",
      label: "test",
    });
    expect(res.ok).toBe(false);
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe("unconfigured");
  });

  test("is disabled under the vitest runner gate", () => {
    expect(imessageSendingDisabledReason()).toBeTruthy();
  });
});

describe("POST /phone/subscribe", () => {
  test("rejects when consent is not true", async () => {
    const r = await request(app)
      .post("/api/phone/subscribe")
      .send({ phone: num(1), product: "nightly", consent: false });
    expect(r.status).toBe(400);
  });

  test("rejects an unparseable phone number", async () => {
    const r = await request(app)
      .post("/api/phone/subscribe")
      .send({ phone: "abc", product: "nightly", consent: true });
    expect(r.status).toBe(400);
  });

  test("rejects an unknown product", async () => {
    const r = await request(app)
      .post("/api/phone/subscribe")
      .send({ phone: num(2), product: "marketing", consent: true });
    expect(r.status).toBe(400);
  });

  test("captures a new number as pending and is idempotent", async () => {
    const phone = num(10);
    const r1 = await request(app).post("/api/phone/subscribe").send({
      phone,
      product: "nightly",
      consent: true,
      source: "sleep-agent",
    });
    expect(r1.status).toBe(200);
    expect(r1.body.ok).toBe(true);
    expect(r1.body.pending).toBe(true);

    // Re-submitting the same (product, phone) must not duplicate the row.
    const r2 = await request(app)
      .post("/api/phone/subscribe")
      .send({ phone, product: "nightly", consent: true });
    expect(r2.status).toBe(200);
    expect(r2.body.pending).toBe(true);

    const rows = await pool.query(
      `SELECT status, consent_at FROM phone_subscribers WHERE phone = $1 AND product = 'nightly'`,
      [normalizeE164(phone)],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].status).toBe("pending");
    // Compliance: an explicit consent timestamp must be persisted on subscribe.
    expect(rows.rows[0].consent_at).not.toBeNull();
  });

  test("a repeat pending submit does NOT re-send or re-issue a token", async () => {
    const phone = num(15);
    const spy = vi.spyOn(imessageModule, "sendImessage");
    try {
      const r1 = await request(app)
        .post("/api/phone/subscribe")
        .send({ phone, product: "nightly", consent: true });
      expect(r1.body.pending).toBe(true);
      const sendsAfterFirst = spy.mock.calls.length;

      const tok1 = await pool.query(
        `SELECT confirm_token FROM phone_subscribers WHERE phone = $1 AND product = 'nightly'`,
        [normalizeE164(phone)],
      );

      // Re-submitting while still pending must be an idempotent no-op: no extra
      // (paid) text and the same confirmation token.
      const r2 = await request(app)
        .post("/api/phone/subscribe")
        .send({ phone, product: "nightly", consent: true });
      expect(r2.body.pending).toBe(true);
      expect(spy.mock.calls.length).toBe(sendsAfterFirst); // no additional send

      const tok2 = await pool.query(
        `SELECT confirm_token FROM phone_subscribers WHERE phone = $1 AND product = 'nightly'`,
        [normalizeE164(phone)],
      );
      expect(tok2.rows[0].confirm_token).toBe(tok1.rows[0].confirm_token);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("GET /phone/confirm", () => {
  test("an active subscriber re-submitting returns alreadySubscribed", async () => {
    const phone = num(31);
    await request(app)
      .post("/api/phone/subscribe")
      .send({ phone, product: "nightly", consent: true });
    const row = await pool.query(
      `SELECT confirm_token FROM phone_subscribers WHERE phone = $1 AND product = 'nightly'`,
      [normalizeE164(phone)],
    );
    await request(app).get(
      `/api/phone/confirm?token=${row.rows[0].confirm_token}`,
    );

    const r = await request(app)
      .post("/api/phone/subscribe")
      .send({ phone, product: "nightly", consent: true });
    expect(r.body.alreadySubscribed).toBe(true);
    expect(r.body.pending).toBeUndefined();
  });

  test("an unknown token 404s", async () => {
    const r = await request(app).get(`/api/phone/confirm?token=does-not-exist`);
    expect(r.status).toBe(404);
  });
});

describe("POST /phone/webhook", () => {
  test("YES re-activates after an opt-out (authenticated webhook)", async () => {
    const phone = num(50);
    process.env.IMESSAGE_WEBHOOK_SECRET = "wh-secret";
    try {
      await request(app)
        .post("/api/phone/subscribe")
        .send({ phone, product: "nightly", consent: true });
      await request(app)
        .post("/api/phone/webhook")
        .set("x-webhook-secret", "wh-secret")
        .send({ number: normalizeE164(phone), content: "STOP" });
      // LoopMessage-shaped inbound payload, with the shared secret presented.
      const r = await request(app)
        .post("/api/phone/webhook")
        .set("x-webhook-secret", "wh-secret")
        .send({
          recipient: normalizeE164(phone),
          text: "YES",
          alert_type: "message_inbound",
        });
      expect(r.status).toBe(200);

      const rows = await pool.query(
        `SELECT status FROM phone_subscribers WHERE phone = $1 AND product = 'nightly'`,
        [normalizeE164(phone)],
      );
      expect(rows.rows[0].status).toBe("active");
    } finally {
      delete process.env.IMESSAGE_WEBHOOK_SECRET;
    }
  });

  test("reply-based activation is IGNORED when no webhook secret is configured", async () => {
    const phone = num(51);
    await request(app)
      .post("/api/phone/subscribe")
      .send({ phone, product: "nightly", consent: true });
    // Opt out first, then forge a YES — with no secret configured we can't
    // trust the reply, so the row must stay opted_out.
    await request(app)
      .post("/api/phone/webhook")
      .send({ number: normalizeE164(phone), content: "STOP" });
    const r = await request(app)
      .post("/api/phone/webhook")
      .send({ number: normalizeE164(phone), content: "YES" });
    expect(r.status).toBe(200);
    expect(r.body.ignored).toBe("unauthenticated");

    const rows = await pool.query(
      `SELECT status FROM phone_subscribers WHERE phone = $1 AND product = 'nightly'`,
      [normalizeE164(phone)],
    );
    expect(rows.rows[0].status).toBe("opted_out");
  });

  test("a forged webhook is rejected (401) when a secret is configured", async () => {
    const phone = num(52);
    process.env.IMESSAGE_WEBHOOK_SECRET = "wh-secret";
    try {
      await request(app)
        .post("/api/phone/subscribe")
        .send({ phone, product: "nightly", consent: true });
      // No / wrong secret → 401, and consent state is untouched.
      const r = await request(app)
        .post("/api/phone/webhook")
        .send({ number: normalizeE164(phone), content: "STOP" });
      expect(r.status).toBe(401);

      const rows = await pool.query(
        `SELECT status FROM phone_subscribers WHERE phone = $1 AND product = 'nightly'`,
        [normalizeE164(phone)],
      );
      expect(rows.rows[0].status).toBe("pending");
    } finally {
      delete process.env.IMESSAGE_WEBHOOK_SECRET;
    }
  });

  test("STOP is honored without a secret (fail-safe opt-out)", async () => {
    const phone = num(53);
    await request(app)
      .post("/api/phone/subscribe")
      .send({ phone, product: "nightly", consent: true });
    const r = await request(app)
      .post("/api/phone/webhook")
      .send({ number: normalizeE164(phone), content: "STOP" });
    expect(r.status).toBe(200);

    const rows = await pool.query(
      `SELECT status FROM phone_subscribers WHERE phone = $1 AND product = 'nightly'`,
      [normalizeE164(phone)],
    );
    expect(rows.rows[0].status).toBe("opted_out");
  });

  test("ignores our own outbound echoes", async () => {
    const phone = num(55);
    await request(app)
      .post("/api/phone/subscribe")
      .send({ phone, product: "nightly", consent: true });
    await request(app)
      .post("/api/phone/webhook")
      .send({
        number: normalizeE164(phone),
        content: "STOP",
        is_outbound: true,
      });
    const rows = await pool.query(
      `SELECT status FROM phone_subscribers WHERE phone = $1 AND product = 'nightly'`,
      [normalizeE164(phone)],
    );
    expect(rows.rows[0].status).toBe("pending");
  });
});

describe("admin phone endpoints", () => {
  test("list requires the palonur_admin cookie", async () => {
    const r = await request(app).get("/api/admin/phone-numbers");
    expect(r.status).toBe(401);
  });

  test("CSV export requires the cookie and returns CSV", async () => {
    const noAuth = await request(app).get("/api/admin/phone-numbers.csv");
    expect(noAuth.status).toBe(401);

    const r = await request(app)
      .get("/api/admin/phone-numbers.csv")
      .set("Cookie", ADMIN_COOKIE);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("text/csv");
    expect(r.text.split("\n")[0]).toContain("phone");
  });
});
