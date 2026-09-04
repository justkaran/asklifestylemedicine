/**
 * Minimum cosine similarity for retrieval to count as "covered". Below this the
 * agent short-circuits to a clean UNCOVERED instead of drafting an answer from
 * weak matches.
 *
 * This is calibrated for the in-house gte-small model. Its cosine geometry is
 * very different from the old OpenAI text-embedding-3-large: gte-small packs
 * everything into a much narrower band, so the legacy 0.25 default would treat
 * essentially everything as covered. The default below sits inside that gap.
 *
 * Calibrated against the live corpus (see scripts/calibrateThreshold.ts): on-topic
 * sleep questions hit top similarity 0.797–0.902 (mean ~0.83), unrelated questions
 * hit 0.716–0.784 (mean ~0.74). 0.79 is the midpoint that cleanly separates the two
 * groups. The margin is narrow by nature of gte-small's compressed range, which is
 * why this stays env-overridable for production tuning.
 *
 * Single source of truth — every agent surface (sleep, embed, voice
 * preview, weekly reflection) imports this so the covered/uncovered boundary can
 * never drift between routes. Override per-environment with RAG_MIN_SCORE.
 */
export const RAG_MIN_SCORE = (() => {
  const raw = Number(process.env.RAG_MIN_SCORE);
  return Number.isFinite(raw) && raw > 0 ? raw : 0.79;
})();
