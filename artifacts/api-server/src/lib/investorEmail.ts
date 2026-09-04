import { getResendClient } from "./resendClient";
import { logger } from "./logger";
import { sendGuarded } from "./emailGuard";


const FROM_ADDRESS =
  process.env.INVESTOR_FROM ?? "Palonur <noreply@palonur.com>";

const BASE_URL = process.env.PUBLIC_URL ?? "https://palonur.replit.app";

export async function sendInvestorMagicLink(args: {
  to: string;
  name?: string | null;
  token: string;
}): Promise<void> {
  const link = `${BASE_URL}/investor-login?token=${encodeURIComponent(args.token)}`;
  const conn = await getResendClient();
  if (!conn) {
    logger.warn(
      { to: args.to, link },
      "Resend not configured — would send investor magic link",
    );
    return;
  }
  const greeting = args.name ? `Hi ${args.name},` : "Hello,";
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0a0a0f;max-width:540px;margin:0 auto;padding:24px;">
  <p>${greeting}</p>
  <p>Here is your one-time link to the Palonur investor portal:</p>
  <p style="margin:28px 0;"><a href="${link}" style="background:#0a0a2a;color:#fff;text-decoration:none;padding:13px 22px;border-radius:999px;display:inline-block;font-weight:600;">Open the investor portal</a></p>
  <p style="color:#666;font-size:13px;">This link expires in 30 minutes and is just for you. If you didn't request it, ignore this email.</p>
  <p style="color:#999;font-size:12px;margin-top:32px;">— Palonur</p>
  </body></html>`;
  const { error } = await sendGuarded(
    conn.client,
    {
      from: FROM_ADDRESS,
      to: args.to,
      subject: "Your Palonur investor portal link",
      text: `${greeting}\n\nOpen the Palonur investor portal: ${link}\n\nExpires in 30 minutes.`,
      html,
    },
    { label: "investor magic link" },
  );
  if (error) {
    logger.error({ err: error, to: args.to }, "Failed to send investor magic link");
  }
}
