import { and, desc, eq, gte, or, sql } from "drizzle-orm";
import {
  db, facultyMembershipsTable, facultyUsersTable, interpretationsTable, pillarsTable,
  researchDiscoveryCandidatesTable, researchDiscoveryRunsTable, sourcesTable,
} from "@workspace/db";
import { ingestSource } from "./ingestSource.js";
import { autoApproveDiscoveredInterpretation } from "./autoApproveDiscoveredInterpretation.js";
import { logger } from "./logger.js";
import pool from "./db.js";
import { automaticApprovalReviewReason, dedupeResearchRecords, metadataReviewReason, parseCrossrefWorks, parsePubmedXml, type ResearchRecord } from "./researchDiscoveryProviders.js";
import { verifyDiscoveredInterpretationGrounding } from "./researchDiscoveryGrounding.js";

const MAX_PER_PROVIDER = 5;
let discoveryQueue: Promise<void> = Promise.resolve();
function enqueueDiscovery(runId: number): Promise<void> {
  discoveryQueue = discoveryQueue.catch(() => undefined).then(async () => {
    const client = await pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(7349201)");
      await runResearchDiscovery(runId);
    } finally {
      try { await client.query("SELECT pg_advisory_unlock(7349201)"); } finally { client.release(); }
    }
  });
  return discoveryQueue;
}
// Discovery never creates knowledge_relations. Approved interpretations become
// graph nodes through the existing corpus, while graph edges remain explicit
// faculty judgments rather than inferred bibliographic associations.
const apiFetch = async (url: string) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(12_000), headers: { Accept: "application/json", "User-Agent": "PalonurResearchDiscovery/1.0 (metadata-only)" } });
  if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
  return response;
};
const normalDoi = (doi: string | null) => doi?.trim().toLowerCase() || null;

export async function findResearchRecords(name: string, topic: string): Promise<{ records: ResearchRecord[]; providerErrors: string[] }> {
  const query = `${name} ${topic}`.trim();
  const pubmedTask = (async () => { const search = await apiFetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=${MAX_PER_PROVIDER}&term=${encodeURIComponent(query)}`); const ids = ((await search.json()) as { esearchresult?: { idlist?: string[] } }).esearchresult?.idlist ?? []; return ids.length ? parsePubmedXml(await (await apiFetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&retmode=xml&id=${ids.join(",")}`)).text()) : []; })();
  const crossrefTask = (async () => parseCrossrefWorks(await (await apiFetch(`https://api.crossref.org/works?rows=${MAX_PER_PROVIDER}&query.author=${encodeURIComponent(name)}&query.bibliographic=${encodeURIComponent(topic)}`)).json()))();
  const settled = await Promise.allSettled([pubmedTask, crossrefTask]);
  const records = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  const providerErrors = settled.flatMap((result, i) => result.status === "rejected" ? [`${i === 0 ? "PubMed" : "Crossref"} failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`] : []);
  return { records: dedupeResearchRecords(records), providerErrors };
}

export async function startResearchDiscoveryRun(opts: {
  facultyUserId: number; pillarId: number; startedByUserId: number | null;
  facultyName: string; pillarTopic: string;
}): Promise<number> {
  const run = await db.transaction(async (tx) => {
    // Serialize a target's launch across application instances. The active-run
    // partial unique index below remains the durable backstop if a caller
    // bypasses this path.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${opts.facultyUserId}, ${opts.pillarId})`);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [recent] = await tx.select({ id: researchDiscoveryRunsTable.id }).from(researchDiscoveryRunsTable)
      .where(and(eq(researchDiscoveryRunsTable.facultyUserId, opts.facultyUserId), eq(researchDiscoveryRunsTable.pillarId, opts.pillarId), gte(researchDiscoveryRunsTable.createdAt, since))).limit(1);
    if (recent) throw new Error("A discovery run for this faculty member and pillar already started within 24 hours.");
    const [created] = await tx.insert(researchDiscoveryRunsTable).values({ ...opts, status: "pending" }).returning();
    return created!;
  });
  void enqueueDiscovery(run.id).catch(async (err) => {
    logger.warn({ err, runId: run.id }, "Research discovery failed");
    await db.update(researchDiscoveryRunsTable).set({ status: "failed", error: err instanceof Error ? err.message : String(err) }).where(eq(researchDiscoveryRunsTable.id, run.id));
  });
  return run.id;
}

export async function runResearchDiscovery(runId: number): Promise<void> {
  const [run] = await db.select().from(researchDiscoveryRunsTable).where(eq(researchDiscoveryRunsTable.id, runId)).limit(1);
  if (!run) return;
  await db.update(researchDiscoveryRunsTable).set({ status: "discovering", error: null }).where(eq(researchDiscoveryRunsTable.id, runId));
  try {
    const { records, providerErrors } = await findResearchRecords(run.facultyName, run.pillarTopic);
    for (const error of providerErrors) {
      const provider = error.startsWith("PubMed") ? "pubmed" : "crossref";
      await db.insert(researchDiscoveryCandidatesTable).values({
        discoveryRunId: run.id, pillarId: run.pillarId, provider,
        providerId: `provider-error:${run.id}:${provider}`, title: `${provider} provider failure`,
        status: "review", reviewReason: error,
      }).onConflictDoNothing();
    }
    for (const raw of records) await persistRecord(run, { ...raw, doi: normalDoi(raw.doi) });
    await db.update(researchDiscoveryRunsTable).set({ status: records.length ? "done" : "failed", error: providerErrors.length ? providerErrors.join("; ") : null }).where(eq(researchDiscoveryRunsTable.id, runId));
  } catch (err) {
    await db.update(researchDiscoveryRunsTable).set({ status: "failed", error: err instanceof Error ? err.message : String(err) }).where(eq(researchDiscoveryRunsTable.id, runId));
  }
}

async function persistRecord(run: typeof researchDiscoveryRunsTable.$inferSelect, record: ResearchRecord): Promise<void> {
  const duplicate = await db.select({ id: researchDiscoveryCandidatesTable.id }).from(researchDiscoveryCandidatesTable)
    .where(and(eq(researchDiscoveryCandidatesTable.pillarId, run.pillarId), or(
      and(eq(researchDiscoveryCandidatesTable.provider, record.provider), eq(researchDiscoveryCandidatesTable.providerId, record.providerId)),
      record.doi ? eq(researchDiscoveryCandidatesTable.doi, record.doi) : undefined,
    ))).limit(1);
  if (duplicate[0]) return; // persisted uniqueness makes repeated/manual runs idempotent
  const sourceDuplicate = record.doi ? await db.select({ id: sourcesTable.id }).from(sourcesTable)
    .where(and(eq(sourcesTable.pillarId, run.pillarId), eq(sourcesTable.doi, record.doi))).limit(1) : [];
  const reason = sourceDuplicate[0] ? "Duplicate DOI already exists in this pillar." : metadataReviewReason(record);
  const [candidate] = await db.insert(researchDiscoveryCandidatesTable).values({
    discoveryRunId: run.id, pillarId: run.pillarId, ...record,
    status: reason ? (sourceDuplicate[0] ? "duplicate" : "review") : "discovered",
    reviewReason: reason ?? null, sourceId: sourceDuplicate[0]?.id ?? null,
  }).onConflictDoNothing().returning();
  if (!candidate || reason) return;
  try {
    const ingest = await ingestSource({
      pillarId: run.pillarId, uploadedByUserId: run.facultyUserId,
      fullText: record.abstract!, fallbackTitle: record.title,
      meta: { kind: "paper", title: record.title, authors: record.authors, year: record.year,
        journal: record.journal, doi: record.doi, abstract: record.abstract, sourceUrl: record.sourceUrl,
        rightsBasis: "no_documented_full_text_rights" },
    });
    const [interp] = await db.select().from(interpretationsTable).where(eq(interpretationsTable.id, ingest.firstDraftId!)).limit(1);
    const grounding = await verifyDiscoveredInterpretationGrounding({
      title: record.title,
      abstract: record.abstract!,
      interpretation: interp?.interpretation ?? "",
    });
    // Published records that passed the mandatory metadata/retraction checks
    // are automatically approved once a grounded interpretation exists.
    // Topic-fit remains an observable signal for owners, not an approval gate:
    // discovery is already scoped by faculty name + pillar topic, and owners
    // can exclude unwanted matches with a durable rediscovery tombstone.
    const approvalReason = automaticApprovalReviewReason(
      record,
      run.pillarTopic,
      grounding.supported,
    );
    if (approvalReason) {
      await db.update(researchDiscoveryCandidatesTable).set({
        status: "review",
        sourceId: ingest.source.id,
        interpretationId: interp?.id ?? null,
        reviewReason: grounding.supported ? approvalReason : grounding.reason,
      }).where(eq(researchDiscoveryCandidatesTable.id, candidate.id));
      return;
    }
    await autoApproveDiscoveredInterpretation({ sourceId: ingest.source.id, interpretationId: interp!.id });
    await db.update(researchDiscoveryCandidatesTable).set({ status: "auto_approved", sourceId: ingest.source.id, interpretationId: interp!.id, reviewReason: null }).where(eq(researchDiscoveryCandidatesTable.id, candidate.id));
  } catch (err) {
    await db.update(researchDiscoveryCandidatesTable).set({ status: "failed", reviewReason: err instanceof Error ? err.message : String(err) }).where(eq(researchDiscoveryCandidatesTable.id, candidate.id));
  }
}

/** Daily, opt-in and deliberately bounded to one run per faculty/pillar/day. */
export async function runDailyResearchDiscovery(): Promise<void> {
  if (process.env.RESEARCH_DISCOVERY_ENABLED !== "true") return;
  const targets = await db.select({ facultyUserId: facultyUsersTable.id, facultyName: facultyUsersTable.fullName, pillarId: pillarsTable.id, topic: pillarsTable.description, pillarName: pillarsTable.name })
    .from(facultyMembershipsTable).innerJoin(facultyUsersTable, eq(facultyUsersTable.id, facultyMembershipsTable.userId)).innerJoin(pillarsTable, eq(pillarsTable.id, facultyMembershipsTable.pillarId))
    .where(and(eq(facultyMembershipsTable.role, "steward"), sql`${pillarsTable.retiredAt} IS NULL`));
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  for (const target of targets) {
    if (!target.facultyName?.trim()) continue;
    const existing = await db.select({ id: researchDiscoveryRunsTable.id }).from(researchDiscoveryRunsTable)
      .where(and(eq(researchDiscoveryRunsTable.facultyUserId, target.facultyUserId), eq(researchDiscoveryRunsTable.pillarId, target.pillarId), gte(researchDiscoveryRunsTable.createdAt, since))).orderBy(desc(researchDiscoveryRunsTable.createdAt)).limit(1);
    if (!existing[0]) await startResearchDiscoveryRun({ facultyUserId: target.facultyUserId, pillarId: target.pillarId, startedByUserId: null, facultyName: target.facultyName, pillarTopic: target.topic?.trim() || target.pillarName });
  }
}