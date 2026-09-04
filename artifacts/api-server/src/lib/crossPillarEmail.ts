import { getResendClient } from "./resendClient";
import { logger } from "./logger";
import { sendGuarded } from "./emailGuard";


const FROM_ADDRESS =
  process.env.FACULTY_INVITE_FROM ?? "Palonur, Palo Alto <noreply@palonur.com>";

const PUBLIC_URL = process.env.PUBLIC_URL ?? "https://palonur.replit.app";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface CrossPillarCommentEmailArgs {
  to: string;
  ownerName: string | null;
  commenterName: string | null;
  commenterPillarName: string | null;
  interpretationAnswer: string;
  commentBody: string;
}

/**
 * Notify the owning pillar's steward that a steward from another pillar
 * started a discussion on one of their APPROVED interpretations.
 */
export async function sendCrossPillarCommentEmail(
  args: CrossPillarCommentEmailArgs,
): Promise<void> {
  const conn = await getResendClient();
  if (!conn) {
    logger.warn(
      { to: args.to },
      "Resend not configured — skipping cross-pillar comment email",
    );
    return;
  }
  const {
    to,
    ownerName,
    commenterName,
    commenterPillarName,
    interpretationAnswer,
    commentBody,
  } = args;
  const owner = ownerName ?? "there";
  const commenter = commenterName ?? "A Palonur steward";
  const fromPillar = commenterPillarName ? ` (${commenterPillarName})` : "";
  const subject = `${commenter} commented on your interpretation`;
  const text = `Hi ${owner},

${commenter}${fromPillar} left a comment on your approved interpretation:

"${interpretationAnswer}"

Their comment:
${commentBody}

Open your portal to reply:
${PUBLIC_URL}/

— Palonur`;
  const html = `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color:#111; max-width:560px; margin:0 auto; padding:24px;">
  <p>Hi ${escapeHtml(owner)},</p>
  <p><strong>${escapeHtml(commenter)}</strong>${escapeHtml(fromPillar)} left a comment on your approved interpretation:</p>
  <blockquote style="border-left:3px solid #E8DDD0; margin:16px 0; padding:4px 0 4px 14px; color:#572020;">${escapeHtml(interpretationAnswer)}</blockquote>
  <p style="background:#FBF7F0; border:1px solid #E8DDD0; border-radius:8px; padding:12px 14px; color:#333;">${escapeHtml(commentBody)}</p>
  <p style="margin:24px 0;"><a href="${PUBLIC_URL}/" style="background:#8C1515; color:#fff; text-decoration:none; padding:11px 18px; border-radius:6px; display:inline-block;">Open your portal</a></p>
  <p style="color:#999; font-size:12px; margin-top:28px;">— Palonur</p>
</body></html>`;
  const { error } = await sendGuarded(
    conn.client,
    { from: FROM_ADDRESS, to, subject, text, html },
    { label: "cross-pillar comment" },
  );
  if (error) {
    logger.error({ err: error, to }, "Failed to send cross-pillar comment email");
  }
}

export interface CrossPillarMergeRequestEmailArgs {
  to: string;
  ownerName: string | null;
  requesterName: string | null;
  sourcePillarName: string | null;
  targetPillarName: string;
  interpretationAnswer: string;
  note: string | null;
}

/**
 * Notify the owning (target) pillar's steward that another steward
 * proposed bringing one of their interpretations into the owner's pillar.
 */
export async function sendCrossPillarMergeRequestEmail(
  args: CrossPillarMergeRequestEmailArgs,
): Promise<void> {
  const conn = await getResendClient();
  if (!conn) {
    logger.warn(
      { to: args.to },
      "Resend not configured — skipping cross-pillar merge-request email",
    );
    return;
  }
  const {
    to,
    ownerName,
    requesterName,
    sourcePillarName,
    targetPillarName,
    interpretationAnswer,
    note,
  } = args;
  const owner = ownerName ?? "there";
  const requester = requesterName ?? "A Palonur steward";
  void sourcePillarName;
  const subject = `${requester} wants to adopt your interpretation`;
  const text = `Hi ${owner},

${requester}, a steward of the ${targetPillarName} pillar, would like to adopt your approved interpretation into ${targetPillarName} — with full credit to you and your pillar:

"${interpretationAnswer}"
${note ? `\nTheir note:\n${note}\n` : ""}
Review the request (approve or decline) in your portal:
${PUBLIC_URL}/

— Palonur`;
  const html = `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color:#111; max-width:560px; margin:0 auto; padding:24px;">
  <p>Hi ${escapeHtml(owner)},</p>
  <p><strong>${escapeHtml(requester)}</strong>, a steward of the <strong>${escapeHtml(targetPillarName)}</strong> pillar, would like to adopt your approved interpretation into ${escapeHtml(targetPillarName)} — with full credit to you and your pillar:</p>
  <blockquote style="border-left:3px solid #E8DDD0; margin:16px 0; padding:4px 0 4px 14px; color:#572020;">${escapeHtml(interpretationAnswer)}</blockquote>
  ${note ? `<p style="background:#FBF7F0; border:1px solid #E8DDD0; border-radius:8px; padding:12px 14px; color:#333;">${escapeHtml(note)}</p>` : ""}
  <p style="margin:24px 0;"><a href="${PUBLIC_URL}/" style="background:#8C1515; color:#fff; text-decoration:none; padding:11px 18px; border-radius:6px; display:inline-block;">Review request</a></p>
  <p style="color:#999; font-size:12px; margin-top:28px;">— Palonur</p>
</body></html>`;
  const { error } = await sendGuarded(
    conn.client,
    { from: FROM_ADDRESS, to, subject, text, html },
    { label: "cross-pillar merge request" },
  );
  if (error) {
    logger.error(
      { err: error, to },
      "Failed to send cross-pillar merge-request email",
    );
  }
}

export interface CrossPillarMergeOutcomeEmailArgs {
  to: string;
  requesterName: string | null;
  reviewerName: string | null;
  sourcePillarName: string | null;
  targetPillarName: string | null;
  interpretationAnswer: string;
  outcome: "approved" | "declined";
  declineReason: string | null;
}

/**
 * Notify the REQUESTER (the steward who proposed adopting another pillar's
 * interpretation) that the owning steward approved or declined the request.
 */
export async function sendCrossPillarMergeOutcomeEmail(
  args: CrossPillarMergeOutcomeEmailArgs,
): Promise<void> {
  const conn = await getResendClient();
  if (!conn) {
    logger.warn(
      { to: args.to },
      "Resend not configured — skipping cross-pillar merge-outcome email",
    );
    return;
  }
  const {
    to,
    requesterName,
    reviewerName,
    sourcePillarName,
    targetPillarName,
    interpretationAnswer,
    outcome,
    declineReason,
  } = args;
  const requester = requesterName ?? "there";
  const reviewer = reviewerName ?? "The owning steward";
  const fromPillar = sourcePillarName ? ` (${sourcePillarName})` : "";
  const target = targetPillarName ?? "your pillar";

  const subject =
    outcome === "approved"
      ? "Your adoption request was approved"
      : "Your adoption request was declined";

  const text =
    outcome === "approved"
      ? `Hi ${requester},

${reviewer}${fromPillar} approved your request to adopt their interpretation into ${target}. It's now part of ${target}, with full credit to the original steward and pillar:

"${interpretationAnswer}"

Open your portal:
${PUBLIC_URL}/

— Palonur`
      : `Hi ${requester},

${reviewer}${fromPillar} declined your request to adopt their interpretation into ${target}:

"${interpretationAnswer}"
${declineReason ? `\nTheir reason:\n${declineReason}\n` : ""}
Open your portal:
${PUBLIC_URL}/

— Palonur`;

  const intro =
    outcome === "approved"
      ? `<strong>${escapeHtml(reviewer)}</strong>${escapeHtml(fromPillar)} approved your request to adopt their interpretation into <strong>${escapeHtml(target)}</strong>. It's now part of ${escapeHtml(target)}, with full credit to the original steward and pillar:`
      : `<strong>${escapeHtml(reviewer)}</strong>${escapeHtml(fromPillar)} declined your request to adopt their interpretation into <strong>${escapeHtml(target)}</strong>:`;

  const html = `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color:#111; max-width:560px; margin:0 auto; padding:24px;">
  <p>Hi ${escapeHtml(requester)},</p>
  <p>${intro}</p>
  <blockquote style="border-left:3px solid #E8DDD0; margin:16px 0; padding:4px 0 4px 14px; color:#572020;">${escapeHtml(interpretationAnswer)}</blockquote>
  ${outcome === "declined" && declineReason ? `<p style="background:#FBF7F0; border:1px solid #E8DDD0; border-radius:8px; padding:12px 14px; color:#333;">${escapeHtml(declineReason)}</p>` : ""}
  <p style="margin:24px 0;"><a href="${PUBLIC_URL}/" style="background:#8C1515; color:#fff; text-decoration:none; padding:11px 18px; border-radius:6px; display:inline-block;">Open your portal</a></p>
  <p style="color:#999; font-size:12px; margin-top:28px;">— Palonur</p>
</body></html>`;
  const { error } = await sendGuarded(
    conn.client,
    { from: FROM_ADDRESS, to, subject, text, html },
    { label: "cross-pillar merge outcome" },
  );
  if (error) {
    logger.error(
      { err: error, to },
      "Failed to send cross-pillar merge-outcome email",
    );
  }
}
