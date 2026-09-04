/**
 * Controlled vocabulary for a source's study design / study type.
 *
 * Single source of truth shared by:
 *   - API input validation (api-server routes)
 *   - the faculty source add/edit dropdown
 *   - the reader-facing chip labels on /sleep and /embed-agent
 *
 * This is a **stored attribute only** — a steward picks it when adding or
 * editing a source. It is NEVER inferred, scored, or LLM-generated. It is
 * nullable everywhere; absence renders exactly as before.
 *
 * This module is intentionally dependency-free (no pg / drizzle imports) so
 * it can be imported into browser bundles via the `@workspace/db/study-design`
 * subpath export without pulling server-only code.
 */

export interface StudyDesignOption {
  /** Stable machine value persisted in `sources.study_design`. */
  readonly value: string;
  /** Human-readable label shown to faculty and readers. */
  readonly label: string;
}

export const STUDY_DESIGNS: readonly StudyDesignOption[] = [
  { value: "rct", label: "Randomized controlled trial" },
  { value: "meta_analysis", label: "Meta-analysis / systematic review" },
  { value: "cohort", label: "Cohort / longitudinal" },
  { value: "cross_sectional", label: "Cross-sectional" },
  { value: "case_control", label: "Case-control" },
  { value: "mechanistic", label: "Mechanistic / lab" },
  { value: "narrative_review", label: "Narrative review" },
  { value: "other", label: "Other" },
] as const;

/** The allowed machine values, for zod enums and membership checks. */
export const STUDY_DESIGN_VALUES = STUDY_DESIGNS.map((d) => d.value) as [
  string,
  ...string[],
];

const LABEL_BY_VALUE: Record<string, string> = Object.fromEntries(
  STUDY_DESIGNS.map((d) => [d.value, d.label]),
);

/** True when `value` is a recognized study-design vocabulary value. */
export function isStudyDesign(value: unknown): value is string {
  return typeof value === "string" && value in LABEL_BY_VALUE;
}

/**
 * Resolve a stored value to its human label. Returns null for null/empty or
 * unrecognized values so callers can render "nothing" exactly as before.
 */
export function studyDesignLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return LABEL_BY_VALUE[value] ?? null;
}
