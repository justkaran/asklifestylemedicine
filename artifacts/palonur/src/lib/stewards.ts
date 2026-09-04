// ─── Steward spotlight (brand home) ────────────────────────────────────────────
// Hand-curated, like team.ts: steward identity on the consumer home page is an
// explicit product decision (topic pages already expose the same identity
// publicly). Never source this from /api/faculty/public/pillars — that endpoint
// is deliberately steward-free. Each steward ships a curated static headshot
// (public/stewards/*) so all cards show a real face regardless of pillar
// status; a runtime /api/topics photo (matched by surname) overrides it when
// present, and the monogram remains the fallback for any missing photo.

const BASE = import.meta.env.BASE_URL;

export type StewardSpotlight = {
  /** Surname used to match a photo from the public topics API. */
  surname: string;
  /** Curated static headshot; runtime /api/topics photo overrides when present. */
  photoUrl?: string;
  name: string;
  credentials: string;
  title: string;
  blurb: string;
  /** Where the promise gets concrete. Null = no live surface yet. */
  href: string | null;
  linkLabel: string | null;
  /** Shown instead of a link when href is null. */
  comingSoon?: string;
};

// ─── Steward portraits (answer surfaces) ──────────────────────────────────────
// Curated static headshots keyed by surname, used wherever the API returns a
// steward without a photoUrl (dev DBs, un-onboarded stewards). A runtime
// photoUrl always wins; the monogram stays the fallback for unknown names.
const PORTRAIT_BY_SURNAME: ReadonlyArray<readonly [string, string]> = [
  ["zeitzer", `${BASE}stewards/jamie-zeitzer.jpg`],
  ["tapia", `${BASE}stewards/sarah-meyer-tapia.jpg`],
  ["fredericson", `${BASE}stewards/michael-fredericson.jpg`],
  ["friedlander", `${BASE}stewards/anne-friedlander.jpg`],
  ["oppezzo", `${BASE}stewards/marily-oppezzo.jpg`],
  ["shorey", `${BASE}stewards/shaliza-shorey.jpg`],
  ["parker", `${BASE}stewards/karen-parker.jpg`],
];

/** Curated portrait for a steward full name, or null (→ monogram fallback). */
export function stewardPortraitUrl(
  fullName: string | null | undefined,
): string | null {
  if (!fullName) return null;
  const lower = fullName.toLowerCase();
  for (const [surname, url] of PORTRAIT_BY_SURNAME) {
    if (lower.includes(surname)) return url;
  }
  return null;
}

export const STEWARD_SPOTLIGHT: StewardSpotlight[] = [
  {
    surname: "Fredericson",
    photoUrl: `${BASE}stewards/fredericson.jpg`,
    name: "Michael Fredericson",
    credentials: "MD",
    title: "Director, Stanford Lifestyle Medicine · Sports-medicine physician",
    blurb:
      "Chief Medical Officer of USA Track & Field and professor of Physical Medicine & Rehabilitation, he has kept Olympians moving for decades. He leads Stanford Lifestyle Medicine — and now his movement research answers you directly.",
    href: `${BASE}t/movement`,
    linkLabel: "Explore Movement & Exercise",
  },
  {
    surname: "Friedlander",
    photoUrl: `${BASE}stewards/friedlander.jpg`,
    name: "Anne Friedlander",
    credentials: "PhD",
    title: "Co-Director, Stanford Lifestyle Medicine · Exercise physiologist",
    blurb:
      "An NIH-funded exercise physiologist who studies how movement slows aging, she co-directs the Lifestyle Medicine fellowship that trains the next generation of physicians. Her science of staying strong is open to your questions.",
    href: `${BASE}t/movement`,
    linkLabel: "Explore Movement & Exercise",
  },
  {
    surname: "Zeitzer",
    photoUrl: `${BASE}stewards/zeitzer.png`,
    name: "Jamie Zeitzer",
    credentials: "PhD",
    title:
      "Sleep & circadian scientist · Co-Director, Center for Sleep Research",
    blurb:
      "He has advised NASA on astronaut sleep and runs the Zeitzer Lab at Stanford, one of the world's leading circadian labs. Every sleep answer on Palonur is drawn from his lab's published research and carries his name — ask it anything, tonight.",
    href: `${BASE}sleep`,
    linkLabel: "Ask his research now",
  },
  {
    surname: "Parker",
    photoUrl: `${BASE}stewards/parker.jpg`,
    name: "Karen Parker",
    credentials: "PhD",
    title: "Psychiatry & Behavioral Sciences researcher",
    blurb:
      "A Stanford lab director, Kavli Fellow, and Simons Foundation and Department of Defense-backed neuroscientist studying the social brain. Her pillar is being prepared with the same care as the rest.",
    href: null,
    linkLabel: null,
    comingSoon: "Her pillar opens soon",
  },
];
