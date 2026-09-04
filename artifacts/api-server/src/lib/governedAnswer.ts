/**
 * Non-streaming governed-RAG answer helper.
 *
 * The streaming agent surfaces (/sleep-agent and /embed-agent)
 * each own their SSE wiring. The MCP tool surface (and any other request /
 * response JSON consumer) needs the SAME governed retrieval + grounding +
 * citation guard, but as a single awaited call that returns a structured
 * object. This helper is that path:
 *
 *   route (or pin) pillars -> retrieve approved chunks -> threshold gate ->
 *   build CONTEXT + provenance -> one Anthropic completion -> parse the
 *   labeled sections -> citation guard.
 *
 * It NEVER falls back to the legacy baked Zeitzer corpus: a tool caller gets
 * an honest UNCOVERED when the approved knowledge layer does not cover the
 * question, so every covered answer carries real provenance.
 *
 * Honest-claims: this returns a no-training POLICY (see agentLicense), not a
 * technical guarantee. The helper itself attaches no license; the caller adds
 * `agentLicensePayload(req)` so the policy travels with the keyed response.
 */
import Anthropic from "@anthropic-ai/sdk";
import { and, eq, isNull } from "drizzle-orm";
import { db, pillarsTable } from "@workspace/db";
import { routePillars } from "./pillarRouter.js";
import { RAG_MIN_SCORE } from "./ragThreshold.js";
import {
  CITATION_GUARD_BOUNDARY,
  citationGuardTripped,
  retrieve,
  buildContextBlock,
  buildProvenance,
  verifyCitation,
  type CitationVerification,
  type ProvenanceEntry,
  UNTRUSTED_CONTEXT_RULE,
} from "./rag.js";
import { computeAnswerLimits, type AnswerLimitNotice } from "./answerLimits.js";
import {
  buildExpertSystemPrompt,
  verifyVoice,
  hasVoiceMaterial,
  type StewardVoiceContext,
  type VoiceVerification,
} from "./stewardVoice.js";

const anthropic = new Anthropic({
  baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
});

export type GovernedAnswerOutcome = "covered" | "uncovered" | "refused";

export interface GovernedAnswerResult {
  outcome: GovernedAnswerOutcome;
  /** Human-readable reason on the refused / uncovered paths. */
  reason: string | null;
  /** Parsed labeled sections, present on the covered path. */
  answer: string | null;
  citation: string | null;
  paper: string | null;
  finding: string | null;
  interpretation: string | null;
  action: string | null;
  insight: string | null;
  /** Pillars the question was scoped to (names). */
  pillarNames: string[];
  /** Full citations / provenance the answer was grounded in. */
  provenance: ProvenanceEntry[];
  /** Post-answer citation guard outcome (covered path only). */
  citationVerification: CitationVerification | null;
  /** Post-answer voice guard outcome — present only when a steward voice
   * context with real material was supplied (covered path only). Observe-only,
   * mirrors the citation guard. */
  voiceVerification: VoiceVerification | null;
  /** Top cosine similarity from retrieval (diagnostic). */
  topScore: number;
  /** Amber limit notices (covered path only, [] otherwise). Derived from
   * existing signals — source count, near-threshold margin, pending steward
   * drafts — never new scoring. See lib/answerLimits.ts. */
  limitNotices: AnswerLimitNotice[];
}

export interface GovernedAnswerOptions {
  question: string;
  /**
   * Optional pillar slug to hard-lock retrieval to a single pillar. When
   * omitted, the keyword router selects the pillar set (falling back to all
   * pillars). Retired pillars are never selectable.
   */
  pillarSlug?: string;
  /**
   * Optional steward voice context. When supplied together with a pinned
   * `pillarSlug`, the covered answer is generated through the expert
   * (first-person, voice-aware) system prompt instead of the neutral tool
   * prompt, and the voice guard runs over the result. Omit for the neutral
   * tool path (the default).
   */
  voiceContext?: StewardVoiceContext;
  /** Display name of the steward whose voice is used by the expert prompt. */
  expertName?: string | null;
  /**
   * Canary policy passthrough (see `RetrieveOptions.includeCanaryDoi`).
   * Default (omitted) excludes canaries pre-retrieval — the consumer-safe
   * behavior. Keyed callers pass their licensee's assigned canary DOI,
   * derived ONLY from a validated `req.partnerKey`.
   */
  includeCanaryDoi?: string | null;
}

/**
 * Tool/agent system prompt for the governed covered path. Mirrors the
 * sleep-agent governed prompt (live CONTEXT block, cite-only-from-CONTEXT,
 * no em-dashes) but is self-contained so this lib never imports a route
 * module.
 */
export function buildToolSystemPrompt(
  contextBlock: string,
  pillarNames: string[],
): string {
  const scope =
    pillarNames.length > 0
      ? pillarNames.join(", ")
      : "the topics covered in CONTEXT";
  return `You are Palonur's governed science assistant, called as a TOOL by an
external AI agent. You answer ONLY using the faculty-approved Stanford
Lifestyle Medicine knowledge layer provided below in CONTEXT.

You are scoped to these pillars: ${scope}.

OUTPUT FORMAT - every substantive answer MUST use these exact section markers,
each on its own line, in this order:

ANSWER:
[One or two sentences. Direct. Maximum 35 words.]

CITATION:
[Author et al., Year, Journal - taken verbatim from one CONTEXT entry header.]

PAPER:
[Exact paper title in quotes - from the same CONTEXT entry as CITATION.]

FINDING:
[One sentence on what the paper actually showed, drawn from CONTEXT. Max 35 words.]

INTERPRETATION:
[2-3 sentences, plain language, from a FACULTY-APPROVED INTERPRETATION block
when one exists for the cited source. Maximum 60 words.]

ACTION:
[One sentence. A single concrete lifestyle or behavioral step the person can do -
NEVER a medication, dose, supplement regimen, or treatment instruction. Maximum 20 words.]

INSIGHT:
Q: [The single question about this topic most people never think to ask. Max 14 words.]
A: [Plain, slightly surprising answer grounded in CONTEXT. Maximum 45 words.]

HARD RULES:
1. Cite ONLY a source whose header line appears in CONTEXT below
   ("[source_id=N] ..."). Never invent a citation, paper, year, or finding.
2. If a FACULTY-APPROVED INTERPRETATION block exists for a source, prefer it
   over raw paper excerpts when phrasing the INTERPRETATION section.
3. If the question is clearly outside the pillar scope (${scope}), respond with
   EXACTLY this single line and nothing else:
   REFUSE: This tool only answers questions grounded in Stanford Lifestyle Medicine (${scope}).
   A question that relates to any scoped pillar is IN SCOPE even when it is
   personal, or asks whether something is normal or worth worrying about
   (e.g. a memory question when Cognitive Enhancement is in scope). NEVER
   REFUSE such a question: if CONTEXT covers it, answer; if not, use
   UNCOVERED (rule 4).
4. If the question is in scope but CONTEXT does not actually cover it, respond
   with EXACTLY:
   UNCOVERED: ${CITATION_GUARD_BOUNDARY}
5. NEVER add text before "ANSWER:" or after the last section. No greetings, no
   sign-offs, no markdown, no asterisks, no bullets.
6. NEVER use em-dashes anywhere in the output. Use a comma, a period, or
   parentheses instead, including in the CITATION line.
7. NEVER diagnose a condition, never tell the person whether they have (or do
   not have) a condition, and never prescribe or recommend a medication, dose,
   supplement regimen, or treatment. You are not a clinician. Report ONLY what
   the cited studies showed. If a question is diagnostic or personal-medical
   but the research can still inform it, answer with what the studies showed,
   without labeling the person or their condition. The ACTION line must be a
   lifestyle or behavioral step only, never medication, dosing, or treatment
   instructions.
8. LANGUAGE: Detect the language the user wrote their question in and write
   all section content in that same language. Keep the section labels
   themselves (ANSWER:, CITATION:, PAPER:, FINDING:, INTERPRETATION:, ACTION:,
   INSIGHT:, CLARIFY:, REFUSE:, UNCOVERED:) in English exactly as shown because
   they are machine-readable markers. Only the content after each label should
   be in the detected language.

CONTEXT (the only sources you may cite):
${contextBlock}

${UNTRUSTED_CONTEXT_RULE}`;
}

function makeGrabber(raw: string) {
  return (label: string, next?: string): string | null => {
    const re = new RegExp(
      `${label}:\\s*([\\s\\S]*?)(?=${next ? next + ":" : "$"})`,
      "i",
    );
    const m = raw.match(re);
    return m ? m[1].trim() : null;
  };
}

function emptyResult(
  outcome: GovernedAnswerOutcome,
  pillarNames: string[],
  topScore: number,
  reason: string | null,
): GovernedAnswerResult {
  return {
    outcome,
    reason,
    answer: null,
    citation: null,
    paper: null,
    finding: null,
    interpretation: null,
    action: null,
    insight: null,
    pillarNames,
    provenance: [],
    citationVerification: null,
    voiceVerification: null,
    topScore,
    limitNotices: [],
  };
}

/**
 * Run the governed covered path once and return a structured result. Throws
 * only on a genuine infrastructure failure (retrieval / model error); callers
 * map that to a tool error.
 */
export async function governedAnswer(
  opts: GovernedAnswerOptions,
): Promise<GovernedAnswerResult> {
  const question = opts.question.trim();
  if (question.length === 0) {
    return emptyResult("uncovered", [], 0, "Empty question.");
  }

  // Resolve the pillar set: a pinned slug locks to one (non-retired) pillar;
  // otherwise the keyword router decides.
  let pillarIds: number[];
  let pillarNames: string[];
  if (opts.pillarSlug && opts.pillarSlug.trim()) {
    const slug = opts.pillarSlug.trim();
    const pillar = (
      await db
        .select({ id: pillarsTable.id, name: pillarsTable.name })
        .from(pillarsTable)
        .where(and(eq(pillarsTable.slug, slug), isNull(pillarsTable.retiredAt)))
        .limit(1)
    )[0];
    if (!pillar) {
      return emptyResult(
        "uncovered",
        [],
        0,
        `No active pillar with slug "${slug}".`,
      );
    }
    pillarIds = [pillar.id];
    pillarNames = [pillar.name];
  } else {
    const route = await routePillars(question);
    pillarIds = route.pillars.map((p) => p.id);
    pillarNames = route.pillars.map((p) => p.name);
  }

  const result = await retrieve({
    question,
    pillarIds,
    k: 6,
    includeCanaryDoi: opts.includeCanaryDoi ?? null,
  });
  const topScore = result.topScore;

  if (result.chunks.length === 0 || topScore < RAG_MIN_SCORE) {
    return emptyResult(
      "uncovered",
      pillarNames,
      topScore,
      CITATION_GUARD_BOUNDARY,
    );
  }

  const provenance = buildProvenance(result.chunks);
  const contextBlock = buildContextBlock(result.chunks);

  // When a steward voice context is supplied alongside a pinned single pillar,
  // generate the answer in that expert's first-person, voice-aware prompt;
  // otherwise use the neutral tool prompt. Voice shapes TONE only — it never
  // loosens the grounding or citation discipline enforced below.
  const useVoice = Boolean(
    opts.voiceContext && opts.pillarSlug && opts.pillarSlug.trim(),
  );
  const system = useVoice
    ? buildExpertSystemPrompt(
        contextBlock,
        pillarNames[0] ?? "",
        opts.expertName ?? null,
        opts.voiceContext,
      )
    : buildToolSystemPrompt(contextBlock, pillarNames);

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: question }],
  });

  const raw =
    (msg.content[0] as { type: string; text?: string })?.text?.trim() ?? "";

  if (raw.startsWith("REFUSE:")) {
    return emptyResult(
      "refused",
      pillarNames,
      topScore,
      raw.replace(/^REFUSE:\s*/i, "").trim(),
    );
  }
  if (raw.startsWith("UNCOVERED:")) {
    return emptyResult(
      "uncovered",
      pillarNames,
      topScore,
      raw.replace(/^UNCOVERED:\s*/i, "").trim(),
    );
  }

  const grab = makeGrabber(raw);
  const citationVerification =
    provenance.length > 0 ? verifyCitation(raw, provenance) : null;

  // Voice guard — observe-only, mirrors the citation guard. Runs only when a
  // voice context with real material was supplied; it never rewrites or blocks.
  const voiceVerification =
    opts.voiceContext && hasVoiceMaterial(opts.voiceContext)
      ? verifyVoice(raw, opts.voiceContext)
      : null;

  // Citation guard ENFORCEMENT (non-streaming path): the model invented a
  // citation that maps to no retrieved source. Replace the whole answer with
  // the honest boundary instead of shipping fabricated attribution.
  if (citationGuardTripped(citationVerification)) {
    return {
      ...emptyResult(
        "uncovered",
        pillarNames,
        topScore,
        CITATION_GUARD_BOUNDARY,
      ),
      citationVerification,
    };
  }

  // Amber limit notices — covered path only, derived from signals already
  // in hand (provenance, topScore, steward queue).
  const limitNotices = await computeAnswerLimits({
    provenance,
    topScore,
    pillarIds,
  });

  return {
    outcome: "covered",
    reason: null,
    answer: grab("ANSWER", "CITATION"),
    citation: grab("CITATION", "PAPER"),
    paper: grab("PAPER", "FINDING"),
    finding: grab("FINDING", "INTERPRETATION"),
    interpretation: grab("INTERPRETATION", "ACTION"),
    action: grab("ACTION", "INSIGHT"),
    insight: grab("INSIGHT"),
    pillarNames,
    provenance,
    citationVerification,
    voiceVerification,
    topScore,
    limitNotices,
  };
}
