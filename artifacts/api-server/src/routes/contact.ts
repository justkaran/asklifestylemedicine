/**
 * POST /contact
 *   Accepts a message from a visitor who wants to reach Karan directly.
 *   Fields: name (required), email (required), message (optional).
 *   Sends a forwarding email via Resend and returns 200 on success.
 */
import { Router, type Request, type Response } from "express";
import { getResendClient } from "../lib/resendClient";

const router = Router();

router.post("/contact", async (req: Request, res: Response) => {
  const name    = typeof req.body?.name    === "string" ? req.body.name.slice(0, 120).trim()    : "";
  const email   = typeof req.body?.email   === "string" ? req.body.email.slice(0, 200).trim()   : "";
  const message = typeof req.body?.message === "string" ? req.body.message.slice(0, 2000).trim() : "";

  if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: "name and a valid email are required" });
    return;
  }

  const conn = await getResendClient();
  if (conn) {
    await conn.client.emails.send({
      from: `Palonur <${conn.fromEmail}>`,
      to:   ["karan@palonur.com"],
      replyTo: email,
      subject: `Message from ${name} via palonur.com`,
      html: `
        <p><strong>From:</strong> ${name} &lt;${email}&gt;</p>
        ${message ? `<p><strong>Message:</strong></p><blockquote style="border-left:3px solid #E8352A;margin:0;padding:0 12px;color:#444">${message.replace(/\n/g, "<br>")}</blockquote>` : "<p><em>(No message — just a name and email.)</em></p>"}
        <hr>
        <p style="color:#888;font-size:12px">Sent from the Palonur founder section contact form.</p>
      `,
    }).catch((err: unknown) => {
      req.log.warn({ err }, "contact: Resend send failed");
    });
  } else {
    req.log.warn({ name, email }, "contact: Resend not configured — message not sent");
  }

  res.json({ ok: true });
});

export default router;
