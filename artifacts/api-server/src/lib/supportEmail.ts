import { getResendClient } from "./resendClient";
import { logger } from "./logger";
import { sendGuarded } from "./emailGuard";

/**
 * Support Concierge email helpers. Mirror the other magic-link email helpers
 * (storyEmail / investorEmail): module-level Resend client, graceful degrade to
 * a warn when Resend isn't configured, sendGuarded for quota/safety rails.
 *
 * Two reply identities:
 *   - SUPPORT_FROM      — the warm Palonur concierge identity (reply AS Palonur)
 *   - steward replies   — sent from the same Palonur identity but signed in the
 *     steward's name (we do not own per-steward mailboxes).
 */

const FROM_ADDRESS =
  process.env.SUPPORT_FROM ?? "Palonur <noreply@palonur.com>";

const BASE_URL = process.env.PUBLIC_URL ?? "https://palonur.replit.app";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Render plain text reply into simple HTML paragraphs. */
function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;">${esc(p).replace(/\n/g, "<br/>")}</p>`)
    .join("");
}

export async function sendSupportMagicLink(args: {
  to: string;
  token: string;
}): Promise<void> {
  const link = `${BASE_URL}/support-login?token=${encodeURIComponent(args.token)}`;
  const conn = await getResendClient();
  if (!conn) {
    logger.warn(
      { to: args.to, link },
      "Resend not configured — would send support magic link",
    );
    return;
  }
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;max-width:540px;margin:0 auto;padding:24px;">
  <p>Sign in to the Palonur Support concierge:</p>
  <p style="margin:28px 0;"><a href="${link}" style="background:#8C1515;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block;">Open the concierge inbox</a></p>
  <p style="color:#666;font-size:13px;">This link expires in 30 minutes. If you didn't request it, ignore this email.</p>
  <p style="color:#999;font-size:12px;margin-top:32px;">— Palonur</p>
  </body></html>`;
  const { error } = await sendGuarded(
    conn.client,
    {
      from: FROM_ADDRESS,
      to: args.to,
      subject: "Your Palonur Support sign-in link",
      text: `Open the Palonur Support concierge inbox: ${link}\n\nExpires in 30 minutes.`,
      html,
    },
    { label: "support magic link" },
  );
  if (error) {
    logger.error({ err: error, to: args.to }, "Failed to send support magic link");
  }
}

/**
 * Send a reply to an "Ask Palonur" asker. When `stewardName` is provided the
 * reply is signed in that steward's voice; otherwise it is a warm Palonur
 * concierge reply. Returns true when handed to Resend, false when it degraded
 * (no key) or errored — callers may still mark the item answered on false since
 * the degrade is intentional in dev/test.
 */
export async function sendSupportReply(args: {
  to: string;
  name?: string | null;
  question: string;
  reply: string;
  stewardName?: string | null;
}): Promise<boolean> {
  const conn = await getResendClient();
  if (!conn) {
    logger.warn(
      { to: args.to, steward: args.stewardName ?? null },
      "Resend not configured — would send support reply",
    );
    return false;
  }
  const greeting = args.name ? `Hi ${esc(args.name)},` : "Hello,";
  const signature = args.stewardName
    ? `${esc(args.stewardName)} · Stanford Lifestyle Medicine`
    : "The Palonur team";
  const subject = args.stewardName
    ? `${args.stewardName} replied to your question`
    : "A reply from Palonur";
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;max-width:560px;margin:0 auto;padding:24px;line-height:1.6;">
  <p style="margin:0 0 14px;">${greeting}</p>
  <p style="margin:0 0 14px;color:#666;font-size:14px;">You asked:</p>
  <blockquote style="margin:0 0 20px;padding:10px 16px;border-left:3px solid #8C1515;color:#444;font-style:italic;">${esc(args.question)}</blockquote>
  ${paragraphs(args.reply)}
  <p style="margin:24px 0 0;color:#999;font-size:12px;">— ${signature}</p>
  </body></html>`;
  const text = `${args.name ? `Hi ${args.name},` : "Hello,"}\n\nYou asked:\n${args.question}\n\n${args.reply}\n\n— ${args.stewardName ? `${args.stewardName} · Stanford Lifestyle Medicine` : "The Palonur team"}`;
  const { error } = await sendGuarded(
    conn.client,
    {
      from: FROM_ADDRESS,
      to: args.to,
      subject,
      text,
      html,
    },
    { label: args.stewardName ? "support steward reply" : "support concierge reply" },
  );
  if (error) {
    logger.error({ err: error, to: args.to }, "Failed to send support reply");
    return false;
  }
  return true;
}
