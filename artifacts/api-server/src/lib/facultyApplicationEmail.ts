import { getResendClient } from "./resendClient";
import { logger } from "./logger";
import { sendGuarded } from "./emailGuard";

// Warm, plain-language emails for the self-serve faculty application funnel.
// Same sender identity as faculty invitations. No em dashes in copy.

const FROM_ADDRESS =
  process.env.FACULTY_INVITE_FROM ?? "Palonur, Palo Alto <noreply@palonur.com>";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function send(
  to: string,
  subject: string,
  text: string,
  html: string,
  label: string,
): Promise<void> {
  const conn = await getResendClient();
  if (!conn) {
    logger.warn({ to }, `Resend not configured, skipping ${label} email`);
    return;
  }
  const { error } = await sendGuarded(
    conn.client,
    { from: FROM_ADDRESS, to, subject, text, html },
    { label },
  );
  if (error) {
    logger.error({ err: error, to }, `Failed to send ${label} email`);
  }
}

const shell = (body: string): string => `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color:#111; max-width:560px; margin:0 auto; padding:24px;">
${body}
<p style="color:#999; font-size:12px; margin-top:32px;">Palonur, Palo Alto</p>
</body></html>`;

/** Sent to the institutional address the applicant claims. Clicking proves ownership. */
export async function sendApplicationVerificationEmail(args: {
  to: string;
  applicantName: string | null;
  verifyUrl: string;
}): Promise<void> {
  const name = args.applicantName?.trim() || "there";
  const subject = "Confirm your institutional email for Palonur";
  const text = `Hello ${name},

You listed this address as your institutional email in your Palonur faculty application. Please confirm it by opening this link:

${args.verifyUrl}

The link expires in 7 days. If you did not apply, you can safely ignore this email.

Palonur, Palo Alto`;
  const html = shell(`
  <p>Hello ${escapeHtml(name)},</p>
  <p>You listed this address as your institutional email in your Palonur faculty application. Please confirm it so we can review your application.</p>
  <p style="margin: 28px 0;">
    <a href="${args.verifyUrl}" style="background:#8C1515; color:#fff; text-decoration:none; padding:12px 20px; border-radius:6px; display:inline-block;">Confirm this email</a>
  </p>
  <p style="color:#666; font-size:13px;">The link expires in 7 days. If you did not apply, you can safely ignore this email.</p>`);
  await send(args.to, subject, text, html, "faculty application verification");
}

/** Warm admission email with a link back to the portal. */
export async function sendApplicationAdmittedEmail(args: {
  to: string;
  applicantName: string | null;
  pillarName: string;
  role: string;
  portalUrl: string;
}): Promise<void> {
  const name = args.applicantName?.trim() || "there";
  const subject = `Welcome to Palonur: you have been admitted to the ${args.pillarName} pillar`;
  const text = `Hello ${name},

Good news. Palonur has reviewed your application and admitted you to the ${args.pillarName} pillar as a ${args.role}.

Sign in to see the questions people are already asking in your field:
${args.portalUrl}

We are glad to have you.

Palonur, Palo Alto`;
  const html = shell(`
  <p>Hello ${escapeHtml(name)},</p>
  <p>Good news. Palonur has reviewed your application and admitted you to the <strong>${escapeHtml(args.pillarName)}</strong> pillar as <strong>${escapeHtml(args.role)}</strong>.</p>
  <p style="margin: 28px 0;">
    <a href="${args.portalUrl}" style="background:#8C1515; color:#fff; text-decoration:none; padding:12px 20px; border-radius:6px; display:inline-block;">Open your portal</a>
  </p>
  <p>Sign in to see the questions people are already asking in your field. We are glad to have you.</p>`);
  await send(args.to, subject, text, html, "faculty application admitted");
}

/**
 * One-per-application nudge to all platform admins when a new application
 * arrives. Guarded by sendGuarded so it respects daily quota rails.
 */
export async function sendNewApplicationAdminEmail(args: {
  adminEmails: string[];
  applicantName: string | null;
  applicantEmail: string;
  institution: string;
  field: string;
  reviewUrl: string;
}): Promise<void> {
  if (args.adminEmails.length === 0) return;
  const name = args.applicantName?.trim() || "Someone";
  const subject = "New Palonur faculty application waiting for review";
  const text = `Hello,

${name} (${args.applicantEmail}) has submitted a new faculty application.

Institution: ${args.institution}
Field: ${args.field}

Review it here:
${args.reviewUrl}

Palonur, Palo Alto`;
  const html = shell(`
  <p>Hello,</p>
  <p><strong>${escapeHtml(name)}</strong> (${escapeHtml(args.applicantEmail)}) has submitted a new faculty application.</p>
  <ul style="padding-left:20px; line-height:1.7;">
    <li><strong>Institution:</strong> ${escapeHtml(args.institution)}</li>
    <li><strong>Field:</strong> ${escapeHtml(args.field)}</li>
  </ul>
  <p style="margin: 28px 0;">
    <a href="${args.reviewUrl}" style="background:#8C1515; color:#fff; text-decoration:none; padding:12px 20px; border-radius:6px; display:inline-block;">Review application</a>
  </p>`);
  const conn = await getResendClient();
  if (!conn) {
    logger.warn({}, "Resend not configured, skipping admin application nudge");
    return;
  }
  for (const adminEmail of args.adminEmails) {
    const { error } = await sendGuarded(
      conn.client,
      { from: FROM_ADDRESS, to: adminEmail, subject, text, html },
      { label: "faculty application admin nudge" },
    );
    if (error) {
      logger.error(
        { err: error, to: adminEmail },
        "Failed to send admin application nudge",
      );
    }
  }
}

/** Honest, warm decline with the admin's optional note. */
export async function sendApplicationDeclinedEmail(args: {
  to: string;
  applicantName: string | null;
  note: string | null;
}): Promise<void> {
  const name = args.applicantName?.trim() || "there";
  const subject = "An update on your Palonur faculty application";
  const noteText = args.note?.trim()
    ? `\n\nA note from our team:\n${args.note.trim()}\n`
    : "";
  const text = `Hello ${name},

Thank you for applying to join Palonur's faculty. After review, we are not able to offer you a place right now.${noteText}
This is not a judgment of your work. Our pillars grow slowly and deliberately, and we revisit past applications as new pillars open.

Palonur, Palo Alto`;
  const noteHtml = args.note?.trim()
    ? `<p style="border-left:3px solid #E8DDD0; padding-left:12px; color:#444;">${escapeHtml(args.note.trim())}</p>`
    : "";
  const html = shell(`
  <p>Hello ${escapeHtml(name)},</p>
  <p>Thank you for applying to join Palonur's faculty. After review, we are not able to offer you a place right now.</p>
  ${noteHtml}
  <p>This is not a judgment of your work. Our pillars grow slowly and deliberately, and we revisit past applications as new pillars open.</p>`);
  await send(args.to, subject, text, html, "faculty application declined");
}
