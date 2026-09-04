/**
 * Consumer account hub — a single "manage my subscriptions & memberships"
 * surface for a signed-in consumer (the `palonur_consumer` cookie).
 *
 * This is the end-user counterpart to the per-feature billing routes: it unions
 * a consumer's paid Stripe subscriptions (derived capabilities), their free/paid
 * newsletter memberships, and the catalogue of publications they could read.
 * It NEVER exposes any other account's data and NEVER mutates billing — Stripe
 * changes go through the customer portal (`POST /api/billing/portal`).
 *
 * Every read degrades gracefully when Stripe isn't connected: capabilities and
 * paid subscriptions resolve empty, and the newsletter memberships (which live
 * in our own tables) still render.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { randomBytes } from "crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  db,
  consumerAccountsTable,
  newsletterSubscribersTable,
  newsletterPublicationsTable,
  phoneSubscribersTable,
} from "@workspace/db";
import {
  getConsumerFromRequest,
  getConsumerCapabilities,
  listActiveSubscriptionsForCustomer,
  type ConsumerAccount,
} from "../lib/consumerAuth";
import {
  NOTIFICATION_PRODUCTS,
  isNotificationProduct,
  getAccountPhone,
  getProductPreferences,
  setProductPreference,
  linkPhoneRowsToAccount,
  type NotificationProduct,
} from "../lib/notifications";
import { normalizeE164 } from "./phone";
import { ensureHousePublication } from "./newsletter";
import { sendImessage } from "../lib/imessage";
import {
  UpdateNotificationChannelBody,
  AddAccountPhoneBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

const BASE_URL = process.env.PUBLIC_URL ?? "https://palonur.replit.app";

/**
 * Build the caller's full notification settings: account email, the status of
 * any account-linked phone, and the per-product channel preference alongside
 * whether they're currently entitled to that product. Shared by the GET and the
 * mutating endpoints so every response is consistent.
 */
async function buildNotificationSettings(account: ConsumerAccount) {
  const [phone, prefs, capabilities] = await Promise.all([
    getAccountPhone(account.id),
    getProductPreferences(account.id),
    getConsumerCapabilities(account.stripeCustomerId),
  ]);
  return {
    email: account.email,
    phone,
    products: NOTIFICATION_PRODUCTS.map((product) => ({
      product,
      channel: prefs[product],
      subscribed: capabilities.has(product),
    })),
  };
}

/** Product-agnostic account-level phone confirmation text (one confirmation). */
function buildAccountOptInMessage(token: string): string {
  const confirmUrl = `${BASE_URL}/api/phone/confirm?token=${token}`;
  return (
    `Palonur: confirm this number to get your texts. ` +
    `Reply YES to confirm, or tap ${confirmUrl}. Reply STOP to opt out.`
  );
}

/**
 * Set (or clear) the caller's display name. Plain text only, 80 chars max;
 * an empty string clears it.
 */
router.put("/account/name", async (req: Request, res: Response) => {
  const account = await getConsumerFromRequest(req);
  if (!account) return res.status(401).json({ error: "Not signed in" });

  const raw = (req.body as { displayName?: unknown })?.displayName;
  if (typeof raw !== "string") {
    return res.status(400).json({ error: "displayName must be a string" });
  }
  const displayName = raw.replace(/\s+/g, " ").trim().slice(0, 80) || null;
  try {
    await db
      .update(consumerAccountsTable)
      .set({ displayName })
      .where(eq(consumerAccountsTable.id, account.id));
    return res.json({ ok: true, displayName });
  } catch (e) {
    req.log.error({ err: e }, "account name update failed");
    return res.status(500).json({ error: "Failed to save name" });
  }
});

/**
 * Lightweight profile settings for the end user: name, email, member-since
 * date, and the house-newsletter opt-in state. Read-only companion to
 * PUT /account/name and PUT /account/newsletter below.
 */
router.get("/account/settings", async (req: Request, res: Response) => {
  const account = await getConsumerFromRequest(req);
  if (!account) return res.status(401).json({ error: "Not signed in" });

  try {
    const house = await ensureHousePublication();
    const [[acctRow], [subRow]] = await Promise.all([
      db
        .select({ createdAt: consumerAccountsTable.createdAt })
        .from(consumerAccountsTable)
        .where(eq(consumerAccountsTable.id, account.id))
        .limit(1),
      db
        .select({ status: newsletterSubscribersTable.status })
        .from(newsletterSubscribersTable)
        .where(
          and(
            eq(newsletterSubscribersTable.publicationId, house.id),
            eq(newsletterSubscribersTable.email, account.email),
          ),
        )
        .limit(1),
    ]);
    return res.json({
      email: account.email,
      displayName: account.displayName,
      memberSince: acctRow?.createdAt?.toISOString() ?? null,
      newsletterStatus: subRow?.status ?? "none",
      newsletterOptedIn:
        subRow?.status === "active" || subRow?.status === "pending",
    });
  } catch (e) {
    req.log.error({ err: e }, "account settings read failed");
    return res.status(500).json({ error: "Failed to load settings" });
  }
});

/**
 * Newsletter opt-in / opt-out from account settings. A signed-in,
 * email-verified account has already proven ownership of its address (the
 * magic-link sign-in), so opting IN activates immediately — no second
 * confirmation email. Unverified (provisional) sessions are rejected by
 * getConsumerFromRequest, keeping double opt-in intact for everyone else.
 */
router.put("/account/newsletter", async (req: Request, res: Response) => {
  const account = await getConsumerFromRequest(req);
  if (!account) return res.status(401).json({ error: "Not signed in" });

  const optIn = (req.body as { optIn?: unknown })?.optIn;
  if (typeof optIn !== "boolean") {
    return res.status(400).json({ error: "optIn must be a boolean" });
  }

  try {
    const house = await ensureHousePublication();
    const [existing] = await db
      .select()
      .from(newsletterSubscribersTable)
      .where(
        and(
          eq(newsletterSubscribersTable.publicationId, house.id),
          eq(newsletterSubscribersTable.email, account.email),
        ),
      )
      .limit(1);

    if (optIn) {
      if (!account.emailVerifiedAt) {
        // Belt and braces: never activate an unproven address directly.
        return res.status(403).json({ error: "Verify your email first" });
      }
      if (existing) {
        await db
          .update(newsletterSubscribersTable)
          .set({
            status: "active",
            confirmedAt: existing.confirmedAt ?? new Date(),
            unsubscribedAt: null,
            name: existing.name ?? account.displayName,
          })
          .where(eq(newsletterSubscribersTable.id, existing.id));
      } else {
        await db.insert(newsletterSubscribersTable).values({
          publicationId: house.id,
          email: account.email,
          name: account.displayName,
          source: "account-settings",
          status: "active",
          unsubscribeToken: randomBytes(24).toString("hex"),
          confirmedAt: new Date(),
        });
      }
      return res.json({
        ok: true,
        newsletterOptedIn: true,
        newsletterStatus: "active",
      });
    }

    if (existing && existing.status !== "unsubscribed") {
      await db
        .update(newsletterSubscribersTable)
        .set({ status: "unsubscribed", unsubscribedAt: new Date() })
        .where(eq(newsletterSubscribersTable.id, existing.id));
    }
    return res.json({
      ok: true,
      newsletterOptedIn: false,
      newsletterStatus: "unsubscribed",
    });
  } catch (e) {
    req.log.error({ err: e }, "account newsletter toggle failed");
    return res
      .status(500)
      .json({ error: "Failed to update newsletter preference" });
  }
});

router.get("/account", async (req: Request, res: Response) => {
  const account = await getConsumerFromRequest(req);
  if (!account) return res.status(401).json({ error: "Not signed in" });

  try {
    const [
      capabilities,
      paidSubscriptions,
      memberships,
      availablePublications,
    ] = await Promise.all([
      getConsumerCapabilities(account.stripeCustomerId),
      listActiveSubscriptionsForCustomer(account.stripeCustomerId),
      db
        .select({
          publicationId: newsletterPublicationsTable.id,
          name: newsletterPublicationsTable.name,
          slug: newsletterPublicationsTable.slug,
          tagline: newsletterPublicationsTable.tagline,
          accentColor: newsletterPublicationsTable.accentColor,
          isHouse: newsletterPublicationsTable.isHouse,
          subscribedAt: newsletterSubscribersTable.createdAt,
        })
        .from(newsletterSubscribersTable)
        .innerJoin(
          newsletterPublicationsTable,
          eq(
            newsletterPublicationsTable.id,
            newsletterSubscribersTable.publicationId,
          ),
        )
        .where(
          and(
            eq(newsletterSubscribersTable.email, account.email),
            eq(newsletterSubscribersTable.status, "active"),
          ),
        )
        .orderBy(desc(newsletterPublicationsTable.isHouse)),
      db
        .select({
          id: newsletterPublicationsTable.id,
          name: newsletterPublicationsTable.name,
          slug: newsletterPublicationsTable.slug,
          tagline: newsletterPublicationsTable.tagline,
          accentColor: newsletterPublicationsTable.accentColor,
          isHouse: newsletterPublicationsTable.isHouse,
        })
        .from(newsletterPublicationsTable)
        .orderBy(desc(newsletterPublicationsTable.isHouse)),
    ]);

    // Steward Q&A subscriptions carry a publication id; resolve it to a
    // slug + name so the hub can link "Ask …" straight to /p/:slug.
    const stewardPubIds = Array.from(
      new Set(
        paidSubscriptions
          .map((s) => s.stewardPublicationId)
          .filter((id): id is number => id != null),
      ),
    );
    const stewardPubs = stewardPubIds.length
      ? await db
          .select({
            id: newsletterPublicationsTable.id,
            name: newsletterPublicationsTable.name,
            slug: newsletterPublicationsTable.slug,
          })
          .from(newsletterPublicationsTable)
          .where(inArray(newsletterPublicationsTable.id, stewardPubIds))
      : [];
    const pubById = new Map(stewardPubs.map((p) => [p.id, p]));
    const paidWithSteward = paidSubscriptions.map((s) => {
      const pub =
        s.stewardPublicationId != null
          ? pubById.get(s.stewardPublicationId)
          : undefined;
      return {
        ...s,
        stewardPublicationSlug: pub?.slug ?? null,
        stewardPublicationName: pub?.name ?? null,
      };
    });

    return res.json({
      email: account.email,
      displayName: account.displayName,
      capabilities: Array.from(capabilities),
      paidSubscriptions: paidWithSteward,
      newsletterMemberships: memberships,
      availablePublications,
    });
  } catch (e) {
    req.log.error({ err: e }, "account hub load failed");
    return res.status(500).json({ error: "Failed to load account" });
  }
});

/**
 * Unsubscribe the signed-in consumer from one newsletter publication. Only ever
 * touches the caller's own membership row (scoped by the cookie-resolved email),
 * so a consumer can't unsubscribe anyone else.
 */
router.post(
  "/account/newsletters/:publicationId/unsubscribe",
  async (req: Request, res: Response) => {
    const account = await getConsumerFromRequest(req);
    if (!account) return res.status(401).json({ error: "Not signed in" });

    const publicationId = Number(req.params.publicationId);
    if (!Number.isInteger(publicationId) || publicationId <= 0) {
      return res.status(400).json({ error: "Invalid publication" });
    }

    try {
      const updated = await db
        .update(newsletterSubscribersTable)
        .set({ status: "unsubscribed" })
        .where(
          and(
            eq(newsletterSubscribersTable.email, account.email),
            eq(newsletterSubscribersTable.publicationId, publicationId),
            eq(newsletterSubscribersTable.status, "active"),
          ),
        )
        .returning({ id: newsletterSubscribersTable.id });
      return res.json({ ok: true, removed: updated.length > 0 });
    } catch (e) {
      req.log.error({ err: e }, "account newsletter unsubscribe failed");
      return res.status(500).json({ error: "Failed to unsubscribe" });
    }
  },
);

// ── Notification channel preferences (signed-in consumer only) ───────────────

/** GET the caller's per-product channel preferences + phone status. */
router.get("/account/notifications", async (req: Request, res: Response) => {
  const account = await getConsumerFromRequest(req);
  if (!account) return res.status(401).json({ error: "Not signed in" });
  try {
    return res.json(await buildNotificationSettings(account));
  } catch (e) {
    req.log.error({ err: e }, "notification settings load failed");
    return res.status(500).json({ error: "Failed to load settings" });
  }
});

/**
 * Set the channel for one product. Choosing iMessage/both requires a confirmed
 * (active) account-linked number — otherwise we'd promise texts we can't send.
 */
router.put(
  "/account/notifications/:product",
  async (req: Request, res: Response) => {
    const account = await getConsumerFromRequest(req);
    if (!account) return res.status(401).json({ error: "Not signed in" });

    const product = req.params.product;
    if (!isNotificationProduct(product)) {
      return res.status(400).json({ error: "Invalid product" });
    }
    const parsed = UpdateNotificationChannelBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid channel" });
    }
    const { channel } = parsed.data;

    try {
      if (channel === "imessage" || channel === "both") {
        const phone = await getAccountPhone(account.id);
        if (phone.status !== "active") {
          return res.status(400).json({
            error: "Confirm a phone number before enabling iMessage",
          });
        }
      }
      await setProductPreference(
        account.id,
        product as NotificationProduct,
        channel,
      );
      return res.json(await buildNotificationSettings(account));
    } catch (e) {
      req.log.error({ err: e }, "notification channel update failed");
      return res.status(500).json({ error: "Failed to update settings" });
    }
  },
);

/**
 * Link + verify a phone number for the signed-in consumer. Reuses the existing
 * double opt-in: links any anonymous rows for the number to the account, then
 * (idempotently) sends ONE confirmation text. Verification is account-level —
 * once any of the account's rows is active the number is usable for iMessage on
 * every product (no per-product re-confirmation).
 */
router.post("/account/phone", async (req: Request, res: Response) => {
  const account = await getConsumerFromRequest(req);
  if (!account) return res.status(401).json({ error: "Not signed in" });

  const parsed = AddAccountPhoneBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request" });
  }
  const { phone, consent } = parsed.data;
  if (consent !== true) {
    return res.status(400).json({ error: "Consent is required" });
  }
  const normalized = normalizeE164(phone);
  if (!normalized) {
    return res.status(400).json({ error: "A valid phone number is required" });
  }

  try {
    // Adopt any anonymous rows for this number onto the account first.
    await linkPhoneRowsToAccount(account.id, normalized);

    const rows = await db
      .select()
      .from(phoneSubscribersTable)
      .where(eq(phoneSubscribersTable.phone, normalized));

    // `linkPhoneRowsToAccount` adopted only NULL-owner rows, so any row still
    // owned by a different account genuinely belongs to someone else. NEVER
    // mutate or claim it — the number is already associated with another
    // account. Reject with a generic message (don't leak whose).
    if (
      rows.some(
        (r) =>
          r.consumerAccountId != null && r.consumerAccountId !== account.id,
      )
    ) {
      return res
        .status(409)
        .json({ error: "This number is linked to another account" });
    }
    // From here on, every remaining row is owned by this account (or was just
    // adopted from NULL ownership above).
    const ownRows = rows.filter((r) => r.consumerAccountId === account.id);

    if (ownRows.some((r) => r.status === "active")) {
      return res.json({ ok: true, alreadyConfirmed: true });
    }
    // A confirmation text is already outstanding — idempotent no-op, no re-spam.
    if (ownRows.some((r) => r.status === "pending")) {
      return res.json({ ok: true, pending: true });
    }

    const confirmToken = randomBytes(24).toString("hex");
    const optedOut = ownRows.find((r) => r.status === "opted_out");
    if (optedOut) {
      // Genuine new consent cycle after a prior STOP — reactivate one row.
      // Owner-scoped WHERE for defense in depth (never reassign a foreign row).
      await db
        .update(phoneSubscribersTable)
        .set({
          status: "pending",
          source: "account",
          consentAt: new Date(),
          confirmToken,
          confirmedAt: null,
          optedOutAt: null,
          consumerAccountId: account.id,
        })
        .where(
          and(
            eq(phoneSubscribersTable.id, optedOut.id),
            eq(phoneSubscribersTable.consumerAccountId, account.id),
          ),
        );
    } else {
      // Brand-new number for this account. The product slot is arbitrary
      // (status is account-level); default to nightly.
      await db.insert(phoneSubscribersTable).values({
        phone: normalized,
        product: "nightly",
        status: "pending",
        source: "account",
        consentAt: new Date(),
        confirmToken,
        consumerAccountId: account.id,
      });
    }
    await sendImessage({
      to: normalized,
      body: buildAccountOptInMessage(confirmToken),
      label: "account phone opt-in confirmation",
    });
    return res.json({ ok: true, pending: true });
  } catch (e) {
    req.log.error({ err: e }, "account phone link failed");
    return res.status(500).json({ error: "Failed to add phone" });
  }
});

export default router;
