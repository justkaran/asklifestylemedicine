import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Home hero — the instant-value front door for 50+ visitors.
// Contract under guard:
//   - the explicit free-to-ask line ("Free to ask. No account needed.") is
//     rendered,
//   - the hero explains Palonur's authority-router position,
//   - the question field has an explicit visible purpose and action,
//   - none of the new hero copy contains an em dash (50+ plain-language rule),
//   - EN and DE locale files stay in sync on the new keys,
//   - the landing demo visibly ranks a human Palonur Steward and analyzes
//     current topic expertise without leaving the landing page.
// ---------------------------------------------------------------------------

import { BrandHero } from "../pages/home.js";
import { useAskGate } from "../lib/ask-gate.js";
import en from "../locales/en/home.json";
import de from "../locales/de/home.json";

const originalLocation = window.location;

function stubLocation(): { href: string } {
  const fake = { href: "http://localhost/" };
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: fake as unknown as Location,
  });
  return fake;
}

function SharedAskProbe() {
  const { ask } = useAskGate();
  return <button onClick={() => ask("Is cheese nutritious?")}>Ask</button>;
}

beforeEach(() => {
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cleanup();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
});

describe("BrandHero", () => {
  test("renders the explicit free-to-ask line", () => {
    render(<BrandHero />);
    expect(screen.getByTestId("text-hero-free-line").textContent).toMatch(
      /Free to ask\. No account needed\./,
    );
  });

  test("explains Palonur and makes the question action explicit", () => {
    render(<BrandHero />);
    expect(screen.getByTestId("text-hero-headline").textContent).toContain(
      "authority router for the AI era.",
    );
    expect(screen.getByTestId("text-hero-subhead").textContent).toContain(
      "Palonur routes each question to the right human faculty authority, we call them Palonur Stewards, with ownership, sources, and governance attached.",
    );
    expect(screen.getByText("Ask Palonur a question")).toBeTruthy();
    expect(screen.getByTestId("button-hero-ask").textContent).toContain("Ask Palonur");
  });

  test("shows a lean routing chat and the selected Steward source", async () => {
    vi.useFakeTimers();
    const location = stubLocation();
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          question: "Is cheese nutritious?",
          topic: "nutrition and food",
          response:
            "I routed this to Christopher Gardner because his current work focuses on nutrition and dietary patterns.",
          whyThisSteward:
            "His public Stanford profile documents the closest current expertise match.",
          designationClaim:
            "This is Palonur's own Steward designation. A public profile supports current-expertise matching; while we are rolling out our partnerships with leading universities, it does not state that the person or university has accepted, endorsed, or adopted Palonur.",
          stages: [],
          authority: {
            id: "christopher-gardner",
            name: "Christopher Gardner",
            institution: "Stanford",
            field: "nutrition and dietary patterns",
            expertise: "nutrition, food, and dietary-pattern research",
            sourceLabel: "Stanford research profile",
            sourceUrl: "https://profiles.stanford.edu/christopher-gardner",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<BrandHero />);

    const input = screen.getByTestId("input-hero-ask");
    fireEvent.change(input, { target: { value: "Is cheese nutritious?" } });
    fireEvent.click(screen.getByTestId("button-hero-ask"));

    expect(location.href).toBe("http://localhost/");
    expect(screen.getByText("Routing your question...")).toBeTruthy();
    expect(screen.getByText("Is cheese nutritious?")).toBeTruthy();

    for (let step = 0; step < 10; step += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
    }

    expect(screen.getByTestId("landing-authority-demo")).toBeTruthy();
    expect(screen.getByText("Christopher Gardner")).toBeTruthy();
    expect(screen.getByText("Palonur Steward")).toBeTruthy();
    expect(
      screen.getByText(
        /while we are rolling out our partnerships with leading universities/i,
      ),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Stanford research profile" }).getAttribute("href")).toBe(
      "https://profiles.stanford.edu/christopher-gardner",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/landing-demo/route",
      expect.objectContaining({ method: "POST" }),
    );
    expect(location.href).not.toContain("/slm?");
  });

  test("keeps follow-up questions inside the same chat", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            question: "Why do I wake up at night?",
            topic: "sleep and biological timing",
            response:
              "I routed this to Jamie Zeitzer because his work focuses on sleep and circadian timing.",
            whyThisSteward:
              "His public Stanford profile documents the closest current expertise match.",
            designationClaim:
              "This is Palonur's own Steward designation. A public profile supports current-expertise matching; while we are rolling out our partnerships with leading universities, it does not state that the person or university has accepted, endorsed, or adopted Palonur.",
            stages: [],
            authority: {
              id: "jamie-zeitzer",
              name: "Jamie Zeitzer",
              institution: "Stanford",
              field: "sleep and circadian science",
              expertise: "sleep, circadian timing, and light",
              sourceLabel: "Stanford research profile",
              sourceUrl: "https://profiles.stanford.edu/jamie-zeitzer",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            question: "Does morning light help?",
            answer:
              "Morning light can help shift circadian timing, but the useful timing depends on your sleep pattern.",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    render(<BrandHero />);

    fireEvent.change(screen.getByTestId("input-hero-ask"), {
      target: { value: "Why do I wake up at night?" },
    });
    fireEvent.click(screen.getByTestId("button-hero-ask"));

    for (let step = 0; step < 10; step += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
    }

    expect(screen.getByText("Jamie Zeitzer")).toBeTruthy();
    fireEvent.change(screen.getByTestId("input-landing-demo-follow-up"), {
      target: { value: "Does morning light help?" },
    });
    fireEvent.click(screen.getByTestId("button-landing-demo-follow-up"));

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("Does morning light help?")).toBeTruthy();
    expect(
      screen.getByText(/Morning light can help shift circadian timing/i),
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/landing-demo/follow-up",
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("keeps the shared default on the isolated ASLM route", () => {
    const location = stubLocation();
    render(<SharedAskProbe />);

    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    expect(location.href).toContain("/slm?q=Is%20cheese%20nutritious%3F");
    expect(location.href).not.toContain("/sleep?");
  });

  test("new hero copy has no em dashes and DE stays in sync", () => {
    for (const locale of [en, de] as Array<Record<string, any>>) {
      const hero = locale.hero as Record<string, unknown>;
      expect(typeof hero.freeLine, "freeLine missing").toBe("string");
      expect(hero.freeLine as string).not.toContain("—");
      expect(typeof hero.headline, "headline missing").toBe("string");
      expect(typeof hero.inputLabel, "inputLabel missing").toBe("string");
      expect(typeof hero.askLabel, "askLabel missing").toBe("string");
      expect(typeof hero.askButton, "askButton missing").toBe("string");
      const landingDemo = locale.landingDemo as Record<string, unknown>;
      expect(typeof landingDemo.currentExpertiseLabel, "current expertise label missing").toBe("string");
      expect(typeof landingDemo.disclaimer, "disclaimer missing").toBe("string");
    }
  });
});
