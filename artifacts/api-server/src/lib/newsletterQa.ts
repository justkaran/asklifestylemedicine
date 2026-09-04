/**
 * Auto-routing newsletter Q&A engine.
 *
 * A reader asks a free-form question with NO pillar pre-chosen. This engine:
 *
 *   1. ROUTES the question to the single best-matching ACTIVE (non-retired)
 *      pillar by running governed retrieval across every active pillar's
 *      approved knowledge layer and taking the pillar of the top-ranked chunk.
 *   2. Loads that pillar's expert (first steward) + their voice context.
 *   3. ANSWERS in that one steward's first-person voice through the existing
 *      governed-answer path (citation discipline + voice guard intact).
 *
 * Routing decisions:
 *   - "unavailable" — there is no approved content anywhere yet (or no active
 *     pillars), so there is nothing any expert could answer from.
 *   - "uncovered"   — approved content exists but nothing clears the retrieval
 *     confidence threshold, i.e. no expert covers this question.
 *   - "routed"      — a single best pillar/expert was selected.
 *
 * It NEVER blends multiple pillars into one answer: a question is answered by
 * exactly one expert from their own approved material, or not at all. The
 * existing pillar-locked surfaces (/embed-agent and /sleep-agent)
 * are untouched — this reuses their shared helpers, it does not replace them.
 *
 * Exposed as a reusable function (`answerNewsletterQuestion`, one-shot, for the
 * downstream email-reply pipeline) and consumed by the streaming HTTP route
 * (`routes/newsletter-qa.ts`) for the members-area web surface.
 */
import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  pillarsTable,
  facultyMembershipsTable,
  facultyUsersTable,
} from "@workspace/db";
import { RAG_MIN_SCORE } from "./ragThreshold.js";
import { retrieve } from "./rag.js";
import {
  loadStewardVoiceContext,
  type StewardVoiceContext,
} from "./stewardVoice.js";
import { governedAnswer, type GovernedAnswerResult } from "./governedAnswer.js";

/** The active pillar + expert a question was routed to. */
export interface RoutedExpert {
  pillarId: number;
  pillarSlug: string;
  pillarName: string;
  /** First steward's display name — the expert who answers. */
  expertName: string | null;
  /** First steward's faculty user id, used to load their voice. */
  stewardUserId: number | null;
  /** Stored profile + live style exemplars that voice the steward. */
  voiceContext: StewardVoiceContext;
}

export type RoutingResult =
  | {
      status: "routed";
      expert: RoutedExpert;
      topScore: number;
      /** The active pillar ids the router searched (excludes retired). */
      pillarIds: number[];
    }
  | { status: "uncovered"; topScore: number; pillarIds: number[] }
  | { status: "unavailable" };

interface ActivePillar {
  id: number;
  slug: string;
  name: string;
}

/**
 * Load the expert (first steward) + voice context for a pillar. Mirrors the
 * steward lookup in /embed-agent: lowest-id steward membership wins, and the
 * voice context degrades to an empty (generic-voice) context when the pillar
 * has no steward or no voice material yet.
 */
async function loadPillarExpert(pillar: ActivePillar): Promise<RoutedExpert> {
  const stewardRow = (
    await db
      .select({
        userId: facultyUsersTable.id,
        fullName: facultyUsersTable.fullName,
      })
      .from(facultyMembershipsTable)
      .innerJoin(
        facultyUsersTable,
        eq(facultyUsersTable.id, facultyMembershipsTable.userId),
      )
      .where(
        and(
          eq(facultyMembershipsTable.pillarId, pillar.id),
          eq(facultyMembershipsTable.role, "steward"),
        ),
      )
      .orderBy(facultyMembershipsTable.id)
      .limit(1)
  )[0];

  const stewardUserId = stewardRow?.userId ?? null;
  const voiceContext = await loadStewardVoiceContext({
    facultyUserId: stewardUserId,
    pillarId: pillar.id,
  });

  return {
    pillarId: pillar.id,
    pillarSlug: pillar.slug,
    pillarName: pillar.name,
    expertName: stewardRow?.fullName ?? null,
    stewardUserId,
    voiceContext,
  };
}

/**
 * Route a free-form question to the single best-matching ACTIVE pillar/expert.
 * Retrieval runs across ALL active (non-retired) pillars at once; the pillar of
 * the top-ranked chunk wins. Retired pillars are never selectable because they
 * are excluded from the candidate set before retrieval.
 */
export async function routeBestPillar(
  question: string,
): Promise<RoutingResult> {
  const q = question.trim();
  if (q.length === 0) return { status: "unavailable" };

  const activePillars: ActivePillar[] = await db
    .select({
      id: pillarsTable.id,
      slug: pillarsTable.slug,
      name: pillarsTable.name,
    })
    .from(pillarsTable)
    .where(isNull(pillarsTable.retiredAt));

  if (activePillars.length === 0) return { status: "unavailable" };

  const pillarIds = activePillars.map((p) => p.id);
  const result = await retrieve({ question: q, pillarIds, k: 6 });

  // No approved chunks at all across every active pillar → nothing to answer
  // from yet, anywhere.
  if (result.chunks.length === 0) return { status: "unavailable" };

  // Content exists but nothing is confident enough → no expert covers this.
  if (result.topScore < RAG_MIN_SCORE) {
    return { status: "uncovered", topScore: result.topScore, pillarIds };
  }

  // The top weighted chunk's pillar is the single best match.
  const bestPillarId = result.chunks[0].pillarId;
  const pillar =
    activePillars.find((p) => p.id === bestPillarId) ?? activePillars[0];
  const expert = await loadPillarExpert(pillar);

  return { status: "routed", expert, topScore: result.topScore, pillarIds };
}

export type NewsletterQaOutcome = "answered" | "uncovered" | "unavailable";

export interface NewsletterQaResult {
  outcome: NewsletterQaOutcome;
  /** The expert/pillar that handled the question (present whenever routing
   * selected one, even if the answer ultimately came back uncovered). */
  expert: {
    name: string | null;
    pillarSlug: string;
    pillarName: string;
  } | null;
  /** Human-readable reason on the uncovered / unavailable paths. */
  reason: string | null;
  /** Parsed labeled sections, present on the answered path. */
  answer: string | null;
  citation: string | null;
  paper: string | null;
  finding: string | null;
  interpretation: string | null;
  action: string | null;
  insight: string | null;
  provenance: GovernedAnswerResult["provenance"];
  citationVerification: GovernedAnswerResult["citationVerification"];
  voiceVerification: GovernedAnswerResult["voiceVerification"];
  topScore: number;
}

function emptyQaResult(
  outcome: NewsletterQaOutcome,
  expert: NewsletterQaResult["expert"],
  reason: string | null,
  topScore: number,
): NewsletterQaResult {
  return {
    outcome,
    expert,
    reason,
    answer: null,
    citation: null,
    paper: null,
    finding: null,
    interpretation: null,
    action: null,
    insight: null,
    provenance: [],
    citationVerification: null,
    voiceVerification: null,
    topScore,
  };
}

/**
 * One-shot (non-streamed) auto-routed answer. Routes the question, then runs
 * the governed-answer path locked to the chosen pillar in that steward's voice.
 * This is the reusable entry point for the downstream email-reply pipeline,
 * which needs a single final answer rather than a token stream.
 */
export async function answerNewsletterQuestion(
  question: string,
): Promise<NewsletterQaResult> {
  const routing = await routeBestPillar(question);

  if (routing.status === "unavailable") {
    return emptyQaResult(
      "unavailable",
      null,
      "No answer is available yet — our experts have not published material on this.",
      0,
    );
  }

  if (routing.status === "uncovered") {
    return emptyQaResult(
      "uncovered",
      null,
      "None of our experts cover this question yet.",
      routing.topScore,
    );
  }

  const { expert } = routing;
  const expertMeta = {
    name: expert.expertName,
    pillarSlug: expert.pillarSlug,
    pillarName: expert.pillarName,
  };

  const result = await governedAnswer({
    question,
    pillarSlug: expert.pillarSlug,
    voiceContext: expert.voiceContext,
    expertName: expert.expertName,
  });

  // A covered governed answer is the only "answered" outcome. A post-routing
  // refuse / uncovered (the model declined despite clearing the threshold) is
  // surfaced as uncovered, keeping the routed expert for context.
  if (result.outcome !== "covered") {
    return emptyQaResult(
      "uncovered",
      expertMeta,
      result.reason ?? "None of our experts cover this question yet.",
      result.topScore,
    );
  }

  return {
    outcome: "answered",
    expert: expertMeta,
    reason: null,
    answer: result.answer,
    citation: result.citation,
    paper: result.paper,
    finding: result.finding,
    interpretation: result.interpretation,
    action: result.action,
    insight: result.insight,
    provenance: result.provenance,
    citationVerification: result.citationVerification,
    voiceVerification: result.voiceVerification,
    topScore: result.topScore,
  };
}
