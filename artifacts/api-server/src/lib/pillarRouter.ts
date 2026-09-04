import { db, pillarsTable, type Pillar } from "@workspace/db";

/**
 * Human-readable display labels per pillar slug, used in the disambiguation
 * card shown to readers when the router detects a genuine near-tie.
 * Deliberately phrased for lay readers — not the same as the DB pillar name
 * (which can be institution-specific).
 */
export const PILLAR_DISPLAY_LABELS: Record<string, string> = {
  sleep: "Sleep science",
  movement: "Movement & exercise",
  nutrition: "Food & nutrition",
  "stress-management": "Stress & anxiety",
  "cognitive-enhancement": "Memory & cognition",
  "social-connection": "Relationships & community",
  "gratitude-purpose": "Gratitude & purpose",
  autism: "Autism & neurodiversity",
};

interface PillarsCache {
  loadedAt: number;
  pillars: Pillar[];
}

const PILLARS_TTL_MS = 60_000;
let pillarsCache: PillarsCache | null = null;

async function loadPillars(): Promise<Pillar[]> {
  const now = Date.now();
  if (pillarsCache && now - pillarsCache.loadedAt < PILLARS_TTL_MS) {
    return pillarsCache.pillars;
  }
  const rows = await db.select().from(pillarsTable);
  pillarsCache = { loadedAt: now, pillars: rows };
  return rows;
}

/**
 * Per-pillar keyword sets used by the lightweight classifier. The slug
 * is the pivot — only pillars actually present in the DB are returned.
 * Add a slug here and bootstrap a row in `pillars` to make the public
 * agent route to it.
 */
export const PILLAR_KEYWORDS: Record<string, RegExp[]> = {
  sleep: [
    // Caffeine/coffee and "body clock" live here too (not only in nutrition):
    // caffeine timing and circadian phase are core sleep-science topics, so a
    // question like "does evening coffee shift my body clock?" must be able to
    // route to the sleep pillar even when it carries no other sleep keyword.
    // These terms also remain in `nutrition`, so such questions route to BOTH
    // and the retriever's scoring picks the best-matching corpus.
    // "awake" must be listed explicitly: \bwake\b does NOT match inside
    // "awake", and "Why am I awake at HH:MM?" is the home hero's default
    // night question — it must always route to the sleep pillar.
    /\b(sleep|insomnia|circadian|melatonin|light|lux|nap|napping|wake|waking|woke|awake|wakeful(ness)?|sleepless(ness)?|bed|bedtime|tired|fatigue|grogg|drowsy|snore|snoring|apnea|dream|dreaming|nightmare|jet ?lag|shift work|night shift|chronotype|sleeping|asleep|rem|nrem|caffeine|coffee|body ?clock)\b/i,
  ],
  movement: [
    /\b(exercise|workout|gym|cardio|strength|lift(ing)?|run(ning)?|jog(ging)?|walk(ing)?|cycle|cycling|bike|biking|stretch(ing)?|mobility|yoga|pilates|hiit|sedentary|sit(ting)?|posture|step count|steps per day|active minutes|vo2|fitness|training|sport|sports)\b/i,
  ],
  nutrition: [
    /\b(eat(ing)?|food|diet|meal|breakfast|lunch|dinner|snack|sugar|protein|carb(ohydrate)?s?|fat|fiber|vitamin|mineral|hydrat(ion|e)|water intake|alcohol|caffeine|coffee|tea|fast(ing)?|fasted|calorie|calories|kcal|nutrient|nutrition|microbiome|gut|supplement|appetite|hunger|satiety)\b/i,
  ],
  "stress-management": [
    // Overlaps with sleep ("stress keeps me up at night") are fine:
    // multi-match routing lets retrieval scoring pick the best corpus.
    /\b(stress(ed|ful|or|ors)?|anxiety|anxious|worr(y|ied|ies|ying)|burnout|burn(ed|t)? out|overwhelm(ed|ing)?|relax(ation|ing|ed)?|meditat(e|ion|ing|ive)|mindful(ness)?|breath ?work|breathing exercise(s)?|box breathing|cortisol|panic|tension|unwind|de-?stress(ing)?)\b/i,
  ],
  "cognitive-enhancement": [
    // "How do I improve my memory" belongs on the cognitive pillar, while
    // sleep-and-memory questions multi-match so scoring decides the winner.
    /\b(focus(ing|ed)?|concentrat(e|ion|ing)|attention|distract(ed|ion|ions)?|brain ?fog|brain health|brain train(ing)?|cognit(ion|ive)|memory|mental (sharpness|clarity|performance)|neuroplasticity|forgetful(ness)?)\b/i,
  ],
  "social-connection": [
    /\b(friend(s|ship|ships)?|social (connection|connections|life|ties|network|isolation|support)|relationship(s)?|community|belonging|isolat(ed|ion)|lonel(y|iness)|connect(ing)? with (people|others)|social health)\b/i,
  ],
  "gratitude-purpose": [
    // Bare "purpose" overlaps mechanistic questions ("purpose of REM
    // sleep") — those also carry a sleep keyword, so multi-match + scoring
    // resolves them.
    /\b(gratitude|grateful(ness)?|thankful(ness)?|purpose|meaning (in|of) life|meaningful life|optimis(m|tic)|appreciat(e|ion|ing)|journal(ing)?|volunteer(ing)?)\b/i,
  ],
  autism: [
    /\b(autis(m|tic)|asd|asperger('|\u2019)?s?|neurodiverg(ent|ence)|oxytocin|vasopressin)\b/i,
  ],
  empathy: [
    // "compassion"/"kindness" also read as empathy-adjacent; bare
    // "perspective" is too generic, so require "perspective taking".
    /\b(empath(y|ic|etic|ize|izing)|compassion(ate)?|kindness|perspective[- ]taking|bedside manner|emotional attunement|empathic (concern|accuracy|listening))\b/i,
  ],
};

/**
 * Human-readable routing terms per pillar slug, shown on the faculty admin
 * Pillars page so operators can see WHY a public question lands on a pillar.
 * These are display strings, not the matching source of truth — the regexes
 * above decide routing. A drift guard in `__tests__/pillarRouter.test.ts`
 * asserts every term here actually matches its pillar's regex set, so the
 * two cannot silently diverge.
 */
export const ROUTING_KEYWORDS: Record<string, string[]> = {
  sleep: [
    "sleep",
    "insomnia",
    "circadian",
    "melatonin",
    "nap",
    "awake",
    "bedtime",
    "tired",
    "snoring",
    "apnea",
    "dream",
    "jet lag",
    "night shift",
    "caffeine",
    "coffee",
    "body clock",
  ],
  movement: [
    "exercise",
    "workout",
    "gym",
    "cardio",
    "strength",
    "running",
    "walking",
    "cycling",
    "stretching",
    "yoga",
    "sedentary",
    "posture",
    "fitness",
    "sport",
  ],
  nutrition: [
    "food",
    "diet",
    "meal",
    "sugar",
    "protein",
    "fiber",
    "vitamin",
    "hydration",
    "alcohol",
    "caffeine",
    "coffee",
    "fasting",
    "calories",
    "microbiome",
    "supplement",
    "appetite",
  ],
  "stress-management": [
    "stress",
    "anxiety",
    "burnout",
    "overwhelmed",
    "relaxation",
    "meditation",
    "mindfulness",
    "breathwork",
    "cortisol",
    "panic",
  ],
  "cognitive-enhancement": [
    "focus",
    "concentration",
    "attention",
    "brain fog",
    "brain health",
    "memory",
    "cognitive",
    "mental clarity",
    "forgetfulness",
  ],
  "social-connection": [
    "friendship",
    "social connection",
    "relationships",
    "community",
    "belonging",
    "isolation",
    "loneliness",
    "social support",
  ],
  "gratitude-purpose": [
    "gratitude",
    "grateful",
    "thankfulness",
    "purpose",
    "meaning in life",
    "optimism",
    "appreciation",
    "journaling",
    "volunteering",
  ],
  autism: ["autism", "autistic", "asperger's", "neurodivergent", "oxytocin"],
  empathy: [
    "empathy",
    "empathic",
    "compassion",
    "kindness",
    "perspective taking",
    "bedside manner",
  ],
};

export interface DisambiguateCandidate {
  slug: string;
  /** Human-readable display label from PILLAR_DISPLAY_LABELS (never the DB
   * name which can include institution-specific branding). */
  label: string;
}

export interface PillarRoute {
  pillars: Pillar[];
  /** True when no keyword matched and we fell back to all pillars. */
  fallback: boolean;
  /**
   * True when 2+ pillars matched and the ONLY matching ROUTING_KEYWORDS terms
   * are ones shared between two or more pillars (no pillar has an exclusive
   * anchor term). In this case `disambiguateCandidates` lists the candidates
   * for the client to present a one-tap picker before the LLM is invoked.
   *
   * Examples that ARE ambiguous:
   *   "caffeine"         → sleep + nutrition both claim it
   *
   * Examples that are NOT ambiguous:
   *   "does caffeine affect sleep?" → sleep has exclusive "sleep" keyword
   *   "how does exercise affect sleep?" → movement has "exercise", sleep has "sleep"
   */
  ambiguous: boolean;
  disambiguateCandidates: DisambiguateCandidate[];
}

/**
 * For each matched pillar, count which ROUTING_KEYWORDS terms appear in the
 * question (case-insensitive substring). Returns the set of matched term
 * strings for that slug.
 */
function findMatchedTerms(question: string, slug: string): Set<string> {
  const terms = ROUTING_KEYWORDS[slug] ?? [];
  const q = question.toLowerCase();
  const matched = new Set<string>();
  for (const term of terms) {
    if (q.includes(term.toLowerCase())) matched.add(term.toLowerCase());
  }
  return matched;
}

/**
 * Map a free-form question to one or more pillars present in the DB.
 *
 * Strategy: keyword-first. Each pillar slug has an associated regex set;
 * any pillar whose patterns match is included. If none match, we fall
 * back to ALL known pillars so the retriever still has a chance to find
 * something rather than an automatic UNCOVERED.
 *
 * When `opts.pillarLock` is provided (a pillar slug), routing is bypassed
 * entirely and only that pillar is returned — used after the user taps a
 * disambiguation card and has explicitly chosen their pillar.
 *
 * Ambiguity detection: if 2+ pillars matched but EVERY matching term is
 * shared across multiple pillars (no pillar has even one exclusive term),
 * the route is flagged `ambiguous: true` so the caller can pause and ask
 * the reader to pick before calling the LLM.
 */
export async function routePillars(
  question: string,
  opts?: { pillarLock?: string },
): Promise<PillarRoute> {
  const known = await loadPillars();

  // Explicit pillar lock — the reader already chose via disambiguation.
  if (opts?.pillarLock) {
    const locked = known.find((p) => p.slug === opts.pillarLock);
    if (locked) {
      return {
        pillars: [locked],
        fallback: false,
        ambiguous: false,
        disambiguateCandidates: [],
      };
    }
    // Unknown slug — fall through to normal routing.
  }

  const matched: Pillar[] = [];
  for (const p of known) {
    const patterns = PILLAR_KEYWORDS[p.slug];
    if (!patterns) continue;
    if (patterns.some((re) => re.test(question))) {
      matched.push(p);
    }
  }

  if (matched.length === 0) {
    return {
      pillars: known,
      fallback: true,
      ambiguous: false,
      disambiguateCandidates: [],
    };
  }

  // Ambiguity check: build the matched-terms set for every matched pillar,
  // then flag terms as "exclusive" if only one pillar matched them. A pillar
  // with at least one exclusive term is dominant enough to resolve routing
  // without user input; only when NO matched pillar has an exclusive term do
  // we call it ambiguous.
  if (matched.length >= 2) {
    const termsBySlug = new Map<string, Set<string>>();
    for (const p of matched) {
      termsBySlug.set(p.slug, findMatchedTerms(question, p.slug));
    }

    // Build a tally: how many matched pillars claim each term.
    const termPillarCount = new Map<string, number>();
    for (const terms of termsBySlug.values()) {
      for (const t of terms) {
        termPillarCount.set(t, (termPillarCount.get(t) ?? 0) + 1);
      }
    }

    // A term is exclusive to one pillar if exactly one pillar matched it.
    const hasExclusiveTerm = [...termsBySlug.entries()].some(([, terms]) =>
      [...terms].some((t) => termPillarCount.get(t) === 1),
    );

    if (!hasExclusiveTerm) {
      // Every matching term is shared — genuine ambiguity.
      const disambiguateCandidates: DisambiguateCandidate[] = matched.map(
        (p) => ({
          slug: p.slug,
          label: PILLAR_DISPLAY_LABELS[p.slug] ?? p.name,
        }),
      );
      return {
        pillars: matched,
        fallback: false,
        ambiguous: true,
        disambiguateCandidates,
      };
    }
  }

  return {
    pillars: matched,
    fallback: false,
    ambiguous: false,
    disambiguateCandidates: [],
  };
}
