/**
 * "Save this answer" email for the consumer agent surfaces.
 *
 * Sends the visitor the answer they just received — rendered SERVER-SIDE from
 * the persisted `agent_queries` row, never from client-supplied text (that
 * would turn the endpoint into an arbitrary-content email relay) — plus its
 * sources and a magic link to come back signed in.
 */
import { logger } from "./logger.js";
import { sendGuarded } from "./emailGuard.js";
import { getResendClient } from "./resendClient.js";

const BASE_URL = process.env.PUBLIC_URL ?? "https://palonur.replit.app";

export interface AnswerEmailSource {
  title: string;
  authors: string | null;
  year: number | null;
  journal: string | null;
  sourceUrl: string | null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Known labeled sections the agents emit, bolded as headings in the email. */
const SECTION_LABELS = [
  "ANSWER",
  "CITATION",
  "PAPER",
  "FINDING",
  "INTERPRETATION",
  "ACTION",
  "INSIGHT",
];

/**
 * Render the raw streamed answer text into simple email HTML: escape
 * everything, bold the known section labels, preserve line breaks.
 */
function renderAnswerHtml(answerText: string): string {
  const escaped = escapeHtml(answerText.trim());
  const labeled = escaped.replace(
    new RegExp(`^(${SECTION_LABELS.join("|")}):`, "gm"),
    (_m, label: string) =>
      `<strong style="display:block;margin-top:14px;color:#333;font-size:12px;letter-spacing:0.06em;">${label}</strong>`,
  );
  return labeled.replace(/\n/g, "<br/>");
}

function renderSourcesHtml(sources: AnswerEmailSource[]): string {
  if (sources.length === 0) return "";
  const items = sources
    .map((s) => {
      const meta = [s.authors, s.journal, s.year ? String(s.year) : null]
        .filter(Boolean)
        .map((x) => escapeHtml(String(x)))
        .join(" · ");
      const title = escapeHtml(s.title);
      const titleHtml =
        s.sourceUrl && /^https?:\/\//.test(s.sourceUrl)
          ? `<a href="${escapeHtml(s.sourceUrl)}" style="color:#8B1A1A;">${title}</a>`
          : title;
      return `<li style="margin-bottom:8px;">${titleHtml}${meta ? `<br/><span style="color:#666;font-size:13px;">${meta}</span>` : ""}</li>`;
    })
    .join("");
  return `<h3 style="margin:28px 0 8px;font-size:14px;color:#333;">Your sources</h3><ul style="padding-left:20px;margin:0;">${items}</ul>`;
}

/**
 * Email the saved answer + sources + a sign-in magic link. Returns true when
 * the send was handed to Resend without error (false = not configured or
 * failed; callers may surface a soft warning but must not 500).
 */
export async function sendAnswerEmail(args: {
  to: string;
  question: string;
  answerText: string;
  sources: AnswerEmailSource[];
  /** Consumer magic-link token minted for this save. */
  loginToken: string;
  /** Same-origin path to return to after sign-in (e.g. "/sleep?claimed=1"). */
  next: string;
}): Promise<boolean> {
  const link = `${BASE_URL}/account?login=${encodeURIComponent(args.loginToken)}&next=${encodeURIComponent(args.next)}`;
  const conn = await getResendClient();
  if (!conn) {
    logger.warn(
      { to: args.to },
      "Resend not configured — would send saved-answer email",
    );
    return false;
  }
  const from =
    process.env.CONSUMER_FROM ??
    (conn.fromEmail.includes("<")
      ? conn.fromEmail
      : `Palonur <${conn.fromEmail}>`);
  const question = escapeHtml(args.question.trim());
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;max-width:560px;margin:0 auto;padding:24px;">
  <p style="color:#666;font-size:13px;margin-bottom:4px;">You asked:</p>
  <p style="font-size:16px;font-weight:600;margin-top:0;">${question}</p>
  <div style="background:#FBF7F0;border:1px solid #E8DDD0;border-radius:8px;padding:18px 20px;font-size:15px;line-height:1.55;">${renderAnswerHtml(args.answerText)}</div>
  ${renderSourcesHtml(args.sources)}
  <p style="margin:28px 0 8px;">Pick up where you left off — this link signs you in:</p>
  <p style="margin:0 0 24px;"><a href="${link}" style="background:#8B1A1A;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block;">Continue on Palonur</a></p>
  <p style="color:#666;font-size:13px;">The link expires in 7 days. If you didn't request this, you can ignore this email.</p>
  <p style="color:#999;font-size:12px;margin-top:32px;">— Palonur · Stanford Lifestyle Medicine</p>
  </body></html>`;
  const sourceLines = args.sources
    .map((s) => {
      const meta = [s.authors, s.journal, s.year ? String(s.year) : null]
        .filter(Boolean)
        .join(" · ");
      return `- ${s.title}${meta ? ` (${meta})` : ""}${s.sourceUrl ? ` ${s.sourceUrl}` : ""}`;
    })
    .join("\n");
  const text = `You asked: ${args.question.trim()}\n\n${args.answerText.trim()}\n${sourceLines ? `\nYour sources:\n${sourceLines}\n` : ""}\nContinue on Palonur (signs you in, expires in 7 days): ${link}\n`;
  const { error } = await sendGuarded(
    conn.client,
    {
      from,
      to: args.to,
      subject: "Your answer from Palonur",
      text,
      html,
    },
    { label: "saved answer" },
  );
  if (error) {
    logger.error({ err: error, to: args.to }, "Failed to send saved-answer email");
    return false;
  }
  return true;
}
