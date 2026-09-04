/**
 * Task: data retention enforcement + consumer export/delete.
 *
 * Covers:
 *  - runRetentionCleanup(): rows inside the window survive, rows outside are
 *    purged/anonymized per category (tokens, doorway excerpts, analytics IPs
 *    and raw rows, email send log, stale visitor sessions).
 *  - buildConsumerExport(): compiles profile + question history.
 *  - POST /consumer/data-export: auth gate + guarded email send.
 *  - POST /consumer/delete-account: confirm step, PII gone (account
 *    anonymized in place, phone/prefs/sessions/tokens deleted, doorway event
 *    row KEPT with blank excerpt), billing detached, cookies cleared.
 *
 * Shared dev DB conventions: self-provision tables in beforeAll (tests import
 * app.ts, boot DDL never runs), namespace fixtures with a per-run stamp,
 * delete only own rows.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-data-retention-secret";
});

// Mock the Resend connection so export/delete sends are captured, not sent.
const sentEmails: Array<{ to: string; subject: string }> = [];
vi.mock("../lib/resendClient", () => ({
  getResendClient: async () => ({
    client: {
      emails: {
        send: async (payload: { to: string; subject: string }) => {
          sentEmails.push({ to: payload.to, subject: payload.subject });
          return { data: { id: `mock_${sentEmails.length}` }, error: null };
        },
      },
    },
    fromEmail: "checkin@palonur.com",
  }),
}));

import type { Express } from "express";
import request from "supertest";
import { createHmac } from "node:crypto";
import pool from "../lib/db.js";
import {
  runRetentionCleanup,
  LOGIN_TOKEN_RETENTION_DAYS,
  DOORWAY_EXCERPT_RETENTION_DAYS,
  ANALYTICS_RETENTION_DAYS,
  ANALYTICS_IP_RETENTION_DAYS,
  EMAIL_SEND_LOG_RETENTION_DAYS,
  VISITOR_SESSION_RETENTION_DAYS,
} from "../lib/retention.js";
import { buildConsumerExport, deletionDeps } from "../routes/consumerData.js";

let app: Express;
const stamp = `ret${Date.now().toString(36)}`;

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

function consumerCookie(id: number): string {
  const val = String(id);
  const mac = createHmac("sha256", process.env.SESSION_SECRET!)
    .update(val)
    .digest("base64")
    .replace(/=+$/, "");
  return `palonur_consumer=s%3A${val}.${encodeURIComponent(mac)}`;
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for dataRetention tests");
  }

  await pool.query(`CREATE TABLE IF NOT EXISTS consumer_accounts (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    stripe_customer_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(
    `ALTER TABLE consumer_accounts ADD COLUMN IF NOT EXISTS display_name TEXT`,
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS consumer_login_tokens (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    magic_token TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS visitor_sessions (
    session_id TEXT PRIMARY KEY,
    consumer_account_id INTEGER,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    claimed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS agent_queries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id TEXT NOT NULL,
    question TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'sleep-agent',
    pillar_ids INTEGER[] NOT NULL DEFAULT ARRAY[]::int[],
    retrieved_source_ids INTEGER[] NOT NULL DEFAULT ARRAY[]::int[],
    retrieved_interpretation_ids INTEGER[] NOT NULL DEFAULT ARRAY[]::int[],
    top_score REAL NOT NULL DEFAULT 0,
    was_uncovered BOOLEAN NOT NULL DEFAULT FALSE,
    answer_text TEXT NOT NULL DEFAULT '',
    latency_ms INTEGER NOT NULL DEFAULT 0,
    user_flagged BOOLEAN NOT NULL DEFAULT FALSE,
    flag_reason TEXT,
    cluster_id INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS doorway_events (
    id SERIAL PRIMARY KEY,
    channel TEXT NOT NULL DEFAULT 'imessage',
    from_phone_hash TEXT NOT NULL,
    consumer_account_id INTEGER,
    product TEXT NOT NULL,
    body_excerpt TEXT,
    crisis_flagged BOOLEAN NOT NULL DEFAULT FALSE,
    outcome TEXT NOT NULL,
    provider_event_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS doorway_links (
    id SERIAL PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    doorway_event_id INTEGER,
    product TEXT NOT NULL,
    question TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS phone_subscribers (
    id SERIAL PRIMARY KEY,
    phone TEXT NOT NULL,
    consumer_account_id INTEGER,
    confirm_token TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS notification_preferences (
    id SERIAL PRIMARY KEY,
    consumer_account_id INTEGER NOT NULL,
    product TEXT NOT NULL,
    channel TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS email_sends (
    id SERIAL PRIMARY KEY,
    label TEXT NOT NULL,
    recipient_hash TEXT NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS palonur_pageviews (
    id SERIAL PRIMARY KEY,
    session_id TEXT,
    page TEXT,
    referrer TEXT,
    ip TEXT,
    country TEXT,
    city TEXT,
    visitor_id TEXT,
    is_bot BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS palonur_video_views (
    id SERIAL PRIMARY KEY,
    video TEXT,
    session_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS referral_codes (
    id SERIAL PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    owner_email TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS referral_events (
    id SERIAL PRIMARY KEY,
    code TEXT NOT NULL,
    event_type TEXT NOT NULL,
    recipient_email TEXT,
    credited_cents INTEGER,
    ip_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS referral_bonus (
    id SERIAL PRIMARY KEY,
    consumer_account_id INTEGER NOT NULL UNIQUE,
    bonus_questions_remaining INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS journey_passes (
    id SERIAL PRIMARY KEY,
    consumer_account_id INTEGER NOT NULL,
    product TEXT NOT NULL,
    stripe_session_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    expires_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sleep_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id TEXT NOT NULL,
    consumer_account_id INTEGER,
    free_turns_used INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sleep_conversation_messages (
    id SERIAL PRIMARY KEY,
    conversation_id UUID NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    meta JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS newsletter_subscriber_sessions (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    magic_token TEXT UNIQUE,
    session_token TEXT UNIQUE,
    consumed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    session_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  // The shared dev DB accumulates email throttle hits across runs — reset
  // ours so the export request isn't 429'd by a previous run (guarded: the
  // table may not exist on a fresh DB).
  await pool.query(`DELETE FROM email_rate_limit_hits`).catch(() => undefined);

  const mod = await import("../app.js");
  app = mod.default;
});

afterAll(async () => {
  // Delete only rows this suite created (everything carries `stamp`).
  await pool.query(`DELETE FROM doorway_links WHERE token LIKE $1`, [
    `${stamp}%`,
  ]);
  await pool.query(`DELETE FROM doorway_events WHERE from_phone_hash LIKE $1`, [
    `${stamp}%`,
  ]);
  await pool.query(`DELETE FROM agent_queries WHERE session_id LIKE $1`, [
    `${stamp}%`,
  ]);
  await pool.query(`DELETE FROM visitor_sessions WHERE session_id LIKE $1`, [
    `${stamp}%`,
  ]);
  await pool.query(`DELETE FROM consumer_login_tokens WHERE email LIKE $1`, [
    `%${stamp}%`,
  ]);
  await pool.query(
    `DELETE FROM newsletter_subscriber_sessions WHERE email LIKE $1`,
    [`%${stamp}%`],
  );
  await pool.query(`DELETE FROM email_sends WHERE recipient_hash LIKE $1`, [
    `${stamp}%`,
  ]);
  await pool.query(`DELETE FROM palonur_pageviews WHERE session_id LIKE $1`, [
    `${stamp}%`,
  ]);
  await pool.query(`DELETE FROM palonur_video_views WHERE session_id LIKE $1`, [
    `${stamp}%`,
  ]);
  await pool.query(`DELETE FROM phone_subscribers WHERE phone LIKE $1`, [
    `%${stamp}%`,
  ]);
  for (const [parent, child] of [
    ["sleep_conversations", "sleep_conversation_messages"],
  ] as const) {
    await pool.query(
      `DELETE FROM ${child} WHERE conversation_id IN
        (SELECT id FROM ${parent} WHERE session_id LIKE $1)`,
      [`${stamp}%`],
    );
    await pool.query(`DELETE FROM ${parent} WHERE session_id LIKE $1`, [
      `${stamp}%`,
    ]);
  }
  await pool.query(`DELETE FROM referral_codes WHERE code LIKE $1`, [
    `%${stamp}%`,
  ]);
  await pool.query(`DELETE FROM referral_events WHERE code LIKE $1`, [
    `%${stamp}%`,
  ]);
  await pool.query(
    `DELETE FROM journey_passes WHERE consumer_account_id IN
      (SELECT id FROM consumer_accounts WHERE email LIKE $1)`,
    [`%${stamp}%`],
  );
  await pool.query(
    `DELETE FROM referral_bonus WHERE consumer_account_id IN
      (SELECT id FROM consumer_accounts WHERE email LIKE $1)`,
    [`%${stamp}%`],
  );
  await pool.query(`DELETE FROM consumer_accounts WHERE email LIKE $1`, [
    `%${stamp}%`,
  ]);
});

// ── Retention cleanup job ────────────────────────────────────────────────────

describe("runRetentionCleanup", () => {
  test("purges/anonymizes aged rows, keeps rows inside each window", async () => {
    // Seed one inside-window and one outside-window row per category.
    await pool.query(
      `INSERT INTO consumer_login_tokens (email, magic_token, expires_at)
       VALUES ($1, $2, $3), ($4, $5, $6)`,
      [
        `keep-${stamp}@test.local`,
        `tok-keep-${stamp}`,
        daysAgo(LOGIN_TOKEN_RETENTION_DAYS - 5),
        `old-${stamp}@test.local`,
        `tok-old-${stamp}`,
        daysAgo(LOGIN_TOKEN_RETENTION_DAYS + 5),
      ],
    );
    await pool.query(
      `INSERT INTO newsletter_subscriber_sessions (email, magic_token, expires_at)
       VALUES ($1, $2, $3), ($4, $5, $6)`,
      [
        `mkeep-${stamp}@test.local`,
        `mtok-keep-${stamp}`,
        daysAgo(LOGIN_TOKEN_RETENTION_DAYS - 5),
        `mold-${stamp}@test.local`,
        `mtok-old-${stamp}`,
        daysAgo(LOGIN_TOKEN_RETENTION_DAYS + 5),
      ],
    );
    await pool.query(
      `INSERT INTO doorway_events (from_phone_hash, product, body_excerpt, crisis_flagged, outcome, created_at)
       VALUES ($1, 'nightly', 'recent crisis text', true, 'crisis', $2),
              ($3, 'nightly', 'ancient crisis text', true, 'crisis', $4)`,
      [
        `${stamp}-hash-recent`,
        daysAgo(DOORWAY_EXCERPT_RETENTION_DAYS - 10),
        `${stamp}-hash-old`,
        daysAgo(DOORWAY_EXCERPT_RETENTION_DAYS + 10),
      ],
    );
    await pool.query(
      `INSERT INTO palonur_pageviews (session_id, page, ip, created_at)
       VALUES ($1, '/', '10.0.0.1', $2),   -- fresh: untouched
              ($3, '/', '10.0.0.2', $4),   -- mid-age: ip nulled, row kept
              ($5, '/', '10.0.0.3', $6)`, // ancient: deleted
      [
        `${stamp}-pv-fresh`,
        daysAgo(ANALYTICS_IP_RETENTION_DAYS - 10),
        `${stamp}-pv-mid`,
        daysAgo(ANALYTICS_IP_RETENTION_DAYS + 10),
        `${stamp}-pv-old`,
        daysAgo(ANALYTICS_RETENTION_DAYS + 10),
      ],
    );
    await pool.query(
      `INSERT INTO palonur_video_views (video, session_id, created_at)
       VALUES ('v', $1, $2), ('v', $3, $4)`,
      [
        `${stamp}-vv-keep`,
        daysAgo(ANALYTICS_RETENTION_DAYS - 10),
        `${stamp}-vv-old`,
        daysAgo(ANALYTICS_RETENTION_DAYS + 10),
      ],
    );
    await pool.query(
      `INSERT INTO email_sends (label, recipient_hash, sent_at)
       VALUES ('test', $1, $2), ('test', $3, $4)`,
      [
        `${stamp}-es-keep`,
        daysAgo(EMAIL_SEND_LOG_RETENTION_DAYS - 10),
        `${stamp}-es-old`,
        daysAgo(EMAIL_SEND_LOG_RETENTION_DAYS + 10),
      ],
    );
    await pool.query(
      `INSERT INTO visitor_sessions (session_id, last_seen_at)
       VALUES ($1, $2), ($3, $4)`,
      [
        `${stamp}-vs-keep`,
        daysAgo(VISITOR_SESSION_RETENTION_DAYS - 10),
        `${stamp}-vs-old`,
        daysAgo(VISITOR_SESSION_RETENTION_DAYS + 10),
      ],
    );

    // Conversation threads: one idle beyond 24 months (with a message), one
    // recent (with a message).
    for (const [parent, child] of [
      ["sleep_conversations", "sleep_conversation_messages"],
    ] as const) {
      const oldConv = await pool.query(
        `INSERT INTO ${parent} (session_id, last_message_at) VALUES ($1, $2) RETURNING id`,
        [`${stamp}-conv-old`, daysAgo(VISITOR_SESSION_RETENTION_DAYS + 10)],
      );
      await pool.query(
        `INSERT INTO ${child} (conversation_id, role, content) VALUES ($1, 'user', 'ancient heart-pour')`,
        [oldConv.rows[0].id],
      );
      const keepConv = await pool.query(
        `INSERT INTO ${parent} (session_id, last_message_at) VALUES ($1, $2) RETURNING id`,
        [`${stamp}-conv-keep`, daysAgo(VISITOR_SESSION_RETENTION_DAYS - 10)],
      );
      await pool.query(
        `INSERT INTO ${child} (conversation_id, role, content) VALUES ($1, 'user', 'recent message')`,
        [keepConv.rows[0].id],
      );
    }

    const report = await runRetentionCleanup();
    expect(report.loginTokensDeleted).toBeGreaterThanOrEqual(1);

    const tokens = await pool.query(
      `SELECT magic_token FROM consumer_login_tokens WHERE magic_token LIKE $1`,
      [`tok-%${stamp}`],
    );
    expect(tokens.rows.map((r) => r.magic_token)).toEqual([
      `tok-keep-${stamp}`,
    ]);

    const msessions = await pool.query(
      `SELECT magic_token FROM newsletter_subscriber_sessions WHERE magic_token LIKE $1`,
      [`mtok-%${stamp}`],
    );
    expect(msessions.rows.map((r) => r.magic_token)).toEqual([
      `mtok-keep-${stamp}`,
    ]);

    // Doorway: old excerpt blanked, event row still present; recent intact.
    const doorway = await pool.query(
      `SELECT from_phone_hash, body_excerpt FROM doorway_events
        WHERE from_phone_hash LIKE $1 ORDER BY from_phone_hash`,
      [`${stamp}-hash-%`],
    );
    expect(doorway.rows).toEqual([
      { from_phone_hash: `${stamp}-hash-old`, body_excerpt: "" },
      {
        from_phone_hash: `${stamp}-hash-recent`,
        body_excerpt: "recent crisis text",
      },
    ]);

    // Pageviews: fresh untouched, mid-age IP nulled but kept, ancient gone.
    const pv = await pool.query(
      `SELECT session_id, ip FROM palonur_pageviews
        WHERE session_id LIKE $1 ORDER BY session_id`,
      [`${stamp}-pv-%`],
    );
    expect(pv.rows).toEqual([
      { session_id: `${stamp}-pv-fresh`, ip: "10.0.0.1" },
      { session_id: `${stamp}-pv-mid`, ip: null },
    ]);

    const vv = await pool.query(
      `SELECT session_id FROM palonur_video_views WHERE session_id LIKE $1`,
      [`${stamp}-vv-%`],
    );
    expect(vv.rows).toEqual([{ session_id: `${stamp}-vv-keep` }]);

    const es = await pool.query(
      `SELECT recipient_hash FROM email_sends WHERE recipient_hash LIKE $1`,
      [`${stamp}-es-%`],
    );
    expect(es.rows).toEqual([{ recipient_hash: `${stamp}-es-keep` }]);

    const vs = await pool.query(
      `SELECT session_id FROM visitor_sessions WHERE session_id LIKE $1`,
      [`${stamp}-vs-%`],
    );
    expect(vs.rows).toEqual([{ session_id: `${stamp}-vs-keep` }]);

    // Idle conversation threads deleted with their messages; recent kept.
    for (const [parent, child] of [
      ["sleep_conversations", "sleep_conversation_messages"],
    ] as const) {
      const convs = await pool.query(
        `SELECT session_id FROM ${parent} WHERE session_id LIKE $1`,
        [`${stamp}-conv-%`],
      );
      expect(convs.rows, parent).toEqual([
        { session_id: `${stamp}-conv-keep` },
      ]);
      const orphanMsgs = await pool.query(
        `SELECT 1 FROM ${child} m
          WHERE NOT EXISTS (SELECT 1 FROM ${parent} c WHERE c.id = m.conversation_id)
            AND m.content = 'ancient heart-pour'`,
      );
      expect(orphanMsgs.rows, child).toHaveLength(0);
    }
  });

  test("is idempotent — a second run affects nothing new in seeded categories", async () => {
    const again = await runRetentionCleanup();
    // Our seeded out-of-window rows were already handled; the doorway/token
    // categories must not find them again.
    const doorway = await pool.query(
      `SELECT 1 FROM doorway_events
        WHERE from_phone_hash = $1 AND body_excerpt <> ''`,
      [`${stamp}-hash-old`],
    );
    expect(doorway.rows).toHaveLength(0);
    expect(again).toBeTruthy();
  });
});

// ── Export ───────────────────────────────────────────────────────────────────

describe("consumer data export", () => {
  let accountId = 0;
  const email = `export-${stamp}@test.local`;

  beforeAll(async () => {
    const r = await pool.query(
      `INSERT INTO consumer_accounts (email, display_name) VALUES ($1, 'Ex Porter')
       RETURNING id`,
      [email],
    );
    accountId = r.rows[0].id as number;
    await pool.query(
      `INSERT INTO visitor_sessions (session_id, consumer_account_id)
       VALUES ($1, $2)`,
      [`${stamp}-export-session`, accountId],
    );
    await pool.query(
      `INSERT INTO agent_queries (session_id, question, source)
       VALUES ($1, 'How much sleep do I need?', 'sleep-agent')`,
      [`${stamp}-export-session`],
    );
  });

  test("buildConsumerExport compiles profile and question history", async () => {
    const data = await buildConsumerExport({
      id: accountId,
      email,
      displayName: "Ex Porter",
      stripeCustomerId: null,
      emailVerifiedAt: null,
      provisional: false,
    });
    expect(data.profile.email).toBe(email);
    expect(data.profile.displayName).toBe("Ex Porter");
    expect(data.questions).toHaveLength(1);
    expect(data.questions[0].question).toBe("How much sleep do I need?");
    expect(data.questions[0].surface).toBe("sleep-agent");
  });

  test("POST /consumer/data-export requires auth", async () => {
    const res = await request(app).post("/api/consumer/data-export");
    expect(res.status).toBe(401);
  });

  test("POST /consumer/data-export emails the export to the account address", async () => {
    // Outside production, sendGuarded short-circuits with a synthetic success
    // BEFORE touching the Resend client (env gate), so we assert the route
    // outcome rather than a captured payload.
    const res = await request(app)
      .post("/api/consumer/data-export")
      .set("Cookie", consumerCookie(accountId));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ── Deletion ─────────────────────────────────────────────────────────────────

describe("consumer account deletion", () => {
  let accountId = 0;
  const email = `delete-${stamp}@test.local`;

  beforeAll(async () => {
    const r = await pool.query(
      `INSERT INTO consumer_accounts (email, display_name, stripe_customer_id)
       VALUES ($1, 'Dele Ter', $2) RETURNING id`,
      [email, `cus_${stamp}`],
    );
    accountId = r.rows[0].id as number;
    await pool.query(
      `INSERT INTO visitor_sessions (session_id, consumer_account_id) VALUES ($1, $2)`,
      [`${stamp}-del-session`, accountId],
    );
    await pool.query(
      `INSERT INTO agent_queries (session_id, question) VALUES ($1, 'kept pseudonymously')`,
      [`${stamp}-del-session`],
    );
    await pool.query(
      `INSERT INTO phone_subscribers (phone, product, consumer_account_id, status)
       VALUES ($1, 'nightly', $2, 'active')`,
      [`+1555${stamp}`, accountId],
    );
    await pool.query(
      `INSERT INTO notification_preferences (consumer_account_id, product, channel)
       VALUES ($1, 'nightly', 'both')`,
      [accountId],
    );
    const ev = await pool.query(
      `INSERT INTO doorway_events (from_phone_hash, consumer_account_id, product, body_excerpt, crisis_flagged, outcome)
       VALUES ($1, $2, 'nightly', 'a hard 3am text', true, 'crisis') RETURNING id`,
      [`${stamp}-del-hash`, accountId],
    );
    await pool.query(
      `INSERT INTO doorway_links (token, doorway_event_id, product, question, expires_at)
       VALUES ($1, $2, 'nightly', 'their raw message', NOW() + INTERVAL '1 hour')`,
      [`${stamp}-del-token`, ev.rows[0].id],
    );
    await pool.query(
      `INSERT INTO consumer_login_tokens (email, magic_token, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '30 minutes')`,
      [email, `tok-del-${stamp}`],
    );
    await pool.query(
      `INSERT INTO journey_passes (consumer_account_id, product, stripe_session_id, expires_at)
       VALUES ($1, 'nightly', $2, NOW() + INTERVAL '7 days')`,
      [accountId, `cs_${stamp}`],
    );
    await pool.query(
      `INSERT INTO referral_codes (code, owner_email) VALUES ($1, $2)`,
      [`RC${stamp}`, email],
    );
    await pool.query(
      `INSERT INTO referral_events (code, event_type, recipient_email)
       VALUES ('SO${stamp}', 'signup', $1)`,
      [email],
    );
    await pool.query(
      `INSERT INTO referral_bonus (consumer_account_id, bonus_questions_remaining)
       VALUES ($1, 3)`,
      [accountId],
    );
    for (const [parent, child] of [
      ["sleep_conversations", "sleep_conversation_messages"],
    ] as const) {
      const conv = await pool.query(
        `INSERT INTO ${parent} (session_id, consumer_account_id) VALUES ($1, $2) RETURNING id`,
        [`${stamp}-del-conv`, accountId],
      );
      await pool.query(
        `INSERT INTO ${child} (conversation_id, role, content) VALUES ($1, 'user', 'very personal message')`,
        [conv.rows[0].id],
      );
    }
    // Governance-style row that must survive (email_sends is the audit stand-in).
    await pool.query(
      `INSERT INTO email_sends (label, recipient_hash) VALUES ('audit', $1)`,
      [`${stamp}-es-audit`],
    );
  });

  test("requires auth", async () => {
    const res = await request(app)
      .post("/api/consumer/delete-account")
      .send({ confirm: "DELETE" });
    expect(res.status).toBe(401);
  });

  test("requires the typed confirm phrase", async () => {
    const res = await request(app)
      .post("/api/consumer/delete-account")
      .set("Cookie", consumerCookie(accountId))
      .send({ confirm: "yes please" });
    expect(res.status).toBe(400);
  });

  test("refuses deletion while a subscription is active (409, no mutation)", async () => {
    const original = deletionDeps.countActiveSubs;
    deletionDeps.countActiveSubs = async () => 1;
    try {
      const res = await request(app)
        .post("/api/consumer/delete-account")
        .set("Cookie", consumerCookie(accountId))
        .send({ confirm: "DELETE" });
      expect(res.status).toBe(409);
    } finally {
      deletionDeps.countActiveSubs = original;
    }
    const acct = await pool.query(
      `SELECT email FROM consumer_accounts WHERE id = $1`,
      [accountId],
    );
    expect(acct.rows[0].email).toBe(email);
  });

  test("fails closed (503, no mutation) when the subscription lookup errors", async () => {
    const original = deletionDeps.countActiveSubs;
    deletionDeps.countActiveSubs = async () => {
      throw new Error("stripe schema unavailable");
    };
    try {
      const res = await request(app)
        .post("/api/consumer/delete-account")
        .set("Cookie", consumerCookie(accountId))
        .send({ confirm: "DELETE" });
      expect(res.status).toBe(503);
    } finally {
      deletionDeps.countActiveSubs = original;
    }
    const acct = await pool.query(
      `SELECT email FROM consumer_accounts WHERE id = $1`,
      [accountId],
    );
    expect(acct.rows[0].email).toBe(email);
    const phone = await pool.query(
      `SELECT 1 FROM phone_subscribers WHERE consumer_account_id = $1`,
      [accountId],
    );
    expect(phone.rows).toHaveLength(1);
  });

  test("anonymizes PII, keeps audit rows, clears cookies, sends confirmation", async () => {
    sentEmails.length = 0;
    const res = await request(app)
      .post("/api/consumer/delete-account")
      .set("Cookie", consumerCookie(accountId))
      .send({ confirm: "DELETE" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Cookies cleared.
    const setCookies = res.headers["set-cookie"] as unknown as string[];
    expect(setCookies.join(";")).toContain("palonur_consumer=;");
    expect(setCookies.join(";")).toContain("members_session=;");

    // Account anonymized in place — row exists, PII gone, billing detached.
    const acct = await pool.query(
      `SELECT email, display_name, stripe_customer_id FROM consumer_accounts WHERE id = $1`,
      [accountId],
    );
    expect(acct.rows).toHaveLength(1);
    expect(acct.rows[0].email).toBe(
      `deleted-account-${accountId}@anonymized.invalid`,
    );
    expect(acct.rows[0].display_name).toBeNull();
    expect(acct.rows[0].stripe_customer_id).toBeNull();

    // Phone, prefs, session linkage, tokens: gone.
    for (const [table, where, param] of [
      ["phone_subscribers", "consumer_account_id = $1", accountId],
      ["notification_preferences", "consumer_account_id = $1", accountId],
      ["visitor_sessions", "consumer_account_id = $1", accountId],
      ["consumer_login_tokens", "email = $1", email],
    ] as const) {
      const r = await pool.query(`SELECT 1 FROM ${table} WHERE ${where}`, [
        param,
      ]);
      expect(r.rows, table).toHaveLength(0);
    }

    // Question history survives pseudonymously (no account linkage).
    const q = await pool.query(
      `SELECT question FROM agent_queries WHERE session_id = $1`,
      [`${stamp}-del-session`],
    );
    expect(q.rows).toHaveLength(1);

    // Doorway event row kept for audit, but content + linkage removed.
    const ev = await pool.query(
      `SELECT consumer_account_id, body_excerpt FROM doorway_events WHERE from_phone_hash = $1`,
      [`${stamp}-del-hash`],
    );
    expect(ev.rows).toEqual([{ consumer_account_id: null, body_excerpt: "" }]);
    const link = await pool.query(
      `SELECT question FROM doorway_links WHERE token = $1`,
      [`${stamp}-del-token`],
    );
    expect(link.rows).toEqual([{ question: "" }]);

    // Conversation threads + message content gone.
    for (const [parent, child] of [
      ["sleep_conversations", "sleep_conversation_messages"],
    ] as const) {
      const convs = await pool.query(
        `SELECT 1 FROM ${parent} WHERE consumer_account_id = $1`,
        [accountId],
      );
      expect(convs.rows, parent).toHaveLength(0);
      const msgs = await pool.query(
        `SELECT 1 FROM ${child} m
          JOIN ${parent} c ON c.id = m.conversation_id
         WHERE c.session_id = $1`,
        [`${stamp}-del-conv`],
      );
      expect(msgs.rows, child).toHaveLength(0);
    }

    // Journey pass kept (FK to the anonymized account) minus its Stripe handle.
    const pass = await pool.query(
      `SELECT stripe_session_id FROM journey_passes WHERE consumer_account_id = $1`,
      [accountId],
    );
    expect(pass.rows).toEqual([{ stripe_session_id: null }]);

    // Referral: owner code deleted, recipient email nulled, bonus row gone.
    const rc = await pool.query(
      `SELECT 1 FROM referral_codes WHERE owner_email = $1`,
      [email],
    );
    expect(rc.rows).toHaveLength(0);
    const re = await pool.query(
      `SELECT 1 FROM referral_events WHERE recipient_email = $1`,
      [email],
    );
    expect(re.rows).toHaveLength(0);
    const rb = await pool.query(
      `SELECT 1 FROM referral_bonus WHERE consumer_account_id = $1`,
      [accountId],
    );
    expect(rb.rows).toHaveLength(0);

    // Non-personal audit row intact.
    const audit = await pool.query(
      `SELECT 1 FROM email_sends WHERE recipient_hash = $1`,
      [`${stamp}-es-audit`],
    );
    expect(audit.rows).toHaveLength(1);

    // The old cookie no longer authenticates a follow-up export... it still
    // resolves the (anonymized) account, but the email now points nowhere
    // personal. A fresh deletion attempt is a no-op, not an error.
    const again = await request(app)
      .post("/api/consumer/delete-account")
      .set("Cookie", consumerCookie(accountId))
      .send({ confirm: "DELETE" });
    expect(again.status).toBe(200);
  });
});
