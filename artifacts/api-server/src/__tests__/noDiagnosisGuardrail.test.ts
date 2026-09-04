import { describe, test, expect, vi } from "vitest";

// Set env BEFORE the route/lib modules load — they read these once at
// module-init time.
vi.hoisted(() => {
  process.env.USE_GOVERNED_RAG = "true";
  process.env.RESEND_API_KEY = "stub-key";
});

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: async () => ({ id: "stub-id" }) };
  },
}));

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      create: async () => ({ content: [{ type: "text", text: "" }] }),
      stream: () => {
        async function* gen() {
          yield {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "ANSWER:\nok" },
          };
        }
        return gen();
      },
    };
  }
  return { default: FakeAnthropic };
});

import {
  SYSTEM_PROMPT,
  NEUTRAL_SYSTEM_PROMPT,
  buildGovernedSystemPrompt,
  buildNeutralGovernedSystemPrompt,
} from "../routes/sleep-agent.js";
import { buildToolSystemPrompt } from "../lib/governedAnswer.js";

// ─── No-diagnosis / no-medical-advice guardrail ─────────────────────────
//
// Every answer path of the sleep agent must carry an
// explicit hard rule: never diagnose, never prescribe or recommend
// medications/doses/treatments, only report what the cited studies showed,
// and keep ACTION lifestyle/behavioral only. These assertions ensure a
// future prompt edit can't silently drop the rule.

function expectNoDiagnosisRule(prompt: string) {
  // Never diagnose or label the person's condition.
  expect(prompt).toMatch(/NEVER diagnose a condition/i);
  expect(prompt).toMatch(
    /whether they have (\(or do\s+not have\) )?a condition/i,
  );
  // Never prescribe/recommend medications, doses, or treatments.
  expect(prompt).toMatch(/never prescribe or recommend a medication, dose/i);
  expect(prompt).toMatch(/not a clinician/i);
  // Only report what the cited studies/sources showed.
  expect(prompt).toMatch(
    /Report ONLY what\s+the cited (studies|sources) showed/i,
  );
  // ACTION stays lifestyle/behavioral only.
  expect(prompt).toMatch(
    /ACTION line must be a\s+lifestyle or behavioral step only, never medication, dosing, or treatment\s+instructions/i,
  );
  // The ACTION format block itself is constrained too.
  expect(prompt).toMatch(
    /lifestyle or behavioral (step|practice)[\s\S]{0,120}NEVER a medication, dose, supplement regimen, or treatment/i,
  );
}

describe("no-diagnosis guardrail in every agent prompt variant", () => {
  test("sleep agent main prompt", () => {
    expectNoDiagnosisRule(SYSTEM_PROMPT);
  });

  test("sleep agent brand-neutral prompt", () => {
    expectNoDiagnosisRule(NEUTRAL_SYSTEM_PROMPT);
  });

  test("sleep agent governed prompt", () => {
    expectNoDiagnosisRule(
      buildGovernedSystemPrompt("[source_id=1] x", ["sleep"]),
    );
  });

  test("sleep agent brand-neutral governed prompt", () => {
    expectNoDiagnosisRule(buildNeutralGovernedSystemPrompt("[source_id=1] x"));
  });

  test("shared governed tool prompt", () => {
    expectNoDiagnosisRule(buildToolSystemPrompt("[source_id=1] x", ["sleep"]));
  });
});
