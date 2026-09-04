import express from "express";
import request from "supertest";
import { describe, expect, test } from "vitest";
import stanfordRouter from "../routes/stanford.js";

// This suite exercises composition only. Every request either has a local
// handler or is rejected before a legacy/database-backed handler can run.
const app = express();
app.use(stanfordRouter);

describe("Stanford route composition", () => {
  test("mounts health and consumer logout without a database", async () => {
    await request(app).get("/healthz").expect(200);
    await request(app)
      .post("/consumer/auth/logout")
      .expect(200)
      .expect({ ok: true });
  });

  test.each([
    "/faculty/voice-profile",
    "/faculty/admin/research-discovery",
    "/faculty/pillars/sleep/sources",
    "/storage/public-objects/stewards/example.webp",
    "/slm-agent",
    "/slm-answer-links",
    "/uncovered-escalation",
  ])(
    "mounts required route %s without invoking its database handler",
    async (path) => {
      await request(app).options(path).expect(200);
    },
  );

  test.each([
    "/billing/plans",
    "/sleep-agent",
    "/newsletter",
    "/investors",
    "/partner-access",
    "/analytics",
    "/decision-room",
    "/mcp",
    "/support",
    "/phone",
    "/contact",
    "/faculty/newsletter-offers",
    "/faculty/communication-offers",
    "/faculty/parentdata-offers",
    "/faculty/channel-interest",
    "/faculty/distribution-channels",
    "/faculty/admin/distribution-channels",
    "/faculty/admin/newsletter-session",
    "/faculty/admin/command-center-session",
    "/faculty/admin/crawls",
    "/faculty/admin/crawls-targets",
    "/storage/uploads/request-url",
    "/storage/objects/private-example.pdf",
  ])("rejects excluded route %s before it reaches a handler", async (path) => {
    await request(app).get(path).expect(404);
  });
});
