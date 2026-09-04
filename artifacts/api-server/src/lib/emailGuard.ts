// Centralized safety rails for every outbound email.
//
// All Resend sends in this server funnel through `sendGuarded`, which enforces
// four protections so a bug, retry storm, or runaway loop can never burn the
// account's email quota:
//
//   1. Hard daily cap   — refuses to send past EMAIL_DAILY_CAP successful sends
//                         per UTC day (default 90, just under Resend's free
//                         100/day). Failed sends do NOT consume the budget.
//   2. Hard monthly cap  — refuses to send past EMAIL_MONTHLY_CAP successful
//                         sends per UTC month (default 2800, just under Resend's
//                         free 3000/month).
//   3. Rate limiting     — sends are serialized with a minimum spacing
//                         (EMAIL_MIN_INTERVAL_MS, default 500ms ≈ 2/sec) so a
//                         send-to-all loop can't burst past Resend's per-second
//                         limit.
//   4. Retry w/ backoff  — transient failures (429, 5xx, network) are retried
//                         up to EMAIL_MAX_RETRIES times with exponential
//                         backoff; quota / validation (4xx) errors are not.
//
// Both caps are backed by the `email_sends` audit table (one row per SUCCESSFUL
// send), counted over the current UTC day / month window right before each send.
// This survives restarts and redeploys (an in-memory counter reset to zero on
// every process restart, so steady sending plus frequent restarts could quietly
// blow past the monthly limit) and is shared across instances. Failed sends
// write no row, so failures never consume budget.
//
// Crucially, real delivery is ALSO gated to PRODUCTION ONLY (see
// `sendingDisabledReason`): the Resend account is reached through a Replit
// connector that is ALSO available in dev and the test runner, so without this
// gate `vitest` and the dev server's cron jobs send real email through the live
// account and silently burn its quota. The env gate ensures only the production
// process ever sends at all; the caps protect that single process from a runaway
// loop.
import { createHash } from "node:crypto";
import { logger } from "./logger";
import pool from "./db.js";

export interface EmailSendResult {
  data?: unknown;
  error?: unknown;
}

export interface EmailPayload {
  from: string;
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string | string[];
}

// Method syntax (not a property arrow) so a real Resend instance — whose
// `emails.send` has extra optional params and a richer return type — is
// structurally assignable here.
export interface SendableEmailClient {
  emails: { send(payload: EmailPayload): Promise<EmailSendResult> };
}

// ── Config (read lazily so it is tunable via env and easy to set in tests) ────
function dailyCap(): number {
  const n = Number(process.env.EMAIL_DAILY_CAP);
  return Number.isFinite(n) && n >= 0 ? n : 90;
}
function monthlyCap(): number {
  const n = Number(process.env.EMAIL_MONTHLY_CAP);
  return Number.isFinite(n) && n >= 0 ? n : 2800; // just under Resend free 3000/mo
}
function minIntervalMs(): number {
  const n = Number(process.env.EMAIL_MIN_INTERVAL_MS);
  return Number.isFinite(n) && n >= 0 ? n : 500;
}
function maxRetries(): number {
  const n = Number(process.env.EMAIL_MAX_RETRIES);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}
function retryBaseMs(): number {
  const n = Number(process.env.EMAIL_RETRY_BASE_MS);
  return Number.isFinite(n) && n > 0 ? n : 300;
}

// Exponential backoff with jitter, floored at the min send interval so retry
// attempts are spaced at least as far apart as ordinary sends (they hit the same
// Resend API and the same per-second limit).
function backoffMs(attempt: number): number {
  const exp = retryBaseMs() * 2 ** attempt;
  return Math.max(exp, minIntervalMs()) + Math.floor(Math.random() * 100);
}

// ── Cap window helpers ────────────────────────────────────────────────────────
// Windows are computed in JS (not SQL NOW()) so they honor fake timers in tests
// and so the same Date drives both the count window and the row we insert.
function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10); // UTC YYYY-MM-DD
}
function monthKey(now: Date): string {
  return now.toISOString().slice(0, 7); // UTC YYYY-MM
}
function dayStart(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}
function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Count successful sends in the current UTC day + month windows. */
async function countWindows(
  now: Date,
): Promise<{ day: number; month: number }> {
  const mStart = monthStart(now);
  const dStart = dayStart(now);
  const { rows } = await pool.query<{ day: string; month: string }>(
    `SELECT
       count(*) FILTER (WHERE sent_at >= $1) AS day,
       count(*) AS month
     FROM email_sends
     WHERE sent_at >= $2`,
    [dStart.toISOString(), mStart.toISOString()],
  );
  return {
    day: Number(rows[0]?.day ?? 0),
    month: Number(rows[0]?.month ?? 0),
  };
}

/**
 * SHA-256 of the recipient salted with SESSION_SECRET — same privacy posture as
 * the Stories IP hash. Used both for the audit row and for success log lines, so
 * send volume is visible in logs without writing raw addresses anywhere.
 */
export function hashRecipient(to: string | string[]): string {
  const salt = process.env.SESSION_SECRET ?? "dev-secret-change-me";
  const normalized = (Array.isArray(to) ? to.join(",") : to)
    .trim()
    .toLowerCase();
  return createHash("sha256").update(`${normalized}${salt}`).digest("hex");
}

/** Record a successful send. Best-effort: a logging failure never throws. */
async function recordSend(
  label: string,
  to: string | string[],
  sentAt: Date,
): Promise<void> {
  const recipientHash = hashRecipient(to);
  try {
    await pool.query(
      `INSERT INTO email_sends (label, recipient_hash, sent_at)
       VALUES ($1, $2, $3)`,
      [label, recipientHash, sentAt.toISOString()],
    );
  } catch (err) {
    logger.warn({ err, label }, "Failed to record email send in audit table");
  }
  // Volume-visibility log line for every successful transactional send, uniform
  // across all senders (raw address never logged).
  logger.info({ label, recipientHash }, "Sent transactional email");
}

// ── Rate limiter: serialize sends so only one runs at a time ──────────────────
// Every send is funneled through a single promise chain, so cap accounting and
// min-interval spacing both happen with no interleaving between callers.
let queue: Promise<unknown> = Promise.resolve();
let lastSendAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const task = queue.then(() => fn());
  // Keep the chain alive regardless of individual outcomes.
  queue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

// ── Error classification ──────────────────────────────────────────────────────
function isRetryable(err: unknown): boolean {
  if (!err) return false;
  const e = err as {
    statusCode?: number;
    status?: number;
    name?: string;
    message?: string;
  };
  const text = `${e.name ?? ""} ${e.message ?? ""}`.toLowerCase();

  // Quota / monthly-limit errors are never worth retrying — the cap exists to
  // keep us from ever reaching them in the first place. Use specific phrases so
  // we don't accidentally swallow "rate_limit_exceeded" (which IS retryable).
  if (/quota|monthly|daily limit|daily sending|sending limit/.test(text)) {
    return false;
  }

  const code = e.statusCode ?? e.status;
  if (typeof code === "number") {
    if (code === 429) return true;
    if (code >= 500) return true;
    return false; // other 4xx (validation, etc.) — do not retry
  }

  if (
    /rate.?limit|too many|timeout|timed out|econn|socket hang|network|temporar|502|503|504|429/.test(
      text,
    )
  ) {
    return true;
  }

  // A thrown Error with no status code is most likely a transient network
  // failure; returned (non-thrown) error objects without a code are treated as
  // permanent.
  return err instanceof Error;
}

async function sendWithRetry(
  client: SendableEmailClient,
  payload: EmailPayload,
  label: string,
): Promise<EmailSendResult> {
  const retries = maxRetries();
  let lastResult: EmailSendResult = {};
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await client.emails.send(payload);
      if (res?.error) {
        lastResult = res;
        if (attempt < retries && isRetryable(res.error)) {
          await sleep(backoffMs(attempt));
          logger.warn({ label, attempt: attempt + 1, err: res.error }, "Email send failed — retrying");
          continue;
        }
        return res;
      }
      return res;
    } catch (e) {
      lastResult = { error: e };
      if (attempt < retries && isRetryable(e)) {
        await sleep(backoffMs(attempt));
        logger.warn({ label, attempt: attempt + 1, err: e }, "Email send threw — retrying");
        continue;
      }
      return { error: e };
    }
  }
  return lastResult;
}

// ── Environment gate: only the production server may send real email ──────────
// The Resend account/key (via the Replit connector) is reachable from EVERY
// environment that can hit the connector — including dev and the `vitest` test
// runner. Without this gate, the test suite sends real email (to bouncing
// `@test.local` users AND every eligible real user in the shared dev DB) and the
// dev server's cron jobs do too, silently burning the account's limited
// daily/monthly quota. So real delivery is allowed ONLY in production.
//
//   • EMAIL_LIVE_OVERRIDE=true — force-enable real sends anywhere (used by this
//                                module's own unit tests to exercise the rails,
//                                and available for deliberate dev testing).
//   • EMAIL_DISABLED=true      — force-disable real sends anywhere (kill switch).
//   • otherwise disabled when   NODE_ENV is "test"/"development" or under VITEST.
//
// Returns the disable reason (a short tag) when sending is off, or null when the
// real send is allowed to proceed.
export function sendingDisabledReason(): string | null {
  if (process.env.EMAIL_LIVE_OVERRIDE === "true") return null;
  if (process.env.EMAIL_DISABLED === "true") return "EMAIL_DISABLED";
  if (process.env.VITEST) return "test";
  const env = process.env.NODE_ENV;
  if (env === "test") return "test";
  if (env === "development") return "development";
  return null;
}

/**
 * Send an email through the shared safety rails. Returns the same
 * `{ data, error }` shape as the Resend SDK; on a cap hit it returns a synthetic
 * `error` (and sends nothing) so callers treat it as a non-delivery.
 *
 * Outside production (see `sendingDisabledReason`) the real send is skipped and a
 * synthetic *success* is returned, so callers proceed exactly as if delivery
 * succeeded (DB rows update, counts increment) without any email leaving the
 * process and without consuming the daily cap.
 */
export async function sendGuarded(
  client: SendableEmailClient,
  payload: EmailPayload,
  ctx: { label: string },
): Promise<EmailSendResult> {
  // Hard environment gate first: never touch the real Resend account from a
  // non-production process. Returns a synthetic success (not an error) so the
  // calling job/route behaves as if the send went out.
  const disabled = sendingDisabledReason();
  if (disabled) {
    logger.warn(
      { label: ctx.label, to: payload.to, reason: disabled },
      "Email sending disabled outside production — send skipped (no real email sent)",
    );
    return { data: { id: `email-disabled:${disabled}` } };
  }

  // Everything below runs inside the single serialized queue, so the cap is
  // evaluated at the moment of the *actual* send — never at enqueue time. This
  // matters across the UTC day/month boundary: the budget is checked against,
  // and the audit row is charged to, the window the send really lands in, so
  // real Resend traffic on any given UTC day/month can never exceed the cap.
  return enqueue(async () => {
    // Space real sends out by the min interval BEFORE we evaluate the cap, so
    // the window is read at the true send moment, not the (possibly pre-rollover)
    // moment this task was dequeued. After a rejection no real send happens, so
    // `lastSendAt` is untouched and subsequent rejections wait ~0.
    const wait = lastSendAt + minIntervalMs() - Date.now();
    if (wait > 0) await sleep(wait);

    const now = new Date(); // post-wait: the moment of the actual send attempt
    const { day, month } = await countWindows(now);

    const dCap = dailyCap();
    if (day >= dCap) {
      logger.warn(
        { label: ctx.label, to: payload.to, cap: dCap, sentToday: day },
        "Email daily cap reached — send skipped",
      );
      return {
        error: {
          name: "daily_cap_reached",
          message: `Email daily cap of ${dCap} reached for ${dayKey(now)}; send skipped.`,
        },
      };
    }

    const mCap = monthlyCap();
    if (month >= mCap) {
      logger.warn(
        { label: ctx.label, to: payload.to, cap: mCap, sentThisMonth: month },
        "Email monthly cap reached — send skipped",
      );
      return {
        error: {
          name: "monthly_cap_reached",
          message: `Email monthly cap of ${mCap} reached for ${monthKey(now)}; send skipped.`,
        },
      };
    }

    let res: EmailSendResult;
    try {
      res = await sendWithRetry(client, payload, ctx.label);
    } finally {
      lastSendAt = Date.now();
    }

    // Only a successful delivery consumes budget — record it AFTER it lands, and
    // charge it to the window of the *completed* send (a fresh timestamp), so a
    // send whose retries/backoff cross a UTC rollover is counted in the new
    // day/month, never the prior one. A failed send writes no row at all.
    if (!res?.error) {
      await recordSend(ctx.label, payload.to, new Date());
    }
    return res;
  });
}

// ── Introspection / test helpers ──────────────────────────────────────────────
export async function emailGuardStatus(): Promise<{
  day: string;
  month: string;
  sentToday: number;
  sentThisMonth: number;
  dailyCap: number;
  monthlyCap: number;
}> {
  const now = new Date();
  const { day, month } = await countWindows(now);
  return {
    day: dayKey(now),
    month: monthKey(now),
    sentToday: day,
    sentThisMonth: month,
    dailyCap: dailyCap(),
    monthlyCap: monthlyCap(),
  };
}

/**
 * Per-label send counts for the current UTC day + month windows, ordered by
 * monthly volume. Powers the admin "Email volume" view so the team can see
 * which features (magic links, invites, newsletter, etc.) drive send volume.
 * Reads the same audit table and windows the caps are computed from, so the
 * label totals always reconcile with `emailGuardStatus()`.
 */
export async function emailVolumeByLabel(): Promise<
  Array<{ label: string; sentToday: number; sentThisMonth: number }>
> {
  const now = new Date();
  const mStart = monthStart(now);
  const dStart = dayStart(now);
  const { rows } = await pool.query<{
    label: string;
    day: string;
    month: string;
  }>(
    `SELECT
       label,
       count(*) FILTER (WHERE sent_at >= $1) AS day,
       count(*) AS month
     FROM email_sends
     WHERE sent_at >= $2
     GROUP BY label
     ORDER BY month DESC, label ASC`,
    [dStart.toISOString(), mStart.toISOString()],
  );
  return rows.map((r) => ({
    label: r.label,
    sentToday: Number(r.day ?? 0),
    sentThisMonth: Number(r.month ?? 0),
  }));
}

/** Reset the in-memory send queue/spacing. Intended for tests. */
export function resetEmailGuard(): void {
  lastSendAt = 0;
  queue = Promise.resolve();
}

/**
 * Test-only: wipe the audit table so cap counts start from zero. Not exported
 * from any package barrel; only the api-server's own tests should reach for it.
 */
export async function __clearEmailSendsForTests(): Promise<void> {
  await pool.query(`DELETE FROM email_sends`);
}
