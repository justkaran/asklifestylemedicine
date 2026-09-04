import { getResendClient } from "./resendClient";
import { logger } from "./logger";
import { sendGuarded } from "./emailGuard";


const FROM_ADDRESS = process.env.PARTNER_FROM ?? "Palonur <noreply@palonur.com>";

const BASE_URL = process.env.PUBLIC_URL ?? "https://palonur.replit.app";

const BTN =
  "background:#8B1A1A;color:#fff;text-decoration:none;padding:13px 22px;border-radius:999px;display:inline-block;font-weight:600;";
const WRAP =
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a0505;max-width:540px;margin:0 auto;padding:24px;";

/**
 * One-time sign-in link for the partner portal. Sent both on first signup and
 * on a returning-partner sign-in request. The frontend `/partner-login` page
 * consumes the `token` and sets the partner session cookie.
 */
export async function sendPartnerMagicLink(args: {
  to: string;
  name?: string | null;
  token: string;
}): Promise<void> {
  const link = `${BASE_URL}/partner-login?token=${encodeURIComponent(args.token)}`;
  const conn = await getResendClient();
  if (!conn) {
    logger.warn(
      { to: args.to, link },
      "Resend not configured — would send partner magic link",
    );
    return;
  }
  const greeting = args.name ? `Hi ${args.name},` : "Hello,";
  const html = `<!doctype html><html><body style="${WRAP}">
  <p>${greeting}</p>
  <p>Here is your one-time link to the Palonur partner portal:</p>
  <p style="margin:28px 0;"><a href="${link}" style="${BTN}">Open the partner portal</a></p>
  <p style="color:#666;font-size:13px;">This link expires in 30 minutes and is just for you. If you didn't request it, ignore this email.</p>
  <p style="color:#999;font-size:12px;margin-top:32px;">— Palonur</p>
  </body></html>`;
  const { error } = await sendGuarded(
    conn.client,
    {
      from: FROM_ADDRESS,
      to: args.to,
      subject: "Your Palonur partner portal link",
      text: `${greeting}\n\nOpen the Palonur partner portal: ${link}\n\nExpires in 30 minutes.`,
      html,
    },
    { label: "partner magic link" },
  );
  if (error) {
    logger.error({ err: error, to: args.to }, "Failed to send partner magic link");
  }
}

/**
 * Sent when an admin approves a partner request. Invites the partner back to
 * the portal to self-serve their payment and mint their API key.
 */
export async function sendPartnerApprovedEmail(args: {
  to: string;
  name?: string | null;
  token: string;
}): Promise<void> {
  const link = `${BASE_URL}/partner-login?token=${encodeURIComponent(args.token)}`;
  const conn = await getResendClient();
  if (!conn) {
    logger.warn(
      { to: args.to, link },
      "Resend not configured — would send partner approval email",
    );
    return;
  }
  const greeting = args.name ? `Hi ${args.name},` : "Hello,";
  const html = `<!doctype html><html><body style="${WRAP}">
  <p>${greeting}</p>
  <p>Good news — your Palonur partner request has been approved.</p>
  <p>Open the portal to set up payment and generate your API key. The same link signs you in:</p>
  <p style="margin:28px 0;"><a href="${link}" style="${BTN}">Set up &amp; get your key</a></p>
  <p style="color:#666;font-size:13px;">This sign-in link expires in 30 minutes. You can always request a fresh one from the portal.</p>
  <p style="color:#999;font-size:12px;margin-top:32px;">— Palonur</p>
  </body></html>`;
  const { error } = await sendGuarded(
    conn.client,
    {
      from: FROM_ADDRESS,
      to: args.to,
      subject: "You're approved for Palonur partner access",
      text: `${greeting}\n\nYour Palonur partner request was approved. Set up payment and get your key: ${link}\n\nExpires in 30 minutes.`,
      html,
    },
    { label: "partner approval" },
  );
  if (error) {
    logger.error(
      { err: error, to: args.to },
      "Failed to send partner approval email",
    );
  }
}
