/**
 * Fire-and-forget notification to karan@palonur.com whenever a human user
 * asks any question on any agent surface.
 *
 * Skips partner-key (B2B) requests — those are programmatic callers, not
 * human consumers Karan would follow up with.
 *
 * Uses the same getResendClient / sendGuarded pattern as all other email
 * helpers so it degrades silently when Resend is unconfigured.
 */
import type { Request } from "express";
import { getResendClient } from "./resendClient.js";
import { sendGuarded } from "./emailGuard.js";
import { logger } from "./logger.js";
import { getConsumerFromRequest } from "./consumerAuth.js";
import pool from "./db.js";

const KARAN = "karan@palonur.com";

const SOURCE_LABELS: Record<string, string> = {
  "sleep-agent": "Sleep agent (/sleep)",
  "embed-agent": "Embed agent (/embed-agent)",
  "newsletter-qa": "Newsletter Q&A (/p/:slug)",
};

/**
 * Look up a registered user's email from the palonur_session cookie value.
 * palonur_users rows are linked to their session via the onboarding
 * registration flow — the frontend stores the userId in localStorage and
 * sends it on commit, but we can also match by looking at recent agent_queries
 * rows that share this session_id and joining to palonur_users via any saved
 * question association. Simpler fallback: just return null if not found.
 */
async function lookupOnboardingEmail(
  sessionId: string,
): Promise<string | null> {
  try {
    const { rows } = await pool.query<{ email: string }>(
      `SELECT pu.email
         FROM palonur_commitments pc
         JOIN palonur_users pu ON pu.id = pc.user_id
        WHERE EXISTS (
          SELECT 1 FROM agent_queries aq
           WHERE aq.session_id = $1
             AND aq.created_at > NOW() - INTERVAL '7 days'
          LIMIT 1
        )
          AND pu.email IS NOT NULL
        ORDER BY pc.created_at DESC
        LIMIT 1`,
      [sessionId],
    );
    return rows[0]?.email ?? null;
  } catch {
    return null;
  }
}

/**
 * Send a notification to Karan for every real human question.
 * Call fire-and-forget: `notifyKaranOfQuestion(req, message, "sleep-agent")`.
 * Never awaited — errors are swallowed after logging.
 */
export function notifyKaranOfQuestion(
  req: Request,
  question: string,
  source: string,
): void {
  // Skip B2B partner-key callers — they are not human consumers.
  if ((req as Request & { partnerKey?: unknown }).partnerKey) return;

  void (async () => {
    try {
      const conn = await getResendClient();
      if (!conn) return;

      // Try consumer_accounts first (Stripe/billing sign-in).
      let userEmail: string | null = null;
      let userName: string | null = null;
      try {
        const account = await getConsumerFromRequest(req);
        userEmail = account?.email ?? null;
      } catch {
        // non-fatal
      }

      // Fallback: try palonur_users via session cookie (onboarding sign-up).
      if (!userEmail) {
        const sessionCookie =
          (req.cookies as Record<string, string> | undefined)
            ?.palonur_session ?? null;
        if (sessionCookie) {
          userEmail = await lookupOnboardingEmail(sessionCookie);
        }
      }

      const surfaceLabel = SOURCE_LABELS[source] ?? source;
      const userLine = userEmail
        ? `<b>User:</b> ${userEmail}${userName ? ` (${userName})` : ""}`
        : "<b>User:</b> anonymous";

      const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;max-width:560px;padding:24px">
  <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#a98c7a;margin-bottom:20px">Palonur</div>
  <div style="font-size:20px;font-family:Georgia,serif;color:#1a0505;margin-bottom:20px">New question asked</div>
  <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:24px">
    <tr><td style="padding:8px 12px;background:#faf8f6;border:1px solid #e8ddd0;width:110px;font-weight:600">Surface</td>
        <td style="padding:8px 12px;background:#fff;border:1px solid #e8ddd0">${surfaceLabel}</td></tr>
    <tr><td style="padding:8px 12px;background:#faf8f6;border:1px solid #e8ddd0;font-weight:600">User</td>
        <td style="padding:8px 12px;background:#fff;border:1px solid #e8ddd0">${userEmail ?? "anonymous"}</td></tr>
    <tr><td style="padding:8px 12px;background:#faf8f6;border:1px solid #e8ddd0;font-weight:600">Question</td>
        <td style="padding:8px 12px;background:#fff;border:1px solid #e8ddd0;font-style:italic">${question.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</td></tr>
  </table>
  ${userEmail ? `<p style="font-size:13px;color:#555">Reply directly to this email to reach them, or write to <a href="mailto:${userEmail}">${userEmail}</a>.</p>` : ""}
  <p style="font-size:12px;color:#bbb;margin-top:32px">Palonur internal notification</p>
</div>`;

      const text = [
        `New question on ${surfaceLabel}`,
        `User: ${userEmail ?? "anonymous"}`,
        `Question: ${question}`,
        userEmail ? `\nReply to reach them: ${userEmail}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      const from =
        process.env.CONSUMER_FROM ??
        (conn.fromEmail.includes("<")
          ? conn.fromEmail
          : `Palonur <${conn.fromEmail}>`);

      await sendGuarded(
        conn.client,
        {
          from,
          to: KARAN,
          subject: `[${surfaceLabel}] ${question.slice(0, 72)}${question.length > 72 ? "..." : ""}`,
          html,
          text,
        },
        { label: "karan-notify" },
      );
    } catch (e) {
      logger.warn({ err: e }, "karanNotify: failed (non-fatal)");
    }
  })();
}
