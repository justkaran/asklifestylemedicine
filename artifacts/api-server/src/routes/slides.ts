import { Router, type IRouter } from "express";
import pool from "../lib/db";

const router: IRouter = Router();

router.get("/slides", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT deck_html, deleted_sids FROM slides_state WHERE id = 1"
    );
    if (rows.length === 0) {
      res.json({ deck_html: null, deleted_sids: [] });
      return;
    }
    res.json({ deck_html: rows[0].deck_html, deleted_sids: rows[0].deleted_sids ?? [] });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

router.post("/slides", async (req, res) => {
  const token = req.headers["x-save-token"];
  if (token !== "palonureditor") {
    res.status(403).json({ error: "Unauthorized" });
    return;
  }
  const { deck_html, deleted_sids } = req.body as {
    deck_html?: string;
    deleted_sids?: string[];
  };
  try {
    await pool.query(
      `INSERT INTO slides_state (id, deck_html, deleted_sids, updated_at)
         VALUES (1, $1, COALESCE($2::jsonb, '[]'), NOW())
       ON CONFLICT (id) DO UPDATE
         SET deck_html    = COALESCE(EXCLUDED.deck_html, slides_state.deck_html),
             deleted_sids = COALESCE(EXCLUDED.deleted_sids, slides_state.deleted_sids),
             updated_at   = NOW()`,
      [
        deck_html ?? null,
        deleted_sids != null ? JSON.stringify(deleted_sids) : null,
      ]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

router.post("/slides/reset", async (_req, res) => {
  try {
    await pool.query(
      "UPDATE slides_state SET deck_html = NULL, deleted_sids = '[]', updated_at = NOW() WHERE id = 1"
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

export default router;
