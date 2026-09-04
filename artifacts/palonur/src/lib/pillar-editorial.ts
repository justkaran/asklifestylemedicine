// Hand-curated editorial content for the public pillar topic pages
// (/t/:slug). Follows the CONSUMER_PILLARS precedent: the frontend owns the
// story. No steward identity here — steward data comes only from the
// /api/topics endpoints, where exposing it is an explicit product decision.
//
// Health copy is intentionally factual and non-alarmist: it describes what
// the research literature documents, never gives advice, and always funnels
// readers into the citation-first ask surface.

const BASE = import.meta.env.BASE_URL;

export type SubTopic = {
  /** Short editorial label shown on the card. */
  label: string;
  /** The question pre-filled into the ask surface. */
  question: string;
};

export type PillarEditorial = {
  slug: string;
  /** Wide editorial hero/section image (public asset path). */
  heroArt: string;
  /** Section image for "Why this matters" (public asset path). */
  whyArt: string;
  /** Section image for "What's at risk" (public asset path). */
  riskArt: string;
  /** Wide banner image for the sub-topics section (public asset path). */
  askArt: string;
  /** One-line editorial dek under the pillar name. */
  dek: string;
  /** "Why this matters" — the health case, 2 short paragraphs. */
  whyItMatters: string[];
  /** "What's at risk" — documented consequences of neglect, 2 paragraphs. */
  atRisk: string[];
  /** Sub-topic entry points that funnel into the ask surface. */
  subTopics: SubTopic[];
};

const heroArt = (slug: string): string => `${BASE}pillars/editorial-${slug}.png`;
const whyArt = (slug: string): string => `${BASE}pillars/why-${slug}.png`;
const riskArt = (slug: string): string => `${BASE}pillars/risk-${slug}.png`;
const askArt = (slug: string): string => `${BASE}pillars/ask-${slug}.png`;

export const PILLAR_EDITORIAL: PillarEditorial[] = [
  {
    slug: "sleep",
    heroArt: heroArt("sleep"),
    whyArt: whyArt("sleep"),
    riskArt: riskArt("sleep"),
    askArt: askArt("sleep"),
    dek: "The nightly repair cycle every other pillar depends on.",
    whyItMatters: [
      "Sleep is when the body consolidates memory, regulates hormones, clears metabolic byproducts from the brain, and resets the immune system. Decades of research link consistent, sufficient sleep to better cardiovascular health, mood stability, learning, and metabolic function.",
      "It is also the pillar most people try to fix with the least reliable information. The research on circadian timing, light exposure, and sleep architecture is deep — but it rarely survives the trip through headlines and feeds intact.",
    ],
    atRisk: [
      "The literature documents associations between chronically short or fragmented sleep and higher rates of hypertension, impaired glucose regulation, weight gain, and depressed mood. Attention, reaction time, and decision-making measurably decline after even a single night of restricted sleep.",
      "None of this means one bad night is dangerous — the research is about patterns over time, and the honest picture includes plenty of open questions. That is exactly why answers here come with citations you can check.",
    ],
    subTopics: [
      { label: "Waking at 3am", question: "Why do I keep waking up at 3am and how does the research explain it?" },
      { label: "Light & the body clock", question: "How does light exposure during the day and evening affect my sleep?" },
      { label: "Caffeine timing", question: "What does the research say about how late in the day caffeine affects sleep?" },
      { label: "Sleep & memory", question: "What does the research say about how sleep affects memory and learning?" },
    ],
  },
  {
    slug: "stress-management",
    heroArt: heroArt("stress-management"),
    whyArt: whyArt("stress-management"),
    riskArt: riskArt("stress-management"),
    askArt: askArt("stress-management"),
    dek: "Not the absence of stress — the ability to recover from it.",
    whyItMatters: [
      "The stress response itself is healthy and ancient; the problem the research points to is a response that never switches off. How quickly heart rate, cortisol, and attention return to baseline after a stressor predicts more about long-term health than the stressor itself.",
      "Research on breathing practices, cognitive reframing, and recovery habits shows these are trainable skills — measurable in physiology, not just mood.",
    ],
    atRisk: [
      "Chronic, unrecovered stress is associated in the literature with elevated blood pressure, disrupted sleep, impaired immune response, and higher rates of anxiety and depression. It also quietly erodes the other pillars: stressed people sleep worse, eat worse, and move less.",
      "The research is careful here, and so are we: stress is not a moral failing, and not every technique works for every person. The honest answer is what the studies actually measured.",
    ],
    subTopics: [
      { label: "Breath & the nervous system", question: "What does the research say about breathing exercises and the stress response?" },
      { label: "Stress & sleep", question: "How does chronic stress affect sleep, according to the research?" },
      { label: "Measuring recovery", question: "What does research say about heart rate variability as a measure of stress recovery?" },
    ],
  },
  {
    slug: "nutrition",
    heroArt: heroArt("nutrition"),
    whyArt: whyArt("nutrition"),
    riskArt: riskArt("nutrition"),
    askArt: askArt("nutrition"),
    dek: "The most contested pillar — and the one most in need of citations.",
    whyItMatters: [
      "Dietary pattern is among the strongest modifiable predictors of long-term health in the epidemiological literature — linked to cardiovascular outcomes, metabolic health, and healthy aging across large cohort studies spanning decades.",
      "It is also the noisiest corner of health information. A single study becomes a headline becomes a rule, stripped of dose, population, and confidence. Nutrition is where 'ask the scientist, get the citation' matters most.",
    ],
    atRisk: [
      "Diets low in whole foods and high in ultra-processed foods are consistently associated in the research with higher rates of type 2 diabetes, cardiovascular disease, and all-cause mortality. Fiber intake, in particular, tracks with outcomes across dozens of large studies.",
      "But nutrition science is genuinely hard — observational, confounded, slow. The honest picture includes what the research cannot yet say, and answers here will tell you when that is the case.",
    ],
    subTopics: [
      { label: "Ultra-processed foods", question: "What does the research actually say about ultra-processed foods and health?" },
      { label: "Meal timing", question: "What does research say about when we eat — meal timing and time-restricted eating?" },
      { label: "Fiber & the gut", question: "What does the research say about dietary fiber and long-term health?" },
    ],
  },
  {
    slug: "movement",
    heroArt: heroArt("movement"),
    whyArt: whyArt("movement"),
    riskArt: riskArt("movement"),
    askArt: askArt("movement"),
    dek: "The closest thing the research has to a universal prescription.",
    whyItMatters: [
      "Regular physical activity shows up in the literature as protective across nearly every system measured: cardiovascular, metabolic, musculoskeletal, cognitive, and mood. The dose-response curve is steepest at the bottom — the biggest documented gains come from moving at all versus not moving.",
      "Strength, in particular, has moved to the center of the aging research: muscle mass and grip strength are among the better predictors of independence and resilience in later life.",
    ],
    atRisk: [
      "Prolonged inactivity is associated in the research with faster loss of muscle mass after 50, declining bone density, reduced insulin sensitivity, and higher rates of cardiovascular disease. Sedentary time appears to carry risk even in people who exercise.",
      "The encouraging counterpoint, also documented: much of this is responsive to change at any age. Strength training studies in adults in their 70s and beyond still show meaningful gains.",
    ],
    subTopics: [
      { label: "Strength after 50", question: "What does the research say about building strength after age 50?" },
      { label: "Daily steps", question: "What does the research actually show about daily step counts and health?" },
      { label: "Exercise & sleep", question: "How does exercise affect sleep quality, according to the research?" },
    ],
  },
  {
    slug: "social-connection",
    heroArt: heroArt("social-connection"),
    whyArt: whyArt("social-connection"),
    riskArt: riskArt("social-connection"),
    askArt: askArt("social-connection"),
    dek: "Relationships are a health behavior, not a soft one.",
    whyItMatters: [
      "The strength of a person's social ties is one of the more robust predictors of longevity in the epidemiological literature — on the same order as established clinical risk factors in several large meta-analyses.",
      "The research goes beyond loneliness surveys: social integration shows measurable associations with immune function, cardiovascular markers, cognitive resilience, and recovery from illness.",
    ],
    atRisk: [
      "Chronic social isolation and loneliness are associated in the literature with higher rates of cardiovascular disease, depression, cognitive decline, and earlier mortality. These associations persist after controlling for many of the usual confounders.",
      "The research is equally clear that quality matters more than quantity, and that connection is buildable — which is precisely the kind of nuance that gets lost between the study and the headline.",
    ],
    subTopics: [
      { label: "Loneliness & longevity", question: "What does the research say about loneliness and long-term health?" },
      { label: "Connection & the brain", question: "How does social connection affect cognitive health, according to the research?" },
    ],
  },
  {
    slug: "cognitive-enhancement",
    heroArt: heroArt("cognitive-enhancement"),
    whyArt: whyArt("cognitive-enhancement"),
    riskArt: riskArt("cognitive-enhancement"),
    askArt: askArt("cognitive-enhancement"),
    dek: "What the research says actually keeps a mind sharp.",
    whyItMatters: [
      "Cognitive health research has converged on a hopeful finding: the brain remains plastic across the lifespan, and the behaviors associated with preserving attention, memory, and processing speed are largely the other pillars — sleep, movement, connection — plus sustained mental challenge.",
      "That makes this pillar the integration point. The literature on cognitive reserve suggests decades of everyday habits shape how the brain weathers aging.",
    ],
    atRisk: [
      "The research associates chronic sleep loss, inactivity, and isolation with faster age-related cognitive decline. Untreated hearing loss and cardiovascular risk factors in midlife also appear repeatedly in the dementia-risk literature.",
      "What the research does not support is most of what is sold as 'brain training.' The honest picture separates the well-documented from the well-marketed — with citations.",
    ],
    subTopics: [
      { label: "Memory & aging", question: "What does the research say about normal memory change with age versus decline?" },
      { label: "Brain training claims", question: "What does the research actually show about brain-training games and cognition?" },
      { label: "Sleep & the aging brain", question: "How does sleep affect long-term brain health, according to the research?" },
    ],
  },
  {
    slug: "gratitude-purpose",
    heroArt: heroArt("gratitude-purpose"),
    whyArt: whyArt("gratitude-purpose"),
    riskArt: riskArt("gratitude-purpose"),
    askArt: askArt("gratitude-purpose"),
    dek: "The science of meaning — measured, not preached.",
    whyItMatters: [
      "A sense of purpose is not just a feeling; in longitudinal studies it is associated with lower mortality, better sleep, more physical activity, and greater resilience after setbacks. Gratitude practices, studied in controlled trials, show measurable effects on mood and sleep quality.",
      "This is one of the younger pillars of lifestyle medicine, which makes rigor matter more, not less: the field is easy to oversell and the honest effect sizes deserve to be reported as they are.",
    ],
    atRisk: [
      "Low sense of purpose is associated in the research with higher rates of depression, poorer sleep, and reduced engagement in the health behaviors that drive the other pillars. Purpose appears to function partly as the motivation layer underneath everything else.",
      "The research also cautions against overclaiming: gratitude is not a treatment, and no journaling practice replaces care. Answers here will tell you what the studies measured and what they did not.",
    ],
    subTopics: [
      { label: "Purpose & longevity", question: "What does the research say about sense of purpose and longevity?" },
      { label: "Gratitude practices", question: "What do controlled studies actually show about gratitude practices?" },
    ],
  },
];

export function pillarEditorialFor(slug: string): PillarEditorial | null {
  return PILLAR_EDITORIAL.find((p) => p.slug === slug) ?? null;
}
