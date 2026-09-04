/**
 * POST /api/tts  { text: string }
 *
 * Text-to-speech via ElevenLabs. Returns audio/mpeg.
 *
 * Voice: the warm stock expert voice.
 *
 * POST /api/tts/minicast  { question, sections: { answer?, finding?, action? } }
 *
 * Produces a "Nightly" two-voice podcast episode from a parsed answer.
 * Fixed 10-turn structure — hook → conversation (male host / female expert)
 * → outro. Music (5s entry + 30s outro) is layered entirely client-side from
 * the static theme track /sounds/minicast-theme.mp3; the server sends voice
 * segments only. Missing sections get brief, natural-sounding fallbacks.
 *
 * ElevenLabs credentials come from the Replit connector (never a hard-coded key).
 */
import { createHash } from "node:crypto";
import { Router } from "express";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { MinicastTtsBody } from "@workspace/api-zod";

const router = Router();

/**
 * Short-lived in-memory cache of produced minicast episodes so a listener
 * who leaves an answer page and returns (or reloads) replays the same
 * episode without re-calling ElevenLabs. Bounded: LRU with a small max
 * entry count and a TTL, since each episode carries base64 audio.
 */
interface CachedEpisode {
  segments: Array<{ role: string; label: string; audio: string }>;
  at: number;
}

const EPISODE_CACHE_MAX = 8;
const EPISODE_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

const episodeCache = new Map<string, CachedEpisode>();

function episodeCacheKey(
  question: string,
  sections: { answer?: string; finding?: string; action?: string },
  show: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        q: question.trim(),
        a: sections.answer ?? "",
        f: sections.finding ?? "",
        c: sections.action ?? "",
        show,
      }),
    )
    .digest("hex");
}

function getCachedEpisode(key: string): CachedEpisode["segments"] | null {
  const entry = episodeCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > EPISODE_CACHE_TTL_MS) {
    episodeCache.delete(key);
    return null;
  }
  // Refresh LRU position.
  episodeCache.delete(key);
  episodeCache.set(key, entry);
  return entry.segments;
}

function setCachedEpisode(key: string, segments: CachedEpisode["segments"]) {
  episodeCache.delete(key);
  episodeCache.set(key, { segments, at: Date.now() });
  while (episodeCache.size > EPISODE_CACHE_MAX) {
    const oldest = episodeCache.keys().next().value;
    if (oldest === undefined) break;
    episodeCache.delete(oldest);
  }
}

/** Female expert stock voice for the Nightly podcast. */
const FALLBACK_EXPERT_VOICE_ID = "S8fvCTNkUyToiumExm4N";

/** George — warm, conversational British male stock voice for the host. */
const FALLBACK_HOST_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";

/**
 * The "Nightly" answer voice — the expert avatar that delivers the answer.
 * HOST voice remains the George British stock voice (or HOST_ELEVENLABS_VOICE_ID when set).
 */
const NIGHTLY_EXPERT_VOICE_ID = "S8fvCTNkUyToiumExm4N";

/**
 * Set to true after the first voice_not_found so later turns (and later
 * episodes) go straight to the fallback voice instead of burning a doomed
 * ElevenLabs call per expert turn.
 */
let expertVoiceUnavailable = false;

const connectors = new ReplitConnectors();

/**
 * Per-IP daily allowance for the plain /tts (Listen) endpoint. Every call
 * costs ElevenLabs credits and the endpoint is otherwise unauthenticated,
 * so a script could drain the quota. Keyed on req.ip (trust proxy = 1 is
 * set app-wide — never parse client-supplied headers). In-memory per-UTC-day
 * counters, same pattern as the slm-agent anonymous free-question allowance.
 */
const TTS_DAILY_IP_LIMIT = Math.max(
  1,
  Number.parseInt(process.env.TTS_DAILY_IP_LIMIT ?? "", 10) || 40,
);

/** Hard cap on a single synthesis request — the Listen button sends one
 * answer at a time, which is well under this. Rejecting oversized bodies
 * bounds the credit cost of any single request. */
const TTS_MAX_TEXT_LENGTH = 5000;

/** Bound on tracked IPs: beyond this, deny new callers (fail closed)
 * rather than growing memory without limit. */
const TTS_BUDGET_MAX_KEYS = 20_000;

const ttsDailyHits = new Map<string, { day: string; count: number }>();

function takeTtsAllowance(ip: string): boolean {
  const day = new Date().toISOString().slice(0, 10);
  if (ttsDailyHits.size >= TTS_BUDGET_MAX_KEYS) {
    for (const [k, v] of ttsDailyHits) {
      if (v.day !== day) ttsDailyHits.delete(k);
    }
    if (ttsDailyHits.size >= TTS_BUDGET_MAX_KEYS && !ttsDailyHits.has(ip)) {
      return false;
    }
  }
  const rec = ttsDailyHits.get(ip);
  const count = rec && rec.day === day ? rec.count : 0;
  if (count >= TTS_DAILY_IP_LIMIT) return false;
  ttsDailyHits.set(ip, { day, count: count + 1 });
  return true;
}

/**
 * Per-IP daily allowance for /tts/minicast. Each episode costs ~10 ElevenLabs
 * calls (about 10x a plain /tts request), so the limit is much lower than the
 * Listen budget. Same in-memory per-UTC-day counter pattern as
 * takeTtsAllowance; keyed on req.ip (trust proxy = 1 — never client headers).
 * Cache hits do NOT spend the allowance.
 */
const MINICAST_DAILY_IP_LIMIT = Math.max(
  1,
  Number.parseInt(process.env.MINICAST_DAILY_IP_LIMIT ?? "", 10) || 4,
);

const minicastDailyHits = new Map<string, { day: string; count: number }>();

function takeMinicastAllowance(ip: string): boolean {
  const day = new Date().toISOString().slice(0, 10);
  if (minicastDailyHits.size >= TTS_BUDGET_MAX_KEYS) {
    for (const [k, v] of minicastDailyHits) {
      if (v.day !== day) minicastDailyHits.delete(k);
    }
    if (
      minicastDailyHits.size >= TTS_BUDGET_MAX_KEYS &&
      !minicastDailyHits.has(ip)
    ) {
      return false;
    }
  }
  const rec = minicastDailyHits.get(ip);
  const count = rec && rec.day === day ? rec.count : 0;
  if (count >= MINICAST_DAILY_IP_LIMIT) return false;
  minicastDailyHits.set(ip, { day, count: count + 1 });
  return true;
}

/** Call ElevenLabs and return the audio as a Buffer. Retries on 429. */
async function synthesize(voiceId: string, text: string): Promise<Buffer> {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; ; attempt++) {
    const elResponse = await connectors.proxy(
      "elevenlabs",
      `/v1/text-to-speech/${voiceId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: text.trim(),
          model_id: "eleven_multilingual_v2",
          voice_settings: {
            stability: 0.35,
            similarity_boost: 0.8,
            style: 0.45,
            use_speaker_boost: true,
          },
        }),
      },
    );

    if (elResponse.ok) {
      const ab = await elResponse.arrayBuffer();
      return Buffer.from(ab);
    }

    const err = await elResponse.text();
    // The plan allows only a few concurrent requests — back off and retry.
    if (elResponse.status === 429 && attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 800 * attempt));
      continue;
    }
    throw Object.assign(new Error("ElevenLabs TTS error"), {
      status: elResponse.status,
      detail: err,
    });
  }
}

/**
 * Run tasks with a bounded concurrency pool. ElevenLabs subscriptions cap
 * concurrent requests (currently 3), so the 10-turn episode is synthesised
 * a few turns at a time instead of all at once.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

interface DialogueTurn {
  role: "host" | "expert";
  label:
    | "hook"
    | "welcome"
    | "answer"
    | "reaction"
    | "action"
    | "bridge"
    | "finding"
    | "takeaway"
    | "closing"
    | "outro";
  text: string;
}

type EpisodeLang = "en" | "de";

/**
 * Common German function words. Deliberately excludes the strongest
 * English homographs ("am", "man", "hat") so an English answer can't
 * accidentally score German; the remaining overlaps ("die", "was", "es")
 * are harmless in aggregate because the ratio threshold is well above
 * what English text produces.
 */
const GERMAN_STOPWORDS = new Set([
  "und",
  "nicht",
  "das",
  "der",
  "die",
  "ist",
  "ich",
  "mit",
  "für",
  "auf",
  "ein",
  "eine",
  "einen",
  "einem",
  "einer",
  "wie",
  "was",
  "dass",
  "auch",
  "wenn",
  "oder",
  "aber",
  "sind",
  "wird",
  "werden",
  "kann",
  "können",
  "sich",
  "nach",
  "bei",
  "zum",
  "zur",
  "über",
  "mehr",
  "sehr",
  "dann",
  "noch",
  "nur",
  "schon",
  "gegen",
  "durch",
  "vor",
  "aus",
  "mir",
  "mich",
  "ihre",
  "ihr",
  "sein",
  "seine",
  "haben",
  "habe",
  "es",
  "im",
  "um",
  "zu",
  "dem",
  "den",
  "des",
  "sie",
  "wir",
  "uns",
  "diese",
  "dieser",
]);

/**
 * Detect whether the episode content is German or English so the entire
 * podcast script (host lines, transitions, fallbacks) can be produced in
 * ONE language. The answer sections dominate the spoken episode, so the
 * detection runs over the sections plus the question. Heuristic: ratio of
 * German stopwords + umlaut/ß words to total words. German prose scores
 * far above 0.15 with this list; English prose stays in low single digits.
 */
function detectEpisodeLang(
  question: string,
  sections: { answer?: string; finding?: string; action?: string },
): EpisodeLang {
  const sample = [sections.answer, sections.finding, sections.action, question]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const words = sample.match(/[a-zäöüß]+/g) ?? [];
  if (words.length === 0) return "en";
  let score = 0;
  for (const w of words) {
    if (GERMAN_STOPWORDS.has(w)) score += 1;
    else if (/[äöüß]/.test(w)) score += 2;
  }
  return score / words.length >= 0.15 ? "de" : "en";
}

/**
 * Build the fixed 10-turn Palonur episode script from the answer sections.
 *
 * The script adapts its language to the actual question, topic, and expert
 * supplied by the caller. No topic is assumed — pillar and expert are optional
 * and the script degrades gracefully when absent.
 *
 * Structure (always in this order):
 *   host hook      — opens with the listener's question, spoken over the music entry
 *   host welcome   — show intro + Palonur production credit, then poses the
 *                    listener's exact question to the expert
 *   expert answer  — the core answer
 *   host reaction  — natural reaction + practical follow-up question
 *   expert action  — what to actually do (fallback when absent)
 *   host bridge    — bridges to the science
 *   expert finding — the interesting research finding
 *   host takeaway  — one-line summary of the episode
 *   expert closing — warm expert sign-off thought
 *   host outro     — closes the show, leads into the outro music
 */
function buildDialogueScript(
  question: string,
  sections: { answer?: string; finding?: string; action?: string },
  pillar?: string,
  expert?: string,
  lang: EpisodeLang = "en",
): DialogueTurn[] {
  const questionTrimmed = question.trim().replace(/\?+$/, "");

  // When no pillar or expert is supplied this is a plain Nightly sleep episode
  // and must keep the original Nightly branding so the test contract holds.
  const isNightlyShow = !pillar && !expert;

  if (lang === "de") {
    return buildGermanDialogueScript(
      questionTrimmed,
      sections,
      pillar,
      expert,
      isNightlyShow,
    );
  }

  const answerText =
    sections.answer?.trim() ||
    "The research points to a few key strategies worth knowing, and they're simpler than most people expect.";

  const actionText =
    sections.action?.trim() ||
    "The most important thing is to start small and stay consistent. Pick one change, hold onto it for a full week, and build from there. That's how real progress happens.";

  const findingText =
    sections.finding?.trim() ||
    "What's interesting is that the science here is still evolving, but the fundamentals are remarkably well supported across studies.";

  const isNightly = isNightlyShow;

  // Build host address for the expert: use name when provided, else "our expert".
  const expertAddress = expert ? (expert.split(" ").pop() ?? expert) : null;
  const expertIntro = expert
    ? `${expert} is here with me as our ${pillar ? `${pillar} expert` : "expert"}`
    : `I have our ${pillar ? `${pillar} expert` : "expert"} here with me`;

  // Topic phrase for the welcome line.
  const topicPhrase = pillar
    ? `short conversations backed by leading scientists, today focusing on ${pillar}`
    : "short conversations backed by leading scientists";

  // Closing thought is topical when pillar is present.
  const closingThought = pillar
    ? `The science of ${pillar.toLowerCase()} keeps moving forward, and small, consistent choices really do compound over time.`
    : "Small, consistent choices really do compound over time.";

  if (isNightly) {
    return [
      {
        role: "host",
        label: "hook",
        text: `Tonight a listener wants to know: ${questionTrimmed}? Stay with us — the answer might change how you think about this.`,
      },
      {
        role: "host",
        label: "welcome",
        text: `Welcome to Pal — short sleep science conversations backed by leading researchers. This episode is produced by Palonur, where you get vetted answers from scientists. I have our sleep expert here with me, so let me put our listener's exact question to you: ${questionTrimmed}?`,
      },
      {
        role: "expert",
        label: "answer",
        text: `That's such a good question. ${answerText}`,
      },
      {
        role: "host",
        label: "reaction",
        text: "Okay — that makes a lot of sense. But let's make it practical. For someone dealing with this tonight — what should they actually do?",
      },
      {
        role: "expert",
        label: "action",
        text: actionText,
      },
      {
        role: "host",
        label: "bridge",
        text: "I love that — simple, doable, no magic involved. Now before we wrap up, give us the science. What did the research actually find here?",
      },
      {
        role: "expert",
        label: "finding",
        text: `Here's the part I find fascinating. ${findingText}`,
      },
      {
        role: "host",
        label: "takeaway",
        text: "So there it is — one question, one clear answer, backed by actual research. That's exactly what this show is for.",
      },
      {
        role: "expert",
        label: "closing",
        text: "Sleep well tonight. Small, consistent choices really do compound over time.",
      },
      {
        role: "host",
        label: "outro",
        text: `That's tonight's episode from Palonur. If it helped, pass it along to someone who could use it. Until next time.`,
      },
    ];
  }

  return [
    {
      role: "host",
      label: "hook",
      text: `Today a listener wants to know: ${questionTrimmed}? Stay with us — the answer might change how you think about this.`,
    },
    {
      role: "host",
      label: "welcome",
      text: `Welcome to Palonur — ${topicPhrase}. This episode is produced by Palonur, where you get vetted answers from scientists. ${expertIntro}, so let me put our listener's exact question to you${expertAddress ? `, ${expertAddress}` : ""}: ${questionTrimmed}?`,
    },
    {
      role: "expert",
      label: "answer",
      text: `That's such a good question. ${answerText}`,
    },
    {
      role: "host",
      label: "reaction",
      text: "Okay — that makes a lot of sense. But let's make it practical. For someone dealing with this today — what should they actually do?",
    },
    {
      role: "expert",
      label: "action",
      text: actionText,
    },
    {
      role: "host",
      label: "bridge",
      text: "I love that — simple, doable, no magic involved. Now before we wrap up, give us the science. What did the research actually find here?",
    },
    {
      role: "expert",
      label: "finding",
      text: `Here's the part I find fascinating. ${findingText}`,
    },
    {
      role: "host",
      label: "takeaway",
      text: "So there it is — one question, one clear answer, backed by actual research. That's exactly what this show is for.",
    },
    {
      role: "expert",
      label: "closing",
      text: closingThought,
    },
    {
      role: "host",
      label: "outro",
      text: `That's today's episode from Palonur. If it helped, pass it along to someone who could use it. Until next time.`,
    },
  ];
}

/**
 * German mirror of buildDialogueScript — same fixed 10-turn structure, same
 * branding (Nightly / Palonur stay untranslated), every host line and
 * missing-section fallback in German so a German answer never yields a
 * mixed-language episode.
 */
function buildGermanDialogueScript(
  questionTrimmed: string,
  sections: { answer?: string; finding?: string; action?: string },
  pillar: string | undefined,
  expert: string | undefined,
  isNightly: boolean,
): DialogueTurn[] {
  const answerText =
    sections.answer?.trim() ||
    "Die Forschung zeigt einige zentrale Strategien, die man kennen sollte, und sie sind einfacher, als die meisten erwarten.";

  const actionText =
    sections.action?.trim() ||
    "Am wichtigsten ist, klein anzufangen und dranzubleiben. Wählen Sie eine Veränderung, halten Sie sie eine volle Woche durch, und bauen Sie darauf auf. So entsteht echter Fortschritt.";

  const findingText =
    sections.finding?.trim() ||
    "Interessant ist, dass die Wissenschaft hier noch in Bewegung ist, aber die Grundlagen sind über viele Studien hinweg bemerkenswert gut belegt.";

  const expertAddress = expert ? (expert.split(" ").pop() ?? expert) : null;
  const expertIntro = expert
    ? `${expert} ist ${pillar ? `als unser Experte für ${pillar}` : "als unser Experte"} bei mir`
    : `unser Experte ${pillar ? `für ${pillar} ` : ""}ist bei mir`;

  const topicPhrase = pillar
    ? `kurze Gespräche, gestützt auf führende Wissenschaftler, heute zum Thema ${pillar}`
    : "kurze Gespräche, gestützt auf führende Wissenschaftler";

  const closingThought = pillar
    ? `Die Forschung zu ${pillar} entwickelt sich ständig weiter, und kleine, beständige Entscheidungen summieren sich wirklich mit der Zeit.`
    : "Kleine, beständige Entscheidungen summieren sich wirklich mit der Zeit.";

  if (isNightly) {
    return [
      {
        role: "host",
        label: "hook",
        text: `Heute Nacht möchte ein Hörer wissen: ${questionTrimmed}? Bleiben Sie dran, die Antwort könnte Ihre Sicht darauf verändern.`,
      },
      {
        role: "host",
        label: "welcome",
        text: `Willkommen bei Pal, kurze Gespräche über Schlafforschung, gestützt auf führende Wissenschaftler. Diese Folge wird von Palonur produziert, wo Sie geprüfte Antworten von Wissenschaftlern bekommen. Unser Schlafexperte ist bei mir, also stelle ich Ihnen die Frage unseres Hörers direkt: ${questionTrimmed}?`,
      },
      {
        role: "expert",
        label: "answer",
        text: `Das ist eine wirklich gute Frage. ${answerText}`,
      },
      {
        role: "host",
        label: "reaction",
        text: "Okay, das leuchtet ein. Aber machen wir es praktisch. Was sollte jemand, der heute Nacht damit zu tun hat, konkret tun?",
      },
      {
        role: "expert",
        label: "action",
        text: actionText,
      },
      {
        role: "host",
        label: "bridge",
        text: "Das gefällt mir, einfach und machbar, ganz ohne Zauberei. Bevor wir zum Ende kommen, geben Sie uns noch die Wissenschaft. Was hat die Forschung hier tatsächlich herausgefunden?",
      },
      {
        role: "expert",
        label: "finding",
        text: `Hier kommt der Teil, den ich faszinierend finde. ${findingText}`,
      },
      {
        role: "host",
        label: "takeaway",
        text: "Da haben wir es: eine Frage, eine klare Antwort, gestützt auf echte Forschung. Genau dafür gibt es diese Sendung.",
      },
      {
        role: "expert",
        label: "closing",
        text: "Schlafen Sie gut heute Nacht. Kleine, beständige Entscheidungen summieren sich wirklich mit der Zeit.",
      },
      {
        role: "host",
        label: "outro",
        text: "Das war die heutige Folge von Palonur. Wenn sie geholfen hat, geben Sie sie an jemanden weiter, der sie gebrauchen kann. Bis zum nächsten Mal.",
      },
    ];
  }

  return [
    {
      role: "host",
      label: "hook",
      text: `Heute möchte ein Hörer wissen: ${questionTrimmed}? Bleiben Sie dran, die Antwort könnte Ihre Sicht darauf verändern.`,
    },
    {
      role: "host",
      label: "welcome",
      text: `Willkommen bei Palonur, ${topicPhrase}. Diese Folge wird von Palonur produziert, wo Sie geprüfte Antworten von Wissenschaftlern bekommen. ${expertIntro.charAt(0).toUpperCase()}${expertIntro.slice(1)}, also stelle ich Ihnen die Frage unseres Hörers direkt${expertAddress ? `, ${expertAddress}` : ""}: ${questionTrimmed}?`,
    },
    {
      role: "expert",
      label: "answer",
      text: `Das ist eine wirklich gute Frage. ${answerText}`,
    },
    {
      role: "host",
      label: "reaction",
      text: "Okay, das leuchtet ein. Aber machen wir es praktisch. Was sollte jemand, der heute damit zu tun hat, konkret tun?",
    },
    {
      role: "expert",
      label: "action",
      text: actionText,
    },
    {
      role: "host",
      label: "bridge",
      text: "Das gefällt mir, einfach und machbar, ganz ohne Zauberei. Bevor wir zum Ende kommen, geben Sie uns noch die Wissenschaft. Was hat die Forschung hier tatsächlich herausgefunden?",
    },
    {
      role: "expert",
      label: "finding",
      text: `Hier kommt der Teil, den ich faszinierend finde. ${findingText}`,
    },
    {
      role: "host",
      label: "takeaway",
      text: "Da haben wir es: eine Frage, eine klare Antwort, gestützt auf echte Forschung. Genau dafür gibt es diese Sendung.",
    },
    {
      role: "expert",
      label: "closing",
      text: closingThought,
    },
    {
      role: "host",
      label: "outro",
      text: "Das war die heutige Folge von Palonur. Wenn sie geholfen hat, geben Sie sie an jemanden weiter, der sie gebrauchen kann. Bis zum nächsten Mal.",
    },
  ];
}

router.post("/tts", async (req, res) => {
  const { text } = req.body as { text?: string };
  if (!text || typeof text !== "string" || text.trim().length === 0) {
    res.status(400).json({ error: "text is required" });
    return;
  }

  if (text.length > TTS_MAX_TEXT_LENGTH) {
    res.status(413).json({ error: "Text is too long to read aloud" });
    return;
  }

  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (!takeTtsAllowance(ip)) {
    res.status(429).json({
      error: "Daily listen limit reached. Please try again tomorrow.",
    });
    return;
  }

  const voiceId = FALLBACK_EXPERT_VOICE_ID;

  try {
    const buf = await synthesize(voiceId, text.trim());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.send(buf);
  } catch (err) {
    req.log.error({ err }, "TTS route error");
    res.status(502).json({ error: "TTS service error" });
  }
});

router.post("/tts/minicast", async (req, res) => {
  const parsed = MinicastTtsBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Invalid request", issues: parsed.error.issues });
    return;
  }

  const { question, sections, show, pillar, expert } = parsed.data;

  if (!sections.answer && !sections.finding && !sections.action) {
    res.status(400).json({ error: "At least one answer section is required" });
    return;
  }

  const cacheKey = episodeCacheKey(question, sections, show ?? "nightly");
  const cachedSegments = getCachedEpisode(cacheKey);
  if (cachedSegments) {
    req.log.info(
      { question: question.slice(0, 80), show: show ?? "nightly" },
      "minicast cache hit",
    );
    res.json({ segments: cachedSegments });
    return;
  }

  // Producing a fresh episode spends the per-IP daily allowance. Checked
  // AFTER the cache lookup so replays of an already-produced episode stay
  // free — only requests that would actually call ElevenLabs count.
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (!takeMinicastAllowance(ip)) {
    res.status(429).json({
      error: "Daily episode limit reached. Please try again tomorrow.",
    });
    return;
  }

  const hostVoiceId =
    process.env.HOST_ELEVENLABS_VOICE_ID ?? FALLBACK_HOST_VOICE_ID;
  const expertVoiceId = NIGHTLY_EXPERT_VOICE_ID;

  // The whole episode is produced in ONE language: the language of the
  // answer content. German answer sections get German host lines and
  // fallbacks; anything else stays fully English.
  const lang = detectEpisodeLang(question, sections);

  const script = buildDialogueScript(
    question,
    sections,
    pillar ?? undefined,
    expert ?? undefined,
    lang,
  );

  const t0 = Date.now();
  req.log.info(
    { question: question.slice(0, 80), show: show ?? "nightly", lang },
    "minicast start",
  );

  try {
    const audioBuffers = await mapWithConcurrency(script, 2, async (turn) => {
      if (turn.role === "host") return synthesize(hostVoiceId, turn.text);
      const unavailable = expertVoiceUnavailable;
      if (unavailable || expertVoiceId === FALLBACK_EXPERT_VOICE_ID) {
        return synthesize(FALLBACK_EXPERT_VOICE_ID, turn.text);
      }
      try {
        return await synthesize(expertVoiceId, turn.text);
      } catch (err) {
        // The expert voice may not be available on the connected ElevenLabs
        // account — degrade to the stock expert voice rather than failing
        // the whole episode, and remember the outcome.
        if ((err as { status?: number }).status === 404) {
          expertVoiceUnavailable = true;
          req.log.warn(
            { voiceId: expertVoiceId, show: show ?? "nightly" },
            "expert voice not found on this ElevenLabs account — using fallback voice",
          );
          return synthesize(FALLBACK_EXPERT_VOICE_ID, turn.text);
        }
        throw err;
      }
    });

    const segments = script.map((turn, i) => ({
      role: turn.role,
      label: turn.label,
      audio: audioBuffers[i].toString("base64"),
    }));

    req.log.info(
      { ms: Date.now() - t0, count: segments.length },
      "minicast done",
    );

    setCachedEpisode(cacheKey, segments);
    res.json({ segments });
  } catch (err) {
    const e = err as Error & { status?: number; detail?: string };
    req.log.error(
      { err: e.message, detail: e.detail, status: e.status },
      "minicast ElevenLabs error",
    );
    res.status(502).json({ error: "ElevenLabs unavailable" });
  }
});

export default router;
