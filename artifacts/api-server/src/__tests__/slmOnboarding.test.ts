/**
 * SLM chat self-registration onboarding — POST /api/consumer/auth/register.
 *
 * Pins the security model of the "chat now, verify later" flow:
 *  1. A brand-new email gets an account (display_name = first name,
 *     email_verified_at NULL) plus a PROVISIONAL browser-session cookie
 *     (no Expires/Max-Age) that passes the standalone /api/slm-agent gate.
 *  2. Registering an EXISTING email (verified or not) NEVER issues a session:
 *     typing someone else's email cannot hijack their account, and a
 *     returning unverified visitor is blocked until the emailed link is
 *     clicked (their provisional cookie died with the browser).
 *  3. Consuming the magic link stamps email_verified_at and activates a
 *     newsletter opt-in recorded during onboarding — but ONLY subs with the
 *     onboarding source; a pending sub planted via the public form by a
 *     third party is never activated by a mere sign-in.
 *  4. The sliding-renewal middleware never converts a provisional cookie
 *     into a persistent one.
 *
 * Suite conventions: shared dev DB, beforeAll self-provisioning, serial files.
 */
import { beforeAll, beforeEach, afterAll, describe, test, expect, vi } from "vitest";
import { ensureCaptureLoopSchema } from "./testHelpers.js";

vi.hoisted(() => {
  process.env.RESEND_API_KEY = "stub-key";
  // The in-memory regIpHits map (billing.ts) persists across tests in this
  // suite; all registrations share the supertest loopback IP. Raise the daily
  // limit so the suite does not exhaust its own quota.
  process.env.CONSUMER_REG_IP_DAILY_LIMIT = "100";
});

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: async () => ({ id: "stub-id" }) };
  },
}));

vi.mock("../lib/resendClient.js", () => ({
  getResendClient: async () => null,
}));

import request from "supertest";
import app from "../app";
import pool from "../lib/db";

const STAMP = Date.now();
const createdEmails: string[] = [];

function trackedEmail(tag: string): string {
  const email = `slm-onboard-${tag}-${STAMP}@test.local`;
  createdEmails.push(email);
  return email;
}

/** The consumer session cookie from a response, or null. */
function consumerSetCookie(res: request.Response): string | null {
  const header = res.headers["set-cookie"] as string | string[] | undefined;
  const cookies = Array.isArray(header) ? header : header ? [header] : [];
  return cookies.find((c) => c.startsWith("palonur_consumer=")) ?? null;
}

beforeAll(async () => {
  await ensureCaptureLoopSchema();
});

// /consumer/auth/register sits behind the per-IP email throttle (5 hits per
// 15 min); this suite alone exceeds that from one supertest IP, so reset the
// window between tests (established suite convention for the shared dev DB).
beforeEach(async () => {
  await pool.query(`DELETE FROM email_rate_limit_hits`);
});

afterAll(async () => {
  for (const email of createdEmails) {
    await pool.query(`DELETE FROM newsletter_subscribers WHERE email = $1`, [email]);
    await pool.query(`DELETE FROM consumer_login_tokens WHERE email = $1`, [email]);
    await pool.query(`DELETE FROM consumer_accounts WHERE email = $1`, [email]);
  }
});

describe("POST /api/consumer/auth/register — new account", () => {
  test("creates the account, grants a provisional SESSION cookie, and records the newsletter opt-in as pending", async () => {
    const email = trackedEmail("new");
    const res = await request(app)
      .post("/api/consumer/auth/register")
      .send({ email, firstName: "Greta", newsletter: true, slmStandalone: true });
    expect(res.status).toBe(200);
    expect(res.body.provisional).toBe(true);
    expect(res.body.displayName).toBe("Greta");

    // Provisional cookie: prov:<id> value, and NO Expires/Max-Age — it must
    // die with the browser.
    const cookie = consumerSetCookie(res);
    expect(cookie).toBeTruthy();
    expect(decodeURIComponent(cookie!)).toContain("prov:");
    expect(cookie!.toLowerCase()).not.toContain("expires=");
    expect(cookie!.toLowerCase()).not.toContain("max-age=");

    const acct = await pool.query(
      `SELECT display_name, email_verified_at FROM consumer_accounts WHERE email = $1`,
      [email],
    );
    expect(acct.rows[0].display_name).toBe("Greta");
    expect(acct.rows[0].email_verified_at).toBeNull();

    // Newsletter opt-in: pending with the onboarding source (no separate
    // confirmation email flow — the account link doubles as confirmation).
    const sub = await pool.query(
      `SELECT status, source FROM newsletter_subscribers WHERE email = $1`,
      [email],
    );
    expect(sub.rows[0].status).toBe("pending");
    expect(sub.rows[0].source).toBe("slm-chat-onboarding");

    // A verification magic link was minted.
    const tokens = await pool.query(
      `SELECT magic_token FROM consumer_login_tokens WHERE email = $1`,
      [email],
    );
    expect(tokens.rows.length).toBe(1);

    // The provisional cookie passes the standalone chat gate (401 otherwise).
    const cookiePair = cookie!.split(";")[0];
    const gate = await request(app)
      .post("/api/slm-agent")
      .set("Sec-Fetch-Site", "same-origin")
      .set("Cookie", cookiePair)
      .send({ message: "What about circadian light?", standalone: true });
    expect(gate.status).not.toBe(401);

    // Sliding renewal must NOT upgrade a provisional cookie to persistent.
    const me = await request(app).get("/api/consumer/me").set("Cookie", cookiePair);
    expect(me.body.authenticated).toBe(true);
    expect(me.body.provisional).toBe(true);
    expect(me.body.emailVerified).toBe(false);
    expect(me.body.displayName).toBe("Greta");
    const renewed = consumerSetCookie(me);
    if (renewed) {
      expect(renewed.toLowerCase()).not.toContain("expires=");
      expect(renewed.toLowerCase()).not.toContain("max-age=");
    }
  });

  test("provisional cookie is capability-scoped: rejected by billing routes, and dead once the account verifies", async () => {
    const email = trackedEmail("scoped");
    const res = await request(app)
      .post("/api/consumer/auth/register")
      .send({ email, firstName: "Scopey" });
    const cookiePair = consumerSetCookie(res)!.split(";")[0];

    // Full-auth surfaces refuse a provisional session outright.
    const sub = await request(app)
      .get("/api/billing/subscription")
      .set("Cookie", cookiePair);
    expect(sub.status).toBe(401);

    // Once the account is verified (owner clicked their link), any lingering
    // provisional cookie is dead even on the surfaces that accepted it.
    await pool.query(
      `UPDATE consumer_accounts SET email_verified_at = NOW() WHERE email = $1`,
      [email],
    );
    const me = await request(app).get("/api/consumer/me").set("Cookie", cookiePair);
    expect(me.body.authenticated).toBe(false);
    // Include history so the anonymous "first free question" allowance does
    // not apply: a dead provisional cookie must be treated as signed out.
    const gate = await request(app)
      .post("/api/slm-agent")
      .set("Sec-Fetch-Site", "same-origin")
      .set("Cookie", cookiePair)
      .send({
        message: "What about circadian light?",
        standalone: true,
        history: [
          { role: "user", content: "How does sleep work?" },
          { role: "assistant", content: "Here is an overview." },
        ],
      });
    expect(gate.status).toBe(401);
  });

  test("GET /api/slm-agent/history returns only the signed-in consumer's own turns", async () => {
    const email = trackedEmail("history");
    const res = await request(app)
      .post("/api/consumer/auth/register")
      .send({ email, firstName: "Historia" });
    const cookiePair = consumerSetCookie(res)!.split(";")[0];
    const { rows } = await pool.query<{ id: number }>(
      `SELECT id FROM consumer_accounts WHERE email = $1`,
      [email],
    );
    const accountId = rows[0].id;

    // One row for this consumer, one legacy shared row, one for someone else.
    await pool.query(
      `INSERT INTO agent_queries (id, source, session_id, question, answer_text, was_uncovered)
       VALUES
         (gen_random_uuid(), 'slm-agent', $1, 'My own question?', 'ANSWER: Yours.', false),
         (gen_random_uuid(), 'slm-agent', 'slm-agent', 'Anonymous question?', 'ANSWER: Shared.', false),
         (gen_random_uuid(), 'slm-agent', 'consumer:999999999', 'Someone elses?', 'ANSWER: Theirs.', false),
         (gen_random_uuid(), 'slm-agent', $1, 'Fallback question?', 'A non-governed fallback answer.', true)`,
      [`consumer:${accountId}`],
    );

    const noAuth = await request(app).get("/api/slm-agent/history");
    expect(noAuth.status).toBe(401);

    const h = await request(app).get("/api/slm-agent/history").set("Cookie", cookiePair);
    expect(h.status).toBe(200);
    const questions = (h.body.turns as Array<{ question: string }>).map((t) => t.question);
    expect(questions).toEqual(["My own question?"]);

    await pool.query(
      `DELETE FROM agent_queries WHERE session_id IN ($1, 'consumer:999999999')
         OR (session_id = 'slm-agent' AND question = 'Anonymous question?')`,
      [`consumer:${accountId}`],
    );
  });

  test("no newsletter opt-in → no subscriber row", async () => {
    const email = trackedEmail("nonews");
    const res = await request(app)
      .post("/api/consumer/auth/register")
      .send({ email, firstName: "Nils", newsletter: false });
    expect(res.status).toBe(200);
    expect(res.body.provisional).toBe(true);
    const sub = await pool.query(
      `SELECT 1 FROM newsletter_subscribers WHERE email = $1`,
      [email],
    );
    expect(sub.rows.length).toBe(0);
  });

  test("rejects a missing first name", async () => {
    const res = await request(app)
      .post("/api/consumer/auth/register")
      .send({ email: trackedEmail("noname"), firstName: "   " });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/consumer/auth/register — existing account never gets a session", () => {
  test("unverified returning visitor: no cookie, must use the emailed link", async () => {
    const email = trackedEmail("returning");
    await request(app)
      .post("/api/consumer/auth/register")
      .send({ email, firstName: "First" });

    // Second registration attempt (browser closed, provisional cookie gone).
    const res = await request(app)
      .post("/api/consumer/auth/register")
      .send({ email, firstName: "Imposter" });
    expect(res.status).toBe(200);
    expect(res.body.provisional).toBe(false);
    expect(consumerSetCookie(res)).toBeNull();

    // The original display name is untouched.
    const acct = await pool.query(
      `SELECT display_name FROM consumer_accounts WHERE email = $1`,
      [email],
    );
    expect(acct.rows[0].display_name).toBe("First");
  });

  test("verified account (someone else's email): no cookie either", async () => {
    const email = trackedEmail("victim");
    await pool.query(
      `INSERT INTO consumer_accounts (email, email_verified_at) VALUES ($1, NOW())`,
      [email],
    );
    const res = await request(app)
      .post("/api/consumer/auth/register")
      .send({ email, firstName: "Mallory" });
    expect(res.status).toBe(200);
    expect(res.body.provisional).toBe(false);
    expect(consumerSetCookie(res)).toBeNull();
  });
});

describe("GET /api/consumer/auth/consume — verification side effects", () => {
  test("stamps email_verified_at and activates ONLY the onboarding newsletter opt-in", async () => {
    const email = trackedEmail("verify");
    await request(app)
      .post("/api/consumer/auth/register")
      .send({ email, firstName: "Vera", newsletter: true, slmStandalone: true });

    // A second, third-party-planted pending sub for a DIFFERENT email must
    // stay pending after Vera verifies.
    const otherEmail = trackedEmail("bystander");
    const house = await pool.query(
      `SELECT id FROM newsletter_publications WHERE is_house = true LIMIT 1`,
    );
    await pool.query(
      `INSERT INTO newsletter_subscribers
         (publication_id, email, status, source, unsubscribe_token, confirm_token)
       VALUES ($1, $2, 'pending', 'web', $3, $4)`,
      [house.rows[0].id, otherEmail, `unsub-${STAMP}`, `conf-${STAMP}`],
    );

    const tokenRow = await pool.query(
      `SELECT magic_token FROM consumer_login_tokens WHERE email = $1 ORDER BY id DESC LIMIT 1`,
      [email],
    );
    const consume = await request(app).get(
      `/api/consumer/auth/consume?token=${tokenRow.rows[0].magic_token}`,
    );
    expect(consume.status).toBe(200);

    // Full persistent cookie now (has an expiry), account verified.
    const cookie = consumerSetCookie(consume);
    expect(cookie).toBeTruthy();
    expect(decodeURIComponent(cookie!)).not.toContain("prov:");
    expect(cookie!.toLowerCase()).toContain("expires=");
    const acct = await pool.query(
      `SELECT email_verified_at FROM consumer_accounts WHERE email = $1`,
      [email],
    );
    expect(acct.rows[0].email_verified_at).not.toBeNull();

    // Onboarding opt-in flipped to active; the bystander row stays pending.
    const sub = await pool.query(
      `SELECT status, confirmed_at FROM newsletter_subscribers WHERE email = $1`,
      [email],
    );
    expect(sub.rows[0].status).toBe("active");
    expect(sub.rows[0].confirmed_at).not.toBeNull();
    const other = await pool.query(
      `SELECT status FROM newsletter_subscribers WHERE email = $1`,
      [otherEmail],
    );
    expect(other.rows[0].status).toBe("pending");
  });

  test("a pending sub with a NON-onboarding source for the SAME email is not activated by sign-in", async () => {
    const email = trackedEmail("webform");
    const house = await pool.query(
      `SELECT id FROM newsletter_publications WHERE is_house = true LIMIT 1`,
    );
    await pool.query(
      `INSERT INTO newsletter_subscribers
         (publication_id, email, status, source, unsubscribe_token, confirm_token)
       VALUES ($1, $2, 'pending', 'web', $3, $4)`,
      [house.rows[0].id, email, `unsub2-${STAMP}`, `conf2-${STAMP}`],
    );
    // Sign in via a plain magic link (no onboarding).
    const token = `tok-${STAMP}-webform`;
    await pool.query(
      `INSERT INTO consumer_login_tokens (email, magic_token, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '30 minutes')`,
      [email, token],
    );
    const consume = await request(app).get(`/api/consumer/auth/consume?token=${token}`);
    expect(consume.status).toBe(200);
    const sub = await pool.query(
      `SELECT status FROM newsletter_subscribers WHERE email = $1`,
      [email],
    );
    expect(sub.rows[0].status).toBe("pending");
  });
});
