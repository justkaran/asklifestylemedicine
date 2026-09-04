import { beforeAll, afterAll, describe, test, expect } from "vitest";

import type { Express } from "express";
import request from "supertest";
import pool from "../lib/db.js";

let app: Express;
const createdEmails: string[] = [];

// The api-server Vitest suite imports app.ts (not index.ts), so the boot-time
// DDL that creates palonur_users never runs here — self-provision it
// idempotently. See .agents/memory/api-server-test-schema.md.
async function ensureUsersSchema(): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS palonur_users (
    id SERIAL PRIMARY KEY,
    first_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    timezone TEXT,
    email_opted_out BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for registerDerivedName.test.ts");
  }
  await ensureUsersSchema();
  app = (await import("../app")).default;
});

afterAll(async () => {
  if (createdEmails.length) {
    await pool.query(`DELETE FROM palonur_users WHERE email = ANY($1::text[])`, [
      createdEmails,
    ]);
  }
});

function uniqueEmail(local: string): string {
  const email = `${local}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
  createdEmails.push(email);
  return email;
}

describe("POST /api/register — optional first_name", () => {
  test("derives a capitalized first name from the email local-part when name is omitted", async () => {
    const email = uniqueEmail("ana.garcia42");
    const res = await request(app).post("/api/register").send({ email });
    expect(res.status).toBe(200);
    expect(res.body.userId).toBeTruthy();
    expect(res.body.first_name).toBe("Ana");

    const row = await pool.query(
      `SELECT first_name FROM palonur_users WHERE email = $1`,
      [email],
    );
    expect(row.rows[0].first_name).toBe("Ana");
  });

  test("falls back to 'Friend' when the local-part has no letters", async () => {
    const email = uniqueEmail("12345");
    const res = await request(app).post("/api/register").send({ email });
    expect(res.status).toBe(200);
    // local-part is "12345-<timestamp>-<rand>" — digits/punctuation only.
    expect(res.body.first_name).toBe("Friend");
  });

  test("still honors an explicit first_name", async () => {
    const email = uniqueEmail("explicit");
    const res = await request(app)
      .post("/api/register")
      .send({ email, first_name: "Marisol" });
    expect(res.status).toBe(200);
    expect(res.body.first_name).toBe("Marisol");
  });

  test("rejects a missing email with 400", async () => {
    const res = await request(app).post("/api/register").send({ first_name: "NoEmail" });
    expect(res.status).toBe(400);
  });
});
