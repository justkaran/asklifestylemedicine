import Anthropic from "@anthropic-ai/sdk";
import pool from "./db";
import { logger } from "./logger";
import {
  retrieve,
  buildContextBlock,
  buildProvenance,
  verifyCitation,
} from "./rag";
import { buildGovernedSystemPrompt } from "../routes/sleep-agent";
import { RAG_MIN_SCORE } from "./ragThreshold";

// The weekly reflection's grounded coaching note is generated through the SAME
// governed/cited RAG path the live sleep agent uses: retrieve over the approved
// Stanford knowledge layer, inject a CONTEXT block the model is forbidden to
// stray from, then verify the emitted CITATION maps back to a retrieved source.
// Refusal behavior (REFUSE/UNCOVERED) is preserved: a miss yields NO note
// rather than a fabricated summary.

const anthropic = new Anthropic({
  baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
});


// The reflection coaches strictly on the Restorative Sleep pillar (lifestyle
// habits, consistency, timing). It never routes to medical/treatment pillars.
const REFLECTION_PILLAR_SLUG = "sleep";

export interface WeeklyCommitmentSummary {
  id: number;
  actionText: string;
  sleepQuestion: string | null;
  didCount: number;
  totalCheckins: number;
}

export interface GroundedNote {
  answer: string;
  finding: string | null;
  citation: string;
  paper: string | null;
  sourceUrl: string | null;
  pillarName: string | null;
}

export interface WeeklyReflection {
  user: {
    id: number;
    firstName: string;
    email: string;
    emailOptedOut: boolean;
  };
  weekStart: string;
  windowStart: string;
  windowEnd: string;
  nights: {
    count: number;
    avgQuality: number | null;
    logs: Array<{ log_date: string; quality: number }>;
  };
  commitments: WeeklyCommitmentSummary[];
  /** The commitment whose advice anchors the grounded note, if any. */
  focusCommitmentId: number | null;
  /** True when the user logged at least one night or checked in this week. */
  hasData: boolean;
  /** Gentle, non-fabricated nudge shown to empty-data users. Null otherwise. */
  emptyPrompt: string | null;
  /** Grounded, cited coaching note — null on a RAG miss/refusal. */
  groundedNote: GroundedNote | null;
}

interface GatheredData {
  user: WeeklyReflection["user"];
  weekStart: string;
  windowStart: string;
  windowEnd: string;
  nights: WeeklyReflection["nights"];
  commitments: WeeklyCommitmentSummary[];
  focusCommitmentId: number | null;
}

function pickSection(text: string, name: string): string | null {
  const re = new RegExp(
    `^\\s*${name}:\\s*([\\s\\S]*?)(?=\\n\\s*(?:ANSWER|CITATION|PAPER|FINDING|INTERPRETATION|ACTION|INSIGHT|CLARIFY|ADVISOR_NOTE):|$)`,
    "im",
  );
  const m = text.match(re);
  const val = m?.[1]?.trim();
  return val ? val : null;
}

async function gatherWeeklyData(userId: number): Promise<GatheredData | null> {
  const userRes = await pool.query(
    `SELECT id, first_name, email, email_opted_out FROM palonur_users WHERE id = $1`,
    [userId],
  );
  if (!userRes.rows.length) return null;
  const u = userRes.rows[0];

  const meta = await pool.query<{
    week_start: string;
    window_start: string;
    window_end: string;
  }>(
    `SELECT
       to_char(date_trunc('week', CURRENT_DATE), 'YYYY-MM-DD') AS week_start,
       to_char(CURRENT_DATE - 6, 'YYYY-MM-DD')                 AS window_start,
       to_char(CURRENT_DATE, 'YYYY-MM-DD')                     AS window_end`,
  );
  const { week_start, window_start, window_end } = meta.rows[0];

  const logsRes = await pool.query<{ log_date: string; quality: number }>(
    `SELECT to_char(log_date, 'YYYY-MM-DD') AS log_date, quality
       FROM palonur_sleep_logs
      WHERE user_id = $1 AND log_date >= CURRENT_DATE - 6
      ORDER BY log_date ASC`,
    [userId],
  );
  const logs = logsRes.rows.map((r) => ({
    log_date: r.log_date,
    quality: Number(r.quality),
  }));
  const avgQuality =
    logs.length > 0
      ? Math.round((logs.reduce((s, l) => s + l.quality, 0) / logs.length) * 10) /
        10
      : null;

  const commRes = await pool.query<{
    id: number;
    action_text: string;
    sleep_question: string | null;
    did_count: string;
    total_checkins: string;
  }>(
    `SELECT
       c.id,
       c.action_text,
       c.sleep_question,
       COUNT(ck.id) FILTER (WHERE ck.did_it) AS did_count,
       COUNT(ck.id)                           AS total_checkins
     FROM palonur_commitments c
     LEFT JOIN palonur_checkins ck
       ON ck.commitment_id = c.id AND ck.checkin_date >= CURRENT_DATE - 6
     WHERE c.user_id = $1
     GROUP BY c.id
     ORDER BY c.created_at DESC`,
    [userId],
  );
  const commitments: WeeklyCommitmentSummary[] = commRes.rows.map((c) => ({
    id: Number(c.id),
    actionText: c.action_text,
    sleepQuestion: c.sleep_question,
    didCount: Number(c.did_count),
    totalCheckins: Number(c.total_checkins),
  }));

  // Anchor the grounded note on the user's most recent "tonight's focus" pick
  // when it points at a still-active commitment, else the newest commitment.
  let focusCommitmentId: number | null = commitments.length
    ? commitments[0].id
    : null;
  const focusRes = await pool.query<{ commitment_id: number }>(
    `SELECT commitment_id FROM palonur_tonights_focus
      WHERE user_id = $1 ORDER BY focus_date DESC LIMIT 1`,
    [userId],
  );
  if (focusRes.rows.length) {
    const fid = Number(focusRes.rows[0].commitment_id);
    if (commitments.some((c) => c.id === fid)) focusCommitmentId = fid;
  }

  return {
    user: {
      id: Number(u.id),
      firstName: u.first_name,
      email: u.email,
      emailOptedOut: Boolean(u.email_opted_out),
    },
    weekStart: week_start,
    windowStart: window_start,
    windowEnd: window_end,
    nights: { count: logs.length, avgQuality, logs },
    commitments,
    focusCommitmentId,
  };
}

/**
 * Generate a short grounded, cited coaching note for `question` through the
 * governed RAG path. Returns null on any refusal / miss / unverifiable
 * citation so the caller never surfaces a fabricated or uncited claim.
 */
export async function generateGroundedNote(
  question: string,
): Promise<GroundedNote | null> {
  const q = question.trim();
  if (!q) return null;

  const pillarRes = await pool.query<{ id: number; name: string }>(
    `SELECT id, name FROM pillars WHERE slug = $1 ORDER BY id ASC LIMIT 1`,
    [REFLECTION_PILLAR_SLUG],
  );
  if (!pillarRes.rows.length) return null;
  const pillar = pillarRes.rows[0];

  let result;
  try {
    result = await retrieve({ question: q, pillarIds: [Number(pillar.id)], k: 6 });
  } catch (err) {
    logger.error({ err }, "Weekly reflection retrieval failed");
    return null;
  }

  // Refusal behavior intact: an empty/below-threshold retrieval means the
  // governed knowledge map does not cover this — emit no note rather than
  // falling back to an ungoverned answer.
  if (result.chunks.length === 0 || result.topScore < RAG_MIN_SCORE) {
    return null;
  }

  const contextBlock = buildContextBlock(result.chunks);
  const provenance = buildProvenance(result.chunks);
  const system = buildGovernedSystemPrompt(contextBlock, [pillar.name]);

  let answerText: string;
  try {
    const resp = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: q }],
    });
    answerText = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
  } catch (err) {
    logger.error({ err }, "Weekly reflection generation failed");
    return null;
  }

  // Preserve the agent's two refusal modes verbatim.
  if (/^\s*(REFUSE|UNCOVERED):/i.test(answerText)) return null;

  const citation = pickSection(answerText, "CITATION");
  const answer = pickSection(answerText, "ANSWER");
  if (!citation || !answer) return null;

  // Citation guard: the emitted citation MUST map back to a retrieved source,
  // otherwise it is a hallucination and we drop the whole note.
  const verification = verifyCitation(answerText, provenance);
  if (verification.status !== "verified") {
    logger.warn(
      { status: verification.status, citationLine: verification.citationLine },
      "Weekly reflection citation unverified — dropping note",
    );
    return null;
  }

  const matchedId = verification.matchedSourceIds[0];
  const matched = provenance.find((p) => p.source_id === matchedId) ?? null;

  return {
    answer,
    finding: pickSection(answerText, "FINDING"),
    citation,
    paper: pickSection(answerText, "PAPER"),
    sourceUrl: matched?.source_url ?? null,
    pillarName: pillar.name,
  };
}

/**
 * Build the full weekly reflection for a user. Stats are always recomputed
 * live; the (expensive) grounded note is cached once per ISO week per anchor
 * question in `palonur_weekly_reflections`, so repeated /journey loads and the
 * weekly email reuse one generation.
 */
export async function computeWeeklyReflection(
  userId: number,
): Promise<WeeklyReflection | null> {
  const data = await gatherWeeklyData(userId);
  if (!data) return null;

  const recentCheckins = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM palonur_checkins
      WHERE user_id = $1 AND checkin_date >= CURRENT_DATE - 6`,
    [userId],
  );
  const hasCheckins = Number(recentCheckins.rows[0]?.n ?? 0) > 0;
  const hasData = data.nights.count > 0 || hasCheckins;

  const base: WeeklyReflection = {
    user: data.user,
    weekStart: data.weekStart,
    windowStart: data.windowStart,
    windowEnd: data.windowEnd,
    nights: data.nights,
    commitments: data.commitments,
    focusCommitmentId: data.focusCommitmentId,
    hasData,
    emptyPrompt: null,
    groundedNote: null,
  };

  if (!hasData) {
    base.emptyPrompt =
      "You haven't logged any nights or check-ins this week yet. Log a night or start a small experiment, and next week's reflection will connect what you tried to how you slept.";
    return base;
  }

  // Anchor the grounded note on the focus commitment's advice. No commitment
  // means there's no advice to tie back to — skip the note (no fabrication).
  const focus =
    data.commitments.find((c) => c.id === data.focusCommitmentId) ?? null;
  if (!focus) return base;

  const question =
    focus.sleepQuestion?.trim() ||
    `What does sleep science say about the habit of "${focus.actionText}" for better sleep?`;

  base.groundedNote = await getOrGenerateNote(
    userId,
    data.weekStart,
    question,
  );
  return base;
}

async function getOrGenerateNote(
  userId: number,
  weekStart: string,
  question: string,
): Promise<GroundedNote | null> {
  const cached = await pool.query<{ question: string; note: GroundedNote | null }>(
    `SELECT question, note FROM palonur_weekly_reflections
      WHERE user_id = $1 AND week_start = $2`,
    [userId, weekStart],
  );
  if (cached.rows.length && cached.rows[0].question === question) {
    return cached.rows[0].note;
  }

  const note = await generateGroundedNote(question);
  await pool.query(
    `INSERT INTO palonur_weekly_reflections (user_id, week_start, question, note, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, NOW())
     ON CONFLICT (user_id, week_start)
       DO UPDATE SET question = EXCLUDED.question, note = EXCLUDED.note, updated_at = NOW()`,
    [userId, weekStart, question, note ? JSON.stringify(note) : null],
  );
  return note;
}
