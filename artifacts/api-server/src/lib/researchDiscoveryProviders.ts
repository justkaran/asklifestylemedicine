/** Provider-normalized metadata. Only provider APIs, identifiers and abstracts
 * are used by the discovery pipeline; publisher landing pages are never read. */
export type ResearchRecord = {
  provider: "pubmed" | "crossref";
  providerId: string;
  doi: string | null;
  pmid: string | null;
  title: string;
  authors: string | null;
  journal: string | null;
  year: number | null;
  abstract: string | null;
  sourceUrl: string | null;
};

const stripTags = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
const xml = (text: string, tag: string) =>
  Array.from(text.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi")))
    .map((m) => decode(stripTags(m[1] ?? ""))).filter(Boolean);

export function parsePubmedXml(xmlText: string): ResearchRecord[] {
  return xmlText.split(/<PubmedArticle>/i).slice(1).map((article) => {
    const pmid = xml(article, "PMID")[0] ?? null;
    const title = xml(article, "ArticleTitle")[0] ?? "";
    const abstract = xml(article, "AbstractText").join("\n") || null;
    const doi = (article.match(/<ArticleId IdType="doi">([\s\S]*?)<\/ArticleId>/i)?.[1] ?? "").trim() || null;
    const names = Array.from(article.matchAll(/<Author[\s\S]*?<\/Author>/gi)).map((a) => {
      const last = xml(a[0], "LastName")[0]; const fore = xml(a[0], "ForeName")[0];
      return [fore, last].filter(Boolean).join(" ");
    }).filter(Boolean).join(", ") || null;
    const yearText = xml(article, "PubDate")[0]?.match(/\b(19|20)\d{2}\b/)?.[0] ?? xml(article, "Year")[0];
    return { provider: "pubmed" as const, providerId: pmid ?? doi ?? title, doi, pmid, title, authors: names,
      journal: xml(article, "Title")[0] ?? null, year: yearText ? Number(yearText) : null, abstract,
      sourceUrl: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : null };
  }).filter((r) => r.providerId && r.title);
}

export function parseCrossrefWorks(payload: unknown): ResearchRecord[] {
  const items = (payload as { message?: { items?: Array<Record<string, unknown>> } })?.message?.items ?? [];
  return items.map((item) => {
    const doi = typeof item.DOI === "string" ? item.DOI.toLowerCase() : null;
    const title = Array.isArray(item.title) ? String(item.title[0] ?? "") : "";
    const authors = Array.isArray(item.author) ? item.author.map((a) => {
      const x = a as { given?: string; family?: string };
      return [x.given, x.family].filter(Boolean).join(" ");
    }).filter(Boolean).join(", ") || null : null;
    const parts = (item.published as { ["date-parts"]?: number[][] } | undefined)?.["date-parts"]?.[0];
    return { provider: "crossref" as const, providerId: doi ?? String(item.URL ?? title), doi, pmid: null, title,
      authors, journal: Array.isArray(item["container-title"]) ? String(item["container-title"][0] ?? "") || null : null,
      year: parts?.[0] ?? null, abstract: typeof item.abstract === "string" ? stripTags(item.abstract) : null,
      sourceUrl: typeof item.URL === "string" ? item.URL : (doi ? `https://doi.org/${doi}` : null) };
  }).filter((r) => r.providerId && r.title);
}

export function metadataReviewReason(record: ResearchRecord): string | null {
  if (!record.title.trim()) return "Missing title.";
  if (!record.abstract?.trim()) return "Missing abstract; metadata-only records require steward review.";
  if (!record.doi && !record.pmid) return "Missing DOI/PMID.";
  if (/\b(retract(ed|ion)?|expression of concern)\b/i.test(`${record.title} ${record.abstract}`)) return "Retraction or expression-of-concern signal.";
  return null;
}
const TOPIC_STOPWORDS = new Set(["about", "advance", "based", "disease", "education", "evidence", "health", "lifestyle", "medicine", "medicine", "outcomes", "research", "stanford", "support", "their", "these", "through", "wellbeing", "with"]);
export function topicKeywords(topic: string): string[] {
  return [...new Set((topic.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((x) => !TOPIC_STOPWORDS.has(x)))];
}
export function discoveryReviewReason(record: ResearchRecord, topic: string): string | null {
  const metadata = metadataReviewReason(record);
  if (metadata) return metadata;
  if (!hasDeterministicMetadataTopicMatch(record, topic)) return "Off-topic or ambiguous topic fit.";
  return null;
}

/** Pure run-local dedupe; database unique indexes provide the concurrent,
 * persisted counterpart. DOI wins so PubMed/Crossref representations collapse. */
export function dedupeResearchRecords(records: ResearchRecord[]): ResearchRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = record.doi ? `doi:${record.doi.trim().toLowerCase()}` : `${record.provider}:${record.providerId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Published discovery records auto-approve once metadata is safe and the
 * generated interpretation is grounded. Topic-fit is observe-only; the owner
 * can exclude a false or unwanted match without allowing rediscovery. */
export function automaticApprovalReviewReason(record: ResearchRecord, _topic: string, groundedClaim: boolean, _offTopicSuspect = false): string | null {
  const metadataReason = metadataReviewReason(record);
  if (metadataReason) return metadataReason;
  if (!groundedClaim) return "Unable to generate a grounded interpretation claim.";
  return null;
}

/** A deliberately simple, explainable fallback when vector topic fitting is
 * unavailable: two substantial pillar-topic terms must occur in the record. */
export function hasDeterministicMetadataTopicMatch(record: ResearchRecord, topic: string): boolean {
  const terms = topicKeywords(topic);
  const haystack = `${record.title} ${record.abstract ?? ""}`.toLowerCase();
  return terms.length >= 2 && terms.filter((term) => haystack.includes(term)).length >= 2;
}