import { Router, type IRouter } from "express";
import Anthropic from "@anthropic-ai/sdk";
import pool from "../lib/db";

const router: IRouter = Router();

const anthropic = new Anthropic({
  baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
  apiKey:  process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
});

// ── Zeitzer research grounding for wearable data ──────────────────────────────
const WEARABLE_SYSTEM = `You are a sleep analysis assistant grounded exclusively in the
published research of Prof. Jamie M. Zeitzer (Stanford University, Center for Sleep &
Circadian Sciences). You are analyzing real Apple Watch sleep data for a user.

RESPONSE FORMAT — respond with exactly these sections in order:

HEADLINE:
[One crisp sentence summarizing last night overall. Max 20 words. No jargon.]

DEEP_SLEEP:
[1–2 sentences on their deep/slow-wave sleep duration vs. what Stanford sleep science
and established norms expect for their age group. If data unavailable say so.]

REM:
[1–2 sentences on REM duration and its implications per Stanford sleep science. Be specific.]

HRV:
[1–2 sentences interpreting HRV in context of sleep quality and circadian health. 
HRV should be higher during deep sleep, lower at sleep onset. Note trends if available.]

HEART_RATE:
[1–2 sentences interpreting resting heart rate during sleep. Normal: 40–60 bpm during sleep.]

CIRCADIAN:
[1–2 sentences on timing alignment: when did they fall asleep and wake relative to 
their likely circadian window? Reference Zeitzer's work on circadian phase if relevant.]

ACTION_TONIGHT:
[Exactly one concrete thing to do tonight based on the data. Start with a verb. Max 18 words.]

ACTION_MORNING:
[Exactly one concrete thing to do tomorrow morning. Start with a verb. Max 18 words.]

ZEITZER_INSIGHT:
[One surprising research finding from Zeitzer's lab that directly applies to what this
data shows. Cite the paper inline: Source: Zeitzer et al., Year, Journal. Max 50 words.]

RULES:
- Never fabricate data. If a field is null/missing, say so and skip that section's advice.
- Never cite papers not by Zeitzer. 
- Speak directly to the user in second person. Warm, precise, not clinical.
- No bullet points, no markdown, no headers beyond the section names above.`;

// ── POST /api/apple-health — ingest nightly data from Apple Shortcut ──────────
router.post("/apple-health", async (req, res) => {
  const token = (req.headers["x-palonur-token"] as string) || (req.query.token as string);
  if (!token) return res.status(401).json({ error: "x-palonur-token header required" });

  const user = await pool.query(
    "SELECT id FROM palonur_users WHERE apple_token = $1 LIMIT 1",
    [token]
  ).catch(() => null);

  if (!user?.rows.length) return res.status(401).json({ error: "Invalid token" });
  const userId = user.rows[0].id;

  const {
    sleep_date,
    total_sleep_min,
    deep_sleep_min,
    rem_sleep_min,
    light_sleep_min,
    awake_min,
    sleep_start,
    sleep_end,
    hrv_avg,
    heart_rate_avg,
    heart_rate_min,
    respiratory_rate,
    blood_oxygen,
    wrist_temperature,
  } = req.body as Record<string, number | string | null | undefined>;

  if (!sleep_date) return res.status(400).json({ error: "sleep_date required (YYYY-MM-DD)" });

  try {
    const result = await pool.query(`
      INSERT INTO palonur_apple_health (
        user_id, sleep_date,
        total_sleep_min, deep_sleep_min, rem_sleep_min, light_sleep_min, awake_min,
        sleep_start, sleep_end,
        hrv_avg, heart_rate_avg, heart_rate_min,
        respiratory_rate, blood_oxygen, wrist_temperature
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (user_id, sleep_date) DO UPDATE SET
        total_sleep_min  = EXCLUDED.total_sleep_min,
        deep_sleep_min   = EXCLUDED.deep_sleep_min,
        rem_sleep_min    = EXCLUDED.rem_sleep_min,
        light_sleep_min  = EXCLUDED.light_sleep_min,
        awake_min        = EXCLUDED.awake_min,
        sleep_start      = EXCLUDED.sleep_start,
        sleep_end        = EXCLUDED.sleep_end,
        hrv_avg          = EXCLUDED.hrv_avg,
        heart_rate_avg   = EXCLUDED.heart_rate_avg,
        heart_rate_min   = EXCLUDED.heart_rate_min,
        respiratory_rate = EXCLUDED.respiratory_rate,
        blood_oxygen     = EXCLUDED.blood_oxygen,
        wrist_temperature= EXCLUDED.wrist_temperature,
        updated_at       = NOW()
      RETURNING id`,
      [
        userId, sleep_date,
        total_sleep_min ?? null, deep_sleep_min ?? null, rem_sleep_min ?? null,
        light_sleep_min ?? null, awake_min ?? null,
        sleep_start ?? null, sleep_end ?? null,
        hrv_avg ?? null, heart_rate_avg ?? null, heart_rate_min ?? null,
        respiratory_rate ?? null, blood_oxygen ?? null, wrist_temperature ?? null,
      ]
    );
    return res.json({ ok: true, id: result.rows[0].id });
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

// ── GET /api/apple-health/latest/:userId — most recent reading (for sleep agent) ─
router.get("/apple-health/latest/:userId", async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (isNaN(userId)) return res.status(400).json({ error: "invalid userId" });
  try {
    const r = await pool.query(`
      SELECT * FROM palonur_apple_health
      WHERE user_id = $1
      ORDER BY sleep_date DESC LIMIT 1`,
      [userId]
    );
    if (!r.rows.length) return res.json({ data: null });
    return res.json({ data: r.rows[0] });
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

// ── GET /api/apple-health/history/:userId — last 14 nights ───────────────────
router.get("/apple-health/history/:userId", async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (isNaN(userId)) return res.status(400).json({ error: "invalid userId" });
  try {
    const r = await pool.query(`
      SELECT * FROM palonur_apple_health
      WHERE user_id = $1
      ORDER BY sleep_date DESC LIMIT 14`,
      [userId]
    );
    return res.json({ data: r.rows });
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

// ── GET /api/apple-health/analysis/:userId — streaming Zeitzer analysis ───────
router.get("/apple-health/analysis/:userId", async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (isNaN(userId)) {
    res.status(400).json({ error: "invalid userId" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  try {
    const [userRes, todayRes, historyRes] = await Promise.all([
      pool.query("SELECT first_name FROM palonur_users WHERE id = $1", [userId]),
      pool.query(`SELECT * FROM palonur_apple_health WHERE user_id = $1 ORDER BY sleep_date DESC LIMIT 1`, [userId]),
      pool.query(`SELECT sleep_date, total_sleep_min, deep_sleep_min, rem_sleep_min, hrv_avg, heart_rate_avg FROM palonur_apple_health WHERE user_id = $1 ORDER BY sleep_date DESC LIMIT 7`, [userId]),
    ]);

    if (!todayRes.rows.length) {
      res.write(`data: ${JSON.stringify({ error: "no_data" })}\n\n`);
      res.end();
      return;
    }

    const firstName = userRes.rows[0]?.first_name ?? "there";
    const d = todayRes.rows[0];
    const history = historyRes.rows;

    const fmt = (v: number | null, unit: string) => v != null ? `${v}${unit}` : "not recorded";
    const fmtTime = (t: string | null) => t ? new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "not recorded";

    const historyLines = history.slice(1).map((h: Record<string, number | string | null>) =>
      `  ${h.sleep_date}: total ${fmt(h.total_sleep_min as number, "min")}, deep ${fmt(h.deep_sleep_min as number, "min")}, REM ${fmt(h.rem_sleep_min as number, "min")}, HRV ${fmt(h.hrv_avg as number, "ms")}`
    ).join("\n");

    const prompt = `User: ${firstName}

LAST NIGHT (${d.sleep_date}):
- Total sleep: ${fmt(d.total_sleep_min, " min")} (${d.total_sleep_min ? Math.floor(d.total_sleep_min / 60) + "h " + (d.total_sleep_min % 60) + "m" : "—"})
- Deep (slow-wave) sleep: ${fmt(d.deep_sleep_min, " min")} (${d.total_sleep_min && d.deep_sleep_min ? Math.round(d.deep_sleep_min / d.total_sleep_min * 100) : "—"}% of total)
- REM sleep: ${fmt(d.rem_sleep_min, " min")} (${d.total_sleep_min && d.rem_sleep_min ? Math.round(d.rem_sleep_min / d.total_sleep_min * 100) : "—"}% of total)
- Light sleep: ${fmt(d.light_sleep_min, " min")}
- Awake during night: ${fmt(d.awake_min, " min")}
- Sleep start: ${fmtTime(d.sleep_start)}
- Wake time: ${fmtTime(d.sleep_end)}
- HRV (avg): ${fmt(d.hrv_avg, " ms")}
- Resting heart rate (avg): ${fmt(d.heart_rate_avg, " bpm")}
- Resting heart rate (min): ${fmt(d.heart_rate_min, " bpm")}
- Respiratory rate: ${fmt(d.respiratory_rate, " breaths/min")}
- Blood oxygen (SpO2): ${fmt(d.blood_oxygen, "%")}
- Wrist temperature deviation: ${d.wrist_temperature != null ? (d.wrist_temperature > 0 ? "+" : "") + d.wrist_temperature + "°C from baseline" : "not recorded"}

PRIOR 6 NIGHTS (for trend context):
${historyLines || "  No prior nights recorded yet"}

Analyze this data and give ${firstName} a full Zeitzer-grounded breakdown.`;

    const stream = anthropic.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 1200,
      system: WEARABLE_SYSTEM,
      messages: [{ role: "user", content: prompt }],
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        res.write(`data: ${JSON.stringify({ content: event.delta.text })}\n\n`);
      }
    }
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: String((e as Error).message) })}\n\n`);
    res.end();
  }
});

// ── POST /api/apple-health/token — get or create apple_token for a user ──────
router.post("/apple-health/token", async (req, res) => {
  const { user_id } = req.body as { user_id?: number };
  if (!user_id) return res.status(400).json({ error: "user_id required" });
  try {
    const r = await pool.query(
      `UPDATE palonur_users
       SET apple_token = COALESCE(apple_token, gen_random_uuid())
       WHERE id = $1
       RETURNING apple_token`,
      [user_id]
    );
    if (!r.rows.length) return res.status(404).json({ error: "user not found" });
    return res.json({ token: r.rows[0].apple_token });
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

export default router;
