/**
 * Paid steward Q&A subscriptions — Stripe catalog, entitlement, and the 80/20
 * earnings ledger.
 *
 * Each ask-eligible steward publication (see `stewardAsk.ts`) gets its own
 * $9/month Stripe product, auto-provisioned by the boot seed below. Products
 * are identified by metadata:
 *
 *   palonur_plan             = "steward"           (the family key)
 *   palonur_publication_id   = "<publication id>"  (the stable identity)
 *   palonur_publication_slug = "<slug>"            (informational only)
 *
 * The PUBLICATION ID (immutable) — not the slug (editable) — is the identity
 * that entitlement and the ledger key on, so renaming a publication slug never
 * strands existing subscribers. The monthly price carries lookup_key
 * `steward-pub-<id>-monthly` so checkout can target it in ANY Stripe mode.
 *
 * Entitlement follows the house pattern: NEVER stored locally, derived at read
 * time from the synced `stripe.subscriptions` mirror. Individual tiers don't
 * cascade — All-Access deliberately does NOT include steward Q&A products.
 *
 * The earnings ledger mints one `steward_earnings` row per PAID Stripe invoice
 * (80% steward / 20% Palonur, remainder to Palonur so the split always sums).
 * Minting is lazy (runs on earnings reads) and idempotent via the unique index
 * on `stripe_invoice_id` + ON CONFLICT DO NOTHING — a re-read or webhook
 * re-sync can never double-credit. It is a reimbursement record only; no money
 * moves here.
 */
import { sql, eq, and, isNotNull } from "drizzle-orm";
import {
  db,
  newsletterPublicationsTable,
  stewardEarningsTable,
} from "@workspace/db";
import type Stripe from "stripe";
import { getUncachableStripeClient } from "./stripeClient";
import { loadStewardAskEligibility } from "./stewardAsk";
import { logger } from "./logger";

export const STEWARD_PLAN_KEY = "steward";
const PUBLICATION_ID_METADATA_KEY = "palonur_publication_id";
const STEWARD_MONTHLY_CENTS = 900; // $9.00 / month
const CURRENCY = "usd";

/** Steward share of gross revenue (Palonur keeps the remainder). */
export const STEWARD_SHARE = 0.8;

/** Stable price lookup key for a steward publication's monthly plan. */
export function stewardLookupKey(publicationId: number): string {
  return `steward-pub-${publicationId}-monthly`;
}

export function splitGross(grossCents: number): {
  stewardCents: number;
  palonurCents: number;
} {
  const stewardCents = Math.round(grossCents * STEWARD_SHARE);
  return { stewardCents, palonurCents: grossCents - stewardCents };
}

// ── Boot seed ────────────────────────────────────────────────────────────────

/**
 * Idempotently ensure a $9/mo Stripe product + price exists for every
 * ask-eligible steward publication. Mirrors `seedStripeProducts` (list() not
 * search(), never throws per-publication, safe to run every boot). Runs in
 * BOTH modes so production live-mode products exist too.
 */
export async function seedStewardProducts(): Promise<{
  productsCreated: number;
  pricesCreated: number;
}> {
  let productsCreated = 0;
  let pricesCreated = 0;

  // Candidate publications: steward-owned (non-house) with an owning faculty
  // user. Eligibility (voice profile + approved material) is checked per row.
  const pubs = await db
    .select({
      id: newsletterPublicationsTable.id,
      slug: newsletterPublicationsTable.slug,
      name: newsletterPublicationsTable.name,
      facultyUserId: newsletterPublicationsTable.facultyUserId,
    })
    .from(newsletterPublicationsTable)
    .where(
      and(
        eq(newsletterPublicationsTable.isHouse, false),
        isNotNull(newsletterPublicationsTable.facultyUserId),
      ),
    );

  const eligible: typeof pubs = [];
  for (const pub of pubs) {
    try {
      const ask = await loadStewardAskEligibility(pub.facultyUserId);
      if (ask.eligible) eligible.push(pub);
    } catch (err) {
      logger.error(
        { err, publication: pub.slug },
        "Steward product seed: eligibility check failed (skipping)",
      );
    }
  }
  if (eligible.length === 0) return { productsCreated, pricesCreated };

  const stripe = await getUncachableStripeClient();
  const existingProducts: Stripe.Product[] = [];
  for await (const p of stripe.products.list({ active: true, limit: 100 })) {
    existingProducts.push(p);
  }

  for (const pub of eligible) {
    try {
      let product = existingProducts.find(
        (p) =>
          p.metadata?.palonur_plan === STEWARD_PLAN_KEY &&
          p.metadata?.[PUBLICATION_ID_METADATA_KEY] === String(pub.id),
      );
      if (!product) {
        product = await stripe.products.create({
          name: `${pub.name} — Ask the Steward`,
          description: `Unlimited questions answered from ${pub.name}'s approved research, in the steward's own voice.`,
          metadata: {
            palonur_plan: STEWARD_PLAN_KEY,
            [PUBLICATION_ID_METADATA_KEY]: String(pub.id),
            palonur_publication_slug: pub.slug,
          },
        });
        productsCreated += 1;
        logger.info(
          { product: product.id, publication: pub.slug },
          "Created steward Stripe product",
        );
      }

      // Idempotent by lookup_key — a lookup key is held by at most one price.
      const lookupKey = stewardLookupKey(pub.id);
      const held = await stripe.prices.list({
        lookup_keys: [lookupKey],
        limit: 1,
      });
      if (held.data[0]) continue;
      const created = await stripe.prices.create({
        product: product.id,
        unit_amount: STEWARD_MONTHLY_CENTS,
        currency: CURRENCY,
        recurring: { interval: "month" },
        lookup_key: lookupKey,
        metadata: {
          palonur_plan: STEWARD_PLAN_KEY,
          [PUBLICATION_ID_METADATA_KEY]: String(pub.id),
        },
      });
      pricesCreated += 1;
      logger.info(
        { price: created.id, publication: pub.slug, lookupKey },
        "Created steward Stripe price",
      );
    } catch (err) {
      logger.error(
        { err, publication: pub.slug },
        "Failed to seed steward Stripe product (continuing)",
      );
    }
  }

  return { productsCreated, pricesCreated };
}

// ── Entitlement ──────────────────────────────────────────────────────────────

/**
 * True when the Stripe customer holds an active/trialing subscription to THIS
 * publication's steward Q&A product. Never throws — resolves false when the
 * stripe schema is absent (Stripe not connected) so callers treat the reader
 * as free-tier.
 */
export async function hasStewardAccess(
  customerId: string | null,
  publicationId: number,
): Promise<boolean> {
  if (!customerId) return false;
  try {
    const result = await db.execute(sql`
      SELECT 1
      FROM stripe.subscriptions s
      JOIN stripe.subscription_items si ON si.subscription = s.id
      JOIN stripe.prices p ON p.id = si.price
      JOIN stripe.products prod ON prod.id = p.product
      WHERE s.customer = ${customerId}
        AND s.status IN ('active', 'trialing')
        AND prod.metadata->>'palonur_plan' = ${STEWARD_PLAN_KEY}
        AND prod.metadata->>${PUBLICATION_ID_METADATA_KEY} = ${String(publicationId)}
      LIMIT 1
    `);
    return result.rows.length > 0;
  } catch {
    return false;
  }
}

/** The publication a `steward` product/subscription belongs to, or null. */
export async function publicationIdForProduct(
  productId: string | null,
): Promise<number | null> {
  if (!productId) return null;
  try {
    const result = await db.execute(sql`
      SELECT prod.metadata->>${PUBLICATION_ID_METADATA_KEY} AS pub_id
      FROM stripe.products prod
      WHERE prod.id = ${productId}
        AND prod.metadata->>'palonur_plan' = ${STEWARD_PLAN_KEY}
      LIMIT 1
    `);
    const raw = (result.rows[0] as { pub_id?: string } | undefined)?.pub_id;
    const id = Number(raw);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

export interface StewardPlan {
  priceId: string;
  lookupKey: string;
  unitAmount: number | null;
  currency: string | null;
  interval: string | null;
}

/**
 * The public monthly plan for a publication's steward product (most recently
 * created active monthly price), or null when Stripe is absent / not seeded.
 */
export async function getStewardPlan(
  publicationId: number,
): Promise<StewardPlan | null> {
  try {
    const result = await db.execute(sql`
      SELECT pr.id AS price_id,
             pr.lookup_key AS lookup_key,
             pr.unit_amount AS unit_amount,
             pr.currency AS currency,
             pr.recurring->>'interval' AS interval
      FROM stripe.prices pr
      JOIN stripe.products prod ON prod.id = pr.product
      WHERE pr.active = true
        AND prod.active = true
        AND pr.type = 'recurring'
        AND prod.metadata->>'palonur_plan' = ${STEWARD_PLAN_KEY}
        AND prod.metadata->>${PUBLICATION_ID_METADATA_KEY} = ${String(publicationId)}
        AND pr.recurring->>'interval' = 'month'
      ORDER BY pr.created DESC NULLS LAST
      LIMIT 1
    `);
    const row = result.rows[0] as
      | {
          price_id: string;
          lookup_key: string | null;
          unit_amount: number | null;
          currency: string | null;
          interval: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      priceId: row.price_id,
      lookupKey: row.lookup_key ?? stewardLookupKey(publicationId),
      unitAmount: row.unit_amount,
      currency: row.currency,
      interval: row.interval,
    };
  } catch {
    return null;
  }
}

/** Active subscriber count for a publication's steward product. */
export async function countStewardSubscribers(
  publicationId: number,
): Promise<number> {
  try {
    const result = await db.execute(sql`
      SELECT COUNT(DISTINCT s.customer) AS n
      FROM stripe.subscriptions s
      JOIN stripe.subscription_items si ON si.subscription = s.id
      JOIN stripe.prices p ON p.id = si.price
      JOIN stripe.products prod ON prod.id = p.product
      WHERE s.status IN ('active', 'trialing')
        AND prod.metadata->>'palonur_plan' = ${STEWARD_PLAN_KEY}
        AND prod.metadata->>${PUBLICATION_ID_METADATA_KEY} = ${String(publicationId)}
    `);
    return Number((result.rows[0] as { n?: string } | undefined)?.n ?? 0);
  } catch {
    return 0;
  }
}

// ── Earnings ledger ──────────────────────────────────────────────────────────

/**
 * Lazily mint ledger rows for every PAID steward-product invoice not yet in
 * `steward_earnings`. Idempotent (unique stripe_invoice_id + ON CONFLICT DO
 * NOTHING). Called at read time by the earnings endpoints; never throws — an
 * absent stripe schema simply mints nothing.
 */
export async function mintStewardEarnings(): Promise<number> {
  try {
    const result = await db.execute(sql`
      INSERT INTO steward_earnings
        (stripe_invoice_id, publication_id, faculty_user_id, publication_slug,
         publication_name, steward_name, gross_cents, steward_cents,
         palonur_cents, currency, invoice_created)
      SELECT DISTINCT ON (i.id)
             i.id,
             (prod.metadata->>${PUBLICATION_ID_METADATA_KEY})::int,
             pub.faculty_user_id,
             COALESCE(pub.slug, prod.metadata->>'palonur_publication_slug', ''),
             pub.name,
             fu.full_name,
             i.amount_paid,
             ROUND(i.amount_paid * ${STEWARD_SHARE}::numeric),
             i.amount_paid - ROUND(i.amount_paid * ${STEWARD_SHARE}::numeric),
             COALESCE(i.currency, 'usd'),
             i.created
      FROM stripe.invoices i
      JOIN stripe.subscriptions s ON s.id = i.subscription
      JOIN stripe.subscription_items si ON si.subscription = s.id
      JOIN stripe.prices p ON p.id = si.price
      JOIN stripe.products prod ON prod.id = p.product
      LEFT JOIN newsletter_publications pub
        ON pub.id = (prod.metadata->>${PUBLICATION_ID_METADATA_KEY})::int
      LEFT JOIN faculty_users fu ON fu.id = pub.faculty_user_id
      WHERE i.status = 'paid'
        AND i.amount_paid > 0
        AND prod.metadata->>'palonur_plan' = ${STEWARD_PLAN_KEY}
        AND (prod.metadata->>${PUBLICATION_ID_METADATA_KEY}) ~ '^[0-9]+$'
      ON CONFLICT (stripe_invoice_id) DO NOTHING
    `);
    return result.rowCount ?? 0;
  } catch (err) {
    logger.warn({ err }, "Steward earnings mint failed (continuing)");
    return 0;
  }
}

export interface StewardEarningsSummary {
  publicationId: number;
  publicationSlug: string;
  publicationName: string | null;
  stewardName: string | null;
  facultyUserId: number | null;
  invoiceCount: number;
  grossCents: number;
  stewardCents: number;
  palonurCents: number;
  currency: string;
}

/** Per-publication earnings rollup (all stewards — for the admin tab). */
export async function listStewardEarningsSummaries(): Promise<
  StewardEarningsSummary[]
> {
  await mintStewardEarnings();
  const result = await db.execute(sql`
    SELECT publication_id,
           MAX(publication_slug) AS publication_slug,
           MAX(publication_name) AS publication_name,
           MAX(steward_name) AS steward_name,
           MAX(faculty_user_id) AS faculty_user_id,
           COUNT(*)::int AS invoice_count,
           SUM(gross_cents)::bigint AS gross_cents,
           SUM(steward_cents)::bigint AS steward_cents,
           SUM(palonur_cents)::bigint AS palonur_cents,
           MAX(currency) AS currency
    FROM steward_earnings
    GROUP BY publication_id
    ORDER BY SUM(steward_cents) DESC
  `);
  return (result.rows as unknown as Record<string, unknown>[]).map((r) => ({
    publicationId: Number(r.publication_id),
    publicationSlug: String(r.publication_slug ?? ""),
    publicationName: (r.publication_name as string | null) ?? null,
    stewardName: (r.steward_name as string | null) ?? null,
    facultyUserId:
      r.faculty_user_id == null ? null : Number(r.faculty_user_id),
    invoiceCount: Number(r.invoice_count ?? 0),
    grossCents: Number(r.gross_cents ?? 0),
    stewardCents: Number(r.steward_cents ?? 0),
    palonurCents: Number(r.palonur_cents ?? 0),
    currency: String(r.currency ?? "usd"),
  }));
}

export interface StewardEarningsEntry {
  stripeInvoiceId: string;
  publicationId: number;
  publicationSlug: string;
  grossCents: number;
  stewardCents: number;
  palonurCents: number;
  currency: string;
  invoiceCreated: number | null;
}

/** A steward's own ledger entries, newest first (for the faculty portal). */
export async function listEarningsForFacultyUser(
  facultyUserId: number,
): Promise<StewardEarningsEntry[]> {
  await mintStewardEarnings();
  const rows = await db
    .select()
    .from(stewardEarningsTable)
    .where(eq(stewardEarningsTable.facultyUserId, facultyUserId))
    .orderBy(sql`${stewardEarningsTable.invoiceCreated} DESC NULLS LAST`);
  return rows.map((r) => ({
    stripeInvoiceId: r.stripeInvoiceId,
    publicationId: r.publicationId,
    publicationSlug: r.publicationSlug,
    grossCents: r.grossCents,
    stewardCents: r.stewardCents,
    palonurCents: r.palonurCents,
    currency: r.currency,
    invoiceCreated: r.invoiceCreated,
  }));
}
