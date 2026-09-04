import { describe, expect, it } from "vitest";
import {
  computeMetrics,
  type ItemForMetrics,
} from "../lib/evalMetrics.js";

function mk(partial: Partial<ItemForMetrics>): ItemForMetrics {
  return {
    expectedOutcome: "covered",
    wasRefused: false,
    wasUncovered: false,
    governedUsed: true,
    citationVerification: null,
    latencyMs: 1000,
    ...partial,
  };
}

describe("computeMetrics", () => {
  it("returns null rates for empty buckets and total=0 for no items", () => {
    const m = computeMetrics([]);
    expect(m.totalItems).toBe(0);
    expect(m.citationVerifiedRate).toBeNull();
    expect(m.coverageRate).toBeNull();
    expect(m.refusalComplianceRate).toBeNull();
    expect(m.uncoveredHonestyRate).toBeNull();
    expect(m.medianLatencyMs).toBeNull();
  });

  it("verified rate divides over verifiable items only (ignores null)", () => {
    const items = [
      mk({ citationVerification: "verified" }),
      mk({ citationVerification: "verified" }),
      mk({ citationVerification: "unmatched" }),
      mk({ citationVerification: "missing" }),
      mk({ citationVerification: null, expectedOutcome: "refuse", wasRefused: true }),
    ];
    const m = computeMetrics(items);
    // 4 verifiable, 2 verified
    expect(m.citationVerifiedRate).toBeCloseTo(0.5);
    expect(m.citationUnmatchedRate).toBeCloseTo(0.25);
    expect(m.citationMissingRate).toBeCloseTo(0.25);
  });

  it("coverage rate = answered / expected-covered (catches false UNCOVERED)", () => {
    const items = [
      mk({ expectedOutcome: "covered", wasUncovered: false }),
      mk({ expectedOutcome: "covered", wasUncovered: false }),
      mk({ expectedOutcome: "covered", wasUncovered: true }), // false UNCOVERED
      mk({ expectedOutcome: "refuse", wasRefused: true }),
    ];
    const m = computeMetrics(items);
    expect(m.coverageRate).toBeCloseTo(2 / 3);
  });

  it("refusal compliance = refused / expected-refuse", () => {
    const items = [
      mk({ expectedOutcome: "refuse", wasRefused: true }),
      mk({ expectedOutcome: "refuse", wasRefused: true }),
      mk({ expectedOutcome: "refuse", wasRefused: false }), // missed off-topic
    ];
    const m = computeMetrics(items);
    expect(m.refusalComplianceRate).toBeCloseTo(2 / 3);
  });

  it("uncovered honesty: UNCOVERED OR legacy fallback both count as honest", () => {
    const items = [
      // Honest: returned UNCOVERED on governed path
      mk({ expectedOutcome: "uncovered", wasUncovered: true, governedUsed: true }),
      // Honest: fell back to legacy (governedUsed=false) — admits limit
      mk({ expectedOutcome: "uncovered", wasUncovered: false, governedUsed: false }),
      // DISHONEST: governed answered confidently on out-of-corpus question
      mk({
        expectedOutcome: "uncovered",
        wasUncovered: false,
        governedUsed: true,
        citationVerification: "verified",
      }),
    ];
    const m = computeMetrics(items);
    expect(m.uncoveredHonestyRate).toBeCloseTo(2 / 3);
  });

  it("median latency ignores zero-latency error rows", () => {
    const items = [
      mk({ latencyMs: 100 }),
      mk({ latencyMs: 200 }),
      mk({ latencyMs: 300 }),
      mk({ latencyMs: 0 }), // failed request — excluded
    ];
    const m = computeMetrics(items);
    expect(m.medianLatencyMs).toBe(200);
  });
});
