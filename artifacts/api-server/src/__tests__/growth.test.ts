import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  test,
  expect,
  vi,
} from "vitest";

vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-growth-secret";
});

import type { Express } from "express";
import request from "supertest";
import { createHmac } from "crypto";

const PASSWORD = "test-growth-password";

function signCookie(val: string, secret: string): string {
  const hash = createHmac("sha256", secret)
    .update(val)
    .digest("base64")
    .replace(/=+$/, "");
  return val + "." + hash;
}
function signed(value: string): string {
  return "s:" + signCookie(value, process.env.SESSION_SECRET as string);
}

/** A valid, properly-signed growth session cookie header value. */
const GROWTH_COOKIE = `growth_session=${encodeURIComponent(signed("1"))}`;
/** A valid, properly-signed platform-admin cookie header value. */
const ADMIN_COOKIE = `palonur_admin=${encodeURIComponent(signed("1"))}`;

/** Pull a Set-Cookie entry by name out of a supertest response. */
function setCookie(res: request.Response, name: string): string | undefined {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  if (!raw) return undefined;
  return raw.find((c) => c.startsWith(`${name}=`));
}

let app: Express;
const originalPassword = process.env.GROWTH_TEAM_PASSWORD;

beforeAll(async () => {
  app = (await import("../app.js")).default;
});

afterEach(() => {
  if (originalPassword === undefined) delete process.env.GROWTH_TEAM_PASSWORD;
  else process.env.GROWTH_TEAM_PASSWORD = originalPassword;
});

afterAll(() => {
  if (originalPassword === undefined) delete process.env.GROWTH_TEAM_PASSWORD;
  else process.env.GROWTH_TEAM_PASSWORD = originalPassword;
});

describe("Growth dashboard password exchange", () => {
  test("503 when the password env var is unset", async () => {
    delete process.env.GROWTH_TEAM_PASSWORD;
    const res = await request(app)
      .post("/api/growth-auth")
      .send({ password: "anything" });
    expect(res.status).toBe(503);
    expect(setCookie(res, "growth_session")).toBeUndefined();
  });

  test("401 on a wrong password and sets NO cookie", async () => {
    process.env.GROWTH_TEAM_PASSWORD = PASSWORD;
    const res = await request(app)
      .post("/api/growth-auth")
      .send({ password: "nope" });
    expect(res.status).toBe(401);
    expect(setCookie(res, "growth_session")).toBeUndefined();
  });

  test("200 + a signed httpOnly cookie on the correct password", async () => {
    process.env.GROWTH_TEAM_PASSWORD = PASSWORD;
    const res = await request(app)
      .post("/api/growth-auth")
      .send({ password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const ck = setCookie(res, "growth_session");
    expect(ck).toBeDefined();
    expect(ck).toContain("HttpOnly");
    expect(ck).toContain(encodeURIComponent("s:"));
  });
});

describe("Growth session bridge (fail-closed gate)", () => {
  test("authed=false with no cookie", async () => {
    process.env.GROWTH_TEAM_PASSWORD = PASSWORD;
    const res = await request(app).get("/api/growth-auth/session");
    expect(res.status).toBe(200);
    expect(res.body.authed).toBe(false);
  });

  test("authed=true with a valid growth cookie while the password is set", async () => {
    process.env.GROWTH_TEAM_PASSWORD = PASSWORD;
    const res = await request(app)
      .get("/api/growth-auth/session")
      .set("Cookie", GROWTH_COOKIE);
    expect(res.body.authed).toBe(true);
  });

  test("FAIL CLOSED: a stale growth cookie is rejected once the password is unset", async () => {
    delete process.env.GROWTH_TEAM_PASSWORD;
    const res = await request(app)
      .get("/api/growth-auth/session")
      .set("Cookie", GROWTH_COOKIE);
    expect(res.body.authed).toBe(false);
  });

  test("platform-admin cookie still grants access even when the password is unset", async () => {
    delete process.env.GROWTH_TEAM_PASSWORD;
    const res = await request(app)
      .get("/api/growth-auth/session")
      .set("Cookie", ADMIN_COOKIE);
    expect(res.body.authed).toBe(true);
  });
});

describe("GET /api/growth/overview guard", () => {
  test("401 without any cookie", async () => {
    process.env.GROWTH_TEAM_PASSWORD = PASSWORD;
    const res = await request(app).get("/api/growth/overview");
    expect(res.status).toBe(401);
  });

  test("FAIL CLOSED: stale growth cookie + unset password is denied (401)", async () => {
    delete process.env.GROWTH_TEAM_PASSWORD;
    const res = await request(app)
      .get("/api/growth/overview")
      .set("Cookie", GROWTH_COOKIE);
    expect(res.status).toBe(401);
  });

  test("200 with a valid growth cookie and stage payload shape", async () => {
    process.env.GROWTH_TEAM_PASSWORD = PASSWORD;
    const res = await request(app)
      .get("/api/growth/overview")
      .set("Cookie", GROWTH_COOKIE);
    expect(res.status).toBe(200);
    expect(["alpha", "beta", "scale"]).toContain(res.body.stage?.current);
    expect(typeof res.body.stage?.metric).toBe("number");
    expect(typeof res.body.stage?.metricLabel).toBe("string");
    expect(res.body.users).toBeDefined();
    expect(res.body.revenue).toBeDefined();
    expect(res.body.tokens).toBeDefined();
    expect(res.body.retention).toBeDefined();
  });
});
