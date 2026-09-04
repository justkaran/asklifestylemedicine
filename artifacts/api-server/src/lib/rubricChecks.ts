import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

/**
 * Steward rubric checks: an LLM pass that scores a proposed interpretation
 * draft against each steward-authored rubric line ("always state the
 * study's age range", "flag industry-funded work").
 *
 * Everything here is OBSERVE-ONLY, like the topic-fit flag: a verdict is
 * an advisory badge on the review screen. It never blocks, auto-rejects,
 * or otherwise changes the approval workflow — the steward stays the
 * approver. Evaluation failures are swallowed by callers so a scoring
 * error can never fail an inbox read.
 */

const anthropic = new Anthropic({
  baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
});

export const RUBRIC_MODEL = "claude-sonnet-4-6";

/** How many not-yet-scored drafts to lazily evaluate per inbox read
 * (mirrors the topic-fit dashboard's lazy backfill batch). */
export const RUBRIC_LAZY_BATCH = 3;

export function isRubricAiConfigured(): boolean {
  return Boolean(
    process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL &&
      process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
  );
}

export interface DraftForRubric {
  interpretationId: number;
  answer: string;
  interpretation: string;
  notProven: string | null;
  action: string | null;
  sourceTitle: string | null;
}

export interface RubricCheckLine {
  id: number;
  name: string;
  instruction: string;
}

export type RubricVerdict = "pass" | "flag";

export interface RubricEvaluation {
  checkId: number;
  verdict: RubricVerdict;
  rationale: string | null;
}

/**
 * Cache key: the exact draft text + the exact check instruction the
 * verdict was computed for. Editing either side changes the hash, which
 * marks the cached row stale and triggers a lazy re-evaluation.
 */
export function rubricContentHash(
  draft: Pick<
    DraftForRubric,
    "answer" | "interpretation" | "notProven" | "action"
  >,
  check: Pick<RubricCheckLine, "instruction">,
): string {
  return createHash("sha256")
    .update(
      [
        draft.answer,
        draft.interpretation,
        draft.notProven ?? "",
        draft.action ?? "",
        check.instruction,
      ].join("\u0000"),
    )
    .digest("hex");
}

function buildSystemPrompt(): string {
  return [
    "You are screening a DRAFT scientific interpretation against a faculty steward's review rubric.",
    "Your verdicts are ADVISORY flags shown to the steward before they open the draft. You never approve or reject anything — the steward does.",
    "Judge ONLY the draft text provided. Do not use outside knowledge about the underlying study.",
    "",
    "For EACH rubric check, decide:",
    '- "pass" — the draft satisfies the check, or the check clearly does not apply to this draft.',
    '- "flag" — the draft fails the check or leaves it unaddressed in a way the steward would want to see.',
    "Be conservative: flag only genuine misses, not stylistic quibbles beyond what the check asks for.",
    "For every check also give a one-line rationale (at most 160 characters) explaining the verdict.",
    "",
    "Return ONLY a JSON object, no prose and no code fences, with exactly this shape:",
    '{ "results": [{"checkId": 1, "verdict": "pass", "rationale": "..."}] }',
    "Include every checkId you were given exactly once.",
  ].join("\n");
}

function buildUserContent(
  draft: DraftForRubric,
  checks: RubricCheckLine[],
): string {
  const checkBlock = checks
    .map((c) => `- checkId ${c.id} — ${c.name}: ${c.instruction}`)
    .join("\n");
  const parts = [
    `RUBRIC CHECKS:\n${checkBlock}`,
    draft.sourceTitle ? `SOURCE TITLE: ${draft.sourceTitle}` : null,
    `DRAFT ANSWER:\n${draft.answer}`,
    `DRAFT INTERPRETATION:\n${draft.interpretation}`,
    draft.notProven ? `WHAT IS NOT PROVEN:\n${draft.notProven}` : null,
    draft.action ? `SUGGESTED ACTION:\n${draft.action}` : null,
  ];
  return parts.filter(Boolean).join("\n\n");
}

/** Pull the first JSON object out of a model response, tolerating code
 * fences or surrounding prose (same tolerance as scoreSource). */
function parseJsonObject(raw: string): Record<string, unknown> | null {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * One LLM call scoring one draft against ALL of the pillar's rubric
 * checks. Returns null when the integration key is missing or the output
 * is unusable — callers treat null as "still pending", never as a flag.
 */
export async function evaluateDraftAgainstChecks(
  draft: DraftForRubric,
  checks: RubricCheckLine[],
): Promise<RubricEvaluation[] | null> {
  if (!isRubricAiConfigured() || checks.length === 0) return null;

  let msg;
  try {
    msg = await anthropic.messages.create({
      model: RUBRIC_MODEL,
      max_tokens: 4096,
      system: buildSystemPrompt(),
      messages: [{ role: "user", content: buildUserContent(draft, checks) }],
    });
  } catch {
    return null;
  }

  const block = msg.content[0] as { type: string; text?: string } | undefined;
  const raw = block && block.type === "text" && block.text ? block.text : "";
  const parsed = raw ? parseJsonObject(raw) : null;
  const items = Array.isArray(parsed?.results) ? parsed.results : null;
  if (!items) return null;

  const byId = new Map(checks.map((c) => [c.id, c]));
  const out: RubricEvaluation[] = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const rec = it as Record<string, unknown>;
    const checkId = Number(rec.checkId);
    if (!byId.has(checkId)) continue;
    const verdict = rec.verdict === "flag" ? "flag" : "pass";
    const rationale =
      typeof rec.rationale === "string" && rec.rationale.trim()
        ? rec.rationale.trim().slice(0, 300)
        : null;
    out.push({ checkId, verdict, rationale });
  }
  // Only usable when the model addressed every check; a partial answer
  // stays pending rather than silently passing the missing ones.
  return out.length === checks.length ? out : null;
}

/**
 * Evaluate one draft against the checks and upsert cached rows. Returns
 * true when verdicts were stored. Callers wrap in try/catch — a failure
 * here must never fail the read that triggered it.
 */
export async function evaluateAndStoreDraft(
  draft: DraftForRubric,
  checks: RubricCheckLine[],
): Promise<boolean> {
  const evals = await evaluateDraftAgainstChecks(draft, checks);
  if (!evals) return false;
  for (const ev of evals) {
    const check = checks.find((c) => c.id === ev.checkId)!;
    const hash = rubricContentHash(draft, check);
    await db.execute(sql`
      INSERT INTO rubric_check_results
        (check_id, interpretation_id, verdict, rationale, content_hash, model, created_at)
      VALUES
        (${ev.checkId}, ${draft.interpretationId}, ${ev.verdict}, ${ev.rationale}, ${hash}, ${RUBRIC_MODEL}, NOW())
      ON CONFLICT (check_id, interpretation_id) DO UPDATE SET
        verdict = EXCLUDED.verdict,
        rationale = EXCLUDED.rationale,
        content_hash = EXCLUDED.content_hash,
        model = EXCLUDED.model,
        created_at = NOW()
    `);
  }
  return true;
}
