import { getUncachableStripeClient } from "./lib/stripeClient.js";

/**
 * Seeds the Palonur subscription products + monthly/annual recurring prices in
 * Stripe. Products are keyed by metadata.palonur_plan (the value the
 * server's capability layer maps to capabilities):
 *
 *   premium       → Nightly sleep agent                     ($9 / mo)
 *   newsletter    → SLM premium newsletters                 ($9 / mo)
 *   all_access    → everything above (top tier)             ($19 / mo)
 *
 * Idempotent: identifies each product by metadata.palonur_plan and reuses
 * existing recurring prices that match the target amount + interval. Bumping an
 * amount here creates a NEW price (Stripe prices are immutable); archive the old
 * price in the Stripe dashboard if you don't want both active.
 *
 * Run with: pnpm --filter @workspace/scripts run seed-stripe-products
 */

const PRODUCT_METADATA_KEY = "palonur_plan";
const CURRENCY = "usd";

// Individual per-tool plans are all $9/mo ($90/yr). Each unlocks ONE capability.
const INDIVIDUAL_MONTHLY = 900; // $9.00 / month
const INDIVIDUAL_ANNUAL = 9000; // $90.00 / year

// Sleep-agent "Nightly" plan (legacy metadata value "premium" → nightly cap).
const PREMIUM_VALUE = "premium";

// SLM "Wellness Journey" paid newsletter plan. The newsletter entitlement check
// (lib/newsletterBilling.ts) filters synced subscriptions by this product's
// metadata.palonur_plan === "newsletter".
const NEWSLETTER_VALUE = "newsletter";

// Top-tier bundle: unlocks every AI tool + every newsletter. Mapped to all
// capabilities by lib/consumerAuth.ts (ALL_ACCESS_PLAN_KEY = "all_access").
const ALL_ACCESS_VALUE = "all_access";
const ALL_ACCESS_MONTHLY = 1900; // $19.00 / month
const ALL_ACCESS_ANNUAL = 19000; // $190.00 / year

async function seedProduct(args: {
  metadataValue: string;
  name: string;
  description: string;
  monthly: number;
  /** Omit for monthly-only plans (no annual price is seeded). */
  annual?: number;
}): Promise<void> {
  const stripe = await getUncachableStripeClient();

  // 1. Find or create the product (identified by metadata.palonur_plan).
  const search = await stripe.products.search({
    query: `metadata['${PRODUCT_METADATA_KEY}']:'${args.metadataValue}'`,
  });

  let product = search.data[0];
  if (product) {
    console.log(`Product already exists: ${product.name} (${product.id})`);
  } else {
    product = await stripe.products.create({
      name: args.name,
      description: args.description,
      metadata: { [PRODUCT_METADATA_KEY]: args.metadataValue },
    });
    console.log(`Created product: ${product.name} (${product.id})`);
  }

  // 2. Ensure a recurring price exists for each interval.
  const existingPrices = await stripe.prices.list({
    product: product.id,
    active: true,
    limit: 100,
  });

  async function ensurePrice(interval: "month" | "year", amount: number) {
    const match = existingPrices.data.find(
      (p) =>
        p.type === "recurring" &&
        p.recurring?.interval === interval &&
        p.unit_amount === amount &&
        p.currency === CURRENCY,
    );
    if (match) {
      console.log(
        `Price already exists: ${interval} $${(amount / 100).toFixed(2)} (${match.id})`,
      );
      return match;
    }
    const created = await stripe.prices.create({
      product: product!.id,
      unit_amount: amount,
      currency: CURRENCY,
      recurring: { interval },
      metadata: { palonur_plan: args.metadataValue },
    });
    console.log(
      `Created price: ${interval} $${(amount / 100).toFixed(2)} (${created.id})`,
    );
    return created;
  }

  await ensurePrice("month", args.monthly);
  if (args.annual != null) await ensurePrice("year", args.annual);
}

/**
 * Hidden (non-storefront) prices — mirror of HIDDEN_PRICES in
 * artifacts/api-server/src/lib/stripeProductSeed.ts (keep the two in sync).
 * metadata.hidden="true" keeps them off every public plan listing; the
 * lookup_key lets /billing/checkout resolve them by name in any mode.
 */
const HIDDEN_PRICES = [
  {
    productMetadataValue: PREMIUM_VALUE,
    lookupKey: "nightly-sponsored-11",
    interval: "month" as const,
    amount: 1100, // $11.00 / month
    nickname: "Nightly — sponsored pilot ($11/mo)",
    cohort: "sponsored-pilot",
  },
];

async function seedHiddenPrices(): Promise<void> {
  const stripe = await getUncachableStripeClient();
  for (const hp of HIDDEN_PRICES) {
    const held = await stripe.prices.list({
      lookup_keys: [hp.lookupKey],
      limit: 1,
    });
    if (held.data[0]) {
      console.log(
        `Hidden price already exists: ${hp.lookupKey} (${held.data[0].id})`,
      );
      continue;
    }
    const search = await stripe.products.search({
      query: `metadata['${PRODUCT_METADATA_KEY}']:'${hp.productMetadataValue}'`,
    });
    const product = search.data[0];
    if (!product) {
      console.error(
        `Cannot seed hidden price ${hp.lookupKey}: no product with ${PRODUCT_METADATA_KEY}='${hp.productMetadataValue}'`,
      );
      continue;
    }
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
    console.log(
      `Created hidden price: ${hp.lookupKey} $${(hp.amount / 100).toFixed(2)}/${hp.interval} (${created.id})`,
    );
  }
}

async function seed() {
  await seedProduct({
    metadataValue: PREMIUM_VALUE,
    name: "Palonur Nightly",
    description:
      "Unlimited evidence-based sleep answers grounded in Stanford research.",
    monthly: INDIVIDUAL_MONTHLY,
    annual: INDIVIDUAL_ANNUAL,
  });

  await seedProduct({
    metadataValue: NEWSLETTER_VALUE,
    name: "Palonur Newsletter Premium",
    description:
      "Full access to premium issues of the Stanford Lifestyle Medicine Wellness Journey newsletter.",
    monthly: INDIVIDUAL_MONTHLY,
    annual: INDIVIDUAL_ANNUAL,
  });

  await seedProduct({
    metadataValue: ALL_ACCESS_VALUE,
    name: "Palonur All-Access",
    description:
      "Everything Palonur offers: unlimited answers from every AI tool plus full access to every premium newsletter.",
    monthly: ALL_ACCESS_MONTHLY,
    annual: ALL_ACCESS_ANNUAL,
  });

  await seedHiddenPrices();

  console.log("✓ Stripe products and prices are seeded.");
}

seed().catch((err) => {
  console.error("Failed to seed Stripe products:", err);
  process.exit(1);
});
