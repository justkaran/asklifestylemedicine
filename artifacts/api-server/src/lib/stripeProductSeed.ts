import type Stripe from "stripe";
import { getUncachableStripeClient } from "./stripeClient";
import { logger } from "./logger";

/**
 * Best-effort, idempotent boot seed for the Palonur subscription catalog in
 * Stripe.
 *
 * Stripe products live in a specific account/mode (test vs. live). The Replit
 * connector hands out a sandbox/test key in development and a live key only in
 * production (via the Publish pane), so a product created against the dev
 * test-mode key never appears in the production live-mode account. Publishing
 * does NOT copy Stripe products across modes — they are separate accounts
 * This boot seed runs inside initStripe() with whatever key the current
 * environment holds, so in production it idempotently creates the missing
 * live-mode products + recurring prices. The standalone
 * `scripts/src/seed-stripe-products.ts` keeps the same definitions for manual
 * runs; keep the two PRODUCTS lists in sync.
 *
 * Idempotency: each product is identified by metadata.palonur_plan and each
 * recurring price by (interval, amount, currency). We look products/prices up
 * via list() (immediately consistent) rather than search() (eventually
 * consistent) so a restart shortly after the first seed never duplicates rows.
 * Bumping an amount creates a NEW price (Stripe prices are immutable); archive
 * the old one in the dashboard if you don't want both active.
 */

const PRODUCT_METADATA_KEY = "palonur_plan";
const CURRENCY = "usd";

const INDIVIDUAL_MONTHLY = 900; // $9.00 / month  (newsletter only)
const INDIVIDUAL_ANNUAL = 9000; // $90.00 / year  (newsletter only)
const NIGHTLY_MONTHLY = 4900; // $49.00 / month
const NIGHTLY_ANNUAL = 7900; // $79.00 / year
const ALL_ACCESS_MONTHLY = 1900; // $19.00 / month
const ALL_ACCESS_ANNUAL = 19000; // $190.00 / year

interface SeedProduct {
  metadataValue: string;
  name: string;
  description: string;
  monthly: number;
  /** Omit for monthly-only plans (no annual price is seeded). */
  annual?: number;
  /**
   * When true, any OTHER active public recurring price on this product is
   * archived (deactivated) at boot — used after a reprice so the plan listing
   * can never surface a superseded amount or a stale annual option. Archived
   * prices keep billing existing subscriptions (that's how grandfathering
   * works); hidden and lookup-key prices are never touched.
   */
  archiveSupersededPrices?: boolean;
}

const PRODUCTS: SeedProduct[] = [
  {
    metadataValue: "premium",
    name: "Palonur Pal",
    description:
      "Unlimited evidence-based answers across all pillars, grounded in Stanford research.",
    monthly: NIGHTLY_MONTHLY,
    annual: NIGHTLY_ANNUAL,
  },
  {
    metadataValue: "newsletter",
    name: "Palonur Newsletter Premium",
    description:
      "Full access to premium issues of the Stanford Lifestyle Medicine Wellness Journey newsletter.",
    monthly: INDIVIDUAL_MONTHLY,
    annual: INDIVIDUAL_ANNUAL,
  },
  {
    metadataValue: "all_access",
    name: "Palonur All-Access",
    description:
      "One subscription covering every supported pillar and every premium newsletter.",
    monthly: ALL_ACCESS_MONTHLY,
    annual: ALL_ACCESS_ANNUAL,
    archiveSupersededPrices: true,
  },
];

/**
 * Hidden (non-storefront) prices. These bill real money but never appear on the
 * public plan listings — /billing/plans and getNewsletterPlans() both filter out
 * prices carrying metadata.hidden="true". Each has a lookup_key so checkout can
 * resolve it by name in ANY mode (test vs. live price ids differ, but the
 * lookup key is what we control in both).
 *
 * "nightly-sponsored-11": $11/mo Pal for the sponsored pilot cohort — a
 * sponsor pays each member's subscription with their own card via per-member
 * checkout links (see scripts/src/mint-sponsored-checkouts.ts). Kept off the
 * storefront so the public Pal tier stays at the seeded $9/mo.
 */
interface HiddenPrice {
  /** Which PRODUCTS entry (metadata.palonur_plan) the price belongs to. */
  productMetadataValue: string;
  lookupKey: string;
  interval: "month" | "year";
  amount: number;
  nickname: string;
  cohort: string;
}

const HIDDEN_PRICES: HiddenPrice[] = [
  {
    productMetadataValue: "premium",
    lookupKey: "nightly-sponsored-11",
    interval: "month",
    amount: 1100, // $11.00 / month
    nickname: "Pal — sponsored pilot ($11/mo)",
    cohort: "sponsored-pilot",
  },
];

/**
 * Beta-testing prices. Shown on the /apply page only — not on the public
 * storefront. Billed as recurring every-90-days subscriptions so access
 * auto-expires if the user doesn't renew (which they won't — it's a fixed
 * cohort). Idempotent by lookup_key same as HIDDEN_PRICES.
 */
interface BetaPrice {
  productMetadataValue: string;
  lookupKey: string;
  amount: number;
  nickname: string;
  recurring: { interval: "day" | "month" | "year"; intervalCount: number };
}

const BETA_PRICES: BetaPrice[] = [
  {
    productMetadataValue: "all_access",
    lookupKey: "beta-all-access-90d",
    amount: 1100, // $11.00 every 90 days
    nickname: "Beta Testing — All-Access $11 / 90 days",
    recurring: { interval: "day", intervalCount: 90 },
  },
];

/**
 * Journey Pass prices. The current offering is a $49 auto-renewing
 * every-90-days subscription granting unlimited questions until the user
 * presses "I've found my answer" (which stops renewal). Kept off
 * the storefront (metadata.hidden="true") but resolv­able by lookup_key so
 * /api/journey/checkout can create a Stripe checkout session without
 * hard-coding a mode-specific price ID. Legacy entries are type="one_time";
 * the current Journey Pass entries are recurring every-90-days prices.
 */
interface JourneyPrice {
  productMetadataValue: string;
  lookupKey: string;
  amount: number;
  nickname: string;
  /**
   * When set, the price is created as a recurring subscription price (e.g.
   * every 90 days). When absent it is a legacy one-time price. Existing
   * legacy prices are left in place so old checkout sessions/records stay
   * resolvable, but new checkouts only use the recurring lookup keys.
   */
  recurring?: { interval: "day" | "month" | "year"; intervalCount: number };
}

const JOURNEY_PRICES: JourneyPrice[] = [
  // Legacy one-time passes — no longer offered for new checkouts, kept so the
  // lookup keys stay held (never re-create or transfer a lookup key).
  {
    productMetadataValue: "premium",
    lookupKey: "journey-sleep",
    amount: 4900, // $49.00 one-time (legacy)
    nickname: "Sleep Journey — one-time $49 (legacy)",
  },
  // Auto-renewing Journey Pass — $49 billed every 90 days. These are the
  // prices /api/journey/checkout uses for new subscriptions.
  {
    productMetadataValue: "premium",
    lookupKey: "journey-sleep-90d",
    amount: 4900, // $49.00 every 90 days
    nickname: "Sleep Journey Pass — $49 every 90 days",
    recurring: { interval: "day", intervalCount: 90 },
  },
];

/**
 * Ensure all Palonur subscription products + monthly/annual prices exist in the
 * currently connected Stripe account. Returns a small summary for logging. Never
 * throws on a single product failure — it logs and continues so one bad call
 * can't leave the catalog half-seeded or block boot.
 */
export async function seedStripeProducts(): Promise<{
  productsCreated: number;
  pricesCreated: number;
}> {
  const stripe = await getUncachableStripeClient();

  // Pull ALL existing products (immediately consistent, unlike search()).
  // Auto-paginate so idempotency holds even if the account exceeds one page.
  const existingProducts: Stripe.Product[] = [];
  for await (const p of stripe.products.list({ active: true, limit: 100 })) {
    existingProducts.push(p);
  }

  let productsCreated = 0;
  let pricesCreated = 0;

  for (const spec of PRODUCTS) {
    try {
      let product = existingProducts.find(
        (p) => p.metadata?.[PRODUCT_METADATA_KEY] === spec.metadataValue,
      );

      if (!product) {
        product = await stripe.products.create({
          name: spec.name,
          description: spec.description,
          metadata: { [PRODUCT_METADATA_KEY]: spec.metadataValue },
        });
        productsCreated += 1;
        logger.info(
          { product: product.id, plan: spec.metadataValue },
          "Created Stripe product",
        );
      } else if (
        product.name !== spec.name ||
        (product.description ?? "") !== spec.description
      ) {
        // Keep configured product display metadata current without changing
        // product ids, prices, lookup keys, or existing subscriptions.
        product = await stripe.products.update(product.id, {
          name: spec.name,
          description: spec.description,
        });
        logger.info(
          { product: product.id, plan: spec.metadataValue, name: spec.name },
          "Renamed Stripe product in place",
        );
      }

      const existingPrices = await stripe.prices.list({
        product: product.id,
        active: true,
        limit: 100,
      });

      const targetIntervals: Array<["month" | "year", number]> = [
        ["month", spec.monthly],
      ];
      if (spec.annual != null) targetIntervals.push(["year", spec.annual]);

      for (const [interval, amount] of targetIntervals) {
        const match = existingPrices.data.find(
          (p) =>
            p.type === "recurring" &&
            p.recurring?.interval === interval &&
            p.unit_amount === amount &&
            p.currency === CURRENCY,
        );
        if (match) continue;
        const created = await stripe.prices.create({
          product: product.id,
          unit_amount: amount,
          currency: CURRENCY,
          recurring: { interval },
          metadata: { [PRODUCT_METADATA_KEY]: spec.metadataValue },
        });
        pricesCreated += 1;
        logger.info(
          { price: created.id, plan: spec.metadataValue, interval, amount },
          "Created Stripe price",
        );
      }

      // Archive superseded public prices after a reprice. /billing/plans dedups
      // to the newest price per (product, interval), but an active OLD annual
      // price would still surface an annual option — so retired amounts must be
      // deactivated, not just superseded. Deactivating a price never cancels or
      // migrates subscriptions billing on it (grandfathering). Hidden and
      // lookup-key prices (sponsored, journey) are explicitly skipped.
      if (spec.archiveSupersededPrices) {
        for (const p of existingPrices.data) {
          if (p.type !== "recurring") continue;
          if (p.lookup_key) continue;
          if (p.metadata?.hidden === "true") continue;
          const isTarget = targetIntervals.some(
            ([interval, amount]) =>
              p.recurring?.interval === interval &&
              p.unit_amount === amount &&
              p.currency === CURRENCY,
          );
          if (isTarget) continue;
          await stripe.prices.update(p.id, { active: false });
          logger.info(
            {
              price: p.id,
              plan: spec.metadataValue,
              interval: p.recurring?.interval,
              amount: p.unit_amount,
            },
            "Archived superseded Stripe price",
          );
        }
      }

      // Hidden recurring prices for this product, idempotent by lookup_key (a
      // lookup key can only ever be held by one price, so a plain existence
      // check is the reliable identity — never re-create or transfer).
      for (const hp of HIDDEN_PRICES) {
        if (hp.productMetadataValue !== spec.metadataValue) continue;
        const held = await stripe.prices.list({
          lookup_keys: [hp.lookupKey],
          limit: 1,
        });
        if (held.data[0]) continue;
        const created = await stripe.prices.create({
          product: product.id,
          unit_amount: hp.amount,
          currency: CURRENCY,
          recurring: { interval: hp.interval },
          lookup_key: hp.lookupKey,
          nickname: hp.nickname,
          metadata: {
            [PRODUCT_METADATA_KEY]: hp.productMetadataValue,
            hidden: "true",
            cohort: hp.cohort,
          },
        });
        pricesCreated += 1;
        logger.info(
          {
            price: created.id,
            plan: hp.productMetadataValue,
            lookupKey: hp.lookupKey,
            amount: hp.amount,
          },
          "Created hidden Stripe price",
        );
      }

      // Journey prices — legacy entries are one-time (no `recurring`),
      // current entries are recurring every-90-days subscriptions.
      // Idempotent by lookup_key same as HIDDEN_PRICES above.
      for (const jp of JOURNEY_PRICES) {
        if (jp.productMetadataValue !== spec.metadataValue) continue;
        const held = await stripe.prices.list({
          lookup_keys: [jp.lookupKey],
          limit: 1,
        });
        if (held.data[0]) continue;
        const created = await stripe.prices.create({
          product: product.id,
          unit_amount: jp.amount,
          currency: CURRENCY,
          lookup_key: jp.lookupKey,
          nickname: jp.nickname,
          ...(jp.recurring
            ? {
                recurring: {
                  interval: jp.recurring.interval,
                  interval_count: jp.recurring.intervalCount,
                },
              }
            : {}),
          metadata: {
            [PRODUCT_METADATA_KEY]: jp.productMetadataValue,
            hidden: "true",
            journey: "true",
          },
        });
        pricesCreated += 1;
        logger.info(
          {
            price: created.id,
            plan: jp.productMetadataValue,
            lookupKey: jp.lookupKey,
            amount: jp.amount,
          },
          "Created journey Stripe price",
        );
      }

      // Beta-testing prices — hidden 90-day recurring prices for /apply.
      // Idempotent by lookup_key same as HIDDEN_PRICES above.
      for (const bp of BETA_PRICES) {
        if (bp.productMetadataValue !== spec.metadataValue) continue;
        const held = await stripe.prices.list({
          lookup_keys: [bp.lookupKey],
          limit: 1,
        });
        if (held.data[0]) continue;
        const created = await stripe.prices.create({
          product: product.id,
          unit_amount: bp.amount,
          currency: CURRENCY,
          lookup_key: bp.lookupKey,
          nickname: bp.nickname,
          recurring: {
            interval: bp.recurring.interval,
            interval_count: bp.recurring.intervalCount,
          },
          metadata: {
            [PRODUCT_METADATA_KEY]: bp.productMetadataValue,
            hidden: "true",
            beta: "true",
          },
        });
        pricesCreated += 1;
        logger.info(
          {
            price: created.id,
            plan: bp.productMetadataValue,
            lookupKey: bp.lookupKey,
            amount: bp.amount,
          },
          "Created beta Stripe price",
        );
      }
    } catch (err) {
      logger.error(
        { err, plan: spec.metadataValue },
        "Failed to seed Stripe product (continuing)",
      );
    }
  }

  return { productsCreated, pricesCreated };
}
