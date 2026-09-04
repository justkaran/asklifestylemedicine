import { getResendClient } from "./resendClient";
import { logger } from "./logger";
import { sendGuarded } from "./emailGuard";


const FROM_ADDRESS =
  process.env.COMMUNICATION_FROM ??
  process.env.STORY_FROM ??
  "Palonur <noreply@palonur.com>";

const BASE_URL = process.env.PUBLIC_URL ?? "https://palonur.replit.app";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Magic-link sign-in for Matt's communication review queue. */
export async function sendCommunicationMagicLink(args: {
  to: string;
  token: string;
}): Promise<void> {
  const link = `${BASE_URL}/communication-login?token=${encodeURIComponent(args.token)}`;
  const conn = await getResendClient();
  if (!conn) {
    logger.warn(
      { to: args.to, link },
      "Resend not configured — would send communication magic link",
    );
    return;
  }
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;max-width:540px;margin:0 auto;padding:24px;">
  <p>Sign in to review the article offers stewards have sent you:</p>
  <p style="margin:28px 0;"><a href="${link}" style="background:#8B1A1A;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block;">Open your review queue</a></p>
  <p style="color:#666;font-size:13px;">This link expires in 30 minutes. If you didn't request it, ignore this email.</p>
  <p style="color:#999;font-size:12px;margin-top:32px;">— Palonur · Stanford Lifestyle Medicine</p>
  </body></html>`;
  const { error } = await sendGuarded(
    conn.client,
    {
      from: FROM_ADDRESS,
      to: args.to,
      subject: "Your Palonur review-queue sign-in link",
      text: `Open your review queue: ${link}\n\nExpires in 30 minutes.`,
      html,
    },
    { label: "communication magic link" },
  );
  if (error) {
    logger.error(
      { err: error, to: args.to },
      "Failed to send communication magic link",
    );
  }
}

/** Notify Matt that a steward has offered a new article. */
export async function sendCommunicationOfferNotice(args: {
  to: string | string[];
  authorName: string | null;
  authorEmail: string | null;
  title: string;
  summary: string | null;
}): Promise<void> {
  const link = `${BASE_URL}/communication`;
  const conn = await getResendClient();
  if (!conn) {
    logger.warn(
      { to: args.to, title: args.title },
      "Resend not configured — would send communication offer notice",
    );
    return;
  }
  const author = args.authorName ?? args.authorEmail ?? "A steward";
  const summary = args.summary
    ? `<p style="color:#444;font-size:14px;background:#faf5f5;border-left:3px solid #8B1A1A;padding:12px 14px;border-radius:0 8px 8px 0;">${esc(args.summary)}</p>`
    : "";
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;max-width:540px;margin:0 auto;padding:24px;">
  <p><strong>${esc(author)}</strong> offered you an article for communication-focused content:</p>
  <p style="font-size:18px;font-weight:600;margin:14px 0 4px;">${esc(args.title)}</p>
  ${summary}
  <p style="margin:28px 0;"><a href="${link}" style="background:#8B1A1A;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block;">Review the offer</a></p>
  <p style="color:#999;font-size:12px;margin-top:32px;">— Palonur · Stanford Lifestyle Medicine</p>
  </body></html>`;
  const { error } = await sendGuarded(
    conn.client,
    {
      from: FROM_ADDRESS,
      to: args.to,
      subject: `New article offer: ${args.title}`,
      text: `${author} offered you an article: "${args.title}".\n\nReview it: ${link}`,
      html,
    },
    { label: "communication offer notice" },
  );
  if (error) {
    logger.error(
      { err: error, to: args.to },
      "Failed to send communication offer notice",
    );
  }
}

/** Notify the steward that Matt accepted or declined their offer. */
export async function sendCommunicationDecision(args: {
  to: string;
  title: string;
  status: "accepted" | "declined";
  note: string | null;
}): Promise<void> {
  const conn = await getResendClient();
  if (!conn) {
    logger.warn(
      { to: args.to, title: args.title, status: args.status },
      "Resend not configured — would send communication decision",
    );
    return;
  }
  const accepted = args.status === "accepted";
  const headline = accepted
    ? `Matt Abrahams accepted your article offer`
    : `Matt Abrahams declined your article offer`;
  const note = args.note
    ? `<p style="color:#444;font-size:14px;background:#faf5f5;border-left:3px solid #8B1A1A;padding:12px 14px;border-radius:0 8px 8px 0;"><strong>Matt's note:</strong> ${esc(args.note)}</p>`
    : "";
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;max-width:540px;margin:0 auto;padding:24px;">
  <p>${esc(headline)}:</p>
  <p style="font-size:18px;font-weight:600;margin:14px 0 4px;">${esc(args.title)}</p>
  ${note}
  <p style="color:#999;font-size:12px;margin-top:32px;">— Palonur · Stanford Lifestyle Medicine</p>
  </body></html>`;
  const { error } = await sendGuarded(
    conn.client,
    {
      from: FROM_ADDRESS,
      to: args.to,
      subject: accepted
        ? `Matt accepted: ${args.title}`
        : `Update on your article offer: ${args.title}`,
      text: `${headline}: "${args.title}".${args.note ? `\n\nMatt's note: ${args.note}` : ""}`,
      html,
    },
    { label: "communication decision" },
  );
  if (error) {
    logger.error(
      { err: error, to: args.to },
      "Failed to send communication decision",
    );
  }
}
