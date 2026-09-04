import { syncSchemaAdditive } from "@workspace/db/sync-schema";
import pool from "../lib/db.js";

/**
 * Shared schema bootstrap for the api-server tests.
 *
 * Tests import `app.ts`, not `index.ts`, so the boot-time DDL never runs and the
 * test DB can lag the Drizzle schema after a schema-changing merge — a single
 * missing column on a hot table reds dozens of suites with "column does not
 * exist". Rather than hand-maintaining a parallel copy of the schema here (the
 * old whack-a-mole: one ALTER per new column), we delegate to the shared
 * `syncSchemaAdditive` engine, which derives every additive change straight from
 * the Drizzle metadata. New columns/tables/indexes/enum values are picked up
 * automatically — no edit to this file required.
 *
 * Idempotent and race-tolerant (safe across parallel vitest workers). Silent by
 * default so it doesn't spam test output.
 */
export async function ensureCaptureLoopSchema(): Promise<void> {
  await syncSchemaAdditive(pool);
}

/**
 * Talk-crawl schema bootstrap. Kept as a distinct export for the talk-crawl
 * suites, but the talk-crawl tables/columns/enums live in the same Drizzle
 * barrel, so the additive sync covers them too — this is now just an alias.
 */
export async function ensureTalkCrawlSchema(): Promise<void> {
  await syncSchemaAdditive(pool);
}

/**
 * Steward voice-profile schema bootstrap. `faculty_voice_profiles` + its enum
 * live in the same Drizzle barrel, so the additive sync provisions them too —
 * this is a named alias for the voice-profile suite's readability.
 */
export async function ensureVoiceProfileSchema(): Promise<void> {
  await syncSchemaAdditive(pool);
}

/**
 * Poll until the best-effort `agent_queries` insert lands. The route
 * fires the insert after `res.end()` so the test can race ahead of it
 * if we don't wait.
 */
export async function waitForAgentQueryRow(
  pool_: typeof pool,
  queryId: string,
): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const { rowCount } = await pool_.query(
      `SELECT 1 FROM agent_queries WHERE id = $1::uuid`,
      [queryId],
    );
    if (rowCount && rowCount > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for agent_queries row ${queryId}`);
}

/** Pull the queryId out of the last `data:` line that carries one. */
export function parseSseQueryId(text: string): string {
  let queryId = "";
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const obj = JSON.parse(line.slice(6)) as { queryId?: string };
      if (obj.queryId) queryId = obj.queryId;
    } catch {
      // ignore non-JSON SSE lines
    }
  }
  return queryId;
}

/** Collect every JSON object emitted as an SSE `data:` line. */
export function parseSseEvents(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      out.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
    } catch {
      // ignore non-JSON SSE lines
    }
  }
  return out;
}

/**
 * Deterministic 384-dim unit vector keyed by topic words. Two texts
 * that share a topic word land on the same axis → cosine similarity 1
 * (well above the RAG threshold). Unrelated texts land on different
 * axes → similarity 0. Keep topic axes disjoint across tests.
 */
export function makeTopicEmbedding(text: string): number[] {
  const v = new Array(384).fill(0);
  if (/melatonin|circadian|light/i.test(text)) {
    v[10] = 1;
  } else if (/tinnitus/i.test(text)) {
    v[0] = 1;
    v[1] = 0.05;
  } else if (/concentration|focus/i.test(text)) {
    v[3] = 1;
  } else {
    v[20] = 1;
  }
  return v;
}
