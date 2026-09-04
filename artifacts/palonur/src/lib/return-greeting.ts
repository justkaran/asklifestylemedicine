/**
 * Warm return greetings for returning visitors on the chat surfaces
 * (/sleep top bar, SLM standalone chat
 * reminder). A small set of friendly variants, each with a named and a
 * name-free form, so the copy never feels canned and never renders a
 * blank or "null" name.
 *
 * Copy rules: short sentences, plain language, no em dashes — every variant obeys this in both languages.
 *
 * The variant is rolled once per page load (module-level) so all greetings
 * in one visit agree; tests can pass an explicit roll.
 */

interface GreetingVariant {
  named: (name: string) => string;
  plain: string;
}

const VARIANTS: Record<"en" | "de", GreetingVariant[]> = {
  en: [
    {
      named: (n) => `The day just got better. ${n} is here.`,
      plain: "The day just got better. Welcome back.",
    },
    {
      named: (n) => `Welcome back, ${n}. It is good to see you again.`,
      plain: "Welcome back. It is good to see you again.",
    },
    {
      named: (n) => `Look who is back. Hello again, ${n}.`,
      plain: "Look who is back. Hello again.",
    },
  ],
  de: [
    {
      named: (n) => `Der Tag ist gerade besser geworden. ${n} ist wieder da.`,
      plain: "Der Tag ist gerade besser geworden. Willkommen zurück.",
    },
    {
      named: (n) => `Willkommen zurück, ${n}. Schön, Sie wiederzusehen.`,
      plain: "Willkommen zurück. Schön, Sie wiederzusehen.",
    },
    {
      named: (n) => `Da sind Sie ja wieder. Hallo, ${n}.`,
      plain: "Da sind Sie ja wieder. Hallo.",
    },
  ],
};

/**
 * Normalise a possibly-messy stored name into a greeting-safe first name,
 * or null when there is nothing usable. Rejects empty strings, the literal
 * strings "null"/"undefined" (a serialization bug upstream must never reach
 * the visitor), and anything implausibly long.
 */
export function cleanFirstName(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const first = name.trim().split(/\s+/)[0] ?? "";
  if (!first) return null;
  const lower = first.toLowerCase();
  if (lower === "null" || lower === "undefined") return null;
  if (first.length > 40) return null;
  return first;
}

/** One roll per page load so every surface in a visit shows the same variant. */
let pageRoll: number | null = null;

function rollOf(explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    return Math.abs(Math.floor(explicit));
  }
  if (pageRoll === null) pageRoll = Math.floor(Math.random() * 1000);
  return pageRoll;
}

/**
 * The warm return greeting for this visit. Named form when a usable name is
 * known, name-free form otherwise. `lang` falls back to English for anything
 * that is not German. `roll` pins the variant (tests).
 */
export function warmReturnGreeting(
  name: string | null | undefined,
  lang?: string,
  roll?: number,
): string {
  const list = lang?.toLowerCase().startsWith("de") ? VARIANTS.de : VARIANTS.en;
  const v = list[rollOf(roll) % list.length];
  const clean = cleanFirstName(name);
  return clean ? v.named(clean) : v.plain;
}
