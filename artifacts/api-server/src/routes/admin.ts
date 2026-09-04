import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import pool from "../lib/db";
import { sendMorningCheckin } from "../lib/email";
import {
  runWeeklyPortraits,
  runNudgeEmails,
  runWeeklyReflections,
} from "../lib/jobs";
import {
  verifyCitation,
  type ProvenanceEntry,
  type CitationVerificationStatus,
} from "../lib/rag";
import { emailGuardStatus, emailVolumeByLabel } from "../lib/emailGuard";
import { getFacultyRoster, getPillarOverview } from "../lib/facultyOverview";
import { getStripeMode } from "../lib/stripeClient";
import {
  getPillarIngestionSummaries,
  getPillarDocuments,
  verifyPillarSelfRetrieval,
  TOPIC_FIT_MIN_SCORE,
} from "../lib/ingestionHealth";
import { EMBEDDING_MODEL } from "../lib/embeddings";
import { RAG_MIN_SCORE } from "../lib/ragThreshold";

const router: IRouter = Router();

export function checkAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.signedCookies?.palonur_admin === "1") return next();
  return res.status(401).json({ error: "Unauthorized" });
}

// Simple in-memory rate limiter for email-sending endpoints (max 1 trigger per 5 min per IP)
const emailRateMap = new Map<string, number>();
function rateLimitEmail(req: Request, res: Response, next: NextFunction) {
  const ip =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
    req.socket.remoteAddress ??
    "unknown";
  const last = emailRateMap.get(ip) ?? 0;
  const now = Date.now();
  if (now - last < 5 * 60 * 1000) {
    return res
      .status(429)
      .json({ error: "Rate limit: wait 5 minutes between email sends" });
  }
  emailRateMap.set(ip, now);
  return next();
}

// Read-only Stripe mode indicator. Reports whether THIS environment is wired to
// a TEST/sandbox or LIVE Stripe account (derived from the key prefix) so the
// admin always knows whether real cards can be charged. Never exposes the key.
router.get("/admin/stripe-mode", checkAdmin, async (_req, res) => {
  try {
    return res.json(await getStripeMode());
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

// Lightweight probe so a page holding the `palonur_admin` cookie (e.g. set by
// the command-center bridge) can confirm it is authenticated without firing the
// heavier overview/users queries or prompting for the password again.
router.get("/admin/session", checkAdmin, (_req, res) => {
  return res.json({ ok: true });
});

// ── Ingestion Health (Task #475) ────────────────────────────────────────
// Per-pillar ingestion/embedding health summaries for the admin dashboard.
// Read-only aggregates; never mutates chunks or embeddings.
router.get("/admin/ingestion-health", checkAdmin, async (req, res) => {
  try {
    const pillars = await getPillarIngestionSummaries();
    return res.json({
      pillars,
      embeddingModel: EMBEDDING_MODEL,
      retrievalThreshold: RAG_MIN_SCORE,
      topicFitThreshold: TOPIC_FIT_MIN_SCORE,
    });
  } catch (e) {
    req.log.error({ err: e }, "ingestion-health summary failed");
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

// Per-document drill-down for one pillar. Lazily topic-fit-scores a small
// batch of historical (never-scored) documents on each read.
router.get(
  "/admin/ingestion-health/pillars/:id/documents",
  checkAdmin,
  async (req, res) => {
    const pillarId = Number(req.params.id);
    if (!Number.isInteger(pillarId) || pillarId <= 0) {
      return res.status(400).json({ error: "Invalid pillar id" });
    }
    try {
      const documents = await getPillarDocuments(pillarId);
      return res.json({
        documents,
        topicFitThreshold: TOPIC_FIT_MIN_SCORE,
      });
    } catch (e) {
      req.log.error({ err: e, pillarId }, "ingestion-health documents failed");
      return res.status(500).json({ error: String((e as Error).message) });
    }
  },
);

// One-click self-retrieval verification probe: re-embed a stored chunk per
// document and confirm it retrieves its own document above the retrieval
// threshold. Read-only.
router.post(
  "/admin/ingestion-health/pillars/:id/verify",
  checkAdmin,
  async (req, res) => {
    const pillarId = Number(req.params.id);
    if (!Number.isInteger(pillarId) || pillarId <= 0) {
      return res.status(400).json({ error: "Invalid pillar id" });
    }
    try {
      const report = await verifyPillarSelfRetrieval(pillarId);
      return res.json(report);
    } catch (e) {
      req.log.error({ err: e, pillarId }, "ingestion-health verify failed");
      return res.status(500).json({ error: String((e as Error).message) });
    }
  },
);

// Read-only Stewards & Pillars overview for the internal Palonur admin. The
// faculty portal has its own Clerk-gated management surface for this data; here
// we only surface it (no create/edit/delete) behind the shared `palonur_admin`
// cookie, reusing the exact same read models so the numbers can't drift.
router.get("/admin/faculty", checkAdmin, async (_req, res) => {
  try {
    const [members, pillars] = await Promise.all([
      getFacultyRoster(),
      getPillarOverview(),
    ]);
    return res.json({ members, pillars });
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

// OTL dashboard login audit — every successful shared-password login to the
// Stanford OTL governance dashboard, newest first, with coarse IP geolocation
// so the admin can see whether OTL has opened the dashboard and from where.
router.get("/admin/otl-logins", checkAdmin, async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, created_at, via, ip, country, country_code, city, user_agent
         FROM otl_login_events
        ORDER BY created_at DESC
        LIMIT 200`,
    );
    return res.json({
      events: r.rows.map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        via: row.via,
        ip: row.ip,
        country: row.country,
        countryCode: row.country_code,
        city: row.city,
        userAgent: row.user_agent,
      })),
    });
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

// Governance & Accountability — live accountability aggregates backing the
// /admin Governance tab. The statement itself (authority source, allowed
// claims, information control, accountability) is rendered client-side and
// mirrored in the OTL brief; this endpoint supplies the LIVE numbers proving
// each pillar of the statement, computed over existing tables only.
router.get("/admin/governance", checkAdmin, async (_req, res) => {
  try {
    const [stewards, pillars, sources, interps, citation, otlAudit, queries] =
      await Promise.all([
        pool.query<{ total: number; onboarded: number }>(
          `SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE onboarded_at IS NOT NULL)::int AS onboarded
             FROM faculty_users
            WHERE deactivated_at IS NULL`,
        ),
        pool.query<{ active: number; retired: number }>(
          `SELECT COUNT(*) FILTER (WHERE retired_at IS NULL)::int  AS active,
                  COUNT(*) FILTER (WHERE retired_at IS NOT NULL)::int AS retired
             FROM pillars`,
        ),
        pool.query<{ total: number; approved: number }>(
          `SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE status = 'approved')::int AS approved
             FROM sources`,
        ),
        pool.query<{ total: number; approved: number; proposed: number }>(
          `SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
                  COUNT(*) FILTER (WHERE status = 'proposed')::int AS proposed
             FROM interpretations`,
        ),
        pool.query<{ key: string | null; n: number }>(
          `SELECT citation_verification AS key, COUNT(*)::int AS n
             FROM eval_items
            WHERE run_id = (
              SELECT id FROM eval_runs WHERE completed_at IS NOT NULL
               ORDER BY completed_at DESC LIMIT 1
            )
              AND citation_verification IS NOT NULL
            GROUP BY 1`,
        ),
        pool.query<{ total: number; last_at: string | null }>(
          `SELECT COUNT(*)::int AS total, MAX(created_at) AS last_at
             FROM otl_login_events`,
        ),
        pool.query<{ total: number; covered: number }>(
          `SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE was_uncovered = FALSE)::int AS covered
             FROM agent_queries`,
        ),
      ]);

    const cv = new Map(citation.rows.map((r) => [r.key ?? "", r.n]));
    const verified = cv.get("verified") ?? 0;
    const unmatched = cv.get("unmatched") ?? 0;
    const missing = cv.get("missing") ?? 0;
    const cvDenom = verified + unmatched + missing;

    return res.json({
      stewards: {
        total: stewards.rows[0].total,
        onboarded: stewards.rows[0].onboarded,
      },
      pillars: {
        active: pillars.rows[0].active,
        retired: pillars.rows[0].retired,
      },
      content: {
        sourcesTotal: sources.rows[0].total,
        sourcesApproved: sources.rows[0].approved,
        interpretationsTotal: interps.rows[0].total,
        interpretationsApproved: interps.rows[0].approved,
        interpretationsPending: interps.rows[0].proposed,
      },
      citationHealth: {
        verified,
        unmatched,
        missing,
        verifiedRate: cvDenom > 0 ? verified / cvDenom : null,
      },
      audit: {
        otlLogins: otlAudit.rows[0].total,
        otlLastAccessAt: otlAudit.rows[0].last_at,
        questionsLogged: queries.rows[0].total,
        questionsCovered: queries.rows[0].covered,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

router.get("/admin/overview", checkAdmin, async (_req, res) => {
  try {
    const [
      users,
      questions,
      commitments,
      checkinUsers,
      commitUsers,
      avg,
      retention,
      eligible,
    ] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS total FROM palonur_users"),
      pool.query("SELECT COUNT(*)::int AS total FROM palonur_interactions"),
      pool.query("SELECT COUNT(*)::int AS total FROM palonur_commitments"),
      pool.query(
        "SELECT COUNT(DISTINCT user_id)::int AS total FROM palonur_checkins",
      ),
      pool.query(
        "SELECT COUNT(DISTINCT user_id)::int AS total FROM palonur_commitments",
      ),
      pool.query(`
          SELECT ROUND(
            COUNT(*)::numeric / NULLIF((SELECT COUNT(*) FROM palonur_users), 0), 1
          ) AS avg FROM palonur_interactions
        `),
      pool.query(`
          SELECT COUNT(DISTINCT u.id)::int AS retained
          FROM palonur_users u
          WHERE u.created_at <= NOW() - INTERVAL '7 days'
          AND EXISTS (
            SELECT 1 FROM (
              SELECT user_id, created_at FROM palonur_interactions
              UNION ALL
              SELECT user_id, created_at FROM palonur_sleep_logs
              UNION ALL
              SELECT user_id, created_at FROM palonur_checkins
            ) activity
            WHERE activity.user_id = u.id
              AND activity.created_at >= u.created_at + INTERVAL '7 days'
          )
        `),
      pool.query(`
          SELECT COUNT(*)::int AS total FROM palonur_users
          WHERE created_at <= NOW() - INTERVAL '7 days'
        `),
    ]);

    return res.json({
      totalUsers: users.rows[0].total,
      totalQuestions: questions.rows[0].total,
      totalCommitments: commitments.rows[0].total,
      avgQuestionsPerUser: parseFloat(avg.rows[0].avg ?? "0"),
      checkinUsers: checkinUsers.rows[0].total,
      commitUsers: commitUsers.rows[0].total,
      retained7d: retention.rows[0].retained,
      eligible7d: eligible.rows[0].total,
    });
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

router.get("/admin/users", checkAdmin, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.id, u.first_name, u.email, u.created_at,
        COUNT(DISTINCT i.id)::int  AS question_count,
        COUNT(DISTINCT sl.id)::int AS sleep_log_count,
        COUNT(DISTINCT c.id)::int  AS commitment_count,
        COUNT(DISTINCT ck.id)::int AS checkin_count,
        GREATEST(
          MAX(i.created_at),
          MAX(sl.created_at),
          MAX(c.created_at),
          MAX(ck.created_at)
        ) AS last_active
      FROM palonur_users u
      LEFT JOIN palonur_interactions  i  ON i.user_id  = u.id
      LEFT JOIN palonur_sleep_logs    sl ON sl.user_id = u.id
      LEFT JOIN palonur_commitments   c  ON c.user_id  = u.id
      LEFT JOIN palonur_checkins      ck ON ck.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);
    return res.json(result.rows);
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

router.get("/admin/user/:id", checkAdmin, async (req, res) => {
  const uid = parseInt(String(req.params.id), 10);
  if (isNaN(uid)) return res.status(400).json({ error: "invalid id" });
  try {
    const [user, questions, sleepLogs, commitments, checkins] =
      await Promise.all([
        pool.query(
          "SELECT id, first_name, email, created_at FROM palonur_users WHERE id = $1",
          [uid],
        ),
        pool.query(
          `SELECT id, original_question, clarify_question, clarify_answer,
                ai_answer, article_url, created_at
         FROM palonur_interactions WHERE user_id = $1 ORDER BY created_at DESC`,
          [uid],
        ),
        pool.query(
          `SELECT id, log_date, quality, note, created_at
         FROM palonur_sleep_logs WHERE user_id = $1 ORDER BY log_date DESC`,
          [uid],
        ),
        pool.query(
          `SELECT id, action_text, sleep_question, created_at
         FROM palonur_commitments WHERE user_id = $1 ORDER BY created_at DESC`,
          [uid],
        ),
        pool.query(
          `SELECT id, checkin_date, did_it, commitment_id, created_at
         FROM palonur_checkins WHERE user_id = $1 ORDER BY checkin_date DESC`,
          [uid],
        ),
      ]);
    if (!user.rows.length)
      return res.status(404).json({ error: "User not found" });
    return res.json({
      user: user.rows[0],
      questions: questions.rows,
      sleepLogs: sleepLogs.rows,
      commitments: commitments.rows,
      checkins: checkins.rows,
    });
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

router.get("/admin/export", checkAdmin, async (req, res) => {
  const format = (req.query.format as string) ?? "json";
  try {
    const result = await pool.query(`
      SELECT
        u.first_name, u.email,
        i.original_question, i.clarify_question, i.clarify_answer,
        i.ai_answer, i.article_url, i.created_at,
        sl.log_date, sl.quality, sl.note,
        c.action_text AS commitment_action,
        ck.checkin_date, ck.did_it
      FROM palonur_interactions i
      JOIN palonur_users u ON u.id = i.user_id
      LEFT JOIN palonur_sleep_logs sl ON sl.user_id = i.user_id
        AND sl.log_date = i.created_at::date
      LEFT JOIN palonur_commitments c ON c.user_id = i.user_id
        AND c.created_at >= i.created_at - INTERVAL '5 minutes'
        AND c.created_at <= i.created_at + INTERVAL '1 day'
      LEFT JOIN palonur_checkins ck ON ck.commitment_id = c.id
        AND ck.checkin_date = (i.created_at + INTERVAL '1 day')::date
      ORDER BY i.created_at DESC
    `);

    if (format === "csv") {
      const cols = [
        "first_name",
        "email",
        "asked_at",
        "question",
        "clarify_question",
        "clarify_answer",
        "ai_answer",
        "article_url",
        "sleep_quality",
        "sleep_note",
        "commitment_action",
        "checkin_date",
        "did_it",
      ];
      const escape = (v: unknown) => {
        if (v == null) return "";
        const s = String(v).replace(/"/g, '""');
        return s.includes(",") || s.includes('"') || s.includes("\n")
          ? `"${s}"`
          : s;
      };
      const rows = result.rows.map((r) =>
        [
          r.first_name,
          r.email,
          r.created_at,
          r.original_question,
          r.clarify_question,
          r.clarify_answer,
          r.ai_answer,
          r.article_url,
          r.quality,
          r.note,
          r.commitment_action,
          r.checkin_date,
          r.did_it,
        ]
          .map(escape)
          .join(","),
      );
      const csv = [cols.join(","), ...rows].join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="palonur_export_${new Date().toISOString().slice(0, 10)}.csv"`,
      );
      return res.send(csv);
    }

    // JSONL — OpenAI fine-tune format: one JSON object per line
    const allInteractions = await pool.query(`
      SELECT
        i.original_question, i.clarify_question, i.clarify_answer, i.ai_answer,
        i.article_url, i.created_at,
        u.email
      FROM palonur_interactions i
      JOIN palonur_users u ON u.id = i.user_id
      ORDER BY i.created_at DESC
    `);

    const lines = allInteractions.rows.map((r) => {
      const userContent =
        r.clarify_question && r.clarify_answer
          ? `${r.original_question}\n\nFollow-up Q: ${r.clarify_question}\nFollow-up A: ${r.clarify_answer}`
          : r.original_question;
      return JSON.stringify({
        messages: [
          {
            role: "system",
            content:
              "You are a sleep health assistant grounded in the published research of Prof. Jamie Zeitzer at Stanford.",
          },
          { role: "user", content: userContent },
          { role: "assistant", content: r.ai_answer },
        ],
        metadata: {
          article_url: r.article_url ?? null,
          asked_at: r.created_at,
        },
      });
    });

    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="palonur_training_${new Date().toISOString().slice(0, 10)}.jsonl"`,
    );
    return res.send(lines.join("\n"));
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

// ─── Pilot audit trail ─────────────────────────────────────────────────
//
// A reviewer-facing, exportable provenance trail built entirely from the
// existing per-question `agent_queries` log. Every public agent answer is
// already captured with the question, retrieved source/interpretation IDs,
// top retrieval score, the uncovered flag, and any user flag. This surface
// packages that into the governance story a B2B pilot reviewer can hand to
// their boss: "every answer was grounded in approved Stanford sleep science,
// and out-of-scope questions were cleanly refused."
//
// PII-free by construction: we never expose session_id, embeddings, the raw
// answer prose, or any IP (which is never stored at all). Only the question
// text, the outcome, the citation receipts, and the confidence/flag signals
// leave the server.

/** Outcome bucket derived from the captured row. */
type AuditOutcome = "answered" | "refused" | "uncovered";

interface AuditCitation {
  sourceId: number;
  title: string;
  authors: string | null;
  year: number | null;
}

interface AuditRow {
  id: string;
  createdAt: string;
  source: string;
  question: string;
  outcome: AuditOutcome;
  topScore: number;
  citationVerification: CitationVerificationStatus | null;
  citationLine: string | null;
  citations: AuditCitation[];
  userFlagged: boolean;
  flagReason: string | null;
}

// Upper bound on rows pulled into one audit computation. A pilot window is
// small; this just keeps a pathological "all time" pull from unbounded work.
const MAX_AUDIT_ROWS = 5000;

interface RawAuditRow {
  id: string;
  created_at: string;
  source: string;
  question: string;
  top_score: number;
  was_uncovered: boolean;
  answer_text: string;
  user_flagged: boolean;
  flag_reason: string | null;
  retrieved_source_ids: number[];
}

function classifyOutcome(row: RawAuditRow): AuditOutcome {
  if (row.was_uncovered) return "uncovered";
  if (
    String(row.answer_text ?? "")
      .trimStart()
      .startsWith("REFUSE:")
  ) {
    return "refused";
  }
  return "answered";
}

/**
 * Load and enrich the audit trail for a date window. Reconstructs a minimal
 * provenance set from each row's `retrieved_source_ids` so the existing
 * `verifyCitation()` guard can re-derive the citation-verification outcome
 * for answered rows (it isn't persisted on the query log). Read-only — does
 * not touch how answers are generated or cited.
 */
async function loadAuditRows(opts: {
  from?: string;
  to?: string;
}): Promise<{ rows: AuditRow[]; truncated: boolean }> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (opts.from) {
    params.push(opts.from);
    conds.push(`created_at >= $${params.length}`);
  }
  if (opts.to) {
    params.push(opts.to);
    conds.push(`created_at <= $${params.length}`);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  params.push(MAX_AUDIT_ROWS + 1);

  const { rows: raw } = await pool.query<RawAuditRow>(
    `SELECT id, created_at, source, question, top_score, was_uncovered,
            answer_text, user_flagged, flag_reason, retrieved_source_ids
       FROM agent_queries
       ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
    params,
  );

  const truncated = raw.length > MAX_AUDIT_ROWS;
  const slice = truncated ? raw.slice(0, MAX_AUDIT_ROWS) : raw;

  // One batched lookup for every retrieved source across the window.
  const sourceIds = new Set<number>();
  for (const r of slice) {
    for (const sid of r.retrieved_source_ids ?? []) {
      if (Number(sid) > 0) sourceIds.add(Number(sid));
    }
  }
  const sourceMap = new Map<
    number,
    {
      title: string;
      authors: string | null;
      year: number | null;
      journal: string | null;
    }
  >();
  if (sourceIds.size > 0) {
    const { rows: srows } = await pool.query<{
      id: number;
      title: string;
      authors: string | null;
      year: number | null;
      journal: string | null;
    }>(
      `SELECT id, title, authors, year, journal
         FROM sources WHERE id = ANY($1::int[])`,
      [Array.from(sourceIds)],
    );
    for (const s of srows) {
      sourceMap.set(Number(s.id), {
        title: s.title,
        authors: s.authors,
        year: s.year == null ? null : Number(s.year),
        journal: s.journal,
      });
    }
  }

  const rows: AuditRow[] = slice.map((r) => {
    const outcome = classifyOutcome(r);
    const citations: AuditCitation[] = [];
    const provenance: ProvenanceEntry[] = [];
    for (const sidRaw of r.retrieved_source_ids ?? []) {
      const sid = Number(sidRaw);
      const s = sourceMap.get(sid);
      if (!s) continue;
      citations.push({
        sourceId: sid,
        title: s.title,
        authors: s.authors,
        year: s.year,
      });
      provenance.push({
        source_id: sid,
        interpretation_id: null,
        chunk_ids: [],
        title: s.title,
        authors: s.authors,
        year: s.year,
        journal: s.journal,
        doi: null,
        source_url: null,
        study_design: null,
        pillar_slug: "",
        interpretation_author: null,
        excerpts: [],
        interpretation_note: null,
        reliability: null,
      });
    }

    let citationVerification: CitationVerificationStatus | null = null;
    let citationLine: string | null = null;
    if (outcome === "answered") {
      const v = verifyCitation(String(r.answer_text ?? ""), provenance);
      citationVerification = v.status;
      citationLine = v.citationLine;
    }

    return {
      id: String(r.id),
      createdAt: r.created_at,
      source: r.source,
      question: r.question,
      outcome,
      topScore: Number(r.top_score ?? 0),
      citationVerification,
      citationLine,
      citations,
      userFlagged: !!r.user_flagged,
      flagReason: r.flag_reason ?? null,
    };
  });

  return { rows, truncated };
}

function matchesFilter(row: AuditRow, filter: string): boolean {
  if (filter === "answered") return row.outcome === "answered";
  if (filter === "refused") {
    return row.outcome === "refused" || row.outcome === "uncovered";
  }
  return true;
}

function summarize(rows: AuditRow[]) {
  let answered = 0;
  let refused = 0;
  let uncovered = 0;
  let flagged = 0;
  let answeredVerified = 0;
  let answeredUnmatched = 0;
  let answeredMissing = 0;
  for (const r of rows) {
    if (r.userFlagged) flagged++;
    if (r.outcome === "answered") {
      answered++;
      if (r.citationVerification === "verified") answeredVerified++;
      else if (r.citationVerification === "unmatched") answeredUnmatched++;
      else answeredMissing++;
    } else if (r.outcome === "refused") {
      refused++;
    } else {
      uncovered++;
    }
  }
  return {
    total: rows.length,
    answered,
    refused,
    uncovered,
    flagged,
    answeredVerified,
    answeredUnmatched,
    answeredMissing,
  };
}

/**
 * GET /api/admin/audit — filterable, paginated provenance trail + summary.
 * Query params: from, to (ISO timestamps), filter (all|answered|refused),
 * limit, offset.
 */
router.get("/admin/audit", checkAdmin, async (req, res) => {
  try {
    const from =
      typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    const filter =
      req.query.filter === "answered" || req.query.filter === "refused"
        ? req.query.filter
        : "all";
    const limit = Math.min(
      Math.max(parseInt(String(req.query.limit ?? "100"), 10) || 100, 1),
      500,
    );
    const offset = Math.max(
      parseInt(String(req.query.offset ?? "0"), 10) || 0,
      0,
    );

    const { rows, truncated } = await loadAuditRows({ from, to });
    const summary = summarize(rows);
    const filtered = rows.filter((r) => matchesFilter(r, filter));
    const page = filtered.slice(offset, offset + limit);

    return res.json({
      summary,
      rows: page,
      filteredTotal: filtered.length,
      truncated,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

/**
 * GET /api/admin/audit/export — CSV of the same trail (no pagination) so a
 * pilot reviewer can hand the full window to their boss. Honors from/to and
 * the covered-vs-refused filter. PII-free, lifestyle-only framing preserved.
 */
router.get("/admin/audit/export", checkAdmin, async (req, res) => {
  try {
    const from =
      typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    const filter =
      req.query.filter === "answered" || req.query.filter === "refused"
        ? req.query.filter
        : "all";

    const { rows } = await loadAuditRows({ from, to });
    const filtered = rows.filter((r) => matchesFilter(r, filter));

    const outcomeLabel: Record<AuditOutcome, string> = {
      answered: "Answered (grounded)",
      refused: "Refused (off-topic)",
      uncovered: "Refused (out of coverage)",
    };
    const cols = [
      "asked_at",
      "agent",
      "outcome",
      "question",
      "retrieval_confidence",
      "citation_verification",
      "citation",
      "grounded_sources",
      "user_flagged",
      "flag_reason",
    ];
    const escape = (v: unknown) => {
      if (v == null) return "";
      const s = String(v).replace(/"/g, '""');
      return s.includes(",") || s.includes('"') || s.includes("\n")
        ? `"${s}"`
        : s;
    };
    const csvRows = filtered.map((r) =>
      [
        r.createdAt,
        r.source,
        outcomeLabel[r.outcome],
        r.question,
        r.topScore ? r.topScore.toFixed(3) : "",
        r.outcome === "answered" ? (r.citationVerification ?? "") : "n/a",
        r.citationLine ?? "",
        r.citations
          .map((c) =>
            [c.title, c.authors, c.year ? `(${c.year})` : ""]
              .filter(Boolean)
              .join(" "),
          )
          .join(" | "),
        r.userFlagged ? "yes" : "no",
        r.flagReason ?? "",
      ]
        .map(escape)
        .join(","),
    );
    const csv = [cols.join(","), ...csvRows].join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="palonur_audit_${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    return res.send(csv);
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

/**
 * GET /api/admin/email-volume — read-only send-quota dashboard data. Returns
 * today's + this month's successful transactional sends against the configured
 * daily/monthly caps (via `emailGuardStatus`), plus a per-`label` breakdown so
 * the team can see which features drive volume before scaling sends. The
 * underlying audit table stores only SHA-256 recipient hashes, so no raw
 * address is ever exposed.
 */
router.get("/admin/email-volume", checkAdmin, async (_req, res) => {
  try {
    const [status, byLabel] = await Promise.all([
      emailGuardStatus(),
      emailVolumeByLabel(),
    ]);
    return res.json({ ...status, byLabel });
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

router.post(
  "/admin/send-morning-emails",
  checkAdmin,
  rateLimitEmail,
  async (_req, res) => {
    try {
      const due = await pool.query(`
      SELECT c.id, c.action_text, c.check_in_token,
             u.first_name, u.email
      FROM palonur_commitments c
      JOIN palonur_users u ON u.id = c.user_id
      WHERE c.email_sent_at IS NULL
        AND u.email_opted_out = FALSE
        AND c.created_at < NOW() - INTERVAL '12 hours'
        AND NOT EXISTS (
          SELECT 1 FROM palonur_checkins ck
          WHERE ck.commitment_id = c.id
            AND ck.checkin_date >= c.created_at::date + 1
        )
    `);
      let sent = 0;
      for (const row of due.rows) {
        const ok = await sendMorningCheckin({
          to: row.email,
          firstName: row.first_name,
          actionText: row.action_text,
          token: row.check_in_token,
        });
        if (ok) {
          await pool.query(
            `UPDATE palonur_commitments SET email_sent_at = NOW() WHERE id = $1`,
            [row.id],
          );
          sent++;
        }
      }
      return res.json({ queued: due.rows.length, sent });
    } catch (e) {
      return res.status(500).json({ error: String((e as Error).message) });
    }
  },
);

router.post(
  "/admin/send-weekly-portraits",
  checkAdmin,
  rateLimitEmail,
  async (_req, res) => {
    try {
      const sent = await runWeeklyPortraits();
      return res.json({ sent });
    } catch (e) {
      return res.status(500).json({ error: String((e as Error).message) });
    }
  },
);

router.post(
  "/admin/send-nudge-emails",
  checkAdmin,
  rateLimitEmail,
  async (_req, res) => {
    try {
      const sent = await runNudgeEmails();
      return res.json({ sent });
    } catch (e) {
      return res.status(500).json({ error: String((e as Error).message) });
    }
  },
);

router.post(
  "/admin/send-weekly-reflections",
  checkAdmin,
  rateLimitEmail,
  async (_req, res) => {
    try {
      const sent = await runWeeklyReflections();
      return res.json({ sent });
    } catch (e) {
      return res.status(500).json({ error: String((e as Error).message) });
    }
  },
);

// ─── People directory ──────────────────────────────────────────────────
//
// A unified, READ-ONLY roster that merges every email-bearing record across
// the system — consumer journey profiles (`palonur_users`), consumer billing
// identities (`consumer_accounts`), newsletter subscribers across the house +
// faculty publications, the waitlist, investors, NON-anonymous story
// submitters, and B2B partner contacts — deduplicated case-insensitively by
// email. Each person appears exactly once with a set of source badges, each
// carrying its own per-source status.
//
// Privacy invariants:
//   - Investor money (`commitment_cents` / `notes`) is NEVER selected here,
//     mirroring the investor-portal money-gating rule. Investors surface as
//     name + role + status only.
//   - Anonymous story submitters (and rows with no email) are excluded.

type PersonSourceType =
  | "account"
  | "billing"
  | "newsletter"
  | "waitlist"
  | "beta"
  | "investor"
  | "story"
  | "partner";

const PERSON_SOURCE_TYPES: PersonSourceType[] = [
  "account",
  "billing",
  "newsletter",
  "waitlist",
  "beta",
  "investor",
  "story",
  "partner",
];

interface PersonSource {
  type: PersonSourceType;
  status: string | null;
  detail: string | null;
}

interface PersonRow {
  email: string;
  name: string | null;
  sources: PersonSource[];
  /** Set when this email owns a consumer journey profile — drives the existing
   * `/admin/user/:id` drill-down so it is preserved unchanged. */
  palonurUserId: number | null;
  consumerAccountId: number | null;
  /** Earliest known created_at across every source ("first seen"). */
  createdAt: string | null;
}

// Defensive upper bound per source so a pathological table can't pull unbounded
// rows into one aggregation. Admin scale is tiny; this is just a guard rail.
const MAX_PEOPLE_ROWS_PER_SOURCE = 50000;

/**
 * Load and merge every email-bearing record into a deduped people roster.
 * One query per source (no N+1); merge happens in memory keyed by lower(email).
 */
async function loadPeople(): Promise<PersonRow[]> {
  const byEmail = new Map<string, PersonRow>();

  function upsert(rawEmail: string | null | undefined): PersonRow | null {
    const email = String(rawEmail ?? "").trim();
    if (!email) return null;
    const key = email.toLowerCase();
    let row = byEmail.get(key);
    if (!row) {
      row = {
        email,
        name: null,
        sources: [],
        palonurUserId: null,
        consumerAccountId: null,
        createdAt: null,
      };
      byEmail.set(key, row);
    }
    return row;
  }

  function considerName(row: PersonRow, name: string | null | undefined) {
    const n = String(name ?? "").trim();
    if (n && !row.name) row.name = n;
  }
  function considerCreatedAt(
    row: PersonRow,
    createdAt: string | Date | null | undefined,
  ) {
    if (!createdAt) return;
    const iso =
      createdAt instanceof Date ? createdAt.toISOString() : String(createdAt);
    if (!row.createdAt || iso < row.createdAt) row.createdAt = iso;
  }

  const lim = MAX_PEOPLE_ROWS_PER_SOURCE;
  const [
    accounts,
    billing,
    subs,
    waitlist,
    betaWaitlist,
    investors,
    stories,
    partners,
  ] = await Promise.all([
    pool.query(
      `SELECT id, first_name, email, created_at FROM palonur_users
          WHERE email IS NOT NULL AND email <> ''
          ORDER BY created_at DESC LIMIT ${lim}`,
    ),
    pool.query(
      `SELECT id, email, stripe_customer_id, created_at FROM consumer_accounts
          WHERE email IS NOT NULL AND email <> ''
          ORDER BY created_at DESC LIMIT ${lim}`,
    ),
    pool.query(
      `SELECT ns.email, ns.name, ns.status, ns.created_at,
                np.name AS pub_name, np.is_house
           FROM newsletter_subscribers ns
           LEFT JOIN newsletter_publications np ON np.id = ns.publication_id
          WHERE ns.email IS NOT NULL AND ns.email <> ''
          ORDER BY ns.created_at DESC LIMIT ${lim}`,
    ),
    pool.query(
      `SELECT id, name, email, source, created_at FROM palonur_waitlist
          WHERE email IS NOT NULL AND email <> ''
          ORDER BY created_at DESC LIMIT ${lim}`,
    ),
    pool.query(
      `SELECT email, variant, founding_member, created_at FROM beta_waitlist
          WHERE email IS NOT NULL AND email <> ''
          ORDER BY created_at DESC LIMIT ${lim}`,
    ),
    // NOTE: commitment_cents / notes are deliberately NOT selected.
    pool.query(
      `SELECT id, name, email, role, status, created_at FROM investors
          WHERE email IS NOT NULL AND email <> ''
          ORDER BY created_at DESC LIMIT ${lim}`,
    ),
    pool.query(
      `SELECT id, first_name, email, status, created_at FROM stories
          WHERE anonymous = FALSE AND email IS NOT NULL AND email <> ''
          ORDER BY created_at DESC LIMIT ${lim}`,
    ),
    pool.query(
      `SELECT id, partner_name, contact_email AS email, revoked_at, created_at
           FROM partner_keys
          WHERE contact_email IS NOT NULL AND contact_email <> ''
          ORDER BY created_at DESC LIMIT ${lim}`,
    ),
  ]);

  for (const r of accounts.rows) {
    const row = upsert(r.email);
    if (!row) continue;
    considerName(row, r.first_name);
    considerCreatedAt(row, r.created_at);
    row.palonurUserId = Number(r.id);
    row.sources.push({ type: "account", status: "active", detail: null });
  }
  for (const r of billing.rows) {
    const row = upsert(r.email);
    if (!row) continue;
    considerCreatedAt(row, r.created_at);
    row.consumerAccountId = Number(r.id);
    row.sources.push({
      type: "billing",
      status: r.stripe_customer_id ? "stripe-linked" : "registered",
      detail: null,
    });
  }
  for (const r of subs.rows) {
    const row = upsert(r.email);
    if (!row) continue;
    considerName(row, r.name);
    considerCreatedAt(row, r.created_at);
    row.sources.push({
      type: "newsletter",
      status: r.status ?? null,
      detail: r.pub_name ?? (r.is_house ? "House" : null),
    });
  }
  for (const r of waitlist.rows) {
    const row = upsert(r.email);
    if (!row) continue;
    considerName(row, r.name);
    considerCreatedAt(row, r.created_at);
    row.sources.push({
      type: "waitlist",
      status: "waiting",
      detail: r.source ?? null,
    });
  }
  for (const r of betaWaitlist.rows) {
    const row = upsert(r.email);
    if (!row) continue;
    considerCreatedAt(row, r.created_at);
    const detail = r.founding_member ? "founding" : (r.variant ?? null);
    row.sources.push({
      type: "beta",
      status: "waiting",
      detail,
    });
  }
  for (const r of investors.rows) {
    const row = upsert(r.email);
    if (!row) continue;
    considerName(row, r.name);
    considerCreatedAt(row, r.created_at);
    row.sources.push({
      type: "investor",
      status: r.status ?? null,
      detail: r.role ?? null,
    });
  }
  for (const r of stories.rows) {
    const row = upsert(r.email);
    if (!row) continue;
    considerName(row, r.first_name);
    considerCreatedAt(row, r.created_at);
    row.sources.push({ type: "story", status: r.status ?? null, detail: null });
  }
  for (const r of partners.rows) {
    const row = upsert(r.email);
    if (!row) continue;
    considerName(row, r.partner_name);
    considerCreatedAt(row, r.created_at);
    row.sources.push({
      type: "partner",
      status: r.revoked_at ? "revoked" : "active",
      detail: r.partner_name ?? null,
    });
  }
  const all = Array.from(byEmail.values());
  // Most-recently-first-seen on top; stable tiebreak by email.
  all.sort((a, b) => {
    const ax = a.createdAt ?? "";
    const bx = b.createdAt ?? "";
    if (ax === bx) return a.email.localeCompare(b.email);
    return ax < bx ? 1 : -1;
  });
  return all;
}

function filterPeople(
  all: PersonRow[],
  opts: { q?: string; source?: string; status?: string },
): PersonRow[] {
  let out = all;
  if (opts.q) {
    const q = opts.q.toLowerCase();
    out = out.filter(
      (p) =>
        p.email.toLowerCase().includes(q) ||
        (p.name ?? "").toLowerCase().includes(q),
    );
  }
  if (opts.source) {
    out = out.filter((p) => p.sources.some((s) => s.type === opts.source));
  }
  if (opts.status) {
    const st = opts.status.toLowerCase();
    out = out.filter((p) =>
      p.sources.some((s) => (s.status ?? "").toLowerCase() === st),
    );
  }
  return out;
}

/** Distinct people that carry each source type (over the full unfiltered set). */
function countBySource(all: PersonRow[]): Record<PersonSourceType, number> {
  const counts = Object.fromEntries(
    PERSON_SOURCE_TYPES.map((t) => [t, 0]),
  ) as Record<PersonSourceType, number>;
  for (const p of all) {
    const seen = new Set<PersonSourceType>();
    for (const s of p.sources) seen.add(s.type);
    for (const t of seen) counts[t] += 1;
  }
  return counts;
}

function parsePeopleFilters(req: Request): {
  q: string;
  source: string;
  status: string;
} {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const source =
    typeof req.query.source === "string" &&
    (PERSON_SOURCE_TYPES as string[]).includes(req.query.source)
      ? req.query.source
      : "";
  const status =
    typeof req.query.status === "string" ? req.query.status.trim() : "";
  return { q, source, status };
}

/**
 * GET /api/admin/people — deduped, filterable, paginated people directory plus
 * per-source counts. Query params: q (name/email search), source (one of the
 * source types), status, limit, offset.
 */
router.get("/admin/people", checkAdmin, async (req, res) => {
  try {
    const { q, source, status } = parsePeopleFilters(req);
    const limit = Math.min(
      Math.max(parseInt(String(req.query.limit ?? "100"), 10) || 100, 1),
      500,
    );
    const offset = Math.max(
      parseInt(String(req.query.offset ?? "0"), 10) || 0,
      0,
    );

    const all = await loadPeople();
    const counts = countBySource(all);
    const filtered = filterPeople(all, { q, source, status });
    const page = filtered.slice(offset, offset + limit);

    return res.json({
      people: page,
      total: filtered.length,
      totalPeople: all.length,
      counts,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

/**
 * GET /api/admin/people/export — CSV of the same (filtered) directory, no
 * pagination. Honors q/source/status. Investor money is never present.
 */
router.get("/admin/people/export", checkAdmin, async (req, res) => {
  try {
    const { q, source, status } = parsePeopleFilters(req);
    const all = await loadPeople();
    const filtered = filterPeople(all, { q, source, status });

    const cols = [
      "email",
      "name",
      "sources",
      "statuses",
      "palonur_user_id",
      "consumer_account_id",
      "first_seen",
    ];
    const escape = (v: unknown) => {
      if (v == null) return "";
      const s = String(v).replace(/"/g, '""');
      return s.includes(",") || s.includes('"') || s.includes("\n")
        ? `"${s}"`
        : s;
    };
    const csvRows = filtered.map((p) =>
      [
        p.email,
        p.name ?? "",
        p.sources
          .map((s) => (s.detail ? `${s.type} (${s.detail})` : s.type))
          .join(" | "),
        p.sources.map((s) => `${s.type}:${s.status ?? ""}`).join(" | "),
        p.palonurUserId ?? "",
        p.consumerAccountId ?? "",
        p.createdAt ?? "",
      ]
        .map(escape)
        .join(","),
    );
    const csv = [cols.join(","), ...csvRows].join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="palonur_people_${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    return res.send(csv);
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

// ── GET /api/admin/beta-ab-stats ──────────────────────────────────────────────
// Returns A/B breakdown for the /apply page waitlist.

router.get("/admin/beta-ab-stats", checkAdmin, async (_req, res) => {
  try {
    const [variantRows, foundingRows] = await Promise.all([
      pool.query<{ variant: string | null; cnt: string }>(
        `SELECT variant, COUNT(*) AS cnt FROM beta_waitlist GROUP BY variant ORDER BY cnt DESC`,
      ),
      pool.query<{ founding_member: boolean; cnt: string }>(
        `SELECT founding_member, COUNT(*) AS cnt FROM beta_waitlist GROUP BY founding_member`,
      ),
    ]);

    const byVariant: Record<string, number> = {};
    let total = 0;
    for (const row of variantRows.rows) {
      const key = row.variant ?? "unknown";
      const n = parseInt(row.cnt, 10);
      byVariant[key] = n;
      total += n;
    }

    let foundingCount = 0;
    let notifyCount = 0;
    for (const row of foundingRows.rows) {
      const n = parseInt(row.cnt, 10);
      if (row.founding_member) foundingCount = n;
      else notifyCount = n;
    }

    return res.json({ total, byVariant, foundingCount, notifyCount });
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

export default router;
