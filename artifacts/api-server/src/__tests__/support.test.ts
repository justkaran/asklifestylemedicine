import { beforeAll, beforeEach, describe, test, expect, vi } from "vitest";

vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-support-secret";
  process.env.RESEND_API_KEY = "stub-key";
  process.env.SUPPORT_EMAILS = "agent@support-test.local,second@support-test.local";
});

// ── Capture support emails instead of hitting Resend ────────────────────────
interface SentMagic {
  to: string;
  token: string;
}
interface SentReply {
  to: string;
  name?: string | null;
  question: string;
  reply: string;
  stewardName?: string | null;
}
const sentMagic: SentMagic[] = [];
const sentReplies: SentReply[] = [];

vi.mock("../lib/supportEmail", () => ({
  sendSupportMagicLink: async (args: SentMagic) => {
    sentMagic.push(args);
  },
  sendSupportReply: async (args: SentReply) => {
    sentReplies.push(args);
    return true;
  },
}));

// ── Deterministic triage (no AI/RAG in tests) ───────────────────────────────
// Returns a routed suggestion ONLY for questions mentioning "circadian", so a
// test can choose covered vs uncovered triage by wording.
let triageStewardUserId = 0;
vi.mock("../lib/supportTriage", () => ({
  triageQuestion: async (message: string) => {
    if (/circadian|melatonin|light/i.test(message)) {
      return {
        suggestedPillarId: 1,
        suggestedPillarSlug: "sleep",
        suggestedPillarName: "Sleep",
        suggestedStewardUserId: triageStewardUserId || null,
        suggestedStewardName: "Dr. Test Steward",
        draftReply: "Light in the morning anchors your circadian clock.",
        draftMode: triageStewardUserId ? "steward" : "palonur",
        sourceContext: [{ marker: "[1]", citation: "Zeitzer et al., 2024" }],
      };
    }
    return {
      suggestedPillarId: null,
      suggestedPillarSlug: null,
      suggestedPillarName: null,
      suggestedStewardUserId: null,
      suggestedStewardName: null,
      draftReply: null,
      draftMode: "palonur",
      sourceContext: null,
    };
  },
}));

// ── Faculty (Clerk) auth stub ───────────────────────────────────────────────
let stubFacultyUserId = 0;
vi.mock("../middlewares/facultyAuth.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../middlewares/facultyAuth.js")
  >();
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

import type { Express } from "express";
import request from "supertest";
import { createHmac } from "crypto";
import pool from "../lib/db.js";
import { ensureCaptureLoopSchema } from "./testHelpers";
import { __resetEmailRateLimitForTests } from "../middlewares/emailRateLimit";

const SECRET = "test-support-secret";

function signCookie(val: string, secret: string): string {
  const hash = createHmac("sha256", secret)
    .update(val)
    .digest("base64")
    .replace(/=+$/, "");
  return val + "." + hash;
}

/** Build a signed `palonur_admin=1` cookie header. */
function adminCookieHeader(): string {
  return `palonur_admin=${encodeURIComponent("s:" + signCookie("1", SECRET))}`;
}

let app: Express;
let stewardUserId = 0;
let stewardClerkId = "";

/** Sign in a support agent and return their session cookie header. */
async function supportCookie(email = "agent@support-test.local"): Promise<string> {
  sentMagic.length = 0;
  await request(app).post("/api/support-auth/request").send({ email });
  const token = sentMagic[0].token;
  const consume = await request(app).get(
    `/api/support-auth/consume?token=${token}`,
  );
  return consume.headers["set-cookie"];
}

beforeAll(async () => {
  await ensureCaptureLoopSchema();
  app = (await import("../app")).default;
  stewardClerkId = `support-steward-${Date.now()}`;
  const u = await pool.query(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [stewardClerkId, "steward@support-test.local", "Dr. Test Steward"],
  );
  stewardUserId = u.rows[0].id;
  triageStewardUserId = stewardUserId;
});

beforeEach(async () => {
  sentMagic.length = 0;
  sentReplies.length = 0;
  stubFacultyUserId = 0;
  await __resetEmailRateLimitForTests();
  await pool.query(`DELETE FROM support_questions`);
  await pool.query(`DELETE FROM support_sessions`);
  // Re-ensure the steward row if a preceding suite's CASCADE truncate wiped it.
  if (stewardUserId) {
    await pool.query(
      `INSERT INTO faculty_users (id, clerk_user_id, email, full_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [stewardUserId, stewardClerkId, "steward@support-test.local", "Dr. Test Steward"],
    );
    triageStewardUserId = stewardUserId;
  }
});

describe("support magic-link auth + isolation", () => {
  test("request emails a link only for an allowlisted email, never leaks", async () => {
    const known = await request(app)
      .post("/api/support-auth/request")
      .send({ email: "agent@support-test.local" });
    expect(known.status).toBe(200);
    expect(known.body).toEqual({ ok: true });
    expect(sentMagic).toHaveLength(1);

    sentMagic.length = 0;

    const unknown = await request(app)
      .post("/api/support-auth/request")
      .send({ email: "stranger@support-test.local" });
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual({ ok: true }); // identical generic success
    expect(sentMagic).toHaveLength(0); // no link minted for non-allowlisted
  });

  test("consume mints a session; me returns the agent email", async () => {
    const cookie = await supportCookie();
    expect(cookie).toBeDefined();
    const me = await request(app)
      .get("/api/support-auth/me")
      .set("Cookie", cookie);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe("agent@support-test.local");
  });

  test("a magic token cannot be replayed", async () => {
    await request(app)
      .post("/api/support-auth/request")
      .send({ email: "agent@support-test.local" });
    const token = sentMagic[0].token;
    const first = await request(app).get(
      `/api/support-auth/consume?token=${token}`,
    );
    expect(first.status).toBe(200);
    const second = await request(app).get(
      `/api/support-auth/consume?token=${token}`,
    );
    expect(second.status).toBe(400);
  });

  test("inbox + me reject an unauthenticated caller", async () => {
    expect((await request(app).get("/api/support/inbox")).status).toBe(401);
    expect((await request(app).get("/api/support-auth/me")).status).toBe(401);
  });

  test("an admin/editor cookie does NOT grant the support identity", async () => {
    // Admin can open the inbox (convenience) but is NOT "support".
    const me = await request(app)
      .get("/api/support-auth/me")
      .set("Cookie", adminCookieHeader());
    expect(me.status).toBe(401);
  });

  test("a support cookie does NOT grant admin surfaces", async () => {
    const cookie = await supportCookie();
    // An admin-only investor surface must reject a support cookie.
    const r = await request(app)
      .get("/api/investor-admin/documents")
      .set("Cookie", cookie);
    expect(r.status).toBe(401);
  });

  test("platform admin MAY open the inbox", async () => {
    const r = await request(app)
      .get("/api/support/inbox")
      .set("Cookie", adminCookieHeader());
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.items)).toBe(true);
  });
});

describe("public Ask Palonur intake", () => {
  test("requires both consents and a valid email", async () => {
    const noConsent = await request(app).post("/api/support/ask").send({
      email: "asker@support-test.local",
      message: "How does morning light affect circadian rhythm?",
      consentReply: true,
      consentPrivacy: false,
    });
    expect(noConsent.status).toBe(400);

    const noEmail = await request(app).post("/api/support/ask").send({
      message: "How does morning light affect circadian rhythm?",
      consentReply: true,
      consentPrivacy: true,
    });
    expect(noEmail.status).toBe(400);
  });

  test("accepted submission is triaged and never stores a raw IP", async () => {
    const r = await request(app)
      .post("/api/support/ask")
      .set("X-Forwarded-For", "203.0.113.9")
      .send({
        name: "Asker",
        email: "asker@support-test.local",
        message: "How does morning light affect circadian rhythm?",
        consentReply: true,
        consentPrivacy: true,
      });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    const row = await pool.query(
      `SELECT source, status, suggested_pillar_slug, draft_reply, consent_ip_hash, consent_timestamp
       FROM support_questions WHERE id = $1`,
      [r.body.id],
    );
    expect(row.rows[0].source).toBe("ask");
    expect(row.rows[0].status).toBe("new");
    expect(row.rows[0].suggested_pillar_slug).toBe("sleep");
    expect(row.rows[0].draft_reply).toBeTruthy();
    expect(row.rows[0].consent_timestamp).toBeTruthy();
    // IP is hashed, never raw.
    expect(row.rows[0].consent_ip_hash).toBeTruthy();
    expect(row.rows[0].consent_ip_hash).not.toContain("203.0.113.9");
  });
});

describe("concierge resolution — reply as Palonur", () => {
  test("send-palonur answers the asker and is atomic (no double-send)", async () => {
    const ask = await request(app).post("/api/support/ask").send({
      name: "Asker",
      email: "asker@support-test.local",
      message: "How does morning light affect circadian rhythm?",
      consentReply: true,
      consentPrivacy: true,
    });
    const id = ask.body.id as number;
    const cookie = await supportCookie();

    const first = await request(app)
      .post(`/api/support/questions/${id}/send-palonur`)
      .set("Cookie", cookie)
      .send({ reply: "Get bright light within 30 minutes of waking." });
    expect(first.status).toBe(200);
    expect(first.body.item.status).toBe("answered");
    expect(first.body.item.replyMode).toBe("palonur");
    expect(sentReplies).toHaveLength(1);
    expect(sentReplies[0].to).toBe("asker@support-test.local");
    expect(sentReplies[0].stewardName).toBeFalsy(); // sent AS Palonur

    // Second send is rejected — already resolved, no second email.
    const second = await request(app)
      .post(`/api/support/questions/${id}/send-palonur`)
      .set("Cookie", cookie)
      .send({ reply: "duplicate" });
    expect(second.status).toBe(409);
    expect(sentReplies).toHaveLength(1);
  });
});

describe("steward hand-off", () => {
  test("route-to-steward then steward sends in their voice (atomic, no double-send)", async () => {
    const ask = await request(app).post("/api/support/ask").send({
      name: "Asker",
      email: "asker@support-test.local",
      message: "How does morning light affect circadian rhythm?",
      consentReply: true,
      consentPrivacy: true,
    });
    const id = ask.body.id as number;
    const cookie = await supportCookie();

    const routed = await request(app)
      .post(`/api/support/questions/${id}/route-steward`)
      .set("Cookie", cookie)
      .send({ stewardUserId });
    expect(routed.status).toBe(200);
    expect(routed.body.item.status).toBe("pending_steward");
    expect(routed.body.item.assignedStewardUserId).toBe(stewardUserId);

    // Routing again is rejected (no longer `new`).
    const reroute = await request(app)
      .post(`/api/support/questions/${id}/route-steward`)
      .set("Cookie", cookie)
      .send({ stewardUserId });
    expect(reroute.status).toBe(409);

    // The assigned steward sees it in their queue.
    stubFacultyUserId = stewardUserId;
    const queue = await request(app).get("/api/support/steward/queue");
    expect(queue.status).toBe(200);
    expect(queue.body.items.some((i: { id: number }) => i.id === id)).toBe(true);

    // Steward sends in their own voice.
    const sent = await request(app)
      .post(`/api/support/steward/questions/${id}/send`)
      .send({ reply: "From my lab's data, morning light is the strongest cue." });
    expect(sent.status).toBe(200);
    expect(sent.body.item.status).toBe("answered");
    expect(sentReplies).toHaveLength(1);
    expect(sentReplies[0].stewardName).toBe("Dr. Test Steward");

    // A resend is rejected — no double-send.
    const resend = await request(app)
      .post(`/api/support/steward/questions/${id}/send`)
      .send({ reply: "again" });
    expect(resend.status).toBe(409);
    expect(sentReplies).toHaveLength(1);
  });

  test("a steward cannot send an item assigned to a different steward", async () => {
    const ask = await request(app).post("/api/support/ask").send({
      name: "Asker",
      email: "asker@support-test.local",
      message: "How does morning light affect circadian rhythm?",
      consentReply: true,
      consentPrivacy: true,
    });
    const id = ask.body.id as number;
    const cookie = await supportCookie();
    await request(app)
      .post(`/api/support/questions/${id}/route-steward`)
      .set("Cookie", cookie)
      .send({ stewardUserId });

    // A DIFFERENT faculty user attempts the send.
    const other = await pool.query(
      `INSERT INTO faculty_users (clerk_user_id, email, full_name)
       VALUES ($1, $2, $3) RETURNING id`,
      [`other-steward-${Date.now()}`, "other@support-test.local", "Dr. Other"],
    );
    stubFacultyUserId = other.rows[0].id;
    const sent = await request(app)
      .post(`/api/support/steward/questions/${id}/send`)
      .send({ reply: "not mine" });
    expect(sent.status).toBe(409);
    expect(sentReplies).toHaveLength(0);
  });
});

describe("uncovered agent questions → inbox", () => {
  test("uncovered queries are materialized and drafted for a steward", async () => {
    // Seed an uncovered agent query.
    const q = await pool.query(
      `INSERT INTO agent_queries (session_id, question, was_uncovered)
       VALUES ($1, $2, true) RETURNING id`,
      [`sess-${Date.now()}`, "What time should I get circadian light exposure?"],
    );
    const agentQueryId = q.rows[0].id as string;

    const cookie = await supportCookie();
    const inbox = await request(app)
      .get("/api/support/inbox")
      .set("Cookie", cookie);
    expect(inbox.status).toBe(200);
    const item = inbox.body.items.find(
      (i: { agentQueryId: string | null }) => i.agentQueryId === agentQueryId,
    );
    expect(item).toBeDefined();
    expect(item.source).toBe("uncovered");
    expect(item.suggestedStewardUserId).toBe(stewardUserId);
    expect(item.draftReply).toBeTruthy();
    expect(item.askerEmail).toBeNull(); // uncovered items are anonymous

    // A second inbox load does NOT duplicate the item (idempotent materialize).
    const inbox2 = await request(app)
      .get("/api/support/inbox")
      .set("Cookie", cookie);
    const matches = inbox2.body.items.filter(
      (i: { agentQueryId: string | null }) => i.agentQueryId === agentQueryId,
    );
    expect(matches).toHaveLength(1);
  });
});
