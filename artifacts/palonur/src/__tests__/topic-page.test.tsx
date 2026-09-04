import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { Route } from "wouter";

// ---------------------------------------------------------------------------
// Data-dependent branches of the public /t/:slug topic page:
//   - steward block vs "Coming soon" fallback
//   - sleep's sub-topic links carrying ?q= vs other pillars' /p links
//   - unlinked "Steward coming soon" sub-topic cards when no steward exists
//   - "Meet the stewards" grid filtered to canonical pillars only
//   - 404 → themed NotFound on unknown slug
// ---------------------------------------------------------------------------

import TopicPage from "../pages/topic.js";

interface StewardFixture {
  fullName: string | null;
  institution: string | null;
  photoUrl: string | null;
  achievements?: string[];
  publicationSlug: string | null;
  publicationName: string | null;
}

interface TopicFixture {
  slug: string;
  name: string;
  description: string | null;
  steward: StewardFixture | null;
}

const ZEITZER: StewardFixture = {
  fullName: "Jamie Zeitzer",
  institution: "Stanford University",
  photoUrl: null,
  publicationSlug: "jamie-zeitzer",
  publicationName: "The Sleep Letter",
};

const SLEEP_TOPIC: TopicFixture = {
  slug: "sleep",
  name: "Sleep",
  description: "Sleep answers.",
  steward: ZEITZER,
};

const NUTRITION_STEWARD: StewardFixture = {
  fullName: "Christopher Gardner",
  institution: "Stanford University",
  photoUrl: null,
  publicationSlug: "christopher-gardner",
  publicationName: "Nutrition Notes",
};

const NUTRITION_TOPIC: TopicFixture = {
  slug: "nutrition",
  name: "Nutrition",
  description: "Food, grounded in research.",
  steward: NUTRITION_STEWARD,
};

const MOVEMENT_NO_STEWARD: TopicFixture = {
  slug: "movement",
  name: "Movement",
  description: "Physical activity.",
  steward: null,
};

/**
 * Stub global fetch for the page's three data sources:
 *  - GET /api/topics/:slug → the topic under test (404 when null)
 *  - GET /api/topics       → the all-topics list ("Meet the stewards")
 *  - GET /api/faculty/public/pillars → 500 so useVisiblePillars keeps the
 *    full editorial set (its documented fail-open behavior)
 */
function stubFetch(topic: TopicFixture | null, allTopics: TopicFixture[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (/\/api\/topics\/[^/?]+$/.test(url)) {
        if (!topic) return new Response("{}", { status: 404 });
        return new Response(JSON.stringify({ topic }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/topics")) {
        return new Response(JSON.stringify({ topics: allTopics }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 500 });
    }),
  );
}

function renderTopic(slug: string) {
  window.history.replaceState({}, "", `/t/${slug}`);
  return render(<Route path="/t/:slug" component={TopicPage} />);
}

async function waitLoaded() {
  await waitFor(() => expect(screen.queryByText(/loading/i)).toBeNull());
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("steward block vs coming-soon fallback", () => {
  test("steward present → steward block with publication link", async () => {
    stubFetch(NUTRITION_TOPIC);
    renderTopic("nutrition");
    await waitLoaded();

    const block = screen.getByTestId("topic-steward");
    expect(within(block).getByText("Christopher Gardner")).toBeTruthy();
    const pubLink = screen.getByTestId("topic-publication-link");
    expect(pubLink.getAttribute("href")).toBe("/p/christopher-gardner");
    expect(pubLink.textContent).toMatch(/Read Nutrition Notes/);
    // Primary CTA uses the steward's first name and points at /p.
    const cta = screen.getByTestId("topic-primary-cta");
    expect(cta.getAttribute("href")).toBe("/p/christopher-gardner");
    expect(cta.textContent).toMatch(/Ask Christopher a question/);
    expect(screen.queryByText(/Coming soon/i)).toBeNull();
  });

  test("no steward → coming-soon fallback, no steward block, no primary CTA", async () => {
    stubFetch(MOVEMENT_NO_STEWARD);
    renderTopic("movement");
    await waitLoaded();

    expect(screen.queryByTestId("topic-steward")).toBeNull();
    expect(screen.queryByTestId("topic-primary-cta")).toBeNull();
    expect(screen.queryByTestId("topic-publication-link")).toBeNull();
    expect(
      screen.getByText(/named faculty steward for this pillar is on the way/i),
    ).toBeTruthy();
    expect(screen.getByText(/Join the newsletter/)).toBeTruthy();
  });
});

describe("sub-topic entry points", () => {
  test("sleep sub-topics link to /sleep with a pre-filled ?q=", async () => {
    stubFetch(SLEEP_TOPIC);
    renderTopic("sleep");
    await waitLoaded();

    // Primary CTA keeps sleep's existing consumer surface.
    expect(
      screen.getByTestId("topic-primary-cta").getAttribute("href"),
    ).toBe("/sleep");

    const card = screen.getByTestId("topic-subtopic-Waking at 3am");
    expect(card.tagName).toBe("A");
    const href = card.getAttribute("href") ?? "";
    expect(href.startsWith("/sleep?q=")).toBe(true);
    expect(decodeURIComponent(href.split("?q=")[1])).toBe(
      "Why do I keep waking up at 3am and how does the research explain it?",
    );
    // Every sleep sub-topic card is a link carrying its own question.
    expect(within(card).getByText(/Ask this/)).toBeTruthy();
  });

  test("non-sleep pillar with a steward → sub-topics link to the /p page", async () => {
    stubFetch(NUTRITION_TOPIC);
    renderTopic("nutrition");
    await waitLoaded();

    const subtopics = screen.getByTestId("topic-subtopics");
    const links = subtopics.querySelectorAll("a[data-testid^='topic-subtopic-']");
    expect(links.length).toBeGreaterThan(0);
    for (const a of links) {
      expect(a.getAttribute("href")).toBe("/p/christopher-gardner");
    }
  });

  test("no steward → sub-topic cards render unlinked with 'Steward coming soon'", async () => {
    stubFetch(MOVEMENT_NO_STEWARD);
    renderTopic("movement");
    await waitLoaded();

    const subtopics = screen.getByTestId("topic-subtopics");
    // No anchors at all — cards are plain divs.
    expect(
      subtopics.querySelectorAll("a[data-testid^='topic-subtopic-']").length,
    ).toBe(0);
    const cards = subtopics.querySelectorAll("[data-testid^='topic-subtopic-']");
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card.tagName).not.toBe("A");
      expect(card.textContent).toMatch(/Steward coming soon/);
      expect(card.textContent).not.toMatch(/Ask this/);
    }
  });
});

describe("Meet the stewards grid", () => {
  test("filters to canonical pillars only, in editorial order", async () => {
    stubFetch(SLEEP_TOPIC, [
      // Deliberately out of editorial order + a non-canonical admin pillar.
      NUTRITION_TOPIC,
      { slug: "test-pillar", name: "Test Pillar", description: null, steward: null },
      SLEEP_TOPIC,
      MOVEMENT_NO_STEWARD,
    ]);
    renderTopic("sleep");
    await waitLoaded();

    const grid = await screen.findByTestId("topic-meet-stewards");
    const cards = grid.querySelectorAll("[data-testid^='topic-steward-card-']");
    const slugs = Array.from(cards).map((c) =>
      c.getAttribute("data-testid")!.replace("topic-steward-card-", ""),
    );
    // Non-canonical pillar excluded; canonical ones sorted to editorial order.
    expect(slugs).toEqual(["sleep", "nutrition", "movement"]);
    expect(screen.queryByTestId("topic-steward-card-test-pillar")).toBeNull();

    // Steward-less canonical pillar falls back to the editorial LM pillar
    // Head name (display-only; a real API steward always wins).
    const movementCard = screen.getByTestId("topic-steward-card-movement");
    expect(movementCard.textContent).toMatch(/Anne Friedlander/);
    expect(movementCard.textContent).not.toMatch(/Steward coming soon/);
  });

  test("section omitted when the list API returns no canonical topics", async () => {
    stubFetch(SLEEP_TOPIC, [
      { slug: "test-pillar", name: "Test Pillar", description: null, steward: null },
    ]);
    renderTopic("sleep");
    await waitLoaded();

    expect(screen.queryByTestId("topic-meet-stewards")).toBeNull();
  });
});

describe("unknown slug", () => {
  test("404 from the topic API renders the themed NotFound page", async () => {
    stubFetch(null);
    renderTopic("no-such-pillar");

    expect(
      await screen.findByText(/404 · You've drifted off the page/),
    ).toBeTruthy();
    expect(screen.queryByTestId("topic-title")).toBeNull();
  });
});
