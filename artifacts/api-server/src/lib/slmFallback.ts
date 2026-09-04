/**
 * SLM AI Lab fallback — answers questions that clear the REFUSE threshold
 * (relevant to health/wellbeing) but fall outside the governed RAG corpus.
 *
 * Instead of returning a bare UNCOVERED line, we stream a response grounded
 * in Stanford Lifestyle Medicine's published body of work at a general level.
 * No fabricated citations — the format uses ANSWER / FINDING / INTERPRETATION
 * only. The SSE `done` event includes `slmFallback: true` so clients can
 * render the "AI Lab" attribution.
 *
 * Also fires a best-effort email to karan@palonur.com so the team can decide
 * whether to add corpus material for the topic.
 */
import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger.js";
import { getResendClient } from "./resendClient.js";
import { UNTRUSTED_CONTEXT_RULE } from "./rag.js";

const anthropic = new Anthropic({
  baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
});

export const SLM_FALLBACK_EXPERT_NAME = "Stanford Lifestyle Medicine AI Lab";
/** Human steward credited for AI Lab fallback answers on public surfaces. */
export const SLM_FALLBACK_STEWARD_NAME = "Karan Dehghani";
export const SLM_FALLBACK_PILLAR_SLUG = "slm-ai-lab";

const SYSTEM = `You are the Stanford Lifestyle Medicine AI Lab, drawing on Stanford Lifestyle Medicine's published research and faculty expertise across sleep, nutrition, movement, stress management, social connection, cognitive health, empathy, and purpose.

Answer using evidence-based lifestyle medicine knowledge. Be warm, direct, and practical. Write for a curious adult who wants real science, not generic wellness advice.

Format every response with these exact labels on their own lines:
ANSWER: [2-4 sentence evidence-based answer]
FINDING: [The key principle or finding in one sentence]
INTERPRETATION: [What this means in practice for the reader, one sentence]

Rules:
- Draw on established lifestyle medicine science. Do NOT fabricate citations or specific paper titles — there is no CITATION or PAPER line in this format.
- If the question is completely unrelated to health, wellbeing, or lifestyle medicine, respond only with: REFUSE: [brief reason]
- Do not use em dashes. Use a comma, colon, or period instead.

${UNTRUSTED_CONTEXT_RULE}`;

const CHAT_SYSTEM = `You are the Stanford Lifestyle Medicine AI Lab, drawing on Stanford Lifestyle Medicine's published research and faculty expertise across sleep, nutrition, movement, stress management, social connection, cognitive health, empathy, and purpose.

You are replying inside a short follow-up chat next to an answer the visitor already received. Reply conversationally in 2-4 sentences, warm, direct, and practical.

Rules:
- Draw on established lifestyle medicine science. Do NOT fabricate citations or specific paper titles.
- No section labels, no bullet lists, just a short chat reply.
- If the question is completely unrelated to health, wellbeing, or lifestyle medicine, respond only with: REFUSE: [brief reason]
- Do not use em dashes. Use a comma, colon, or period instead.`;

/**
 * Returns an Anthropic streaming message for the given question using the SLM
 * AI Lab general-knowledge prompt. Callers own the SSE writing loop.
 *
 * `chat: true` switches to a short conversational reply format (no labels)
 * for the steward chat panel; `history` carries the prior chat turns.
 */
export function buildSlmFallbackStream(
  question: string,
  opts?: {
    chat?: boolean;
    history?: Array<{ role: "user" | "assistant"; content: string }>;
  },
) {
  return anthropic.messages.stream({
    model: "claude-sonnet-4-6",
    max_tokens: 800,
    system: opts?.chat ? CHAT_SYSTEM : SYSTEM,
    messages: [
      ...(opts?.history ?? []).slice(-10),
      { role: "user" as const, content: question },
    ],
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Fire-and-forget notification email to karan@palonur.com whenever the SLM AI
 * Lab fallback handles a question. Swallows all errors — a logging failure
 * must never break the user-facing response.
 */
export function notifyUncoveredQuestion(question: string): void {
  void (async () => {
    try {
      const conn = await getResendClient();
      if (!conn) return;
      await conn.client.emails.send({
        from: `Palonur Alerts <${conn.fromEmail}>`,
        to: "karan@palonur.com",
        subject: "New question answered by SLM AI Lab (outside corpus)",
        html: `
<p style="font-family:sans-serif;color:#333;">
  A visitor asked a question that fell outside the governed corpus.
  It was answered by the <strong>Stanford Lifestyle Medicine AI Lab</strong> fallback.
</p>
<blockquote style="border-left:3px solid #8C1515;padding:4px 12px;color:#555;font-style:italic;margin:16px 0;">
  ${escapeHtml(question)}
</blockquote>
<p style="font-family:sans-serif;font-size:12px;color:#888;">
  Logged in agent_queries (was_uncovered=true). Consider adding corpus material
  to a pillar to cover this topic in future.
</p>`,
      });
    } catch (e) {
      logger.warn(
        { err: e },
        "slmFallback: failed to send uncovered-question notification",
      );
    }
  })();
}
