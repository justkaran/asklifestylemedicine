import ytdl from "@distube/ytdl-core";
import { logger } from "./logger.js";

/**
 * Best-effort media resolution helpers for the talk-crawl pipeline (Task #168).
 *
 * Collection paths that don't need a third-party scraper:
 *   - `resolvePodcastAudioUrl` — turn a podcast *episode page* into a direct
 *     audio (enclosure) URL so the bytes can be sent to ElevenLabs Scribe when
 *     no published transcript exists. Looks at the page itself (og:audio,
 *     `<source>`, inline mp3) and, failing that, follows a linked RSS feed and
 *     reads its first `<enclosure>`.
 *   - `fetchYouTubeTranscript` — pull a video's caption track (the public
 *     `timedtext` endpoint referenced from the watch page) and flatten it to
 *     plain text. No audio download required.
 *   - `resolveYouTubeAudioUrl` — the fallback when a video has NO captions:
 *     server-side extraction of a direct audio-only stream URL (via
 *     `@distube/ytdl-core`, a pure-JS yt-dlp equivalent) that is then handed to
 *     ElevenLabs Scribe for STT, so caption-less talks are still transcribed.
 *
 * All degrade gracefully: any failure logs at `warn` and returns `null` so the
 * worker can fall through to its next strategy or flag the candidate.
 */

const UA =
  "Mozilla/5.0 (compatible; PalonurTalkCrawler/1.0; +https://palonur.com)";

function isAudioUrl(url: string): boolean {
  return /\.(mp3|m4a|wav|aac|ogg)(\?|#|$)/i.test(url);
}

/** Pull the first audio `<enclosure url="…">` out of an RSS/Atom feed body. */
function firstEnclosure(xml: string): string | null {
  const tagRe = /<enclosure\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml)) !== null) {
    const tag = m[0];
    const urlMatch = tag.match(/\burl\s*=\s*["']([^"']+)["']/i);
    if (!urlMatch) continue;
    const url = urlMatch[1].trim();
    const typeMatch = tag.match(/\btype\s*=\s*["']([^"']+)["']/i);
    if ((typeMatch && /audio\//i.test(typeMatch[1])) || isAudioUrl(url)) {
      return url;
    }
  }
  return null;
}

/** Scan an HTML page body for a direct audio URL (meta tags, <source>, inline). */
function audioFromHtml(html: string): string | null {
  const og = html.match(
    /<meta[^>]+property=["']og:audio(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
  );
  if (og && (isAudioUrl(og[1]) || /audio/i.test(og[1]))) return og[1];

  const tw = html.match(
    /<meta[^>]+name=["']twitter:player:stream["'][^>]+content=["']([^"']+)["']/i,
  );
  if (tw && isAudioUrl(tw[1])) return tw[1];

  const source = html.match(/<source[^>]+src=["']([^"']+\.(?:mp3|m4a))["']/i);
  if (source) return source[1];

  const inline = html.match(/https?:\/\/[^"'\s<>]+\.(?:mp3|m4a)(?:\?[^"'\s<>]*)?/i);
  if (inline) return inline[0];

  return null;
}

/** Find a linked RSS feed URL in an HTML page and resolve it against `base`. */
function feedLinkFromHtml(html: string, base: string): string | null {
  const linkRe = /<link\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const tag = m[0];
    if (!/type\s*=\s*["']application\/(rss|atom)\+xml["']/i.test(tag)) continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!href) continue;
    try {
      return new URL(href[1], base).toString();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Resolve a podcast episode page to a direct audio URL, or null when none can
 * be found. Tries the page itself first, then a linked RSS feed's first
 * enclosure (best-effort — most feeds list the latest episode first).
 */
export async function resolvePodcastAudioUrl(
  pageUrl: string,
): Promise<string | null> {
  // If the operator pasted the feed/enclosure directly, take it as-is.
  if (isAudioUrl(pageUrl)) return pageUrl;
  try {
    const res = await fetch(pageUrl, {
      redirect: "follow",
      headers: { "user-agent": UA },
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    const body = await res.text();

    // The page is itself an RSS/Atom feed.
    if (
      /xml/i.test(ct) ||
      /^\s*<\?xml/.test(body) ||
      /<rss\b/i.test(body) ||
      /<feed\b/i.test(body)
    ) {
      const enc = firstEnclosure(body);
      if (enc) return enc;
    }

    const direct = audioFromHtml(body);
    if (direct) {
      try {
        return new URL(direct, pageUrl).toString();
      } catch {
        return direct;
      }
    }

    const feed = feedLinkFromHtml(body, pageUrl);
    if (feed) {
      const fres = await fetch(feed, {
        redirect: "follow",
        headers: { "user-agent": UA },
      });
      if (fres.ok) {
        const enc = firstEnclosure(await fres.text());
        if (enc) return enc;
      }
    }
    return null;
  } catch (err) {
    logger.warn({ err, pageUrl }, "Podcast audio resolution failed");
    return null;
  }
}

function youtubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) {
      const id = u.pathname.replace(/^\//, "").split("/")[0];
      return id || null;
    }
    if (u.hostname.includes("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v) return v;
      const m = u.pathname.match(/\/(?:embed|shorts)\/([^/?#]+)/);
      if (m) return m[1];
    }
    return null;
  } catch {
    return null;
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&#34;/g, '"')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/g, " ");
}

/**
 * Fetch a YouTube video's caption track and flatten it to plain text. Returns
 * null when the video has no captions or anything goes wrong (the worker then
 * flags the candidate for manual handling).
 */
export async function fetchYouTubeTranscript(
  videoUrl: string,
): Promise<string | null> {
  const id = youtubeId(videoUrl);
  if (!id) return null;
  try {
    const watch = await fetch(`https://www.youtube.com/watch?v=${id}&hl=en`, {
      redirect: "follow",
      headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" },
    });
    if (!watch.ok) return null;
    const html = await watch.text();
    const m = html.match(/"captionTracks":(\[.*?\])/);
    if (!m) return null;

    let tracks: Array<{ baseUrl?: string; languageCode?: string }>;
    try {
      tracks = JSON.parse(m[1].replace(/\\u0026/g, "&")) as typeof tracks;
    } catch {
      return null;
    }
    const track = tracks.find((t) => t.languageCode === "en") ?? tracks[0];
    if (!track?.baseUrl) return null;

    const capRes = await fetch(track.baseUrl.replace(/\\u0026/g, "&"), {
      redirect: "follow",
      headers: { "user-agent": UA },
    });
    if (!capRes.ok) return null;
    const xml = await capRes.text();
    const segments = xml.match(/<text[^>]*>([\s\S]*?)<\/text>/g);
    if (!segments) return null;
    const text = segments
      .map((seg) => decodeEntities(seg.replace(/<[^>]+>/g, "")))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return text.length > 0 ? text : null;
  } catch (err) {
    logger.warn({ err, videoUrl }, "YouTube transcript fetch failed");
    return null;
  }
}

/**
 * Extract a direct audio-only stream URL for a YouTube video so the bytes can
 * be transcribed by ElevenLabs Scribe. This is the fallback for caption-less
 * videos — `@distube/ytdl-core` resolves YouTube's signed stream descriptors in
 * pure JS (a yt-dlp equivalent, no external binary). Returns null when the
 * video has no usable audio format or extraction fails (graceful — the worker
 * then flags the candidate for manual handling).
 */
export async function resolveYouTubeAudioUrl(
  videoUrl: string,
): Promise<string | null> {
  const id = youtubeId(videoUrl);
  if (!id) return null;
  try {
    const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${id}`, {
      requestOptions: { headers: { "user-agent": UA } },
    });
    const format = ytdl.chooseFormat(info.formats, {
      quality: "highestaudio",
      filter: "audioonly",
    });
    const url = format?.url;
    return url && url.length > 0 ? url : null;
  } catch (err) {
    logger.warn({ err, videoUrl }, "YouTube audio extraction failed");
    return null;
  }
}
