import { describe, expect, test } from "vitest";
import { validateGroundingDecision } from "../lib/researchDiscoveryGrounding.js";

const abstract =
  "In this observational study, later sleep timing was associated with lower self-reported wellbeing. The design does not establish causation.";

describe("research discovery grounding verification", () => {
  test("accepts a supported interpretation only with substantive verbatim evidence", () => {
    const result = validateGroundingDecision(
      JSON.stringify({
        supported: true,
        evidence_quotes: [
          "later sleep timing was associated with lower self-reported wellbeing",
          "The design does not establish causation",
        ],
        reason: "Both claims are directly supported.",
      }),
      "Later sleep timing was associated with lower wellbeing, but the observational design cannot establish causation.",
      abstract,
    );
    expect(result.supported).toBe(true);
  });

  test("rejects a nonempty hallucinated or causal interpretation", () => {
    const result = validateGroundingDecision(
      JSON.stringify({
        supported: false,
        evidence_quotes: [],
        reason: "The draft turns an association into a causal claim.",
      }),
      "Later sleep timing causes depression.",
      abstract,
    );
    expect(result).toMatchObject({
      supported: false,
      reason: expect.stringMatching(/causal/i),
    });
  });

  test("rejects supported=true when the quoted evidence was invented", () => {
    const result = validateGroundingDecision(
      JSON.stringify({
        supported: true,
        evidence_quotes: ["Blue light exposure caused major depression in every participant."],
        reason: "Supported.",
      }),
      "Blue light exposure caused major depression.",
      abstract,
    );
    expect(result.supported).toBe(false);
  });

  test("rejects unsupported numbers even when the evidence quote is real", () => {
    const result = validateGroundingDecision(
      JSON.stringify({
        supported: true,
        evidence_quotes: [
          "later sleep timing was associated with lower self-reported wellbeing",
        ],
        reason: "Supported.",
      }),
      "Later sleep timing reduced wellbeing by 42%.",
      abstract,
    );
    expect(result.supported).toBe(false);
    expect(result.reason).toMatch(/number/i);
  });

  test("fails closed on malformed verifier output", () => {
    expect(
      validateGroundingDecision("supported, probably", "A claim.", abstract)
        .supported,
    ).toBe(false);
  });
});