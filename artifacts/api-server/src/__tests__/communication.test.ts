import { beforeAll, beforeEach, describe, test, expect, vi } from "vitest";

vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-communication-secret";
  process.env.COMMUNICATION_REVIEWER_EMAILS = "matt@test.local";
  process.env.STORY_EDITOR_EMAILS = "editor@test.local";
  process.env.RESEND_API_KEY = "stub-key";
});

// Capture emails instead of hitting Resend.
const sentMagicLinks: Array<{ to: string; token: string }> = [];
const sentOfferNotices: Array<{ to: string | string[]; title: string }> = [];
const sentDecisions: Array<{
  to: string;
  title: string;
  status: "accepted" | "declined";
  note: string | null;
}> = [];

vi.mock("../lib/communicationEmail", () => ({
  sendCommunicationMagicLink: async (args: { to: string; token: string }) => {
    sentMagicLinks.push(args);
  },
  sendCommunicationOfferNotice: async (args: {
    to: string | string[];
    title: string;
  }) => {
    sentOfferNotices.push({ to: args.to, title: args.title });
  },
  sendCommunicationDecision: async (args: {
    to: string;
    title: string;
    status: "accepted" | "declined";
    note: string | null;
  }) => {
    sentDecisions.push(args);
  },
}));

// Stub faculty auth so we can drive the faculty-side offer routes without Clerk.
let stubFacultyUserId: number | null = null;

vi.mock("../middlewares/facultyAuth.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../middlewares/facultyAuth.js")>();
  const { db, facultyUsersTable, facultyMembershipsTable } = await import(
    "@workspace/db"
  );
  const { eq } = await import("drizzle-orm");
  return {
    ...actual,
    requireFacultyAuth: async (
      req: { faculty?: unknown },
      res: { status: (n: number) => { json: (b: unknown) => void } },
      next: () => void,
    ) => {
      if (!stubFacultyUserId) {
        res.status(401).json({ error: "no stub user" });
        return;
      }
      const [user] = await db
        .select()
        .from(facultyUsersTable)
        .where(eq(facultyUsersTable.id, stubFacultyUserId));
      const memberships = await db
        .select()
        .from(facultyMembershipsTable)
        .where(eq(facultyMembershipsTable.userId, stubFacultyUserId));
      (req as { faculty: unknown }).faculty = { user, memberships };
      next();
    },
  };
});

// Both AI SDKs are instantiated at import time; stub to avoid env/network reads.
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      create: async () => ({ content: [{ type: "text", text: "stub" }] }),
    };
  }
  return { default: FakeAnthropic };
});
vi.mock("openai", () => {
  class FakeOpenAI {
    chat = { completions: { create: async () => ({ choices: [] }) } };
    images = { generate: async () => ({ data: [] }) };
  }
  return { default: FakeOpenAI };
});

import type { Express } from "express";
import request from "supertest";
import { createHmac } from "crypto";
import pool from "../lib/db.js";

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

let app: Express;

async function ensureCommunicationSchema(): Promise<void> {
  await pool.query(`DO $$ BEGIN
    CREATE TYPE communication_offer_status AS ENUM ('offered','accepted','declined');
  EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN unique_violation THEN NULL;
  END $$;`);
  await pool.query(`CREATE TABLE IF NOT EXISTS communication_offers (
    id SERIAL PRIMARY KEY,
    faculty_user_id INTEGER NOT NULL,
    author_name TEXT,
    author_email TEXT,
    author_institution TEXT,
    title TEXT NOT NULL,
    summary TEXT,
    body_html TEXT,
    status communication_offer_status NOT NULL DEFAULT 'offered',
    reviewer_note TEXT,
    reviewed_by TEXT,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS communication_reviewer_sessions (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    magic_token TEXT NOT NULL UNIQUE,
    session_token TEXT UNIQUE,
    consumed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    session_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS faculty_users (
    id SERIAL PRIMARY KEY,
    clerk_user_id TEXT UNIQUE,
    email TEXT,
    full_name TEXT,
    institution TEXT,
    onboarded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}

async function seedFacultyUser(): Promise<number> {
  const r = await pool.query(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name, institution)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      `clerk-${Date.now()}-${Math.random()}`,
      "steward@test.local",
      "Dr. Steward",
      "Stanford",
    ],
  );
  return r.rows[0].id;
}

async function reviewerCookie(): Promise<string> {
  sentMagicLinks.length = 0;
  await request(app)
    .post("/api/communication-auth/request")
    .set("X-Forwarded-For", "192.0.2.41")
    .send({ email: "matt@test.local" })
    .expect(200);
  const token = sentMagicLinks[0].token;
  const consumed = await request(app)
    .get(`/api/communication-auth/consume?token=${token}`)
    .expect(200);
  return extractCookie(consumed, "comm_session")!;
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for communication.test.ts");
  }
  await ensureCommunicationSchema();
  app = (await import("../app")).default;
});

beforeEach(async () => {
  sentMagicLinks.length = 0;
  sentOfferNotices.length = 0;
  sentDecisions.length = 0;
  stubFacultyUserId = null;
  await pool.query(
    `TRUNCATE communication_offers, communication_reviewer_sessions RESTART IDENTITY CASCADE`,
  );
});

describe("faculty offers an article to Matt", () => {
  test("creates an offered row and notifies the reviewer allowlist", async () => {
    stubFacultyUserId = await seedFacultyUser();
    const res = await request(app)
      .post("/api/faculty/communication-offers")
      .send({ title: "Talking about sleep", summary: "A short pitch." })
      .expect(200);
    expect(res.body.offer.status).toBe("offered");
    expect(res.body.offer.authorName).toBe("Dr. Steward");
    expect(res.body.offer.authorInstitution).toBe("Stanford");
    expect(sentOfferNotices).toHaveLength(1);
    expect(sentOfferNotices[0].to).toContain("matt@test.local");
  });

  test("rejects an offer with no title", async () => {
    stubFacultyUserId = await seedFacultyUser();
    await request(app)
      .post("/api/faculty/communication-offers")
      .send({ summary: "no title" })
      .expect(400);
  });

  test("lists only the caller's own offers", async () => {
    const a = await seedFacultyUser();
    const b = await seedFacultyUser();
    stubFacultyUserId = a;
    await request(app)
      .post("/api/faculty/communication-offers")
      .send({ title: "Mine" })
      .expect(200);
    stubFacultyUserId = b;
    await request(app)
      .post("/api/faculty/communication-offers")
      .send({ title: "Theirs" })
      .expect(200);
    const mine = await request(app)
      .get("/api/faculty/communication-offers")
      .expect(200);
    expect(mine.body.offers).toHaveLength(1);
    expect(mine.body.offers[0].title).toBe("Theirs");
  });
});

describe("reviewer magic-link auth is isolated", () => {
  test("request → consume issues a comm_session and authorises /me", async () => {
    const cookie = await reviewerCookie();
    const me = await request(app)
      .get("/api/communication-auth/me")
      .set("Cookie", cookie)
      .expect(200);
    expect(me.body.email).toBe("matt@test.local");
  });

  test("non-allowlisted email returns ok but persists no token", async () => {
    await request(app)
      .post("/api/communication-auth/request")
      .set("X-Forwarded-For", "192.0.2.42")
      .send({ email: "editor@test.local" })
      .expect(200);
    expect(sentMagicLinks).toHaveLength(0);
    const { rowCount } = await pool.query(
      `SELECT 1 FROM communication_reviewer_sessions`,
    );
    expect(rowCount).toBe(0);
  });

  test("a Stories editor session cookie cannot reach Matt's queue", async () => {
    // Forge a stories_session-shaped cookie; the communication routes only
    // accept comm_session or palonur_admin, so it must be rejected.
    await request(app)
      .get("/api/communication/offers")
      .set("Cookie", `stories_session=${encodeURIComponent(signed("forged"))}`)
      .expect(401);
  });

  test("queue requires auth", async () => {
    await request(app).get("/api/communication/offers").expect(401);
  });
});

describe("race-safe accept / decline", () => {
  async function seedOffer(): Promise<number> {
    const r = await pool.query(
      `INSERT INTO communication_offers (faculty_user_id, author_name, author_email, title, status)
       VALUES ($1, 'Dr. Steward', 'steward@test.local', 'An article', 'offered')
       RETURNING id`,
      [1],
    );
    return r.rows[0].id;
  }

  test("admin can accept; author is notified", async () => {
    const id = await seedOffer();
    const res = await request(app)
      .post(`/api/communication/offers/${id}/accept`)
      .set("Cookie", adminCookie())
      .send({ note: "Love it." })
      .expect(200);
    expect(res.body.offer.status).toBe("accepted");
    expect(res.body.offer.reviewerNote).toBe("Love it.");
    expect(res.body.offer.reviewedBy).toBe("admin");
    expect(sentDecisions).toHaveLength(1);
    expect(sentDecisions[0].status).toBe("accepted");
  });

  test("reviewer can decline with a note", async () => {
    const id = await seedOffer();
    const cookie = await reviewerCookie();
    const res = await request(app)
      .post(`/api/communication/offers/${id}/decline`)
      .set("Cookie", cookie)
      .send({ note: "Not a fit right now." })
      .expect(200);
    expect(res.body.offer.status).toBe("declined");
    expect(res.body.offer.reviewedBy).toBe("matt@test.local");
    expect(sentDecisions[0].status).toBe("declined");
  });

  test("a second decision on an already-resolved offer returns 409", async () => {
    const id = await seedOffer();
    await request(app)
      .post(`/api/communication/offers/${id}/accept`)
      .set("Cookie", adminCookie())
      .expect(200);
    await request(app)
      .post(`/api/communication/offers/${id}/decline`)
      .set("Cookie", adminCookie())
      .expect(409);
    await request(app)
      .post(`/api/communication/offers/${id}/accept`)
      .set("Cookie", adminCookie())
      .expect(409);
  });

  test("concurrent accept/decline resolve exactly once", async () => {
    const id = await seedOffer();
    const [r1, r2] = await Promise.all([
      request(app)
        .post(`/api/communication/offers/${id}/accept`)
        .set("Cookie", adminCookie()),
      request(app)
        .post(`/api/communication/offers/${id}/decline`)
        .set("Cookie", adminCookie()),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
    const { rows } = await pool.query(
      `SELECT status FROM communication_offers WHERE id = $1`,
      [id],
    );
    expect(["accepted", "declined"]).toContain(rows[0].status);
  });

  test("accept on a missing offer returns 404", async () => {
    await request(app)
      .post(`/api/communication/offers/999999/accept`)
      .set("Cookie", adminCookie())
      .expect(404);
  });
});
