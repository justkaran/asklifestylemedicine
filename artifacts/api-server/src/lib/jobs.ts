import pool from "./db";
import { logger } from "./logger";
import {
  sendMorningCheckin,
  sendWeeklyPortrait,
  sendNudgeEmail,
  sendWeeklyReflection,
} from "./email";
import { computeWeeklyReflection } from "./weeklyReflection";

// ── Job 1: Morning commitment check-in (enhanced with sleep trend) ─────────────
export async function runMorningCheckins(): Promise<number> {
  const due = await pool.query(`
    SELECT
      c.id,
      c.action_text,
      c.check_in_token,
      u.id    AS user_id,
      u.first_name,
      u.email,
      (
        SELECT COUNT(*)::int
        FROM palonur_checkins ck
        WHERE ck.commitment_id = c.id AND ck.did_it = TRUE
      ) AS streak_count,
      (
        SELECT ROUND(AVG(quality)::numeric, 1)
        FROM palonur_sleep_logs
        WHERE user_id = u.id
          AND log_date >= CURRENT_DATE - 7
      ) AS avg_quality_week,
      (
        SELECT ROUND(AVG(quality)::numeric, 1)
        FROM palonur_sleep_logs
        WHERE user_id = u.id
          AND log_date >= CURRENT_DATE - 14
          AND log_date <  CURRENT_DATE - 7
      ) AS avg_quality_prev
    FROM palonur_commitments c
    JOIN palonur_users u ON u.id = c.user_id
    WHERE c.email_sent_at IS NULL
      AND u.email_opted_out = FALSE
      AND c.created_at < NOW() - INTERVAL '12 hours'
      AND EXTRACT(HOUR FROM NOW() AT TIME ZONE COALESCE(u.timezone, 'UTC')) = 7
      AND NOT EXISTS (
        SELECT 1 FROM palonur_checkins ck
        WHERE ck.commitment_id = c.id
          AND ck.checkin_date >= c.created_at::date + 1
      )
  `);

  let sent = 0;
  for (const row of due.rows) {
    const ok = await sendMorningCheckin({
      to: row.email,
      firstName: row.first_name,
      actionText: row.action_text,
      token: row.check_in_token,
      avgQualityWeek: row.avg_quality_week
        ? parseFloat(row.avg_quality_week)
        : null,
      avgQualityPrevWeek: row.avg_quality_prev
        ? parseFloat(row.avg_quality_prev)
        : null,
      streakCount: row.streak_count ?? 0,
    });
    if (ok) {
      await pool.query(
        `UPDATE palonur_commitments SET email_sent_at = NOW() WHERE id = $1`,
        [row.id],
      );
      logger.info(
        { commitmentId: row.id, to: row.email },
        "Morning check-in email sent",
      );
      sent++;
    }
  }
  return sent;
}

// ── Job 2: Weekly sleep portrait (runs Sunday evenings PT) ─────────────────────
export async function runWeeklyPortraits(): Promise<number> {
  const eligible = await pool.query(`
    SELECT
      u.id,
      u.first_name,
      u.email,
      json_agg(
        json_build_object('quality', sl.quality, 'log_date', sl.log_date::text)
        ORDER BY sl.log_date
      ) AS logs
    FROM palonur_users u
    JOIN palonur_sleep_logs sl
      ON sl.user_id = u.id
     AND sl.log_date >= CURRENT_DATE - 7
    WHERE u.email_opted_out = FALSE
      AND (
        u.last_portrait_sent_at IS NULL
        OR u.last_portrait_sent_at < NOW() - INTERVAL '6 days'
      )
    GROUP BY u.id
    HAVING COUNT(sl.id) >= 3
  `);

  let sent = 0;
  for (const row of eligible.rows) {
    const ok = await sendWeeklyPortrait({
      to: row.email,
      firstName: row.first_name,
      logs: row.logs,
    });
    if (ok) {
      await pool.query(
        `UPDATE palonur_users SET last_portrait_sent_at = NOW() WHERE id = $1`,
        [row.id],
      );
      logger.info({ userId: row.id, to: row.email }, "Weekly portrait sent");
      sent++;
    }
  }
  return sent;
}

// ── Job 3: Sleep insight nudge (runs regularly for all opted-in users with sleep data) ──
export async function runNudgeEmails(): Promise<number> {
  const eligible = await pool.query(`
    SELECT
      u.id,
      u.first_name,
      u.email,
      ROUND(AVG(sl.quality)::numeric, 1) AS avg_quality
    FROM palonur_users u
    JOIN palonur_sleep_logs sl
      ON sl.user_id = u.id
     AND sl.log_date >= CURRENT_DATE - 7
    WHERE u.email_opted_out = FALSE
      AND (
        u.last_insight_sent_at IS NULL
        OR u.last_insight_sent_at < NOW() - INTERVAL '7 days'
      )
    GROUP BY u.id
    HAVING COUNT(sl.id) >= 1
  `);

  let sent = 0;
  for (const row of eligible.rows) {
    const ok = await sendNudgeEmail({
      to: row.email,
      firstName: row.first_name,
      avgQuality: parseFloat(row.avg_quality),
    });
    if (ok) {
      await pool.query(
        `UPDATE palonur_users SET last_insight_sent_at = NOW() WHERE id = $1`,
        [row.id],
      );
      logger.info({ userId: row.id, to: row.email }, "Reactivation nudge sent");
      sent++;
    }
  }
  return sent;
}

// ── Job 7: Weekly coaching loop ────────────────────────────────────────────────
// Ties the week's experiments + check-in adherence to the nights the user
// logged, with a grounded, cited coaching note (governed RAG path). Only emails
// opted-in users past a 6-day cooldown who actually have data this week —
// empty-data users get the gentle in-app prompt instead, never a fabricated
// email. The grounded note itself is generated once per ISO week and cached by
// computeWeeklyReflection, so the in-app card and this email stay in sync.
export async function runWeeklyReflections(): Promise<number> {
  const eligible = await pool.query<{ id: number }>(`
    SELECT u.id
    FROM palonur_users u
    WHERE u.email_opted_out = FALSE
      AND (
        u.last_weekly_reflection_sent_at IS NULL
        OR u.last_weekly_reflection_sent_at < NOW() - INTERVAL '6 days'
      )
      AND (
        EXISTS (
          SELECT 1 FROM palonur_sleep_logs sl
          WHERE sl.user_id = u.id AND sl.log_date >= CURRENT_DATE - 6
        )
        OR EXISTS (
          SELECT 1 FROM palonur_checkins ck
          WHERE ck.user_id = u.id AND ck.checkin_date >= CURRENT_DATE - 6
        )
      )
  `);

  let sent = 0;
  for (const row of eligible.rows) {
    const reflection = await computeWeeklyReflection(row.id);
    // Re-check opt-out + data inside the loop: computeWeeklyReflection reads the
    // live row, so a user who opted out or has no data is skipped defensively.
    if (!reflection || reflection.user.emailOptedOut || !reflection.hasData) {
      continue;
    }

    const ok = await sendWeeklyReflection({
      to: reflection.user.email,
      firstName: reflection.user.firstName,
      avgQuality: reflection.nights.avgQuality,
      nightsLogged: reflection.nights.count,
      commitments: reflection.commitments.map((c) => ({
        actionText: c.actionText,
        didCount: c.didCount,
        totalCheckins: c.totalCheckins,
      })),
      groundedNote: reflection.groundedNote
        ? {
            answer: reflection.groundedNote.answer,
            finding: reflection.groundedNote.finding,
            citation: reflection.groundedNote.citation,
            paper: reflection.groundedNote.paper,
          }
        : null,
    });
    if (ok) {
      await pool.query(
        `UPDATE palonur_users SET last_weekly_reflection_sent_at = NOW() WHERE id = $1`,
        [row.id],
      );
      logger.info(
        { userId: row.id, to: reflection.user.email },
        "Weekly reflection sent",
      );
      sent++;
    }
  }
  return sent;
}
