import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import pool from "../lib/db";

const router: IRouter = Router();

// Reuse the sleep-agent's per-browser session token (set httpOnly during an
// ask) so an intent can be loosely correlated to the same visitor without any
// PII. Never required.
const SESSION_COOKIE = "palonur_session";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.signedCookies?.palonur_admin === "1") return next();
  res.status(401).json({ error: "unauthorized" });
}

/**
 * Soft payment-intent capture for the brand-neutral SleepZeit pilot.
 * Records willingness-to-pay only — NEVER charges anything.
 */
router.post("/sleepzeit/intent", async (req, res) => {
  const { email, wouldPay, priceLabel, queryId } = req.body as {
    email?: string;
    wouldPay?: boolean;
    priceLabel?: string;
    queryId?: string | null;
  };

  const emailClean = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(emailClean)) {
    res.status(400).json({ error: "Please enter a valid email address." });
    return;
  }
  if (typeof wouldPay !== "boolean") {
    res.status(400).json({ error: "wouldPay (boolean) is required." });
    return;
  }
  const priceClean =
    typeof priceLabel === "string" && priceLabel.trim()
      ? priceLabel.trim().slice(0, 80)
      : "unspecified";

  const queryIdClean =
    typeof queryId === "string" && UUID_RE.test(queryId) ? queryId : null;
  const sessionId =
    typeof req.cookies?.[SESSION_COOKIE] === "string"
      ? req.cookies[SESSION_COOKIE]
      : null;

  try {
    await pool.query(
      `INSERT INTO sleepzeit_intents (email, would_pay, price_label, query_id, session_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [emailClean, wouldPay, priceClean, queryIdClean, sessionId],
    );
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "sleepzeit intent insert failed");
    res.status(500).json({ error: "Could not save your response." });
  }
});

router.get("/admin/sleepzeit/intents", checkAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, email, would_pay, price_label, query_id, created_at
         FROM sleepzeit_intents
        ORDER BY created_at DESC`,
    );
    const wouldPay = r.rows.filter((row) => row.would_pay).length;
    res.json({
      total: r.rowCount,
      wouldPay,
      conversionRate: r.rowCount ? wouldPay / r.rowCount : 0,
      entries: r.rows,
    });
  } catch (err) {
    req.log.error({ err }, "sleepzeit intents query failed");
    res.status(500).json({ error: "db error" });
  }
});

export default router;
