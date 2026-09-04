import { logger } from "./logger.js";

/**
 * AgentMail is used INBOUND-ONLY by the newsletter reply loop: it hosts a
 * mailbox that receives reader replies (the newsletter's `Reply-To`) and POSTs a
 * webhook when one arrives. The Q&A answer is sent back OUT via Resend through
 * the existing guarded/capped send path, so there is no second uncapped send
 * path and we never need AgentMail to send.
 *
 * Because of that, the AgentMail SDK client is only needed for one-time setup
 * (create the inbox + register the webhook) and optional large-message
 * hydration. Everything degrades cleanly when AgentMail is unconfigured:
 * newsletters still send (just without a `Reply-To`) and the webhook endpoint
 * no-ops.
 *
 * Config knobs (all optional; absence = feature off):
 *   - NEWSLETTER_QA_INBOX        full inbox address used as the newsletter
 *                                Reply-To, e.g. "palonur-ask@agentmail.to".
 *   - NEWSLETTER_QA_INBOX_USERNAME  username to create at setup (default
 *                                "palonur-ask"); the address is
 *                                "<username>@agentmail.to".
 *   - AGENTMAIL_WEBHOOK_SECRET   shared secret appended to the webhook URL and
 *                                verified on every inbound POST.
 *   - AGENTMAIL_API_KEY          API key (fallback when the Replit AgentMail
 *                                connector is not bound).
 */

const DEFAULT_INBOX_USERNAME = "palonur-ask";

/** The newsletter Reply-To address, or null when the reply loop is off. */
export function qaInboxAddress(): string | null {
  const explicit = process.env.NEWSLETTER_QA_INBOX?.trim();
  if (explicit) return explicit.toLowerCase();
  return null;
}

/** Shared secret used to verify inbound AgentMail webhooks, or null. */
export function webhookSecret(): string | null {
  const s = process.env.AGENTMAIL_WEBHOOK_SECRET?.trim();
  return s ? s : null;
}

/**
 * Whether the inbound reply loop is configured enough to actually process a
 * webhook. We require the shared secret (so we can verify genuineness) AND a
 * Reply-To inbox (so the answer email can invite a follow-up). Missing either
 * means the webhook no-ops.
 */
export function replyLoopConfigured(): boolean {
  return Boolean(webhookSecret() && qaInboxAddress());
}

/**
 * Fetch the AgentMail API key. Prefers the Replit AgentMail connector (so the
 * key is managed + rotated by the platform) and falls back to AGENTMAIL_API_KEY.
 * Returns null when neither is available. Never throws.
 *
 * NOTE: the connector credential fetch mirrors the standard Replit connector
 * proxy snippet; the exact `settings` key is reconciled with the rendered
 * integration snippet once the connector is authorized.
 */
async function getAgentMailApiKey(): Promise<string | null> {
  const direct = process.env.AGENTMAIL_API_KEY?.trim();
  if (direct) return direct;

  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? `repl ${process.env.REPL_IDENTITY}`
    : process.env.WEB_REPL_RENEWAL
      ? `depl ${process.env.WEB_REPL_RENEWAL}`
      : null;
  if (!hostname || !xReplitToken) return null;

  try {
    const res = await fetch(
      `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=agentmail`,
      { headers: { Accept: "application/json", X_REPLIT_TOKEN: xReplitToken } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      items?: Array<{ settings?: Record<string, unknown> }>;
    };
    const settings = data.items?.[0]?.settings ?? {};
    const key =
      (settings.api_key as string | undefined) ??
      (settings.apiKey as string | undefined) ??
      (settings.access_token as string | undefined) ??
      null;
    return key && key.trim() ? key.trim() : null;
  } catch (err) {
    logger.warn({ err }, "AgentMail connector key fetch failed");
    return null;
  }
}

/**
 * Build a fresh AgentMail client, or null when no API key is available. Never
 * cache the client — connector tokens rotate.
 */
export async function getAgentMailClient() {
  const apiKey = await getAgentMailApiKey();
  if (!apiKey) return null;
  try {
    const { AgentMailClient } = await import("agentmail");
    return new AgentMailClient({ apiKey });
  } catch (err) {
    logger.warn({ err }, "AgentMail client init failed");
    return null;
  }
}

/**
 * Idempotently create the Q&A inbox and register the inbound webhook. Safe to
 * run repeatedly (AgentMail dedupes on `client_id`). Returns the inbox address
 * on success, or null when AgentMail / the secret is unconfigured.
 *
 * `webhookUrl` should be the public inbound endpoint; the shared secret is
 * appended as a `?token=` query param and verified on every delivery.
 */
export async function ensureQaInbox(
  webhookUrl: string,
): Promise<{ address: string } | null> {
  const secret = webhookSecret();
  if (!secret) {
    logger.warn("AGENTMAIL_WEBHOOK_SECRET unset — skipping AgentMail setup");
    return null;
  }
  const client = await getAgentMailClient();
  if (!client) {
    logger.warn("AgentMail not configured — skipping inbox/webhook setup");
    return null;
  }

  const username =
    process.env.NEWSLETTER_QA_INBOX_USERNAME?.trim() || DEFAULT_INBOX_USERNAME;

  const inbox = await client.inboxes.create({
    username,
    clientId: `${username}-inbox`,
  });
  const address =
    (inbox as { inboxId?: string; inbox_id?: string }).inboxId ??
    (inbox as { inbox_id?: string }).inbox_id ??
    `${username}@agentmail.to`;

  const url = new URL(webhookUrl);
  url.searchParams.set("token", secret);
  await client.webhooks.create({
    url: url.toString(),
    eventTypes: ["message.received"],
    clientId: "newsletter-reply-webhook",
  });

  return { address };
}
