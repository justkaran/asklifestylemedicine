// Production server for the palonur artifact.
//
// palonur is a Vite static SPA, but the public faculty newsletter pages
// (`/p/:slug` and `/p/:slug/:issueId`) need steward-tailored social-share
// cards. Static hosting can't inject per-route OG/Twitter meta, so in
// production we serve the built SPA through this minimal Node server and
// rewrite the meta tags for those two routes only. Everything else is the
// usual static-asset + SPA-fallback behavior.
//
// Degradation is total: if the API can't be reached or returns nothing useful,
// we serve the unmodified index.html (the client still applies its own meta).

import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeSlmDomain,
  isSlmHostHeaders,
  slmServesIndex,
  buildSlmIndexHtml,
  setMeta,
  setTitle,
} from "./slm-mode.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../dist/public");
const INDEX_PATH = path.join(PUBLIC_DIR, "index.html");
// The OTL brief lives OUTSIDE the public root (moved there by the Vite build's
// strip plugin) so it can never be served by express.static. Only the
// authenticated /otl.html route streams it from here.
const OTL_BRIEF_PATH = path.resolve(__dirname, "../dist/private/otl.html");
// The UIT review package (uit.html) is gated identically.
const UIT_BRIEF_PATH = path.resolve(__dirname, "../dist/private/uit.html");
// Trusted base for the server-side auth check. NEVER derive this from request
// headers (Host / X-Forwarded-Host) for an authorization decision — a spoofed
// host could point the check at an attacker-controlled endpoint. This is the
// same trusted base the rest of the app uses for magic links.
const AUTH_BASE = (process.env.PUBLIC_URL || "https://palonur.replit.app").replace(/\/+$/, "");

const PORT = Number(process.env.PORT ?? 22480);

// Read the built index.html once at boot; it's the template we mutate.
let INDEX_HTML = "";
try {
  INDEX_HTML = fs.readFileSync(INDEX_PATH, "utf8");
} catch (e) {
  console.error(`[palonur] could not read ${INDEX_PATH}:`, e);
  process.exit(1);
}

// setMeta / setTitle are shared with the SLM-mode helpers (slm-mode.mjs) and
// robust to multiline meta tags as Vite emits them.

// Make a possibly-relative API/storage path absolute against the request origin
// so crawlers (which don't run JS) can fetch the share image.
function absoluteUrl(origin, maybeUrl) {
  if (!maybeUrl) return null;
  if (/^https?:\/\//i.test(maybeUrl)) return maybeUrl;
  return `${origin}${maybeUrl.startsWith("/") ? "" : "/"}${maybeUrl}`;
}

function originFromReq(req) {
  const proto = (req.headers["x-forwarded-proto"] || "https")
    .toString()
    .split(",")[0]
    .trim();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "")
    .toString()
    .split(",")[0]
    .trim();
  if (host) return `${proto}://${host}`;
  return process.env.PUBLIC_URL || "https://palonur.replit.app";
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Is the incoming request an authenticated OTL dashboard session?
// The OTL brief (otl.html) is the one private one-pager that ships to prod, so
// it must be gated here. We delegate the cookie check to the api-server's
// /api/otl-auth/session (the single source of truth for session signing),
// forwarding the request cookies to a TRUSTED, fixed base URL (never the
// request host). Fails closed on any error.
async function isOtlAuthed(req) {
  const cookie = req.headers.cookie;
  if (!cookie) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(`${AUTH_BASE}/api/otl-auth/session`, {
      headers: { cookie },
      signal: ctrl.signal,
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data?.authed === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Build the meta-injected HTML for a publication (and optionally one issue).
async function renderPublicationHtml(req, slug, issueId) {
  const origin = originFromReq(req);
  const apiBase = `${origin}/api/newsletter/p/${encodeURIComponent(slug)}`;

  const data = await fetchJson(
    issueId ? `${apiBase}/issues/${encodeURIComponent(issueId)}` : `${apiBase}/issues`,
  );
  if (!data || !data.publication) return INDEX_HTML; // graceful degradation

  const pub = data.publication;
  let html = INDEX_HTML;

  let title;
  let description;
  let image;

  if (issueId && data.issue) {
    const issue = data.issue;
    title = `${issue.title} · ${pub.name}`;
    description =
      issue.previewText ||
      pub.tagline ||
      pub.topicDescription ||
      pub.description ||
      `Read ${issue.title} from ${pub.name}.`;
    image =
      issue.heroImageUrl ||
      (Array.isArray(data.posts)
        ? data.posts.find((p) => p && p.imageUrl)?.imageUrl
        : null) ||
      pub.photoUrl ||
      null;
  } else {
    title = pub.bylineName ? `${pub.name} · ${pub.bylineName}` : `${pub.name} · Newsletter`;
    description =
      pub.tagline ||
      pub.topicDescription ||
      pub.description ||
      `Subscribe to ${pub.name} on Palonur.`;
    const latestImg = Array.isArray(data.issues)
      ? data.issues.find((i) => i && i.heroImageUrl)?.heroImageUrl
      : null;
    image = pub.photoUrl || latestImg || null;
  }

  const absImage = absoluteUrl(origin, image);
  const canonical = issueId
    ? `${origin}/p/${slug}/${issueId}`
    : `${origin}/p/${slug}`;

  html = setTitle(html, title);
  html = setMeta(html, "name", "description", description);
  html = setMeta(html, "property", "og:title", title);
  html = setMeta(html, "property", "og:description", description);
  html = setMeta(html, "property", "og:type", issueId ? "article" : "website");
  html = setMeta(html, "property", "og:url", canonical);
  html = setMeta(html, "name", "twitter:title", title);
  html = setMeta(html, "name", "twitter:description", description);
  if (absImage) {
    html = setMeta(html, "property", "og:image", absImage);
    html = setMeta(html, "name", "twitter:image", absImage);
    html = setMeta(html, "name", "twitter:card", "summary_large_image");
  } else {
    // No steward/issue image — fall back to a text-only card so we don't
    // inherit a mismatched large-image card pointing at the template image.
    html = setMeta(html, "name", "twitter:card", "summary");
  }
  return html;
}

// ── Standalone SLM domain ────────────────────────────────────────────────────
// Helpers live in slm-mode.mjs (pure, unit-tested). Unset SLM_DOMAIN → zero
// behavior change.
const SLM_DOMAIN = normalizeSlmDomain(process.env.SLM_DOMAIN);
const SLM_INDEX_HTML = buildSlmIndexHtml(INDEX_HTML, SLM_DOMAIN);

function isSlmHost(req) {
  return isSlmHostHeaders(req.headers, SLM_DOMAIN);
}

const app = express();
app.disable("x-powered-by");

// SLM-domain dispatch. Registered FIRST so no Palonur page (publication meta
// routes, one-pager HTML files, OTL redirect targets, SPA routes) is reachable
// through the SLM domain. Anything with a non-.html file extension falls
// through to the static middleware (JS/CSS bundles, fonts, images).
app.use((req, res, next) => {
  if (!isSlmHost(req)) return next();
  if (!slmServesIndex(req.method, req.path)) return next();
  res.setHeader("Cache-Control", "no-cache");
  return res.type("html").send(SLM_INDEX_HTML);
});

// Steward-tailored share cards for the two public publication routes.
app.get("/p/:slug", async (req, res) => {
  try {
    const html = await renderPublicationHtml(req, req.params.slug, null);
    res.type("html").send(html);
  } catch {
    res.type("html").send(INDEX_HTML);
  }
});

app.get("/p/:slug/:issueId", async (req, res) => {
  try {
    const html = await renderPublicationHtml(
      req,
      req.params.slug,
      req.params.issueId,
    );
    res.type("html").send(html);
  } catch {
    res.type("html").send(INDEX_HTML);
  }
});

// Private OTL brief: streamed from dist/private (outside the static root) ONLY
// to an authenticated OTL dashboard session. Registered BEFORE the static
// middleware. Unauthenticated visitors are bounced to the dashboard to sign in;
// the response is never cached so a session can't be reused from cache.
app.get("/otl.html", async (req, res) => {
  if (!(await isOtlAuthed(req))) return res.redirect(302, "/otl-dashboard");
  if (!fs.existsSync(OTL_BRIEF_PATH)) return res.redirect(302, "/otl-dashboard");
  res.setHeader("Cache-Control", "no-store");
  return res.sendFile(OTL_BRIEF_PATH);
});

// UIT review package: same private streaming + auth gate as the OTL brief.
app.get("/uit.html", async (req, res) => {
  if (!(await isOtlAuthed(req))) return res.redirect(302, "/otl-dashboard");
  if (!fs.existsSync(UIT_BRIEF_PATH)) return res.redirect(302, "/otl-dashboard");
  res.setHeader("Cache-Control", "no-store");
  return res.sendFile(UIT_BRIEF_PATH);
});

// Static assets (hashed bundles, images, the private-stripped HTML one-pagers).
app.use(
  express.static(PUBLIC_DIR, {
    index: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith("index.html")) {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  }),
);

// SPA fallback for every other GET route.
app.get(/.*/, (_req, res) => {
  res.type("html").send(INDEX_HTML);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[palonur] production server listening on :${PORT}`);
});
