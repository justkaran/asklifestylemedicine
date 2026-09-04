import { AI_DRAFT_PREFIX } from "./draftInterpretation.js";

/**
 * Compute the Levenshtein edit distance between two strings using a
 * single rolling row of size (b.length + 1). O(a.length × b.length)
 * time, O(b.length) memory. Inputs are clamped to `cap` characters
 * before comparison so the worst case stays bounded even when a
 * steward pastes a 20k-character interpretation.
 */
function levenshtein(aIn: string, bIn: string, cap = 4000): number {
  const a = aIn.length > cap ? aIn.slice(0, cap) : aIn;
  const b = bIn.length > cap ? bIn.slice(0, cap) : bIn;
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prevDiag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = prev[j]!;
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      prev[j] = Math.min(
        prev[j]! + 1, // deletion
        prev[j - 1]! + 1, // insertion
        prevDiag + cost, // substitution
      );
      prevDiag = cur;
    }
  }
  return prev[b.length]!;
}

/**
 * Strip the AI_DRAFT_PREFIX banner (if present) and collapse whitespace
 * so we don't penalise the steward for adding/removing line breaks
 * around the draft they kept verbatim.
 */
function normalize(s: string): string {
  let t = s ?? "";
  if (t.startsWith(AI_DRAFT_PREFIX)) t = t.slice(AI_DRAFT_PREFIX.length);
  return t.replace(/\s+/g, " ").trim();
}

export type DraftAcceptance = "unedited" | "light" | "rewritten" | "no_draft";

export interface DraftSimilarityResult {
  similarity: number | null;
  acceptance: DraftAcceptance;
}

/**
 * Score how much of the AI's draft survived into the approved body.
 *
 * Returns `{ similarity: null, acceptance: "no_draft" }` when there is
 * no draft to compare against (steward never used the drafter, or the
 * row pre-dates Task #31). Otherwise returns a normalized Levenshtein
 * similarity in [0, 1] and a coarse bucket the dashboard can count:
 *
 *   - `unedited`  ≥ 0.95  ("they kept the draft verbatim")
 *   - `light`     ≥ 0.70  ("they tweaked it")
 *   - `rewritten` < 0.70  ("they basically threw it away")
 */
export function scoreDraftAcceptance(
  draft: string | null | undefined,
  finalBody: string,
): DraftSimilarityResult {
  if (!draft || !draft.trim()) {
    return { similarity: null, acceptance: "no_draft" };
  }
  const a = normalize(draft);
  const b = normalize(finalBody);
  if (!a || !b) return { similarity: null, acceptance: "no_draft" };
  const dist = levenshtein(a, b);
  const denom = Math.max(a.length, b.length);
  const sim = denom === 0 ? 1 : 1 - dist / denom;
  const clamped = Math.max(0, Math.min(1, sim));
  let acceptance: DraftAcceptance;
  if (clamped >= 0.95) acceptance = "unedited";
  else if (clamped >= 0.7) acceptance = "light";
  else acceptance = "rewritten";
  return { similarity: clamped, acceptance };
}
