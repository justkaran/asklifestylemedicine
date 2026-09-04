import type { Request } from "express";

/**
 * Is this request from a verified platform admin? Keyed on the signed
 * `palonur_admin` cookie (minted by the shared-password /admin login or the
 * /command-center Clerk confirmation). cookie-parser verifies the HMAC
 * signature (SESSION_SECRET), so a forged/unsigned cookie never matches —
 * it lands in `req.cookies` (or as `false` in signedCookies), not as "1".
 *
 * Used to exempt admin testing traffic from consumer free-question limits,
 * steward paywalls, and the anonymous per-IP rate cap. It never touches
 * entitlements, billing, or partner-key limits, and admin questions are
 * still logged as normal usage.
 */
export function isAdminRequest(req: Request): boolean {
  return req.signedCookies?.palonur_admin === "1";
}

/**
 * Unlimited-tester allowlist: signed-in consumer accounts whose email is on
 * this list are treated as entitled on the sleep agent (no daily free-question
 * limit, no follow-up allowance, no paywall) WITHOUT needing a subscription.
 * Meant for internal testing (Karan). Comma-separated, case-insensitive, via
 * `SLEEP_UNLIMITED_EMAILS`; defaults to karan@palonur.com. Questions still
 * log as normal usage. This never touches billing or partner-key limits.
 */
const DEFAULT_UNLIMITED_EMAILS = "karan@palonur.com";

export function isUnlimitedTesterEmail(
  email: string | null | undefined,
): boolean {
  if (!email) return false;
  const raw = process.env.SLEEP_UNLIMITED_EMAILS ?? DEFAULT_UNLIMITED_EMAILS;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.trim().toLowerCase());
}
