import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import pool from "../lib/db";
import { getIp, geoLookup } from "../lib/geo.js";
import { isBotRequest } from "../lib/botDetect.js";
import { runDailyAnalyticsDigest } from "../lib/analyticsDigestEmail";

const router: IRouter = Router();

// Same cookie-based admin gate the rest of /api/admin/* uses (set by
// POST /api/admin-auth). The previous hardcoded `x-admin-key` header
// gate was never sent by the admin SPA, so /api/admin/analytics always
// 401'd in production and the Traffic tab rendered blank.
function checkAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.signedCookies?.palonur_admin === "1") return next();
  return res.status(401).json({ error: "Unauthorized" });
}

function parseDevice(ua: string): string {
  if (/tablet|ipad/i.test(ua)) return "Tablet";
  if (/mobile|android|iphone|ipod|blackberry|opera mini|iemobile/i.test(ua)) return "Mobile";
  return "Desktop";
}

function parseDomain(referrer: string): string {
  if (!referrer) return "Direct";
  try {
    const url = new URL(referrer);
    const host = url.hostname.replace(/^www\./, "");
    return host || "Direct";
  } catch {
    return "Direct";
  }
}

// POST /api/pageview — record a new pageview, return { id }
router.post("/pageview", async (req, res) => {
  const { session_id, page, referrer, visitor_id } = req.body as {
    session_id?: string;
    page?: string;
    referrer?: string;
    visitor_id?: string;
  };
  if (!session_id || !page) {
    res.status(400).json({ error: "session_id and page required" });
    return;
  }
  const visitorId =
    typeof visitor_id === "string" && visitor_id.length > 0
      ? visitor_id.slice(0, 64)
      : null;
  const ua = req.headers["user-agent"] ?? "";
  const device = parseDevice(ua);
  const referrer_domain = parseDomain(referrer ?? "");
  // getIp returns the raw first x-forwarded-for entry; validate before
  // storing so the TEXT ip column only ever holds a plausible IPv4/IPv6
  // literal (the boot-time bot backfill casts stored values to ::inet).
  const rawIp = getIp(req);
  const ip = /^[0-9a-fA-F:.]{2,45}$/.test(rawIp) ? rawIp : null;
  const isBot = isBotRequest(typeof ua === "string" ? ua : "", rawIp);

  // Respond immediately; geo lookup happens in the background
  let pvId: number;
  try {
    const r = await pool.query(
      `INSERT INTO palonur_pageviews (session_id, page, referrer, referrer_domain, device, ip, visitor_id, is_bot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [session_id, page, referrer ?? null, referrer_domain, device, ip, visitorId, isBot],
    );
    pvId = r.rows[0].id;
    res.json({ id: pvId });
  } catch (err) {
    req.log.error({ err }, "pageview insert failed");
    res.status(500).json({ error: "db error" });
    return;
  }

  // Geo lookup — fire and forget, don't block the response
  geoLookup(ip ?? "").then(async geo => {
    if (!geo) return;
    await pool.query(
      "UPDATE palonur_pageviews SET country=$1, country_code=$2, city=$3 WHERE id=$4",
      [geo.country, geo.country_code, geo.city, pvId],
    ).catch(() => {});
  });
});

// PATCH or POST /api/pageview/:id — set duration when user leaves the page
// sendBeacon always uses POST, so we handle both methods
async function handlePageviewDuration(req: import("express").Request, res: import("express").Response) {
  const id = parseInt(String(req.params.id), 10);
  const { duration_ms } = req.body as { duration_ms?: number };
  if (!id || duration_ms == null) {
    res.status(400).json({ error: "missing fields" });
    return;
  }
  try {
    await pool.query(
      "UPDATE palonur_pageviews SET duration_ms=$1 WHERE id=$2",
      [Math.round(duration_ms), id],
    );
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "pageview update failed");
    res.status(500).json({ error: "db error" });
  }
}

router.patch("/pageview/:id", handlePageviewDuration);
router.post("/pageview/:id", handlePageviewDuration);

// POST /api/video-view — record that a visitor started watching a video
const KNOWN_VIDEOS = new Set(["palonur-intro"]);
const videoViewHits = new Map<string, { count: number; resetAt: number }>();
const VIDEO_VIEW_LIMIT = 20; // per IP per hour
function videoViewAllowed(ip: string): boolean {
  const now = Date.now();
  const entry = videoViewHits.get(ip);
  if (!entry || now > entry.resetAt) {
    videoViewHits.set(ip, { count: 1, resetAt: now + 60 * 60 * 1000 });
    if (videoViewHits.size > 10000) {
      for (const [k, v] of videoViewHits) if (now > v.resetAt) videoViewHits.delete(k);
    }
    return true;
  }
  entry.count += 1;
  return entry.count <= VIDEO_VIEW_LIMIT;
}

router.post("/video-view", async (req, res) => {
  const { video, session_id, visitor_id } = req.body as {
    video?: string;
    session_id?: string;
    visitor_id?: string;
  };
  if (!video || typeof video !== "string" || !KNOWN_VIDEOS.has(video)) {
    res.status(400).json({ error: "unknown video" });
    return;
  }
  if (!videoViewAllowed(req.ip ?? "unknown")) {
    res.status(429).json({ error: "too many requests" });
    return;
  }
  try {
    await pool.query(
      "INSERT INTO palonur_video_views (video, session_id, visitor_id) VALUES ($1,$2,$3)",
      [
        video.slice(0, 128),
        typeof session_id === "string" ? session_id.slice(0, 64) : null,
        typeof visitor_id === "string" ? visitor_id.slice(0, 64) : null,
      ],
    );
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "video view insert failed");
    res.status(500).json({ error: "db error" });
  }
});

// GET /api/admin/video-stats — watch counts per video (admin only)
router.get("/admin/video-stats", checkAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT video,
             COUNT(*)::int AS total_plays,
             COUNT(DISTINCT COALESCE(visitor_id, session_id))::int AS unique_viewers,
             MIN(created_at) AS first_play,
             MAX(created_at) AS last_play
      FROM palonur_video_views
      GROUP BY video
      ORDER BY total_plays DESC
    `);
    res.json({ videos: rows });
  } catch (err) {
    req.log.error({ err }, "video stats failed");
    res.status(500).json({ error: "db error" });
  }
});

// GET /api/admin/analytics — aggregated traffic stats (admin only).
// Bot/crawler pageviews are excluded by default; pass ?include_bots=1 to
// count them too.
router.get("/admin/analytics", checkAdmin, async (req, res) => {
  const includeBots =
    req.query.include_bots === "1" || req.query.include_bots === "true";
  const botFilter = includeBots ? "" : "AND is_bot = FALSE";
  try {
    const [
      totals,
      daily,
      pages,
      referrers,
      devices,
      countries,
      recent,
    ] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int AS total_pageviews,
          COUNT(DISTINCT session_id)::int AS total_sessions,
          ROUND(AVG(duration_ms) / 1000.0, 1) AS avg_duration_sec
        FROM palonur_pageviews
        WHERE created_at >= NOW() - INTERVAL '30 days' ${botFilter}
      `),
      pool.query(`
        SELECT
          DATE(created_at AT TIME ZONE 'America/Los_Angeles') AS date,
          COUNT(DISTINCT session_id)::int AS sessions,
          COUNT(*)::int AS pageviews
        FROM palonur_pageviews
        WHERE created_at >= NOW() - INTERVAL '30 days' ${botFilter}
        GROUP BY 1 ORDER BY 1
      `),
      pool.query(`
        SELECT
          page,
          COUNT(*)::int AS views,
          ROUND(AVG(duration_ms) / 1000.0, 1) AS avg_duration_sec
        FROM palonur_pageviews
        WHERE created_at >= NOW() - INTERVAL '30 days' ${botFilter}
        GROUP BY page ORDER BY views DESC
      `),
      pool.query(`
        SELECT
          referrer_domain AS domain,
          COUNT(*)::int AS visits
        FROM palonur_pageviews
        WHERE created_at >= NOW() - INTERVAL '30 days' ${botFilter}
        GROUP BY referrer_domain ORDER BY visits DESC LIMIT 20
      `),
      pool.query(`
        SELECT
          device,
          COUNT(*)::int AS count
        FROM palonur_pageviews
        WHERE created_at >= NOW() - INTERVAL '30 days' ${botFilter}
        GROUP BY device ORDER BY count DESC
      `),
      pool.query(`
        SELECT
          COALESCE(country, 'Unknown') AS country,
          COALESCE(country_code, '') AS country_code,
          COUNT(DISTINCT session_id)::int AS sessions,
          COUNT(*)::int AS pageviews
        FROM palonur_pageviews
        WHERE created_at >= NOW() - INTERVAL '30 days' ${botFilter}
        GROUP BY country, country_code ORDER BY sessions DESC LIMIT 30
      `),
      pool.query(`
        SELECT
          session_id,
          MIN(created_at) AS first_seen,
          COUNT(*)::int AS pages_viewed,
          STRING_AGG(page, ' → ' ORDER BY created_at) AS journey,
          referrer_domain,
          device,
          MAX(country) AS country,
          MAX(city) AS city
        FROM palonur_pageviews
        WHERE created_at >= NOW() - INTERVAL '7 days' ${botFilter}
        GROUP BY session_id, referrer_domain, device
        ORDER BY first_seen DESC LIMIT 50
      `),
    ]);

    res.json({
      totals: totals.rows[0],
      daily: daily.rows,
      pages: pages.rows,
      referrers: referrers.rows,
      devices: devices.rows,
      countries: countries.rows,
      recentSessions: recent.rows,
    });
  } catch (err) {
    req.log.error({ err }, "analytics query failed");
    res.status(500).json({ error: "db error" });
  }
});

// POST /api/admin/analytics/send-digest — manually trigger the daily traffic
// digest email on demand (admin only). Uses force:true so it sends regardless
// of the NODE_ENV production gate the scheduled cron respects. In production it
// reports live traffic; in dev it would report the (near-empty) dev database.
router.post("/admin/analytics/send-digest", checkAdmin, async (req, res) => {
  try {
    const result = await runDailyAnalyticsDigest({ force: true });
    if (result.ok) {
      res.json({ ok: true, recipients: result.recipients });
      return;
    }
    const status =
      result.reason === "no_recipients"
        ? 400
        : result.reason === "resend_unconfigured"
          ? 503
          : 500;
    res.status(status).json(result);
  } catch (err) {
    req.log.error({ err }, "manual analytics digest send failed");
    res.status(500).json({ ok: false, reason: "send_failed" });
  }
});

export default router;
