/**
 * Follow-up email sent the morning after a user commits to a sleep experiment.
 * Contains three one-click outcome links so the reader can record what happened
 * without logging in, plus a CTA to ask another question on /sleep.
 */
import { logger } from "./logger.js";
import { sendGuarded } from "./emailGuard.js";
import { getResendClient } from "./resendClient.js";

const BASE_URL = process.env.PUBLIC_URL ?? "https://palonur.replit.app";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function outcomeUrl(token: string, outcome: string): string {
  return `${BASE_URL}/api/reflect?token=${encodeURIComponent(token)}&outcome=${outcome}`;
}

export async function sendCommitmentFollowupEmail({
  to,
  firstName,
  actionText,
  reflectToken,
}: {
  to: string;
  firstName: string;
  actionText: string;
  reflectToken: string;
}): Promise<boolean> {
  const conn = await getResendClient();
  if (!conn) {
    logger.warn("sendCommitmentFollowupEmail: no Resend client, skipping");
    return false;
  }

  const helpedUrl = outcomeUrl(reflectToken, "helped");
  const noChangeUrl = outcomeUrl(reflectToken, "no_change");
  const notTriedUrl = outcomeUrl(reflectToken, "not_tried");
  const askUrl = `${BASE_URL}/sleep`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>How did last night's tip go?</title>
</head>
<body style="margin:0;padding:0;background:#faf8f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:520px;margin:0 auto;padding:48px 24px 56px">
  <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#a98c7a;margin-bottom:36px">palonur</div>
  <div style="font-size:24px;font-family:Georgia,serif;color:#1a0505;line-height:1.3;margin-bottom:14px">
    How did last night go, ${escapeHtml(firstName)}?
  </div>
  <div style="font-size:15px;color:#666;line-height:1.6;margin-bottom:10px">
    You committed to trying this:
  </div>
  <div style="background:#8B1A1A;color:#fff;border-radius:12px;padding:16px 20px;font-size:15px;line-height:1.5;margin-bottom:36px;font-weight:500">
    ${escapeHtml(actionText)}
  </div>
  <div style="font-size:16px;font-weight:600;color:#1a0505;margin-bottom:16px">What happened?</div>
  <a href="${helpedUrl}" style="display:block;text-align:center;background:#4a7c59;color:#fff;text-decoration:none;padding:17px 24px;border-radius:12px;font-size:16px;font-weight:600;margin-bottom:10px">
    It helped
  </a>
  <a href="${noChangeUrl}" style="display:block;text-align:center;background:#8B1A1A;color:#fff;text-decoration:none;padding:17px 24px;border-radius:12px;font-size:16px;font-weight:600;margin-bottom:10px">
    Didn't work
  </a>
  <a href="${notTriedUrl}" style="display:block;text-align:center;background:transparent;color:#6b4a3a;text-decoration:none;padding:15px 24px;border-radius:12px;font-size:15px;font-weight:500;border:1.5px solid rgba(139,26,26,0.22);margin-bottom:36px">
    Didn't try it
  </a>
  <div style="border-top:1px solid rgba(139,26,26,.08);padding-top:28px;margin-bottom:8px">
    <a href="${askUrl}" style="display:inline-block;font-size:14px;color:#8B1A1A;text-decoration:underline;font-weight:500">
      Ask another sleep question
    </a>
  </div>
  <div style="font-size:13px;color:#ccc;line-height:1.6;padding-top:16px">
    Palonur. Sleep science grounded in Stanford research.<br>
    You're receiving this because you committed to a sleep experiment.
  </div>
</div>
</body>
</html>`;

  const text = [
    `How did last night go, ${firstName}?`,
    "",
    "You committed to trying this:",
    actionText,
    "",
    "What happened?",
    "",
    `It helped: ${helpedUrl}`,
    `Didn't work: ${noChangeUrl}`,
    `Didn't try it: ${notTriedUrl}`,
    "",
    `Ask another sleep question: ${askUrl}`,
  ].join("\n");

  const from =
    process.env.CONSUMER_FROM ??
    (conn.fromEmail.includes("<") ? conn.fromEmail : `Palonur <${conn.fromEmail}>`);

  const result = await sendGuarded(
    conn.client,
    {
      from,
      to,
      subject: `How did last night's tip go?`,
      html,
      text,
    },
    { label: "commitment-followup" },
  );
  return !result.error;
}
