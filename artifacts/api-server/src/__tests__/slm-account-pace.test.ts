import { describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// Per-account velocity rail for the standalone SLM chat.
// Contract under guard:
//   - questions closer together than the minimum interval are paced with a
//     "too fast" message (slot NOT consumed);
//   - past the daily ceiling the account is told to come back tomorrow;
//   - a new UTC day resets the count.
// Pure in-memory helper — no DB, safe to run in the shared-DB suite.
// ---------------------------------------------------------------------------

import { takeAccountQuestionSlot } from "../routes/slm-agent";

const DAY1 = Date.parse("2026-08-14T10:00:00Z");
const GAP = 16_000; // > default 15s minimum interval

describe("takeAccountQuestionSlot", () => {
  test("paces rapid-fire questions but allows properly spaced ones", () => {
    const id = 910_001;
    expect(takeAccountQuestionSlot(id, DAY1)).toBeNull();
    // 2s later — too fast.
    expect(takeAccountQuestionSlot(id, DAY1 + 2_000)).toMatch(/wait a few seconds/i);
    // Spaced out — allowed again.
    expect(takeAccountQuestionSlot(id, DAY1 + GAP)).toBeNull();
  });

  test("daily ceiling trips, and resets on the next UTC day", () => {
    const id = 910_002;
    let t = DAY1;
    for (let i = 0; i < 300; i += 1) {
      expect(takeAccountQuestionSlot(id, t)).toBeNull();
      t += GAP;
    }
    expect(takeAccountQuestionSlot(id, t)).toMatch(/limit/i);
    // Next UTC day: fresh allowance.
    const day2 = Date.parse("2026-08-15T10:00:00Z");
    expect(takeAccountQuestionSlot(id, Math.max(day2, t + GAP))).toBeNull();
  });

  test("avatar-chat turns are paced on their own lane and still count daily", () => {
    const id = 910_005;
    // Main question, then an avatar-chat turn 2s later: chat has its own
    // (shorter) lane, so the main 15s gap does not block it.
    expect(takeAccountQuestionSlot(id, DAY1)).toBeNull();
    expect(takeAccountQuestionSlot(id, DAY1 + 2_000, { chatTurn: true })).toBeNull();
    // Rapid-fire chat turns ARE paced (own 3s interval)...
    expect(
      takeAccountQuestionSlot(id, DAY1 + 2_500, { chatTurn: true }),
    ).toMatch(/wait a few seconds/i);
    // ...and a chat turn does not reset the main gap: a main question 16s
    // after the ORIGINAL one is allowed even though a chat turn was recent.
    expect(takeAccountQuestionSlot(id, DAY1 + GAP)).toBeNull();

    // Chat turns still spend the daily allowance.
    const heavy = 910_006;
    let t = DAY1;
    for (let i = 0; i < 300; i += 1) {
      expect(takeAccountQuestionSlot(heavy, t, { chatTurn: true })).toBeNull();
      t += 3_100;
    }
    expect(takeAccountQuestionSlot(heavy, t, { chatTurn: true })).toMatch(/limit/i);
  });

  test("accounts are paced independently", () => {
    const a = 910_003;
    const b = 910_004;
    expect(takeAccountQuestionSlot(a, DAY1)).toBeNull();
    expect(takeAccountQuestionSlot(b, DAY1 + 1_000)).toBeNull();
  });
});
