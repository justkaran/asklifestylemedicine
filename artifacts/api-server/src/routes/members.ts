/**
 * Members area — passwordless reading room for newsletter subscribers.
 *
 * A consumer who has subscribed to one or more Palonur publications can sign in
 * here (magic-link, no password) to read the issues of the publications they're
 * subscribed to and use the auto-routing "ask anything" Q&A (which lives at
 * /api/newsletter-qa). This surface is deliberately ISOLATED from every other
 * auth context:
 *
 *  - its own `members_session` cookie (never the editor `stories_session`, the
 *    `palonur_admin` cookie, the `investor_session`, or Clerk faculty auth), so
 *    a members session can never reach an editor/admin/investor surface;
 *  - its own `newsletter_subscriber_sessions` table, keyed by EMAIL (one email
 *    can subscribe to several publications), separate from every other session
 *    store.
 *
 * A session is minted ONLY by clicking an emailed one-time link — never by
 * subscribing or paying (payment/subscribe never proves email ownership). The
 * request endpoint emails a link only when an ACTIVE subscriber row exists for
 * the address, but always returns a generic success so it never leaks whether
 * an email is a subscriber.
 */
import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { randomBytes } from "crypto";
import { eq, and, isNull, gt, desc, inArray } from "drizzle-orm";
import {
  db,
  newsletterSubscribersTable,
  newsletterSubscriberSessionsTable,
  newsletterPublicationsTable,
} from "@workspace/db";
import { sendSubscriberSignInLink } from "../lib/newsletterEmail";
import { emailRateLimit } from "../middlewares/emailRateLimit";
import {
  listActiveSubscriptionsForEmail,
  subscriptionsHaveAllAccess,
} from "../lib/consumerAuth";

const router: IRouter = Router();

const MEMBERS_COOKIE = "members_session";
const MAGIC_TTL_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Lowercased, trimmed email or null when it isn't a plausible address. */
function normalizeEmail(raw: unknown): string | null {
  const email = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!email || !email.includes("@")) return null;
  return email;
}

/** Resolve the signed-in subscriber's email from the members session cookie. */
async function getSessionEmail(req: Request): Promise<string | null> {
  const token = req.signedCookies?.[MEMBERS_COOKIE];
  if (!token || typeof token !== "string") return null;
  const rows = await db
    .select()
    .from(newsletterSubscriberSessionsTable)
    .where(eq(newsletterSubscriberSessionsTable.sessionToken, token))
    .limit(1);
  const s = rows[0];
  if (!s) return null;
  if (s.sessionExpiresAt && s.sessionExpiresAt.getTime() < Date.now())
    return null;
  return s.email;
}

async function requireSubscriberAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const email = await getSessionEmail(req);
  if (!email) return res.status(401).json({ error: "Unauthorized" });
  (req as Request & { subscriberEmail?: string }).subscriberEmail = email;
  return next();
}

/** Active subscriptions for an email → the publications they may read. */
async function activeSubscriptionsFor(email: string) {
  const subs = await db
    .select({
      publicationId: newsletterSubscribersTable.publicationId,
      subscribedAt: newsletterSubscribersTable.createdAt,
    })
    .from(newsletterSubscribersTable)
    .where(
      and(
        eq(newsletterSubscribersTable.email, email),
        eq(newsletterSubscribersTable.status, "active"),
      ),
    );
  const subscribedAt = new Map(
    subs.map((s) => [s.publicationId, s.subscribedAt]),
  );

  // All-access subscribers (the $19 bundle) read every publication, even ones
  // they never explicitly subscribed to. Everyone else sees only their rows.
  const allAccess = subscriptionsHaveAllAccess(
    await listActiveSubscriptionsForEmail(email),
  );

  const pubCols = {
    id: newsletterPublicationsTable.id,
    name: newsletterPublicationsTable.name,
    slug: newsletterPublicationsTable.slug,
    tagline: newsletterPublicationsTable.tagline,
    accentColor: newsletterPublicationsTable.accentColor,
    isHouse: newsletterPublicationsTable.isHouse,
  };

  let pubs: Array<{
    id: number;
    name: string;
    slug: string;
    tagline: string | null;
    accentColor: string | null;
    isHouse: boolean;
  }>;
  if (allAccess) {
    pubs = await db
      .select(pubCols)
      .from(newsletterPublicationsTable)
      .orderBy(desc(newsletterPublicationsTable.isHouse));
  } else {
    const pubIds = subs
      .map((s) => s.publicationId)
      .filter((id): id is number => typeof id === "number");
    if (pubIds.length === 0) return [];
    pubs = await db
      .select(pubCols)
      .from(newsletterPublicationsTable)
      .where(inArray(newsletterPublicationsTable.id, pubIds))
      .orderBy(desc(newsletterPublicationsTable.isHouse));
  }

  return pubs.map((p) => ({
    ...p,
    subscribedAt: subscribedAt.get(p.id) ?? null,
    viaAllAccess: allAccess && !subscribedAt.has(p.id),
  }));
}

// ── Magic-link auth ─────────────────────────────────────────────────────────

router.post(
  "/members-auth/request",
  emailRateLimit,
  async (req: Request, res: Response) => {
    const email = normalizeEmail((req.body as { email?: string }).email);
    if (!email) return res.status(400).json({ error: "Email required" });

    // Only mint + send a link when an ACTIVE subscriber row exists for this
    // email. Pending/unsubscribed rows (and unknown emails) get the SAME generic
    // success below, so this never leaks whether an email is a subscriber.
    const rows = await db
      .select({
        name: newsletterSubscribersTable.name,
      })
      .from(newsletterSubscribersTable)
      .where(
        and(
          eq(newsletterSubscribersTable.email, email),
          eq(newsletterSubscribersTable.status, "active"),
        ),
      )
      .limit(1);
    const sub = rows[0];

    // All-access holders ($19 bundle) can sign in even without an explicit
    // subscriber row — their reading room lists every publication.
    let allowed = Boolean(sub);
    if (!allowed) {
      const consumerSubs = await listActiveSubscriptionsForEmail(email);
      if (subscriptionsHaveAllAccess(consumerSubs)) allowed = true;
    }

    if (!allowed) {
      req.log.warn(
        { email },
        "members sign-in requested for a non-subscriber email",
      );
      return res.json({ ok: true });
    }

    const token = randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + MAGIC_TTL_MS);
    await db.insert(newsletterSubscriberSessionsTable).values({
      email,
      magicToken: token,
      expiresAt,
    });
    await sendSubscriberSignInLink({ to: email, name: sub?.name ?? null, token });
    return res.json({ ok: true });
  },
);

router.get("/members-auth/consume", async (req: Request, res: Response) => {
  const token = String(req.query.token ?? "");
  if (!token) return res.status(400).json({ error: "Token required" });
  const sessionToken = randomBytes(32).toString("hex");
  const sessionExpiresAt = new Date(Date.now() + SESSION_TTL_MS);
  // Atomic single-use consume: only the first request whose token is still
  // unconsumed AND unexpired wins the row, so a link can't be replayed.
  const consumed = await db
    .update(newsletterSubscriberSessionsTable)
    .set({ consumedAt: new Date(), sessionToken, sessionExpiresAt })
    .where(
      and(
        eq(newsletterSubscriberSessionsTable.magicToken, token),
        isNull(newsletterSubscriberSessionsTable.consumedAt),
        gt(newsletterSubscriberSessionsTable.expiresAt, new Date()),
      ),
    )
    .returning();
  if (consumed.length === 0) {
    return res.status(400).json({ error: "Link expired or already used" });
  }
  res.cookie(MEMBERS_COOKIE, sessionToken, {
    signed: true,
    httpOnly: true,
    sameSite: "lax",
    maxAge: SESSION_TTL_MS,
  });
  return res.json({ ok: true });
});

router.get("/members-auth/me", async (req: Request, res: Response) => {
  const email = await getSessionEmail(req);
  if (!email) return res.status(401).json({ error: "Unauthorized" });
  return res.json({ email });
});

router.post("/members-auth/logout", (_req: Request, res: Response) => {
  res.clearCookie(MEMBERS_COOKIE);
  return res.json({ ok: true });
});

// ── Members portal bundle ───────────────────────────────────────────────────

router.get(
  "/members/portal",
  requireSubscriberAuth,
  async (req: Request, res: Response) => {
    const email = (req as Request & { subscriberEmail: string })
      .subscriberEmail;
    try {
      const subscriptions = await activeSubscriptionsFor(email);
      return res.json({ email, subscriptions });
    } catch (e) {
      req.log.error({ err: e }, "members portal failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

export default router;
