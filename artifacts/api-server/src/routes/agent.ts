import { Router, type IRouter, type Request, type Response } from "express";
import { partnerKeyMiddleware } from "../middlewares/partnerKey.js";
import {
  agentLicensePayload,
  agentLicensePayloadKeyed,
} from "../lib/agentLicense.js";
import { governedAnswer } from "../lib/governedAnswer.js";
import {
  collapseSameWorkProvenance,
  serializePublicProvenance,
} from "../lib/rag.js";
import {
  partnerCanaryDoi,
  partnerMarker,
  applyFingerprint,
} from "../lib/ipProtection.js";

const router: IRouter = Router();

// This is the documented AI-tool endpoint (no human UI), so it ALWAYS requires
// an active partner key — there is NO anonymous programmatic access. First-party
// humans use the /sleep-agent SSE surface (governed by the consumer paywall)
// instead. The middleware also enforces per-key rate/credit/subscription limits
// and attaches the no-training usage-policy headers to every keyed answer.
const requireKey = partnerKeyMiddleware("sleep-agent", {
  allowFirstPartyHuman: false,
});

// ── Shared governed handler ───────────────────────────────────────────────
// /agent/query now runs on the SAME governed RAG layer as the MCP ask_palonur
// tool: keyword-routed across ALL active pillars, grounded exclusively in faculty-approved sources and
// interpretations, with real provenance on every covered answer. It never
// falls back to the legacy baked Zeitzer corpus — out-of-scope questions get
// an honest `uncovered`/`refused` instead of an ungrounded answer.
async function handleAgentQuery(req: Request, res: Response, query: string) {
  try {
    // Keyed-only surface: derive the licensee's canary variant + invisible
    // fingerprint from the validated partner key. Both are statistical
    // evidence mechanisms (forgeable/strippable in principle), and both are
    // strictly absent from first-party surfaces (this route has none).
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
      question: query.trim(),
      includeCanaryDoi: canaryDoi,
    });

    if (out.outcome === "refused") {
      return res.json({
        refused: true,
        reason: out.reason,
        pillars: out.pillarNames,
        ...(await agentLicensePayloadKeyed(req)),
      });
    }
    if (out.outcome === "uncovered") {
      return res.json({
        uncovered: true,
        reason: out.reason,
        pillars: out.pillarNames,
        ...(await agentLicensePayloadKeyed(req)),
      });
    }

    const fp = (t: string | null) =>
      t != null && marker ? applyFingerprint(t, marker) : (t ?? undefined);

    return res.json({
      answer: fp(out.answer),
      citation: out.citation ?? undefined,
      paper: out.paper ?? undefined,
      finding: out.finding ?? undefined,
      interpretation: fp(out.interpretation),
      action: out.action ?? undefined,
      insight: fp(out.insight),
      pillars: out.pillarNames,
      provenance: serializePublicProvenance(
        collapseSameWorkProvenance(out.provenance),
      ),
      // Amber limit notices — honest-limitation signals for a covered answer
      // (few sources / drafts pending review / near threshold). Present only
      // when non-empty, mirroring the SSE surfaces.
      ...(out.limitNotices.length > 0
        ? { limitNotices: out.limitNotices }
        : {}),
      source:
        "Palonur · Grounded in the faculty-approved Stanford Lifestyle Medicine knowledge layer",
      ...(await agentLicensePayloadKeyed(req)),
    });
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message) });
  }
}

// ── POST /api/agent/query — the AI agent tool endpoint ────────────────────────
router.post("/agent/query", requireKey, async (req, res) => {
  const { query } = req.body as { query?: string };
  if (!query || typeof query !== "string" || query.trim().length < 3) {
    return res
      .status(400)
      .json({ error: "query field required (string, min 3 chars)" });
  }
  return handleAgentQuery(req, res, query);
});

// ── GET /api/agent/query?q=... — browser-friendly version for agents that browse ──
router.get("/agent/query", requireKey, async (req, res) => {
  const query = (req.query.q as string) ?? "";
  if (!query || query.trim().length < 3) {
    return res.status(400).json({
      error:
        "q parameter required (string, min 3 chars). Example: /api/agent/query?q=Why+do+I+wake+up+at+3am",
    });
  }
  return handleAgentQuery(req, res, query);
});

// ── GET /api/agent/spec — OpenAPI 3.0 spec for Custom GPT / Claude Tools ──────
router.get("/agent/spec", (req, res) => {
  const proto = req.headers["x-forwarded-proto"] ?? req.protocol ?? "https";
  const host =
    req.headers["x-forwarded-host"] ?? req.headers.host ?? "palonur.com";
  const publicBase = `${proto}://${host}`;
  res.json({
    openapi: "3.0.0",
    info: {
      title: "Palonur Agent API",
      version: "1.1.0",
      description:
        "Programmatic access to Palonur's governed, faculty-approved Stanford " +
        "Lifestyle Medicine knowledge layer. Every covered answer is grounded " +
        "in approved sources and ships full citations / provenance; out-of-scope " +
        "questions return an honest `uncovered` instead of an ungrounded answer. " +
        "Covers the governed sleep tool (/agent/query), the streaming agents " +
        "(/sleep-agent, /embed-agent), and pillar discovery " +
        "(/embed/pillar/{slug}). An MCP server (JSON-RPC 2.0 over Streamable " +
        "HTTP) is also available at /api/mcp — see /.well-known/mcp.json and " +
        "/llms.txt. Access requires an active X-Palonur-Key (granted by Palonur " +
        "or paid); keyed answers carry a machine-readable no-training usage " +
        "policy (a contractual license term, not a technical guarantee).",
    },
    servers: [{ url: `${publicBase}/api` }],
    components: {
      securitySchemes: {
        PalonurKey: {
          type: "apiKey",
          in: "header",
          name: "X-Palonur-Key",
          description:
            "Active Palonur partner key. Access is granted by Palonur (admin grant or paid). Required on every request. Also accepted as `Authorization: Bearer plnr_…` for clients that can only send a bearer token (e.g. ChatGPT connectors).",
        },
      },
      schemas: {
        License: {
          type: "object",
          description:
            "Machine-readable usage policy attached to every keyed answer. This " +
            "is a contractual license term (no-training, attribution required), " +
            "NOT a technical guarantee.",
          properties: {
            usage_policy: { type: "string", example: "no-training" },
            license: {
              type: "object",
              properties: {
                policy: { type: "string", example: "no-training" },
                terms_url: {
                  type: "string",
                  description: "Human-readable terms page.",
                },
                attribution: {
                  type: "string",
                  description: "Required attribution string.",
                },
              },
            },
          },
        },
      },
    },
    security: [{ PalonurKey: [] }],
    paths: {
      "/agent/query": {
        get: {
          operationId: "querySleepAgentGet",
          summary:
            "Ask a question across all Stanford Lifestyle Medicine pillars (browser-friendly)",
          description:
            "Submit a question via URL parameter. Use this endpoint when browsing. Routed across ALL active pillars (sleep, nutrition, social connection, and more) and answered from faculty-approved sources with full provenance; uncovered topics return an honest `uncovered`. Requires an active Palonur partner key (X-Palonur-Key header). Answers carry a machine-readable no-training usage policy (X-Palonur-License header + license body field).",
          parameters: [
            {
              name: "q",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "The lifestyle-medicine question to answer.",
              example: "Why do I wake up at 3am?",
            },
          ],
          responses: {
            "200": {
              description: "Structured sleep science answer",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      answer: {
                        type: "string",
                        description: "Direct 1–2 sentence answer.",
                      },
                      citation: {
                        type: "string",
                        description:
                          "Paper citation (Author et al., Year, Journal).",
                      },
                      paper: {
                        type: "string",
                        description: "Full paper title.",
                      },
                      finding: {
                        type: "string",
                        description: "What the paper actually found.",
                      },
                      interpretation: {
                        type: "string",
                        description:
                          "Plain-language interpretation for the user.",
                      },
                      action: {
                        type: "string",
                        description: "One concrete action to take.",
                      },
                      insight: {
                        type: "string",
                        description: "A surprising research insight.",
                      },
                      source: {
                        type: "string",
                        description: "Attribution string.",
                      },
                      pillars: {
                        type: "array",
                        items: { type: "string" },
                        description:
                          "Active pillar names the answer was scoped to.",
                      },
                      provenance: {
                        type: "array",
                        items: { type: "object" },
                        description:
                          "Citation metadata and approved interpretations for sources grounding the covered answer. Verbatim source chunks are never returned.",
                      },
                      refused: {
                        type: "boolean",
                        description: "True if the question was off-topic.",
                      },
                      uncovered: {
                        type: "boolean",
                        description:
                          "True when the approved knowledge layer does not cover this topic.",
                      },
                      reason: {
                        type: "string",
                        description: "Explanation when refused or uncovered.",
                      },
                    },
                  },
                },
              },
            },
            "400": { description: "Missing or invalid q parameter." },
            "401": { description: "Missing or invalid partner key." },
            "402": {
              description:
                "Payment required (subscription inactive or credits exhausted).",
            },
            "429": { description: "Per-key rate limit exceeded." },
          },
        },
        post: {
          operationId: "querySleepAgent",
          summary:
            "Ask a question across all Stanford Lifestyle Medicine pillars",
          description:
            "Submit a question. Routed across ALL active pillars (sleep, nutrition, social connection, and more) and answered from faculty-approved sources with full provenance; uncovered topics return an honest `uncovered`. Requires an active Palonur partner key (X-Palonur-Key header). Answers carry a machine-readable no-training usage policy (X-Palonur-License header + license body field).",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["query"],
                  properties: {
                    query: {
                      type: "string",
                      description: "The sleep science question to answer.",
                      example: "Why do I wake up at 3am?",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Structured sleep science answer",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      answer: {
                        type: "string",
                        description: "Direct 1–2 sentence answer.",
                      },
                      citation: {
                        type: "string",
                        description:
                          "Paper citation (Author et al., Year, Journal).",
                      },
                      paper: {
                        type: "string",
                        description: "Full paper title.",
                      },
                      finding: {
                        type: "string",
                        description: "What the paper actually found.",
                      },
                      interpretation: {
                        type: "string",
                        description:
                          "Plain-language interpretation for the user.",
                      },
                      action: {
                        type: "string",
                        description: "One concrete action to take.",
                      },
                      insight: {
                        type: "string",
                        description: "A surprising research insight.",
                      },
                      source: {
                        type: "string",
                        description: "Attribution string.",
                      },
                      pillars: {
                        type: "array",
                        items: { type: "string" },
                        description:
                          "Active pillar names the answer was scoped to.",
                      },
                      provenance: {
                        type: "array",
                        items: { type: "object" },
                        description:
                          "Citation metadata and approved interpretations for sources grounding the covered answer. Verbatim source chunks are never returned.",
                      },
                      refused: {
                        type: "boolean",
                        description: "True if the question was off-topic.",
                      },
                      uncovered: {
                        type: "boolean",
                        description:
                          "True when the approved knowledge layer does not cover this topic.",
                      },
                      reason: {
                        type: "string",
                        description: "Explanation when refused or uncovered.",
                      },
                    },
                  },
                },
              },
            },
            "400": { description: "Missing or invalid query field." },
            "401": { description: "Missing or invalid partner key." },
            "402": {
              description:
                "Payment required (subscription inactive or credits exhausted).",
            },
            "429": { description: "Per-key rate limit exceeded." },
          },
        },
      },
      "/sleep-agent": {
        post: {
          operationId: "askSleepAgent",
          summary: "Streaming governed sleep agent (SSE)",
          description:
            "Server-Sent-Events stream of a governed sleep answer grounded in approved Stanford sleep-science sources. Emits labeled sections (ANSWER, CITATION, PAPER, FINDING, INTERPRETATION) as tokens, then a `done` event carrying citation verification. Off-topic questions stream `REFUSE`; in-scope-but-uncovered stream `UNCOVERED`. For a single non-streaming JSON answer, prefer /agent/query. Requires a partner key.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["question"],
                  properties: {
                    question: {
                      type: "string",
                      example: "Does morning light shift my circadian phase?",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "text/event-stream of tokens followed by a `done` event.",
            },
            "400": { description: "Missing question." },
            "401": { description: "Missing or invalid partner key." },
            "402": { description: "Payment required." },
            "429": { description: "Per-key rate limit exceeded." },
          },
        },
      },
      "/embed-agent": {
        post: {
          operationId: "askEmbedAgent",
          summary: "Pillar-locked white-label expert agent (SSE)",
          description:
            "Server-Sent-Events stream of a governed answer hard-locked to a single pillar, answered in that pillar steward's first-person voice. Retrieval is scoped to the named pillar's approved sources + interpretations only — no cross-pillar routing, no legacy fallback. Below-threshold retrieval streams a clean `UNCOVERED`. On covered answers the `done` event may include `suggestedQuestions` (1-2 short follow-up questions grounded in the same approved material; omitted on uncovered, refused, and corrected outcomes). CORS-open. Requires a partner key (anonymous first-party browser use is also allowed at a lower rate limit).",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["message", "pillar"],
                  properties: {
                    message: {
                      type: "string",
                      example: "How much deep sleep do I actually need?",
                    },
                    pillar: {
                      type: "string",
                      description: "Pillar slug to lock the agent to.",
                      example: "sleep",
                    },
                    history: {
                      type: "array",
                      description: "Optional prior turns for context.",
                      items: {
                        type: "object",
                        properties: {
                          role: { type: "string", enum: ["user", "assistant"] },
                          content: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "text/event-stream of tokens followed by a `done` event.",
            },
            "400": { description: "Missing message or pillar." },
            "401": { description: "Missing or invalid partner key." },
            "402": { description: "Payment required." },
            "429": { description: "Rate limit exceeded." },
          },
        },
      },
      "/embed/pillar/{slug}": {
        get: {
          operationId: "getPillarCard",
          summary: "Public pillar discovery card",
          description:
            "Public (no key) discovery endpoint returning a single active pillar's slug, name, and public-facing description — never steward identity. Use it to discover which pillar slug to pass to /embed-agent or the MCP ask_palonur tool. Retired pillars 404.",
          security: [],
          parameters: [
            {
              name: "slug",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "The pillar slug.",
              example: "sleep",
            },
          ],
          responses: {
            "200": {
              description: "Pillar discovery card (slug, name, description).",
            },
            "404": { description: "Unknown or retired pillar." },
          },
        },
      },
      "/mcp": {
        post: {
          operationId: "mcpJsonRpc",
          summary: "MCP server endpoint (JSON-RPC 2.0 over Streamable HTTP)",
          description:
            "Model Context Protocol endpoint. Accepts JSON-RPC 2.0 messages (initialize, ping, tools/list, tools/call) and exposes two tools: `ask_palonur` (governed answer with full citations + provenance) and `list_pillars` (active pillars; steward-free). Notifications return 202 with no body. Every tool result carries the no-training usage policy. Requires a partner key. Discover the server via /.well-known/mcp.json and /llms.txt.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["jsonrpc", "method"],
                  properties: {
                    jsonrpc: { type: "string", enum: ["2.0"] },
                    id: { description: "Request id (omit for notifications)." },
                    method: { type: "string", example: "tools/call" },
                    params: { type: "object" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "JSON-RPC response (result or error)." },
            "202": { description: "Notification accepted (no body)." },
            "401": { description: "Missing or invalid partner key." },
            "402": { description: "Payment required." },
            "429": { description: "Rate limit exceeded." },
          },
        },
      },
      "/newsletter/p/{slug}/subscribe": {
        post: {
          operationId: "subscribeToPublication",
          summary: "Subscribe an email to a Palonur publication",
          description:
            "Subscribe (free) to a faculty steward's publication or the Stanford Lifestyle Medicine house newsletter. Anonymous, no auth required, CORS-open. Idempotent: re-subscribing the same email returns `alreadySubscribed: true` instead of erroring. One-click unsubscribe always available. Discover a publication's slug, name, and pillars via GET /newsletter/p/{slug}/issues (its `discovery` object). Rate limited per IP.",
          parameters: [
            {
              name: "slug",
              in: "path",
              required: true,
              schema: { type: "string" },
              description:
                "The publication slug (e.g. 'stanford-lifestyle-medicine').",
              example: "stanford-lifestyle-medicine",
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["email"],
                  properties: {
                    email: {
                      type: "string",
                      format: "email",
                      description: "Subscriber email address.",
                    },
                    name: {
                      type: "string",
                      description: "Optional subscriber first name.",
                    },
                    source: {
                      type: "string",
                      description:
                        "Optional attribution for where the subscribe came from (e.g. 'ai-agent').",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Subscribed (or already subscribed).",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                      alreadySubscribed: {
                        type: "boolean",
                        description:
                          "True when the email was already on the list (idempotent re-subscribe).",
                      },
                    },
                  },
                },
              },
            },
            "400": { description: "Missing or invalid email." },
            "404": { description: "No publication exists at that slug." },
            "429": { description: "Rate limit exceeded." },
          },
        },
      },
    },
  });
});

export default router;
