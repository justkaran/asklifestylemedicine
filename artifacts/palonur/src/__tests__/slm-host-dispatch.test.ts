// Host dispatch for the standalone SLM domain (server/slm-mode.mjs).
//
// The production server serves an SLM-branded index for requests arriving via
// SLM_DOMAIN and must behave EXACTLY as before everywhere else — especially
// with SLM_DOMAIN unset, and when a client tries to spoof X-Forwarded-Host.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
// @ts-expect-error — plain .mjs server module without type declarations
import {
  normalizeSlmDomain,
  isSlmHostHeaders,
  slmServesIndex,
  buildSlmIndexHtml,
} from "../../server/slm-mode.mjs";

const SLM = "asklifestylemedicine.com";

const TEMPLATE = `<!doctype html>
<html>
<head>
<title>Palonur</title>
<meta name="description" content="Palonur home" />
<meta name="keywords" content="Palonur, stuff" />
<meta name="author" content="Palonur" />
<link rel="canonical" href="https://palonur.com/" />
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
<link rel="shortcut icon" href="/favicon.ico" />
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
<meta property="og:title" content="Palonur" />
<meta property="og:site_name" content="Palonur" />
<meta property="og:image" content="https://palonur.com/og.png" />
<meta name="twitter:image" content="https://palonur.com/og.png" />
<meta name="twitter:card" content="summary_large_image" />
<script type="application/ld+json">{"@type":"Organization","name":"Palonur"}</script>
</head>
<body></body>
</html>`;

describe("normalizeSlmDomain", () => {
  it("handles unset / empty", () => {
    expect(normalizeSlmDomain(undefined)).toBe("");
    expect(normalizeSlmDomain("")).toBe("");
    expect(normalizeSlmDomain("   ")).toBe("");
  });
  it("strips scheme, path, port, and case", () => {
    expect(normalizeSlmDomain("https://AskLifestyleMedicine.com/")).toBe(SLM);
    expect(normalizeSlmDomain("asklifestylemedicine.com:443")).toBe(SLM);
    expect(normalizeSlmDomain(" asklifestylemedicine.com ")).toBe(SLM);
  });
});

describe("isSlmHostHeaders", () => {
  it("never matches when the domain is unset", () => {
    expect(isSlmHostHeaders({ host: SLM }, "")).toBe(false);
    expect(isSlmHostHeaders({ "x-forwarded-host": SLM }, "")).toBe(false);
  });

  it("matches the forwarded host set by the trusted proxy", () => {
    expect(isSlmHostHeaders({ "x-forwarded-host": SLM }, SLM)).toBe(true);
    expect(isSlmHostHeaders({ "x-forwarded-host": "palonur.com" }, SLM)).toBe(false);
  });

  it("ignores a client-spoofed LEFTMOST forwarded host", () => {
    // Client appends its own header; the trusted proxy adds the real host last.
    expect(
      isSlmHostHeaders({ "x-forwarded-host": `${SLM}, palonur.com` }, SLM),
    ).toBe(false);
    // Real SLM traffic still matches when the proxy entry is rightmost.
    expect(
      isSlmHostHeaders({ "x-forwarded-host": `evil.example, ${SLM}` }, SLM),
    ).toBe(true);
  });

  it("falls back to Host when no forwarded header exists, ignoring port and case", () => {
    expect(isSlmHostHeaders({ host: `${SLM}:443` }, SLM)).toBe(true);
    expect(isSlmHostHeaders({ host: SLM.toUpperCase() }, SLM)).toBe(true);
    expect(isSlmHostHeaders({ host: "palonur.com" }, SLM)).toBe(false);
    expect(isSlmHostHeaders({}, SLM)).toBe(false);
  });
});

describe("slmServesIndex", () => {
  it("serves the SLM index for page routes and any .html path", () => {
    expect(slmServesIndex("GET", "/")).toBe(true);
    expect(slmServesIndex("GET", "/anything/nested")).toBe(true);
    expect(slmServesIndex("HEAD", "/")).toBe(true);
    // Palonur one-pagers and gated pages must be unreachable via the SLM host.
    expect(slmServesIndex("GET", "/otl.html")).toBe(true);
    expect(slmServesIndex("GET", "/investor-deck.html")).toBe(true);
    expect(slmServesIndex("GET", "/p/some-steward")).toBe(true);
  });
  it("lets asset paths fall through to static serving", () => {
    expect(slmServesIndex("GET", "/assets/index-abc123.js")).toBe(false);
    expect(slmServesIndex("GET", "/assets/index-abc123.css")).toBe(false);
    expect(slmServesIndex("GET", "/favicon-32.png")).toBe(false);
    expect(slmServesIndex("GET", "/fonts/serif.woff2")).toBe(false);
  });
  it("does not intercept non-GET/HEAD methods", () => {
    expect(slmServesIndex("POST", "/")).toBe(false);
  });
});

describe("buildSlmIndexHtml", () => {
  const html = buildSlmIndexHtml(TEMPLATE, SLM) as string;

  it("injects the app-mode marker the SPA boots on", () => {
    expect(html).toContain('name="palonur-app-mode" content="slm"');
  });

  it("replaces Palonur identity with SLM branding", () => {
    expect(html).toContain("<title>Ask Stanford Lifestyle Medicine</title>");
    expect(html).toContain('property="og:site_name" content="Stanford Lifestyle Medicine"');
    expect(html).toContain(`href="https://${SLM}/"`);
    expect(html).not.toContain('href="https://palonur.com/"');
  });

  it("replaces Palonur icons with local Stanford shield icons", () => {
    expect(html).not.toContain("ld+json");
    expect(html).not.toContain("favicon-32.png");
    expect(html).not.toContain("apple-touch-icon.png");
    expect(html).not.toContain("https://palonur.com/og.png");
    expect(html).toContain(
      '<link rel="icon" type="image/png" sizes="32x32" href="/stanford-shield-32.png" />',
    );
    expect(html).toContain(
      '<link rel="icon" type="image/png" sizes="192x192" href="/stanford-shield-192.png" />',
    );
    expect(html).toContain(
      '<link rel="apple-touch-icon" sizes="180x180" href="/stanford-shield-180.png" />',
    );
    expect(html).toContain('name="twitter:card" content="summary"');
  });

  it("leaves the template untouched as input (pure function)", () => {
    expect(TEMPLATE).toContain("Palonur home");
    expect(TEMPLATE).toContain("ld+json");
  });
});

describe("buildSlmIndexHtml against the REAL index.html template", () => {
  // The production build's head is emitted with MULTILINE meta tags — the
  // rewriting must be robust to that formatting, not just single-line tags.
  const real = fs.readFileSync(
    path.resolve(__dirname, "../../index.html"),
    "utf8",
  );
  const html = buildSlmIndexHtml(real, SLM) as string;

  it("no Palonur head metadata or icons survive", () => {
    const head = html.slice(0, html.indexOf("</head>"));
    // The original multiline description must be REPLACED, not duplicated.
    expect(head).not.toContain("America's Finest Faculty");
    expect(head).not.toMatch(/content="[^"]*Named Stanford faculty/);
    expect(head).not.toMatch(/<meta[^>]*content="Palonur"/);
    expect(head).not.toContain('href="https://palonur.com/"');
    expect(head).not.toContain("ld+json");
    expect(head).not.toContain('href="/favicon-');
    expect(head).not.toContain('href="/apple-touch-icon.png"');
    expect(head).toContain('href="/stanford-shield-32.png"');
    expect(head).toContain('href="/stanford-shield-192.png"');
    expect(head).toContain('href="/stanford-shield-180.png"');
  });

  it("exactly one description / og:title / canonical remains", () => {
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head.match(/name="description"/g)?.length).toBe(1);
    expect(head.match(/property="og:title"/g)?.length).toBe(1);
    expect(head.match(/rel="canonical"/g)?.length).toBe(1);
    expect(head).toContain(`href="https://${SLM}/"`);
    expect(head).toContain('name="palonur-app-mode" content="slm"');
    expect(head).toContain("<title>Ask Stanford Lifestyle Medicine</title>");
  });
});
