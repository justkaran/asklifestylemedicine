import { seedSleepContent } from "@workspace/db/seeds/sleep";
import { embedTexts, toVectorLiteral, EMBEDDING_MODEL } from "./embeddings";
import { logger } from "./logger";

/**
 * Best-effort, idempotent boot seed for gap-filling sleep-pillar content.
 *
 * Publishing migrates schema, not row data, so additions to the sleep corpus
 * would not otherwise reach production. This seed adds a small set of real,
 * approved sources + interpretations (stewarded by Jamie Zeitzer) covering
 * questions the existing corpus left UNCOVERED — night-time ("3am") awakenings,
 * food/snacks for sleep, bedroom temperature, and evening caffeine's effect on
 * the body clock — so the agent answers them with honest provenance.
 *
 * It only ever owns the rows whose titles it defines; it never modifies a
 * steward-curated interpretation on a different source. Embeddings are produced
 * entirely in-house, so this needs no third-party API key. The caller runs it
 * post-listen and fire-and-forget so embedding latency can never block boot or a
 * deploy health check.
 */
export async function seedSleep(): Promise<void> {
  const result = await seedSleepContent({
    embedTexts,
    toVectorLiteral,
    embeddingModel: EMBEDDING_MODEL,
    log: {
      info: (msg) => logger.info(msg),
      warn: (msg) => logger.warn(msg),
    },
  });

  logger.info({ result }, "Sleep content seed finished");
}
