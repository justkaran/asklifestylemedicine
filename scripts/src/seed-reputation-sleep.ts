import { db } from "@workspace/db";
import {
  reputationTopicsTable,
  reputationPromptsTable,
} from "@workspace/db/schema";
import { eq } from "drizzle-orm";

const TOPIC_SLUG = "sleep-stanford";
const TOPIC_NAME = "Sleep — Stanford / Zeitzer";
const TOPIC_DESCRIPTION =
  "Track how external AI engines answer everyday sleep questions, and whether Stanford / Prof. Jamie Zeitzer / Palonur ever surface in their answers.";

const SIGNAL_KEYWORDS = [
  "Stanford",
  "Zeitzer",
  "Palonur",
  "Stanford School of Medicine",
  "Stanford Lifestyle Medicine",
  "Center for Sleep and Circadian Sciences",
  "circadian",
  "melatonin",
];

const SEED_DOMAINS = [
  "med.stanford.edu",
  "stanford.edu",
  "longevity.stanford.edu",
  "palonur.com",
];

const PROMPTS: Array<{ prompt: string; category: string }> = [
  { category: "general", prompt: "What's the best way to improve my sleep quality?" },
  { category: "general", prompt: "Why can't I fall asleep at night?" },
  { category: "general", prompt: "How much sleep do I actually need as an adult?" },
  { category: "circadian", prompt: "What does circadian rhythm mean and how do I fix mine?" },
  { category: "circadian", prompt: "How does morning sunlight affect sleep?" },
  { category: "light", prompt: "Does blue light from my phone really keep me awake?" },
  { category: "light", prompt: "What's the best lighting setup for better sleep?" },
  { category: "shift-work", prompt: "How do shift workers cope with bad sleep?" },
  { category: "jet-lag", prompt: "What's the most effective way to beat jet lag?" },
  { category: "supplements", prompt: "Should I take melatonin to sleep better?" },
  { category: "supplements", prompt: "Does magnesium actually help with sleep?" },
  { category: "stimulants", prompt: "When is the latest I can have caffeine without it ruining my sleep?" },
  { category: "alcohol", prompt: "Why does alcohol make my sleep worse?" },
  { category: "naps", prompt: "Are naps good or bad for nighttime sleep?" },
  { category: "exercise", prompt: "When is the best time of day to exercise for sleep?" },
  { category: "temperature", prompt: "What temperature should my bedroom be for the best sleep?" },
  { category: "tracking", prompt: "Is it worth tracking my sleep with a wearable?" },
  { category: "insomnia", prompt: "What is CBT-I and does it really work for insomnia?" },
  { category: "experts", prompt: "Who are the top sleep researchers I should follow?" },
  { category: "experts", prompt: "Where can I get trustworthy AI advice about sleep?" },
];

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const existing = await db
    .select()
    .from(reputationTopicsTable)
    .where(eq(reputationTopicsTable.slug, TOPIC_SLUG))
    .limit(1);

  let topicId: number;
  if (existing[0]) {
    topicId = existing[0].id;
    console.log(`[seed] topic '${TOPIC_SLUG}' already exists (id=${topicId})`);
    if (!dryRun) {
      await db
        .update(reputationTopicsTable)
        .set({
          name: TOPIC_NAME,
          description: TOPIC_DESCRIPTION,
          signalKeywords: SIGNAL_KEYWORDS,
          seedDomains: SEED_DOMAINS,
        })
        .where(eq(reputationTopicsTable.id, topicId));
      console.log(`[seed] updated topic metadata`);
    }
  } else {
    if (dryRun) {
      console.log(`[seed] DRY RUN: would create topic '${TOPIC_SLUG}'`);
      return;
    }
    const [created] = await db
      .insert(reputationTopicsTable)
      .values({
        slug: TOPIC_SLUG,
        name: TOPIC_NAME,
        description: TOPIC_DESCRIPTION,
        signalKeywords: SIGNAL_KEYWORDS,
        seedDomains: SEED_DOMAINS,
      })
      .returning();
    topicId = created.id;
    console.log(`[seed] created topic id=${topicId}`);
  }

  const existingPrompts = await db
    .select()
    .from(reputationPromptsTable)
    .where(eq(reputationPromptsTable.topicId, topicId));
  const existingTexts = new Set(existingPrompts.map((p) => p.prompt));

  const toInsert = PROMPTS.filter((p) => !existingTexts.has(p.prompt));
  if (toInsert.length === 0) {
    console.log(`[seed] all ${PROMPTS.length} prompts already present`);
  } else if (dryRun) {
    console.log(`[seed] DRY RUN: would insert ${toInsert.length} prompts`);
  } else {
    await db.insert(reputationPromptsTable).values(
      toInsert.map((p) => ({
        topicId,
        prompt: p.prompt,
        category: p.category,
      })),
    );
    console.log(`[seed] inserted ${toInsert.length} new prompts`);
  }

  const finalPrompts = await db
    .select()
    .from(reputationPromptsTable)
    .where(eq(reputationPromptsTable.topicId, topicId));
  console.log(`[seed] topic '${TOPIC_SLUG}' has ${finalPrompts.length} total prompts`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
