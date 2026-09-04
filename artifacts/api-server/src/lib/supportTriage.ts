import { routeBestPillar } from "./newsletterQa.js";
import { governedAnswer } from "./governedAnswer.js";
import { logger } from "./logger.js";
import type { ProvenanceEntry } from "./rag.js";

/**
 * Concierge pre-triage. Reuses the cross-pillar router that powers the reader
 * Q&A to suggest the best owning steward/pillar, then reuses the governed
 * answer path (retrieval + steward voice) to pre-write a draft reply and pull
 * the relevant source context.
 *
 * Best-effort by design: any failure (no AI/RAG keys, no approved content,
 * routing miss) degrades to a usable empty triage so the inbox item is still
 * actionable by a human. NEVER throws.
 */
export interface SupportTriage {
  suggestedPillarId: number | null;
  suggestedPillarSlug: string | null;
  suggestedPillarName: string | null;
  suggestedStewardUserId: number | null;
  suggestedStewardName: string | null;
  draftReply: string | null;
  /** "steward" when a voiced draft was produced, else "palonur". */
  draftMode: "palonur" | "steward";
  sourceContext: ProvenanceEntry[] | null;
}

const EMPTY: SupportTriage = {
  suggestedPillarId: null,
  suggestedPillarSlug: null,
  suggestedPillarName: null,
  suggestedStewardUserId: null,
  suggestedStewardName: null,
  draftReply: null,
  draftMode: "palonur",
  sourceContext: null,
};

/** Compose the labeled governed-answer sections into one warm reply body. */
function composeReply(parts: {
  answer: string | null;
  interpretation: string | null;
  action: string | null;
}): string | null {
  const segments = [parts.answer, parts.interpretation, parts.action]
    .map((s) => (s ? s.trim() : ""))
    .filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  return segments.join("\n\n");
}

export async function triageQuestion(message: string): Promise<SupportTriage> {
  const q = message.trim();
  if (q.length === 0) return { ...EMPTY };

  try {
    const routing = await routeBestPillar(q);
    if (routing.status !== "routed") {
      return { ...EMPTY };
    }

    const { expert } = routing;
    const base: SupportTriage = {
      ...EMPTY,
      suggestedPillarId: expert.pillarId,
      suggestedPillarSlug: expert.pillarSlug,
      suggestedPillarName: expert.pillarName,
      suggestedStewardUserId: expert.stewardUserId,
      suggestedStewardName: expert.expertName,
    };

    // Try to pre-write a voiced draft from the routed expert's material.
    try {
      const result = await governedAnswer({
        question: q,
        pillarSlug: expert.pillarSlug,
        voiceContext: expert.voiceContext,
        expertName: expert.expertName,
      });
      if (result.outcome === "covered") {
        return {
          ...base,
          draftReply: composeReply(result),
          draftMode: expert.stewardUserId ? "steward" : "palonur",
          sourceContext:
            result.provenance.length > 0 ? result.provenance : null,
        };
      }
    } catch (e) {
      logger.warn({ err: e }, "support triage draft generation failed");
    }

    // Routed but no covered draft (e.g. no key) — still suggest the steward.
    return base;
  } catch (e) {
    logger.warn({ err: e }, "support triage routing failed");
    return { ...EMPTY };
  }
}
