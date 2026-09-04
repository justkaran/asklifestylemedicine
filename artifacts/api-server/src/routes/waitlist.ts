import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import pool from "../lib/db";

const router: IRouter = Router();

function checkAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.signedCookies?.palonur_admin === "1") return next();
  res.status(401).json({ error: "unauthorized" });
}

router.post("/waitlist", async (req, res) => {
  const { name, email, source } = req.body as {
    name?: string;
    email?: string;
    source?: string;
  };
  if (!name || !email) {
    res.status(400).json({ error: "name and email required" });
    return;
  }
  const emailClean = email.trim().toLowerCase();
  const nameClean = name.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailClean)) {
    res.status(400).json({ error: "invalid email" });
    return;
  }
  try {
    await pool.query(
      `INSERT INTO palonur_waitlist (name, email, source)
       VALUES ($1, $2, $3)
       ON CONFLICT (LOWER(email)) DO NOTHING`,
      [nameClean, emailClean, source ?? "sleep-agent"],
    );
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "waitlist insert failed");
    res.status(500).json({ error: "db error" });
  }
});

router.get("/admin/waitlist", checkAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, email, source, created_at FROM palonur_waitlist ORDER BY created_at DESC`,
    );
    res.json({ total: r.rowCount, entries: r.rows });
  } catch (err) {
    req.log.error({ err }, "waitlist query failed");
    res.status(500).json({ error: "db error" });
  }
});

export default router;
