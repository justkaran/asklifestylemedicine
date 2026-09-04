import { seedEmpathyContent } from "@workspace/db/seeds/empathy";
import { embedTexts, toVectorLiteral, EMBEDDING_MODEL } from "./embeddings";
import { logger } from "./logger";

/**
 * Best-effort, idempotent boot seed for the Empathy pillar's approved content.
 *
 * Publishing migrates schema, not row data, so a fresh production database has
 * the empathy pillar (from CANONICAL_PILLARS) but no sources, which makes the
 * embed-agent return UNCOVERED for everything. This seed populates five
 * approved sources and interpretations drawn from Helen Riess's peer-reviewed
 * work (Harvard Medical School / MGH) so the agent answers with provenance.
 *
 * Embeddings are produced entirely in-house (gte-small, 384-dim) — no
 * third-party API key is required. The caller runs it post-listen and
 * fire-and-forget so embedding latency can never block boot or a health check.
 */
export async function seedEmpathy(): Promise<void> {
  const result = await seedEmpathyContent({
    embedTexts,
    toVectorLiteral,
    embeddingModel: EMBEDDING_MODEL,
    log: {
      info: (msg) => logger.info(msg),
      warn: (msg) => logger.warn(msg),
    },
  });
  logger.info({ result }, "Empathy content seed finished");
}
