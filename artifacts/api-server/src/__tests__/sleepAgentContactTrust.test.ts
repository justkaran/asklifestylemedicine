import { beforeAll, afterAll, describe, test, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ensureCaptureLoopSchema } from "./testHelpers.js";

// The contact route delivers through the shared guarded Resend path via
// sendContactMessage — mock the helper so this suite asserts the route's
// contract (validation, rate limit, payload hand-off) without email I/O.
const sentMessages: Array<{
  name: string;
  email: string;
  message: string;
  context?: string | null;
}> = [];
vi.mock("../lib/contactEmail.js", () => ({
  sendContactMessage: vi.fn(async (args: {
    name: string;
    email: string;
    message: string;
    context?: string | null;
  }) => {
    sentMessages.push(args);
    return true;
  }),
}));

import type { Express } from "express";
import request from "supertest";
import pool from "../lib/db.js";

let app: Express;
// Real agent_queries rows minted for the trust tests; cleaned up in afterAll.
const seededQueryIds: string[] = [];

async function seedAnswer(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO agent_queries (session_id, question, answer_text)
     VALUES ($1, 'Does light timing matter?', 'ANSWER: yes')
     RETURNING id`,
    [`trust-test-${randomUUID()}`],
  );
  seededQueryIds.push(rows[0].id);
  return rows[0].id;
}

beforeAll(async () => {
  await ensureCaptureLoopSchema();
  app = (await import("../app.js")).default;
});

afterAll(async () => {
  if (seededQueryIds.length > 0) {
    await pool.query(
      `DELETE FROM answer_trust_votes WHERE query_id = ANY($1::text[])`,
      [seededQueryIds],
    );
    await pool.query(`DELETE FROM agent_queries WHERE id = ANY($1::uuid[])`, [
      seededQueryIds,
    ]);
  }
  await pool.end();
});

describe("POST /api/sleep-agent/trust — one vote per answer per visitor", () => {
  test("rejects a non-UUID queryId (blocked/errored turns are never voteable)", async () => {
    const res = await request(app)
      .post("/api/sleep-agent/trust")
      .set("Sec-Fetch-Site", "same-origin")
      .send({ queryId: "not-a-uuid", trusted: true });
    expect(res.status).toBe(400);
  });

  test("rejects a UUID that is not a logged answer", async () => {
    const res = await request(app)
      .post("/api/sleep-agent/trust")
      .set("Sec-Fetch-Site", "same-origin")
      .send({ queryId: randomUUID(), trusted: true });
    expect(res.status).toBe(404);
  });

  test("rejects a missing/non-boolean trusted flag", async () => {
    const queryId = await seedAnswer();
    const res = await request(app)
      .post("/api/sleep-agent/trust")
      .set("Sec-Fetch-Site", "same-origin")
      .send({ queryId, trusted: "yes" });
    expect(res.status).toBe(400);
  });

  test("records a vote, and re-voting updates the same row instead of stuffing the ballot", async () => {
    const queryId = await seedAnswer();

    const first = await request(app)
      .post("/api/sleep-agent/trust")
      .set("Sec-Fetch-Site", "same-origin")
      .send({ queryId, trusted: true });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, trusted: true });

    // Same visitor (same IP hash) votes again with the opposite answer:
    // the unique (query_id, voter_hash) upsert flips the row in place.
    const second = await request(app)
      .post("/api/sleep-agent/trust")
      .set("Sec-Fetch-Site", "same-origin")
      .send({ queryId, trusted: false });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ ok: true, trusted: false });

    const { rows } = await pool.query<{ trusted: boolean }>(
      `SELECT trusted FROM answer_trust_votes WHERE query_id = $1`,
      [queryId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].trusted).toBe(false);
  });

  test("GET /trust/mine restores the caller's own vote and nothing else", async () => {
    const queryId = await seedAnswer();
    await request(app)
      .post("/api/sleep-agent/trust")
      .set("Sec-Fetch-Site", "same-origin")
      .send({ queryId, trusted: true });

    const mine = await request(app)
      .get("/api/sleep-agent/trust/mine")
      .query({ queryId })
      .set("Sec-Fetch-Site", "same-origin");
    expect(mine.status).toBe(200);
    expect(mine.body.trusted).toBe(true);

    // An answer this visitor never voted on comes back null.
    const fresh = await seedAnswer();
    const none = await request(app)
      .get("/api/sleep-agent/trust/mine")
      .query({ queryId: fresh })
      .set("Sec-Fetch-Site", "same-origin");
    expect(none.status).toBe(200);
    expect(none.body.trusted).toBeNull();
  });
});

describe("POST /api/sleep-agent/contact — get personal help", () => {
  // NOTE: the route charges the per-IP hourly budget on EVERY request
  // (including rejected ones), and supertest requests all share one IP.
  // The assertions below are ordered so the running total stays within
  // the 5/hour budget until the final rate-limit test spends the rest.

  test("rejects an invalid email", async () => {
    const res = await request(app)
      .post("/api/sleep-agent/contact")
      .set("Sec-Fetch-Site", "same-origin")
      .send({ name: "Test", email: "not-an-email", message: "hello there" });
    expect(res.status).toBe(400);
    expect(sentMessages).toHaveLength(0);
  });

  test("rejects an empty/too-short message", async () => {
    const res = await request(app)
      .post("/api/sleep-agent/contact")
      .set("Sec-Fetch-Site", "same-origin")
      .send({ name: "Test", email: "reader@example.com", message: "hi" });
    expect(res.status).toBe(400);
    expect(sentMessages).toHaveLength(0);
  });

  test("delivers a valid message through the guarded email helper with trimmed fields + context", async () => {
    const res = await request(app)
      .post("/api/sleep-agent/contact")
      .set("Sec-Fetch-Site", "same-origin")
      .send({
        name: "  Jamie Reader  ",
        email: "Reader@Example.com",
        message: "  I would like help with my routine.  ",
        context: "what should I do about caffeine",
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({
      name: "Jamie Reader",
      email: "reader@example.com",
      message: "I would like help with my routine.",
      context: "what should I do about caffeine",
    });
  });

  test("rate-limits after the hourly per-IP budget is spent", async () => {
    // 3 requests consumed above; spend the rest of the 5/hour budget…
    for (let i = 0; i < 2; i++) {
      const ok = await request(app)
        .post("/api/sleep-agent/contact")
        .set("Sec-Fetch-Site", "same-origin")
        .send({
          name: "Budget",
          email: "reader@example.com",
          message: `budget spend ${i}`,
        });
      expect(ok.status).toBe(200);
    }
    // …then the next one must be refused.
    const blocked = await request(app)
      .post("/api/sleep-agent/contact")
      .set("Sec-Fetch-Site", "same-origin")
      .send({
        name: "Budget",
        email: "reader@example.com",
        message: "one message too many",
      });
    expect(blocked.status).toBe(429);
  });
});
