import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { randomBytes } from "crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  communicationOffersTable,
  communicationReviewerSessionsTable,
} from "@workspace/db";
import {
  sendCommunicationMagicLink,
  sendCommunicationDecision,
} from "../lib/communicationEmail";
import { emailRateLimit } from "../middlewares/emailRateLimit";

const router: IRouter = Router();

const COMM_COOKIE = "comm_session";

// Separate allowlist from the newsletter editors (STORY_EDITOR_EMAILS) so Matt
// and the editors have fully distinct access. Default to Matt's steward email.
const ALLOWED_REVIEWER_EMAILS = (
  process.env.COMMUNICATION_REVIEWER_EMAILS ?? "abrahams_matt@gsb.stanford.edu"
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// ── Auth ────────────────────────────────────────────────────────────────────

async function getSessionReviewer(req: Request): Promise<string | null> {
  const token = req.signedCookies?.[COMM_COOKIE] as string | undefined;
  if (!token) return null;
  const rows = await db
    .select()
    .from(communicationReviewerSessionsTable)
    .where(eq(communicationReviewerSessionsTable.sessionToken, token))
    .limit(1);
  const s = rows[0];
  if (!s) return null;
  if (s.sessionExpiresAt && s.sessionExpiresAt.getTime() < Date.now())
    return null;
  return s.email;
}

function isAdmin(req: Request): boolean {
  return req.signedCookies?.palonur_admin === "1";
}

async function requireReviewerOrAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (isAdmin(req)) {
    (req as any).reviewerIdentity = "admin";
    return next();
  }
  const email = await getSessionReviewer(req);
  if (email) {
    (req as any).reviewerIdentity = email;
    return next();
  }
  return res.status(401).json({ error: "Unauthorized" });
}

// ── Magic-link auth ───────────────────────────────────────────────────────────

router.post(
  "/communication-auth/request",
  emailRateLimit,
  async (req: Request, res: Response) => {
    const email = String((req.body as { email?: string }).email ?? "")
      .trim()
      .toLowerCase();
    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "Email required" });
    }
    if (!ALLOWED_REVIEWER_EMAILS.includes(email)) {
      // Don't leak who is authorised — return generic success.
      req.log.warn(
        { email },
        "communication magic-link requested for non-allowed email",
      );
      return res.json({ ok: true });
    }
    const token = randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    await db.insert(communicationReviewerSessionsTable).values({
      email,
      magicToken: token,
      expiresAt,
    });
    await sendCommunicationMagicLink({ to: email, token });
    return res.json({ ok: true });
  },
);

router.get(
  "/communication-auth/consume",
  async (req: Request, res: Response) => {
    const token = String(req.query.token ?? "");
    if (!token) return res.status(400).json({ error: "Token required" });
    const rows = await db
      .select()
      .from(communicationReviewerSessionsTable)
      .where(eq(communicationReviewerSessionsTable.magicToken, token))
      .limit(1);
    const s = rows[0];
    if (!s || s.consumedAt || s.expiresAt.getTime() < Date.now()) {
      return res.status(400).json({ error: "Link expired or already used" });
    }
    const sessionToken = randomBytes(32).toString("hex");
    const sessionExpiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
    await db
      .update(communicationReviewerSessionsTable)
      .set({ consumedAt: new Date(), sessionToken, sessionExpiresAt })
      .where(eq(communicationReviewerSessionsTable.id, s.id));
    res.cookie(COMM_COOKIE, sessionToken, {
      signed: true,
      httpOnly: true,
      sameSite: "lax",
      maxAge: 8 * 60 * 60 * 1000,
    });
    return res.json({ ok: true });
  },
);

router.get(
  "/communication-auth/me",
  async (req: Request, res: Response) => {
    if (isAdmin(req)) return res.json({ email: "admin", isAdmin: true });
    const email = await getSessionReviewer(req);
    if (!email) return res.status(401).json({ error: "Unauthorized" });
    return res.json({ email, isAdmin: false });
  },
);

router.post(
  "/communication-auth/logout",
  async (req: Request, res: Response) => {
    const token = req.signedCookies?.[COMM_COOKIE] as string | undefined;
    if (token) {
      await db
        .update(communicationReviewerSessionsTable)
        .set({ sessionToken: null, sessionExpiresAt: null })
        .where(eq(communicationReviewerSessionsTable.sessionToken, token));
    }
    res.clearCookie(COMM_COOKIE);
    return res.json({ ok: true });
  },
);

// ── Reviewer queue ────────────────────────────────────────────────────────────

// GET /communication/offers?status= — Matt's queue, newest first.
router.get(
  "/communication/offers",
  requireReviewerOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const status = String(req.query.status ?? "").trim();
      const rows = await db
        .select()
        .from(communicationOffersTable)
        .where(
          status === "offered" ||
            status === "accepted" ||
            status === "declined"
            ? eq(communicationOffersTable.status, status)
            : undefined,
        )
        .orderBy(desc(communicationOffersTable.createdAt));
      return res.json({ offers: rows });
    } catch (e) {
      req.log.error({ err: e }, "list communication offers failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

// POST /communication/offers/:id/accept { note? } — atomically claim+accept.
router.post(
  "/communication/offers/:id/accept",
  requireReviewerOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const offerId = parseInt(String(req.params.id), 10);
      const note = String((req.body ?? {}).note ?? "")
        .trim()
        .slice(0, 1000);
      const [updated] = await db
        .update(communicationOffersTable)
        .set({
          status: "accepted",
          reviewerNote: note || null,
          reviewedBy: (req as any).reviewerIdentity ?? null,
          reviewedAt: new Date(),
        })
        .where(
          and(
            eq(communicationOffersTable.id, offerId),
            eq(communicationOffersTable.status, "offered"),
          ),
        )
        .returning();
      if (!updated) {
        const existing = (
          await db
            .select({ status: communicationOffersTable.status })
            .from(communicationOffersTable)
            .where(eq(communicationOffersTable.id, offerId))
            .limit(1)
        )[0];
        if (!existing) return res.status(404).json({ error: "Offer not found" });
        return res
          .status(409)
          .json({ error: `Offer already ${existing.status}` });
      }
      if (updated.authorEmail) {
        await sendCommunicationDecision({
          to: updated.authorEmail,
          title: updated.title,
          status: "accepted",
          note: updated.reviewerNote,
        });
      }
      return res.json({ offer: updated });
    } catch (e) {
      req.log.error({ err: e }, "accept communication offer failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

// POST /communication/offers/:id/decline { note? } — atomically claim+decline.
router.post(
  "/communication/offers/:id/decline",
  requireReviewerOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const offerId = parseInt(String(req.params.id), 10);
      const note = String((req.body ?? {}).note ?? "")
        .trim()
        .slice(0, 1000);
      const [updated] = await db
        .update(communicationOffersTable)
        .set({
          status: "declined",
          reviewerNote: note || null,
          reviewedBy: (req as any).reviewerIdentity ?? null,
          reviewedAt: new Date(),
        })
        .where(
          and(
            eq(communicationOffersTable.id, offerId),
            eq(communicationOffersTable.status, "offered"),
          ),
        )
        .returning();
      if (!updated) {
        const existing = (
          await db
            .select({ status: communicationOffersTable.status })
            .from(communicationOffersTable)
            .where(eq(communicationOffersTable.id, offerId))
            .limit(1)
        )[0];
        if (!existing) return res.status(404).json({ error: "Offer not found" });
        return res
          .status(409)
          .json({ error: `Offer already ${existing.status}` });
      }
      if (updated.authorEmail) {
        await sendCommunicationDecision({
          to: updated.authorEmail,
          title: updated.title,
          status: "declined",
          note: updated.reviewerNote,
        });
      }
      return res.json({ offer: updated });
    } catch (e) {
      req.log.error({ err: e }, "decline communication offer failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

export default router;
