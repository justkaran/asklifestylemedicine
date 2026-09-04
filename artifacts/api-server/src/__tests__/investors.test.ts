import { afterAll, beforeAll, beforeEach, describe, test, expect, vi } from "vitest";

vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-investors-secret";
  process.env.RESEND_API_KEY = "stub-key";
});

// Capture magic-link emails instead of hitting Resend.
interface SentMagicLink {
  to: string;
  name: string;
  token: string;
}
const sentMagicLinks: SentMagicLink[] = [];

vi.mock("../lib/investorEmail", () => ({
  sendInvestorMagicLink: async (args: SentMagicLink) => {
    sentMagicLinks.push(args);
  },
}));

// The deck-sync helper walks the filesystem; stub it so importing the route
// (and any admin resync call) never touches disk in tests.
vi.mock("../lib/investorDecks", () => ({
  syncInvestorDecks: async () => ({ synced: 0, withHtml: 0 }),
}));

// Capture the prompt/system the cash-flow route sends to Anthropic, and return a
// deterministic plan so we can assert persistence without hitting the network.
const anthropicCalls: Array<{ system?: string; prompt: string }> = [];
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      create: async (args: {
        system?: string;
        messages: Array<{ content: string }>;
      }) => {
        anthropicCalls.push({
          system: args.system,
          prompt: args.messages[0]?.content ?? "",
        });
        return {
          content: [
            { type: "text", text: "Month 1: inflow $0, ending cash $1,000,000." },
          ],
        };
      },
    };
  }
  return { default: FakeAnthropic };
});

import type { Express } from "express";
import request from "supertest";
import { createHmac } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pool from "../lib/db.js";
import { AUTO_PLATFORM_ADMIN_EMAILS } from "../middlewares/facultyAuth.js";

const SECRET = "test-investors-secret";

function signCookie(val: string, secret: string): string {
  const hash = createHmac("sha256", secret)
    .update(val)
    .digest("base64")
    .replace(/=+$/, "");
  return val + "." + hash;
}

// A signed palonur_admin cookie (matches cookie-parser's s: prefix format).
const ADMIN_COOKIE = `palonur_admin=${encodeURIComponent(
  "s:" + signCookie("1", SECRET),
)}`;

let app: Express;

async function ensureInvestorSchema(): Promise<void> {
  await pool.query(`DO $$ BEGIN
    CREATE TYPE investor_status AS ENUM ('lead','committed','pending','passed');
  EXCEPTION WHEN duplicate_object THEN NULL; WHEN unique_violation THEN NULL; END $$;`);
  await pool.query(`DO $$ BEGIN
    CREATE TYPE investor_request_status AS ENUM ('open','in_progress','answered','closed');
  EXCEPTION WHEN duplicate_object THEN NULL; WHEN unique_violation THEN NULL; END $$;`);
  await pool.query(`CREATE TABLE IF NOT EXISTS investors (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT,
    status investor_status NOT NULL DEFAULT 'pending',
    commitment_cents INTEGER,
    notes TEXT,
    newsletter_access BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS investors_email_uniq ON investors (email)`,
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS investor_sessions (
    id SERIAL PRIMARY KEY,
    investor_id INTEGER NOT NULL REFERENCES investors(id) ON DELETE CASCADE,
    magic_token TEXT NOT NULL UNIQUE,
    session_token TEXT UNIQUE,
    consumed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    session_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS investor_decks (
    id SERIAL PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    html TEXT,
    listed BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS investor_deck_grants (
    id SERIAL PRIMARY KEY,
    investor_id INTEGER NOT NULL REFERENCES investors(id) ON DELETE CASCADE,
    deck_slug TEXT NOT NULL,
    granted_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS investor_deck_grants_uniq ON investor_deck_grants (investor_id, deck_slug)`,
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS investor_updates (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    body_html TEXT,
    pinned BOOLEAN NOT NULL DEFAULT FALSE,
    published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS investor_requests (
    id SERIAL PRIMARY KEY,
    investor_id INTEGER NOT NULL REFERENCES investors(id) ON DELETE CASCADE,
    subject TEXT NOT NULL,
    body TEXT,
    status investor_request_status NOT NULL DEFAULT 'open',
    response_html TEXT,
    responded_by TEXT,
    responded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS investor_documents (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    object_path TEXT,
    external_url TEXT,
    size_bytes INTEGER,
    content_type TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(
    `ALTER TABLE investor_documents ADD COLUMN IF NOT EXISTS size_bytes INTEGER, ADD COLUMN IF NOT EXISTS content_type TEXT`,
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS investor_settings (
    id TEXT PRIMARY KEY DEFAULT 'default',
    hotline_number TEXT,
    hotline_note TEXT,
    cap_table_note TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS investor_cash_flow (
    id TEXT PRIMARY KEY DEFAULT 'default',
    deck_slug TEXT NOT NULL,
    deck_title TEXT,
    target_date TEXT NOT NULL,
    total_committed_cents INTEGER NOT NULL,
    plan_text TEXT NOT NULL,
    generated_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for investors.test.ts");
  }
  // This legacy investor-only suite uses a non-Stanford fixture address. Keep
  // the exception local to the isolated test module.
  AUTO_PLATFORM_ADMIN_EMAILS.add("karan@palonur.com");
  await ensureInvestorSchema();
  app = (await import("../app")).default;
});

afterAll(() => {
  AUTO_PLATFORM_ADMIN_EMAILS.delete("karan@palonur.com");
});

beforeEach(async () => {
  sentMagicLinks.length = 0;
  await pool.query(
    `TRUNCATE investor_cash_flow, investor_deck_grants, investor_requests, investor_documents, investor_updates, investor_sessions, investors, investor_decks, investor_settings RESTART IDENTITY CASCADE`,
  );
});

function extractCookie(res: request.Response, name: string): string | null {
  const raw = res.headers["set-cookie"];
  if (!raw) return null;
  const list = Array.isArray(raw) ? raw : [raw];
  for (const c of list) {
    const m = c.match(new RegExp(`^${name}=([^;]+)`));
    if (m) return `${name}=${m[1]}`;
  }
  return null;
}

/** Create an investor (admin), then mint a logged-in session cookie for them. */
async function loginAs(email: string): Promise<{ id: number; cookie: string }> {
  const created = await request(app)
    .post("/api/investor-admin/investors")
    .set("Cookie", ADMIN_COOKIE)
    .send({ name: email.split("@")[0], email })
    .expect(200);
  const id = created.body.investor.id as number;

  // Issue + consume a magic link to get a real signed session cookie.
  const link = await request(app)
    .post(`/api/investor-admin/investors/${id}/magic-link`)
    .set("Cookie", ADMIN_COOKIE)
    .send({ send: false })
    .expect(200);
  const token = new URL(link.body.link).searchParams.get("token")!;
  const consumed = await request(app)
    .get(`/api/investor-auth/consume?token=${token}`)
    .expect(200);
  const cookie = extractCookie(consumed, "investor_session")!;
  return { id, cookie };
}

describe("investor auth", () => {
  test("magic-link request never leaks whether an email is on the allowlist", async () => {
    const unknown = await request(app)
      .post("/api/investor-auth/request")
      .set("X-Forwarded-For", "192.0.2.21")
      .send({ email: "stranger@example.com" })
      .expect(200);
    expect(unknown.body).toEqual({ ok: true });
    expect(sentMagicLinks).toHaveLength(0);

    await request(app)
      .post("/api/investor-admin/investors")
      .set("Cookie", ADMIN_COOKIE)
      .send({ name: "Reach", email: "reach@palonur.com" })
      .expect(200);
    const known = await request(app)
      .post("/api/investor-auth/request")
      .set("X-Forwarded-For", "192.0.2.22")
      .send({ email: "reach@palonur.com" })
      .expect(200);
    expect(known.body).toEqual({ ok: true });
    expect(sentMagicLinks).toHaveLength(1);
    expect(sentMagicLinks[0].to).toBe("reach@palonur.com");
  });

  test("portal requires a session", async () => {
    await request(app).get("/api/investor/portal").expect(401);
  });

  test("a consumed magic link cannot be reused", async () => {
    const { id } = await loginAs("once@palonur.com");
    const link = await request(app)
      .post(`/api/investor-admin/investors/${id}/magic-link`)
      .set("Cookie", ADMIN_COOKIE)
      .send({ send: false })
      .expect(200);
    const token = new URL(link.body.link).searchParams.get("token")!;
    await request(app).get(`/api/investor-auth/consume?token=${token}`).expect(200);
    await request(app).get(`/api/investor-auth/consume?token=${token}`).expect(400);
  });
});

describe("investor portal — money never leaks", () => {
  test("self profile + roster omit commitment and notes", async () => {
    // An admin sets a commitment on another investor.
    await request(app)
      .post("/api/investor-admin/investors")
      .set("Cookie", ADMIN_COOKIE)
      .send({
        name: "Big Check",
        email: "big@palonur.com",
        commitmentCents: 5_000_000,
        notes: "secret diligence note",
        status: "committed",
      })
      .expect(200);

    const { cookie } = await loginAs("viewer@palonur.com");
    const portal = await request(app)
      .get("/api/investor/portal")
      .set("Cookie", cookie)
      .expect(200);

    const body = portal.body;
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("commitmentCents");
    expect(serialized).not.toContain("5000000");
    expect(serialized).not.toContain("secret diligence note");
    expect(serialized).not.toContain("notes");

    // Roster shows names + role/status only.
    const big = body.roster.find((r: any) => r.name === "Big Check");
    expect(big).toBeTruthy();
    expect(big.status).toBe("committed");
    expect(big.commitmentCents).toBeUndefined();
    expect(big.email).toBeUndefined();

    // Cap table is the fixed founders snapshot with the faculty COI note.
    expect(body.capTable.rows.map((r: any) => r.percent)).toEqual([76, 4, 20]);
    expect(body.capTable.faculty).toEqual(["Michael", "Jamie", "Anne"]);
    expect(body.capTable.facultyNote).toMatch(/to be decided/i);

    // Hotline default joke.
    expect(body.hotline.note).toBe("Miss me? Call me :)");
    expect(body.hotline.number).toBeNull();
  });
});

describe("deck gating", () => {
  test("granted decks serve html; ungranted return 403", async () => {
    await pool.query(
      `INSERT INTO investor_decks (slug, title, html) VALUES ('reach','Reach Deck','<h1>Reach</h1>'), ('secret','Secret','<h1>Secret</h1>')`,
    );
    const { id, cookie } = await loginAs("granted@palonur.com");
    await request(app)
      .post(`/api/investor-admin/investors/${id}/grants`)
      .set("Cookie", ADMIN_COOKIE)
      .send({ deckSlug: "reach" })
      .expect(200);

    const ok = await request(app)
      .get("/api/investor/decks/reach")
      .set("Cookie", cookie)
      .expect(200);
    expect(ok.text).toContain("Reach");

    await request(app)
      .get("/api/investor/decks/secret")
      .set("Cookie", cookie)
      .expect(403);

    // Portal only lists the granted deck.
    const portal = await request(app)
      .get("/api/investor/portal")
      .set("Cookie", cookie)
      .expect(200);
    expect(portal.body.decks.map((d: any) => d.slug)).toEqual(["reach"]);
  });

  test("deck access is unauthenticated-safe", async () => {
    await pool.query(
      `INSERT INTO investor_decks (slug, title, html) VALUES ('reach','Reach Deck','<h1>Reach</h1>')`,
    );
    await request(app).get("/api/investor/decks/reach").expect(401);
  });

  test("a granted investor can download their deck as an attachment", async () => {
    await pool.query(
      `INSERT INTO investor_decks (slug, title, html) VALUES ('reach','Reach Deck','<h1>Reach</h1>')`,
    );
    const { id, cookie } = await loginAs("dl@palonur.com");
    await request(app)
      .post(`/api/investor-admin/investors/${id}/grants`)
      .set("Cookie", ADMIN_COOKIE)
      .send({ deckSlug: "reach" })
      .expect(200);
    const dl = await request(app)
      .get("/api/investor/decks/reach?download")
      .set("Cookie", cookie)
      .expect(200);
    expect(dl.headers["content-disposition"]).toContain("attachment");
    expect(dl.headers["content-disposition"]).toContain("reach.html");
    expect(dl.text).toContain("Reach");
  });

  test("admin can download any deck; non-admins cannot", async () => {
    await pool.query(
      `INSERT INTO investor_decks (slug, title, html) VALUES ('reach','Reach Deck','<h1>Reach</h1>')`,
    );
    const admin = await request(app)
      .get("/api/investor-admin/decks/reach/download")
      .set("Cookie", ADMIN_COOKIE)
      .expect(200);
    expect(admin.headers["content-disposition"]).toContain("attachment");
    expect(admin.text).toContain("Reach");

    // No admin cookie → rejected.
    await request(app).get("/api/investor-admin/decks/reach/download").expect(401);
    // Unknown deck → 404.
    await request(app)
      .get("/api/investor-admin/decks/nope/download")
      .set("Cookie", ADMIN_COOKIE)
      .expect(404);
  });
});

describe("requests", () => {
  test("an investor only sees their own requests", async () => {
    const a = await loginAs("a@palonur.com");
    const b = await loginAs("b@palonur.com");

    await request(app)
      .post("/api/investor/requests")
      .set("Cookie", a.cookie)
      .send({ subject: "A's question", body: "detail" })
      .expect(200);
    await request(app)
      .post("/api/investor/requests")
      .set("Cookie", b.cookie)
      .send({ subject: "B's question" })
      .expect(200);

    const aPortal = await request(app)
      .get("/api/investor/portal")
      .set("Cookie", a.cookie)
      .expect(200);
    expect(aPortal.body.requests).toHaveLength(1);
    expect(aPortal.body.requests[0].subject).toBe("A's question");

    // Admin sees both with investor attribution.
    const adminReqs = await request(app)
      .get("/api/investor-admin/requests")
      .set("Cookie", ADMIN_COOKIE)
      .expect(200);
    expect(adminReqs.body.requests).toHaveLength(2);
  });

  test("admin can answer a request and the investor sees the reply", async () => {
    const inv = await loginAs("ask@palonur.com");
    const created = await request(app)
      .post("/api/investor/requests")
      .set("Cookie", inv.cookie)
      .send({ subject: "Need the model" })
      .expect(200);
    const reqId = created.body.request.id as number;

    await request(app)
      .patch(`/api/investor-admin/requests/${reqId}`)
      .set("Cookie", ADMIN_COOKIE)
      .send({ status: "answered", responseHtml: "<p>Sent over email.</p>" })
      .expect(200);

    const portal = await request(app)
      .get("/api/investor/portal")
      .set("Cookie", inv.cookie)
      .expect(200);
    expect(portal.body.requests[0].status).toBe("answered");
    expect(portal.body.requests[0].responseHtml).toContain("Sent over email");
  });
});

describe("admin auth", () => {
  test("admin routes reject a missing or non-admin cookie", async () => {
    await request(app).get("/api/investor-admin/investors").expect(401);
    await request(app)
      .post("/api/investor-admin/investors")
      .send({ name: "X", email: "x@palonur.com" })
      .expect(401);
  });

  test("creating an investor with a duplicate email returns 409", async () => {
    await request(app)
      .post("/api/investor-admin/investors")
      .set("Cookie", ADMIN_COOKIE)
      .send({ name: "First", email: "dup@palonur.com" })
      .expect(200);
    await request(app)
      .post("/api/investor-admin/investors")
      .set("Cookie", ADMIN_COOKIE)
      .send({ name: "Second", email: "dup@palonur.com" })
      .expect(409);
  });

  test("status transition + commitment edit are admin-visible only", async () => {
    const created = await request(app)
      .post("/api/investor-admin/investors")
      .set("Cookie", ADMIN_COOKIE)
      .send({ name: "Lead Co", email: "lead@palonur.com", status: "pending" })
      .expect(200);
    const id = created.body.investor.id as number;

    const patched = await request(app)
      .patch(`/api/investor-admin/investors/${id}`)
      .set("Cookie", ADMIN_COOKIE)
      .send({ status: "lead", commitmentCents: 2_500_000 })
      .expect(200);
    expect(patched.body.investor.status).toBe("lead");
    expect(patched.body.investor.commitmentCents).toBe(2_500_000);
  });

  test("admin can edit name/notes/commitment; investors never receive money or notes", async () => {
    // Admin creates an investor with private notes + commitment.
    const created = await request(app)
      .post("/api/investor-admin/investors")
      .set("Cookie", ADMIN_COOKIE)
      .send({
        name: "Edit Me",
        email: "edit@palonur.com",
        status: "pending",
        commitmentCents: 1_000_000,
        notes: "intro via Reach",
      })
      .expect(200);
    const id = created.body.investor.id as number;
    expect(created.body.investor.notes).toBe("intro via Reach");

    // Admin edits the full record (name, commitment, notes).
    const patched = await request(app)
      .patch(`/api/investor-admin/investors/${id}`)
      .set("Cookie", ADMIN_COOKIE)
      .send({
        name: "Edited Name",
        commitmentCents: 7_500_000,
        notes: "verbal yes 2026-06-05",
      })
      .expect(200);
    expect(patched.body.investor.name).toBe("Edited Name");
    expect(patched.body.investor.commitmentCents).toBe(7_500_000);
    expect(patched.body.investor.notes).toBe("verbal yes 2026-06-05");

    // The edited investor logs in and must NOT see their own money/notes,
    // and must NOT see this investor's money/notes in the roster either.
    const { cookie } = await loginAs("rosterpeek@palonur.com");
    const portal = await request(app)
      .get("/api/investor/portal")
      .set("Cookie", cookie)
      .expect(200);
    const blob = JSON.stringify(portal.body);
    expect(blob).not.toContain("verbal yes");
    expect(blob).not.toContain("7500000");
    expect(blob).not.toContain("commitmentCents");
    const peer = portal.body.roster.find(
      (r: { email?: string; name: string }) => r.name === "Edited Name",
    );
    expect(peer).toBeTruthy();
    expect(peer.commitmentCents).toBeUndefined();
    expect(peer.notes).toBeUndefined();
  });

  test("an invalid status is rejected with 400 (not a DB 500)", async () => {
    const created = await request(app)
      .post("/api/investor-admin/investors")
      .set("Cookie", ADMIN_COOKIE)
      .send({ name: "Status Co", email: "status@palonur.com" })
      .expect(200);
    await request(app)
      .patch(`/api/investor-admin/investors/${created.body.investor.id}`)
      .set("Cookie", ADMIN_COOKIE)
      .send({ status: "totally-bogus" })
      .expect(400);
  });

  test("settings round-trip: hotline number surfaces to investors", async () => {
    await request(app)
      .put("/api/investor-admin/settings")
      .set("Cookie", ADMIN_COOKIE)
      .send({ hotlineNumber: "+1 555 0100", hotlineNote: "Ring me" })
      .expect(200);
    const { cookie } = await loginAs("caller@palonur.com");
    const portal = await request(app)
      .get("/api/investor/portal")
      .set("Cookie", cookie)
      .expect(200);
    expect(portal.body.hotline.number).toBe("+1 555 0100");
    expect(portal.body.hotline.note).toBe("Ring me");
  });
});

describe("roster ordering", () => {
  test("portal roster lists lead first, then committed, then in-conversation/passed", async () => {
    // Created out of priority order to prove sorting isn't just creation order.
    for (const [name, email, status] of [
      ["Passed Co", "passed@palonur.com", "passed"],
      ["Pending Co", "pending@palonur.com", "pending"],
      ["Committed Co", "committed@palonur.com", "committed"],
      ["Karan", "karan@palonur.com", "lead"],
    ] as const) {
      await request(app)
        .post("/api/investor-admin/investors")
        .set("Cookie", ADMIN_COOKIE)
        .send({ name, email, status })
        .expect(200);
    }

    const { cookie } = await loginAs("rosterview@palonur.com");
    const portal = await request(app)
      .get("/api/investor/portal")
      .set("Cookie", cookie)
      .expect(200);
    const statuses = portal.body.roster.map((r: { status: string }) => r.status);
    // lead → committed before any pending/passed.
    expect(statuses[0]).toBe("lead");
    expect(statuses[1]).toBe("committed");
    expect(statuses.indexOf("lead")).toBeLessThan(statuses.indexOf("committed"));
    expect(statuses.indexOf("committed")).toBeLessThan(
      statuses.indexOf("pending"),
    );
    expect(statuses.indexOf("pending")).toBeLessThan(statuses.indexOf("passed"));
  });
});

describe("lead-only summary + cash-flow (platform admin)", () => {
  async function seedCommitments() {
    await request(app)
      .post("/api/investor-admin/investors")
      .set("Cookie", ADMIN_COOKIE)
      .send({
        name: "Karan",
        email: "karan@palonur.com",
        status: "lead",
        commitmentCents: 2_000_000,
      })
      .expect(200);
    await request(app)
      .post("/api/investor-admin/investors")
      .set("Cookie", ADMIN_COOKIE)
      .send({
        name: "Committed Co",
        email: "committed@palonur.com",
        status: "committed",
        commitmentCents: 3_000_000,
      })
      .expect(200);
    // Pending money must NOT count toward the committed total.
    await request(app)
      .post("/api/investor-admin/investors")
      .set("Cookie", ADMIN_COOKIE)
      .send({
        name: "Maybe Co",
        email: "maybe@palonur.com",
        status: "pending",
        commitmentCents: 9_000_000,
      })
      .expect(200);
    await pool.query(
      `INSERT INTO investor_decks (slug, title, html) VALUES ('reach','Reach Deck','<h1>Reach</h1><p>Plan to grow.</p>')`,
    );
  }

  // Karan logs in with the magic-link flow; he was created in seedCommitments.
  async function loginAsKaran(): Promise<string> {
    const id = (
      await request(app)
        .get("/api/investor-admin/investors")
        .set("Cookie", ADMIN_COOKIE)
        .expect(200)
    ).body.investors.find(
      (i: { email: string }) => i.email === "karan@palonur.com",
    ).id as number;
    const link = await request(app)
      .post(`/api/investor-admin/investors/${id}/magic-link`)
      .set("Cookie", ADMIN_COOKIE)
      .send({ send: false })
      .expect(200);
    const token = new URL(link.body.link).searchParams.get("token")!;
    const consumed = await request(app)
      .get(`/api/investor-auth/consume?token=${token}`)
      .expect(200);
    return extractCookie(consumed, "investor_session")!;
  }

  test("lead summary totals only lead+committed, and lists connectable decks", async () => {
    await seedCommitments();
    const karan = await loginAsKaran();
    const summary = await request(app)
      .get("/api/investor/lead-summary")
      .set("Cookie", karan)
      .expect(200);
    // 2,000,000 (lead) + 3,000,000 (committed); pending 9,000,000 excluded.
    expect(summary.body.totalCommittedCents).toBe(5_000_000);
    expect(summary.body.decks.map((d: { slug: string }) => d.slug)).toContain(
      "reach",
    );
    expect(summary.body.plan).toBeNull();
  });

  test("a non-lead investor is rejected (no money leak) on both endpoints", async () => {
    await seedCommitments();
    const { cookie } = await loginAs("nosy@palonur.com");
    await request(app)
      .get("/api/investor/lead-summary")
      .set("Cookie", cookie)
      .expect(403);
    await request(app)
      .post("/api/investor/cash-flow")
      .set("Cookie", cookie)
      .send({ deckSlug: "reach", targetDate: "2030-01-01" })
      .expect(403);

    // The shared portal bundle never carries the committed total either.
    const portal = await request(app)
      .get("/api/investor/portal")
      .set("Cookie", cookie)
      .expect(200);
    const blob = JSON.stringify(portal.body);
    expect(blob).not.toContain("totalCommittedCents");
    expect(blob).not.toContain("5000000");
  });

  test("both lead endpoints reject an unauthenticated caller", async () => {
    await request(app).get("/api/investor/lead-summary").expect(401);
    await request(app)
      .post("/api/investor/cash-flow")
      .send({ deckSlug: "reach", targetDate: "2030-01-01" })
      .expect(401);
  });

  test("cash-flow generates, persists, and re-reads idempotently", async () => {
    await seedCommitments();
    const karan = await loginAsKaran();
    anthropicCalls.length = 0;

    const gen = await request(app)
      .post("/api/investor/cash-flow")
      .set("Cookie", karan)
      .send({ deckSlug: "reach", targetDate: "2030-01-01" })
      .expect(200);
    expect(gen.body.totalCommittedCents).toBe(5_000_000);
    expect(gen.body.plan.deckSlug).toBe("reach");
    expect(gen.body.plan.targetDate).toBe("2030-01-01");
    expect(gen.body.plan.totalCommittedCents).toBe(5_000_000);
    expect(gen.body.plan.planText).toContain("ending cash");
    expect(anthropicCalls).toHaveLength(1);

    // The prompt must NOT instruct the model to surface a split/donation line —
    // the system prompt forbids it (Palonur-only cash flow).
    expect(anthropicCalls[0].system).toMatch(/never/i);
    expect(anthropicCalls[0].system?.toLowerCase()).toContain("split");

    // Re-reading the summary returns the persisted plan (survives reload).
    const summary = await request(app)
      .get("/api/investor/lead-summary")
      .set("Cookie", karan)
      .expect(200);
    expect(summary.body.plan.planText).toContain("ending cash");
    expect(summary.body.plan.deckSlug).toBe("reach");

    // Re-generating overwrites the singleton (no duplicate rows).
    await request(app)
      .post("/api/investor/cash-flow")
      .set("Cookie", karan)
      .send({ deckSlug: "reach", targetDate: "2031-06-01" })
      .expect(200);
    const after = await request(app)
      .get("/api/investor/lead-summary")
      .set("Cookie", karan)
      .expect(200);
    expect(after.body.plan.targetDate).toBe("2031-06-01");
    const count = await pool.query(`SELECT COUNT(*)::int AS n FROM investor_cash_flow`);
    expect(count.rows[0].n).toBe(1);
  });

  test("cash-flow rejects a bad date or unknown deck", async () => {
    await seedCommitments();
    const karan = await loginAsKaran();
    await request(app)
      .post("/api/investor/cash-flow")
      .set("Cookie", karan)
      .send({ deckSlug: "reach", targetDate: "not-a-date" })
      .expect(400);
    await request(app)
      .post("/api/investor/cash-flow")
      .set("Cookie", karan)
      .send({ deckSlug: "ghost", targetDate: "2030-01-01" })
      .expect(404);
  });
});

// ── SLM plan sanitize guardrail (end-to-end) ────────────────────────────────
// The unit test in investorDecks.test.ts covers the transform in isolation
// against a synthetic fixture. This suite exercises the REAL syncInvestorDecks()
// against the REAL on-disk business-plan-slm.html and the gated viewer route, so
// it fails loudly if a source-marker drift makes sanitizeForInvestor
// silently no-op and leak the founders' shared editing tools to an investor.
//
// It lives in this file (not its own) on purpose: investors.test.ts is the sole
// owner of the shared `investor_decks` table and serializes access via its
// beforeEach TRUNCATE. A separate file would race the parallel test runner and
// collide on the canonical deck slugs that syncInvestorDecks upserts.
describe("SLM plan investor snapshot — sanitized end to end", () => {
  // The markers the transform anchors on. If these vanish from the source HTML,
  // the sanitize no-ops; the assertions below are the canary.
  const COLLAB_MARKER = "/api/business-plan";
  const GATE_MARKER = "pw-gate";
  const SLM_SLUG = "business-plan-slm";

  async function readSlmSource(): Promise<string> {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(
        dir,
        "artifacts",
        "palonur",
        "public",
        "business-plan-slm.html",
      );
      try {
        return await fs.readFile(candidate, "utf8");
      } catch {
        // walk up
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    throw new Error("Could not locate business-plan-slm.html source on disk");
  }

  async function realSync() {
    const actual = await vi.importActual<typeof import("../lib/investorDecks")>(
      "../lib/investorDecks",
    );
    return actual.syncInvestorDecks();
  }

  test("the source HTML still ships the markers the transform strips", async () => {
    const src = await readSlmSource();
    expect(
      src.includes(COLLAB_MARKER),
      "business-plan-slm.html no longer contains '/api/business-plan' — sanitizeSlmPlanForInvestor will no-op and leak the collaboration layer",
    ).toBe(true);
    expect(
      src.includes(GATE_MARKER),
      "business-plan-slm.html no longer contains '#pw-gate' — the password gate may not be neutralized",
    ).toBe(true);
  });

  test("syncInvestorDecks stores a sanitized, self-contained snapshot", async () => {
    const result = await realSync();
    expect(result.synced).toBeGreaterThan(0);
    expect(result.withHtml).toBeGreaterThan(0);

    const rows = await pool.query(
      `SELECT html FROM investor_decks WHERE slug = $1`,
      [SLM_SLUG],
    );
    expect(rows.rows).toHaveLength(1);
    const html: string = rows.rows[0].html;
    expect(html).toBeTruthy();

    // Real plan content survives the transform.
    expect(html).toContain("120,000 visitors a month");
    expect(html).toContain("Partnership Plan");

    // The collaboration layer that talks to the founders' shared copy is gone.
    expect(
      html.includes(COLLAB_MARKER),
      "stored SLM snapshot still references /api/business-plan — the founders' shared editing layer leaked into the investor copy",
    ).toBe(false);

    // The gate-neutralizing / edit-hiding injection is present.
    expect(html).toContain("investor-readonly");
    expect(html).toContain("palonur-bp-unlocked");
    expect(html).toContain("#edit-mode-btn{display:none!important}");
  });

  test("a granted investor is served the sanitized snapshot via the gated viewer", async () => {
    await realSync();
    const { id, cookie } = await loginAs("slm-viewer@palonur.com");
    await request(app)
      .post(`/api/investor-admin/investors/${id}/grants`)
      .set("Cookie", ADMIN_COOKIE)
      .send({ deckSlug: SLM_SLUG })
      .expect(200);

    const res = await request(app)
      .get(`/api/investor/decks/${SLM_SLUG}`)
      .set("Cookie", cookie)
      .expect(200);

    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.text).toContain("120,000 visitors a month");
    expect(res.text).not.toContain(COLLAB_MARKER);
    expect(res.text).toContain("investor-readonly");
    expect(res.text).toContain("palonur-bp-unlocked");
  });
});

// ── Investor deck sanitize coverage (every flagged deck, end to end) ─────────
// The SLM block above proves the transform works against ONE real source file.
// This block proves the INVESTOR_DECKS flag list itself stays honest:
//   1. Every deck flagged `sanitizeForInvestor` is served gate-free, edit-free,
//      and cloud-sync-free (mirroring the SLM guardrail, deck-agnostic).
//   2. Every deck NOT flagged genuinely ships no editing/collab markers in its
//      source, so a deck that later grows a gate / edit toolbar / cloud-sync
//      script can't quietly skip sanitizing and leak it to a granted investor.
describe("investor deck sanitize coverage", () => {
  // Markers that indicate a source ships editing or shared-state collaboration
  // chrome and therefore MUST be sanitized before an investor sees it.
  const EDIT_COLLAB_MARKERS = [
    "pw-gate",
    'id="edit-mode-btn"',
    "contenteditable",
    "/api/business-plan",
    "/api/reach-deck",
  ];

  async function decks() {
    const actual = await vi.importActual<typeof import("../lib/investorDecks")>(
      "../lib/investorDecks",
    );
    return actual.INVESTOR_DECKS;
  }

  async function realSync() {
    const actual = await vi.importActual<typeof import("../lib/investorDecks")>(
      "../lib/investorDecks",
    );
    return actual.syncInvestorDecks();
  }

  async function readDeckSource(file: string): Promise<string> {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, "artifacts", "palonur", "public", file);
      try {
        return await fs.readFile(candidate, "utf8");
      } catch {
        // walk up
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    throw new Error(`Could not locate ${file} source on disk`);
  }

  test("unflagged decks ship no editing/collab markers (flag list can't fall behind)", async () => {
    for (const deck of await decks()) {
      if (deck.sanitizeForInvestor) continue;
      const src = await readDeckSource(deck.file);
      for (const marker of EDIT_COLLAB_MARKERS) {
        expect(
          src.includes(marker),
          `${deck.file} is NOT flagged sanitizeForInvestor but ships the editing/collab marker "${marker}" — flag it so the investor copy is stripped`,
        ).toBe(false);
      }
    }
  });

  test("flagged decks really do ship a marker the transform must neutralize", async () => {
    for (const deck of await decks()) {
      if (!deck.sanitizeForInvestor) continue;
      const src = await readDeckSource(deck.file);
      const hasMarker = EDIT_COLLAB_MARKERS.some((m) => src.includes(m));
      expect(
        hasMarker,
        `${deck.file} is flagged sanitizeForInvestor but ships no editing/collab marker — the flag is stale and should be removed`,
      ).toBe(true);
    }
  });

  test("every flagged deck is served gate-free, edit-free, and cloud-sync-free", async () => {
    await realSync();
    const { id, cookie } = await loginAs("coverage@palonur.com");

    for (const deck of await decks()) {
      if (!deck.sanitizeForInvestor) continue;

      await request(app)
        .post(`/api/investor-admin/investors/${id}/grants`)
        .set("Cookie", ADMIN_COOKIE)
        .send({ deckSlug: deck.slug })
        .expect(200);

      const res = await request(app)
        .get(`/api/investor/decks/${deck.slug}`)
        .set("Cookie", cookie)
        .expect(200);

      const html = res.text;
      // Content survived the transform (it didn't nuke the document).
      expect(
        html.length,
        `${deck.slug} served HTML looks empty/truncated after sanitize`,
      ).toBeGreaterThan(2000);
      expect(html).toContain("</html>");

      // The read-only chrome is injected: gate hidden, edit toolbar hidden.
      expect(html, `${deck.slug} missing read-only injection`).toContain(
        "investor-readonly",
      );
      expect(html).toContain("#pw-gate{display:none!important}");
      expect(html).toContain("#edit-mode-btn{display:none!important}");
      expect(html).toContain(".toolbar{display:none!important}");

      // No cloud-sync collaboration endpoint reaches the investor.
      const { CLOUD_SYNC_MARKERS } = await vi.importActual<
        typeof import("../lib/investorDecks")
      >("../lib/investorDecks");
      for (const marker of CLOUD_SYNC_MARKERS) {
        expect(
          html.includes(marker),
          `${deck.slug} leaked the ${marker} shared-state writer`,
        ).toBe(false);
      }
    }
  });

  // The marker-presence tests above only confirm each flagged deck still ships
  // *a* known marker — they can't notice a deck whose sync endpoint was renamed
  // to something not in CLOUD_SYNC_MARKERS. This re-derives the write endpoints
  // straight from each deck's fetch(...) calls and fails loudly on any the strip
  // list doesn't cover, so a renamed/new endpoint can't leak to an investor.
  test("no flagged deck writes to a cloud-sync endpoint outside CLOUD_SYNC_MARKERS", async () => {
    const { findUncoveredCloudSyncEndpoints, CLOUD_SYNC_MARKERS } =
      await vi.importActual<typeof import("../lib/investorDecks")>(
        "../lib/investorDecks",
      );
    for (const deck of await decks()) {
      if (!deck.sanitizeForInvestor) continue;
      const src = await readDeckSource(deck.file);
      const uncovered = findUncoveredCloudSyncEndpoints(src);
      expect(
        uncovered,
        `${deck.file} writes to cloud-sync endpoint(s) ${JSON.stringify(
          uncovered,
        )} not covered by CLOUD_SYNC_MARKERS (${CLOUD_SYNC_MARKERS.join(
          ", ",
        )}) — sanitizeForInvestor will leave the shared-editing layer in the investor copy. Add the endpoint to CLOUD_SYNC_MARKERS.`,
      ).toEqual([]);
    }
  });
});
