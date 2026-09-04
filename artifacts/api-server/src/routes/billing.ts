import { Router, type IRouter, type Request, type Response } from "express";
import { randomBytes } from "crypto";
import { z } from "zod/v4";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  consumerAccountsTable,
  consumerLoginTokensTable,
  newsletterPublicationsTable,
  newsletterSubscribersTable,
} from "@workspace/db";
import { subscribePendingToHouseNewsletter } from "./newsletter";
import {
  getUncachableStripeClient,
  getStripeSync,
  isStripeConnected,
} from "../lib/stripeClient";
import { sendConsumerMagicLink } from "../lib/consumerEmail";
import { emailRateLimit } from "../middlewares/emailRateLimit";
import { claimVisitorSession } from "../lib/visitorSessions.js";
import {
  CONSUMER_COOKIE,
  setConsumerCookie,
  getConsumerFromRequest,
  getEntitlementForCustomer,
  listActiveSubscriptionsForCustomer,
} from "../lib/consumerAuth";
import {
  siteBaseUrl,
  findOrCreateConsumerByEmail,
  ensureStripeCustomer,
} from "../lib/consumerBilling";
import { applyReferralSignup } from "./referral";
import { applyReferralConversion } from "../lib/referralCredit";
import { isBillingEnabled, isStanfordEdition } from "../lib/features";

const router: IRouter = Router();

/**
 * The member surface a buyer should land on to start using what they just
 * bought. Used both as the magic-link `next` (new buyers, after they
 * verify email) and as the redirect for already-signed-in buyers. Unknown /
 * null plans fall back to the account hub. Always an internal absolute path.
 */
async function memberDestinationFor(
  product: string | null,
  stewardPublicationId: number | null = null,
): Promise<string> {
  // A steward Q&A buyer goes straight back to the publication page they were
  // reading — that's where the ask panel (the thing they just unlocked) lives.
  if (product === "steward" && stewardPublicationId) {
    try {
      const rows = await db
        .select({ slug: newsletterPublicationsTable.slug })
        .from(newsletterPublicationsTable)
        .where(eq(newsletterPublicationsTable.id, stewardPublicationId))
        .limit(1);
      if (rows[0]?.slug) return `/p/${rows[0].slug}`;
    } catch {
      // fall through to the account hub
    }
    return "/account";
  }
  switch (product) {
    case "premium":
    case "nightly":
      return "/sleep";
    default:
      // Newsletter, All-Access, and unknown/unresolved plans land on the
      // account hub — the honest surface when the product spans more than one
      // tool or isn't a single self-serve "start using" page.
      return "/account";
  }
}

// ── Consumer magic-link auth ────────────────────────────────────────────────

const requestSchema = z.object({
  email: z.string().email(),
  // Optional internal path to return the user to after the link is consumed
  // Strictly a same-site absolute path so the magic link cannot become an open
  // redirect.
  next: z
    .string()
    .regex(/^\/(?!\/)[^\s\\]*$/)
    .max(300)
    .optional(),
  // Standalone SLM domain sign-in: land the magic link on the SLM domain
  // root instead of /account (see sendConsumerMagicLink).
  slmStandalone: z.boolean().optional(),
});

router.post(
  "/consumer/auth/request",
  emailRateLimit,
  async (req: Request, res: Response) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Valid email required" });
    }
    const email = parsed.data.email.trim().toLowerCase();
    const token = randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    await db.insert(consumerLoginTokensTable).values({
      email,
      magicToken: token,
      expiresAt,
    });
    await sendConsumerMagicLink({
      to: email,
      token,
      next: parsed.data.next,
      slmStandalone: parsed.data.slmStandalone,
    });
    // Generic success — never leak whether an account exists.
    return res.json({ ok: true });
  },
);

// ── SLM chat self-registration ──────────────────────────────────────────────
//
// One-step onboarding for the standalone SLM chat: first name + email (+
// optional newsletter opt-in). A BRAND-NEW email gets its account created
// immediately plus a PROVISIONAL browser-session cookie, so the visitor can
// keep chatting right away while the verification email travels. The
// provisional cookie dies with the browser; the register endpoint never
// issues one for an existing account (verified or not), so a returning
// unverified visitor is blocked until they click the emailed link. This also
// means typing someone ELSE's email never grants access to that account.
const registerSchema = z.object({
  email: z.string().email(),
  firstName: z.string().trim().min(1).max(80),
  newsletter: z.boolean().optional(),
  next: z
    .string()
    .regex(/^\/(?!\/)[^\s\\]*$/)
    .max(300)
    .optional(),
  slmStandalone: z.boolean().optional(),
});

/** Source tag marking newsletter opt-ins made during SLM chat onboarding. */
export const ONBOARDING_NEWSLETTER_SOURCE = "slm-chat-onboarding";

// ── Registration abuse rail ─────────────────────────────────────────────────
// New-ACCOUNT creations per IP per UTC day. Scripts registering throwaway
// emails burn this out fast; real households never notice. Counts only
// creations (never sign-in links for existing accounts), keys on req.ip
// (trust proxy = 1 — never client-supplied headers), in-memory (resets on
// restart; this is an abuse rail, not billing).
const REG_IP_DAILY_LIMIT = Number(process.env.CONSUMER_REG_IP_DAILY_LIMIT ?? 3);
const REG_IP_MAX_KEYS = 20_000;
const regIpHits = new Map<string, { day: string; count: number }>();

/** Peek only — true when the IP still has a creation slot today. Charged
 *  separately AFTER the insert actually wins, so a same-email race (both
 *  requests pre-select "absent", one insert succeeds) never double-spends. */
function hasRegistrationSlot(ip: string): boolean {
  const day = new Date().toISOString().slice(0, 10);
  if (regIpHits.size >= REG_IP_MAX_KEYS) {
    for (const [k, v] of regIpHits) {
      if (v.day !== day) regIpHits.delete(k);
    }
    // Still full of today's keys → under a flood; fail closed for new IPs.
    if (regIpHits.size >= REG_IP_MAX_KEYS && !regIpHits.has(ip)) return false;
  }
  const rec = regIpHits.get(ip);
  const count = rec && rec.day === day ? rec.count : 0;
  return count < REG_IP_DAILY_LIMIT;
}

function chargeRegistrationSlot(ip: string): void {
  const day = new Date().toISOString().slice(0, 10);
  const rec = regIpHits.get(ip);
  const count = rec && rec.day === day ? rec.count : 0;
  regIpHits.set(ip, { day, count: count + 1 });
}

router.post(
  "/consumer/auth/register",
  emailRateLimit,
  async (req: Request, res: Response) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "A first name and a valid email are required" });
    }
    const email = parsed.data.email.trim().toLowerCase();
    const firstName = parsed.data.firstName;

    // Registration rail: charge the per-IP slot only when this email would
    // CREATE an account — an existing account (any verification state) just
    // gets a sign-in link, which shared-IP households must never be denied.
    // The 429 is only reachable by an IP already over the abuse limit, so the
    // exists/created distinction it implies is an accepted trade-off.
    const preExisting = await db
      .select({ id: consumerAccountsTable.id })
      .from(consumerAccountsTable)
      .where(eq(consumerAccountsTable.email, email))
      .limit(1);
    if (preExisting.length === 0 && !hasRegistrationSlot(req.ip ?? "unknown")) {
      return res.status(429).json({
        error:
          "Too many new accounts from this network today. Please try again tomorrow.",
      });
    }

    // Race-safe create: onConflictDoNothing returns no row when the email
    // already has an account (created earlier or concurrently).
    const inserted = await db
      .insert(consumerAccountsTable)
      .values({ email, displayName: firstName })
      .onConflictDoNothing({ target: consumerAccountsTable.email })
      .returning();
    const created = inserted[0] ?? null;
    // Charge the per-IP slot only when THIS request actually created the
    // account — a lost same-email race spends nothing.
    if (created) chargeRegistrationSlot(req.ip ?? "unknown");

    // Newsletter opt-in: recorded as PENDING with no extra email — consuming
    // the account-verification magic link doubles as the confirmation click.
    if (!isStanfordEdition() && created && parsed.data.newsletter) {
      try {
        await subscribePendingToHouseNewsletter(email, {
          name: firstName,
          source: ONBOARDING_NEWSLETTER_SOURCE,
          skipEmail: true,
        });
      } catch (e) {
        req.log.warn({ err: e }, "onboarding newsletter opt-in failed");
      }
    }

    // Both paths send the same magic link (verification for new accounts,
    // sign-in for existing ones) so the response never leaks whether an
    // account existed.
    const token = randomBytes(24).toString("hex");
    await db.insert(consumerLoginTokensTable).values({
      email,
      magicToken: token,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });
    await sendConsumerMagicLink({
      to: email,
      token,
      next: parsed.data.next,
      slmStandalone: parsed.data.slmStandalone,
      newsletterOptIn: Boolean(
        !isStanfordEdition() && created && parsed.data.newsletter,
      ),
    });

    if (created) {
      setConsumerCookie(res, created.id, { provisional: true });
      return res.json({ ok: true, provisional: true, displayName: firstName });
    }
    // Existing account (any verification state): no session — they must click
    // the emailed link.
    return res.json({ ok: true, provisional: false });
  },
);

router.get("/consumer/auth/consume", async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  const token = String(req.query.token ?? "");
  if (!token) return res.status(400).json({ error: "Token required" });
  const rows = await db
    .select()
    .from(consumerLoginTokensTable)
    .where(eq(consumerLoginTokensTable.magicToken, token))
    .limit(1);
  const t = rows[0];
  if (!t || t.consumedAt || t.expiresAt.getTime() < Date.now()) {
    return res.status(400).json({ error: "Link expired or already used" });
  }
  await db
    .update(consumerLoginTokensTable)
    .set({ consumedAt: new Date() })
    .where(eq(consumerLoginTokensTable.id, t.id));
  const account = await findOrCreateConsumerByEmail(t.email);
  // Consuming the link proves email ownership: mark the account verified and
  // upgrade any provisional session to a full persistent one.
  if (!account.emailVerifiedAt) {
    await db
      .update(consumerAccountsTable)
      .set({ emailVerifiedAt: new Date() })
      .where(
        and(
          eq(consumerAccountsTable.id, account.id),
          isNull(consumerAccountsTable.emailVerifiedAt),
        ),
      );
  }
  // Activate a newsletter opt-in made during SLM chat onboarding: that flow
  // records the sub as pending WITHOUT its own confirmation email, because
  // this click is the confirmation. Scoped to the onboarding source so a
  // pending sub created by a third party via the public form is never
  // activated by someone merely signing in.
  if (!isStanfordEdition()) {
    await db
      .update(newsletterSubscribersTable)
      .set({ status: "active", confirmedAt: new Date() })
      .where(
        and(
          eq(newsletterSubscribersTable.email, account.email),
          eq(newsletterSubscribersTable.status, "pending"),
          eq(newsletterSubscribersTable.source, ONBOARDING_NEWSLETTER_SOURCE),
        ),
      );
  }
  setConsumerCookie(res, account.id);
  // Auto-create: consuming the magic link proves email ownership — claim this
  // browser's anonymous visitor session for the account (best-effort).
  claimVisitorSession(
    req.cookies?.["palonur_session"] as string | undefined,
    account.id,
  );
  // Referral bonus: if a ref_code cookie is present and valid, grant 5 bonus
  // questions to this account and record the signup event (best-effort).
  const refCode = req.cookies?.["ref_code"] as string | undefined;
  if (!isStanfordEdition() && refCode) {
    await applyReferralSignup(account.id, account.email, refCode);
    res.clearCookie("ref_code", { path: "/" });
  }
  return res.json({ ok: true, email: account.email });
});

router.post("/consumer/auth/logout", (_req: Request, res: Response) => {
  res.clearCookie(CONSUMER_COOKIE);
  return res.json({ ok: true });
});

router.get("/consumer/me", async (req: Request, res: Response) => {
  // Authentication state changes when a magic link sets the session cookie.
  // Never let the browser reuse a pre-login `authenticated:false` response
  // after that transition.
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  // Status endpoint: provisional sessions may see their own state (so the
  // SLM chat can greet them and show verification status), but they get no
  // billing/account capabilities anywhere else.
  const account = await getConsumerFromRequest(req, { allowProvisional: true });
  if (!account) {
    return res.json({ authenticated: false });
  }
  const entitlement = isBillingEnabled()
    ? await getEntitlementForCustomer(account.stripeCustomerId)
    : null;
  return res.json({
    authenticated: true,
    email: account.email,
    displayName: account.displayName,
    emailVerified: account.emailVerifiedAt != null,
    provisional: account.provisional,
    subscription: entitlement,
  });
});

// ── Plans (public) ──────────────────────────────────────────────────────────

interface PlanRow {
  product_id: string;
  name: string | null;
  description: string | null;
  palonur_plan: string | null;
  price_id: string;
  unit_amount: number | null;
  currency: string | null;
  interval: string | null;
}

router.get("/billing/plans", async (req: Request, res: Response) => {
  if (!isBillingEnabled()) {
    return res.json({ enabled: false, plans: [] });
  }
  try {
    // DISTINCT ON collapses a tier to exactly one price per (product, interval):
    // when an amount is bumped, Stripe keeps the OLD price active until it's
    // archived (prices are immutable), so a product can legitimately carry stale
    // duplicates (e.g. an old $4/mo alongside the seeded $9/mo). We keep the
    // most-recently-created price per (product, interval), which always reflects
    // the current intended amount, so the storefront never shows a stale price.
    const result = await db.execute(sql`
      SELECT DISTINCT ON (prod.id, pr.recurring->>'interval')
             prod.id AS product_id,
             prod.name AS name,
             prod.description AS description,
             prod.metadata->>'palonur_plan' AS palonur_plan,
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
      ORDER BY prod.id, pr.recurring->>'interval', pr.created DESC NULLS LAST
    `);
    const rows = result.rows as unknown as PlanRow[];
    const plans = rows.map((r) => ({
      productId: r.product_id,
      priceId: r.price_id,
      name: r.name,
      description: r.description,
      // The product's palonur_plan metadata (e.g. "all_access", "newsletter").
      // Lets the storefront group prices by tier and badge the bundle.
      planKey: r.palonur_plan,
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
    return res.json({ plans });
  } catch (err) {
    // stripe schema may not exist yet (Stripe not connected) — treat as no plans
    req.log.warn({ err }, "Could not list billing plans");
    return res.json({ plans: [] });
  }
});

// ── Checkout ────────────────────────────────────────────────────────────────

const checkoutSchema = z
  .object({
    email: z.string().email(),
    priceId: z.string().min(1).optional(),
    // Alternative to priceId: a Stripe price lookup_key. Lookup keys are
    // stable names we control in BOTH test and live mode (raw price ids
    // differ per mode), so callers like the sponsored-checkout mint script
    // can target one price without knowing the mode-local id. This also
    // reaches hidden (non-storefront) prices — deliberate: hidden prices
    // are unlisted, not privileged (checkout has always accepted any active
    // priceId), and every hidden price costs MORE than the public tier.
    lookupKey: z.string().min(1).optional(),
    // Optional internal path checkout returns to (success AND cancel), so a
    // /p/:slug steward-plan buyer lands back on the publication page instead
    // of the generic storefront. Strictly validated as a same-site absolute
    // path (starts with exactly one "/") — never an external URL.
    returnPath: z
      .string()
      .regex(/^\/(?!\/)[^\s]*$/)
      .max(300)
      .optional(),
  })
  .refine((v) => Boolean(v.priceId) !== Boolean(v.lookupKey), {
    message: "Provide exactly one of priceId or lookupKey",
  });

router.post("/billing/checkout", async (req: Request, res: Response) => {
  if (!isBillingEnabled() || !(await isStripeConnected())) {
    return res.status(503).json({ error: "Billing is not available yet" });
  }
  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Email and exactly one of priceId or lookupKey required",
    });
  }
  const { email, lookupKey } = parsed.data;
  try {
    const stripe = await getUncachableStripeClient();
    // Resolve a lookup key to the mode-local price id BEFORE creating any
    // account/customer, so an unknown plan has zero side effects.
    let priceId = parsed.data.priceId ?? null;
    if (!priceId && lookupKey) {
      const found = await stripe.prices.list({
        lookup_keys: [lookupKey],
        active: true,
        limit: 1,
      });
      priceId = found.data[0]?.id ?? null;
    }
    if (!priceId) {
      return res.status(404).json({ error: "Unknown plan" });
    }
    const account = await findOrCreateConsumerByEmail(email);
    const customerId = await ensureStripeCustomer(account);
    const base = siteBaseUrl(req);
    const returnPath = parsed.data.returnPath ?? "/subscribe";
    const sep = returnPath.includes("?") ? "&" : "?";
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${base}${returnPath}${sep}checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}${returnPath}${sep}checkout=cancelled`,
      allow_promotion_codes: true,
    });
    if (!session.url) {
      return res.status(502).json({ error: "Could not start checkout" });
    }
    return res.json({ url: session.url });
  } catch (err) {
    req.log.error({ err }, "Stripe checkout creation failed");
    return res.status(500).json({ error: "Could not start checkout" });
  }
});

// ── Confirm (post-checkout: sync + log the buyer in) ────────────────────────

const confirmSchema = z.object({ sessionId: z.string().min(1) });

router.post(
  "/billing/confirm",
  emailRateLimit,
  async (req: Request, res: Response) => {
    if (!isBillingEnabled() || !(await isStripeConnected())) {
      return res.status(503).json({ error: "Billing is not available yet" });
    }
    const parsed = confirmSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "sessionId required" });
    }
    try {
      const stripe = await getUncachableStripeClient();
      const session = await stripe.checkout.sessions.retrieve(
        parsed.data.sessionId,
      );
      // A checkout session NEVER proves the caller owns the account email —
      // anyone can start checkout with any email (see /billing/checkout). So this
      // endpoint must not establish an authenticated session on the strength of a
      // session id alone, or it becomes an account-takeover vector (pay for a
      // victim's email, then "confirm" to get their cookie). We only:
      //   1. act on a genuinely completed + paid checkout,
      //   2. sync entitlement so it reflects immediately, and
      //   3. prove email ownership via a magic link before logging anyone in
      //      (unless the requester is ALREADY authenticated as this exact
      //      account, in which case no new proof is needed).
      if (
        session.status !== "complete" ||
        session.payment_status === "unpaid"
      ) {
        return res.status(402).json({ error: "Checkout not completed" });
      }
      const customerId =
        typeof session.customer === "string"
          ? session.customer
          : (session.customer?.id ?? null);
      if (!customerId) {
        return res.status(400).json({ error: "No customer on session" });
      }
      // Map the customer back to a local account.
      const rows = await db
        .select()
        .from(consumerAccountsTable)
        .where(eq(consumerAccountsTable.stripeCustomerId, customerId))
        .limit(1);
      const account = rows[0];
      if (!account) {
        return res.status(404).json({ error: "Account not found" });
      }
      // Best-effort: pull the latest subscription/customer state so entitlement
      // reflects immediately instead of waiting for the async webhook.
      try {
        const stripeSync = await getStripeSync();
        await stripeSync.syncSingleEntity(customerId);
        if (typeof session.subscription === "string") {
          await stripeSync.syncSingleEntity(session.subscription);
        }
      } catch (err) {
        req.log.warn(
          { err },
          "Post-checkout sync failed (webhook will catch up)",
        );
      }

      // Resolve which product they just bought so the client can name it on the
      // post-checkout confirmation screen. Best-effort: match the session's
      // subscription, else the most
      // recent active one. Never blocks confirm.
      let product: string | null = null;
      let stewardPublicationId: number | null = null;
      try {
        const subs = await listActiveSubscriptionsForCustomer(customerId);
        const subId =
          typeof session.subscription === "string"
            ? session.subscription
            : null;
        // Prefer the subscription this checkout created. If it hasn't synced yet
        // we deliberately fall back to a generic confirmation (null) rather than
        // subs[0], so a multi-subscription (e.g. upgrade) buyer is never shown the
        // name of a DIFFERENT plan they already hold.
        const matched = subId
          ? (subs.find((s) => s.subscriptionId === subId) ?? null)
          : (subs[0] ?? null);
        product = matched?.palonurPlan ?? null;
        stewardPublicationId = matched?.stewardPublicationId ?? null;
      } catch (err) {
        req.log.warn({ err }, "Post-checkout product lookup failed");
      }

      // The member surface for what they just bought, so the client can send them
      // straight into first use instead of the generic storefront/hub.
      const destination = await memberDestinationFor(
        product,
        stewardPublicationId,
      );

      // Apply referral signup bonus if a ref_code cookie is present (handles
      // users who completed checkout without passing through /consume first).
      // Idempotent: one signup event per email globally.
      const refCodeConfirm = req.cookies?.["ref_code"] as string | undefined;
      if (refCodeConfirm) {
        await applyReferralSignup(account.id, account.email, refCodeConfirm);
        res.clearCookie("ref_code", { path: "/" });
      }

      // Apply referral conversion credit (best-effort, non-blocking).
      void applyReferralConversion(account.email, req.log);

      // If the caller is already signed in as this very account, they've already
      // proven email ownership — just return the refreshed entitlement.
      const current = await getConsumerFromRequest(req);
      if (current && current.id === account.id) {
        const entitlement = await getEntitlementForCustomer(customerId);
        return res.json({
          ok: true,
          email: account.email,
          subscription: entitlement,
          product,
          destination,
        });
      }

      // Otherwise, require email-ownership proof before any session is granted.
      // The magic link carries `next` so that once they verify, they land on the
      // product's member surface — payment still never grants the session itself.
      const token = randomBytes(24).toString("hex");
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
      await db.insert(consumerLoginTokensTable).values({
        email: account.email,
        magicToken: token,
        expiresAt,
      });
      await sendConsumerMagicLink({
        to: account.email,
        token,
        next: destination,
      });
      return res.json({
        ok: true,
        emailVerificationSent: true,
        email: account.email,
        product,
        destination,
      });
    } catch (err) {
      req.log.error({ err }, "Stripe checkout confirm failed");
      return res.status(500).json({ error: "Could not confirm checkout" });
    }
  },
);

// ── Customer portal ─────────────────────────────────────────────────────────

router.post("/billing/portal", async (req: Request, res: Response) => {
  if (!isBillingEnabled() || !(await isStripeConnected())) {
    return res.status(503).json({ error: "Billing is not available yet" });
  }
  const account = await getConsumerFromRequest(req);
  if (!account || !account.stripeCustomerId) {
    return res.status(401).json({ error: "Not signed in" });
  }
  try {
    const stripe = await getUncachableStripeClient();
    const base = siteBaseUrl(req);
    const portal = await stripe.billingPortal.sessions.create({
      customer: account.stripeCustomerId,
      return_url: `${base}/subscribe`,
    });
    return res.json({ url: portal.url });
  } catch (err) {
    req.log.error({ err }, "Stripe portal session failed");
    return res.status(500).json({ error: "Could not open billing portal" });
  }
});

// ── Subscription state ──────────────────────────────────────────────────────

router.get("/billing/subscription", async (req: Request, res: Response) => {
  const account = await getConsumerFromRequest(req);
  if (!account) return res.status(401).json({ error: "Not signed in" });
  if (!isBillingEnabled()) {
    return res.status(503).json({ error: "Billing is not available yet" });
  }
  const entitlement = await getEntitlementForCustomer(account.stripeCustomerId);
  return res.json({ email: account.email, subscription: entitlement });
});

export default router;
