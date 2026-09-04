/**
 * Cross-lingual retrieval bridge.
 *
 * The approved corpus is English and the in-house gte-small embedding model is
 * English-focused: a German question embeds measurably farther from the same
 * content than its English equivalent (observed ~0.78 vs ~0.85 top similarity),
 * which pushes plainly-covered questions under RAG_MIN_SCORE and into the
 * fallback path — losing steward attribution. Keyword pillar routing is also
 * English-regex based, so non-English questions always fan out.
 *
 * Fix: when the client-declared UI language is not English, translate the
 * retrieval query to English with a single small LLM call. The translation is
 * used ONLY for pillar routing + retrieval (and downstream routing hints);
 * the model messages and telemetry keep the user's original wording, so the
 * answer still comes back in the user's language.
 *
 * Fail-open: any error/timeout returns null and the caller proceeds with the
 * original query — behavior is then exactly what it was before this bridge.
 */
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
});

export const TRANSLATION_MODEL = "claude-sonnet-4-6";
const TRANSLATION_TIMEOUT_MS = 8000;
const MAX_INPUT_CHARS = 2000;

/**
 * Returns true when the declared language needs the English bridge.
 * `lang` is the client's two-letter UI language ("en", "de", ...).
 */
export function needsRetrievalTranslation(
  lang: string | undefined | null,
): boolean {
  if (!lang) return false;
  return !lang.trim().toLowerCase().startsWith("en");
}

/**
 * Translate a user question to English for embedding/routing. Returns the
 * English text, or null when translation is unavailable (caller keeps the
 * original). Never throws.
 */
export async function translateForRetrieval(
  text: string,
): Promise<string | null> {
  const input = text.trim();
  if (!input) return null;
  try {
    const msg = await anthropic.messages.create(
      {
        model: TRANSLATION_MODEL,
        max_tokens: 400,
        system:
          "You translate user questions into English for a search index. " +
          "Reply with ONLY the English translation - no quotes, no commentary. " +
          "If the text is already English, reply with the text unchanged.",
        messages: [{ role: "user", content: input.slice(0, MAX_INPUT_CHARS) }],
      },
      { timeout: TRANSLATION_TIMEOUT_MS, maxRetries: 0 },
    );
    const out = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
