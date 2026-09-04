import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Regression guard for the "Manage billing" portal path on /subscribe and
// /account: clicking the button must POST /api/billing/portal and redirect to
// the returned Stripe billing-portal URL, and surface the inline error when
// the request fails. If this silently breaks, paying subscribers can't cancel
// or update their card.
// ---------------------------------------------------------------------------

import Subscribe from "../pages/subscribe.js";
import Account from "../pages/account.js";

const SIGNED_IN_ME = {
  authenticated: true,
  email: "subscriber@example.com",
  subscription: {
    active: true,
    status: "active",
    plan: "monthly",
    interval: "month",
    currentPeriodEnd: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
    cancelAtPeriodEnd: false,
  },
};

const ACCOUNT_DATA = {
  email: "subscriber@example.com",
  capabilities: ["nightly"],
  paidSubscriptions: [
    {
      subscriptionId: "sub_123",
      status: "active",
      currentPeriodEnd: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
      cancelAtPeriodEnd: false,
      productName: "Palonur Pal",
      palonurPlan: "nightly",
      unitAmount: 1500,
      currency: "usd",
      interval: "month",
    },
  ],
  newsletterMemberships: [],
  availablePublications: [],
};

type PortalResponder = () => Response | Promise<Response>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Stub global fetch so both pages render their signed-in state and the
 *  billing-portal request uses the provided responder. */
function stubFetch(portal: PortalResponder) {
  const fetchSpy = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = String(input);
      if (url.includes("/billing/portal")) return portal();
      if (url.includes("/billing/plans")) return json({ plans: [] });
      if (url.includes("/consumer/me")) return json(SIGNED_IN_ME);
      if (url.endsWith("/account")) return json(ACCOUNT_DATA);
      return json({}, 401);
    },
  );
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

/** Replace window.location with a plain writable object so the portal
 *  redirect (`window.location.href = url`) can be asserted under jsdom. */
function stubLocation(): { href: string; search: string; pathname: string } {
  const fake = { href: "http://localhost/", search: "", pathname: "/" };
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: fake as unknown as Location,
  });
  return fake;
}

function portalCallOf(fetchSpy: ReturnType<typeof vi.fn>) {
  const call = fetchSpy.mock.calls.find(([input]) =>
    String(input).includes("/billing/portal"),
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

describe("/subscribe manage billing portal", () => {
  test("success: POSTs /billing/portal and redirects to the returned URL", async () => {
    const loc = stubLocation();
    const fetchSpy = stubFetch(() =>
      json({ url: "https://billing.stripe.com/p/session_portal_123" }),
    );
    render(<Subscribe />);

    const button = await screen.findByRole("button", {
      name: /manage billing/i,
    });
    fireEvent.click(button);

    await waitFor(() =>
      expect(loc.href).toBe("https://billing.stripe.com/p/session_portal_123"),
    );
    const [, init] = portalCallOf(fetchSpy);
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("include");
  });

  test("failure: renders the inline portal error and does not redirect", async () => {
    const loc = stubLocation();
    stubFetch(() => json({ error: "no portal" }, 500));
    render(<Subscribe />);

    fireEvent.click(
      await screen.findByRole("button", { name: /manage billing/i }),
    );

    expect(
      await screen.findByText("Could not open the billing portal."),
    ).toBeTruthy();
    expect(loc.href).toBe("http://localhost/");
    // Button recovers for a retry.
    const button = screen.getByRole("button", {
      name: /manage billing/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  test("network failure: renders the inline portal error", async () => {
    const loc = stubLocation();
    stubFetch(() => {
      throw new Error("network down");
    });
    render(<Subscribe />);

    fireEvent.click(
      await screen.findByRole("button", { name: /manage billing/i }),
    );

    expect(
      await screen.findByText("Could not open the billing portal."),
    ).toBeTruthy();
    expect(loc.href).toBe("http://localhost/");
  });
});

describe("/account manage billing portal", () => {
  test("success: POSTs /billing/portal and redirects to the returned URL", async () => {
    const loc = stubLocation();
    const fetchSpy = stubFetch(() =>
      json({ url: "https://billing.stripe.com/p/session_portal_acct" }),
    );
    render(<Account />);

    const button = await screen.findByRole("button", {
      name: /manage billing/i,
    });
    fireEvent.click(button);

    await waitFor(() =>
      expect(loc.href).toBe("https://billing.stripe.com/p/session_portal_acct"),
    );
    const [, init] = portalCallOf(fetchSpy);
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("include");
  });

  test("failure: renders the inline portal error and does not redirect", async () => {
    const loc = stubLocation();
    stubFetch(() => json({ error: "no portal" }, 500));
    render(<Account />);

    fireEvent.click(
      await screen.findByRole("button", { name: /manage billing/i }),
    );

    expect(
      await screen.findByText(
        "Couldn't open billing management just now — please try again.",
      ),
    ).toBeTruthy();
    expect(loc.href).toBe("http://localhost/");
    const button = screen.getByRole("button", {
      name: /manage billing/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });
});
