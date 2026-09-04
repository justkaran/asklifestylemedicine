import type { Request } from "express";

/**
 * Shared client-IP + coarse geo-IP helpers used by request-logging surfaces
 * (pageview analytics, OTL dashboard login audit). `trust proxy` is set in
 * app.ts, so `x-forwarded-for` carries the real client chain.
 */
export function getIp(req: Request): string {
  return (
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    ""
  );
}

const LOCAL_IP_RE =
  /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|::1$|localhost)/;

export interface GeoResult {
  country: string;
  country_code: string;
  city: string;
}

/**
 * Best-effort coarse geolocation for a public IP via ip-api.com (free, no key).
 * Returns null for private/loopback IPs and on any error so callers degrade
 * silently.
 */
export async function geoLookup(ip: string): Promise<GeoResult | null> {
  if (!ip || LOCAL_IP_RE.test(ip)) return null;
  try {
    const r = await fetch(
      `http://ip-api.com/json/${ip}?fields=status,country,countryCode,city`,
      { signal: AbortSignal.timeout(2000) },
    );
    if (!r.ok) return null;
    const d = (await r.json()) as {
      status: string;
      country: string;
      countryCode: string;
      city: string;
    };
    if (d.status !== "success") return null;
    return { country: d.country, country_code: d.countryCode, city: d.city };
  } catch {
    return null;
  }
}
