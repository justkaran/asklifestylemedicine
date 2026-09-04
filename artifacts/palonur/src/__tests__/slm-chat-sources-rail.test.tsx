import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import SlmChat from "../pages/slm-chat.js";

function governedAnswer(): Response {
  const provenance = [
    {
      source_id: 41,
      interpretation_id: 7,
      title: "Sleep stability and cognitive health",
      authors: "Li MK, Winer JR",
      year: 2024,
      journal: "Sleep Medicine",
      doi: null,
      source_url: "https://example.com/sleep-stability",
      pillar_slug: "sleep",
    },
  ];
  const body =
    `data: ${JSON.stringify({
      content:
        "ANSWER: A steady daily rhythm can support more stable sleep.\nFINDING: Morning light and daytime movement help anchor the body clock.\nINTERPRETATION: Keep wake time consistent and discuss persistent changes with his clinician.",
    })}\n` +
    `data: ${JSON.stringify({
      done: true,
      provenance,
      pillarNames: ["Sleep"],
      suggestedQuestions: ["What should I ask his doctor?", "What can we try tonight?"],
    })}\n`;
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

beforeEach(() => {
  localStorage.clear();
  Element.prototype.scrollTo = (() => {}) as unknown as typeof Element.prototype.scrollTo;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Ask Lifestyle Medicine answer sources rail", () => {
  test("shows real sources and steward attribution beside an answer and keeps follow-up entry in the conversation", async () => {
    const agentBodies: Array<{ message?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("api/consumer/me")) {
          return new Response(
            JSON.stringify({ authenticated: true, displayName: "Pat", emailVerified: true }),
            { status: 200 },
          );
        }
        if (url.includes("api/slm-agent/history")) {
          return new Response(JSON.stringify({ turns: [] }), { status: 200 });
        }
        if (url.includes("api/slm-agent/stewards")) {
          return new Response(
            JSON.stringify({
              stewards: [
                {
                  pillarSlug: "sleep",
                  pillarName: "Sleep",
                  stewardName: "Jamie Zeitzer",
                  institution: "Stanford Lifestyle Medicine",
                  photoUrl: "/api/storage/objects/stewards/jamie-zeitzer.jpg",
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes("api/slm-agent")) {
          agentBodies.push(JSON.parse(String(init?.body ?? "{}")) as { message?: string });
          return governedAnswer();
        }
        return new Response("{}", { status: 200 });
      }),
    );

    render(<SlmChat />);
    const composer = await screen.findByPlaceholderText(/Dear Professor/i);
    fireEvent.change(composer, {
      target: { value: "How can I help my dad sleep more steadily?" },
    });
    fireEvent.keyDown(composer, { key: "Enter" });

    const rail = await screen.findByRole("complementary", {
      name: /Answer sources and review trail/i,
    });
    expect(rail.closest(".slm-answer-layout")).toBeTruthy();
    expect(within(rail).getByText(/Sources for this answer/i)).toBeTruthy();
    expect(
      within(rail)
        .getByRole("link", { name: /Sleep stability and cognitive health/i })
        .getAttribute("href"),
    ).toBe("https://example.com/sleep-stability");
    expect(
      within(rail).getByRole("img", { name: "Jamie Zeitzer" }).getAttribute("src"),
    ).toBe("/stewards/jamie-zeitzer.jpg");

    expect(screen.getByText("What should I ask his doctor?")).toBeTruthy();
    expect(screen.getByText("What can we try tonight?")).toBeTruthy();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    const followUp = screen.getByRole("textbox", { name: /Ask a follow-up question/i });
    fireEvent.change(followUp, { target: { value: "Can morning light help?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    await waitFor(() => expect(agentBodies).toHaveLength(2));
    expect(agentBodies[1].message).toBe("Can morning light help?");
  });
});