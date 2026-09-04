/**
 * "How AI sees you" — steward AI-visibility report engine.
 *
 * Given an expert's name (+aliases) and their pillar topics, this module:
 *   1. generates a small FIXED number of realistic consumer questions,
 *   2. runs each against the leading assistants we have keys for
 *      (Anthropic + OpenAI via the AI Integrations proxy — reuses
 *      reputationEngines.callEngine),
 *   3. detects whether the expert is mentioned (authoritative word-boundary
 *      name/alias match — never trusts the classifier for this),
 *   4. asks one LLM classifier call to summarize how the expert is
 *      characterized and who gets recommended instead.
 *
 * Cost bounds: MAX_QUESTIONS questions x 2 engines answer calls, plus one
 * question-generation call and one classification call per report. Model
 * answers are UNTRUSTED third-party text: they are sanitized and fenced with
 * the standard prompt-injection rules before reaching the classifier, and
 * must never be presented as Palonur answers.
 */
import Anthropic from "@anthropic-ai/sdk";
import { ALL_ENGINES, callEngine, type EngineId } from "./reputationEngines.js";
import {
  sanitizeUntrustedText,
  CONTEXT_FENCE_OPEN,
  CONTEXT_FENCE_CLOSE,
  UNTRUSTED_CONTEXT_RULE,
} from "../lib/rag.js";

export const MAX_QUESTIONS = 5;

const anthropic = new Anthropic({
  baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
});
const CLASSIFIER_MODEL = "claude-sonnet-4-6";

export interface VisibilitySubject {
  /** Full display name. */
  name: string;
  /** Extra match aliases. */
  aliases: string[];
  /** Plain-language topic areas the person is known for. */
  topics: string[];
}

export interface VisibilityEngineAnswer {
  engine: EngineId;
  model: string;
  status: "ok" | "error";
  /** Sanitized answer text (untrusted third-party model output). */
  answerText: string | null;
  errorMessage: string | null;
  /** Authoritative word-boundary name/alias match. */
  mentioned: boolean;
  mentionHits: string[];
  /** LLM-classified (advisory): how the subject is characterized, if at all. */
  characterization: string | null;
  /** LLM-classified: other named people/institutions the answer points to. */
  recommendedInstead: string[];
}

export interface VisibilityQuestionResult {
  question: string;
  engines: VisibilityEngineAnswer[];
}

export interface VisibilityReportSummary {
  /** Answers where the subject was mentioned / total ok answers. */
  mentionedCount: number;
  totalAnswers: number;
  /** Plain-language overall read (LLM-written, advisory). */
  overall: string | null;
  /** Most-recommended other names across all answers. */
  topRecommended: string[];
}

export interface VisibilityReportPayload {
  questions: string[];
  results: VisibilityQuestionResult[];
  summary: VisibilityReportSummary;
}

/** Escape a name for use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary mention detection for the full name, each alias, and — since
 * assistants often say only "Dr. <surname>" — the bare surname when it is
 * reasonably distinctive (>= 4 chars).
 */
export function detectMention(
  text: string | null,
  subject: VisibilitySubject,
): { mentioned: boolean; hits: string[] } {
  if (!text) return { mentioned: false, hits: [] };
  const candidates = new Set<string>([subject.name, ...subject.aliases]);
  const parts = subject.name.trim().split(/\s+/);
  const surname = parts[parts.length - 1];
  if (surname && surname.length >= 4) candidates.add(surname);
  const hits: string[] = [];
  for (const c of candidates) {
    const trimmed = c.trim();
    if (!trimmed) continue;
    const re = new RegExp(`\\b${escapeRe(trimmed)}\\b`, "i");
    if (re.test(text)) hits.push(trimmed);
  }
  return { mentioned: hits.length > 0, hits };
}

/** Deterministic fallback questions when the generator call fails. */
export function fallbackQuestions(topics: string[]): string[] {
  const t = topics.filter((x) => x.trim());
  const first = t[0] ?? "aging well";
  const templates = [
    `What does the research actually say about ${first}?`,
    `Who are the leading experts on ${t[1] ?? first}?`,
    `I'm in my 60s — what should I do about ${t[2] ?? first}?`,
    `Can you recommend a book or expert to follow on ${t[3] ?? first}?`,
    `What's the most common myth about ${t[4] ?? first}?`,
  ];
  return templates.slice(0, MAX_QUESTIONS);
}

/**
 * Generate up to MAX_QUESTIONS realistic consumer questions for the topics.
 * Falls back to templates on any failure — the report must never die here.
 */
export async function generateQuestions(
  subject: VisibilitySubject,
): Promise<string[]> {
  try {
    const resp = await anthropic.messages.create({
      model: CLASSIFIER_MODEL,
      max_tokens: 600,
      messages: [
        {
          role: "user",
          content: `Write exactly ${MAX_QUESTIONS} realistic questions that ordinary consumers (often adults 50+) would type into an AI assistant like ChatGPT about these topics: ${subject.topics.join(
            "; ",
          )}. The questions must be the kind where an expert such as ${subject.name} could plausibly be mentioned or recommended, but NEVER include the expert's name in the question itself. Everyday language, one question per line, no numbering, no extra text.`,
        },
      ],
    });
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n");
    const qs = text
      .split("\n")
      .map((l) => l.replace(/^\s*[-*\d.)\s]+/, "").trim())
      .filter((l) => l.length > 10 && l.includes("?"))
      .slice(0, MAX_QUESTIONS);
    if (qs.length >= 3) return qs;
    return fallbackQuestions(subject.topics);
  } catch {
    return fallbackQuestions(subject.topics);
  }
}

interface ClassifiedAnswer {
  index: number;
  characterization: string | null;
  recommendedInstead: string[];
}

/**
 * One classifier call over ALL collected answers. Answers are sanitized and
 * fenced as untrusted DATA; the classifier returns strict JSON.
 */
async function classifyAnswers(
  subject: VisibilitySubject,
  flat: { index: number; question: string; text: string }[],
): Promise<{
  perAnswer: Map<number, ClassifiedAnswer>;
  overall: string | null;
}> {
  const empty = {
    perAnswer: new Map<number, ClassifiedAnswer>(),
    overall: null,
  };
  if (flat.length === 0) return empty;
  const fenced = flat
    .map(
      (f) =>
        `--- ANSWER ${f.index} (to question: ${sanitizeUntrustedText(f.question)}) ---\n${sanitizeUntrustedText(f.text).slice(0, 4000)}`,
    )
    .join("\n\n");
  try {
    const resp = await anthropic.messages.create({
      model: CLASSIFIER_MODEL,
      max_tokens: 1500,
      system: `You analyze how AI assistants talk about the expert "${subject.name}" (aliases: ${
        subject.aliases.join(", ") || "none"
      }; topics: ${subject.topics.join("; ")}).
Return ONLY strict JSON, no markdown, with this shape:
{"answers":[{"index":<number>,"characterization":<string or null — one short sentence on how ${subject.name} is portrayed IF the answer mentions them, else null>,"recommendedInstead":[<other named experts, authors, or institutions this answer points people to; empty array if none>]}],"overall":"<2-3 plain-language sentences: is ${subject.name} visible in these AI answers, how are they characterized, and who currently owns this topic in AI answers instead>"}

${UNTRUSTED_CONTEXT_RULE}`,
      messages: [
        {
          role: "user",
          content: `${CONTEXT_FENCE_OPEN}\n${fenced}\n${CONTEXT_FENCE_CLOSE}`,
        },
      ],
    });
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    const parsed = JSON.parse(text) as {
      answers?: {
        index?: number;
        characterization?: string | null;
        recommendedInstead?: string[];
      }[];
      overall?: string;
    };
    const perAnswer = new Map<number, ClassifiedAnswer>();
    for (const a of parsed.answers ?? []) {
      if (typeof a.index !== "number") continue;
      perAnswer.set(a.index, {
        index: a.index,
        characterization:
          typeof a.characterization === "string" && a.characterization.trim()
            ? a.characterization.trim().slice(0, 400)
            : null,
        recommendedInstead: Array.isArray(a.recommendedInstead)
          ? a.recommendedInstead
              .filter((r): r is string => typeof r === "string")
              .map((r) => r.trim().slice(0, 120))
              .filter(Boolean)
              .slice(0, 8)
          : [],
      });
    }
    return {
      perAnswer,
      overall:
        typeof parsed.overall === "string" && parsed.overall.trim()
          ? parsed.overall.trim().slice(0, 1200)
          : null,
    };
  } catch {
    return empty;
  }
}

/**
 * Run the full report. Never throws for individual engine failures — those
 * become per-answer error rows; throws only if literally nothing could run.
 */
export async function runVisibilityReport(
  subject: VisibilitySubject,
): Promise<VisibilityReportPayload> {
  const questions = await generateQuestions(subject);

  const results: VisibilityQuestionResult[] = [];
  // Flat index across (question, engine) pairs for the classifier.
  const flat: { index: number; question: string; text: string }[] = [];
  let flatIndex = 0;

  for (const question of questions) {
    const engineResults = await Promise.all(
      ALL_ENGINES.map((e) => callEngine(e, question)),
    );
    const engines: VisibilityEngineAnswer[] = engineResults.map((r) => {
      const sanitized = r.answerText
        ? sanitizeUntrustedText(r.answerText)
        : null;
      const mention = detectMention(sanitized, subject);
      const idx = flatIndex++;
      if (r.status === "ok" && sanitized) {
        flat.push({ index: idx, question, text: sanitized });
      }
      return {
        engine: r.engine,
        model: r.model,
        status: r.status,
        answerText: sanitized,
        errorMessage: r.errorMessage,
        mentioned: mention.mentioned,
        mentionHits: mention.hits,
        characterization: null,
        recommendedInstead: [],
      };
    });
    results.push({ question, engines });
  }

  if (flat.length === 0) {
    throw new Error("No AI assistant answers could be collected");
  }

  const { perAnswer, overall } = await classifyAnswers(subject, flat);
  // Re-attach classifier output by flat index (walk in the same order).
  let walk = 0;
  for (const qr of results) {
    for (const ea of qr.engines) {
      const c = perAnswer.get(walk);
      walk++;
      if (!c) continue;
      // The regex match is authoritative for "mentioned"; the classifier only
      // supplies characterization when a mention actually exists.
      ea.characterization = ea.mentioned ? c.characterization : null;
      ea.recommendedInstead = c.recommendedInstead;
    }
  }

  const okAnswers = results
    .flatMap((r) => r.engines)
    .filter((e) => e.status === "ok");
  const mentionedCount = okAnswers.filter((e) => e.mentioned).length;
  const counts = new Map<string, number>();
  for (const e of okAnswers) {
    for (const name of e.recommendedInstead) {
      const key = name.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  // Keep the display casing of the first occurrence.
  const firstCase = new Map<string, string>();
  for (const e of okAnswers)
    for (const name of e.recommendedInstead)
      if (!firstCase.has(name.toLowerCase()))
        firstCase.set(name.toLowerCase(), name);
  const topRecommended = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k]) => firstCase.get(k)!)
    // Never list the subject themselves as "recommended instead".
    .filter((n) => !detectMention(n, subject).mentioned);

  return {
    questions,
    results,
    summary: {
      mentionedCount,
      totalAnswers: okAnswers.length,
      overall,
      topRecommended,
    },
  };
}
