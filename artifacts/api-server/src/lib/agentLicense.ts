import type { Request, Response } from "express";

/**
 * Machine-readable usage policy attached to every KEYED agent answer
 * (programmatic / external-agent access). This is a CONTRACTUAL term we
 * impose on partners — "do not train on these outputs, attribution
 * required" — surfaced as response headers + a `license` body field so an
 * agent can read it programmatically, plus a human-readable terms page.
 *
 * IMPORTANT (honest-claims): this is a *policy/license*, NOT a technical
 * guarantee. We do NOT claim a technical no-training / zero-retention /
 * "corpus never leaves" enforcement. The terms page must say the same.
 * See `.agents/memory/external-data-protection-claims.md`.
 */
export const AGENT_USAGE_POLICY = "no-training";

/** Public, human-readable terms page (served by the palonur SPA). */
export const AGENT_TERMS_PATH = "/agent-license";

// NOTE: this string is emitted as an HTTP HEADER value (X-Palonur-Attribution),
// so it MUST stay ASCII/Latin-1 — Node's res.setHeader throws ERR_INVALID_CHAR
// on characters like an em-dash (U+2014). Keep it a plain hyphen.
export const AGENT_ATTRIBUTION =
  "Source: Palonur - governed expert science. Attribution required; outputs may not be used to train AI models.";

/** Resolve the absolute terms URL, preferring PUBLIC_URL, then the request host. */
export function agentTermsUrl(req: Request): string {
  const fromEnv = process.env.PUBLIC_URL?.replace(/\/+$/, "");
  if (fromEnv) return `${fromEnv}${AGENT_TERMS_PATH}`;
  const proto =
    (req.headers["x-forwarded-proto"] as string)?.split(",")[0]?.trim() ||
    req.protocol ||
    "https";
  const host =
    (req.headers["x-forwarded-host"] as string) ||
    req.headers.host ||
    "palonur.com";
  return `${proto}://${host}${AGENT_TERMS_PATH}`;
}

/**
 * Set the license/usage-policy response headers. Call on the KEYED path only
 * (first-party humans don't get them). Safe to call before SSE writes —
 * headers are buffered until the first body byte.
 */
export function setAgentLicenseHeaders(req: Request, res: Response): void {
  res.setHeader("X-Palonur-Usage-Policy", AGENT_USAGE_POLICY);
  res.setHeader("X-Palonur-License", agentTermsUrl(req));
  res.setHeader("X-Palonur-Attribution", AGENT_ATTRIBUTION);
}

/**
 * Keyed-path variant: same license block, plus the per-licensee invisible
 * fingerprint marker (zero-width encoded, derived from the key's private
 * fingerprint secret) embedded in the attribution string. Call ONLY when
 * `req.partnerKey` is present — first-party/consumer responses must never
 * carry a marker. Best-effort: any fingerprint failure degrades to the
 * plain license payload rather than failing the response.
 *
 * HONEST-LIMITS: the marker is statistical evidence, forgeable/strippable
 * in principle — never cryptographic proof of copying.
 */
export async function agentLicensePayloadKeyed(
  req: Request,
): Promise<ReturnType<typeof agentLicensePayload>> {
  const payload = agentLicensePayload(req);
  const partnerKeyId = (req as Request & { partnerKey?: { id: number } })
    .partnerKey?.id;
  if (partnerKeyId == null) return payload;
  try {
    const { partnerMarker, applyFingerprint } = await import(
      "./ipProtection.js"
    );
    const marker = await partnerMarker(partnerKeyId);
    if (!marker) return payload;
    return {
      ...payload,
      license: {
        ...payload.license,
        attribution: applyFingerprint(payload.license.attribution, marker),
      },
    };
  } catch {
    return payload;
  }
}

/** Structured license block for JSON / SSE-done response bodies. */
export function agentLicensePayload(req: Request): {
  usage_policy: string;
  license: { policy: string; terms_url: string; attribution: string };
} {
  return {
    usage_policy: AGENT_USAGE_POLICY,
    license: {
      policy: AGENT_USAGE_POLICY,
      terms_url: agentTermsUrl(req),
      attribution: AGENT_ATTRIBUTION,
    },
  };
}
