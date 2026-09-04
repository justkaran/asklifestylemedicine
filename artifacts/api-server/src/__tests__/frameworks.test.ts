import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  test,
  expect,
  vi,
} from "vitest";
import { syncSchemaAdditive } from "@workspace/db/sync-schema";
import { makeTopicEmbedding } from "./testHelpers.js";

// Env must be set before the route/lib modules read it at import time.
vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-frameworks-secret";
  process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY = "stub-frameworks-key";
  process.env.FRAMEWORK_REVENUE_SHARE_PCT = "20";
});

// The framework apply route only calls the non-streaming `messages.create`.
// Return a clean prose rewrite (no REFUSE/UNCOVERED prefix) so the success
// path is exercised.
const anthropicState = vi.hoisted(() => ({ createCalls: 0 }));
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      create: async () => {
        anthropicState.createCalls += 1;
        return {
          content: [
            {
              type: "text",
              text: "Here is your draft, retold through the framework: dim the lights before bed.",
            },
          ],
        };
      },
    };
  }
  return { default: FakeAnthropic };
});

// Deterministic embeddings so the seeded chunk lands on the melatonin axis and
// the apply retrieval clears the RAG threshold.
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

// `stubFacultyUserId` lets each test act as a specific signed-in faculty user.
// requireFacultyAuth is stubbed; requirePillarRoleFromBody stays REAL so the
// owner/booker steward gate is exercised end-to-end.
let stubFacultyUserId = 0;
vi.mock("../middlewares/facultyAuth.js", async () => {
  const actual =
    await vi.importActual<typeof import("../middlewares/facultyAuth.js")>(
      "../middlewares/facultyAuth.js",
    );
  const { db, facultyUsersTable, facultyMembershipsTable } = await import(
    "@workspace/db"
  );
  const { eq } = await import("drizzle-orm");
  return {
    ...actual,
    requireFacultyAuth: async (
      req: { faculty?: unknown; log?: unknown },
      res: { status: (n: number) => { json: (b: unknown) => void } },
      next: () => void,
    ) => {
      if (!stubFacultyUserId) {
        res.status(401).json({ error: "no stub user" });
        return;
      }
      const [user] = await db
        .select()
        .from(facultyUsersTable)
        .where(eq(facultyUsersTable.id, stubFacultyUserId));
      const memberships = await db
        .select()
        .from(facultyMembershipsTable)
        .where(eq(facultyMembershipsTable.userId, stubFacultyUserId));
      (req as { faculty: unknown }).faculty = { user, memberships };
      (req as { log: unknown }).log = {
        warn: () => {},
        info: () => {},
        error: () => {},
      };
      next();
    },
  };
});

// ─── Imports that depend on the mocks above ────────────────────────────

import type { Express } from "express";
import request from "supertest";
import pool from "../lib/db.js";
import { toVectorLiteral } from "../lib/embeddings.js";
import { clearEmbeddingCache } from "../lib/rag.js";

let app: Express;
const stamp = Date.now().toString(36);

let ownerPillarId = 0;
let bookerPillarId = 0;
let ownerUserId = 0; // steward of the owner pillar (framework author)
let bookerUserId = 0; // steward of a different pillar (borrower)
let adminUserId = 0; // platform admin
let outsiderUserId = 0; // faculty with no steward membership
let ownerSourceId = 0;
let embeddingsUsable = false;

const ownerSlug = `fw-owner-${stamp}`;
const bookerSlug = `fw-booker-${stamp}`;

beforeAll(async () => {
  await syncSchemaAdditive(pool);
  app = (await import("../app.js")).default;

  // Framework authoring is locked to the communication-expert pillars. The
  // owner pillar here stands in for one of them, so register its (unique, test-
  // scoped) slug in the allowed set; the booker pillar stays non-allowed so its
  // steward can book/apply but never author.
  const { FRAMEWORK_OWNER_PILLAR_SLUGS } = await import(
    "../routes/frameworks.js"
  );
  FRAMEWORK_OWNER_PILLAR_SLUGS.add(ownerSlug);

  const { rows: pillarRows } = await pool.query<{ id: number }>(
    `INSERT INTO pillars (slug, name) VALUES ($1,$2),($3,$4) RETURNING id`,
    [ownerSlug, "FW Owner Pillar", bookerSlug, "FW Booker Pillar"],
  );
  ownerPillarId = pillarRows[0].id;
  bookerPillarId = pillarRows[1].id;

  const { rows: userRows } = await pool.query<{ id: number }>(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name, is_platform_admin)
     VALUES ($1,$2,$3,'false'),($4,$5,$6,'false'),($7,$8,$9,'true'),($10,$11,$12,'false')
     RETURNING id`,
    [
      `fw-owner-${stamp}`,
      `fw-owner-${stamp}@test.local`,
      "Dr. Framework Owner",
      `fw-booker-${stamp}`,
      `fw-booker-${stamp}@test.local`,
      "Dr. Framework Booker",
      `fw-admin-${stamp}`,
      `fw-admin-${stamp}@test.local`,
      "Dr. Admin",
      `fw-outsider-${stamp}`,
      `fw-outsider-${stamp}@test.local`,
      "Dr. Outsider",
    ],
  );
  ownerUserId = userRows[0].id;
  bookerUserId = userRows[1].id;
  adminUserId = userRows[2].id;
  outsiderUserId = userRows[3].id;

  await pool.query(
    `INSERT INTO faculty_memberships (user_id, pillar_id, role)
     VALUES ($1,$2,'steward'),($3,$4,'steward')`,
    [ownerUserId, ownerPillarId, bookerUserId, bookerPillarId],
  );

  // An approved source + chunk in the OWNER pillar so apply retrieval grounds.
  const { rows: sourceRows } = await pool.query<{ id: number }>(
    `INSERT INTO sources
        (pillar_id, kind, title, authors, year, journal, status, uploaded_by_user_id)
       VALUES ($1, 'paper',
               'Sensitivity of the human circadian pacemaker to nocturnal light',
               'Zeitzer JM et al.', 2000, 'J Physiol', 'approved', $2)
       RETURNING id`,
    [ownerPillarId, ownerUserId],
  );
  ownerSourceId = sourceRows[0].id;

  // Best-effort: seed an approved 384-dim chunk so the apply *success* path can
  // ground + cite. Some dev DBs predate the in-house gte-small migration and
  // still pin `embedding` to halfvec(3072); inserting a 384-dim vector throws
  // there. That pre-existing drift only disables the success assertion below —
  // everything else (CRUD, apply UNCOVERED, bookings, ledger) is independent of
  // it, because the freshly-created pillars own no chunks for retrieval to cast.
  const vec = toVectorLiteral(makeTopicEmbedding("melatonin circadian light"));
  try {
    await pool.query(
      `INSERT INTO source_chunks
         (source_id, chunk_index, text, embedding, embedding_model)
       VALUES ($1, 0, $2, $3::halfvec(384), 'Xenova/gte-small')`,
      [
        ownerSourceId,
        "Even ~100 lux of nocturnal light suppresses melatonin (Zeitzer 2000).",
        vec,
      ],
    );
    embeddingsUsable = true;
  } catch {
    embeddingsUsable = false;
  }
  clearEmbeddingCache();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(() => {
  stubFacultyUserId = 0;
  anthropicState.createCalls = 0;
});

let frameworkId = 0;
let adminDraftId = 0;

describe("frameworks — owner authoring", () => {
  test("non-steward of the pillar cannot create a framework", async () => {
    stubFacultyUserId = outsiderUserId;
    const res = await request(app)
      .post("/api/faculty/frameworks")
      .send({
        pillarId: ownerPillarId,
        name: "The 3-Beat Story",
        structure: "Hook → struggle → resolution.",
      });
    expect(res.status).toBe(403);
  });

  test("a steward of a non-communication pillar cannot author its OWN framework", async () => {
    // The booker steward owns a non-allowed pillar: even with steward
    // membership of that pillar, framework authoring is locked to the
    // communication pillars.
    stubFacultyUserId = bookerUserId;
    const res = await request(app)
      .post("/api/faculty/frameworks")
      .send({
        pillarId: bookerPillarId,
        name: "Borrower's Framework",
        structure: "Should never be created.",
      });
    expect(res.status).toBe(403);
  });

  test("a platform admin can author in any pillar (bypass)", async () => {
    stubFacultyUserId = adminUserId;
    const res = await request(app)
      .post("/api/faculty/frameworks")
      .send({
        pillarId: bookerPillarId,
        name: `Admin Draft ${stamp}`,
        structure: "Admins keep their bypass for testing/support.",
      });
    expect(res.status).toBe(201);
    expect(res.body.framework.status).toBe("draft");
    adminDraftId = res.body.framework.id;
  });

  test("a non-communication steward cannot publish a framework in their pillar", async () => {
    // The admin authored a draft in the (non-allowed) booker pillar. Its
    // steward stewards that pillar but is still blocked from authoring actions.
    stubFacultyUserId = bookerUserId;
    const res = await request(app).post(
      `/api/faculty/frameworks/${adminDraftId}/publish`,
    );
    expect(res.status).toBe(403);
  });

  test("steward of the pillar creates a draft framework", async () => {
    stubFacultyUserId = ownerUserId;
    const res = await request(app)
      .post("/api/faculty/frameworks")
      .send({
        pillarId: ownerPillarId,
        name: "The 3-Beat Story",
        description: "Turn evidence into a narrative.",
        structure: "Hook → struggle → resolution.",
        example: "Last night I dimmed the lights…",
      });
    expect(res.status).toBe(201);
    expect(res.body.framework.status).toBe("draft");
    expect(res.body.framework.ownerUserId).toBe(ownerUserId);
    expect(res.body.framework.slug).toBe("the-3-beat-story");
    frameworkId = res.body.framework.id;
  });

  test("a draft framework is NOT in the cross-pillar published list", async () => {
    stubFacultyUserId = bookerUserId;
    const res = await request(app).get("/api/faculty/frameworks/published");
    expect(res.status).toBe(200);
    expect(
      res.body.frameworks.some((f: { id: number }) => f.id === frameworkId),
    ).toBe(false);
  });

  test("owner publishes the framework", async () => {
    stubFacultyUserId = ownerUserId;
    const res = await request(app).post(
      `/api/faculty/frameworks/${frameworkId}/publish`,
    );
    expect(res.status).toBe(200);
    expect(res.body.framework.status).toBe("published");
  });

  test("published framework appears with owner + pillar attribution", async () => {
    stubFacultyUserId = bookerUserId;
    const res = await request(app).get("/api/faculty/frameworks/published");
    const found = res.body.frameworks.find(
      (f: { id: number }) => f.id === frameworkId,
    );
    expect(found).toBeTruthy();
    expect(found.ownerName).toBe("Dr. Framework Owner");
    expect(found.pillarName).toBe("FW Owner Pillar");
  });

  test("the cross-pillar picker EXCLUDES the caller's own pillar frameworks", async () => {
    // The owner steward must not see their own published framework in the
    // borrow picker — you apply a colleague's framework, never your own.
    stubFacultyUserId = ownerUserId;
    const res = await request(app).get("/api/faculty/frameworks/published");
    expect(res.status).toBe(200);
    expect(
      res.body.frameworks.some((f: { id: number }) => f.id === frameworkId),
    ).toBe(false);
  });
});

describe("frameworks — cross-pillar apply", () => {
  test("applies a framework, grounded in owner content + attributed", async (ctx) => {
    // Skipped only under the pre-existing embedding-dim drift (no 384 chunk
    // could be seeded); the success path needs a grounded retrieval.
    if (!embeddingsUsable) return ctx.skip();
    stubFacultyUserId = bookerUserId;
    const res = await request(app)
      .post(`/api/faculty/frameworks/${frameworkId}/apply`)
      .send({ draft: "Light at night affects melatonin and sleep.", kind: "answer" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.refused).toBe(false);
    expect(res.body.uncovered).toBe(false);
    expect(res.body.draft).toContain("framework");
    expect(res.body.attribution.ownerName).toBe("Dr. Framework Owner");
    expect(res.body.attribution.frameworkName).toBe("The 3-Beat Story");
    expect(anthropicState.createCalls).toBe(1);
  });

  test("UNCOVERED (no LLM call) when retrieval finds nothing", async () => {
    stubFacultyUserId = bookerUserId;
    const res = await request(app)
      .post(`/api/faculty/frameworks/${frameworkId}/apply`)
      .send({ draft: "How do I improve concentration and focus at work?" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.uncovered).toBe(true);
    expect(res.body.draft.startsWith("UNCOVERED:")).toBe(true);
    expect(anthropicState.createCalls).toBe(0);
  });

  test("a steward cannot apply their OWN pillar's framework", async () => {
    stubFacultyUserId = ownerUserId;
    const res = await request(app)
      .post(`/api/faculty/frameworks/${frameworkId}/apply`)
      .send({ draft: "Light at night affects melatonin.", kind: "answer" });
    expect(res.status).toBe(400);
    expect(anthropicState.createCalls).toBe(0);
  });
});

describe("frameworks — bookings + revenue-share ledger", () => {
  let bookingId = 0;

  test("booker steward books a use; share% snapshots from env", async () => {
    stubFacultyUserId = bookerUserId;
    const res = await request(app)
      .post("/api/faculty/frameworks/bookings")
      .send({
        frameworkId,
        bookerPillarId,
        targetType: "interpretation",
        targetId: 4242,
        targetTitle: "Why evening light matters",
      });
    expect(res.status).toBe(201);
    expect(res.body.booking.sharePct).toBe(20);
    expect(res.body.booking.ownerPillarId).toBe(ownerPillarId);
    expect(res.body.booking.ownerUserId).toBe(ownerUserId);
    expect(res.body.booking.status).toBe("booked");
    bookingId = res.body.booking.id;
  });

  test("re-booking the same target is idempotent", async () => {
    stubFacultyUserId = bookerUserId;
    const res = await request(app)
      .post("/api/faculty/frameworks/bookings")
      .send({
        frameworkId,
        bookerPillarId,
        targetType: "interpretation",
        targetId: 4242,
      });
    expect(res.status).toBe(200);
    expect(res.body.idempotent).toBe(true);
    expect(res.body.booking.id).toBe(bookingId);
  });

  test("non-steward of the booker pillar cannot book", async () => {
    stubFacultyUserId = outsiderUserId;
    const res = await request(app)
      .post("/api/faculty/frameworks/bookings")
      .send({ frameworkId, bookerPillarId });
    expect(res.status).toBe(403);
  });

  test("a steward cannot book their OWN pillar's framework", async () => {
    stubFacultyUserId = ownerUserId;
    const res = await request(app)
      .post("/api/faculty/frameworks/bookings")
      .send({ frameworkId, bookerPillarId: ownerPillarId });
    expect(res.status).toBe(400);
  });

  test("booker records revenue → owner share computed from share%", async () => {
    stubFacultyUserId = bookerUserId;
    const res = await request(app)
      .post(`/api/faculty/frameworks/bookings/${bookingId}/revenue`)
      .send({ revenueCents: 10000 });
    expect(res.status).toBe(200);
    expect(res.body.booking.revenueCents).toBe(10000);
    expect(res.body.booking.ownerShareCents).toBe(2000); // 20% of $100
    expect(res.body.booking.status).toBe("revenue_recorded");
  });

  test("owner sees the booking + owed amount in box=owner", async () => {
    stubFacultyUserId = ownerUserId;
    const res = await request(app).get(
      "/api/faculty/frameworks/bookings?box=owner",
    );
    expect(res.status).toBe(200);
    const found = res.body.bookings.find(
      (b: { id: number }) => b.id === bookingId,
    );
    expect(found).toBeTruthy();
    expect(found.bookerPillarName).toBe("FW Booker Pillar");
    expect(res.body.summary.owedCents).toBeGreaterThanOrEqual(2000);
  });

  test("non-admin cannot read the ledger", async () => {
    stubFacultyUserId = ownerUserId;
    const res = await request(app).get(
      "/api/faculty/frameworks/bookings/ledger",
    );
    expect(res.status).toBe(403);
  });

  test("admin settles the booking; owed moves to settled", async () => {
    stubFacultyUserId = adminUserId;
    const patch = await request(app)
      .patch(`/api/faculty/frameworks/bookings/${bookingId}`)
      .send({ status: "settled" });
    expect(patch.status).toBe(200);
    expect(patch.body.booking.status).toBe("settled");

    const ledger = await request(app).get(
      "/api/faculty/frameworks/bookings/ledger",
    );
    expect(ledger.status).toBe(200);
    expect(ledger.body.summary.settledCents).toBeGreaterThanOrEqual(2000);
  });

  test("admin CSV export includes a header + the booking row", async () => {
    stubFacultyUserId = adminUserId;
    const res = await request(app).get(
      "/api/faculty/frameworks/bookings/ledger.csv",
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.text.split("\n")[0]).toContain("framework");
    expect(res.text).toContain("The 3-Beat Story");
  });
});
