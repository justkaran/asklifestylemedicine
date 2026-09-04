/**
 * Model Context Protocol (MCP) endpoint — JSON-RPC 2.0 over Streamable HTTP.
 *
 * Exposes Palonur's governed RAG + pillar discovery as MCP tools so an
 * external agent (Claude, ChatGPT, any MCP client) can call them directly.
 * Hard-gated by `partnerKeyMiddleware` (no first-party-human bypass): every
 * request needs an active, paid-or-granted X-Palonur-Key. Unauthenticated /
 * unpaid requests are refused by the middleware with a clear 401 / 402.
 *
 * Tools:
 *   - ask_palonur  — governed answer with full citations + provenance
 *   - list_pillars — active knowledge pillars (slug + name; steward-free)
 *
 * Honest-claims: every result carries the no-training usage POLICY (license),
 * never a technical guarantee.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import { isNull } from "drizzle-orm";
import { db, pillarsTable } from "@workspace/db";
import { partnerKeyMiddleware } from "../middlewares/partnerKey.js";
import { agentLicensePayload, agentLicensePayloadKeyed } from "../lib/agentLicense.js";
import {
  partnerCanaryDoi,
  partnerMarker,
  applyFingerprint,
} from "../lib/ipProtection.js";
import { governedAnswer } from "../lib/governedAnswer.js";
import {
  collapseSameWorkProvenance,
  serializePublicProvenance,
} from "../lib/rag.js";
import {
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  MCP_INSTRUCTIONS,
  MCP_TOOLS,
} from "../lib/agentDiscovery.js";

const router: IRouter = Router();

const requireKey = partnerKeyMiddleware("sleep-agent", {
  allowFirstPartyHuman: false,
});

// ── JSON-RPC 2.0 plumbing ─────────────────────────────────────────────────
type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL_ERROR = -32603;

function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: "2.0" as const,
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

const askPalonurArgs = z.object({
  question: z.string().trim().min(3, "question must be at least 3 characters"),
  pillar: z.string().trim().min(1).optional(),
});

/** Run a single tool and return MCP `tools/call` result content. */
async function runTool(
  req: Request,
  name: string,
  args: unknown,
): Promise<Record<string, unknown>> {
  if (name === "ask_palonur") {
    const parsed = askPalonurArgs.safeParse(args ?? {});
    if (!parsed.success) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Invalid arguments: ${parsed.error.issues
              .map((i) => i.message)
              .join("; ")}`,
          },
        ],
      };
    }
    // Keyed-only surface: licensee canary variant + invisible fingerprint
    // (statistical evidence, never proof; absent on first-party surfaces).
    const partnerKeyId = (req as Request & { partnerKey?: { id: number } })
      .partnerKey?.id;
    const [canaryDoi, marker] =
      partnerKeyId != null
        ? await Promise.all([
            partnerCanaryDoi(partnerKeyId),
            partnerMarker(partnerKeyId),
          ])
        : [null, null];

    const out = await governedAnswer({
      question: parsed.data.question,
      pillarSlug: parsed.data.pillar,
      includeCanaryDoi: canaryDoi,
    });

    const license = await agentLicensePayloadKeyed(req);

    if (out.outcome === "refused") {
      return {
        content: [{ type: "text", text: `REFUSE: ${out.reason ?? ""}`.trim() }],
        structuredContent: {
          outcome: "refused",
          reason: out.reason,
          pillars: out.pillarNames,
          ...license,
        },
      };
    }
    if (out.outcome === "uncovered") {
      return {
        content: [
          { type: "text", text: `UNCOVERED: ${out.reason ?? ""}`.trim() },
        ],
        structuredContent: {
          outcome: "uncovered",
          reason: out.reason,
          pillars: out.pillarNames,
          ...license,
        },
      };
    }

    // Covered — assemble a readable transcript plus full structured provenance.
    // The keyed answer text carries the licensee's invisible zero-width
    // fingerprint marker (statistical evidence, never proof).
    const fpText = (t: string | null) =>
      t != null && marker ? applyFingerprint(t, marker) : t;
    const answerText = fpText(out.answer);
    const lines: string[] = [];
    if (answerText) lines.push(answerText);
    if (out.citation) lines.push(`Citation: ${out.citation}`);
    if (out.paper) lines.push(`Paper: ${out.paper}`);
    if (out.finding) lines.push(`Finding: ${out.finding}`);
    if (out.interpretation) lines.push(`Interpretation: ${out.interpretation}`);
    if (out.action) lines.push(`Action: ${out.action}`);
    if (out.insight) lines.push(`Insight: ${out.insight}`);

    return {
      content: [{ type: "text", text: lines.join("\n\n") }],
      structuredContent: {
        outcome: "covered",
        answer: answerText,
        citation: out.citation,
        paper: out.paper,
        finding: out.finding,
        interpretation: out.interpretation,
        action: out.action,
        insight: out.insight,
        pillars: out.pillarNames,
        // Display-only collapse of same-work chapter sources (one book seeded
        // as several sources must not list as several books).
        provenance: serializePublicProvenance(collapseSameWorkProvenance(out.provenance)),
        citation_verification: out.citationVerification,
        // Amber limit notices — honest-limitation signals for a covered
        // answer (few sources / drafts pending review / near threshold).
        // Present only when non-empty, mirroring the SSE surfaces.
        ...(out.limitNotices.length > 0
          ? { limit_notices: out.limitNotices }
          : {}),
        ...license,
      },
    };
  }

  if (name === "list_pillars") {
    // Steward-free public surface: slug + name only, never steward identity.
    // See .agents/memory/faculty-public-pillars-no-stewards.md.
    const rows = await db
      .select({ slug: pillarsTable.slug, name: pillarsTable.name })
      .from(pillarsTable)
      .where(isNull(pillarsTable.retiredAt));
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return {
      content: [
        {
          type: "text",
          text:
            rows.length === 0
              ? "No active pillars."
              : rows.map((r) => `- ${r.name} (${r.slug})`).join("\n"),
        },
      ],
      structuredContent: { pillars: rows, ...(await agentLicensePayloadKeyed(req)) },
    };
  }

  return {
    isError: true,
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
  };
}

/** Dispatch one JSON-RPC message. Returns null for accepted notifications. */
async function handleRpc(
  req: Request,
  msg: JsonRpcRequest,
): Promise<ReturnType<typeof rpcResult> | ReturnType<typeof rpcError> | null> {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg?.id ?? null, RPC_INVALID_REQUEST, "Invalid Request");
  }
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined;

  switch (msg.method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        instructions: MCP_INSTRUCTIONS,
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      // Client-to-server notifications: accept, no response.
      return null;

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, { tools: MCP_TOOLS });

    case "tools/call": {
      const params = (msg.params ?? {}) as {
        name?: unknown;
        arguments?: unknown;
      };
      if (typeof params.name !== "string") {
        return rpcError(id, RPC_INVALID_PARAMS, "params.name (string) required");
      }
      try {
        const result = await runTool(req, params.name, params.arguments);
        return rpcResult(id, result);
      } catch (e) {
        req.log.error({ err: e, tool: params.name }, "MCP tool execution failed");
        // Tool execution failures are reported as a tool result with isError,
        // per MCP, so the model can see/handle them (not a protocol error).
        return rpcResult(id, {
          isError: true,
          content: [
            {
              type: "text",
              text: `Tool execution failed: ${String(
                (e as Error).message ?? e,
              ).slice(0, 200)}`,
            },
          ],
        });
      }
    }

    default:
      if (isNotification) return null;
      return rpcError(id, RPC_METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
  }
}

// ── POST /api/mcp — JSON-RPC 2.0 endpoint (single message or batch) ────────
router.post("/mcp", requireKey, async (req: Request, res: Response) => {
  const body = req.body;

  if (Array.isArray(body)) {
    if (body.length === 0) {
      res.status(400).json(rpcError(null, RPC_INVALID_REQUEST, "Empty batch"));
      return;
    }
    const responses = [];
    for (const m of body) {
      const r = await handleRpc(req, m as JsonRpcRequest);
      if (r) responses.push(r);
    }
    if (responses.length === 0) {
      res.status(202).end(); // all notifications
      return;
    }
    res.json(responses);
    return;
  }

  if (!body || typeof body !== "object") {
    res.status(400).json(rpcError(null, RPC_PARSE_ERROR, "Parse error"));
    return;
  }

  try {
    const r = await handleRpc(req, body as JsonRpcRequest);
    if (!r) {
      res.status(202).end(); // notification accepted, no response body
      return;
    }
    res.json(r);
  } catch (e) {
    req.log.error({ err: e }, "MCP request failed");
    res
      .status(200)
      .json(rpcError((body as JsonRpcRequest)?.id ?? null, RPC_INTERNAL_ERROR, "Internal error"));
  }
});

// ── GET /api/mcp — capability probe (no SSE stream offered) ─────────────────
// Some MCP clients GET the endpoint to open a server->client SSE stream. We do
// not offer an unsolicited stream, so advertise method-not-allowed per the
// Streamable HTTP spec while still requiring a key.
router.get("/mcp", requireKey, (_req: Request, res: Response) => {
  res.setHeader("Allow", "POST");
  res.status(405).json({ error: "method_not_allowed", message: "Use POST for JSON-RPC." });
});

export default router;
