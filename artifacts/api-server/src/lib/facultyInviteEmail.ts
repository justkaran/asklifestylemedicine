import { getResendClient } from "./resendClient";
import { logger } from "./logger";
import { sendGuarded } from "./emailGuard";


const FROM_ADDRESS =
  process.env.FACULTY_INVITE_FROM ?? "Palonur, Palo Alto <noreply@palonur.com>";

export interface SendInviteEmailArgs {
  to: string;
  pillarName: string;
  inviterName: string | null;
  acceptUrl: string;
  role: string;
}

export async function sendFacultyInviteEmail(
  args: SendInviteEmailArgs,
): Promise<void> {
  const conn = await getResendClient();
  if (!conn) {
    logger.warn(
      { to: args.to },
      "Resend not configured — skipping faculty invite email",
    );
    return;
  }

  const { to, pillarName, inviterName, acceptUrl, role } = args;
  const inviter = inviterName ?? "A Palonur steward";
  const subject = `${inviter} invited you to the Palonur ${pillarName} pillar`;
  const text = `${inviter} has invited you to join the Palonur ${pillarName} pillar as a ${role}.

Accept your invitation:
${acceptUrl}

This link will expire in 14 days. If you weren't expecting this email, you can ignore it.

— Palonur`;

  const html = `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color:#111; max-width:560px; margin:0 auto; padding:24px;">
  <p>${escapeHtml(inviter)} has invited you to join the <strong>Palonur ${escapeHtml(pillarName)}</strong> pillar as <strong>${escapeHtml(role)}</strong>.</p>
  <p style="margin: 28px 0;">
    <a href="${acceptUrl}" style="background:#E8352A; color:#fff; text-decoration:none; padding:12px 20px; border-radius:6px; display:inline-block;">Accept invitation</a>
  </p>
  <p style="color:#666; font-size:13px;">This link expires in 14 days. If you weren't expecting this email, you can ignore it.</p>
  <p style="color:#999; font-size:12px; margin-top:32px;">— Palonur</p>
</body></html>`;

  const { error } = await sendGuarded(
    conn.client,
    {
      from: FROM_ADDRESS,
      to,
      subject,
      text,
      html,
    },
    { label: "faculty invite" },
  );
  if (error) {
    logger.error({ err: error, to }, "Failed to send faculty invite email");
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
