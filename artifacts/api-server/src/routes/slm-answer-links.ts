/**
 * Answer permalinks for the /slm public ask surface.
 *
 * POST /api/slm-answer-links { queryId }  → { id }
 * GET  /api/slm-answer-links/:id          → { question, answer, citations, createdAt }
 *
 * A permalink is a public, read-only snapshot of an answer the visitor
 * already received: question, raw answer text, and PUBLIC citation fields
 * only. Snapshotting happens at creation time (from the persisted
 * agent_queries row plus the sources table) so a shared link keeps working
 * even if the underlying sources are later edited or archived.
 *
 * Boundaries:
 *   - only 'slm-agent' rows are shareable (never steward/preview surfaces),
 *   - REFUSE answers are never shareable (boundaries, not refusals),
 *   - citations expose only { title, authors, year, journal, doi,
 *     source_url, pillar_slug } — no excerpts, scores, interpretation ids,
 *     or steward-internal data,
 *   - same-work provenance collapse is applied at this display boundary,
 *   - creation is rate limited per req.ip (trust proxy = 1 is set app-wide).
 */
import { Router, type IRouter } from "express";
import { randomBytes } from "node:crypto";
import { pool } from "@workspace/db";
import {
  collapseSameWorkProvenance,
  type ProvenanceEntry,
} from "../lib/rag.js";

const router: IRouter = Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LINK_ID_RE = /^[A-Za-z0-9_-]{10,64}$/;

/** Public citation shape stored in the snapshot. Nothing else may leak. */
export interface PublicCitation {
  title: string;
  authors: string | null;
  year: number | null;
  journal: string | null;
  doi: string | null;
  source_url: string | null;
  pillar_slug: string;
}

// ── Per-IP creation budget (in-memory sliding window) ──────────────────────
// Same single-process tradeoff as the other in-memory counters. Keyed on
// req.ip (never x-forwarded-for parsing — trust proxy handles that).
const IP_WINDOW_MS = 60 * 60 * 1000;
const IP_LIMIT = (() => {
  const raw = Number(process.env.SLM_SHARE_LINK_IP_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? raw : 20;
})();
const ipHits = new Map<string, number[]>();

function overIpBudget(ip: string): boolean {
  const now = Date.now();
  const hits = (ipHits.get(ip) ?? []).filter((t) => now - t < IP_WINDOW_MS);
  if (hits.length >= IP_LIMIT) {
    ipHits.set(ip, hits);
    return true;
  }
  hits.push(now);
  ipHits.set(ip, hits);
  if (ipHits.size > 5000) {
    for (const [k, v] of ipHits) {
      if (v.every((t) => now - t >= IP_WINDOW_MS)) ipHits.delete(k);
    }
  }
  return false;
}

interface QueryRow {
  id: string;
  question: string;
  answer_text: string;
  retrieved_source_ids: number[];
}

/**
 * The agent_queries insert is best-effort AFTER res.end() on the slm route,
 * so a share fired the moment the answer finishes can race it. Retry
 * briefly, then give up with a clean 404.
 */
async function lookupSlmQueryWithRetry(queryId: string): Promise<QueryRow | null> {
  const delays = [0, 700, 1400];
  for (const delay of delays) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    const result = await pool.query(
      `SELECT id, question, answer_text, retrieved_source_ids
         FROM agent_queries
        WHERE id = $1::uuid AND source = 'slm-agent'
        LIMIT 1`,
      [queryId],
    );
    if (result.rows[0]) return result.rows[0] as QueryRow;
  }
  return null;
}

/** Rebuild PUBLIC citations from the sources table, same-work-collapsed. */
async function buildPublicCitations(sourceIds: number[]): Promise<PublicCitation[]> {
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) return [];
  const ids = sourceIds.filter((n) => Number.isInteger(n));
  if (ids.length === 0) return [];
  const result = await pool.query(
    `SELECT s.id, s.title, s.authors, s.year, s.journal, s.doi,
            s.source_url, p.slug AS pillar_slug
       FROM sources s
       JOIN pillars p ON p.id = s.pillar_id
      WHERE s.id = ANY($1::int[])
        AND s.is_canary = FALSE`,
    [ids],
  );
  // Feed minimal ProvenanceEntry values through the shared display-boundary
  // collapse so a chapter-split book shows as one citation on permalinks too.
  const entries: ProvenanceEntry[] = result.rows.map((r) => ({
    source_id: r.id as number,
    interpretation_id: null,
    chunk_ids: [],
    title: r.title as string,
    authors: (r.authors as string | null) ?? null,
    year: (r.year as number | null) ?? null,
    journal: (r.journal as string | null) ?? null,
    doi: (r.doi as string | null) ?? null,
    source_url: (r.source_url as string | null) ?? null,
    study_design: null,
    pillar_slug: r.pillar_slug as string,
    interpretation_author: null,
    excerpts: [],
    interpretation_note: null,
    reliability: null,
  }));
  return collapseSameWorkProvenance(entries).map((e) => ({
    title: e.title,
    authors: e.authors,
    year: e.year,
    journal: e.journal,
    doi: e.doi,
    source_url: e.source_url,
    pillar_slug: e.pillar_slug,
  }));
}

// ── POST /api/slm-answer-links ──────────────────────────────────────────────
router.post("/slm-answer-links", async (req, res): Promise<void> => {
  const { queryId } = (req.body ?? {}) as { queryId?: unknown };
  if (typeof queryId !== "string" || !UUID_RE.test(queryId)) {
    res.status(400).json({ error: "queryId required" });
    return;
  }

  const ip = req.ip ?? "unknown";
  if (overIpBudget(ip)) {
    res.status(429).json({
      error: "Too many share links created. Please try again in an hour.",
    });
    return;
  }

  try {
    // Idempotent: sharing the same answer twice returns the same link.
    const existing = await pool.query(
      `SELECT id FROM slm_answer_links WHERE query_id = $1::uuid LIMIT 1`,
      [queryId],
    );
    if (existing.rows[0]) {
      res.json({ id: existing.rows[0].id as string });
      return;
    }

    const row = await lookupSlmQueryWithRetry(queryId);
    if (!row) {
      res.status(404).json({ error: "Answer not found" });
      return;
    }
    if (row.answer_text.trim().startsWith("REFUSE:")) {
      res.status(422).json({ error: "This answer cannot be shared" });
      return;
    }

    const citations = await buildPublicCitations(row.retrieved_source_ids ?? []);
    const id = randomBytes(16).toString("base64url");
    const inserted = await pool.query(
      `INSERT INTO slm_answer_links (id, query_id, question, answer_text, citations)
       VALUES ($1, $2::uuid, $3, $4, $5::jsonb)
       ON CONFLICT (query_id) DO NOTHING
       RETURNING id`,
      [id, row.id, row.question, row.answer_text, JSON.stringify(citations)],
    );
    if (inserted.rows[0]) {
      res.json({ id: inserted.rows[0].id as string });
      return;
    }
    // Lost a concurrent-create race — return the winner's id.
    const winner = await pool.query(
      `SELECT id FROM slm_answer_links WHERE query_id = $1::uuid LIMIT 1`,
      [queryId],
    );
    res.json({ id: winner.rows[0]?.id as string });
  } catch (e) {
    req.log.error({ err: e }, "slm-answer-links create failed");
    res.status(500).json({ error: "Could not create the share link" });
  }
});

// ── GET /api/slm-answer-links/:id ───────────────────────────────────────────
router.get("/slm-answer-links/:id", async (req, res): Promise<void> => {
  const { id } = req.params;
  if (!LINK_ID_RE.test(id)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  try {
    const result = await pool.query(
      `SELECT question, answer_text, citations, created_at
         FROM slm_answer_links
        WHERE id = $1
        LIMIT 1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({
      question: row.question as string,
      answer: row.answer_text as string,
      citations: (row.citations ?? []) as PublicCitation[],
      createdAt: row.created_at as string,
    });
  } catch (e) {
    req.log.error({ err: e }, "slm-answer-links fetch failed");
    res.status(500).json({ error: "Could not load the answer" });
  }
});

export default router;
