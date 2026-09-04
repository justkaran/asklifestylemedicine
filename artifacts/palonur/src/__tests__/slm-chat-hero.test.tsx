import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// This suite represents the separately-hosted AskLifestyleMedicine experience.
vi.mock("../lib/app-mode", () => ({ SLM_STANDALONE: true }));

import SlmChat from "../pages/slm-chat.js";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  Element.prototype.scrollTo = (() => {}) as unknown as typeof Element.prototype.scrollTo;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AskLifestyleMedicine standalone hero", () => {
  test("starts at the welcome section and enters faculty chat through its current entry option", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("api/consumer/me")) {
          return new Response(
            JSON.stringify({ authenticated: false }),
            { status: 200 },
          );
        }
        if (url.includes("api/slm-agent/history")) {
          return new Response(JSON.stringify({ turns: [] }), { status: 200 });
        }
        if (url.includes("api/slm-agent/stewards")) {
          return new Response(JSON.stringify({ stewards: [] }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }),
    );

    render(<SlmChat />);

    expect(await screen.findByTestId("section-slm-welcome")).toBeTruthy();
    const composer = screen.getByRole("textbox", { name: "Your first name" });
    fireEvent.change(composer, {
      target: { value: "Morgan" },
    });
    fireEvent.submit(composer.closest("form")!);

    expect(await screen.findByText("Nice to meet you, Morgan.")).toBeTruthy();
    expect(screen.getByTestId("button-ask-faculty").textContent).toContain("Faculty chat");
    fireEvent.click(screen.getByTestId("button-ask-faculty"));
    expect(
      await screen.findByRole("textbox", { name: "Ask a Lifestyle Medicine question" }),
    ).toBeTruthy();
  });

  test("enters the coach through the welcome option", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ authenticated: false }), { status: 200 })));
    render(<SlmChat />);

    expect(await screen.findByTestId("section-slm-welcome")).toBeTruthy();
    const composer = screen.getByRole("textbox", { name: "Your first name" });
    fireEvent.change(composer, { target: { value: "Morgan" } });
    fireEvent.submit(composer.closest("form")!);
    fireEvent.click(await screen.findByTestId("button-learn-with-coach"));

    expect(await screen.findByTestId("section-slm-coach")).toBeTruthy();
  });

  test("offers both faculty and coach choices on the welcome entry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ authenticated: false }), { status: 200 })));

    render(<SlmChat />);

    expect(await screen.findByTestId("section-slm-welcome")).toBeTruthy();
    const composer = screen.getByRole("textbox", { name: "Your first name" });
    fireEvent.change(composer, { target: { value: "Morgan" } });
    fireEvent.submit(composer.closest("form")!);

    expect(await screen.findByTestId("button-ask-faculty")).toBeTruthy();
    expect(screen.getByTestId("button-learn-with-coach")).toBeTruthy();
  });

  test("takes a signed-in returning visitor straight to the faculty surface", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("api/consumer/me")) {
          return new Response(
            JSON.stringify({ authenticated: true, displayName: "Karan", emailVerified: true }),
            { status: 200 },
          );
        }
        if (url.includes("api/slm-agent/history")) {
          return new Response(JSON.stringify({ turns: [] }), { status: 200 });
        }
        if (url.includes("api/slm-agent/stewards")) {
          return new Response(JSON.stringify({ stewards: [] }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }),
    );

    render(<SlmChat />);

    expect(await screen.findByText(/Signed in as/i)).toBeTruthy();
    expect(screen.getAllByText("Karan").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("textbox", { name: "Ask a Lifestyle Medicine question" }),
    ).toBeTruthy();
    expect(screen.queryByTestId("button-ask-faculty")).toBeNull();
    expect(screen.queryByTestId("button-learn-with-coach")).toBeNull();
  });

  test("never uses an email address as a return greeting", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("api/consumer/me")) {
          return new Response(
            JSON.stringify({
              authenticated: true,
              displayName: "kdegani@stanford.edu",
              emailVerified: true,
            }),
            { status: 200 },
          );
        }
        if (url.includes("api/slm-agent/history")) {
          return new Response(JSON.stringify({ turns: [] }), { status: 200 });
        }
        if (url.includes("api/slm-agent/stewards")) {
          return new Response(JSON.stringify({ stewards: [] }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }),
    );

    render(<SlmChat />);

    expect(
      await screen.findByRole("textbox", {
        name: "Ask a Lifestyle Medicine question",
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/kdegani@stanford\.edu/i)).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Your first name" })).toBeNull();
  });
});