import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Regression guards for the decluttered governed answer surface:
//   1. The duplicate below-answer source list stays deleted — sources live
//      ONLY in the governance rail. If someone reintroduces the old
//      provenance block (data-testid="provenance-list"), this fails.
//   2. TrustVoteCard: one vote per answer per visitor — casts a vote via
//      POST /trust, restores a prior vote from GET /trust/mine when
//      localStorage is empty (cleared storage / other device), and keeps the
//      buttons active when the server has no vote for this visitor.
// ---------------------------------------------------------------------------

import {
  TrustVoteCard,
  normalizeSelectedExcerpt,
  parseAnswer,
} from "../pages/sleep-agent.js";

const PAGE_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../pages/sleep-agent.tsx"),
  "utf8",
);

describe("answer surface layout (source guard)", () => {
  test("the below-answer provenance list stays deleted — sources render only in the rail", () => {
    expect(PAGE_SOURCE).not.toContain('data-testid="provenance-list"');
  });

  test("the rail engagement cards and contact entry point exist", () => {
    expect(PAGE_SOURCE).toContain('data-testid="rail-share-card"');
    expect(PAGE_SOURCE).toContain('data-testid="trust-vote-card"');
    expect(PAGE_SOURCE).toContain('data-testid="button-get-personal-help"');
    expect(PAGE_SOURCE).toContain('data-testid="contact-modal"');
  });

  test("chat-style center: actions live BELOW the answer, top search hides mid-thread", () => {
    // The Gemini-style action strip under the reply carries TTS, MiniCast,
    // copy-credential and the personal-help pill.
    expect(PAGE_SOURCE).toContain('data-testid="answer-action-bar"');
    // The top pill search bar is gated off while a conversation is active —
    // the bottom follow-up composer is the only input mid-thread.
    expect(PAGE_SOURCE).toContain(
      `!(
              conversationActive &&
              intakePhase === "idle" &&
              !followUpPaywall
            ) && (`,
    );
    // The busy pre-answer toolbar and the labeled quote/clarify chrome stay
    // deleted: no copy-quote button, no uppercase clarify label.
    expect(PAGE_SOURCE).not.toContain('data-testid="copy-jamie"');
    expect(PAGE_SOURCE).not.toContain("sleepAgent.answer.clarifyLabel");
    // The page overrides the global dark body background (black-band fix).
    expect(PAGE_SOURCE).toContain('document.body.style.background = "#fafaf7"');
  });

  test("podcast + personal-help live in the right rail, NOT in the center action bar", () => {
    // The rail-extras block (top of the governance rail) carries MiniCast and
    // the personal-help pill.
    const railStart = PAGE_SOURCE.indexOf('data-testid="rail-extras"');
    expect(railStart).toBeGreaterThan(-1);
    const railBlock = PAGE_SOURCE.slice(railStart, railStart + 2500);
    expect(railBlock).toContain("<MinicastButton");
    expect(railBlock).toContain('data-testid="button-get-personal-help"');
    // The center answer-action-bar keeps ONLY listen/TTS + copy-credential —
    // no MiniCast, no personal-help pill.
    const barStart = PAGE_SOURCE.indexOf('data-testid="answer-action-bar"');
    expect(barStart).toBeGreaterThan(railStart);
    const barBlock = PAGE_SOURCE.slice(barStart, PAGE_SOURCE.indexOf('data-testid="clarify-question"', barStart));
    expect(barBlock).not.toContain("MinicastButton");
    expect(barBlock).not.toContain("button-get-personal-help");
  });

  test("single text input: clarify renders as plain text, the composer answers it", () => {
    // The clarify question is plain text under the answer …
    expect(PAGE_SOURCE).toContain('data-testid="clarify-question"');
    // … the old inline clarify mini-form (second input) stays deleted …
    expect(PAGE_SOURCE).not.toContain("clarifyInput");
    // … and the bottom composer switches its placeholder while a clarify is
    // pending, routing the next submit as the clarify answer.
    expect(PAGE_SOURCE).toContain("sleepAgent.answer.clarifyPlaceholder");
  });

  test("highlight-to-ask uses the normal composer and the governed request field", () => {
    expect(PAGE_SOURCE).toContain('data-answer-selectable="true"');
    expect(PAGE_SOURCE).toContain('data-testid="button-ask-about-selection"');
    expect(PAGE_SOURCE).toContain('data-testid="selected-excerpt"');
    expect(PAGE_SOURCE).toContain("{ selectedExcerpt: excerpt }");
    expect(PAGE_SOURCE).toContain("followUp: true");
    expect(PAGE_SOURCE).toContain('aria-keyshortcuts="Alt+A"');
    expect(PAGE_SOURCE).toContain("selectionActionButtonRef.current?.focus()");
  });

  test("the existing responsive governance rail remains the only source UI", () => {
    expect(PAGE_SOURCE).toContain('variant="desktop"');
    expect(PAGE_SOURCE).toContain('variant="sheet"');
    expect(PAGE_SOURCE).toContain('data-testid="governance-rail-sheet"');
  });
});

describe("boundary and selected-excerpt normalization", () => {
  test("invisible controls cannot hide the UNCOVERED marker", () => {
    const parsed = parseAnswer(
      "\u200b\u2066UNCOVERED: I don't have reviewed research for that yet.",
    );
    expect(parsed.kind).toBe("uncovered");
    expect(parsed.raw).not.toMatch(/[\u200b\u2066]/);
    expect(PAGE_SOURCE).toContain("const parsed = parseAnswer(turn.raw)");
  });

  test("selected excerpts are plain, whitespace-normalized, control-free, and capped", () => {
    const parsed = normalizeSelectedExcerpt(
      `  Morning\u200b light\n\tanchors sleep. ${"x".repeat(600)}  `,
    );
    expect(parsed.startsWith("Morning light anchors sleep.")).toBe(true);
    expect(parsed).not.toContain("\u200b");
    expect(parsed).not.toContain("\n");
    expect(parsed).toHaveLength(500);
  });
});

const QUERY_ID = "11111111-2222-4333-8444-555555555555";
const STORAGE_KEY = `palonur_trust_${QUERY_ID}`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("TrustVoteCard", () => {
  test("no prior vote anywhere: server says null, buttons stay active, Yes POSTs and flips to thanks", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/trust/mine")) {
        return jsonResponse({ trusted: null });
      }
      if (url.endsWith("/sleep-agent/trust") && init?.method === "POST") {
        return jsonResponse({ ok: true, trusted: true });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    render(<TrustVoteCard queryId={QUERY_ID} />);

    // /trust/mine returned null → the Yes/No buttons remain.
    await waitFor(() =>
      expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes("/trust/mine"))).toBe(true),
    );
    expect(screen.getByTestId("button-trust-yes")).toBeTruthy();
    expect(screen.getByTestId("button-trust-no")).toBeTruthy();

    fireEvent.click(screen.getByTestId("button-trust-yes"));
    await waitFor(() => expect(screen.getByTestId("trust-vote-thanks")).toBeTruthy());
    expect(screen.queryByTestId("button-trust-yes")).toBeNull();

    const post = fetchSpy.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(post).toBeTruthy();
    expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({
      queryId: QUERY_ID,
      trusted: true,
    });
    // The local mirror is updated for instant restore next time.
    expect(localStorage.getItem(STORAGE_KEY)).toBe("yes");
  });

  test("cleared localStorage: a prior server-side vote restores via GET /trust/mine", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/trust/mine")) {
        expect(url).toContain(`queryId=${QUERY_ID}`);
        return jsonResponse({ trusted: false });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    render(<TrustVoteCard queryId={QUERY_ID} />);

    await waitFor(() => expect(screen.getByTestId("trust-vote-thanks")).toBeTruthy());
    expect(screen.queryByTestId("button-trust-yes")).toBeNull();
    // Restored vote re-mirrors to localStorage.
    expect(localStorage.getItem(STORAGE_KEY)).toBe("no");
  });

  test("localStorage vote restores instantly without asking the server twice for a decision", async () => {
    localStorage.setItem(STORAGE_KEY, "yes");
    const fetchSpy = vi.fn(async () => jsonResponse({ trusted: true }));
    vi.stubGlobal("fetch", fetchSpy);

    render(<TrustVoteCard queryId={QUERY_ID} />);

    expect(screen.getByTestId("trust-vote-thanks")).toBeTruthy();
    // Local mirror was authoritative → no /trust/mine round trip needed.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("offline /trust/mine failure leaves the buttons usable", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/trust/mine")) throw new Error("offline");
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal("fetch", fetchSpy);

    render(<TrustVoteCard queryId={QUERY_ID} />);

    await waitFor(() =>
      expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes("/trust/mine"))).toBe(true),
    );
    expect(screen.getByTestId("button-trust-yes")).toBeTruthy();
  });
});
