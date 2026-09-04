import { describe, test, expect } from "vitest";
import { scoreDraftAcceptance } from "../lib/draftSimilarity.js";
import { AI_DRAFT_PREFIX } from "../lib/draftInterpretation.js";

describe("scoreDraftAcceptance", () => {
  test("returns no_draft when there is no draft on file", () => {
    expect(scoreDraftAcceptance(null, "Steward wrote this by hand.")).toEqual({
      similarity: null,
      acceptance: "no_draft",
    });
    expect(scoreDraftAcceptance("", "anything")).toEqual({
      similarity: null,
      acceptance: "no_draft",
    });
  });

  test("kept verbatim → unedited", () => {
    const draft =
      "Two hours of bright morning light advances the circadian clock by about 35 minutes.";
    const r = scoreDraftAcceptance(draft, draft);
    expect(r.acceptance).toBe("unedited");
    expect(r.similarity).toBeGreaterThanOrEqual(0.95);
  });

  test("ignores AI_DRAFT_PREFIX banner when comparing", () => {
    const body =
      "Two hours of bright morning light advances the circadian clock by about 35 minutes.";
    // The persisted draft has no prefix; the approved body might still
    // carry the banner if the steward hit Approve without stripping it.
    const r = scoreDraftAcceptance(body, AI_DRAFT_PREFIX + body);
    expect(r.acceptance).toBe("unedited");
  });

  test("light edits → light bucket", () => {
    const draft =
      "Two hours of bright morning light advances the circadian clock by about 35 minutes.";
    // ~10 chars changed out of ~85 → similarity ~0.88
    const final =
      "Two hours of bright morning light shifts your circadian clock by about 35 minutes.";
    const r = scoreDraftAcceptance(draft, final);
    expect(r.acceptance).toBe("light");
    expect(r.similarity).toBeGreaterThan(0.7);
    expect(r.similarity).toBeLessThan(0.95);
  });

  test("complete rewrite → rewritten bucket", () => {
    const draft =
      "Two hours of bright morning light advances the circadian clock by about 35 minutes.";
    const final =
      "Get sunlight on your face within an hour of waking — that's the single most reliable knob for sleep timing.";
    const r = scoreDraftAcceptance(draft, final);
    expect(r.acceptance).toBe("rewritten");
    expect(r.similarity).toBeLessThan(0.7);
  });
});
