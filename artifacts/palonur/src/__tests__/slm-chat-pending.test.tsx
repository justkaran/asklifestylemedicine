import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Standalone SLM chat — pending-question survival across the sign-in gate.
// Contract under guard:
//   - when /api/slm-agent answers 401 (register first), the held question is
//     stored via savePending in the {q, ts} JSON shape that takePending
//     expects, so the promised auto-submit after magic-link sign-in works.
//     (Regression: a raw-string localStorage write here silently dropped the
//     question after login.)
//   - the sign-in card is shown in the thread after the 401.
// ---------------------------------------------------------------------------

import SlmChat from "../pages/slm-chat.js";

const PENDING_KEY = "slm_pending_question";

function mockFetch(handlers: {
  me: () => Response | Promise<Response>;
  agent: () => Response | Promise<Response>;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api/consumer/me")) return handlers.me();
      if (url.includes("api/slm-agent")) return handlers.agent();
      return new Response("{}", { status: 200 });
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
  // jsdom has no Element.scrollTo; the thread autoscroll effect calls it.
  Element.prototype.scrollTo = (() => {}) as unknown as typeof Element.prototype.scrollTo;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SLM standalone chat pending question", () => {
  test("401 from the agent stores the question in the savePending JSON shape", async () => {
    // The auth bootstrap says authed, but the server (the real authority)
    // answers 401 — e.g. the session expired between bootstrap and submit.
    mockFetch({
      me: () =>
        new Response(JSON.stringify({ authenticated: true }), { status: 200 }),
      agent: () => new Response("Unauthorized", { status: 401 }),
    });

    render(<SlmChat />);
    const box = await screen.findByPlaceholderText(/Dear Professor|Ask a (question|follow-up)/i);
    fireEvent.change(box, { target: { value: "Does exercise help sleep?" } });
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() => {
      const raw = localStorage.getItem(PENDING_KEY);
      expect(raw, "pending question must be stored").toBeTruthy();
      // Must be the {q, ts} JSON shape takePending() accepts — a raw string
      // would parse-fail and the question would be lost after sign-in.
      const parsed = JSON.parse(raw!) as { q?: unknown; ts?: unknown };
      expect(parsed.q).toBe("Does exercise help sleep?");
      expect(typeof parsed.ts).toBe("number");
    });
  });

  test("allows the first unauthenticated question, then saves only the second pending question", async () => {
    let agentRequests = 0;
    mockFetch({
      me: () =>
        new Response(JSON.stringify({ authenticated: false }), { status: 200 }),
      agent: () => {
        agentRequests += 1;
        return new Response(
          `data: ${JSON.stringify({ content: "ANSWER: A balanced pattern can support healthy aging." })}\n` +
            `data: ${JSON.stringify({ done: true, provenance: [], pillarNames: ["Nutrition"] })}\n`,
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });

    render(<SlmChat />);
    const nameBox = await screen.findByRole("textbox", {
      name: "Your first name",
    });
    fireEvent.change(nameBox, { target: { value: "Morgan" } });
    fireEvent.submit(nameBox.closest("form")!);
    fireEvent.click(await screen.findByTestId("button-ask-faculty"));

    const box = await screen.findByRole("textbox", {
      name: "Ask a Lifestyle Medicine question",
    });
    const requestsBeforeFirstQuestion = agentRequests;
    fireEvent.change(box, { target: { value: "What should I eat after 50?" } });
    fireEvent.keyDown(box, { key: "Enter" });

    expect(
      await screen.findByText(
        "A balanced pattern can support healthy aging.",
      ),
    ).toBeTruthy();
    await waitFor(() => {
      expect(localStorage.getItem(PENDING_KEY)).toBeNull();
    });
    expect(agentRequests).toBe(requestsBeforeFirstQuestion + 1);
    const requestsAfterFirstQuestion = agentRequests;

    const followUp = await screen.findByRole("textbox", { name: /Ask a follow-up question/i });
    fireEvent.change(followUp, { target: { value: "What exercise is best after 50?" } });
    fireEvent.keyDown(followUp, { key: "Enter" });

    await waitFor(() => {
      const raw = localStorage.getItem(PENDING_KEY);
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw!) as { q?: unknown; ts?: unknown };
      expect(parsed.q).toBe("What exercise is best after 50?");
      expect(typeof parsed.ts).toBe("number");
    });
    expect(
      await screen.findByRole("button", {
        name: "Already have an account? Sign in",
      }),
    ).toBeTruthy();
    expect(agentRequests).toBe(requestsAfterFirstQuestion);
  });
});
