import { db, adviceGuardTermsTable, type AdviceGuardTerm } from "@workspace/db";

/**
 * FDA / advice review guard.
 *
 * Scans agent answers (agent_queries.answer_text) for language a regulator
 * could read as medical advice: diagnosing the person, medication dosing, or
 * prescriptive treatment directives. Observe-only, like verifyCitation and
 * verifyVoice: it never blocks or rewrites an answer. Results are computed at
 * READ TIME in the admin advice-review endpoint against the current
 * admin-editable term list, so adjusting a boundary instantly re-classifies
 * past answers.
 */

export const ADVICE_CATEGORIES = ["diagnosis", "dosage", "treatment"] as const;
export type AdviceCategory = (typeof ADVICE_CATEGORIES)[number];

export interface AdviceTerm {
  id: number;
  category: AdviceCategory;
  phrase: string;
  addedBy: string;
}

export interface AdviceHit {
  termId: number;
  category: AdviceCategory;
  phrase: string;
  /** ~60 chars of answer text either side of the match, whitespace-collapsed. */
  excerpt: string;
}

/**
 * Code defaults. These SEED the admin-managed `advice_guard_terms` table when
 * it is empty and are the FALLBACK if the table can't be read — mirroring the
 * story_editors pattern so the scanner can never silently go blind. Once
 * seeded, the managed list is authoritative: an admin can remove a default
 * boundary and it stays removed (until the table is emptied entirely).
 */
export const DEFAULT_ADVICE_TERMS: ReadonlyArray<{
  category: AdviceCategory;
  phrase: string;
}> = [
  // Diagnosis — labeling the person or their condition.
  { category: "diagnosis", phrase: "you have insomnia" },
  { category: "diagnosis", phrase: "you have sleep apnea" },
  { category: "diagnosis", phrase: "you likely have" },
  { category: "diagnosis", phrase: "you probably have" },
  { category: "diagnosis", phrase: "you may have a disorder" },
  { category: "diagnosis", phrase: "sounds like you have" },
  { category: "diagnosis", phrase: "you are suffering from" },
  { category: "diagnosis", phrase: "you suffer from" },
  { category: "diagnosis", phrase: "you appear to have" },
  { category: "diagnosis", phrase: "this means you have" },
  { category: "diagnosis", phrase: "consistent with a diagnosis" },
  { category: "diagnosis", phrase: "you are diagnosed" },
  // Dosage — medication-quantity / dosing language. Deliberately NOT the bare
  // words "dose" / "dosing": sleep science legitimately says "dose-response
  // is non-linear" about light exposure, and flagging every such answer
  // drowned the review surface in noise (461/1000 on real data). Admins can
  // add the bare word back as a boundary if they want maximum strictness.
  { category: "dosage", phrase: "mg" },
  { category: "dosage", phrase: "milligram" },
  { category: "dosage", phrase: "milligrams" },
  { category: "dosage", phrase: "mcg" },
  { category: "dosage", phrase: "microgram" },
  { category: "dosage", phrase: "micrograms" },
  { category: "dosage", phrase: "your dose" },
  { category: "dosage", phrase: "melatonin dose" },
  { category: "dosage", phrase: "dose of melatonin" },
  { category: "dosage", phrase: "take a dose" },
  { category: "dosage", phrase: "increase the dose" },
  { category: "dosage", phrase: "lower the dose" },
  { category: "dosage", phrase: "reduce the dose" },
  // Treatment — prescriptive medication / treatment directives.
  { category: "treatment", phrase: "you should take" },
  { category: "treatment", phrase: "recommend taking" },
  { category: "treatment", phrase: "try taking" },
  { category: "treatment", phrase: "start taking" },
  { category: "treatment", phrase: "stop taking" },
  { category: "treatment", phrase: "prescribe" },
  { category: "treatment", phrase: "prescribed" },
  { category: "treatment", phrase: "prescription" },
  { category: "treatment", phrase: "cure your" },
  { category: "treatment", phrase: "treat your" },
  { category: "treatment", phrase: "treatment for your" },
];

export function isAdviceCategory(v: unknown): v is AdviceCategory {
  return (
    typeof v === "string" && (ADVICE_CATEGORIES as readonly string[]).includes(v)
  );
}

// Seed the managed term table from the code defaults exactly once — only when
// it is empty. Seeding on every read would resurrect a boundary an admin
// deliberately removed, so we never re-seed a non-empty table. (Deleting EVERY
// term therefore restores the defaults on next read — a deliberate fail-safe
// so the review surface can never end up scanning against nothing by
// accident.)
async function ensureAdviceTermsSeeded(): Promise<void> {
  const existing = await db
    .select({ id: adviceGuardTermsTable.id })
    .from(adviceGuardTermsTable)
    .limit(1);
  if (existing.length > 0) return;
  await db
    .insert(adviceGuardTermsTable)
    .values(
      DEFAULT_ADVICE_TERMS.map((t) => ({
        category: t.category,
        phrase: t.phrase,
        addedBy: "seed",
      })),
    )
    .onConflictDoNothing();
}

function rowToTerm(row: AdviceGuardTerm): AdviceTerm {
  return {
    id: row.id,
    category: isAdviceCategory(row.category) ? row.category : "treatment",
    phrase: row.phrase,
    addedBy: row.addedBy,
  };
}

/**
 * The effective boundary list: admin-managed DB rows, seeded from the code
 * defaults. Falls back to the code defaults (with synthetic negative ids) if
 * the DB is unreachable so a transient blip never blanks the review surface.
 */
export async function getAdviceTerms(): Promise<AdviceTerm[]> {
  try {
    await ensureAdviceTermsSeeded();
    const rows = await db.select().from(adviceGuardTermsTable);
    if (rows.length > 0) return rows.map(rowToTerm);
  } catch {
    /* fall through to defaults */
  }
  return DEFAULT_ADVICE_TERMS.map((t, i) => ({
    id: -(i + 1),
    category: t.category,
    phrase: t.phrase,
    addedBy: "fallback",
  }));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive, word-boundary match so "mg" never matches inside "might". */
export function buildTermRegex(phrase: string): RegExp {
  const escaped = escapeRegex(phrase.trim()).replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "i");
}

const EXCERPT_RADIUS = 60;

/**
 * Scan one answer against the boundary list. Refusal outcomes (REFUSE: /
 * UNCOVERED:) and empty answers are never flagged — they contain no advice by
 * construction.
 */
export function scanAnswerForAdvice(
  answerText: string,
  terms: AdviceTerm[],
): AdviceHit[] {
  const text = (answerText ?? "").trim();
  if (!text) return [];
  if (/^(REFUSE|UNCOVERED)\s*:/i.test(text)) return [];
  const hits: AdviceHit[] = [];
  for (const term of terms) {
    if (!term.phrase.trim()) continue;
    let re: RegExp;
    try {
      re = buildTermRegex(term.phrase);
    } catch {
      continue; // a malformed phrase must never take the whole scan down
    }
    const m = re.exec(text);
    if (!m) continue;
    const start = Math.max(0, m.index - EXCERPT_RADIUS);
    const end = Math.min(text.length, m.index + m[0].length + EXCERPT_RADIUS);
    const excerpt =
      (start > 0 ? "…" : "") +
      text.slice(start, end).replace(/\s+/g, " ").trim() +
      (end < text.length ? "…" : "");
    hits.push({
      termId: term.id,
      category: term.category,
      phrase: term.phrase,
      excerpt,
    });
  }
  return hits;
}
