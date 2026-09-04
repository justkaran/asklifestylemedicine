import { getResendClient } from "./resendClient";
import { logger } from "./logger";
import { sendGuarded } from "./emailGuard";


const FROM_ADDRESS =
  process.env.STORY_FROM ?? "Palonur Stories <noreply@palonur.com>";

const BASE_URL = process.env.PUBLIC_URL ?? "https://palonur.replit.app";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function sendStoryMagicLink(args: {
  to: string;
  token: string;
}): Promise<void> {
  const link = `${BASE_URL}/stories-login?token=${encodeURIComponent(args.token)}`;
  const conn = await getResendClient();
  if (!conn) {
    logger.warn({ to: args.to, link }, "Resend not configured — would send story magic link");
    return;
  }
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;max-width:540px;margin:0 auto;padding:24px;">
  <p>Sign in to the Palonur Stories editor:</p>
  <p style="margin:28px 0;"><a href="${link}" style="background:#8B1A1A;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block;">Open Stories dashboard</a></p>
  <p style="color:#666;font-size:13px;">This link expires in 30 minutes. If you didn't request it, ignore this email.</p>
  <p style="color:#999;font-size:12px;margin-top:32px;">— Palonur · Stanford Lifestyle Medicine</p>
  </body></html>`;
  const { error } = await sendGuarded(
    conn.client,
    {
      from: FROM_ADDRESS,
      to: args.to,
      subject: "Your Palonur Stories sign-in link",
      text: `Open the Stories dashboard: ${link}\n\nExpires in 30 minutes.`,
      html,
    },
    { label: "story magic link" },
  );
  if (error) {
    logger.error({ err: error, to: args.to }, "Failed to send story magic link");
  }
}

export async function sendStoryInvite(args: {
  to: string;
  inviterEmail: string;
  contextNote?: string | null;
  token: string;
}): Promise<void> {
  const link = `${BASE_URL}/share?invite=${encodeURIComponent(args.token)}`;
  const conn = await getResendClient();
  if (!conn) {
    logger.warn({ to: args.to, link }, "Resend not configured — would send story invite");
    return;
  }
  const note = args.contextNote
    ? `<p style="color:#444;font-size:14px;background:#faf5f5;border-left:3px solid #8B1A1A;padding:12px 14px;border-radius:0 8px 8px 0;">${esc(args.contextNote)}</p>`
    : "";
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;max-width:540px;margin:0 auto;padding:24px;">
  <p>${esc(args.inviterEmail)} invited you to share your sleep story with the Stanford Lifestyle Medicine newsletter.</p>
  ${note}
  <p>It's a short, guided form — about 5 minutes. You decide which name (if any) appears.</p>
  <p style="margin:28px 0;"><a href="${link}" style="background:#8B1A1A;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block;">Share your story</a></p>
  <p style="color:#999;font-size:12px;margin-top:32px;">— Palonur · Stanford Lifestyle Medicine</p>
  </body></html>`;
  const { error } = await sendGuarded(
    conn.client,
    {
      from: FROM_ADDRESS,
      to: args.to,
      subject: `${args.inviterEmail} invited you to share your sleep story`,
      text: `Share your sleep story for the Stanford Lifestyle Medicine newsletter:\n${link}`,
      html,
    },
    { label: "story invite" },
  );
  if (error) {
    logger.error({ err: error, to: args.to }, "Failed to send story invite");
  }
}
