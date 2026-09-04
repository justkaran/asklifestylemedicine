/**
 * Steward analytics endpoints for the per-pillar dashboard:
 *   GET   /api/faculty/pillars/:slug/analytics        — headline stats + monthly chart
 *   GET   /api/faculty/pillars/:slug/payout-settings  — auto-payout preference
 *   PATCH /api/faculty/pillars/:slug/payout-settings  — toggle auto-payout
 *   POST  /api/faculty/pillars/:slug/payout/request   — request a manual payout
 *   GET   /api/faculty/pillars/:slug/corpus-search    — search agent_queries ?q=
 *
 * All endpoints require faculty auth + pillar membership (steward for writes).
 */
import { Router, type IRouter } from "express";
import pool from "../lib/db.js";
import {
  requireFacultyAuth,
  requirePillarRole,
  type FacultyRequest,
} from "../middlewares/facultyAuth.js";
import {
  countStewardSubscribers,
  STEWARD_SHARE,
} from "../lib/stewardBilling.js";

const router: IRouter = Router();

// Idempotently ensure auto_payout column exists on faculty_memberships.
pool
  .query(
    `ALTER TABLE faculty_memberships
     ADD COLUMN IF NOT EXISTS auto_payout BOOLEAN NOT NULL DEFAULT TRUE`,
  )
  .catch(() => {
    /* already exists — safe to ignore */
  });

// ── Analytics summary ─────────────────────────────────────────────────────────

router.get(
  "/faculty/pillars/:slug/analytics",
  requireFacultyAuth,
  requirePillarRole({ slugParam: "slug" }, [
    "steward",
    "contributor",
    "advisor",
    "viewer",
  ]),
  async (req: FacultyRequest, res): Promise<void> => {
    const pillar = req.pillar;
    const facultyUserId = req.faculty?.user.id;
    if (!pillar || !facultyUserId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    try {
      const [monthly, userCount, pubIds, ytd, allTime] = await Promise.all([
        // Monthly revenue grouped by calendar month (last 12, oldest→newest)
        pool.query<{
          month: string;
          label: string;
          gross_cents: string;
          steward_cents: string;
          palonur_cents: string;
        }>(
          `SELECT
             TO_CHAR(COALESCE(TO_TIMESTAMP(invoice_created), created_at), 'YYYY-MM')   AS month,
             TO_CHAR(COALESCE(TO_TIMESTAMP(invoice_created), created_at), 'Mon ''YY') AS label,
             SUM(gross_cents)::bigint   AS gross_cents,
             SUM(steward_cents)::bigint AS steward_cents,
             SUM(palonur_cents)::bigint AS palonur_cents
           FROM steward_earnings
           WHERE faculty_user_id = $1
           GROUP BY 1, 2
           ORDER BY 1 DESC
           LIMIT 12`,
          [facultyUserId],
        ),

        // Unique user sessions for this pillar
        pool.query<{ count: number }>(
          `SELECT COUNT(DISTINCT session_id)::int AS count
           FROM agent_queries
           WHERE $1 = ANY(pillar_ids)`,
          [pillar.id],
        ),

        // Publication IDs this steward earns from
        pool.query<{ publication_id: number }>(
          `SELECT DISTINCT publication_id
           FROM steward_earnings
           WHERE faculty_user_id = $1`,
          [facultyUserId],
        ),

        // Year-to-date totals
        pool.query<{
          gross_cents: string;
          steward_cents: string;
          palonur_cents: string;
        }>(
          `SELECT
             COALESCE(SUM(gross_cents),   0)::bigint AS gross_cents,
             COALESCE(SUM(steward_cents), 0)::bigint AS steward_cents,
             COALESCE(SUM(palonur_cents), 0)::bigint AS palonur_cents
           FROM steward_earnings
           WHERE faculty_user_id = $1
             AND EXTRACT(YEAR FROM COALESCE(TO_TIMESTAMP(invoice_created), created_at))
                 = EXTRACT(YEAR FROM NOW())`,
          [facultyUserId],
        ),

        // All-time totals + invoice count
        pool.query<{
          gross_cents: string;
          steward_cents: string;
          palonur_cents: string;
          invoice_count: number;
        }>(
          `SELECT
             COALESCE(SUM(gross_cents),   0)::bigint AS gross_cents,
             COALESCE(SUM(steward_cents), 0)::bigint AS steward_cents,
             COALESCE(SUM(palonur_cents), 0)::bigint AS palonur_cents,
             COUNT(*)::int                           AS invoice_count
           FROM steward_earnings
           WHERE faculty_user_id = $1`,
          [facultyUserId],
        ),
      ]);

      // Subscriber count across all publications this steward earns from.
      let activeSubscribers = 0;
      for (const row of pubIds.rows) {
        activeSubscribers += await countStewardSubscribers(row.publication_id);
      }

      // Query returned DESC (newest first); first row = most recent month.
      const currentMonth = new Date().toISOString().slice(0, 7);
      const firstRow = monthly.rows[0];
      const thisMonthRow = firstRow?.month === currentMonth ? firstRow : null;

      // Reverse to oldest→newest for the chart timeline.
      const monthlyChronological = [...monthly.rows].reverse();

      res.json({
        sharePercent: Math.round(STEWARD_SHARE * 100),
        uniqueUsers: userCount.rows[0]?.count ?? 0,
        activeSubscribers,
        invoiceCount: allTime.rows[0]?.invoice_count ?? 0,
        thisMonth: {
          grossCents: Number(thisMonthRow?.gross_cents ?? 0),
          stewardCents: Number(thisMonthRow?.steward_cents ?? 0),
          palonurCents: Number(thisMonthRow?.palonur_cents ?? 0),
        },
        ytd: {
          grossCents: Number(ytd.rows[0]?.gross_cents ?? 0),
          stewardCents: Number(ytd.rows[0]?.steward_cents ?? 0),
          palonurCents: Number(ytd.rows[0]?.palonur_cents ?? 0),
        },
        allTime: {
          grossCents: Number(allTime.rows[0]?.gross_cents ?? 0),
          stewardCents: Number(allTime.rows[0]?.steward_cents ?? 0),
          palonurCents: Number(allTime.rows[0]?.palonur_cents ?? 0),
        },
        monthly: monthlyChronological.map((r) => ({
          month: r.month,
          label: r.label,
          grossCents: Number(r.gross_cents),
          stewardCents: Number(r.steward_cents),
          palonurCents: Number(r.palonur_cents),
        })),
      });
    } catch (e) {
      req.log.error({ err: e }, "pillar analytics load failed");
      res.status(500).json({ error: "Failed to load analytics" });
    }
  },
);

// ── Payout settings ───────────────────────────────────────────────────────────

router.get(
  "/faculty/pillars/:slug/payout-settings",
  requireFacultyAuth,
  requirePillarRole({ slugParam: "slug" }, ["steward"]),
  async (req: FacultyRequest, res): Promise<void> => {
    const pillar = req.pillar;
    const facultyUserId = req.faculty?.user.id;
    if (!pillar || !facultyUserId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    try {
      const result = await pool.query<{ auto_payout: boolean | null }>(
        `SELECT auto_payout FROM faculty_memberships
         WHERE user_id = $1 AND pillar_id = $2`,
        [facultyUserId, pillar.id],
      );
      res.json({ autoPayout: result.rows[0]?.auto_payout ?? true });
    } catch (e) {
      req.log.error({ err: e }, "payout settings load failed");
      res.status(500).json({ error: "Failed to load payout settings" });
    }
  },
);

router.patch(
  "/faculty/pillars/:slug/payout-settings",
  requireFacultyAuth,
  requirePillarRole({ slugParam: "slug" }, ["steward"]),
  async (req: FacultyRequest, res): Promise<void> => {
    const pillar = req.pillar;
    const facultyUserId = req.faculty?.user.id;
    if (!pillar || !facultyUserId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const { autoPayout } = req.body ?? {};
    if (typeof autoPayout !== "boolean") {
      res.status(400).json({ error: "autoPayout must be a boolean" });
      return;
    }
    try {
      await pool.query(
        `UPDATE faculty_memberships SET auto_payout = $1
         WHERE user_id = $2 AND pillar_id = $3`,
        [autoPayout, facultyUserId, pillar.id],
      );
      res.json({ autoPayout });
    } catch (e) {
      req.log.error({ err: e }, "payout settings update failed");
      res.status(500).json({ error: "Failed to update payout settings" });
    }
  },
);

// ── Manual payout request ─────────────────────────────────────────────────────

router.post(
  "/faculty/pillars/:slug/payout/request",
  requireFacultyAuth,
  requirePillarRole({ slugParam: "slug" }, ["steward"]),
  async (req: FacultyRequest, res): Promise<void> => {
    const pillar = req.pillar;
    const user = req.faculty?.user;
    if (!pillar || !user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    req.log.info(
      {
        pillarSlug: pillar.slug,
        facultyUserId: user.id,
        fullName: user.fullName,
      },
      "Manual payout requested",
    );
    // TODO: send admin notification email.
    res.json({
      requested: true,
      message:
        "Payout request received — Palonur will process your share within 5 business days.",
    });
  },
);

// ── Earnings CSV export ───────────────────────────────────────────────────

router.get(
  "/faculty/pillars/:slug/analytics/export.csv",
  requireFacultyAuth,
  requirePillarRole({ slugParam: "slug" }, [
    "steward",
    "contributor",
    "advisor",
    "viewer",
  ]),
  async (req: FacultyRequest, res): Promise<void> => {
    const pillar = req.pillar;
    const facultyUserId = req.faculty?.user.id;
    if (!pillar || !facultyUserId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    try {
      const result = await pool.query<{
        month: string;
        invoice_date: string;
        gross_cents: string;
        steward_cents: string;
        palonur_cents: string;
        stripe_invoice_id: string;
      }>(
        `SELECT
           TO_CHAR(COALESCE(TO_TIMESTAMP(invoice_created), created_at), 'YYYY-MM') AS month,
           TO_CHAR(COALESCE(TO_TIMESTAMP(invoice_created), created_at), 'YYYY-MM-DD') AS invoice_date,
           gross_cents,
           steward_cents,
           palonur_cents,
           stripe_invoice_id
         FROM steward_earnings
         WHERE faculty_user_id = $1
         ORDER BY COALESCE(TO_TIMESTAMP(invoice_created), created_at) ASC`,
        [facultyUserId],
      );

      const centsToUSD = (c: string) => (Number(c) / 100).toFixed(2);

      const header = "Month,Invoice Date,Gross Amount,Your Share (80%),Palonur Share (20%),Invoice ID";
      const rows = result.rows.map((r) =>
        [
          r.month,
          r.invoice_date,
          centsToUSD(r.gross_cents),
          centsToUSD(r.steward_cents),
          centsToUSD(r.palonur_cents),
          r.stripe_invoice_id,
        ].join(","),
      );

      const csv = [header, ...rows].join("\n");
      const filename = `earnings-${pillar.slug}.csv`;

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );
      res.send(csv);
    } catch (e) {
      req.log.error({ err: e }, "earnings CSV export failed");
      res.status(500).json({ error: "Failed to export earnings" });
    }
  },
);

// ── Corpus search ─────────────────────────────────────────────────────────────

router.get(
  "/faculty/pillars/:slug/corpus-search",
  requireFacultyAuth,
  requirePillarRole({ slugParam: "slug" }, [
    "steward",
    "contributor",
    "advisor",
    "viewer",
  ]),
  async (req: FacultyRequest, res): Promise<void> => {
    const pillar = req.pillar;
    if (!pillar) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const q = String(req.query.q ?? "").trim();

    try {
      // Group by cluster representative (when available) or exact question.
      // Empty `q` → top 30 most-asked questions overall.
      const result = await pool.query<{
        representative: string;
        hits: number;
        cluster_id: number | null;
        has_uncovered: boolean;
      }>(
        `SELECT
           COALESCE(c.representative_question, aq.question) AS representative,
           COUNT(*)::int                                      AS hits,
           aq.cluster_id,
           bool_or(aq.was_uncovered)                        AS has_uncovered
         FROM agent_queries aq
         LEFT JOIN query_clusters c
           ON c.id = aq.cluster_id AND c.pillar_id = $1
         WHERE $1 = ANY(aq.pillar_ids)
           AND ($2 = '' OR aq.question ILIKE '%' || $2 || '%')
         GROUP BY COALESCE(c.representative_question, aq.question), aq.cluster_id
         ORDER BY hits DESC
         LIMIT 30`,
        [pillar.id, q],
      );

      res.json({
        query: q,
        groups: result.rows.map((r) => ({
          representative: r.representative,
          hits: r.hits,
          clusterId: r.cluster_id,
          hasUncovered: r.has_uncovered,
        })),
      });
    } catch (e) {
      req.log.error({ err: e }, "corpus search failed");
      res.status(500).json({ error: "Failed to search corpus" });
    }
  },
);

export default router;
