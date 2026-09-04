/**
 * Answer-format poll (avatar / podcast / text) — /api/format-votes.
 *
 * Covers: option validation, one-vote-per-visitor upsert semantics (re-voting
 * changes the choice instead of adding a row), distinct-voter tallies, the
 * self-lookup endpoint, and the admin-cookie gate on the tallies endpoint.
 *
 * Tests import app.ts (not index.ts), so boot-time DDL never runs — the table
 * is self-provisioned in beforeAll, mirroring the schema in
 * lib/db/src/schema/formatVotes.ts.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createHmac } from "crypto";
import app from "../app";
import pool from "../lib/db";

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
function adminCookie(): string {
  return `palonur_admin=${encodeURIComponent(signed("1"))}`;
}

// Distinct visitors are simulated via x-forwarded-for (the route hashes the
// first XFF hop). Use reserved TEST-NET addresses so nothing collides with
// rows another suite might write from the default supertest address.
const VOTER_A = "192.0.2.10";
const VOTER_B = "192.0.2.20";
const VOTER_C = "192.0.2.30";

async function tallies() {
  const { rows } = await pool.query(
    `SELECT option, count(*)::int AS n FROM answer_format_votes GROUP BY option`,
  );
  const out: Record<string, number> = { avatar: 0, podcast: 0, text: 0 };
  for (const r of rows) out[r.option] = r.n;
  return out;
}

beforeAll(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS answer_format_votes (
      id serial PRIMARY KEY,
      option text NOT NULL,
      voter_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS answer_format_votes_voter_hash_idx
      ON answer_format_votes (voter_hash);
  `);
});

beforeEach(async () => {
  await pool.query(`DELETE FROM answer_format_votes`);
});

afterAll(async () => {
  await pool.query(`DELETE FROM answer_format_votes`);
});

describe("POST /api/format-votes", () => {
  it("rejects a missing or unknown option", async () => {
    const r1 = await request(app).post("/api/format-votes").send({});
    expect(r1.status).toBe(400);
    const r2 = await request(app)
      .post("/api/format-votes")
      .send({ option: "hologram" });
    expect(r2.status).toBe(400);
    expect(await tallies()).toEqual({ avatar: 0, podcast: 0, text: 0 });
  });

  it("records a vote and returns the tallies", async () => {
    const res = await request(app)
      .post("/api/format-votes")
      .set("x-forwarded-for", VOTER_A)
      .send({ option: "avatar" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.counts).toEqual({ avatar: 1, podcast: 0, text: 0 });
    expect(res.body.total).toBe(1);
  });

  it("upserts by visitor: re-voting changes the choice, never adds a row", async () => {
    await request(app)
      .post("/api/format-votes")
      .set("x-forwarded-for", VOTER_A)
      .send({ option: "avatar" });
    const res = await request(app)
      .post("/api/format-votes")
      .set("x-forwarded-for", VOTER_A)
      .send({ option: "podcast" });
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ avatar: 0, podcast: 1, text: 0 });
    expect(res.body.total).toBe(1);
  });

  it("counts distinct visitors", async () => {
    await request(app)
      .post("/api/format-votes")
      .set("x-forwarded-for", VOTER_A)
      .send({ option: "avatar" });
    await request(app)
      .post("/api/format-votes")
      .set("x-forwarded-for", VOTER_B)
      .send({ option: "avatar" });
    const res = await request(app)
      .post("/api/format-votes")
      .set("x-forwarded-for", VOTER_C)
      .send({ option: "text" });
    expect(res.body.counts).toEqual({ avatar: 2, podcast: 0, text: 1 });
    expect(res.body.total).toBe(3);
  });
});

describe("GET /api/format-votes/mine", () => {
  it("returns the caller's own prior choice, or null", async () => {
    const before = await request(app)
      .get("/api/format-votes/mine")
      .set("x-forwarded-for", VOTER_A);
    expect(before.status).toBe(200);
    expect(before.body.option).toBeNull();

    await request(app)
      .post("/api/format-votes")
      .set("x-forwarded-for", VOTER_A)
      .send({ option: "podcast" });

    const after = await request(app)
      .get("/api/format-votes/mine")
      .set("x-forwarded-for", VOTER_A);
    expect(after.body.option).toBe("podcast");

    const other = await request(app)
      .get("/api/format-votes/mine")
      .set("x-forwarded-for", VOTER_B);
    expect(other.body.option).toBeNull();
  });
});

describe("GET /api/admin/format-votes", () => {
  it("401s without the admin cookie", async () => {
    const res = await request(app).get("/api/admin/format-votes");
    expect(res.status).toBe(401);
  });

  it("401s with a forged admin cookie", async () => {
    const res = await request(app)
      .get("/api/admin/format-votes")
      .set("Cookie", "palonur_admin=s%3A1.notarealsignature");
    expect(res.status).toBe(401);
  });

  it("returns tallies for an admin", async () => {
    await request(app)
      .post("/api/format-votes")
      .set("x-forwarded-for", VOTER_A)
      .send({ option: "text" });
    const res = await request(app)
      .get("/api/admin/format-votes")
      .set("Cookie", adminCookie());
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ avatar: 0, podcast: 0, text: 1 });
    expect(res.body.total).toBe(1);
    expect(res.body.lastVoteAt).toBeTruthy();
  });
});
