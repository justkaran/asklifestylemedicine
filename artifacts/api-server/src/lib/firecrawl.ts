import { logger } from "./logger.js";

/**
 * Thin Firecrawl HTTP client for the talk-crawl pipeline (Task #168).
 *
 * Firecrawl is used for two things:
 *   1. `searchTalks` — discover web pages where a faculty member appears
 *      (talks, podcasts, interviews).
 *   2. `scrapeMarkdown` — pull the readable text of a page (used to harvest a
 *      transcript when one is published on the page).
 *
 * Degrades gracefully: when `FIRECRAWL_API_KEY` is unset, `isFirecrawlConfigured`
 * returns false and callers surface a clear "not configured" message instead of
 * throwing opaque network errors. Operators can still paste URLs directly.
 */
const FIRECRAWL_BASE = "https://api.firecrawl.dev";

export function isFirecrawlConfigured(): boolean {
  return Boolean(process.env.FIRECRAWL_API_KEY);
}

export interface FirecrawlSearchResult {
  url: string;
  title: string;
  description: string | null;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
    "Content-Type": "application/json",
  };
}

/**
 * Discover candidate appearance pages for a person. Returns [] when Firecrawl
 * is not configured or the call fails (logged) — discovery is best-effort and
 * the operator can always paste URLs.
 */
export async function searchTalks(
  query: string,
  opts: { limit?: number } = {},
): Promise<FirecrawlSearchResult[]> {
  if (!isFirecrawlConfigured()) return [];
  const limit = Math.max(1, Math.min(20, opts.limit ?? 10));
  try {
    const res = await fetch(`${FIRECRAWL_BASE}/v1/search`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ query, limit }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, body: body.slice(0, 500) },
        "Firecrawl search failed",
      );
      return [];
    }
    const json = (await res.json()) as {
      data?: Array<{ url?: string; title?: string; description?: string }>;
    };
    const rows = json.data ?? [];
    return rows
      .filter((r): r is { url: string; title?: string; description?: string } =>
        Boolean(r.url),
      )
      .map((r) => ({
        url: r.url,
        title: (r.title ?? r.url).slice(0, 1000),
        description: r.description ?? null,
      }));
  } catch (err) {
    logger.warn({ err }, "Firecrawl search threw");
    return [];
  }
}

/**
 * Scrape a single page to markdown. Returns null when not configured or the
 * scrape fails / yields no usable text.
 */
export async function scrapeMarkdown(url: string): Promise<string | null> {
  if (!isFirecrawlConfigured()) return null;
  try {
    const res = await fetch(`${FIRECRAWL_BASE}/v1/scrape`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, url, body: body.slice(0, 500) },
        "Firecrawl scrape failed",
      );
      return null;
    }
    const json = (await res.json()) as { data?: { markdown?: string } };
    const md = json.data?.markdown?.trim();
    return md && md.length > 0 ? md : null;
  } catch (err) {
    logger.warn({ err, url }, "Firecrawl scrape threw");
    return null;
  }
}
