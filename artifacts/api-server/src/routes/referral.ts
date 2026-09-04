import { Router, type IRouter, type Request, type Response } from "express";
import { randomBytes, createHmac } from "crypto";
import { eq, sql, and, ne } from "drizzle-orm";
import { db, consumerAccountsTable } from "@workspace/db";
import {
  getConsumerFromRequest,
  CONSUMER_COOKIE,
  listActiveSubscriptionsForCustomer,
} from "../lib/consumerAuth";
import { isAdminRequest } from "../lib/adminBypass";
import { applyReferralConversion } from "../lib/referralCredit.js";
export { applyReferralConversion };

const router: IRouter = Router();

const REF_COOKIE = "ref_code";
const REF_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds

// Non-httpOnly cookie: grants anonymous visitors who haven't yet registered a
// session-level 5-question bonus. The sleep agent reads and decrements it.
// The value is HMAC-signed to prevent client-side tampering.
export const ANON_BONUS_COOKIE = "palonur_ref_bonus";

const BONUS_MAX = 5;

/** Sign a bonus count so clients cannot inflate it. */
function signBonusValue(count: number): string {
  const bounded = Math.max(0, Math.min(BONUS_MAX, count));
  const raw = String(bounded);
  const secret = process.env.SESSION_SECRET ?? "";
  const mac = createHmac("sha256", secret)
    .update(`referral_bonus:${raw}`)
    .digest("base64url")
    .slice(0, 16);
  return `${raw}.${mac}`;
}

/** Verify and parse the signed bonus cookie. Returns 0 on any tampering. */
function parseBonusValue(raw: string | undefined): number {
  if (!raw) return 0;
  const dot = raw.lastIndexOf(".");
  if (dot < 0) return 0;
  const countStr = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  const count = Number(countStr);
  if (!Number.isInteger(count) || count < 0 || count > BONUS_MAX) return 0;
  const secret = process.env.SESSION_SECRET ?? "";
  const expected = createHmac("sha256", secret)
    .update(`referral_bonus:${countStr}`)
    .digest("base64url")
    .slice(0, 16);
  // Constant-time equality (no short-circuit)
  if (expected.length !== mac.length) return 0;
  let diff = 0;
  for (let i = 0; i < expected.length; i++)
    diff |= expected.charCodeAt(i) ^ mac.charCodeAt(i);
  return diff === 0 ? count : 0;
}

/**
 * Consume one anonymous referral bonus question, decrementing the signed cookie.
 * Returns true if a bonus was available and consumed.
 * All signing logic lives here — callers (sleep-agent) never touch the cookie format.
 */
export function consumeAnonBonusCookie(
  req: { cookies?: Record<string, string> },
  setHeader: (name: string, value: string) => void,
): boolean {
  const raw = (req.cookies as Record<string, string> | undefined)?.[
    ANON_BONUS_COOKIE
  ];
  const count = parseBonusValue(raw);
  if (count <= 0) return false;
  const next = count - 1;
  const cookieParts = [
    `${ANON_BONUS_COOKIE}=${signBonusValue(next)}`,
    "Path=/",
    `Max-Age=${next > 0 ? REF_COOKIE_MAX_AGE : 0}`,
    "SameSite=Lax",
  ];
  setHeader("Set-Cookie", cookieParts.join("; "));
  return true;
}

/** Generate a short, URL-safe referral code (8 chars). */
function generateCode(): string {
  return randomBytes(6).toString("base64url").slice(0, 8);
}

// ── GET /api/referral/code ────────────────────────────────────────────────
// Returns the caller's referral code, creating one lazily.
// Requires consumer auth (palonur_consumer cookie).

router.get("/referral/code", async (req: Request, res: Response) => {
  // Admin bypass: allow admins testing /sleep to get a code without a
  // consumer account. Returns a fixed admin-scoped code under a sentinel email.
  const adminEmail = "admin@palonur.dev";
  const ownerEmail = isAdminRequest(req)
    ? adminEmail
    : ((await getConsumerFromRequest(req))?.email ?? null);
  if (!ownerEmail) return res.status(401).json({ error: "Not signed in" });

  try {
    const existing = await db.execute(sql`
      SELECT code FROM referral_codes WHERE owner_email = ${ownerEmail} LIMIT 1
    `);
    if (existing.rows.length > 0) {
      const row = existing.rows[0] as { code: string };
      return res.json({ code: row.code });
    }
    // Create a new code, retrying on collision (very unlikely with 8-char
    // base64url codes). Track whether any insert succeeded to avoid returning
    // a code that was never persisted.
    let inserted = false;
    let code = generateCode();
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await db.execute(sql`
          INSERT INTO referral_codes (code, owner_email)
          VALUES (${code}, ${ownerEmail})
        `);
        inserted = true;
        break;
      } catch {
        code = generateCode();
      }
    }
    if (!inserted) {
      req.log.error(
        "referral/code: all insert attempts failed (collision storm or DB error)",
      );
      return res.status(500).json({ error: "Could not generate code" });
    }
    return res.json({ code });
  } catch (err) {
    req.log.error({ err }, "referral/code error");
    return res.status(500).json({ error: "Could not generate code" });
  }
});

// ── GET /api/referral/owner ───────────────────────────────────────────────
// Returns the owner's first name for a given code (anonymous-friendly).
// Used by the subscribe page to personalise the referral banner.

router.get("/referral/owner", async (req: Request, res: Response) => {
  const code = String(req.query.code ?? "").trim();
  if (!code) return res.status(400).json({ error: "code required" });

  try {
    const result = await db.execute(sql`
      SELECT owner_email FROM referral_codes WHERE code = ${code} LIMIT 1
    `);
    if (!result.rows.length)
      return res.status(404).json({ error: "Unknown code" });

    const row = result.rows[0] as { owner_email: string };
    // Return only the first name segment of the email address local-part
    // (before @), capitalised. Revealing the full email would be a privacy
    // concern for a public anonymous-accessible endpoint.
    const localPart = row.owner_email.split("@")[0] ?? "";
    const firstName =
      localPart.split(/[._-]/)[0]?.replace(/[^a-zA-Z]/g, "") ?? "";
    const display = firstName
      ? firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase()
      : "a friend";
    return res.json({ firstName: display });
  } catch (err) {
    req.log.error({ err }, "referral/owner error");
    return res.status(500).json({ error: "Could not look up code" });
  }
});

// ── POST /api/referral/track ──────────────────────────────────────────────
// Records a click event for a referral code and sets a ref_code cookie.
// Anonymous-friendly (no auth required). Idempotent per IP+code within 1h
// (we simply let the DB insert the click; duplicate-click noise is acceptable
// for a referral system at this scale).

router.post("/referral/track", async (req: Request, res: Response) => {
  const code = String(
    req.query.code ?? (req.body as { code?: string })?.code ?? "",
  ).trim();
  if (!code) return res.status(400).json({ error: "code required" });

  try {
    // Verify the code exists.
    const exists = await db.execute(sql`
      SELECT 1 FROM referral_codes WHERE code = ${code} LIMIT 1
    `);
    if (!exists.rows.length)
      return res.status(404).json({ error: "Unknown code" });

    // Idempotent click: skip if same IP+code recorded a click in the last hour.
    const ip = String(req.ip ?? req.socket?.remoteAddress ?? "");
    const recentClick = await db.execute(sql`
      SELECT 1 FROM referral_events
      WHERE code = ${code}
        AND event_type = 'click'
        AND ip_hash = md5(${ip})
        AND created_at > NOW() - INTERVAL '1 hour'
      LIMIT 1
    `);
    if (!recentClick.rows.length) {
      await db.execute(sql`
        INSERT INTO referral_events (code, event_type, ip_hash)
        VALUES (${code}, 'click', md5(${ip}))
      `);
    }

    // Set a durable ref_code httpOnly cookie (for the billing confirm path to
    // read server-side) and a non-httpOnly palonur_ref_bonus cookie so
    // anonymous visitors who haven't yet registered get a session-level
    // 5-question bonus (the sleep agent reads and decrements this cookie).
    res.cookie(REF_COOKIE, code, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: REF_COOKIE_MAX_AGE * 1000,
      path: "/",
    });
    // Only grant the anonymous bonus if one isn't already active (signed check
    // prevents an inflated existing value from being honoured).
    const existingBonus = parseBonusValue(req.cookies?.[ANON_BONUS_COOKIE]);
    if (!existingBonus) {
      res.cookie(ANON_BONUS_COOKIE, signBonusValue(BONUS_MAX), {
        httpOnly: false, // readable by the sleep-agent route (always verified server-side)
        sameSite: "lax",
        maxAge: REF_COOKIE_MAX_AGE * 1000,
        path: "/",
      });
    }

    return res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "referral/track error");
    return res.status(500).json({ error: "Could not track click" });
  }
});

// ── GET /api/referral/ref ─────────────────────────────────────────────────
// Reads the persisted ref_code cookie and returns the owner's first name.
// Used by /subscribe to show the referral banner when the user arrives
// without a ?ref= query param (e.g. after landing on /sleep?ref=CODE first).
// Anonymous-friendly (no auth required); returns {} when no cookie is set.

router.get("/referral/ref", async (req: Request, res: Response) => {
  const code = String(req.cookies?.[REF_COOKIE] ?? "").trim();
  if (!code) return res.json({});

  try {
    const result = await db.execute(sql`
      SELECT owner_email FROM referral_codes WHERE code = ${code} LIMIT 1
    `);
    if (!result.rows.length) return res.json({});

    const row = result.rows[0] as { owner_email: string };
    const localPart = row.owner_email.split("@")[0] ?? "";
    const firstName =
      localPart.split(/[._-]/)[0]?.replace(/[^a-zA-Z]/g, "") ?? "";
    const display = firstName
      ? firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase()
      : "a friend";
    return res.json({ code, firstName: display });
  } catch (err) {
    req.log.error({ err }, "referral/ref error");
    return res.json({});
  }
});

// ── GET /api/referral/status ──────────────────────────────────────────────
// Returns the caller's referral status (signups, conversions, credits earned).
// Requires consumer auth.

router.get("/referral/status", async (req: Request, res: Response) => {
  const account = await getConsumerFromRequest(req);
  if (!account) return res.status(401).json({ error: "Not signed in" });

  try {
    const codeRow = await db.execute(sql`
      SELECT code FROM referral_codes WHERE owner_email = ${account.email} LIMIT 1
    `);
    if (!codeRow.rows.length) {
      // No code yet — return the full response shape with defaults so typed
      // clients don't encounter missing-field contract drift.
      const bonusRowEmpty = await db.execute(sql`
        SELECT bonus_questions_remaining
        FROM referral_bonus
        WHERE consumer_account_id = ${account.id}
        LIMIT 1
      `);
      const bonusQuestionsRemaining = bonusRowEmpty.rows.length
        ? Number(
            (bonusRowEmpty.rows[0] as { bonus_questions_remaining: string })
              .bonus_questions_remaining,
          )
        : 0;
      return res.json({
        code: null,
        link: "",
        signups: 0,
        conversions: 0,
        creditsEarnedCents: 0,
        bonusQuestionsRemaining,
      });
    }
    const code = (codeRow.rows[0] as { code: string }).code;

    const stats = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE event_type = 'signup')  AS signups,
        COUNT(*) FILTER (WHERE event_type = 'convert') AS conversions,
        COALESCE(SUM(credited_cents) FILTER (WHERE event_type = 'convert'), 0) AS credits_earned_cents
      FROM referral_events
      WHERE code = ${code}
    `);
    const row = stats.rows[0] as {
      signups: string;
      conversions: string;
      credits_earned_cents: string;
    };

    // Fetch remaining bonus questions for this account.
    const bonusRow = await db.execute(sql`
      SELECT bonus_questions_remaining
      FROM referral_bonus
      WHERE consumer_account_id = ${account.id}
      LIMIT 1
    `);
    const bonusQuestionsRemaining = bonusRow.rows.length
      ? Number(
          (bonusRow.rows[0] as { bonus_questions_remaining: string })
            .bonus_questions_remaining,
        )
      : 0;

    const baseUrl = process.env.PUBLIC_URL ?? "https://palonur.replit.app";
    const link = `${baseUrl}/sleep?ref=${code}`;

    return res.json({
      code,
      link,
      signups: Number(row.signups),
      conversions: Number(row.conversions),
      creditsEarnedCents: Number(row.credits_earned_cents),
      bonusQuestionsRemaining,
    });
  } catch (err) {
    req.log.error({ err }, "referral/status error");
    return res.status(500).json({ error: "Could not load referral status" });
  }
});

// ── GET /api/admin/referral-stats ────────────────────────────────────────
// Aggregate referral stats for the admin panel. Requires admin cookie.

router.get("/admin/referral-stats", async (req: Request, res: Response) => {
  if (!isAdminRequest(req)) return res.status(403).json({ error: "Forbidden" });

  try {
    const result = await db.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM referral_codes) AS total_codes,
        COUNT(*) FILTER (WHERE event_type = 'click')   AS total_clicks,
        COUNT(*) FILTER (WHERE event_type = 'signup')  AS total_signups,
        COUNT(*) FILTER (WHERE event_type = 'convert') AS total_conversions,
        COALESCE(SUM(credited_cents) FILTER (WHERE event_type = 'convert'), 0) AS total_credits_cents
      FROM referral_events
    `);
    const row = result.rows[0] as {
      total_codes: string;
      total_clicks: string;
      total_signups: string;
      total_conversions: string;
      total_credits_cents: string;
    };

    return res.json({
      totalCodes: Number(row.total_codes),
      totalClicks: Number(row.total_clicks),
      totalSignups: Number(row.total_signups),
      totalConversions: Number(row.total_conversions),
      totalCreditsCents: Number(row.total_credits_cents),
    });
  } catch (err) {
    req.log.error({ err }, "admin/referral-stats error");
    return res.status(500).json({ error: "Could not load referral stats" });
  }
});

// ── Exported helper: apply referral bonus on signup ───────────────────────
// Called from billing.ts when a magic-link is consumed (email ownership proven).
// If a ref_code cookie is present and valid, records a signup event and grants
// 5 bonus questions to the account. Idempotent: one signup event per email.

export async function applyReferralSignup(
  accountId: number,
  email: string,
  refCode: string | undefined,
): Promise<void> {
  if (!refCode) return;

  try {
    // Verify code exists and isn't owned by this same person.
    const codeRow = await db.execute(sql`
      SELECT owner_email FROM referral_codes WHERE code = ${refCode} LIMIT 1
    `);
    if (!codeRow.rows.length) return;
    const ownerEmail = (codeRow.rows[0] as { owner_email: string }).owner_email;
    if (ownerEmail === email) return; // no self-referrals

    // Global idempotency: only one referral signup bonus per recipient email
    // regardless of which code they used. Prevents repeated +5 grants by
    // cycling different referral codes.
    const alreadyApplied = await db.execute(sql`
      SELECT 1 FROM referral_events
      WHERE event_type = 'signup' AND recipient_email = ${email}
      LIMIT 1
    `);
    if (alreadyApplied.rows.length > 0) return;

    // Record the signup event.
    await db.execute(sql`
      INSERT INTO referral_events (code, event_type, recipient_email)
      VALUES (${refCode}, 'signup', ${email})
    `);

    // Grant 5 bonus questions to the recipient's account (upsert).
    await db.execute(sql`
      INSERT INTO referral_bonus (consumer_account_id, bonus_questions_remaining)
      VALUES (${accountId}, 5)
      ON CONFLICT (consumer_account_id)
      DO UPDATE SET
        bonus_questions_remaining = referral_bonus.bonus_questions_remaining + 5,
        updated_at = NOW()
    `);
  } catch {
    // Best-effort: never fail the sign-in flow over a referral error.
  }
}

// applyReferralConversion is defined in lib/referralCredit.ts and re-exported
// above. It is called from three places (webhook handler, /billing/confirm,
// and the boot-time reconciliation) for belt-and-suspenders reliability.

// ── Exported helper: consume a referral bonus question ────────────────────
// Called from sleep-agent before the free-question check.
// Decrements the bonus by 1 and returns true if a bonus question was available
// (caller should skip the paywall gate for this request).

export async function consumeReferralBonus(
  accountId: number,
): Promise<boolean> {
  try {
    const result = await db.execute(sql`
      UPDATE referral_bonus
      SET bonus_questions_remaining = bonus_questions_remaining - 1,
          updated_at = NOW()
      WHERE consumer_account_id = ${accountId}
        AND bonus_questions_remaining > 0
      RETURNING bonus_questions_remaining
    `);
    return (result.rows?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

// ── Exported: heal missed conversions ─────────────────────────────────────
// Post-listen reconciliation: finds referred users who have an active Stripe
// subscription but no convert event yet (e.g. /billing/confirm was never
// called — client drop-off, blocked redirect, etc.) and applies the credit.
// Safe to run repeatedly — applyReferralConversion is idempotent via the
// partial unique index on (code, recipient_email) WHERE event_type='convert'.

export async function reconcileReferralConversions(): Promise<void> {
  try {
    // Find emails with a signup event but no convert event.
    const pending = await db.execute(sql`
      SELECT DISTINCT re.recipient_email
      FROM referral_events re
      LEFT JOIN referral_events rc
        ON rc.event_type = 'convert' AND rc.recipient_email = re.recipient_email
      WHERE re.event_type = 'signup'
        AND re.recipient_email IS NOT NULL
        AND rc.id IS NULL
    `);
    if (!pending.rows.length) return;

    const { logger } = await import("../lib/logger.js");
    for (const row of pending.rows) {
      const { recipient_email } = row as { recipient_email: string };
      // Only credit if they actually have an active subscription.
      const acct = await db
        .select({ stripeCustomerId: consumerAccountsTable.stripeCustomerId })
        .from(consumerAccountsTable)
        .where(eq(consumerAccountsTable.email, recipient_email))
        .limit(1);
      if (!acct[0]?.stripeCustomerId) continue;
      const subs = await listActiveSubscriptionsForCustomer(
        acct[0].stripeCustomerId,
      );
      if (!subs.length) continue;
      // They qualified — apply the conversion credit now.
      await applyReferralConversion(recipient_email, logger);
    }
  } catch (err) {
    const { logger: errLogger } = await import("../lib/logger.js");
    errLogger.error({ err }, "referral reconciliation failed (non-fatal)");
  }
}

export default router;
