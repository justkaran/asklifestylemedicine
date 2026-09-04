import pool from "../lib/db";
import { embedTexts, toVectorLiteral, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "../lib/embeddings";

/**
 * Calibration eval for RAG_MIN_SCORE after the in-house model swap. The covered/
 * UNCOVERED gate compares `topScore` (max cosine similarity = 1 - cosine distance,
 * higher is closer) against RAG_MIN_SCORE. This prints the top similarity each
 * on-topic vs off-topic probe hits in the live dev corpus so we can pick a default
 * that cleanly separates the two groups. It writes nothing.
 */

const ON_TOPIC = [
  "I wake up at 3am every night and can't fall back asleep",
  "Does melatonin help me sleep?",
  "How does morning light exposure affect my circadian rhythm?",
  "Why do I still feel tired after eight hours of sleep?",
  "How does caffeine in the afternoon affect sleep quality?",
  "What causes insomnia and how can I treat it?",
  "Is it bad to use my phone in bed before sleeping?",
  "How much deep sleep do I actually need?",
];

const OFF_TOPIC = [
  "What's the best recipe for chocolate chip cookies?",
  "How do I file my income taxes online?",
  "Who won the football World Cup in 2018?",
  "What's the capital of France?",
  "How do I change a flat car tire?",
  "What's a good beginner stock to invest in?",
];

async function topSim(qvec: string): Promise<number> {
  const { rows } = await pool.query<{ sim: number }>(
    `SELECT sim FROM (
SELECT 1 - (sc.embedding <=> $1::halfvec(${EMBEDDING_DIMENSIONS})) AS sim
          FROM source_chunks sc
          JOIN sources s ON s.id = sc.source_id
         WHERE sc.embedding_model = $2
           AND s.rights_basis IS NOT NULL
           AND s.retention_status IN ('review_window', 'retained_with_rights')
        UNION ALL
SELECT 1 - (embedding <=> $1::halfvec(${EMBEDDING_DIMENSIONS})) AS sim
          FROM interpretation_chunks WHERE embedding_model = $2
     ) u ORDER BY sim DESC LIMIT 1`,
    [qvec, EMBEDDING_MODEL],
  );
  return rows.length ? Number(rows[0].sim) : 0;
}

async function main(): Promise<void> {
  const all = [...ON_TOPIC, ...OFF_TOPIC];
  const vectors = await embedTexts(all);
  const lits = vectors.map(toVectorLiteral);

  const onScores: number[] = [];
  const offScores: number[] = [];

  console.log("\n=== ON-TOPIC (should be COVERED) ===");
  for (let i = 0; i < ON_TOPIC.length; i++) {
    const s = await topSim(lits[i]);
    onScores.push(s);
    console.log(`${s.toFixed(4)}  ${ON_TOPIC[i]}`);
  }

  console.log("\n=== OFF-TOPIC (should be UNCOVERED) ===");
  for (let i = 0; i < OFF_TOPIC.length; i++) {
    const s = await topSim(lits[ON_TOPIC.length + i]);
    offScores.push(s);
    console.log(`${s.toFixed(4)}  ${OFF_TOPIC[i]}`);
  }

  const minOn = Math.min(...onScores);
  const maxOff = Math.max(...offScores);
  const meanOn = onScores.reduce((a, b) => a + b, 0) / onScores.length;
  const meanOff = offScores.reduce((a, b) => a + b, 0) / offScores.length;

  console.log("\n=== SUMMARY ===");
  console.log(`on-topic : min=${minOn.toFixed(4)} mean=${meanOn.toFixed(4)}`);
  console.log(`off-topic: max=${maxOff.toFixed(4)} mean=${meanOff.toFixed(4)}`);
  console.log(`gap (minOn - maxOff) = ${(minOn - maxOff).toFixed(4)}`);
  if (minOn > maxOff) {
    console.log(`suggested midpoint threshold = ${((minOn + maxOff) / 2).toFixed(4)}`);
  } else {
    console.log("WARNING: groups overlap — no clean separating threshold");
  }
  await pool.end();
}

main().catch((err) => {
  console.error("Calibration failed", err);
  process.exitCode = 1;
  void pool.end();
});
