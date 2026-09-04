// Thin, provider-agnostic iMessage send module.
//
// Mirrors the Resend email helper's posture exactly: it reads its credential
// from configured secrets and DEGRADES GRACEFULLY — logs a warning and no-ops
// (returns `{ ok: false, skipped: true }`) when unconfigured — so dev and
// unconfigured environments never crash. The actual provider (Sendblue or
// LoopMessage) is swappable behind this single module; the rest of the server
// only ever calls `sendImessage()`.
//
// There is NO Replit-managed integration for iMessage providers, so the
// credential comes from a plain secret requested through the environment-secrets
// flow (the operator sets up the Sendblue / LoopMessage account).
//
// Like the email path, real delivery is ALSO gated to PRODUCTION ONLY: a key
// present in dev or the `vitest` runner must not fire real texts. The send is a
// no-op (synthetic skip) outside production unless explicitly overridden.
import { logger } from "./logger";

export type ImessageProvider = "sendblue" | "loopmessage";

export interface SendImessageArgs {
  /** Destination phone number, E.164 (e.g. +14155550123). */
  to: string;
  /** Plain-text message body (consent/confirmation only — no marketing). */
  body: string;
  /** Short tag for logs (e.g. "phone opt-in confirmation"). */
  label: string;
}

export interface SendImessageResult {
  ok: boolean;
  /** True when no real send happened (unconfigured or non-production gate). */
  skipped?: boolean;
  /** Short reason tag when skipped/failed. */
  reason?: string;
  error?: unknown;
}

interface ProviderConfig {
  provider: ImessageProvider;
  send(args: SendImessageArgs): Promise<{ ok: boolean; error?: unknown }>;
}

/**
 * Resolve the configured provider + credentials from env, or null when the
 * provider key(s) are unset. Provider is chosen by `IMESSAGE_PROVIDER`
 * (default "sendblue"); each provider reads its own credential secrets.
 */
function getImessageConfig(): ProviderConfig | null {
  const provider = (
    process.env.IMESSAGE_PROVIDER ?? "sendblue"
  ).toLowerCase() as ImessageProvider;

  if (provider === "loopmessage") {
    const authKey = process.env.LOOPMESSAGE_AUTH_KEY;
    const secretKey = process.env.LOOPMESSAGE_SECRET_KEY;
    const senderName = process.env.LOOPMESSAGE_SENDER_NAME;
    if (!authKey || !secretKey || !senderName) return null;
    return {
      provider,
      async send({ to, body }) {
        try {
          const r = await fetch(
            "https://server.loopmessage.com/api/v1/message/send/",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: authKey,
                "Loop-Secret-Key": secretKey,
              },
              body: JSON.stringify({
                recipient: to,
                text: body,
                sender_name: senderName,
              }),
            },
          );
          if (!r.ok) {
            const text = await r.text().catch(() => "");
            return { ok: false, error: `${r.status} ${text}`.trim() };
          }
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e };
        }
      },
    };
  }

  // Default: Sendblue.
  const apiKeyId = process.env.SENDBLUE_API_KEY_ID;
  const apiSecretKey = process.env.SENDBLUE_API_SECRET_KEY;
  if (!apiKeyId || !apiSecretKey) return null;
  return {
    provider: "sendblue",
    async send({ to, body }) {
      try {
        const r = await fetch("https://api.sendblue.co/api/send-message", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "sb-api-key-id": apiKeyId,
            "sb-api-secret-key": apiSecretKey,
          },
          body: JSON.stringify({ number: to, content: body }),
        });
        if (!r.ok) {
          const text = await r.text().catch(() => "");
          return { ok: false, error: `${r.status} ${text}`.trim() };
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e };
      }
    },
  };
}

/** True when a provider credential is configured (used by routes/tests). */
export function imessageConfigured(): boolean {
  return getImessageConfig() !== null;
}

// ── Environment gate: only the production server may send real texts ──────────
// Same rationale as the email guard: a present provider key is reachable from
// dev and the `vitest` runner, so without this gate tests/dev would fire real
// (paid) texts. Allowed only in production unless explicitly overridden.
//   • IMESSAGE_LIVE_OVERRIDE=true — force-enable real sends anywhere.
//   • IMESSAGE_DISABLED=true      — force-disable real sends anywhere.
//   • otherwise disabled under VITEST or NODE_ENV test/development.
export function imessageSendingDisabledReason(): string | null {
  if (process.env.IMESSAGE_LIVE_OVERRIDE === "true") return null;
  if (process.env.IMESSAGE_DISABLED === "true") return "IMESSAGE_DISABLED";
  if (process.env.VITEST) return "test";
  const env = process.env.NODE_ENV;
  if (env === "test") return "test";
  if (env === "development") return "development";
  return null;
}

/**
 * Send one iMessage through the configured provider. Returns `{ ok, skipped }`.
 * No-ops (warn + `{ ok:false, skipped:true }`) when unconfigured OR when the
 * production gate is closed — never throws, so callers can fire-and-forget.
 */
export async function sendImessage(
  args: SendImessageArgs,
): Promise<SendImessageResult> {
  const config = getImessageConfig();
  if (!config) {
    logger.warn(
      { label: args.label, to: args.to },
      "iMessage provider not configured — send skipped (no real text sent)",
    );
    return { ok: false, skipped: true, reason: "unconfigured" };
  }

  const disabled = imessageSendingDisabledReason();
  if (disabled) {
    logger.warn(
      { label: args.label, to: args.to, reason: disabled, provider: config.provider },
      "iMessage sending disabled outside production — send skipped (no real text sent)",
    );
    return { ok: false, skipped: true, reason: disabled };
  }

  const res = await config.send(args);
  if (!res.ok) {
    logger.warn(
      { label: args.label, to: args.to, provider: config.provider, err: res.error },
      "iMessage send failed",
    );
    return { ok: false, error: res.error, reason: "send_failed" };
  }
  logger.info(
    { label: args.label, provider: config.provider },
    "Sent iMessage",
  );
  return { ok: true };
}
