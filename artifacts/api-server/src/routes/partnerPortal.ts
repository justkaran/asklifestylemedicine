import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { randomBytes, createHash } from "node:crypto";
import { z } from "zod/v4";
import { eq, and, isNull, gt, inArray } from "drizzle-orm";
import {
  db,
  partnerAccountsTable,
  partnerAccountSessionsTable,
} from "@workspace/db";
import pool from "../lib/db";
import { checkAdmin } from "./admin";
import {
  getUncachableStripeClient,
  getStripeSync,
  isStripeConnected,
} from "../lib/stripeClient";
import { siteBaseUrl } from "../lib/consumerBilling";
import { emailRateLimit } from "../middlewares/emailRateLimit";
import {
  sendPartnerMagicLink,
  sendPartnerApprovedEmail,
} from "../lib/partnerEmail";

const router: IRouter = Router();

const PARTNER_COOKIE = "partner_session";
const MAGIC_TTL_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Pilot defaults mirror the admin grant + the /platforms table.
const PILOT_DEFAULTS = {
  ratePerMinute: 60,
  ratePerDay: 50_000,
  concurrentStreams: 10,
};

type PartnerAccount = typeof partnerAccountsTable.$inferSelect;

// ── Key minting (same shape as partnerAccess.ts) ─────────────────────────────

function generateKey(): { raw: string; hash: string; prefix: string } {
  const bytes = randomBytes(24).toString("hex");
  const raw = `plnr_live_${bytes}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  const prefix = raw.slice(0, 18);
  return { raw, hash, prefix };
}

function normalizeEmail(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

function inStatuses(statuses: PartnerAccount["status"][]) {
  return inArray(partnerAccountsTable.status, statuses);
}

// ── Billing config (self-serve price IDs come from env) ──────────────────────

function partnerBillingConfig() {
  const subscriptionPriceId = process.env.PARTNER_SUBSCRIPTION_PRICE_ID || null;
  const creditsPriceId = process.env.PARTNER_CREDITS_PRICE_ID || null;
  const creditsPerPurchase = Number(
    process.env.PARTNER_CREDITS_PER_PURCHASE || "1000",
  );
  return {
    subscriptionPriceId,
    creditsPriceId,
    creditsPerPurchase:
      Number.isFinite(creditsPerPurchase) && creditsPerPurchase > 0
        ? Math.floor(creditsPerPurchase)
        : 1000,
  };
}

// ── Partner auth ─────────────────────────────────────────────────────────────

async function getSessionAccount(req: Request): Promise<PartnerAccount | null> {
  const token = req.signedCookies?.[PARTNER_COOKIE] as string | undefined;
  if (!token) return null;
  const rows = await db
    .select()
    .from(partnerAccountSessionsTable)
    .where(eq(partnerAccountSessionsTable.sessionToken, token))
    .limit(1);
  const s = rows[0];
  if (!s) return null;
  if (s.sessionExpiresAt && s.sessionExpiresAt.getTime() < Date.now())
    return null;
  const acct = await db
    .select()
    .from(partnerAccountsTable)
    .where(eq(partnerAccountsTable.id, s.accountId))
    .limit(1);
  return acct[0] ?? null;
}

async function requirePartnerAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const acct = await getSessionAccount(req);
  if (!acct) return res.status(401).json({ error: "Unauthorized" });
  (req as any).partner = acct;
  return next();
}

async function issueMagicLink(
  account: PartnerAccount,
  variant: "magic" | "approved",
): Promise<void> {
  const token = randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + MAGIC_TTL_MS);
  await db.insert(partnerAccountSessionsTable).values({
    accountId: account.id,
    magicToken: token,
    expiresAt,
  });
  if (variant === "approved") {
    await sendPartnerApprovedEmail({
      to: account.email,
      name: account.contactName,
      token,
    });
  } else {
    await sendPartnerMagicLink({
      to: account.email,
      name: account.contactName,
      token,
    });
  }
}

// ── Public: signup (creates a request) ───────────────────────────────────────

const signupSchema = z.object({
  email: z.string().email(),
  companyName: z.string().trim().min(1).max(200),
  contactName: z.string().trim().min(1).max(200),
  intendedUse: z.string().trim().max(2000).optional(),
  acceptLicense: z.literal(true),
});

router.post(
  "/partner-auth/signup",
  emailRateLimit,
  async (req: Request, res: Response) => {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "Invalid signup", details: parsed.error.issues });
    }
    const d = parsed.data;
    const email = normalizeEmail(d.email);
    try {
      const existing = await db
        .select()
        .from(partnerAccountsTable)
        .where(eq(partnerAccountsTable.email, email))
        .limit(1);

      let account = existing[0];
      if (!account) {
        const inserted = await db
          .insert(partnerAccountsTable)
          .values({
            email,
            companyName: d.companyName,
            contactName: d.contactName,
            intendedUse: d.intendedUse ?? null,
            status: "requested",
            licenseAcceptedAt: new Date(),
          })
          .returning();
        account = inserted[0]!;
      } else {
        // Idempotent: refresh the contact details + re-stamp license accept,
        // but never downgrade an already-approved/active account back to
        // "requested". We still email a sign-in link below.
        await db
          .update(partnerAccountsTable)
          .set({
            companyName: d.companyName,
            contactName: d.contactName,
            intendedUse: d.intendedUse ?? account.intendedUse,
            licenseAcceptedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(partnerAccountsTable.id, account.id));
      }
      // Always email a one-time link (sign-in) and always return generic
      // success so we never reveal whether the email already had an account.
      await issueMagicLink(account, "magic");
      return res.json({ ok: true });
    } catch (err) {
      req.log.error({ err }, "Partner signup failed");
      return res.status(500).json({ error: "Could not sign up" });
    }
  },
);

// ── Public: returning-partner sign-in link ───────────────────────────────────

router.post(
  "/partner-auth/request",
  emailRateLimit,
  async (req: Request, res: Response) => {
    const email = normalizeEmail((req.body as { email?: string }).email);
    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "Email required" });
    }
    const rows = await db
      .select()
      .from(partnerAccountsTable)
      .where(eq(partnerAccountsTable.email, email))
      .limit(1);
    const account = rows[0];
    if (!account) {
      // Never leak which emails have partner accounts.
      req.log.warn({ email }, "partner magic-link requested for unknown email");
      return res.json({ ok: true });
    }
    await issueMagicLink(account, "magic");
    return res.json({ ok: true });
  },
);

// ── Public: consume a magic link → set the partner session cookie ────────────

router.get("/partner-auth/consume", async (req: Request, res: Response) => {
  const token = String(req.query.token ?? "");
  if (!token) return res.status(400).json({ error: "Token required" });
  const sessionToken = randomBytes(32).toString("hex");
  const sessionExpiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const consumed = await db
    .update(partnerAccountSessionsTable)
    .set({ consumedAt: new Date(), sessionToken, sessionExpiresAt })
    .where(
      and(
        eq(partnerAccountSessionsTable.magicToken, token),
        isNull(partnerAccountSessionsTable.consumedAt),
        gt(partnerAccountSessionsTable.expiresAt, new Date()),
      ),
    )
    .returning();
  if (consumed.length === 0) {
    return res.status(400).json({ error: "Link expired or already used" });
  }
  res.cookie(PARTNER_COOKIE, sessionToken, {
    signed: true,
    httpOnly: true,
    sameSite: "lax",
    maxAge: SESSION_TTL_MS,
  });
  return res.json({ ok: true });
});

router.post("/partner-auth/logout", (_req: Request, res: Response) => {
  res.clearCookie(PARTNER_COOKIE);
  return res.json({ ok: true });
});

// ── Partner-facing key summary ───────────────────────────────────────────────

interface PortalKeyRow {
  id: number;
  key_prefix: string;
  billing_mode: string;
  requires_payment: boolean;
  stripe_subscription_id: string | null;
  credits_total: number | null;
  credits_used: number;
  revoked_at: string | null;
}

async function loadAccountKey(accountId: number): Promise<PortalKeyRow | null> {
  const { rows } = await pool.query<PortalKeyRow>(
    `SELECT id, key_prefix, billing_mode, requires_payment,
            stripe_subscription_id, credits_total, credits_used, revoked_at
       FROM partner_keys
      WHERE partner_account_id = $1 AND revoked_at IS NULL
      ORDER BY id DESC
      LIMIT 1`,
    [accountId],
  );
  return rows[0] ?? null;
}

async function subscriptionActive(subId: string | null): Promise<boolean | null> {
  if (!subId) return null;
  try {
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM stripe.subscriptions WHERE id = $1`,
      [subId],
    );
    const s = rows[0];
    if (!s) return false;
    return s.status === "active" || s.status === "trialing";
  } catch {
    return null;
  }
}

// ── Partner portal bundle ────────────────────────────────────────────────────

router.get(
  "/partner/portal",
  requirePartnerAuth,
  async (req: Request, res: Response) => {
    const acct = (req as any).partner as PartnerAccount;
    const cfg = partnerBillingConfig();
    const stripeReady = await isStripeConnected();
    const keyRow = await loadAccountKey(acct.id);
    const subActive = keyRow
      ? await subscriptionActive(keyRow.stripe_subscription_id)
      : null;
    const base = siteBaseUrl(req);

    const keySummary = keyRow
      ? {
          keyPrefix: keyRow.key_prefix,
          billingMode: keyRow.billing_mode,
          requiresPayment: keyRow.requires_payment,
          subscriptionActive: subActive,
          creditsRemaining:
            keyRow.credits_total == null
              ? null
              : keyRow.credits_total - keyRow.credits_used,
        }
      : null;

    return res.json({
      account: {
        email: acct.email,
        companyName: acct.companyName,
        contactName: acct.contactName,
        status: acct.status,
      },
      key: keySummary,
      billing: {
        stripeReady,
        subscription: stripeReady && !!cfg.subscriptionPriceId,
        credits: stripeReady && !!cfg.creditsPriceId,
        creditsPerPurchase: cfg.creditsPerPurchase,
      },
      mcp: {
        url: `${base}/api/mcp`,
        agentUrl: `${base}/api/sleep-agent`,
        keyHeader: "X-Palonur-Key",
      },
    });
  },
);

// ── Partner: ensure the linked key exists (create lazily at checkout) ─────────

async function ensureAccountKey(
  account: PartnerAccount,
  billingMode: "subscription" | "credits",
): Promise<number> {
  const existing = await loadAccountKey(account.id);
  if (existing) {
    // Keep the key's billing mode aligned with what the partner is paying for.
    if (existing.billing_mode !== billingMode) {
      await pool.query(
        `UPDATE partner_keys SET billing_mode = $2 WHERE id = $1`,
        [existing.id, billingMode],
      );
    }
    return existing.id;
  }
  const { hash, prefix } = generateKey();
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO partner_keys
       (key_hash, key_prefix, partner_name, contact_email, scopes, tier,
        rate_per_minute, rate_per_day, concurrent_streams,
        origin, requires_payment, billing_mode, partner_account_id)
     VALUES ($1,$2,$3,$4,$5,'pilot',$6,$7,$8,'paid',true,$9,$10)
     RETURNING id`,
    [
      hash,
      prefix,
      account.companyName,
      account.email,
      ["sleep-agent"],
      PILOT_DEFAULTS.ratePerMinute,
      PILOT_DEFAULTS.ratePerDay,
      PILOT_DEFAULTS.concurrentStreams,
      billingMode,
      account.id,
    ],
  );
  return rows[0]!.id;
}

async function ensurePartnerStripeCustomer(
  account: PartnerAccount,
): Promise<string> {
  if (account.stripeCustomerId) return account.stripeCustomerId;
  const stripe = await getUncachableStripeClient();
  const customer = await stripe.customers.create({
    email: account.email,
    name: account.companyName,
    metadata: { palonurPartnerAccountId: String(account.id) },
  });
  await db
    .update(partnerAccountsTable)
    .set({ stripeCustomerId: customer.id, updatedAt: new Date() })
    .where(eq(partnerAccountsTable.id, account.id));
  return customer.id;
}

// ── Partner: self-serve checkout ─────────────────────────────────────────────

const checkoutSchema = z.object({
  mode: z.enum(["subscription", "credits"]),
});

router.post(
  "/partner/checkout",
  requirePartnerAuth,
  async (req: Request, res: Response) => {
    const acct = (req as any).partner as PartnerAccount;
    if (acct.status !== "approved" && acct.status !== "active") {
      return res
        .status(403)
        .json({ error: "Your account is not approved for payment yet" });
    }
    if (!(await isStripeConnected())) {
      return res.status(503).json({ error: "Billing is not available yet" });
    }
    const parsed = checkoutSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid checkout" });
    }
    const mode = parsed.data.mode;
    const cfg = partnerBillingConfig();
    const priceId =
      mode === "subscription" ? cfg.subscriptionPriceId : cfg.creditsPriceId;
    if (!priceId) {
      return res
        .status(503)
        .json({ error: "Self-serve billing for this option is not configured" });
    }
    try {
      const keyId = await ensureAccountKey(acct, mode);
      const customerId = await ensurePartnerStripeCustomer(acct);
      // Persist the customer onto the key too, so the existing confirm path
      // and admin views resolve a stable customer.
      await pool.query(
        `UPDATE partner_keys SET stripe_customer_id = COALESCE(stripe_customer_id, $2) WHERE id = $1`,
        [keyId, customerId],
      );
      const stripe = await getUncachableStripeClient();
      const base = siteBaseUrl(req);
      const session = await stripe.checkout.sessions.create({
        mode: mode === "subscription" ? "subscription" : "payment",
        line_items: [{ price: priceId, quantity: 1 }],
        customer: customerId,
        success_url: `${base}/partner?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${base}/partner?payment=cancelled`,
        ...(mode === "subscription" ? { allow_promotion_codes: true } : {}),
        metadata: {
          partnerKeyId: String(keyId),
          kind: mode,
          ...(mode === "credits"
            ? { creditsAdded: String(cfg.creditsPerPurchase) }
            : {}),
        },
      });
      if (!session.url) {
        return res.status(502).json({ error: "Could not start checkout" });
      }
      return res.json({ url: session.url });
    } catch (err) {
      req.log.error({ err }, "Partner self-serve checkout failed");
      return res.status(500).json({ error: "Could not start checkout" });
    }
  },
);

// ── Partner: generate / rotate the API key (reveal once) ─────────────────────

router.post(
  "/partner/key",
  requirePartnerAuth,
  async (req: Request, res: Response) => {
    const acct = (req as any).partner as PartnerAccount;
    if (acct.status !== "active") {
      return res
        .status(403)
        .json({ error: "Complete payment before generating a key" });
    }
    const keyRow = await loadAccountKey(acct.id);
    if (!keyRow) {
      return res
        .status(409)
        .json({ error: "No key to generate — complete payment first" });
    }
    const { raw, hash, prefix } = generateKey();
    // Rotate in place: the same row keeps its billing + account link, the old
    // secret stops working immediately, and the new raw key is shown once.
    await pool.query(
      `UPDATE partner_keys SET key_hash = $2, key_prefix = $3 WHERE id = $1`,
      [keyRow.id, hash, prefix],
    );
    return res.json({ rawKey: raw, keyPrefix: prefix });
  },
);

// ── Admin: list partner accounts (requests + approved/active) ────────────────

interface AdminAccountRow {
  id: number;
  email: string;
  company_name: string;
  contact_name: string;
  intended_use: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
  has_key: boolean;
}

router.get(
  "/partner-access/accounts",
  checkAdmin,
  async (req: Request, res: Response) => {
    try {
      const { rows } = await pool.query<AdminAccountRow>(`
        SELECT a.id, a.email, a.company_name, a.contact_name, a.intended_use,
               a.status, a.notes, a.created_at, a.updated_at,
               EXISTS (
                 SELECT 1 FROM partner_keys pk
                  WHERE pk.partner_account_id = a.id AND pk.revoked_at IS NULL
               ) AS has_key
          FROM partner_accounts a
         ORDER BY
           CASE a.status WHEN 'requested' THEN 0 WHEN 'approved' THEN 1
                         WHEN 'active' THEN 2 ELSE 3 END,
           a.created_at DESC
      `);
      return res.json({
        accounts: rows.map((r) => ({
          id: r.id,
          email: r.email,
          companyName: r.company_name,
          contactName: r.contact_name,
          intendedUse: r.intended_use,
          status: r.status,
          notes: r.notes,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          hasKey: r.has_key,
        })),
      });
    } catch (err) {
      req.log.error({ err }, "Failed to list partner accounts");
      return res.status(500).json({ error: "Could not list partner accounts" });
    }
  },
);

// ── Admin: approve a request (emails the partner a sign-in link) ─────────────

router.post(
  "/partner-access/accounts/:id/approve",
  checkAdmin,
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid id" });
    }
    try {
      // Only a 'requested' (or already-approved) account may move to approved;
      // never resurrect a rejected/suspended one without an explicit reset.
      const updated = await db
        .update(partnerAccountsTable)
        .set({ status: "approved", updatedAt: new Date() })
        .where(
          and(
            eq(partnerAccountsTable.id, id),
            inStatuses(["requested", "approved"]),
          ),
        )
        .returning();
      const acct = updated[0];
      if (!acct) {
        return res
          .status(409)
          .json({ error: "Account not found or not in a requestable state" });
      }
      await issueMagicLink(acct, "approved");
      return res.json({ ok: true, status: acct.status });
    } catch (err) {
      req.log.error({ err }, "Failed to approve partner account");
      return res.status(500).json({ error: "Could not approve account" });
    }
  },
);

// ── Admin: reject a request ──────────────────────────────────────────────────

const rejectSchema = z.object({ notes: z.string().trim().max(2000).optional() });

router.post(
  "/partner-access/accounts/:id/reject",
  checkAdmin,
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid id" });
    }
    const parsed = rejectSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid reject" });
    }
    try {
      const updated = await db
        .update(partnerAccountsTable)
        .set({
          status: "rejected",
          notes: parsed.data.notes ?? null,
          updatedAt: new Date(),
        })
        .where(eq(partnerAccountsTable.id, id))
        .returning();
      if (updated.length === 0) {
        return res.status(404).json({ error: "Account not found" });
      }
      return res.json({ ok: true, status: "rejected" });
    } catch (err) {
      req.log.error({ err }, "Failed to reject partner account");
      return res.status(500).json({ error: "Could not reject account" });
    }
  },
);

export default router;
