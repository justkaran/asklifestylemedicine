/**
 * Unit tests for collapseSameWorkProvenance — the display-only collapse of
 * provenance entries that are the same underlying work stored as multiple
 * chapter/section sources (e.g. Example Author's one Example Book
 * six "(the Grow pillar)"-style sources). Public answer surfaces must list
 * the book ONCE, not six times. Pure unit tests, no DB.
 */
import { describe, test, expect } from "vitest";
import {
  collapseSameWorkProvenance,
  serializePublicProvenance,
  type ProvenanceEntry,
} from "../lib/rag.js";

function entry(overrides: Partial<ProvenanceEntry>): ProvenanceEntry {
  return {
    source_id: 1,
    interpretation_id: null,
    chunk_ids: [10],
    title: "Some Paper",
    authors: "Example Author",
    year: 2025,
    journal: "Worthy Books",
    doi: null,
    source_url: null,
    study_design: null,
    pillar_slug: "example",
    interpretation_author: null,
    excerpts: [{ chunk_id: 10, kind: "source", text: "excerpt" }],
    interpretation_note: null,
    reliability: null,
    ...overrides,
  } as ProvenanceEntry;
}

const BOOK = "Example Book's Second Half";

describe("collapseSameWorkProvenance", () => {
  test("collapses chapter-split book sources into one clean-titled entry", () => {
    const input = [
      entry({ source_id: 1, chunk_ids: [10], title: BOOK }),
      entry({
        source_id: 2,
        chunk_ids: [20],
        title: `${BOOK} (the Grow pillar)`,
        excerpts: [{ chunk_id: 20, kind: "source", text: "grow" }],
      }),
      entry({
        source_id: 3,
        chunk_ids: [30],
        title: `${BOOK} (the Connect pillar)`,
        excerpts: [{ chunk_id: 30, kind: "source", text: "connect" }],
      }),
    ];
    const out = collapseSameWorkProvenance(input);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe(BOOK);
    expect(out[0].source_id).toBe(1);
    expect(out[0].chunk_ids).toEqual([10, 20, 30]);
    expect(out[0].excerpts.map((e) => e.chunk_id)).toEqual([10, 20, 30]);
  });

  test("keeps distinct works separate and preserves their titles verbatim", () => {
    const input = [
      entry({
        source_id: 1,
        title: "Sleep and the Aging Brain (RCT)",
        authors: "Zeitzer J",
        journal: "Sleep",
      }),
      entry({
        source_id: 2,
        title: "Caffeine Timing in Older Adults",
        authors: "Zeitzer J",
        journal: "Sleep",
      }),
    ];
    const out = collapseSameWorkProvenance(input);
    expect(out).toHaveLength(2);
    // A lone entry never has its trailing parenthetical stripped.
    expect(out[0].title).toBe("Sleep and the Aging Brain (RCT)");
    expect(out[1].title).toBe("Caffeine Timing in Older Adults");
  });

  test("same base title but different author/year stays separate", () => {
    const input = [
      entry({ source_id: 1, title: `${BOOK} (the Grow pillar)` }),
      entry({ source_id: 2, title: `${BOOK} (second edition)`, year: 2027 }),
    ];
    const out = collapseSameWorkProvenance(input);
    expect(out).toHaveLength(2);
  });

  test("merged group preserves interpretation, reliability, doi and url from any member", () => {
    const rel = { overall: 4 } as unknown as ProvenanceEntry["reliability"];
    const input = [
      entry({ source_id: 1, title: `${BOOK} (the Grow pillar)` }),
      entry({
        source_id: 2,
        title: `${BOOK} (the Give pillar)`,
        interpretation_id: 77,
        interpretation_author: "Example Author",
        interpretation_note: "note-b",
        reliability: rel,
        doi: "10.1000/example",
        source_url: "https://example.com/example",
      }),
    ];
    const out = collapseSameWorkProvenance(input);
    expect(out).toHaveLength(1);
    expect(out[0].interpretation_id).toBe(77);
    expect(out[0].interpretation_author).toBe("Example Author");
    expect(out[0].interpretation_note).toBe("note-b");
    expect(out[0].reliability).toBe(rel);
    expect(out[0].doi).toBe("10.1000/example");
    expect(out[0].source_url).toBe("https://example.com/example");
  });

  test("does not mutate its input entries", () => {
    const a = entry({
      source_id: 1,
      chunk_ids: [10],
      title: `${BOOK} (the Grow pillar)`,
    });
    const b = entry({
      source_id: 2,
      chunk_ids: [20],
      title: `${BOOK} (the Adapt pillar)`,
    });
    collapseSameWorkProvenance([a, b]);
    expect(a.chunk_ids).toEqual([10]);
    expect(a.title).toBe(`${BOOK} (the Grow pillar)`);
    expect(b.chunk_ids).toEqual([20]);
  });

  test("empty input returns empty output", () => {
    expect(collapseSameWorkProvenance([])).toEqual([]);
  });
});

describe("serializePublicProvenance", () => {
  test("removes verbatim retrieved chunks while retaining citation metadata and interpretations", () => {
    const sourceText = "This source sentence must remain server-side.";
    const result = serializePublicProvenance([
      entry({
        excerpts: [{ chunk_id: 10, kind: "source", text: sourceText }],
        interpretation_note: "Faculty interpretation remains available.",
      }),
    ]);

    expect(result[0]).not.toHaveProperty("excerpts");
    expect(JSON.stringify(result)).not.toContain(sourceText);
    expect(result[0].interpretation_note).toBe(
      "Faculty interpretation remains available.",
    );
  });
});
