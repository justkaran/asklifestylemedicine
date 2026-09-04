import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Standalone SLM chat — "New conversation" clean slate.
// Contract under guard:
//   - clicking New conversation empties the visible thread and the context
//     (`history`) sent with the next question; server-side history is not
//     touched (no delete call is made).
//   - a LATE history restore must not repopulate a cleared thread: the
//     bootstrap /api/slm-agent/history fetch may still be in flight when the
//     visitor clears — its turns must be dropped, and the next request must
//     not carry them as context. (Regression: bootstrap treated an empty
//     thread as "no interaction yet" and merged the restore in.)
// ---------------------------------------------------------------------------

import SlmChat, {
  VerifyReminderCard,
  buildSlmAuthDestination,
} from "../pages/slm-chat.js";
import i18n from "../i18n";
import { warmReturnGreeting } from "../lib/return-greeting";

/** All greeting variants for a name/lang (the card rolls one at random). */
function allGreetings(name: string | null, lang: string): string[] {
  return [0, 1, 2].map((r) => warmReturnGreeting(name, lang, r));
}

function sseAnswer(text: string): Response {
  const body =
    `data: ${JSON.stringify({ content: `ANSWER: ${text}` })}\n` +
    `data: ${JSON.stringify({ done: true, provenance: [], pillarNames: [] })}\n`;
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
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

describe("SLM standalone chat — New conversation", () => {
  test("clears the thread and the context of the next question, even when the history restore lands late", async () => {
    // History fetch resolves only when WE say so — after the visitor has
    // already asked and cleared.
    let resolveHistory: (r: Response) => void = () => {};
    const historyPromise = new Promise<Response>((res) => {
      resolveHistory = res;
    });
    const agentBodies: Array<{ history?: unknown[] }> = [];

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
        if (url.includes("api/slm-agent/history")) return historyPromise;
        if (url.includes("api/slm-agent/stewards")) {
          return new Response(JSON.stringify({ stewards: [] }), { status: 200 });
        }
        if (url.includes("api/slm-agent")) {
          agentBodies.push(JSON.parse(String(init?.body ?? "{}")) as { history?: unknown[] });
          return sseAnswer("Movement helps most people sleep better.");
        }
        return new Response("{}", { status: 200 });
      }),
    );

    render(<SlmChat />);
    const box = await screen.findByPlaceholderText(/Dear Professor|Ask a (question|follow-up)/i);

    // Ask while the history restore is still pending.
    fireEvent.change(box, { target: { value: "Does exercise help sleep?" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByText(/Movement helps most people sleep better/i);

    // Start fresh.
    fireEvent.click(await screen.findByRole("button", { name: /New conversation/i }));
    // The hero splits the name into its own styled span, so match on the
    // heading's combined text content rather than a single text node.
    const heroMatcher = (_: string, el: Element | null) =>
      el?.tagName === "H1" &&
      // Matches either the old "Hello Pat, what would you like to know?"
      // or the current "Hello Pat. Dear Professor, please help me decide…"
      /Hello\s+Pat[\s.,]/i.test(el.textContent ?? "");
    await screen.findByText(heroMatcher);

    // The stale history restore lands AFTER the clear — it must be dropped.
    resolveHistory(
      new Response(
        JSON.stringify({
          turns: [{ question: "Old question?", answer: "ANSWER: Old answer.", pillarNames: [] }],
        }),
        { status: 200 },
      ),
    );
    // Give the bootstrap continuation a beat, then confirm the slate stayed clean.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/Old question\?/)).toBeNull();
    expect(screen.getByText(heroMatcher)).toBeTruthy();

    // The next question carries no prior context.
    fireEvent.change(screen.getByPlaceholderText(/Dear Professor|Ask a (question|follow-up)/i), {
      target: { value: "What about naps?" },
    });
    fireEvent.keyDown(screen.getByPlaceholderText(/Dear Professor|Ask a (question|follow-up)/i), { key: "Enter" });
    await waitFor(() => expect(agentBodies.length).toBe(2));
    expect(agentBodies[1].history).toEqual([]);

    // History stays in the database: nothing was deleted server-side.
    const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(
      calls.some(([, init]) => (init as RequestInit | undefined)?.method === "DELETE"),
    ).toBe(false);
  });

  test("an aborted request's cleanup never clears the NEW request's in-flight guard", async () => {
    // Regression: newConversation aborts the old request and immediately
    // resets inFlightRef; if the OLD request's finally then ran
    // unconditionally, it would clear the guard for the NEW in-flight
    // request, letting a third submit start a concurrent stream that
    // overwrites the same last assistant turn.
    let rejectFirst: (e: unknown) => void = () => {};
    const firstAgent = new Promise<Response>((_, rej) => {
      rejectFirst = rej;
    });
    let agentCalls = 0;
    let resolveSecond: (r: Response) => void = () => {};
    const secondAgent = new Promise<Response>((res) => {
      resolveSecond = res;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
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
          return new Response(JSON.stringify({ stewards: [] }), { status: 200 });
        }
        if (url.includes("api/slm-agent")) {
          agentCalls += 1;
          return agentCalls === 1 ? firstAgent : secondAgent;
        }
        return new Response("{}", { status: 200 });
      }),
    );

    render(<SlmChat />);
    const box = await screen.findByPlaceholderText(/Dear Professor|Ask a (question|follow-up)/i);

    // Q1 starts streaming (its fetch never settles yet).
    fireEvent.change(box, { target: { value: "First question?" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(agentCalls).toBe(1));

    // Clear + immediately ask Q2 — a new request in a new generation.
    fireEvent.click(await screen.findByRole("button", { name: /New conversation/i }));
    fireEvent.change(screen.getByPlaceholderText(/Dear Professor|Ask a (question|follow-up)/i), {
      target: { value: "Second question?" },
    });
    fireEvent.keyDown(screen.getByPlaceholderText(/Dear Professor|Ask a (question|follow-up)/i), { key: "Enter" });
    await waitFor(() => expect(agentCalls).toBe(2));

    // NOW the aborted Q1 request finally settles — its cleanup must be a
    // no-op for the new generation's in-flight guard.
    rejectFirst(Object.assign(new Error("aborted"), { name: "AbortError" }));
    await new Promise((r) => setTimeout(r, 30));

    // A third submit while Q2 is still streaming must be swallowed by the
    // guard (no concurrent third stream).
    fireEvent.change(screen.getByPlaceholderText(/Dear Professor|Ask a (question|follow-up)/i), {
      target: { value: "Third question?" },
    });
    fireEvent.keyDown(screen.getByPlaceholderText(/Dear Professor|Ask a (question|follow-up)/i), { key: "Enter" });
    await new Promise((r) => setTimeout(r, 30));
    expect(agentCalls).toBe(2);

    // Q2's answer still lands intact.
    resolveSecond(sseAnswer("Second answer arrives cleanly."));
    await screen.findByText(/Second answer arrives cleanly/i);
  });

  test("a stale 401 after New conversation never flips auth or injects the sign-in card", async () => {
    let resolveFirst: (r: Response) => void = () => {};
    const firstAgent = new Promise<Response>((res) => {
      resolveFirst = res;
    });
    let resolveSecond: (r: Response) => void = () => {};
    const secondAgent = new Promise<Response>((res) => {
      resolveSecond = res;
    });
    let agentCalls = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
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
          return new Response(JSON.stringify({ stewards: [] }), { status: 200 });
        }
        if (url.includes("api/slm-agent")) {
          agentCalls += 1;
          return agentCalls === 1 ? firstAgent : secondAgent;
        }
        return new Response("{}", { status: 200 });
      }),
    );

    render(<SlmChat />);
    const box = await screen.findByPlaceholderText(/Dear Professor|Ask a (question|follow-up)/i);

    // Q1 in flight; visitor clears and asks Q2 in the new generation.
    fireEvent.change(box, { target: { value: "First question?" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(agentCalls).toBe(1));
    fireEvent.click(await screen.findByRole("button", { name: /New conversation/i }));
    fireEvent.change(screen.getByPlaceholderText(/Dear Professor|Ask a (question|follow-up)/i), {
      target: { value: "Second question?" },
    });
    fireEvent.keyDown(screen.getByPlaceholderText(/Dear Professor|Ask a (question|follow-up)/i), { key: "Enter" });
    await waitFor(() => expect(agentCalls).toBe(2));

    // NOW the stale Q1 request answers 401 — it must be dropped entirely:
    // no sign-in card, no removed turns, session stays signed in.
    resolveFirst(new Response(JSON.stringify({ error: "register" }), { status: 401 }));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/Sign in|Create.*account/i)).toBeNull();
    expect(screen.getByText(/Second question\?/)).toBeTruthy();
    expect(screen.getByText(/Signed in as/i)).toBeTruthy();

    // Q2 still completes normally.
    resolveSecond(sseAnswer("Q2 answer lands."));
    await screen.findByText(/Q2 answer lands/i);
  });

  test("a stale SSE done after New conversation never mirrors into Past conversations", async () => {
    // Q1's stream stays open across the clear; when its done event finally
    // arrives it must not add the abandoned Q1 to Past conversations or
    // clear the loading state of the in-flight Q2.
    const enc = new TextEncoder();
    let pushDone: () => void = () => {};
    const firstStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ content: "ANSWER: Old partial." })}\n`));
        pushDone = () => {
          controller.enqueue(
            enc.encode(`data: ${JSON.stringify({ done: true, provenance: [], pillarNames: ["Sleep"] })}\n`),
          );
          controller.close();
        };
      },
    });
    let agentCalls = 0;
    let resolveSecond: (r: Response) => void = () => {};
    const secondAgent = new Promise<Response>((res) => {
      resolveSecond = res;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
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
          return new Response(JSON.stringify({ stewards: [] }), { status: 200 });
        }
        if (url.includes("api/slm-agent")) {
          agentCalls += 1;
          if (agentCalls === 1) {
            return new Response(firstStream, {
              status: 200,
              headers: { "Content-Type": "text/event-stream" },
            });
          }
          return secondAgent;
        }
        return new Response("{}", { status: 200 });
      }),
    );

    render(<SlmChat />);
    const box = await screen.findByPlaceholderText(/Dear Professor|Ask a (question|follow-up)/i);

    fireEvent.change(box, { target: { value: "Stale stream question?" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByText(/Old partial/i);

    fireEvent.click(await screen.findByRole("button", { name: /New conversation/i }));
    fireEvent.change(screen.getByPlaceholderText(/Dear Professor|Ask a (question|follow-up)/i), {
      target: { value: "Fresh question?" },
    });
    fireEvent.keyDown(screen.getByPlaceholderText(/Dear Professor|Ask a (question|follow-up)/i), { key: "Enter" });
    await waitFor(() => expect(agentCalls).toBe(2));

    // Late done from the superseded stream.
    pushDone();
    await new Promise((r) => setTimeout(r, 30));
    // Not mirrored into Past conversations (no past drawer button appears)…
    expect(screen.queryByRole("button", { name: /Past conversations/i })).toBeNull();
    // …the abandoned answer stays gone, and Q2 is still visibly loading.
    expect(screen.queryByText(/Old partial/i)).toBeNull();

    resolveSecond(sseAnswer("Fresh answer lands."));
    await screen.findByText(/Fresh answer lands/i);
  });
});

describe("SLM hero — warm return greeting for returning signed-in users", () => {
  function stubReturningFetch() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("api/consumer/me")) {
          return new Response(
            JSON.stringify({ authenticated: true, displayName: "Pat", emailVerified: true }),
            { status: 200 },
          );
        }
        if (url.includes("api/slm-agent/history")) {
          return new Response(
            JSON.stringify({
              turns: [
                { question: "Old question?", answer: "ANSWER: Old answer.", pillarNames: [] },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes("api/slm-agent/stewards")) {
          return new Response(JSON.stringify({ stewards: [] }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }),
    );
  }

  test("shows the warm named greeting on the hero after New conversation (EN and DE)", async () => {
    stubReturningFetch();
    render(<SlmChat />);
    // Returning visitors land on a clean slate: past conversations live behind
    // the three-dot history button, so the hero greeting shows right away.
    const en = await screen.findByText((_, el) =>
      allGreetings("Pat", "en").some((g) => el?.textContent === g),
    );
    expect(en).toBeTruthy();
    cleanup();

    const prev = i18n.language;
    await i18n.changeLanguage("de");
    try {
      stubReturningFetch();
      render(<SlmChat />);
      const de = await screen.findByText((_, el) =>
        allGreetings("Pat", "de").some((g) => el?.textContent === g),
      );
      expect(de).toBeTruthy();
    } finally {
      await i18n.changeLanguage(prev);
    }
  });
});

describe("SLM sign-out — cross-account history isolation", () => {
  test("account A's Past conversations never survive sign-out into account B's session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("api/consumer/me")) {
          return new Response(
            JSON.stringify({ authenticated: true, displayName: "Alice", emailVerified: true }),
            { status: 200 },
          );
        }
        if (url.includes("api/slm-agent/history")) {
          return new Response(
            JSON.stringify({
              turns: [
                { question: "Alice private question?", answer: "ANSWER: Alice answer.", pillarNames: [] },
                { question: "Alice older question?", answer: "ANSWER: Older.", pillarNames: [], askedAt: "2026-01-01T00:00:00Z" },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes("api/slm-agent/stewards")) {
          return new Response(JSON.stringify({ stewards: [] }), { status: 200 });
        }
        if (url.includes("auth/logout")) {
          return new Response("{}", { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }),
    );

    render(<SlmChat />);
    // Account A's history is loaded: the Past conversations entry point shows.
    await screen.findByRole("button", { name: /Past conversations/i });

    // A signs out on this shared device.
    fireEvent.click(screen.getByRole("button", { name: /Sign out/i }));

    // B registers in the same SPA session (supported onboarding flow ends in
    // handleRegistered → authed). None of A's history may resurface.
    await waitFor(() =>
      expect(screen.queryByText(/Alice private question\?/)).toBeNull(),
    );
    expect(screen.queryByRole("button", { name: /Past conversations/i })).toBeNull();
    expect(screen.queryByText(/Alice older question\?/)).toBeNull();
  });
});

describe("SLM verify reminder — warm return greeting", () => {
  test("keeps confirmation links on the current Palonur host unless this is the standalone SLM domain", () => {
    expect(buildSlmAuthDestination(false, "/")).toEqual({
      slmStandalone: false,
      next: "/slm",
    });
    expect(buildSlmAuthDestination(true, "/")).toEqual({
      slmStandalone: true,
    });
  });

  test("greets by name, and in German when the locale is German", async () => {
    render(<VerifyReminderCard email="pat@example.com" name="Pat" />);
    const en = screen.getByText(/Pat/i, { selector: "p" });
    expect(
      allGreetings("Pat", "en").some((g) => en.textContent?.includes(g)),
    ).toBe(true);
    cleanup();

    const prev = i18n.language;
    await i18n.changeLanguage("de");
    try {
      render(<VerifyReminderCard email="pat@example.com" name="Pat" />);
      const de = screen.getByText(/Pat/i, { selector: "p" });
      expect(
        allGreetings("Pat", "de").some((g) => de.textContent?.includes(g)),
      ).toBe(true);
      cleanup();

      // Name-free German fallback: friendly copy, never "null".
      render(<VerifyReminderCard email="pat@example.com" name={null} />);
      const body = document.querySelector("p");
      expect(
        allGreetings(null, "de").some((g) => body?.textContent?.includes(g)),
      ).toBe(true);
      expect(body?.textContent).not.toMatch(/null|undefined/i);
    } finally {
      await i18n.changeLanguage(prev);
    }
  });
});
