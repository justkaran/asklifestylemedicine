import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Regression guard for the revenue-critical checkout submit path on /subscribe
//: submitting the form must POST /api/billing/checkout with the
// entered email + selected priceId, redirect to the returned Stripe URL on
// success, and surface the inline error message on failure. A silent break
// here blocks every purchase.
// ---------------------------------------------------------------------------

import Subscribe from "../pages/subscribe.js";

interface PlanFixture {
  productId: string;
  priceId: string;
  name: string | null;
  description: string | null;
  planKey: string | null;
  unitAmount: number | null;
  currency: string | null;
  interval: string | null;
  plan: "monthly" | "annual" | null;
}

const NIGHTLY_PLAN: PlanFixture = {
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

type CheckoutResponder = () => Response | Promise<Response>;

/** Stub global fetch: /billing/plans returns the given plans, /billing/checkout
 *  uses the provided responder, everything else 401s (pages render signed-out).
 *  Returns a spy so tests can inspect the checkout request body. */
function stubFetch(plans: PlanFixture[], checkout: CheckoutResponder) {
  const fetchSpy = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = String(input);
      if (url.includes("/billing/plans")) {
        return new Response(JSON.stringify({ plans }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/billing/checkout")) {
        return checkout();
      }
      return new Response(JSON.stringify({}), { status: 401 });
    },
  );
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

/** Replace window.location with a plain writable object so the checkout
 *  redirect (`window.location.href = url`) can be asserted under jsdom
 *  (which otherwise throws "Not implemented: navigation"). */
function stubLocation(): { href: string } {
  const fake = { href: "http://localhost/" };
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: fake as unknown as Location,
  });
  return fake;
}

function checkoutCallOf(fetchSpy: ReturnType<typeof vi.fn>) {
  const call = fetchSpy.mock.calls.find(([input]) =>
    String(input).includes("/billing/checkout"),
  );
  expect(call).toBeTruthy();
  return call as [RequestInfo | URL, RequestInit | undefined];
}

const originalLocation = window.location;

beforeEach(() => {
  window.history.replaceState({}, "", "/subscribe");
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function fillAndSubmit(email: string) {
  const input = screen.getByPlaceholderText<HTMLInputElement>(/email address/i);
  fireEvent.change(input, { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: /subscribe →/i }));
}

describe("/subscribe checkout submit", () => {
  test("success: POSTs email + priceId and redirects to the returned URL", async () => {
    const loc = stubLocation();
    const fetchSpy = stubFetch(
      [NIGHTLY_PLAN],
      () =>
        new Response(
          JSON.stringify({ url: "https://checkout.stripe.com/c/session_123" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    render(<Subscribe />);
    await waitFor(() =>
      expect(screen.queryByText(/loading plans/i)).toBeNull(),
    );

    await fillAndSubmit("buyer@example.com");

    await waitFor(() =>
      expect(loc.href).toBe("https://checkout.stripe.com/c/session_123"),
    );
    const [, init] = checkoutCallOf(fetchSpy);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      email: "buyer@example.com",
      priceId: NIGHTLY_PLAN.priceId,
    });
  });

  test("failure: renders the server's inline error and does not redirect", async () => {
    const loc = stubLocation();
    stubFetch(
      [NIGHTLY_PLAN],
      () =>
        new Response(JSON.stringify({ error: "Card declined by Stripe" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
    );
    render(<Subscribe />);
    await waitFor(() =>
      expect(screen.queryByText(/loading plans/i)).toBeNull(),
    );

    await fillAndSubmit("buyer@example.com");

    expect(await screen.findByText("Card declined by Stripe")).toBeTruthy();
    expect(loc.href).toBe("http://localhost/");
    // Form recovers: submit button is enabled again for a retry.
    const button = screen.getByRole("button", {
      name: /subscribe →/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  test("failure without a server message: renders the generic inline error", async () => {
    stubFetch([NIGHTLY_PLAN], () => new Response("oops", { status: 500 }));
    render(<Subscribe />);
    await waitFor(() =>
      expect(screen.queryByText(/loading plans/i)).toBeNull(),
    );

    await fillAndSubmit("buyer@example.com");

    expect(
      await screen.findByText(/something went wrong — please try again/i),
    ).toBeTruthy();
  });
});
