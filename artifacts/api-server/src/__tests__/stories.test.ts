import { beforeAll, beforeEach, describe, test, expect, vi } from "vitest";

vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-stories-secret";
  process.env.STORY_EDITOR_EMAILS = "editor@test.local";
  process.env.RESEND_API_KEY = "stub-key";
});

// Capture magic-link + invite emails instead of hitting Resend.
interface SentMagicLink {
  to: string;
  token: string;
}
const sentMagicLinks: SentMagicLink[] = [];
const sentInvites: Array<{ to: string; token: string }> = [];

vi.mock("../lib/storyEmail", () => ({
  sendStoryMagicLink: async (args: SentMagicLink) => {
    sentMagicLinks.push(args);
  },
  sendStoryInvite: async (args: { to: string; token: string }) => {
    sentInvites.push(args);
  },
}));

// Anthropic isn't exercised here (no draft generation tests), but the route
// module instantiates it at import time, so stub it to avoid network env reads.
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      create: async () => ({ content: [{ type: "text", text: "stub" }] }),
    };
  }
  return { default: FakeAnthropic };
});

import type { Express } from "express";
import request from "supertest";
import { createHmac } from "crypto";
import pool from "../lib/db.js";
import { __resetEmailRateLimitForTests } from "../middlewares/emailRateLimit";

function signCookie(val: string, secret: string): string {
  const hash = createHmac("sha256", secret).update(val).digest("base64").replace(/=+$/, "");
  return val + "." + hash;
}

let app: Express;

async function ensureStoriesSchema(): Promise<void> {
  await pool.query(`DO $$ BEGIN
    CREATE TYPE story_status AS ENUM ('draft','new','in_edit','approved','archived');
  EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN unique_violation THEN NULL;
  END $$;`);
  await pool.query(`CREATE TABLE IF NOT EXISTS stories (
    id SERIAL PRIMARY KEY,
    draft_token TEXT NOT NULL UNIQUE,
    status story_status NOT NULL DEFAULT 'draft',
    first_name TEXT,
    email TEXT,
    anonymous BOOLEAN NOT NULL DEFAULT FALSE,
    goal TEXT,
    hook TEXT,
    struggle TEXT,
    enablement TEXT,
    follow_ups JSONB NOT NULL DEFAULT '{}'::jsonb,
    follow_up_answers JSONB NOT NULL DEFAULT '{}'::jsonb,
    draft_html TEXT,
    pull_quote TEXT,
    editor_notes TEXT,
    referrer TEXT,
    sleep_query_id TEXT,
    invite_id INTEGER,
    inviter_note TEXT,
    consent_copyright BOOLEAN NOT NULL DEFAULT FALSE,
    consent_publish BOOLEAN NOT NULL DEFAULT FALSE,
    consent_timestamp TIMESTAMPTZ,
    consent_ip_hash TEXT,
    submitted_at TIMESTAMPTZ,
    approved_at TIMESTAMPTZ,
    approved_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS story_images (
    id SERIAL PRIMARY KEY,
    story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    object_path TEXT NOT NULL,
    content_type TEXT,
    original_name TEXT,
    caption TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    is_pull_image BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS story_invites (
    id SERIAL PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    inviter_email TEXT NOT NULL,
    context_note TEXT,
    used_at TIMESTAMPTZ,
    story_id INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS story_editor_sessions (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    magic_token TEXT NOT NULL UNIQUE,
    session_token TEXT UNIQUE,
    consumed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    session_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS story_editors (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    added_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  // Self-heal: pre-constraint dev DBs miss UNIQUE(email) (CREATE TABLE IF NOT
  // EXISTS never retrofits it), which breaks the duplicate-add idempotency test.
  // Conditional so fresh DBs don't grow a second redundant unique index.
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'story_editors'
        AND indexdef ILIKE '%UNIQUE%(email)%'
    ) THEN
      DELETE FROM story_editors a USING story_editors b
        WHERE a.email = b.email AND a.id > b.id;
      CREATE UNIQUE INDEX story_editors_email_unique ON story_editors (email);
    END IF;
  END $$`);
}

function signed(value: string): string {
  return "s:" + signCookie(value, process.env.SESSION_SECRET as string);
}

function adminCookie(): string {
  return `palonur_admin=${encodeURIComponent(signed("1"))}`;
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for stories.test.ts");
  }
  await ensureStoriesSchema();
  app = (await import("../app")).default;
});

beforeEach(async () => {
  sentMagicLinks.length = 0;
  sentInvites.length = 0;
  await pool.query(`TRUNCATE story_images, story_invites, story_editor_sessions, story_editors, stories RESTART IDENTITY CASCADE`);
  await __resetEmailRateLimitForTests();
});

// Pull the signed draft cookie out of a Set-Cookie response so a follow-up
// request can resume the same draft (mimics a real browser jar).
function extractCookie(res: request.Response, name: string): string | null {
  const raw = res.headers["set-cookie"];
  if (!raw) return null;
  const list = Array.isArray(raw) ? raw : [raw];
  for (const c of list) {
    const m = c.match(new RegExp(`^${name}=([^;]+)`));
    if (m) return `${name}=${m[1]}`;
  }
  return null;
}

describe("stories intake", () => {
  test("rejects submit without both consents", async () => {
    // Seed PACE answers via patch first.
    const draftRes = await request(app).get("/api/stories/intake/draft");
    const draftCookie = extractCookie(draftRes, "story_draft");
    expect(draftCookie).toBeTruthy();
    await request(app)
      .patch("/api/stories/intake/draft")
      .set("Cookie", draftCookie!)
      .send({ goal: "g", hook: "h", struggle: "s", enablement: "e" })
      .expect(200);

    // Missing both
    await request(app)
      .post("/api/stories/intake/submit")
      .set("Cookie", draftCookie!)
      .send({})
      .expect(400);
    // Only one consent
    await request(app)
      .post("/api/stories/intake/submit")
      .set("Cookie", draftCookie!)
      .send({ consentCopyright: true })
      .expect(400);
    await request(app)
      .post("/api/stories/intake/submit")
      .set("Cookie", draftCookie!)
      .send({ consentPublish: true })
      .expect(400);

    const { rows } = await pool.query(
      `SELECT status, consent_copyright, consent_publish FROM stories`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("draft");
    expect(rows[0].consent_copyright).toBe(false);
    expect(rows[0].consent_publish).toBe(false);
  });

  test("draft cookie resume returns the same draft row", async () => {
    const first = await request(app).get("/api/stories/intake/draft").expect(200);
    const cookie = extractCookie(first, "story_draft");
    expect(cookie).toBeTruthy();
    const firstId = first.body.draft.id as number;

    const second = await request(app)
      .get("/api/stories/intake/draft")
      .set("Cookie", cookie!)
      .expect(200);
    expect(second.body.draft.id).toBe(firstId);

    const { rowCount } = await pool.query(`SELECT 1 FROM stories`);
    expect(rowCount).toBe(1);
  });

  test("full intake + dual consent submit transitions draft → new", async () => {
    const draftRes = await request(app).get("/api/stories/intake/draft");
    const cookie = extractCookie(draftRes, "story_draft")!;
    await request(app)
      .patch("/api/stories/intake/draft")
      .set("Cookie", cookie)
      .send({
        firstName: "Sam",
        goal: "Sleep better",
        hook: "2am awake",
        struggle: "Couldn't drift back",
        enablement: "Walked outside at dawn",
      })
      .expect(200);
    const submit = await request(app)
      .post("/api/stories/intake/submit")
      .set("Cookie", cookie)
      .send({ consentCopyright: true, consentPublish: true, firstName: "Sam" })
      .expect(200);
    expect(submit.body.ok).toBe(true);
    const { rows } = await pool.query(
      `SELECT status, consent_copyright, consent_publish, consent_timestamp, consent_ip_hash, submitted_at FROM stories WHERE id = $1`,
      [submit.body.id],
    );
    expect(rows[0].status).toBe("new");
    expect(rows[0].consent_copyright).toBe(true);
    expect(rows[0].consent_publish).toBe(true);
    expect(rows[0].consent_timestamp).toBeTruthy();
    expect(rows[0].consent_ip_hash).toBeTruthy();
    expect(rows[0].submitted_at).toBeTruthy();
  });
});

describe("magic-link auth", () => {
  test("request → consume rotates token, issues session, second consume fails", async () => {
    await request(app)
      .post("/api/stories-auth/request")
      .set("X-Forwarded-For", "192.0.2.11")
      .send({ email: "editor@test.local" })
      .expect(200);
    expect(sentMagicLinks).toHaveLength(1);
    const magicToken = sentMagicLinks[0].token;

    const consumed = await request(app)
      .get(`/api/stories-auth/consume?token=${magicToken}`)
      .expect(200);
    expect(consumed.body.email).toBe("editor@test.local");
    const sessionCookie = extractCookie(consumed, "stories_session");
    expect(sessionCookie).toBeTruthy();

    // Token was rotated → consumed_at + session_token set, magic_token unusable.
    const { rows } = await pool.query(
      `SELECT consumed_at, session_token FROM story_editor_sessions WHERE magic_token = $1`,
      [magicToken],
    );
    expect(rows[0].consumed_at).toBeTruthy();
    expect(rows[0].session_token).toBeTruthy();

    // Replay attempt fails.
    await request(app)
      .get(`/api/stories-auth/consume?token=${magicToken}`)
      .expect(400);

    // Session cookie authorises /me.
    const me = await request(app)
      .get("/api/stories-auth/me")
      .set("Cookie", sessionCookie!)
      .expect(200);
    expect(me.body.email).toBe("editor@test.local");
    expect(me.body.role).toBe("editor");
  });

  test("non-allowlisted email returns ok but does not email or persist a token", async () => {
    await request(app)
      .post("/api/stories-auth/request")
      .set("X-Forwarded-For", "192.0.2.12")
      .send({ email: "stranger@example.com" })
      .expect(200);
    expect(sentMagicLinks).toHaveLength(0);
    const { rowCount } = await pool.query(`SELECT 1 FROM story_editor_sessions`);
    expect(rowCount).toBe(0);
  });
});

describe("requireEditorOrAdmin", () => {
  test("rejects unauthenticated", async () => {
    await request(app).get("/api/stories").expect(401);
  });

  test("accepts admin signed cookie", async () => {
    const res = await request(app)
      .get("/api/stories")
      .set("Cookie", adminCookie())
      .expect(200);
    expect(Array.isArray(res.body.stories)).toBe(true);
  });

  test("accepts editor session cookie", async () => {
    await request(app)
      .post("/api/stories-auth/request")
      .set("X-Forwarded-For", "192.0.2.13")
      .send({ email: "editor@test.local" })
      .expect(200);
    const consumed = await request(app)
      .get(`/api/stories-auth/consume?token=${sentMagicLinks[0].token}`)
      .expect(200);
    const sessionCookie = extractCookie(consumed, "stories_session")!;
    await request(app)
      .get("/api/stories")
      .set("Cookie", sessionCookie)
      .expect(200);
  });
});

describe("admin-managed editor allowlist", () => {
  test("non-admin cannot view, add, or remove editors", async () => {
    await request(app).get("/api/stories-editors").expect(401);
    await request(app).post("/api/stories-editors").send({ email: "x@test.local" }).expect(401);
    await request(app).delete("/api/stories-editors/1").expect(401);
  });

  test("editor session cannot manage the allowlist (no admin escalation)", async () => {
    await request(app)
      .post("/api/stories-auth/request")
      .send({ email: "editor@test.local" })
      .expect(200);
    const consumed = await request(app)
      .get(`/api/stories-auth/consume?token=${sentMagicLinks[0].token}`)
      .expect(200);
    const sessionCookie = extractCookie(consumed, "stories_session")!;
    await request(app).get("/api/stories-editors").set("Cookie", sessionCookie).expect(401);
    await request(app)
      .post("/api/stories-editors")
      .set("Cookie", sessionCookie)
      .send({ email: "x@test.local" })
      .expect(401);
  });

  test("admin list seeds the env default on first read", async () => {
    const res = await request(app)
      .get("/api/stories-editors")
      .set("Cookie", adminCookie())
      .expect(200);
    const emails = (res.body.editors as Array<{ email: string }>).map((e) => e.email);
    expect(emails).toContain("editor@test.local");
  });

  test("admin can add an editor, who can then request a magic link", async () => {
    // A not-yet-allowed email gets no magic link.
    await request(app)
      .post("/api/stories-auth/request")
      .send({ email: "newbie@test.local" })
      .expect(200);
    expect(sentMagicLinks.find((m) => m.to === "newbie@test.local")).toBeUndefined();

    // Admin adds them.
    const add = await request(app)
      .post("/api/stories-editors")
      .set("Cookie", adminCookie())
      .send({ email: "Newbie@Test.local" })
      .expect(200);
    expect(add.body.editor.email).toBe("newbie@test.local");

    // Now a magic link is issued.
    await request(app)
      .post("/api/stories-auth/request")
      .send({ email: "newbie@test.local" })
      .expect(200);
    expect(sentMagicLinks.find((m) => m.to === "newbie@test.local")).toBeTruthy();
  });

  test("adding the same editor twice is idempotent", async () => {
    // The full-suite run shares one dev DB across parallel vitest workers, and
    // another worker can stomp this table between the two POSTs (the row
    // vanishes, so the second POST inserts fresh and `alreadyExists` comes back
    // undefined). Retry with a fresh suite-scoped email per attempt: external
    // row deletion just triggers another attempt, while a REAL idempotency
    // regression (a duplicate row) fails immediately on any attempt.
    let sawAlreadyExists = false;
    for (let attempt = 0; attempt < 5 && !sawAlreadyExists; attempt++) {
      const email = `dup-${attempt}-${Date.now()}@test.local`;
      await request(app)
        .post("/api/stories-editors")
        .set("Cookie", adminCookie())
        .send({ email })
        .expect(200);
      const again = await request(app)
        .post("/api/stories-editors")
        .set("Cookie", adminCookie())
        .send({ email })
        .expect(200);
      const { rowCount } = await pool.query(
        `SELECT 1 FROM story_editors WHERE email = $1`,
        [email],
      );
      // A duplicate row means the idempotency path is genuinely broken — fail
      // immediately regardless of contamination.
      expect(rowCount ?? 0).toBeLessThanOrEqual(1);
      if (again.body.alreadyExists === true && rowCount === 1) {
        sawAlreadyExists = true;
      }
    }
    expect(sawAlreadyExists).toBe(true);
  });

  test("admin can remove an editor and it stays removed", async () => {
    // Add a second editor so the table is never empty (the empty-table safety
    // net re-seeds defaults to avoid locking everyone out — not under test here).
    await request(app)
      .post("/api/stories-editors")
      .set("Cookie", adminCookie())
      .send({ email: "keep@test.local" })
      .expect(200);

    // Find the seeded default row and remove it.
    const list = await request(app).get("/api/stories-editors").set("Cookie", adminCookie()).expect(200);
    const row = (list.body.editors as Array<{ id: number; email: string }>).find(
      (e) => e.email === "editor@test.local",
    )!;
    await request(app)
      .delete(`/api/stories-editors/${row.id}`)
      .set("Cookie", adminCookie())
      .expect(200);

    // A second read must NOT re-seed the removed default.
    const after = await request(app).get("/api/stories-editors").set("Cookie", adminCookie()).expect(200);
    const emails = (after.body.editors as Array<{ email: string }>).map((e) => e.email);
    expect(emails).not.toContain("editor@test.local");
    expect(emails).toContain("keep@test.local");

    // The removed editor can no longer get a magic link.
    await request(app)
      .post("/api/stories-auth/request")
      .send({ email: "editor@test.local" })
      .expect(200);
    expect(sentMagicLinks.find((m) => m.to === "editor@test.local")).toBeUndefined();
  });

  test("rejects an invalid email", async () => {
    await request(app)
      .post("/api/stories-editors")
      .set("Cookie", adminCookie())
      .send({ email: "not-an-email" })
      .expect(400);
  });
});

describe("editor patch + status transitions", () => {
  async function seedSubmittedStory(): Promise<number> {
    const r = await pool.query(
      `INSERT INTO stories (draft_token, status, first_name, goal, hook, struggle, enablement,
        consent_copyright, consent_publish, consent_timestamp, consent_ip_hash, submitted_at)
       VALUES ($1, 'new', 'Sam', 'g', 'h', 's', 'e', true, true, NOW(), 'hash', NOW())
       RETURNING id`,
      [`tok-${Date.now()}-${Math.random()}`],
    );
    return r.rows[0].id;
  }

  test("editor can move new → in_edit → approved (sets approvedAt/approvedBy)", async () => {
    const id = await seedSubmittedStory();
    await request(app)
      .patch(`/api/stories/${id}`)
      .set("Cookie", adminCookie())
      .send({ status: "in_edit", pullQuote: "A quote." })
      .expect(200);
    const approved = await request(app)
      .patch(`/api/stories/${id}`)
      .set("Cookie", adminCookie())
      .send({ status: "approved" })
      .expect(200);
    expect(approved.body.story.status).toBe("approved");
    expect(approved.body.story.approvedAt).toBeTruthy();
    expect(approved.body.story.approvedBy).toBe("admin");
  });

  test("approved stories are locked — further patches return 409", async () => {
    const id = await seedSubmittedStory();
    await request(app)
      .patch(`/api/stories/${id}`)
      .set("Cookie", adminCookie())
      .send({ status: "approved" })
      .expect(200);
    await request(app)
      .patch(`/api/stories/${id}`)
      .set("Cookie", adminCookie())
      .send({ pullQuote: "tampering" })
      .expect(409);
    await request(app)
      .patch(`/api/stories/${id}`)
      .set("Cookie", adminCookie())
      .send({ status: "in_edit" })
      .expect(409);
  });
});

describe("exports include pull-quote and consent line", () => {
  async function seedApprovedStory(): Promise<number> {
    const r = await pool.query(
      `INSERT INTO stories (draft_token, status, first_name, goal, hook, struggle, enablement,
        draft_html, pull_quote,
        consent_copyright, consent_publish, consent_timestamp, consent_ip_hash, submitted_at, approved_at, approved_by)
       VALUES ($1, 'approved', 'Sam', 'g', 'h', 's', 'e',
         '<p>Body paragraph.</p>', 'A line that sings.',
         true, true, NOW(), 'hash', NOW(), NOW(), 'admin')
       RETURNING id`,
      [`tok-${Date.now()}-${Math.random()}`],
    );
    return r.rows[0].id;
  }

  test("HTML export contains the pull-quote and a consent line", async () => {
    const id = await seedApprovedStory();
    const res = await request(app)
      .get(`/api/stories/${id}/export.html`)
      .set("Cookie", adminCookie())
      .expect(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toContain("A line that sings.");
    expect(res.text).toContain("<blockquote");
    expect(res.text).toMatch(/Reader gave consent to publish on \d{4}-\d{2}-\d{2}/);
    expect(res.text).toContain("Body paragraph.");
  });

  test("Markdown export contains the pull-quote and a consent line", async () => {
    const id = await seedApprovedStory();
    const res = await request(app)
      .get(`/api/stories/${id}/export.md`)
      .set("Cookie", adminCookie())
      .expect(200);
    expect(res.headers["content-type"]).toMatch(/text\/markdown/);
    expect(res.text).toContain("> _A line that sings._");
    expect(res.text).toMatch(/Reader gave consent to publish on \d{4}-\d{2}-\d{2}/);
  });
});
