/**
 * "Get personal help" contact form → team inbox email.
 *
 * Follows the same getResendClient / sendGuarded pattern as every other email
 * helper: resolve the client per-send (Resend connector, not env var), funnel
 * through the guarded quota rails, and degrade to a warn (returning false)
 * when Resend is unconfigured — the route still confirms receipt so the
 * surface never breaks in dev/test.
 */
import { getResendClient } from "./resendClient.js";
import { sendGuarded } from "./emailGuard.js";
import { logger } from "./logger.js";

const TEAM_INBOX = process.env.CONTACT_TEAM_EMAIL ?? "karan@palonur.com";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Send a personal-help contact message to the team. Returns true when handed
 * to Resend, false when it degraded (no client) or errored.
 */
export async function sendContactMessage(args: {
  name: string;
  email: string;
  message: string;
  /** Optional context: which answer surface / pillar the user was on. */
  context?: string | null;
}): Promise<boolean> {
  const conn = await getResendClient();
  if (!conn) {
    logger.warn(
      { from: args.email },
      "Resend not configured — would send personal-help contact message",
    );
    return false;
  }

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;max-width:560px;padding:24px">
  <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#a98c7a;margin-bottom:20px">Palonur</div>
  <div style="font-size:20px;font-family:Georgia,serif;color:#1a0505;margin-bottom:20px">Personal help request</div>
  <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:24px">
    <tr><td style="padding:8px 12px;background:#faf8f6;border:1px solid #e8ddd0;width:110px;font-weight:600">Name</td>
        <td style="padding:8px 12px;background:#fff;border:1px solid #e8ddd0">${esc(args.name)}</td></tr>
    <tr><td style="padding:8px 12px;background:#faf8f6;border:1px solid #e8ddd0;font-weight:600">Email</td>
        <td style="padding:8px 12px;background:#fff;border:1px solid #e8ddd0"><a href="mailto:${esc(args.email)}">${esc(args.email)}</a></td></tr>
    ${args.context ? `<tr><td style="padding:8px 12px;background:#faf8f6;border:1px solid #e8ddd0;font-weight:600">Context</td>
        <td style="padding:8px 12px;background:#fff;border:1px solid #e8ddd0">${esc(args.context)}</td></tr>` : ""}
    <tr><td style="padding:8px 12px;background:#faf8f6;border:1px solid #e8ddd0;font-weight:600;vertical-align:top">Message</td>
        <td style="padding:8px 12px;background:#fff;border:1px solid #e8ddd0;white-space:pre-wrap">${esc(args.message)}</td></tr>
  </table>
  <p style="font-size:13px;color:#555">Reply directly to this email to reach them.</p>
  <p style="font-size:12px;color:#bbb;margin-top:32px">Palonur internal notification</p>
</div>`;

  const text = [
    "Personal help request",
    `Name: ${args.name}`,
    `Email: ${args.email}`,
    args.context ? `Context: ${args.context}` : "",
    "",
    args.message,
  ].filter(Boolean).join("\n");

  const from =
    process.env.CONSUMER_FROM ??
    (conn.fromEmail.includes("<") ? conn.fromEmail : `Palonur <${conn.fromEmail}>`);

  const { error } = await sendGuarded(
    conn.client,
    {
      from,
      to: TEAM_INBOX,
      replyTo: args.email,
      subject: `[Personal help] ${args.name || args.email}`,
      html,
      text,
    },
    { label: "personal-help contact" },
  );
  if (error) {
    logger.error({ err: error, from: args.email }, "Failed to send contact message");
    return false;
  }
  return true;
}
