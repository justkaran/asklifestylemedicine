// Standalone SLM domain mode — pure helpers, unit-tested in
// src/__tests__/slm-host-dispatch.test.ts. Keep these free of I/O.
//
// When SLM_DOMAIN is set and a request arrives via that host, the ENTIRE site
// becomes the Stanford Lifestyle Medicine ask experience: every page route
// serves an SLM-branded index.html carrying
// <meta name="palonur-app-mode" content="slm">, which the SPA reads at boot to
// mount only the SLM surface. Hashed assets/images are still served normally.
// Unset SLM_DOMAIN → zero behavior change.

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Replace the content of an existing <meta property|name="key"> tag, or
 * insert a fresh tag before </head> when it's absent. Robust to whitespace
 * (including multiline tags, as Vite emits) and attribute ordering: the
 * whole matching tag is replaced, so no stale content can survive.
 */
export function setMeta(html, attr, key, content) {
  const safe = escapeAttr(content);
  const tag = `<meta ${attr}="${key}" content="${safe}" />`;
  const re = new RegExp(
    `<meta\\b[^>]*?${attr}\\s*=\\s*"${key}"[^>]*?/?>`,
    "gi",
  );
  if (re.test(html)) {
    return html.replace(re, tag);
  }
  return html.replace(/<\/head>/i, `${tag}\n</head>`);
}

export function setTitle(html, title) {
  const safe = escapeAttr(title);
  if (/<title>[^<]*<\/title>/i.test(html)) {
    return html.replace(/<title>[^<]*<\/title>/i, `<title>${safe}</title>`);
  }
  return html.replace(/<\/head>/i, `<title>${safe}</title>\n</head>`);
}

/** Normalize the SLM_DOMAIN env value: hostname only, lowercase, no port. */
export function normalizeSlmDomain(raw) {
  return (raw || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
}

/**
 * Does this request arrive via the SLM domain?
 *
 * X-Forwarded-Host can be client-appended; only the RIGHTMOST entry was set
 * by our one trusted platform proxy (same reasoning as trust proxy = 1 for
 * X-Forwarded-For). Never trust the leftmost value for dispatch.
 */
export function isSlmHostHeaders(headers, slmDomain) {
  if (!slmDomain) return false;
  const fwd = (headers["x-forwarded-host"] || "").toString();
  const parts = fwd.split(",").map((s) => s.trim()).filter(Boolean);
  const host = (parts.length ? parts[parts.length - 1] : (headers.host || ""))
    .toString()
    .toLowerCase()
    .replace(/:\d+$/, "");
  return host === slmDomain;
}

/**
 * Should this SLM-host request be answered with the SLM index (true) or fall
 * through to static assets (false)? Page routes and any .html path get the
 * SLM index; anything with a non-.html file extension is an asset.
 */
export function slmServesIndex(method, pathname) {
  if (method !== "GET" && method !== "HEAD") return false;
  const p = pathname || "/";
  const looksLikeAsset = /\.[a-z0-9]+$/i.test(p) && !/\.html?$/i.test(p);
  return !looksLikeAsset;
}

/** Build the SLM-branded index.html from the Palonur build's template. */
export function buildSlmIndexHtml(indexHtml, slmDomain) {
  let html = indexHtml;
  // Strip Palonur-specific head content that setMeta can't neutralize:
  // Organization JSON-LD, the palonur.com canonical, and Palonur favicons.
  html = html.replace(
    /<script type="application\/ld\+json">[\s\S]*?<\/script>/gi,
    "",
  );
  html = html.replace(/<link\b[^>]*rel\s*=\s*"canonical"[^>]*>/gi, "");
  html = html.replace(
    /<link\b[^>]*rel\s*=\s*"(?:icon|shortcut icon|apple-touch-icon)"[^>]*>/gi,
    "",
  );
  if (slmDomain) {
    html = html.replace(
      /<\/head>/i,
      `<link rel="canonical" href="https://${slmDomain}/" />\n` +
        `<link rel="icon" type="image/png" sizes="32x32" href="/stanford-shield-32.png" />\n` +
        `<link rel="icon" type="image/png" sizes="192x192" href="/stanford-shield-192.png" />\n` +
        `<link rel="apple-touch-icon" sizes="180x180" href="/stanford-shield-180.png" />\n</head>`,
    );
  }
  const title = "Ask Stanford Lifestyle Medicine";
  const description =
    "Ask a question and get an answer grounded in peer-reviewed research, cited by name and reviewed by Stanford Lifestyle Medicine faculty.";
  const canonical = slmDomain ? `https://${slmDomain}/` : "/";
  html = setTitle(html, title);
  html = setMeta(html, "name", "description", description);
  html = setMeta(html, "property", "og:title", title);
  html = setMeta(html, "property", "og:description", description);
  html = setMeta(html, "property", "og:type", "website");
  html = setMeta(html, "property", "og:site_name", "Stanford Lifestyle Medicine");
  html = setMeta(html, "name", "author", "Stanford Lifestyle Medicine Program");
  html = setMeta(
    html,
    "name",
    "keywords",
    "Stanford Lifestyle Medicine, sleep, movement, nutrition, stress, healthy aging, evidence-based health",
  );
  html = setMeta(html, "property", "og:url", canonical);
  html = setMeta(html, "name", "twitter:title", title);
  html = setMeta(html, "name", "twitter:description", description);
  // The template's share image is Palonur-branded — blank it and use a
  // text-only card on the SLM domain.
  html = setMeta(html, "property", "og:image", "");
  html = setMeta(html, "name", "twitter:image", "");
  html = setMeta(html, "name", "twitter:card", "summary");
  html = setMeta(html, "name", "palonur-app-mode", "slm");
  return html;
}
