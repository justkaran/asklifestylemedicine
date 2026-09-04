import type { Request, Response, NextFunction } from "express";
import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { db, consumerAccountsTable } from "@workspace/db";

export const CONSUMER_COOKIE = "palonur_consumer";

/**
 * How long a consumer session cookie lives without any activity. Sessions are
 * meant to last "until logout": every authenticated request slides the window
 * forward (see `consumerSessionSliding`), so an active user never expires.
 * 400 days is the maximum lifetime Chrome allows for any cookie, so this is
 * effectively "as long as the browser permits".
 */
export const CONSUMER_SESSION_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;

/**
 * Cookie-value marker for a PROVISIONAL session: issued once, at the moment a
 * brand-new account self-registers in the SLM chat, before the email is
 * verified. Provisional cookies are browser-SESSION cookies (no max-age), so
 * they die when the browser closes — by design: an unverified visitor may
 * keep chatting in the session where they registered, but a returning
 * browser must verify the email first (the register endpoint never issues a
 * second provisional session for an existing account).
 */
const PROVISIONAL_PREFIX = "prov:";

/** Set (or refresh) the signed httpOnly consumer session cookie. */
export function setConsumerCookie(
  res: Response,
  accountId: number,
  opts: { provisional?: boolean } = {},
): void {
  if (opts.provisional) {
    // No maxAge → browser-session cookie that expires when the browser closes.
    res.cookie(CONSUMER_COOKIE, `${PROVISIONAL_PREFIX}${accountId}`, {
      signed: true,
      httpOnly: true,
      sameSite: "lax",
    });
    return;
  }
  res.cookie(CONSUMER_COOKIE, String(accountId), {
    signed: true,
    httpOnly: true,
    sameSite: "lax",
    maxAge: CONSUMER_SESSION_MAX_AGE_MS,
  });
}

/** Parse a signed consumer cookie value into its account id + provisionality. */
function parseConsumerCookie(
  raw: string | undefined,
): { id: number; provisional: boolean } | null {
  if (!raw) return null;
  const provisional = raw.startsWith(PROVISIONAL_PREFIX);
  const id = Number(provisional ? raw.slice(PROVISIONAL_PREFIX.length) : raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return { id, provisional };
}

/**
 * Sliding-session middleware: whenever a request carries a valid signed
 * consumer cookie, re-issue it with a fresh max-age so the session only ends
 * when the user explicitly logs out (or the account is removed). Signature
 * validity is already enforced by cookie-parser (`signedCookies` only holds
 * cookies with a valid signature), so no DB hit is needed here. Skips the
 * logout endpoint so its `clearCookie` is never raced by a renewal.
 */
export function consumerSessionSliding(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.path.endsWith("/consumer/auth/logout")) {
    const raw = req.signedCookies?.[CONSUMER_COOKIE] as string | undefined;
    const parsed = parseConsumerCookie(raw);
    // Provisional cookies are NOT renewed: they must stay browser-session
    // cookies so an unverified registration cannot outlive the browser.
    if (parsed && !parsed.provisional) setConsumerCookie(res, parsed.id);
  }
  next();
}

export interface ConsumerAccount {
  id: number;
  email: string;
  displayName: string | null;
  stripeCustomerId: string | null;
  /** NULL until the account's email is proven by consuming a magic link. */
  emailVerifiedAt: Date | null;
  /**
   * True when this request rode a provisional (unverified, browser-session)
   * cookie from SLM chat self-registration. Only set by
   * `getConsumerFromRequest`; lookups by email leave it false.
   */
  provisional: boolean;
}

/**
 * Resolve the signed consumer session cookie to an account row. Returns null
 * when there's no cookie or it doesn't map to an account.
 */
export async function getConsumerFromRequest(
  req: Request,
  opts: { allowProvisional?: boolean } = {},
): Promise<ConsumerAccount | null> {
  const raw = req.signedCookies?.[CONSUMER_COOKIE] as string | undefined;
  const parsed = parseConsumerCookie(raw);
  if (!parsed) return null;
  const rows = await db
    .select()
    .from(consumerAccountsTable)
    .where(eq(consumerAccountsTable.id, parsed.id))
    .limit(1);
  const a = rows[0];
  if (!a) return null;
  if (parsed.provisional) {
    // Provisional sessions are a narrow capability, NOT full authentication:
    // only routes that explicitly opt in (the standalone SLM chat and the
    // /consumer/me status endpoint) accept them. Everything else — billing
    // portal, account data, entitlements — requires a full session minted by
    // consuming a magic link. And a provisional cookie is only honored while
    // the account is still UNVERIFIED: once the real owner clicks their
    // link, any provisional cookie for that account (possibly held by
    // whoever typed the email) is dead.
    if (!opts.allowProvisional) return null;
    if (a.emailVerifiedAt) return null;
  }
  return {
    id: a.id,
    email: a.email,
    displayName: a.displayName,
    stripeCustomerId: a.stripeCustomerId,
    emailVerifiedAt: a.emailVerifiedAt,
    provisional: parsed.provisional,
  };
}

export interface EntitlementInfo {
  active: boolean;
  status: string | null;
  plan: "monthly" | "annual" | null;
  priceId: string | null;
  unitAmount: number | null;
  currency: string | null;
  interval: string | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
}

const INACTIVE: EntitlementInfo = {
  active: false,
  status: null,
  plan: null,
  priceId: null,
  unitAmount: null,
  currency: null,
  interval: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
};

/**
 * Derive entitlement for a Stripe customer by querying the synced
 * `stripe.subscriptions` table. Active = a subscription in `active` or
 * `trialing` status. Never throws — if the stripe schema isn't present yet
 * (Stripe not connected) it resolves to inactive so callers can treat the
 * consumer as free-tier.
 */
export async function getEntitlementForCustomer(
  customerId: string | null,
): Promise<EntitlementInfo> {
  if (!customerId) return INACTIVE;
  try {
    const result = await db.execute(sql`
      SELECT s.status::text AS status,
             s.current_period_end AS current_period_end,
             s.cancel_at_period_end AS cancel_at_period_end,
             p.id AS price_id,
             p.unit_amount AS unit_amount,
             p.currency AS currency,
             p.recurring->>'interval' AS interval
      FROM stripe.subscriptions s
      LEFT JOIN stripe.subscription_items si ON si.subscription = s.id
      LEFT JOIN stripe.prices p ON p.id = si.price
      WHERE s.customer = ${customerId}
        AND s.status IN ('active', 'trialing')
      ORDER BY s.created DESC NULLS LAST
      LIMIT 1
    `);
    const row = result.rows[0] as
      | {
          status: string | null;
          current_period_end: number | null;
          cancel_at_period_end: boolean | null;
          price_id: string | null;
          unit_amount: number | null;
          currency: string | null;
          interval: string | null;
        }
      | undefined;
    if (!row) return INACTIVE;
    const interval = row.interval ?? null;
    return {
      active: true,
      status: row.status,
      plan:
        interval === "year"
          ? "annual"
          : interval === "month"
            ? "monthly"
            : null,
      priceId: row.price_id,
      unitAmount: row.unit_amount,
      currency: row.currency,
      interval,
      currentPeriodEnd: row.current_period_end,
      cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    };
  } catch {
    return INACTIVE;
  }
}

/**
 * Convenience: resolve the request's consumer account and its entitlement in
 * one call. Used by the sleep-agent paywall gate.
 */
export async function getRequestEntitlement(req: Request): Promise<{
  account: ConsumerAccount | null;
  entitlement: EntitlementInfo;
}> {
  const account = await getConsumerFromRequest(req);
  if (!account) return { account: null, entitlement: INACTIVE };
  const entitlement = await getEntitlementForCustomer(account.stripeCustomerId);
  return { account, entitlement };
}

// ── Capability-based entitlements ───────────────────────────────────────────
//
// A consumer's access is derived from the set of products they actively
// subscribe to, identified by `products.metadata.palonur_plan`. Each plan grants
// one or more capabilities; the top-tier "all_access" plan grants every one.
// Lower individual tiers grant only their own capability.

export type Capability =
  | "nightly"
  | "newsletter"
  /** Social Brain pillar — Karen Parker. Gating activated when the pillar opens. */
  | "social_brain";

/** Stripe `products.metadata.palonur_plan` value for the $19 top tier. */
export const ALL_ACCESS_PLAN_KEY = "all_access";

/**
 * Maps a product's `palonur_plan` metadata value to the capabilities it grants.
 * `premium` is the legacy sleep-agent ("Nightly") key and is kept as an alias of
 * `nightly` so existing subscriptions keep working.
 */
const PLAN_CAPABILITIES: Record<string, Capability[]> = {
  premium: ["nightly"],
  nightly: ["nightly"],
  newsletter: ["newsletter"],
  all_access: ["nightly", "newsletter", "social_brain"],
};

/** Capabilities granted by a single `palonur_plan` value (empty if unknown). */
export function capabilitiesForPlanKey(planKey: string | null): Capability[] {
  if (!planKey) return [];
  return PLAN_CAPABILITIES[planKey] ?? [];
}

export interface ActiveSubscription {
  subscriptionId: string;
  status: string | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  productId: string | null;
  productName: string | null;
  /** `products.metadata.palonur_plan`, e.g. "all_access" / "newsletter". */
  palonurPlan: string | null;
  /**
   * For `steward` Q&A plans only: the publication id this subscription is
   * bound to (`products.metadata.palonur_publication_id`). Null for every
   * other plan family.
   */
  stewardPublicationId: number | null;
  priceId: string | null;
  unitAmount: number | null;
  currency: string | null;
  interval: string | null;
  /** `recurring.interval_count` — e.g. 90 for a $49-every-90-days price. */
  intervalCount: number | null;
  plan: "monthly" | "annual" | null;
}

/**
 * Every active/trialing subscription a Stripe customer holds, with its plan
 * metadata. Unlike `getEntitlementForCustomer` (which returns a single display
 * row) this returns ALL active subscriptions so capabilities can be unioned
 * across plans. Never throws — resolves to `[]` when the stripe schema is
 * absent (Stripe not connected) so callers treat the consumer as free-tier.
 */
export async function listActiveSubscriptionsForCustomer(
  customerId: string | null,
): Promise<ActiveSubscription[]> {
  if (!customerId) return [];
  try {
    const result = await db.execute(sql`
      SELECT s.id AS subscription_id,
             s.status::text AS status,
             s.current_period_end AS current_period_end,
             s.cancel_at_period_end AS cancel_at_period_end,
             prod.id AS product_id,
             prod.name AS product_name,
             prod.metadata->>'palonur_plan' AS palonur_plan,
             prod.metadata->>'palonur_publication_id' AS steward_publication_id,
             p.id AS price_id,
             p.unit_amount AS unit_amount,
             p.currency AS currency,
             p.recurring->>'interval' AS interval,
             p.recurring->>'interval_count' AS interval_count
      FROM stripe.subscriptions s
      JOIN stripe.subscription_items si ON si.subscription = s.id
      LEFT JOIN stripe.prices p ON p.id = si.price
      LEFT JOIN stripe.products prod ON prod.id = p.product
      WHERE s.customer = ${customerId}
        AND s.status IN ('active', 'trialing')
      ORDER BY s.created DESC NULLS LAST
    `);
    const rows = result.rows as unknown as {
      subscription_id: string;
      status: string | null;
      current_period_end: number | null;
      cancel_at_period_end: boolean | null;
      product_id: string | null;
      product_name: string | null;
      palonur_plan: string | null;
      steward_publication_id: string | null;
      price_id: string | null;
      unit_amount: number | null;
      currency: string | null;
      interval: string | null;
      interval_count: string | null;
    }[];
    return rows.map((r) => ({
      subscriptionId: r.subscription_id,
      status: r.status,
      currentPeriodEnd: r.current_period_end,
      cancelAtPeriodEnd: Boolean(r.cancel_at_period_end),
      productId: r.product_id,
      productName: r.product_name,
      palonurPlan: r.palonur_plan,
      stewardPublicationId:
        r.palonur_plan === "steward" &&
        r.steward_publication_id &&
        Number.isInteger(Number(r.steward_publication_id))
          ? Number(r.steward_publication_id)
          : null,
      priceId: r.price_id,
      unitAmount: r.unit_amount,
      currency: r.currency,
      interval: r.interval,
      intervalCount:
        r.interval_count != null && Number.isFinite(Number(r.interval_count))
          ? Number(r.interval_count)
          : null,
      plan:
        r.interval === "year"
          ? "annual"
          : r.interval === "month"
            ? "monthly"
            : null,
    }));
  } catch {
    return [];
  }
}

/** The union of capabilities granted by a customer's active subscriptions. */
export async function getConsumerCapabilities(
  customerId: string | null,
): Promise<Set<Capability>> {
  const subs = await listActiveSubscriptionsForCustomer(customerId);
  const caps = new Set<Capability>();
  for (const s of subs) {
    for (const c of capabilitiesForPlanKey(s.palonurPlan)) caps.add(c);
  }
  return caps;
}

/** Resolve the request's consumer account and its capability set in one call. */
export async function getRequestCapabilities(req: Request): Promise<{
  account: ConsumerAccount | null;
  capabilities: Set<Capability>;
}> {
  const account = await getConsumerFromRequest(req);
  if (!account) return { account: null, capabilities: new Set<Capability>() };
  const capabilities = await getConsumerCapabilities(account.stripeCustomerId);
  return { account, capabilities };
}

/** True if any active subscription is the top-tier all-access plan. */
export function subscriptionsHaveAllAccess(
  subs: ActiveSubscription[],
): boolean {
  return subs.some((s) => s.palonurPlan === ALL_ACCESS_PLAN_KEY);
}

/**
 * True when the consumer account has an active, unexpired journey pass for the
 * given product. Degrades to false on any error so the paywall stays closed
 * even if the journey_passes table hasn't been created yet on a fresh DB.
 */
export async function hasActiveJourneyPass(
  accountId: number,
  product: "sleep",
): Promise<boolean> {
  try {
    const result = await db.execute(sql`
      SELECT id FROM journey_passes
       WHERE consumer_account_id = ${accountId}
         AND product             = ${product}
         AND status              = 'active'
         AND expires_at          > NOW()
       LIMIT 1
    `);
    return (result.rows?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Resolve a consumer account by email (case-insensitive), or null. */
export async function getAccountByEmail(
  email: string,
): Promise<ConsumerAccount | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const rows = await db
    .select()
    .from(consumerAccountsTable)
    .where(eq(consumerAccountsTable.email, normalized))
    .limit(1);
  const a = rows[0];
  if (!a) return null;
  return {
    id: a.id,
    email: a.email,
    displayName: a.displayName,
    stripeCustomerId: a.stripeCustomerId,
    emailVerifiedAt: a.emailVerifiedAt,
    provisional: false,
  };
}

/** Active subscriptions for an email's consumer account (empty if none). */
export async function listActiveSubscriptionsForEmail(
  email: string,
): Promise<ActiveSubscription[]> {
  const account = await getAccountByEmail(email);
  if (!account) return [];
  return listActiveSubscriptionsForCustomer(account.stripeCustomerId);
}
