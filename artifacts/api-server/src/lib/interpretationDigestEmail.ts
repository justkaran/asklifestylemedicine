import { getResendClient } from "./resendClient";
import { logger } from "./logger";
import { sendGuarded } from "./emailGuard";
import {
  collectStewardDigests,
  type StewardDigest,
} from "../routes/interpretations.js";


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

function baseUrl(): string {
  return (
    process.env.PUBLIC_APP_URL ??
    (process.env.REPLIT_DOMAINS?.split(",")[0]
      ? `https://${process.env.REPLIT_DOMAINS.split(",")[0]}`
      : "http://localhost")
  );
}

function formatAge(d: Date): string {
  const hrs = Math.floor((Date.now() - d.getTime()) / 36e5);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function renderDigestHtml(digest: StewardDigest): string {
  const root = baseUrl();
  const sections = digest.pillars
    .map((p) => {
      const items = p.pending
        .map(
          (x) => `
          <li style="margin-bottom: 14px;">
            <a href="${root}/faculty/pillars/${p.slug}/sources/${x.sourceId}"
               style="color:#8C1515; text-decoration:none; font-weight:500;">
              ${escapeHtml(x.answer.slice(0, 200))}${x.answer.length > 200 ? "…" : ""}
            </a>
            <div style="color:#666; font-size:12px; margin-top:2px;">
              ${escapeHtml(x.sourceTitle)} · proposed by
              ${escapeHtml(x.authorName ?? x.authorEmail ?? "unknown")}
              · waiting ${formatAge(new Date(x.createdAt))}
            </div>
          </li>`,
        )
        .join("");
      return `
        <h3 style="font-family: Georgia, serif; margin-top: 28px; margin-bottom: 8px;">
          ${escapeHtml(p.name)}
          <span style="color:#999; font-weight:400; font-size:14px;">
            (${p.pending.length} pending)
          </span>
        </h3>
        <ul style="padding-left: 18px; margin: 0;">${items}</ul>
        <p style="margin-top:8px;">
          <a href="${root}/faculty/pillars/${p.slug}/inbox"
             style="color:#8C1515; font-size:13px;">
            Open ${escapeHtml(p.name)} review queue →
          </a>
        </p>`;
    })
    .join("");

  return `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color:#111; max-width:620px; margin:0 auto; padding:24px;">
  <p style="font-size:11px; letter-spacing:0.25em; color:#8C1515; text-transform:uppercase; margin:0 0 4px;">
    Palonur Faculty · Daily review
  </p>
  <h2 style="font-family: Georgia, serif; font-weight: 500; margin: 0 0 16px;">
    Hi ${escapeHtml(digest.user.fullName ?? "Steward")}, you have items waiting on you.
  </h2>
  <p style="color:#444;">
    Faculty interpretations need your review. The longest-waiting items are listed first.
  </p>
  ${sections}
  <p style="color:#999; font-size:12px; margin-top:36px;">— Palonur</p>
</body></html>`;
}

function renderDigestText(digest: StewardDigest): string {
  const root = baseUrl();
  const lines: string[] = [
    `Hi ${digest.user.fullName ?? "Steward"},`,
    ``,
    `Faculty interpretations are waiting on your review.`,
    ``,
  ];
  for (const p of digest.pillars) {
    lines.push(`# ${p.name} (${p.pending.length} pending)`);
    for (const x of p.pending) {
      lines.push(`  • ${x.answer.slice(0, 180)}`);
      lines.push(
        `    ${x.sourceTitle} — by ${x.authorName ?? x.authorEmail ?? "unknown"} — waiting ${formatAge(new Date(x.createdAt))}`,
      );
      lines.push(
        `    ${root}/faculty/pillars/${p.slug}/sources/${x.sourceId}`,
      );
    }
    lines.push(``);
    lines.push(`  Inbox: ${root}/faculty/pillars/${p.slug}/inbox`);
    lines.push(``);
  }
  lines.push(`— Palonur`);
  return lines.join("\n");
}

/**
 * Sends a daily review-queue digest to every steward with at least one
 * pending interpretation. Stewards with empty queues are skipped (per
 * spec: "skip if zero").
 */
export async function runStewardReviewDigest(): Promise<number> {
  const digests = await collectStewardDigests();
  if (digests.length === 0) return 0;
  const conn = await getResendClient();
  if (!conn) {
    logger.warn(
      { count: digests.length },
      "Resend not configured — skipping steward digest",
    );
    return 0;
  }
  let sent = 0;
  for (const d of digests) {
    if (d.pillars.length === 0) continue;
    const totalPending = d.pillars.reduce(
      (n, p) => n + p.pending.length,
      0,
    );
    const { error } = await sendGuarded(
      conn.client,
      {
        from: FROM_ADDRESS,
        to: d.user.email,
        subject: `${totalPending} faculty interpretation${totalPending === 1 ? "" : "s"} awaiting your review`,
        html: renderDigestHtml(d),
        text: renderDigestText(d),
      },
      { label: "steward review digest" },
    );
    if (error) {
      logger.error(
        { err: error, to: d.user.email },
        "Failed to send steward digest email",
      );
      continue;
    }
    sent++;
  }
  logger.info({ sent }, "Steward review digest run complete");
  return sent;
}
