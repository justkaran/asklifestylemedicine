import { afterAll, describe, test, expect, vi } from "vitest";

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

// The intake route uses the non-streaming messages.create. The mock returns
// whatever JSON/string the current test queued, so we exercise the questions /
// refuse / skip branches deterministically without a network call.
const intakeReply = { text: "" };
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      create: async () => ({
        content: [{ type: "text", text: intakeReply.text }],
      }),
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

import type { Express } from "express";
import request from "supertest";
import pool from "../lib/db.js";
import {
  INTAKE_MAX_QUESTIONS,
  parseIntakeQuestions,
  buildIntakeSystemPrompt,
} from "../routes/sleep-agent.js";

// ─── Part 1: pure parser/prompt (no DB) ────────────────────────────────

describe("sleep-agent intake — prompt", () => {
  test("system prompt is lifestyle-only and forbids medical screening", () => {
    const p = buildIntakeSystemPrompt();
    // Stays in habit territory…
    expect(p).toMatch(/lifestyle/i);
    expect(p).toMatch(/caffeine/i);
    // …and explicitly bars the medical/diagnosis surface.
    expect(p).toMatch(/apnea/i);
    expect(p).toMatch(/medication/i);
    expect(p).toMatch(/diagnos/i);
    // Off-topic contract is a bare REFUSE line.
    expect(p).toMatch(/REFUSE/);
    // House style: no em-dashes in model output.
    expect(p).toMatch(/em-dash/i);
  });
});

describe("sleep-agent intake — parseIntakeQuestions", () => {
  test("parses a clean JSON object", () => {
    const out = parseIntakeQuestions(
      JSON.stringify({
        questions: [
          { id: "timing", question: "When do you go to bed?", options: ["before 10", "after midnight"] },
          { id: "screens", question: "Screens before bed?", options: ["yes", "no"] },
        ],
      }),
    );
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe("timing");
    expect(out[0].options).toEqual(["before 10", "after midnight"]);
  });

  test("tolerates prose/markdown fences around the JSON", () => {
    const out = parseIntakeQuestions(
      'Sure! Here you go:\n```json\n{"questions":[{"id":"caffeine","question":"Coffee after noon?","options":["yes","no"]}]}\n```\nHope that helps.',
    );
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("caffeine");
  });

  test("caps at INTAKE_MAX_QUESTIONS and 4 options", () => {
    const out = parseIntakeQuestions(
      JSON.stringify({
        questions: Array.from({ length: 6 }, (_, i) => ({
          id: `q${i}`,
          question: `Question ${i}?`,
          options: ["a", "b", "c", "d", "e", "f"],
        })),
      }),
    );
    expect(out).toHaveLength(INTAKE_MAX_QUESTIONS);
    expect(out[0].options).toHaveLength(4);
  });

  test("normalizes/dedupes ids and drops empty questions", () => {
    const out = parseIntakeQuestions(
      JSON.stringify({
        questions: [
          { id: "My Timing!", question: "When?", options: [] },
          { id: "My Timing!", question: "Where?", options: [] },
          { id: "", question: "   ", options: [] },
        ],
      }),
    );
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe("my-timing");
    // Duplicate slug is reassigned, not collided.
    expect(out[1].id).not.toBe(out[0].id);
  });

  test("returns [] for non-JSON or missing questions array", () => {
    expect(parseIntakeQuestions("REFUSE")).toEqual([]);
    expect(parseIntakeQuestions("not json at all")).toEqual([]);
    expect(parseIntakeQuestions('{"foo":1}')).toEqual([]);
  });
});

// ─── Part 2: route behaviour (mocked SDK, no DB writes) ─────────────────

let app: Express;

describe("sleep-agent intake — POST /api/sleep-agent/intake", () => {
  test("400 when message missing", async () => {
    app = (await import("../app.js")).default;
    const res = await request.agent(app).post("/api/sleep-agent/intake").set("Sec-Fetch-Site", "same-origin").send({});
    expect(res.status).toBe(400);
  });

  test("returns kind:questions when the model emits valid JSON", async () => {
    app = (await import("../app.js")).default;
    intakeReply.text = JSON.stringify({
      questions: [
        { id: "timing", question: "When do you go to bed?", options: ["early", "late"] },
      ],
    });
    const res = await request
      .agent(app)
      .post("/api/sleep-agent/intake")
      .set("Sec-Fetch-Site", "same-origin")
      .send({ message: "I can't fall asleep" });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("questions");
    expect(res.body.questions).toHaveLength(1);
    expect(res.body.questions[0].id).toBe("timing");
  });

  test("returns kind:refuse when the model refuses (off-topic)", async () => {
    app = (await import("../app.js")).default;
    intakeReply.text = "REFUSE";
    const res = await request
      .agent(app)
      .post("/api/sleep-agent/intake")
      .set("Sec-Fetch-Site", "same-origin")
      .send({ message: "what is the capital of France" });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("refuse");
  });

  test("degrades to kind:skip when the model output is unusable", async () => {
    app = (await import("../app.js")).default;
    intakeReply.text = "here are some thoughts but no json";
    const res = await request
      .agent(app)
      .post("/api/sleep-agent/intake")
      .set("Sec-Fetch-Site", "same-origin")
      .send({ message: "tired all the time" });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("skip");
  });
});

afterAll(async () => {
  await pool.end();
});
