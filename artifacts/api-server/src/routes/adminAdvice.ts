import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, adviceGuardTermsTable } from "@workspace/db";
import pool from "../lib/db";
import { checkAdmin } from "./admin";
import {
  ADVICE_CATEGORIES,
  getAdviceTerms,
  isAdviceCategory,
  scanAnswerForAdvice,
  type AdviceCategory,
} from "../lib/adviceGuard";

const router: IRouter = Router();

// ── FDA / advice review ─────────────────────────────────────────────────────
// Read-time scan of recent agent answers (every surface that logs into
// agent_queries: sleep-agent, embed-agent, newsletter Q&A,
// governed tool) against the admin-editable boundary list. Because the scan
// runs at read time, adding or removing a term below instantly re-classifies
// past answers — there is nothing to backfill.

const MAX_SCAN = 1000;

router.get("/admin/advice-review", checkAdmin, async (req, res) => {
  try {
    const days = Math.min(
      365,
      Math.max(1, parseInt(String(req.query.days ?? "30"), 10) || 30),
    );
    const terms = await getAdviceTerms();
    const r = await pool.query<{
      id: string;
      question: string;
      answer_text: string;
      source: string;
      was_uncovered: boolean;
      created_at: Date;
    }>(
      `SELECT id, question, answer_text, source, was_uncovered, created_at
         FROM agent_queries
        WHERE created_at > now() - ($1 || ' days')::interval
          AND answer_text <> ''
        ORDER BY created_at DESC
        LIMIT ${MAX_SCAN}`,
      [days],
    );

    const countsByCategory: Record<AdviceCategory, number> = {
      diagnosis: 0,
      dosage: 0,
      treatment: 0,
    };
    const flagged: Array<{
      id: string;
      question: string;
      answerText: string;
      source: string;
      createdAt: Date;
      hits: ReturnType<typeof scanAnswerForAdvice>;
    }> = [];

    for (const row of r.rows) {
      const hits = scanAnswerForAdvice(row.answer_text, terms);
      if (hits.length === 0) continue;
      const seen = new Set<AdviceCategory>();
      for (const h of hits) {
        if (!seen.has(h.category)) {
          countsByCategory[h.category] += 1;
          seen.add(h.category);
        }
      }
      flagged.push({
        id: row.id,
        question: row.question,
        answerText: row.answer_text,
        source: row.source,
        createdAt: row.created_at,
        hits,
      });
    }

    return res.json({
      days,
      scanned: r.rows.length,
      scanCap: MAX_SCAN,
      flaggedCount: flagged.length,
      countsByCategory,
      flagged,
      terms,
      categories: ADVICE_CATEGORIES,
    });
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

// ── Boundary (term) management ──────────────────────────────────────────────

router.get("/admin/advice-terms", checkAdmin, async (_req, res) => {
  try {
    return res.json({ terms: await getAdviceTerms() });
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

router.post("/admin/advice-terms", checkAdmin, async (req, res) => {
  try {
    const category = req.body?.category;
    const phrase = String(req.body?.phrase ?? "").trim();
    if (!isAdviceCategory(category)) {
      return res.status(400).json({
        error: `category must be one of: ${ADVICE_CATEGORIES.join(", ")}`,
      });
    }
    if (phrase.length < 2 || phrase.length > 120) {
      return res.status(400).json({ error: "phrase must be 2–120 characters" });
    }
    // Seed-when-empty happens inside getAdviceTerms; call it first so a brand
    // new phrase never becomes the ONLY row of an otherwise unseeded table.
    const existing = await getAdviceTerms();
    const dup = existing.find(
      (t) =>
        t.category === category &&
        t.phrase.toLowerCase() === phrase.toLowerCase(),
    );
    if (dup) return res.json({ term: dup, alreadyExists: true });
    const inserted = await db
      .insert(adviceGuardTermsTable)
      .values({ category, phrase, addedBy: "admin" })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) {
      return res.json({ alreadyExists: true });
    }
    const row = inserted[0];
    return res.status(201).json({
      term: {
        id: row.id,
        category: row.category,
        phrase: row.phrase,
        addedBy: row.addedBy,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

router.delete("/admin/advice-terms/:id", checkAdmin, async (req, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "invalid id" });
    }
    const deleted = await db
      .delete(adviceGuardTermsTable)
      .where(eq(adviceGuardTermsTable.id, id))
      .returning({ id: adviceGuardTermsTable.id });
    if (deleted.length === 0) {
      return res.status(404).json({ error: "term not found" });
    }
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

export default router;
