/**
 * Framework-rewrite prompt — the cross-pillar "apply a framework" generator.
 *
 * A borrowing steward's draft (an answer or an article) is rewritten so it
 * follows a framework owner's named structure, GROUNDED ONLY in the owner's
 * approved knowledge (CONTEXT), written in the owner's first-person voice, and
 * explicitly attributed to the owner. The output ends with a single CITATION:
 * line taken verbatim from one CONTEXT header so the existing citation guard
 * (`verifyCitation`) works exactly as it does on every other governed surface.
 *
 * Two refusal modes mirror the agent:
 *   REFUSE:     — the draft is off-topic for the owner's pillar.
 *   UNCOVERED:  — on-topic but the owner has no approved material to ground it.
 */
import { formatVoiceBlock, type StewardVoiceContext } from "./stewardVoice.js";
import { UNTRUSTED_CONTEXT_RULE } from "./rag.js";

export interface FrameworkLike {
  name: string;
  description: string | null;
  structure: string;
  example: string | null;
}

export type FrameworkApplyKind = "answer" | "article";

/** Pull the rewritten body out of the model output, dropping the CITATION tail. */
export function splitRewrite(raw: string): { body: string; citation: string | null } {
  const text = raw.trim();
  const m = text.match(/^CITATION:\s*(.+)$/im);
  if (!m) return { body: text, citation: null };
  const idx = text.toUpperCase().lastIndexOf("CITATION:");
  const body = idx >= 0 ? text.slice(0, idx).trim() : text;
  return { body, citation: m[1].trim() };
}

export function buildFrameworkRewritePrompt(opts: {
  framework: FrameworkLike;
  contextBlock: string;
  ownerName: string | null;
  pillarName: string;
  kind: FrameworkApplyKind;
  voiceContext?: StewardVoiceContext;
}): string {
  const { framework, contextBlock, ownerName, pillarName, kind, voiceContext } =
    opts;
  const voiceName = ownerName ?? "the framework owner";
  const piece = kind === "article" ? "article" : "answer";

  const voiceBlock = voiceContext
    ? formatVoiceBlock(voiceName, voiceContext)
    : "";
  const voiceSection = voiceBlock ? `\n\n${voiceBlock}` : "";

  const frameworkParts: string[] = [
    `FRAMEWORK — "${framework.name}" (authored by ${voiceName}):`,
  ];
  if (framework.description) {
    frameworkParts.push(`Purpose: ${framework.description}`);
  }
  frameworkParts.push(`Structure to follow:\n${framework.structure}`);
  if (framework.example) {
    frameworkParts.push(`Worked example:\n${framework.example}`);
  }
  const frameworkBlock = frameworkParts.join("\n\n");

  return `You rewrite a Stanford Lifestyle Medicine steward's ${piece} draft so it
follows ${voiceName}'s "${framework.name}" framework, in ${voiceName}'s own
first-person voice, attributed to ${voiceName}. You speak AS ${voiceName} sharing
their framework with a colleague.

GROUNDING — absolute:
- Every claim in the rewrite must come ONLY from ${voiceName}'s approved
  knowledge in CONTEXT below. Never add a fact that is not in CONTEXT.
- You may freely re-shape, re-order, and re-voice the steward's draft to fit the
  framework, but you may NOT introduce claims the CONTEXT does not support.
- This is about ${pillarName}. If the draft is off-topic for ${voiceName}'s
  expertise, output exactly one line: "REFUSE: <one short first-person sentence>".
- If the draft is on-topic but CONTEXT has nothing to ground it, output exactly
  one line: "UNCOVERED: <one short first-person sentence>".

VOICE — write in ${voiceName}'s first person ("In my framework...", "What I do
is..."). Warm, direct, plain-spoken. Adopting the voice never licenses an
ungrounded claim.${voiceSection}

OUTPUT FORMAT (only when you are NOT refusing):
1. The rewritten ${piece}, organized to follow the framework's structure above.
   Open by naming the framework and crediting ${voiceName} (e.g. "Using
   ${voiceName}'s ${framework.name} framework, ...").
2. Then, on its own final line:
CITATION: [Author et al., Year, Journal — verbatim from one CONTEXT entry header]

${frameworkBlock}

CONTEXT — ${voiceName}'s approved knowledge layer (the ONLY allowed source of
claims):
${contextBlock}

${UNTRUSTED_CONTEXT_RULE}`;
}
