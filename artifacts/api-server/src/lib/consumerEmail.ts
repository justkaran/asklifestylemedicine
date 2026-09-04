import { logger } from "./logger";
import { sendGuarded } from "./emailGuard";
import { getResendClient } from "./resendClient";

const BASE_URL = process.env.PUBLIC_URL ?? "https://palonur.replit.app";

/**
 * Sends a consumer sign-in magic link. The link lands on the account
 * dashboard, which exchanges the token for a session cookie via
 * /api/consumer/auth/consume and then shows the buyer their subscription.
 */
export async function sendConsumerMagicLink(args: {
  to: string;
  token: string;
  /**
   * Optional internal path to forward the buyer to after the token is
   * exchanged for a session. Only same-origin absolute
   * paths are honored; anything else is ignored to prevent open redirects.
   */
  next?: string;
  /**
   * When true and SLM_DOMAIN is configured, the link lands on the standalone
   * Stanford Lifestyle Medicine domain root (`https://<SLM_DOMAIN>/?login=…`)
   * instead of the Palonur /account page — the standalone chat consumes the
   * token itself so the session cookie is set on the right domain. Falls back
   * to the normal /account flow when SLM_DOMAIN is unset (dev).
   */
  slmStandalone?: boolean;
  /**
   * When true, the email explicitly says the link also confirms the Stanford
   * Lifestyle Medicine newsletter opt-in made during registration. Consent
   * safety: the activation only ever happens when this was said out loud in
   * the email — a recipient who never registered can simply ignore it.
   */
  newsletterOptIn?: boolean;
}): Promise<void> {
  const safeNext =
    args.next &&
    args.next.startsWith("/") &&
    !args.next.startsWith("//") &&
    !args.next.includes("\\")
      ? args.next
      : null;
  const nextParam = safeNext ? `&next=${encodeURIComponent(safeNext)}` : "";
  // Normalize SLM_DOMAIN to a bare hostname (no scheme/port/path) and reject
  // anything that is not hostname-shaped, so a malformed env value can never
  // produce an unintended link target.
  const slmDomain = (process.env.SLM_DOMAIN ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
  const slmDomainValid = /^[a-z0-9][a-z0-9.-]*$/.test(slmDomain);
  const link =
    args.slmStandalone && slmDomainValid
      ? `https://${slmDomain}/?login=${encodeURIComponent(args.token)}`
      : `${BASE_URL}/account?login=${encodeURIComponent(args.token)}${nextParam}`;
  const conn = await getResendClient();
  if (!conn) {
    logger.warn(
      { to: args.to, link },
      "Resend not configured — would send consumer magic link",
    );
    return;
  }
  const from =
    process.env.CONSUMER_FROM ??
    (conn.fromEmail.includes("<")
      ? conn.fromEmail
      : `Palonur <${conn.fromEmail}>`);
  const newsletterLineHtml = args.newsletterOptIn
    ? `<p style="color:#666;font-size:13px;">Clicking the button also confirms your subscription to the Stanford Lifestyle Medicine newsletter, which you asked for when you registered. If you do not want it, just ignore this email.</p>`
    : "";
  const newsletterLineText = args.newsletterOptIn
    ? `\n\nClicking the link also confirms your subscription to the Stanford Lifestyle Medicine newsletter, which you asked for when you registered. If you do not want it, just ignore this email.`
    : "";
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;max-width:540px;margin:0 auto;padding:24px;">
  <p>Sign in to your Palonur account to access your subscription:</p>
  <p style="margin:28px 0;"><a href="${link}" style="background:#8B1A1A;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block;">Sign in to Palonur</a></p>
  ${newsletterLineHtml}
  <p style="color:#666;font-size:13px;">This link expires in 30 minutes. If you didn't request it, you can ignore this email.</p>
  <p style="color:#999;font-size:12px;margin-top:32px;">— Palonur · Stanford Lifestyle Medicine</p>
  </body></html>`;
  const { error } = await sendGuarded(
    conn.client,
    {
      from,
      to: args.to,
      subject: "Your Palonur sign-in link",
      text: `Sign in to Palonur: ${link}${newsletterLineText}\n\nExpires in 30 minutes.`,
      html,
    },
    { label: "consumer magic link" },
  );
  if (error) {
    logger.error(
      { err: error, to: args.to },
      "Failed to send consumer magic link",
    );
  }
}
