import { describe, test, expect, beforeAll, beforeEach, vi } from "vitest";
import {
  sendGuarded,
  emailGuardStatus,
  resetEmailGuard,
  __clearEmailSendsForTests,
  type EmailPayload,
  type SendableEmailClient,
} from "../lib/emailGuard.js";
import { ensureCaptureLoopSchema } from "./testHelpers.js";

const payload: EmailPayload = {
  from: "Palonur <noreply@palonur.com>",
  to: "user@example.com",
  subject: "Test",
  html: "<p>hi</p>",
};

function fakeClient(
  send: (p: EmailPayload) => Promise<{ data?: unknown; error?: unknown }>,
): { client: SendableEmailClient; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(send);
  return { client: { emails: { send: spy } }, spy };
}

beforeAll(async () => {
  // Provision the email_sends audit table (tests import app.ts, not index.ts,
  // so boot-time DDL never runs).
  await ensureCaptureLoopSchema();
});

beforeEach(async () => {
  // Make the rails fast + deterministic for tests.
  process.env.EMAIL_MIN_INTERVAL_MS = "0";
  process.env.EMAIL_RETRY_BASE_MS = "1";
  process.env.EMAIL_MAX_RETRIES = "3";
  delete process.env.EMAIL_DAILY_CAP;
  delete process.env.EMAIL_MONTHLY_CAP;
  delete process.env.EMAIL_DISABLED;
  // These rails tests exercise the real send machinery against a fake client, so
  // opt into "live" mode — the production-only env gate is verified separately in
  // the "environment gate" block below.
  process.env.EMAIL_LIVE_OVERRIDE = "true";
  resetEmailGuard();
  // The caps are DB-backed; start every test from an empty audit table.
  await __clearEmailSendsForTests();
});

describe("emailGuard daily cap", () => {
  test("allows sends below the cap and counts only successes", async () => {
    process.env.EMAIL_DAILY_CAP = "5";
    const { client, spy } = fakeClient(async () => ({ data: { id: "x" }, error: null }));

    for (let i = 0; i < 3; i++) {
      const res = await sendGuarded(client, payload, { label: "test" });
      expect(res.error).toBeFalsy();
    }
    expect(spy).toHaveBeenCalledTimes(3);
    expect((await emailGuardStatus()).sentToday).toBe(3);
  });

  test("blocks sends past the cap without calling the client", async () => {
    process.env.EMAIL_DAILY_CAP = "2";
    const { client, spy } = fakeClient(async () => ({ data: { id: "x" }, error: null }));

    const r1 = await sendGuarded(client, payload, { label: "test" });
    const r2 = await sendGuarded(client, payload, { label: "test" });
    const r3 = await sendGuarded(client, payload, { label: "test" });

    expect(r1.error).toBeFalsy();
    expect(r2.error).toBeFalsy();
    expect(r3.error).toBeTruthy();
    expect((r3.error as { name?: string }).name).toBe("daily_cap_reached");
    expect(spy).toHaveBeenCalledTimes(2); // 3rd never reached the client
    expect((await emailGuardStatus()).sentToday).toBe(2);
  });

  test("a failed send does not consume the daily budget", async () => {
    process.env.EMAIL_DAILY_CAP = "2";
    const { client } = fakeClient(async () => ({
      error: { name: "validation_error", statusCode: 422, message: "bad" },
    }));

    const res = await sendGuarded(client, payload, { label: "test" });
    expect(res.error).toBeTruthy();
    expect((await emailGuardStatus()).sentToday).toBe(0); // no audit row written
  });

  test("concurrent callers cannot collectively exceed the cap", async () => {
    process.env.EMAIL_DAILY_CAP = "3";
    let inFlight = 0;
    let maxInFlight = 0;
    let sends = 0;
    const { client } = fakeClient(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      sends++;
      return { data: { id: "x" }, error: null };
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => sendGuarded(client, payload, { label: "test" })),
    );

    expect(results.filter((r) => !r.error)).toHaveLength(3);
    expect(results.filter((r) => r.error)).toHaveLength(5);
    expect(sends).toBe(3); // only 3 ever reached the client
    expect(maxInFlight).toBe(1); // sends are serialized, never concurrent
    expect((await emailGuardStatus()).sentToday).toBe(3);
  });

  test("a batch crossing the UTC day boundary counts against the day it sends", async () => {
    // Fake ONLY Date so DB I/O (real sockets/timers) still works.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      process.env.EMAIL_DAILY_CAP = "2";
      vi.setSystemTime(new Date("2026-06-14T23:59:50Z"));

      const { client, spy } = fakeClient(async () => ({ data: { id: "x" }, error: null }));

      await sendGuarded(client, payload, { label: "test" });
      await sendGuarded(client, payload, { label: "test" });
      const blocked = await sendGuarded(client, payload, { label: "test" });
      expect(blocked.error).toBeTruthy(); // cap reached for 2026-06-14
      expect(spy).toHaveBeenCalledTimes(2);

      // Cross midnight UTC — the next send reserves against the fresh day.
      vi.setSystemTime(new Date("2026-06-15T00:00:10Z"));
      const afterMidnight = await sendGuarded(client, payload, { label: "test" });
      expect(afterMidnight.error).toBeFalsy();
      expect(spy).toHaveBeenCalledTimes(3);

      const status = await emailGuardStatus();
      expect(status.day).toBe("2026-06-15");
      expect(status.sentToday).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a send whose retries cross UTC midnight is charged to the new day", async () => {
    // Regression: the cap window + audit row must follow the *completed* send,
    // not the moment the queue task was dequeued. A send that starts before
    // midnight, retries, and lands after midnight belongs to the new day —
    // otherwise the new day's cap could be silently overspent.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      process.env.EMAIL_DAILY_CAP = "1";
      vi.setSystemTime(new Date("2026-06-14T23:59:59.500Z"));

      let calls = 0;
      const { client, spy } = fakeClient(async () => {
        calls++;
        if (calls === 1) {
          // First attempt fails transiently AND the clock rolls past midnight
          // before the retry succeeds.
          vi.setSystemTime(new Date("2026-06-15T00:00:00.500Z"));
          return { error: { name: "rate_limit_exceeded", statusCode: 429, message: "slow" } };
        }
        return { data: { id: "ok" }, error: null };
      });

      const res = await sendGuarded(client, payload, { label: "test" });
      expect(res.error).toBeFalsy();
      expect(spy).toHaveBeenCalledTimes(2); // failed then succeeded after midnight

      // The completed send was charged to 2026-06-15, not 2026-06-14.
      const status = await emailGuardStatus();
      expect(status.day).toBe("2026-06-15");
      expect(status.sentToday).toBe(1);

      // Proof the new day's budget really absorbed it: with a cap of 1, the
      // next same-day send is now blocked.
      const blocked = await sendGuarded(client, payload, { label: "test" });
      expect(blocked.error).toBeTruthy();
      expect((blocked.error as { name?: string }).name).toBe("daily_cap_reached");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("emailGuard monthly cap", () => {
  test("blocks sends past the monthly cap, even with daily budget left", async () => {
    process.env.EMAIL_DAILY_CAP = "100";
    process.env.EMAIL_MONTHLY_CAP = "2";
    const { client, spy } = fakeClient(async () => ({ data: { id: "x" }, error: null }));

    const r1 = await sendGuarded(client, payload, { label: "test" });
    const r2 = await sendGuarded(client, payload, { label: "test" });
    const r3 = await sendGuarded(client, payload, { label: "test" });

    expect(r1.error).toBeFalsy();
    expect(r2.error).toBeFalsy();
    expect(r3.error).toBeTruthy();
    expect((r3.error as { name?: string }).name).toBe("monthly_cap_reached");
    expect(spy).toHaveBeenCalledTimes(2);
    expect((await emailGuardStatus()).sentThisMonth).toBe(2);
  });

  test("a failed send does not consume the monthly budget", async () => {
    process.env.EMAIL_DAILY_CAP = "100";
    process.env.EMAIL_MONTHLY_CAP = "2";
    const { client } = fakeClient(async () => ({
      error: { name: "validation_error", statusCode: 422, message: "bad" },
    }));

    const res = await sendGuarded(client, payload, { label: "test" });
    expect(res.error).toBeTruthy();
    expect((await emailGuardStatus()).sentThisMonth).toBe(0);
  });

  test("status reports both windows and caps", async () => {
    process.env.EMAIL_DAILY_CAP = "7";
    process.env.EMAIL_MONTHLY_CAP = "9";
    const { client } = fakeClient(async () => ({ data: { id: "x" }, error: null }));
    await sendGuarded(client, payload, { label: "test" });

    const s = await emailGuardStatus();
    expect(s.sentToday).toBe(1);
    expect(s.sentThisMonth).toBe(1);
    expect(s.dailyCap).toBe(7);
    expect(s.monthlyCap).toBe(9);
  });
});

describe("emailGuard retry", () => {
  test("retries transient (429) errors then succeeds", async () => {
    process.env.EMAIL_DAILY_CAP = "10";
    let calls = 0;
    const { client, spy } = fakeClient(async () => {
      calls++;
      if (calls < 3) {
        return { error: { name: "rate_limit_exceeded", statusCode: 429, message: "slow down" } };
      }
      return { data: { id: "ok" }, error: null };
    });

    const res = await sendGuarded(client, payload, { label: "test" });
    expect(res.error).toBeFalsy();
    expect(spy).toHaveBeenCalledTimes(3);
    expect((await emailGuardStatus()).sentToday).toBe(1);
  });

  test("retries thrown network errors then succeeds", async () => {
    process.env.EMAIL_DAILY_CAP = "10";
    let calls = 0;
    const { client, spy } = fakeClient(async () => {
      calls++;
      if (calls < 2) throw new Error("ECONNRESET socket hang up");
      return { data: { id: "ok" }, error: null };
    });

    const res = await sendGuarded(client, payload, { label: "test" });
    expect(res.error).toBeFalsy();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test("does NOT retry validation (4xx) errors", async () => {
    process.env.EMAIL_DAILY_CAP = "10";
    const { client, spy } = fakeClient(async () => ({
      error: { name: "validation_error", statusCode: 422, message: "invalid to" },
    }));

    const res = await sendGuarded(client, payload, { label: "test" });
    expect(res.error).toBeTruthy();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("does NOT retry quota errors and gives up after max retries", async () => {
    process.env.EMAIL_DAILY_CAP = "10";
    const { client, spy } = fakeClient(async () => ({
      error: { name: "daily_quota_exceeded", message: "You have exceeded your daily quota" },
    }));

    const res = await sendGuarded(client, payload, { label: "test" });
    expect(res.error).toBeTruthy();
    expect(spy).toHaveBeenCalledTimes(1); // quota is not retryable
    expect((await emailGuardStatus()).sentToday).toBe(0);
  });
});

describe("emailGuard environment gate (production-only sending)", () => {
  test("under the test runner, the real send is skipped and returns synthetic success", async () => {
    // Drop the per-test override so the gate falls back to its real decision:
    // vitest sets VITEST, so sending is disabled.
    delete process.env.EMAIL_LIVE_OVERRIDE;
    process.env.EMAIL_DAILY_CAP = "10";
    const { client, spy } = fakeClient(async () => ({ data: { id: "x" }, error: null }));

    const res = await sendGuarded(client, payload, { label: "test" });

    expect(spy).not.toHaveBeenCalled(); // the live Resend client is never touched
    expect(res.error).toBeFalsy(); // synthetic success, so callers proceed as "sent"
    expect((res.data as { id?: string }).id).toContain("email-disabled");
    expect((await emailGuardStatus()).sentToday).toBe(0); // disabled sends never consume the cap
  });

  test("EMAIL_DISABLED acts as a kill switch even when not under the test runner", async () => {
    delete process.env.EMAIL_LIVE_OVERRIDE;
    process.env.EMAIL_DISABLED = "true";
    const { client, spy } = fakeClient(async () => ({ data: { id: "x" }, error: null }));

    const res = await sendGuarded(client, payload, { label: "test" });

    expect(spy).not.toHaveBeenCalled();
    expect(res.error).toBeFalsy();
    expect((res.data as { id?: string }).id).toContain("EMAIL_DISABLED");
  });

  test("EMAIL_LIVE_OVERRIDE re-enables the real send", async () => {
    process.env.EMAIL_LIVE_OVERRIDE = "true";
    process.env.EMAIL_DAILY_CAP = "10";
    const { client, spy } = fakeClient(async () => ({ data: { id: "x" }, error: null }));

    const res = await sendGuarded(client, payload, { label: "test" });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(res.error).toBeFalsy();
    expect((await emailGuardStatus()).sentToday).toBe(1);
  });
});
