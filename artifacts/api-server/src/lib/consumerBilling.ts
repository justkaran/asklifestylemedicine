import type { Request } from "express";
import { eq } from "drizzle-orm";
import { db, consumerAccountsTable } from "@workspace/db";
import { getUncachableStripeClient } from "./stripeClient";
import type { ConsumerAccount } from "./consumerAuth";

/**
 * Shared consumer-billing helpers used by both the sleep-agent billing routes
 * (routes/billing.ts) and the paid newsletter tier (routes/newsletter.ts).
 * Keeping them here avoids one route importing another and keeps the
 * email→consumer→Stripe-customer linkage consistent across surfaces.
 */

/** Absolute site origin for Stripe redirect URLs (must not be relative). */
export function siteBaseUrl(req: Request): string {
  const host = req.get("host");
  if (host) return `${req.protocol}://${host}`;
  return process.env.PUBLIC_URL ?? "https://palonur.replit.app";
}

/** Find an existing consumer account by email, or create one. */
export async function findOrCreateConsumerByEmail(
  email: string,
): Promise<ConsumerAccount> {
  const normalized = email.trim().toLowerCase();
  const existing = await db
    .select()
    .from(consumerAccountsTable)
    .where(eq(consumerAccountsTable.email, normalized))
    .limit(1);
  if (existing[0]) {
    const a = existing[0];
    return {
      id: a.id,
      email: a.email,
      displayName: a.displayName,
      stripeCustomerId: a.stripeCustomerId,
      emailVerifiedAt: a.emailVerifiedAt,
      provisional: false,
    };
  }
  const inserted = await db
    .insert(consumerAccountsTable)
    .values({ email: normalized })
    .returning();
  const a = inserted[0]!;
  return {
    id: a.id,
    email: a.email,
    displayName: a.displayName,
    stripeCustomerId: a.stripeCustomerId,
    emailVerifiedAt: a.emailVerifiedAt,
    provisional: false,
  };
}

/**
 * Ensure the consumer account has a backing Stripe customer, creating one if
 * needed and persisting the id. Requires the Stripe integration to be
 * connected (callers gate on that).
 */
export async function ensureStripeCustomer(
  account: ConsumerAccount,
): Promise<string> {
  if (account.stripeCustomerId) return account.stripeCustomerId;
  const stripe = await getUncachableStripeClient();
  const customer = await stripe.customers.create({
    email: account.email,
    metadata: { palonurConsumerId: String(account.id) },
  });
  await db
    .update(consumerAccountsTable)
    .set({ stripeCustomerId: customer.id })
    .where(eq(consumerAccountsTable.id, account.id));
  return customer.id;
}
