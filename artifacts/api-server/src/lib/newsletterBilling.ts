import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

/**
 * Read-time entitlement + revenue derivation for the paid newsletter tier.
 *
 * As with the consumer sleep-agent tier, paid status is NEVER stored locally —
 * it is derived from the Stripe-synced tables (`stripe.subscriptions` etc.,
 * kept current by the Stripe webhook → stripe-replit-sync). A subscriber is
 * "paid" when their Stripe customer has an active/trialing subscription to the
 * newsletter product, identified by `products.metadata.palonur_plan`.
 *
 * Every query degrades gracefully: if the `stripe` schema doesn't exist yet
 * (Stripe not connected / dev) we return empty/zero rather than throwing, so
 * the newsletter keeps working as a free-only product.
 */

export const NEWSLETTER_PLAN_KEY = "newsletter";

// Paid newsletter ACCESS is granted by the dedicated newsletter plan plus the
// top-tier all-access bundle (`palonur_plan IN ('newsletter','all_access')` in
// getPaidNewsletterCustomerIds). `getNewsletterRevenue` and `getNewsletterPlans`
// intentionally stay newsletter-only so all-access revenue/plan listings aren't
// misattributed to the newsletter line.

export interface NewsletterPlan {
  productId: string;
  priceId: string;
  name: string | null;
  description: string | null;
  unitAmount: number | null;
  currency: string | null;
  interval: string | null;
  plan: "monthly" | "annual" | null;
}

interface PlanRow {
  product_id: string;
  name: string | null;
  description: string | null;
  price_id: string;
  unit_amount: number | null;
  currency: string | null;
  interval: string | null;
}

/** Active recurring prices for the newsletter product, cheapest first. */
export async function getNewsletterPlans(): Promise<NewsletterPlan[]> {
  try {
    const result = await db.execute(sql`
      SELECT prod.id AS product_id,
             prod.name AS name,
             prod.description AS description,
             pr.id AS price_id,
             pr.unit_amount AS unit_amount,
             pr.currency AS currency,
             pr.recurring->>'interval' AS interval
      FROM stripe.prices pr
      JOIN stripe.products prod ON prod.id = pr.product
      WHERE pr.active = true
        AND prod.active = true
        AND pr.type = 'recurring'
        AND COALESCE(pr.metadata->>'hidden', '') <> 'true'
        AND prod.metadata->>'palonur_plan' = ${NEWSLETTER_PLAN_KEY}
      ORDER BY pr.unit_amount ASC NULLS LAST
    `);
    const rows = result.rows as unknown as PlanRow[];
    return rows.map((r) => ({
      productId: r.product_id,
      priceId: r.price_id,
      name: r.name,
      description: r.description,
      unitAmount: r.unit_amount,
      currency: r.currency,
      interval: r.interval,
      plan:
        r.interval === "year"
          ? "annual"
          : r.interval === "month"
            ? "monthly"
            : null,
    }));
  } catch (err) {
    logger.warn({ err }, "Could not list newsletter plans");
    return [];
  }
}

/** True if `priceId` is one of the active newsletter prices. */
export async function isNewsletterPrice(priceId: string): Promise<boolean> {
  const plans = await getNewsletterPlans();
  return plans.some((p) => p.priceId === priceId);
}

/**
 * The set of Stripe customer ids that currently hold an active/trialing
 * subscription to the newsletter product. Used to split the send list into
 * paid vs free, and to count paid subscribers in the admin.
 */
export async function getPaidNewsletterCustomerIds(): Promise<Set<string>> {
  try {
    const result = await db.execute(sql`
      SELECT DISTINCT s.customer AS customer
      FROM stripe.subscriptions s
      JOIN stripe.subscription_items si ON si.subscription = s.id
      JOIN stripe.prices p ON p.id = si.price
      JOIN stripe.products prod ON prod.id = p.product
      WHERE s.status IN ('active', 'trialing')
        AND prod.metadata->>'palonur_plan' IN ('newsletter', 'all_access')
        AND s.customer IS NOT NULL
    `);
    const rows = result.rows as unknown as { customer: string }[];
    return new Set(rows.map((r) => r.customer));
  } catch (err) {
    logger.warn({ err }, "Could not derive paid newsletter customers");
    return new Set();
  }
}

interface RevenueRow {
  unit_amount: number | null;
  currency: string | null;
  interval: string | null;
}

export interface NewsletterRevenue {
  /** Distinct paying customers (active/trialing newsletter subscriptions). */
  paidCustomers: number;
  /** Monthly recurring revenue in cents (annual plans normalized /12). */
  mrrCents: number;
  currency: string;
}

/** Simple MRR + paying-customer count across active newsletter subscriptions. */
export async function getNewsletterRevenue(): Promise<NewsletterRevenue> {
  try {
    const result = await db.execute(sql`
      SELECT p.unit_amount AS unit_amount,
             p.currency AS currency,
             p.recurring->>'interval' AS interval
      FROM stripe.subscriptions s
      JOIN stripe.subscription_items si ON si.subscription = s.id
      JOIN stripe.prices p ON p.id = si.price
      JOIN stripe.products prod ON prod.id = p.product
      WHERE s.status IN ('active', 'trialing')
        AND prod.metadata->>'palonur_plan' = ${NEWSLETTER_PLAN_KEY}
    `);
    const rows = result.rows as unknown as RevenueRow[];
    let mrrCents = 0;
    let currency = "usd";
    for (const r of rows) {
      const amount = r.unit_amount ?? 0;
      if (r.interval === "year") mrrCents += Math.round(amount / 12);
      else if (r.interval === "week") mrrCents += amount * 4;
      else mrrCents += amount; // month (and any other) treated as monthly
      if (r.currency) currency = r.currency;
    }
    return { paidCustomers: rows.length, mrrCents, currency };
  } catch (err) {
    logger.warn({ err }, "Could not compute newsletter revenue");
    return { paidCustomers: 0, mrrCents: 0, currency: "usd" };
  }
}
