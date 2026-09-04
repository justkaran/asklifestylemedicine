import { seedCorpusGaps } from "@workspace/db/seeds/corpus-gaps";
import { embedTexts, toVectorLiteral, EMBEDDING_MODEL } from "./embeddings";
import { logger } from "./logger";

/**
 * Best-effort, idempotent boot seed for the five corpus coverage gaps
 * identified from real agent-query logs.
 *
 * Adds Stanford-sourced interpretations (and two supplemental sources) so
 * previously-UNCOVERED questions answer with provenance:
 *   - "How do I improve concentration and focus at work?" (cognitive-enhancement)
 *   - "How do I stay connected as I age?" (social-connection)
 *   - "What time should I get circadian light exposure?" (sleep)
 *   - "Why do I wake up at 3am?" (sleep — supplemental coverage)
 *
 * Embeddings are produced entirely in-house; no third-party API key required.
 * Called post-listen, fire-and-forget, so embedding latency never blocks boot
 * or a deploy health check.
 */
export async function seedCorpusGapsContent(): Promise<void> {
  const result = await seedCorpusGaps({
    embedTexts,
    toVectorLiteral,
    embeddingModel: EMBEDDING_MODEL,
    log: {
      info: (msg) => logger.info(msg),
      warn: (msg) => logger.warn(msg),
    },
  });
  logger.info({ result }, "Corpus-gaps content seed finished");
}
