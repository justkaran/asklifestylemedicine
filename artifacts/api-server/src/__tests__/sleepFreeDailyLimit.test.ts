import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { consumeFreeQuestion } from "../routes/sleep-agent.js";

// Regression guard for the consumer free sleep tier: the tally is a genuine
// per-UTC-day allowance (resets at midnight), not a one-time lifetime trial.
// Pairs with the route gate `used > SLEEP_FREE_DAILY_LIMIT` (default 1).
describe("sleep free-question daily window", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("accumulates within a UTC day, then resets after midnight", () => {
    const session = `unit-${Math.random().toString(36).slice(2)}`;

    vi.setSystemTime(new Date("2026-06-29T08:00:00.000Z"));
    expect(consumeFreeQuestion(session)).toBe(1);
    expect(consumeFreeQuestion(session)).toBe(2);
    expect(consumeFreeQuestion(session)).toBe(3);

    // Later the same UTC day keeps accumulating (no reset).
    vi.setSystemTime(new Date("2026-06-29T23:59:59.000Z"));
    expect(consumeFreeQuestion(session)).toBe(4);

    // UTC-midnight rollover resets the tally back to 1.
    vi.setSystemTime(new Date("2026-06-30T00:00:01.000Z"));
    expect(consumeFreeQuestion(session)).toBe(1);
    expect(consumeFreeQuestion(session)).toBe(2);
  });

  test("counts are independent per session", () => {
    vi.setSystemTime(new Date("2026-06-29T08:00:00.000Z"));
    const a = `unit-a-${Math.random().toString(36).slice(2)}`;
    const b = `unit-b-${Math.random().toString(36).slice(2)}`;

    expect(consumeFreeQuestion(a)).toBe(1);
    expect(consumeFreeQuestion(a)).toBe(2);
    expect(consumeFreeQuestion(b)).toBe(1);
    expect(consumeFreeQuestion(a)).toBe(3);
  });
});
