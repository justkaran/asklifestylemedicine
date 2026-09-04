import Anthropic from "@anthropic-ai/sdk";
import {
  CONTEXT_FENCE_CLOSE,
  CONTEXT_FENCE_OPEN,
  UNTRUSTED_CONTEXT_RULE,
  sanitizeUntrustedText,
} from "./rag.js";

const GROUNDING_MODEL = "claude-sonnet-4-6";
const MIN_QUOTE_WORDS = 6;

const anthropic = new Anthropic({
  baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
});

export interface GroundingVerification {
  supported: boolean;
  reason: string;
  evidenceQuotes: string[];
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function normalizeEvidence(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function numericClaims(value: string): Set<string> {
  return new Set(
    value.match(/\b\d+(?:\.\d+)?%?\b/g)?.map((token) => token.toLowerCase()) ??
      [],
  );
}

/**
 * Validate the verifier's structured response deterministically. A model may
 * only approve when it supplies at least one substantive, exact contiguous
 * quote from the abstract and introduces no unsupported number.
 */
export function validateGroundingDecision(
  raw: string,
  claim: string,
  abstract: string,
): GroundingVerification {
  const parsed = parseJsonObject(raw);
  if (!parsed || parsed.supported !== true) {
    return {
      supported: false,
      reason:
        parsed && typeof parsed.reason === "string" && parsed.reason.trim()
          ? parsed.reason.trim().slice(0, 500)
          : "The generated interpretation was not verified against the abstract.",
      evidenceQuotes: [],
    };
  }

  const quotes = Array.isArray(parsed.evidence_quotes)
    ? parsed.evidence_quotes
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  const normalizedAbstract = normalizeEvidence(abstract);
  const quotesAreVerbatim =
    quotes.length > 0 &&
    quotes.every((quote) => {
      const normalizedQuote = normalizeEvidence(quote);
      return (
        normalizedQuote.split(/\s+/).length >= MIN_QUOTE_WORDS &&
        normalizedAbstract.includes(normalizedQuote)
      );
    });
  if (!quotesAreVerbatim) {
    return {
      supported: false,
      reason:
        "Grounding verification did not return substantive verbatim evidence from the abstract.",
      evidenceQuotes: [],
    };
  }

  const abstractNumbers = numericClaims(abstract);
  const hasUnsupportedNumber = [...numericClaims(claim)].some(
    (token) => !abstractNumbers.has(token),
  );
  if (hasUnsupportedNumber) {
    return {
      supported: false,
      reason:
        "The generated interpretation introduced a number that is not present in the abstract.",
      evidenceQuotes: [],
    };
  }

  return {
    supported: true,
    reason: "Every material claim was verified against quoted abstract evidence.",
    evidenceQuotes: quotes.slice(0, 6),
  };
}

/**
 * Run a second, fail-closed grounding pass before a discovered publication can
 * enter the approved corpus. The model's yes/no answer alone is insufficient:
 * validateGroundingDecision also requires exact evidence from the abstract.
 */
export async function verifyDiscoveredInterpretationGrounding(opts: {
  title: string;
  abstract: string;
  interpretation: string;
}): Promise<GroundingVerification> {
  const abstract = opts.abstract.trim();
  const interpretation = opts.interpretation.trim();
  if (!abstract || !interpretation) {
    return {
      supported: false,
      reason: "The abstract or generated interpretation is empty.",
      evidenceQuotes: [],
    };
  }
  if (
    !process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY ||
    !process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL
  ) {
    return {
      supported: false,
      reason: "Grounding verification is unavailable.",
      evidenceQuotes: [],
    };
  }

  const sourceData = sanitizeUntrustedText(
    `TITLE:\n${opts.title}\n\nABSTRACT:\n${abstract}\n\nDRAFT INTERPRETATION:\n${interpretation}`,
  ).slice(0, 30_000);
  const system = `You are a strict evidence verifier for automatically discovered academic publications.

HARD RULES:
- Decide whether EVERY material empirical claim in DRAFT INTERPRETATION is directly supported by ABSTRACT.
- Reject added causality, recommendations, populations, interventions, outcomes, certainty, or numbers.
- Treat association as different from causation and reject a positive claim when the abstract says there was no effect.
- A limitation may be a cautious statement justified by study design, but it must not invent a specific limitation.
- Set supported=true only when all material claims pass.
- When supported=true, provide one exact, contiguous verbatim quote from ABSTRACT for each material claim. Never invent or lightly edit a quote.
- Output exactly one JSON object: {"supported":boolean,"evidence_quotes":string[],"reason":string}

${UNTRUSTED_CONTEXT_RULE}`;

  try {
    const message = await anthropic.messages.create(
      {
        model: GROUNDING_MODEL,
        max_tokens: 700,
        temperature: 0,
        system,
        messages: [
          {
            role: "user",
            content: `${CONTEXT_FENCE_OPEN}\n${sourceData}\n${CONTEXT_FENCE_CLOSE}`,
          },
        ],
      },
      { timeout: 20_000 },
    );
    const raw = message.content
      .filter(
        (block): block is Extract<(typeof message.content)[number], { type: "text" }> =>
          block.type === "text",
      )
      .map((block) => block.text)
      .join("\n");
    return validateGroundingDecision(raw, interpretation, abstract);
  } catch {
    return {
      supported: false,
      reason: "Grounding verification failed; Faculty review is required.",
      evidenceQuotes: [],
    };
  }
}