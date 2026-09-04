import { Resend } from "resend";
import { logger } from "./logger";

export interface ResendConnection {
  client: Resend;
  /** Verified sender configured on the Resend connector (or a safe default). */
  fromEmail: string;
}

/**
 * Resolves a Resend client from the Replit Resend connector, falling back to a
 * raw RESEND_API_KEY env var when the connector proxy isn't reachable (e.g.
 * local scripts). Returns null when no credential is available so callers can
 * degrade gracefully instead of throwing.
 *
 * This is the single source of truth for Resend credentials — every email
 * module should resolve through here so the connected connector is honored in
 * both development and production.
 */
export async function getResendClient(): Promise<ResendConnection | null> {
  try {
    const hostname = process.env["REPLIT_CONNECTORS_HOSTNAME"];
    const xReplitToken = process.env["REPL_IDENTITY"]
      ? "repl " + process.env["REPL_IDENTITY"]
      : process.env["WEB_REPL_RENEWAL"]
        ? "depl " + process.env["WEB_REPL_RENEWAL"]
        : null;

    if (!hostname || !xReplitToken) {
      const apiKey = process.env["RESEND_API_KEY"];
      if (!apiKey) return null;
      return { client: new Resend(apiKey), fromEmail: "checkin@palonur.com" };
    }

    const data = await fetch(
      "https://" +
        hostname +
        "/api/v2/connection?include_secrets=true&connector_names=resend",
      {
        headers: {
          Accept: "application/json",
          "X-Replit-Token": xReplitToken,
        },
      },
    )
      .then((r) => r.json())
      .then(
        (d) =>
          (
            d as {
              items?: Array<{
                settings?: { api_key?: string; from_email?: string };
              }>;
            }
          ).items?.[0],
      );

    if (!data?.settings?.api_key) {
      // Connector reachable but no credential — fall back to env if present.
      const apiKey = process.env["RESEND_API_KEY"];
      if (!apiKey) return null;
      return { client: new Resend(apiKey), fromEmail: "checkin@palonur.com" };
    }

    return {
      client: new Resend(data.settings.api_key),
      fromEmail: data.settings.from_email || "checkin@palonur.com",
    };
  } catch (e) {
    logger.error({ err: e }, "getResendClient failed to resolve Resend credentials");
    return null;
  }
}
