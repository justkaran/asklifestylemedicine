import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import pool from "../lib/db.js";
import {
  getSubscriptionRevenue,
  getLifetimeRevenueCents,
} from "../lib/otlOverview.js";

const router: IRouter = Router();

const GROWTH_COOKIE = "growth_session";

/**
 * Growth-team dashboard — server-side password gate.
 *
 * Mirrors the OTL dashboard access model exactly: ONE shared password
 * (GROWTH_TEAM_PASSWORD) exchanged for a signed, time-limited cookie. The
 * guard also accepts the platform-admin cookie so a signed-in admin opens
 * the page without re-entering a password. Gating is enforced on the SERVER
 * for the data endpoint; when the env var is unset we deny cleanly (503 on
 * login, 401 on data) so the dashboard can never leak by misconfiguration.
 */
function configuredPassword(): string | null {
  const pw = process.env["GROWTH_TEAM_PASSWORD"];
  if (!pw || !pw.trim()) return null;
  return pw;
}

function hasGrowthAccess(req: Request): boolean {
  if (req.signedCookies?.palonur_admin === "1") return true;
  // Fail closed: a growth cookie only grants access while the shared
  // password is actually configured.
  if (!configuredPassword()) return false;
  return req.signedCookies?.[GROWTH_COOKIE] === "1";
}

function requireGrowth(req: Request, res: Response, next: NextFunction) {
  if (hasGrowthAccess(req)) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

// Exchange the shared password for a signed 8-hour session cookie.
router.post("/growth-auth", (req: Request, res: Response) => {
  const expected = configuredPassword();
  if (!expected) {
    req.log?.warn("growth: GROWTH_TEAM_PASSWORD not configured; denying");
    return res
      .status(503)
      .json({ ok: false, error: "Growth dashboard is not configured yet." });
  }
  const { password } = req.body as { password?: string };
  if (!password || password.trim() !== expected) {
    return res.status(401).json({ ok: false, error: "Incorrect password" });
  }
  res.cookie(GROWTH_COOKIE, "1", {
    signed: true,
    httpOnly: true,
    sameSite: "lax",
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
  });
  return res.json({ ok: true });
});

router.delete("/growth-auth", (_req: Request, res: Response) => {
  res.clearCookie(GROWTH_COOKIE);
  return res.json({ ok: true });
});

// Bridge check: lets the SPA skip the password prompt when the caller
// already holds a valid growth or platform-admin cookie.
router.get("/growth-auth/session", (req: Request, res: Response) => {
  return res.json({ authed: hasGrowthAccess(req) });
});

interface MonthRow {
  month: string;
  visitors: number;
  pageviews: number;
}

interface SignupMonthRow {
  month: string;
  signups: number;
}

/**
 * The single read-only aggregate the growth page renders. Every metric is
 * computed live from existing tables — nothing is cached or hand-entered:
 *  - user growth: palonur_pageviews (visitor_id, falling back to session_id
 *    for pre-tracking rows) + palonur_users signups
 *  - revenue: stripe-synced schema via the shared OTL helpers (zeros when
 *    the stripe schema isn't present)
 *  - tokens: agent_queries.input_tokens/output_tokens (NULL rows predate
 *    tracking or never reached the LLM)
 *  - retention: distinct-visitor windows over palonur_pageviews
 */
router.get(
  "/growth/overview",
  requireGrowth,
  async (req: Request, res: Response) => {
    try {
      res.set("Cache-Control", "no-store");
      const [
        usersRow,
        monthly,
        signupMonthly,
        tokensAll,
        tokens30,
        tokensBySource,
        retention,
        revenue,
        lifetimeCents,
        subscribersRow,
        pillarStats,
      ] = await Promise.all([
        pool.query(
          `SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days')::int AS last30
           FROM palonur_users`,
        ),
        pool.query(`
          SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
                 COUNT(DISTINCT COALESCE(visitor_id, session_id))::int AS visitors,
                 COUNT(*)::int AS pageviews
          FROM palonur_pageviews
          WHERE is_bot = FALSE
            AND created_at > NOW() - INTERVAL '6 months'
          GROUP BY 1 ORDER BY 1
        `),
        pool.query(`
          SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
                 COUNT(*)::int AS signups
          FROM palonur_users
          WHERE created_at > NOW() - INTERVAL '6 months'
          GROUP BY 1 ORDER BY 1
        `),
        pool.query(`
          SELECT COALESCE(SUM(input_tokens), 0)::bigint AS input,
                 COALESCE(SUM(output_tokens), 0)::bigint AS output,
                 COUNT(*) FILTER (WHERE input_tokens IS NOT NULL)::int AS tracked,
                 COUNT(*)::int AS total_questions
          FROM agent_queries
        `),
        pool.query(`
          SELECT COALESCE(SUM(input_tokens), 0)::bigint AS input,
                 COALESCE(SUM(output_tokens), 0)::bigint AS output,
                 COUNT(*) FILTER (WHERE input_tokens IS NOT NULL)::int AS tracked,
                 COUNT(*)::int AS total_questions
          FROM agent_queries
          WHERE created_at > NOW() - INTERVAL '30 days'
        `),
        pool.query(`
          SELECT source,
                 COALESCE(SUM(input_tokens), 0)::bigint AS input,
                 COALESCE(SUM(output_tokens), 0)::bigint AS output,
                 COUNT(*)::int AS questions
          FROM agent_queries
          GROUP BY source ORDER BY questions DESC
        `),
        pool.query(`
          WITH v AS (
            SELECT COALESCE(visitor_id, session_id) AS visitor,
                   created_at
            FROM palonur_pageviews
            WHERE is_bot = FALSE
          )
          SELECT
            (SELECT COUNT(DISTINCT visitor) FROM v
              WHERE created_at > NOW() - INTERVAL '1 day')::int   AS dau,
            (SELECT COUNT(DISTINCT visitor) FROM v
              WHERE created_at > NOW() - INTERVAL '7 days')::int  AS wau,
            (SELECT COUNT(DISTINCT visitor) FROM v
              WHERE created_at > NOW() - INTERVAL '30 days')::int AS mau,
            (SELECT COUNT(DISTINCT visitor) FROM v
              WHERE created_at > NOW() - INTERVAL '7 days'
                AND visitor IN (
                  SELECT visitor FROM v
                  WHERE created_at BETWEEN NOW() - INTERVAL '14 days'
                                       AND NOW() - INTERVAL '7 days'
                ))::int AS returned_this_week,
            (SELECT COUNT(DISTINCT visitor) FROM v
              WHERE created_at BETWEEN NOW() - INTERVAL '14 days'
                                   AND NOW() - INTERVAL '7 days')::int AS prev_week,
            (SELECT COUNT(*) FROM (
               SELECT visitor FROM v
               GROUP BY visitor
               HAVING COUNT(DISTINCT created_at::date) >= 2
             ) r)::int AS repeat_visitors,
            (SELECT COUNT(DISTINCT visitor) FROM v)::int AS all_visitors
        `),
        getSubscriptionRevenue(),
        getLifetimeRevenueCents(),
        pool.query(
          `SELECT COUNT(*)::int AS total FROM newsletter_subscribers
           WHERE status = 'active'`,
        ),
        // Per-pillar Q&A counts: unnest pillar_ids array from agent_queries,
        // join to pillars for the display name.
        pool.query(`
          SELECT p.name AS pillar_name,
                 p.slug AS pillar_slug,
                 COUNT(*)::int AS questions,
                 COUNT(*) FILTER (
                   WHERE aq.created_at > NOW() - INTERVAL '30 days'
                 )::int AS questions_30d,
                 COALESCE(SUM(aq.input_tokens), 0)::bigint  AS input_tokens,
                 COALESCE(SUM(aq.output_tokens), 0)::bigint AS output_tokens
          FROM agent_queries aq,
               LATERAL unnest(aq.pillar_ids) AS pid
          JOIN pillars p ON p.id = pid
          GROUP BY p.id, p.name, p.slug
          ORDER BY questions DESC
        `),
      ]);

      const registeredUsers = usersRow.rows[0].total as number;
      const stage =
        registeredUsers >= 1000
          ? "scale"
          : registeredUsers >= 100
            ? "beta"
            : "alpha";
      const ret = retention.rows[0] as {
        dau: number;
        wau: number;
        mau: number;
        returned_this_week: number;
        prev_week: number;
        repeat_visitors: number;
        all_visitors: number;
      };

      return res.json({
        stage: {
          current: stage,
          // ONE labeled count drives the stage — spelled out so the growth
          // team knows exactly what "users" means here.
          metric: registeredUsers,
          metricLabel:
            "registered consumer accounts (palonur_users — people who created an account on the consumer app)",
        },
        users: {
          registered: registeredUsers,
          registeredLast30: usersRow.rows[0].last30 as number,
          newsletterSubscribers: subscribersRow.rows[0].total as number,
          uniqueVisitorsAllTime: ret.all_visitors,
          monthly: (monthly.rows as MonthRow[]).map((m) => ({
            month: m.month,
            visitors: m.visitors,
            pageviews: m.pageviews,
            signups:
              (signupMonthly.rows as SignupMonthRow[]).find(
                (s) => s.month === m.month,
              )?.signups ?? 0,
          })),
        },
        revenue: {
          mrrCents: revenue.mrrCents,
          activeSubscriptions: revenue.activeSubscriptions,
          payingCustomers: revenue.payingCustomers,
          currency: revenue.currency,
          byProduct: revenue.byProduct,
          lifetimeCents,
          cacNote:
            "No paid acquisition channels yet — all growth is organic, so CAC is not yet measurable.",
        },
        tokens: {
          allTime: {
            inputTokens: Number(tokensAll.rows[0].input),
            outputTokens: Number(tokensAll.rows[0].output),
            trackedQuestions: tokensAll.rows[0].tracked as number,
            totalQuestions: tokensAll.rows[0].total_questions as number,
          },
          last30Days: {
            inputTokens: Number(tokens30.rows[0].input),
            outputTokens: Number(tokens30.rows[0].output),
            trackedQuestions: tokens30.rows[0].tracked as number,
            totalQuestions: tokens30.rows[0].total_questions as number,
          },
          bySource: tokensBySource.rows.map(
            (r: {
              source: string;
              input: string;
              output: string;
              questions: number;
            }) => ({
              source: r.source,
              inputTokens: Number(r.input),
              outputTokens: Number(r.output),
              questions: r.questions,
            }),
          ),
          note: "Token tracking began July 2026 — earlier questions have no token counts.",
        },
        retention: {
          dau: ret.dau,
          wau: ret.wau,
          mau: ret.mau,
          dauOverMau: ret.mau > 0 ? ret.dau / ret.mau : null,
          wauOverMau: ret.mau > 0 ? ret.wau / ret.mau : null,
          weekOverWeekReturn:
            ret.prev_week > 0 ? ret.returned_this_week / ret.prev_week : null,
          repeatVisitorShare:
            ret.all_visitors > 0
              ? ret.repeat_visitors / ret.all_visitors
              : null,
          basis:
            "Distinct visitors from palonur_pageviews (visitor_id, falling back to session_id for pre-tracking rows).",
        },
        pillars: {
          byPillar: (
            pillarStats.rows as Array<{
              pillar_name: string;
              pillar_slug: string;
              questions: number;
              questions_30d: number;
              input_tokens: string;
              output_tokens: string;
            }>
          ).map((r) => ({
            pillarName: r.pillar_name,
            pillarSlug: r.pillar_slug,
            questions: r.questions,
            questions30d: r.questions_30d,
            inputTokens: Number(r.input_tokens),
            outputTokens: Number(r.output_tokens),
          })),
          note: "Counts derived from agent_queries.pillar_ids (the pillars actually used in each answer). One question can touch multiple pillars in cross-pillar mode.",
        },
        generatedAt: new Date().toISOString(),
      });
    } catch (err) {
      req.log?.error({ err }, "growth: failed to build overview");
      return res.status(500).json({ error: "Failed to load growth data" });
    }
  },
);

export default router;
