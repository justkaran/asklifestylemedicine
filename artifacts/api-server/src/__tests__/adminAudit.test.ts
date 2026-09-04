import { afterAll, beforeAll, describe, test, expect, vi } from "vitest";
import { ensureCaptureLoopSchema } from "./testHelpers.js";

vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-admin-audit-secret";
});

import type { Express } from "express";
import request from "supertest";
import { createHmac } from "crypto";
import pool from "../lib/db.js";

let app: Express;
const stamp = Date.now().toString(36);
let pillarId = 0;
let sourceId = 0;

function signCookie(val: string, secret: string): string {
  const hash = createHmac("sha256", secret)
    .update(val)
    .digest("base64")
    .replace(/=+$/, "");
  return val + "." + hash;
}
function signed(value: string): string {
  return "s:" + signCookie(value, process.env.SESSION_SECRET as string);
}
const adminCookie = () => `palonur_admin=${encodeURIComponent(signed("1"))}`;

beforeAll(async () => {
  await ensureCaptureLoopSchema();
  app = (await import("../app.js")).default;

  const { rows: pr } = await pool.query<{ id: number }>(
    `INSERT INTO pillars (slug, name) VALUES ($1, $2) RETURNING id`,
    [`audit-${stamp}`, `Audit Test Pillar ${stamp}`],
  );
  pillarId = pr[0].id;

  const { rows: sr } = await pool.query<{ id: number }>(
    `INSERT INTO sources (pillar_id, kind, title, authors, year, journal, status)
     VALUES ($1, 'paper', $2, $3, $4, $5, 'approved') RETURNING id`,
    [pillarId, "Audit test paper on light and sleep", "Zeitzer J", 2000, "J Physiol"],
  );
  sourceId = sr[0].id;

  const answered = [
    "ANSWER:",
    "Bright light in the evening can delay your clock.",
    "",
    "CITATION:",
    "Zeitzer et al., 2000, J Physiol",
    "",
    "PAPER:",
    '"Audit test paper on light and sleep"',
  ].join("\n");

  // Answered + verified citation, with a retrieved source.
  await pool.query(
    `INSERT INTO agent_queries
       (session_id, source, question, pillar_ids, retrieved_source_ids,
        top_score, was_uncovered, answer_text, created_at)
     VALUES ($1,'sleep-agent',$2,$3,$4,$5,FALSE,$6, now())`,
    [
      `audit-sess-${stamp}`,
      `audit-answered-${stamp}`,
      [pillarId],
      [sourceId],
      0.82,
      answered,
    ],
  );

  // Cleanly refused (off-topic).
  await pool.query(
    `INSERT INTO agent_queries
       (session_id, source, question, pillar_ids, retrieved_source_ids,
        top_score, was_uncovered, answer_text, created_at)
     VALUES ($1,'sleep-agent',$2,$3,$4,$5,FALSE,$6, now())`,
    [
      `audit-sess-${stamp}`,
      `audit-refused-${stamp}`,
      [pillarId],
      [],
      0,
      "REFUSE: That is outside what I can help with.",
    ],
  );

  // Uncovered (sleep but out of corpus), user-flagged.
  await pool.query(
    `INSERT INTO agent_queries
       (session_id, source, question, pillar_ids, retrieved_source_ids,
        top_score, was_uncovered, answer_text, user_flagged, flag_reason, created_at)
     VALUES ($1,'sleep-agent',$2,$3,$4,$5,TRUE,$6,TRUE,$7, now())`,
    [
      `audit-sess-${stamp}`,
      `audit-uncovered-${stamp}`,
      [pillarId],
      [],
      0.21,
      "UNCOVERED: I don't have an approved source on that yet.",
      "felt wrong",
    ],
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM agent_queries WHERE question LIKE $1`, [
    `audit-%-${stamp}`,
  ]);
  await pool.query(`DELETE FROM sources WHERE id = $1`, [sourceId]);
  await pool.query(`DELETE FROM pillars WHERE id = $1`, [pillarId]);
});

describe("GET /api/admin/audit", () => {
  test("rejects an unauthenticated caller", async () => {
    const res = await request(app).get("/api/admin/audit");
    expect(res.status).toBe(401);
  });

  test("returns summary + rows with outcome classification for an admin", async () => {
    const res = await request(app)
      .get("/api/admin/audit?limit=500")
      .set("Cookie", adminCookie());
    expect(res.status).toBe(200);

    const mine = (res.body.rows as Array<{ question: string }>).filter((r) =>
      r.question.endsWith(`-${stamp}`),
    );
    expect(mine.length).toBe(3);

    const byQ = Object.fromEntries(
      (res.body.rows as Array<Record<string, unknown>>)
        .filter((r) => String(r.question).endsWith(`-${stamp}`))
        .map((r) => [String(r.question), r]),
    );

    const answered = byQ[`audit-answered-${stamp}`];
    expect(answered.outcome).toBe("answered");
    expect(answered.citationVerification).toBe("verified");
    expect((answered.citations as unknown[]).length).toBe(1);

    expect(byQ[`audit-refused-${stamp}`].outcome).toBe("refused");

    const uncovered = byQ[`audit-uncovered-${stamp}`];
    expect(uncovered.outcome).toBe("uncovered");
    expect(uncovered.userFlagged).toBe(true);
    expect(uncovered.flagReason).toBe("felt wrong");

    // Summary aggregates over the whole window must reflect our three rows.
    expect(res.body.summary.answered).toBeGreaterThanOrEqual(1);
    expect(res.body.summary.refused).toBeGreaterThanOrEqual(1);
    expect(res.body.summary.uncovered).toBeGreaterThanOrEqual(1);
    expect(res.body.summary.answeredVerified).toBeGreaterThanOrEqual(1);
    expect(res.body.summary.flagged).toBeGreaterThanOrEqual(1);
  });

  test("filter=refused excludes answered rows", async () => {
    const res = await request(app)
      .get("/api/admin/audit?limit=500&filter=refused")
      .set("Cookie", adminCookie());
    expect(res.status).toBe(200);
    const mine = (res.body.rows as Array<{ question: string; outcome: string }>)
      .filter((r) => r.question.endsWith(`-${stamp}`));
    expect(mine.length).toBe(2);
    expect(mine.every((r) => r.outcome !== "answered")).toBe(true);
  });
});

describe("GET /api/admin/audit/export", () => {
  test("rejects an unauthenticated caller", async () => {
    const res = await request(app).get("/api/admin/audit/export");
    expect(res.status).toBe(401);
  });

  test("returns CSV with a header row and PII-free columns for an admin", async () => {
    const res = await request(app)
      .get("/api/admin/audit/export")
      .set("Cookie", adminCookie());
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const body = res.text;
    expect(body.split("\n")[0]).toContain("citation_verification");
    expect(body).toContain(`audit-answered-${stamp}`);
    // Never leak the session id.
    expect(body).not.toContain(`audit-sess-${stamp}`);
  });
});
