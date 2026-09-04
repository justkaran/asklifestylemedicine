/**
 * Black-box misuse detection: signal detection, statistical scoring,
 * licensee attribution, probe CRUD (admin-only), detection sessions, and
 * evidence-package export.
 */
import { beforeAll, afterAll, describe, test, expect, vi } from "vitest";
import { createHmac } from "node:crypto";

// Admin cookie stubbing (same pattern as adminAudit.test.ts).
const SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
process.env.SESSION_SECRET = SESSION_SECRET;

function signCookie(val: string): string {
  const sig = createHmac("sha256", SESSION_SECRET)
    .update(val)
    .digest("base64")
    .replace(/=+$/, "");
  return `s:${val}.${sig}`;
}
const ADMIN_COOKIE = `palonur_admin=${encodeURIComponent(signCookie("1"))}`;

import pool from "../lib/db.js";
import {
  CANARY_SPECS,
  zeroWidthEncode,
  ensureFingerprint,
  sha256Hex,
} from "../lib/ipProtection.js";
import {
  detectSignals,
  scoreSession,
  attributeSession,
  zeroWidthDecodeAll,
  buildMethodologyDoc,
  CANARY_ASSOCIATIONS,
  type ProbeResult,
  type FingerprintInfo,
} from "../lib/misuseDetection.js";

async function ensureSchema(): Promise<void> {
  // Tests import app.ts, not index.ts — self-provision boot DDL.
  await pool.query(
    `ALTER TABLE sources ADD COLUMN IF NOT EXISTS content_hash TEXT,
       ADD COLUMN IF NOT EXISTS is_canary BOOLEAN NOT NULL DEFAULT FALSE`,
  );
  await pool.query(
    `ALTER TABLE source_chunks ADD COLUMN IF NOT EXISTS content_hash TEXT`,
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS misuse_probes (
    id SERIAL PRIMARY KEY,
    label TEXT NOT NULL,
    prompt TEXT NOT NULL,
    target_kind TEXT NOT NULL DEFAULT 'canary',
    canary_doi TEXT,
    expected_signals JSONB NOT NULL DEFAULT '[]',
    notes TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS detection_sessions (
    id SERIAL PRIMARY KEY,
    label TEXT NOT NULL,
    mode TEXT NOT NULL,
    target JSONB,
    results JSONB NOT NULL DEFAULT '[]',
    stats JSONB NOT NULL DEFAULT '{}',
    attribution JSONB NOT NULL DEFAULT '{}',
    manifest_id INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS corpus_manifests (
    id SERIAL PRIMARY KEY,
    manifest_hash TEXT NOT NULL,
    source_count INTEGER NOT NULL,
    chunk_count INTEGER NOT NULL,
    entries JSONB NOT NULL,
    reason TEXT NOT NULL DEFAULT 'boot',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS partner_key_fingerprints (
    id SERIAL PRIMARY KEY,
    partner_key_id INTEGER NOT NULL REFERENCES partner_keys(id) ON DELETE CASCADE,
    fingerprint_secret TEXT NOT NULL,
    marker_code TEXT NOT NULL,
    canary_variant INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS partner_key_fingerprints_key_unique
       ON partner_key_fingerprints (partner_key_id)`,
  );
}

async function insertPartnerKey(name: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO partner_keys (key_hash, key_prefix, partner_name)
     VALUES ($1, 'plnr_test', $2) RETURNING id`,
    [sha256Hex(`misuse-${name}-${Date.now()}-${Math.random()}`), name],
  );
  return rows[0].id;
}

let keyA = 0;
let keyB = 0;

beforeAll(async () => {
  await ensureSchema();
  keyA = await insertPartnerKey("Misuse Test Partner A");
  keyB = await insertPartnerKey("Misuse Test Partner B");
});

afterAll(async () => {
  await pool.query(
    `DELETE FROM misuse_probes WHERE label LIKE 'MDTEST %'`,
  );
  await pool.query(
    `DELETE FROM detection_sessions WHERE label LIKE 'MDTEST %'`,
  );
  await pool.query(`DELETE FROM partner_keys WHERE id = ANY($1::int[])`, [
    [keyA, keyB],
  ]);
  await pool.end();
});

describe("signal detection", () => {
  const spec = CANARY_SPECS[0];

  test("detects exact canary token", () => {
    const signals = detectSignals(`Some answer mentioning ${spec.token} verbatim.`);
    expect(signals).toContainEqual({
      type: "canary_token",
      canaryDoi: spec.doi,
      evidence: spec.token,
    });
  });

  test("fabricated association needs at least TWO distinct phrases", () => {
    const [p1, p2] = CANARY_ASSOCIATIONS[spec.doi];
    const one = detectSignals(`This text only mentions ${p1}.`);
    expect(one.filter((s) => s.type === "fabricated_association")).toHaveLength(0);
    const two = detectSignals(`This text pairs ${p1} with the ${p2} idea.`);
    const assoc = two.filter((s) => s.type === "fabricated_association");
    expect(assoc).toHaveLength(1);
    expect(assoc[0].canaryDoi).toBe(spec.doi);
  });

  test("decodes zero-width fingerprint markers (all runs, not just first)", () => {
    const m1 = zeroWidthEncode("plnrfp:aaaabbbbcccc");
    const m2 = zeroWidthEncode("plnrfp:ddddeeeeffff");
    const text = `Answer ${m1} with two ${m2} markers.`;
    expect(zeroWidthDecodeAll(text)).toEqual([
      "plnrfp:aaaabbbbcccc",
      "plnrfp:ddddeeeeffff",
    ]);
    const signals = detectSignals(text);
    const markers = signals.filter((s) => s.type === "zero_width_marker");
    expect(markers.map((s) => s.evidence).sort()).toEqual([
      "aaaabbbbcccc",
      "ddddeeeeffff",
    ]);
  });

  test("clean text yields no signals", () => {
    expect(detectSignals("Melatonin regulates circadian rhythm.")).toEqual([]);
  });
});

function result(partial: Partial<ProbeResult>): ProbeResult {
  return {
    probeId: null,
    label: "t",
    prompt: "p",
    responseText: "r",
    error: null,
    signals: [],
    ...partial,
  };
}

describe("statistical scoring", () => {
  const spec = CANARY_SPECS[0];

  test("no hits → confidence none, honest absence framing", () => {
    const stats = scoreSession([result({}), result({})]);
    expect(stats.confidence).toBe("none");
    expect(stats.hitProbeCount).toBe(0);
    expect(stats.interpretation).toMatch(/NOT evidence of absence/);
    expect(stats.interpretation).toMatch(/statistical evidence, not proof/i);
  });

  test("token hits rate strong; single association rates weak; base rates stated", () => {
    const strong = scoreSession([
      result({ signals: detectSignals(`x ${spec.token}`) }),
      result({ signals: detectSignals(`y ${spec.token}`) }),
    ]);
    expect(strong.confidence).toBe("strong");
    expect(strong.perCanary[0]).toMatchObject({
      canaryDoi: spec.doi,
      tokenHits: 2,
      assumedBaseRateCeiling: expect.any(Number),
    });
    expect(strong.interpretation).toMatch(/not proof/i);

    const [p1, p2] = CANARY_ASSOCIATIONS[spec.doi];
    const weak = scoreSession([
      result({ signals: detectSignals(`pairs ${p1} and ${p2}`) }),
    ]);
    expect(weak.confidence).toBe("weak");
  });
});

describe("attribution", () => {
  const fps: FingerprintInfo[] = [
    { partnerKeyId: 1, partnerName: "A", markerCode: "aaaabbbbcccc", canaryVariant: 0, canaryDoi: CANARY_SPECS[0].doi, revoked: false },
    { partnerKeyId: 2, partnerName: "B", markerCode: "ddddeeeeffff", canaryVariant: 0, canaryDoi: CANARY_SPECS[0].doi, revoked: false },
    { partnerKeyId: 3, partnerName: "C", markerCode: "999988887777", canaryVariant: 1, canaryDoi: CANARY_SPECS[1].doi, revoked: false },
  ];

  test("marker hit attributes directly to one licensee", () => {
    const stats = scoreSession([
      result({ signals: detectSignals(`x ${zeroWidthEncode("plnrfp:aaaabbbbcccc")}`) }),
    ]);
    const att = attributeSession(stats, fps);
    expect(att.best?.partnerKeyId).toBe(1);
    expect(att.best?.markerMatch).toBe(true);
    expect(att.ambiguous).toBe(false);
    expect(att.note).toMatch(/statistical evidence, not proof/i);
  });

  test("shared canary variant is honestly ambiguous", () => {
    const stats = scoreSession([
      result({ signals: detectSignals(`x ${CANARY_SPECS[0].token}`) }),
    ]);
    const att = attributeSession(stats, fps);
    expect(att.ambiguous).toBe(true);
    expect(att.note).toMatch(/multiple licensees/i);
    // Both variant-0 licensees are candidates.
    expect(att.candidates.map((c) => c.partnerKeyId).sort()).toEqual([1, 2]);
  });

  test("uniquely-assigned variant is the best match but framed as a lead", () => {
    const stats = scoreSession([
      result({ signals: detectSignals(`x ${CANARY_SPECS[1].token}`) }),
    ]);
    const att = attributeSession(stats, fps);
    expect(att.best?.partnerKeyId).toBe(3);
    expect(att.ambiguous).toBe(false);
    expect(att.note).toMatch(/lead, not a conclusion/i);
  });

  test("signals with no fingerprint mapping → no attribution, honest note", () => {
    const stats = scoreSession([
      result({ signals: detectSignals(`x ${CANARY_SPECS[2].token}`) }),
    ]);
    const att = attributeSession(stats, fps);
    expect(att.best).toBeNull();
    expect(att.candidates).toHaveLength(0);
    expect(att.note).toMatch(/non-keyed channel|stripped/i);
  });
});

describe("SSRF guard on live endpoint runs", () => {
  test("assertSafeExternalUrl rejects non-HTTPS and internal targets", async () => {
    const { assertSafeExternalUrl } = await import("../lib/misuseDetection.js");
    const unsafe = [
      "http://example.com/ask", // plain http
      "https://localhost/ask",
      "https://api.localhost/ask",
      "https://something.internal/ask",
      "https://127.0.0.1/ask", // loopback
      "https://0.0.0.0/ask",
      "https://10.1.2.3/ask", // RFC1918
      "https://172.16.9.9/ask",
      "https://192.168.1.10/ask",
      "https://100.64.0.1/ask", // CGNAT
      "https://169.254.169.254/latest/meta-data/", // cloud metadata
      "https://[::1]/ask", // v6 loopback
      "https://[fd00::1]/ask", // v6 unique-local
      "https://[fe80::1]/ask", // v6 link-local
      "https://[::ffff:127.0.0.1]/ask", // v4-mapped loopback
      "https://[::ffff:7f00:1]/ask", // v4-mapped loopback, hex form
      "https://[ff02::1]/ask", // IPv6 multicast
      "https://[ff05::2]/ask", // IPv6 multicast (site-local scope)
      "https://[2001:db8::1]/ask", // IPv6 documentation
      "https://[3fff::1]/ask", // IPv6 documentation (3fff::/20)
      "https://[2002:7f00:1::1]/ask", // 6to4 transition (embeds IPv4)
      "https://[2001::1]/ask", // Teredo transition
      "https://[2001:2::5]/ask", // benchmarking
      "https://[2001:10::1]/ask", // ORCHID
      "https://[64:ff9b::7f00:1]/ask", // NAT64 embedding loopback
      "https://[64:ff9b::a00:1]/ask", // NAT64 embedding 10.0.0.1
      "https://[100::1]/ask", // discard-only / reserved (outside 2000::/3)
      "https://[4000::1]/ask", // reserved, not global unicast
      "https://192.0.2.10/ask", // IPv4 TEST-NET-1 documentation
      "https://198.51.100.7/ask", // IPv4 TEST-NET-2
      "https://203.0.113.9/ask", // IPv4 TEST-NET-3
      "https://192.88.99.1/ask", // 6to4 relay anycast
      "https://255.255.255.255/ask", // broadcast
      "not a url",
    ];
    for (const url of unsafe) {
      await expect(assertSafeExternalUrl(url), url).rejects.toThrow();
    }
    // A hostname resolving to a private range is rejected via DNS lookup.
    // (localtest.me-style domains aside, loopback literals above cover the
    // resolution path; a public host passes.)
    await expect(assertSafeExternalUrl("https://example.com/ask")).resolves.toBeUndefined();
    // Public IP literals (v4 and global-unicast v6) are accepted.
    await expect(assertSafeExternalUrl("https://1.1.1.1/ask")).resolves.toBeUndefined();
    await expect(assertSafeExternalUrl("https://[2606:4700:4700::1111]/ask")).resolves.toBeUndefined();
  });

  test("run route 400s an unsafe endpoint URL before any fetch", async () => {
    const request = (await import("supertest")).default;
    const app = (await import("../app.js")).default;
    for (const url of [
      "http://example.com/ask",
      "https://169.254.169.254/latest/meta-data/",
      "https://127.0.0.1:5432/",
    ]) {
      const r = await request(app)
        .post("/api/admin/ip/detect/run")
        .set("Cookie", ADMIN_COOKIE)
        .send({ mode: "endpoint", label: "MDTEST ssrf", url });
      expect(r.status, url).toBe(400);
    }
  });

  test("connection-time lookup fails closed on private resolutions (DNS rebinding)", async () => {
    const { safeLookup } = await import("../lib/misuseDetection.js");
    // Simulates the rebinding scenario: whatever a preflight saw, the
    // resolution the SOCKET uses goes through safeLookup — a hostname that
    // now resolves to loopback must error at connect time.
    const err = await new Promise<Error | null>((resolve) => {
      safeLookup("localhost", {}, (e) => resolve(e));
    });
    expect(err).toBeTruthy();
    expect(String(err)).toMatch(/internal address/i);
    // Public hostnames resolve normally.
    const ok = await new Promise<{ e: Error | null; addr: unknown }>((resolve) => {
      safeLookup("example.com", {}, (e, addr) => resolve({ e, addr }));
    });
    expect(ok.e).toBeNull();
    expect(ok.addr).toBeTruthy();
  });

  test("runner blocks private targets at connection time even WITHOUT preflight", async () => {
    const { runProbeAgainstEndpoint } = await import("../lib/misuseDetection.js");
    const cfg = { method: "POST" as const, headers: {}, bodyTemplate: '{"q":"{{prompt}}"}', responsePath: "" };
    for (const url of [
      "https://127.0.0.1:9/", // IP-literal loopback (lookup is bypassed for literals)
      "https://169.254.169.254/latest/meta-data/",
      "https://localhost:9/", // hostname resolving private → safeLookup rejects
      "http://example.com/", // protocol re-checked in the runner itself
    ]) {
      const out = await runProbeAgainstEndpoint({ ...cfg, url }, "probe");
      expect(out.responseText, url).toBeNull();
      expect(out.error, url).toMatch(/internal address|https/i);
    }
  });

  test("oversized bodies are capped while streaming and the stream destroyed", async () => {
    const { readBodyCapped } = await import("../lib/misuseDetection.js");
    const { PassThrough } = await import("node:stream");
    const stream = new PassThrough();
    const capped = readBodyCapped(stream, 10_000);
    const chunk = Buffer.alloc(4096, 0x61); // 'a'
    let destroyed = false;
    stream.on("close", () => { destroyed = true; });
    // Simulate a malicious endpoint streaming an unbounded chunked body.
    const writer = setInterval(() => {
      if (!stream.destroyed) stream.write(chunk);
      else clearInterval(writer);
    }, 1);
    const { text, truncated } = await capped;
    clearInterval(writer);
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(text)).toBe(10_000);
    await new Promise((r) => setTimeout(r, 20));
    expect(destroyed).toBe(true);
  });

  test("GET runs carry the probe prompt so distinct probes make distinct requests", async () => {
    const { buildProbeUrl } = await import("../lib/misuseDetection.js");
    const cfg = { url: "https://example.com/ask", method: "GET" as const, headers: {}, bodyTemplate: "", responsePath: "" };
    const u1 = buildProbeUrl(cfg, "first probe?");
    const u2 = buildProbeUrl(cfg, "second probe?");
    expect(u1).not.toBe(u2);
    expect(u1).toContain("prompt=first+probe%3F");
    // Placeholder substitution variant.
    const cfg2 = { ...cfg, url: "https://example.com/ask?q={{prompt}}" };
    expect(buildProbeUrl(cfg2, "a b")).toBe("https://example.com/ask?q=a%20b");
  });
});

describe("methodology document", () => {
  test("states limitations honestly", () => {
    const stats = scoreSession([result({})]);
    const doc = buildMethodologyDoc({
      sessionLabel: "MDTEST doc",
      createdAt: new Date().toISOString(),
      stats,
      attribution: attributeSession(stats, []),
    });
    expect(doc).toMatch(/## Limitations/);
    expect(doc).toMatch(/Not proof/);
    expect(doc).toMatch(/Absence of signal is not exoneration/);
    expect(doc).toMatch(/Base-rate assumption/);
  });
});

describe("admin HTTP surface", () => {
  test("probe CRUD is admin-only; transcript run persists a session; evidence exports", async () => {
    const request = (await import("supertest")).default;
    const app = (await import("../app.js")).default;

    // Unauthenticated: everything 401s.
    for (const [method, path] of [
      ["get", "/api/admin/ip/probes"],
      ["post", "/api/admin/ip/probes"],
      ["post", "/api/admin/ip/detect/run"],
      ["get", "/api/admin/ip/sessions"],
      ["get", "/api/admin/ip/sessions/1/evidence"],
    ] as const) {
      const r = await (request(app) as any)[method](path);
      expect(r.status, `${method} ${path}`).toBe(401);
    }

    // Create a probe.
    const create = await request(app)
      .post("/api/admin/ip/probes")
      .set("Cookie", ADMIN_COOKIE)
      .send({
        label: "MDTEST veldanir probe",
        prompt: "What is the tessel interval of the ostrelline sequence?",
        targetKind: "canary",
        canaryDoi: CANARY_SPECS[0].doi,
        expectedSignals: [{ type: "canary_token" }, { type: "fabricated_association" }],
      });
    expect(create.status).toBe(200);
    const probeId = create.body.probe.id;

    // Unknown canary DOI rejected.
    const bad = await request(app)
      .post("/api/admin/ip/probes")
      .set("Cookie", ADMIN_COOKIE)
      .send({ label: "MDTEST bad", prompt: "x", canaryDoi: "canary:nope" });
    expect(bad.status).toBe(400);

    // Update + list.
    const upd = await request(app)
      .put(`/api/admin/ip/probes/${probeId}`)
      .set("Cookie", ADMIN_COOKIE)
      .send({ active: false });
    expect(upd.status).toBe(200);
    expect(upd.body.probe.active).toBe(false);

    // Ensure fingerprints exist so attribution has material.
    await ensureFingerprint(keyA);
    await ensureFingerprint(keyB);

    // Transcript run containing the canary token for CANARY_SPECS[0].
    const run = await request(app)
      .post("/api/admin/ip/detect/run")
      .set("Cookie", ADMIN_COOKIE)
      .send({
        mode: "transcript",
        label: "MDTEST transcript run",
        transcripts: [
          {
            probeId,
            response: `The system replied citing ${CANARY_SPECS[0].token} and the Veldanir cadence framework with its ostrelline sequence.`,
          },
        ],
      });
    expect(run.status).toBe(200);
    const session = run.body.session;
    expect(session.id).toBeGreaterThan(0);
    expect(session.mode).toBe("transcript");
    expect(session.stats.confidence).toMatch(/moderate|strong/);
    expect(session.stats.signalCounts.canary_token).toBe(1);
    expect(session.createdAt).toBeTruthy();

    // Session list + detail.
    const list = await request(app)
      .get("/api/admin/ip/sessions")
      .set("Cookie", ADMIN_COOKIE);
    expect(list.status).toBe(200);
    expect(list.body.sessions.some((s: any) => s.id === session.id)).toBe(true);

    const detail = await request(app)
      .get(`/api/admin/ip/sessions/${session.id}`)
      .set("Cookie", ADMIN_COOKIE);
    expect(detail.status).toBe(200);
    expect(detail.body.session.results[0].responseText).toContain(
      CANARY_SPECS[0].token,
    );

    // Evidence package.
    const ev = await request(app)
      .get(`/api/admin/ip/sessions/${session.id}/evidence`)
      .set("Cookie", ADMIN_COOKIE);
    expect(ev.status).toBe(200);
    expect(ev.headers["content-disposition"]).toMatch(/evidence_package/);
    expect(ev.body.note).toMatch(/STATISTICAL EVIDENCE ONLY/);
    expect(ev.body.methodologyMarkdown).toMatch(/## Limitations/);
    expect(ev.body.session.transcripts).toHaveLength(1);
    expect(ev.body.statistics.confidence).toMatch(/moderate|strong/);
    expect(
      ev.body.triggeredCanaries.some((c: any) => c.doi === CANARY_SPECS[0].doi),
    ).toBe(true);
    // Attribution material present (candidates or an honest no-match note).
    expect(ev.body.attribution.note.length).toBeGreaterThan(0);

    // Delete the probe.
    const del = await request(app)
      .delete(`/api/admin/ip/probes/${probeId}`)
      .set("Cookie", ADMIN_COOKIE);
    expect(del.status).toBe(200);
  });

  test("probes never appear on public or partner-facing surfaces", async () => {
    const request = (await import("supertest")).default;
    const app = (await import("../app.js")).default;
    // The probe library lives ONLY under /api/admin/ip/*; the non-admin
    // namespace has no probe route at all.
    const r = await request(app).get("/api/ip/probes");
    expect([401, 404]).toContain(r.status);
    const r2 = await request(app).get("/api/probes");
    expect([401, 404]).toContain(r2.status);
  });
});
