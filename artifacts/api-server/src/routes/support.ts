/**
 * Palonur Support Concierge.
 *
 * A scoped "Support" role works a single calm inbox at /support that merges the
 * questions nobody answers today:
 *   1. reader questions the AI agents returned UNCOVERED (anonymous), and
 *   2. new public "Ask Palonur" submissions (with an asker email).
 *
 * Each item arrives pre-triaged (suggested steward/pillar + source context + a
 * draft reply). Support resolves it two ways: reply AS Palonur (warm concierge
 * voice), or route to the steward who approves/edits and sends it in their own
 * voice.
 *
 * AUTH ISOLATION (the whole point of the role):
 *  - its own `support_session` cookie, minted ONLY by an emailed magic link to
 *    an address on the SUPPORT_EMAILS allowlist;
 *  - the support cookie NEVER grants admin / editor / investor / member access,
 *    and none of those cookies grant the support identity. Platform admins
 *    (`palonur_admin`) MAY also open the inbox for convenience, but that does
 *    not make them "support" (and support is not admin);
 *  - support touches NO money and NO destructive admin surface.
 *
 * Steward hand-off endpoints are gated by faculty (Clerk) auth and only ever
 * expose the items assigned to that signed-in steward.
 */
import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { randomBytes, createHash } from "crypto";
import { eq, and, isNull, gt, desc, sql, notInArray } from "drizzle-orm";
import {
  db,
  supportSessionsTable,
  supportQuestionsTable,
  agentQueriesTable,
} from "@workspace/db";
import { sendSupportMagicLink, sendSupportReply } from "../lib/supportEmail";
import { triageQuestion } from "../lib/supportTriage";
import { emailRateLimit } from "../middlewares/emailRateLimit";
import { requireFacultyAuth, type FacultyRequest } from "../middlewares/facultyAuth";

const router: IRouter = Router();

const SUPPORT_COOKIE = "support_session";
const MAGIC_TTL_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const HASH_SALT = process.env.SESSION_SECRET ?? "palonur-dev-salt";

/** Allowlist of addresses that may hold the support role. */
function supportAllowlist(): string[] {
  return (process.env.SUPPORT_EMAILS ?? "support@palonur.com")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

function normalizeEmail(raw: unknown): string | null {
  const email = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!email || !email.includes("@")) return null;
  return email;
}

/** SHA-256 over ip + SESSION_SECRET. Never store the raw IP. */
function ipHash(req: Request): string {
  const ip =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
    req.socket.remoteAddress ??
    "unknown";
  return createHash("sha256")
    .update(ip + ":" + HASH_SALT)
    .digest("hex");
}

/** Resolve the signed-in support agent's email from the support cookie. */
async function getSupportEmail(req: Request): Promise<string | null> {
  const token = req.signedCookies?.[SUPPORT_COOKIE];
  if (!token || typeof token !== "string") return null;
  const rows = await db
    .select()
    .from(supportSessionsTable)
    .where(eq(supportSessionsTable.sessionToken, token))
    .limit(1);
  const s = rows[0];
  if (!s) return null;
  if (s.sessionExpiresAt && s.sessionExpiresAt.getTime() < Date.now())
    return null;
  // A session is only valid while the email is still on the allowlist.
  if (!supportAllowlist().includes(s.email)) return null;
  return s.email;
}

function isAdmin(req: Request): boolean {
  return req.signedCookies?.palonur_admin === "1";
}

/** Strict: ONLY a real support cookie counts. (Admins are not "support".) */
async function requireSupport(req: Request, res: Response, next: NextFunction) {
  const email = await getSupportEmail(req);
  if (!email) return res.status(401).json({ error: "Unauthorized" });
  (req as Request & { supportEmail?: string }).supportEmail = email;
  return next();
}

/** Inbox access: a support agent OR a platform admin (convenience). Never an
 * editor / investor / member cookie. */
async function requireSupportOrAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const email = await getSupportEmail(req);
  if (email) {
    (req as Request & { supportEmail?: string; supportActor?: string }).supportEmail =
      email;
    (req as Request & { supportActor?: string }).supportActor = email;
    return next();
  }
  if (isAdmin(req)) {
    (req as Request & { supportActor?: string }).supportActor = "admin";
    return next();
  }
  return res.status(401).json({ error: "Unauthorized" });
}

// ── Magic-link auth ─────────────────────────────────────────────────────────

router.post(
  "/support-auth/request",
  emailRateLimit,
  async (req: Request, res: Response) => {
    const email = normalizeEmail((req.body as { email?: string }).email);
    if (!email) return res.status(400).json({ error: "Email required" });

    // Only mint + send a link when the address is on the allowlist. Everything
    // else gets the SAME generic success, so this never leaks who is support.
    if (!supportAllowlist().includes(email)) {
      req.log.warn({ email }, "support sign-in requested for non-allowlisted email");
      return res.json({ ok: true });
    }

    const token = randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + MAGIC_TTL_MS);
    await db.insert(supportSessionsTable).values({ email, magicToken: token, expiresAt });
    await sendSupportMagicLink({ to: email, token });
    return res.json({ ok: true });
  },
);

router.get("/support-auth/consume", async (req: Request, res: Response) => {
  const token = String(req.query.token ?? "");
  if (!token) return res.status(400).json({ error: "Token required" });
  const sessionToken = randomBytes(32).toString("hex");
  const sessionExpiresAt = new Date(Date.now() + SESSION_TTL_MS);
  // Atomic single-use consume: only the first request whose token is still
  // unconsumed AND unexpired wins the row, so a link can't be replayed.
  const consumed = await db
    .update(supportSessionsTable)
    .set({ consumedAt: new Date(), sessionToken, sessionExpiresAt })
    .where(
      and(
        eq(supportSessionsTable.magicToken, token),
        isNull(supportSessionsTable.consumedAt),
        gt(supportSessionsTable.expiresAt, new Date()),
      ),
    )
    .returning();
  if (consumed.length === 0) {
    return res.status(400).json({ error: "Link expired or already used" });
  }
  // Defense in depth: if the email fell off the allowlist between request and
  // consume, refuse to mint a usable cookie.
  if (!supportAllowlist().includes(consumed[0].email)) {
    return res.status(403).json({ error: "Not authorized" });
  }
  res.cookie(SUPPORT_COOKIE, sessionToken, {
    signed: true,
    httpOnly: true,
    sameSite: "lax",
    maxAge: SESSION_TTL_MS,
  });
  return res.json({ ok: true });
});

router.get("/support-auth/me", async (req: Request, res: Response) => {
  const email = await getSupportEmail(req);
  if (!email) return res.status(401).json({ error: "Unauthorized" });
  return res.json({ email });
});

router.post("/support-auth/logout", (_req: Request, res: Response) => {
  res.clearCookie(SUPPORT_COOKIE);
  return res.json({ ok: true });
});

// ── Public "Ask Palonur" intake ─────────────────────────────────────────────

router.post("/support/ask", async (req: Request, res: Response) => {
  const body = req.body as {
    name?: string;
    email?: string;
    message?: string;
    targetPillarId?: number;
    consentReply?: boolean;
    consentPrivacy?: boolean;
  };
  const email = normalizeEmail(body.email);
  const message = String(body.message ?? "").trim();
  if (!email) return res.status(400).json({ error: "A valid email is required" });
  if (message.length < 5)
    return res.status(400).json({ error: "Please write your question" });
  // Dual consent is mandatory.
  if (body.consentReply !== true || body.consentPrivacy !== true) {
    return res.status(400).json({ error: "Both consents are required" });
  }

  // Best-effort pre-triage; never blocks intake.
  const triage = await triageQuestion(message);

  try {
    const inserted = await db
      .insert(supportQuestionsTable)
      .values({
        source: "ask",
        status: "new",
        askerName: body.name ? String(body.name).trim().slice(0, 200) : null,
        askerEmail: email,
        message,
        targetPillarId:
          typeof body.targetPillarId === "number" ? body.targetPillarId : null,
        suggestedPillarId: triage.suggestedPillarId,
        suggestedPillarSlug: triage.suggestedPillarSlug,
        suggestedPillarName: triage.suggestedPillarName,
        suggestedStewardUserId: triage.suggestedStewardUserId,
        suggestedStewardName: triage.suggestedStewardName,
        draftReply: triage.draftReply,
        draftMode: triage.draftMode,
        sourceContext: triage.sourceContext,
        consentTimestamp: new Date(),
        consentIpHash: ipHash(req),
      })
      .returning({ id: supportQuestionsTable.id });
    return res.json({ ok: true, id: inserted[0]?.id });
  } catch (e) {
    req.log.error({ err: e }, "support ask intake failed");
    return res.status(500).json({ error: "Failed to submit" });
  }
});

// ── Inbox (support or admin) ────────────────────────────────────────────────

/** Pull in uncovered agent questions that aren't in the inbox yet, triaging
 * each. Capped per call so a load never triggers an unbounded triage storm.
 * Idempotent via the unique agent_query_id index. */
async function materializeUncovered(limit = 20): Promise<void> {
  // Existing agentQueryIds already in the inbox.
  const present = await db
    .select({ id: supportQuestionsTable.agentQueryId })
    .from(supportQuestionsTable)
    .where(sql`${supportQuestionsTable.agentQueryId} IS NOT NULL`);
  const seen = present
    .map((r) => r.id)
    .filter((id): id is string => typeof id === "string");

  const baseWhere = eq(agentQueriesTable.wasUncovered, true);
  const rows = await db
    .select({
      id: agentQueriesTable.id,
      question: agentQueriesTable.question,
    })
    .from(agentQueriesTable)
    .where(seen.length > 0 ? and(baseWhere, notInArray(agentQueriesTable.id, seen)) : baseWhere)
    .orderBy(desc(agentQueriesTable.createdAt))
    .limit(limit);

  for (const r of rows) {
    const triage = await triageQuestion(r.question);
    await db
      .insert(supportQuestionsTable)
      .values({
        source: "uncovered",
        status: "new",
        message: r.question,
        agentQueryId: r.id,
        suggestedPillarId: triage.suggestedPillarId,
        suggestedPillarSlug: triage.suggestedPillarSlug,
        suggestedPillarName: triage.suggestedPillarName,
        suggestedStewardUserId: triage.suggestedStewardUserId,
        suggestedStewardName: triage.suggestedStewardName,
        draftReply: triage.draftReply,
        draftMode: triage.draftMode,
        sourceContext: triage.sourceContext,
      })
      .onConflictDoNothing({ target: supportQuestionsTable.agentQueryId });
  }
}

router.get(
  "/support/inbox",
  requireSupportOrAdmin,
  async (req: Request, res: Response) => {
    try {
      await materializeUncovered();
    } catch (e) {
      // Materialization is best-effort; still serve whatever is already here.
      req.log.warn({ err: e }, "support inbox materialize failed");
    }
    try {
      const items = await db
        .select()
        .from(supportQuestionsTable)
        .orderBy(desc(supportQuestionsTable.createdAt))
        .limit(200);
      return res.json({ items });
    } catch (e) {
      req.log.error({ err: e }, "support inbox failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

// ── Resolution ──────────────────────────────────────────────────────────────

function actorOf(req: Request): string {
  return (
    (req as Request & { supportActor?: string }).supportActor ?? "support"
  );
}

/** Reply AS Palonur (warm concierge voice). Atomic: only an unresolved item
 * can be answered, so two agents can't double-send. */
router.post(
  "/support/questions/:id/send-palonur",
  requireSupportOrAdmin,
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const reply = String((req.body as { reply?: string }).reply ?? "").trim();
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Bad id" });
    if (reply.length < 1) return res.status(400).json({ error: "Reply required" });

    const updated = await db
      .update(supportQuestionsTable)
      .set({
        status: "answered",
        replyMode: "palonur",
        sentReply: reply,
        answeredBy: actorOf(req),
        answeredAt: new Date(),
      })
      .where(
        and(
          eq(supportQuestionsTable.id, id),
          sql`${supportQuestionsTable.status} IN ('new','pending_steward')`,
        ),
      )
      .returning();
    if (updated.length === 0) {
      return res.status(409).json({ error: "Already resolved or not found" });
    }
    const item = updated[0];
    if (item.askerEmail) {
      await sendSupportReply({
        to: item.askerEmail,
        name: item.askerName,
        question: item.message,
        reply,
      });
    }
    return res.json({ ok: true, item });
  },
);

/** Route to a steward for them to send in their own voice. Atomic: only a
 * still-`new` item can be routed. */
router.post(
  "/support/questions/:id/route-steward",
  requireSupportOrAdmin,
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const body = req.body as { stewardUserId?: number; draftReply?: string };
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Bad id" });

    // Resolve the target steward: explicit override or the triage suggestion.
    const existing = await db
      .select({ suggested: supportQuestionsTable.suggestedStewardUserId })
      .from(supportQuestionsTable)
      .where(eq(supportQuestionsTable.id, id))
      .limit(1);
    if (existing.length === 0) return res.status(404).json({ error: "Not found" });
    const stewardUserId =
      typeof body.stewardUserId === "number"
        ? body.stewardUserId
        : existing[0].suggested;
    if (stewardUserId == null) {
      return res.status(400).json({ error: "No steward to route to" });
    }

    const updated = await db
      .update(supportQuestionsTable)
      .set({
        status: "pending_steward",
        assignedStewardUserId: stewardUserId,
        replyMode: "steward",
        ...(typeof body.draftReply === "string"
          ? { draftReply: body.draftReply }
          : {}),
      })
      .where(
        and(eq(supportQuestionsTable.id, id), eq(supportQuestionsTable.status, "new")),
      )
      .returning();
    if (updated.length === 0) {
      return res.status(409).json({ error: "Already resolved or not found" });
    }
    return res.json({ ok: true, item: updated[0] });
  },
);

/** Dismiss without a reply (e.g. spam / out of scope). */
router.post(
  "/support/questions/:id/dismiss",
  requireSupportOrAdmin,
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Bad id" });
    const updated = await db
      .update(supportQuestionsTable)
      .set({ status: "closed", answeredBy: actorOf(req), answeredAt: new Date() })
      .where(
        and(
          eq(supportQuestionsTable.id, id),
          sql`${supportQuestionsTable.status} IN ('new','pending_steward')`,
        ),
      )
      .returning();
    if (updated.length === 0) {
      return res.status(409).json({ error: "Already resolved or not found" });
    }
    return res.json({ ok: true, item: updated[0] });
  },
);

// ── Steward hand-off (faculty/Clerk auth) ───────────────────────────────────

/** The items routed to the signed-in steward, awaiting their send. */
router.get(
  "/support/steward/queue",
  requireFacultyAuth,
  async (req: Request, res: Response) => {
    const fr = req as FacultyRequest;
    const userId = fr.faculty?.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    try {
      const items = await db
        .select()
        .from(supportQuestionsTable)
        .where(
          and(
            eq(supportQuestionsTable.assignedStewardUserId, userId),
            eq(supportQuestionsTable.status, "pending_steward"),
          ),
        )
        .orderBy(desc(supportQuestionsTable.createdAt));
      return res.json({ items });
    } catch (e) {
      req.log.error({ err: e }, "support steward queue failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

/** Steward approves + sends in their own voice. Atomic + idempotent: only the
 * assigned steward, only while still pending — so a resend never double-sends. */
router.post(
  "/support/steward/questions/:id/send",
  requireFacultyAuth,
  async (req: Request, res: Response) => {
    const fr = req as FacultyRequest;
    const userId = fr.faculty?.user?.id;
    const stewardName = fr.faculty?.user?.fullName ?? null;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const id = Number(req.params.id);
    const reply = String((req.body as { reply?: string }).reply ?? "").trim();
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Bad id" });
    if (reply.length < 1) return res.status(400).json({ error: "Reply required" });

    const updated = await db
      .update(supportQuestionsTable)
      .set({
        status: "answered",
        replyMode: "steward",
        sentReply: reply,
        answeredBy: stewardName ?? `steward:${userId}`,
        answeredAt: new Date(),
      })
      .where(
        and(
          eq(supportQuestionsTable.id, id),
          eq(supportQuestionsTable.assignedStewardUserId, userId),
          eq(supportQuestionsTable.status, "pending_steward"),
        ),
      )
      .returning();
    if (updated.length === 0) {
      return res
        .status(409)
        .json({ error: "Already sent, not yours, or not found" });
    }
    const item = updated[0];
    // Email the asker (when there is one — uncovered items are anonymous and
    // the steward's answer simply becomes part of the closed record / future
    // published knowledge).
    if (item.askerEmail) {
      await sendSupportReply({
        to: item.askerEmail,
        name: item.askerName,
        question: item.message,
        reply,
        stewardName,
      });
    }
    return res.json({ ok: true, item });
  },
);

export default router;
