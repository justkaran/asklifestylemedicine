/**
 * POST /api/uncovered-escalation
 *
 * Called by every agent surface when it returns UNCOVERED. Records the
 * unanswered question and, if the visitor leaves an email, stores it so
 * Palonur can follow up with the right expert.
 *
 * A plain notification email goes to karan@palonur.com on every submission.
 * Rate-limited to 5 submissions per hour per IP to prevent flooding.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { db, uncoveredEscalationsTable } from "@workspace/db";
import { getResendClient } from "../lib/resendClient.js";
import { sendGuarded } from "../lib/emailGuard.js";
import { enforceRateLimit } from "../middlewares/emailRateLimit.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

const NOTIFY_TO = "karan@palonur.com";
const FROM_ADDRESS = "Palonur <noreply@palonur.com>";
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const IP_LIMIT = 5;

function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

router.post("/uncovered-escalation", async (req: Request, res: Response) => {
  const body = req.body as {
    question?: string;
    surface?: string;
    userEmail?: string;
    sessionId?: string;
  };

  const question = String(body.question ?? "").trim();
  const surface = String(body.surface ?? "unknown").trim().slice(0, 100);
  const rawEmail = String(body.userEmail ?? "").trim().toLowerCase();
  const sessionId = body.sessionId ? String(body.sessionId).trim().slice(0, 200) : null;
  const userEmail =
    rawEmail && rawEmail.includes("@") ? rawEmail : null;

  if (!question || question.length < 3) {
    return res.status(400).json({ error: "Question required" });
  }

  const ip = clientIp(req);
  const { allowed, retryAfterSec } = await enforceRateLimit({
    scope: "uncovered-escalation-ip",
    key: ip,
    limit: IP_LIMIT,
    windowMs: WINDOW_MS,
  });
  if (!allowed) {
    res.setHeader("Retry-After", String(retryAfterSec));
    return res
      .status(429)
      .json({ error: "rate_limited", retry_after: retryAfterSec });
  }

  try {
    await db.insert(uncoveredEscalationsTable).values({
      question,
      surface,
      userEmail,
      sessionId,
    });
  } catch (e) {
    req.log.error({ err: e }, "uncovered-escalation insert failed");
    return res.status(500).json({ error: "Failed to save" });
  }

  const conn = await getResendClient();
  if (conn) {
    const surfaceLabel = esc(surface);
    const questionHtml = esc(question);
    const emailLine = userEmail
      ? `<p style="margin:0 0 10px;"><strong>Visitor email:</strong> ${esc(userEmail)}</p>`
      : `<p style="margin:0 0 10px;color:#666;">No email left by visitor.</p>`;

    const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;max-width:560px;margin:0 auto;padding:24px;line-height:1.6;">
<p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#8C1515;">Unanswered question</p>
<p style="margin:0 0 4px;"><strong>Surface:</strong> ${surfaceLabel}</p>
<blockquote style="margin:0 0 18px;padding:12px 16px;border-left:3px solid #8C1515;color:#333;font-style:italic;font-size:16px;">${questionHtml}</blockquote>
${emailLine}
<p style="margin:24px 0 0;color:#999;font-size:12px;">Palonur agent escalation</p>
</body></html>`;

    const text = `Unanswered question (${surface})\n\n${question}\n\n${userEmail ? `Visitor email: ${userEmail}` : "No email left."}\n\n— Palonur agent escalation`;

    const { error } = await sendGuarded(
      conn.client,
      {
        from: FROM_ADDRESS,
        to: NOTIFY_TO,
        subject: `Unanswered: "${question.slice(0, 60)}${question.length > 60 ? "..." : ""}"`,
        text,
        html,
      },
      { label: "uncovered escalation notify" },
    );
    if (error) {
      logger.warn({ err: error }, "uncovered-escalation notify email failed");
    }
  } else {
    logger.warn(
      { question, surface },
      "Resend not configured — uncovered escalation not emailed",
    );
  }

  return res.json({ ok: true });
});

export default router;
