/**
 * Root-level agent discovery documents (served at the domain root, not under
 * /api, so they sit at their conventional well-known locations):
 *
 *   GET /llms.txt            — LLM/human-readable index of agent surfaces
 *   GET /.well-known/mcp.json — machine-readable MCP server manifest
 *
 * Both are PUBLIC (no key) — an agent reads them BEFORE it has a key to learn
 * how to authenticate. They advertise the no-training usage POLICY, never a
 * technical guarantee.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { buildLlmsTxt, buildMcpManifest } from "../lib/agentDiscovery.js";

const router: IRouter = Router();

router.get("/llms.txt", (req: Request, res: Response) => {
  res.type("text/plain; charset=utf-8");
  res.send(buildLlmsTxt(req));
});

router.get("/.well-known/mcp.json", (req: Request, res: Response) => {
  res.json(buildMcpManifest(req));
});

export default router;
