import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, test, vi } from "vitest";

const createMessage = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic {
    messages = { create: createMessage };
  },
}));

import landingDemoRouter from "../routes/landingDemo.js";

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(landingDemoRouter);

beforeEach(() => {
  createMessage.mockReset();
  process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY = "test-key";
  process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL = "https://example.test";
});

describe("landing authority demo", () => {
  test("routes through the ordered authority catalog and returns the exact claim", async () => {
    createMessage.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            authorityId: "christopher-gardner",
            topic: "nutrition and food",
            response:
              "I routed this to Christopher Gardner because his current work focuses on nutrition and dietary patterns.",
            whyThisSteward:
              "His public Stanford profile is the closest current expertise match.",
          }),
        },
      ],
    });

    const response = await request(app)
      .post("/landing-demo/route")
      .send({ question: "Is cheese nutritious?" })
      .expect(200);

    expect(response.body.authority).toMatchObject({
      id: "christopher-gardner",
      name: "Christopher Gardner",
      institution: "Stanford",
      sourceUrl: "https://profiles.stanford.edu/christopher-gardner",
    });
    expect(response.body.designationClaim).toBe(
      "This is Palonur's own Steward designation. A public profile supports current-expertise matching; while we are rolling out our partnerships with leading universities, it does not state that the person or university has accepted, endorsed, or adopted Palonur.",
    );
    const call = createMessage.mock.calls[0]?.[0];
    expect(call.model).toBe("claude-sonnet-5");
    expect(call.system).toContain(
      "Stanford, University of Chicago, Harvard, Oxford, Cambridge, Other Ivy League universities",
    );
    expect(call.system).toContain(
      "name that one person in the response and say that Palonur routed the question to them",
    );
    expect(call.messages[0].content.indexOf("Christopher Gardner")).toBeLessThan(
      call.messages[0].content.indexOf("John A. List"),
    );
  });

  test("grounds a follow-up in the selected server-side Steward record", async () => {
    createMessage.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: "Morning light can shift circadian timing, but the useful timing depends on the person's sleep pattern.",
        },
      ],
    });

    const response = await request(app)
      .post("/landing-demo/follow-up")
      .send({
        originalQuestion: "Why do I wake up at night?",
        authorityId: "jamie-zeitzer",
        topic: "sleep and biological timing",
        question: "Does morning light help?",
      })
      .expect(200);

    expect(response.body.answer).toContain("Morning light");
    expect(response.body.question).toBe("Does morning light help?");
    const prompt = createMessage.mock.calls[0]?.[0].messages[0].content;
    expect(prompt).toContain("Palonur Steward: Jamie Zeitzer");
    expect(prompt).toContain("Current expertise: sleep, circadian timing, and light");
    expect(prompt).toContain("Follow-up question:\nDoes morning light help?");
  });

  test("discovers one leading public academic when the curated catalog has no match", async () => {
    createMessage
      .mockResolvedValueOnce({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              authorityId: null,
              authority: {
                name: "David J. Stevenson",
                institution: "California Institute of Technology",
                field: "planetary science",
                expertise:
                  "planetary formation, interiors, evolution, and planetary physics",
                sourceLabel: "Caltech faculty profile",
                sourceUrl:
                  "https://www.gps.caltech.edu/people/david-j-stevenson",
                profile:
                  "Caltech Professor of Planetary Science whose work covers the formation, interiors, and evolution of planets.",
              },
              topic: "Earth's rotation and planetary formation",
              response:
                "I routed this to David J. Stevenson because the question belongs to planetary formation and planetary physics.",
              whyThisSteward:
                "His current public Caltech profile is the strongest direct expertise match.",
            }),
          },
        ],
      })
      .mockResolvedValueOnce({
        content: [
          {
            type: "text",
            text: "Earth retained angular momentum from the rotating material that formed the early solar system.",
          },
        ],
      });

    const routed = await request(app)
      .post("/landing-demo/route")
      .send({ question: "Why\u200B\u200C\u200D does the Earth rotate?" })
      .expect(200);

    expect(routed.body.question).toBe("Why does the Earth rotate?");
    expect(routed.body.authority).toMatchObject({
      name: "David J. Stevenson",
      institution: "California Institute of Technology",
      sourceUrl: "https://www.gps.caltech.edu/people/david-j-stevenson",
    });
    expect(routed.body.authority.id).toMatch(/^discovered-/);

    await request(app)
      .post("/landing-demo/follow-up")
      .send({
        originalQuestion: "Why does the Earth rotate?",
        authorityId: routed.body.authority.id,
        topic: routed.body.topic,
        question: "Why has it not stopped?",
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body.answer).toContain("angular momentum");
      });

    const discoveryPrompt = createMessage.mock.calls[0]?.[0].messages[0].content;
    expect(discoveryPrompt).toContain("Find exactly one leading public academic");
    expect(discoveryPrompt).toContain("Do not return a list or multiple candidates");
  });

  test("fails explicitly when the model returns an unknown authority", async () => {
    createMessage.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            authorityId: "invented-person",
            topic: "space plants",
            response: "An invented response.",
            whyThisSteward: "An invented reason.",
          }),
        },
      ],
    });

    await request(app)
      .post("/landing-demo/route")
      .send({ question: "How do plants grow in space?" })
      .expect(502, { error: "The routing demo selected an unknown authority." });
  });
});