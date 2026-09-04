import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Standalone SLM chat — session bootstrap race guard (sessionGenRef).
// Contract under guard:
//   - a /api/consumer/me bootstrap response that started BEFORE a session
//     transition (registration or sign-out) must never overwrite the state
//     of the newer session. Concretely:
//       * a stale "signed out" /me must not verify-lock a user whose
//         brand-new provisional session is valid, and
//       * a stale "authenticated" /me resolving after sign-out must not
//         restore the signed-in header for the next visitor.
// ---------------------------------------------------------------------------

import SlmChat from "../pages/slm-chat.js";

type Deferred = { resolve: (r: Response) => void; promise: Promise<Response> };

function deferred(): Deferred {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

beforeEach(() => {
  localStorage.clear();
  // jsdom has no Element.scrollTo; the thread autoscroll effect calls it.
  Element.prototype.scrollTo = (() => {}) as unknown as typeof Element.prototype.scrollTo;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SLM standalone chat session-generation guard", () => {
  test("delayed pre-registration /me cannot clobber the new session, and a stale authed /me cannot survive sign-out", async () => {
    const me = deferred();
    let agentCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("api/consumer/me")) return me.promise;
        if (url.includes("api/consumer/auth/register")) {
          return json({ ok: true, provisional: true });
        }
        if (url.includes("api/consumer/auth/logout")) return json({ ok: true });
        if (url.includes("api/slm-agent/stewards")) return json({ stewards: [] });
        if (url.includes("api/slm-agent/history")) return json({ turns: [] });
        if (url.includes("api/slm-agent")) {
          void init;
          // First ask (signed out) → register-first gate. The post-register
          // auto-ask of the held question just errors (a 500 keeps the
          // session intact — only 401 has auth side effects).
          agentCalls += 1;
          return agentCalls === 1
            ? new Response("Unauthorized", { status: 401 })
            : new Response("", { status: 500 });
        }
        return json({});
      }),
    );

    render(<SlmChat />);

    // Ask while the bootstrap /me is STILL pending → sign-in card appears.
    const box = await screen.findByPlaceholderText(/Dear Professor|Ask a (question|follow-up)/i);
    fireEvent.change(box, { target: { value: "Does exercise help sleep?" } });
    fireEvent.keyDown(box, { key: "Enter" });

    // Register: name step, then email step → provisional session granted.
    const nameField = await screen.findByPlaceholderText("Your first name");
    fireEvent.change(nameField, { target: { value: "Audit" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    const emailField = await screen.findByPlaceholderText("you@example.com");
    fireEvent.change(emailField, { target: { value: "audit@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /create my account/i }));

    // Registered: signed-in header (Sign out) appears.
    const signOutBtn = await screen.findByRole("button", { name: /sign out/i });

    // Sign out again immediately.
    fireEvent.click(signOutBtn);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /sign out/i })).toBeNull(),
    );

    // NOW the slow pre-registration /me finally resolves — claiming an
    // authenticated session. It is two session generations stale and must
    // be discarded: the header stays signed out, no verify-lock appears.
    me.resolve(
      json({ authenticated: true, displayName: "Ghost", provisional: true }),
    );
    // Give the microtask queue a chance to (incorrectly) apply it.
    await new Promise((r) => setTimeout(r, 20));

    expect(screen.queryByRole("button", { name: /sign out/i })).toBeNull();
    expect(screen.queryByText(/confirm your email to continue/i)).toBeNull();
  });
});
