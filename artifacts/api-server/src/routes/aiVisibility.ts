/**
 * "How AI sees you" — steward AI-visibility report endpoints.
 *
 * Faculty-portal surface (Clerk-authenticated via requireFacultyAuth):
 *
 *   GET  /faculty/ai-visibility/reports        — own reports; admin sees all
 *                                                (including prospect reports)
 *   POST /faculty/ai-visibility/reports        — generate a new report:
 *          steward mode  {}                    — for the caller themselves,
 *                                                topics from their steward
 *                                                pillar(s)
 *          prospect mode {subjectName, topics} — ADMIN ONLY, recruiting tool
 *                                                for people without accounts
 *   GET  /faculty/ai-visibility/reports/:id    — full report (owner or admin)
 *
 * Cost / abuse bounds:
 *   - fixed question count (MAX_QUESTIONS) x 2 engines per run,
 *   - one run at a time per subject; a completed run within the cache window
 *     is returned instead of re-running (admins may pass force=true),
 *   - per-user daily run cap.
 *
 * Reports store raw assistant answers, which are UNTRUSTED third-party text:
 * they are never served outside the authenticated faculty portal and never
 * presented as Palonur answers.
 */
import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { pool } from "@workspace/db";
import {
  requireFacultyAuth,
  type FacultyRequest,
} from "../middlewares/facultyAuth.js";
import {
  runVisibilityReport,
  MAX_QUESTIONS,
  type VisibilitySubject,
  type VisibilityReportPayload,
} from "../services/aiVisibility.js";
import { logger as rootLogger } from "../lib/logger.js";

const router: IRouter = Router();

/** A completed run younger than this is served from cache instead of re-run. */
const CACHE_WINDOW_HOURS = 6;
/** Max runs any single faculty user may trigger per UTC day. */
const DAILY_RUN_CAP = 10;

const isAdmin = (req: FacultyRequest): boolean =>
  req.faculty!.user.isPlatformAdmin === "true";

interface ReportRow {
  id: number;
  subject_name: string;
  aliases: string[];
  topics: string[];
  pillar_id: number | null;
  faculty_user_id: number | null;
  requested_by: number | null;
  status: string;
  payload: VisibilityReportPayload | null;
  error_message: string | null;
  created_at: Date;
  completed_at: Date | null;
}

function summarize(r: ReportRow) {
  return {
    id: r.id,
    subjectName: r.subject_name,
    topics: r.topics,
    pillarId: r.pillar_id,
    isProspect: r.faculty_user_id == null,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    completedAt: r.completed_at ? r.completed_at.toISOString() : null,
    errorMessage: r.error_message,
    summary: r.payload?.summary ?? null,
  };
}

/** Steward-pillar topics for a faculty user: pillar names + descriptions. */
async function stewardSubject(
  facultyUserId: number,
  fullName: string,
): Promise<{ subject: VisibilitySubject; pillarId: number | null } | null> {
  const rows = await pool.query<{
    id: number;
    name: string;
    description: string | null;
  }>(
    `SELECT p.id, p.name, p.description
       FROM faculty_memberships m
       JOIN pillars p ON p.id = m.pillar_id
      WHERE m.user_id = $1 AND m.role = 'steward' AND p.retired_at IS NULL
      ORDER BY m.id`,
    [facultyUserId],
  );
  if (rows.rows.length === 0) return null;
  const topics: string[] = [];
  for (const p of rows.rows) {
    topics.push(p.name);
    // Descriptions often carry "— Author Name" credits; strip them so the
    // question generator never receives the subject's own name as a topic.
    const desc = (p.description ?? "").split(/[—–-]\s*[A-Z][a-z]+ [A-Z]/)[0].trim();
    if (desc) topics.push(desc);
  }
  return {
    subject: { name: fullName, aliases: [], topics: topics.slice(0, 8) },
    pillarId: rows.rows[0].id,
  };
}

/** Approved-source count for the "what Palonur would answer" pointer. */
async function approvedSourceCount(pillarId: number | null): Promise<number> {
  if (pillarId == null) return 0;
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM sources WHERE pillar_id = $1 AND status = 'approved' AND is_canary = FALSE`,
    [pillarId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

router.get(
  "/faculty/ai-visibility/reports",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    const rows = await pool.query<ReportRow>(
      isAdmin(req)
        ? `SELECT * FROM ai_visibility_reports ORDER BY created_at DESC LIMIT 50`
        : `SELECT * FROM ai_visibility_reports WHERE faculty_user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      isAdmin(req) ? [] : [ctx.user.id],
    );
    res.json({ reports: rows.rows.map(summarize), isAdmin: isAdmin(req) });
  },
);

router.get(
  "/faculty/ai-visibility/reports/:id",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Bad id" });
      return;
    }
    const rows = await pool.query<ReportRow>(
      `SELECT * FROM ai_visibility_reports WHERE id = $1`,
      [id],
    );
    const report = rows.rows[0];
    if (!report || (!isAdmin(req) && report.faculty_user_id !== ctx.user.id)) {
      // 404 for both missing and foreign reports — don't leak existence.
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({
      report: {
        ...summarize(report),
        aliases: report.aliases,
        payload: report.payload,
        approvedSources: await approvedSourceCount(report.pillar_id),
      },
    });
  },
);

const prospectSchema = z.object({
  subjectName: z.string().trim().min(2).max(120),
  aliases: z.array(z.string().trim().min(1).max(120)).max(5).optional(),
  topics: z.array(z.string().trim().min(2).max(200)).min(1).max(8),
  pillarId: z.number().int().positive().optional(),
  force: z.boolean().optional(),
});

router.post(
  "/faculty/ai-visibility/reports",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const ctx = req.faculty!;
    const admin = isAdmin(req);

    let subject: VisibilitySubject;
    let pillarId: number | null = null;
    let ownerFacultyUserId: number | null = null;
    let force = false;

    const wantsProspect =
      req.body && typeof req.body === "object" && "subjectName" in req.body;

    if (wantsProspect) {
      if (!admin) {
        res.status(403).json({ error: "Prospect reports are admin-only" });
        return;
      }
      const parsed = prospectSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid body" });
        return;
      }
      subject = {
        name: parsed.data.subjectName,
        aliases: parsed.data.aliases ?? [],
        topics: parsed.data.topics,
      };
      pillarId = parsed.data.pillarId ?? null;
      force = parsed.data.force === true;
    } else {
      const fullName = ctx.user.fullName?.trim();
      if (!fullName) {
        res.status(400).json({
          error: "Add your full name in Settings first — the report needs it to detect mentions.",
        });
        return;
      }
      const s = await stewardSubject(ctx.user.id, fullName);
      if (!s) {
        res.status(400).json({ error: "You need a steward pillar to run a report." });
        return;
      }
      subject = s.subject;
      pillarId = s.pillarId;
      ownerFacultyUserId = ctx.user.id;
      force = admin && req.body?.force === true;
    }

    // All guard checks + the insert run atomically inside one transaction,
    // serialized per subject by a transaction-scoped advisory lock. Without
    // this, concurrent POSTs could all pass the read-then-insert checks and
    // launch duplicate paid engine runs / exceed the daily cap.
    const client = await pool.connect();
    let report: ReportRow;
    try {
      await client.query("BEGIN");
      // Per-subject serialization (namespaced advisory lock, released at
      // COMMIT/ROLLBACK). A second, user-scoped lock serializes the daily cap
      // for admins racing runs across DIFFERENT subjects.
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext('ai_visibility:' || lower($1))),
                pg_advisory_xact_lock(hashtext('ai_visibility_user:' || $2::text))`,
        [subject.name, ctx.user.id],
      );

      // Duplicate/cache checks are scoped to reports the CALLER is authorized
      // to see. Keying on subject_name alone would let a steward rename
      // themselves after another steward and receive that person's cached
      // summary (or running-report id) — an access-control leak. Stewards
      // therefore match only their own rows; admins match by subject across
      // all rows (they can read everything anyway).
      const scopeSql = admin
        ? `lower(subject_name) = lower($1)`
        : `faculty_user_id = $1`;
      const scopeParam: string | number = admin ? subject.name : ctx.user.id;

      // One running report per subject at a time.
      const running = await client.query<{ id: number }>(
        `SELECT id FROM ai_visibility_reports
          WHERE ${scopeSql} AND status = 'running'
            AND created_at > now() - interval '15 minutes'`,
        [scopeParam],
      );
      if (running.rows.length > 0) {
        await client.query("ROLLBACK");
        res.status(409).json({ error: "A report for this person is already running.", id: running.rows[0].id });
        return;
      }

      // Cache: recent completed run for the same subject is returned as-is.
      if (!force) {
        const recent = await client.query<ReportRow>(
          `SELECT * FROM ai_visibility_reports
            WHERE ${scopeSql} AND status = 'completed'
              AND completed_at > now() - interval '${CACHE_WINDOW_HOURS} hours'
            ORDER BY completed_at DESC LIMIT 1`,
          [scopeParam],
        );
        if (recent.rows[0]) {
          await client.query("ROLLBACK");
          res.status(200).json({ report: summarize(recent.rows[0]), cached: true });
          return;
        }
      }

      // Daily cap per triggering user.
      const today = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ai_visibility_reports
          WHERE requested_by = $1 AND created_at > date_trunc('day', now())`,
        [ctx.user.id],
      );
      if (Number(today.rows[0]?.n ?? 0) >= DAILY_RUN_CAP) {
        await client.query("ROLLBACK");
        res.status(429).json({ error: "Daily report limit reached. Try again tomorrow." });
        return;
      }

      const inserted = await client.query<ReportRow>(
        `INSERT INTO ai_visibility_reports
           (subject_name, aliases, topics, pillar_id, faculty_user_id, requested_by, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'running')
         RETURNING *`,
        [
          subject.name,
          subject.aliases,
          subject.topics,
          pillarId,
          ownerFacultyUserId,
          ctx.user.id,
        ],
      );
      await client.query("COMMIT");
      report = inserted.rows[0];
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    res.status(202).json({ report: summarize(report), maxQuestions: MAX_QUESTIONS });

    // Fire-and-forget background execution (mirrors the reputation runner).
    void (async () => {
      const log = rootLogger.child({ aiVisibilityReportId: report.id });
      try {
        const payload = await runVisibilityReport(subject);
        await pool.query(
          `UPDATE ai_visibility_reports
              SET status = 'completed', payload = $2, completed_at = now()
            WHERE id = $1`,
          [report.id, JSON.stringify(payload)],
        );
        log.info(
          { mentioned: payload.summary.mentionedCount, total: payload.summary.totalAnswers },
          "ai-visibility report completed",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err: msg }, "ai-visibility report failed");
        await pool.query(
          `UPDATE ai_visibility_reports
              SET status = 'failed', error_message = $2, completed_at = now()
            WHERE id = $1`,
          [report.id, msg.slice(0, 500)],
        ).catch(() => {});
      }
    })();
  },
);

export default router;
