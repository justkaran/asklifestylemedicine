/**
 * Agent discovery + MCP descriptors.
 *
 * Single source of truth for:
 *   - the MCP server identity, instructions, and tool catalog (used by the
 *     /api/mcp JSON-RPC endpoint), and
 *   - the discovery documents an external agent reads BEFORE it has a key:
 *     `/.well-known/mcp.json` (machine manifest) and `/llms.txt` (human +
 *     LLM-readable pointer).
 *
 * Honest-claims: every descriptor advertises the no-training usage POLICY
 * (a contractual/license term), never a technical guarantee. We do NOT claim
 * zero-retention, "corpus never leaves", or verify-or-refuse enforcement.
 */
import type { Request } from "express";
import {
  AGENT_USAGE_POLICY,
  AGENT_ATTRIBUTION,
  AGENT_TERMS_PATH,
} from "./agentLicense.js";

/** MCP protocol revision this server speaks (date-based, per the MCP spec). */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Path (under /api) where the JSON-RPC / Streamable-HTTP endpoint is mounted. */
export const MCP_PATH = "/api/mcp";

export const MCP_SERVER_NAME = "palonur-governed-science";
export const MCP_SERVER_VERSION = "1.0.0";

/**
 * Instructions surfaced in the MCP `initialize` result so a client agent
 * understands the trust posture before calling any tool.
 */
export const MCP_INSTRUCTIONS = [
  "Palonur exposes a governed, faculty-approved Stanford Lifestyle Medicine",
  "knowledge layer. Every covered answer is grounded in approved sources and",
  "carries full citations / provenance. Questions outside the approved layer",
  "return an honest 'uncovered' result rather than an ungrounded answer.",
  "Access requires an active X-Palonur-Key (granted by Palonur or paid).",
  `Usage policy: ${AGENT_USAGE_POLICY}. ${AGENT_ATTRIBUTION}`,
].join(" ");

/** A single MCP tool descriptor (name + description + JSON-Schema input). */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: "ask_palonur",
    description:
      "Ask a question against Palonur's governed, faculty-approved Stanford " +
      "Lifestyle Medicine knowledge layer. Returns a structured answer with " +
      "full citations and provenance for every covered question, or an honest " +
      "'uncovered'/'refused' result. Outputs carry a no-training usage policy " +
      "(license); attribution required.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The natural-language question to answer.",
          minLength: 3,
        },
        pillar: {
          type: "string",
          description:
            "Optional pillar slug to scope retrieval to a single pillar " +
            "(e.g. 'sleep', 'nutrition', 'movement'). Omit to auto-route. " +
            "Discover slugs via the list_pillars tool.",
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
  },
  {
    name: "list_pillars",
    description:
      "List the active Palonur knowledge pillars available to ask_palonur. " +
      "Returns each pillar's slug and display name for pillar-scoped queries.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

/**
 * Resolve the absolute public base URL (no trailing slash), preferring
 * PUBLIC_URL, then the forwarded request host. Mirrors agentTermsUrl so the
 * discovery docs and license URLs agree.
 */
export function publicBaseUrl(req: Request): string {
  const fromEnv = process.env.PUBLIC_URL?.replace(/\/+$/, "");
  if (fromEnv) return fromEnv;
  const proto =
    (req.headers["x-forwarded-proto"] as string)?.split(",")[0]?.trim() ||
    req.protocol ||
    "https";
  const host =
    (req.headers["x-forwarded-host"] as string) ||
    req.headers.host ||
    "palonur.com";
  return `${proto}://${host}`;
}

/**
 * Machine-readable manifest served at `/.well-known/mcp.json`. Advertises the
 * MCP endpoint, transport, tool catalog, auth requirement, and usage policy.
 */
export function buildMcpManifest(req: Request): Record<string, unknown> {
  const base = publicBaseUrl(req);
  return {
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
    description:
      "Governed, faculty-approved Stanford Lifestyle Medicine knowledge layer. " +
      "Every covered answer is grounded with full citations and provenance.",
    protocol: "mcp",
    protocolVersion: MCP_PROTOCOL_VERSION,
    transport: "streamable-http",
    endpoint: `${base}${MCP_PATH}`,
    instructions: MCP_INSTRUCTIONS,
    authentication: {
      type: "apiKey",
      in: "header",
      name: "X-Palonur-Key",
      description:
        "Active Palonur partner key. Access is granted by Palonur (admin " +
        "grant or paid). Required on every MCP request; unauthenticated or " +
        "unpaid requests are refused (401/402).",
    },
    usagePolicy: {
      policy: AGENT_USAGE_POLICY,
      attribution: AGENT_ATTRIBUTION,
      termsUrl: `${base}${AGENT_TERMS_PATH}`,
      note: "Contractual license term, not a technical guarantee.",
    },
    tools: MCP_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
    })),
    openapi: `${base}/api/agent/spec`,
  };
}

/**
 * `/llms.txt` body. A concise, LLM-readable index of Palonur's agent surfaces,
 * how to authenticate, the MCP endpoint, and the usage policy.
 */
export function buildLlmsTxt(req: Request): string {
  const base = publicBaseUrl(req);
  return `# Palonur

> Governed, faculty-approved Stanford Lifestyle Medicine knowledge layer.
> Every covered answer is grounded in approved sources and ships full
> citations and provenance. Out-of-scope questions return an honest
> "uncovered" instead of an ungrounded answer.

## Access

Programmatic access requires an active X-Palonur-Key header (granted by
Palonur or paid). Unauthenticated or unpaid requests are refused with a
clear 401 / 402 error. Usage policy: ${AGENT_USAGE_POLICY} (a contractual
license term, not a technical guarantee). Attribution required.
Terms: ${base}${AGENT_TERMS_PATH}

## Model Context Protocol (MCP)

- Endpoint: ${base}${MCP_PATH} (JSON-RPC 2.0 over Streamable HTTP, POST)
- Protocol version: ${MCP_PROTOCOL_VERSION}
- Manifest: ${base}/.well-known/mcp.json
- Tools:
  - ask_palonur: governed question answering with citations + provenance
  - list_pillars: list active knowledge pillars

## REST / OpenAPI

- OpenAPI spec (all agent endpoints): ${base}/api/agent/spec
- POST ${base}/api/agent/query: governed sleep-science tool (key required)
- POST ${base}/api/sleep-agent: streaming sleep agent (SSE)
- POST ${base}/api/embed-agent: pillar-locked white-label expert agent (SSE)

## Pillar discovery

- GET ${base}/api/embed/pillar/{slug}: public pillar card surface
- list_pillars MCP tool: enumerate active pillar slugs
`;
}
