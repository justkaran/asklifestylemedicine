/**
 * Sleep seed (manual / dev runner).
 *
 * Thin wrapper over the shared, idempotent seed in @workspace/db/seeds/sleep.
 * The shared module is embeddings-agnostic, so this runner supplies the in-house
 * (local gte-small) embedding callback. The same seed runs best-effort at
 * api-server boot, so a fresh production database self-heals this sleep content
 * on the next publish.
 *
 * What it adds: six real, published papers (with real authors, year, journal,
 * and DOI) plus an approved interpretation each, stewarded by Jamie Zeitzer,
 * covering everyday sleep questions the existing corpus left UNCOVERED — waking
 * at 3am (Ohayon et al., 2010), food/snacks for sleep (St-Onge et al., 2016),
 * bedroom temperature and "best mattress" (Okamoto-Mizuno & Mizuno, 2012), and
 * evening caffeine shifting the body clock (Burke et al., 2015). Every title is
 * distinct from the existing curated sleep corpus, so the seed only ever owns
 * its own rows and never clobbers a steward-curated interpretation.
 *
 * Idempotent. Safe to re-run. Skips anything already approved-with-chunks.
 * Embeds in-process (local gte-small) — no embedding API key required.
 *
 * Run: pnpm --filter @workspace/scripts run seed-sleep
 */
import { pool } from "@workspace/db";
import { seedSleepContent } from "@workspace/db/seeds/sleep";
import { embedTexts, toVectorLiteral, EMBEDDING_MODEL } from "./embeddings.js";

async function main() {
  console.log("Seeding the sleep pillar...");
  const result = await seedSleepContent({
    embedTexts,
    toVectorLiteral,
    embeddingModel: EMBEDDING_MODEL,
    log: { info: (m) => console.log(m), warn: (m) => console.warn(m) },
  });

  if (!result.seeded) {
    console.log(`Sleep seed did not run: ${result.reason ?? "unknown"}.`);
    return;
  }
  console.log(
    `Done. ${result.sources} sources, ${result.interpretations} interpretations ensured.`,
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
