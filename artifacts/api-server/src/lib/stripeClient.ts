import Stripe from "stripe";
import { StripeSync } from "stripe-replit-sync";
import { logger } from "./logger";

/**
 * Thrown when Stripe is genuinely NOT connected (no integration / missing
 * secret), as opposed to a transient failure reaching the connector API. Lets
 * callers (e.g. the admin mode indicator) tell "not connected" apart from
 * "couldn't check right now" instead of conflating both into one state.
 */
export class StripeNotConnectedError extends Error {}

/**
 * Fetches Stripe credentials from the Replit connection API.
 * Not cached — tokens can rotate, so fetch fresh each time.
 */
async function getStripeCredentials(): Promise<{
  secretKey: string;
  webhookSecret?: string;
  accountId?: string;
}> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;

  if (!hostname || !xReplitToken) {
    throw new StripeNotConnectedError(
      "Missing Replit environment variables. " +
        "Ensure the Stripe integration is connected via the Integrations tab.",
    );
  }

  const resp = await fetch(
    `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=stripe`,
    {
      headers: { Accept: "application/json", X_REPLIT_TOKEN: xReplitToken },
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!resp.ok) {
    throw new Error(
      `Failed to fetch Stripe credentials: ${resp.status} ${resp.statusText}`,
    );
  }

  const data = (await resp.json()) as {
    items?: Array<{
      settings?: {
        secret?: string;
        webhook_secret?: string;
        account_id?: string;
      };
    }>;
  };
  const settings = data.items?.[0]?.settings;

  if (!settings?.secret) {
    throw new StripeNotConnectedError(
      "Stripe integration not connected or missing secret key. " +
        "Connect Stripe via the Integrations tab first.",
    );
  }

  return {
    secretKey: settings.secret,
    webhookSecret: settings.webhook_secret,
    accountId: settings.account_id,
  };
}

/**
 * Returns a fresh authenticated Stripe client.
 * Not cached — fetches credentials on every call so rotated keys are picked up.
 */
export async function getUncachableStripeClient(): Promise<Stripe> {
  const { secretKey } = await getStripeCredentials();
  return new Stripe(secretKey);
}

/**
 * Returns a fresh StripeSync instance for webhook processing and data sync.
 * Not cached — fetches credentials on every call so rotated keys are picked up.
 */
export async function getStripeSync(): Promise<StripeSync> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  const { secretKey, webhookSecret } = await getStripeCredentials();
  const sync = new StripeSync({
    poolConfig: { connectionString: databaseUrl },
    stripeSecretKey: secretKey,
    stripeWebhookSecret: webhookSecret ?? "",
  });
  // StripeSync creates its own internal pg Pool with NO "error" listener.
  // Without one, an error on an idle client (e.g. Postgres terminating
  // connections during a publish/restart — 57P01) is emitted on the pool
  // and crashes the whole Node process. This is exactly what took prod down
  // during the July 2026 publish window: our own pools logged and recovered,
  // but the StripeSync pool's unhandled "error" event killed the server.
  sync.postgresClient.pool.on("error", (err) => {
    logger.warn(
      { err },
      "stripe-sync pg pool idle client error; pool will recover",
    );
  });
  // Idle-listener only covers pooled clients; a CHECKED-OUT client hit by a
  // backend termination emits "error" on the bare client and would crash the
  // process. Consume it per-client at connect time.
  sync.postgresClient.pool.on("connect", (client) => {
    client.on("error", (err) => {
      logger.warn(
        { err },
        "stripe-sync pg client connection error; pool will recover",
      );
    });
  });
  return sync;
}

/**
 * Best-effort check that the Stripe integration is connected. Used to gate
 * startup sync + checkout so the server stays up (and the rest of the API keeps
 * working) when Stripe hasn't been connected yet.
 */
export async function isStripeConnected(): Promise<boolean> {
  try {
    await getStripeCredentials();
    return true;
  } catch {
    return false;
  }
}

/**
 * Reports whether the connected Stripe account is in TEST (sandbox) or LIVE
 * (real-payments) mode, derived from the secret-key prefix. The mode is fixed
 * by which Stripe account is connected to this environment — in development the
 * Replit connector hands out a sandbox/test key, and live keys are supplied via
 * the Publish pane in production. There is intentionally no runtime switch: a
 * single account/key drives the synced `stripe.*` mirror and the managed
 * webhook, so the mode follows the environment.
 *
 * NEVER returns the secret key itself — only the derived mode and the public
 * account id (`acct_…`, safe to display to an admin).
 */
export async function getStripeMode(): Promise<{
  status: "test" | "live" | "unknown" | "not_connected" | "unavailable";
  accountId: string | null;
}> {
  try {
    const { secretKey, accountId } = await getStripeCredentials();
    const status: "test" | "live" | "unknown" = /^[a-z]+_live_/.test(secretKey)
      ? "live"
      : /^[a-z]+_test_/.test(secretKey)
        ? "test"
        : "unknown";
    return { status, accountId: accountId ?? null };
  } catch (err) {
    // Genuinely not connected vs. a transient failure reaching the connector —
    // the indicator must not claim "not connected" when it simply couldn't check.
    return {
      status:
        err instanceof StripeNotConnectedError ? "not_connected" : "unavailable",
      accountId: null,
    };
  }
}
