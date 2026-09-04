/**
 * POST /api/save-answer — "Email me this answer" for the consumer agents.
 *
 * The near-zero-friction onboarding path: an anonymous visitor asks the sleep
 * sleep agent a question, gets the answer, and is then offered ONE
 * ask — their email — to save the answer and come back. We:
 *
 *   1. look up the persisted `agent_queries` row by queryId (the insert runs
 *      AFTER res.end() on the sleep route, so the lookup retries briefly),
 *   2. require the caller's own `palonur_session` cookie to match the row's
 *      session_id (ownership — a leaked queryId must not let anyone email
 *      arbitrary recipients someone else's answer),
 *   3. create/find the consumer account for the email (identity only — NO
 *      capabilities; entitlement always derives from Stripe at read time),
 *   4. link the visitor session to the account,
 *   5. mint a consumer magic-link token and email the answer + sources +
 *      sign-in link, rendered entirely server-side,
 *   6. optionally start the newsletter DOUBLE OPT-IN (a separate, explicit,
 *      unchecked choice in the UI — never silent marketing; the subscriber
 *      stays `pending` until they confirm).
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod/v4";
import { db, pool, consumerLoginTokensTable } from "@workspace/db";
import { emailRateLimit } from "../middlewares/emailRateLimit.js";
import { findOrCreateConsumerByEmail } from "../lib/consumerBilling.js";
import { linkVisitorSessionToAccount } from "../lib/visitorSessions.js";
import { sendAnswerEmail, type AnswerEmailSource } from "../lib/answerEmail.js";
import { subscribePendingToHouseNewsletter } from "./newsletter.js";

const router: IRouter = Router();

const SESSION_COOKIE = "palonur_session";

const bodySchema = z.object({
  queryId: z.uuid(),
  email: z.email(),
  newsletterOptIn: z.boolean().optional(),
});

interface QueryRow {
  id: string;
  session_id: string;
  source: string;
  question: string;
  answer_text: string;
  retrieved_source_ids: number[];
}

/**
 * Only the two consumer surfaces may have their answers emailed. Other
 * sources (embed-agent, partner-keyed calls) log PREDICTABLE constant
 * session_ids (e.g. 'embed-agent'), so admitting them would let anyone
 * forge the cookie to that constant and email a stranger's answer.
 */
const SAVEABLE_SOURCES = ["sleep-agent"];

/** Real browser sessions are UUIDs minted by ensureSessionId. A row whose
 * session_id is NOT UUID-shaped (legacy constant placeholders) can never be
 * owned by a browser, so it is never emailable. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The agent_queries insert is best-effort AFTER res.end(), so a save fired
 * right when the answer finishes can race it. Retry briefly, then give up
 * with a clean 409 (also the outcome for opted-out `palonur_no_log` sessions,
 * whose answers are never persisted).
 */
async function lookupQueryWithRetry(queryId: string): Promise<QueryRow | null> {
  const delays = [0, 700, 1400];
  for (const delay of delays) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    const result = await pool.query(
      `SELECT id, session_id, source, question, answer_text, retrieved_source_ids
         FROM agent_queries
        WHERE id = $1::uuid AND source = ANY($2::text[])
        LIMIT 1`,
      [queryId, SAVEABLE_SOURCES],
    );
    if (result.rows[0]) return result.rows[0] as QueryRow;
  }
  return null;
}

/** Where the emailed magic link should land after sign-in. */
function nextPathForSource(source: string): string {
  return "/sleep?claimed=1";
}

router.post(
  "/save-answer",
  emailRateLimit,
  async (req: Request, res: Response) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "Valid queryId and email required" });
    }
    const { queryId, newsletterOptIn } = parsed.data;
    const email = parsed.data.email.trim().toLowerCase();

    const sessionId = req.cookies?.[SESSION_COOKIE] as string | undefined;
    if (!sessionId) {
      return res.status(401).json({ error: "No session" });
    }

    try {
      const row = await lookupQueryWithRetry(queryId);
      if (!row) {
        return res.status(409).json({
          error: "This answer isn't saved yet — please try again in a moment.",
        });
      }
      // Ownership: only the browser that asked may email this answer. The
      // row's session must be a real browser UUID — constant placeholder
      // session_ids (legacy rows) are unownable by construction, so a forged
      // cookie matching one must still be rejected.
      if (!UUID_RE.test(row.session_id) || row.session_id !== sessionId) {
        return res.status(403).json({ error: "Not your answer" });
      }
      const answerText = (row.answer_text ?? "").trim();
      if (!answerText || answerText === "(personal_help_redirect)") {
        return res.status(409).json({ error: "This answer can't be emailed." });
      }

      // Identity only — a bare consumer account grants zero capabilities.
      const account = await findOrCreateConsumerByEmail(email);
      await linkVisitorSessionToAccount(sessionId, account.id);

      // Magic link: longer-lived than the 30-minute sign-in flow — the whole
      // point of this email is "come back later".
      const token = randomBytes(24).toString("hex");
      await db.insert(consumerLoginTokensTable).values({
        email,
        magicToken: token,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });

      let sources: AnswerEmailSource[] = [];
      const ids = row.retrieved_source_ids ?? [];
      if (ids.length > 0) {
        const result = await pool.query(
          `SELECT title, authors, year, journal, source_url
             FROM sources
            WHERE id = ANY($1::int[])
            ORDER BY array_position($1::int[], id)`,
          [ids],
        );
        sources = (
          result.rows as {
            title: string;
            authors: string | null;
            year: number | null;
            journal: string | null;
            source_url: string | null;
          }[]
        ).map((s) => ({
          title: s.title,
          authors: s.authors,
          year: s.year,
          journal: s.journal,
          sourceUrl: s.source_url,
        }));
      }

      const emailed = await sendAnswerEmail({
        to: email,
        question: row.question,
        answerText,
        sources,
        loginToken: token,
        next: nextPathForSource(row.source),
      });

      // Newsletter is a SEPARATE explicit choice — and even then it only
      // starts the double opt-in (pending until they confirm). Failure here
      // never fails the save.
      let newsletterPending = false;
      if (newsletterOptIn === true) {
        try {
          const sub = await subscribePendingToHouseNewsletter(email, {
            source: "save-answer",
          });
          newsletterPending = sub.pending === true;
        } catch (e) {
          req.log.warn({ err: e }, "save-answer newsletter opt-in failed");
        }
      }

      return res.json({ ok: true, emailed, newsletterPending });
    } catch (e) {
      req.log.error({ err: e }, "save-answer failed");
      return res.status(500).json({ error: "Failed to save answer" });
    }
  },
);

export default router;
