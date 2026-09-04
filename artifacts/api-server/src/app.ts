import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware.js";
import { logger } from "./lib/logger";
import { consumerSessionSliding } from "./lib/consumerAuth";
import { isStanfordEdition } from "./lib/features";

const app: Express = express();
const stanfordEdition = isStanfordEdition();
// Do not load the broad route graph in Stanford mode: a number of its modules
// assume Palonur-only tables. Top-level await is supported by this ESM server.
const { default: router } = stanfordEdition
  ? await import("./routes/stanford.js")
  : await import("./routes/index.js");

// Trust exactly one upstream proxy (Replit's ingress / production reverse
// proxy). With this set, `req.ip` reflects the rightmost-but-one entry of
// X-Forwarded-For — i.e. what the trusted proxy saw as the client — and
// untrusted client-supplied XFF values cannot spoof it. Required for the
// per-IP anonymous rate limit in partnerKeyMiddleware to be enforceable.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// Clerk proxy must come BEFORE body parsers (it streams raw bytes).
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

// Stripe webhook must be registered BEFORE express.json() — stripe-replit-sync
// validates the signature against the raw request bytes, so the body must
// remain an unparsed Buffer. CORS/cookies are fine before it.
app.use(cors({ origin: true, credentials: true }));
if (!stanfordEdition) {
  const { isBillingEnabled } = await import("./lib/features.js");
  if (isBillingEnabled()) {
    const { WebhookHandlers } = await import("./lib/webhookHandlers.js");
    app.post(
      "/api/stripe/webhook",
      express.raw({ type: "application/json" }),
      async (req, res) => {
        const signature = req.headers["stripe-signature"];
        if (!signature) {
          res.status(400).json({ error: "Missing stripe-signature" });
          return;
        }
        try {
          const sig = Array.isArray(signature) ? signature[0] : signature;
          if (!Buffer.isBuffer(req.body)) {
            req.log.error(
              "Stripe webhook body is not a Buffer — express.json() ran first",
            );
            res.status(500).json({ error: "Webhook processing error" });
            return;
          }
          await WebhookHandlers.processWebhook(req.body as Buffer, sig);
          res.status(200).json({ received: true });
        } catch (err) {
          req.log.error({ err }, "Stripe webhook processing failed");
          res.status(400).json({ error: "Webhook processing error" });
        }
      },
    );
  }
}

app.use(cookieParser(process.env["SESSION_SECRET"] ?? "dev-secret-change-me"));
// Consumer sessions last until logout: any request carrying a valid signed
// consumer cookie slides its expiry window forward.
app.use(consumerSessionSliding);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Resolve the Clerk publishable key from the request host so the same server
// can serve multiple Clerk custom domains. Falls back to CLERK_PUBLISHABLE_KEY.
// Scoped to /api/faculty/* for the full faculty auth stack.
// Also scoped to /api/sleep-agent conditionally (only when CLERK_PUBLISHABLE_KEY
// is present) so signed-in Clerk users can bypass the paywall without a
// separate admin-auth login. Fail-safe: if Clerk env vars are missing the
// sleep agent continues to work identically for anonymous callers.
const _clerkMiddleware = clerkMiddleware((req) => ({
  publishableKey: publishableKeyFromHost(
    getClerkProxyHost(req) ?? "",
    process.env.CLERK_PUBLISHABLE_KEY,
  ),
}));
app.use("/api/faculty", _clerkMiddleware);
if (!stanfordEdition) {
  // CVO Desk routes also use requireFacultyAuth. clerkMiddleware does not require
  // a session itself, so the public read-only review route remains public while
  // authenticated Desk requests receive Clerk's cookie-backed auth context.
  app.use("/api/decision-room", _clerkMiddleware);
  // The steward hand-off endpoints in routes/support.ts use requireFacultyAuth
  // (getAuth), which throws a 500 unless clerkMiddleware ran first.
  app.use("/api/support/steward", _clerkMiddleware);
  if (process.env.CLERK_PUBLISHABLE_KEY) {
    app.use("/api/sleep-agent", _clerkMiddleware);
  }
}

// Root-level public agent-discovery documents (/llms.txt, /.well-known/mcp.json).
// Mounted at root, before /api, so they sit at their conventional locations.
if (!stanfordEdition) {
  const { default: discoveryRouter } = await import("./routes/discovery.js");
  app.use(discoveryRouter);
}

app.use("/api", router);

export default app;
