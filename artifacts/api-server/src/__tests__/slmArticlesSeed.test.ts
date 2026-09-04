import { afterAll, beforeAll, beforeEach, describe, test, expect } from "vitest";
import pool from "../lib/db.js";
import { seedSlmArticles, type SlmSeedData } from "../lib/slmArticlesSeed.js";

/**
 * Idempotency tests for the SLM articles boot seed. The seed is exercised
 * against a dedicated throwaway pillar with injected data + a deterministic
 * embed stub (no model download, no network). Pattern mirrors
 * stewardRosterSeed.test.ts: shared dev DB, self-provisioned fixtures,
 * cleanup in afterAll.
 */

const stamp = Date.now().toString(36);
const TEST_SLUG = `slm-seed-test-${stamp}`;
let testPillarId = 0;

const fakeEmbed = async (texts: string[]): Promise<number[][]> =>
  texts.map(() => {
    const v = new Array(384).fill(0);
    v[3] = 1;
    return v;
  });

function makeData(overrides?: Partial<SlmSeedData>): SlmSeedData {
  return {
    journal: "Stanford Lifestyle Medicine Newsletter",
    articles: [
      {
        pillarSlug: TEST_SLUG,
        kind: "slm_article",
        title: "Test article one",
        authors: "Doe, J.",
        year: 2024,
        sourceUrl: `https://example.stanford.test/${stamp}/one`,
        chunks: ["chunk one text", "chunk two text"],
      },
      {
        pillarSlug: TEST_SLUG,
        kind: "slm_article",
        title: "Test article two",
        authors: null,
        year: null,
        sourceUrl: `https://example.stanford.test/${stamp}/two`,
        chunks: ["solo chunk"],
      },
    ],
    ...overrides,
  };
}

async function sourceRows(): Promise<
  Array<{
    id: number;
    source_url: string;
    status: string;
    rights_basis: string | null;
    retention_status: string;
    chunks: number;
  }>
> {
  const { rows } = await pool.query<{
    id: number;
    source_url: string;
    status: string;
    rights_basis: string | null;
    retention_status: string;
    chunks: string;
  }>(
    `SELECT s.id, s.source_url, s.status, s.rights_basis, s.retention_status,
            (SELECT COUNT(*) FROM source_chunks c WHERE c.source_id = s.id) AS chunks
       FROM sources s WHERE s.pillar_id = $1 ORDER BY s.id`,
    [testPillarId],
  );
  return rows.map((r) => ({ ...r, chunks: Number(r.chunks) }));
}

async function ensureTestPillar(): Promise<void> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO pillars (slug, name, description)
       VALUES ($1, 'SLM Seed Test', 'decoy pillar for slmArticlesSeed tests')
     ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
     RETURNING id`,
    [TEST_SLUG],
  );
  testPillarId = rows[0].id;
}

beforeAll(ensureTestPillar);
// Other suites TRUNCATE shared tables mid-run — re-ensure fixtures.
beforeEach(ensureTestPillar);

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

describe("seedSlmArticles", () => {
  test("first run inserts approved sources + chunks; rerun is a no-op", async () => {
    const data = makeData();

    const first = await seedSlmArticles({ data, embed: fakeEmbed });
    expect(first.inserted).toBe(2);
    expect(first.healed).toBe(0);
    expect(first.skippedExisting).toBe(0);
    expect(first.missingSlugs).toEqual([]);

    let rows = await sourceRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "approved")).toBe(true);
    expect(rows.every((r) => r.rights_basis === "permission")).toBe(true);
    expect(rows.every((r) => r.retention_status === "retained_with_rights")).toBe(
      true,
    );
    expect(rows.map((r) => r.chunks)).toEqual([2, 1]);

    const second = await seedSlmArticles({ data, embed: fakeEmbed });
    expect(second.inserted).toBe(0);
    expect(second.healed).toBe(0);
    expect(second.skippedExisting).toBe(2);

    rows = await sourceRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.chunks)).toEqual([2, 1]);
  });

  test("never reverts a steward edit on an existing row", async () => {
    const data = makeData();
    await seedSlmArticles({ data, embed: fakeEmbed });

    // Steward archives one of the seeded sources.
    await pool.query(
      `UPDATE sources SET status = 'archived' WHERE pillar_id = $1 AND source_url = $2`,
      [testPillarId, data.articles[0].sourceUrl],
    );

    const result = await seedSlmArticles({ data, embed: fakeEmbed });
    expect(result.inserted).toBe(0);
    expect(result.skippedExisting).toBe(2);

    const rows = await sourceRows();
    const archived = rows.find(
      (r) => r.source_url === data.articles[0].sourceUrl,
    );
    expect(archived?.status).toBe("archived");
  });

  test("heals an existing source that has zero chunks", async () => {
    const data = makeData();
    await seedSlmArticles({ data, embed: fakeEmbed });

    const rowsBefore = await sourceRows();
    const target = rowsBefore.find(
      (r) => r.source_url === data.articles[0].sourceUrl,
    )!;
    await pool.query(`DELETE FROM source_chunks WHERE source_id = $1`, [
      target.id,
    ]);

    const result = await seedSlmArticles({ data, embed: fakeEmbed });
    expect(result.healed).toBe(1);
    expect(result.skippedExisting).toBe(1);
    expect(result.inserted).toBe(0);

    const rowsAfter = await sourceRows();
    const healed = rowsAfter.find((r) => r.id === target.id);
    expect(healed?.chunks).toBe(2);
  });

  test("does not heal raw chunks into a legacy source with no recorded rights", async () => {
    const data = makeData();
    await seedSlmArticles({ data, embed: fakeEmbed });
    const target = (await sourceRows()).find(
      (r) => r.source_url === data.articles[0].sourceUrl,
    )!;
    await pool.query(`DELETE FROM source_chunks WHERE source_id = $1`, [
      target.id,
    ]);
    await pool.query(
      `UPDATE sources
          SET rights_basis = NULL, retention_status = 'needs_review'
        WHERE id = $1`,
      [target.id],
    );

    const result = await seedSlmArticles({ data, embed: fakeEmbed });
    expect(result.healed).toBe(0);
    const [after] = (await sourceRows()).filter((r) => r.id === target.id);
    expect(after.chunks).toBe(0);
    expect(after.retention_status).toBe("needs_review");
  });

  test("a failing article is retried, counted, and never aborts the rest", async () => {
    // Regression for the July 2026 prod crash loop: a dropped DB connection
    // mid-article used to abort the whole seed run. A persistent failure on
    // one article must be retried once, counted in `failed`, and the
    // remaining articles must still be seeded.
    const data = makeData();
    data.articles[0].sourceUrl = `https://example.stanford.test/${stamp}/poison`;
    data.articles[0].chunks = ["POISON chunk"];
    // Fresh URL: /two was already seeded by the earlier idempotency tests.
    data.articles[1].sourceUrl = `https://example.stanford.test/${stamp}/healthy`;

    let poisonCalls = 0;
    const flakyEmbed = async (texts: string[]): Promise<number[][]> => {
      if (texts.some((t) => t.includes("POISON"))) {
        poisonCalls++;
        throw new Error("simulated connection termination");
      }
      return fakeEmbed(texts);
    };

    const result = await seedSlmArticles({ data, embed: flakyEmbed });
    expect(result.failed).toBe(1);
    expect(poisonCalls).toBe(2); // initial attempt + one retry
    expect(result.inserted).toBe(1); // the healthy article still landed

    const rows = await sourceRows();
    expect(rows.some((r) => r.source_url.endsWith("/healthy"))).toBe(true);

    // Transient failure: the retry succeeds and nothing is counted failed.
    let flakes = 1;
    const transientEmbed = async (texts: string[]): Promise<number[][]> => {
      if (texts.some((t) => t.includes("POISON")) && flakes-- > 0) {
        throw new Error("simulated transient drop");
      }
      return fakeEmbed(texts);
    };
    const second = await seedSlmArticles({ data, embed: transientEmbed });
    expect(second.failed).toBe(0);
    // The poison article's source row may already exist from the failed run
    // (source insert precedes embedding), so the retry lands as heal OR insert.
    expect(second.healed + second.inserted).toBe(1);

    const rowsAfter = await sourceRows();
    const poison = rowsAfter.find((r) => r.source_url.endsWith("/poison"));
    expect(poison?.chunks).toBe(1);
  }, 30000);

  test("missing pillar slug is skipped, never thrown", async () => {
    const data = makeData();
    data.articles.push({
      pillarSlug: `no-such-pillar-${stamp}`,
      kind: "slm_article",
      title: "Orphan",
      authors: null,
      year: null,
      sourceUrl: `https://example.stanford.test/${stamp}/orphan`,
      chunks: ["orphan chunk"],
    });

    const result = await seedSlmArticles({ data, embed: fakeEmbed });
    expect(result.skippedPillarMissing).toBe(1);
    expect(result.missingSlugs).toEqual([`no-such-pillar-${stamp}`]);

    const rows = await sourceRows();
    expect(rows.some((r) => r.source_url.endsWith("/orphan"))).toBe(false);
  });
});
