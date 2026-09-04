import { beforeAll, beforeEach, describe, test, expect, vi } from "vitest";

vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-parentdata-secret";
  process.env.PARENTDATA_REVIEWER_EMAILS = "editor@parentdata.test";
  process.env.STORY_EDITOR_EMAILS = "editor@test.local";
  process.env.COMMUNICATION_REVIEWER_EMAILS = "matt@test.local";
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
  paymentCents?: number | null;
}> = [];
const sentMessageNotices: Array<{
  to: string | string[];
  title: string;
  audience: "reviewer" | "faculty";
}> = [];
const sentCallNotices: Array<{
  to: string;
  title: string;
  budgetCents: number | null;
}> = [];

vi.mock("../lib/parentdataEmail", () => ({
  sendParentDataMagicLink: async (args: { to: string; token: string }) => {
    sentMagicLinks.push(args);
  },
  sendParentDataOfferNotice: async (args: {
    to: string | string[];
    title: string;
  }) => {
    sentOfferNotices.push({ to: args.to, title: args.title });
  },
  sendParentDataDecision: async (args: {
    to: string;
    title: string;
    status: "accepted" | "declined";
    note: string | null;
    paymentCents?: number | null;
  }) => {
    sentDecisions.push(args);
  },
  sendParentDataMessageNotice: async (args: {
    to: string | string[];
    title: string;
    audience: "reviewer" | "faculty";
  }) => {
    sentMessageNotices.push({
      to: args.to,
      title: args.title,
      audience: args.audience,
    });
  },
  sendParentDataCallNotice: async (args: {
    to: string;
    title: string;
    brief: string | null;
    budgetCents: number | null;
  }) => {
    sentCallNotices.push({
      to: args.to,
      title: args.title,
      budgetCents: args.budgetCents,
    });
  },
}));

// Stub faculty auth so we can drive the faculty-side routes without Clerk.
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

async function ensureParentDataSchema(): Promise<void> {
  await pool.query(`DO $$ BEGIN
    CREATE TYPE parentdata_offer_status AS ENUM ('offered','accepted','declined');
  EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN unique_violation THEN NULL;
  END $$;`);
  await pool.query(`DO $$ BEGIN
    CREATE TYPE parentdata_message_sender AS ENUM ('faculty','reviewer');
  EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN unique_violation THEN NULL;
  END $$;`);
  await pool.query(`DO $$ BEGIN
    CREATE TYPE parentdata_call_status AS ENUM ('open','closed');
  EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN unique_violation THEN NULL;
  END $$;`);
  await pool.query(`CREATE TABLE IF NOT EXISTS parentdata_offers (
    id SERIAL PRIMARY KEY,
    faculty_user_id INTEGER NOT NULL,
    author_name TEXT,
    author_email TEXT,
    author_institution TEXT,
    title TEXT NOT NULL,
    summary TEXT,
    body_html TEXT,
    call_id INTEGER,
    status parentdata_offer_status NOT NULL DEFAULT 'offered',
    reviewer_note TEXT,
    payment_cents INTEGER,
    reviewed_by TEXT,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  // Tolerate a pre-existing offers table from an older run / file.
  await pool.query(
    `ALTER TABLE parentdata_offers ADD COLUMN IF NOT EXISTS call_id INTEGER`,
  );
  await pool.query(
    `ALTER TABLE parentdata_offers ADD COLUMN IF NOT EXISTS payment_cents INTEGER`,
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS parentdata_calls (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    brief TEXT,
    budget_cents INTEGER,
    status parentdata_call_status NOT NULL DEFAULT 'open',
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS parentdata_reviewer_sessions (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    magic_token TEXT NOT NULL UNIQUE,
    session_token TEXT UNIQUE,
    consumed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    session_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS parentdata_offer_messages (
    id SERIAL PRIMARY KEY,
    offer_id INTEGER NOT NULL,
    sender_role parentdata_message_sender NOT NULL,
    sender_name TEXT,
    sender_email TEXT,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS faculty_users (
    id SERIAL PRIMARY KEY,
    clerk_user_id TEXT UNIQUE,
    email TEXT,
    full_name TEXT,
    institution TEXT,
    onboarded_at TIMESTAMPTZ,
    deactivated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  // Tolerate a pre-existing faculty_users table from another suite.
  await pool.query(
    `ALTER TABLE faculty_users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ`,
  );
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
    .post("/api/parentdata-auth/request")
    .set("X-Forwarded-For", "192.0.2.61")
    .send({ email: "editor@parentdata.test" })
    .expect(200);
  const token = sentMagicLinks[0].token;
  const consumed = await request(app)
    .get(`/api/parentdata-auth/consume?token=${token}`)
    .expect(200);
  return extractCookie(consumed, "parentdata_session")!;
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for parentdata.test.ts");
  }
  await ensureParentDataSchema();
  app = (await import("../app")).default;
});

beforeEach(async () => {
  sentMagicLinks.length = 0;
  sentOfferNotices.length = 0;
  sentDecisions.length = 0;
  sentMessageNotices.length = 0;
  sentCallNotices.length = 0;
  stubFacultyUserId = null;
  await pool.query(
    `TRUNCATE parentdata_offers, parentdata_reviewer_sessions, parentdata_offer_messages, parentdata_calls RESTART IDENTITY CASCADE`,
  );
  // The broadcast on call-create fans out to every active faculty row; other
  // suites seed faculty_users, so clear it to keep recipient counts predictable.
  await pool.query(`DELETE FROM faculty_users`).catch(() => {});
  // The magic-link request route is throttled per-IP/per-email via the shared
  // `email_rate_limit_hits` window. Those rows survive across files and runs, so
  // clear them between tests or repeated reviewerCookie() calls hit a 429.
  await pool.query(`DELETE FROM email_rate_limit_hits`).catch(() => {});
});

describe("faculty proposes an article to ParentData", () => {
  test("creates an offered row and notifies the reviewer allowlist", async () => {
    stubFacultyUserId = await seedFacultyUser();
    const res = await request(app)
      .post("/api/faculty/parentdata-offers")
      .send({ title: "Sleep and toddlers", summary: "A short pitch." })
      .expect(200);
    expect(res.body.offer.status).toBe("offered");
    expect(res.body.offer.authorName).toBe("Dr. Steward");
    expect(res.body.offer.authorInstitution).toBe("Stanford");
    expect(sentOfferNotices).toHaveLength(1);
    expect(sentOfferNotices[0].to).toContain("editor@parentdata.test");
  });

  test("rejects a proposal with no title", async () => {
    stubFacultyUserId = await seedFacultyUser();
    await request(app)
      .post("/api/faculty/parentdata-offers")
      .send({ summary: "no title" })
      .expect(400);
  });

  test("lists only the caller's own proposals", async () => {
    const a = await seedFacultyUser();
    const b = await seedFacultyUser();
    stubFacultyUserId = a;
    await request(app)
      .post("/api/faculty/parentdata-offers")
      .send({ title: "Mine" })
      .expect(200);
    stubFacultyUserId = b;
    await request(app)
      .post("/api/faculty/parentdata-offers")
      .send({ title: "Theirs" })
      .expect(200);
    const mine = await request(app)
      .get("/api/faculty/parentdata-offers")
      .expect(200);
    expect(mine.body.offers).toHaveLength(1);
    expect(mine.body.offers[0].title).toBe("Theirs");
  });
});

describe("reviewer magic-link auth is isolated", () => {
  test("request → consume issues a parentdata_session and authorises /me", async () => {
    const cookie = await reviewerCookie();
    const me = await request(app)
      .get("/api/parentdata-auth/me")
      .set("Cookie", cookie)
      .expect(200);
    expect(me.body.email).toBe("editor@parentdata.test");
  });

  test("non-allowlisted email returns ok but persists no token", async () => {
    await request(app)
      .post("/api/parentdata-auth/request")
      .set("X-Forwarded-For", "192.0.2.62")
      .send({ email: "matt@test.local" })
      .expect(200);
    expect(sentMagicLinks).toHaveLength(0);
    const { rowCount } = await pool.query(
      `SELECT 1 FROM parentdata_reviewer_sessions`,
    );
    expect(rowCount).toBe(0);
  });

  test("a communication reviewer cookie cannot reach ParentData's queue", async () => {
    // Forge a comm_session-shaped cookie; the parentdata routes only accept
    // parentdata_session or palonur_admin, so it must be rejected.
    await request(app)
      .get("/api/parentdata/offers")
      .set("Cookie", `comm_session=${encodeURIComponent(signed("forged"))}`)
      .expect(401);
  });

  test("queue requires auth", async () => {
    await request(app).get("/api/parentdata/offers").expect(401);
  });
});

describe("race-safe accept / decline", () => {
  async function seedOffer(): Promise<number> {
    const r = await pool.query(
      `INSERT INTO parentdata_offers (faculty_user_id, author_name, author_email, title, status)
       VALUES ($1, 'Dr. Steward', 'steward@test.local', 'An article', 'offered')
       RETURNING id`,
      [1],
    );
    return r.rows[0].id;
  }

  test("admin can accept; author is notified", async () => {
    const id = await seedOffer();
    const res = await request(app)
      .post(`/api/parentdata/offers/${id}/accept`)
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
      .post(`/api/parentdata/offers/${id}/decline`)
      .set("Cookie", cookie)
      .send({ note: "Not a fit right now." })
      .expect(200);
    expect(res.body.offer.status).toBe("declined");
    expect(res.body.offer.reviewedBy).toBe("editor@parentdata.test");
    expect(sentDecisions[0].status).toBe("declined");
  });

  test("a second decision on an already-resolved offer returns 409", async () => {
    const id = await seedOffer();
    await request(app)
      .post(`/api/parentdata/offers/${id}/accept`)
      .set("Cookie", adminCookie())
      .expect(200);
    await request(app)
      .post(`/api/parentdata/offers/${id}/decline`)
      .set("Cookie", adminCookie())
      .expect(409);
  });

  test("concurrent accept/decline resolve exactly once", async () => {
    const id = await seedOffer();
    const [r1, r2] = await Promise.all([
      request(app)
        .post(`/api/parentdata/offers/${id}/accept`)
        .set("Cookie", adminCookie()),
      request(app)
        .post(`/api/parentdata/offers/${id}/decline`)
        .set("Cookie", adminCookie()),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
    const { rows } = await pool.query(
      `SELECT status FROM parentdata_offers WHERE id = $1`,
      [id],
    );
    expect(["accepted", "declined"]).toContain(rows[0].status);
  });

  test("accept on a missing offer returns 404", async () => {
    await request(app)
      .post(`/api/parentdata/offers/999999/accept`)
      .set("Cookie", adminCookie())
      .expect(404);
  });

  test("a non-numeric offer id returns 400, not a 500", async () => {
    await request(app)
      .post(`/api/parentdata/offers/not-a-number/accept`)
      .set("Cookie", adminCookie())
      .expect(400);
  });
});

describe("proposal conversation (back-and-forth)", () => {
  test("steward and editor exchange messages on the same proposal", async () => {
    stubFacultyUserId = await seedFacultyUser();
    const offer = await request(app)
      .post("/api/faculty/parentdata-offers")
      .send({ title: "A piece on naps" })
      .expect(200);
    const offerId = offer.body.offer.id as number;

    // Faculty posts the first message → notifies the editor allowlist.
    await request(app)
      .post(`/api/faculty/parentdata-offers/${offerId}/messages`)
      .send({ body: "Happy to adjust the angle." })
      .expect(200);
    expect(sentMessageNotices.some((m) => m.audience === "reviewer")).toBe(true);

    // Editor replies from her own dashboard → notifies the steward.
    const cookie = await reviewerCookie();
    await request(app)
      .post(`/api/parentdata/offers/${offerId}/messages`)
      .set("Cookie", cookie)
      .send({ body: "Could you focus on ages 1–3?" })
      .expect(200);
    expect(sentMessageNotices.some((m) => m.audience === "faculty")).toBe(true);

    // Both sides see the full thread, oldest first.
    const facultyThread = await request(app)
      .get(`/api/faculty/parentdata-offers/${offerId}/messages`)
      .expect(200);
    expect(facultyThread.body.messages).toHaveLength(2);
    expect(facultyThread.body.messages[0].senderRole).toBe("faculty");
    expect(facultyThread.body.messages[1].senderRole).toBe("reviewer");

    const editorThread = await request(app)
      .get(`/api/parentdata/offers/${offerId}/messages`)
      .set("Cookie", cookie)
      .expect(200);
    expect(editorThread.body.messages).toHaveLength(2);
  });

  test("a faculty member cannot read or post on another steward's proposal", async () => {
    const owner = await seedFacultyUser();
    const intruder = await seedFacultyUser();
    stubFacultyUserId = owner;
    const offer = await request(app)
      .post("/api/faculty/parentdata-offers")
      .send({ title: "Owned" })
      .expect(200);
    const offerId = offer.body.offer.id as number;

    stubFacultyUserId = intruder;
    await request(app)
      .get(`/api/faculty/parentdata-offers/${offerId}/messages`)
      .expect(404);
    await request(app)
      .post(`/api/faculty/parentdata-offers/${offerId}/messages`)
      .send({ body: "let me in" })
      .expect(404);
  });

  test("posting an empty message is rejected", async () => {
    stubFacultyUserId = await seedFacultyUser();
    const offer = await request(app)
      .post("/api/faculty/parentdata-offers")
      .send({ title: "Has thread" })
      .expect(200);
    const offerId = offer.body.offer.id as number;
    await request(app)
      .post(`/api/faculty/parentdata-offers/${offerId}/messages`)
      .send({ body: "   " })
      .expect(400);
  });

  test("editor messaging requires auth", async () => {
    stubFacultyUserId = await seedFacultyUser();
    const offer = await request(app)
      .post("/api/faculty/parentdata-offers")
      .send({ title: "Locked" })
      .expect(200);
    const offerId = offer.body.offer.id as number;
    await request(app)
      .get(`/api/parentdata/offers/${offerId}/messages`)
      .expect(401);
    await request(app)
      .post(`/api/parentdata/offers/${offerId}/messages`)
      .send({ body: "hi" })
      .expect(401);
  });
});

describe("editor pays (or doesn't) on accept", () => {
  async function seedOffer(): Promise<number> {
    const r = await pool.query(
      `INSERT INTO parentdata_offers (faculty_user_id, author_name, author_email, title, status)
       VALUES ($1, 'Dr. Steward', 'steward@test.local', 'A paid piece', 'offered')
       RETURNING id`,
      [1],
    );
    return r.rows[0].id;
  }

  test("accepting with a payment records the cents and emails the amount", async () => {
    const id = await seedOffer();
    const res = await request(app)
      .post(`/api/parentdata/offers/${id}/accept`)
      .set("Cookie", adminCookie())
      .send({ note: "Great fit.", paymentCents: 25000 })
      .expect(200);
    expect(res.body.offer.status).toBe("accepted");
    expect(res.body.offer.paymentCents).toBe(25000);
    expect(sentDecisions[0].paymentCents).toBe(25000);
  });

  test("accepting with paymentCents 0 records a decided 'no pay'", async () => {
    const id = await seedOffer();
    const res = await request(app)
      .post(`/api/parentdata/offers/${id}/accept`)
      .set("Cookie", adminCookie())
      .send({ paymentCents: 0 })
      .expect(200);
    expect(res.body.offer.paymentCents).toBe(0);
    expect(sentDecisions[0].paymentCents).toBe(0);
  });

  test("accepting with no payment field leaves it undecided (null)", async () => {
    const id = await seedOffer();
    const res = await request(app)
      .post(`/api/parentdata/offers/${id}/accept`)
      .set("Cookie", adminCookie())
      .expect(200);
    expect(res.body.offer.paymentCents).toBeNull();
  });

  test("a negative or non-integer payment is rejected with 400", async () => {
    const id = await seedOffer();
    await request(app)
      .post(`/api/parentdata/offers/${id}/accept`)
      .set("Cookie", adminCookie())
      .send({ paymentCents: -5 })
      .expect(400);
    await request(app)
      .post(`/api/parentdata/offers/${id}/accept`)
      .set("Cookie", adminCookie())
      .send({ paymentCents: 12.5 })
      .expect(400);
    // The offer is still unresolved after the rejected attempts.
    const { rows } = await pool.query(
      `SELECT status FROM parentdata_offers WHERE id = $1`,
      [id],
    );
    expect(rows[0].status).toBe("offered");
  });

  test("declining never carries a payment", async () => {
    const id = await seedOffer();
    const res = await request(app)
      .post(`/api/parentdata/offers/${id}/decline`)
      .set("Cookie", adminCookie())
      .send({ paymentCents: 9999 })
      .expect(200);
    expect(res.body.offer.status).toBe("declined");
    expect(res.body.offer.paymentCents).toBeNull();
  });
});

describe("calls for articles", () => {
  async function seedActiveFaculty(email: string): Promise<number> {
    const r = await pool.query(
      `INSERT INTO faculty_users (clerk_user_id, email, full_name)
       VALUES ($1, $2, 'Dr. Active') RETURNING id`,
      [`clerk-${Date.now()}-${Math.random()}`, email],
    );
    return r.rows[0].id;
  }

  test("editor posts a call and active faculty are each notified", async () => {
    await seedActiveFaculty("a@stanford.test");
    await seedActiveFaculty("b@stanford.test");
    // A deactivated steward must NOT be emailed.
    const dead = await seedActiveFaculty("c@stanford.test");
    await pool.query(
      `UPDATE faculty_users SET deactivated_at = NOW() WHERE id = $1`,
      [dead],
    );
    const cookie = await reviewerCookie();
    const res = await request(app)
      .post("/api/parentdata/calls")
      .set("Cookie", cookie)
      .send({ title: "Sleep regressions", brief: "800 words", budgetCents: 30000 })
      .expect(200);
    expect(res.body.call.status).toBe("open");
    expect(res.body.call.budgetCents).toBe(30000);
    const recipients = sentCallNotices.map((c) => c.to).sort();
    expect(recipients).toEqual(["a@stanford.test", "b@stanford.test"]);
  });

  test("creating a call requires reviewer/admin auth", async () => {
    await request(app)
      .post("/api/parentdata/calls")
      .send({ title: "Nope" })
      .expect(401);
  });

  test("a call with no title is rejected", async () => {
    const cookie = await reviewerCookie();
    await request(app)
      .post("/api/parentdata/calls")
      .set("Cookie", cookie)
      .send({ brief: "no title" })
      .expect(400);
  });

  test("faculty see only OPEN calls; closing one hides it", async () => {
    const cookie = await reviewerCookie();
    const open = await request(app)
      .post("/api/parentdata/calls")
      .set("Cookie", cookie)
      .send({ title: "Open call" })
      .expect(200);
    const toClose = await request(app)
      .post("/api/parentdata/calls")
      .set("Cookie", cookie)
      .send({ title: "Will close" })
      .expect(200);
    await request(app)
      .patch(`/api/parentdata/calls/${toClose.body.call.id}`)
      .set("Cookie", cookie)
      .send({ status: "closed" })
      .expect(200);

    stubFacultyUserId = await seedFacultyUser();
    const facultyView = await request(app)
      .get("/api/faculty/parentdata-calls")
      .expect(200);
    const titles = facultyView.body.calls.map((c: { title: string }) => c.title);
    expect(titles).toEqual(["Open call"]);
    expect(open.body.call.id).toBeDefined();
  });

  test("a proposal can answer an open call; a closed call is refused", async () => {
    const cookie = await reviewerCookie();
    const call = await request(app)
      .post("/api/parentdata/calls")
      .set("Cookie", cookie)
      .send({ title: "Answerable" })
      .expect(200);
    const callId = call.body.call.id as number;

    stubFacultyUserId = await seedFacultyUser();
    const offer = await request(app)
      .post("/api/faculty/parentdata-offers")
      .send({ title: "My response", callId })
      .expect(200);
    expect(offer.body.offer.callId).toBe(callId);

    // Close the call, then a new proposal against it is rejected.
    await request(app)
      .patch(`/api/parentdata/calls/${callId}`)
      .set("Cookie", cookie)
      .send({ status: "closed" })
      .expect(200);
    await request(app)
      .post("/api/faculty/parentdata-offers")
      .send({ title: "Too late", callId })
      .expect(400);
  });

  test("referencing a non-existent call is rejected", async () => {
    stubFacultyUserId = await seedFacultyUser();
    await request(app)
      .post("/api/faculty/parentdata-offers")
      .send({ title: "Ghost call", callId: 999999 })
      .expect(400);
  });
});
