// Client boot detection for SLM standalone mode (src/lib/app-mode.ts).
//
// The meta marker is the primary production trigger (injected by host
// dispatch); the ?slmHost query param must ALSO work in production builds so
// the workspace preview (which serves a prod build) can render the standalone
// experience.
import { describe, it, expect } from "vitest";
import { detectSlmStandalone } from "../lib/app-mode";

function docWithMeta(content: string | null): Pick<Document, "querySelector"> {
  return {
    querySelector: (sel: string) =>
      sel === 'meta[name="palonur-app-mode"]' && content !== null
        ? ({ getAttribute: () => content } as unknown as Element)
        : null,
  };
}

describe("detectSlmStandalone", () => {
  it("is off by default (no marker, no query param)", () => {
    expect(detectSlmStandalone(docWithMeta(null), "")).toBe(false);
    expect(detectSlmStandalone(docWithMeta(null), "?foo=1")).toBe(false);
  });

  it("turns on via the injected meta marker (production host dispatch)", () => {
    expect(detectSlmStandalone(docWithMeta("slm"), "")).toBe(true);
    expect(detectSlmStandalone(docWithMeta("other"), "")).toBe(false);
  });

  it("turns on via ?slmHost regardless of build mode (preview switch)", () => {
    // No import.meta.env.DEV guard — this must work on production builds too.
    expect(detectSlmStandalone(docWithMeta(null), "?slmHost=1")).toBe(true);
    expect(detectSlmStandalone(docWithMeta(null), "?slmHost")).toBe(true);
    expect(detectSlmStandalone(docWithMeta(null), "?a=b&slmHost=1")).toBe(true);
  });

  it("stays off with no document (SSR safety)", () => {
    expect(detectSlmStandalone(undefined, "?slmHost=1")).toBe(false);
  });
});
