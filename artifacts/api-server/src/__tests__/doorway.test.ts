import { beforeAll, describe, test, expect, vi } from "vitest";
import { ensureCaptureLoopSchema } from "./testHelpers.js";

vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-doorway-secret";
  // The doorway pipeline REQUIRES an authenticated webhook (paid outbound
  // acks). Configure a secret for the suite; individual tests exercise the
  // unauthenticated paths explicitly.
  process.env.IMESSAGE_WEBHOOK_SECRET = "doorway-wh-secret";
});

// Mock the send module so acks are observable and nothing tries a real
// provider call. Everything else in the module keeps its real behavior.
const sendImessageMock = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true as const })),
);
vi.mock("../lib/imessage.js", async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>;
  return { ...mod, sendImessage: sendImessageMock };
});

import type { Express } from "express";
import request from "supertest";
import pool from "../lib/db.js";
import {
  phoneHash,
  useDoorwayToken,
  mintDoorwayLink,
  pruneStaleDoorwayQuestions,
  DOORWAY_LINK_MAX_USES,
  DOORWAY_NIGHT_CAP,
} from "../lib/doorway.js";

let app: Express;

const WH = { "x-webhook-secret": "doorway-wh-secret" };

// Unique numbers per run so the shared dev DB never collides across runs or
// parallel suites.
const stamp = Date.now() % 1000000;
function num(offset: number): string {
  return `+1628${String(1000000 + ((stamp + offset) % 9000000)).slice(0, 7)}`;
}

async function seedSubscriber(
  phone: string,
  product: string,
  status = "active",
): Promise<void> {
  await pool.query(
    `INSERT INTO phone_subscribers (phone, product, status, confirmed_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (product, phone) DO UPDATE SET status = EXCLUDED.status`,
    [phone, product, status],
  );
}

function lastSentBody(): string {
  const call = sendImessageMock.mock.calls.at(-1) as
    | [{ body: string }]
    | undefined;
  return call?.[0]?.body ?? "";
}

function extractToken(body: string): string {
  const m = body.match(/\/api\/doorway\/([a-f0-9]+)/);
  if (!m) throw new Error(`no doorway link in: ${body}`);
  return m[1];
}

beforeAll(async () => {
  await ensureCaptureLoopSchema();
  app = (await import("../app.js")).default;
});

describe("reply-as-doorway webhook pipeline", () => {
  test("registered sender gets a canned ack with a working magic link", async () => {
    const phone = num(1);
    await seedSubscriber(phone, "nightly");
    sendImessageMock.mockClear();

    const res = await request(app)
      .post("/api/phone/webhook")
      .set(WH)
      .send({ number: phone, content: "I can't sleep and I'm falling apart" });
    expect(res.status).toBe(200);
    expect(res.body.doorway).toBe("ack");

    expect(sendImessageMock).toHaveBeenCalledTimes(1);
    const body = lastSentBody();
    // Canned neutral copy — never AI, and the answer stays on the page.
    expect(body).toContain("/api/doorway/");
    expect(body).toContain("not in this thread");

    const token = extractToken(body);
    const redirect = await request(app).get(`/api/doorway/${token}`);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toContain("/sleep?q=");
    expect(redirect.headers.location).toContain(
      encodeURIComponent("I can't sleep"),
    );
    expect(redirect.headers.location).toContain(`dw=${token}`);

    // Event row: outcome ack, hashed sender, NO message text stored.
    const ev = await pool.query(
      `SELECT outcome, body_excerpt, crisis_flagged FROM doorway_events
        WHERE from_phone_hash = $1 ORDER BY id DESC LIMIT 1`,
      [phoneHash(phone)],
    );
    expect(ev.rows[0].outcome).toBe("ack");
    expect(ev.rows[0].body_excerpt).toBeNull();
    expect(ev.rows[0].crisis_flagged).toBe(false);
  });

  test("crisis language gets static resources, no link, excerpt stored", async () => {
    const phone = num(3);
    await seedSubscriber(phone, "nightly");
    sendImessageMock.mockClear();

    const res = await request(app)
      .post("/api/phone/webhook")
      .set(WH)
      .send({ number: phone, content: "some nights I just want to die" });
    expect(res.body.doorway).toBe("crisis");

    expect(sendImessageMock).toHaveBeenCalledTimes(1);
    const body = lastSentBody();
    expect(body).toContain("988");
    expect(body).not.toContain("/api/doorway/");

    const ev = await pool.query(
      `SELECT outcome, body_excerpt, crisis_flagged FROM doorway_events
        WHERE from_phone_hash = $1 ORDER BY id DESC LIMIT 1`,
      [phoneHash(phone)],
    );
    expect(ev.rows[0].outcome).toBe("crisis");
    expect(ev.rows[0].crisis_flagged).toBe(true);
    expect(ev.rows[0].body_excerpt).toContain("want to die");
  });

  test("unknown sender is logged and never replied to", async () => {
    const phone = num(4); // never seeded
    sendImessageMock.mockClear();

    const res = await request(app)
      .post("/api/phone/webhook")
      .set(WH)
      .send({ number: phone, content: "hello?" });
    expect(res.body.doorway).toBe("ignored");
    expect(sendImessageMock).not.toHaveBeenCalled();

    const ev = await pool.query(
      `SELECT outcome, body_excerpt FROM doorway_events
        WHERE from_phone_hash = $1 ORDER BY id DESC LIMIT 1`,
      [phoneHash(phone)],
    );
    expect(ev.rows[0].outcome).toBe("ignored");
    expect(ev.rows[0].body_excerpt).toBeNull();
  });

  test("rolling night cap sends a gentle final reply without a link", async () => {
    const phone = num(5);
    await seedSubscriber(phone, "nightly");
    // Pre-load the cap window with ack events.
    for (let i = 0; i < DOORWAY_NIGHT_CAP; i++) {
      await pool.query(
        `INSERT INTO doorway_events (from_phone_hash, product, outcome, provider_event_id)
         VALUES ($1, 'nightly', 'ack', $2)`,
        [phoneHash(phone), `cap-seed-${stamp}-${i}`],
      );
    }
    sendImessageMock.mockClear();

    const res = await request(app)
      .post("/api/phone/webhook")
      .set(WH)
      .send({ number: phone, content: "still awake" });
    expect(res.body.doorway).toBe("capped");
    expect(lastSentBody()).not.toContain("/api/doorway/");
  });

  test("webhook retries are deduped on the provider message handle", async () => {
    const phone = num(6);
    await seedSubscriber(phone, "nightly");
    sendImessageMock.mockClear();

    const payload = {
      number: phone,
      content: "wide awake again",
      message_handle: `dedup-${stamp}`,
    };
    const first = await request(app)
      .post("/api/phone/webhook")
      .set(WH)
      .send(payload);
    const second = await request(app)
      .post("/api/phone/webhook")
      .set(WH)
      .send(payload);
    expect(first.body.doorway).toBe("ack");
    expect(second.body.doorway).toBe("duplicate");
    expect(sendImessageMock).toHaveBeenCalledTimes(1);
  });

  test("STOP still resolves before the doorway pipeline", async () => {
    const phone = num(7);
    await seedSubscriber(phone, "nightly");
    sendImessageMock.mockClear();

    const res = await request(app)
      .post("/api/phone/webhook")
      .set(WH)
      .send({ number: phone, content: "STOP" });
    expect(res.status).toBe(200);
    expect(res.body.doorway).toBeUndefined();
    expect(sendImessageMock).not.toHaveBeenCalled();
  });

  test("without a configured secret the doorway channel is off", async () => {
    const phone = num(8);
    await seedSubscriber(phone, "nightly");
    const saved = process.env.IMESSAGE_WEBHOOK_SECRET;
    delete process.env.IMESSAGE_WEBHOOK_SECRET;
    sendImessageMock.mockClear();
    try {
      const res = await request(app)
        .post("/api/phone/webhook")
        .send({ number: phone, content: "can't sleep" });
      expect(res.status).toBe(200);
      expect(res.body.ignored).toBe("unauthenticated");
      expect(sendImessageMock).not.toHaveBeenCalled();
    } finally {
      process.env.IMESSAGE_WEBHOOK_SECRET = saved;
    }
  });
});

describe("doorway tokens", () => {
  test("stored questions are blanked once well past expiry", async () => {
    const evRes = await pool.query(
      `INSERT INTO doorway_events (from_phone_hash, product, outcome, provider_event_id)
       VALUES ('prune-test-hash', 'nightly', 'ack', $1) RETURNING id`,
      [`prune-${stamp}`],
    );
    const token = `prunetoken${stamp}`;
    // Expired 2 days ago — past the 24h grace window.
    await pool.query(
      `INSERT INTO doorway_links (token, doorway_event_id, product, question, expires_at)
       VALUES ($1, $2, 'nightly', 'a very private 3am message', now() - interval '2 days')`,
      [token, evRes.rows[0].id],
    );

    const pruned = await pruneStaleDoorwayQuestions();
    expect(pruned).toBeGreaterThanOrEqual(1);

    const row = await pool.query(
      `SELECT question FROM doorway_links WHERE token = $1`,
      [token],
    );
    expect(row.rows[0].question).toBe("");

    // The blanked stale link still redirects to the right surface — just
    // without the question or the comp.
    const redirect = await request(app).get(`/api/doorway/${token}`);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toContain("/sleep");
    expect(redirect.headers.location).not.toContain("private");
  });

  test("unknown token falls back to the sleep surface", async () => {
    const redirect = await request(app).get(`/api/doorway/deadbeef`);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe("/sleep");
  });
});
