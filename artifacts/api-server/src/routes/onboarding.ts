import { Router, type IRouter } from "express";
import { randomBytes } from "crypto";
import pool from "../lib/db";
import { computeWeeklyReflection } from "../lib/weeklyReflection";
import { sendCommitmentFollowupEmail } from "../lib/commitmentFollowupEmail.js";

const REFLECT_BASE = process.env["PUBLIC_URL"] ?? "https://palonur.replit.app";
const VALID_OUTCOMES = new Set(["helped", "no_change", "not_tried"]);

/**
 * Boot-time DDL to provision the follow-up schema idempotently.
 * Runs once on module load; degrades gracefully on error.
 */
async function ensureFollowupSchema() {
  try {
    await pool.query(`
      ALTER TABLE palonur_commitments
        ADD COLUMN IF NOT EXISTS reflect_token TEXT UNIQUE;

      CREATE TABLE IF NOT EXISTS commitment_followups (
        id            SERIAL PRIMARY KEY,
        commitment_id INTEGER NOT NULL
          REFERENCES palonur_commitments(id) ON DELETE CASCADE,
        scheduled_at  TIMESTAMPTZ NOT NULL,
        sent_at       TIMESTAMPTZ,
        outcome       TEXT CHECK (outcome IN ('helped','no_change','not_tried')),
        outcome_at    TIMESTAMPTZ,
        UNIQUE (commitment_id)
      );
    `);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (!msg.includes("already exists")) {
      console.error("ensureFollowupSchema failed:", msg);
    }
  }
}
ensureFollowupSchema();

/**
 * Returns the next 8:00 AM as a UTC Date, anchored to the user's IANA timezone.
 * Falls back to server-local time when the timezone is missing or invalid.
 *
 * Uses an "estimate then correct" loop: start from 08:00 UTC on the target day,
 * then shift by the observed offset so the result lands on exactly 08:00 local.
 * Two passes handle DST transitions cleanly (max real-world shift is 1 h).
 *
 * Note: targetDay overflow (e.g. day 32) is intentional — Date.UTC rolls it over
 * to the next month automatically.
 */
function nextEightAm(userTimezone?: string | null): Date {
  const now = new Date();

  if (userTimezone) {
    try {
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: userTimezone,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", hourCycle: "h23",
      });
      const getPart = (type: string, d: Date): number =>
        parseInt(fmt.formatToParts(d).find((p) => p.type === type)?.value ?? "0", 10);

      const year = getPart("year", now);
      const month = getPart("month", now);  // 1-indexed
      const day = getPart("day", now);
      const hour = getPart("hour", now);

      // If it's already 8am or later in the user's zone, target tomorrow.
      const targetDay = hour < 8 ? day : day + 1;

      // Start from 08:00 UTC on the target date (a rough guess).
      let guess = new Date(Date.UTC(year, month - 1, targetDay, 8, 0, 0));

      // Shift by observed offset; repeat once to handle DST boundary edge cases.
      for (let i = 0; i < 2; i++) {
        const diff = 8 - getPart("hour", guess);
        if (diff === 0) break;
        guess = new Date(guess.getTime() + diff * 3_600_000);
      }

      if (!isNaN(guess.getTime())) return guess;
    } catch {
      // Fall through to server-local fallback.
    }
  }

  // Server-local fallback.
  const d = new Date(now);
  d.setHours(8, 0, 0, 0);
  if (d <= now) d.setDate(d.getDate() + 1);
  return d;
}

/**
 * Schedules the morning follow-up email via process-local setTimeout.
 * MVP approach (low volume); a persistent job queue would replace this for scale.
 * Only stamps sent_at when the send actually succeeds.
 */
function scheduleFollowupEmail({
  commitmentId,
  to,
  firstName,
  actionText,
  reflectToken,
  scheduledAt,
}: {
  commitmentId: number;
  to: string;
  firstName: string;
  actionText: string;
  reflectToken: string;
  scheduledAt: Date;
}) {
  const delay = Math.max(0, scheduledAt.getTime() - Date.now());
  setTimeout(async () => {
    try {
      const ok = await sendCommitmentFollowupEmail({ to, firstName, actionText, reflectToken });
      if (ok) {
        await pool.query(
          `UPDATE commitment_followups SET sent_at = NOW() WHERE commitment_id = $1`,
          [commitmentId],
        );
      }
    } catch (e) {
      console.error("commitment followup send failed:", (e as Error).message);
    }
  }, delay);
}

const router: IRouter = Router();

/**
 * Derive a friendly first name from an email local-part when the user skipped
 * the (optional) name field. "ana.garcia42@x.com" → "Ana". Keeping the column
 * NOT NULL means every downstream consumer (morning check-in emails, journey
 * greeting, admin views) keeps working unchanged.
 */
function deriveFirstName(email: string): string {
  const local = email.split("@")[0] ?? "";
  const word = local.split(/[._\-+]/).find((w) => /[a-zA-Z]/.test(w)) ?? "";
  const letters = word.replace(/[^a-zA-Z]/g, "");
  if (!letters) return "Friend";
  return letters.charAt(0).toUpperCase() + letters.slice(1).toLowerCase();
}

router.post("/register", async (req, res) => {
  const { first_name, email, timezone } = req.body as {
    first_name?: string; email?: string; timezone?: string;
  };
  if (!email?.trim()) {
    return res.status(400).json({ error: "email required" });
  }
  const firstName = first_name?.trim() || deriveFirstName(email.trim().toLowerCase());
  const tz = timezone?.trim() || null;
  try {
    const existing = await pool.query(
      "SELECT id, first_name FROM palonur_users WHERE email = $1 LIMIT 1",
      [email.trim().toLowerCase()]
    );
    if (existing.rows.length > 0) {
      if (tz) {
        await pool.query(
          "UPDATE palonur_users SET timezone = $1 WHERE id = $2 AND timezone IS NULL",
          [tz, existing.rows[0].id]
        );
      }
      return res.json({ userId: existing.rows[0].id, first_name: existing.rows[0].first_name, existing: true });
    }
    const result = await pool.query(
      "INSERT INTO palonur_users (first_name, email, timezone) VALUES ($1, $2, $3) RETURNING id, first_name",
      [firstName, email.trim().toLowerCase(), tz]
    );
    return res.json({ userId: result.rows[0].id, first_name: result.rows[0].first_name, existing: false });
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

router.post("/sleep-log", async (req, res) => {
  const { user_id, quality, note, log_date } = req.body as {
    user_id?: number; quality?: number; note?: string; log_date?: string;
  };
  if (!user_id || !quality) {
    return res.status(400).json({ error: "user_id and quality required" });
  }
  if (quality < 1 || quality > 5) {
    return res.status(400).json({ error: "quality must be 1–5" });
  }
  try {
    const date = log_date ?? new Date().toISOString().slice(0, 10);
    const result = await pool.query(
      `INSERT INTO palonur_sleep_logs (user_id, log_date, quality, note)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, log_date)
       DO UPDATE SET quality = EXCLUDED.quality, note = EXCLUDED.note
       RETURNING id, log_date, quality, note`,
      [user_id, date, quality, note?.trim() ?? null]
    );
    return res.json(result.rows[0]);
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

type JourneyLog = { log_date: string; quality: number; note: string | null };

// Lifetime, honest summary figures computed across EVERY logged night. Returned
// only in the `range=all` ("so far") mode so the default weekly fetch stays lean.
// Trend is a simple recent-half vs earlier-half average-quality comparison; it
// stays null until there are enough nights (>=4) for the split to mean anything.
function computeJourneyStats(logs: JourneyLog[]) {
  const totalNights = logs.length;
  if (totalNights === 0) {
    return { totalNights: 0, avgQuality: null, trend: null };
  }
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const avgQuality = round1(logs.reduce((s, l) => s + l.quality, 0) / totalNights);

  let trend: {
    direction: "up" | "down" | "steady";
    recentAvg: number;
    earlierAvg: number;
  } | null = null;
  if (totalNights >= 4) {
    // The query returns nights newest-first, so reverse to get chronological
    // order, then split into an earlier half and a recent half. For an odd count
    // the single middle night is left out of both halves so the split stays clean.
    const asc = [...logs].reverse();
    const half = Math.floor(asc.length / 2);
    const earlier = asc.slice(0, half);
    const recent = asc.slice(asc.length - half);
    const earlierAvg = earlier.reduce((s, l) => s + l.quality, 0) / earlier.length;
    const recentAvg = recent.reduce((s, l) => s + l.quality, 0) / recent.length;
    const delta = recentAvg - earlierAvg;
    const direction = delta > 0.2 ? "up" : delta < -0.2 ? "down" : "steady";
    trend = { direction, recentAvg: round1(recentAvg), earlierAvg: round1(earlierAvg) };
  }
  return { totalNights, avgQuality, trend };
}

router.get("/journey/:userId", async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (isNaN(userId)) return res.status(400).json({ error: "invalid userId" });
  // The default weekly grid only needs recent nights; the "so far" history view
  // asks for `range=all` to get the complete log history plus lifetime stats.
  const allHistory = req.query.range === "all";
  try {
    const user = await pool.query(
      "SELECT id, first_name, created_at FROM palonur_users WHERE id = $1",
      [userId]
    );
    if (!user.rows.length) return res.status(404).json({ error: "user not found" });

    // Return the MOST RECENT logs (not the oldest). The /journey grid is a
    // rolling 7-night window ending today, so it needs recent entries; ASC+LIMIT
    // would starve active users with >30 logs of their current week. The client
    // matches by date via .find(), so the returned order does not matter. With
    // range=all the LIMIT is dropped so the full lifetime history is reachable.
    const logs = await pool.query<JourneyLog>(
      `SELECT log_date, quality, note
       FROM palonur_sleep_logs WHERE user_id = $1
       ORDER BY log_date DESC${allHistory ? "" : " LIMIT 30"}`,
      [userId]
    );
    return res.json({
      user: user.rows[0],
      logs: logs.rows,
      ...(allHistory ? { stats: computeJourneyStats(logs.rows) } : {}),
    });
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

// Weekly coaching loop — same grounded reflection the weekly email sends, shown
// in-app on /journey. Stats recomputed live; grounded note reused from cache.
router.get("/weekly-reflection/:userId", async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (isNaN(userId)) return res.status(400).json({ error: "invalid userId" });
  try {
    const reflection = await computeWeeklyReflection(userId);
    if (!reflection) return res.status(404).json({ error: "user not found" });
    return res.json(reflection);
  } catch (e) {
    req.log.error({ err: e }, "weekly-reflection failed");
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

router.post("/commitment", async (req, res) => {
  const { user_id, action_text, sleep_question } = req.body as {
    user_id?: number; action_text?: string; sleep_question?: string;
  };
  if (!user_id || !action_text?.trim()) {
    return res.status(400).json({ error: "user_id and action_text required" });
  }
  try {
    const result = await pool.query(
      `INSERT INTO palonur_commitments (user_id, action_text, sleep_question)
       VALUES ($1, $2, $3) RETURNING id, created_at`,
      [user_id, action_text.trim(), sleep_question?.trim() ?? null]
    );
    const commitment = result.rows[0] as { id: number; created_at: string };

    // Attempt to schedule a morning follow-up email for users with an email on file.
    let followUpScheduled = false;
    try {
      const userRow = await pool.query(
        `SELECT first_name, email, email_opted_out, timezone FROM palonur_users WHERE id = $1`,
        [user_id],
      );
      const user = userRow.rows[0] as {
        first_name: string; email: string | null; email_opted_out: boolean; timezone: string | null;
      } | undefined;
      if (user?.email && !user.email_opted_out) {
        const token = randomBytes(24).toString("base64url");
        const scheduledAt = nextEightAm(user.timezone);
        await pool.query(
          `UPDATE palonur_commitments SET reflect_token = $1 WHERE id = $2`,
          [token, commitment.id],
        );
        await pool.query(
          `INSERT INTO commitment_followups (commitment_id, scheduled_at)
           VALUES ($1, $2) ON CONFLICT (commitment_id) DO NOTHING`,
          [commitment.id, scheduledAt],
        );
        scheduleFollowupEmail({
          commitmentId: commitment.id,
          to: user.email,
          firstName: user.first_name,
          actionText: action_text.trim(),
          reflectToken: token,
          scheduledAt,
        });
        followUpScheduled = true;
      }
    } catch (e) {
      req.log?.warn({ err: e }, "commitment follow-up scheduling failed, continuing");
    }

    return res.json({ ...commitment, followUpScheduled });
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

router.post("/checkin", async (req, res) => {
  const { user_id, commitment_id, did_it } = req.body as {
    user_id?: number; commitment_id?: number; did_it?: boolean;
  };
  if (!user_id || commitment_id == null || did_it == null) {
    return res.status(400).json({ error: "user_id, commitment_id, and did_it required" });
  }
  try {
    const result = await pool.query(
      `INSERT INTO palonur_checkins (user_id, commitment_id, checkin_date, did_it)
       VALUES ($1, $2, CURRENT_DATE, $3)
       ON CONFLICT (user_id, commitment_id, checkin_date)
       DO UPDATE SET did_it = EXCLUDED.did_it
       RETURNING id, checkin_date, did_it`,
      [user_id, commitment_id, did_it]
    );
    return res.json(result.rows[0]);
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

// Persist the user's "tonight's focus" pick server-side so it follows them
// across devices. Scoped per user + day. `focus_date` is the client's local
// date (YYYY-MM-DD) so it aligns with the user's wall-clock "tonight"; we fall
// back to the server's CURRENT_DATE when it's absent or malformed.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.post("/tonights-focus", async (req, res) => {
  const { user_id, commitment_id, focus_date } = req.body as {
    user_id?: number; commitment_id?: number; focus_date?: string;
  };
  if (!user_id || commitment_id == null) {
    return res.status(400).json({ error: "user_id and commitment_id required" });
  }
  const date = focus_date && DATE_RE.test(focus_date.trim()) ? focus_date.trim() : null;
  try {
    const result = await pool.query(
      `INSERT INTO palonur_tonights_focus (user_id, focus_date, commitment_id, updated_at)
       VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, NOW())
       ON CONFLICT (user_id, focus_date)
       DO UPDATE SET commitment_id = EXCLUDED.commitment_id, updated_at = NOW()
       RETURNING to_char(focus_date, 'YYYY-MM-DD') AS focus_date, commitment_id`,
      [user_id, date, commitment_id]
    );
    const row = result.rows[0];
    return res.json({ date: row.focus_date, commitmentId: row.commitment_id });
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

router.get("/active-commitment/:userId", async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (isNaN(userId)) return res.status(400).json({ error: "invalid userId" });
  try {
    // Return ALL commitments for the user (most recent first), each with its
    // own checkin history and today's status. Older endpoints returned just
    // the latest commitment as `commitment` + `checkins` + `todayCheckin`;
    // we keep those legacy fields populated from the most recent commitment
    // for back-compat, and add `commitments: [...]` for surfaces that want
    // to render every active experiment.
    const comm = await pool.query(
      `SELECT id, action_text, sleep_question, created_at
       FROM palonur_commitments WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );
    if (!comm.rows.length) {
      return res.json({ commitment: null, checkins: [], todayCheckin: null, commitments: [], tonightsFocus: null });
    }

    const [checkinsAll, followupsAll] = await Promise.all([
      pool.query(
        `SELECT commitment_id, checkin_date, did_it FROM palonur_checkins
         WHERE user_id = $1 ORDER BY checkin_date ASC`,
        [userId]
      ),
      pool.query(
        `SELECT cf.commitment_id, cf.outcome, cf.outcome_at
         FROM commitment_followups cf
         JOIN palonur_commitments pc ON pc.id = cf.commitment_id
         WHERE pc.user_id = $1`,
        [userId]
      ).catch(() => ({ rows: [] as Array<{ commitment_id: number; outcome: string | null; outcome_at: string | null }> })),
    ]);

    const followupMap = new Map(
      followupsAll.rows.map((r) => [
        r.commitment_id,
        { outcome: r.outcome as string | null, outcomeAt: r.outcome_at as string | null },
      ])
    );

    const commitments = comm.rows.map((c) => {
      const myCheckins = checkinsAll.rows
        .filter((r) => r.commitment_id === c.id)
        .map((r) => ({ checkin_date: r.checkin_date, did_it: r.did_it }));
      const today = myCheckins.find((r) => {
        const d = typeof r.checkin_date === "string" ? r.checkin_date.slice(0, 10) : new Date(r.checkin_date).toISOString().slice(0, 10);
        const now = new Date().toISOString().slice(0, 10);
        return d === now;
      });
      const followup = followupMap.get(c.id) ?? null;
      return {
        id: c.id,
        action_text: c.action_text,
        sleep_question: c.sleep_question,
        created_at: c.created_at,
        checkins: myCheckins,
        todayCheckin: today ? { did_it: today.did_it } : null,
        followupOutcome: followup?.outcome ?? null,
        followupOutcomeAt: followup?.outcomeAt ?? null,
      };
    });

    // Most recent "tonight's focus" pick (if any). The client compares its
    // `date` against the user's local today and falls back to localStorage when
    // it doesn't match (or the server has none).
    const focus = await pool.query(
      `SELECT to_char(focus_date, 'YYYY-MM-DD') AS focus_date, commitment_id
       FROM palonur_tonights_focus WHERE user_id = $1
       ORDER BY focus_date DESC LIMIT 1`,
      [userId]
    );
    const tonightsFocus = focus.rows.length
      ? { date: focus.rows[0].focus_date, commitmentId: focus.rows[0].commitment_id }
      : null;

    const latest = commitments[0];
    return res.json({
      commitment: { id: latest.id, action_text: latest.action_text, sleep_question: latest.sleep_question, created_at: latest.created_at },
      checkins: latest.checkins,
      todayCheckin: latest.todayCheckin,
      commitments,
      tonightsFocus,
    });
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

router.get("/checkin-link/:token", async (req, res) => {
  const { token } = req.params;
  const didIt = req.query.did_it === "true";
  const BASE = process.env["PUBLIC_URL"] ?? "https://palonur.com";

  function confirmPage(didIt: boolean, streakDays: number) {
    const headline = didIt
      ? "Logged. Well done."
      : "Noted — no pressure.";
    const sub = didIt
      ? streakDays > 1
        ? `That's ${streakDays} nights in a row. Your body is paying attention.`
        : "One night down. Keep going."
      : "Sleep experiments take patience. Try again tonight if you can.";
    const cta = didIt ? "See my journey →" : "Ask the sleep agent →";
    const ctaHref = didIt ? `${BASE}/journey` : `${BASE}/sleep`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Check-in recorded · Palonur</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
       background:#faf8f6;min-height:100vh;display:flex;align-items:center;
       justify-content:center;padding:24px}
  .card{background:#fff;border-radius:20px;padding:44px 36px;max-width:420px;
        width:100%;box-shadow:0 4px 32px rgba(0,0,0,.07);text-align:center}
  .icon{font-size:48px;margin-bottom:20px}
  h1{font-family:Georgia,serif;font-size:26px;color:#1a0505;margin-bottom:12px;
     line-height:1.25}
  p{font-size:15px;color:#666;line-height:1.6;margin-bottom:32px}
  a{display:inline-block;background:#8B1A1A;color:#fff;text-decoration:none;
    padding:14px 28px;border-radius:12px;font-size:15px;font-weight:600;
    letter-spacing:.01em;transition:opacity .15s}
  a:hover{opacity:.88}
  .wordmark{margin-top:32px;font-size:11px;color:#bbb;letter-spacing:.08em;
            text-transform:uppercase}
</style>
</head>
<body>
<div class="card">
  <div class="icon">${didIt ? "✓" : "○"}</div>
  <h1>${headline}</h1>
  <p>${sub}</p>
  <a href="${ctaHref}">${cta}</a>
  <div class="wordmark">Palonur · Stanford Lifestyle Medicine</div>
</div>
</body>
</html>`;
  }

  try {
    const comm = await pool.query(
      `SELECT id, user_id FROM palonur_commitments WHERE check_in_token = $1`,
      [token]
    );
    if (!comm.rows.length) {
      return res.redirect(`${BASE}/journey`);
    }
    const { id: commitment_id, user_id } = comm.rows[0];
    await pool.query(
      `INSERT INTO palonur_checkins (user_id, commitment_id, checkin_date, did_it)
       VALUES ($1, $2, CURRENT_DATE, $3)
       ON CONFLICT (user_id, commitment_id, checkin_date)
       DO UPDATE SET did_it = EXCLUDED.did_it`,
      [user_id, commitment_id, didIt]
    );
    const streak = await pool.query(
      `SELECT COUNT(*) AS days FROM (
         SELECT checkin_date FROM palonur_checkins
         WHERE user_id = $1 AND did_it = true
         ORDER BY checkin_date DESC
         LIMIT 7
       ) sub`,
      [user_id]
    );
    const streakDays = parseInt(streak.rows[0]?.days ?? "1", 10);
    return res.send(confirmPage(didIt, streakDays));
  } catch {
    return res.redirect(`${BASE}/journey`);
  }
});

router.post("/interaction", async (req, res) => {
  const {
    user_id,
    original_question,
    clarify_question,
    clarify_answer,
    final_question,
    ai_answer,
    article_url,
  } = req.body as {
    user_id?: number;
    original_question?: string;
    clarify_question?: string;
    clarify_answer?: string;
    final_question?: string;
    ai_answer?: string;
    article_url?: string;
  };

  if (!original_question?.trim() || !final_question?.trim() || !ai_answer?.trim()) {
    return res.status(400).json({ error: "original_question, final_question, and ai_answer are required" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO palonur_interactions
         (user_id, original_question, clarify_question, clarify_answer, final_question, ai_answer, article_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, created_at`,
      [
        user_id ?? null,
        original_question.trim(),
        clarify_question?.trim() ?? null,
        clarify_answer?.trim() ?? null,
        final_question.trim(),
        ai_answer.trim(),
        article_url ?? null,
      ]
    );
    return res.json(result.rows[0]);
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

router.get("/user/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    const result = await pool.query(
      "SELECT id, first_name, email, email_opted_out FROM palonur_users WHERE id = $1",
      [userId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "User not found" });
    return res.json(result.rows[0]);
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

router.delete("/user/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    const result = await pool.query(
      "DELETE FROM palonur_users WHERE id = $1 RETURNING id",
      [userId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "User not found" });
    return res.json({ deleted: true });
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

router.put("/user/:userId", async (req, res) => {
  const { userId } = req.params;
  const { first_name, email, email_opted_out } = req.body as {
    first_name?: string;
    email?: string;
    email_opted_out?: boolean;
  };
  try {
    const result = await pool.query(
      `UPDATE palonur_users
       SET first_name     = COALESCE($1, first_name),
           email          = COALESCE($2, email),
           email_opted_out = COALESCE($3, email_opted_out)
       WHERE id = $4
       RETURNING id, first_name, email, email_opted_out`,
      [
        first_name?.trim() || null,
        email?.trim().toLowerCase() || null,
        email_opted_out ?? null,
        userId,
      ]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "User not found" });
    return res.json(result.rows[0]);
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

/**
 * Records the outcome from a morning follow-up email link and redirects
 * the user to the /reflect page with the outcome pre-set so they see a
 * warm confirmation without needing to be logged in.
 */
router.get("/reflect", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token.trim() : "";
  const outcome = typeof req.query.outcome === "string" ? req.query.outcome.trim() : "";
  if (!token || !VALID_OUTCOMES.has(outcome)) {
    return res.redirect(`${REFLECT_BASE}/reflect?error=1`);
  }
  try {
    const comm = await pool.query(
      `SELECT id FROM palonur_commitments WHERE reflect_token = $1`,
      [token],
    );
    if (!comm.rows.length) {
      return res.redirect(`${REFLECT_BASE}/reflect?error=1`);
    }
    const commitmentId = (comm.rows[0] as { id: number }).id;
    await pool.query(
      `UPDATE commitment_followups
       SET outcome = $1, outcome_at = NOW()
       WHERE commitment_id = $2`,
      [outcome, commitmentId],
    );
    return res.redirect(`${REFLECT_BASE}/reflect?done=1&outcome=${outcome}`);
  } catch {
    return res.redirect(`${REFLECT_BASE}/reflect?error=1`);
  }
});

export default router;
