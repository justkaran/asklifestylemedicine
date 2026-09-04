/**
 * Maps the visitor's sleep question to a topic key so the 7-nights journey
 * invite can speak to what they actually asked about, instead of the generic
 * "if this changes over 7 nights" line.
 *
 * Returns one of the topic keys under
 * `sleepAgent.answer.journey.inviteHeadingTopics.*` in the locale files, or
 * null when no topic matches (caller falls back to the generic heading).
 *
 * Keyword lists cover both English and German because the question text
 * arrives in the visitor's language. Order matters: more specific topics
 * (caffeine, alcohol, screens) are checked before the broad sleep-pattern
 * ones so "does coffee keep me from falling asleep" lands on caffeine.
 */
export type JourneyInviteTopic =
  | "caffeine"
  | "alcohol"
  | "screens"
  | "dreams"
  | "wake3am"
  | "earlyWake"
  | "fallAsleep"
  | "daytime";

const TOPIC_PATTERNS: Array<[JourneyInviteTopic, RegExp]> = [
  ["caffeine", /\b(caffeine|coffee|espresso|energy drink|koffein|kaffee|energydrink)\b/i],
  ["alcohol", /\b(alcohol|wine|beer|nightcap|alkohol|wein|bier|schlummertrunk)\b/i],
  ["screens", /\b(screen|phone|scrolling|doomscroll\w*|tiktok|instagram|bildschirm|handy|smartphone|scrollen)\b/i],
  ["dreams", /\b(dream[s]?|dreaming|nightmare[s]?|traum|träume[n]?|albtraum|albträume[n]?|alptraum|alpträume[n]?)\b/i],
  [
    "wake3am",
    /\b(3\s?(am|a\.m\.)|3\s?uhr|drei uhr|middle of the night|wake (up )?(at|during) night|night waking[s]?|mitten in der nacht|nachts (immer wieder )?(auf|wach)|nächtliche[sn]? (aufwachen|erwachen)|wache? (jede )?nacht|durchschlafen|durchzuschlafen)\b/i,
  ],
  [
    "earlyWake",
    /\b(too early|wake (up )?(too )?early|early waking|zu früh|(wache|aufwachen) .{0,20}früh|früh (auf|wach))\b/i,
  ],
  [
    "fallAsleep",
    /\b(fall(ing)? asleep|can'?t (get to )?sleep|racing (mind|thoughts)|insomnia|einschlafen|nicht (ein)?schlafen|gedankenkarussell|schlaflos\w*)\b/i,
  ],
  [
    "daytime",
    /\b(tired|exhausted|fatigue[d]?|energy|sleepy during|müde|erschöpft|energie|tagsüber)\b/i,
  ],
];

export function journeyInviteTopic(question: string): JourneyInviteTopic | null {
  const q = question.trim();
  if (!q) return null;
  for (const [topic, pattern] of TOPIC_PATTERNS) {
    if (pattern.test(q)) return topic;
  }
  return null;
}
