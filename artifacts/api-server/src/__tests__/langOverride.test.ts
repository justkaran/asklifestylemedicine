/**
 * Language-override regression suite (task: explicit EN/DE selection must
 * stick on consumer agents).
 *
 * The behavior is centralized in `langOverride` (lib/stewardVoice.ts): when
 * the visitor has EXPLICITLY selected a language, the returned instruction
 * always beats the prompts' "answer in the question's language" auto-detect
 * rule — INCLUDING for English (an EN selection forces English answers even
 * for German questions). No selection → empty string → auto-detect stands.
 *
 * Coverage:
 *   1. Unit tests on `langOverride` itself (en / de / undefined / unknown).
 *   2. Prompt-builder tests: the slm-agent system prompt embeds the override.
 *   3. Route-level test on /api/sleep-agent (legacy baked-corpus path, no
 *      governed RAG): the `lang` sent in the REQUEST BODY must reach the
 *      model's system prompt as the override suffix — this is the surface
 *      where the override is appended at request time rather than inside a
 *      builder, so a prompt refactor could silently drop it.
 */
import { beforeAll, describe, test, expect, vi } from "vitest";
import { parseSseEvents } from "./testHelpers.js";

// Env BEFORE the route modules load (they read these at module-init time).
// USE_GOVERNED_RAG stays OFF so /api/sleep-agent takes the legacy
// baked-corpus path: no retrieval, no embeddings, no pillar routing — the
// mocked model still receives systemForRequest + langOverride(lang).
vi.hoisted(() => {
  delete process.env.USE_GOVERNED_RAG;
  process.env.RESEND_API_KEY = "stub-key";
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-lang-secret";
  // Keep the consumer paywall far away — this suite asks several questions
  // from the same anonymous session.
  process.env.SLEEP_FREE_DAILY_QUESTION_LIMIT = "100";
  process.env.FREE_QUESTION_LIMIT = "100";
});

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: async () => ({ id: "stub-id" }) };
  },
}));

vi.mock("../lib/resendClient.js", () => ({
  getResendClient: async () => null,
}));

// Fake Anthropic: records the SYSTEM prompt of every stream call so the
// route-level test can assert the override suffix actually reached the model.
const systemPrompts: string[] = [];
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      stream: (opts: { system?: string }) => {
        systemPrompts.push(opts.system ?? "");
        const text =
          "ANSWER: Morning light anchors the circadian clock.\n" +
          "CITATION: Zeitzer et al., 2000, J Physiol\n" +
          'PAPER: "Sensitivity of the human circadian pacemaker to nocturnal light"\n' +
          "FINDING: Even dim room light at night suppresses melatonin.\n" +
          "INTERPRETATION: Keep evenings dim, get bright light in the morning.\n" +
          "ACTION: Step outside within an hour of waking tomorrow.\n" +
          "INSIGHT:\nQ: Does dim light matter?\nA: Yes, near 100 lux already shifts the clock.";
        async function* gen() {
          yield {
            type: "message_start",
            message: { usage: { input_tokens: 10 } },
          };
          for (const piece of text.match(/[\s\S]{1,40}/g) ?? []) {
            yield {
              type: "content_block_delta",
              delta: { type: "text_delta", text: piece },
            };
          }
          yield { type: "message_delta", usage: { output_tokens: 5 } };
        }
        return gen();
      },
    };
  }
  return { default: FakeAnthropic };
});

import type { Express } from "express";
import request from "supertest";
import { langOverride } from "../lib/stewardVoice.js";
import { buildExpertSystemPrompt } from "../lib/stewardVoice.js";
import { buildSlmSystemPrompt } from "../routes/slm-agent.js";

let app: Express;
beforeAll(async () => {
  app = (await import("../app.js")).default;
});

// ── 1. langOverride unit behavior ───────────────────────────────────────

describe("langOverride", () => {
  test("explicit EN selection returns an explicit English instruction", () => {
    const out = langOverride("en");
    expect(out).toContain("LANGUAGE OVERRIDE");
    expect(out).toContain("selected English");
    expect(out).toContain("Respond in English throughout");
    // The critical clause a prompt edit must never lose: EN wins even when
    // the question itself is written in another language.
    expect(out).toMatch(/even if the question is written in another language/i);
    // Machine-readable section markers stay in English.
    expect(out).toContain("ANSWER:");
    expect(out).toContain("UNCOVERED:");
  });

  test("explicit DE selection returns a German instruction", () => {
    const out = langOverride("de");
    expect(out).toContain("LANGUAGE OVERRIDE");
    expect(out).toContain("selected German");
    expect(out).toContain("Respond in German throughout");
    // Labels stay English; content after each label must be German.
    expect(out).toContain("All content after each label must be in German");
    expect(out).toContain("ANSWER:");
  });

  test("no selection preserves auto-detect (empty string)", () => {
    expect(langOverride(undefined)).toBe("");
    expect(langOverride("")).toBe("");
  });

  test("unknown code still forces that language rather than silently dropping", () => {
    const out = langOverride("xx");
    expect(out).toContain("LANGUAGE OVERRIDE");
    expect(out).toContain("Respond in xx throughout");
  });
});

// ── 2. Prompt builders embed the override ───────────────────────────────

describe("slm-agent system prompt", () => {
  test("includes the English override when lang='en'", () => {
    const prompt = buildSlmSystemPrompt("[source_id=1] test context", "en");
    expect(prompt).toContain(langOverride("en"));
  });

  test("includes the German override when lang='de'", () => {
    const prompt = buildSlmSystemPrompt("[source_id=1] test context", "de");
    expect(prompt).toContain(langOverride("de"));
  });

  test("omits the override when no lang is sent (auto-detect stands)", () => {
    const prompt = buildSlmSystemPrompt("[source_id=1] test context");
    expect(prompt).not.toContain("LANGUAGE OVERRIDE");
  });
});

describe("expert (embed) system prompt", () => {
  test("appends the override when lang is provided", () => {
    const prompt = buildExpertSystemPrompt(
      "[source_id=1] ctx",
      "Sleep",
      "Dr. Test",
      undefined,
      "en",
    );
    expect(prompt).toContain(langOverride("en"));
    const without = buildExpertSystemPrompt(
      "[source_id=1] ctx",
      "Sleep",
      "Dr. Test",
    );
    expect(without).not.toContain("LANGUAGE OVERRIDE");
  });
});

// ── 3. sleep-agent route: body `lang` reaches the model's system prompt ──

async function askSleep(body: Record<string, unknown>) {
  const res = await request(app)
    .post("/api/sleep-agent")
    .set("Sec-Fetch-Site", "same-origin")
    .set("Accept", "text/event-stream")
    .send(body);
  expect(res.status).toBe(200);
  return parseSseEvents(res.text);
}

describe("POST /api/sleep-agent lang override wiring", () => {
  test("lang='en' in the body appends the English override to the system prompt", async () => {
    systemPrompts.length = 0;
    await askSleep({
      message: "Warum wache ich um 3 Uhr morgens auf?",
      lang: "en",
      log: false,
    });
    expect(systemPrompts.length).toBeGreaterThan(0);
    const system = systemPrompts[systemPrompts.length - 1];
    expect(system).toContain(langOverride("en"));
  });

  test("lang='de' in the body appends the German override", async () => {
    systemPrompts.length = 0;
    await askSleep({
      message: "Does evening exercise hurt sleep?",
      lang: "de",
      log: false,
    });
    expect(systemPrompts.length).toBeGreaterThan(0);
    const system = systemPrompts[systemPrompts.length - 1];
    expect(system).toContain(langOverride("de"));
  });

  test("no lang in the body leaves auto-detect in place (no override)", async () => {
    systemPrompts.length = 0;
    await askSleep({
      message: "Does evening exercise hurt sleep?",
      log: false,
    });
    expect(systemPrompts.length).toBeGreaterThan(0);
    const system = systemPrompts[systemPrompts.length - 1];
    expect(system).not.toContain("LANGUAGE OVERRIDE");
  });
});
