import { Router } from "express";
import pool from "../lib/db";

const router = Router();

const EDIT_PASSWORD =
  process.env["REACH_EDIT_PASSWORD"] ?? "palonureditor";

router.get("/reach-tech", async (_req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  try {
    const result = await pool.query(
      "SELECT content, updated_at FROM reach_tech_doc WHERE id = 1",
    );
    if (result.rows.length === 0) {
      return res.json({ content: null, updatedAt: null });
    }
    return res.json({
      content: result.rows[0].content,
      updatedAt: result.rows[0].updated_at,
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to load tech doc" });
  }
});

router.put("/reach-tech", async (req, res) => {
  const password =
    (req.header("x-edit-password") ?? "").toString().trim();
  if (password !== EDIT_PASSWORD) {
    return res.status(401).json({ error: "Invalid edit password" });
  }
  const { content } = req.body ?? {};
  if (typeof content !== "string") {
    return res
      .status(400)
      .json({ error: "Invalid payload: expected { content: string }" });
  }
  if (content.length > 2_000_000) {
    return res.status(413).json({ error: "Content too large" });
  }
  try {
    await pool.query(
      `INSERT INTO reach_tech_doc (id, content, updated_at)
       VALUES (1, $1, NOW())
       ON CONFLICT (id) DO UPDATE SET content = $1, updated_at = NOW()`,
      [content],
    );
    return res.json({ ok: true, savedAt: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: "Failed to save tech doc" });
  }
});

export default router;
