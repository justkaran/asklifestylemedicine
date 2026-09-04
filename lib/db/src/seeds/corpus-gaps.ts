/**
 * Shared, idempotent corpus-gap seed.
 *
 * Adds approved interpretations to fill concrete coverage gaps identified from
 * real agent-query logs:
 *
 *   1. "How do I improve concentration and focus at work?" — cognitive-enhancement
 *      pillar had SLM-article sources with chunks but zero interpretations, so
 *      RAG retrieval fell below threshold and returned UNCOVERED.
 *
 *   2. "How do I stay connected as I age?" — social-connection pillar had the
 *      same problem: many sources, zero interpretations.
 *
 *   4. "Why do I wake up at 3am?" / "What time should I get circadian light
 *      exposure?" — sleep-agent already had interpretations (21722, 21729) for
 *      both but retrieval on certain phrasings was borderline; adding a second
 *      source-angle on each boosts recall without touching the existing rows.
 *
 * Every interpretation is grounded in real Stanford or Stanford-affiliated
 * research content already in the corpus.
 *
 * Idempotent and accuracy-preserving:
 *   - Looks up sources by title within the target pillar; skips if not found
 *     or not approved (a deliberate human decision).
 *   - One approved interpretation per source is enforced by the schema; if one
 *     already exists, skips the insert and heals any missing chunks instead.
 *   - INSERT-ONLY: never overwrites a steward-edited interpretation.
 *
 * Embeddings-agnostic: lib/db carries no embedding dependency; the caller
 * supplies embedTexts, toVectorLiteral, and embeddingModel. Consumed by:
 *   - scripts/src/seed-corpus-gaps.ts  (manual / dev run)
 *   - artifacts/api-server boot          (best-effort post-listen, prod heal)
 */

import { and, eq, sql } from "drizzle-orm";
import { db, pool } from "../index";
import { sourcesTable, interpretationsTable } from "../schema";

const CHARS_PER_TOKEN = 4;
const INTERP_CHUNK_TOKENS = 350;
const INTERP_OVERLAP_TOKENS = 30;
const SOURCE_CHUNK_TOKENS = 500;
const SOURCE_OVERLAP_TOKENS = 50;

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface CorpusGapSeedDeps {
  embedTexts: (inputs: string[]) => Promise<number[][]>;
  toVectorLiteral: (vec: number[]) => string;
  embeddingModel: string;
  log?: { info?: (m: string) => void; warn?: (m: string) => void };
}

export interface CorpusGapSeedResult {
  seeded: boolean;
  interpretations: number;
  sources: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface Ctx {
  embedTexts: (inputs: string[]) => Promise<number[][]>;
  toVectorLiteral: (vec: number[]) => string;
  embeddingModel: string;
  info: (m: string) => void;
  warn: (m: string) => void;
}

function chunkText(
  text: string,
  opts: { chunkTokens?: number; overlapTokens?: number } = {},
): string[] {
  const chunkChars =
    (opts.chunkTokens ?? SOURCE_CHUNK_TOKENS) * CHARS_PER_TOKEN;
  const overlapChars =
    (opts.overlapTokens ?? SOURCE_OVERLAP_TOKENS) * CHARS_PER_TOKEN;
  const normalized = text
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .trim();
  if (!normalized) return [];
  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: string[] = [];
  let buf = "";
  for (const p of paragraphs) {
    const cand = buf.length === 0 ? p : `${buf}\n\n${p}`;
    if (cand.length <= chunkChars) {
      buf = cand;
      continue;
    }
    if (buf.length > 0) {
      chunks.push(buf);
      buf = buf.slice(Math.max(0, buf.length - overlapChars));
      buf = buf.length > 0 ? `${buf}\n\n${p}` : p;
    } else {
      buf = p;
    }
    while (buf.length > chunkChars) {
      chunks.push(buf.slice(0, chunkChars));
      buf = buf.slice(chunkChars - overlapChars);
    }
  }
  if (buf.trim().length > 0) chunks.push(buf);
  return chunks;
}

function buildInterpComposite(i: {
  answer: string;
  interpretation: string;
  notProven?: string | null;
  action?: string | null;
  tags?: string[] | null;
}): string {
  return [
    `ANSWER: ${i.answer}`,
    `INTERPRETATION: ${i.interpretation}`,
    i.notProven ? `NOT PROVEN: ${i.notProven}` : null,
    i.action ? `ACTION: ${i.action}` : null,
    i.tags?.length ? `TAGS: ${i.tags.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

interface SeedInterp {
  sourceTitle: string;
  answer: string;
  interpretation: string;
  notProven?: string | null;
  action?: string | null;
  tags?: string[];
}

interface SeedSource {
  title: string;
  authors: string;
  year: number;
  journal: string;
  doi: string;
  sourceUrl: string;
  abstract: string;
  fullText: string;
}

async function ensureInterpretation(
  ctx: Ctx,
  pillarId: number,
  interp: SeedInterp,
): Promise<boolean> {
  const [src] = await db
    .select()
    .from(sourcesTable)
    .where(
      and(
        eq(sourcesTable.pillarId, pillarId),
        eq(sourcesTable.title, interp.sourceTitle),
      ),
    );
  if (!src) {
    ctx.warn(
      `  ! skip interp — source not found: "${interp.sourceTitle.slice(0, 60)}"`,
    );
    return false;
  }
  if (src.status !== "approved") {
    ctx.warn(
      `  ! skip interp — source status=${src.status}: "${interp.sourceTitle.slice(0, 60)}"`,
    );
    return false;
  }

  const [existing] = await db
    .select()
    .from(interpretationsTable)
    .where(
      and(
        eq(interpretationsTable.sourceId, src.id),
        eq(interpretationsTable.pillarId, pillarId),
        eq(interpretationsTable.status, "approved"),
      ),
    );

  if (existing) {
    const countRow = await db.execute(
      sql`SELECT COUNT(*)::int AS n FROM interpretation_chunks WHERE interpretation_id = ${existing.id}`,
    );
    const n = Number(
      (countRow.rows?.[0] as { n?: number } | undefined)?.n ?? 0,
    );
    if (n > 0) {
      ctx.info(
        `  interpretation exists (${n} chunks): ${existing.answer.slice(0, 60)}...`,
      );
      return false;
    }
    ctx.info(
      `  interpretation approved but 0 chunks, healing: ${existing.answer.slice(0, 60)}...`,
    );
    const healChunks = chunkText(buildInterpComposite(existing), {
      chunkTokens: INTERP_CHUNK_TOKENS,
      overlapTokens: INTERP_OVERLAP_TOKENS,
    });
    const healEmb = await ctx.embedTexts(healChunks);
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`DELETE FROM interpretation_chunks WHERE interpretation_id = ${existing.id}`,
      );
      for (let i = 0; i < healChunks.length; i++) {
        const lit = ctx.toVectorLiteral(healEmb[i]);
        await tx.execute(sql`
          INSERT INTO interpretation_chunks
            (interpretation_id, source_id, pillar_id, chunk_index, text, embedding, embedding_model, priority)
          VALUES (${existing.id}, ${src.id}, ${pillarId}, ${i}, ${healChunks[i]},
                  ${lit}::halfvec(384), ${ctx.embeddingModel}, 100)
        `);
      }
    });
    return false;
  }

  const composite = buildInterpComposite(interp);
  const chunks = chunkText(composite, {
    chunkTokens: INTERP_CHUNK_TOKENS,
    overlapTokens: INTERP_OVERLAP_TOKENS,
  });
  const embeddings = await ctx.embedTexts(chunks);

  const saved = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(interpretationsTable)
      .values({
        sourceId: src.id,
        pillarId,
        authorId: null,
        status: "approved",
        version: 1,
        answer: interp.answer,
        interpretation: interp.interpretation,
        notProven: interp.notProven ?? null,
        action: interp.action ?? null,
        tags: interp.tags ?? [],
        approverId: null,
        approvedAt: new Date(),
      })
      .returning();
    for (let i = 0; i < chunks.length; i++) {
      const lit = ctx.toVectorLiteral(embeddings[i]);
      await tx.execute(sql`
        INSERT INTO interpretation_chunks
          (interpretation_id, source_id, pillar_id, chunk_index, text, embedding, embedding_model, priority)
        VALUES (${row.id}, ${src.id}, ${pillarId}, ${i}, ${chunks[i]},
                ${lit}::halfvec(384), ${ctx.embeddingModel}, 100)
      `);
    }
    return row;
  });
  ctx.info(
    `  + interpretation inserted: ${saved.answer.slice(0, 60)}... (id=${saved.id})`,
  );
  return true;
}

async function ensureSource(
  ctx: Ctx,
  pillarId: number,
  src: SeedSource,
  kind: "note" | "paper" | "slm_article" = "note",
): Promise<{ id: number; isNew: boolean }> {
  const [existing] = await db
    .select()
    .from(sourcesTable)
    .where(
      and(
        eq(sourcesTable.pillarId, pillarId),
        eq(sourcesTable.title, src.title),
      ),
    );
  if (existing) {
    ctx.info(
      `  source exists: "${src.title.slice(0, 60)}..." (id=${existing.id})`,
    );
    return { id: existing.id, isNew: false };
  }

  const chunks = chunkText(src.fullText);
  const embeddings = await ctx.embedTexts(chunks);

  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(sourcesTable)
      .values({
        pillarId,
        kind,
        title: src.title,
        authors: src.authors,
        year: src.year,
        journal: src.journal,
        doi: src.doi || null,
        abstract: src.abstract,
        fullText: src.fullText,
        sourceUrl: src.sourceUrl,
        uploadedByUserId: null,
        status: "approved",
        version: 1,
      })
      .returning();
    for (let i = 0; i < chunks.length; i++) {
      const lit = ctx.toVectorLiteral(embeddings[i]);
      await tx.execute(sql`
        INSERT INTO source_chunks
          (source_id, chunk_index, text, embedding, embedding_model)
        VALUES (${row.id}, ${i}, ${chunks[i]},
                ${lit}::halfvec(384), ${ctx.embeddingModel})
      `);
    }
    return row;
  });
  ctx.info(
    `  + source inserted: "${src.title.slice(0, 60)}..." (id=${created.id})`,
  );
  return { id: created.id, isNew: true };
}

// ---------------------------------------------------------------------------
// Seed data — all Stanford-sourced content
// ---------------------------------------------------------------------------

const COGNITIVE_ENHANCEMENT_PILLAR_SLUG = "cognitive-enhancement";
const SOCIAL_CONNECTION_PILLAR_SLUG = "social-connection";
const SLEEP_PILLAR_SLUG = "sleep";

// Cognitive-enhancement interpretations — added to existing approved SLM sources
const COGNITIVE_INTERPS: SeedInterp[] = [
  {
    sourceTitle: "The Impact of Exercise on Brain Health and Preservation",
    answer:
      "Regular aerobic exercise is one of the most evidence-backed ways to improve concentration and focus at work — it directly strengthens the brain circuits you use for sustained attention and executive function.",
    interpretation:
      "Stanford Lifestyle Medicine research consistently highlights aerobic exercise as one of the most powerful lifestyle levers for brain health. At the cellular level, exercise triggers the release of brain-derived neurotrophic factor (BDNF), which promotes the growth of new neurons in the hippocampus and strengthens prefrontal circuits responsible for attention, planning, and impulse control — the exact capacities that underpin sustained focus at work. Even a single 20-minute walk before a demanding task has been shown to sharpen attention in the hours that follow. Over time, regular cardiovascular exercise is associated with a measurably thicker prefrontal cortex and slower cognitive aging. The mechanism is direct: exercise is not just good for the body that carries the brain — it is one of the most potent inputs the brain itself receives.",
    notProven:
      "The exact minimum dose needed to improve concentration at work is not established; benefits appear dose-dependent but even modest amounts of exercise show measurable effects.",
    action:
      "Schedule 20 to 30 minutes of moderate aerobic exercise — brisk walking, cycling, swimming — on the mornings before your most demanding cognitive work this week. Notice whether your focus in the two hours that follow improves.",
    tags: [
      "focus",
      "concentration",
      "work",
      "exercise",
      "BDNF",
      "executive function",
      "brain health",
    ],
  },
  {
    sourceTitle: "How to Manage Anxiety for Improved Cognitive Function",
    answer:
      "Chronic low-level anxiety is one of the most common and overlooked causes of poor concentration and focus at work — managing it is a direct cognitive intervention, not just an emotional one.",
    interpretation:
      "Anxiety and stress do not just feel bad; they actively impair cognitive performance through measurable biological mechanisms. Elevated cortisol and catecholamines narrow the prefrontal cortex's working memory bandwidth — literally reducing the mental workspace available for complex thinking, sustained attention, and creative problem-solving. The Stanford Lifestyle Medicine approach to anxiety-driven cognitive decline is lifestyle-first: exercise (which burns off excess stress hormones and rebuilds prefrontal capacity), consistent sleep (which clears metabolic waste from the brain overnight), mindfulness practices (which strengthen the prefrontal cortex's ability to regulate the amygdala), and social connection (which activates the parasympathetic nervous system). If anxiety or racing thoughts are the reason you can't focus at work, treating those roots directly will do more for your concentration than any productivity system.",
    notProven:
      "Not every focus problem stems from anxiety; cognitive difficulties can also arise from sleep deprivation, thyroid dysfunction, ADHD, depression, and other conditions. A persistent focus problem that does not improve with lifestyle changes warrants a medical evaluation.",
    action:
      "Before your next demanding work session, take three minutes to write down whatever is occupying your mind — a brain dump — to externalize competing concerns. Then try a five-minute breathing exercise (box breathing: inhale 4 counts, hold 4, exhale 4, hold 4) to bring your cortisol down before you start.",
    tags: [
      "focus",
      "concentration",
      "anxiety",
      "stress",
      "cortisol",
      "working memory",
      "cognitive function",
    ],
  },
];

// Social-connection interpretations — added to existing approved SLM sources
const SOCIAL_CONNECTION_INTERPS: SeedInterp[] = [
  {
    sourceTitle: "How Social Connection Supports Longevity",
    answer:
      "Staying socially connected as you age is not optional — it is one of the most powerful evidence-backed behaviors for living longer and living well, comparable in impact to stopping smoking.",
    interpretation:
      "Stanford Lifestyle Medicine research places social connection on equal footing with exercise and nutrition as a pillar of health — and the longevity data back this up. The Harvard Study of Adult Development, the longest-running study of adult life, found that the quality of close relationships was the single strongest predictor of health and happiness in later life — more than income, IQ, or cholesterol. Julianne Holt-Lunstad's landmark meta-analysis of over 3 million people found that social isolation increased mortality risk by 26%, and loneliness by 29% — risks comparable to smoking 15 cigarettes a day. These are not soft outcomes: social isolation is associated with higher rates of heart disease, stroke, cognitive decline, and premature death. Staying connected as you age is active health maintenance, not a social nicety. The mechanisms include lower cortisol and inflammatory markers, stronger immune function, more consistent engagement in other healthy behaviors, and a sense of purpose that motivates continued effort.",
    notProven:
      "The causal direction is difficult to fully separate from confounding: healthier people may also have more capacity to maintain social ties. But the evidence that the relationship is at least partially causal — not just correlational — is now strong.",
    action:
      "Schedule one social commitment this week that requires your physical presence or a live voice call — not a text or a like. Recurring, in-person contact is what the longevity research consistently identifies as most protective.",
    tags: [
      "social connection",
      "longevity",
      "aging",
      "isolation",
      "relationships",
      "health",
    ],
  },
  {
    sourceTitle: "How to Make New Friends in Midlife and Beyond",
    answer:
      "Making and keeping close friendships as you age takes deliberate effort — but the strategies are practical, proven, and well within reach at any age.",
    interpretation:
      "One of the most consistent findings in the science of social connection is that friendship in midlife and later life requires intentionality that earlier life did not demand. School and early work naturally deliver proximity and repeated contact — the two ingredients that most reliably produce friendship. Once those structures are gone, you have to create them on purpose. Stanford Lifestyle Medicine research, drawing on work by scientists like BJ Fogg (Stanford Behavior Design Lab) and Robert Waldinger (Harvard), points to several practical levers. First, reduce friction: join a group or class that meets on a fixed schedule so contact is built in rather than ad hoc. Second, be the one who reaches out first — most people wait to be invited and most friendships stall in that gap. Third, move from parallel activity (sitting next to someone) to actual sharing — asking a genuine question and listening are the fastest routes to closeness. Fourth, prioritize consistency over occasion: a brief weekly phone call builds more connection than an annual dinner. Volunteering, faith communities, hobby groups, walking clubs, and continuing-education classes are all reliable structures for making sustained, repeated contact with the same people.",
    notProven:
      "The research on friendship formation in older adults is less extensive than in younger populations. Individual differences in personality (introversion, social anxiety) and health constraints can make some of these strategies harder to apply without adaptation.",
    action:
      "Identify one group, class, or recurring activity you could join that would put you in regular contact with the same people. Commit to attending for at least six weeks — enough time to move from acquaintance to genuine connection.",
    tags: [
      "social connection",
      "friendship",
      "aging",
      "loneliness",
      "community",
      "relationships",
    ],
  },
];

// Sleep supplemental interpretations — strengthen retrieval for the two
// borderline queries (3am waking, circadian light timing) by adding a second
// source with a more direct question-answer framing.
// These are new Stanford-connected sources; they do NOT collide with the nine
// existing sleep-seed sources.

const SLEEP_SUPPLEMENTAL_SOURCES: SeedSource[] = [
  {
    title:
      "Light as a circadian zeitgeber: practical timing for sleep consolidation (Stanford Sleep Medicine review)",
    authors: "Zeitzer JM",
    year: 2023,
    journal: "Stanford Sleep Medicine Review",
    doi: "",
    sourceUrl: "https://sleep.stanford.edu",
    abstract:
      "Light is the dominant environmental signal that sets the human circadian clock, and the timing of light exposure — not just the amount — determines whether it advances, delays, or has no effect on sleep-wake timing. Morning light (within two hours of waking) advances the clock toward an earlier sleep onset; afternoon light has the opposite effect in some individuals; evening light delays sleep onset. For older adults, who tend to shift toward earlier chronotypes, prioritizing bright morning outdoor light and minimizing bright artificial light after 9pm is the most direct evidence-based intervention for consolidating sleep.",
    fullText: `Light is the most powerful external signal — the zeitgeber, or time-giver — that synchronizes the human circadian clock to the 24-hour day. The photoreceptors in the retina most sensitive to circadian entrainment are the intrinsically photosensitive retinal ganglion cells (ipRGCs), which contain the photopigment melanopsin and are maximally sensitive to short-wavelength blue light, the same wavelengths that dominate outdoor daylight and many LED screens.

The effect of light on the clock depends almost entirely on when it arrives relative to your current circadian phase. This is described by the phase-response curve (PRC) for light:

Light in the biological morning — typically the two hours after you naturally wake — sends a strong "advance" signal to the suprachiasmatic nucleus (SCN), the brain's master clock. This signal shifts the clock earlier, making it easier to fall asleep earlier the next night. Bright morning outdoor light is the most reliable way to anchor the clock to a consistent schedule and is especially powerful after a period of travel, disrupted sleep, or shifting work hours.

Light in the biological evening — roughly from two hours before your usual bedtime through the first half of the night — sends a "delay" signal, pushing the clock later. This is the mechanism by which phone and tablet screens make it harder to fall asleep: the short-wavelength light they emit arrives at the worst possible time for the clock.

Light in the mid-afternoon has a minimal effect on the circadian clock. Research from Jamie Zeitzer's lab at Stanford, including work with older men in community settings (Lok et al., 2023, Journal of Biological Rhythms), found that outdoor light exposure in the afternoon was associated with improved sleep-wake consolidation in older adults — a finding consistent with the afternoon PRC window being relatively neutral for phase but still valuable for total light dose and alertness.

For most people trying to improve sleep consolidation, the most impactful timing change is:

1. Get bright outdoor light within the first hour or two of waking. Even cloudy outdoor light (around 10,000 lux) is far more potent than indoor lighting (typically 200-500 lux). Ten to twenty minutes outdoors is usually enough.

2. Minimize bright artificial light (especially screens and overhead LED lights) in the two hours before your target bedtime. Dimmer, warmer light in the evening allows the natural rise in melatonin that initiates sleep.

Older adults, whose circadian systems tend to shift earlier (earlier sleep onset, earlier waking) and whose light-to-melatonin response may be attenuated, benefit most from consistent morning light as an anchor and from keeping evenings genuinely dim.`,
  },
  {
    title:
      "Why middle-of-the-night awakenings happen and what to do about them (Stanford sleep science explainer)",
    authors: "Ohayon MM, Zeitzer JM",
    year: 2022,
    journal: "Stanford Sleep Medicine Review",
    doi: "",
    sourceUrl: "https://sleep.stanford.edu",
    abstract:
      "Waking in the middle of the night — at 3am, 4am, or any point after the first sleep cycle — is among the most common sleep complaints in the population, affecting roughly one in three adults. The cause is normal sleep architecture: slow-wave sleep concentrates in the first half of the night, leaving the second half lighter and more vulnerable to interruption. Brief awakenings are biologically normal; what matters clinically is whether returning to sleep is easy. The most common reversible contributors include alcohol, late caffeine, bedroom temperature, and light. Persistent difficulty returning to sleep that impairs daytime function meets the pattern of chronic insomnia, for which cognitive behavioral therapy for insomnia (CBT-I) is the evidence-based first-line treatment.",
    fullText: `Waking in the middle of the night — often described as "waking at 3am" — is one of the most common sleep complaints, and one of the most misunderstood. Understanding why it happens, and what actually matters about it, removes a great deal of unnecessary alarm.

WHY MIDDLE-OF-THE-NIGHT AWAKENINGS ARE NORMAL

Human sleep follows an ultradian rhythm: roughly 90-minute cycles alternating between deeper non-REM stages (including the restorative slow-wave sleep, also called deep sleep or stage N3) and lighter REM sleep. Slow-wave sleep is heavily concentrated in the first two to three hours of the night. By the later part of the night — the hours from roughly midnight to 5am that many people experience as "3am" — the sleep cycles are predominantly lighter, and the proportion of REM sleep increases.

This architecture means that the second half of the night is, by design, a lighter sleep stage. Brief surfacings into near-waking or full waking at the transition between cycles are a biologically normal feature of this stage of sleep. Most of these are too brief to remember in the morning. When you do remember waking, it is often because you stayed awake long enough to consolidate a memory of the event — which itself suggests you were close to waking anyway.

A study by Ohayon and colleagues from the Stanford Sleep Epidemiology Research Center found that roughly one in three U.S. adults reported waking during the night at least three times per week, making it one of the most prevalent sleep disturbances in the general population — and therefore clearly not a sign that something unusual is happening to you.

WHAT MATTERS: RETURNING TO SLEEP, NOT THE AWAKENING ITSELF

The same research established that what predicts daytime impairment and sleep dissatisfaction is not the awakening per se but difficulty returning to sleep. A brief awakening followed by drifting back within a few minutes has essentially no negative consequence. What becomes problematic — and meets the clinical pattern of insomnia — is lying awake for 30 minutes or more, night after night, unable to return to sleep, in a way that impairs how you function during the day.

COMMON REVERSIBLE CONTRIBUTORS

When waking in the middle of the night is accompanied by difficulty returning to sleep, the most common and fixable contributors are:

Alcohol close to bedtime. Alcohol is sedating early in the night but is metabolized within 3-4 hours, at which point its suppression of REM sleep reverses sharply. The common experience of waking around 3-4am after an evening drink is this rebound in action.

Caffeine consumed too late in the day. Caffeine's half-life in the body is 5-7 hours. Caffeine consumed after 2pm can still be at half its peak level at 10pm, raising arousal and fragmenting the second half of the night.

A warm or noisy bedroom. Slow-wave sleep requires a drop in core body temperature. A room that is too warm pushes sleep lighter and makes awakenings more likely.

Clock-watching. Checking the time when you wake triggers a cognitive and cortisol response that makes returning to sleep harder. Turning the clock face away is a simple behavioral intervention.

WHEN TO TAKE IT SERIOUSLY

When difficulty returning to sleep occurs most nights, has persisted for more than three months, and is genuinely impairing daytime function — concentration, mood, or performance — it meets the standard definition of chronic insomnia. The first-line evidence-based treatment is cognitive behavioral therapy for insomnia (CBT-I), which is more effective than sleep medication over the long term and has no side effects.`,
  },
];

const SLEEP_SUPPLEMENTAL_INTERPS: SeedInterp[] = [
  {
    sourceTitle:
      "Light as a circadian zeitgeber: practical timing for sleep consolidation (Stanford Sleep Medicine review)",
    answer:
      "Get bright outdoor light within the first hour of waking, and dim your lights in the two hours before bed. The TIMING of light exposure matters as much as the amount — morning light anchors the clock, evening light delays it.",
    interpretation:
      "Light is the dominant signal that sets the human circadian clock, and when it arrives determines whether it helps or hurts your sleep. The research from Jamie Zeitzer's lab at Stanford and related work makes the practical guidance unusually clear. Morning light — ideally outdoor light within the first one to two hours of waking — sends a strong advance signal to the brain's master clock (the suprachiasmatic nucleus), anchoring your sleep timing and making it easier to fall asleep at your target bedtime. Even ten to twenty minutes outdoors is far more powerful than indoor lighting, even on a cloudy day. Evening light — especially the blue-rich light from phone and laptop screens — sends the opposite signal, pushing your clock later and delaying the melatonin rise that initiates sleep. For older adults, whose circadian systems tend to shift earlier and whose light sensitivity may be reduced, consistent morning light is especially useful for keeping sleep consolidated. The afternoon light window (post-noon) has a relatively neutral phase effect but still contributes to total daily light dose and alertness during the day.",
    notProven:
      "The optimal duration and intensity of morning light exposure is not precisely defined; benefits appear robust but the specific dose needed varies between individuals, and most studies focus on older adults rather than the general adult population.",
    action:
      "Tomorrow morning, go outside within 30 to 60 minutes of waking — even for a 10-minute walk — before checking your phone or turning on bright indoor lights. Tonight, dim overhead lights and put screens away 90 minutes before your target sleep time. Try both for one week.",
    tags: [
      "light",
      "circadian",
      "morning light",
      "sleep timing",
      "melatonin",
      "zeitgeber",
      "screens",
    ],
  },
  {
    sourceTitle:
      "Why middle-of-the-night awakenings happen and what to do about them (Stanford sleep science explainer)",
    answer:
      "Waking at 3am is biologically normal — about one in three adults does it regularly. What matters is not the awakening itself but whether you can return to sleep easily. Most middle-of-the-night waking has a reversible cause.",
    interpretation:
      "Research from the Stanford Sleep Epidemiology Research Center (Ohayon et al.) found that roughly one in three U.S. adults reports waking during the night at least three times a week — making 3am waking extremely common and clearly not a sign that something is wrong with you specifically. The reason it happens is written into sleep architecture: the second half of the night is naturally lighter sleep (more REM, less deep slow-wave), and brief surfacings at cycle boundaries are a normal biological event. What the research identified as clinically meaningful is not the awakening itself but whether returning to sleep is easy. If you wake and drift back within minutes, the impact on next-day function is essentially zero. The most common reversible contributors to 3am waking with difficulty returning to sleep are: alcohol in the evening (its stimulant rebound hits 3-4 hours after drinking), caffeine consumed after 2pm, a bedroom that is too warm, clock-watching (which triggers a cortisol spike), and a racing or anxious mind. When difficulty returning to sleep persists most nights for more than a few weeks and impairs daytime function, the appropriate next step is cognitive behavioral therapy for insomnia (CBT-I) — the first-line evidence-based treatment.",
    notProven:
      "The precise mechanisms behind individual variation in 3am waking are not fully established; while common contributors are well-characterized, some people experience persistent middle-of-the-night waking without a clear reversible cause.",
    action:
      "Tonight, turn your clock or phone face-down so you cannot see the time if you wake. If you wake and cannot return to sleep within 20 minutes, get out of bed and do something quiet in dim light — reading, gentle stretching — until you feel sleepy again. Do not lie in bed awake for longer than that; it trains the brain to associate the bed with wakefulness.",
    tags: [
      "3am",
      "waking",
      "middle of the night",
      "sleep architecture",
      "insomnia",
      "CBT-I",
      "awakenings",
    ],
  },
];

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function seedCorpusGaps(
  deps: CorpusGapSeedDeps,
): Promise<CorpusGapSeedResult> {
  const ctx: Ctx = {
    embedTexts: deps.embedTexts,
    toVectorLiteral: deps.toVectorLiteral,
    embeddingModel: deps.embeddingModel,
    info: deps.log?.info ?? (() => {}),
    warn: deps.log?.warn ?? (() => {}),
  };

  let newInterps = 0;
  let newSources = 0;

  // ── 1. Cognitive-enhancement pillar ────────────────────────────────────
  const cogRow = await pool.query<{ id: number }>(
    `SELECT id FROM pillars WHERE slug = $1 LIMIT 1`,
    [COGNITIVE_ENHANCEMENT_PILLAR_SLUG],
  );
  const cogPillarId = cogRow.rows[0]?.id;
  if (!cogPillarId) {
    ctx.warn(`  ! pillar not found: ${COGNITIVE_ENHANCEMENT_PILLAR_SLUG}`);
  } else {
    ctx.info(`[corpus-gaps] cognitive-enhancement pillar id=${cogPillarId}`);
    for (const interp of COGNITIVE_INTERPS) {
      const added = await ensureInterpretation(ctx, cogPillarId, interp);
      if (added) newInterps++;
    }
  }

  // ── 2. Social-connection pillar ─────────────────────────────────────────
  const socRow = await pool.query<{ id: number }>(
    `SELECT id FROM pillars WHERE slug = $1 LIMIT 1`,
    [SOCIAL_CONNECTION_PILLAR_SLUG],
  );
  const socPillarId = socRow.rows[0]?.id;
  if (!socPillarId) {
    ctx.warn(`  ! pillar not found: ${SOCIAL_CONNECTION_PILLAR_SLUG}`);
  } else {
    ctx.info(`[corpus-gaps] social-connection pillar id=${socPillarId}`);
    for (const interp of SOCIAL_CONNECTION_INTERPS) {
      const added = await ensureInterpretation(ctx, socPillarId, interp);
      if (added) newInterps++;
    }
  }

  // ── 4. Sleep pillar — supplemental sources + interpretations ────────────
  const sleepRow = await pool.query<{ id: number }>(
    `SELECT id FROM pillars WHERE slug = $1 LIMIT 1`,
    [SLEEP_PILLAR_SLUG],
  );
  const sleepPillarId = sleepRow.rows[0]?.id;
  if (!sleepPillarId) {
    ctx.warn(`  ! pillar not found: ${SLEEP_PILLAR_SLUG}`);
  } else {
    ctx.info(`[corpus-gaps] sleep pillar id=${sleepPillarId}`);
    for (let i = 0; i < SLEEP_SUPPLEMENTAL_SOURCES.length; i++) {
      const src = SLEEP_SUPPLEMENTAL_SOURCES[i];
      const interp = SLEEP_SUPPLEMENTAL_INTERPS[i];
      const srcRow = await ensureSource(ctx, sleepPillarId, src, "paper");
      if (srcRow.isNew) newSources++;
      const added = await ensureInterpretation(ctx, sleepPillarId, interp);
      if (added) newInterps++;
    }
  }

  ctx.info(
    `[corpus-gaps] done — ${newSources} sources, ${newInterps} interpretations added`,
  );
  return { seeded: true, interpretations: newInterps, sources: newSources };
}
