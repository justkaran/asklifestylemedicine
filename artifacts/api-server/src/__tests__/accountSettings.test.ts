import { afterAll, beforeAll, describe, test, expect, vi } from "vitest";

vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-account-settings-secret";
});

import type { Express } from "express";
import request from "supertest";
import { createHmac } from "node:crypto";
import pool from "../lib/db.js";

let app: Express;
const stamp = Date.now().toString(36);
const email = `acct-settings-${stamp}@test.local`;
let accountId: number;
let housePubId: number;

function consumerCookie(id: number): string {
  const val = String(id);
  const mac = createHmac("sha256", process.env.SESSION_SECRET!)
    .update(val)
    .digest("base64")
    .replace(/=+$/, "");
  return `palonur_consumer=s%3A${val}.${encodeURIComponent(mac)}`;
}

beforeAll(async () => {
  ({ default: app } = await import("../app.js"));
  const rows = await pool.query(
    `INSERT INTO consumer_accounts (email, display_name, email_verified_at)
     VALUES ($1, 'Settings Tester', NOW()) RETURNING id`,
    [email],
  );
  accountId = rows.rows[0].id;
});

afterAll(async () => {
  await pool.query(
    `DELETE FROM newsletter_subscribers WHERE email = $1`,
    [email],
  );
  await pool.query(`DELETE FROM consumer_accounts WHERE id = $1`, [accountId]);
});

describe("account settings", () => {
  test("GET /api/account/settings requires sign-in", async () => {
    const res = await request(app).get("/api/account/settings");
    expect(res.status).toBe(401);
  });

  test("GET returns profile fields with no newsletter row", async () => {
    const res = await request(app)
      .get("/api/account/settings")
      .set("Cookie", consumerCookie(accountId));
    expect(res.status).toBe(200);
    expect(res.body.email).toBe(email);
    expect(res.body.displayName).toBe("Settings Tester");
    expect(typeof res.body.memberSince).toBe("string");
    expect(res.body.newsletterOptedIn).toBe(false);
    expect(res.body.newsletterStatus).toBe("none");
  });

  test("opt IN activates immediately for a verified account (no pending)", async () => {
    const res = await request(app)
      .put("/api/account/newsletter")
      .set("Cookie", consumerCookie(accountId))
      .send({ optIn: true });
    expect(res.status).toBe(200);
    expect(res.body.newsletterOptedIn).toBe(true);

    const row = await pool.query(
      `SELECT ns.status, ns.confirmed_at, ns.publication_id
       FROM newsletter_subscribers ns
       JOIN newsletter_publications np ON np.id = ns.publication_id
       WHERE ns.email = $1 AND np.is_house = TRUE`,
      [email],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].status).toBe("active");
    expect(row.rows[0].confirmed_at).not.toBeNull();
    housePubId = row.rows[0].publication_id;

    const settings = await request(app)
      .get("/api/account/settings")
      .set("Cookie", consumerCookie(accountId));
    expect(settings.body.newsletterOptedIn).toBe(true);
    expect(settings.body.newsletterStatus).toBe("active");
  });

  test("opt OUT unsubscribes the row", async () => {
    const res = await request(app)
      .put("/api/account/newsletter")
      .set("Cookie", consumerCookie(accountId))
      .send({ optIn: false });
    expect(res.status).toBe(200);
    expect(res.body.newsletterOptedIn).toBe(false);

    const row = await pool.query(
      `SELECT status, unsubscribed_at FROM newsletter_subscribers
       WHERE email = $1 AND publication_id = $2`,
      [email, housePubId],
    );
    expect(row.rows[0].status).toBe("unsubscribed");
    expect(row.rows[0].unsubscribed_at).not.toBeNull();
  });

  test("opt IN is refused for an UNVERIFIED account (double opt-in stays intact)", async () => {
    const unverified = await pool.query(
      `INSERT INTO consumer_accounts (email, email_verified_at)
       VALUES ($1, NULL) RETURNING id`,
      [`acct-settings-unverified-${stamp}@test.local`],
    );
    const uid: number = unverified.rows[0].id;
    try {
      const res = await request(app)
        .put("/api/account/newsletter")
        .set("Cookie", consumerCookie(uid))
        .send({ optIn: true });
      expect(res.status).toBe(403);
    } finally {
      await pool.query(`DELETE FROM consumer_accounts WHERE id = $1`, [uid]);
    }
  });

  test("PUT /api/account/name updates the display name", async () => {
    const res = await request(app)
      .put("/api/account/name")
      .set("Cookie", consumerCookie(accountId))
      .send({ displayName: "Renamed Tester" });
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe("Renamed Tester");
  });
});
