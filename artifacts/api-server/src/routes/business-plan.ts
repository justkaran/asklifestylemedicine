import { Router, type Request, type Response, type NextFunction } from "express";
import pool from "../lib/db";

const router = Router();

const PLAN_ID = "slm";

const EDIT_PASSWORD = process.env["BUSINESS_PLAN_PASSWORD"] ?? "palonurplan";

// Canonical collaborator names. Self-declared (trusted, 2-person tool) but
// normalized against this allowlist so attribution stays clean.
const AUTHORS = (process.env["BUSINESS_PLAN_AUTHORS"] ?? "Karan,Ernesto")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function canonicalAuthor(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  const match = AUTHORS.find((a) => a.toLowerCase() === v);
  return match ?? null;
}

interface BpRequest extends Request {
  bpAuthor?: string;
}

// All endpoints require the shared edit password (header). Writes also require a
// valid collaborator name. Mirrors the reach-deck header-password pattern.
function requireBpAuth(req: BpRequest, res: Response, next: NextFunction) {
  const password = (req.header("x-bp-password") ?? "").toString().trim();
  if (password !== EDIT_PASSWORD) {
    return res.status(401).json({ error: "Invalid password" });
  }
  const rawAuthor = (req.header("x-bp-author") ?? "").toString();
  if (rawAuthor) {
    const author = canonicalAuthor(rawAuthor);
    if (!author) {
      return res.status(400).json({ error: "Unknown collaborator" });
    }
    req.bpAuthor = author;
  }
  return next();
}

function requireAuthor(req: BpRequest, res: Response): string | null {
  if (!req.bpAuthor) {
    res.status(400).json({ error: "Missing collaborator name" });
    return null;
  }
  return req.bpAuthor;
}

type AttributionMeta = Record<string, { by: string; at: string }>;

interface StateRow {
  assumptions: Record<string, string>;
  narrative: Record<string, string>;
  assumptions_meta: AttributionMeta;
  narrative_meta: AttributionMeta;
  updated_by: string | null;
  updated_at: string | null;
}

function emptyState(): StateRow {
  return {
    assumptions: {},
    narrative: {},
    assumptions_meta: {},
    narrative_meta: {},
    updated_by: null,
    updated_at: null,
  };
}

async function loadState(): Promise<StateRow> {
  const result = await pool.query(
    `SELECT assumptions, narrative, assumptions_meta, narrative_meta, updated_by, updated_at
       FROM business_plan_state WHERE id = $1`,
    [PLAN_ID],
  );
  if (result.rows.length === 0) return emptyState();
  const r = result.rows[0];
  return {
    assumptions: r.assumptions ?? {},
    narrative: r.narrative ?? {},
    assumptions_meta: r.assumptions_meta ?? {},
    narrative_meta: r.narrative_meta ?? {},
    updated_by: r.updated_by ?? null,
    updated_at: r.updated_at ?? null,
  };
}

function serializeState(s: StateRow) {
  return {
    assumptions: s.assumptions,
    narrative: s.narrative,
    assumptionsMeta: s.assumptions_meta,
    narrativeMeta: s.narrative_meta,
    updatedBy: s.updated_by,
    updatedAt: s.updated_at,
  };
}

function isStringMap(v: unknown): v is Record<string, string> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  return Object.values(v).every((x) => typeof x === "string");
}

// Verify password + name without mutating anything (used on "join").
router.post("/business-plan/auth", requireBpAuth, (req: BpRequest, res) => {
  if (!req.bpAuthor) {
    return res.status(400).json({ error: "Missing collaborator name" });
  }
  return res.json({ ok: true, name: req.bpAuthor, authors: AUTHORS });
});

router.get("/business-plan/state", requireBpAuth, async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const state = await loadState();
    return res.json(serializeState(state));
  } catch (err) {
    req.log?.error({ err }, "business-plan: load state failed");
    return res.status(500).json({ error: "Failed to load state" });
  }
});

router.put("/business-plan/state", requireBpAuth, async (req: BpRequest, res) => {
  const author = requireAuthor(req, res);
  if (!author) return;

  const body = req.body ?? {};
  const incomingAssumptions = body.assumptions;
  const incomingNarrative = body.narrative;
  if (
    (incomingAssumptions !== undefined && !isStringMap(incomingAssumptions)) ||
    (incomingNarrative !== undefined && !isStringMap(incomingNarrative))
  ) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  try {
    const prev = await loadState();
    const now = new Date().toISOString();

    // Field-level merge: a PUT carries only the keys the caller actually
    // changed, so a stale editor can never clobber the other person's
    // untouched fields. Merge those keys over the stored maps.
    const nextAssumptions = incomingAssumptions
      ? { ...prev.assumptions, ...incomingAssumptions }
      : prev.assumptions;
    const nextNarrative = incomingNarrative
      ? { ...prev.narrative, ...incomingNarrative }
      : prev.narrative;

    const assumptionsMeta: AttributionMeta = { ...prev.assumptions_meta };
    if (incomingAssumptions) {
      for (const [k, v] of Object.entries(incomingAssumptions)) {
        if (prev.assumptions[k] !== v) assumptionsMeta[k] = { by: author, at: now };
      }
    }
    const narrativeMeta: AttributionMeta = { ...prev.narrative_meta };
    if (incomingNarrative) {
      for (const [k, v] of Object.entries(incomingNarrative)) {
        if (prev.narrative[k] !== v) narrativeMeta[k] = { by: author, at: now };
      }
    }

    await pool.query(
      `INSERT INTO business_plan_state
         (id, assumptions, narrative, assumptions_meta, narrative_meta, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6, NOW())
       ON CONFLICT (id) DO UPDATE SET
         assumptions = $2::jsonb,
         narrative = $3::jsonb,
         assumptions_meta = $4::jsonb,
         narrative_meta = $5::jsonb,
         updated_by = $6,
         updated_at = NOW()`,
      [
        PLAN_ID,
        JSON.stringify(nextAssumptions),
        JSON.stringify(nextNarrative),
        JSON.stringify(assumptionsMeta),
        JSON.stringify(narrativeMeta),
        author,
      ],
    );

    const state = await loadState();
    return res.json(serializeState(state));
  } catch (err) {
    req.log?.error({ err }, "business-plan: save state failed");
    return res.status(500).json({ error: "Failed to save state" });
  }
});

router.get("/business-plan/comments", requireBpAuth, async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const result = await pool.query(
      `SELECT id, section, section_label, author, body, resolved, created_at
         FROM business_plan_comments
        WHERE plan_id = $1
        ORDER BY created_at ASC`,
      [PLAN_ID],
    );
    return res.json({
      comments: result.rows.map((r) => ({
        id: r.id,
        section: r.section,
        sectionLabel: r.section_label,
        author: r.author,
        body: r.body,
        resolved: r.resolved,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    req.log?.error({ err }, "business-plan: load comments failed");
    return res.status(500).json({ error: "Failed to load comments" });
  }
});

router.post(
  "/business-plan/comments",
  requireBpAuth,
  async (req: BpRequest, res) => {
    const author = requireAuthor(req, res);
    if (!author) return;

    const { section, sectionLabel, body } = req.body ?? {};
    if (typeof section !== "string" || !section.trim()) {
      return res.status(400).json({ error: "Missing section" });
    }
    if (typeof body !== "string" || !body.trim()) {
      return res.status(400).json({ error: "Empty comment" });
    }
    if (body.length > 4000) {
      return res.status(400).json({ error: "Comment too long" });
    }

    try {
      const result = await pool.query(
        `INSERT INTO business_plan_comments
           (plan_id, section, section_label, author, body)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, section, section_label, author, body, resolved, created_at`,
        [
          PLAN_ID,
          section.trim().slice(0, 200),
          typeof sectionLabel === "string" ? sectionLabel.slice(0, 300) : null,
          author,
          body.trim(),
        ],
      );
      const r = result.rows[0];
      return res.status(201).json({
        id: r.id,
        section: r.section,
        sectionLabel: r.section_label,
        author: r.author,
        body: r.body,
        resolved: r.resolved,
        createdAt: r.created_at,
      });
    } catch (err) {
      req.log?.error({ err }, "business-plan: post comment failed");
      return res.status(500).json({ error: "Failed to post comment" });
    }
  },
);

router.patch(
  "/business-plan/comments/:id",
  requireBpAuth,
  async (req: BpRequest, res) => {
    const author = requireAuthor(req, res);
    if (!author) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }
    const { resolved } = req.body ?? {};
    if (typeof resolved !== "boolean") {
      return res.status(400).json({ error: "Expected { resolved: boolean }" });
    }
    try {
      const result = await pool.query(
        `UPDATE business_plan_comments SET resolved = $1
          WHERE id = $2 AND plan_id = $3
        RETURNING id`,
        [resolved, id, PLAN_ID],
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Not found" });
      }
      return res.json({ ok: true });
    } catch (err) {
      req.log?.error({ err }, "business-plan: resolve comment failed");
      return res.status(500).json({ error: "Failed to update comment" });
    }
  },
);

export default router;
