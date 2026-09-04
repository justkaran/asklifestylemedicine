import { eq, sql } from "drizzle-orm";
import { db, consumerAccountsTable } from "@workspace/db";
import {
  getUncachableStripeClient,
  isStripeConnected,
} from "./stripeClient.js";
import { listActiveSubscriptionsForCustomer } from "./consumerAuth.js";

/**
 * Apply a Stripe balance credit to the referrer when a referred user converts
 * to a paid subscriber.  Called from:
 *   1. lib/webhookHandlers.ts — checkout.session.completed event (preferred path)
 *   2. routes/billing.ts — /billing/confirm return path (fast-path backup)
 *   3. routes/referral.ts — boot-time reconciliation (heal historical misses)
 *
 * Idempotent: the referral_events partial unique index on
 * (code, recipient_email) WHERE event_type='convert' prevents double-credit
 * even when all three paths fire for the same conversion.
 *
 * Capped at 12 conversions per referrer per calendar year.
 */
export async function applyReferralConversion(
  recipientEmail: string,
  log: { warn: (...args: unknown[]) => void },
): Promise<void> {
  try {
    if (!(await isStripeConnected())) return;

    // Find the referral signup event for this recipient.
    const signupRow = await db.execute(sql`
      SELECT re.code, rc.owner_email
      FROM referral_events re
      JOIN referral_codes rc ON rc.code = re.code
      WHERE re.event_type = 'signup'
        AND re.recipient_email = ${recipientEmail}
      ORDER BY re.created_at DESC
      LIMIT 1
    `);
    if (!signupRow.rows.length) return;

    const { code, owner_email: ownerEmail } = signupRow.rows[0] as {
      code: string;
      owner_email: string;
    };

    // Enforce per-referrer annual cap of 12 credited conversions.
    const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString();
    const yearCount = await db.execute(sql`
      SELECT COUNT(*) AS cnt
      FROM referral_events re
      JOIN referral_codes rc ON rc.code = re.code
      WHERE re.event_type = 'convert'
        AND rc.owner_email = ${ownerEmail}
        AND re.created_at >= ${yearStart}
    `);
    const cnt = Number((yearCount.rows[0] as { cnt: string }).cnt ?? 0);
    if (cnt >= 12) return;

    // Look up the referrer's Stripe customer to apply a balance credit.
    const referrerAccount = await db
      .select({ stripeCustomerId: consumerAccountsTable.stripeCustomerId })
      .from(consumerAccountsTable)
      .where(eq(consumerAccountsTable.email, ownerEmail))
      .limit(1);
    const stripeCustomerId = referrerAccount[0]?.stripeCustomerId ?? null;
    if (!stripeCustomerId) return;

    // Find the referrer's active plan amount (one month's value).
    const subs = await listActiveSubscriptionsForCustomer(stripeCustomerId);
    if (!subs.length) return;

    // "One free month" = the referrer's highest-value active plan's monthly
    // equivalent. Using the highest (not cheapest) ensures multi-plan holders
    // get credited for their primary subscription.
    const monthlyAmount = subs.reduce((max, s) => {
      const amt = s.unitAmount ?? 0;
      const monthly =
        s.plan === "annual" ? Math.round(amt / 12) : amt;
      return monthly > max ? monthly : max;
    }, 0);

    if (!Number.isFinite(monthlyAmount) || monthlyAmount <= 0) return;

    // Insert the convert event FIRST with the partial unique index as a
    // concurrency guard. ON CONFLICT DO NOTHING returns 0 rows when a
    // concurrent request already claimed the slot — abort without crediting.
    const inserted = await db.execute(sql`
      INSERT INTO referral_events (code, event_type, recipient_email, credited_cents)
      VALUES (${code}, 'convert', ${recipientEmail}, ${monthlyAmount})
      ON CONFLICT DO NOTHING
      RETURNING id
    `);
    if (!inserted.rows.length) return; // already converted by a concurrent call

    const stripe = await getUncachableStripeClient();
    // Negative amount = credit (reduces what the customer owes).
    await stripe.customers.createBalanceTransaction(stripeCustomerId, {
      amount: -monthlyAmount,
      currency: "usd",
      description: `Referral reward: ${recipientEmail} converted`,
    });
  } catch (err) {
    log.warn({ err }, "referral conversion credit failed (non-fatal)");
  }
}
