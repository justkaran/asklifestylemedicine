// Editorial constant for the public Stanford Lifestyle Medicine pillar
// showcase (homepage strip + /pillars page). Hand-curated copy, following
// the faculty landing's LANDING_PILLARS precedent: the frontend owns the
// story; the anonymous public-pillars API is only used to auto-hide pillars
// that have been retired. Never add steward identity to any API response —
// any names here are editorial frontend copy only.

import { useEffect, useState } from "react";

const BASE = import.meta.env.BASE_URL;

export type ConsumerPillar = {
  slug: string;
  name: string;
  /** Public asset path (already base-prefixed). */
  art: string;
  /** One-sentence consumer description. */
  description: string;
  /** Named steward(s) — editorial only, never from the API. */
  steward?: string;
  /** Circular headshot shown at the top of the pillar card. */
  stewardPhoto?: string;
  /** Live today on palonur.com? */
  live: boolean;
  /** Where a live pillar's consumer surface lives. */
  href?: string;
  /** Label for the live link. */
  linkLabel?: string;
};

const art = (name: string): string => `${BASE}pillars/${name}.png`;

export const CONSUMER_PILLARS: ConsumerPillar[] = [
  {
    slug: "sleep",
    name: "Sleep",
    art: art("editorial-sleep"),
    description:
      "Poor sleep accelerates cognitive decline, raises blood pressure, and ages the brain faster. Most advice gets it wrong after 50.",
    steward: "Dr. Jamie Zeitzer, Stanford",
    stewardPhoto: `${BASE}stewards/zeitzer.png`,
    live: true,
    href: `${BASE}sleep`,
    linkLabel: "Ask a sleep question →",
  },
  {
    slug: "stress-management",
    name: "Stress Management",
    art: art("editorial-stress-management"),
    description:
      "Chronic stress shortens telomeres and drives inflammation. The way it compounds with age is rarely explained clearly.",
    steward: "Dr. Sarah Meyer Tapia, Stanford",
    stewardPhoto: `${BASE}stewards/sarah-meyer-tapia.jpg`,
    live: true,
    href: `${BASE}slm`,
    linkLabel: "Ask a question →",
  },
  {
    slug: "nutrition",
    name: "Nutrition",
    art: art("editorial-nutrition"),
    description:
      "Nutritional needs shift significantly after 50. What worked at 35 may be working against you now.",
    steward: "Dr. Marily Oppezzo, Stanford",
    stewardPhoto: `${BASE}stewards/marily-oppezzo.jpg`,
    live: true,
    href: `${BASE}slm`,
    linkLabel: "Ask a question →",
  },
  {
    slug: "movement",
    name: "Movement",
    art: art("editorial-movement"),
    description:
      "Muscle loss starts at 40 and accelerates fast. The right movement slows it. The wrong kind can't.",
    steward: "Drs. Fredericson & Friedlander, Stanford",
    stewardPhoto: `${BASE}stewards/michael-fredericson.jpg`,
    live: true,
    href: `${BASE}slm`,
    linkLabel: "Ask a question →",
  },
  {
    slug: "social-connection",
    name: "Social Engagement",
    art: art("editorial-social-connection"),
    description:
      "Social isolation raises dementia risk more than smoking. Staying connected is a medical decision, not a lifestyle one.",
    steward: "Steven Crane, Stanford",
    live: true,
    href: `${BASE}slm`,
    linkLabel: "Ask a question →",
  },
  {
    slug: "cognitive-enhancement",
    name: "Cognitive Enhancement",
    art: art("editorial-cognitive-enhancement"),
    description:
      "Memory lapses feel alarming after 50. Most are normal. Some signal something you can act on now.",
    steward: "Shaliza Shorey, Stanford",
    stewardPhoto: `${BASE}stewards/shaliza-shorey.jpg`,
    live: true,
    href: `${BASE}slm`,
    linkLabel: "Ask a question →",
  },
  {
    slug: "gratitude-purpose",
    name: "Gratitude & Purpose",
    art: art("editorial-gratitude-purpose"),
    description:
      "People with a clear sense of purpose live longer and recover from illness faster. The research is more specific than most expect.",
    steward: "Bruce Feldstein & Barbara Waxman, Stanford",
    live: true,
    href: `${BASE}slm`,
    linkLabel: "Ask a question →",
  },
];

/**
 * Shared hook for both surfaces (homepage strip + /pillars page): renders the
 * editorial set immediately, then swaps in the API-filtered set so retired
 * pillars auto-hide everywhere.
 */
export function useVisiblePillars(): ConsumerPillar[] {
  const [pillars, setPillars] = useState<ConsumerPillar[]>(CONSUMER_PILLARS);
  useEffect(() => {
    let alive = true;
    loadVisiblePillars().then((v) => {
      if (alive) setPillars(v);
    });
    return () => {
      alive = false;
    };
  }, []);
  return pillars;
}

export async function loadVisiblePillars(): Promise<ConsumerPillar[]> {
  try {
    const res = await fetch("/api/faculty/public/pillars");
    if (!res.ok) return CONSUMER_PILLARS;
    const data = (await res.json()) as {
      pillars?: { slug: string }[];
    };
    if (!Array.isArray(data.pillars)) return CONSUMER_PILLARS;
    const active = new Set(data.pillars.map((p) => p.slug));
    return CONSUMER_PILLARS.filter((p) => active.has(p.slug));
  } catch {
    return CONSUMER_PILLARS;
  }
}
