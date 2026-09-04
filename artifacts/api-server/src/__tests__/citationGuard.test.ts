import { describe, test, expect } from "vitest";
import { verifyCitation, type ProvenanceEntry } from "../lib/rag.js";

function makeProvenance(over: Partial<ProvenanceEntry> = {}): ProvenanceEntry {
  return {
    source_id: 42,
    interpretation_id: null,
    chunk_ids: [1],
    title: "Sensitivity of the human circadian pacemaker to nocturnal light",
    authors: "Zeitzer JM, Dijk DJ, Kronauer RE, Brown EN, Czeisler CA",
    year: 2000,
    journal: "J Physiol",
    doi: null,
    source_url: null,
    study_design: null,
    pillar_slug: "sleep",
    interpretation_author: null,
    excerpts: [],
    interpretation_note: null,
    reliability: null,
    ...over,
  };
}

const answerWithCitation = (citation: string): string => `ANSWER:
Dim evening light suppresses melatonin and shifts your clock later.

CITATION:
${citation}

PAPER:
"Sensitivity of the human circadian pacemaker to nocturnal light"

FINDING:
Even ~100 lux at night significantly suppresses melatonin.

INTERPRETATION:
Keep evenings dim.

ACTION:
Dim lights two hours before bed.
`;

describe("citation guard", () => {
  test("verified — citation surname + year match a retrieved source", () => {
    const v = verifyCitation(answerWithCitation("Zeitzer et al., 2000, J Physiol"), [
      makeProvenance(),
    ]);
    expect(v.status).toBe("verified");
    expect(v.surname).toBe("Zeitzer");
    expect(v.year).toBe(2000);
    expect(v.matchedSourceIds).toEqual([42]);
  });

  test("verified — formatting variation (no 'et al.') still matches", () => {
    const v = verifyCitation(
      answerWithCitation("Zeitzer JM, 2000, J Physiol"),
      [makeProvenance()],
    );
    expect(v.status).toBe("verified");
    expect(v.matchedSourceIds).toEqual([42]);
  });

  test("unmatched — hallucinated surname (model invented an author)", () => {
    const v = verifyCitation(
      answerWithCitation("Walker et al., 2000, J Physiol"),
      [makeProvenance()],
    );
    expect(v.status).toBe("unmatched");
    expect(v.surname).toBe("Walker");
    expect(v.year).toBe(2000);
    expect(v.matchedSourceIds).toEqual([]);
  });

  test("unmatched — hallucinated year (right author, wrong year)", () => {
    const v = verifyCitation(
      answerWithCitation("Zeitzer et al., 2019, J Physiol"),
      [makeProvenance()],
    );
    expect(v.status).toBe("unmatched");
    expect(v.matchedSourceIds).toEqual([]);
  });

  test("verified — an undated source is cited as n.d.", () => {
    const v = verifyCitation(
      answerWithCitation("Stanford Health Care Sleep Medicine, n.d."),
      [
        makeProvenance({
          source_id: 57,
          title: "Stanford Health Care CBT-I clinical procedures",
          authors: "Stanford Health Care Sleep Medicine",
          year: null,
          journal: "Stanford Health Care",
        }),
      ],
    );
    expect(v.status).toBe("verified");
    expect(v.surname).toBe("Stanford");
    expect(v.year).toBeNull();
    expect(v.matchedSourceIds).toEqual([57]);
  });

  test("unmatched — an undated source cannot be cited with an invented year", () => {
    const v = verifyCitation(
      answerWithCitation("Stanford Health Care Sleep Medicine, 2022"),
      [
        makeProvenance({
          source_id: 57,
          authors: "Stanford Health Care Sleep Medicine",
          year: null,
        }),
      ],
    );
    expect(v.status).toBe("unmatched");
    expect(v.matchedSourceIds).toEqual([]);
  });

  test("unmatched — CITATION present but no parseable surname/year", () => {
    const v = verifyCitation(answerWithCitation("see references"), [
      makeProvenance(),
    ]);
    expect(v.status).toBe("unmatched");
    expect(v.matchedSourceIds).toEqual([]);
  });

  test("missing — no CITATION line at all (malformed answer)", () => {
    const v = verifyCitation("ANSWER:\nSomething.\n", [makeProvenance()]);
    expect(v.status).toBe("missing");
    expect(v.citationLine).toBeNull();
    expect(v.matchedSourceIds).toEqual([]);
  });

  test("verified — Unicode apostrophe in DB matches ASCII in citation", () => {
    const v = verifyCitation(
      answerWithCitation("O'Connor et al., 2018, Sleep Med"),
      [
        makeProvenance({
          source_id: 7,
          authors: "O\u2019Connor PJ, Smith K",
          year: 2018,
          journal: "Sleep Med",
          title: "Aerobic exercise and adult sleep quality",
        }),
      ],
    );
    expect(v.status).toBe("verified");
    expect(v.matchedSourceIds).toEqual([7]);
  });

  test("verified — Unicode en-dash in citation normalizes to ASCII", () => {
    const v = verifyCitation(
      answerWithCitation("Zeitzer et al., 2000, J Physiol \u2013 London"),
      [makeProvenance()],
    );
    expect(v.status).toBe("verified");
    expect(v.matchedSourceIds).toEqual([42]);
  });

  test("verified — 2-letter surname matches an exact author token", () => {
    const v = verifyCitation(
      answerWithCitation("Li et al., 2022; Winer et al., 2024"),
      [
        makeProvenance({
          source_id: 98,
          authors: "Li SB, Damonte VM, Chen C",
          year: 2022,
          title: "Hyperexcitable arousal circuits drive sleep instability during aging",
        }),
      ],
    );
    expect(v.status).toBe("verified");
    expect(v.surname).toBe("Li");
    expect(v.year).toBe(2022);
    expect(v.matchedSourceIds).toEqual([98]);
  });

  test("unmatched — 2-letter surname cannot match inside a longer author name", () => {
    const v = verifyCitation(answerWithCitation("Li, 2020, Sleep"), [
      makeProvenance({
        source_id: 99,
        authors: "Williams J, Lipton A",
        year: 2020,
      }),
    ]);
    expect(v.status).toBe("unmatched");
    expect(v.surname).toBe("Li");
    expect(v.matchedSourceIds).toEqual([]);
  });

  test("same surname + same year — title token tie-breaker picks the right one", () => {
    const v = verifyCitation(
      `ANSWER:\nFlashes shift the clock without waking you.\n\nCITATION:\nZeitzer et al., 2014, J Biol Rhythms\n\nPAPER:\n"Millisecond flashes of light phase delay the human circadian clock during sleep"\n\nFINDING:\nx\n\nINTERPRETATION:\nx\n\nACTION:\nx`,
      [
        makeProvenance({
          source_id: 100,
          authors: "Zeitzer JM, Hon F",
          year: 2014,
          journal: "Other",
          title: "Coherence between actigraphy and polysomnography",
        }),
        makeProvenance({
          source_id: 101,
          authors: "Zeitzer JM, Fisicaro RA",
          year: 2014,
          journal: "J Biol Rhythms",
          title:
            "Millisecond flashes of light phase delay the human circadian clock during sleep",
        }),
      ],
    );
    expect(v.status).toBe("verified");
    expect(v.matchedSourceIds).toEqual([101]);
  });

  test("same surname + same year — both kept when tie-breaker cannot disambiguate", () => {
    // No PAPER line and no journal tokens overlap → both candidates survive.
    const v = verifyCitation(
      "ANSWER:\nx.\n\nCITATION:\nZeitzer et al., 2014\n",
      [
        makeProvenance({
          source_id: 200,
          authors: "Zeitzer JM",
          year: 2014,
          journal: "J Foo",
          title: "Paper A",
        }),
        makeProvenance({
          source_id: 201,
          authors: "Zeitzer JM",
          year: 2014,
          journal: "J Bar",
          title: "Paper B",
        }),
      ],
    );
    expect(v.status).toBe("verified");
    expect(new Set(v.matchedSourceIds)).toEqual(new Set([200, 201]));
  });

  test("verified — Jamie's 2026 Stanford interview (slm_article) cites cleanly", () => {
    // The screens-before-bed interview is a published interview, not a
    // journal paper; the citation guard only cares about surname + year, so
    // it must verify against the interview's provenance just like a paper.
    const v = verifyCitation(
      `ANSWER:\nFor adults it's the content, not the screen light.\n\nCITATION:\nZeitzer, 2026, Stanford Lifestyle Medicine\n\nPAPER:\n"Screen Time and Sleep — It's Different for Adults"\n\nFINDING:\nx\n\nINTERPRETATION:\nx\n\nACTION:\nx`,
      [
        makeProvenance({
          source_id: 314,
          authors: "Zeitzer JM",
          year: 2026,
          journal: "Stanford Lifestyle Medicine",
          title: "Screen Time and Sleep — It's Different for Adults",
        }),
      ],
    );
    expect(v.status).toBe("verified");
    expect(v.surname).toBe("Zeitzer");
    expect(v.year).toBe(2026);
    expect(v.matchedSourceIds).toEqual([314]);
  });

  test("verified — picks the right source when several are retrieved", () => {
    const v = verifyCitation(
      answerWithCitation("Hilditch et al., 2019, Nat Sci Sleep"),
      [
        makeProvenance({ source_id: 11, authors: "Zeitzer JM", year: 2000 }),
        makeProvenance({
          source_id: 22,
          authors: "Hilditch CJ, McHill AW",
          year: 2019,
          journal: "Nat Sci Sleep",
        }),
        makeProvenance({ source_id: 33, authors: "Cain SW", year: 2020 }),
      ],
    );
    expect(v.status).toBe("verified");
    expect(v.matchedSourceIds).toEqual([22]);
  });
});
