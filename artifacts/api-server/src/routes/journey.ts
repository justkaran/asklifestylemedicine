/**
 * Journey passes — a $49-every-90-days auto-renewing subscription that grants
 * unlimited questions. "I've found my answer" stops the auto-renewal (cancel at
 * period end); access continues through the already-paid 90 days. Legacy
 * one-time passes (journey_passes rows) are still honored until they expire.
 *
 * POST /api/journey/checkout   { email, product }  → { url }
 * POST /api/journey/confirm    { sessionId }       → { ok, activated? | emailVerificationSent? }
 * POST /api/journey/complete                       → { ok }  (auth required)
 * GET  /api/journey/status                         → { active, product?, expiresAt? } (auth required)
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod/v4";
import { eq, sql } from "drizzle-orm";
import {
  db,
  consumerAccountsTable,
  consumerLoginTokensTable,
} from "@workspace/db";
import {
  getUncachableStripeClient,
  isStripeConnected,
} from "../lib/stripeClient.js";
import {
  findOrCreateConsumerByEmail,
  ensureStripeCustomer,
  siteBaseUrl,
} from "../lib/consumerBilling.js";
import { sendConsumerMagicLink } from "../lib/consumerEmail.js";
import { getConsumerFromRequest } from "../lib/consumerAuth.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// Auto-renewing $49-per-90-days subscription prices (see stripeProductSeed).
const JOURNEY_LOOKUP_KEYS: Record<string, string> = {
  sleep: "journey-sleep-90d",
};

const RECURRING_KEY_TO_PRODUCT: Record<string, "sleep"> = {
  "journey-sleep-90d": "sleep",
};

interface JourneySubscription {
  subscriptionId: string;
  product: "sleep";
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
}

/**
 * Active auto-renewing Journey Pass subscriptions for a Stripe customer, read
 * from the synced stripe schema. Identified by the price's journey lookup key.
 * Never throws — resolves to [] when the stripe schema is absent.
 */
async function listJourneySubscriptions(
  customerId: string | null,
): Promise<JourneySubscription[]> {
  if (!customerId) return [];
  try {
    const result = await db.execute(sql`
      SELECT s.id AS subscription_id,
             s.current_period_end AS current_period_end,
             s.cancel_at_period_end AS cancel_at_period_end,
             p.lookup_key AS lookup_key
      FROM stripe.subscriptions s
      JOIN stripe.subscription_items si ON si.subscription = s.id
      JOIN stripe.prices p ON p.id = si.price
      WHERE s.customer = ${customerId}
        AND s.status IN ('active', 'trialing')
        AND p.lookup_key = 'journey-sleep-90d'
      ORDER BY s.created DESC NULLS LAST
    `);
    const rows = (result.rows ?? []) as unknown as {
      subscription_id: string;
      current_period_end: number | null;
      cancel_at_period_end: boolean | null;
      lookup_key: string | null;
    }[];
    return rows.flatMap((r) => {
      const product = RECURRING_KEY_TO_PRODUCT[r.lookup_key ?? ""];
      if (!product) return [];
      return [
        {
          subscriptionId: r.subscription_id,
          product,
          currentPeriodEnd: r.current_period_end,
          cancelAtPeriodEnd: Boolean(r.cancel_at_period_end),
        },
      ];
    });
  } catch {
    return [];
  }
}

const JOURNEY_DESTINATIONS: Record<string, string> = {
  sleep: "/sleep",
};

const JOURNEY_PASS_DAYS = 90;

// ── POST /api/journey/checkout ────────────────────────────────────────────────

const checkoutSchema = z.object({
  email: z.string().email(),
  product: z.literal("sleep"),
});

router.post("/journey/checkout", async (req: Request, res: Response) => {
  const body = checkoutSchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: "Valid email and product required" });
  }
  const { email, product } = body.data;
  const lookupKey = JOURNEY_LOOKUP_KEYS[product];
  if (!lookupKey) return res.status(400).json({ error: "Invalid product" });

  if (!(await isStripeConnected())) {
    return res.status(503).json({ error: "Payments not available right now" });
  }

  try {
    const stripe = await getUncachableStripeClient();

    const held = await stripe.prices.list({
      lookup_keys: [lookupKey],
      limit: 1,
    });
    const price = held.data[0];
    if (!price) {
      return res.status(503).json({
        error: "Journey passes are not yet available. Try again shortly.",
      });
    }

    const account = await findOrCreateConsumerByEmail(email);
    const stripeCustomerId = await ensureStripeCustomer(account);

    const base = siteBaseUrl(req);
    const destination = JOURNEY_DESTINATIONS[product] ?? "/account";

    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      mode: "subscription",
      line_items: [{ price: price.id, quantity: 1 }],
      success_url: `${base}${destination}?journey_session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}${destination}`,
      metadata: {
        palonur_product: product,
        palonur_account_id: String(account.id),
      },
    });

    return res.json({ url: session.url });
  } catch (err) {
    logger.error({ err }, "journey/checkout failed");
    return res
      .status(500)
      .json({ error: "Could not start checkout. Please try again." });
  }
});

// ── POST /api/journey/confirm ─────────────────────────────────────────────────

const confirmSchema = z.object({
  sessionId: z.string().min(1).max(256),
});

router.post("/journey/confirm", async (req: Request, res: Response) => {
  const body = confirmSchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: "Valid sessionId required" });
  }
  const { sessionId } = body.data;

  if (!(await isStripeConnected())) {
    return res.status(503).json({ error: "Payments not available right now" });
  }

  try {
    const stripe = await getUncachableStripeClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    // New passes are subscription-mode; legacy one-time sessions were
    // payment-mode. Accept both so an old emailed link still confirms.
    if (
      (session.mode !== "subscription" && session.mode !== "payment") ||
      session.payment_status !== "paid"
    ) {
      return res.status(400).json({ error: "Payment not completed" });
    }

    const product = (session.metadata?.palonur_product ?? "") as string;
    const accountId = Number(session.metadata?.palonur_account_id ?? "0");
    if (!product || !accountId || !JOURNEY_LOOKUP_KEYS[product]) {
      return res.status(400).json({ error: "Invalid session metadata" });
    }

    // Legacy payment-mode sessions mint a journey_passes row. Subscription-mode
    // sessions don't — entitlement is derived from the Stripe subscription
    // itself (synced stripe schema), which survives renewals automatically.
    if (session.mode === "payment") {
      // Idempotent insert — skip if this Stripe session already created a pass.
      // Uses raw sql so a missing table degrades gracefully on a fresh DB.
      try {
        const existing = await db.execute(sql`
          SELECT id FROM journey_passes
           WHERE stripe_session_id = ${sessionId}
           LIMIT 1
        `);
        if ((existing.rows?.length ?? 0) === 0) {
          const expiresAt = new Date(
            Date.now() + JOURNEY_PASS_DAYS * 24 * 60 * 60 * 1000,
          );
          await db.execute(sql`
            INSERT INTO journey_passes
              (consumer_account_id, product, stripe_session_id, status, expires_at)
            VALUES (${accountId}, ${product}, ${sessionId}, 'active', ${expiresAt})
            ON CONFLICT DO NOTHING
          `);
        }
      } catch (e) {
        logger.warn(
          { err: e },
          "journey/confirm insert failed (new table may not exist)",
        );
      }
    }

    // If already signed in as the right account → activate immediately.
    const currentAccount = await getConsumerFromRequest(req);
    if (currentAccount?.id === accountId) {
      return res.json({ ok: true, activated: true });
    }

    // Otherwise send a magic link so the buyer can sign in and resume.
    const accountRows = await db
      .select({ email: consumerAccountsTable.email })
      .from(consumerAccountsTable)
      .where(eq(consumerAccountsTable.id, accountId))
      .limit(1);
    const accountEmail = accountRows[0]?.email;
    if (!accountEmail) {
      return res.status(500).json({ error: "Account not found" });
    }

    const token = randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    await db.insert(consumerLoginTokensTable).values({
      email: accountEmail,
      magicToken: token,
      expiresAt,
    });

    const destination = JOURNEY_DESTINATIONS[product] ?? "/account";
    await sendConsumerMagicLink({ to: accountEmail, token, next: destination });

    return res.json({ ok: true, emailVerificationSent: true });
  } catch (err) {
    logger.error({ err }, "journey/confirm failed");
    return res
      .status(500)
      .json({ error: "Could not confirm payment. Contact support." });
  }
});

// ── POST /api/journey/complete ────────────────────────────────────────────────

router.post("/journey/complete", async (req: Request, res: Response) => {
  const account = await getConsumerFromRequest(req);
  if (!account) return res.status(401).json({ error: "Not signed in" });

  // Quarterly subscription holders: stop the auto-renewal (cancel at period
  // end) — access continues through the already-paid 90 days. Never throws the
  // whole request on a Stripe error; the legacy row completion below still runs.
  try {
    const journeySubs = await listJourneySubscriptions(
      account.stripeCustomerId,
    );
    const renewing = journeySubs.filter((s) => !s.cancelAtPeriodEnd);
    if (renewing.length > 0 && (await isStripeConnected())) {
      const stripe = await getUncachableStripeClient();
      for (const s of renewing) {
        await stripe.subscriptions.update(s.subscriptionId, {
          cancel_at_period_end: true,
        });
      }
    }
  } catch (err) {
    logger.warn(
      { err },
      "journey/complete cancel-at-period-end failed (degrading)",
    );
  }

  // Legacy one-time passes: mark the row completed.
  try {
    await db.execute(sql`
      UPDATE journey_passes
         SET status = 'completed', completed_at = NOW()
       WHERE consumer_account_id = ${account.id}
         AND status = 'active'
         AND expires_at > NOW()
    `);
  } catch (err) {
    // Fail-open: the table may not exist on a fresh DB. Log but succeed.
    logger.warn({ err }, "journey/complete update failed (degrading)");
  }
  return res.json({ ok: true });
});

// ── GET /api/journey/status ───────────────────────────────────────────────────

router.get("/journey/status", async (req: Request, res: Response) => {
  const account = await getConsumerFromRequest(req);
  if (!account) return res.json({ active: false });

  // Auto-renewing quarterly subscription — the current offering.
  const subs = await listJourneySubscriptions(account.stripeCustomerId);
  const sub = subs[0];
  if (sub) {
    return res.json({
      active: true,
      product: sub.product,
      expiresAt: sub.currentPeriodEnd
        ? new Date(sub.currentPeriodEnd * 1000).toISOString()
        : null,
      renewing: !sub.cancelAtPeriodEnd,
    });
  }

  // Legacy one-time passes — honored until they expire.
  try {
    const result = await db.execute(sql`
      SELECT product, expires_at
        FROM journey_passes
       WHERE consumer_account_id = ${account.id}
         AND status = 'active'
         AND expires_at > NOW()
       ORDER BY created_at DESC
       LIMIT 1
    `);
    const row = (result.rows ?? [])[0] as
      | { product: string; expires_at: string }
      | undefined;
    if (!row) return res.json({ active: false });
    return res.json({
      active: true,
      product: row.product,
      expiresAt: row.expires_at,
      renewing: false,
    });
  } catch {
    return res.json({ active: false });
  }
});

export default router;
