import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  test,
  expect,
  vi,
} from "vitest";
import pool from "../lib/db.js";

// Deterministic, network-free embeddings (ingestSource embeds the scraped
// chunks); 384-d to satisfy the halfvec cast.
vi.mock("../lib/embeddings.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/embeddings.js")>(
    "../lib/embeddings.js",
  );
  return {
    ...actual,
    embedTexts: vi.fn(async (texts: string[]) =>
      texts.map(() => {
        const v = new Array(384).fill(0);
        v[5] = 1;
        return v;
      }),
    ),
  };
});

// Controllable Firecrawl stubs.
const firecrawl = vi.hoisted(() => ({
  configured: true,
  searchResults: [] as Array<{
    url: string;
    title: string;
    description: string | null;
  }>,
  scrapeText: "" as string | null,
  searchCalls: [] as string[],
}));
vi.mock("../lib/firecrawl.js", () => ({
  isFirecrawlConfigured: () => firecrawl.configured,
  searchTalks: vi.fn(async (query: string) => {
    firecrawl.searchCalls.push(query);
    return firecrawl.searchResults;
  }),
  scrapeMarkdown: vi.fn(async () => firecrawl.scrapeText),
}));

// Email spies: getResendClient returns a truthy dummy; sendGuarded records.
const email = vi.hoisted(() => ({
  sends: [] as Array<{ label: string; subject: string }>,
}));
vi.mock("../lib/resendClient.js", () => ({
  getResendClient: vi.fn(async () => ({
    client: {},
    fromEmail: "checkin@palonur.com",
  })),
}));
vi.mock("../lib/emailGuard.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/emailGuard.js")>(
    "../lib/emailGuard.js",
  );
  return {
    ...actual,
    sendGuarded: vi.fn(
      async (
        _client: unknown,
        payload: { subject: string },
        ctx: { label: string },
      ) => {
        email.sends.push({ label: ctx.label, subject: payload.subject });
        return { data: { id: "test-send" } };
      },
    ),
  };
});

import {
  runGapDiscovery,
  getRefusalEvidence,
  isDisplayableQuestion,
  __resetGapDiscoveryGuardsForTests,
} from "../lib/stanfordGapDiscovery.js";

const stamp = Date.now().toString(36);
const TEST_SLUG = `gap-disc-test-${stamp}`;
let testPillarId = 0;

const LONG_TEXT = "Stanford lifestyle medicine material. ".repeat(30); // > 400 chars

async function ensureTestPillar(): Promise<void> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO pillars (slug, name, description)
       VALUES ($1, 'Gap Discovery Test', 'decoy pillar for stanfordGapDiscovery tests')
     ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
     RETURNING id`,
    [TEST_SLUG],
  );
  testPillarId = rows[0].id;
}

// Tests import app.ts (never index.ts), so boot-time DDL doesn't run here —
// self-provision the evidence table exactly as the schema defines it.
async function ensureEvidenceTable(): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS gap_discovery_events (
       id serial PRIMARY KEY,
       question text NOT NULL,
       pillar_id integer NOT NULL REFERENCES pillars(id) ON DELETE CASCADE,
       source_id integer NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
       created_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

beforeAll(async () => {
  await ensureTestPillar();
  await ensureEvidenceTable();
});

beforeEach(async () => {
  await ensureTestPillar();
  __resetGapDiscoveryGuardsForTests();
  firecrawl.configured = true;
  firecrawl.searchResults = [];
  firecrawl.scrapeText = LONG_TEXT;
  firecrawl.searchCalls = [];
  email.sends = [];
});

afterAll(async () => {
  await pool.query(
    `DELETE FROM source_chunks WHERE source_id IN (SELECT id FROM sources WHERE pillar_id = $1)`,
    [testPillarId],
  );
  await pool.query(
    `DELETE FROM source_audit_log WHERE source_id IN (SELECT id FROM sources WHERE pillar_id = $1)`,
    [testPillarId],
  );
  await pool.query(`DELETE FROM sources WHERE pillar_id = $1`, [testPillarId]);
  await pool.query(`DELETE FROM pillars WHERE id = $1`, [testPillarId]);
});

describe("runGapDiscovery", () => {
  test("queues allowlisted material as a DRAFT source and emails only then", async () => {
    const url = `https://lifestylemedicine.stanford.edu/${stamp}/protein`;
    firecrawl.searchResults = [
      { url: "https://evil.example.com/spoof", title: "Spoof", description: null },
      { url, title: "Protein after 50", description: null },
    ];

    const result = await runGapDiscovery({
      question: `How much protein do I need after 50? ${stamp}`,
      pillarIds: [testPillarId],
    });

    expect(result.outcome).toBe("queued");
    expect(result.url).toBe(url);

    const { rows } = await pool.query<{ status: string; chunks: string }>(
      `SELECT s.status,
              (SELECT COUNT(*) FROM source_chunks c WHERE c.source_id = s.id) AS chunks
         FROM sources s WHERE s.pillar_id = $1 AND s.source_url = $2`,
      [testPillarId, url],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("draft"); // steward approval queue — never quoted
    expect(Number(rows[0].chunks)).toBeGreaterThan(0);

    expect(email.sends).toHaveLength(1);
    expect(email.sends[0].label).toBe("stanford-gap-discovery");

    // Search query is scoped to the hardcoded Stanford domain, never user-derived.
    expect(firecrawl.searchCalls[0]).toContain("site:lifestylemedicine.stanford.edu");
  });

  test("dedupes against an existing source URL in ANY status (no email)", async () => {
    const url = `https://lifestylemedicine.stanford.edu/${stamp}/rejected`;
    await pool.query(
      `INSERT INTO sources (pillar_id, kind, title, source_url, status)
         VALUES ($1, 'slm_article', 'Previously rejected', $2, 'archived')`,
      [testPillarId, url],
    );
    firecrawl.searchResults = [{ url, title: "Rejected", description: null }];

    const result = await runGapDiscovery({
      question: `Question about already rejected material ${stamp}`,
      pillarIds: [testPillarId],
    });

    expect(result.outcome).toBe("no_candidates");
    expect(email.sends).toHaveLength(0);
  });

  test("24h per-question guard blocks an immediate repeat", async () => {
    const url = `https://lifestylemedicine.stanford.edu/${stamp}/guard`;
    firecrawl.searchResults = [{ url, title: "Guarded", description: null }];
    const question = `Repeated question ${stamp}`;

    const first = await runGapDiscovery({ question, pillarIds: [testPillarId] });
    expect(first.outcome).toBe("queued");

    const second = await runGapDiscovery({ question, pillarIds: [testPillarId] });
    expect(second.outcome).toBe("skipped_guard");
    expect(email.sends).toHaveLength(1);
  });

  test("degrades cleanly when Firecrawl is unconfigured", async () => {
    firecrawl.configured = false;
    const result = await runGapDiscovery({
      question: `Unconfigured question ${stamp}`,
      pillarIds: [testPillarId],
    });
    expect(result.outcome).toBe("skipped_unconfigured");
    expect(email.sends).toHaveLength(0);
  });

  test("scrape failure queues nothing and sends no email", async () => {
    const url = `https://lifestylemedicine.stanford.edu/${stamp}/thin`;
    firecrawl.searchResults = [{ url, title: "Thin page", description: null }];
    firecrawl.scrapeText = "too short";

    const result = await runGapDiscovery({
      question: `Thin scrape question ${stamp}`,
      pillarIds: [testPillarId],
    });
    expect(result.outcome).toBe("scrape_failed");
    expect(email.sends).toHaveLength(0);

    const { rows } = await pool.query(
      `SELECT id FROM sources WHERE pillar_id = $1 AND source_url = $2`,
      [testPillarId, url],
    );
    expect(rows).toHaveLength(0);
  });

  test("queued run persists a gap_discovery_events row linking question → source", async () => {
    const url = `https://lifestylemedicine.stanford.edu/${stamp}/evidence-link`;
    const question = `Does magnesium timing change deep sleep? ${stamp}`;
    firecrawl.searchResults = [{ url, title: "Magnesium and sleep", description: null }];

    const result = await runGapDiscovery({ question, pillarIds: [testPillarId] });
    expect(result.outcome).toBe("queued");

    const { rows } = await pool.query<{ question: string; source_url: string }>(
      `SELECT e.question, s.source_url
         FROM gap_discovery_events e
         JOIN sources s ON s.id = e.source_id
        WHERE e.pillar_id = $1 AND s.source_url = $2`,
      [testPillarId, url],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].question).toBe(question);
  });
});

describe("refusal evidence", () => {
  test("isDisplayableQuestion rejects PII-shaped and unusual questions", () => {
    expect(isDisplayableQuestion("Does melatonin help with jet lag recovery?")).toBe(true);
    expect(isDisplayableQuestion("email me at jane@example.com about my sleep")).toBe(false);
    expect(isDisplayableQuestion("call me back at 650-555-0199 tonight please")).toBe(false);
    expect(isDisplayableQuestion("see https://example.com/my-sleep-data now")).toBe(false);
    expect(isDisplayableQuestion("short?")).toBe(false);
    expect(isDisplayableQuestion(`way too long ${"x".repeat(220)}`)).toBe(false);
  });

  test("prefers a steward-APPROVED story over a newer pending one and skips PII questions", async () => {
    const oldUrl = `https://lifestylemedicine.stanford.edu/${stamp}/approved-story`;
    const newUrl = `https://lifestylemedicine.stanford.edu/${stamp}/pending-story`;
    const piiUrl = `https://lifestylemedicine.stanford.edu/${stamp}/pii-story`;
    const approvedQ = `Is REM rebound after alcohol a real effect? ${stamp}`;
    const pendingQ = `Do weighted blankets change sleep depth? ${stamp}`;
    const piiQ = `my email is reader@example.com can you help me sleep`;

    firecrawl.searchResults = [{ url: oldUrl, title: "REM rebound", description: null }];
    const first = await runGapDiscovery({ question: approvedQ, pillarIds: [testPillarId] });
    expect(first.outcome).toBe("queued");

    firecrawl.searchResults = [{ url: newUrl, title: "Weighted blankets", description: null }];
    const second = await runGapDiscovery({ question: pendingQ, pillarIds: [testPillarId] });
    expect(second.outcome).toBe("queued");

    firecrawl.searchResults = [{ url: piiUrl, title: "PII case", description: null }];
    const third = await runGapDiscovery({ question: piiQ, pillarIds: [testPillarId] });
    expect(third.outcome).toBe("queued");

    // Steward approves the OLDER story's material.
    await pool.query(
      `UPDATE sources SET status = 'approved' WHERE pillar_id = $1 AND source_url = $2`,
      [testPillarId, oldUrl],
    );

    const evidence = await getRefusalEvidence();
    expect(evidence.story).not.toBeNull();
    expect(evidence.story!.question).toBe(approvedQ);
    expect(evidence.story!.approved).toBe(true);
    expect(evidence.story!.sourceTitle).toBe("REM rebound");
    expect(evidence.story!.pillarName).toBe("Gap Discovery Test");
    // The PII-shaped question must never be the displayed story.
    expect(evidence.story!.question).not.toContain("@");
  });

  test("falls back to the newest pending story when nothing is approved yet", async () => {
    // Undo the approval from the previous test — this suite shares the dev DB,
    // so "nothing approved" must be established, not assumed.
    await pool.query(
      `UPDATE sources SET status = 'draft' WHERE pillar_id = $1 AND status = 'approved'`,
      [testPillarId],
    );

    const url = `https://lifestylemedicine.stanford.edu/${stamp}/pending-only`;
    const question = `Does evening light exposure delay melatonin onset? ${stamp}`;
    firecrawl.searchResults = [{ url, title: "Evening light", description: null }];
    const result = await runGapDiscovery({ question, pillarIds: [testPillarId] });
    expect(result.outcome).toBe("queued");

    const evidence = await getRefusalEvidence();
    expect(evidence.story).not.toBeNull();
    // Newest displayable event wins when no approved story exists in the
    // scan window (this suite's events are the newest rows in the table).
    expect(evidence.story!.question).toBe(question);
    expect(evidence.story!.approved).toBe(false);
    expect(typeof evidence.uncoveredCount30d === "number" || evidence.uncoveredCount30d === null).toBe(true);
  });
});
