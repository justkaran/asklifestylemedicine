/**
 * Palonur Sleep Knowledge Map
 * ---------------------------------------------------------------------------
 * The investor thesis behind Palonur: we are the *trust layer* that puts
 * Stanford in control of how AI uses Stanford sleep knowledge across all
 * AI platforms. This file is that trust layer made concrete.
 *
 * It is a typed registry of:
 *   - PAPERS:     peer-reviewed sleep science papers cleared for citation
 *   - CATEGORIES: question-pattern → category → which papers to cite
 *
 * At inference time, the routes call routeQuestion(query) BEFORE asking the
 * LLM. If the question matches a category (e.g. "racing mind" →
 * cognitive-arousal), the LLM is given a ROUTING HINT that names the right
 * paper and action template. This stops the agent from defaulting to its
 * single most-anchored paper for every question.
 *
 * REVIEW PROCESS
 * - `verified: true`  →  Cleared by Palonur for production citation.
 * - `verified: false` →  Seed entry, awaiting expert sign-off. The router
 *                        WILL still surface these via ROUTING HINT, but a
 *                        production hardening step should require verified=true
 *                        before allowing a citation in the response.
 *
 * Adding a new paper or category should be the ONLY way the agent's behavior
 * shifts on a topic. No prompt edits required.
 */

export interface SleepPaper {
  id: string;
  authors: string;
  year: number;
  journal: string;
  title: string;
  /** One-sentence factual summary of what the paper found. */
  finding: string;
  /** "Stanford School of Medicine" or "Stanford-affiliated" or external. */
  affiliation: string;
  /** Cleared for production citation. */
  verified: boolean;
}

export interface KnowledgeCategory {
  id: string;
  label: string;
  /** Plain-English description of what this category covers. */
  description: string;
  /** Regex patterns that indicate the question belongs to this category. */
  triggers: RegExp[];
  /** Paper ids in priority order. The first one is the preferred citation. */
  papers: string[];
  /**
   * One-sentence template for the concrete action the agent should suggest.
   * The LLM may rewrite this to fit the user's exact wording.
   */
  actionTemplate: string;
  /** Routing notes injected into the LLM prompt as a HINT. */
  notes: string;
}

// ─── Paper registry ────────────────────────────────────────────────────────
export const PAPERS: Record<string, SleepPaper> = {
  // ── Zeitzer lab (Stanford, verified) ─────────────────────────────────
  "zeitzer-2000-light": {
    id: "zeitzer-2000-light",
    authors: "Zeitzer JM, Dijk DJ, Kronauer RE, Brown EN, Czeisler CA",
    year: 2000,
    journal: "J Physiol",
    title:
      "Sensitivity of the human circadian pacemaker to nocturnal light: melanopsin and phase-resetting",
    finding:
      "Even ordinary room light (~100 lux) at night significantly suppresses melatonin and shifts the circadian clock; the dose-response is non-linear with a half-maximal effect near 100 lux.",
    affiliation: "Stanford School of Medicine",
    verified: true,
  },
  "zeitzer-2011-flashes": {
    id: "zeitzer-2011-flashes",
    authors: "Zeitzer JM, Ruby NF, Fisicaro RA, Heller HC",
    year: 2011,
    journal: "PLoS ONE",
    title: "Response of the human circadian system to millisecond flashes of light",
    finding:
      "Brief 2-millisecond flashes of light during sleep can shift circadian phase as effectively as continuous bright light.",
    affiliation: "Stanford School of Medicine",
    verified: true,
  },
  "zeitzer-2014-flashes-delay": {
    id: "zeitzer-2014-flashes-delay",
    authors: "Zeitzer JM, Fisicaro RA, Ruby NF, Heller HC",
    year: 2014,
    journal: "J Biol Rhythms",
    title:
      "Millisecond flashes of light phase delay the human circadian clock during sleep",
    finding:
      "Sequenced light flashes during the latter half of the night can delay the biological clock by nearly two hours per night without waking the sleeper.",
    affiliation: "Stanford School of Medicine",
    verified: true,
  },
  "zeitzer-2007-aging-melatonin": {
    id: "zeitzer-2007-aging-melatonin",
    authors: "Zeitzer JM, Duffy JF, Lockley SW, Dijk DJ, Czeisler CA",
    year: 2007,
    journal: "Sleep",
    title:
      "Plasma melatonin rhythms in young and older humans during sleep, sleep deprivation, and wake",
    finding:
      "Older adults have lower melatonin amplitude but preserved circadian phase; melatonin is driven primarily by the circadian clock, not by sleep itself.",
    affiliation: "Stanford School of Medicine",
    verified: true,
  },
  "zeitzer-2011-evening-exercise": {
    id: "zeitzer-2011-evening-exercise",
    authors: "Zeitzer JM, Friedman L, Yesavage JA",
    year: 2011,
    journal: "J Sleep Res",
    title:
      "Effectiveness of evening exercise on sleep in healthy adults: a systematic review",
    finding:
      "Evening exercise does not consistently impair sleep; for most healthy adults it is neutral or mildly beneficial.",
    affiliation: "Stanford School of Medicine",
    verified: true,
  },
  "zeitzer-2005-late-night-light": {
    id: "zeitzer-2005-late-night-light",
    authors:
      "Zeitzer JM, Khalsa SBS, Boivin DB, Duffy JF, Shanahan TL, Kronauer RE, Czeisler CA",
    year: 2005,
    journal: "Am J Physiol Regul Integr Comp Physiol",
    title:
      "Temporal dynamics of late-night photic stimulation of the human circadian timing system",
    finding:
      "Light exposure in the late biological night advances the clock; sensitivity persists for hours after waking.",
    affiliation: "Stanford School of Medicine",
    verified: true,
  },
  "kaplan-2018-rise-and-shine": {
    id: "kaplan-2018-rise-and-shine",
    authors: "Kaplan KA, Talavera DC, Harvey AG (with Zeitzer collaboration)",
    year: 2018,
    journal: "Behav Res Ther",
    title:
      "Rise and shine: a treatment experiment testing a morning routine to decrease subjective sleep inertia in insomnia and bipolar disorder",
    finding:
      "A structured morning protocol (light + activity + caffeine) reduces subjective grogginess after waking.",
    affiliation: "Stanford-affiliated",
    verified: true,
  },
  "hilditch-2019-sleep-inertia": {
    id: "hilditch-2019-sleep-inertia",
    authors: "Hilditch CJ, McHill AW (Zeitzer lab)",
    year: 2019,
    journal: "Nat Sci Sleep",
    title: "Sleep inertia: current insights",
    finding:
      "Sleep inertia (post-wake grogginess) lasts 15-60 minutes and can be mitigated by light, caffeine, sound, and limiting prior sleep restriction.",
    affiliation: "Stanford School of Medicine",
    verified: true,
  },
  "zeitzer-2013-control": {
    id: "zeitzer-2013-control",
    authors: "Zeitzer JM",
    year: 2013,
    journal: "Prog Mol Biol Transl Sci",
    title: "Control of sleep and wakefulness in health and disease",
    finding:
      "Sleep and wake are governed by a two-process model: homeostatic Process S and circadian Process C; the orexin/hypocretin system stabilises wake.",
    affiliation: "Stanford School of Medicine",
    verified: true,
  },

  // ── Stanford CBT-I (Manber lab, seed — pending sign-off) ─────────────
  "manber-2008-cbti-depression": {
    id: "manber-2008-cbti-depression",
    authors:
      "Manber R, Edinger JD, Gress JL, San Pedro-Salcedo MG, Kuo TF, Kalista T",
    year: 2008,
    journal: "Sleep",
    title:
      "Cognitive behavioral therapy for insomnia enhances depression outcome in patients with comorbid major depressive disorder and insomnia",
    finding:
      "CBT for insomnia delivered alongside antidepressant treatment improved both insomnia and depression outcomes versus medication plus a control therapy.",
    affiliation: "Stanford School of Medicine",
    verified: true,
  },
  "harvey-2002-cognitive-model": {
    id: "harvey-2002-cognitive-model",
    authors: "Harvey AG",
    year: 2002,
    journal: "Behav Res Ther",
    title: "A cognitive model of insomnia",
    finding:
      "Insomnia is maintained by a cognitive cycle of worry, selective attention to sleep-related threat, and counter-productive safety behaviours that increase pre-sleep arousal.",
    affiliation:
      "External (UC Berkeley) — foundational cognitive-arousal reference, included for routing context only",
    verified: false,
  },
  "barwick-2024-cure-insomnia": {
    id: "barwick-2024-cure-insomnia",
    authors: "Barwick FC (Stanford Lifestyle Medicine, ed. S. Brock)",
    year: 2024,
    journal: "Stanford Lifestyle Medicine",
    title:
      "How to Cure Insomnia (CBT-I curriculum, Stanford Lifestyle Medicine)",
    finding:
      "Insomnia in most patients is driven by anxious thinking and insufficient sleep drive, not broken biology; the durable fix is CBT-I — bed re-association, sleep consolidation, no-snooze wake discipline, daytime stress regulation, and evening journaling or loving-kindness practice.",
    affiliation: "Stanford School of Medicine (Sleep Medicine)",
    verified: true,
  },

  // ── Stanford athletic-performance sleep work (Mah / Dement lab) ──────
  "mah-2011-basketball": {
    id: "mah-2011-basketball",
    authors: "Mah CD, Mah KE, Kezirian EJ, Dement WC",
    year: 2011,
    journal: "Sleep",
    title:
      "The effects of sleep extension on the athletic performance of collegiate basketball players",
    finding:
      "Stanford basketball players who extended sleep to a minimum of 10 hours in bed for 5-7 weeks ran faster sprints (16.2 → 15.5 s on a baseline timed sprint), improved free-throw accuracy by 9% and three-point accuracy by 9.2%, and reported less daytime fatigue and better mood. This is the landmark causal demonstration that more sleep improves athletic performance.",
    affiliation: "Stanford School of Medicine (Sleep Disorders Clinic)",
    verified: true,
  },
  "mah-2018-collegiate-athletes": {
    id: "mah-2018-collegiate-athletes",
    authors: "Mah CD, Kezirian EJ, Marcello BM, Dement WC",
    year: 2018,
    journal: "Sleep Health",
    title:
      "Poor sleep quality and insufficient sleep of a collegiate student-athlete population",
    finding:
      "In a survey of 628 Stanford student-athletes, 42.4% reported poor sleep quality (PSQI > 5) and 39% slept under 7 hours on weeknights. Insufficient and poor-quality sleep are the norm — not the exception — in elite collegiate athletes, even before competition demands.",
    affiliation: "Stanford School of Medicine (Sleep Disorders Clinic)",
    verified: true,
  },
  "mah-2008-swimmers": {
    id: "mah-2008-swimmers",
    authors: "Mah CD, Mah KE, Dement WC",
    year: 2008,
    journal: "Sleep (Abstract Supplement)",
    title:
      "Extended sleep and the effects on mood and athletic performance in collegiate swimmers",
    finding:
      "Stanford swimmers extending nightly sleep to 10 hours for 6-7 weeks improved 15-m sprint time, reaction time off the blocks, turn time, and kick stroke count, alongside improved daytime mood and reduced sleepiness. Replicates the basketball finding in a different sport.",
    affiliation: "Stanford School of Medicine (Sleep Disorders Clinic)",
    verified: true,
  },
};

// ─── Category routing ──────────────────────────────────────────────────────
//
// Order matters: the first category whose triggers match wins. Place more
// specific categories ABOVE more general ones.
export const CATEGORIES: KnowledgeCategory[] = [
  {
    id: "cognitive-arousal",
    label: "Racing thoughts / cognitive hyperarousal at bedtime",
    description:
      "The user reports their mind won't switch off, they're worrying or replaying things in bed, anxiety on going to bed, or they lie awake thinking.",
    triggers: [
      /\b(racing|busy|won'?t (switch|shut|turn) off|won'?t stop|can'?t (stop|quiet|switch) (my )?(mind|thoughts|brain))\b/i,
      /\b(mind (going|spinning|racing)|thoughts (racing|spinning|going))\b/i,
      /\b(over[-\s]?thinking|ruminat|anxious (in|at) bed|anxiety .*bed|worry(ing)? .*bed|stress(ed)? .*bed)\b/i,
      /\b(can'?t fall asleep|trouble falling asleep|hard to fall asleep).*\b(mind|thoughts|worry|anxious|stress)\b/i,
    ],
    papers: [
      "manber-2008-cbti-depression",
      "barwick-2024-cure-insomnia",
      "harvey-2002-cognitive-model",
    ],
    actionTemplate:
      "Tonight: schedule a 10-minute 'worry window' an hour before bed. Write each concern + the next single step you can take, then close the notebook.",
    notes:
      "This is a cognitive-arousal question, NOT a circadian-light question. The strongest evidence base is CBT-I (Manber, Stanford; Barwick teaches the same curriculum at Stanford Lifestyle Medicine). DO NOT default to the Zeitzer 2000 light-suppression paper — it addresses circadian phase, not cognitive racing thoughts. Cite Manber 2008 OR Barwick 2024 and recommend the worry-window technique, stimulus control (get out of bed if awake >20 min), or constructive worry. If you reference Harvey 2002, frame it as the cognitive model that underpins CBT-I.",
  },

  {
    id: "middle-of-night-waking",
    label: "Waking in the middle of the night and unable to fall back asleep",
    description:
      "User wakes at e.g. 2-4am and lies awake. May or may not involve racing thoughts.",
    triggers: [
      /\b(wake (up )?in the (middle|night)|middle of the night)\b/i,
      /\b(wake (up )?at \d{1,2}\s?(am|a\.m\.|in the morning|at night))\b/i,
      // "Why am I awake at 22:21?" — the home hero's default night question.
      // Covers "awake"/"wide awake"/"lying awake" + a clock time, including
      // 24-hour times ("22:21") that carry no am/pm marker.
      /\b((wide |lying |lie )?awake|wake up|waking( up)?) at \d{1,2}([:.]\d{2})?\b/i,
      /\b(can'?t (fall|get) back (to )?(sleep|asleep)|trouble falling back asleep)\b/i,
      /\b(3\s?am|three\s?am|early[-\s]morning waking|sleep maintenance)\b/i,
    ],
    papers: [
      "barwick-2024-cure-insomnia",
      "manber-2008-cbti-depression",
      "zeitzer-2000-light",
    ],
    actionTemplate:
      "If you've been awake more than 20 minutes, get out of bed, sit in dim light somewhere else, and return only when sleepy. Do not check the time.",
    notes:
      "Middle-of-the-night waking is best addressed by stimulus control (a CBT-I technique), not by light hygiene. Cite Barwick 2024 (Stanford Lifestyle Medicine, the source of the explicit middle-of-night protocol) or Manber 2008. Note: if the user is over 60, mention briefly that lighter, more fragmented sleep is normal with age (Zeitzer 2007 background) — but the actionable change is stimulus control.",
  },

  {
    id: "evening-light",
    label: "Evening light, screens, melatonin suppression",
    description:
      "User asks about screen use, bright light before bed, blue light, lamps, melatonin.",
    triggers: [
      /\b(blue light|screen(s)? (before|at) bed|phone (before|at) bed|tv (before|at) bed)\b/i,
      /\b(light (before|at) bed|evening light|bright light .*night|lamp(s)? .*night|melatonin)\b/i,
      /\b(does light .*(hurt|affect|impact) sleep)\b/i,
    ],
    papers: ["zeitzer-2000-light", "zeitzer-2005-late-night-light"],
    actionTemplate:
      "Tonight: dim overhead lights to lamp level and switch screens to night mode 2 hours before your target bedtime.",
    notes:
      "Cite Zeitzer 2000 (J Physiol). The non-linear dose-response (~100 lux half-maximal) is the key finding to surface.",
  },

  {
    id: "morning-light",
    label: "Morning light, phase advance, getting outside on waking",
    description: "User asks about morning sun, getting light on waking, morning routine.",
    triggers: [
      /\b(morning (light|sun|sunlight)|light .*(after )?wak(e|ing)|sun .*(after )?wak(e|ing))\b/i,
      /\b(when should I (get|see) (sun)?light|outdoor light .*morning)\b/i,
    ],
    papers: ["zeitzer-2005-late-night-light", "kaplan-2018-rise-and-shine"],
    actionTemplate:
      "Tomorrow: step outside for 10 minutes within 30 minutes of waking, even if the sky is overcast.",
    notes:
      "Morning bright light advances the circadian clock and is the strongest natural zeitgeber. The Kaplan 2018 'Rise and Shine' protocol (light + activity + caffeine) is the structured form.",
  },

  {
    id: "sleep-inertia",
    label: "Sleep inertia / morning grogginess",
    description: "User feels groggy, foggy, slow, or heavy on waking.",
    triggers: [
      /\b(grogg(y|iness)|sleep inertia|fog(gy)? .*(morning|wak)|hard to wak(e|ing) up|takes (me )?(forever|hours) to wake up)\b/i,
      /\b(slow .*(morning|wak)|heavy .*(morning|wak))\b/i,
    ],
    papers: ["hilditch-2019-sleep-inertia", "kaplan-2018-rise-and-shine"],
    actionTemplate:
      "On waking: open the curtains, drink water, and stand or walk for 5 minutes before sitting down. Caffeine 15-20 minutes after rising sharpens the effect.",
    notes:
      "Cite Hilditch 2019 (Nat Sci Sleep). Grogginess is a real, time-limited (15-60 min) state — light + movement + delayed caffeine is the evidence-based countermeasure.",
  },

  {
    id: "daytime-fatigue",
    label: "Persistent daytime tiredness despite adequate sleep duration",
    description:
      "User sleeps 7+ hours but is still tired during the day. May indicate apnea, depression, or low sleep efficiency.",
    triggers: [
      /\b(tired (all|during the) day|daytime (fatigue|tiredness|sleepiness))\b/i,
      /\b(sleep (\d|seven|eight|nine|ten) hours? .*(still|but).*(tired|exhausted|sleepy))\b/i,
      /\b(no energy|exhausted .*day|wiped out)\b/i,
    ],
    papers: ["zeitzer-2013-control", "zeitzer-2007-aging-melatonin"],
    actionTemplate:
      "This week: track your sleep efficiency (time asleep ÷ time in bed). If it's below ~85%, the issue is sleep quality, not duration — and a sleep apnea screening with your doctor is worth scheduling.",
    notes:
      "Be honest: persistent daytime fatigue despite 7+ hours of sleep is a screening flag for sleep apnea (especially with snoring, witnessed pauses, morning headaches), depression, or fragmented sleep. The agent should: (1) acknowledge this is a quality-not-quantity problem, (2) cite Zeitzer 2013 on sleep regulation, (3) gently flag that a sleep medicine consult is appropriate if symptoms persist. Do NOT pretend a single behavioural tweak will fix it.",
  },

  {
    id: "sleep-aging",
    label: "Sleep changes with age (50+/60+/70+)",
    description: "User mentions their age and changes in sleep over time.",
    triggers: [
      /\b(I('?m| am) (5\d|6\d|7\d|8\d)|at (50|55|60|65|70|75|80))\b/i,
      /\b(older|aging|since I (turned|got older)|with age|menopause).*(sleep|wak)/i,
      /\b(sleep .*(changed|harder|worse|lighter) .*(age|older))\b/i,
    ],
    papers: ["zeitzer-2007-aging-melatonin", "zeitzer-2005-late-night-light"],
    actionTemplate:
      "This week: anchor your wake time first — keep it within a 30-minute window every day, even on weekends. The circadian system stabilises around the wake signal more than the bedtime.",
    notes:
      "Cite Zeitzer 2007 (Sleep). Older adults have lower melatonin amplitude but preserved phase — meaning the clock still works, the night-time signal is just quieter. Stronger zeitgebers (morning light, consistent wake time) compensate.",
  },

  {
    id: "shift-work",
    label: "Shift work, night shifts, irregular schedules",
    description: "User works nights, rotating shifts, or otherwise sleeps off-schedule.",
    triggers: [
      /\b(night shift|shift work|rotating shift|graveyard shift|work nights?|overnight shift)\b/i,
    ],
    papers: ["zeitzer-2000-light", "zeitzer-2014-flashes-delay"],
    actionTemplate:
      "On work nights: wear blue-blocking glasses on the commute home and use blackout curtains for daytime sleep. On days off, keep an 'anchor sleep' window of at least 4 hours that overlaps your work-day sleep.",
    notes:
      "Shift workers chronically misalign the circadian clock and the sleep/wake schedule. Light timing is the primary correction tool. Anchor sleep on days off prevents further drift.",
  },

  {
    id: "jet-lag",
    label: "Jet lag, time-zone travel",
    description: "User is travelling across time zones.",
    triggers: [
      /\b(jet ?lag|time ?zone|flying (east|west)|travel(l)?ing to|long flight|cross(ed)? time zones?)\b/i,
    ],
    papers: ["zeitzer-2000-light", "zeitzer-2005-late-night-light"],
    actionTemplate:
      "On arrival: get outside in bright light at the destination's morning if flying east, or destination's evening if flying west. Use blackout shades against light at the wrong time.",
    notes:
      "Light is the dominant zeitgeber. Eastward travel needs morning light at destination; westward travel needs evening light. 0.5-3 mg melatonin at destination bedtime for 2-4 nights is additive.",
  },

  {
    id: "athletic-performance",
    label: "Sleep and athletic performance / training / recovery",
    description:
      "User asks whether sleep helps performance, recovery, strength, speed, reaction time, accuracy, training adaptation — i.e. the benefits side, not the timing side.",
    triggers: [
      /\b(athletic|athlete|sport|sports|performance|recovery|training|train)\b.*\b(sleep|nap|rest|nights?)\b/i,
      /\b(sleep|nap|rest|nights?)\b.*\b(athletic|athlete|sport|sports|performance|recovery|training|train|strength|speed|sprint|reaction time|endurance|accuracy|VO2|adaptation)\b/i,
      /\b(does|how does|prove|evidence|show me|studies?|research)\b.*\b(sleep)\b.*\b(perform|athlete|sport|recover|training|strength|speed|reaction|accuracy|endurance)\b/i,
      /\b(sleep extension|extra sleep|more sleep)\b.*\b(perform|athlete|sport|recover|training|game|race|match)\b/i,
    ],
    papers: [
      "mah-2011-basketball",
      "mah-2008-swimmers",
      "mah-2018-collegiate-athletes",
    ],
    actionTemplate:
      "For the next 7 nights: aim for 10 hours in bed (≈9 hours of sleep). Track how a key performance metric — sprint time, free-throw accuracy, or perceived effort — changes by the end of the week.",
    notes:
      "This is a performance / training / recovery question, NOT an exercise-timing question. Cite Mah 2011 (Stanford / Dement lab, Sleep) as the gold standard — the basketball sleep-extension study quantifying faster sprints, better free-throw and three-point accuracy. Mah 2008 (swimmers) and Mah 2018 (628 collegiate athletes, sleep quality survey) are secondary. Do NOT cite Zeitzer 2011 here — that paper is about whether evening exercise hurts sleep, the inverse question. Be specific with the numbers (16.2→15.5 s sprint, ~9% accuracy gains) — that is what makes this answer feel like a Stanford answer.",
  },

  {
    id: "exercise",
    label: "Exercise timing and sleep",
    description: "User asks whether evening or late workouts hurt sleep.",
    triggers: [
      /\b(exercise|workout|gym|running|run|cycling) .*(sleep|night|bed|evening|late)\b/i,
      /\b(evening (exercise|workout)|late (exercise|workout))\b/i,
    ],
    papers: ["zeitzer-2011-evening-exercise"],
    actionTemplate:
      "Train when it fits your life. If late exercise leaves you wired, leave a 60-minute cool-down window before bed and dim the lights as you do.",
    notes:
      "The evidence (Zeitzer 2011 systematic review) is reassuring: evening exercise does NOT consistently impair sleep for most healthy adults. Don't fearmonger.",
  },
];

// ─── Routing ───────────────────────────────────────────────────────────────
export interface RoutingResult {
  category: KnowledgeCategory;
  papers: SleepPaper[];
}

export function routeQuestion(query: string): RoutingResult | null {
  const text = query.trim();
  if (text.length < 3) return null;

  for (const cat of CATEGORIES) {
    if (cat.triggers.some((re) => re.test(text))) {
      const papers = cat.papers
        .map((id) => PAPERS[id])
        .filter((p): p is SleepPaper => Boolean(p));
      if (papers.length === 0) continue;
      return { category: cat, papers };
    }
  }
  return null;
}

/**
 * Build a ROUTING HINT block to inject into the LLM system prompt or as a
 * system-level message before the user query. This is what stops the agent
 * from defaulting to its single most-anchored paper for every question.
 */
export function buildRoutingHint(result: RoutingResult): string {
  const { category, papers } = result;
  const preferred = papers[0];
  const lines: string[] = [
    "ROUTING HINT (Palonur Sleep Knowledge Map)",
    `Category: ${category.label}`,
    `Routing notes: ${category.notes}`,
    "",
    "Preferred citation for this question:",
    `  ${preferred.authors} (${preferred.year}). ${preferred.journal}.`,
    `  "${preferred.title}"`,
    `  Finding: ${preferred.finding}`,
  ];
  if (papers.length > 1) {
    lines.push("", "Secondary papers you may draw on if more relevant:");
    for (const p of papers.slice(1)) {
      lines.push(
        `  - ${p.authors} (${p.year}). ${p.journal}. "${p.title}" — ${p.finding}`
      );
    }
  }
  lines.push("", `Suggested action template (rewrite to fit the user): ${category.actionTemplate}`);
  lines.push(
    "",
    "You MUST cite the preferred paper unless a secondary paper is a clearly better fit. Do NOT cite a paper from a different category just because it is more familiar."
  );
  return lines.join("\n");
}
