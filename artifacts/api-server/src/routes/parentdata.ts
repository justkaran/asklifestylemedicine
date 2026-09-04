import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { randomBytes } from "crypto";
import { and, asc, desc, eq, isNull, isNotNull } from "drizzle-orm";
import {
  db,
  parentdataOffersTable,
  parentdataReviewerSessionsTable,
  parentdataOfferMessagesTable,
  parentdataCallsTable,
  facultyUsersTable,
} from "@workspace/db";
import {
  sendParentDataMagicLink,
  sendParentDataDecision,
  sendParentDataMessageNotice,
  sendParentDataCallNotice,
} from "../lib/parentdataEmail";
import { isHiddenFacultyEmail } from "../middlewares/facultyAuth.js";
import { emailRateLimit } from "../middlewares/emailRateLimit";

// Largest payment / budget the editor can record, in cents ($1,000,000). A
// guard against fat-fingered amounts; this is a record-only number anyway.
const MAX_CENTS = 100_000_000;

/**
 * Parse an optional cents value from a request body. Returns:
 *  - `undefined` when the field is absent/blank (caller decides the default),
 *  - a non-negative integer when valid,
 *  - `null` when present but invalid (caller should 400).
 */
function parseCents(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_CENTS) return null;
  return n;
}

const router: IRouter = Router();

const PARENTDATA_COOKIE = "parentdata_session";

// Separate allowlist from the newsletter editors (STORY_EDITOR_EMAILS) and from
// Matt's queue (COMMUNICATION_REVIEWER_EMAILS) so ParentData's editor has fully
// distinct access. Default to ParentData's editorial inbox — override via env.
const ALLOWED_REVIEWER_EMAILS = (
  process.env.PARENTDATA_REVIEWER_EMAILS ?? "hello@parentdata.org"
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// ── Auth ────────────────────────────────────────────────────────────────────

async function getSessionReviewer(req: Request): Promise<string | null> {
  const token = req.signedCookies?.[PARENTDATA_COOKIE] as string | undefined;
  if (!token) return null;
  const rows = await db
    .select()
    .from(parentdataReviewerSessionsTable)
    .where(eq(parentdataReviewerSessionsTable.sessionToken, token))
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
  "/parentdata-auth/request",
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
        "parentdata magic-link requested for non-allowed email",
      );
      return res.json({ ok: true });
    }
    const token = randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    await db.insert(parentdataReviewerSessionsTable).values({
      email,
      magicToken: token,
      expiresAt,
    });
    await sendParentDataMagicLink({ to: email, token });
    return res.json({ ok: true });
  },
);

router.get("/parentdata-auth/consume", async (req: Request, res: Response) => {
  const token = String(req.query.token ?? "");
  if (!token) return res.status(400).json({ error: "Token required" });
  const rows = await db
    .select()
    .from(parentdataReviewerSessionsTable)
    .where(eq(parentdataReviewerSessionsTable.magicToken, token))
    .limit(1);
  const s = rows[0];
  if (!s || s.consumedAt || s.expiresAt.getTime() < Date.now()) {
    return res.status(400).json({ error: "Link expired or already used" });
  }
  const sessionToken = randomBytes(32).toString("hex");
  const sessionExpiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
  // Consume atomically: only the first of two simultaneous clicks should win.
  const [claimed] = await db
    .update(parentdataReviewerSessionsTable)
    .set({ consumedAt: new Date(), sessionToken, sessionExpiresAt })
    .where(
      and(
        eq(parentdataReviewerSessionsTable.id, s.id),
        isNull(parentdataReviewerSessionsTable.consumedAt),
      ),
    )
    .returning();
  if (!claimed) {
    return res.status(400).json({ error: "Link expired or already used" });
  }
  res.cookie(PARENTDATA_COOKIE, sessionToken, {
    signed: true,
    httpOnly: true,
    sameSite: "lax",
    maxAge: 8 * 60 * 60 * 1000,
  });
  return res.json({ ok: true });
});

router.get("/parentdata-auth/me", async (req: Request, res: Response) => {
  if (isAdmin(req)) return res.json({ email: "admin", isAdmin: true });
  const email = await getSessionReviewer(req);
  if (!email) return res.status(401).json({ error: "Unauthorized" });
  return res.json({ email, isAdmin: false });
});

router.post("/parentdata-auth/logout", async (req: Request, res: Response) => {
  const token = req.signedCookies?.[PARENTDATA_COOKIE] as string | undefined;
  if (token) {
    await db
      .update(parentdataReviewerSessionsTable)
      .set({ sessionToken: null, sessionExpiresAt: null })
      .where(eq(parentdataReviewerSessionsTable.sessionToken, token));
  }
  res.clearCookie(PARENTDATA_COOKIE);
  return res.json({ ok: true });
});

// ── Reviewer queue ────────────────────────────────────────────────────────────

// GET /parentdata/offers?status= — the editor's queue, newest first.
router.get(
  "/parentdata/offers",
  requireReviewerOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const status = String(req.query.status ?? "").trim();
      const rows = await db
        .select()
        .from(parentdataOffersTable)
        .where(
          status === "offered" ||
            status === "accepted" ||
            status === "declined"
            ? eq(parentdataOffersTable.status, status)
            : undefined,
        )
        .orderBy(desc(parentdataOffersTable.createdAt));
      return res.json({ offers: rows });
    } catch (e) {
      req.log.error({ err: e }, "list parentdata offers failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

async function resolveDecision(
  req: Request,
  res: Response,
  status: "accepted" | "declined",
) {
  try {
    const offerId = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(offerId)) {
      return res.status(400).json({ error: "Invalid proposal id" });
    }
    const note = String((req.body ?? {}).note ?? "")
      .trim()
      .slice(0, 1000);
    // Payment is an accept-only decision: null = undecided, 0 = won't pay,
    // >0 = amount in cents. A declined proposal never carries a payment.
    let paymentCents: number | null = null;
    if (status === "accepted") {
      const parsed = parseCents((req.body ?? {}).paymentCents);
      if (parsed === null) {
        return res.status(400).json({ error: "Invalid payment amount" });
      }
      paymentCents = parsed ?? null;
    }
    const [updated] = await db
      .update(parentdataOffersTable)
      .set({
        status,
        reviewerNote: note || null,
        paymentCents,
        reviewedBy: (req as any).reviewerIdentity ?? null,
        reviewedAt: new Date(),
      })
      .where(
        and(
          eq(parentdataOffersTable.id, offerId),
          eq(parentdataOffersTable.status, "offered"),
        ),
      )
      .returning();
    if (!updated) {
      const existing = (
        await db
          .select({ status: parentdataOffersTable.status })
          .from(parentdataOffersTable)
          .where(eq(parentdataOffersTable.id, offerId))
          .limit(1)
      )[0];
      if (!existing) return res.status(404).json({ error: "Proposal not found" });
      return res.status(409).json({ error: `Proposal already ${existing.status}` });
    }
    if (updated.authorEmail) {
      try {
        await sendParentDataDecision({
          to: updated.authorEmail,
          title: updated.title,
          status,
          note: updated.reviewerNote,
          paymentCents: updated.paymentCents,
        });
      } catch (notifyErr) {
        req.log.error({ err: notifyErr }, "parentdata decision notice failed");
      }
    }
    return res.json({ offer: updated });
  } catch (e) {
    req.log.error({ err: e }, `parentdata ${status} failed`);
    return res.status(500).json({ error: "Failed" });
  }
}

// POST /parentdata/offers/:id/accept { note? } — atomically claim+accept.
router.post(
  "/parentdata/offers/:id/accept",
  requireReviewerOrAdmin,
  (req: Request, res: Response) => resolveDecision(req, res, "accepted"),
);

// POST /parentdata/offers/:id/decline { note? } — atomically claim+decline.
router.post(
  "/parentdata/offers/:id/decline",
  requireReviewerOrAdmin,
  (req: Request, res: Response) => resolveDecision(req, res, "declined"),
);

// ── Calls for articles ──────────────────────────────────────────────────────
// The ParentData editor authors a "call for articles" that faculty stewards see
// in their portal. Reviewer/admin only — faculty read OPEN calls via the
// faculty router. Money (budget) is record-only.

// GET /parentdata/calls — every call (open + closed), newest first.
router.get(
  "/parentdata/calls",
  requireReviewerOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const calls = await db
        .select()
        .from(parentdataCallsTable)
        .orderBy(desc(parentdataCallsTable.createdAt));
      return res.json({ calls });
    } catch (e) {
      req.log.error({ err: e }, "list parentdata calls failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

// POST /parentdata/calls { title, brief?, budgetCents? } — author a new call and
// best-effort notify active faculty stewards (one email each, never CC'd).
router.post(
  "/parentdata/calls",
  requireReviewerOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const title = String((req.body ?? {}).title ?? "")
        .trim()
        .slice(0, 300);
      if (!title) return res.status(400).json({ error: "Title required" });
      const brief = String((req.body ?? {}).brief ?? "")
        .trim()
        .slice(0, 5000);
      const budget = parseCents((req.body ?? {}).budgetCents);
      if (budget === null) {
        return res.status(400).json({ error: "Invalid budget amount" });
      }
      const [call] = await db
        .insert(parentdataCallsTable)
        .values({
          title,
          brief: brief || null,
          budgetCents: budget ?? null,
          createdBy: (req as any).reviewerIdentity ?? null,
        })
        .returning();

      // Notify every active, non-hidden faculty steward — one email each so no
      // address is exposed to another. Best-effort: failures never block.
      try {
        const recipients = await db
          .select({ email: facultyUsersTable.email })
          .from(facultyUsersTable)
          .where(
            and(
              isNotNull(facultyUsersTable.email),
              isNull(facultyUsersTable.deactivatedAt),
            ),
          );
        const seen = new Set<string>();
        for (const r of recipients) {
          const email = (r.email ?? "").trim().toLowerCase();
          if (!email || seen.has(email) || isHiddenFacultyEmail(email)) continue;
          seen.add(email);
          await sendParentDataCallNotice({
            to: email,
            title: call.title,
            brief: call.brief,
            budgetCents: call.budgetCents,
          });
        }
      } catch (notifyErr) {
        req.log.error(
          { err: notifyErr },
          "parentdata call broadcast failed",
        );
      }
      return res.json({ call });
    } catch (e) {
      req.log.error({ err: e }, "create parentdata call failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

// PATCH /parentdata/calls/:id { title?, brief?, budgetCents?, status? } — edit
// or close/reopen a call.
router.patch(
  "/parentdata/calls/:id",
  requireReviewerOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isInteger(id)) {
        return res.status(400).json({ error: "Invalid call id" });
      }
      const body = req.body ?? {};
      const patch: Partial<{
        title: string;
        brief: string | null;
        budgetCents: number | null;
        status: "open" | "closed";
      }> = {};
      if (body.title !== undefined) {
        const title = String(body.title).trim().slice(0, 300);
        if (!title) return res.status(400).json({ error: "Title required" });
        patch.title = title;
      }
      if (body.brief !== undefined) {
        const brief = String(body.brief).trim().slice(0, 5000);
        patch.brief = brief || null;
      }
      if (body.budgetCents !== undefined) {
        const budget = parseCents(body.budgetCents);
        if (budget === null) {
          return res.status(400).json({ error: "Invalid budget amount" });
        }
        patch.budgetCents = budget ?? null;
      }
      if (body.status !== undefined) {
        if (body.status !== "open" && body.status !== "closed") {
          return res.status(400).json({ error: "Invalid status" });
        }
        patch.status = body.status;
      }
      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: "Nothing to update" });
      }
      const [call] = await db
        .update(parentdataCallsTable)
        .set(patch)
        .where(eq(parentdataCallsTable.id, id))
        .returning();
      if (!call) return res.status(404).json({ error: "Call not found" });
      return res.json({ call });
    } catch (e) {
      req.log.error({ err: e }, "update parentdata call failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

// ── Conversation ──────────────────────────────────────────────────────────────

// GET /parentdata/offers/:id/messages — full thread, oldest first.
router.get(
  "/parentdata/offers/:id/messages",
  requireReviewerOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const offerId = parseInt(String(req.params.id), 10);
      if (!Number.isInteger(offerId)) {
        return res.status(400).json({ error: "Invalid id" });
      }
      const [offer] = await db
        .select({ id: parentdataOffersTable.id })
        .from(parentdataOffersTable)
        .where(eq(parentdataOffersTable.id, offerId))
        .limit(1);
      if (!offer) return res.status(404).json({ error: "Proposal not found" });
      const messages = await db
        .select()
        .from(parentdataOfferMessagesTable)
        .where(eq(parentdataOfferMessagesTable.offerId, offerId))
        .orderBy(asc(parentdataOfferMessagesTable.createdAt));
      return res.json({ messages });
    } catch (e) {
      req.log.error({ err: e }, "list parentdata messages failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

// POST /parentdata/offers/:id/messages { body } — editor posts a message.
router.post(
  "/parentdata/offers/:id/messages",
  requireReviewerOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const offerId = parseInt(String(req.params.id), 10);
      if (!Number.isInteger(offerId)) {
        return res.status(400).json({ error: "Invalid id" });
      }
      const body = String((req.body ?? {}).body ?? "")
        .trim()
        .slice(0, 5000);
      if (!body) return res.status(400).json({ error: "Message required" });
      const [offer] = await db
        .select()
        .from(parentdataOffersTable)
        .where(eq(parentdataOffersTable.id, offerId))
        .limit(1);
      if (!offer) return res.status(404).json({ error: "Proposal not found" });
      const identity = (req as any).reviewerIdentity as string | undefined;
      const senderEmail =
        identity && identity !== "admin" && identity.includes("@")
          ? identity
          : null;
      const [message] = await db
        .insert(parentdataOfferMessagesTable)
        .values({
          offerId,
          senderRole: "reviewer",
          senderName: senderEmail ?? "ParentData editor",
          senderEmail,
          body,
        })
        .returning();
      // Notify the steward (fire-and-forget; never fail the write).
      if (offer.authorEmail) {
        try {
          await sendParentDataMessageNotice({
            to: offer.authorEmail,
            fromName: "ParentData",
            title: offer.title,
            body,
            audience: "faculty",
          });
        } catch (notifyErr) {
          req.log.error(
            { err: notifyErr },
            "parentdata message notice failed",
          );
        }
      }
      return res.json({ message });
    } catch (e) {
      req.log.error({ err: e }, "post parentdata message failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

export default router;
