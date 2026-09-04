import { beforeAll, describe, test, expect } from "vitest";
import { db, pillarsTable } from "@workspace/db";
import {
  routePillars,
  PILLAR_KEYWORDS,
  ROUTING_KEYWORDS,
} from "../lib/pillarRouter.js";

// Regression guard: the palonur home hero's default night question is
// auto-generated as "Why am I awake at <clock time>?" and MUST route to the
// sleep pillar. It once fell through both keyword routers (\bwake\b cannot
// match inside "awake") and fanned out to all pillars, which made the model
// nondeterministically answer UNCOVERED for the very question the product
// asks on the reader's behalf.
describe("routePillars — sleep keyword routing", () => {
  beforeAll(async () => {
    // Shared dev DB: the sleep pillar is normally boot-seeded, but another
    // suite's TRUNCATE ... CASCADE can wipe it mid-run. Re-ensure idempotently.
    await db
      .insert(pillarsTable)
      .values({ slug: "sleep", name: "Sleep" })
      .onConflictDoNothing({ target: pillarsTable.slug });
  });

  test.each([
    "Why am I awake at 22:21?", // 24-hour clock, no am/pm marker
    "Why am I awake at 22.21?", // period-separator locales
    "Why am I awake at 3:04 a.m.?",
    "Why am I so tired at 7:46 p.m.?", // daytime default question
    "I feel wakeful every night",
    "My sleepless nights are getting worse",
  ])("routes %j to the sleep pillar without fallback", async (q) => {
    const route = await routePillars(q);
    expect(route.fallback).toBe(false);
    expect(route.pillars.some((p) => p.slug === "sleep")).toBe(true);
  });

  test("unrelated question falls back to all pillars", async () => {
    const route = await routePillars("What is the capital of France?");
    expect(route.fallback).toBe(true);
  });
});

// The four SLM pillars with substantial approved corpora (plus autism) once
// had NO keyword entries at all, so every stress / focus / friendship /
// gratitude question fanned out to all pillars, retrieval diluted, and the
// reader frequently got the sleep-only legacy refusal — the "it only answers
// sleep questions" complaint. These pins keep them routable.
describe("routePillars — remaining canonical pillar routing", () => {
  beforeAll(async () => {
    await db
      .insert(pillarsTable)
      .values([
        { slug: "sleep", name: "Sleep" },
        { slug: "stress-management", name: "Stress Management" },
        { slug: "cognitive-enhancement", name: "Cognitive Enhancement" },
        { slug: "social-connection", name: "Social Connection" },
        { slug: "gratitude-purpose", name: "Gratitude & Purpose" },
        { slug: "autism", name: "Autism" },
      ])
      .onConflictDoNothing({ target: pillarsTable.slug });
  });

  test.each([
    ["How do I manage stress at work?", "stress-management"],
    ["I feel burned out and overwhelmed", "stress-management"],
    ["Does meditation actually lower cortisol?", "stress-management"],
    ["How can I improve my focus and concentration?", "cognitive-enhancement"],
    ["What causes brain fog?", "cognitive-enhancement"],
    ["How do I improve my memory as I get older?", "cognitive-enhancement"],
    ["Why are friendships important for health?", "social-connection"],
    ["How does social isolation affect the body?", "social-connection"],
    ["Does a gratitude practice really work?", "gratitude-purpose"],
    ["How do I find meaning in life after retiring?", "gratitude-purpose"],
    ["What does oxytocin have to do with autism?", "autism"],
  ])("routes %j to %s without fallback", async (q, slug) => {
    const route = await routePillars(q);
    expect(route.fallback).toBe(false);
    expect(route.pillars.some((p) => p.slug === slug)).toBe(true);
  });

  test("stress + sleep question routes to BOTH pillars", async () => {
    const route = await routePillars(
      "Stress keeps me up at night, how do I fall asleep?",
    );
    expect(route.fallback).toBe(false);
    const slugs = route.pillars.map((p) => p.slug);
    expect(slugs).toContain("sleep");
    expect(slugs).toContain("stress-management");
  });
});

// Drift guard: ROUTING_KEYWORDS is the human-readable display copy shown on
// the faculty admin Pillars page; PILLAR_KEYWORDS is the matching source of
// truth. Every display term must actually match its pillar's regex set, and
// every display slug must exist in the regex map — otherwise the admin page
// would advertise routing behavior the router doesn't have.
describe("ROUTING_KEYWORDS ↔ PILLAR_KEYWORDS drift guard", () => {
  test("every display slug has a regex entry", () => {
    for (const slug of Object.keys(ROUTING_KEYWORDS)) {
      expect(
        PILLAR_KEYWORDS[slug],
        `missing regex set for ${slug}`,
      ).toBeDefined();
    }
  });

  test("every display term matches its pillar's regex set", () => {
    for (const [slug, terms] of Object.entries(ROUTING_KEYWORDS)) {
      const patterns = PILLAR_KEYWORDS[slug] ?? [];
      for (const term of terms) {
        const matches = patterns.some((re) => re.test(term));
        expect(matches, `"${term}" does not match ${slug} regexes`).toBe(true);
      }
    }
  });
});
