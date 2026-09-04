import { beforeAll, beforeEach, afterAll, describe, test, expect } from "vitest";

import type { Express } from "express";
import request from "supertest";
import pool from "../lib/db.js";

let app: Express;
let userId: number;
let commitmentA: number;
let commitmentB: number;

// The api-server Vitest suite imports app.ts (not index.ts), so the boot-time
// DDL that creates palonur_tonights_focus never runs here — self-provision it
// (and its FK parents) idempotently. See .agents/memory/api-server-test-schema.md.
async function ensureTonightsFocusSchema(): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS palonur_users (
    id SERIAL PRIMARY KEY,
    first_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    timezone TEXT,
    email_opted_out BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS palonur_commitments (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES palonur_users(id) ON DELETE CASCADE,
    action_text TEXT NOT NULL,
    sleep_question TEXT,
    check_in_token TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS palonur_tonights_focus (
    user_id INTEGER NOT NULL REFERENCES palonur_users(id) ON DELETE CASCADE,
    focus_date DATE NOT NULL,
    commitment_id INTEGER NOT NULL REFERENCES palonur_commitments(id) ON DELETE CASCADE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, focus_date)
  )`);
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for tonightsFocus.test.ts");
  }
  await ensureTonightsFocusSchema();
  app = (await import("../app")).default;

  const u = await pool.query(
    `INSERT INTO palonur_users (first_name, email) VALUES ($1, $2) RETURNING id`,
    ["Focus", `focus-${Date.now()}@test.local`],
  );
  userId = u.rows[0].id as number;

  const a = await pool.query(
    `INSERT INTO palonur_commitments (user_id, action_text) VALUES ($1, $2) RETURNING id`,
    [userId, "Dim the lights at 9pm"],
  );
  commitmentA = a.rows[0].id as number;
  const b = await pool.query(
    `INSERT INTO palonur_commitments (user_id, action_text) VALUES ($1, $2) RETURNING id`,
    [userId, "No screens after 10pm"],
  );
  commitmentB = b.rows[0].id as number;
});

beforeEach(async () => {
  await pool.query(`DELETE FROM palonur_tonights_focus WHERE user_id = $1`, [userId]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM palonur_users WHERE id = $1`, [userId]);
});

describe("tonight's focus — cross-device memory", () => {
  test("POST upserts a pick for the given user + day", async () => {
    const res = await request(app)
      .post("/api/tonights-focus")
      .send({ user_id: userId, commitment_id: commitmentA, focus_date: "2026-06-09" })
      .expect(200);
    expect(res.body).toEqual({ date: "2026-06-09", commitmentId: commitmentA });

    const { rows } = await pool.query(
      `SELECT to_char(focus_date,'YYYY-MM-DD') AS d, commitment_id FROM palonur_tonights_focus WHERE user_id = $1`,
      [userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ d: "2026-06-09", commitment_id: commitmentA });
  });

  test("a second POST for the same day overwrites the pick (no duplicate rows)", async () => {
    await request(app)
      .post("/api/tonights-focus")
      .send({ user_id: userId, commitment_id: commitmentA, focus_date: "2026-06-09" })
      .expect(200);
    const res = await request(app)
      .post("/api/tonights-focus")
      .send({ user_id: userId, commitment_id: commitmentB, focus_date: "2026-06-09" })
      .expect(200);
    expect(res.body).toEqual({ date: "2026-06-09", commitmentId: commitmentB });

    const { rows } = await pool.query(
      `SELECT commitment_id FROM palonur_tonights_focus WHERE user_id = $1 AND focus_date = '2026-06-09'`,
      [userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].commitment_id).toBe(commitmentB);
  });

  test("GET /active-commitment returns the latest tonightsFocus { date, commitmentId }", async () => {
    await request(app)
      .post("/api/tonights-focus")
      .send({ user_id: userId, commitment_id: commitmentA, focus_date: "2026-06-08" })
      .expect(200);
    await request(app)
      .post("/api/tonights-focus")
      .send({ user_id: userId, commitment_id: commitmentB, focus_date: "2026-06-09" })
      .expect(200);

    const res = await request(app)
      .get(`/api/active-commitment/${userId}`)
      .expect(200);
    expect(res.body.tonightsFocus).toEqual({ date: "2026-06-09", commitmentId: commitmentB });
  });

  test("tonightsFocus is null when the user has no pick", async () => {
    const res = await request(app)
      .get(`/api/active-commitment/${userId}`)
      .expect(200);
    expect(res.body.tonightsFocus).toBeNull();
  });

  test("a missing focus_date falls back to CURRENT_DATE", async () => {
    const today = (
      await pool.query<{ d: string }>(`SELECT to_char(CURRENT_DATE,'YYYY-MM-DD') AS d`)
    ).rows[0].d;
    const res = await request(app)
      .post("/api/tonights-focus")
      .send({ user_id: userId, commitment_id: commitmentA })
      .expect(200);
    expect(res.body).toEqual({ date: today, commitmentId: commitmentA });
  });

  test("an invalid focus_date falls back to CURRENT_DATE", async () => {
    const today = (
      await pool.query<{ d: string }>(`SELECT to_char(CURRENT_DATE,'YYYY-MM-DD') AS d`)
    ).rows[0].d;
    const res = await request(app)
      .post("/api/tonights-focus")
      .send({ user_id: userId, commitment_id: commitmentA, focus_date: "not-a-date" })
      .expect(200);
    expect(res.body).toEqual({ date: today, commitmentId: commitmentA });
  });

  test("POST without commitment_id is rejected", async () => {
    await request(app)
      .post("/api/tonights-focus")
      .send({ user_id: userId })
      .expect(400);
  });
});

describe("tonight's focus — cascade cleanup", () => {
  // These tests delete their own fixtures, so they each provision an isolated
  // user + commitment instead of touching the shared beforeAll rows.
  async function makeUser(): Promise<number> {
    const u = await pool.query(
      `INSERT INTO palonur_users (first_name, email) VALUES ($1, $2) RETURNING id`,
      ["Cascade", `cascade-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`],
    );
    return u.rows[0].id as number;
  }

  async function makeCommitment(uid: number): Promise<number> {
    const c = await pool.query(
      `INSERT INTO palonur_commitments (user_id, action_text) VALUES ($1, $2) RETURNING id`,
      [uid, "Wind down by 9:30pm"],
    );
    return c.rows[0].id as number;
  }

  test("deleting the pinned commitment removes the focus row and nulls tonightsFocus", async () => {
    const uid = await makeUser();
    const cid = await makeCommitment(uid);

    await request(app)
      .post("/api/tonights-focus")
      .send({ user_id: uid, commitment_id: cid, focus_date: "2026-06-09" })
      .expect(200);

    // Sanity: the focus row exists and is surfaced.
    let res = await request(app).get(`/api/active-commitment/${uid}`).expect(200);
    expect(res.body.tonightsFocus).toEqual({ date: "2026-06-09", commitmentId: cid });

    // Delete just the commitment that was pinned as tonight's focus.
    await pool.query(`DELETE FROM palonur_commitments WHERE id = $1`, [cid]);

    const { rows } = await pool.query(
      `SELECT 1 FROM palonur_tonights_focus WHERE user_id = $1`,
      [uid],
    );
    expect(rows).toHaveLength(0);

    res = await request(app).get(`/api/active-commitment/${uid}`).expect(200);
    expect(res.body.tonightsFocus).toBeNull();

    await pool.query(`DELETE FROM palonur_users WHERE id = $1`, [uid]);
  });

  test("deleting the user cascades away the focus row", async () => {
    const uid = await makeUser();
    const cid = await makeCommitment(uid);

    await request(app)
      .post("/api/tonights-focus")
      .send({ user_id: uid, commitment_id: cid, focus_date: "2026-06-09" })
      .expect(200);

    await pool.query(`DELETE FROM palonur_users WHERE id = $1`, [uid]);

    const { rows } = await pool.query(
      `SELECT 1 FROM palonur_tonights_focus WHERE user_id = $1`,
      [uid],
    );
    expect(rows).toHaveLength(0);
  });
});
