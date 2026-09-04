/**
 * Bot / crawler detection for visitor analytics.
 *
 * Two signals, either one flags the pageview as a bot:
 *  1. User-agent match against well-known crawler tokens (Googlebot, Bingbot,
 *     GPTBot, generic "bot/crawler/spider" markers, headless browsers).
 *  2. Client IP inside a known cloud / data-center range (Microsoft/Bing and
 *     Google crawl fleets). Production review showed most "visitors" were
 *     Bingbot from Microsoft ranges (Quincy WA, Boydton VA, Des Moines) and
 *     Google Cloud bots (North Charleston) — real humans do not browse from
 *     these ranges.
 *
 * The CIDR list is deliberately conservative: verified crawler ranges plus the
 * big Azure/GCP compute blocks the observed bot traffic came from, NOT every
 * cloud provider. It is shared with the boot-time SQL backfill (UA was never
 * stored, so historical rows can only be classified by IP).
 */

// Substring/regex UA test. Case-insensitive. Covers the major search crawlers,
// AI crawlers, link preview fetchers, monitoring agents, and generic markers.
export const BOT_UA_RE =
  /bot|crawler|spider|crawling|slurp|bingpreview|facebookexternalhit|embedly|quora link preview|outbrain|vkshare|w3c_validator|whatsapp|telegrambot|headlesschrome|phantomjs|puppeteer|playwright|python-requests|python-urllib|aiohttp|httpx|go-http-client|java\/|libwww|curl\/|wget\/|okhttp|scrapy|feedfetcher|mediapartners|adsbot|apis-google|duckduckgo|baiduspider|yandex|sogou|exabot|ia_archiver|semrush|ahrefs|mj12bot|dotbot|petalbot|bytespider|gptbot|oai-searchbot|chatgpt-user|claudebot|claude-web|anthropic-ai|perplexitybot|ccbot|amazonbot|applebot|pingdom|uptimerobot|statuscake|site24x7|newrelicpinger|node-fetch|axios\//i;

/**
 * Known crawler / data-center IPv4 ranges (CIDR).
 * Sources: Microsoft's published Bingbot ranges + the Azure blocks the observed
 * crawl traffic used; Google's published Googlebot range + the GCP blocks used
 * by its cloud crawlers.
 */
export const DATACENTER_CIDRS: string[] = [
  // --- Microsoft / Bingbot (published bingbot ranges) ---
  "157.55.0.0/16",
  "157.56.0.0/16",
  "207.46.0.0/16",
  "40.77.0.0/16",
  "13.66.0.0/16",
  "13.67.0.0/16",
  "52.167.144.0/24",
  "52.162.161.0/24",
  "131.253.21.0/24",
  "131.253.22.0/23",
  "131.253.24.0/22",
  "131.253.46.0/23",
  "199.30.16.0/20",
  // Azure compute blocks observed carrying crawler traffic
  "20.0.0.0/11",
  "20.32.0.0/11",
  "20.64.0.0/10",
  "20.128.0.0/16",
  "40.64.0.0/13",
  "40.74.0.0/15",
  "40.76.0.0/14",
  "40.80.0.0/12",
  "40.96.0.0/12",
  "40.112.0.0/13",
  "40.120.0.0/14",
  "40.124.0.0/16",
  "40.125.0.0/17",
  "52.224.0.0/11",
  "52.160.0.0/11",
  "52.96.0.0/12",
  "52.112.0.0/14",
  "104.40.0.0/13",
  "104.208.0.0/13",
  "137.116.0.0/15",
  "168.61.0.0/16",
  "168.62.0.0/15",
  "191.232.0.0/13",
  // --- Google ---
  "66.249.64.0/19", // Googlebot (published)
  "64.233.160.0/19",
  "72.14.192.0/18",
  "74.125.0.0/16",
  "209.85.128.0/17",
  "216.239.32.0/19",
  // Google Cloud compute blocks (North Charleston etc.)
  "34.64.0.0/10",
  "34.128.0.0/10",
  "35.184.0.0/13",
  "35.192.0.0/12",
  "35.208.0.0/12",
  "35.224.0.0/12",
  "35.240.0.0/13",
  "104.154.0.0/15",
  "104.196.0.0/14",
  "130.211.0.0/16",
  "146.148.0.0/17",
];

interface ParsedCidr {
  base: number;
  mask: number;
}

function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

const PARSED_CIDRS: ParsedCidr[] = DATACENTER_CIDRS.map((cidr) => {
  const [ip, bitsStr] = cidr.split("/");
  const bits = parseInt(bitsStr, 10);
  const base = ipv4ToInt(ip)!;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, mask };
});

/** True when the (IPv4) address falls in a known crawler/data-center range. */
export function isDataCenterIp(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false; // IPv6 / malformed — no range data, don't flag
  return PARSED_CIDRS.some((c) => ((n & c.mask) >>> 0) === c.base);
}

/** Combined verdict used at pageview-insert time. */
export function isBotRequest(ua: string, ip: string): boolean {
  return (ua !== "" && BOT_UA_RE.test(ua)) || isDataCenterIp(ip);
}

/**
 * Strict IPv4 regex for SQL (each octet 0-255). The `ip` column is TEXT and
 * historically stored the raw `x-forwarded-for` value unvalidated, so a loose
 * `\d{1,3}` guard would let values like `300.1.1.1` through to `::inet` and
 * crash the boot backfill.
 */
export const IPV4_STRICT_SQL_RE =
  "^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$";

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null }>;
}

/**
 * Idempotent IP-range backfill for `palonur_pageviews.is_bot` (UA was never
 * stored, so historical rows can only be classified by IP). Safe to run every
 * boot: only flips FALSE→TRUE, and the CASE expression guarantees the `::inet`
 * cast is only ever evaluated on strictly-validated IPv4 text — a malformed
 * stored value must never be able to turn boot into a crash loop.
 */
export async function backfillBotIpFlags(
  db: Queryable,
): Promise<number> {
  const r = await db.query(
    `UPDATE palonur_pageviews
     SET is_bot = TRUE
     WHERE is_bot = FALSE
       AND CASE
             WHEN ip ~ '${IPV4_STRICT_SQL_RE}'
             THEN ip::inet <<= ANY ($1::inet[])
             ELSE FALSE
           END`,
    [DATACENTER_CIDRS],
  );
  return r.rowCount ?? 0;
}
