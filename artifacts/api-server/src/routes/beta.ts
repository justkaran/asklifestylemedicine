/**
 * Beta testing subscription — $11 / 90 days / all-access.
 *
 * POST /api/beta/register   { email }  → { ok: true }
 *   Adds the email to the beta_waitlist table (idempotent). Sends a
 *   "you're on the list" confirmation email. Used while Stripe review
 *   is pending so subscription intent can be measured without a live key.
 *
 * GET  /api/beta/waitlist               → { count, registrants }
 *   Admin-only list of all waitlist registrants. Gated by
 *   Authorization: Bearer <GROWTH_TEAM_PASSWORD>. Fail-closed when the
 *   env var is unset.
 *
 * POST /api/beta/checkout  { email }  → { url }
 *   Creates a Stripe Checkout session for the beta-all-access-90d price
 *   and returns the redirect URL. Used once Stripe live keys are active.
 */
import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { z } from "zod/v4";
import { db, betaWaitlistTable } from "@workspace/db";
import {
  getUncachableStripeClient,
  isStripeConnected,
} from "../lib/stripeClient.js";
import {
  findOrCreateConsumerByEmail,
  ensureStripeCustomer,
  siteBaseUrl,
} from "../lib/consumerBilling.js";
import { sendGuarded } from "../lib/emailGuard.js";
import { getResendClient } from "../lib/resendClient.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

const BETA_LOOKUP_KEY = "beta-all-access-90d";

const emailSchema = z.object({
  email: z.email(),
  name: z.string().max(120).optional(),
  variant: z.string().optional(),
  foundingMember: z.boolean().optional(),
  referralSource: z.string().max(200).optional(),
});

// ── GET /api/beta/stats ───────────────────────────────────────────────────────
// Public — returns founding + total waitlist counts for social proof display.

router.get("/beta/stats", async (_req: Request, res: Response) => {
  try {
    const rows = await db.execute(
      `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE founding_member = true) AS founding FROM beta_waitlist`
    );
    const FOUNDING_FLOOR = 190;
    const row = rows.rows[0] as { total: string; founding: string };
    return res.json({
      total: parseInt(row.total, 10),
      foundingCount: Math.max(FOUNDING_FLOOR, parseInt(row.founding, 10)),
    });
  } catch {
    return res.json({ total: 0, foundingCount: 190 });
  }
});

// ── POST /api/beta/register ───────────────────────────────────────────────────

router.post("/beta/register", async (req: Request, res: Response) => {
  const body = emailSchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: "A valid email address is required." });
  }
  const { email, name, variant, foundingMember, referralSource } = body.data;

  try {
    // Upsert — if the email already exists, do nothing (idempotent).
    await db
      .insert(betaWaitlistTable)
      .values({ email, name: name?.trim() || null, variant: variant ?? null, foundingMember: foundingMember ?? false, referralSource: referralSource ?? null })
      .onConflictDoNothing({ target: betaWaitlistTable.email });

    // Send confirmation email (best-effort — never block the 200 response).
    void sendBetaConfirmation(email).catch((err) =>
      logger.warn({ err, email }, "beta: confirmation email failed"),
    );

    req.log?.info({ email }, "beta: registered");
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err, email }, "beta/register failed");
    return res.status(500).json({ error: "Could not save your registration. Please try again." });
  }
});

async function sendBetaConfirmation(to: string): Promise<void> {
  const conn = await getResendClient();
  if (!conn) {
    logger.warn({ to }, "beta: Resend not configured — skipping confirmation email");
    return;
  }
  const from =
    process.env.CONSUMER_FROM ??
    (conn.fromEmail.includes("<")
      ? conn.fromEmail
      : `Palonur <${conn.fromEmail}>`);

  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#3a2010;max-width:540px;margin:0 auto;padding:24px;">
  <p style="font-size:15px;line-height:1.6;">You are on the list.</p>
  <p style="font-size:15px;line-height:1.6;">
    As soon as beta access opens we will send your personal invite link
    directly to this address. Early members get a discount on their first period.
  </p>
  <p style="font-size:15px;line-height:1.6;">We will be in touch shortly.</p>
  <p style="color:#9a7a60;font-size:13px;margin-top:32px;">Palonur &middot; Stanford Lifestyle Medicine</p>
  </body></html>`;

  const { error } = await sendGuarded(
    conn.client,
    {
      from,
      to,
      subject: "You are on the Palonur beta list",
      text: `You're on the list.\n\nAs soon as beta access opens we'll send your personal invite link to this address. Early members get a discount on their first period.\n\n— Palonur`,
      html,
    },
    { label: "beta confirmation" },
  );
  if (error) {
    logger.error({ err: error, to }, "beta: failed to send confirmation email");
  }
}

// ── GET /api/beta/waitlist ────────────────────────────────────────────────────

function getAdminPassword(): string | null {
  const pw = process.env["GROWTH_TEAM_PASSWORD"];
  return pw?.trim() || null;
}

router.get("/beta/waitlist", async (req: Request, res: Response) => {
  const expected = getAdminPassword();
  if (!expected) {
    return res.status(503).json({ error: "Admin access is not configured." });
  }
  const auth = req.headers["authorization"] ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== expected) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  try {
    const rows = await db
      .select({
        email: betaWaitlistTable.email,
        joinedAt: betaWaitlistTable.createdAt,
        referralSource: betaWaitlistTable.referralSource,
      })
      .from(betaWaitlistTable)
      .orderBy(betaWaitlistTable.createdAt);

    return res.json({ count: rows.length, registrants: rows });
  } catch (err) {
    logger.error({ err }, "beta/waitlist failed");
    return res.status(500).json({ error: "Could not load registrants." });
  }
});

// ── POST /api/beta/checkout ───────────────────────────────────────────────────

router.post("/beta/checkout", async (req: Request, res: Response) => {
  const body = emailSchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: "A valid email address is required." });
  }
  const { email } = body.data;

  if (!(await isStripeConnected())) {
    return res.status(503).json({ error: "Payments are not available right now. Please try again shortly." });
  }

  try {
    const stripe = await getUncachableStripeClient();

    const held = await stripe.prices.list({ lookup_keys: [BETA_LOOKUP_KEY], limit: 1 });
    const price = held.data[0];
    if (!price) {
      return res.status(503).json({ error: "Beta pricing is not yet configured. Please try again in a few minutes." });
    }

    const account = await findOrCreateConsumerByEmail(email);
    const stripeCustomerId = await ensureStripeCustomer(account);

    const base = siteBaseUrl(req);

    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      mode: "subscription",
      line_items: [{ price: price.id, quantity: 1 }],
      success_url: `${base}/account?beta_session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/apply`,
      metadata: {
        palonur_product: "all_access",
        palonur_account_id: String(account.id),
        beta: "true",
      },
    });

    return res.json({ url: session.url });
  } catch (err) {
    logger.error({ err }, "beta/checkout failed");
    return res.status(500).json({ error: "Could not start checkout. Please try again." });
  }
});

export default router;
