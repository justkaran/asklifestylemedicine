/**
 * Pure metric functions for the blinded eval harness. Lives in
 * api-server (not scripts) so the same code computes metrics for the
 * recompute endpoint AND can be unit-tested with the existing vitest
 * setup. The CLI runner just POSTs to /api/evals/runs/:id/recompute
 * after writing items; it does not duplicate this logic.
 */

export interface ItemForMetrics {
  expectedOutcome: "covered" | "uncovered" | "refuse";
  wasRefused: boolean;
  wasUncovered: boolean;
  governedUsed: boolean;
  citationVerification: string | null;
  latencyMs: number;
}

export interface AggregateMetrics {
  totalItems: number;
  citationVerifiedRate: number | null;
  citationUnmatchedRate: number | null;
  citationMissingRate: number | null;
  coverageRate: number | null;
  refusalComplianceRate: number | null;
  uncoveredHonestyRate: number | null;
  medianLatencyMs: number | null;
}

function safeRate(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return numerator / denominator;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
    : sorted[mid]!;
}

/**
 * Compute aggregate metrics across the items of one run. All rates
 * 0..1, null when the denominator is zero (so the UI renders "n/a"
 * rather than NaN).
 *
 *   citation_verified_rate    of verifiable items, fraction "verified".
 *                             Headline anti-hallucination number.
 *   coverage_rate             of expected=covered, fraction NOT
 *                             was_uncovered. Catches false UNCOVERED.
 *   refusal_compliance_rate   of expected=refuse, fraction REFUSE:.
 *                             Off-topic firewall.
 *   uncovered_honesty_rate    of expected=uncovered, fraction that
 *                             returned UNCOVERED: OR fell back to
 *                             legacy. The failure mode is confabulating
 *                             so honesty = anything that admits the
 *                             limit.
 */
export function computeMetrics(items: ItemForMetrics[]): AggregateMetrics {
  const covered = items.filter((i) => i.expectedOutcome === "covered");
  const uncovered = items.filter((i) => i.expectedOutcome === "uncovered");
  const refuse = items.filter((i) => i.expectedOutcome === "refuse");

  const verifiable = items.filter((i) => i.citationVerification !== null);
  const verified = verifiable.filter(
    (i) => i.citationVerification === "verified",
  );
  const unmatched = verifiable.filter(
    (i) => i.citationVerification === "unmatched",
  );
  const missing = verifiable.filter(
    (i) => i.citationVerification === "missing",
  );

  const coveredAnswered = covered.filter((i) => !i.wasUncovered);
  const refusedCorrectly = refuse.filter((i) => i.wasRefused);
  const uncoveredHonest = uncovered.filter(
    (i) => i.wasUncovered || !i.governedUsed,
  );

  return {
    totalItems: items.length,
    citationVerifiedRate: safeRate(verified.length, verifiable.length),
    citationUnmatchedRate: safeRate(unmatched.length, verifiable.length),
    citationMissingRate: safeRate(missing.length, verifiable.length),
    coverageRate: safeRate(coveredAnswered.length, covered.length),
    refusalComplianceRate: safeRate(refusedCorrectly.length, refuse.length),
    uncoveredHonestyRate: safeRate(uncoveredHonest.length, uncovered.length),
    medianLatencyMs: median(items.map((i) => i.latencyMs).filter((n) => n > 0)),
  };
}
