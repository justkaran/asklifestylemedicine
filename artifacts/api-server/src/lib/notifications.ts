import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  db,
  phoneSubscribersTable,
  notificationPreferencesTable,
} from "@workspace/db";

// ── Notification channel preferences + account-linked phone status ───────────
// Per-account, per-product "how do we reach you" plumbing shared by the
// /account endpoints and any future send path. Verification is ACCOUNT-LEVEL:
// a number is usable for iMessage once ANY account-linked phone_subscribers row
// for that number is `active`. The per-product `notification_preferences` row is
// the per-product channel choice (email / imessage / both); the absence of a
// row means the safe default, email (we always have a verified account email,
// but never assume a phone exists).

export const NOTIFICATION_PRODUCTS = ["nightly"] as const;
export type NotificationProduct = (typeof NOTIFICATION_PRODUCTS)[number];

export type NotificationChannel = "email" | "imessage" | "both";

/** Account-level phone status, derived across all of the account's rows. */
export type AccountPhoneState = "active" | "pending" | "opted_out" | null;

export interface AccountPhone {
  number: string | null;
  status: AccountPhoneState;
}

export function isNotificationProduct(v: unknown): v is NotificationProduct {
  return v === "nightly";
}

export function isNotificationChannel(v: unknown): v is NotificationChannel {
  return v === "email" || v === "imessage" || v === "both";
}

/**
 * The single phone number linked to an account and its overall status. An
 * account can technically hold multiple rows (one per product), so we collapse
 * to the most "usable" state: any active row wins (the number is confirmed and
 * usable for iMessage), else any pending, else opted_out, else no number.
 */
export async function getAccountPhone(
  accountId: number,
): Promise<AccountPhone> {
  const rows = await db
    .select({
      phone: phoneSubscribersTable.phone,
      status: phoneSubscribersTable.status,
    })
    .from(phoneSubscribersTable)
    .where(eq(phoneSubscribersTable.consumerAccountId, accountId));
  if (rows.length === 0) return { number: null, status: null };

  const byStatus = (s: string) => rows.find((r) => r.status === s);
  const active = byStatus("active");
  if (active) return { number: active.phone, status: "active" };
  const pending = byStatus("pending");
  if (pending) return { number: pending.phone, status: "pending" };
  const optedOut = byStatus("opted_out");
  if (optedOut) return { number: optedOut.phone, status: "opted_out" };
  return { number: rows[0].phone, status: null };
}

/**
 * The account's channel preference for every product, defaulting to "email"
 * for any product without a saved row.
 */
export async function getProductPreferences(
  accountId: number,
): Promise<Record<NotificationProduct, NotificationChannel>> {
  const rows = await db
    .select({
      product: notificationPreferencesTable.product,
      channel: notificationPreferencesTable.channel,
    })
    .from(notificationPreferencesTable)
    .where(eq(notificationPreferencesTable.consumerAccountId, accountId));

  const out: Record<NotificationProduct, NotificationChannel> = {
    nightly: "email",
  };
  for (const r of rows) {
    if (isNotificationProduct(r.product) && isNotificationChannel(r.channel)) {
      out[r.product] = r.channel;
    }
  }
  return out;
}

/** Upsert a single (account, product) channel preference. */
export async function setProductPreference(
  accountId: number,
  product: NotificationProduct,
  channel: NotificationChannel,
): Promise<void> {
  await db
    .insert(notificationPreferencesTable)
    .values({ consumerAccountId: accountId, product, channel })
    .onConflictDoUpdate({
      target: [
        notificationPreferencesTable.consumerAccountId,
        notificationPreferencesTable.product,
      ],
      set: { channel, updatedAt: new Date() },
    });
}

/**
 * Backfill the account link onto every still-anonymous row for a number, never
 * un-linking a row already owned by another account. Used when a signed-in
 * consumer verifies / re-submits a number first captured anonymously.
 */
export async function linkPhoneRowsToAccount(
  accountId: number,
  normalized: string,
): Promise<void> {
  await db
    .update(phoneSubscribersTable)
    .set({ consumerAccountId: accountId })
    .where(
      and(
        eq(phoneSubscribersTable.phone, normalized),
        // Only rows with no owner yet — never steal a row from another account.
        isNull(phoneSubscribersTable.consumerAccountId),
      ),
    );
}

export interface ResolvedTargets {
  /** Email address to notify, or null when the email channel is off. */
  email: string | null;
  /** E.164 number to notify, or null when iMessage is off / unconfirmed. */
  imessage: string | null;
}

/**
 * Resolve, for one account + product, the concrete delivery targets honoring
 * the saved channel preference AND the account's confirmed-phone status. This
 * is the single send-time decision point so every future send path stays
 * consistent: iMessage is only ever returned when the account has an `active`
 * (confirmed, not opted-out) number.
 */
export function resolveTargets(
  channel: NotificationChannel,
  email: string,
  phone: AccountPhone,
): ResolvedTargets {
  const wantsEmail = channel === "email" || channel === "both";
  const wantsImessage = channel === "imessage" || channel === "both";
  const phoneUsable = phone.status === "active" && !!phone.number;
  return {
    email: wantsEmail ? email : null,
    // iMessage is returned ONLY with an active (confirmed, not opted-out)
    // number. Setting an iMessage/both preference is gated on an active phone
    // at write time, so the only way to reach here without a usable number is a
    // later opt-out (STOP), in which case the iMessage target is simply dropped.
    imessage: wantsImessage && phoneUsable ? phone.number : null,
  };
}

export interface AudienceMember {
  accountId: number;
  email: string;
  channel: NotificationChannel;
  targets: ResolvedTargets;
}

/**
 * Send-time audience for a product over a set of already-entitled accounts.
 * Callers pass the accounts entitled to the product (entitlement/cadence is out
 * of scope here); this maps each to its resolved channel targets so a sender can
 * split into an email batch + an iMessage batch while honoring per-account
 * preferences and phone confirmation in one pass.
 */
export async function getNotificationAudience(
  product: NotificationProduct,
  accounts: { id: number; email: string }[],
): Promise<AudienceMember[]> {
  if (accounts.length === 0) return [];
  const ids = accounts.map((a) => a.id);

  const prefRows = await db
    .select({
      consumerAccountId: notificationPreferencesTable.consumerAccountId,
      channel: notificationPreferencesTable.channel,
    })
    .from(notificationPreferencesTable)
    .where(
      and(
        inArray(notificationPreferencesTable.consumerAccountId, ids),
        eq(notificationPreferencesTable.product, product),
      ),
    );
  const prefByAccount = new Map<number, NotificationChannel>();
  for (const r of prefRows) {
    if (isNotificationChannel(r.channel)) {
      prefByAccount.set(r.consumerAccountId, r.channel);
    }
  }

  const phoneRows = await db
    .select({
      consumerAccountId: phoneSubscribersTable.consumerAccountId,
      phone: phoneSubscribersTable.phone,
      status: phoneSubscribersTable.status,
    })
    .from(phoneSubscribersTable)
    .where(inArray(phoneSubscribersTable.consumerAccountId, ids));
  const phoneByAccount = new Map<number, AccountPhone>();
  for (const r of phoneRows) {
    if (r.consumerAccountId == null) continue;
    const cur = phoneByAccount.get(r.consumerAccountId);
    // Same "most usable wins" collapse as getAccountPhone.
    const rank = (s: AccountPhoneState) =>
      s === "active" ? 3 : s === "pending" ? 2 : s === "opted_out" ? 1 : 0;
    const next: AccountPhone = {
      number: r.phone,
      status: r.status as AccountPhoneState,
    };
    if (!cur || rank(next.status) > rank(cur.status)) {
      phoneByAccount.set(r.consumerAccountId, next);
    }
  }

  return accounts.map((a) => {
    const channel = prefByAccount.get(a.id) ?? "email";
    const phone = phoneByAccount.get(a.id) ?? { number: null, status: null };
    return {
      accountId: a.id,
      email: a.email,
      channel,
      targets: resolveTargets(channel, a.email, phone),
    };
  });
}
