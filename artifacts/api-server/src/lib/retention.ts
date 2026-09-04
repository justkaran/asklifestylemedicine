/**
 * Data-retention enforcement — the code half of docs/data-retention-policy.md.
 *
 * `runRetentionCleanup()` runs daily (cron in index.ts) and enforces the
 * documented schedule per category. Every step is:
 *   - idempotent — plain windowed DELETE/UPDATEs keyed on timestamps, so
 *     re-running (or running concurrently across restarts) is always safe;
 *   - independent — each category is wrapped in its own try/catch so one
 *     missing table (fresh DB, partial test provisioning) never blocks the
 *     rest;
 *   - auditable — one log line per category with the affected row count.
 *
 * Governance data (sources, interpretations, audit logs, steward activity) is
 * EXPLICITLY exempt and retained indefinitely for accountability — nothing in
 * this module may ever touch those tables.
 */
import pool from "./db.js";
import { logger } from "./logger.js";
import { pruneStaleDoorwayQuestions } from "./doorway.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Retention windows (mirror docs/data-retention-policy.md) ────────────────

/** Expired/consumed magic-link token rows are deleted 30 days past expiry. */
export const LOGIN_TOKEN_RETENTION_DAYS = 30;
/** Crisis text excerpts on doorway events are blanked after 90 days. */
export const DOORWAY_EXCERPT_RETENTION_DAYS = 90;
/** Raw pageview/video-view analytics rows are deleted after ~13 months. */
export const ANALYTICS_RETENTION_DAYS = 400;
/** Pageview IPs are nulled after 90 days (row kept for aggregate stats). */
export const ANALYTICS_IP_RETENTION_DAYS = 90;
/** Email send audit rows (hashed recipients) are deleted after ~13 months. */
export const EMAIL_SEND_LOG_RETENTION_DAYS = 396;
/** Anonymous visitor sessions unseen for 24 months lose their linkage row. */
export const VISITOR_SESSION_RETENTION_DAYS = 730;

export interface RetentionReport {
  loginTokensDeleted: number;
  memberSessionsDeleted: number;
  doorwayExcerptsBlanked: number;
  doorwayQuestionsBlanked: number;
  pageviewIpsCleared: number;
  pageviewsDeleted: number;
  videoViewsDeleted: number;
  emailSendRowsDeleted: number;
  visitorSessionsDeleted: number;
  sleepConversationsDeleted: number;
}

function cutoff(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

/** Run one guarded step; a missing table or SQL error never aborts the job. */
async function step(
  category: string,
  fn: () => Promise<number>,
): Promise<number> {
  try {
    const affected = await fn();
    logger.info({ category, affected }, "retention: category enforced");
    return affected;
  } catch (err) {
    logger.warn({ category, err }, "retention: category skipped (errored)");
    return 0;
  }
}

/** Enforce the full retention schedule once. Never throws. */
export async function runRetentionCleanup(): Promise<RetentionReport> {
  const report: RetentionReport = {
    // Consumer sign-in magic links: single-use tokens with a 30-minute life;
    // the rows themselves (email + token) are deleted 30 days past expiry so
    // the audit window for "did this email request a link?" stays short.
    loginTokensDeleted: await step("consumer_login_tokens", async () => {
      const r = await pool.query(
        `DELETE FROM consumer_login_tokens WHERE expires_at < $1`,
        [cutoff(LOGIN_TOKEN_RETENTION_DAYS)],
      );
      return r.rowCount ?? 0;
    }),

    // Members reading-room sessions: unconsumed magic tokens 30 days past
    // expiry, and consumed sessions 30 days past their session expiry.
    memberSessionsDeleted: await step(
      "newsletter_subscriber_sessions",
      async () => {
        const r = await pool.query(
          `DELETE FROM newsletter_subscriber_sessions
            WHERE (consumed_at IS NULL AND expires_at < $1)
               OR (session_expires_at IS NOT NULL AND session_expires_at < $1)`,
          [cutoff(LOGIN_TOKEN_RETENTION_DAYS)],
        );
        return r.rowCount ?? 0;
      },
    ),

    // Doorway (inbound SMS) crisis text excerpts: the event ROW is kept
    // indefinitely for audit (phone is stored only as a salted hash), but the
    // raw message excerpt is blanked after 90 days.
    doorwayExcerptsBlanked: await step(
      "doorway_events.body_excerpt",
      async () => {
        const r = await pool.query(
          `UPDATE doorway_events SET body_excerpt = ''
          WHERE created_at < $1
            AND body_excerpt IS NOT NULL AND body_excerpt <> ''`,
          [cutoff(DOORWAY_EXCERPT_RETENTION_DAYS)],
        );
        return r.rowCount ?? 0;
      },
    ),

    // Doorway link questions: already blanked opportunistically 24h past
    // expiry (see doorway.ts); the daily run guarantees the sweep happens even
    // on nights with no new inbound texts.
    doorwayQuestionsBlanked: await step("doorway_links.question", () =>
      pruneStaleDoorwayQuestions(),
    ),

    // Raw analytics: IPs are nulled after 90 days (geo columns already
    // derived), whole rows deleted after ~13 months so year-over-year
    // aggregates stay possible without indefinite raw retention.
    pageviewIpsCleared: await step("palonur_pageviews.ip", async () => {
      const r = await pool.query(
        `UPDATE palonur_pageviews SET ip = NULL
          WHERE created_at < $1 AND ip IS NOT NULL`,
        [cutoff(ANALYTICS_IP_RETENTION_DAYS)],
      );
      return r.rowCount ?? 0;
    }),
    pageviewsDeleted: await step("palonur_pageviews", async () => {
      const r = await pool.query(
        `DELETE FROM palonur_pageviews WHERE created_at < $1`,
        [cutoff(ANALYTICS_RETENTION_DAYS)],
      );
      return r.rowCount ?? 0;
    }),
    videoViewsDeleted: await step("palonur_video_views", async () => {
      const r = await pool.query(
        `DELETE FROM palonur_video_views WHERE created_at < $1`,
        [cutoff(ANALYTICS_RETENTION_DAYS)],
      );
      return r.rowCount ?? 0;
    }),

    // Email send audit log: recipients are already stored ONLY as salted
    // hashes; rows are still deleted after ~13 months. The window is safely
    // wider than the monthly quota-cap window (current UTC month), so cap
    // accounting is never affected.
    emailSendRowsDeleted: await step("email_sends", async () => {
      const r = await pool.query(`DELETE FROM email_sends WHERE sent_at < $1`, [
        cutoff(EMAIL_SEND_LOG_RETENTION_DAYS),
      ]);
      return r.rowCount ?? 0;
    }),

    // Anonymous visitor-session linkage rows unseen for 24 months are deleted.
    // This severs any account linkage from long-dead browser sessions; the
    // agent_queries rows themselves stay as pseudonymous (random-session-id)
    // operational logs.
    visitorSessionsDeleted: await step("visitor_sessions", async () => {
      const r = await pool.query(
        `DELETE FROM visitor_sessions WHERE last_seen_at < $1`,
        [cutoff(VISITOR_SESSION_RETENTION_DAYS)],
      );
      return r.rowCount ?? 0;
    }),

    // Sleep conversation threads hold full multi-turn message
    // content — the most sensitive stored material. Threads idle for 24
    // months are deleted entirely, children first (explicit: some
    // environments provision these tables without ON DELETE CASCADE).
    sleepConversationsDeleted: await step("sleep_conversations", async () => {
      await pool.query(
        `DELETE FROM sleep_conversation_messages
          WHERE conversation_id IN
                (SELECT id FROM sleep_conversations WHERE last_message_at < $1)`,
        [cutoff(VISITOR_SESSION_RETENTION_DAYS)],
      );
      const r = await pool.query(
        `DELETE FROM sleep_conversations WHERE last_message_at < $1`,
        [cutoff(VISITOR_SESSION_RETENTION_DAYS)],
      );
      return r.rowCount ?? 0;
    }),
  };

  logger.info({ report }, "retention: daily cleanup complete");
  return report;
}
