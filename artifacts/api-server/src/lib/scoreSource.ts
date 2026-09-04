import Anthropic from "@anthropic-ai/sdk";
import {
  RELIABILITY_AXES,
  RELIABILITY_ANSWERS,
  normalizeRubric,
  type ReliabilityRubric,
} from "@workspace/db";

/**
 * AI first-pass scorer for a source's three-axis scientific reliability
 * assessment (Stanford SPORR / CORES). This ONLY produces a DRAFT the
 * steward reviews, edits, and approves — it is never authoritative. The
 * server always recomputes the numeric axis scores from the returned item
 * answers via `scoreRubric` (in `@workspace/db/source-rigor`); we never
 * trust a number the model emits.
 *
 * Mirrors `draftInterpretation.ts`: a module-level Anthropic client wired to
 * the Replit AI Integrations proxy. Degrades cleanly — returns `null` when
 * the integration key is absent or the model returns unparseable output, so
 * the steward can still assess by hand.
 */

const anthropic = new Anthropic({
  baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
});

export const SCORE_MODEL = "claude-sonnet-4-6";

/** Cap on the paper body we feed the model, to bound token cost. */
const FULL_TEXT_CHARS = 40_000;

export interface SourceForAssessment {
  title: string;
  authors?: string | null;
  year?: number | null;
  journal?: string | null;
  doi?: string | null;
  abstract?: string | null;
  fullText?: string | null;
}

export interface SourceAssessmentDraft {
  rubric: ReliabilityRubric;
}

function hasAnthropicKey(): boolean {
  return Boolean(
    process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL &&
      process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
  );
}

/** Whether the AI reliability scorer is wired up. Lets callers (e.g. the batch
 * draft route) tell a steward up front that drafting is unavailable instead of
 * silently queueing work that will produce nothing. */
export function isAssessmentAiConfigured(): boolean {
  return hasAnthropicKey();
}

/** Build the rubric description block from the shared definition so the
 * prompt can never drift from the canonical item ids. */
function rubricSpec(): string {
  return RELIABILITY_AXES.map((axis) => {
    const items = axis.items
      .map((it) => `    - ${it.id} — ${it.label}: ${it.help}`)
      .join("\n");
    return `${axis.label} (${axis.key}) — ${axis.blurb}\n${items}`;
  }).join("\n\n");
}

function buildSystemPrompt(): string {
  return [
    "You are assessing the SCIENTIFIC RELIABILITY of a single research paper.",
    "Your assessment is a FIRST DRAFT that a faculty steward will review, edit, and approve before anything is published. Be conservative and honest.",
    "Base your judgement ONLY on the paper text provided by the user. Do NOT use outside knowledge about the authors, the journal, or the field's reputation.",
    "",
    "Score three SEPARATE axes. They measure DIFFERENT things and must never be collapsed into a single overall verdict:",
    "",
    rubricSpec(),
    "",
    `For every item, answer exactly one of: ${RELIABILITY_ANSWERS.join(", ")}.`,
    'Use "unclear" whenever the provided text does not give enough information to judge. Do NOT guess. "unclear" is not a penalty; it simply means the paper does not say.',
    "For each item also give a one-line rationale (at most 160 characters), factual and about the PAPER only.",
    "",
    "Return ONLY a JSON object, no prose and no code fences, with exactly this shape:",
    '{ "rigor": [{"id": "...", "answer": "...", "rationale": "..."}], "reproducibility": [ ... ], "openness": [ ... ] }',
    "Include every item id listed above exactly once, in its axis.",
  ].join("\n");
}

function buildUserContent(source: SourceForAssessment): string {
  const meta = [
    `Title: ${source.title}`,
    source.authors ? `Authors: ${source.authors}` : null,
    source.year ? `Year: ${source.year}` : null,
    source.journal ? `Journal/venue: ${source.journal}` : null,
    source.doi ? `DOI: ${source.doi}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const abstract = source.abstract?.trim()
    ? `\n\nABSTRACT:\n${source.abstract.trim()}`
    : "";

  const body = source.fullText?.trim()
    ? `\n\nPAPER TEXT (may be truncated):\n${source.fullText
        .trim()
        .slice(0, FULL_TEXT_CHARS)}`
    : "";

  return `${meta}${abstract}${body}`;
}

/** Pull the first JSON object out of a model response, tolerating code
 * fences or leading/trailing prose. Returns null if nothing parses. */
function parseJsonObject(raw: string): Record<string, unknown> | null {
  let text = raw.trim();
  // Strip ```json ... ``` fences if present.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Coerce one axis value (array of items, or {items:[...]}) to an items array. */
function axisItems(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (
    v &&
    typeof v === "object" &&
    Array.isArray((v as { items?: unknown }).items)
  ) {
    return (v as { items: unknown[] }).items;
  }
  return [];
}

/**
 * Ask the model to draft a reliability assessment for one source. Returns a
 * normalized rubric (canonical ids/order, bad answers coerced to 'unclear'),
 * or `null` when the integration key is missing or output is unparseable.
 */
export async function generateSourceAssessmentDraft(
  source: SourceForAssessment,
): Promise<SourceAssessmentDraft | null> {
  if (!hasAnthropicKey()) return null;
  const content = buildUserContent(source);
  if (!content.trim()) return null;

  let msg;
  try {
    msg = await anthropic.messages.create({
      model: SCORE_MODEL,
      max_tokens: 8192,
      system: buildSystemPrompt(),
      messages: [{ role: "user", content }],
    });
  } catch {
    return null;
  }

  const block = msg.content[0] as { type: string; text?: string } | undefined;
  const raw =
    block && block.type === "text" && block.text ? block.text : "";
  if (!raw) return null;

  const parsed = parseJsonObject(raw);
  if (!parsed) return null;

  const shaped: Record<string, { items: unknown[] }> = {};
  for (const axis of RELIABILITY_AXES) {
    shaped[axis.key] = { items: axisItems(parsed[axis.key]) };
  }
  return { rubric: normalizeRubric(shaped) };
}
