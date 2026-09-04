import { Router, type Request, type Response } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "@workspace/db";
import { newsletterReplyEventsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { answerNewsletterQuestion } from "../lib/newsletterQa.js";
import {
  buildQaReplyEmail,
  sendNewsletterEmail,
} from "../lib/newsletterEmail.js";
import {
  qaInboxAddress,
  webhookSecret,
  replyLoopConfigured,
  ensureQaInbox,
} from "../lib/agentMail.js";
import {
  cleanInboundQuestion,
  parseFromEmail,
  isAutoReply,
} from "../lib/inboundEmail.js";
import { enforceRateLimit } from "../middlewares/emailRateLimit.js";

const router = Router();

// Per-sender throttle for inbound Q&A replies: a generous handful per hour so a
// real reader can ask a few follow-ups, while a runaway auto-responder loop or a
// single abusive sender can't burn the Resend quota answering itself.
const REPLY_LIMIT = 4;
const REPLY_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function isAdmin(req: Request): boolean {
  return req.signedCookies?.palonur_admin === "1";
}

function fromHashOf(email: string): string {
  const salt = process.env.SESSION_SECRET ?? "dev-secret-change-me";
  return createHash("sha256").update(`${email}${salt}`).digest("hex");
}

/** Constant-time-ish compare for the shared webhook secret. */
function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return a.equals(b);
}

const inboundSchema = z.object({
  // AgentMail sends `event_type`; accept `type` defensively too.
  event_type: z.string().optional(),
  type: z.string().optional(),
  event_id: z.string().optional(),
  id: z.string().optional(),
  message: z
    .object({
      message_id: z.string().optional(),
      inbox_id: z.string().optional(),
      thread_id: z.string().optional(),
      from_: z.string().optional(),
      from: z.string().optional(),
      subject: z.string().optional(),
      text: z.string().optional(),
      html: z.string().optional(),
      labels: z.array(z.string()).optional(),
      in_reply_to: z.string().optional(),
    })
    .optional(),
});

/**
 * Inbound AgentMail webhook. A reader replied to a newsletter (whose Reply-To
 * points at the AgentMail inbox); AgentMail POSTs the message here. We verify the
 * shared secret, dedup on event_id, ignore auto-replies / our own sends, rate
 * limit per sender, run the existing Q&A engine, and email the answer back via
 * the guarded Resend path. ALWAYS returns 200 (except auth failures) so AgentMail
 * does not hammer retries; processing is synchronous so it is unit-testable.
 *
 * Degrades cleanly: when the reply loop is unconfigured (no secret / no inbox)
 * the endpoint no-ops with 200 instead of erroring.
 */
router.post("/newsletter/reply/inbound", async (req: Request, res: Response) => {
  const secret = webhookSecret();

  // Unconfigured → accept-and-ignore so a stray probe can't error.
  if (!secret || !replyLoopConfigured()) {
    req.log?.info("newsletter reply webhook hit while unconfigured — noop");
    res.status(200).json({ ok: true, ignored: "unconfigured" });
    return;
  }

  // Genuineness: shared secret via ?token= or X-Webhook-Secret header.
  const provided =
    (typeof req.query.token === "string" ? req.query.token : undefined) ??
    (typeof req.headers["x-webhook-secret"] === "string"
      ? (req.headers["x-webhook-secret"] as string)
      : undefined);
  if (!secretMatches(provided, secret)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const parsed = inboundSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(200).json({ ok: true, ignored: "unparseable" });
    return;
  }
  const body = parsed.data;
  const eventType = body.event_type ?? body.type ?? "";
  const msg = body.message;

  // Only handle inbound received messages; ignore everything else (incl. our
  // own outbound copies which carry a "sent" label).
  if (eventType && eventType !== "message.received") {
    res.status(200).json({ ok: true, ignored: "event_type" });
    return;
  }
  if (!msg) {
    res.status(200).json({ ok: true, ignored: "no_message" });
    return;
  }
  const labels = msg.labels ?? [];
  if (labels.includes("sent")) {
    res.status(200).json({ ok: true, ignored: "sent_label" });
    return;
  }

  const eventId = body.event_id ?? body.id ?? msg.message_id;
  if (!eventId) {
    res.status(200).json({ ok: true, ignored: "no_event_id" });
    return;
  }

  const fromRaw = msg.from_ ?? msg.from ?? null;
  const fromEmail = parseFromEmail(fromRaw);

  // Atomic dedup claim: a retried webhook inserts 0 rows → already handled.
  const claimed = await db
    .insert(newsletterReplyEventsTable)
    .values({
      eventId,
      messageId: msg.message_id ?? null,
      inboxId: msg.inbox_id ?? null,
      fromHash: fromEmail ? fromHashOf(fromEmail) : null,
      outcome: "processing",
    })
    .onConflictDoNothing({ target: newsletterReplyEventsTable.eventId })
    .returning({ id: newsletterReplyEventsTable.id });

  if (claimed.length === 0) {
    res.status(200).json({ ok: true, ignored: "duplicate" });
    return;
  }
  const rowId = claimed[0].id;

  const finish = async (
    outcome: string,
    extra?: { pillarSlug?: string | null; expertName?: string | null },
  ) => {
    await db
      .update(newsletterReplyEventsTable)
      .set({
        outcome,
        pillarSlug: extra?.pillarSlug ?? null,
        expertName: extra?.expertName ?? null,
      })
      .where(eq(newsletterReplyEventsTable.id, rowId));
  };

  try {
    // Ignore auto-replies / bounces / OOO / our own address.
    if (
      isAutoReply({
        from: fromRaw,
        subject: msg.subject ?? null,
        labels,
      }) ||
      !fromEmail ||
      fromEmail === qaInboxAddress()
    ) {
      await finish("ignored");
      res.status(200).json({ ok: true, ignored: "auto_or_self" });
      return;
    }

    // Per-sender rate limit.
    const gate = await enforceRateLimit({
      scope: "reply-qa",
      key: fromEmail,
      limit: REPLY_LIMIT,
      windowMs: REPLY_WINDOW_MS,
    });
    if (!gate.allowed) {
      await finish("rate_limited");
      res.status(200).json({ ok: true, ignored: "rate_limited" });
      return;
    }

    const question = cleanInboundQuestion({
      text: msg.text ?? null,
      html: msg.html ?? null,
    });
    if (!question) {
      await finish("ignored");
      res.status(200).json({ ok: true, ignored: "empty_question" });
      return;
    }

    const result = await answerNewsletterQuestion(question);
    const email = buildQaReplyEmail({
      question,
      subject: msg.subject ?? null,
      result: {
        outcome: result.outcome,
        expert: result.expert
          ? { name: result.expert.name, pillarName: result.expert.pillarName }
          : null,
        answer: result.answer,
        interpretation: result.interpretation,
        action: result.action,
        citation: result.citation,
        paper: result.paper,
      },
    });

    await sendNewsletterEmail({
      to: fromEmail,
      subject: email.subject,
      html: email.html,
      text: email.text,
      replyTo: qaInboxAddress(),
      label: "newsletter reply qa",
    });

    await finish(result.outcome, {
      pillarSlug: result.expert?.pillarSlug ?? null,
      expertName: result.expert?.name ?? null,
    });
    res.status(200).json({ ok: true, outcome: result.outcome });
  } catch (err) {
    req.log?.error({ err }, "newsletter reply processing failed");
    await finish("error").catch(() => {});
    // Still 200: a 500 makes AgentMail retry, which would re-answer.
    res.status(200).json({ ok: true, error: "processing_failed" });
  }
});

/**
 * Admin-only one-time setup: create the AgentMail inbox + register this webhook.
 * Idempotent. Returns the inbox address on success. Gated by the shared admin
 * cookie (same as the rest of the admin surfaces).
 */
router.post("/newsletter/reply/setup", async (req: Request, res: Response) => {
  if (!isAdmin(req)) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const base = (process.env.PUBLIC_URL ?? "https://palonur.replit.app").replace(
    /\/$/,
    "",
  );
  const webhookUrl = `${base}/api/newsletter/reply/inbound`;
  try {
    const result = await ensureQaInbox(webhookUrl);
    if (!result) {
      res.status(409).json({
        error: "not_configured",
        message:
          "AgentMail is not configured (missing API key / AGENTMAIL_WEBHOOK_SECRET).",
      });
      return;
    }
    res.json({ ok: true, address: result.address, webhookUrl });
  } catch (err) {
    req.log?.error({ err }, "AgentMail setup failed");
    res.status(502).json({ error: "setup_failed" });
  }
});

/** Lightweight status for the admin UI / sanity checks. */
router.get("/newsletter/reply/status", (req: Request, res: Response) => {
  if (!isAdmin(req)) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  res.json({
    configured: replyLoopConfigured(),
    inbox: qaInboxAddress(),
    secretSet: Boolean(webhookSecret()),
  });
});

export default router;
