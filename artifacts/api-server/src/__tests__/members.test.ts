import { beforeAll, beforeEach, describe, test, expect, vi } from "vitest";

vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-members-secret";
  process.env.RESEND_API_KEY = "stub-key";
});

// Capture the members sign-in links instead of hitting Resend.
interface SentSignIn {
  to: string;
  name?: string | null;
  token: string;
}
const sentLinks: SentSignIn[] = [];

vi.mock("../lib/newsletterEmail", () => ({
  sendSubscriberSignInLink: async (args: SentSignIn) => {
    sentLinks.push(args);
  },
}));

import type { Express } from "express";
import request from "supertest";
import { createHmac } from "crypto";
import pool from "../lib/db.js";
import { __resetEmailRateLimitForTests } from "../middlewares/emailRateLimit.js";

const SECRET = "test-members-secret";

function signCookie(val: string, secret: string): string {
  const hash = createHmac("sha256", secret)
    .update(val)
    .digest("base64")
    .replace(/=+$/, "");
  return val + "." + hash;
}

let app: Express;

async function ensureSchema(): Promise<void> {
  await pool.query(`DO $$ BEGIN
    CREATE TYPE newsletter_subscriber_status AS ENUM ('active','pending','unsubscribed');
  EXCEPTION WHEN duplicate_object THEN NULL; WHEN unique_violation THEN NULL; END $$;`);
  await pool.query(`CREATE TABLE IF NOT EXISTS newsletter_publications (
    id SERIAL PRIMARY KEY,
    is_house BOOLEAN NOT NULL DEFAULT FALSE,
    faculty_user_id INTEGER,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    byline_name TEXT,
    byline_institution TEXT,
    tagline TEXT,
    description TEXT,
    accent_color TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS newsletter_subscribers (
    id SERIAL PRIMARY KEY,
    publication_id INTEGER,
    email TEXT NOT NULL,
    name TEXT,
    status newsletter_subscriber_status NOT NULL DEFAULT 'active',
    source TEXT,
    stripe_customer_id TEXT,
    unsubscribe_token TEXT NOT NULL,
    confirm_token TEXT,
    confirmed_at TIMESTAMPTZ,
    unsubscribed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS nl_subs_unsub_token_uniq ON newsletter_subscribers (unsubscribe_token)`,
  );
  // Matches the real schema's slug unique index; the beforeAll fixture upsert
  // relies on ON CONFLICT (slug).
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS newsletter_publications_slug_uniq ON newsletter_publications (slug)`,
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS newsletter_subscriber_sessions (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    magic_token TEXT NOT NULL UNIQUE,
    session_token TEXT UNIQUE,
    consumed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    session_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}

let pubId: number;

beforeAll(async () => {
  await ensureSchema();
  app = (await import("../app")).default;
  // NOT is_house: a partial unique index allows only ONE house row, and the
  // real house publication is created lazily by the first public subscribe
  // (including save-answer opt-ins), so a shared dev DB may already have it.
  // Members routes match subscribers by email regardless of house-ness.
  const r = await pool.query(
    `INSERT INTO newsletter_publications (is_house, name, slug, tagline)
     VALUES (false, 'Members Test Publication', 'slm-members-test', 'Test')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, is_house = false
     RETURNING id`,
  );
  pubId = r.rows[0].id;
});

beforeEach(async () => {
  sentLinks.length = 0;
  // Members auth shares the persistent per-IP/email throttle with other
  // magic-link suites. Isolate this file from earlier localhost requests.
  await __resetEmailRateLimitForTests();
  await pool.query(`DELETE FROM newsletter_subscriber_sessions`);
  await pool.query(`DELETE FROM newsletter_subscribers WHERE email LIKE '%@members-test.local'`);
});

async function seedSubscriber(email: string, status = "active") {
  await pool.query(
    `INSERT INTO newsletter_subscribers (publication_id, email, name, status, unsubscribe_token)
     VALUES ($1, $2, 'Test Member', $3, $4)`,
    [pubId, email, status, `tok-${Math.random().toString(36).slice(2)}`],
  );
}

describe("members magic-link auth", () => {
  test("request emails a link only for an active subscriber, never leaks existence", async () => {
    await seedSubscriber("member@members-test.local", "active");

    const known = await request(app)
      .post("/api/members-auth/request")
      .send({ email: "member@members-test.local" });
    expect(known.status).toBe(200);
    expect(known.body).toEqual({ ok: true });
    expect(sentLinks).toHaveLength(1);
    expect(sentLinks[0].to).toBe("member@members-test.local");

    sentLinks.length = 0;

    // Unknown email → identical generic success, NO email sent.
    const unknown = await request(app)
      .post("/api/members-auth/request")
      .send({ email: "nobody@members-test.local" });
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual({ ok: true });
    expect(sentLinks).toHaveLength(0);
  });

  test("pending (non-active) subscriber gets no link", async () => {
    await seedSubscriber("pending@members-test.local", "pending");
    const r = await request(app)
      .post("/api/members-auth/request")
      .send({ email: "pending@members-test.local" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(sentLinks).toHaveLength(0);
  });

  test("consume mints a session cookie; portal returns subscriptions", async () => {
    await seedSubscriber("flow@members-test.local", "active");
    await request(app)
      .post("/api/members-auth/request")
      .send({ email: "flow@members-test.local" });
    const token = sentLinks[0].token;

    const consume = await request(app).get(
      `/api/members-auth/consume?token=${token}`,
    );
    expect(consume.status).toBe(200);
    const cookie = consume.headers["set-cookie"];
    expect(cookie).toBeDefined();

    const me = await request(app).get("/api/members-auth/me").set("Cookie", cookie);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe("flow@members-test.local");

    const portal = await request(app)
      .get("/api/members/portal")
      .set("Cookie", cookie);
    expect(portal.status).toBe(200);
    expect(portal.body.email).toBe("flow@members-test.local");
    expect(Array.isArray(portal.body.subscriptions)).toBe(true);
    expect(
      portal.body.subscriptions.some((s: { slug: string }) => s.slug === "slm-members-test"),
    ).toBe(true);
  });

  test("a magic token cannot be replayed", async () => {
    await seedSubscriber("replay@members-test.local", "active");
    await request(app)
      .post("/api/members-auth/request")
      .send({ email: "replay@members-test.local" });
    const token = sentLinks[0].token;

    const first = await request(app).get(
      `/api/members-auth/consume?token=${token}`,
    );
    expect(first.status).toBe(200);
    const second = await request(app).get(
      `/api/members-auth/consume?token=${token}`,
    );
    expect(second.status).toBe(400);
  });

  test("portal and me reject an unauthenticated caller", async () => {
    expect((await request(app).get("/api/members/portal")).status).toBe(401);
    expect((await request(app).get("/api/members-auth/me")).status).toBe(401);
  });

  test("an editor/admin cookie does NOT unlock the members area", async () => {
    const adminCookie = `palonur_admin=${encodeURIComponent(
      "s:" + signCookie("1", SECRET),
    )}`;
    const r = await request(app)
      .get("/api/members/portal")
      .set("Cookie", adminCookie);
    expect(r.status).toBe(401);
  });

  test("logout clears the cookie", async () => {
    const r = await request(app).post("/api/members-auth/logout");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });
});
