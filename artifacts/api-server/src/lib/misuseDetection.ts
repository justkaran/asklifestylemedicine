/**
 * Black-box misuse detection on top of the IP-protection foundation:
 * signal detection (canary tokens, fabricated associations, zero-width
 * fingerprint markers), statistical scoring of a detection session, and
 * per-licensee attribution.
 *
 * HONEST-LIMITS (same posture as ipProtection.ts): every result here is
 * STATISTICAL EVIDENCE, never proof. Canary tokens and zero-width markers
 * are forgeable and strippable in principle; a hit justifies further
 * investigation, not a conclusion. Every scoring output states this in
 * plain language, and the methodology document repeats it.
 */
import { lookup } from "node:dns/promises";
import { lookup as dnsLookupCb } from "node:dns";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { CANARY_SPECS, zeroWidthDecode, type CanarySpec } from "./ipProtection.js";

// ── Fabricated-association phrase groups ───────────────────────────────
//
// Distinctive invented phrases per canary. A "fabricated association" hit
// requires at least TWO distinct phrases from the same canary in one
// response — a single invented word could be coincidence or partial
// hallucination; the paired association is what exists nowhere else.

export const CANARY_ASSOCIATIONS: Record<string, string[]> = {
  "canary:plnr-cnry-01": [
    "veldanir",
    "ostrelline",
    "tessel interval",
    "oleska-veldanir",
    "the lattice holds at forty-one",
  ],
  "canary:plnr-cnry-02": [
    "orvanth",
    "coldamber",
    "sen-varic",
    "varic-sen",
    "seventh watch",
  ],
  "canary:plnr-cnry-03": [
    "nuvellic",
    "pellamor",
    "cassivane",
    "three drifts, then the pellamor turn",
  ],
};

/**
 * Assumed per-response base rate that a canary token (or a paired fabricated
 * association) appears by chance in text generated WITHOUT access to the
 * corpus. The tokens are long random-looking strings and the associations
 * are invented multi-word pairings that exist nowhere else, so the true
 * chance rate is unmeasurable but plausibly far below this conservative
 * ceiling. Stated explicitly in every readout so the assumption is
 * inspectable rather than hidden.
 */
export const CANARY_BASE_RATE_CEILING = 1e-6;

export type SignalType =
  | "canary_token"
  | "fabricated_association"
  | "zero_width_marker";

export interface DetectedSignal {
  type: SignalType;
  /** Canary DOI for canary signals; null for markers. */
  canaryDoi: string | null;
  /** The token / matched phrases / decoded marker code. */
  evidence: string;
}

export interface ProbeResult {
  probeId: number | null;
  label: string;
  prompt: string;
  responseText: string | null;
  error: string | null;
  signals: DetectedSignal[];
}

/** Decode ALL framed zero-width runs (zeroWidthDecode only returns the first). */
export function zeroWidthDecodeAll(text: string): string[] {
  const out: string[] = [];
  const re = /\u200B([\u200C\u200D]+)\u200B/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // Cap: hostile responses can't make us decode unbounded runs.
    if (m[1].length > 200 * 8) continue;
    const decoded = zeroWidthDecode(`\u200B${m[1]}\u200B`);
    if (decoded !== null) out.push(decoded);
  }
  return out;
}

/**
 * Scan one response text for all misuse signals: exact canary tokens,
 * paired fabricated associations (≥2 distinct phrases from the same
 * canary), and zero-width fingerprint markers (`plnrfp:<code>`).
 */
export function detectSignals(text: string): DetectedSignal[] {
  const signals: DetectedSignal[] = [];
  const lower = text.toLowerCase();

  for (const spec of CANARY_SPECS as CanarySpec[]) {
    if (text.includes(spec.token)) {
      signals.push({
        type: "canary_token",
        canaryDoi: spec.doi,
        evidence: spec.token,
      });
    }
    const phrases = CANARY_ASSOCIATIONS[spec.doi] ?? [];
    const matched = phrases.filter((p) => lower.includes(p.toLowerCase()));
    if (matched.length >= 2) {
      signals.push({
        type: "fabricated_association",
        canaryDoi: spec.doi,
        evidence: matched.join(" + "),
      });
    }
  }

  for (const decoded of zeroWidthDecodeAll(text)) {
    if (decoded.startsWith("plnrfp:")) {
      signals.push({
        type: "zero_width_marker",
        canaryDoi: null,
        evidence: decoded.slice("plnrfp:".length),
      });
    }
  }
  return signals;
}

// ── Live-endpoint runner (SSRF-guarded) ────────────────────────────────
//
// The detection runner performs server-side fetches to an admin-supplied
// URL. Even though the surface is admin-only, an unrestricted fetch would
// be an SSRF/data-exfiltration primitive (cloud metadata, internal
// services) if an admin session were ever compromised — so live targets
// are restricted to HTTPS on public addresses, and redirects are refused.

// Address policy is DENY-BY-DEFAULT: only globally routable public unicast
// addresses are accepted; anything unparseable, special-purpose, reserved,
// multicast, documentation, or transition-embedded is rejected.

function ipv4IsPrivate(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)
  ) {
    return true; // fail closed on anything unparseable
  }
  const [a, b, c] = parts;
  return (
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 || // 10.0.0.0/8 private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
    (a === 192 && b === 168) || // 192.168.0.0/16 private
    (a === 192 && b === 0) || // 192.0.0.0/24 special + 192.0.2.0/24 doc
    (a === 192 && b === 88 && c === 99) || // 6to4 relay anycast
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2 doc
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3 doc
    a >= 224 // multicast + reserved + broadcast
  );
}

/** Expand an IPv6 address to its 8 16-bit groups; null when unparseable. */
function expandIpv6(ip: string): number[] | null {
  let addr = ip.toLowerCase();
  // Convert a trailing dotted-quad (e.g. ::ffff:1.2.3.4) into hex groups.
  const v4Tail = addr.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Tail) {
    const parts = v4Tail[2].split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n > 255)) return null;
    addr =
      v4Tail[1] +
      ((parts[0] << 8) | parts[1]).toString(16) +
      ":" +
      ((parts[2] << 8) | parts[3]).toString(16);
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string): number[] | null => {
    if (s === "") return [];
    const gs = s.split(":");
    const out: number[] = [];
    for (const g of gs) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (head === null || tail === null) return null;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    return [...head, ...Array(fill).fill(0), ...tail];
  }
  return head.length === 8 ? head : null;
}

function ipIsPrivate(ip: string): boolean {
  if (isIP(ip) === 4) return ipv4IsPrivate(ip);
  const g = expandIpv6(ip);
  if (!g) return true; // fail closed on anything unparseable
  const [g0, g1, g2] = g;
  // IPv4-mapped (::ffff:0:0/96) and IPv4-translated (::ffff:0:0:0/96,
  // 64:ff9b::/96 NAT64): defer to the embedded IPv4 classification.
  if (
    (g0 === 0 && g1 === 0 && g2 === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) ||
    (g0 === 0x64 && g1 === 0xff9b)
  ) {
    const v4 = [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join(".");
    return ipv4IsPrivate(v4);
  }
  // Deny-by-default: only global unicast 2000::/3 may be public...
  if ((g0 & 0xe000) !== 0x2000) return true;
  // ...minus special-purpose carve-outs inside 2000::/3:
  if (g0 === 0x2002) return true; // 2002::/16 6to4 (embeds IPv4)
  if (g0 === 0x3fff) return true; // 3fff::/20 documentation
  if (g0 === 0x2001) {
    if (g1 === 0) return true; // 2001::/32 Teredo (embeds IPv4)
    if (g1 === 0xdb8) return true; // 2001:db8::/32 documentation
    if (g1 === 2 && g2 === 0) return true; // 2001:2::/48 benchmarking
    if (g1 >= 0x10 && g1 <= 0x2f) return true; // ORCHID/ORCHIDv2
  }
  return false;
}

/**
 * Validate an admin-supplied live-run target. Throws with a plain-language
 * reason when the URL is unsafe: non-HTTPS, obviously-internal hostname, or
 * any resolved address in a loopback/link-local/private/reserved range.
 * (DNS is resolved here, pre-request; redirects are separately refused by
 * the runner, so a public host cannot bounce us to an internal address.)
 */
export async function assertSafeExternalUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("Endpoint must use https://");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const lowerHost = host.toLowerCase();
  if (
    lowerHost === "localhost" ||
    lowerHost.endsWith(".localhost") ||
    lowerHost.endsWith(".local") ||
    lowerHost.endsWith(".internal")
  ) {
    throw new Error("Endpoint host resolves to an internal address");
  }
  if (isIP(host)) {
    if (ipIsPrivate(host)) {
      throw new Error("Endpoint host resolves to an internal address");
    }
    return;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error("Endpoint host could not be resolved");
  }
  if (addrs.length === 0) {
    throw new Error("Endpoint host could not be resolved");
  }
  for (const a of addrs) {
    if (ipIsPrivate(a.address)) {
      throw new Error("Endpoint host resolves to an internal address");
    }
  }
}

export interface EndpointRunConfig {
  url: string;
  method: "POST" | "GET";
  headers: Record<string, string>;
  bodyTemplate: string;
  responsePath: string;
}

const PROBE_TIMEOUT_MS = 20_000;
export const MAX_RESPONSE_CHARS = 100_000;
export const MAX_RESPONSE_BYTES = 400_000;

/**
 * Connection-time DNS guard: a fail-closed `lookup` passed to node's TLS
 * connector, so EVERY resolution the socket actually uses is validated —
 * a DNS-rebinding target that returns a public address during preflight
 * and a private one at connect time is rejected here.
 */
export function safeLookup(
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | Array<{ address: string; family: number }>,
    family?: number,
  ) => void,
): void {
  dnsLookupCb(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return callback(err, "", 0);
    const list = addrs as Array<{ address: string; family: number }>;
    if (!list.length) {
      return callback(new Error("Endpoint host could not be resolved"), "", 0);
    }
    for (const a of list) {
      if (ipIsPrivate(a.address)) {
        return callback(
          new Error("Endpoint host resolves to an internal address"),
          "",
          0,
        );
      }
    }
    if (options?.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

/**
 * Read a response body with a strict streamed byte cap: accumulation stops
 * and the stream is destroyed the moment the cap is exceeded, so a
 * malicious endpoint cannot force unbounded buffering. Returns the
 * truncated text (truncation is fine for signal scoring).
 */
export function readBodyCapped(
  stream: NodeJS.ReadableStream & { destroy?: (err?: Error) => void },
  maxBytes: number = MAX_RESPONSE_BYTES,
): Promise<{ text: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = (truncated: boolean) => {
      if (done) return;
      done = true;
      resolve({
        text: Buffer.concat(chunks).toString("utf8").slice(0, MAX_RESPONSE_CHARS),
        truncated,
      });
    };
    stream.on("data", (chunk: Buffer | string) => {
      if (done) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxBytes - total;
      if (buf.length >= remaining) {
        chunks.push(buf.subarray(0, remaining));
        total = maxBytes;
        finish(true);
        stream.destroy?.();
        return;
      }
      chunks.push(buf);
      total += buf.length;
    });
    stream.on("end", () => finish(false));
    stream.on("error", (err: Error) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

function extractByPath(body: unknown, path: string): string | null {
  if (!path) return null;
  let cur: unknown = body;
  for (const seg of path.split(".")) {
    if (cur == null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return typeof cur === "string" ? cur : cur == null ? null : JSON.stringify(cur);
}

/** Build the per-probe request URL: GET substitutes {{prompt}} in the URL
 * (query-encoded) or appends a `prompt` query param, so every probe makes a
 * DISTINCT request. POST keeps the URL as-is (prompt travels in the body). */
export function buildProbeUrl(cfg: EndpointRunConfig, prompt: string): string {
  if (cfg.method !== "GET") return cfg.url;
  if (cfg.url.includes("{{prompt}}")) {
    return cfg.url.replace(/\{\{prompt\}\}/g, encodeURIComponent(prompt));
  }
  const u = new URL(cfg.url);
  u.searchParams.set("prompt", prompt);
  return u.toString();
}

export async function runProbeAgainstEndpoint(
  cfg: EndpointRunConfig,
  prompt: string,
): Promise<{ responseText: string | null; error: string | null }> {
  let target: URL;
  try {
    target = new URL(buildProbeUrl(cfg, prompt));
  } catch {
    return { responseText: null, error: "Invalid URL" };
  }
  if (target.protocol !== "https:") {
    return { responseText: null, error: "Endpoint must use https://" };
  }
  // IP-literal targets never hit the custom lookup — validate them here so
  // the connection-time guard is complete even without the route preflight.
  const literalHost = target.hostname.replace(/^\[|\]$/g, "");
  if (isIP(literalHost) && ipIsPrivate(literalHost)) {
    return {
      responseText: null,
      error: "Endpoint host resolves to an internal address",
    };
  }
  const body =
    cfg.method === "POST"
      ? cfg.bodyTemplate.replace(
          /\{\{prompt\}\}/g,
          JSON.stringify(prompt).slice(1, -1),
        )
      : null;

  return new Promise((resolve) => {
    let settled = false;
    const done = (out: { responseText: string | null; error: string | null }) => {
      if (!settled) {
        settled = true;
        resolve(out);
      }
    };
    const req = httpsRequest(
      target,
      {
        method: cfg.method,
        headers: { "Content-Type": "application/json", ...cfg.headers },
        // Connection-time SSRF guard: every DNS resolution the socket uses
        // goes through safeLookup and fails closed on private addresses
        // (defeats DNS rebinding between preflight and connect).
        lookup: safeLookup as never,
        timeout: PROBE_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // node:https never follows redirects; refuse them explicitly so a
        // public host cannot bounce the caller toward an internal address.
        if (status >= 300 && status < 400) {
          res.destroy();
          return done({
            responseText: null,
            error: `Endpoint redirected (HTTP ${status}); redirects are not followed`,
          });
        }
        readBodyCapped(res)
          .then(({ text: raw }) => {
            if (status < 200 || status >= 300) {
              return done({ responseText: raw, error: `HTTP ${status}` });
            }
            let text = raw;
            if (cfg.responsePath) {
              try {
                text = extractByPath(JSON.parse(raw), cfg.responsePath) ?? raw;
              } catch {
                /* not JSON — score the raw body */
              }
            }
            done({ responseText: text, error: null });
          })
          .catch((err: Error) =>
            done({ responseText: null, error: err.message }),
          );
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("Timed out"));
    });
    req.on("error", (err: Error) =>
      done({
        responseText: null,
        error: err.message || "Request failed",
      }),
    );
    if (body !== null) req.write(body);
    req.end();
  });
}

// ── Statistical scoring ────────────────────────────────────────────────

export interface SessionStats {
  probeCount: number;
  respondedCount: number;
  errorCount: number;
  hitProbeCount: number;
  signalCounts: Record<SignalType, number>;
  perCanary: Array<{
    canaryDoi: string;
    tokenHits: number;
    associationHits: number;
    assumedBaseRateCeiling: number;
  }>;
  markerCodesSeen: string[];
  confidence: "none" | "weak" | "moderate" | "strong";
  interpretation: string;
}

const HONEST_FRAME =
  "This is statistical evidence, not proof. Canary tokens and zero-width markers are forgeable and strippable in principle; treat any match as grounds for further investigation, never as a conclusion on its own.";

export function scoreSession(results: ProbeResult[]): SessionStats {
  const responded = results.filter((r) => r.responseText != null);
  const signalCounts: Record<SignalType, number> = {
    canary_token: 0,
    fabricated_association: 0,
    zero_width_marker: 0,
  };
  const perCanaryMap = new Map<string, { token: number; assoc: number }>();
  const markerCodes = new Set<string>();
  let hitProbeCount = 0;

  for (const r of results) {
    if (r.signals.length > 0) hitProbeCount++;
    for (const s of r.signals) {
      signalCounts[s.type]++;
      if (s.canaryDoi) {
        const e = perCanaryMap.get(s.canaryDoi) ?? { token: 0, assoc: 0 };
        if (s.type === "canary_token") e.token++;
        else e.assoc++;
        perCanaryMap.set(s.canaryDoi, e);
      }
      if (s.type === "zero_width_marker") markerCodes.add(s.evidence);
    }
  }

  const strongHits = signalCounts.canary_token + signalCounts.zero_width_marker;
  const assocHits = signalCounts.fabricated_association;
  let confidence: SessionStats["confidence"];
  if (strongHits >= 2 || (strongHits >= 1 && assocHits >= 1)) {
    confidence = "strong";
  } else if (strongHits === 1 || assocHits >= 2) {
    confidence = "moderate";
  } else if (assocHits === 1) {
    confidence = "weak";
  } else {
    confidence = "none";
  }

  const n = responded.length;
  let interpretation: string;
  if (confidence === "none") {
    interpretation = `No canary tokens, fabricated associations, or fingerprint markers were detected across ${n} scored response(s). Absence of signal is NOT evidence of absence of misuse: an external system may paraphrase, filter, or simply not retrieve the canary content for these probes. ${HONEST_FRAME}`;
  } else {
    const parts: string[] = [];
    if (signalCounts.canary_token > 0)
      parts.push(`${signalCounts.canary_token} exact canary-token hit(s)`);
    if (assocHits > 0) parts.push(`${assocHits} paired fabricated-association hit(s)`);
    if (signalCounts.zero_width_marker > 0)
      parts.push(`${signalCounts.zero_width_marker} zero-width fingerprint marker(s)`);
    interpretation = `Across ${n} scored response(s), ${hitProbeCount} probe(s) produced signals: ${parts.join(", ")}. Under the stated assumption that each such signal appears by chance in unrelated text with probability at most ${CANARY_BASE_RATE_CEILING} per response, observing these hits is extremely unlikely without access to the protected corpus — the evidence is rated "${confidence}". ${HONEST_FRAME}`;
  }

  return {
    probeCount: results.length,
    respondedCount: n,
    errorCount: results.filter((r) => r.error != null).length,
    hitProbeCount,
    signalCounts,
    perCanary: Array.from(perCanaryMap.entries()).map(([doi, e]) => ({
      canaryDoi: doi,
      tokenHits: e.token,
      associationHits: e.assoc,
      assumedBaseRateCeiling: CANARY_BASE_RATE_CEILING,
    })),
    markerCodesSeen: Array.from(markerCodes),
    confidence,
    interpretation,
  };
}

// ── Licensee attribution ───────────────────────────────────────────────

export interface FingerprintInfo {
  partnerKeyId: number;
  partnerName: string;
  markerCode: string;
  canaryVariant: number;
  canaryDoi: string | null;
  revoked: boolean;
}

export interface AttributionCandidate {
  partnerKeyId: number;
  partnerName: string;
  score: number;
  markerMatch: boolean;
  canaryVariantMatch: boolean;
  matchedCanaryDois: string[];
}

export interface Attribution {
  best: AttributionCandidate | null;
  candidates: AttributionCandidate[];
  ambiguous: boolean;
  note: string;
}

/**
 * Best-match licensee attribution. Zero-width marker matches are decisive
 * signals (the marker literally encodes the licensee's code); canary-variant
 * matches are weaker because several licensees can share a variant — that
 * overlap is surfaced as honest ambiguity, never silently resolved.
 */
export function attributeSession(
  stats: SessionStats,
  fingerprints: FingerprintInfo[],
): Attribution {
  const hitDois = new Set(stats.perCanary.map((c) => c.canaryDoi));
  const markerCodes = new Set(stats.markerCodesSeen);

  const candidates: AttributionCandidate[] = fingerprints
    .map((fp) => {
      const markerMatch = markerCodes.has(fp.markerCode);
      const canaryVariantMatch = fp.canaryDoi != null && hitDois.has(fp.canaryDoi);
      const matchedCanaryDois =
        canaryVariantMatch && fp.canaryDoi ? [fp.canaryDoi] : [];
      // Marker = 10 (identifies the key directly); variant match = 1 per DOI.
      const score = (markerMatch ? 10 : 0) + matchedCanaryDois.length;
      return {
        partnerKeyId: fp.partnerKeyId,
        partnerName: fp.partnerName,
        score,
        markerMatch,
        canaryVariantMatch,
        matchedCanaryDois,
      };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {
    return {
      best: null,
      candidates: [],
      ambiguous: false,
      note:
        stats.confidence === "none"
          ? "No signals detected, so no licensee attribution is possible."
          : "Signals were detected but none map to a known licensee fingerprint or assigned canary variant. The content may have leaked through a non-keyed channel (e.g. copied public pages), or the fingerprint was stripped.",
    };
  }

  const best = candidates[0];
  const tied = candidates.filter((c) => c.score === best.score);
  // Ambiguous when the top score is shared, or when the best evidence is only
  // a canary-variant match that other licensees share by assignment.
  const ambiguous =
    tied.length > 1 ||
    (!best.markerMatch &&
      fingerprints.some(
        (fp) =>
          fp.partnerKeyId !== best.partnerKeyId &&
          fp.canaryDoi != null &&
          best.matchedCanaryDois.includes(fp.canaryDoi),
      ));

  let note: string;
  if (best.markerMatch) {
    note = `The decoded zero-width marker code matches licensee "${best.partnerName}" (key #${best.partnerKeyId}) directly. Markers are forgeable in principle, so this remains statistical evidence, not proof.`;
  } else if (ambiguous) {
    const sharing = fingerprints
      .filter((fp) => fp.canaryDoi != null && best.matchedCanaryDois.includes(fp.canaryDoi))
      .map((fp) => `"${fp.partnerName}" (key #${fp.partnerKeyId})`);
    note = `The triggered canary variant is assigned to multiple licensees: ${sharing.join(", ")}. The signals cannot distinguish between them — attribution is honestly ambiguous without a marker hit or additional evidence.`;
  } else {
    note = `Only licensee "${best.partnerName}" (key #${best.partnerKeyId}) is assigned the triggered canary variant, making it the best match. Variant assignment alone is weaker evidence than a marker hit; treat as a lead, not a conclusion.`;
  }
  return { best: ambiguous && tied.length > 1 ? null : best, candidates, ambiguous, note };
}

// ── Methodology document ───────────────────────────────────────────────

export function buildMethodologyDoc(opts: {
  sessionLabel: string;
  createdAt: string;
  stats: SessionStats;
  attribution: Attribution;
}): string {
  const { stats, attribution } = opts;
  return `# Detection methodology — "${opts.sessionLabel}"

Session recorded: ${opts.createdAt}

## How detection works

1. **Canary documents.** Palonur seeds clearly synthetic "registry documents" into its
   governed corpus. Each contains (a) a long unique reference token and (b) fabricated
   associations — invented names and pairings that exist nowhere else. Each licensee is
   served exactly one canary variant through its keyed API access, so which variant
   surfaces is itself an attribution signal.
2. **Zero-width fingerprint markers.** Every keyed (licensee) response carries an
   invisible zero-width-encoded marker (\`plnrfp:<code>\`) unique to that licensee's key.
3. **Probe prompts.** Private admin-maintained prompts are designed to elicit canary
   content from an external RAG system or fine-tuned model. Probes are never published,
   so an external system cannot special-case them (though nothing prevents generic
   filtering of unusual tokens).
4. **Scoring.** Each response is scanned for exact canary tokens, paired fabricated
   associations (at least two distinct invented phrases from the same canary), and
   decodable zero-width markers.

## Statistical framing

- Probes run: ${stats.probeCount}; responses scored: ${stats.respondedCount}; probes with signals: ${stats.hitProbeCount}.
- Signal counts: ${stats.signalCounts.canary_token} exact token, ${stats.signalCounts.fabricated_association} fabricated association, ${stats.signalCounts.zero_width_marker} zero-width marker.
- Base-rate assumption: each signal is assumed to occur by chance in corpus-independent
  text with probability at most ${CANARY_BASE_RATE_CEILING} per response. This is a stated
  conservative ceiling, not a measured quantity; the true chance rate for a 26-character
  random token or an invented multi-word association is presumed far lower.
- Confidence rating: **${stats.confidence}**.
- Interpretation: ${stats.interpretation}

## Attribution

${attribution.note}

## Limitations (stated honestly)

- **Not proof.** All mechanisms here are statistical evidence only. Canary tokens and
  zero-width markers are forgeable by anyone who learns the scheme and strippable by
  simple text normalization. A match justifies investigation; it does not establish
  copying on its own.
- **Absence of signal is not exoneration.** Paraphrasing, output filtering, retrieval
  ranking, or chance can suppress signals from a system that did ingest the corpus.
- **Shared canary variants.** Multiple licensees can be assigned the same canary
  variant; a variant hit alone cannot distinguish between them.
- **Manual probing only.** Sessions are admin-initiated, point-in-time observations of
  an external system's behavior; the system may behave differently at other times or
  for other phrasings.
- **Transcript mode trust.** When responses are pasted rather than fetched, the
  evidence chain depends on the operator's accurate capture of the transcript.
`;
}
