import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Regression guard for the two non-checkout revenue-adjacent forms on
// /subscribe: the returning-subscriber magic-link sign-in and the free-account
// signup. Both POST /api/consumer/auth/request; a silent break here blocks new
// free users and returning subscribers from signing in.
// ---------------------------------------------------------------------------

import Subscribe from "../pages/subscribe.js";

type AuthResponder = () => Response | Promise<Response>;

// A live plan is needed for the paid card (where the shared inline `error`
// renders) to be present on the page.
const NIGHTLY_PLAN = {
  productId: "prod_all_access",
  priceId: "price_nightly_monthly",
  name: "Palonur All-Access",
  description: "Every expert, every pillar, one subscription.",
  planKey: "all_access",
  unitAmount: 1500,
  currency: "usd",
  interval: "month",
  plan: "monthly",
};

/** Stub global fetch: /billing/plans returns the nightly plan,
 *  /consumer/auth/request uses the provided responder, everything else 401s
 *  (page renders signed-out). Returns a spy for request-body assertions. */
function stubFetch(auth: AuthResponder) {
  const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void init;
    const url = String(input);
    if (url.includes("/billing/plans")) {
      return new Response(JSON.stringify({ plans: [NIGHTLY_PLAN] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/consumer/auth/request")) {
      return auth();
    }
    return new Response(JSON.stringify({}), { status: 401 });
  });
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

function authCallOf(fetchSpy: ReturnType<typeof vi.fn>) {
  const call = fetchSpy.mock.calls.find(([input]) =>
    String(input).includes("/consumer/auth/request"),
  );
  expect(call).toBeTruthy();
  return call as [RequestInfo | URL, RequestInit | undefined];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("/subscribe returning-subscriber sign-in", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/subscribe");
  });

  async function openAndSubmitSignIn(email: string) {
    render(<Subscribe />);
    await waitFor(() => expect(screen.queryByText(/loading plans/i)).toBeNull());
    fireEvent.click(
      screen.getByRole("button", { name: /already subscribed\? sign in/i }),
    );
    const input = screen.getByPlaceholderText<HTMLInputElement>(/your email/i);
    fireEvent.change(input, { target: { value: email } });
    fireEvent.click(screen.getByRole("button", { name: /send link/i }));
  }

  test("success: POSTs the email and renders the link-sent state", async () => {
    const fetchSpy = stubFetch(
      () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    await openAndSubmitSignIn("returning@example.com");

    expect(
      await screen.findByText(/check your inbox — we sent a sign-in link/i),
    ).toBeTruthy();
    // The form is replaced by the sent state.
    expect(screen.queryByRole("button", { name: /send link/i })).toBeNull();

    const [, init] = authCallOf(fetchSpy);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      email: "returning@example.com",
    });
  });

  test("network failure: renders the inline error and keeps the form", async () => {
    stubFetch(() => {
      throw new Error("network down");
    });

    await openAndSubmitSignIn("returning@example.com");

    expect(
      await screen.findByText(/could not send the sign-in link/i),
    ).toBeTruthy();
    // No sent state; the form stays available for a retry.
    expect(screen.queryByText(/we sent a sign-in link/i)).toBeNull();
    const button = screen.getByRole("button", {
      name: /send link/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });
});

describe("/subscribe free-account signup", () => {
  beforeEach(() => {
    // ?plan=free switches the page into free-signup mode.
    window.history.replaceState({}, "", "/subscribe?plan=free");
  });

  async function submitFreeSignup(email: string) {
    render(<Subscribe />);
    await waitFor(() =>
      expect(screen.getByText(/create your free account/i)).toBeTruthy(),
    );
    const input = screen.getByPlaceholderText<HTMLInputElement>(/email address/i);
    fireEvent.change(input, { target: { value: email } });
    fireEvent.click(screen.getByRole("button", { name: /sign up free/i }));
  }

  test("success: POSTs the email and renders the link-sent state", async () => {
    const fetchSpy = stubFetch(
      () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    await submitFreeSignup("newbie@example.com");

    expect(
      await screen.findByText(/we sent a link to finish creating your/i),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /sign up free/i })).toBeNull();

    const [, init] = authCallOf(fetchSpy);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      email: "newbie@example.com",
    });
  });

  test("server failure: renders the inline error and keeps the form", async () => {
    stubFetch(() => new Response("oops", { status: 500 }));

    await submitFreeSignup("newbie@example.com");

    expect(
      await screen.findByText(/could not send your sign-up link/i),
    ).toBeTruthy();
    expect(screen.queryByText(/finish creating your/i)).toBeNull();
    const button = screen.getByRole("button", {
      name: /sign up free/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  test("network failure: renders the inline error", async () => {
    stubFetch(() => {
      throw new Error("network down");
    });

    await submitFreeSignup("newbie@example.com");

    expect(
      await screen.findByText(/could not send your sign-up link/i),
    ).toBeTruthy();
  });
});
