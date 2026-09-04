import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import pool from "./db.js";
import { logger } from "./logger.js";
import {
  getFacultyRoster,
  getPillarOverview,
  type RosterMember,
} from "./facultyOverview.js";
import { getNewsletterRevenue } from "./newsletterBilling.js";

/**
 * Read-only aggregate model powering the Stanford OTL governance dashboard
 * (`/otl-dashboard`). Every number is computed over EXISTING tables — there are
 * no OTL-specific tables — and reuses the shared faculty/pillar read models
 * (`getFacultyRoster`, `getPillarOverview`) and the newsletter revenue helper so
 * the OTL surface reconciles with the internal admin and faculty views.
 *
 * IMPORTANT: revenue is intentionally exposed here. This is a privileged,
 * password-gated surface controlled by Karan and deliberately does NOT follow
 * the investor-portal "hide money" rule.
 */

const COVERAGE_GAP_WINDOW_DAYS = 30;
const QUERY_VOLUME_WINDOW_DAYS = 30;
export const CONSUMER_PLAN_PRICE_CENTS = 900; // Palonur Nightly, $9/mo

export interface OtlOverview {
  generatedAt: string;
  kpis: {
    activePillars: number;
    retiredPillars: number;
    onboardedStewards: number;
    totalFaculty: number;
    approvedSources: number;
    approvedInterpretations: number;
    questionsAnswered: number;
    coverageRatePct: number | null;
    citationVerifiedRate: number | null;
  };
  pillars: Array<{
    slug: string;
    name: string;
    description: string | null;
    retired: boolean;
    stewards: string[];
    facultyCount: number;
    approvedSources: number;
    approvedInterpretations: number;
    questionVolume: number;
  }>;
  stewards: Array<{
    name: string;
    institution: string | null;
    isPlatformAdmin: boolean;
    onboarded: boolean;
    voiceProfile: "approved" | "draft" | "none";
    roles: Array<{ pillar: string; role: string }>;
    interpretationsAuthored: number;
    interpretationsApproved: number;
  }>;
  governance: {
    sourcesByStatus: Record<string, number>;
    sourcesByKind: Record<string, number>;
    reliability: {
      rigor: { avg: number | null; scored: number };
      reproducibility: { avg: number | null; scored: number };
      openness: { avg: number | null; scored: number };
      assessed: number;
      approvedAssessments: number;
    };
    draftAcceptance: {
      total: number;
      withDraft: number;
      unedited: number;
      light: number;
      rewritten: number;
      noDraft: number;
    };
    interpretationsByStatus: Record<string, number>;
    citationHealth: {
      verified: number;
      unmatched: number;
      missing: number;
      verifiedRate: number | null;
    };
    coverageGaps: {
      windowDays: number;
      totalUncovered: number;
      distinctQuestions: number;
    };
    crossPillarAdoptions: {
      proposed: number;
      approved: number;
      declined: number;
    };
    evalQuality: {
      runName: string | null;
      completedAt: string | null;
      citationVerifiedRate: number | null;
      coverageRate: number | null;
      refusalComplianceRate: number | null;
      uncoveredHonestyRate: number | null;
      medianLatencyMs: number | null;
    } | null;
  };
  demand: {
    signups: number;
    waitlist: number;
    newsletterSubscribers: { active: number; total: number };
    willingnessToPay: {
      total: number;
      wouldPay: number;
      byPrice: Array<{ label: string; count: number }>;
    };
    queryVolume: Array<{ date: string; count: number }>;
  };
  revenue: {
    activeSubscriptions: number;
    payingCustomers: number;
    mrrCents: number;
    currency: string;
    byProduct: Array<{ product: string; subscriptions: number; mrrCents: number }>;
    lifetimeRevenueCents: number | null;
    newsletterMrrCents: number;
    newsletterPayingCustomers: number;
    consumerPlanPriceCents: number;
  };
}

function toCountMap(
  rows: Array<{ key: string | null; n: number }>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.key ?? "unknown"] = r.n;
  return out;
}

/** Monthly-normalized cents for one subscription line. */
function monthlyCents(unitAmount: number, interval: string | null): number {
  if (interval === "year") return Math.round(unitAmount / 12);
  if (interval === "week") return unitAmount * 4;
  return unitAmount; // month (and anything else) treated as monthly
}

interface StripeSubRow {
  customer: string | null;
  product: string | null;
  unit_amount: number | null;
  interval: string | null;
  currency: string | null;
}

/**
 * All active/trialing subscriptions with their product + price, aggregated into
 * a total MRR, distinct paying customers, and a per-product breakdown. Mirrors
 * the established stripe-synced query pattern (see newsletterBilling) and
 * degrades to zeros when the `stripe` schema isn't present (dev / not connected).
 */
export async function getSubscriptionRevenue(): Promise<{
  activeSubscriptions: number;
  payingCustomers: number;
  mrrCents: number;
  currency: string;
  byProduct: Array<{ product: string; subscriptions: number; mrrCents: number }>;
}> {
  try {
    const result = await db.execute(sql`
      SELECT s.customer AS customer,
             COALESCE(prod.name, 'Unknown') AS product,
             p.unit_amount AS unit_amount,
             p.recurring->>'interval' AS interval,
             p.currency AS currency
      FROM stripe.subscriptions s
      JOIN stripe.subscription_items si ON si.subscription = s.id
      JOIN stripe.prices p ON p.id = si.price
      LEFT JOIN stripe.products prod ON prod.id = p.product
      WHERE s.status IN ('active', 'trialing')
    `);
    const rows = result.rows as unknown as StripeSubRow[];
    const customers = new Set<string>();
    const byProduct = new Map<string, { subscriptions: number; mrrCents: number }>();
    let mrrCents = 0;
    let currency = "usd";
    for (const r of rows) {
      const amount = r.unit_amount ?? 0;
      const mc = monthlyCents(amount, r.interval);
      mrrCents += mc;
      if (r.currency) currency = r.currency;
      if (r.customer) customers.add(r.customer);
      const name = r.product ?? "Unknown";
      const agg = byProduct.get(name) ?? { subscriptions: 0, mrrCents: 0 };
      agg.subscriptions += 1;
      agg.mrrCents += mc;
      byProduct.set(name, agg);
    }
    return {
      activeSubscriptions: rows.length,
      payingCustomers: customers.size,
      mrrCents,
      currency,
      byProduct: Array.from(byProduct.entries())
        .map(([product, v]) => ({ product, ...v }))
        .sort((a, b) => b.mrrCents - a.mrrCents),
    };
  } catch (err) {
    logger.warn({ err }, "otl: could not derive subscription revenue");
    return {
      activeSubscriptions: 0,
      payingCustomers: 0,
      mrrCents: 0,
      currency: "usd",
      byProduct: [],
    };
  }
}

/** Lifetime paid revenue from synced Stripe invoices, or null if unavailable. */
export async function getLifetimeRevenueCents(): Promise<number | null> {
  try {
    const result = await db.execute(sql`
      SELECT COALESCE(SUM(amount_paid), 0)::bigint AS total
      FROM stripe.invoices
      WHERE status = 'paid'
    `);
    const row = result.rows[0] as { total: string | number } | undefined;
    if (!row) return null;
    return Number(row.total) || 0;
  } catch (err) {
    logger.warn({ err }, "otl: could not derive lifetime revenue");
    return null;
  }
}

export async function getOtlOverview(): Promise<OtlOverview> {
  const [
    roster,
    pillarOverview,
    approvedSourceByPillar,
    approvedInterpByPillar,
    questionsByPillar,
    sourcesByStatusRows,
    sourcesByKindRows,
    reliabilityRow,
    draftAcceptanceRows,
    interpByStatusRows,
    interpByAuthorRows,
    interpByApproverRows,
    voiceRows,
    crossPillarRows,
    coverageGapRow,
    queryTotalsRow,
    queryVolumeRows,
    signupsRow,
    waitlistRow,
    newsletterRows,
    wtpTotalsRow,
    wtpByPriceRows,
    latestEvalRunRows,
    subscriptionRevenue,
    lifetimeRevenueCents,
    newsletterRevenue,
  ] = await Promise.all([
    getFacultyRoster(),
    getPillarOverview(),
    pool.query<{ pillar_id: number; n: number }>(
      `SELECT pillar_id, COUNT(*)::int AS n FROM sources WHERE status = 'approved' AND is_canary = FALSE GROUP BY pillar_id`,
    ),
    pool.query<{ pillar_id: number; n: number }>(
      `SELECT pillar_id, COUNT(*)::int AS n FROM interpretations WHERE status = 'approved' GROUP BY pillar_id`,
    ),
    pool.query<{ pillar_id: number; n: number }>(
      `SELECT pid AS pillar_id, COUNT(*)::int AS n
         FROM agent_queries, UNNEST(pillar_ids) AS pid
        GROUP BY pid`,
    ),
    pool.query<{ key: string | null; n: number }>(
      `SELECT status AS key, COUNT(*)::int AS n FROM sources WHERE is_canary = FALSE GROUP BY status`,
    ),
    pool.query<{ key: string | null; n: number }>(
      `SELECT kind AS key, COUNT(*)::int AS n FROM sources WHERE is_canary = FALSE GROUP BY kind`,
    ),
    pool.query<{
      rigor_avg: number | null;
      rigor_n: number;
      repro_avg: number | null;
      repro_n: number;
      openness_avg: number | null;
      openness_n: number;
      assessed: number;
      approved_assessments: number;
    }>(
      `SELECT AVG(rigor_score)::float                                            AS rigor_avg,
              COUNT(rigor_score)::int                                            AS rigor_n,
              AVG(reproducibility_score)::float                                  AS repro_avg,
              COUNT(reproducibility_score)::int                                  AS repro_n,
              AVG(openness_score)::float                                         AS openness_avg,
              COUNT(openness_score)::int                                         AS openness_n,
              COUNT(*) FILTER (WHERE assessment_status IS NOT NULL)::int         AS assessed,
              COUNT(*) FILTER (WHERE assessment_status = 'approved')::int        AS approved_assessments
         FROM sources
        WHERE is_canary = FALSE`,
    ),
    pool.query<{ key: string | null; n: number }>(
      `SELECT COALESCE(ai_draft_acceptance, 'no_draft') AS key, COUNT(*)::int AS n
         FROM interpretations
        WHERE status = 'approved'
        GROUP BY 1`,
    ),
    pool.query<{ key: string | null; n: number }>(
      `SELECT status AS key, COUNT(*)::int AS n FROM interpretations GROUP BY status`,
    ),
    pool.query<{ author_id: number; n: number }>(
      `SELECT author_id, COUNT(*)::int AS n FROM interpretations WHERE author_id IS NOT NULL GROUP BY author_id`,
    ),
    pool.query<{ approver_id: number; n: number }>(
      `SELECT approver_id, COUNT(*)::int AS n
         FROM interpretations
        WHERE approver_id IS NOT NULL AND status = 'approved'
        GROUP BY approver_id`,
    ),
    pool.query<{ faculty_user_id: number; approved: boolean }>(
      `SELECT faculty_user_id, (approved_at IS NOT NULL) AS approved FROM faculty_voice_profiles`,
    ),
    pool.query<{ key: string | null; n: number }>(
      `SELECT status AS key, COUNT(*)::int AS n FROM cross_pillar_merge_requests GROUP BY status`,
    ),
    pool.query<{ total: number; distinct_questions: number }>(
      `SELECT COUNT(*)::int AS total, COUNT(DISTINCT question)::int AS distinct_questions
         FROM agent_queries
        WHERE was_uncovered = TRUE
          AND created_at >= NOW() - make_interval(days => $1::int)`,
      [COVERAGE_GAP_WINDOW_DAYS],
    ),
    pool.query<{ total: number; covered: number }>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE was_uncovered = FALSE)::int AS covered
         FROM agent_queries`,
    ),
    pool.query<{ date: string; n: number }>(
      `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date,
              COUNT(*)::int AS n
         FROM agent_queries
        WHERE created_at >= NOW() - make_interval(days => $1::int)
        GROUP BY 1
        ORDER BY 1`,
      [QUERY_VOLUME_WINDOW_DAYS],
    ),
    pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM palonur_users`),
    pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM palonur_waitlist`),
    pool.query<{ key: string | null; n: number }>(
      `SELECT status AS key, COUNT(*)::int AS n FROM newsletter_subscribers GROUP BY status`,
    ),
    pool.query<{ total: number; would_pay: number }>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE would_pay = TRUE)::int AS would_pay
         FROM sleepzeit_intents`,
    ),
    pool.query<{ label: string; n: number }>(
      `SELECT price_label AS label, COUNT(*)::int AS n
         FROM sleepzeit_intents
        WHERE would_pay = TRUE
        GROUP BY price_label
        ORDER BY n DESC`,
    ),
    pool.query<{
      name: string;
      completed_at: string | null;
      citation_verified_rate: number | null;
      coverage_rate: number | null;
      refusal_compliance_rate: number | null;
      uncovered_honesty_rate: number | null;
      median_latency_ms: number | null;
    }>(
      `SELECT name, completed_at, citation_verified_rate, coverage_rate,
              refusal_compliance_rate, uncovered_honesty_rate, median_latency_ms
         FROM eval_runs
        WHERE completed_at IS NOT NULL
        ORDER BY completed_at DESC
        LIMIT 1`,
    ),
    getSubscriptionRevenue(),
    getLifetimeRevenueCents(),
    getNewsletterRevenue(),
  ]);

  // ── Pillars ───────────────────────────────────────────────────────────────
  const approvedSourceMap = new Map(
    approvedSourceByPillar.rows.map((r) => [r.pillar_id, r.n]),
  );
  const approvedInterpMap = new Map(
    approvedInterpByPillar.rows.map((r) => [r.pillar_id, r.n]),
  );
  const questionsMap = new Map(
    questionsByPillar.rows.map((r) => [r.pillar_id, r.n]),
  );
  // Steward names per pillar from the shared roster (role === 'steward').
  const stewardsByPillar = new Map<string, string[]>();
  for (const m of roster) {
    const name = m.fullName ?? m.email;
    for (const mem of m.memberships) {
      if (mem.role === "steward") {
        const arr = stewardsByPillar.get(mem.pillarSlug) ?? [];
        arr.push(name);
        stewardsByPillar.set(mem.pillarSlug, arr);
      }
    }
  }
  const pillars = pillarOverview.map((p) => ({
    slug: p.slug,
    name: p.name,
    description: p.description,
    retired: p.retiredAt != null,
    stewards: stewardsByPillar.get(p.slug) ?? [],
    facultyCount: p.facultyCount,
    approvedSources: approvedSourceMap.get(p.id) ?? 0,
    approvedInterpretations: approvedInterpMap.get(p.id) ?? 0,
    questionVolume: questionsMap.get(p.id) ?? 0,
  }));

  // ── Stewards roster ─────────────────────────────────────────────────────────
  const authoredMap = new Map(
    interpByAuthorRows.rows.map((r) => [r.author_id, r.n]),
  );
  const approvedByMap = new Map(
    interpByApproverRows.rows.map((r) => [r.approver_id, r.n]),
  );
  const voiceMap = new Map<number, "approved" | "draft">(
    voiceRows.rows.map((r) => [
      r.faculty_user_id,
      r.approved ? "approved" : "draft",
    ]),
  );
  const stewards = roster.map((m: RosterMember) => ({
    name: m.fullName ?? m.email,
    institution: m.institution,
    isPlatformAdmin: m.isPlatformAdmin,
    onboarded: m.onboardedAt != null,
    voiceProfile: voiceMap.get(m.id) ?? ("none" as const),
    roles: m.memberships.map((mem) => ({
      pillar: mem.pillarName,
      role: mem.role,
    })),
    interpretationsAuthored: authoredMap.get(m.id) ?? 0,
    interpretationsApproved: approvedByMap.get(m.id) ?? 0,
  }));

  // ── KPIs ────────────────────────────────────────────────────────────────────
  const sourcesByStatus = toCountMap(sourcesByStatusRows.rows);
  const interpretationsByStatus = toCountMap(interpByStatusRows.rows);
  const activePillars = pillarOverview.filter((p) => p.retiredAt == null).length;
  const retiredPillars = pillarOverview.length - activePillars;
  const onboardedStewards = roster.filter((m) => m.onboardedAt != null).length;
  const queryTotals = queryTotalsRow.rows[0] ?? { total: 0, covered: 0 };
  const coverageRatePct =
    queryTotals.total > 0
      ? Math.round((queryTotals.covered / queryTotals.total) * 1000) / 10
      : null;
  const latestEval = latestEvalRunRows.rows[0] ?? null;

  // ── Draft acceptance ────────────────────────────────────────────────────────
  const da = toCountMap(draftAcceptanceRows.rows);
  const daUnedited = da.unedited ?? 0;
  const daLight = da.light ?? 0;
  const daRewritten = da.rewritten ?? 0;
  const daNoDraft = da.no_draft ?? 0;

  // ── Citation health (from latest completed eval run's items) ─────────────────
  let citationHealth = {
    verified: 0,
    unmatched: 0,
    missing: 0,
    verifiedRate: null as number | null,
  };
  {
    const cv = toCountMap(
      (
        await pool.query<{ key: string | null; n: number }>(
          `SELECT citation_verification AS key, COUNT(*)::int AS n
             FROM eval_items
            WHERE run_id = (
              SELECT id FROM eval_runs WHERE completed_at IS NOT NULL
               ORDER BY completed_at DESC LIMIT 1
            )
              AND citation_verification IS NOT NULL
            GROUP BY 1`,
        )
      ).rows,
    );
    const verified = cv.verified ?? 0;
    const unmatched = cv.unmatched ?? 0;
    const missing = cv.missing ?? 0;
    const denom = verified + unmatched + missing;
    citationHealth = {
      verified,
      unmatched,
      missing,
      verifiedRate: denom > 0 ? verified / denom : null,
    };
  }

  const reliability = reliabilityRow.rows[0] ?? {
    rigor_avg: null,
    rigor_n: 0,
    repro_avg: null,
    repro_n: 0,
    openness_avg: null,
    openness_n: 0,
    assessed: 0,
    approved_assessments: 0,
  };

  const crossPillar = toCountMap(crossPillarRows.rows);
  const coverageGap = coverageGapRow.rows[0] ?? {
    total: 0,
    distinct_questions: 0,
  };
  const newsletterByStatus = toCountMap(newsletterRows.rows);
  const wtpTotals = wtpTotalsRow.rows[0] ?? { total: 0, would_pay: 0 };

  return {
    generatedAt: new Date().toISOString(),
    kpis: {
      activePillars,
      retiredPillars,
      onboardedStewards,
      totalFaculty: roster.length,
      approvedSources: sourcesByStatus.approved ?? 0,
      approvedInterpretations: interpretationsByStatus.approved ?? 0,
      questionsAnswered: queryTotals.total,
      coverageRatePct,
      citationVerifiedRate: latestEval?.citation_verified_rate ?? null,
    },
    pillars,
    stewards,
    governance: {
      sourcesByStatus,
      sourcesByKind: toCountMap(sourcesByKindRows.rows),
      reliability: {
        rigor: { avg: reliability.rigor_avg, scored: reliability.rigor_n },
        reproducibility: {
          avg: reliability.repro_avg,
          scored: reliability.repro_n,
        },
        openness: {
          avg: reliability.openness_avg,
          scored: reliability.openness_n,
        },
        assessed: reliability.assessed,
        approvedAssessments: reliability.approved_assessments,
      },
      draftAcceptance: {
        total: daUnedited + daLight + daRewritten + daNoDraft,
        withDraft: daUnedited + daLight + daRewritten,
        unedited: daUnedited,
        light: daLight,
        rewritten: daRewritten,
        noDraft: daNoDraft,
      },
      interpretationsByStatus,
      citationHealth,
      coverageGaps: {
        windowDays: COVERAGE_GAP_WINDOW_DAYS,
        totalUncovered: coverageGap.total,
        distinctQuestions: coverageGap.distinct_questions,
      },
      crossPillarAdoptions: {
        proposed: crossPillar.proposed ?? 0,
        approved: crossPillar.approved ?? 0,
        declined: crossPillar.declined ?? 0,
      },
      evalQuality: latestEval
        ? {
            runName: latestEval.name,
            completedAt: latestEval.completed_at,
            citationVerifiedRate: latestEval.citation_verified_rate,
            coverageRate: latestEval.coverage_rate,
            refusalComplianceRate: latestEval.refusal_compliance_rate,
            uncoveredHonestyRate: latestEval.uncovered_honesty_rate,
            medianLatencyMs: latestEval.median_latency_ms,
          }
        : null,
    },
    demand: {
      signups: signupsRow.rows[0]?.n ?? 0,
      waitlist: waitlistRow.rows[0]?.n ?? 0,
      newsletterSubscribers: {
        active: newsletterByStatus.active ?? 0,
        total: Object.values(newsletterByStatus).reduce((a, b) => a + b, 0),
      },
      willingnessToPay: {
        total: wtpTotals.total,
        wouldPay: wtpTotals.would_pay,
        byPrice: wtpByPriceRows.rows.map((r) => ({
          label: r.label,
          count: r.n,
        })),
      },
      queryVolume: queryVolumeRows.rows.map((r) => ({
        date: r.date,
        count: r.n,
      })),
    },
    revenue: {
      activeSubscriptions: subscriptionRevenue.activeSubscriptions,
      payingCustomers: subscriptionRevenue.payingCustomers,
      mrrCents: subscriptionRevenue.mrrCents,
      currency: subscriptionRevenue.currency,
      byProduct: subscriptionRevenue.byProduct,
      lifetimeRevenueCents,
      newsletterMrrCents: newsletterRevenue.mrrCents,
      newsletterPayingCustomers: newsletterRevenue.paidCustomers,
      consumerPlanPriceCents: CONSUMER_PLAN_PRICE_CENTS,
    },
  };
}
