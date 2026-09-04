import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Regression guard for the revenue-critical storefront fallback: when
// /api/billing/plans returns no matching prices, the Pal (/subscribe) and
// benefit list — degrading price/checkout gracefully — and must NEVER show the
// old "isn't available… check back soon" dead-end copy.
// ---------------------------------------------------------------------------

import Subscribe from "../pages/subscribe.js";

const NOT_AVAILABLE_RE =
  /not available|isn't available|isn.t available|check back soon/i;

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

/** Stub global fetch: /billing/plans returns the given plans; everything else returns 401. */
function stubFetch(plans: PlanFixture[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/billing/plans")) {
        return new Response(JSON.stringify({ plans }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 401 });
    }),
  );
}

beforeEach(() => {
  window.history.replaceState({}, "", "/subscribe");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("/subscribe Pal card with NO matching plans", () => {
  test("renders title, tagline, and benefits — never 'not available'", async () => {
    stubFetch([]);
    const { container } = render(<Subscribe />);

    // Wait for the plans load to settle (loading indicator gone).
    await waitFor(() =>
      expect(screen.queryByText(/loading plans/i)).toBeNull(),
    );

    // Title + tagline still render.
    expect(screen.getAllByText("Palonur Pal").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/dr\. jamie zeitzer/i).length).toBeGreaterThan(
      0,
    );

    // The ✓ benefit list always renders even with no live price.
    expect(
      screen.getByText(/unlimited answers from all pillars, any hour/i),
    ).toBeTruthy();
    expect(screen.getByText(/cancel anytime — no lock-in/i)).toBeTruthy();

    // Graceful degradation pointer instead of a dead-end.
    expect(
      screen.getByText(/ask the sleep agent a question free/i),
    ).toBeTruthy();

    // The dead-end copy must never come back.
    expect(container.textContent ?? "").not.toMatch(NOT_AVAILABLE_RE);
  });
});

describe("/subscribe Pal card WITH plans", () => {
  test("renders price and the subscribe/checkout form", async () => {
    stubFetch([NIGHTLY_PLAN]);
    const { container } = render(<Subscribe />);

    await waitFor(() =>
      expect(screen.queryByText(/loading plans/i)).toBeNull(),
    );

    // Live price renders.
    expect(screen.getByText("$15")).toBeTruthy();
    // Checkout form renders (email input + submit inside the price card).
    const emailInputs = container.querySelectorAll('input[type="email"]');
    expect(emailInputs.length).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("button", { name: /subscribe/i }).length,
    ).toBeGreaterThan(0);
    // No fallback pointer when a price exists.
    expect(
      screen.queryByText(/ask the sleep agent a question free/i),
    ).toBeNull();
  });
});
