import { beforeAll, describe, test, expect, vi } from "vitest";
import { ensureCaptureLoopSchema } from "./testHelpers.js";

vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-admin-people-secret";
});

import type { Express } from "express";
import request from "supertest";
import { createHmac } from "crypto";
import pool from "../lib/db.js";

let app: Express;
const stamp = Date.now().toString(36);

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

// palonur_users + palonur_waitlist are created via boot-time DDL in index.ts,
// NOT in the Drizzle schema, so syncSchemaAdditive won't provision them in the
// test DB — create them by hand.
async function ensurePalonurTables(): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS palonur_users (
    id SERIAL PRIMARY KEY,
    first_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS palonur_waitlist (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    source TEXT DEFAULT 'sleep-agent',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
}

// Unique per-run emails so parallel suites / reruns never collide.
const E = {
  // Same person across THREE sources — must dedupe to one row.
  multi: `multi.${stamp}@example.com`,
  // Case-insensitive dedup probe.
  caseLower: `case.${stamp}@example.com`,
  caseUpper: `CASE.${stamp}@example.com`,
  waitlist: `wait.${stamp}@example.com`,
  investor: `inv.${stamp}@example.com`,
  storyNamed: `story.${stamp}@example.com`,
  partner: `partner.${stamp}@example.com`,
  anon: `anon.${stamp}@example.com`,
};

let pubId = 0;

beforeAll(async () => {
  await ensureCaptureLoopSchema();
  await ensurePalonurTables();
  app = (await import("../app.js")).default;

  // account + billing + newsletter for the SAME email → one deduped person.
  await pool.query(
    `INSERT INTO palonur_users (first_name, email) VALUES ($1, $2)`,
    [`Multi ${stamp}`, E.multi],
  );
  await pool.query(
    `INSERT INTO consumer_accounts (email, stripe_customer_id) VALUES ($1, $2)
     ON CONFLICT (email) DO NOTHING`,
    [E.multi, `cus_${stamp}`],
  );

  const { rows: pubRows } = await pool.query<{ id: number }>(
    `INSERT INTO newsletter_publications (slug, name, is_house)
     VALUES ($1, $2, FALSE) RETURNING id`,
    [`people-pub-${stamp}`, `People Pub ${stamp}`],
  );
  pubId = pubRows[0].id;
  await pool.query(
    `INSERT INTO newsletter_subscribers (publication_id, email, name, status, unsubscribe_token)
     VALUES ($1, $2, $3, 'active', $4)
     ON CONFLICT (publication_id, email) DO NOTHING`,
    [pubId, E.multi, `Multi ${stamp}`, `unsub-multi-${stamp}`],
  );

  // Case-insensitive dedup: one newsletter row (lower) + one waitlist row (upper).
  await pool.query(
    `INSERT INTO newsletter_subscribers (publication_id, email, name, status, unsubscribe_token)
     VALUES ($1, $2, $3, 'pending', $4)
     ON CONFLICT (publication_id, email) DO NOTHING`,
    [pubId, E.caseLower, `Case ${stamp}`, `unsub-case-${stamp}`],
  );
  await pool.query(
    `INSERT INTO palonur_waitlist (name, email, source) VALUES ($1, $2, 'sleep-agent')`,
    [`Case ${stamp}`, E.caseUpper],
  );

  // Standalone waitlist person.
  await pool.query(
    `INSERT INTO palonur_waitlist (name, email, source) VALUES ($1, $2, 'sleep-agent')`,
    [`Waitlister ${stamp}`, E.waitlist],
  );

  // Investor with money that must NEVER be serialized.
  await pool.query(
    `INSERT INTO investors (name, email, role, status, commitment_cents, notes)
     VALUES ($1, $2, 'Angel', 'committed', 1234567, $3)
     ON CONFLICT (email) DO NOTHING`,
    [`Investor ${stamp}`, E.investor, `secret-note-${stamp}`],
  );

  // Named (non-anonymous) story + anonymous story (must be excluded).
  await pool.query(
    `INSERT INTO stories (draft_token, status, first_name, email, anonymous)
     VALUES ($1, 'new', $2, $3, FALSE)`,
    [`draft-named-${stamp}`, `Storyteller ${stamp}`, E.storyNamed],
  );
  await pool.query(
    `INSERT INTO stories (draft_token, status, first_name, email, anonymous)
     VALUES ($1, 'new', $2, $3, TRUE)`,
    [`draft-anon-${stamp}`, `Anon ${stamp}`, E.anon],
  );

  // Partner B2B contact.
  await pool.query(
    `INSERT INTO partner_keys (key_hash, key_prefix, partner_name, contact_email)
     VALUES ($1, $2, $3, $4)`,
    [`hash-${stamp}`, `pk_${stamp}`, `Partner Co ${stamp}`, E.partner],
  );
});

async function fetchPeople(qs = ""): Promise<{
  status: number;
  body: {
    people: Array<{
      email: string;
      name: string | null;
      sources: Array<{
        type: string;
        status: string | null;
        detail: string | null;
      }>;
      palonurUserId: number | null;
      consumerAccountId: number | null;
    }>;
    total: number;
    totalPeople: number;
    counts: Record<string, number>;
  };
}> {
  const res = await request(app)
    .get(`/api/admin/people${qs}`)
    .set("Cookie", ADMIN_COOKIE);
  return { status: res.status, body: res.body };
}

describe("admin people directory", () => {
  test("requires the palonur_admin cookie", async () => {
    const res = await request(app).get("/api/admin/people");
    expect(res.status).toBe(401);
  });

  test("dedupes the same email across multiple sources into one row", async () => {
    const { status, body } = await fetchPeople(
      `?q=${encodeURIComponent(E.multi)}`,
    );
    expect(status).toBe(200);
    const hits = body.people.filter((p) => p.email.toLowerCase() === E.multi);
    expect(hits.length).toBe(1);
    const types = hits[0].sources.map((s) => s.type).sort();
    expect(types).toContain("account");
    expect(types).toContain("billing");
    expect(types).toContain("newsletter");
    expect(hits[0].palonurUserId).not.toBeNull();
    expect(hits[0].consumerAccountId).not.toBeNull();
  });

  test("dedupes case-insensitively by email", async () => {
    const { body } = await fetchPeople(`?q=case.${stamp}`);
    const hits = body.people.filter(
      (p) => p.email.toLowerCase() === E.caseLower,
    );
    expect(hits.length).toBe(1);
    const types = hits[0].sources.map((s) => s.type).sort();
    expect(types).toContain("newsletter");
    expect(types).toContain("waitlist");
  });

  test("never serializes investor money (commitment/notes)", async () => {
    const { body } = await fetchPeople(`?q=${encodeURIComponent(E.investor)}`);
    const hit = body.people.find((p) => p.email.toLowerCase() === E.investor);
    expect(hit).toBeTruthy();
    const serialized = JSON.stringify(hit);
    expect(serialized).not.toContain("1234567");
    expect(serialized).not.toContain(`secret-note-${stamp}`);
    const inv = hit!.sources.find((s) => s.type === "investor");
    expect(inv?.status).toBe("committed");
    expect(inv?.detail).toBe("Angel");
  });

  test("excludes anonymous story submitters", async () => {
    const { body } = await fetchPeople(`?q=${encodeURIComponent(E.anon)}`);
    const hit = body.people.find((p) => p.email.toLowerCase() === E.anon);
    expect(hit).toBeUndefined();
  });

  test("includes named story submitters with story source", async () => {
    const { body } = await fetchPeople(
      `?q=${encodeURIComponent(E.storyNamed)}`,
    );
    const hit = body.people.find((p) => p.email.toLowerCase() === E.storyNamed);
    expect(hit).toBeTruthy();
    expect(hit!.sources.some((s) => s.type === "story")).toBe(true);
  });

  test("source filter returns only people with that source", async () => {
    const { body } = await fetchPeople(`?source=partner&q=${stamp}`);
    expect(body.people.length).toBeGreaterThan(0);
    for (const p of body.people) {
      expect(p.sources.some((s) => s.type === "partner")).toBe(true);
    }
    expect(body.people.some((p) => p.email.toLowerCase() === E.partner)).toBe(
      true,
    );
  });

  test("status filter matches a per-source status", async () => {
    const { body } = await fetchPeople(`?status=committed&q=${stamp}`);
    expect(body.people.some((p) => p.email.toLowerCase() === E.investor)).toBe(
      true,
    );
    for (const p of body.people) {
      expect(
        p.sources.some((s) => (s.status ?? "").toLowerCase() === "committed"),
      ).toBe(true);
    }
  });

  test("reports per-source counts and respects pagination limit", async () => {
    const { body } = await fetchPeople(`?limit=1&q=${stamp}`);
    expect(body.people.length).toBeLessThanOrEqual(1);
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(typeof body.counts.investor).toBe("number");
    expect(body.counts.partner).toBeGreaterThanOrEqual(1);
  });

  test("CSV export honors filters and omits investor money", async () => {
    const res = await request(app)
      .get(`/api/admin/people/export?q=${encodeURIComponent(E.investor)}`)
      .set("Cookie", ADMIN_COOKIE);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.text).toContain(E.investor);
    expect(res.text).not.toContain("1234567");
    expect(res.text).not.toContain(`secret-note-${stamp}`);
  });
});
