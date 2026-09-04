import {
  pgTable,
  serial,
  text,
  integer,
  real,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  pgEnum,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { facultyUsersTable } from "./faculty";

/**
 * Blinded faculty-graded eval harness. Promotes the citation-guard,
 * refusal-posture, and coverage claims in the investor DD brief from
 * structural ("we wrote prompts and a verifier") to numeric ("on N
 * questions, M% verified, R% refused correctly, C% covered").
 *
 * Three tables:
 *
 *   eval_runs       — one row per execution of the seed set against the
 *                     live /api/sleep-agent endpoint. Aggregate auto-
 *                     metrics live here, populated by the CLI after every
 *                     item finishes.
 *
 *   eval_items      — one row per question in a run. Records what the
 *                     system did (answer text, citation verification,
 *                     was_uncovered/refused, top score, retrieval IDs)
 *                     so faculty can grade against the ground-truth
 *                     `expected_outcome` label.
 *
 *   eval_gradings   — one row per (item, grader). Faculty submits 1-5
 *                     scores for groundedness/helpfulness/accuracy and
 *                     a binary hallucinated flag. Blinded — the grading
 *                     UI hides the system's own citation_verification
 *                     and was_uncovered flags so grades aren't anchored
 *                     to the system's self-assessment.
 */

export const expectedOutcomeEnum = pgEnum("eval_expected_outcome", [
  /** In-corpus sleep question. Expect an answer with a verified citation. */
  "covered",
  /** In-scope sleep question we know isn't in the faculty corpus yet.
   *  Expect UNCOVERED: (or governedMiss fallback to the legacy Zeitzer
   *  baked corpus). Grading focuses on whether the refusal/fallback is
   *  honest about its limits. */
  "uncovered",
  /** Off-topic question (finance, weather, politics, code). Expect
   *  REFUSE:. Grading is binary on whether the refusal actually fired. */
  "refuse",
]);

export const evalRunsTable = pgTable(
  "eval_runs",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    notes: text("notes"),
    /** Git SHA or build identifier of the api-server at run time, so a
     *  regression can be attributed to a specific deploy. Free-form;
     *  the CLI fills it from env (`EVAL_BUILD_REF`) or leaves NULL. */
    buildRef: text("build_ref"),
    /** Base URL the runner hit (e.g. http://localhost:80 or the prod
     *  domain). Lets a reviewer tell at a glance which environment the
     *  numbers came from. */
    targetUrl: text("target_url").notNull(),
    totalItems: integer("total_items").notNull().default(0),
    completedItems: integer("completed_items").notNull().default(0),
    /** Auto-metrics. NULL until the run completes; populated by
     *  recomputeRunMetrics() once every item has landed. */
    citationVerifiedRate: real("citation_verified_rate"),
    citationUnmatchedRate: real("citation_unmatched_rate"),
    citationMissingRate: real("citation_missing_rate"),
    /** Of items labeled expected='covered', the fraction that did NOT
     *  return was_uncovered=true. */
    coverageRate: real("coverage_rate"),
    /** Of items labeled expected='refuse', the fraction whose answer
     *  started with REFUSE:. */
    refusalComplianceRate: real("refusal_compliance_rate"),
    /** Of items labeled expected='uncovered', the fraction that either
     *  honestly returned was_uncovered=true OR fell back to legacy with
     *  governedMiss=true. Confabulating an answer here is the failure
     *  mode this metric protects against. */
    uncoveredHonestyRate: real("uncovered_honesty_rate"),
    /** Median end-to-end latency across all items, ms. */
    medianLatencyMs: integer("median_latency_ms"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    createdIdx: index("eval_runs_created_idx").on(t.createdAt),
  }),
);

export const evalItemsTable = pgTable(
  "eval_items",
  {
    id: serial("id").primaryKey(),
    runId: integer("run_id")
      .notNull()
      .references(() => evalRunsTable.id, { onDelete: "cascade" }),
    /** Ordinal in the seed set, stable across runs so a grader can
     *  compare the same question across two runs side by side. */
    seedIndex: integer("seed_index").notNull(),
    question: text("question").notNull(),
    expectedOutcome: expectedOutcomeEnum("expected_outcome").notNull(),
    /** Free-form bucket for slicing metrics: "sleep-onset",
     *  "off-topic-finance", "adversarial-leading", etc. */
    category: text("category").notNull(),
    /** The full answer body returned by the agent (post-stream). */
    answerText: text("answer_text").notNull().default(""),
    /** Outcome of verifyCitation() on the governed covered path, or
     *  NULL on legacy/REFUSE/UNCOVERED paths where verification is not
     *  applicable. */
    citationVerification: text("citation_verification"),
    /** Whether the answer body starts with UNCOVERED: */
    wasUncovered: boolean("was_uncovered").notNull().default(false),
    /** Whether the answer body starts with REFUSE: */
    wasRefused: boolean("was_refused").notNull().default(false),
    /** True when the governed path retrieved chunks above RAG_MIN_SCORE.
     *  False when retrieval fell below threshold and the route fell
     *  back to the legacy baked-corpus Zeitzer prompt. Surfaced as
     *  governedMiss in the SSE done frame. */
    governedUsed: boolean("governed_used").notNull().default(false),
    topScore: real("top_score").notNull().default(0),
    retrievedSourceIds: integer("retrieved_source_ids")
      .array()
      .notNull()
      .default(sql`ARRAY[]::int[]`),
    retrievedInterpretationIds: integer("retrieved_interpretation_ids")
      .array()
      .notNull()
      .default(sql`ARRAY[]::int[]`),
    latencyMs: integer("latency_ms").notNull().default(0),
    /** Best-effort. Set when the underlying /api/sleep-agent call
     *  failed mid-stream so the row records the failure rather than
     *  silently dropping. */
    runError: text("run_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    runIdx: index("eval_items_run_idx").on(t.runId, t.seedIndex),
  }),
);

export const evalGradingsTable = pgTable(
  "eval_gradings",
  {
    id: serial("id").primaryKey(),
    itemId: integer("item_id")
      .notNull()
      .references(() => evalItemsTable.id, { onDelete: "cascade" }),
    graderUserId: integer("grader_user_id")
      .notNull()
      .references(() => facultyUsersTable.id, { onDelete: "cascade" }),
    /** 1-5: does the answer follow from the cited source? Independent
     *  of whether the source itself is correct. */
    groundedness: integer("groundedness").notNull(),
    /** 1-5: would this answer actually help the user. */
    helpfulness: integer("helpfulness").notNull(),
    /** 1-5: is the underlying claim correct against current science. */
    accuracy: integer("accuracy").notNull(),
    /** Hard binary flag — the grader caught a hallucination the
     *  citation guard missed (e.g. cited source exists but answer
     *  misrepresents it). Drives the human-vs-machine gap metric. */
    hallucinated: boolean("hallucinated").notNull().default(false),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    itemGraderUnique: uniqueIndex("eval_gradings_item_grader_unique").on(
      t.itemId,
      t.graderUserId,
    ),
  }),
);

export type EvalRun = typeof evalRunsTable.$inferSelect;
export type EvalItem = typeof evalItemsTable.$inferSelect;
export type EvalGrading = typeof evalGradingsTable.$inferSelect;
export type ExpectedOutcome = (typeof expectedOutcomeEnum.enumValues)[number];
