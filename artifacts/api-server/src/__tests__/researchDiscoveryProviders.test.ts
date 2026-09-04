import { describe, expect, test } from "vitest";
import {
  automaticApprovalReviewReason,
  dedupeResearchRecords,
  parseCrossrefWorks,
  parsePubmedXml,
  type ResearchRecord,
} from "../lib/researchDiscoveryProviders.js";

const valid: ResearchRecord = {
  provider: "pubmed", providerId: "123", doi: "10.1000/example", pmid: "123",
  title: "Sleep intervention study", authors: "Ada Lovelace", journal: "Journal",
  year: 2024, abstract: "This sleep intervention study reports a measured outcome.",
  sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/123/",
};

describe("research discovery providers", () => {
  test("parses PubMed XML abstracts and identifiers without publisher scraping", () => {
    const rows = parsePubmedXml(`<PubmedArticle><PMID>123</PMID><ArticleTitle>Sleep study</ArticleTitle><AbstractText>First result.</AbstractText><AbstractText>Second result.</AbstractText><Journal><Title>Example Journal</Title><PubDate><Year>2024</Year></PubDate></Journal><ArticleId IdType="doi">10.1/X</ArticleId><Author><ForeName>Ada</ForeName><LastName>Lovelace</LastName></Author></PubmedArticle>`);
    expect(rows[0]).toMatchObject({ pmid: "123", doi: "10.1/X", title: "Sleep study", abstract: "First result.\nSecond result.", authors: "Ada Lovelace", year: 2024 });
  });

  test("parses Crossref records and dedupes providers by DOI", () => {
    const [crossref] = parseCrossrefWorks({ message: { items: [{ DOI: "10.1000/EXAMPLE", title: ["Sleep intervention study"], abstract: "<jats:p>result</jats:p>", author: [{ given: "Ada", family: "Lovelace" }], published: { "date-parts": [[2024]] } }] } });
    expect(crossref).toMatchObject({ doi: "10.1000/example", authors: "Ada Lovelace", abstract: "result" });
    expect(dedupeResearchRecords([valid, crossref!])).toHaveLength(1);
  });

  test("only permits complete, on-topic, non-retracted grounded records", () => {
    expect(automaticApprovalReviewReason(valid, "sleep intervention", true)).toBeNull();
    expect(automaticApprovalReviewReason({ ...valid, abstract: null }, "sleep", true)).toMatch(/Missing abstract/);
    expect(automaticApprovalReviewReason({ ...valid, title: "Retracted: Sleep study" }, "sleep", true)).toMatch(/Retraction/);
    expect(automaticApprovalReviewReason(valid, "sleep", false)).toMatch(/grounded/);
    expect(automaticApprovalReviewReason(valid, "sleep", true, true)).toBeNull();
  });
});