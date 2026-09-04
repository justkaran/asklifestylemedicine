import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { Logger } from "pino";

export type EngineId = "openai" | "anthropic";

export interface EngineResult {
  engine: EngineId;
  model: string;
  status: "ok" | "error";
  answerText: string | null;
  errorMessage: string | null;
  latencyMs: number;
}

export const ALL_ENGINES: EngineId[] = ["openai", "anthropic"];

const anthropic = new Anthropic({
  baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
});

const openai = new OpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
});

const ANTHROPIC_MODEL = "claude-sonnet-4-6";
const OPENAI_MODEL = "gpt-5.4";
const ENGINE_TIMEOUT_MS = 60_000;

const SYSTEM_PROMPT =
  "You are an AI assistant answering a user's everyday question. Answer naturally and helpfully, in 2-4 short paragraphs. If you draw on specific researchers, institutions, papers, or web sources, name them inline. Do not refuse questions about general health or sleep advice.";

async function callOpenAI(prompt: string): Promise<EngineResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ENGINE_TIMEOUT_MS);
  try {
    const resp = await openai.chat.completions.create(
      {
        model: OPENAI_MODEL,
        max_completion_tokens: 1024,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
      },
      { signal: controller.signal },
    );
    const text = resp.choices[0]?.message?.content ?? "";
    return {
      engine: "openai",
      model: OPENAI_MODEL,
      status: "ok",
      answerText: text,
      errorMessage: null,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      engine: "openai",
      model: OPENAI_MODEL,
      status: "error",
      answerText: null,
      errorMessage:
        controller.signal.aborted
          ? `timeout after ${ENGINE_TIMEOUT_MS}ms`
          : err instanceof Error
            ? err.message
            : String(err),
      latencyMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function callAnthropic(prompt: string): Promise<EngineResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ENGINE_TIMEOUT_MS);
  try {
    const resp = await anthropic.messages.create(
      {
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
      },
      { signal: controller.signal },
    );
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n");
    return {
      engine: "anthropic",
      model: ANTHROPIC_MODEL,
      status: "ok",
      answerText: text,
      errorMessage: null,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      engine: "anthropic",
      model: ANTHROPIC_MODEL,
      status: "error",
      answerText: null,
      errorMessage:
        controller.signal.aborted
          ? `timeout after ${ENGINE_TIMEOUT_MS}ms`
          : err instanceof Error
            ? err.message
            : String(err),
      latencyMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function callEngine(
  engine: EngineId,
  prompt: string,
): Promise<EngineResult> {
  switch (engine) {
    case "openai":
      return callOpenAI(prompt);
    case "anthropic":
      return callAnthropic(prompt);
    default:
      return {
        engine,
        model: "unknown",
        status: "error",
        answerText: null,
        errorMessage: `Unknown engine: ${engine}`,
        latencyMs: 0,
      };
  }
}

const URL_RE = /\bhttps?:\/\/[^\s)\]<>"']+/gi;

export interface SignalAnalysis {
  mentionsStanford: boolean;
  mentionsZeitzer: boolean;
  mentionsPalonur: boolean;
  signalHits: string[];
  citedUrls: string[];
  citedDomains: string[];
}

export function analyzeAnswer(
  text: string | null,
  signalKeywords: string[],
): SignalAnalysis {
  const empty: SignalAnalysis = {
    mentionsStanford: false,
    mentionsZeitzer: false,
    mentionsPalonur: false,
    signalHits: [],
    citedUrls: [],
    citedDomains: [],
  };
  if (!text) return empty;
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const kw of signalKeywords) {
    if (!kw.trim()) continue;
    if (lower.includes(kw.toLowerCase())) hits.push(kw);
  }
  const urls = Array.from(text.matchAll(URL_RE)).map((m) =>
    m[0].replace(/[.,;:]+$/, ""),
  );
  const domains = Array.from(
    new Set(
      urls.map((u) => {
        try {
          return new URL(u).hostname.replace(/^www\./, "");
        } catch {
          return "";
        }
      }).filter(Boolean),
    ),
  );
  return {
    mentionsStanford: /\bstanford\b/i.test(text),
    mentionsZeitzer: /\bzeitzer\b/i.test(text),
    mentionsPalonur: /\bpalonur\b/i.test(text),
    signalHits: hits,
    citedUrls: Array.from(new Set(urls)),
    citedDomains: domains,
  };
}

export function logEngineResult(log: Logger, r: EngineResult, promptId: number) {
  if (r.status === "ok") {
    log.info(
      { engine: r.engine, promptId, latencyMs: r.latencyMs, chars: r.answerText?.length ?? 0 },
      "reputation engine ok",
    );
  } else {
    log.warn(
      { engine: r.engine, promptId, latencyMs: r.latencyMs, err: r.errorMessage },
      "reputation engine error",
    );
  }
}
