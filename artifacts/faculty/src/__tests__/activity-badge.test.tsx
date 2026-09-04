import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

// App.tsx runs Clerk wiring at module scope and pulls in the whole Clerk SDK.
// The Activity badge only needs `isSignedIn` (to enable the inbox query), so
// stub the SDK with a signed-in user to keep the import light and deterministic
// under jsdom.
vi.mock("@clerk/react", () => {
  const passthrough = ({ children }: { children?: unknown }) => children ?? null;
  return {
    ClerkProvider: passthrough,
    SignIn: () => null,
    Show: passthrough,
    SignOutButton: passthrough,
    useClerk: () => ({}),
    useUser: () => ({
      isSignedIn: true,
      user: { primaryEmailAddress: { emailAddress: "admin@stanford.edu" } },
      isLoaded: true,
    }),
  };
});
vi.mock("@clerk/react/internal", () => ({
  publishableKeyFromHost: () => "pk_test_dummy",
}));

import { PortalShell, setViewAs } from "../App.js";

// ---------------------------------------------------------------------------
// The Activity attention badge counts incoming cross-pillar merge requests in
// the `proposed` state, honoring admin "view-as" scoping. The count is wired
// into both the Activity menu button (testId `nav-activity-badge`) and the
// Requests item inside it (testId `link-requests-badge`), and `fetchJson`
// attaches `x-faculty-view-as` when an admin is previewing another steward, so
// the inbox response — and therefore the count — reflects the viewed steward.
// ---------------------------------------------------------------------------
type MergeStatus = "proposed" | "approved" | "declined";

function mr(id: number, status: MergeStatus) {
  return {
    id,
    status,
    note: null,
    declineReason: null,
    createdAt: new Date().toISOString(),
    reviewedAt: null,
    sourceInterpretationId: id,
    sourcePillarId: 1,
    targetPillarId: 2,
    resultingInterpretationId: null,
    interpretationAnswer: null,
    sourcePillarName: "Sleep",
    sourcePillarSlug: "sleep",
    requesterName: "A Steward",
    targetPillarName: "Movement",
  };
}

const ME = {
  user: {
    id: 1,
    email: "admin@stanford.edu",
    fullName: "Platform Admin",
    institution: null,
    photoUrl: null,
    isPlatformAdmin: true,
  },
  memberships: [],
  pillars: [],
  awaitingInvitation: false,
  onboarded: true,
};

// The caller's own inbox, plus per-viewed-steward inboxes keyed by the value of
// the `x-faculty-view-as` header. The fetch stub routes by that header so a
// view-as preview returns the previewed steward's requests, not the admin's.
let ownInbox: ReturnType<typeof mr>[] = [];
let inboxByViewAs: Record<string, ReturnType<typeof mr>[]> = {};
// Records the `x-faculty-view-as` header sent on the inbox request (or null).
let lastInboxViewAsHeader: string | null = null;

beforeEach(() => {
  ownInbox = [];
  inboxByViewAs = {};
  lastInboxViewAsHeader = null;
  setViewAs(null);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (url.includes("/cross-pillar/merge-requests")) {
        const viewAs = headers["x-faculty-view-as"] ?? null;
        lastInboxViewAsHeader = viewAs;
        const requests = viewAs ? (inboxByViewAs[viewAs] ?? []) : ownInbox;
        return new Response(JSON.stringify({ requests }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/faculty/me")) {
        return new Response(JSON.stringify(ME), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // Any other call is benign here.
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  setViewAs(null);
  vi.unstubAllGlobals();
});

// Fresh QueryClient per render so one test's inbox cache can't bleed into the
// next (the inbox query key is static `["merge-requests","inbox"]`).
function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

describe("Activity attention badge — pending cross-pillar requests", () => {
  test("Activity menu and Requests item show the count of proposed inbox requests", async () => {
    // Two proposed + one already-resolved → the badge must show 2, not 3.
    ownInbox = [mr(1, "proposed"), mr(2, "proposed"), mr(3, "approved")];

    renderWithClient(
      <PortalShell>
        <div data-testid="content" />
      </PortalShell>,
    );

    const navBadge = await screen.findByTestId("nav-activity-badge");
    expect(navBadge.textContent).toBe("2");

    // The Requests item lives inside the menu, which only renders when open.
    expect(screen.queryByTestId("link-requests-badge")).toBeNull();
    fireEvent.click(screen.getByTestId("nav-activity"));

    const requestsBadge = await screen.findByTestId("link-requests-badge");
    expect(requestsBadge.textContent).toBe("2");
    const requestsItem = screen.getByTestId("link-requests");
    expect(within(requestsItem).getByTestId("link-requests-badge")).toBeTruthy();
  });

  test("no badge renders when the inbox has zero proposed requests", async () => {
    // Only resolved requests in the inbox → nothing awaiting attention.
    ownInbox = [mr(1, "approved"), mr(2, "declined")];

    renderWithClient(
      <PortalShell>
        <div data-testid="content" />
      </PortalShell>,
    );

    // The Activity menu itself is always present; the badge must be absent.
    await screen.findByTestId("nav-activity");
    expect(screen.queryByTestId("nav-activity-badge")).toBeNull();

    // Even with the menu open, the Requests item carries no badge.
    fireEvent.click(screen.getByTestId("nav-activity"));
    await screen.findByTestId("link-requests");
    expect(screen.queryByTestId("link-requests-badge")).toBeNull();
  });

  test("count reflects the viewed steward when an admin previews via x-faculty-view-as", async () => {
    // The admin's OWN inbox has a single proposed request; the previewed
    // steward's inbox has three. Previewing must surface the steward's count.
    ownInbox = [mr(99, "proposed")];
    inboxByViewAs["42"] = [
      mr(1, "proposed"),
      mr(2, "proposed"),
      mr(3, "proposed"),
    ];
    setViewAs({ id: 42, name: "Previewed Steward" });

    renderWithClient(
      <PortalShell>
        <div data-testid="content" />
      </PortalShell>,
    );

    const navBadge = await screen.findByTestId("nav-activity-badge");
    expect(navBadge.textContent).toBe("3");
    // The scoping happened via the header, not the admin's own inbox.
    expect(lastInboxViewAsHeader).toBe("42");

    fireEvent.click(screen.getByTestId("nav-activity"));
    const requestsBadge = await screen.findByTestId("link-requests-badge");
    expect(requestsBadge.textContent).toBe("3");
  });
});
