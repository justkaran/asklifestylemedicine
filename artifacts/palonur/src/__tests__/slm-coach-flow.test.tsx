import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("../lib/app-mode", () => ({ SLM_STANDALONE: true }));

import SlmChat from "../pages/slm-chat.js";
import { SLM_COACH_LESSONS } from "../lib/slm-articles";

function sseAnswer(text: string): Response {
  const body =
    `data: ${JSON.stringify({ content: `ANSWER: ${text}` })}\n` +
    `data: ${JSON.stringify({ done: true, provenance: [], pillarNames: ["Sleep"] })}\n`;
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  Element.prototype.scrollTo = (() => {}) as unknown as typeof Element.prototype.scrollTo;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SLM coach", () => {
  test("builds a voluntary seven-pillar reflection, keeps skipped pillars unassessed, and preserves the faculty handoff", async () => {
    const agentBodies: Array<{ message?: string; pillarSlugs?: string[] }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("api/consumer/me")) {
          return new Response(JSON.stringify({ authenticated: false }), { status: 200 });
        }
        if (url.includes("api/slm-agent/stewards")) {
          return new Response(
            JSON.stringify({
              stewards: [
                {
                  pillarSlug: "nutrition",
                  pillarName: "Nutrition",
                  stewardName: "Not The Sleep Steward",
                  institution: "Stanford",
                  photoUrl: "/objects/stewards/nutrition.jpg",
                },
                {
                  pillarSlug: "sleep",
                  pillarName: "Sleep",
                  stewardName: "Jamie Zeitzer",
                  institution: "Stanford",
                  photoUrl: "/objects/stewards/jamie.jpg",
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/api/pillars/") && url.endsWith("/coach-videos")) {
          return new Response(JSON.stringify({ videos: [] }), { status: 200 });
        }
        if (url.includes("api/slm-agent")) {
          agentBodies.push(JSON.parse(String(init?.body ?? "{}")) as { message?: string; pillarSlugs?: string[] });
          return sseAnswer("Daylight can be part of a steadier sleep routine.");
        }
        return new Response("{}", { status: 200 });
      }),
    );

    render(<SlmChat />);
    const nameComposer = await screen.findByRole("textbox", {
      name: "Your first name",
    });
    fireEvent.change(nameComposer, {
      target: { value: "Morgan" },
    });
    fireEvent.submit(nameComposer.closest("form")!);
    fireEvent.click(await screen.findByTestId("button-ask-faculty"));
    const conversationComposer = await screen.findByRole("textbox", {
      name: "Ask a Lifestyle Medicine question",
    });
    fireEvent.change(conversationComposer, {
      target: { value: "I want to build a more consistent sleep routine." },
    });
    fireEvent.keyDown(conversationComposer, { key: "Enter" });
    expect(await screen.findByTestId("section-conversation-companion-suggestion")).toBeTruthy();
    expect(agentBodies[0]).toMatchObject({
      message: "I want to build a more consistent sleep routine.",
    });
    fireEvent.click(screen.getByTestId("button-conversation-start-companion"));

    expect(await screen.findByTestId("section-slm-coach")).toBeTruthy();
    expect(screen.queryByText("Seven pillars")).toBeNull();
    expect(screen.queryByText("Your starting picture")).toBeNull();
    expect(screen.queryByText("What feels true today?")).toBeNull();
    expect(screen.queryByTestId("chart-seven-pillar-radar")).toBeNull();
    expect(
      within(screen.getByTestId("card-coach-lesson-sleep-daylight")).getByText("Jamie Zeitzer"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("card-coach-lesson-nutrition-pattern")).getByText(
        "Not The Sleep Steward",
      ),
    ).toBeTruthy();
    expect(screen.getAllByTestId(/card-coach-lesson-/)).toHaveLength(7);

    const sleepLesson = SLM_COACH_LESSONS.find((lesson) => lesson.id === "sleep-daylight")!;
    const flip = screen.getByTestId("button-explore-lesson-sleep-daylight");
    flip.focus();
    fireEvent.keyDown(flip, { key: "Enter" });
    const source = await screen.findByTestId("link-lesson-source-sleep-daylight");
    expect(source.getAttribute("href")).toBe(sleepLesson.source.url);
    expect(source.textContent).toContain(sleepLesson.source.title);
    expect(source.tabIndex).toBe(0);
    expect(document.activeElement).toBe(source);
    expect(screen.getByTestId("button-ask-lesson-sleep-daylight").tabIndex).toBe(0);
    expect(screen.getByTestId("button-flip-back-sleep-daylight").tabIndex).toBe(0);
    // No verified "video" resource was returned, so the card must not invent one.
    expect(screen.queryByTestId("link-lesson-video-sleep-daylight")).toBeNull();

    const back = screen.getByTestId("button-flip-back-sleep-daylight");
    back.focus();
    fireEvent.keyDown(back, { key: "Enter" });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("button-explore-lesson-sleep-daylight")),
    );

    fireEvent.click(screen.getByTestId("button-ask-lesson-sleep-daylight"));
    await waitFor(() => expect(screen.queryByTestId("section-slm-coach")).toBeNull());
  });

  test("shows a designated video only beside its matching coach lesson", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("api/consumer/me")) {
          return new Response(JSON.stringify({ authenticated: false }), { status: 200 });
        }
        if (url.includes("api/slm-agent/stewards")) {
          return new Response(JSON.stringify({ stewards: [] }), { status: 200 });
        }
        if (url.includes("/api/pillars/nutrition/coach-videos")) {
          return new Response(
            JSON.stringify({
              videos: [
                {
                  lessonId: "nutrition-pattern",
                  title: "Eating well, explained",
                  url: "https://video.example.test/nutrition",
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/api/pillars/") && url.endsWith("/coach-videos")) {
          return new Response(JSON.stringify({ videos: [] }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }),
    );

    render(<SlmChat />);
    const nameComposer = await screen.findByRole("textbox", {
      name: "Your first name",
    });
    fireEvent.change(nameComposer, {
      target: { value: "Morgan" },
    });
    fireEvent.submit(nameComposer.closest("form")!);
    fireEvent.click(await screen.findByTestId("button-learn-with-coach"));

    fireEvent.click(screen.getByTestId("button-explore-lesson-nutrition-pattern"));
    const nutritionVideo = await screen.findByTestId(
      "link-lesson-video-nutrition-pattern",
    );
    expect(nutritionVideo.getAttribute("href")).toBe(
      "https://video.example.test/nutrition",
    );

    fireEvent.click(screen.getByTestId("button-explore-lesson-sleep-daylight"));
    expect(screen.queryByTestId("link-lesson-video-sleep-daylight")).toBeNull();
  });
});
