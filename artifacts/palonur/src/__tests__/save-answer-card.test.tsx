import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Regression guard for the post-answer "email me this answer" card — the one
// onboarding ask on the consumer agent surfaces. The non-negotiables:
//   - explicit copy: the visitor is told the answer AND sources will be
//     emailed so they can come back,
//   - the newsletter checkbox is SEPARATE and UNCHECKED by default, and the
//     request omits newsletterOptIn entirely unless it was ticked,
//   - dismissing is one click (continuing without saving stays effortless),
//   - 409 (answer still persisting) surfaces the server's retry message.
// ---------------------------------------------------------------------------

import { SaveAnswerCard, type SaveAnswerPalette } from "../components/save-answer-card.js";

const PALETTE: SaveAnswerPalette = {
  accent: "#8B1A1A",
  ink: "#1a0505",
  muted: "#8a6a5a",
  rule: "#E8DDD0",
  cardBg: "#fff",
  sans: "sans-serif",
  serif: "serif",
};

const QUERY_ID = "11111111-2222-4333-8444-555555555555";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderCard() {
  return render(<SaveAnswerCard queryId={QUERY_ID} palette={PALETTE} />);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SaveAnswerCard", () => {
  test("explicit copy + newsletter checkbox UNCHECKED by default", () => {
    renderCard();
    expect(
      screen.getByText(/email you this answer and your sources/i),
    ).toBeTruthy();
    const checkbox = screen.getByTestId(
      "checkbox-save-answer-newsletter",
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    // Newsletter copy is explicit about the double opt-in.
    expect(screen.getByText(/nothing starts unless you confirm/i)).toBeTruthy();
  });

  test("submit WITHOUT opt-in omits newsletterOptIn from the request entirely", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ ok: true, emailed: true }));
    vi.stubGlobal("fetch", fetchSpy);
    renderCard();

    fireEvent.change(screen.getByTestId("input-save-answer-email"), {
      target: { value: "visitor@example.com" },
    });
    fireEvent.click(screen.getByTestId("button-save-answer"));

    await waitFor(() => expect(screen.getByTestId("save-answer-sent")).toBeTruthy());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/save-answer");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ queryId: QUERY_ID, email: "visitor@example.com" });
    expect("newsletterOptIn" in body).toBe(false);
    // Success state never mentions the newsletter when it wasn't requested.
    expect(screen.queryByText(/newsletter confirmation/i)).toBeNull();
  });

  test("ticked checkbox sends newsletterOptIn:true and surfaces the pending note", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse({ ok: true, emailed: true, newsletterPending: true }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    renderCard();

    fireEvent.change(screen.getByTestId("input-save-answer-email"), {
      target: { value: "visitor@example.com" },
    });
    fireEvent.click(screen.getByTestId("checkbox-save-answer-newsletter"));
    fireEvent.click(screen.getByTestId("button-save-answer"));

    await waitFor(() => expect(screen.getByTestId("save-answer-sent")).toBeTruthy());

    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).newsletterOptIn).toBe(true);
    expect(screen.getByText(/separate newsletter confirmation/i)).toBeTruthy();
  });

  test("409 shows the server's retry message and keeps the form", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { error: "This answer isn't saved yet — please try again in a moment." },
          409,
        ),
      ),
    );
    renderCard();

    fireEvent.change(screen.getByTestId("input-save-answer-email"), {
      target: { value: "visitor@example.com" },
    });
    fireEvent.click(screen.getByTestId("button-save-answer"));

    await waitFor(() =>
      expect(screen.getByTestId("text-save-answer-error").textContent).toMatch(
        /isn't saved yet/i,
      ),
    );
    // The form is still there for a retry.
    expect(screen.getByTestId("input-save-answer-email")).toBeTruthy();
  });

  test("dismiss removes the card in one click", () => {
    renderCard();
    fireEvent.click(screen.getByTestId("save-answer-dismiss"));
    expect(screen.queryByTestId("save-answer-card")).toBeNull();
  });
});
