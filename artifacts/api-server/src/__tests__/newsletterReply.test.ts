import {
  beforeAll,
  beforeEach,
  describe,
  test,
  expect,
  vi,
} from "vitest";
import type { Express } from "express";

vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-newsletter-reply-secret";
  process.env.RESEND_API_KEY = "stub-key";
  process.env.NEWSLETTER_QA_INBOX = "palonur-ask@agentmail.to";
  process.env.AGENTMAIL_WEBHOOK_SECRET = "hook-secret-123";
});

// Controllable Q&A engine result + capture of the (cleaned) question it received.
const qaState = vi.hoisted(() => ({
  lastQuestion: "" as string,
  result: null as unknown,
}));
vi.mock("../lib/newsletterQa.js", () => ({
  answerNewsletterQuestion: vi.fn(async (q: string) => {
    qaState.lastQuestion = q;
    return qaState.result;
  }),
}));

// Keep the real buildQaReplyEmail (we assert on its output) but capture sends
// instead of hitting Resend.
const sentEmails = vi.hoisted(
  () =>
    [] as Array<{
      to: string;
      subject: string;
      html: string;
      text: string;
      replyTo?: string | null;
    }>,
);
vi.mock("../lib/newsletterEmail", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/newsletterEmail")>();
  return {
    ...actual,
    sendNewsletterEmail: vi.fn(
      async (args: {
        to: string;
        subject: string;
        html: string;
        text: string;
        replyTo?: string | null;
      }) => {
        sentEmails.push(args);
        return true;
      },
    ),
  };
});

import request from "supertest";
import pool from "../lib/db.js";
import { ensureCaptureLoopSchema } from "./testHelpers.js";
import { __resetEmailRateLimitForTests } from "../middlewares/emailRateLimit.js";
import { createHmac } from "node:crypto";

function signCookie(val: string, secret: string): string {
  const hash = createHmac("sha256", secret)
    .update(val)
    .digest("base64")
    .replace(/=+$/, "");
  return val + "." + hash;
}
function adminCookie(): string {
  return `palonur_admin=${encodeURIComponent(
    "s:" + signCookie("1", process.env.SESSION_SECRET as string),
  )}`;
}

const SECRET = "hook-secret-123";
const INBOUND = "/api/newsletter/reply/inbound";

let app: Express;

function answeredResult() {
  return {
    outcome: "answered" as const,
    expert: {
      name: "Dr. Jamie Zeitzer",
      pillarSlug: "sleep",
      pillarName: "Sleep",
    },
    reason: null,
    answer: "Dim your evening lights to fall asleep on time.",
    citation: "Zeitzer et al., 2000, J Physiol",
    paper: '"Sensitivity of the human circadian pacemaker to nocturnal light"',
    finding: "Even ~100 lux suppresses melatonin.",
    interpretation: "Keep evenings dim.",
    action: "Dim lights two hours before bed.",
    insight: null,
    provenance: [],
    citationVerification: null,
    voiceVerification: null,
    topScore: 0.9,
  };
}

function uncoveredResult() {
  return {
    outcome: "uncovered" as const,
    expert: null,
    reason: "None of our experts cover this yet.",
    answer: null,
    citation: null,
    paper: null,
    finding: null,
    interpretation: null,
    action: null,
    insight: null,
    provenance: [],
    citationVerification: null,
    voiceVerification: null,
    topScore: 0.1,
  };
}

function payload(over: {
  eventId?: string;
  from?: string;
  subject?: string;
  text?: string;
  html?: string;
  labels?: string[];
}) {
  return {
    event_type: "message.received",
    event_id: over.eventId ?? "evt-1",
    message: {
      message_id: "msg-1",
      inbox_id: "palonur-ask@agentmail.to",
      from_: over.from ?? "Reader <reader@example.com>",
      subject: over.subject ?? "Re: This week in sleep",
      text: over.text,
      html: over.html,
      labels: over.labels ?? [],
    },
  };
}

beforeAll(async () => {
  await ensureCaptureLoopSchema();
  app = (await import("../app.js")).default;
});

beforeEach(async () => {
  sentEmails.length = 0;
  qaState.lastQuestion = "";
  qaState.result = answeredResult();
  process.env.NEWSLETTER_QA_INBOX = "palonur-ask@agentmail.to";
  process.env.AGENTMAIL_WEBHOOK_SECRET = SECRET;
  await pool.query(`DELETE FROM newsletter_reply_events`);
  await __resetEmailRateLimitForTests();
});

describe("newsletter reply webhook", () => {
  test("rejects a bad/missing secret with 401", async () => {
    const res = await request(app)
      .post(`${INBOUND}?token=wrong`)
      .send(payload({}));
    expect(res.status).toBe(401);
    expect(sentEmails).toHaveLength(0);
  });

  test("covered question → emails an answer naming the expert, with the quote stripped", async () => {
    const quoted = [
      "What is the ideal evening light level?",
      "",
      "On Mon, Jan 1, 2026 at 9:00 AM Stanford <palonur-ask@agentmail.to> wrote:",
      "> Welcome to this week's newsletter",
      "> lots of quoted content here",
    ].join("\n");

    const res = await request(app)
      .post(`${INBOUND}?token=${SECRET}`)
      .send(payload({ text: quoted }));

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("answered");
    // The quoted reply chain is stripped before the engine sees it.
    expect(qaState.lastQuestion).toContain("ideal evening light level");
    expect(qaState.lastQuestion).not.toContain("quoted content");

    expect(sentEmails).toHaveLength(1);
    const email = sentEmails[0];
    expect(email.to).toBe("reader@example.com");
    expect(email.replyTo).toBe("palonur-ask@agentmail.to");
    expect(email.html).toContain("Dr. Jamie Zeitzer");
    expect(email.html).toContain("Dim your evening lights");
    expect(email.subject.toLowerCase()).toContain("re:");
  });

  test("uncovered question → honest fallback, no fabricated answer", async () => {
    qaState.result = uncoveredResult();
    const res = await request(app)
      .post(`${INBOUND}?token=${SECRET}`)
      .send(payload({ eventId: "evt-unc", text: "How do I cure baldness?" }));

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("uncovered");
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].text).toContain("rather not guess");
    expect(sentEmails[0].html).toContain("rather not guess");
    expect(sentEmails[0].html).not.toContain("Dim your evening lights");
  });

  test("duplicate event_id is answered exactly once", async () => {
    const body = payload({ eventId: "evt-dup", text: "Question about sleep?" });
    const first = await request(app)
      .post(`${INBOUND}?token=${SECRET}`)
      .send(body);
    const second = await request(app)
      .post(`${INBOUND}?token=${SECRET}`)
      .send(body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.ignored).toBe("duplicate");
    expect(sentEmails).toHaveLength(1);
  });

  test("auto-reply is ignored (no answer sent)", async () => {
    const res = await request(app)
      .post(`${INBOUND}?token=${SECRET}`)
      .send(
        payload({
          eventId: "evt-auto",
          subject: "Out of Office: Re: newsletter",
          text: "I am away until next week.",
        }),
      );
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe("auto_or_self");
    expect(sentEmails).toHaveLength(0);
  });

  test("per-sender rate limit stops a flood after the cap", async () => {
    for (let i = 0; i < 4; i++) {
      const ok = await request(app)
        .post(`${INBOUND}?token=${SECRET}`)
        .send(payload({ eventId: `evt-rl-${i}`, text: `Question ${i}?` }));
      expect(ok.body.outcome).toBe("answered");
    }
    const blocked = await request(app)
      .post(`${INBOUND}?token=${SECRET}`)
      .send(payload({ eventId: "evt-rl-x", text: "One more question?" }));
    expect(blocked.status).toBe(200);
    expect(blocked.body.ignored).toBe("rate_limited");
    expect(sentEmails).toHaveLength(4);
  });

  test("degrades cleanly when unconfigured (no secret) → 200 noop, no send", async () => {
    delete process.env.AGENTMAIL_WEBHOOK_SECRET;
    delete process.env.NEWSLETTER_QA_INBOX;
    const res = await request(app)
      .post(`${INBOUND}?token=anything`)
      .send(payload({ eventId: "evt-unconf" }));
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe("unconfigured");
    expect(sentEmails).toHaveLength(0);
  });
});

describe("newsletter reply setup", () => {
  test("requires admin", async () => {
    const res = await request(app).post("/api/newsletter/reply/setup").send({});
    expect(res.status).toBe(403);
  });

  test("status endpoint reports configuration for an admin", async () => {
    const res = await request(app)
      .get("/api/newsletter/reply/status")
      .set("Cookie", adminCookie());
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.inbox).toBe("palonur-ask@agentmail.to");
  });
});
