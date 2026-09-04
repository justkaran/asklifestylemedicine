import { getResendClient } from "./resendClient";
import pool from "./db";
import { logger } from "./logger";
import { sendGuarded } from "./emailGuard";


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

interface Gap {
  question: string;
  size: number;
}
interface Topic {
  title: string;
  count: number;
}
interface Flag {
  question: string;
  reason: string | null;
}

async function buildPillarSection(
  pillarId: number,
  pillarSlug: string,
  pillarName: string,
): Promise<{
  gaps: Gap[];
  topics: Topic[];
  flags: Flag[];
  totalAsked: number;
} | null> {
  const totalAsked = (
    await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n
         FROM agent_queries
        WHERE $1 = ANY(pillar_ids)
          AND created_at >= NOW() - INTERVAL '7 days'`,
      [pillarId],
    )
  ).rows[0]?.n ?? 0;

  const gaps = (
    await pool.query<{ question: string; size: number }>(
      `SELECT representative_question AS question, size
         FROM query_clusters
        WHERE pillar_id = $1
          AND last_updated >= NOW() - INTERVAL '7 days'
        ORDER BY size DESC
        LIMIT 3`,
      [pillarId],
    )
  ).rows;

  const topics = (
    await pool.query<{ title: string; count: number }>(
      `SELECT s.title, COUNT(*)::int AS count
         FROM agent_queries q
         CROSS JOIN LATERAL UNNEST(q.retrieved_source_ids) AS sid
         JOIN sources s ON s.id = sid AND s.is_canary = FALSE
        WHERE $1 = ANY(q.pillar_ids)
          AND q.created_at >= NOW() - INTERVAL '7 days'
          AND q.was_uncovered = FALSE
        GROUP BY s.title
        ORDER BY count DESC
        LIMIT 5`,
      [pillarId],
    )
  ).rows;

  const flags = (
    await pool.query<{ question: string; reason: string | null }>(
      `SELECT question, flag_reason AS reason
         FROM agent_queries
        WHERE $1 = ANY(pillar_ids)
          AND user_flagged = TRUE
          AND created_at >= NOW() - INTERVAL '7 days'
        ORDER BY created_at DESC
        LIMIT 5`,
      [pillarId],
    )
  ).rows;

  if (totalAsked === 0 && gaps.length === 0 && flags.length === 0) return null;
  void pillarSlug;
  void pillarName;
  return { gaps, topics, flags, totalAsked };
}

function renderHtml(opts: {
  pillarName: string;
  pillarSlug: string;
  totalAsked: number;
  gaps: Gap[];
  topics: Topic[];
  flags: Flag[];
}): string {
  const root = baseUrl();
  const dashUrl = `${root}/faculty/pillars/${opts.pillarSlug}`;
  const gapsHtml = opts.gaps.length
    ? opts.gaps
        .map(
          (g) => `
          <li style="margin-bottom:10px;">
            <span style="color:#8C1515;font-weight:600;">${g.size}× </span>
            ${escapeHtml(g.question)}
          </li>`,
        )
        .join("")
    : `<li style="color:#999;">No coverage gaps this week — nice.</li>`;

  const topicsHtml = opts.topics.length
    ? opts.topics
        .map(
          (t) => `
          <li style="margin-bottom:6px;">
            ${escapeHtml(t.title)}
            <span style="color:#999;">· ${t.count} answer${t.count === 1 ? "" : "s"}</span>
          </li>`,
        )
        .join("")
    : `<li style="color:#999;">No answered questions yet.</li>`;

  const flagsHtml = opts.flags.length
    ? `<h3 style="font-family:Georgia,serif;margin-top:28px;margin-bottom:8px;">User-flagged answers</h3>
       <ul style="padding-left:18px;margin:0;">${opts.flags
         .map(
           (f) => `<li style="margin-bottom:8px;">
             ${escapeHtml(f.question)}
             ${f.reason ? `<div style="color:#999;font-size:12px;">${escapeHtml(f.reason)}</div>` : ""}
           </li>`,
         )
         .join("")}</ul>`
    : "";

  return `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;max-width:620px;margin:0 auto;padding:24px;">
  <p style="font-size:11px;letter-spacing:0.25em;color:#8C1515;text-transform:uppercase;margin:0 0 4px;">
    Palonur Faculty · Weekly coverage
  </p>
  <h2 style="font-family:Georgia,serif;font-weight:500;margin:0 0 16px;">
    ${escapeHtml(opts.pillarName)} — ${opts.totalAsked} question${opts.totalAsked === 1 ? "" : "s"} this week
  </h2>
  <p style="color:#444;line-height:1.5;">
    Here's what the public agent fielded for your pillar this week — and the
    three gaps most worth filling.
  </p>

  <h3 style="font-family:Georgia,serif;margin-top:28px;margin-bottom:8px;">Top coverage gaps</h3>
  <ul style="padding-left:18px;margin:0;">${gapsHtml}</ul>

  <h3 style="font-family:Georgia,serif;margin-top:28px;margin-bottom:8px;">Top topics asked</h3>
  <ul style="padding-left:18px;margin:0;">${topicsHtml}</ul>

  ${flagsHtml}

  <p style="margin-top:32px;">
    <a href="${dashUrl}" style="display:inline-block;background:#8C1515;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;">
      Open ${escapeHtml(opts.pillarName)} dashboard →
    </a>
  </p>
</body></html>`;
}

export async function runWeeklyCoverageDigest(): Promise<void> {
  const conn = await getResendClient();
  if (!conn) {
    logger.warn("Resend not configured — skipping coverage digest");
    return;
  }

  const pillars = await pool.query<{
    id: number;
    slug: string;
    name: string;
  }>(`SELECT id, slug, name FROM pillars`);

  for (const p of pillars.rows) {
    try {
      const summary = await buildPillarSection(p.id, p.slug, p.name);
      if (!summary) continue;

      const stewards = await pool.query<{ email: string }>(
        `SELECT u.email
           FROM faculty_memberships m
           JOIN faculty_users u ON u.id = m.user_id
          WHERE m.pillar_id = $1
            AND m.role = 'steward'`,
        [p.id],
      );
      if (stewards.rows.length === 0) continue;

      const html = renderHtml({
        pillarName: p.name,
        pillarSlug: p.slug,
        totalAsked: summary.totalAsked,
        gaps: summary.gaps,
        topics: summary.topics,
        flags: summary.flags,
      });

      for (const s of stewards.rows) {
        const { error } = await sendGuarded(
          conn.client,
          {
            from: FROM_ADDRESS,
            to: s.email,
            subject: `${p.name}: ${summary.totalAsked} question${summary.totalAsked === 1 ? "" : "s"} this week, ${summary.gaps.length} gap${summary.gaps.length === 1 ? "" : "s"} to fill`,
            html,
          },
          { label: "coverage digest" },
        );
        if (error) {
          logger.error({ err: error, to: s.email }, "coverage digest send failed");
        }
      }
    } catch (e) {
      logger.error({ err: e, pillarId: p.id }, "coverage digest pillar failed");
    }
  }
}
