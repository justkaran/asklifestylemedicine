// Resend integration via Replit Connectors
import { sendGuarded } from "./emailGuard";
import { getResendClient } from "./resendClient";

const BASE_URL = process.env["PUBLIC_URL"] ?? "https://palonur.replit.app";

// ── Future-self hero image (Hershfield 2011) ────────────────────────────────────
// A vivid image of the rested future self measurably moves behavior more than
// arguments do (age-progressed renderings more than doubled retirement saving:
// Hershfield et al., J. Marketing Research 48, S23–S37). Every Nightly email
// leads with the same warm "rested future you" photograph for that reason.
// The caption deliberately collapses temporal distance (present bias: near
// rewards motivate far more than distant ones) — the "future self" here is
// tomorrow morning, hours away, not decades.
const NIGHTLY_HERO = {
  src: `${BASE_URL}/email-nightly-future-self.jpg`,
  alt: "A rested woman stretching in warm morning light, smiling",
  caption: "This is tomorrow morning &mdash; not someday. Tonight decides it.",
};

// ── Shared quality tables ───────────────────────────────────────────────────────
const QUALITY_COLORS: Record<number, string> = {
  1: "#C0392B", 2: "#E67E22", 3: "#D4A017", 4: "#27AE60", 5: "#1E8449",
};
const QUALITY_LABELS: Record<number, string> = {
  1: "Poor", 2: "Difficult", 3: "Fair", 4: "Good", 5: "Excellent",
};
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ── Base HTML shell (shared across all email types) ─────────────────────────────
function emailShell(opts: {
  fromEmail: string;
  subject: string;
  label: string;
  greeting: string;
  body: string;
  hero?: { src: string; alt: string; caption?: string };
}): { subject: string; html: string; from: string } {
  const heroHtml = opts.hero
    ? `<img src="${opts.hero.src}" alt="${opts.hero.alt}" width="520" style="display:block;width:100%;height:auto;border:0;" />${
        opts.hero.caption
          ? `<div style="background:#fdf9f3;padding:10px 36px;font-size:13px;color:#8a6a5a;font-style:italic;text-align:center;line-height:1.5;">${opts.hero.caption}</div>`
          : ""
      }`
    : "";
  return {
    subject: opts.subject,
    from: `Palonur, Palo Alto <${opts.fromEmail}>`,
    html: `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { margin:0;padding:0;background:#f8f4f4;font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif; }
    .wrap { max-width:520px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden; }
    .hdr  { background:#8B1A1A;padding:28px 36px; }
    .hdr-logo { color:#fff;font-size:18px;font-weight:700;letter-spacing:-0.01em; }
    .bdy  { padding:36px; }
    .lbl  { font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#8B1A1A;margin-bottom:8px; }
    .grt  { font-size:26px;font-weight:500;color:#0f0505;line-height:1.25;margin-bottom:20px;font-family:Georgia,serif;letter-spacing:-0.02em; }
    .ftr  { padding:20px 36px;border-top:1px solid #f0e8e8;font-size:12px;color:#aaa;line-height:1.6; }
    @media (max-width:600px){.wrap{margin:0;border-radius:0;}.bdy{padding:24px;}.hdr{padding:20px 24px;}.ftr{padding:16px 24px;}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hdr"><div class="hdr-logo">Palonur</div></div>
    ${heroHtml}
    <div class="bdy">
      <div class="lbl">${opts.label}</div>
      <div class="grt">${opts.greeting}</div>
      ${opts.body}
    </div>
    <div class="ftr">
      Grounded in Stanford sleep science, led by Prof. Jamie Zeitzer.<br>
      <a href="${BASE_URL}" style="color:#8B1A1A;text-decoration:none;">Palonur</a> &middot; Stanford Lifestyle Medicine
    </div>
  </div>
</body>
</html>`,
  };
}

// ── 1. Morning commitment check-in ─────────────────────────────────────────────
export function buildCommitmentEmail(opts: {
  firstName: string;
  actionText: string;
  yesUrl: string;
  noUrl: string;
  fromEmail: string;
  avgQualityWeek?: number | null;
  avgQualityPrevWeek?: number | null;
  streakCount?: number;
}): { subject: string; html: string; from: string } {
  const { firstName, actionText, yesUrl, noUrl, fromEmail,
          avgQualityWeek, avgQualityPrevWeek, streakCount = 0 } = opts;

  let trendHtml = "";
  if (avgQualityWeek != null) {
    const trend = avgQualityPrevWeek != null
      ? (avgQualityWeek - avgQualityPrevWeek > 0.3 ? "up"
        : avgQualityWeek - avgQualityPrevWeek < -0.3 ? "down"
        : "flat")
      : null;

    const trendArrow = trend === "up" ? "&#8593;" : trend === "down" ? "&#8595;" : "&rarr;";
    const trendColor = trend === "up" ? "#27AE60" : trend === "down" ? "#C0392B" : "#888";
    const trendLabel = trend === "up" ? "improving" : trend === "down" ? "declining" : "steady";

    trendHtml = `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
      <tr>
        <td width="48%" style="background:#faf5f5;border-radius:10px;padding:14px 12px;text-align:center;">
          <div style="font-size:24px;font-weight:700;color:#8B1A1A;line-height:1;">${avgQualityWeek.toFixed(1)}</div>
          <div style="font-size:10px;color:#888;letter-spacing:.08em;text-transform:uppercase;margin-top:4px;">sleep avg / 7 nights</div>
        </td>
        <td width="4%"></td>
        ${trend ? `<td width="48%" style="background:#faf5f5;border-radius:10px;padding:14px 12px;text-align:center;">
          <div style="font-size:24px;font-weight:700;color:${trendColor};line-height:1;">${trendArrow}</div>
          <div style="font-size:10px;color:#888;letter-spacing:.08em;text-transform:uppercase;margin-top:4px;">${trendLabel} vs last week</div>
        </td>` : "<td></td>"}
      </tr>
    </table>`;
  }

  const streakLine = streakCount > 0
    ? `<p style="font-size:14px;color:#888;line-height:1.5;margin:0 0 20px;">${streakCount === 1 ? "You completed 1 night of your experiment so far." : `You've completed <strong>${streakCount} nights</strong> of your experiment. Keep going.`}</p>`
    : `<p style="font-size:16px;color:#444;line-height:1.6;margin:0 0 24px;">Yesterday you committed to:</p>`;

  const body = `
    ${trendHtml}
    ${streakLine}
    <div style="background:#8B1A1A;border-radius:12px;padding:18px 22px;margin-bottom:28px;">
      <div style="font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:rgba(255,255,255,0.55);margin-bottom:6px;">Your experiment</div>
      <div style="font-size:15px;color:#fff;line-height:1.55;font-weight:500;">${actionText}</div>
    </div>
    <p style="font-size:15px;font-weight:600;color:#1a0505;margin:0 0 16px;">Did you do it?</p>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td width="48%" style="padding-right:8px;">
          <a href="${yesUrl}" style="display:block;padding:14px;border-radius:10px;font-size:15px;font-weight:600;text-decoration:none;text-align:center;background:#8B1A1A;color:#fff;">Yes</a>
        </td>
        <td width="4%"></td>
        <td width="48%">
          <a href="${noUrl}" style="display:block;padding:14px;border-radius:10px;font-size:15px;font-weight:600;text-decoration:none;text-align:center;background:transparent;color:#8B1A1A;border:1.5px solid #8B1A1A;">Not yet</a>
        </td>
      </tr>
    </table>
    <p style="font-size:13px;color:#999;line-height:1.6;margin:20px 0 0;text-align:center;">Either way, tonight is a fresh chance &mdash; one small change tonight shows up tomorrow morning.</p>`;

  return emailShell({
    fromEmail,
    subject: `${firstName}, did you do it?`,
    label: "Morning check-in",
    greeting: `Good morning, ${firstName}.`,
    body,
    hero: NIGHTLY_HERO,
  });
}

export async function sendMorningCheckin(opts: {
  to: string;
  firstName: string;
  actionText: string;
  token: string;
  avgQualityWeek?: number | null;
  avgQualityPrevWeek?: number | null;
  streakCount?: number;
}): Promise<boolean> {
  const yesUrl = `${BASE_URL}/api/checkin-link/${opts.token}?did_it=true`;
  const noUrl  = `${BASE_URL}/api/checkin-link/${opts.token}?did_it=false`;

  const conn = await getResendClient();
  if (!conn) {
    console.log("[email] Resend not connected — would send:", { to: opts.to });
    return false;
  }

  const { subject, html, from } = buildCommitmentEmail({
    firstName: opts.firstName,
    actionText: opts.actionText,
    yesUrl,
    noUrl,
    fromEmail: conn.fromEmail,
    avgQualityWeek: opts.avgQualityWeek,
    avgQualityPrevWeek: opts.avgQualityPrevWeek,
    streakCount: opts.streakCount,
  });

  try {
    const { error } = await sendGuarded(conn.client, { from, to: opts.to, subject, html }, { label: "morning check-in" });
    if (error) { console.error("[email] send error:", error); return false; }
    return true;
  } catch (e) {
    console.error("[email] exception:", e);
    return false;
  }
}

// ── 2. Weekly sleep portrait ───────────────────────────────────────────────────
export function buildWeeklyPortraitEmail(opts: {
  firstName: string;
  logs: Array<{ quality: number; log_date: string }>;
  fromEmail: string;
}): { subject: string; html: string; from: string } {
  const { firstName, logs, fromEmail } = opts;

  const sorted = [...logs].sort((a, b) => a.log_date.localeCompare(b.log_date));
  const avg = sorted.reduce((s, l) => s + l.quality, 0) / sorted.length;
  const best  = sorted.reduce((m, l) => l.quality > m.quality ? l : m, sorted[0]);
  const worst = sorted.reduce((m, l) => l.quality < m.quality ? l : m, sorted[0]);

  let opening: string;
  if      (avg >= 4.5) opening = `A restorative week — your sleep quality averaged ${avg.toFixed(1)} out of 5. Keep doing what you're doing.`;
  else if (avg >= 3.5) opening = `A solid week of sleep. Your quality averaged ${avg.toFixed(1)} across the nights you logged.`;
  else if (avg >= 2.5) opening = `A mixed week — ${avg.toFixed(1)} on average. Some good nights and some harder ones.`;
  else                 opening = `A challenging week, with an average quality of ${avg.toFixed(1)}. That's worth exploring with the sleep agent.`;

  const gridCells = sorted.map(l => {
    const d = new Date(l.log_date + "T12:00:00Z");
    const day = DAYS[d.getUTCDay()];
    const bg  = QUALITY_COLORS[l.quality] ?? "#ccc";
    return `<td style="text-align:center;padding:0 3px 0 3px;">
      <div style="width:36px;height:36px;border-radius:8px;background:${bg};display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;color:#fff;">${l.quality}</div>
      <div style="font-size:9px;color:#888;margin-top:4px;letter-spacing:.05em;text-transform:uppercase;">${day}</div>
    </td>`;
  }).join("");

  const grid = `<table cellpadding="0" cellspacing="0" style="margin:16px 0 28px;"><tr>${gridCells}</tr></table>`;

  let observation = "";
  const spread = best.quality - worst.quality;
  if (spread >= 3) {
    observation = `<p style="font-size:15px;color:#444;line-height:1.6;margin:0 0 20px;">
      Your best night was <strong style="color:${QUALITY_COLORS[best.quality]}">${QUALITY_LABELS[best.quality]}</strong> and your roughest was <strong style="color:${QUALITY_COLORS[worst.quality]}">${QUALITY_LABELS[worst.quality]}</strong>. That kind of range often traces back to something specific — light exposure, timing, or stress earlier in the day.
    </p>`;
  } else if (spread <= 1) {
    observation = `<p style="font-size:15px;color:#444;line-height:1.6;margin:0 0 20px;">
      Your sleep quality was remarkably consistent this week. Consistency is one of the strongest signals of good sleep hygiene — worth protecting.
    </p>`;
  } else if (avg < 3) {
    observation = `<p style="font-size:15px;color:#444;line-height:1.6;margin:0 0 20px;">
      Several rough nights in a row compounds — fatigue accumulates and can make the next night harder. Talking this through with the sleep agent is a good place to start.
    </p>`;
  }

  const ctaUrl = `${BASE_URL}/sleep`;
  const body = `
    <p style="font-size:16px;color:#444;line-height:1.6;margin:0 0 16px;">${opening}</p>
    ${grid}
    ${observation}
    <p style="font-size:15px;color:#444;line-height:1.6;margin:0 0 20px;">The sleep agent is grounded in Prof. Zeitzer's published research. Ask it anything based on what you noticed this week &mdash; one small change tonight can show up as a better number tomorrow.</p>
    <a href="${ctaUrl}" style="display:block;padding:14px;border-radius:10px;font-size:15px;font-weight:600;text-decoration:none;text-align:center;background:#8B1A1A;color:#fff;">Improve tonight's sleep</a>`;

  return emailShell({
    fromEmail,
    subject: `${firstName}, your sleep this week`,
    label: "Weekly sleep portrait",
    greeting: `Good morning, ${firstName}.`,
    body,
    hero: NIGHTLY_HERO,
  });
}

export async function sendWeeklyPortrait(opts: {
  to: string;
  firstName: string;
  logs: Array<{ quality: number; log_date: string }>;
}): Promise<boolean> {
  const conn = await getResendClient();
  if (!conn) {
    console.log("[email] Resend not connected — would send weekly portrait to:", opts.to);
    return false;
  }

  const { subject, html, from } = buildWeeklyPortraitEmail({
    firstName: opts.firstName,
    logs: opts.logs,
    fromEmail: conn.fromEmail,
  });

  try {
    const { error } = await sendGuarded(conn.client, { from, to: opts.to, subject, html }, { label: "weekly portrait" });
    if (error) { console.error("[email] weekly portrait send error:", error); return false; }
    return true;
  } catch (e) {
    console.error("[email] weekly portrait exception:", e);
    return false;
  }
}

// ── 3. Reactivation nudge ──────────────────────────────────────────────────────
const NUDGE_QUESTIONS: Record<"low" | "mid" | "high", string[]> = {
  low: [
    "Why am I waking up multiple times through the night?",
    "What causes consistently poor sleep quality in adults over 50?",
    "How does chronic sleep deprivation affect long-term health?",
  ],
  mid: [
    "Why do I feel unrested even after 7 or 8 hours of sleep?",
    "How does evening light exposure affect sleep quality?",
    "What is the ideal sleep schedule for adults over 50?",
  ],
  high: [
    "How can I make my already good sleep even more restorative?",
    "What is the difference between deep sleep and REM, and which matters more?",
    "How do I know if my sleep quality is truly optimal for my age?",
  ],
};

export function buildNudgeEmail(opts: {
  firstName: string;
  avgQuality: number;
  fromEmail: string;
}): { subject: string; html: string; from: string } {
  const { firstName, avgQuality, fromEmail } = opts;

  const bucket = avgQuality < 2.5 ? "low" : avgQuality < 3.5 ? "mid" : "high";
  const questions = NUDGE_QUESTIONS[bucket];
  const question  = questions[Math.floor(Math.random() * questions.length)];
  const qUrl = `${BASE_URL}/sleep?q=${encodeURIComponent(question)}`;

  let opening: string;
  if      (bucket === "low")  opening = `You've had some difficult nights recently. Stanford sleep science has specific things to say about that &mdash; things you can put to work tonight.`;
  else if (bucket === "mid")  opening = `Your sleep has been in a steady range. One well-placed question can unlock a real shift, starting tonight.`;
  else                        opening = `You've been sleeping well. This is actually the ideal time to deepen what's working &mdash; tonight, not someday.`;

  const body = `
    <p style="font-size:16px;color:#444;line-height:1.6;margin:0 0 20px;">${opening}</p>
    <p style="font-size:15px;color:#444;line-height:1.6;margin:0 0 12px;">Here's a question worth exploring, based on your recent sleep data:</p>
    <div style="background:#faf5f5;border-left:3px solid #8B1A1A;border-radius:0 8px 8px 0;padding:16px 20px;margin:0 0 24px;">
      <p style="font-size:16px;color:#1a0505;line-height:1.55;margin:0;font-style:italic;">&ldquo;${question}&rdquo;</p>
    </div>
    <a href="${qUrl}" style="display:block;padding:14px;border-radius:10px;font-size:15px;font-weight:600;text-decoration:none;text-align:center;background:#8B1A1A;color:#fff;margin-bottom:12px;">Explore this question</a>
    <p style="font-size:12px;color:#aaa;text-align:center;margin:0;">Or <a href="${BASE_URL}/sleep" style="color:#8B1A1A;text-decoration:none;">ask your own question</a></p>`;

  return emailShell({
    fromEmail,
    subject: `A thought on your sleep, ${firstName}`,
    label: "Sleep insight",
    greeting: `Good morning, ${firstName}.`,
    body,
    hero: NIGHTLY_HERO,
  });
}

export async function sendNudgeEmail(opts: {
  to: string;
  firstName: string;
  avgQuality: number;
}): Promise<boolean> {
  const conn = await getResendClient();
  if (!conn) {
    console.log("[email] Resend not connected — would send nudge to:", opts.to);
    return false;
  }

  const { subject, html, from } = buildNudgeEmail({
    firstName: opts.firstName,
    avgQuality: opts.avgQuality,
    fromEmail: conn.fromEmail,
  });

  try {
    const { error } = await sendGuarded(conn.client, { from, to: opts.to, subject, html }, { label: "reactivation nudge" });
    if (error) { console.error("[email] nudge send error:", error); return false; }
    return true;
  } catch (e) {
    console.error("[email] nudge exception:", e);
    return false;
  }
}

// ── 4. Weekly coaching loop ─────────────────────────────────────────────────────
// Ties the week's experiment(s) + check-in adherence to the nights the user
// logged, then (when available) a short grounded, cited coaching note generated
// through the governed RAG path. Lifestyle framing only — no medical claims.
export interface WeeklyReflectionEmailNote {
  answer: string;
  finding: string | null;
  citation: string;
  paper: string | null;
}

export interface WeeklyReflectionEmailCommitment {
  actionText: string;
  didCount: number;
  totalCheckins: number;
}

export function buildWeeklyReflectionEmail(opts: {
  firstName: string;
  avgQuality: number | null;
  nightsLogged: number;
  commitments: WeeklyReflectionEmailCommitment[];
  groundedNote: WeeklyReflectionEmailNote | null;
  fromEmail: string;
}): { subject: string; html: string; from: string } {
  const { firstName, avgQuality, nightsLogged, commitments, groundedNote, fromEmail } = opts;

  const statHtml = `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
      <tr>
        <td width="48%" style="background:#faf5f5;border-radius:10px;padding:14px 12px;text-align:center;">
          <div style="font-size:24px;font-weight:700;color:#8B1A1A;line-height:1;">${avgQuality != null ? avgQuality.toFixed(1) : "&ndash;"}</div>
          <div style="font-size:10px;color:#888;letter-spacing:.08em;text-transform:uppercase;margin-top:4px;">sleep avg / 7 nights</div>
        </td>
        <td width="4%"></td>
        <td width="48%" style="background:#faf5f5;border-radius:10px;padding:14px 12px;text-align:center;">
          <div style="font-size:24px;font-weight:700;color:#8B1A1A;line-height:1;">${nightsLogged}</div>
          <div style="font-size:10px;color:#888;letter-spacing:.08em;text-transform:uppercase;margin-top:4px;">nights logged</div>
        </td>
      </tr>
    </table>`;

  const commitmentHtml = commitments.length
    ? commitments
        .slice(0, 3)
        .map(
          (c) => `
    <div style="background:#fbf7f7;border-left:3px solid #8B1A1A;border-radius:0 8px 8px 0;padding:14px 18px;margin:0 0 12px;">
      <div style="font-size:15px;color:#1a0505;line-height:1.5;font-weight:500;">${escapeHtml(c.actionText)}</div>
      <div style="font-size:12px;color:#888;margin-top:6px;">${c.didCount} of ${c.totalCheckins} check-ins done this week</div>
    </div>`,
        )
        .join("")
    : `<p style="font-size:15px;color:#444;line-height:1.6;margin:0 0 20px;">No active experiment this week. Pick one small habit to try tonight &mdash; you can feel the difference as soon as tomorrow morning, and next week we'll connect it to your nights.</p>`;

  const noteHtml = groundedNote
    ? `
    <div style="border-top:1px solid #f0e8e8;margin:24px 0 0;padding-top:24px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#8B1A1A;margin-bottom:10px;">Grounded in Stanford research</div>
      <p style="font-size:16px;color:#1a0505;line-height:1.6;margin:0 0 12px;">${escapeHtml(groundedNote.answer)}</p>
      ${groundedNote.finding ? `<p style="font-size:14px;color:#555;line-height:1.6;margin:0 0 12px;">${escapeHtml(groundedNote.finding)}</p>` : ""}
      <p style="font-size:12px;color:#999;line-height:1.5;margin:0;">${escapeHtml(groundedNote.citation)}${groundedNote.paper ? ` &middot; ${escapeHtml(stripQuotes(groundedNote.paper))}` : ""}</p>
    </div>`
    : "";

  const ctaUrl = `${BASE_URL}/journey`;
  const body = `
    <p style="font-size:16px;color:#444;line-height:1.6;margin:0 0 20px;">Here's how your last seven nights came together.</p>
    ${statHtml}
    <div style="font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#888;margin:0 0 12px;">Your experiments</div>
    ${commitmentHtml}
    ${noteHtml}
    <a href="${ctaUrl}" style="display:block;padding:14px;border-radius:10px;font-size:15px;font-weight:600;text-decoration:none;text-align:center;background:#8B1A1A;color:#fff;margin-top:24px;">See your journey</a>`;

  return emailShell({
    fromEmail,
    subject: `${firstName}, your week in sleep`,
    label: "Weekly check-in",
    greeting: `Good morning, ${firstName}.`,
    body,
    hero: NIGHTLY_HERO,
  });
}

export async function sendWeeklyReflection(opts: {
  to: string;
  firstName: string;
  avgQuality: number | null;
  nightsLogged: number;
  commitments: WeeklyReflectionEmailCommitment[];
  groundedNote: WeeklyReflectionEmailNote | null;
}): Promise<boolean> {
  const conn = await getResendClient();
  if (!conn) {
    console.log("[email] Resend not connected — would send weekly reflection to:", opts.to);
    return false;
  }

  const { subject, html, from } = buildWeeklyReflectionEmail({
    firstName: opts.firstName,
    avgQuality: opts.avgQuality,
    nightsLogged: opts.nightsLogged,
    commitments: opts.commitments,
    groundedNote: opts.groundedNote,
    fromEmail: conn.fromEmail,
  });

  try {
    const { error } = await sendGuarded(conn.client, { from, to: opts.to, subject, html }, { label: "weekly reflection" });
    if (error) { console.error("[email] weekly reflection send error:", error); return false; }
    return true;
  } catch (e) {
    console.error("[email] weekly reflection exception:", e);
    return false;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripQuotes(s: string): string {
  return s.replace(/^["'\u201C\u201D]+|["'\u201C\u201D]+$/g, "");
}
