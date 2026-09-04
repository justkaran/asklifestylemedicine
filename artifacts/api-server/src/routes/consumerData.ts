/**
 * Consumer data rights — export ("download my data") and account deletion.
 *
 * Both endpoints require the signed `palonur_consumer` session cookie, which
 * is only ever minted by consuming an emailed magic link — so only the
 * verified owner of the email can trigger either flow. See
 * docs/data-retention-policy.md for the policy these implement.
 *
 * Export: compiles the account's stored profile, subscriptions, newsletter
 * memberships, phone/notification settings, and question history (including
 * saved answers) and emails it through the guarded email path (sendGuarded —
 * caps, serialization, production-only delivery).
 *
 * Deletion: explicit confirm-step (client must send confirm: "DELETE").
 * Anonymizes the account row IN PLACE (so FK'd rows like journey passes and
 * bookings survive without PII), deletes phone opt-ins / notification prefs /
 * session linkage / login tokens / newsletter rows, blanks doorway content
 * while keeping event rows for audit, detaches (never deletes) Stripe billing
 * records, clears cookies, and sends a confirmation email.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import pool from "../lib/db.js";
import {
  getConsumerFromRequest,
  listActiveSubscriptionsForCustomer,
  CONSUMER_COOKIE,
  type ConsumerAccount,
} from "../lib/consumerAuth";

/**
 * STRICT active-subscription count for the deletion guard. Unlike
 * `listActiveSubscriptionsForCustomer` (which deliberately swallows schema
 * errors and returns [] so read surfaces degrade gracefully), this PROPAGATES
 * every error — the deletion route must fail closed (503, no mutation) when
 * it cannot prove the customer has no active subscription.
 *
 * Exposed via `deletionDeps` so tests can substitute a throwing/­counting stub
 * without a module mock.
 */
async function countActiveSubscriptionsStrict(
  stripeCustomerId: string,
): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM stripe.subscriptions
      WHERE customer = $1 AND status IN ('active', 'trialing', 'past_due')`,
    [stripeCustomerId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

export const deletionDeps = {
  countActiveSubs: countActiveSubscriptionsStrict,
};
import { emailRateLimit } from "../middlewares/emailRateLimit";
import { sendGuarded } from "../lib/emailGuard";
import { getResendClient } from "../lib/resendClient";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ── Export ───────────────────────────────────────────────────────────────────

export interface ConsumerExport {
  profile: {
    email: string;
    displayName: string | null;
    createdAt: string | null;
  };
  subscriptions: Array<{
    productName: string | null;
    plan: string | null;
    status: string | null;
  }>;
  newsletterMemberships: Array<{ publication: string; status: string }>;
  phone: { number: string | null; status: string | null };
  notificationPreferences: Array<{ product: string; channel: string }>;
  referral: {
    code: string | null;
    signups: number;
    conversions: number;
  } | null;
  journeyPasses: Array<{
    product: string;
    status: string;
    expiresAt: string;
  }>;
  conversations: Array<{
    surface: "sleep";
    startedAt: string;
    messages: Array<{ role: string; content: string; at: string }>;
  }>;
  questions: Array<{
    askedAt: string;
    surface: string;
    question: string;
  }>;
}

/** Guarded query: a missing table on a fresh DB yields an empty list. */
async function safeRows<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch {
    return [];
  }
}

/** Compile everything we store about one consumer account. */
export async function buildConsumerExport(
  account: ConsumerAccount,
): Promise<ConsumerExport> {
  const [createdRow] = await safeRows(async () => {
    const r = await pool.query<{ created_at: string }>(
      `SELECT created_at FROM consumer_accounts WHERE id = $1`,
      [account.id],
    );
    return r.rows;
  });

  const subs = await listActiveSubscriptionsForCustomer(
    account.stripeCustomerId,
  );

  const newsletterRows = await safeRows(async () => {
    const r = await pool.query<{ name: string; status: string }>(
      `SELECT COALESCE(p.name, 'Newsletter') AS name, s.status
         FROM newsletter_subscribers s
         LEFT JOIN newsletter_publications p ON p.id = s.publication_id
        WHERE s.email = $1`,
      [account.email],
    );
    return r.rows;
  });

  const phoneRows = await safeRows(async () => {
    const r = await pool.query<{ phone: string; status: string }>(
      `SELECT phone, status FROM phone_subscribers
        WHERE consumer_account_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [account.id],
    );
    return r.rows;
  });

  const prefRows = await safeRows(async () => {
    const r = await pool.query<{ product: string; channel: string }>(
      `SELECT product, channel FROM notification_preferences
        WHERE consumer_account_id = $1`,
      [account.id],
    );
    return r.rows;
  });

  const referralRows = await safeRows(async () => {
    const r = await pool.query<{
      code: string;
      signups: string;
      conversions: string;
    }>(
      `SELECT c.code,
              COUNT(*) FILTER (WHERE e.event_type = 'signup') AS signups,
              COUNT(*) FILTER (WHERE e.event_type = 'convert') AS conversions
         FROM referral_codes c
         LEFT JOIN referral_events e ON e.code = c.code
        WHERE c.owner_email = $1
        GROUP BY c.code`,
      [account.email],
    );
    return r.rows;
  });

  const journeyRows = await safeRows(async () => {
    const r = await pool.query<{
      product: string;
      status: string;
      expires_at: string;
    }>(
      `SELECT product, status, expires_at FROM journey_passes
        WHERE consumer_account_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [account.id],
    );
    return r.rows;
  });

  // Full sleep conversation threads directly linked to the
  // account — these hold the actual multi-turn message content, which is the
  // most sensitive thing we store. Capped per thread to keep the email sane;
  // the machine-readable block carries whatever is included here.
  const conversations: ConsumerExport["conversations"] = [];
  for (const [surface, parent, child] of [
    ["sleep", "sleep_conversations", "sleep_conversation_messages"],
  ] as const) {
    const rows = await safeRows(async () => {
      const r = await pool.query<{
        conv_id: string;
        started_at: string;
        role: string;
        content: string;
        msg_at: string;
      }>(
        `SELECT c.id AS conv_id, c.created_at AS started_at,
                m.role, m.content, m.created_at AS msg_at
           FROM ${parent} c
           JOIN ${child} m ON m.conversation_id = c.id
          WHERE c.consumer_account_id = $1
          ORDER BY c.created_at DESC, m.created_at ASC
          LIMIT 400`,
        [account.id],
      );
      return r.rows;
    });
    const byConv = new Map<string, ConsumerExport["conversations"][number]>();
    for (const row of rows) {
      let conv = byConv.get(row.conv_id);
      if (!conv) {
        conv = {
          surface,
          startedAt: new Date(row.started_at).toISOString(),
          messages: [],
        };
        byConv.set(row.conv_id, conv);
      }
      conv.messages.push({
        role: row.role,
        content: row.content,
        at: new Date(row.msg_at).toISOString(),
      });
    }
    conversations.push(...byConv.values());
  }

  // Question history (including saved answers — saving links the session to
  // the account, which is exactly this join): agent_queries linked through
  // this account's visitor sessions. Capped at the 500 most recent.
  const questionRows = await safeRows(async () => {
    const r = await pool.query<{
      created_at: string;
      source: string;
      question: string;
    }>(
      `SELECT q.created_at, q.source, q.question
         FROM agent_queries q
         JOIN visitor_sessions vs ON vs.session_id = q.session_id
        WHERE vs.consumer_account_id = $1
        ORDER BY q.created_at DESC
        LIMIT 500`,
      [account.id],
    );
    return r.rows;
  });

  return {
    profile: {
      email: account.email,
      displayName: account.displayName,
      createdAt: createdRow?.created_at
        ? new Date(createdRow.created_at).toISOString()
        : null,
    },
    subscriptions: subs.map((s) => ({
      productName: s.productName,
      plan: s.palonurPlan,
      status: s.status,
    })),
    newsletterMemberships: newsletterRows.map((r) => ({
      publication: r.name,
      status: r.status,
    })),
    phone: {
      number: phoneRows[0]?.phone ?? null,
      status: phoneRows[0]?.status ?? null,
    },
    notificationPreferences: prefRows,
    referral: referralRows[0]
      ? {
          code: referralRows[0].code,
          signups: Number(referralRows[0].signups),
          conversions: Number(referralRows[0].conversions),
        }
      : null,
    journeyPasses: journeyRows.map((r) => ({
      product: r.product,
      status: r.status,
      expiresAt: new Date(r.expires_at).toISOString(),
    })),
    conversations,
    questions: questionRows.map((r) => ({
      askedAt: new Date(r.created_at).toISOString(),
      surface: r.source,
      question: r.question,
    })),
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function exportEmailHtml(data: ConsumerExport): string {
  const li = (s: string) => `<li>${s}</li>`;
  const subs =
    data.subscriptions
      .map((s) =>
        li(
          `${escapeHtml(s.productName ?? "Subscription")} — ${escapeHtml(s.status ?? "")}`,
        ),
      )
      .join("") || li("None");
  const pubs =
    data.newsletterMemberships
      .map((m) => li(`${escapeHtml(m.publication)} (${escapeHtml(m.status)})`))
      .join("") || li("None");
  const prefs =
    data.notificationPreferences
      .map((p) => li(`${escapeHtml(p.product)}: ${escapeHtml(p.channel)}`))
      .join("") || li("Default (email)");
  const questions =
    data.questions
      .map((q) =>
        li(
          `<span style="color:#888">${escapeHtml(q.askedAt.slice(0, 10))} · ${escapeHtml(q.surface)}</span><br/>${escapeHtml(q.question)}`,
        ),
      )
      .join("") || li("None");
  return `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;max-width:600px;margin:0 auto;padding:24px;">
  <h2 style="margin:0 0 12px;">Your Palonur data export</h2>
  <p style="color:#444;">Everything we store about your account, as of ${escapeHtml(new Date().toISOString().slice(0, 10))}. Full details in the attached JSON block below.</p>
  <h3>Profile</h3>
  <ul><li>Email: ${escapeHtml(data.profile.email)}</li><li>Name: ${escapeHtml(data.profile.displayName ?? "—")}</li><li>Account created: ${escapeHtml(data.profile.createdAt ?? "—")}</li></ul>
  <h3>Active subscriptions</h3><ul>${subs}</ul>
  <h3>Newsletter memberships</h3><ul>${pubs}</ul>
  <h3>Phone</h3><ul><li>${escapeHtml(data.phone.number ?? "None on file")}${data.phone.status ? ` (${escapeHtml(data.phone.status)})` : ""}</li></ul>
  <h3>Notification preferences</h3><ul>${prefs}</ul>
  <h3>Referral</h3><ul>${
    data.referral
      ? li(
          `Code ${escapeHtml(data.referral.code ?? "")} — ${data.referral.signups} signups, ${data.referral.conversions} conversions`,
        )
      : li("None")
  }</ul>
  <h3>Journey passes</h3><ul>${
    data.journeyPasses
      .map((j) => li(`${escapeHtml(j.product)} — ${escapeHtml(j.status)}`))
      .join("") || li("None")
  }</ul>
  <h3>Conversations (${data.conversations.length} threads)</h3><ul>${
    data.conversations
      .map((c) =>
        li(
          `<span style="color:#888">${escapeHtml(c.startedAt.slice(0, 10))} · ${escapeHtml(c.surface)} · ${c.messages.length} messages</span> (full text in the machine-readable copy below)`,
        ),
      )
      .join("") || li("None")
  }</ul>
  <h3>Question history (${data.questions.length}${data.questions.length === 500 ? ", most recent" : ""})</h3><ul>${questions}</ul>
  <h3>Machine-readable copy</h3>
  <pre style="background:#f6f4f0;border-radius:8px;padding:12px;font-size:11px;white-space:pre-wrap;word-break:break-word;">${escapeHtml(JSON.stringify(data, null, 2))}</pre>
  <p style="color:#999;font-size:12px;margin-top:24px;">— Palonur · Stanford Lifestyle Medicine. You received this because it was requested from your signed-in account page. Retention details: see the Privacy Policy.</p>
  </body></html>`;
}

router.post(
  "/consumer/data-export",
  emailRateLimit,
  async (req: Request, res: Response) => {
    const account = await getConsumerFromRequest(req);
    if (!account) return res.status(401).json({ error: "Unauthorized" });
    try {
      const data = await buildConsumerExport(account);
      const conn = await getResendClient();
      if (!conn) {
        return res.status(503).json({
          error: "Email is not configured right now — try again later.",
        });
      }
      const from =
        process.env.CONSUMER_FROM ??
        (conn.fromEmail.includes("<")
          ? conn.fromEmail
          : `Palonur <${conn.fromEmail}>`);
      const { error } = await sendGuarded(
        conn.client,
        {
          from,
          to: account.email,
          subject: "Your Palonur data export",
          html: exportEmailHtml(data),
          text: `Your Palonur data export\n\n${JSON.stringify(data, null, 2)}`,
        },
        { label: "consumer data export" },
      );
      if (error) {
        req.log.error({ err: error }, "consumer data export send failed");
        return res.status(502).json({
          error: "Could not send the export email — try again later.",
        });
      }
      return res.json({ ok: true });
    } catch (e) {
      req.log.error({ err: e }, "consumer data export failed");
      return res.status(500).json({ error: "Export failed" });
    }
  },
);

// ── Deletion ─────────────────────────────────────────────────────────────────

/**
 * Anonymize/remove one consumer account's PII. Exported for tests. Returns
 * the anonymized placeholder email.
 *
 * Runs as ONE transaction so a mid-flow failure leaves the account fully
 * intact (the route's error message promises "no changes were made" — this is
 * what makes that true). Missing tables on a fresh/partially-provisioned DB
 * are handled by checking `information_schema` up front, NOT by catching
 * errors mid-transaction (a caught 42P01 would leave the tx aborted).
 */
export async function deleteConsumerAccountData(
  account: ConsumerAccount,
): Promise<string> {
  const anonEmail = `deleted-account-${account.id}@anonymized.invalid`;
  const client = await pool.connect();
  try {
    const existing = new Set(
      (
        await client.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public'`,
        )
      ).rows.map((r) => r.table_name),
    );
    const run = async (
      table: string,
      sql: string,
      params: unknown[],
    ): Promise<void> => {
      if (!existing.has(table)) return;
      await client.query(sql, params);
    };

    await client.query("BEGIN");

    // Doorway/SMS rows: keep event rows for audit but blank content + linkage.
    if (existing.has("doorway_events")) {
      await run(
        "doorway_links",
        `UPDATE doorway_links SET question = ''
          WHERE doorway_event_id IN
                (SELECT id FROM doorway_events WHERE consumer_account_id = $1)`,
        [account.id],
      );
      await run(
        "doorway_events",
        `UPDATE doorway_events SET consumer_account_id = NULL, body_excerpt = ''
          WHERE consumer_account_id = $1`,
        [account.id],
      );
    }
    // Phone opt-ins hold the raw number — delete outright.
    await run(
      "phone_subscribers",
      `DELETE FROM phone_subscribers WHERE consumer_account_id = $1`,
      [account.id],
    );
    await run(
      "notification_preferences",
      `DELETE FROM notification_preferences WHERE consumer_account_id = $1`,
      [account.id],
    );
    // Sever question-history linkage; agent_queries stay pseudonymous.
    await run(
      "visitor_sessions",
      `DELETE FROM visitor_sessions WHERE consumer_account_id = $1`,
      [account.id],
    );
    // Sleep conversation threads directly linked to the
    // account hold the actual multi-turn message content — delete children
    // then parents outright (explicit child delete: test-provisioned tables
    // may lack the ON DELETE CASCADE of the real schema).
    for (const [parent, child] of [
      ["sleep_conversations", "sleep_conversation_messages"],
    ] as const) {
      if (!existing.has(parent)) continue;
      await run(
        child,
        `DELETE FROM ${child}
          WHERE conversation_id IN
                (SELECT id FROM ${parent} WHERE consumer_account_id = $1)`,
        [account.id],
      );
      await run(
        parent,
        `DELETE FROM ${parent} WHERE consumer_account_id = $1`,
        [account.id],
      );
    }
    // Journey passes stay FK'd to the (anonymized) account, but drop the
    // Stripe checkout-session handle so no billing link remains on our side.
    await run(
      "journey_passes",
      `UPDATE journey_passes SET stripe_session_id = NULL
        WHERE consumer_account_id = $1`,
      [account.id],
    );
    // Referral data: the owner's code row is keyed by email — delete it; any
    // events where this person was the referred party lose the email; the
    // bonus counter row is deleted.
    await run(
      "referral_events",
      `UPDATE referral_events SET recipient_email = NULL
        WHERE recipient_email = $1`,
      [account.email],
    );
    await run(
      "referral_codes",
      `DELETE FROM referral_codes WHERE owner_email = $1`,
      [account.email],
    );
    await run(
      "referral_bonus",
      `DELETE FROM referral_bonus WHERE consumer_account_id = $1`,
      [account.id],
    );
    // Auth artifacts + newsletter rows keyed by email.
    await run(
      "consumer_login_tokens",
      `DELETE FROM consumer_login_tokens WHERE email = $1`,
      [account.email],
    );
    await run(
      "newsletter_subscriber_sessions",
      `DELETE FROM newsletter_subscriber_sessions WHERE email = $1`,
      [account.email],
    );
    await run(
      "newsletter_subscribers",
      `DELETE FROM newsletter_subscribers WHERE email = $1`,
      [account.email],
    );

    // Finally: anonymize the account row in place. Stripe-synced billing rows
    // (stripe.* schema) are retained as financial records but DETACHED — after
    // this update nothing on our side links them to a person.
    await client.query(
      `UPDATE consumer_accounts
          SET email = $2, display_name = NULL, stripe_customer_id = NULL,
              updated_at = NOW()
        WHERE id = $1`,
      [account.id, anonEmail],
    );

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  logger.info(
    { accountId: account.id },
    "consumer account deleted (PII anonymized)",
  );
  return anonEmail;
}

router.post("/consumer/delete-account", async (req: Request, res: Response) => {
  const account = await getConsumerFromRequest(req);
  if (!account) return res.status(401).json({ error: "Unauthorized" });
  const confirm = String((req.body as { confirm?: string })?.confirm ?? "");
  if (confirm.trim().toUpperCase() !== "DELETE") {
    return res
      .status(400)
      .json({ error: "Type DELETE to confirm account deletion." });
  }
  // Never orphan a recurring charge: an account with an active subscription
  // must cancel it first (via the billing portal) so deletion can't leave a
  // paid subscription nobody can manage. Fail CLOSED on a lookup error.
  if (account.stripeCustomerId) {
    try {
      const activeCount = await deletionDeps.countActiveSubs(
        account.stripeCustomerId,
      );
      if (activeCount > 0) {
        return res.status(409).json({
          error:
            "You still have an active subscription. Cancel it first via “Manage billing”, then delete your account.",
        });
      }
    } catch (e) {
      req.log.error({ err: e }, "deletion subscription check failed");
      return res.status(503).json({
        error:
          "We couldn't verify your subscription status just now — please try again shortly.",
      });
    }
  }
  const originalEmail = account.email;
  try {
    await deleteConsumerAccountData(account);
  } catch (e) {
    req.log.error({ err: e }, "consumer account deletion failed");
    return res.status(500).json({
      error: "Deletion failed — no changes were made; please try again.",
    });
  }

  // Confirmation email to the (now removed) address — best-effort.
  try {
    const conn = await getResendClient();
    if (conn) {
      const from =
        process.env.CONSUMER_FROM ??
        (conn.fromEmail.includes("<")
          ? conn.fromEmail
          : `Palonur <${conn.fromEmail}>`);
      await sendGuarded(
        conn.client,
        {
          from,
          to: originalEmail,
          subject: "Your Palonur account has been deleted",
          text:
            "Your Palonur account and personal data have been deleted as you requested. " +
            "Billing records required for financial record-keeping were retained in anonymized form. " +
            "If this wasn't you, contact hello@palonur.com.",
          html: `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;max-width:540px;margin:0 auto;padding:24px;">
  <p>Your Palonur account and personal data have been deleted as you requested.</p>
  <p style="color:#666;font-size:13px;">Billing records required for financial record-keeping were retained in anonymized form. If this wasn't you, contact hello@palonur.com.</p>
  <p style="color:#999;font-size:12px;margin-top:32px;">— Palonur · Stanford Lifestyle Medicine</p>
  </body></html>`,
        },
        { label: "consumer account deletion" },
      );
    }
  } catch (e) {
    req.log.warn({ err: e }, "deletion confirmation email failed");
  }

  res.clearCookie(CONSUMER_COOKIE);
  res.clearCookie("members_session");
  return res.json({ ok: true });
});

export default router;
