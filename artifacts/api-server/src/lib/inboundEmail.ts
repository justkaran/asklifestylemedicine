import { htmlToText } from "./newsletterEmail.js";

/**
 * Pure helpers for turning a raw inbound email reply into a clean question and
 * for deciding whether an inbound message should be answered at all.
 *
 * These are deliberately dependency-light (no DB, no network) so they are
 * trivially unit-testable: the email Q&A loop's "strip quoted history" behavior
 * is the most fragile part of the feature.
 */

const MAX_QUESTION_LEN = 2000;

/**
 * Strip quoted reply history + the sender's signature out of an inbound email
 * body, returning just the new text the reader typed.
 *
 * Handles the common reply formats: Gmail's "On <date>, X wrote:", Outlook's
 * "-----Original Message-----" / "From: ..." header block and the long divider
 * line, `>`-quoted lines, mobile "Sent from my iPhone" footers, and the
 * standard `\n-- \n` signature delimiter. Prefers the plain-text part; falls
 * back to converting the HTML part when no text is present.
 */
export function cleanInboundQuestion(input: {
  text?: string | null;
  html?: string | null;
}): string {
  const text = (input.text ?? "").trim();
  let body = text || (input.html ? htmlToText(input.html) : "");
  body = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Cut everything at the first quoted-history marker. The "On ... wrote:"
  // intro can wrap across lines, so that pattern allows interior newlines.
  const markers: RegExp[] = [
    /\n?On [\s\S]{0,200}?\bwrote:/, // Gmail / Apple Mail attribution line
    /\n-----\s*Original Message\s*-----/i,
    /\n_{10,}/, // Outlook divider line
    /\n>?\s*From:.*\n(>?\s*(Sent|Date|To|Subject):.*\n)+/i, // Outlook header block
    /\nSent from my /i,
    /\nGet Outlook for /i,
    /\nBegin forwarded message:/i,
  ];
  let cut = body.length;
  for (const re of markers) {
    const m = body.match(re);
    if (m && m.index !== undefined && m.index < cut) cut = m.index;
  }
  body = body.slice(0, cut);

  // Drop any remaining `>`-quoted lines.
  body = body
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");

  // Strip a trailing signature introduced by the standard "-- " delimiter.
  const sig = body.search(/\n-- *\n/);
  if (sig !== -1) body = body.slice(0, sig);

  body = body.replace(/\n{3,}/g, "\n\n").trim();
  return body.slice(0, MAX_QUESTION_LEN).trim();
}

/**
 * Parse a bare email address out of an RFC "Display Name <addr@host>" string.
 * Returns the lowercased address, or null when it doesn't look like an email.
 */
export function parseFromEmail(from?: string | null): string | null {
  if (!from) return null;
  const angle = from.match(/<([^>]+)>/);
  const raw = (angle ? angle[1] : from).trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw) ? raw : null;
}

/**
 * Decide whether an inbound message is an automated message we must NOT answer:
 * out-of-office / vacation autoresponders, bounce + delivery-failure
 * notifications, complaints, and no-reply / mailer-daemon senders. Uses the
 * subject, the From address and any AgentMail labels.
 *
 * Erring toward skipping is correct: answering a bounce or an autoresponder
 * would burn quota and could create a mail loop.
 */
export function isAutoReply(input: {
  subject?: string | null;
  from?: string | null;
  labels?: string[] | null;
}): boolean {
  const subject = (input.subject ?? "").toLowerCase();
  if (
    /\b(auto[\s-]?reply|automatic reply|out[\s-]?of[\s-]?office|on vacation|away from (the )?office|autoresponder|delivery (status|failure)|undeliverable|undelivered|mail delivery|returned mail|failure notice|delivery notification)\b/.test(
      subject,
    )
  ) {
    return true;
  }

  const from = (input.from ?? "").toLowerCase();
  if (
    /(^|<|[\s,;])(no[\s-]?reply|do[\s-]?not[\s-]?reply|mailer-daemon|postmaster|bounce[s]?)[@\s]/.test(
      from,
    )
  ) {
    return true;
  }

  const labels = input.labels ?? [];
  if (
    labels.some((l) => /bounce|spam|complain|reject|blocked|unauthenticated/i.test(l))
  ) {
    return true;
  }

  return false;
}
