/**
 * Corpus-gap seed runner.
 *
 * Adds Stanford-sourced interpretations (and two supplemental sources) to fill
 * five concrete coverage gaps identified from real agent-query logs:
 *
 *   1. "How do I improve concentration and focus at work?" — cognitive-enhancement
 *   2. "How do I stay connected as I age?" — social-connection
 *   4. "What time should I get circadian light exposure?" — sleep
 *   5. "Why do I wake up at 3am?" — sleep (supplemental coverage)
 *
 * Idempotent — safe to re-run. Uses the in-house gte-small embedding model
 * (no third-party API key required). New sources embed in-process.
 *
 * Run: pnpm --filter @workspace/scripts run seed-corpus-gaps
 */
import { pool } from "@workspace/db";
import { seedCorpusGaps } from "@workspace/db/seeds/corpus-gaps";
import { embedTexts, toVectorLiteral, EMBEDDING_MODEL } from "./embeddings.js";

async function main() {
  console.log("Seeding corpus gaps...");
  const result = await seedCorpusGaps({
    embedTexts,
    toVectorLiteral,
    embeddingModel: EMBEDDING_MODEL,
    log: {
      info: (m) => console.log(m),
      warn: (m) => console.warn(m),
    },
  });
  console.log(
    `Done. ${result.sources} sources, ${result.interpretations} interpretations added.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
