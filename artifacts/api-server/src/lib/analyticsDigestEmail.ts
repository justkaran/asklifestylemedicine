import pool from "./db";
import { logger } from "./logger";
import { getResendClient } from "./resendClient";
import { sendGuarded } from "./emailGuard";

/**
 * Daily traffic digest email. Mirrors the other job email helpers
 * (coverageDigestEmail / interpretationDigestEmail): module-level Resend
 * client, graceful degrade to a warn when Resend isn't configured, sendGuarded
 * for quota/safety rails.
 *
 * Reports on `palonur_pageviews` — the same table the /admin Traffic tab reads.
 * "Users" here means unique VISITORS approximated by distinct IP, since almost
 * no visitor signs in (the honest caveat is stated in the email footer). Windows
 * are Pacific calendar days so "yesterday" matches the admin dashboard's daily
 * grouping.
 *
 * Recipients: ANALYTICS_DIGEST_TO (comma-separated), default karan@palonur.com.
 */

const FROM_ADDRESS =
  process.env.ANALYTICS_DIGEST_FROM ??
  "Palonur Analytics <noreply@palonur.com>";

const RECIPIENTS = (process.env.ANALYTICS_DIGEST_TO ?? "karan@palonur.com")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const TZ = "America/Los_Angeles";

interface WindowStats {
  visitors: number;
  sessions: number;
  pageviews: number;
  /** MEDIAN seconds on page — median, not mean, because left-open browser
   * tabs inflate the average into hours (all-time mean was ~100min). */
  median_sec: number | null;
}

/**
 * Traffic over a Pacific-calendar-day window [today - startDaysAgo, today -
 * endDaysAgo). endDaysAgo = 0 means "up to the start of today", i.e. through the
 * end of yesterday.
 */
async function windowStats(
  startDaysAgo: number,
  endDaysAgo: number,
): Promise<WindowStats> {
  const r = await pool.query(
    `WITH b AS (
       SELECT date_trunc('day', now() AT TIME ZONE $3) AS d
     )
     SELECT
       count(DISTINCT ip)::int         AS visitors,
       count(DISTINCT session_id)::int AS sessions,
       count(*)::int                   AS pageviews,
       ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms))::numeric / 1000.0, 1) AS median_sec
     FROM palonur_pageviews p, b
     WHERE p.is_bot = FALSE
       AND (p.created_at AT TIME ZONE $3) >= b.d - ($1 || ' days')::interval
       AND (p.created_at AT TIME ZONE $3) <  b.d - ($2 || ' days')::interval`,
    [startDaysAgo, endDaysAgo, TZ],
  );
  const row = r.rows[0] ?? {};
  return {
    visitors: row.visitors ?? 0,
    sessions: row.sessions ?? 0,
    pageviews: row.pageviews ?? 0,
    median_sec: row.median_sec != null ? Number(row.median_sec) : null,
  };
}

interface AllTime extends WindowStats {
  since: string | null;
}

async function allTimeStats(): Promise<AllTime> {
  const r = await pool.query(
    `SELECT
       count(DISTINCT ip)::int         AS visitors,
       count(DISTINCT session_id)::int AS sessions,
       count(*)::int                   AS pageviews,
       ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms))::numeric / 1000.0, 1) AS median_sec,
       MIN(created_at)::date            AS since
     FROM palonur_pageviews
     WHERE is_bot = FALSE`,
  );
  const row = r.rows[0] ?? {};
  return {
    visitors: row.visitors ?? 0,
    sessions: row.sessions ?? 0,
    pageviews: row.pageviews ?? 0,
    median_sec: row.median_sec != null ? Number(row.median_sec) : null,
    since: row.since ? new Date(row.since).toISOString().slice(0, 10) : null,
  };
}

async function topCountries(
  days: number,
): Promise<Array<{ country: string; sessions: number }>> {
  const r = await pool.query(
    `SELECT COALESCE(NULLIF(country, ''), 'Unknown') AS country,
            count(DISTINCT session_id)::int AS sessions
     FROM palonur_pageviews
     WHERE is_bot = FALSE
       AND created_at >= now() - ($1 || ' days')::interval
     GROUP BY 1 ORDER BY sessions DESC, country ASC LIMIT 8`,
    [days],
  );
  return r.rows.map((x) => ({ country: x.country, sessions: x.sessions }));
}

async function topCities(
  days: number,
): Promise<Array<{ label: string; sessions: number }>> {
  const r = await pool.query(
    `SELECT COALESCE(NULLIF(city, ''), 'Unknown') AS city,
            COALESCE(NULLIF(country, ''), '') AS country,
            count(DISTINCT session_id)::int AS sessions
     FROM palonur_pageviews
     WHERE is_bot = FALSE
       AND created_at >= now() - ($1 || ' days')::interval
       AND city IS NOT NULL AND city <> ''
     GROUP BY city, country ORDER BY sessions DESC, city ASC LIMIT 8`,
    [days],
  );
  return r.rows.map((x) => ({
    label: x.country ? `${x.city}, ${x.country}` : x.city,
    sessions: x.sessions,
  }));
}

function pctDelta(cur: number, prev: number): string {
  if (prev === 0) return cur > 0 ? "new" : "—";
  const p = Math.round(((cur - prev) / prev) * 100);
  const arrow = p > 0 ? "▲" : p < 0 ? "▼" : "▬";
  return `${arrow} ${p > 0 ? "+" : ""}${p}%`;
}

function fmtDuration(sec: number | null): string {
  if (sec == null) return "—";
  const t = Math.round(sec);
  if (t < 60) return `${t}s`;
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m}m ${s}s`;
}

function yesterdayLabel(): string {
  const now = new Date();
  // Shift to Pacific, then back one day, for a human date label.
  const pacific = new Date(
    now.toLocaleString("en-US", { timeZone: TZ }),
  );
  pacific.setDate(pacific.getDate() - 1);
  return pacific.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function buildHtml(d: {
  dateLabel: string;
  yesterday: WindowStats;
  dayBefore: WindowStats;
  last7: WindowStats;
  prev7: WindowStats;
  allTime: AllTime;
  countries: Array<{ country: string; sessions: number }>;
  cities: Array<{ label: string; sessions: number }>;
}): string {
  const stat = (label: string, value: string, sub?: string) => `
    <td style="padding:14px 16px;background:#faf8f4;border:1px solid #eadfce;border-radius:10px;text-align:center;">
      <div style="font-size:26px;font-weight:700;color:#8C1515;line-height:1;">${value}</div>
      <div style="font-size:12px;color:#6b6b6b;margin-top:6px;text-transform:uppercase;letter-spacing:.04em;">${label}</div>
      ${sub ? `<div style="font-size:12px;color:#999;margin-top:3px;">${sub}</div>` : ""}
    </td>`;

  const growthRow = (
    label: string,
    cur: number,
    prev: number,
    curExtra: string,
  ) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f0e9dc;font-size:14px;color:#333;">${label}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0e9dc;font-size:14px;color:#333;text-align:right;font-weight:600;">${cur.toLocaleString()}${curExtra}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0e9dc;font-size:14px;color:#666;text-align:right;">${prev.toLocaleString()}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0e9dc;font-size:13px;text-align:right;">${pctDelta(cur, prev)}</td>
    </tr>`;

  const sinceRow = (label: string, value: string) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f0e9dc;font-size:14px;color:#333;">${label}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0e9dc;font-size:14px;color:#333;text-align:right;font-weight:600;">${value}</td>
    </tr>`;

  const locList = (items: Array<{ label: string; sessions: number }>) =>
    items.length === 0
      ? `<p style="color:#999;font-size:14px;margin:6px 0;">No location data yet.</p>`
      : `<table style="width:100%;border-collapse:collapse;">${items
          .map(
            (i) => `<tr>
              <td style="padding:5px 0;font-size:14px;color:#333;">${i.label}</td>
              <td style="padding:5px 0;font-size:14px;color:#666;text-align:right;">${i.sessions.toLocaleString()} visit${i.sessions === 1 ? "" : "s"}</td>
            </tr>`,
          )
          .join("")}</table>`;

  return `<!doctype html><html><body style="margin:0;background:#f4ecdd;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:28px 20px;">
    <p style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#8C1515;font-weight:600;margin:0 0 4px;">Palonur · Daily traffic</p>
    <h1 style="font-size:22px;color:#3a1010;margin:0 0 2px;">${d.dateLabel}</h1>
    <p style="font-size:13px;color:#888;margin:0 0 20px;">Numbers below are for that full day (Pacific).</p>

    <table style="width:100%;border-collapse:separate;border-spacing:8px 0;margin-bottom:8px;"><tr>
      ${stat("Unique visitors", d.yesterday.visitors.toLocaleString(), pctDelta(d.yesterday.visitors, d.dayBefore.visitors) + " vs prev day")}
      ${stat("Visits", d.yesterday.sessions.toLocaleString())}
      ${stat("Median time on site", fmtDuration(d.yesterday.median_sec))}
    </tr></table>

    <h2 style="font-size:15px;color:#3a1010;margin:26px 0 8px;">Growth</h2>
    <table style="width:100%;border-collapse:collapse;">
      <tr>
        <td style="padding:6px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#999;"></td>
        <td style="padding:6px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#999;text-align:right;">Current</td>
        <td style="padding:6px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#999;text-align:right;">Prior</td>
        <td style="padding:6px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#999;text-align:right;">Change</td>
      </tr>
      ${growthRow("Unique visitors — yesterday vs day before", d.yesterday.visitors, d.dayBefore.visitors, "")}
      ${growthRow("Unique visitors — last 7d vs prior 7d", d.last7.visitors, d.prev7.visitors, "")}
      ${growthRow("Visits — last 7d vs prior 7d", d.last7.sessions, d.prev7.sessions, "")}
    </table>

    <h2 style="font-size:15px;color:#3a1010;margin:26px 0 8px;">Top locations (last 7 days)</h2>
    ${locList(d.cities.length ? d.cities : d.countries.map((c) => ({ label: c.country, sessions: c.sessions })))}

    <h2 style="font-size:15px;color:#3a1010;margin:26px 0 8px;">Since launch${d.allTime.since ? ` (${d.allTime.since})` : ""}</h2>
    <table style="width:100%;border-collapse:collapse;">
      ${sinceRow("Total unique visitors", d.allTime.visitors.toLocaleString())}
      ${sinceRow("Total visits", d.allTime.sessions.toLocaleString())}
      ${sinceRow("Median time on site", fmtDuration(d.allTime.median_sec))}
    </table>

    <p style="font-size:12px;color:#999;margin:26px 0 0;line-height:1.5;">
      "Unique visitors" is approximated by distinct IP address (most visitors never sign in),
      so it over- or under-counts when people share a network or switch devices — treat it as a trend, not a headcount.
      Some traffic is your own team (e.g. /admin). Sent automatically each morning.
    </p>
    <p style="font-size:12px;color:#bbb;margin:14px 0 0;">— Palonur</p>
  </div>
  </body></html>`;
}

function buildText(d: {
  dateLabel: string;
  yesterday: WindowStats;
  dayBefore: WindowStats;
  last7: WindowStats;
  prev7: WindowStats;
  allTime: AllTime;
  countries: Array<{ country: string; sessions: number }>;
  cities: Array<{ label: string; sessions: number }>;
}): string {
  const locs = (d.cities.length
    ? d.cities
    : d.countries.map((c) => ({ label: c.country, sessions: c.sessions }))
  )
    .map((i) => `  ${i.label}: ${i.sessions}`)
    .join("\n");
  return [
    `Palonur daily traffic — ${d.dateLabel} (Pacific)`,
    ``,
    `YESTERDAY`,
    `  Unique visitors: ${d.yesterday.visitors} (${pctDelta(d.yesterday.visitors, d.dayBefore.visitors)} vs prev day)`,
    `  Visits: ${d.yesterday.sessions}`,
    `  Median time on site: ${fmtDuration(d.yesterday.median_sec)}`,
    ``,
    `GROWTH`,
    `  Unique visitors last 7d: ${d.last7.visitors} vs prior 7d ${d.prev7.visitors} (${pctDelta(d.last7.visitors, d.prev7.visitors)})`,
    `  Visits last 7d: ${d.last7.sessions} vs prior 7d ${d.prev7.sessions} (${pctDelta(d.last7.sessions, d.prev7.sessions)})`,
    ``,
    `TOP LOCATIONS (last 7 days)`,
    locs || "  (none yet)",
    ``,
    `SINCE LAUNCH${d.allTime.since ? ` (${d.allTime.since})` : ""}`,
    `  Total unique visitors: ${d.allTime.visitors}`,
    `  Total visits: ${d.allTime.sessions}`,
    `  Median time on site: ${fmtDuration(d.allTime.median_sec)}`,
    ``,
    `Note: unique visitors ≈ distinct IP (most visitors never sign in); treat as a trend, not a headcount.`,
  ].join("\n");
}

export type AnalyticsDigestResult =
  | { ok: true; visitors: number; recipients: number }
  | {
      ok: false;
      reason:
        | "not_production"
        | "no_recipients"
        | "resend_unconfigured"
        | "send_failed";
      visitors?: number;
    };

/**
 * Query traffic + send the digest. Production-only for the SCHEDULED path (no
 * reason to email metrics from a dev box); degrades to a warn when Resend isn't
 * configured. Pass `{ force: true }` for a manual admin-triggered send that
 * bypasses the production gate (used by the "Send now" admin button).
 */
export async function runDailyAnalyticsDigest(
  opts: { force?: boolean } = {},
): Promise<AnalyticsDigestResult> {
  if (!opts.force && process.env.NODE_ENV !== "production") {
    logger.debug("Skipping daily analytics digest (not production)");
    return { ok: false, reason: "not_production" };
  }
  if (RECIPIENTS.length === 0) {
    logger.warn("Daily analytics digest has no recipients — skipping");
    return { ok: false, reason: "no_recipients" };
  }

  const [yesterday, dayBefore, last7, prev7, allTime, countries, cities] =
    await Promise.all([
      windowStats(1, 0),
      windowStats(2, 1),
      windowStats(7, 0),
      windowStats(14, 7),
      allTimeStats(),
      topCountries(7),
      topCities(7),
    ]);

  const dateLabel = yesterdayLabel();
  const data = {
    dateLabel,
    yesterday,
    dayBefore,
    last7,
    prev7,
    allTime,
    countries,
    cities,
  };

  const conn = await getResendClient();
  if (!conn) {
    logger.warn(
      { recipients: RECIPIENTS, visitors: yesterday.visitors },
      "Resend not configured — would send daily analytics digest",
    );
    return { ok: false, reason: "resend_unconfigured", visitors: yesterday.visitors };
  }

  const subject = `Palonur daily — ${yesterday.visitors} visitor${yesterday.visitors === 1 ? "" : "s"} yesterday (${dateLabel})`;
  const { error } = await sendGuarded(
    conn.client,
    {
      from: FROM_ADDRESS,
      to: RECIPIENTS.length === 1 ? RECIPIENTS[0] : RECIPIENTS,
      subject,
      text: buildText(data),
      html: buildHtml(data),
    },
    { label: "daily analytics digest" },
  );
  if (error) {
    logger.error({ err: error }, "Failed to send daily analytics digest");
    return { ok: false, reason: "send_failed", visitors: yesterday.visitors };
  }
  logger.info(
    { recipients: RECIPIENTS.length, visitors: yesterday.visitors },
    "Sent daily analytics digest",
  );
  return { ok: true, visitors: yesterday.visitors, recipients: RECIPIENTS.length };
}
