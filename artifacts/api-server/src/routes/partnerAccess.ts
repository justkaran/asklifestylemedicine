import { Router, type IRouter, type Request, type Response } from "express";
import { randomBytes, createHash } from "node:crypto";
import { z } from "zod/v4";
import pool from "../lib/db";
import { checkAdmin } from "./admin";
import {
  getUncachableStripeClient,
  getStripeSync,
  isStripeConnected,
} from "../lib/stripeClient";
import { siteBaseUrl } from "../lib/consumerBilling";

const router: IRouter = Router();

// ── Key minting (mirrors scripts/src/partner-keys.ts) ───────────────────────

function generateKey(): { raw: string; hash: string; prefix: string } {
  const bytes = randomBytes(24).toString("hex"); // 48 hex chars
  const raw = `plnr_live_${bytes}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  const prefix = raw.slice(0, 18); // plnr_live_ + first 8 hex
  return { raw, hash, prefix };
}

// ── Row shapes ──────────────────────────────────────────────────────────────

interface KeyRow {
  id: number;
  key_prefix: string;
  partner_name: string;
  contact_email: string | null;
  scopes: string[];
  tier: string;
  rate_per_minute: number;
  rate_per_day: number;
  concurrent_streams: number;
  notes: string | null;
  origin: string;
  requires_payment: boolean;
  billing_mode: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  credits_total: number | null;
  credits_used: number;
  created_at: string;
  revoked_at: string | null;
  query_count: number;
  last_used: string | null;
}

function serializeKey(r: KeyRow, subActive: boolean | null) {
  return {
    id: r.id,
    keyPrefix: r.key_prefix,
    partnerName: r.partner_name,
    contactEmail: r.contact_email,
    scopes: r.scopes,
    tier: r.tier,
    ratePerMinute: r.rate_per_minute,
    ratePerDay: r.rate_per_day,
    concurrentStreams: r.concurrent_streams,
    notes: r.notes,
    origin: r.origin,
    requiresPayment: r.requires_payment,
    billingMode: r.billing_mode,
    stripeCustomerId: r.stripe_customer_id,
    stripeSubscriptionId: r.stripe_subscription_id,
    creditsTotal: r.credits_total,
    creditsUsed: r.credits_used,
    creditsRemaining:
      r.credits_total == null ? null : r.credits_total - r.credits_used,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
    queryCount: Number(r.query_count),
    lastUsed: r.last_used,
    active: !r.revoked_at,
    subscriptionActive: subActive,
  };
}

// ── Admin: list keys + usage ─────────────────────────────────────────────────

router.get("/partner-access", checkAdmin, async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query<KeyRow>(`
      SELECT pk.*,
             COALESCE(u.cnt, 0) AS query_count,
             u.last_used AS last_used
      FROM partner_keys pk
      LEFT JOIN (
        SELECT partner_key_id,
               COUNT(*) AS cnt,
               MAX(created_at) AS last_used
        FROM agent_queries
        WHERE partner_key_id IS NOT NULL
        GROUP BY partner_key_id
      ) u ON u.partner_key_id = pk.id
      ORDER BY pk.id DESC
    `);

    // Best-effort: resolve which subscription-billed keys have an active
    // Stripe subscription, in one query. The stripe.* schema only exists when
    // Stripe is connected + synced, so failures degrade to "unknown" (null).
    const subIds = rows
      .map((r) => r.stripe_subscription_id)
      .filter((s): s is string => Boolean(s));
    const subStatus = new Map<string, boolean>();
    if (subIds.length > 0) {
      try {
        const { rows: subs } = await pool.query<{ id: string; status: string }>(
          `SELECT id, status FROM stripe.subscriptions WHERE id = ANY($1::text[])`,
          [subIds],
        );
        for (const s of subs) {
          subStatus.set(s.id, s.status === "active" || s.status === "trialing");
        }
      } catch (err) {
        req.log.warn({ err }, "Could not resolve partner subscription status");
      }
    }

    const keys = rows.map((r) =>
      serializeKey(
        r,
        r.billing_mode === "subscription" && r.stripe_subscription_id
          ? (subStatus.get(r.stripe_subscription_id) ?? false)
          : null,
      ),
    );
    return res.json({ keys });
  } catch (err) {
    req.log.error({ err }, "Failed to list partner keys");
    return res.status(500).json({ error: "Could not list partner keys" });
  }
});

// ── Admin: grant a new key (raw key returned exactly once) ───────────────────

const grantSchema = z
  .object({
    partnerName: z.string().trim().min(1),
    contactEmail: z.string().email().nullish(),
    scopes: z.array(z.string().trim().min(1)).min(1).default(["sleep-agent"]),
    tier: z.enum(["pilot", "production"]).default("pilot"),
    ratePerMinute: z.number().int().positive().optional(),
    ratePerDay: z.number().int().positive().optional(),
    concurrentStreams: z.number().int().positive().optional(),
    notes: z.string().nullish(),
    requiresPayment: z.boolean().default(false),
    billingMode: z.enum(["none", "subscription", "credits"]).default("none"),
    creditsTotal: z.number().int().positive().nullish(),
  })
  .refine(
    (v) => !v.requiresPayment || v.billingMode !== "none",
    "A payment-gated key needs a billing mode of subscription or credits",
  );

router.post("/partner-access", checkAdmin, async (req: Request, res: Response) => {
  const parsed = grantSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid grant", details: parsed.error.issues });
  }
  const d = parsed.data;
  const { raw, hash, prefix } = generateKey();
  // Origin is descriptive: a key the admin intends to bill is `paid`, an
  // unconditional grant is `granted`. Enforcement is driven by requiresPayment.
  const origin = d.requiresPayment ? "paid" : "granted";
  try {
    const { rows } = await pool.query<KeyRow>(
      `INSERT INTO partner_keys
         (key_hash, key_prefix, partner_name, contact_email, scopes, tier,
          rate_per_minute, rate_per_day, concurrent_streams, notes,
          origin, requires_payment, billing_mode, credits_total)
       VALUES ($1,$2,$3,$4,$5,$6,
               COALESCE($7,60), COALESCE($8,50000), COALESCE($9,10), $10,
               $11,$12,$13,$14)
       RETURNING *, 0 AS query_count, NULL AS last_used`,
      [
        hash,
        prefix,
        d.partnerName,
        d.contactEmail ?? null,
        d.scopes,
        d.tier,
        d.ratePerMinute ?? null,
        d.ratePerDay ?? null,
        d.concurrentStreams ?? null,
        d.notes ?? null,
        origin,
        d.requiresPayment,
        d.billingMode,
        d.creditsTotal ?? null,
      ],
    );
    // The raw key is returned ONCE here and never stored — only its hash lands
    // in the DB. The admin UI must surface it immediately for copy.
    return res.json({ key: serializeKey(rows[0], null), rawKey: raw });
  } catch (err) {
    req.log.error({ err }, "Failed to grant partner key");
    return res.status(500).json({ error: "Could not grant partner key" });
  }
});

// ── Admin: update a key ──────────────────────────────────────────────────────

const patchSchema = z.object({
  partnerName: z.string().trim().min(1).optional(),
  contactEmail: z.string().email().nullish(),
  scopes: z.array(z.string().trim().min(1)).min(1).optional(),
  tier: z.enum(["pilot", "production"]).optional(),
  ratePerMinute: z.number().int().positive().optional(),
  ratePerDay: z.number().int().positive().optional(),
  concurrentStreams: z.number().int().positive().optional(),
  notes: z.string().nullish(),
  requiresPayment: z.boolean().optional(),
  billingMode: z.enum(["none", "subscription", "credits"]).optional(),
  creditsTotal: z.number().int().positive().nullish(),
});

const PATCH_COLUMNS: Record<string, string> = {
  partnerName: "partner_name",
  contactEmail: "contact_email",
  scopes: "scopes",
  tier: "tier",
  ratePerMinute: "rate_per_minute",
  ratePerDay: "rate_per_day",
  concurrentStreams: "concurrent_streams",
  notes: "notes",
  requiresPayment: "requires_payment",
  billingMode: "billing_mode",
  creditsTotal: "credits_total",
};

router.patch(
  "/partner-access/:id",
  checkAdmin,
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid id" });
    }
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "Invalid update", details: parsed.error.issues });
    }
    const entries = Object.entries(parsed.data).filter(
      ([, v]) => v !== undefined,
    );
    if (entries.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }
    const sets: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    for (const [k, v] of entries) {
      const col = PATCH_COLUMNS[k];
      if (!col) continue;
      sets.push(`${col} = $${i++}`);
      values.push(v);
    }
    values.push(id);
    try {
      const { rows } = await pool.query<KeyRow>(
        `UPDATE partner_keys SET ${sets.join(", ")}
         WHERE id = $${i}
         RETURNING *, 0 AS query_count, NULL AS last_used`,
        values,
      );
      if (rows.length === 0) {
        return res.status(404).json({ error: "Key not found" });
      }
      return res.json({ key: serializeKey(rows[0], null) });
    } catch (err) {
      req.log.error({ err }, "Failed to update partner key");
      return res.status(500).json({ error: "Could not update partner key" });
    }
  },
);

// ── Admin: revoke a key ──────────────────────────────────────────────────────

router.post(
  "/partner-access/:id/revoke",
  checkAdmin,
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid id" });
    }
    try {
      const { rows } = await pool.query<{ id: number }>(
        `UPDATE partner_keys SET revoked_at = NOW()
         WHERE id = $1 AND revoked_at IS NULL
         RETURNING id`,
        [id],
      );
      // Idempotent: an already-revoked (or missing) key is a no-op success.
      return res.json({ ok: true, revoked: rows.length > 0 });
    } catch (err) {
      req.log.error({ err }, "Failed to revoke partner key");
      return res.status(500).json({ error: "Could not revoke partner key" });
    }
  },
);

// ── Admin: create a Stripe payment link for a key ────────────────────────────

const paymentLinkSchema = z
  .object({
    mode: z.enum(["subscription", "credits"]),
    priceId: z.string().trim().min(1),
    creditsToAdd: z.number().int().positive().optional(),
    quantity: z.number().int().positive().default(1),
  })
  .refine(
    (v) => v.mode !== "credits" || typeof v.creditsToAdd === "number",
    "creditsToAdd is required when mode is credits",
  );

router.post(
  "/partner-access/:id/payment-link",
  checkAdmin,
  async (req: Request, res: Response) => {
    if (!(await isStripeConnected())) {
      return res.status(503).json({ error: "Billing is not available yet" });
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid id" });
    }
    const parsed = paymentLinkSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "Invalid payment link", details: parsed.error.issues });
    }
    const d = parsed.data;
    try {
      const { rows } = await pool.query<{
        id: number;
        contact_email: string | null;
        stripe_customer_id: string | null;
      }>(
        `SELECT id, contact_email, stripe_customer_id
         FROM partner_keys WHERE id = $1`,
        [id],
      );
      const key = rows[0];
      if (!key) return res.status(404).json({ error: "Key not found" });

      const stripe = await getUncachableStripeClient();
      const base = siteBaseUrl(req);
      const session = await stripe.checkout.sessions.create({
        mode: d.mode === "subscription" ? "subscription" : "payment",
        line_items: [{ price: d.priceId, quantity: d.quantity }],
        success_url: `${base}/agent-access/confirm?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${base}/agent-license?payment=cancelled`,
        ...(key.stripe_customer_id
          ? { customer: key.stripe_customer_id }
          : key.contact_email
            ? { customer_email: key.contact_email }
            : {}),
        ...(d.mode === "subscription" ? { allow_promotion_codes: true } : {}),
        metadata: {
          partnerKeyId: String(id),
          kind: d.mode,
          ...(d.mode === "credits"
            ? { creditsAdded: String(d.creditsToAdd) }
            : {}),
        },
      });
      if (!session.url) {
        return res.status(502).json({ error: "Could not create payment link" });
      }
      return res.json({ url: session.url });
    } catch (err) {
      req.log.error({ err }, "Failed to create partner payment link");
      return res.status(500).json({ error: "Could not create payment link" });
    }
  },
);

// ── Public: confirm a completed payment (idempotent) ─────────────────────────

const confirmSchema = z.object({ sessionId: z.string().trim().min(1) });

router.post(
  "/partner-access/confirm",
  async (req: Request, res: Response) => {
    if (!(await isStripeConnected())) {
      return res.status(503).json({ error: "Billing is not available yet" });
    }
    const parsed = confirmSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "sessionId required" });
    }
    const client = await pool.connect();
    try {
      const stripe = await getUncachableStripeClient();
      const session = await stripe.checkout.sessions.retrieve(
        parsed.data.sessionId,
      );
      // A checkout session does NOT prove the caller's identity, but it does
      // carry the partnerKeyId we set as metadata at link-creation time, and
      // Stripe is the source of truth for whether it was actually paid. This
      // endpoint applies that paid session to the named key and never grants
      // any browser session/cookie, so a leaked session id is harmless beyond
      // re-confirming a payment that already happened.
      if (session.status !== "complete" || session.payment_status === "unpaid") {
        return res.status(402).json({ error: "Payment not completed" });
      }
      const partnerKeyId = Number(session.metadata?.partnerKeyId);
      const kind = session.metadata?.kind;
      if (!Number.isInteger(partnerKeyId) || partnerKeyId <= 0 || !kind) {
        return res.status(400).json({ error: "Session is not a partner payment" });
      }
      const customerId =
        typeof session.customer === "string"
          ? session.customer
          : (session.customer?.id ?? null);
      const subscriptionId =
        typeof session.subscription === "string"
          ? session.subscription
          : (session.subscription?.id ?? null);
      const creditsAdded =
        kind === "credits" ? Number(session.metadata?.creditsAdded) : null;

      // Best-effort: pull the fresh subscription/customer state so the gate
      // sees an active subscription immediately instead of waiting on the
      // async webhook sync.
      if (kind === "subscription") {
        try {
          const sync = await getStripeSync();
          if (customerId) await sync.syncSingleEntity(customerId);
          if (subscriptionId) await sync.syncSingleEntity(subscriptionId);
        } catch (err) {
          req.log.warn(
            { err },
            "Partner post-payment sync failed (webhook will catch up)",
          );
        }
      }

      await client.query("BEGIN");
      // Idempotency guard: the unique stripe_session_id means a reload (or a
      // double webhook) inserts nothing the second time — so we only apply the
      // key mutation when THIS call is the one that recorded the payment.
      const ins = await client.query<{ id: number }>(
        `INSERT INTO partner_key_payments
           (partner_key_id, stripe_session_id, kind, credits_added)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (stripe_session_id) DO NOTHING
         RETURNING id`,
        [partnerKeyId, session.id, kind, creditsAdded],
      );
      if (ins.rows.length === 0) {
        await client.query("COMMIT");
        return res.json({ ok: true, alreadyApplied: true });
      }
      let keyUpd;
      if (kind === "subscription") {
        keyUpd = await client.query<{ partner_account_id: number | null }>(
          `UPDATE partner_keys
             SET billing_mode = 'subscription',
                 requires_payment = true,
                 origin = 'paid',
                 stripe_customer_id = COALESCE($2, stripe_customer_id),
                 stripe_subscription_id = $3
           WHERE id = $1
           RETURNING partner_account_id`,
          [partnerKeyId, customerId, subscriptionId],
        );
      } else {
        // credits: top up the total so repeated purchases accumulate.
        keyUpd = await client.query<{ partner_account_id: number | null }>(
          `UPDATE partner_keys
             SET billing_mode = 'credits',
                 requires_payment = true,
                 origin = 'paid',
                 stripe_customer_id = COALESCE($2, stripe_customer_id),
                 credits_total = COALESCE(credits_total, 0) + $3
           WHERE id = $1
           RETURNING partner_account_id`,
          [partnerKeyId, customerId, creditsAdded ?? 0],
        );
      }
      // Self-serve keys are owned by a partner account; a completed payment
      // flips that account to `active` so the portal lets them mint their key.
      // Admin hand-minted keys have a NULL partner_account_id, so this is a
      // no-op for them — their path stays exactly as it was.
      const partnerAccountId = keyUpd.rows[0]?.partner_account_id ?? null;
      if (partnerAccountId) {
        await client.query(
          `UPDATE partner_accounts
             SET status = 'active', updated_at = NOW()
           WHERE id = $1 AND status IN ('approved', 'active')`,
          [partnerAccountId],
        );
      }
      await client.query("COMMIT");
      return res.json({ ok: true, applied: true, kind });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      req.log.error({ err }, "Failed to confirm partner payment");
      return res.status(500).json({ error: "Could not confirm payment" });
    } finally {
      client.release();
    }
  },
);

export default router;
