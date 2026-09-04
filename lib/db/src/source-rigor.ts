/**
 * Scientific reliability rubric — the dependency-free definition of the
 * three SEPARATE reliability axes scored per research source, based on
 * Stanford's SPORR / CORES framework (Goodman & Poldrack). The article's
 * core argument is that rigor, reproducibility, and openness are three
 * DIFFERENT things that must never be collapsed into one "is this good?"
 * number, so this module scores and surfaces them separately and never
 * combines them.
 *
 * Single source of truth shared by:
 *   - the AI draft scorer + API validation (api-server)
 *   - the faculty Reliability panel (editable rubric + axis meters)
 *   - the public trust badge next to citations on Palonur / SleepZeit
 *
 * Governance: AI may DRAFT a score; a steward must APPROVE it. Scores are
 * public only once a steward approves the assessment. The scores describe
 * the PAPER, never the steward (no steward identity is ever attached here).
 *
 * This module is intentionally dependency-free (no pg / drizzle imports) so
 * it can be imported into browser bundles via the `@workspace/db/source-rigor`
 * subpath without pulling server-only code (the db barrel constructs a pg
 * Pool, which throws in the browser). Same pattern as `study-design.ts`.
 */

export type ReliabilityAxisKey = "rigor" | "reproducibility" | "openness";

/**
 * Answer for a single rubric item.
 *   - yes      the paper clearly satisfies the item
 *   - partial  partially / weakly satisfied
 *   - no       clearly not satisfied
 *   - unclear  the text does not say (EXCLUDED from the score; lowers coverage)
 */
export type ReliabilityAnswer = "yes" | "partial" | "no" | "unclear";

export const RELIABILITY_ANSWERS: readonly ReliabilityAnswer[] = [
  "yes",
  "partial",
  "no",
  "unclear",
] as const;

export interface ReliabilityItemDef {
  /** Stable machine id persisted in the rubric JSON. */
  readonly id: string;
  /** Short label shown to stewards and readers. */
  readonly label: string;
  /** One-line plain-language explanation of what the item asks. */
  readonly help: string;
}

export interface ReliabilityAxisDef {
  readonly key: ReliabilityAxisKey;
  readonly label: string;
  /** One-line description of what the axis measures. */
  readonly blurb: string;
  readonly items: readonly ReliabilityItemDef[];
}

export const RELIABILITY_AXES: readonly ReliabilityAxisDef[] = [
  {
    key: "rigor",
    label: "Rigor",
    blurb:
      "Quality of the work itself: statistical power, bias control, and transparency.",
    items: [
      {
        id: "sample_power",
        label: "Adequate sample and power",
        help: "Sample size or statistical power is reported and adequate for the claims.",
      },
      {
        id: "bias_control",
        label: "Bias control",
        help: "Randomization, blinding, or appropriate controls guard against bias.",
      },
      {
        id: "preregistration",
        label: "Preregistered plan",
        help: "Hypotheses or the analysis plan were registered before data collection.",
      },
      {
        id: "analytic_transparency",
        label: "Analytic transparency",
        help: "Analytical choices are reported, with no undisclosed flexibility.",
      },
      {
        id: "coi_disclosure",
        label: "Conflicts disclosed",
        help: "Funding sources and conflicts of interest are disclosed.",
      },
    ],
  },
  {
    key: "reproducibility",
    label: "Reproducibility",
    blurb:
      "Whether another scientist could re-derive the result from the same data and methods.",
    items: [
      {
        id: "data_available",
        label: "Data available",
        help: "The underlying data are shared or available on request.",
      },
      {
        id: "code_available",
        label: "Code or methods shared",
        help: "Analysis code or computational methods are shared.",
      },
      {
        id: "methods_detail",
        label: "Methods detailed",
        help: "Methods are described in enough detail to repeat the study.",
      },
      {
        id: "independent_replication",
        label: "Independent replication",
        help: "An independent replication of the result exists.",
      },
    ],
  },
  {
    key: "openness",
    label: "Open Science",
    blurb:
      "FAIR infrastructure that lets others find, access, and reuse the work.",
    items: [
      {
        id: "open_access",
        label: "Open access",
        help: "The paper is openly accessible, not paywalled.",
      },
      {
        id: "shared_materials",
        label: "Shared materials",
        help: "Data and materials are deposited so others can find and access them.",
      },
      {
        id: "interoperable_formats",
        label: "Standard formats",
        help: "Data and materials use standard, interoperable formats.",
      },
      {
        id: "reuse_license",
        label: "Reuse license",
        help: "A license (for example CC BY) explicitly permits reuse.",
      },
    ],
  },
] as const;

export const RELIABILITY_AXIS_KEYS: readonly ReliabilityAxisKey[] =
  RELIABILITY_AXES.map((a) => a.key);

const AXIS_BY_KEY: Record<ReliabilityAxisKey, ReliabilityAxisDef> =
  Object.fromEntries(RELIABILITY_AXES.map((a) => [a.key, a])) as Record<
    ReliabilityAxisKey,
    ReliabilityAxisDef
  >;

/** Look up an axis definition by key. */
export function reliabilityAxis(key: ReliabilityAxisKey): ReliabilityAxisDef {
  return AXIS_BY_KEY[key];
}

/** A single stored rubric answer (per item). */
export interface ReliabilityItemAnswer {
  id: string;
  answer: ReliabilityAnswer;
  /** One-line rationale shown next to the item. Describes the paper. */
  rationale: string;
}

export interface ReliabilityAxisAnswers {
  items: ReliabilityItemAnswer[];
}

/** The full rubric persisted in `sources.assessment_rubric`. */
export type ReliabilityRubric = {
  [K in ReliabilityAxisKey]: ReliabilityAxisAnswers;
};

export function isReliabilityAnswer(v: unknown): v is ReliabilityAnswer {
  return (
    typeof v === "string" &&
    (RELIABILITY_ANSWERS as readonly string[]).includes(v)
  );
}

/** Numeric weight for an answer; null means EXCLUDED from the score. */
function answerValue(answer: ReliabilityAnswer): number | null {
  switch (answer) {
    case "yes":
      return 1;
    case "partial":
      return 0.5;
    case "no":
      return 0;
    case "unclear":
      return null;
  }
}

export interface AxisScore {
  /** 0..100 integer, or null when no items could be scored (all unclear). */
  score: number | null;
  /** Number of items answered yes/partial/no. */
  assessed: number;
  /** Total items in the axis. */
  total: number;
}

/**
 * Pure axis scoring. `unclear` answers are EXCLUDED from the denominator
 * (we do not punish a paper for an item the text simply does not address),
 * but they lower `assessed` so callers can show coverage and avoid
 * over-trusting a score derived from a single answered item.
 */
export function scoreAxis(
  axisKey: ReliabilityAxisKey,
  items: readonly ReliabilityItemAnswer[],
): AxisScore {
  const def = AXIS_BY_KEY[axisKey];
  const total = def.items.length;
  const byId = new Map(items.map((it) => [it.id, it]));
  let sum = 0;
  let assessed = 0;
  for (const itemDef of def.items) {
    const a = byId.get(itemDef.id);
    if (!a || !isReliabilityAnswer(a.answer)) continue;
    const v = answerValue(a.answer);
    if (v === null) continue;
    sum += v;
    assessed += 1;
  }
  const score = assessed === 0 ? null : Math.round((sum / assessed) * 100);
  return { score, assessed, total };
}

export type RubricScores = Record<ReliabilityAxisKey, AxisScore>;

/** Score every axis of a rubric. */
export function scoreRubric(rubric: ReliabilityRubric): RubricScores {
  return {
    rigor: scoreAxis("rigor", rubric.rigor?.items ?? []),
    reproducibility: scoreAxis(
      "reproducibility",
      rubric.reproducibility?.items ?? [],
    ),
    openness: scoreAxis("openness", rubric.openness?.items ?? []),
  };
}

/** Build an empty rubric (all items 'unclear', no rationale). */
export function emptyRubric(): ReliabilityRubric {
  const build = (key: ReliabilityAxisKey): ReliabilityAxisAnswers => ({
    items: AXIS_BY_KEY[key].items.map((it) => ({
      id: it.id,
      answer: "unclear" as ReliabilityAnswer,
      rationale: "",
    })),
  });
  return {
    rigor: build("rigor"),
    reproducibility: build("reproducibility"),
    openness: build("openness"),
  };
}

/**
 * Coerce arbitrary JSON (from the AI scorer or a client PUT) into a
 * well-formed rubric: every axis carries exactly the canonical items in
 * canonical order, unknown ids dropped, bad answers coerced to 'unclear',
 * rationale collapsed to a single trimmed line. This is what the server
 * persists and scores, so a malformed payload can never corrupt the rubric
 * or smuggle extra fields into a public response.
 */
export function normalizeRubric(input: unknown): ReliabilityRubric {
  const obj =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const out = emptyRubric();
  for (const axis of RELIABILITY_AXES) {
    const axisIn = obj[axis.key];
    const itemsIn =
      axisIn &&
      typeof axisIn === "object" &&
      Array.isArray((axisIn as { items?: unknown }).items)
        ? (axisIn as { items: unknown[] }).items
        : [];
    const byId = new Map<string, { answer?: unknown; rationale?: unknown }>();
    for (const raw of itemsIn) {
      if (
        raw &&
        typeof raw === "object" &&
        typeof (raw as { id?: unknown }).id === "string"
      ) {
        byId.set(
          (raw as { id: string }).id,
          raw as { answer?: unknown; rationale?: unknown },
        );
      }
    }
    out[axis.key] = {
      items: axis.items.map((def) => {
        const raw = byId.get(def.id);
        const answer = isReliabilityAnswer(raw?.answer)
          ? raw!.answer
          : "unclear";
        const rationaleRaw =
          typeof raw?.rationale === "string" ? raw.rationale : "";
        const rationale = rationaleRaw.replace(/\s+/g, " ").trim().slice(0, 280);
        return { id: def.id, answer, rationale };
      }),
    };
  }
  return out;
}

/**
 * Stable canonical string for a rubric — `axis.id=answer:rationale` per
 * item, in canonical axis + item order. Used to measure how much of an AI
 * draft the steward kept (draft-vs-final acceptance) so we never trust an
 * AI-emitted score number.
 */
export function canonicalizeRubric(rubric: ReliabilityRubric): string {
  const parts: string[] = [];
  for (const axis of RELIABILITY_AXES) {
    const byId = new Map(
      (rubric[axis.key]?.items ?? []).map((it) => [it.id, it]),
    );
    for (const def of axis.items) {
      const it = byId.get(def.id);
      parts.push(
        `${axis.key}.${def.id}=${it?.answer ?? "unclear"}:${(
          it?.rationale ?? ""
        ).trim()}`,
      );
    }
  }
  return parts.join("\n");
}

/** Coarse display band for a single axis score. Pure presentation. */
export type ReliabilityBand = "strong" | "moderate" | "limited" | "unknown";

export function reliabilityBand(
  score: number | null | undefined,
): ReliabilityBand {
  if (score == null) return "unknown";
  if (score >= 75) return "strong";
  if (score >= 45) return "moderate";
  return "limited";
}

/** Human label for a band, shared by faculty + consumer surfaces. */
export function reliabilityBandLabel(band: ReliabilityBand): string {
  switch (band) {
    case "strong":
      return "Strong";
    case "moderate":
      return "Moderate";
    case "limited":
      return "Limited";
    case "unknown":
      return "Not assessed";
  }
}

/** Per-axis public summary shipped next to a citation on consumer answers. */
export interface PublicAxisScore {
  key: ReliabilityAxisKey;
  label: string;
  score: number | null;
  assessed: number;
  total: number;
  band: ReliabilityBand;
}

/**
 * The whole public reliability object next to a citation. Present ONLY when
 * a steward has approved the assessment. Describes the paper, never the
 * steward.
 */
export interface PublicReliability {
  axes: PublicAxisScore[];
  /** Per-axis rubric items for the expandable detail. */
  rubric: ReliabilityRubric;
}

/**
 * Derive the public reliability object from an approved rubric. Pure: the
 * caller is responsible for only invoking this on steward-approved rows.
 */
export function buildPublicReliability(
  rubric: ReliabilityRubric,
): PublicReliability {
  const scores = scoreRubric(rubric);
  return {
    axes: RELIABILITY_AXES.map((a) => ({
      key: a.key,
      label: a.label,
      score: scores[a.key].score,
      assessed: scores[a.key].assessed,
      total: scores[a.key].total,
      band: reliabilityBand(scores[a.key].score),
    })),
    rubric,
  };
}
