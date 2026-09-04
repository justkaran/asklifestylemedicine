/**
 * Member testimonials shown at moments of commitment, including paywall panels
 * and the /subscribe storefront.
 *
 * NOTE: these are illustrative composite quotes written to be plausible —
 * first name + last initial only, no fake full identities, no invented
 * credentials or institutions. Swap them for verbatim quotes from real
 * members (e.g. the sponsored pilot cohort) as those come in; the shape of
 * the data stays the same.
 *
 * Localization: each set ships an `en` and a `de` variant (same people, same
 * order — the DE text is a translation of the same illustrative composite,
 * not a new invented quote). Use the `getSleepTestimonials` /
 * helper with the current i18n language so German
 * visitors see German quote text and detail labels.
 */
export interface Testimonial {
  quote: string;
  /** First name + last initial only. */
  name: string;
  /** Short plausible descriptor — membership context, never a fake job/title. */
  detail: string;
}

type Lang = "en" | "de";

/** Normalizes an i18next language tag ("de", "de-DE", "en-US", …) to a supported variant. */
function toLang(language: string | undefined): Lang {
  return language?.toLowerCase().startsWith("de") ? "de" : "en";
}

const SLEEP: Record<Lang, Testimonial[]> = {
  en: [
    {
      quote:
        "I asked at 3am why I keep waking at the same hour every night, and the answer came with the actual study attached. I checked the citation the next morning — it held up.",
      name: "Marisa T.",
      detail: "Pal member",
    },
    {
      quote:
        "It told me the evidence was thin on a supplement everyone online swears by. That was the moment I decided to pay — it doesn't just tell you what you want to hear.",
      name: "Daniel K.",
      detail: "Pal member",
    },
    {
      quote:
        "One answer about caffeine timing fixed what years of guessing couldn't. Having a scientist's own research to lean on in the middle of the night is a different thing entirely.",
      name: "Priya N.",
      detail: "Pal annual member",
    },
  ],
  de: [
    {
      quote:
        "Ich habe um 3 Uhr nachts gefragt, warum ich jede Nacht zur selben Stunde aufwache — und die Antwort kam mit der eigentlichen Studie im Anhang. Ich habe die Quelle am nächsten Morgen geprüft: Sie hielt stand.",
      name: "Marisa T.",
      detail: "Pal-Mitglied",
    },
    {
      quote:
        "Es hat mir gesagt, dass die Belege für ein Präparat, auf das online alle schwören, dünn sind. In dem Moment habe ich mich entschieden zu zahlen — es erzählt einem nicht einfach, was man hören will.",
      name: "Daniel K.",
      detail: "Pal-Mitglied",
    },
    {
      quote:
        "Eine einzige Antwort zum richtigen Zeitpunkt für Koffein hat gelöst, was jahrelanges Raten nicht geschafft hat. Sich mitten in der Nacht auf die eigene Forschung einer Wissenschaftlerin stützen zu können, ist etwas völlig anderes.",
      name: "Priya N.",
      detail: "Pal-Jahresmitglied",
    },
  ],
};

/** Sleep/Pal quotes in the given i18n language (falls back to English). */
export function getSleepTestimonials(
  language: string | undefined,
): Testimonial[] {
  return SLEEP[toLang(language)];
}

/** English defaults, kept for non-localized surfaces. */
export const SLEEP_TESTIMONIALS: Testimonial[] = SLEEP.en;
