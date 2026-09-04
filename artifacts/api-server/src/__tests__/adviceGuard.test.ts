import { beforeAll, describe, test, expect, vi } from "vitest";

vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-advice-guard-secret";
});

import type { Express } from "express";
import request from "supertest";
import { createHmac } from "crypto";
import pool from "../lib/db.js";
import {
  DEFAULT_ADVICE_TERMS,
  buildTermRegex,
  scanAnswerForAdvice,
  type AdviceTerm,
} from "../lib/adviceGuard.js";

let app: Express;

function signCookie(val: string, secret: string): string {
  const hash = createHmac("sha256", secret)
    .update(val)
    .digest("base64")
    .replace(/=+$/, "");
  return val + "." + hash;
}
const ADMIN_COOKIE = `palonur_admin=${encodeURIComponent(
  "s:" + signCookie("1", process.env.SESSION_SECRET as string),
)}`;

const stamp = Date.now().toString(36);

// Tests import app.ts, not index.ts, so boot-time DDL never runs — provision
// the advice_guard_terms table (and make sure agent_queries exists) here.
async function ensureAdviceSchema(): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS advice_guard_terms (
    id serial PRIMARY KEY,
    category text NOT NULL,
    phrase text NOT NULL,
    added_by text NOT NULL DEFAULT 'admin',
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS advice_guard_terms_category_phrase_idx
       ON advice_guard_terms (category, lower(phrase))`,
  );
}

function termsOf(
  pairs: Array<{ category: AdviceTerm["category"]; phrase: string }>,
): AdviceTerm[] {
  return pairs.map((p, i) => ({
    id: i + 1,
    category: p.category,
    phrase: p.phrase,
    addedBy: "test",
  }));
}

const DEFAULTS: AdviceTerm[] = DEFAULT_ADVICE_TERMS.map((t, i) => ({
  id: i + 1,
  category: t.category,
  phrase: t.phrase,
  addedBy: "seed",
}));

beforeAll(async () => {
  await ensureAdviceSchema();
  const mod = await import("../app.js");
  app = mod.default;
});

describe("scanAnswerForAdvice (unit)", () => {
  test("flags diagnosis language with category + excerpt", () => {
    const hits = scanAnswerForAdvice(
      "ANSWER: Based on what you describe, it sounds like you have insomnia and should track your sleep.",
      DEFAULTS,
    );
    const cats = hits.map((h) => h.category);
    expect(cats).toContain("diagnosis");
    const diag = hits.find((h) => h.category === "diagnosis")!;
    expect(diag.excerpt.toLowerCase()).toContain("you have insomnia");
  });

  test("flags dosing language (mg) but never inside a longer word", () => {
    expect(
      scanAnswerForAdvice("Take 3 mg of melatonin before bed.", DEFAULTS).some(
        (h) => h.category === "dosage",
      ),
    ).toBe(true);
    // "mg" must not match inside "might"; "dose" not inside "doses of light" — wait,
    // "doses" is a different word so the boundary must hold for the exact phrase.
    expect(
      scanAnswerForAdvice(
        "You might find that morning light helps.",
        termsOf([{ category: "dosage", phrase: "mg" }]),
      ),
    ).toHaveLength(0);
  });

  test("flags treatment directives", () => {
    const hits = scanAnswerForAdvice(
      "You should take melatonin every night to fix this.",
      DEFAULTS,
    );
    expect(hits.some((h) => h.category === "treatment")).toBe(true);
  });

  test("never flags REFUSE / UNCOVERED refusals or empty answers", () => {
    expect(
      scanAnswerForAdvice("REFUSE: I can only answer questions about sleep.", DEFAULTS),
    ).toHaveLength(0);
    expect(
      scanAnswerForAdvice(
        "UNCOVERED: The corpus does not cover melatonin dose questions (mg).",
        DEFAULTS,
      ),
    ).toHaveLength(0);
    expect(scanAnswerForAdvice("", DEFAULTS)).toHaveLength(0);
  });

  test("matching is case-insensitive and whitespace-flexible", () => {
    const t = termsOf([{ category: "treatment", phrase: "you should take" }]);
    expect(scanAnswerForAdvice("YOU  SHOULD\nTAKE this seriously.", t)).toHaveLength(1);
  });

  test("clean lifestyle answer produces no hits", () => {
    expect(
      scanAnswerForAdvice(
        "ANSWER: Keeping a consistent bedtime and getting morning light are the strongest levers for circadian alignment.",
        DEFAULTS,
      ),
    ).toHaveLength(0);
  });

  test("buildTermRegex enforces word boundaries around alphanumerics", () => {
    expect(buildTermRegex("dose").test("a low-dose approach")).toBe(true);
    expect(buildTermRegex("dose").test("doses")).toBe(false);
    expect(buildTermRegex("mg").test("300mg")).toBe(false); // digit-adjacent: still "300 mg" in practice
    expect(buildTermRegex("mg").test("0.5 mg nightly")).toBe(true);
  });
});

describe("advice admin routes", () => {
  test("all endpoints require the palonur_admin cookie", async () => {
    for (const [method, path] of [
      ["get", "/api/admin/advice-review"],
      ["get", "/api/admin/advice-terms"],
      ["post", "/api/admin/advice-terms"],
      ["delete", "/api/admin/advice-terms/1"],
    ] as const) {
      const res = await (request(app) as any)[method](path);
      expect(res.status).toBe(401);
    }
  });

  test("terms are seeded when empty and listable", async () => {
    const res = await request(app)
      .get("/api/admin/advice-terms")
      .set("Cookie", ADMIN_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.terms.length).toBeGreaterThan(0);
    const cats = new Set(res.body.terms.map((t: any) => t.category));
    expect(cats.has("diagnosis")).toBe(true);
    expect(cats.has("dosage")).toBe(true);
    expect(cats.has("treatment")).toBe(true);
  });

  test("add + duplicate + delete a boundary term", async () => {
    const phrase = `magic sleep tonic ${stamp}`;
    const created = await request(app)
      .post("/api/admin/advice-terms")
      .set("Cookie", ADMIN_COOKIE)
      .send({ category: "treatment", phrase });
    expect(created.status).toBe(201);
    const id = created.body.term.id;

    const dup = await request(app)
      .post("/api/admin/advice-terms")
      .set("Cookie", ADMIN_COOKIE)
      .send({ category: "treatment", phrase: phrase.toUpperCase() });
    expect(dup.status).toBe(200);
    expect(dup.body.alreadyExists).toBe(true);

    const bad = await request(app)
      .post("/api/admin/advice-terms")
      .set("Cookie", ADMIN_COOKIE)
      .send({ category: "nonsense", phrase: "x y z" });
    expect(bad.status).toBe(400);

    const del = await request(app)
      .delete(`/api/admin/advice-terms/${id}`)
      .set("Cookie", ADMIN_COOKIE);
    expect(del.status).toBe(200);

    const again = await request(app)
      .delete(`/api/admin/advice-terms/${id}`)
      .set("Cookie", ADMIN_COOKIE);
    expect(again.status).toBe(404);
  });

  test("advice-review flags a stored agent answer and honors term edits instantly", async () => {
    const marker = `zz-advice-${stamp}`;
    await pool.query(
      `INSERT INTO agent_queries (session_id, question, answer_text, source)
       VALUES ($1, $2, $3, 'sleep-agent')`,
      [
        `test-${stamp}`,
        `is melatonin safe? ${marker}`,
        `ANSWER: For your situation the ${marker} evidence suggests you should take 3 mg of melatonin nightly.`,
      ],
    );

    const res = await request(app)
      .get("/api/admin/advice-review?days=1")
      .set("Cookie", ADMIN_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.scanned).toBeGreaterThan(0);
    const row = res.body.flagged.find((f: any) => f.question.includes(marker));
    expect(row).toBeTruthy();
    const cats = new Set(row.hits.map((h: any) => h.category));
    expect(cats.has("dosage")).toBe(true);
    expect(cats.has("treatment")).toBe(true);
    expect(res.body.countsByCategory.dosage).toBeGreaterThan(0);

    // Adjust the boundary: add a custom phrase and confirm the SAME past
    // answer is re-classified on the next read — no reprocessing step.
    const phrase = marker; // matches the stored answer text
    const created = await request(app)
      .post("/api/admin/advice-terms")
      .set("Cookie", ADMIN_COOKIE)
      .send({ category: "diagnosis", phrase });
    expect(created.status).toBe(201);
    try {
      const res2 = await request(app)
        .get("/api/admin/advice-review?days=1")
        .set("Cookie", ADMIN_COOKIE);
      const row2 = res2.body.flagged.find((f: any) => f.question.includes(marker));
      expect(row2.hits.some((h: any) => h.phrase === phrase && h.category === "diagnosis")).toBe(true);
    } finally {
      await request(app)
        .delete(`/api/admin/advice-terms/${created.body.term.id}`)
        .set("Cookie", ADMIN_COOKIE);
      await pool.query(`DELETE FROM agent_queries WHERE session_id = $1`, [
        `test-${stamp}`,
      ]);
    }
  });
});
