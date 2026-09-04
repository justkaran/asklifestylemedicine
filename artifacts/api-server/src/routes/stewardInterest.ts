/**
 * POST /steward-interest
 *   Lightweight steward interest form on the public landing page ("Apply to
 *   become a steward"). Captures name, email, institution, and area of
 *   expertise; stores the submission and forwards it to the admin inbox
 *   through the guarded email path (sendGuarded — never raw Resend).
 *
 *   Deliberately NOT a full application pipeline: no status tracking, no
 *   vetting, no invites. It only records and notifies.
 */
import { Router, type Request, type Response } from "express";
import pool from "../lib/db.js";
import { getResendClient } from "../lib/resendClient";
import { sendGuarded } from "../lib/emailGuard";

const router = Router();

// Self-provision the table on first use — boot-time DDL in index.ts does not
// run when tests import app.ts directly, and a lazy ensure keeps this route
// self-contained either way.
let ensured: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  if (!ensured) {
    ensured = pool
      .query(
        `CREATE TABLE IF NOT EXISTS steward_interest (
           id SERIAL PRIMARY KEY,
           name TEXT NOT NULL,
           email TEXT NOT NULL,
           institution TEXT NOT NULL DEFAULT '',
           expertise TEXT NOT NULL DEFAULT '',
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`,
      )
      .then(() => undefined)
      .catch((err) => {
        ensured = null; // retry on next request
        throw err;
      });
  }
  return ensured;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

router.post("/steward-interest", async (req: Request, res: Response) => {
  const name        = typeof req.body?.name        === "string" ? req.body.name.slice(0, 160).trim()        : "";
  const email       = typeof req.body?.email       === "string" ? req.body.email.slice(0, 200).trim()       : "";
  const institution = typeof req.body?.institution === "string" ? req.body.institution.slice(0, 200).trim() : "";
  const expertise   = typeof req.body?.expertise   === "string" ? req.body.expertise.slice(0, 500).trim()   : "";

  if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: "name and a valid email are required" });
    return;
  }

  try {
    await ensureTable();
    await pool.query(
      `INSERT INTO steward_interest (name, email, institution, expertise)
       VALUES ($1, $2, $3, $4)`,
      [name, email, institution, expertise],
    );
  } catch (err) {
    req.log.error({ err }, "steward-interest: failed to store submission");
    res.status(500).json({ error: "could not record your submission — please try again" });
    return;
  }

  // Notify admins through the guarded path. Storage above is the source of
  // truth; a failed/deferred email must not fail the request.
  const conn = await getResendClient();
  if (conn) {
    const { error } = await sendGuarded(
      conn.client,
      {
        from: `Palonur <${conn.fromEmail}>`,
        to: "karan@palonur.com",
        replyTo: email,
        subject: `Steward interest: ${name}${institution ? ` (${institution})` : ""}`,
        html: `
          <p><strong>Name:</strong> ${esc(name)}</p>
          <p><strong>Email:</strong> ${esc(email)}</p>
          <p><strong>Institution:</strong> ${esc(institution) || "<em>(not given)</em>"}</p>
          <p><strong>Area of expertise:</strong> ${esc(expertise) || "<em>(not given)</em>"}</p>
          <hr>
          <p style="color:#888;font-size:12px">Sent from the "Apply to become a steward" form on the Palonur landing page. Stored in steward_interest.</p>
        `,
        text: `Steward interest submission\n\nName: ${name}\nEmail: ${email}\nInstitution: ${institution || "(not given)"}\nExpertise: ${expertise || "(not given)"}`,
      },
      { label: "steward interest form" },
    );
    if (error) req.log.warn({ err: error }, "steward-interest: notification email not sent");
  } else {
    req.log.warn({ name, email }, "steward-interest: Resend not configured — stored only");
  }

  res.json({ ok: true });
});

export default router;
