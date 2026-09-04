import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

vi.hoisted(() => {
  process.env.SESSION_SECRET ||= "test-save-answer-secret";
});

// ---------------------------------------------------------------------------
// POST /api/save-answer — the "email me this answer" onboarding step.
// Contract under guard:
//   - ownership: only the browser (palonur_session cookie) that asked may
//     email the answer (401 no cookie, 403 wrong cookie),
//   - redirect/empty answers are never emailable (409),
//   - happy path creates an identity-only consumer account, links the visitor
//     session, mints a 7-day magic-link token, and emails via sendAnswerEmail,
//   - newsletter opt-in is a SEPARATE explicit choice and only ever starts the
//     double opt-in (subscriber stays `pending`).
// ---------------------------------------------------------------------------

// Stub the answer email so no real Resend delivery is attempted and we can
// assert what would have been sent.
const sendAnswerEmailMock = vi.hoisted(() =>
  vi.fn(async (_args: unknown) => true),
);
vi.mock("../lib/answerEmail.js", () => ({
  sendAnswerEmail: sendAnswerEmailMock,
}));

// The newsletter double opt-in sends a confirmation email — stub only the
// send functions, keep the real subscribe logic (pending row + confirm token).
vi.mock("../lib/newsletterEmail", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    sendSubscriberConfirmationEmail: async () => true,
    sendWelcomeEmail: async () => true,
    sendNewsletterEmail: async () => true,
    sendNewsletterPortalLink: async () => true,
  };
});

import type { Express } from "express";
import request from "supertest";
import pool from "../lib/db.js";
import { ensureCaptureLoopSchema } from "./testHelpers.js";
import { __resetEmailRateLimitForTests } from "../middlewares/emailRateLimit.js";

let app: Express;

const TEST_DOMAIN = "save-answer-test.local";

function uniqueEmail(tag: string): string {
  return `${tag}-${Math.random().toString(36).slice(2)}@${TEST_DOMAIN}`;
}

function newSession(): string {
  return crypto.randomUUID();
}

async function seedQuery(args: {
  sessionId: string;
  answer?: string;
  source?: string;
  question?: string;
}): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO agent_queries (session_id, question, answer_text, source)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [
      args.sessionId,
      args.question ?? "Why do I wake at 3am?",
      args.answer ?? "Because circadian pressure dips. (test answer)",
      args.source ?? "sleep-agent",
    ],
  );
  return (rows[0] as { id: string }).id;
}

beforeAll(async () => {
  await ensureCaptureLoopSchema();
  app = (await import("../app.js")).default;
}, 60_000);

beforeEach(async () => {
  sendAnswerEmailMock.mockClear();
  await __resetEmailRateLimitForTests();
});

describe("POST /api/save-answer", () => {
  test("400 on invalid body", async () => {
    const res = await request(app)
      .post("/api/save-answer")
      .set("Cookie", `palonur_session=${newSession()}`)
      .send({ queryId: "not-a-uuid", email: "not-an-email" });
    expect(res.status).toBe(400);
  });

  test("401 without a session cookie", async () => {
    const sessionId = newSession();
    const queryId = await seedQuery({ sessionId });
    const res = await request(app)
      .post("/api/save-answer")
      .send({ queryId, email: uniqueEmail("nocookie") });
    expect(res.status).toBe(401);
    expect(sendAnswerEmailMock).not.toHaveBeenCalled();
  });

  test("403 when the cookie is not the asking session (leaked queryId)", async () => {
    const sessionId = newSession();
    const queryId = await seedQuery({ sessionId });
    const res = await request(app)
      .post("/api/save-answer")
      .set("Cookie", `palonur_session=${newSession()}`)
      .send({ queryId, email: uniqueEmail("thief") });
    expect(res.status).toBe(403);
    expect(sendAnswerEmailMock).not.toHaveBeenCalled();
  });

  test("embed-agent rows are unreachable even with a forged constant cookie", async () => {
    // embed-agent logs the literal 'embed-agent' as session_id — an attacker
    // with a leaked queryId could forge the cookie to that constant. The
    // source filter must keep such rows out of the save path entirely.
    const queryId = await seedQuery({
      sessionId: "embed-agent",
      source: "embed-agent",
    });
    const res = await request(app)
      .post("/api/save-answer")
      .set("Cookie", "palonur_session=embed-agent")
      .send({ queryId, email: uniqueEmail("embed-forge") });
    expect([403, 409]).toContain(res.status);
    expect(sendAnswerEmailMock).not.toHaveBeenCalled();
  }, 20_000);

  test("happy path: account + linked visitor session + 7-day token + email, NO newsletter by default", async () => {
    const sessionId = newSession();
    const queryId = await seedQuery({ sessionId });
    const email = uniqueEmail("happy");

    const res = await request(app)
      .post("/api/save-answer")
      .set("Cookie", `palonur_session=${sessionId}`)
      .send({ queryId, email });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      emailed: true,
      newsletterPending: false,
    });

    // Identity-only consumer account exists.
    const account = await pool.query(
      `SELECT id FROM consumer_accounts WHERE email = $1`,
      [email],
    );
    expect(account.rowCount).toBe(1);
    const accountId = (account.rows[0] as { id: number }).id;

    // Visitor session linked to the account, but NOT claimed (email unproven).
    const visitor = await pool.query(
      `SELECT consumer_account_id, claimed_at FROM visitor_sessions WHERE session_id = $1`,
      [sessionId],
    );
    expect(visitor.rowCount).toBe(1);
    expect(
      (visitor.rows[0] as { consumer_account_id: number }).consumer_account_id,
    ).toBe(accountId);
    expect((visitor.rows[0] as { claimed_at: null }).claimed_at).toBeNull();

    // Magic-link token is long-lived (~7 days, not the 30-minute sign-in).
    const token = await pool.query(
      `SELECT magic_token, expires_at FROM consumer_login_tokens
        WHERE email = $1 ORDER BY id DESC LIMIT 1`,
      [email],
    );
    expect(token.rowCount).toBe(1);
    const expiresAt = new Date(
      (token.rows[0] as { expires_at: string }).expires_at,
    );
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(
      6 * 24 * 60 * 60 * 1000,
    );

    // The email carries the answer + the sleep return path.
    expect(sendAnswerEmailMock).toHaveBeenCalledTimes(1);
    const args = sendAnswerEmailMock.mock.calls[0][0] as {
      to: string;
      next: string;
      loginToken: string;
      sources: unknown[];
    };
    expect(args.to).toBe(email);
    expect(args.next).toBe("/sleep?claimed=1");
    expect(args.loginToken).toBe(
      (token.rows[0] as { magic_token: string }).magic_token,
    );
    expect(args.sources).toEqual([]);

    // No newsletter row without the explicit opt-in.
    const sub = await pool.query(
      `SELECT 1 FROM newsletter_subscribers WHERE email = $1`,
      [email],
    );
    expect(sub.rowCount).toBe(0);
  }, 20_000);

  test("newsletter opt-in starts double opt-in only (subscriber stays pending)", async () => {
    const sessionId = newSession();
    const queryId = await seedQuery({ sessionId });
    const email = uniqueEmail("optin");

    const res = await request(app)
      .post("/api/save-answer")
      .set("Cookie", `palonur_session=${sessionId}`)
      .send({ queryId, email, newsletterOptIn: true });

    expect(res.status).toBe(200);
    expect(res.body.newsletterPending).toBe(true);

    const sub = await pool.query(
      `SELECT status, confirm_token, source FROM newsletter_subscribers WHERE email = $1`,
      [email],
    );
    expect(sub.rowCount).toBe(1);
    const row = sub.rows[0] as {
      status: string;
      confirm_token: string | null;
      source: string;
    };
    expect(row.status).toBe("pending");
    expect(row.confirm_token).toBeTruthy();
    expect(row.source).toBe("save-answer");
  }, 20_000);
});
