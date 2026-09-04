import { Router } from "express";
import pool from "../lib/db";

const router = Router();

const EDIT_PASSWORD =
  process.env["AI_NEWSLETTER_EDIT_PASSWORD"] ?? "palonureditor";

const DOC_ID = "slm";

router.get("/ai-newsletter-doc", async (_req, res) => {
  // This is a private proposal. The page (ai-newsletter.html) is stripped from
  // the production build; hide its content from the public in production too so
  // the doc can't be fetched directly via the API. Dev editing stays open.
  if (process.env.NODE_ENV === "production") {
    return res.status(404).json({ error: "Not found" });
  }
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  try {
    const result = await pool.query(
      "SELECT content, updated_at FROM ai_newsletter_doc WHERE id = $1",
      [DOC_ID],
    );
    if (result.rows.length === 0) {
      return res.json({ content: null, updatedAt: null });
    }
    return res.json({
      content: result.rows[0].content,
      updatedAt: result.rows[0].updated_at,
    });
  } catch {
    return res.status(500).json({ error: "Failed to load newsletter doc" });
  }
});

router.put("/ai-newsletter-doc", async (req, res) => {
  const password = (req.header("x-edit-password") ?? "").toString().trim();
  if (password !== EDIT_PASSWORD) {
    return res.status(401).json({ error: "Invalid edit password" });
  }
  const { content } = req.body ?? {};
  if (!Array.isArray(content)) {
    return res
      .status(400)
      .json({ error: "Invalid payload: expected { content: string[] }" });
  }
  if (!content.every((c) => typeof c === "string")) {
    return res
      .status(400)
      .json({ error: "Invalid payload: content must be array of strings" });
  }
  try {
    await pool.query(
      `INSERT INTO ai_newsletter_doc (id, content, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET content = $2::jsonb, updated_at = NOW()`,
      [DOC_ID, JSON.stringify(content)],
    );
    return res.json({ ok: true, savedAt: new Date().toISOString() });
  } catch {
    return res.status(500).json({ error: "Failed to save newsletter doc" });
  }
});

export default router;
