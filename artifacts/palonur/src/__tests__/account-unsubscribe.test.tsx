import { afterEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Regression guard for the newsletter membership "Unsubscribe" flow on
// /account: clicking Unsubscribe must POST
// /api/account/newsletters/:publicationId/unsubscribe and reload the account
// data (list refresh), and surface the inline error — never a silent no-op —
// when the request fails.
// ---------------------------------------------------------------------------

import Account from "../pages/account.js";

const MEMBERSHIP = {
  publicationId: 42,
  name: "Sleep Signals",
  slug: "sleep-signals",
  tagline: "Weekly sleep science",
  accentColor: null,
  isHouse: false,
};

function accountData(withMembership: boolean) {
  return {
    email: "subscriber@example.com",
    capabilities: ["newsletter"],
    paidSubscriptions: [],
    newsletterMemberships: withMembership ? [MEMBERSHIP] : [],
    availablePublications: [],
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type UnsubResponder = () => Response | Promise<Response>;

/** Stub global fetch: /account returns the membership until an unsubscribe
 *  succeeds, then returns an empty list so the refresh is observable. */
function stubFetch(unsub: UnsubResponder) {
  let unsubscribed = false;
  const fetchSpy = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = String(input);
      if (url.includes("/newsletters/") && url.includes("/unsubscribe")) {
        const res = await unsub();
        if (res.ok) unsubscribed = true;
        return res;
      }
      if (url.includes("/billing/plans")) return json({ plans: [] });
      if (url.endsWith("/account")) return json(accountData(!unsubscribed));
      return json({}, 401);
    },
  );
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

function unsubCallOf(fetchSpy: ReturnType<typeof vi.fn>) {
  const call = fetchSpy.mock.calls.find(([input]) =>
    String(input).includes("/unsubscribe"),
  );
  expect(call).toBeTruthy();
  return call as [RequestInfo | URL, RequestInit | undefined];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("/account newsletter unsubscribe", () => {
  test("success: POSTs the unsubscribe endpoint and refreshes the list", async () => {
    const fetchSpy = stubFetch(() => json({ ok: true }));
    render(<Account />);

    // Signed-in state with the membership rendered.
    expect(await screen.findByText("Sleep Signals")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /unsubscribe/i }));

    // The membership disappears after the refreshed GET /account.
    await waitFor(() => expect(screen.queryByText("Sleep Signals")).toBeNull());

    const [url, init] = unsubCallOf(fetchSpy);
    expect(String(url)).toContain("/account/newsletters/42/unsubscribe");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("include");

    // GET /account was re-fetched after the unsubscribe (initial load + refresh).
    const accountCalls = fetchSpy.mock.calls.filter(([input]) =>
      String(input).endsWith("/account"),
    );
    expect(accountCalls.length).toBeGreaterThanOrEqual(2);
  });

  test("server failure: shows a visible error and keeps the membership", async () => {
    stubFetch(() => json({ error: "nope" }, 500));
    render(<Account />);

    expect(await screen.findByText("Sleep Signals")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /unsubscribe/i }));

    expect(
      await screen.findByText("Could not update that subscription."),
    ).toBeTruthy();
    // Membership still listed; button recovers for a retry.
    expect(screen.getByText("Sleep Signals")).toBeTruthy();
    const button = screen.getByRole("button", {
      name: /unsubscribe/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  test("network failure: shows a visible error, not a silent no-op", async () => {
    stubFetch(() => {
      throw new Error("network down");
    });
    render(<Account />);

    expect(await screen.findByText("Sleep Signals")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /unsubscribe/i }));

    expect(
      await screen.findByText("Could not update that subscription."),
    ).toBeTruthy();
    expect(screen.getByText("Sleep Signals")).toBeTruthy();
  });
});
