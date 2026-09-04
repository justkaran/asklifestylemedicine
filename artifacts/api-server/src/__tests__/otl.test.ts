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
  process.env.SESSION_SECRET = "test-otl-secret";
});

import type { Express } from "express";
import request from "supertest";
import { createHmac } from "crypto";

const PASSWORD = "test-otl-password";

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

/** A valid, properly-signed OTL session cookie header value. */
const OTL_COOKIE = `otl_session=${encodeURIComponent(signed("1"))}`;
/** A valid, properly-signed platform-admin cookie header value. */
const ADMIN_COOKIE = `palonur_admin=${encodeURIComponent(signed("1"))}`;

/** Pull a Set-Cookie entry by name out of a supertest response. */
function setCookie(res: request.Response, name: string): string | undefined {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  if (!raw) return undefined;
  return raw.find((c) => c.startsWith(`${name}=`));
}

let app: Express;
const originalPassword = process.env.OTL_DASHBOARD_PASSWORD;

beforeAll(async () => {
  app = (await import("../app.js")).default;
});

afterEach(() => {
  if (originalPassword === undefined) delete process.env.OTL_DASHBOARD_PASSWORD;
  else process.env.OTL_DASHBOARD_PASSWORD = originalPassword;
});

afterAll(() => {
  if (originalPassword === undefined) delete process.env.OTL_DASHBOARD_PASSWORD;
  else process.env.OTL_DASHBOARD_PASSWORD = originalPassword;
});

describe("OTL dashboard password exchange", () => {
  test("503 when the password env var is unset", async () => {
    delete process.env.OTL_DASHBOARD_PASSWORD;
    const res = await request(app)
      .post("/api/otl-auth")
      .send({ password: "anything" });
    expect(res.status).toBe(503);
    expect(setCookie(res, "otl_session")).toBeUndefined();
  });

  test("401 on a wrong password and sets NO cookie", async () => {
    process.env.OTL_DASHBOARD_PASSWORD = PASSWORD;
    const res = await request(app)
      .post("/api/otl-auth")
      .send({ password: "nope" });
    expect(res.status).toBe(401);
    expect(setCookie(res, "otl_session")).toBeUndefined();
  });

  test("200 + a signed httpOnly cookie on the correct password", async () => {
    process.env.OTL_DASHBOARD_PASSWORD = PASSWORD;
    const res = await request(app)
      .post("/api/otl-auth")
      .send({ password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const ck = setCookie(res, "otl_session");
    expect(ck).toBeDefined();
    expect(ck).toContain("HttpOnly");
    expect(ck).toContain(encodeURIComponent("s:"));
  });
});

describe("OTL session bridge (fail-closed gate)", () => {
  test("authed=false with no cookie", async () => {
    process.env.OTL_DASHBOARD_PASSWORD = PASSWORD;
    const res = await request(app).get("/api/otl-auth/session");
    expect(res.status).toBe(200);
    expect(res.body.authed).toBe(false);
  });

  test("authed=true with a valid OTL cookie while the password is set", async () => {
    process.env.OTL_DASHBOARD_PASSWORD = PASSWORD;
    const res = await request(app)
      .get("/api/otl-auth/session")
      .set("Cookie", OTL_COOKIE);
    expect(res.body.authed).toBe(true);
  });

  test("FAIL CLOSED: a stale OTL cookie is rejected once the password is unset", async () => {
    delete process.env.OTL_DASHBOARD_PASSWORD;
    const res = await request(app)
      .get("/api/otl-auth/session")
      .set("Cookie", OTL_COOKIE);
    expect(res.body.authed).toBe(false);
  });

  test("platform-admin cookie still grants access even when the password is unset", async () => {
    delete process.env.OTL_DASHBOARD_PASSWORD;
    const res = await request(app)
      .get("/api/otl-auth/session")
      .set("Cookie", ADMIN_COOKIE);
    expect(res.body.authed).toBe(true);
  });
});

describe("UIT review package doc (/api/uit-doc)", () => {
  const EDIT_PW = process.env.OTL_EDIT_PASSWORD ?? "palonureditor";

  test("PUT with a wrong edit password is rejected (401)", async () => {
    const res = await request(app)
      .put("/api/uit-doc")
      .set("x-edit-password", "wrong")
      .send({ content: ["<section>x</section>"] });
    expect(res.status).toBe(401);
  });

  test("FAIL CLOSED: PUT is denied (503) in production when no edit password is configured", async () => {
    const prevEnv = process.env.NODE_ENV;
    const prevPw = process.env.OTL_EDIT_PASSWORD;
    process.env.NODE_ENV = "production";
    process.env.OTL_DASHBOARD_PASSWORD = PASSWORD; // makes the OTL cookie valid
    delete process.env.OTL_EDIT_PASSWORD;
    try {
      const res = await request(app)
        .put("/api/uit-doc")
        .set("Cookie", OTL_COOKIE)
        .set("x-edit-password", "palonureditor")
        .send({ content: ["<section>x</section>"] });
      expect(res.status).toBe(503);
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevPw === undefined) delete process.env.OTL_EDIT_PASSWORD;
      else process.env.OTL_EDIT_PASSWORD = prevPw;
    }
  });

  test("PROD GATE: PUT without an OTL/admin session is a clean 404 even with the edit password", async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const res = await request(app)
        .put("/api/uit-doc")
        .set("x-edit-password", process.env.OTL_EDIT_PASSWORD ?? "palonureditor")
        .send({ content: ["<section>x</section>"] });
      expect(res.status).toBe(404);
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });

  test("XSS REGRESSION: scripts, event handlers and javascript: URLs are stripped on save", async () => {
    const dirty = [
      `<section class="page"><script>alert(1)</script>` +
        `<img src="x" onerror="alert(2)">` +
        `<a href="javascript:alert(3)">link</a>` +
        `<button class="delete-btn" onclick="deletePage(this)">×</button>` +
        `<p onmouseover="alert(4)">safe text</p></section>`,
    ];
    const put = await request(app)
      .put("/api/uit-doc")
      .set("x-edit-password", EDIT_PW)
      .send({ content: dirty });
    expect(put.status).toBe(200);

    const get = await request(app).get("/api/uit-doc");
    expect(get.status).toBe(200);
    const saved = (get.body.content as string[]).join("");
    expect(saved).not.toContain("<script");
    expect(saved).not.toContain("onerror");
    expect(saved).not.toContain("onclick");
    expect(saved).not.toContain("onmouseover");
    expect(saved).not.toContain("javascript:");
    // Benign structure survives.
    expect(saved).toContain("safe text");
    expect(saved).toContain("delete-btn");
  });

  test("PUT rejects a non-array payload (400)", async () => {
    const res = await request(app)
      .put("/api/uit-doc")
      .set("x-edit-password", EDIT_PW)
      .send({ content: "not-an-array" });
    expect(res.status).toBe(400);
  });

  test("PUT rejects non-string entries (400)", async () => {
    const res = await request(app)
      .put("/api/uit-doc")
      .set("x-edit-password", EDIT_PW)
      .send({ content: [1, 2] });
    expect(res.status).toBe(400);
  });

  test("PUT saves and GET returns the saved UIT snapshot (own doc id)", async () => {
    // NOTE: attribute quoting must match sanitize-html's normalized output.
    const pages = ['<section class="page">uit-test-page</section>'];
    const put = await request(app)
      .put("/api/uit-doc")
      .set("x-edit-password", EDIT_PW)
      .send({ content: pages });
    expect(put.status).toBe(200);

    const get = await request(app).get("/api/uit-doc");
    expect(get.status).toBe(200);
    expect(get.body.content).toEqual(pages);
    // The OTL doc must be untouched — separate document ids.
    const otl = await request(app).get("/api/otl-doc");
    expect(otl.status).toBe(200);
    expect(otl.body.content).not.toEqual(pages);
  });

  test("PROD GATE: unauthenticated GET is a clean 404 in production", async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const res = await request(app).get("/api/uit-doc");
      expect(res.status).toBe(404);
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });

  test("PROD GATE: an OTL session reads the doc in production", async () => {
    process.env.OTL_DASHBOARD_PASSWORD = PASSWORD;
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const res = await request(app)
        .get("/api/uit-doc")
        .set("Cookie", OTL_COOKIE);
      expect(res.status).toBe(200);
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });

  test("AUDIT: an OTL-session GET records an access event", async () => {
    process.env.OTL_DASHBOARD_PASSWORD = PASSWORD;
    const pool = (await import("../lib/db.js")).default;
    // Use a unique IP so the per-IP hourly dedup can't swallow the row.
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
    await request(app)
      .get("/api/uit-doc")
      .set("Cookie", OTL_COOKIE)
      .set("X-Forwarded-For", ip);
    // The audit insert is intentionally fire-and-forget; poll briefly.
    let found = false;
    for (let i = 0; i < 20 && !found; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const r2 = await pool.query(
        "SELECT 1 FROM otl_login_events WHERE ip = $1 AND via = 'session'",
        [ip],
      );
      found = r2.rows.length > 0;
    }
    expect(found).toBe(true);
  });
});

describe("GET /api/otl/overview guard", () => {
  test("401 without any cookie", async () => {
    process.env.OTL_DASHBOARD_PASSWORD = PASSWORD;
    const res = await request(app).get("/api/otl/overview");
    expect(res.status).toBe(401);
  });

  test("FAIL CLOSED: stale OTL cookie + unset password is denied (401)", async () => {
    delete process.env.OTL_DASHBOARD_PASSWORD;
    const res = await request(app)
      .get("/api/otl/overview")
      .set("Cookie", OTL_COOKIE);
    expect(res.status).toBe(401);
  });
});
