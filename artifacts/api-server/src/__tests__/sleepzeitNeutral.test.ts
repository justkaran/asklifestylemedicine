import { beforeAll, afterAll, describe, test, expect, vi } from "vitest";
import {
  ensureCaptureLoopSchema,
  parseSseEvents,
  makeTopicEmbedding,
} from "./testHelpers.js";

// Set env BEFORE the route/lib modules load — they read these once at
// module-init time. `vi.hoisted` is the only way to win the import race.
vi.hoisted(() => {
  process.env.USE_GOVERNED_RAG = "true";
  process.env.RESEND_API_KEY = "stub-key";
});

// ─── Mocks (must be declared before importing the app) ─────────────────

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: async () => ({ id: "stub-id" }) };
  },
}));

// Stream a fully-structured ANSWER block so the covered-path
// post-processing (provenance shipping) runs, not the refusal branch.
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      stream: () => {
        const text = [
          "ANSWER:",
          "Dim evening light suppresses melatonin and shifts your clock later.",
          "",
          "CITATION:",
          "Zeitzer et al., 2000, J Physiol",
          "",
          "PAPER:",
          '"Sensitivity of the human circadian pacemaker to nocturnal light"',
          "",
          "FINDING:",
          "Even ~100 lux at night significantly suppresses melatonin.",
          "",
          "INTERPRETATION:",
          "Keep evenings dim if you want to fall asleep on time.",
          "",
          "ACTION:",
          "Dim household lights two hours before bed tonight.",
        ].join("\n");
        async function* gen() {
          for (const piece of text.match(/[\s\S]{1,40}/g) ?? []) {
            yield {
              type: "content_block_delta",
              delta: { type: "text_delta", text: piece },
            };
          }
        }
        return gen();
      },
    };
  }
  return { default: FakeAnthropic };
});

// Deterministic embeddings so the seeded chunks land on the same axis as
// the test question — guaranteed to clear RAG_MIN_SCORE without network.
vi.mock("../lib/embeddings.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/embeddings.js")>(
      "../lib/embeddings.js",
    );
  return {
    ...actual,
    embedTexts: vi.fn(async (texts: string[]) => texts.map(makeTopicEmbedding)),
  };
});

// Pin the agent to the seeded test pillar so existing dev DB pillars
// don't intercept routing.
const seededPillarRef: { id: number; slug: string; name: string } = {
  id: 0,
  slug: "",
  name: "",
};
vi.mock("../lib/pillarRouter.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/pillarRouter.js")>(
      "../lib/pillarRouter.js",
    );
  return {
    ...actual,
    routePillars: vi.fn(async () => ({
      pillars: [
        {
          id: seededPillarRef.id,
          slug: seededPillarRef.slug,
          name: seededPillarRef.name,
        },
      ],
      matchedKeywords: [],
    })),
  };
});

// ─── Imports that depend on the mocks above ────────────────────────────

import type { Express } from "express";
import request from "supertest";
import pool from "../lib/db.js";
import { EMBEDDING_MODEL, toVectorLiteral } from "../lib/embeddings.js";
import { clearEmbeddingCache } from "../lib/rag.js";
import {
  normalizeRubric,
  type ReliabilityRubric,
} from "@workspace/db/source-rigor";
import {
  ZEITZER_CORPUS,
  SYSTEM_PROMPT,
  NEUTRAL_CORPUS,
  NEUTRAL_SYSTEM_PROMPT,
  buildNeutralGovernedSystemPrompt,
} from "../routes/sleep-agent.js";

// ─── Part 1: pure prompt/corpus scrubbing (no DB) ──────────────────────

// Brand / person identifiers that must NEVER appear in the neutral pilot.
// NOTE (Option 1, founder decision): published author *surnames* in CITATION
// lines are KEPT — "Zeitzer et al., 2014" is a legitimate scientific citation
// and the trust anchor for a brand-neutral reader. So we assert the brand and
// institution tokens are gone, NOT the citation surname.
const FORBIDDEN: Array<[string, RegExp]> = [
  ["Stanford", /stanford/i],
  ["Palonur", /palonur/i],
  ["Jamie", /\bjamie\b/i],
  ["Lifestyle Medicine", /lifestyle medicine/i],
];

function assertBrandClean(label: string, text: string) {
  for (const [name, re] of FORBIDDEN) {
    expect(re.test(text), `${label} must not contain "${name}"`).toBe(false);
  }
}

const NEUTRAL_REFUSE =
  "REFUSE: This assistant only answers questions about sleep and circadian science.";
const NEUTRAL_UNCOVERED =
  "UNCOVERED: I don't have research I can cite for that yet. You can ask a narrower question or try a related sleep topic.";

describe("SleepZeit neutral mode — prompt/corpus scrubbing", () => {
  test("NEUTRAL_CORPUS strips all brand/institution framing", () => {
    assertBrandClean("NEUTRAL_CORPUS", NEUTRAL_CORPUS);
  });

  test("NEUTRAL_CORPUS keeps published author surnames (Option 1)", () => {
    // The corpus is the citation backbone — surnames stay so the agent can
    // still emit verifiable "Zeitzer et al." citations.
    expect(NEUTRAL_CORPUS).toMatch(/Zeitzer/);
  });

  test("NEUTRAL_SYSTEM_PROMPT (legacy path) is brand-clean with neutral refusals", () => {
    assertBrandClean("NEUTRAL_SYSTEM_PROMPT", NEUTRAL_SYSTEM_PROMPT);
    expect(NEUTRAL_SYSTEM_PROMPT).toContain(NEUTRAL_REFUSE);
    expect(NEUTRAL_SYSTEM_PROMPT).toContain(NEUTRAL_UNCOVERED);
  });

  test("neutral governed prompt is brand-clean and drops advisor/pillar scope", () => {
    const prompt = buildNeutralGovernedSystemPrompt(
      "[source_id=1] Example approved source excerpt.",
    );
    assertBrandClean("buildNeutralGovernedSystemPrompt", prompt);
    // The advisor-lens section and pillar-scope framing are removed in neutral.
    expect(prompt).not.toContain("ADVISOR_NOTE");
    expect(prompt).not.toContain("ADVISOR LENS");
    expect(prompt).toContain(NEUTRAL_REFUSE);
    expect(prompt).toContain(NEUTRAL_UNCOVERED);
  });

  // ── Regression guard: legacy fallback must never mandate a hardcoded citation ──
  //
  // ZEITZER_CORPUS and SYSTEM_PROMPT are injected verbatim into the model prompt
  // on the legacy (non-governed) path. If either were edited to mandate a specific
  // author citation string such as "Source: Zeitzer et al." the model would repeat
  // that phrase in every answer — including neutral-brand answers where it must not
  // appear. These static assertions catch that regression at CI time, before any
  // model call is made.
  test("ZEITZER_CORPUS does not mandate a hardcoded author citation string", () => {
    // The exact pattern that has appeared before and must never return.
    expect(ZEITZER_CORPUS).not.toContain("Source: Zeitzer et al.");
    // Guard against variants that instruct the model to always prepend a fixed name.
    expect(ZEITZER_CORPUS).not.toMatch(/always (cite|credit|say|use) "?Source:/i);
    expect(ZEITZER_CORPUS).not.toMatch(/mandatory citation.*Zeitzer/i);
  });

  test("SYSTEM_PROMPT does not mandate a hardcoded author citation string", () => {
    // The exact pattern that has appeared before and must never return.
    expect(SYSTEM_PROMPT).not.toContain("Source: Zeitzer et al.");
    // Guard against variants that instruct the model to always prepend a fixed name.
    expect(SYSTEM_PROMPT).not.toMatch(/always (cite|credit|say|use) "?Source:/i);
    expect(SYSTEM_PROMPT).not.toMatch(/mandatory citation.*Zeitzer/i);
  });
});

// ─── Part 2: response scrubbing end-to-end (DB-backed) ─────────────────

let app: Express;
let pillarId = 0;
let sourceId = 0;
let interpretationId = 0;
let stewardUserId = 0;
const pillarName = "Neutral Pilot Pillar";
const pillarSlug = `neutral-test-${Date.now()}`;
// A clearly identifiable steward name — it must NEVER reach a neutral reader.
const stewardName = "Dr Evelyn Nightingale";
const stewardEmail = `neutral-steward-${Date.now()}@test.local`;
const sourceTitle =
  "Sensitivity of the human circadian pacemaker to nocturnal light";
const question = "Does evening light shift the circadian clock?";

// Rubric rationales deliberately name an institution + a person that the
// token-scrub list does NOT know about — so the only safe behavior for a
// neutral reader is to drop every rationale, not regex a fixed allowlist.
const RATIONALE_LAB = "Karolinska Institutet sleep lab";
const RATIONALE_PERSON = "Dr Søren Halvorsen";
const ASSESSMENT_RUBRIC: ReliabilityRubric = normalizeRubric({
  rigor: {
    items: [
      {
        id: "sample_power",
        answer: "yes",
        rationale: `n=200 cohort run at the ${RATIONALE_LAB} by ${RATIONALE_PERSON}`,
      },
      { id: "bias_control", answer: "no", rationale: "no blinding reported" },
    ],
  },
  reproducibility: {
    items: [
      {
        id: "data_available",
        answer: "yes",
        rationale: `raw data shared on OSF by ${RATIONALE_PERSON}`,
      },
    ],
  },
  openness: {
    items: [
      { id: "open_access", answer: "partial", rationale: "green OA via PMC" },
    ],
  },
});

beforeAll(async () => {
  await ensureCaptureLoopSchema();

  const { rows: pillarRows } = await pool.query<{ id: number }>(
    `INSERT INTO pillars (slug, name) VALUES ($1, $2) RETURNING id`,
    [pillarSlug, pillarName],
  );
  pillarId = pillarRows[0].id;
  seededPillarRef.id = pillarId;
  seededPillarRef.slug = pillarSlug;
  seededPillarRef.name = pillarName;

  const { rows: userRows } = await pool.query<{ id: number }>(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [`neutral-clerk-${Date.now()}`, stewardEmail, stewardName],
  );
  stewardUserId = userRows[0].id;

  await pool.query(
    `INSERT INTO faculty_memberships (user_id, pillar_id, role)
     VALUES ($1, $2, 'steward')`,
    [stewardUserId, pillarId],
  );

  const { rows: sourceRows } = await pool.query<{ id: number }>(
    `INSERT INTO sources
        (pillar_id, kind, title, authors, year, journal, doi,
         abstract, source_url, status, uploaded_by_user_id)
       VALUES ($1, 'paper', $2, 'Zeitzer JM et al.', 2000, 'J Physiol',
               '10.1111/neutral-test', 'Stub abstract on melatonin.',
               'https://example.test/circadian-light',
               'approved', $3)
       RETURNING id`,
    [pillarId, sourceTitle, stewardUserId],
  );
  sourceId = sourceRows[0].id;

  // Approve a reliability assessment whose rationales NAME an institution and
  // a person that are NOT in the token-scrub list — proving neutral mode drops
  // rationales entirely rather than relying on a fixed name allowlist. Known
  // scores: rigor yes(1)+no(0)/2 = 50; reproducibility yes(1)/1 = 100;
  // openness partial(0.5)/1 = 50.
  await pool.query(
    `UPDATE sources
        SET assessment_status = 'approved', assessment_rubric = $2::jsonb
      WHERE id = $1`,
    [sourceId, JSON.stringify(ASSESSMENT_RUBRIC)],
  );

  const sourceChunkText =
    "Even very dim ordinary room light at night significantly suppresses melatonin and shifts the human circadian clock.";
  await pool.query(
    `INSERT INTO source_chunks
       (source_id, chunk_index, text, embedding, embedding_model)
      VALUES ($1, 0, $2, $3::halfvec(384), $4)`,
    [
      sourceId,
      sourceChunkText,
      toVectorLiteral(makeTopicEmbedding(sourceChunkText)),
      EMBEDDING_MODEL,
    ],
  );

  const { rows: interpRows } = await pool.query<{ id: number }>(
    `INSERT INTO interpretations
        (source_id, pillar_id, author_id, status, answer, interpretation,
         action, approver_id, approved_at)
       VALUES ($1, $2, $3, 'approved',
               'Dim evening light suppresses melatonin.',
               'Keep evenings dim to protect your circadian clock.',
               'Per the Stanford lab and Jamie, dim household lights two hours before bed.',
               $3, NOW())
       RETURNING id`,
    [sourceId, pillarId, stewardUserId],
  );
  interpretationId = interpRows[0].id;

  const interpChunkText =
    "Faculty take from the Stanford lab: dim evening light protects melatonin and your circadian rhythm — dim the lights two hours before bed.";
  await pool.query(
    `INSERT INTO interpretation_chunks
        (interpretation_id, source_id, pillar_id, chunk_index, text,
         embedding, embedding_model, priority)
        VALUES ($1, $2, $3, 0, $4, $5::halfvec(384), $6, 100)`,
    [
      interpretationId,
      sourceId,
      pillarId,
      interpChunkText,
      toVectorLiteral(makeTopicEmbedding(interpChunkText)),
      EMBEDDING_MODEL,
    ],
  );

  clearEmbeddingCache();
  app = (await import("../app.js")).default;
});

afterAll(async () => {
  if (pillarId) {
    await pool.query(`DELETE FROM agent_queries WHERE $1 = ANY(pillar_ids)`, [
      pillarId,
    ]);
    await pool.query(`DELETE FROM query_clusters WHERE pillar_id = $1`, [pillarId]);
    await pool.query(`DELETE FROM interpretation_chunks WHERE pillar_id = $1`, [
      pillarId,
    ]);
    await pool.query(`DELETE FROM interpretations WHERE pillar_id = $1`, [pillarId]);
    await pool.query(
      `DELETE FROM source_chunks WHERE source_id IN
         (SELECT id FROM sources WHERE pillar_id = $1)`,
      [pillarId],
    );
    await pool.query(`DELETE FROM sources WHERE pillar_id = $1`, [pillarId]);
    await pool.query(`DELETE FROM faculty_memberships WHERE pillar_id = $1`, [
      pillarId,
    ]);
    await pool.query(`DELETE FROM pillars WHERE id = $1`, [pillarId]);
  }
  if (stewardUserId) {
    await pool.query(`DELETE FROM faculty_users WHERE id = $1`, [stewardUserId]);
  }
  await pool.end();
});

type DoneProvenance = {
  source_id: number;
  interpretation_id: number | null;
  interpretation_author: string | null;
  interpretation_note: string | null;
  authors: string | null;
  reliability: {
    axes: Array<{
      key: string;
      label: string;
      score: number | null;
      assessed: number;
      total: number;
      band: string;
    }>;
    rubric: ReliabilityRubric;
  } | null;
};

async function postAnswer(brand?: string) {
  const res = await request
    .agent(app)
    .post("/api/sleep-agent")
    .send(brand ? { message: question, brand } : { message: question })
    .set("Sec-Fetch-Site", "same-origin")
    .set("Accept", "text/event-stream");
  expect(res.status).toBe(200);
  const events = parseSseEvents(res.text);
  const done = events.find((e) => e.done === true);
  expect(done, `sleep-agent SSE terminated without done: ${res.text}`).toBeDefined();
  return done!;
}

describe("SleepZeit neutral mode — response scrubbing", () => {
  test("branded request exposes steward author and pillar without raw chunks", async () => {
    const done = await postAnswer();
    const provenance = (done.provenance ?? []) as DoneProvenance[];
    const cited = provenance.find((p) => p.source_id === sourceId);
    expect(cited).toBeDefined();
    // Branded path keeps the steward name and routed pillar.
    expect(cited!.interpretation_author).toBe(stewardName);
    expect(done.pillarNames).toEqual([pillarName]);
    // Published citation authors are always present (trust anchor).
    expect(cited!.authors).toBe("Zeitzer JM et al.");
    // The public event still includes answer/citation metadata and never the
    // retrieved source chunks.
    expect(/stanford/i.test(JSON.stringify(done))).toBe(true);
    expect(JSON.stringify(done.provenance)).not.toContain("excerpts");
  });

  test('brand:"neutral" scrubs every steward-text field + empties pillarNames', async () => {
    const done = await postAnswer("neutral");
    const provenance = (done.provenance ?? []) as DoneProvenance[];
    const cited = provenance.find((p) => p.source_id === sourceId);
    expect(cited).toBeDefined();
    // The steward's identity is scrubbed…
    expect(cited!.interpretation_author).toBeNull();
    expect(done.pillarNames).toEqual([]);
    // …interpretation content survives (minus brand tokens)…
    expect(cited!.interpretation_note).toMatch(/dim evening light/i);
    // …and published citation authors stay (trust anchor).
    expect(cited!.authors).toBe("Zeitzer JM et al.");
    // The ENTIRE serialized neutral done event is brand-clean.
    assertBrandClean("neutral done event", JSON.stringify(done));
    expect(JSON.stringify(done)).not.toContain(stewardName);
  });

  test("branded done event keeps the reliability rationales naming a lab/person (control)", async () => {
    const done = await postAnswer();
    const provenance = (done.provenance ?? []) as DoneProvenance[];
    const cited = provenance.find((p) => p.source_id === sourceId);
    expect(cited).toBeDefined();
    const reliability = cited!.reliability;
    expect(reliability).not.toBeNull();
    // Axis scores are present on the branded surface.
    const byKey = Object.fromEntries(
      reliability!.axes.map((a) => [a.key, a.score]),
    );
    expect(byKey.rigor).toBe(50);
    expect(byKey.reproducibility).toBe(100);
    expect(byKey.openness).toBe(50);
    // The steward-authored rationales — including the lab + person names —
    // survive on the branded path.
    const rationales = Object.values(reliability!.rubric)
      .flatMap((axis) => axis.items.map((i) => i.rationale))
      .join(" ");
    expect(rationales).toContain(RATIONALE_LAB);
    expect(rationales).toContain(RATIONALE_PERSON);
  });

  test('brand:"neutral" done event drops every reliability rationale but keeps scores + answers', async () => {
    const done = await postAnswer("neutral");
    const provenance = (done.provenance ?? []) as DoneProvenance[];
    const cited = provenance.find((p) => p.source_id === sourceId);
    expect(cited).toBeDefined();
    const reliability = cited!.reliability;
    expect(reliability).not.toBeNull();
    // Axis scores survive (they carry no identity)…
    const byKey = Object.fromEntries(
      reliability!.axes.map((a) => [a.key, a.score]),
    );
    expect(byKey.rigor).toBe(50);
    expect(byKey.reproducibility).toBe(100);
    expect(byKey.openness).toBe(50);
    // …the yes/partial/no answers survive…
    const answers = Object.values(reliability!.rubric)
      .flatMap((axis) => axis.items.map((i) => i.answer))
      .filter((a) => a !== "unclear");
    expect(answers).toContain("yes");
    expect(answers).toContain("no");
    expect(answers).toContain("partial");
    // …but EVERY rationale is dropped to an empty string.
    const rationales = Object.values(reliability!.rubric).flatMap((axis) =>
      axis.items.map((i) => i.rationale),
    );
    expect(rationales.every((r) => r === "")).toBe(true);
    // The lab + person names — which the token-scrub list never knew about —
    // are nowhere in the neutral payload.
    const serialized = JSON.stringify(done);
    expect(serialized).not.toContain(RATIONALE_LAB);
    expect(serialized).not.toContain(RATIONALE_PERSON);
  });

  test("source detail GET scrubs interpretation text only when ?brand=neutral", async () => {
    const branded = await request.agent(app).get(`/api/sleep-agent/source/${sourceId}`);
    expect(branded.status).toBe(200);
    expect(branded.body.interpretation?.author_name).toBe(stewardName);
    // Control: the steward action text carries a brand token in branded mode.
    expect(/stanford/i.test(branded.body.interpretation?.action ?? "")).toBe(true);
    // Control: the branded source GET keeps the rubric rationales naming a
    // lab + person.
    const brandedRationales = Object.values(
      branded.body.reliability?.rubric as ReliabilityRubric,
    )
      .flatMap((axis) => axis.items.map((i) => i.rationale))
      .join(" ");
    expect(brandedRationales).toContain(RATIONALE_LAB);
    expect(brandedRationales).toContain(RATIONALE_PERSON);

    const neutral = await request
      .agent(app)
      .get(`/api/sleep-agent/source/${sourceId}?brand=neutral`);
    expect(neutral.status).toBe(200);
    expect(neutral.body.interpretation?.author_name).toBeNull();
    // The published paper authors stay on both.
    expect(neutral.body.authors).toBe("Zeitzer JM et al.");
    // The neutral source GET keeps the axis scores + answers but drops every
    // rubric rationale to an empty string.
    const neutralRubric = neutral.body.reliability?.rubric as ReliabilityRubric;
    const neutralScores = Object.fromEntries(
      (
        neutral.body.reliability?.axes as Array<{
          key: string;
          score: number | null;
        }>
      ).map((a) => [a.key, a.score]),
    );
    expect(neutralScores.rigor).toBe(50);
    expect(neutralScores.reproducibility).toBe(100);
    expect(neutralScores.openness).toBe(50);
    const neutralAnswers = Object.values(neutralRubric)
      .flatMap((axis) => axis.items.map((i) => i.answer))
      .filter((a) => a !== "unclear");
    expect(neutralAnswers).toContain("yes");
    expect(neutralAnswers).toContain("no");
    expect(neutralAnswers).toContain("partial");
    const neutralRationales = Object.values(neutralRubric).flatMap((axis) =>
      axis.items.map((i) => i.rationale),
    );
    expect(neutralRationales.every((r) => r === "")).toBe(true);
    // The whole neutral source payload — interpretation prose + rationales — is
    // brand-clean and free of the lab/person names.
    assertBrandClean("neutral source GET", JSON.stringify(neutral.body));
    expect(JSON.stringify(neutral.body)).not.toContain(RATIONALE_LAB);
    expect(JSON.stringify(neutral.body)).not.toContain(RATIONALE_PERSON);
  });
});
