import type { Request, Response, NextFunction } from "express";
import { createHash } from "node:crypto";
import pool from "../lib/db.js";
import { setAgentLicenseHeaders, agentTermsUrl } from "../lib/agentLicense.js";
import { isAdminRequest } from "../lib/adminBypass.js";

/**
 * Access-control + licensing gate for Palonur's agent surfaces.
 *
 * Programmatic / external-agent access ALWAYS requires a valid, active
 * `X-Palonur-Key`. First-party humans on palonur.com keep working WITHOUT a
 * key (the consumer paywall governs them); we recognise them as a
 * COMPATIBILITY gate, not a security boundary:
 *
 *   - `Sec-Fetch-Site: same-origin|same-site`  → first-party (set by the
 *     browser, unforgeable by page JS), OR
 *   - an `Origin` in our first-party allowlist  → first-party (fallback).
 *   - neither header                            → treated as programmatic.
 *
 * A server-side caller can spoof these headers; that's acceptable because the
 * goal is not human-proof anti-abuse — it's to stop anonymous programmatic
 * scraping and route partners/agents onto keys.
 *
 * Keyed requests are rate-limited per-key (min/day/concurrent), then gated on
 * PAYMENT when the key requires it: a `subscription` key needs its specific
 * Stripe subscription active; a `credits` key burns one request credit
 * (atomic) per accepted request. Failures: 401 invalid/revoked/missing-key,
 * 403 scope, 429 rate, 402 payment. On success we attach a machine-readable
 * no-training usage-policy header set (see lib/agentLicense).
 *
 * Counters are in-process (single Node process today). If we ever scale
 * horizontally they must move to Redis or the DB.
 */

interface PartnerKeyRow {
  id: number;
  partnerName: string;
  scopes: string[];
  tier: "pilot" | "production";
  ratePerMinute: number;
  ratePerDay: number;
  concurrentStreams: number;
  revokedAt: Date | null;
  requiresPayment: boolean;
  billingMode: "none" | "subscription" | "credits";
  stripeSubscriptionId: string | null;
  creditsTotal: number | null;
  creditsUsed: number;
}

interface KeyCounters {
  minuteWindowStart: number;
  minuteCount: number;
  dayWindowStart: number;
  dayCount: number;
  active: number;
}

interface IpCounters {
  hourWindowStart: number;
  count: number;
}

export interface PartnerKeyContext {
  id: number;
  partnerName: string;
  tier: string;
}

export interface PartnerKeyMiddlewareOptions {
  /**
   * When true, a request with NO key that looks like a first-party browser
   * is allowed through (subject to the anonymous IP cap); the downstream
   * consumer paywall governs it. When false (pure tool endpoints), every
   * request must carry a key.
   */
  allowFirstPartyHuman?: boolean;
}

const ANON_LIMIT_PER_HOUR = 20;

const keyCache = new Map<string, { row: PartnerKeyRow | null; expiresAt: number }>();
// Short TTL so a revoke (which can happen out-of-process via the admin
// script and therefore can't push-invalidate) takes effect within seconds.
const KEY_CACHE_TTL_MS = 5_000;
const keyCounters = new Map<number, KeyCounters>();
const ipCounters = new Map<string, IpCounters>();
// Subscription-active lookups are cached briefly so a stream of keyed
// requests doesn't hammer the DB; short enough that a cancellation takes
// effect within seconds.
const subActiveCache = new Map<string, { active: boolean; expiresAt: number }>();
const SUB_CACHE_TTL_MS = 10_000;

let firstPartyOriginsCache: Set<string> | null = null;

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function clientIp(req: Request): string {
  // Express resolves req.ip from X-Forwarded-For ONLY when `trust proxy`
  // is set (we set it to `1` in app.ts), so a client can't spoof their IP.
  return req.ip || req.socket.remoteAddress || "unknown";
}

function firstPartyOrigins(): Set<string> {
  if (firstPartyOriginsCache) return firstPartyOriginsCache;
  const set = new Set<string>();
  const add = (u?: string | null) => {
    if (!u) return;
    const v = u.trim();
    if (!v) return;
    try {
      set.add(new URL(v.includes("://") ? v : `https://${v}`).origin);
    } catch {
      /* ignore malformed entry */
    }
  };
  add(process.env.PUBLIC_URL);
  (process.env.REPLIT_DOMAINS ?? "")
    .split(",")
    .forEach((d) => add(d));
  add(process.env.REPLIT_DEV_DOMAIN);
  (process.env.FIRST_PARTY_ORIGINS ?? "")
    .split(",")
    .forEach((d) => add(d));
  firstPartyOriginsCache = set;
  return set;
}

/**
 * Best-effort first-party detection. Sec-Fetch-Site is authoritative when
 * present (browser-set, not page-script-settable); otherwise we fall back to
 * an Origin allowlist. A request with neither signal is treated as a
 * programmatic (non-browser) caller.
 */
function isFirstPartyBrowser(req: Request): boolean {
  const sfs = req.header("sec-fetch-site")?.toLowerCase();
  if (sfs) return sfs === "same-origin" || sfs === "same-site";
  const origin = req.header("origin");
  if (origin) {
    try {
      return firstPartyOrigins().has(new URL(origin).origin);
    } catch {
      return false;
    }
  }
  return false;
}

function send429(res: Response, retryAfterSec: number, reason: string): void {
  const seconds = Math.max(1, Math.ceil(retryAfterSec));
  res.setHeader("Retry-After", String(seconds));
  res.status(429).json({ error: "rate_limited", reason, retry_after: seconds });
}

function sendKeyRequired(req: Request, res: Response): void {
  res.status(401).json({
    error: "key_required",
    message:
      "Programmatic access to Palonur's agent requires an active X-Palonur-Key. " +
      "Access is granted by Palonur (admin grant or paid). See the usage terms.",
    license_terms: agentTermsUrl(req),
  });
}

async function lookupKey(raw: string): Promise<PartnerKeyRow | null> {
  const hash = hashKey(raw);
  const cached = keyCache.get(hash);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.row;
  const { rows } = await pool.query(
    `SELECT id, partner_name, scopes, tier,
            rate_per_minute, rate_per_day, concurrent_streams, revoked_at,
            requires_payment, billing_mode, stripe_subscription_id,
            credits_total, credits_used
       FROM partner_keys
      WHERE key_hash = $1
      LIMIT 1`,
    [hash],
  );
  const row: PartnerKeyRow | null = rows[0]
    ? {
        id: Number(rows[0].id),
        partnerName: String(rows[0].partner_name),
        scopes: (rows[0].scopes as string[]) ?? [],
        tier: rows[0].tier as "pilot" | "production",
        ratePerMinute: Number(rows[0].rate_per_minute),
        ratePerDay: Number(rows[0].rate_per_day),
        concurrentStreams: Number(rows[0].concurrent_streams),
        revokedAt: rows[0].revoked_at ? new Date(rows[0].revoked_at) : null,
        requiresPayment: Boolean(rows[0].requires_payment),
        billingMode: (rows[0].billing_mode as PartnerKeyRow["billingMode"]) ?? "none",
        stripeSubscriptionId: rows[0].stripe_subscription_id
          ? String(rows[0].stripe_subscription_id)
          : null,
        creditsTotal:
          rows[0].credits_total === null || rows[0].credits_total === undefined
            ? null
            : Number(rows[0].credits_total),
        creditsUsed: Number(rows[0].credits_used ?? 0),
      }
    : null;
  keyCache.set(hash, { row, expiresAt: now + KEY_CACHE_TTL_MS });
  return row;
}

/**
 * Is the partner's SPECIFIC subscription active? We gate on the exact
 * subscription id stored on the key (not "any active sub for the customer")
 * so an unrelated/consumer subscription can't unlock partner access. Any DB
 * error (e.g. stripe schema absent) is treated as not-active → 402.
 */
async function isPartnerSubscriptionActive(subId: string | null): Promise<boolean> {
  if (!subId) return false;
  const now = Date.now();
  const cached = subActiveCache.get(subId);
  if (cached && cached.expiresAt > now) return cached.active;
  let active = false;
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM stripe.subscriptions
        WHERE id = $1 AND status IN ('active','trialing') LIMIT 1`,
      [subId],
    );
    active = rows.length > 0;
  } catch {
    active = false;
  }
  subActiveCache.set(subId, { active, expiresAt: now + SUB_CACHE_TTL_MS });
  return active;
}

/**
 * Atomically burn one request credit. Returns true if a credit was consumed,
 * false if the key is exhausted (or not credit-configured). Concurrency-safe:
 * the WHERE guard means two simultaneous requests can't over-spend.
 */
async function consumeCredit(keyId: number): Promise<boolean> {
  const { rows } = await pool.query(
    `UPDATE partner_keys
        SET credits_used = credits_used + 1
      WHERE id = $1
        AND credits_total IS NOT NULL
        AND credits_used < credits_total
      RETURNING credits_used`,
    [keyId],
  );
  if (rows.length > 0) {
    // Invalidate any cached row so admin reads / subsequent gates see fresh usage.
    keyCache.clear();
  }
  return rows.length > 0;
}

/**
 * Build a middleware for a given scope (e.g. "sleep-agent"). See file header.
 */
export function partnerKeyMiddleware(
  scope: string,
  opts: PartnerKeyMiddlewareOptions = {},
) {
  const allowFirstPartyHuman = opts.allowFirstPartyHuman ?? false;
  return async function partnerKey(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    // Primary header is X-Palonur-Key. Some MCP clients (notably ChatGPT
    // custom connectors) can only send the key as `Authorization: Bearer …`,
    // so accept a bearer token that carries our key prefix as an equivalent.
    let raw = req.header("X-Palonur-Key");
    if (!raw) {
      const auth = req.header("Authorization");
      if (auth?.startsWith("Bearer plnr_")) raw = auth.slice(7).trim();
    }

    // ── No key ────────────────────────────────────────────────────────────
    if (!raw) {
      if (!allowFirstPartyHuman || !isFirstPartyBrowser(req)) {
        sendKeyRequired(req, res);
        return;
      }
      // Admin bypass: a verified signed `palonur_admin` cookie exempts
      // first-party admin testing traffic from the anonymous IP cap (the
      // downstream paywall gates also honor it). Never applies to keyed or
      // programmatic callers.
      if (isAdminRequest(req)) {
        next();
        return;
      }
      // First-party human: keep the anonymous IP cap; paywall governs downstream.
      const ip = clientIp(req);
      const now = Date.now();
      const entry = ipCounters.get(ip);
      if (!entry || now - entry.hourWindowStart >= 3_600_000) {
        ipCounters.set(ip, { hourWindowStart: now, count: 1 });
      } else {
        if (entry.count >= ANON_LIMIT_PER_HOUR) {
          const retry = (entry.hourWindowStart + 3_600_000 - now) / 1000;
          send429(
            res,
            retry,
            `Anonymous evaluation cap (${ANON_LIMIT_PER_HOUR}/hour/IP).`,
          );
          return;
        }
        entry.count += 1;
      }
      next();
      return;
    }

    // ── Keyed ─────────────────────────────────────────────────────────────
    let row: PartnerKeyRow | null;
    try {
      row = await lookupKey(raw);
    } catch (e) {
      req.log?.warn({ err: e }, "partner key lookup failed");
      res.status(500).json({ error: "key_lookup_failed" });
      return;
    }
    if (!row) {
      res.status(401).json({ error: "invalid_key" });
      return;
    }
    if (row.revokedAt) {
      res.status(401).json({ error: "revoked_key" });
      return;
    }
    if (!row.scopes.includes(scope)) {
      res.status(403).json({ error: "scope_forbidden", scope });
      return;
    }

    const now = Date.now();
    let c = keyCounters.get(row.id);
    if (!c) {
      c = {
        minuteWindowStart: now,
        minuteCount: 0,
        dayWindowStart: now,
        dayCount: 0,
        active: 0,
      };
      keyCounters.set(row.id, c);
    }
    if (now - c.minuteWindowStart >= 60_000) {
      c.minuteWindowStart = now;
      c.minuteCount = 0;
    }
    if (now - c.dayWindowStart >= 86_400_000) {
      c.dayWindowStart = now;
      c.dayCount = 0;
    }
    // Rate caps first (read-only) so a 429 never burns a payment credit.
    if (c.minuteCount >= row.ratePerMinute) {
      const retry = (c.minuteWindowStart + 60_000 - now) / 1000;
      send429(res, retry, `Per-minute cap (${row.ratePerMinute}/min) reached.`);
      return;
    }
    if (c.dayCount >= row.ratePerDay) {
      const retry = (c.dayWindowStart + 86_400_000 - now) / 1000;
      send429(res, retry, `Daily cap (${row.ratePerDay}/day) reached.`);
      return;
    }
    if (c.active >= row.concurrentStreams) {
      send429(
        res,
        1,
        `Concurrent stream cap (${row.concurrentStreams}) reached.`,
      );
      return;
    }

    // Payment gate (only when the key requires payment). Done after caps so a
    // 429 doesn't consume a credit; done before committing counters.
    if (row.requiresPayment) {
      if (row.billingMode === "subscription") {
        const ok = await isPartnerSubscriptionActive(row.stripeSubscriptionId);
        if (!ok) {
          res
            .status(402)
            .json({ error: "payment_required", reason: "subscription_inactive" });
          return;
        }
      } else if (row.billingMode === "credits") {
        const ok = await consumeCredit(row.id);
        if (!ok) {
          res
            .status(402)
            .json({ error: "payment_required", reason: "credits_exhausted" });
          return;
        }
      } else {
        res
          .status(402)
          .json({ error: "payment_required", reason: "billing_not_configured" });
        return;
      }
    }

    // All gates passed — commit counters.
    c.minuteCount += 1;
    c.dayCount += 1;
    c.active += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const cur = keyCounters.get(row!.id);
      if (cur && cur.active > 0) cur.active -= 1;
    };
    res.on("close", release);
    res.on("finish", release);

    (req as Request & { partnerKey?: PartnerKeyContext }).partnerKey = {
      id: row.id,
      partnerName: row.partnerName,
      tier: row.tier,
    };
    setAgentLicenseHeaders(req, res);
    next();
  };
}

/**
 * Test-only: clear in-memory rate counters between tests. Not exported
 * from any package barrel; only the api-server's own tests should reach
 * for this.
 */
export function __resetPartnerKeyCountersForTests(): void {
  keyCache.clear();
  keyCounters.clear();
  ipCounters.clear();
  subActiveCache.clear();
  firstPartyOriginsCache = null;
}
