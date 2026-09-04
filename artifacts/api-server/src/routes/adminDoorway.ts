import { Router, type IRouter } from "express";
import { desc, eq, gt, sql, and } from "drizzle-orm";
import { db, doorwayEventsTable, crisisTermsTable } from "@workspace/db";
import { checkAdmin } from "./admin";
import { getCrisisTerms, DEFAULT_CRISIS_TERMS } from "../lib/doorway";

const router: IRouter = Router();

// ── Reply-as-doorway review ─────────────────────────────────────────────────
// Admin surface for the despair-moment text channel: crisis-flagged inbound
// messages (the ONLY events whose text is stored), outcome counts, and the
// admin-editable crisis phrase list. Phone numbers are hashed at ingest, so
// nothing here can identify a sender.

const MAX_EVENTS = 500;

router.get("/admin/doorway-review", checkAdmin, async (req, res) => {
  try {
    const days = Math.min(
      365,
      Math.max(1, parseInt(String(req.query.days ?? "30"), 10) || 30),
    );
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const countRows = await db
      .select({
        outcome: doorwayEventsTable.outcome,
        n: sql<number>`count(*)::int`,
      })
      .from(doorwayEventsTable)
      .where(gt(doorwayEventsTable.createdAt, since))
      .groupBy(doorwayEventsTable.outcome);
    const countsByOutcome: Record<string, number> = {};
    for (const r of countRows) countsByOutcome[r.outcome] = r.n;

    const crisisEvents = await db
      .select({
        id: doorwayEventsTable.id,
        fromPhoneHash: doorwayEventsTable.fromPhoneHash,
        product: doorwayEventsTable.product,
        bodyExcerpt: doorwayEventsTable.bodyExcerpt,
        createdAt: doorwayEventsTable.createdAt,
      })
      .from(doorwayEventsTable)
      .where(
        and(
          gt(doorwayEventsTable.createdAt, since),
          eq(doorwayEventsTable.crisisFlagged, true),
        ),
      )
      .orderBy(desc(doorwayEventsTable.createdAt))
      .limit(MAX_EVENTS);

    return res.json({
      days,
      countsByOutcome,
      crisisEvents: crisisEvents.map((e) => ({
        ...e,
        // Only a short prefix of the hash — enough to correlate repeat
        // senders in the UI, never enough to look anything up.
        fromPhoneHash: e.fromPhoneHash.slice(0, 12),
      })),
      terms: await getCrisisTerms(),
    });
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

// ── Crisis phrase management ────────────────────────────────────────────────

router.post("/admin/crisis-terms", checkAdmin, async (req, res) => {
  try {
    const phrase = String(req.body?.phrase ?? "").trim();
    if (phrase.length < 2 || phrase.length > 120) {
      return res.status(400).json({ error: "phrase must be 2–120 characters" });
    }
    // Seed-when-empty happens inside getCrisisTerms; call it first so a brand
    // new phrase never becomes the ONLY row of an otherwise unseeded table.
    const existing = await getCrisisTerms();
    const dup = existing.find(
      (t) => t.phrase.toLowerCase() === phrase.toLowerCase(),
    );
    if (dup) return res.json({ term: dup, alreadyExists: true });
    const inserted = await db
      .insert(crisisTermsTable)
      .values({ phrase, addedBy: "admin" })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) return res.json({ alreadyExists: true });
    const row = inserted[0];
    return res.status(201).json({
      term: { id: row.id, phrase: row.phrase, addedBy: row.addedBy },
    });
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

router.delete("/admin/crisis-terms/:id", checkAdmin, async (req, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "invalid id" });
    }
    // The screen can never go blind: deleting the last term re-seeds the
    // defaults on the next read (same fail-safe as the advice guard), so a
    // delete is always safe to allow.
    const deleted = await db
      .delete(crisisTermsTable)
      .where(eq(crisisTermsTable.id, id))
      .returning({ id: crisisTermsTable.id });
    if (deleted.length === 0) {
      return res.status(404).json({ error: "term not found" });
    }
    return res.json({ ok: true, defaultCount: DEFAULT_CRISIS_TERMS.length });
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
});

export default router;
