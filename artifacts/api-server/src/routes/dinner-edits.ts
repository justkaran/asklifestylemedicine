import { Router } from "express";
import pool from "../lib/db";

const router = Router();

router.get("/dinner-edits", async (_req, res) => {
  try {
    const result = await pool.query("SELECT edits FROM dinner_edits WHERE id = 1");
    if (result.rows.length === 0) {
      return res.json({ edits: {} });
    }
    return res.json({ edits: result.rows[0].edits });
  } catch (err) {
    return res.status(500).json({ error: "Failed to load edits" });
  }
});

router.post("/dinner-edits", async (req, res) => {
  try {
    const { edits } = req.body;
    if (!edits || typeof edits !== "object") {
      return res.status(400).json({ error: "Invalid edits payload" });
    }
    await pool.query(
      `INSERT INTO dinner_edits (id, edits, updated_at)
       VALUES (1, $1, NOW())
       ON CONFLICT (id) DO UPDATE SET edits = $1, updated_at = NOW()`,
      [JSON.stringify(edits)]
    );
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "Failed to save edits" });
  }
});

export default router;
