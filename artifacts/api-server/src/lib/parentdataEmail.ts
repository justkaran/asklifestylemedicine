import { getResendClient } from "./resendClient";
import { logger } from "./logger";
import { sendGuarded } from "./emailGuard";


const FROM_ADDRESS =
  process.env.PARENTDATA_FROM ??
  process.env.STORY_FROM ??
  "Palonur <noreply@palonur.com>";

const BASE_URL = process.env.PUBLIC_URL ?? "https://palonur.replit.app";

const TEAL = "#0E7C7B";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Format integer cents as a USD string, e.g. 5000 → "$50.00". */
function formatUsd(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function shell(inner: string): string {
  return `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;max-width:540px;margin:0 auto;padding:24px;">
  ${inner}
  <p style="color:#999;font-size:12px;margin-top:32px;">— Palonur · for ParentData.org</p>
  </body></html>`;
}

/** Magic-link sign-in for the ParentData editor's review queue. */
export async function sendParentDataMagicLink(args: {
  to: string;
  token: string;
}): Promise<void> {
  const link = `${BASE_URL}/parentdata-login?token=${encodeURIComponent(args.token)}`;
  const conn = await getResendClient();
  if (!conn) {
    logger.warn(
      { to: args.to, link },
      "Resend not configured — would send ParentData magic link",
    );
    return;
  }
  const html = shell(`
  <p>Sign in to review the article proposals stewards have sent to ParentData:</p>
  <p style="margin:28px 0;"><a href="${link}" style="background:${TEAL};color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block;">Open your review queue</a></p>
  <p style="color:#666;font-size:13px;">This link expires in 30 minutes. If you didn't request it, ignore this email.</p>`);
  const { error } = await sendGuarded(
    conn.client,
    {
      from: FROM_ADDRESS,
      to: args.to,
      subject: "Your ParentData review-queue sign-in link",
      text: `Open your review queue: ${link}\n\nExpires in 30 minutes.`,
      html,
    },
    { label: "parentdata magic link" },
  );
  if (error) {
    logger.error(
      { err: error, to: args.to },
      "Failed to send ParentData magic link",
    );
  }
}

/** Notify the ParentData editor that a steward has proposed a new article. */
export async function sendParentDataOfferNotice(args: {
  to: string | string[];
  authorName: string | null;
  authorEmail: string | null;
  title: string;
  summary: string | null;
}): Promise<void> {
  const link = `${BASE_URL}/parentdata`;
  const conn = await getResendClient();
  if (!conn) {
    logger.warn(
      { to: args.to, title: args.title },
      "Resend not configured — would send ParentData offer notice",
    );
    return;
  }
  const author = args.authorName ?? args.authorEmail ?? "A steward";
  const summary = args.summary
    ? `<p style="color:#444;font-size:14px;background:#eef7f6;border-left:3px solid ${TEAL};padding:12px 14px;border-radius:0 8px 8px 0;">${esc(args.summary)}</p>`
    : "";
  const html = shell(`
  <p><strong>${esc(author)}</strong> proposed an article for ParentData:</p>
  <p style="font-size:18px;font-weight:600;margin:14px 0 4px;">${esc(args.title)}</p>
  ${summary}
  <p style="margin:28px 0;"><a href="${link}" style="background:${TEAL};color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block;">Review the proposal</a></p>`);
  const { error } = await sendGuarded(
    conn.client,
    {
      from: FROM_ADDRESS,
      to: args.to,
      subject: `New article proposal: ${args.title}`,
      text: `${author} proposed an article for ParentData: "${args.title}".\n\nReview it: ${link}`,
      html,
    },
    { label: "parentdata offer notice" },
  );
  if (error) {
    logger.error(
      { err: error, to: args.to },
      "Failed to send ParentData offer notice",
    );
  }
}

/** Notify the steward that ParentData accepted or declined their proposal. */
export async function sendParentDataDecision(args: {
  to: string;
  title: string;
  status: "accepted" | "declined";
  note: string | null;
  /**
   * The editor's payment decision (cents). null = undecided / not mentioned,
   * 0 = decided not to pay, >0 = amount. Only surfaced on an accept.
   */
  paymentCents?: number | null;
}): Promise<void> {
  const conn = await getResendClient();
  if (!conn) {
    logger.warn(
      { to: args.to, title: args.title, status: args.status },
      "Resend not configured — would send ParentData decision",
    );
    return;
  }
  const accepted = args.status === "accepted";
  const headline = accepted
    ? `ParentData accepted your article proposal`
    : `ParentData declined your article proposal`;
  const note = args.note
    ? `<p style="color:#444;font-size:14px;background:#eef7f6;border-left:3px solid ${TEAL};padding:12px 14px;border-radius:0 8px 8px 0;"><strong>Editor's note:</strong> ${esc(args.note)}</p>`
    : "";
  // Payment line only on accept, and only when the editor actually made a call.
  let paymentHtml = "";
  let paymentText = "";
  if (accepted && args.paymentCents != null) {
    const msg =
      args.paymentCents > 0
        ? `ParentData will pay <strong>${formatUsd(args.paymentCents)}</strong> for this article.`
        : `This piece will run without payment.`;
    paymentHtml = `<p style="color:#0a5c5b;font-size:15px;font-weight:600;margin:14px 0 0;">${msg}</p>`;
    paymentText =
      args.paymentCents > 0
        ? `\n\nPayment: ${formatUsd(args.paymentCents)}.`
        : `\n\nThis piece will run without payment.`;
  }
  const html = shell(`
  <p>${esc(headline)}:</p>
  <p style="font-size:18px;font-weight:600;margin:14px 0 4px;">${esc(args.title)}</p>
  ${paymentHtml}
  ${note}`);
  const { error } = await sendGuarded(
    conn.client,
    {
      from: FROM_ADDRESS,
      to: args.to,
      subject: accepted
        ? `ParentData accepted: ${args.title}`
        : `Update on your ParentData proposal: ${args.title}`,
      text: `${headline}: "${args.title}".${paymentText}${args.note ? `\n\nEditor's note: ${args.note}` : ""}`,
      html,
    },
    { label: "parentdata decision" },
  );
  if (error) {
    logger.error(
      { err: error, to: args.to },
      "Failed to send ParentData decision",
    );
  }
}

/**
 * Notify a faculty steward that ParentData posted a new call for articles.
 * Sent to one recipient at a time (the route loops over active faculty) so no
 * steward's address is exposed to another. Degrades cleanly with no API key.
 */
export async function sendParentDataCallNotice(args: {
  to: string;
  title: string;
  brief: string | null;
  budgetCents: number | null;
}): Promise<void> {
  const link = `${BASE_URL.replace(/\/$/, "")}`;
  const conn = await getResendClient();
  if (!conn) {
    logger.warn(
      { to: args.to, title: args.title },
      "Resend not configured — would send ParentData call notice",
    );
    return;
  }
  const brief = args.brief
    ? `<p style="color:#444;font-size:14px;background:#eef7f6;border-left:3px solid ${TEAL};padding:12px 14px;border-radius:0 8px 8px 0;white-space:pre-wrap;">${esc(args.brief)}</p>`
    : "";
  const budget =
    args.budgetCents != null && args.budgetCents > 0
      ? `<p style="color:#0a5c5b;font-size:14px;font-weight:600;margin:12px 0 0;">Budget: up to ${formatUsd(args.budgetCents)} per accepted piece.</p>`
      : "";
  const html = shell(`
  <p><strong>ParentData is looking for articles:</strong></p>
  <p style="font-size:18px;font-weight:600;margin:14px 0 4px;">${esc(args.title)}</p>
  ${brief}
  ${budget}
  <p style="margin:24px 0 0;color:#666;font-size:13px;">Pitch a piece from your Palonur faculty portal — <a href="${link}" style="color:${TEAL};">open it here</a>.</p>`);
  const { error } = await sendGuarded(
    conn.client,
    {
      from: FROM_ADDRESS,
      to: args.to,
      subject: `ParentData call for articles: ${args.title}`,
      text: `ParentData is looking for articles: "${args.title}".${
        args.brief ? `\n\n${args.brief}` : ""
      }${
        args.budgetCents != null && args.budgetCents > 0
          ? `\n\nBudget: up to ${formatUsd(args.budgetCents)} per accepted piece.`
          : ""
      }\n\nPitch from your faculty portal: ${link}`,
      html,
    },
    { label: "parentdata call notice" },
  );
  if (error) {
    logger.error(
      { err: error, to: args.to },
      "Failed to send ParentData call notice",
    );
  }
}

/** Notify the other party that a new message was posted on a proposal. */
export async function sendParentDataMessageNotice(args: {
  to: string | string[];
  fromName: string;
  title: string;
  body: string;
  /** Where the recipient reads/replies: the dashboard or the faculty portal. */
  audience: "reviewer" | "faculty";
}): Promise<void> {
  const conn = await getResendClient();
  if (!conn) {
    logger.warn(
      { to: args.to, title: args.title },
      "Resend not configured — would send ParentData message notice",
    );
    return;
  }
  const link =
    args.audience === "reviewer"
      ? `${BASE_URL}/parentdata`
      : `${BASE_URL.replace(/\/$/, "")}`;
  const preview = args.body.slice(0, 280);
  const html = shell(`
  <p><strong>${esc(args.fromName)}</strong> sent a message about the proposal:</p>
  <p style="font-size:16px;font-weight:600;margin:12px 0 4px;">${esc(args.title)}</p>
  <p style="color:#444;font-size:14px;background:#eef7f6;border-left:3px solid ${TEAL};padding:12px 14px;border-radius:0 8px 8px 0;white-space:pre-wrap;">${esc(preview)}${args.body.length > 280 ? "…" : ""}</p>
  ${
    args.audience === "reviewer"
      ? `<p style="margin:28px 0;"><a href="${link}" style="background:${TEAL};color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block;">Open the conversation</a></p>`
      : `<p style="color:#666;font-size:13px;">Reply from your Palonur faculty portal.</p>`
  }`);
  const { error } = await sendGuarded(
    conn.client,
    {
      from: FROM_ADDRESS,
      to: args.to,
      subject: `New message about: ${args.title}`,
      text: `${args.fromName} sent a message about "${args.title}":\n\n${preview}${args.body.length > 280 ? "…" : ""}`,
      html,
    },
    { label: "parentdata message notice" },
  );
  if (error) {
    logger.error(
      { err: error, to: args.to },
      "Failed to send ParentData message notice",
    );
  }
}
