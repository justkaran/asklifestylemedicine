import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { randomBytes } from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { eq, desc, asc, and, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  newsletterPublicationsTable,
  newsletterSubscribersTable,
  newsletterIssuesTable,
  newsletterPostsTable,
  newsletterOffersTable,
  newsletterCreditsTable,
  consumerAccountsTable,
  consumerLoginTokensTable,
  storiesTable,
  storyEditorSessionsTable,
  facultyUsersTable,
  facultyMembershipsTable,
  facultyVoiceProfilesTable,
  pillarsTable,
} from "@workspace/db";
import {
  buildIssueHtml,
  buildTeaserHtml,
  htmlToText,
  unsubscribeUrlFor,
  confirmUrlFor,
  sendNewsletterEmail,
  sendSubscriberConfirmationEmail,
  sendNewsletterPortalLink,
  sendWelcomeEmail,
  brandingForPublication,
  sendKarenPillarNotificationConfirmation,
  sendKarenPillarWelcomeEmail,
  type IssueForEmail,
  type PostForEmail,
} from "../lib/newsletterEmail";
import { replyLoopConfigured } from "../lib/agentMail.js";
import { sanitizeNewsletterHtml } from "../lib/sanitizeHtml";
import { loadStewardAskEligibility } from "../lib/stewardAsk";
import {
  getStewardPlan,
  stewardLookupKey,
  hasStewardAccess,
} from "../lib/stewardBilling";
import { getConsumerFromRequest } from "../lib/consumerAuth";
import {
  loadPillarScience,
  resolvePublicationPillarIds,
} from "../lib/pillarScience";
import {
  getUncachableStripeClient,
  getStripeSync,
  isStripeConnected,
} from "../lib/stripeClient";
import {
  siteBaseUrl,
  findOrCreateConsumerByEmail,
  ensureStripeCustomer,
} from "../lib/consumerBilling";
import {
  getNewsletterPlans,
  isNewsletterPrice,
  getPaidNewsletterCustomerIds,
  getNewsletterRevenue,
} from "../lib/newsletterBilling";
import {
  generateLandingCopy,
  generateLandingImages,
  generateLandingImage,
  resolveLandingForPublic,
  landingContentEditSchema,
  normalizeEditedLanding,
  isImageGenAvailable,
} from "../lib/newsletterLanding";
import { z } from "zod/v4";

const router: IRouter = Router();

const STORIES_COOKIE = "stories_session";

// Default per-inclusion reimbursement amount (cents). Override with env.
const CREDIT_CENTS = (() => {
  const n = parseInt(String(process.env.NEWSLETTER_CREDIT_CENTS ?? ""), 10);
  return Number.isFinite(n) && n >= 0 ? n : 5000;
})();

const anthropic = new Anthropic({
  baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
});

let openaiClient: OpenAI | null = null;
function getOpenAI(): OpenAI | null {
  if (openaiClient) return openaiClient;
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!baseURL || !apiKey) return null;
  openaiClient = new OpenAI({ baseURL, apiKey });
  return openaiClient;
}

// ── Auth (shares the Stories editor session + admin cookie) ──────────────────

async function getSessionEditor(req: Request): Promise<string | null> {
  const token = req.signedCookies?.[STORIES_COOKIE] as string | undefined;
  if (!token) return null;
  const rows = await db
    .select()
    .from(storyEditorSessionsTable)
    .where(eq(storyEditorSessionsTable.sessionToken, token))
    .limit(1);
  const s = rows[0];
  if (!s) return null;
  if (s.sessionExpiresAt && s.sessionExpiresAt.getTime() < Date.now()) return null;
  return s.email;
}

function isAdmin(req: Request): boolean {
  return req.signedCookies?.palonur_admin === "1";
}

async function requireEditorOrAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (isAdmin(req)) {
    (req as any).editorIdentity = "admin";
    return next();
  }
  const email = await getSessionEditor(req);
  if (email) {
    (req as any).editorIdentity = email;
    return next();
  }
  return res.status(401).json({ error: "Unauthorized" });
}

function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// ── House publication ────────────────────────────────────────────────────────
// Every SLM (editor/admin) route operates on the single "house" publication so
// the original newsletter keeps working unchanged while faculty self-publish to
// their own publications. Found-or-created idempotently; constants mirror the
// backfill script (scripts/src/backfill-publications.ts).

const HOUSE_SLUG = "stanford-lifestyle-medicine";
const HOUSE_NAME = "Stanford Lifestyle Medicine";

type PublicationRow = typeof newsletterPublicationsTable.$inferSelect;

export async function ensureHousePublication(): Promise<PublicationRow> {
  const found = await db
    .select()
    .from(newsletterPublicationsTable)
    .where(eq(newsletterPublicationsTable.isHouse, true))
    .limit(1);
  if (found[0]) return found[0];
  try {
    const [row] = await db
      .insert(newsletterPublicationsTable)
      .values({
        isHouse: true,
        facultyUserId: null,
        name: HOUSE_NAME,
        slug: HOUSE_SLUG,
        bylineName: HOUSE_NAME,
        bylineInstitution: "Stanford University",
        tagline: "Evidence-based lifestyle medicine from Stanford.",
      })
      .returning();
    return row;
  } catch {
    // Lost a race to create the singleton house row — re-read it.
    const again = await db
      .select()
      .from(newsletterPublicationsTable)
      .where(eq(newsletterPublicationsTable.isHouse, true))
      .limit(1);
    if (again[0]) return again[0];
    throw new Error("Failed to ensure house publication");
  }
}

// ── Public: subscribe ────────────────────────────────────────────────────────

/**
 * Shared public house-newsletter subscribe with DOUBLE OPT-IN. Used by the
 * public subscribe route below and by the save-answer flow's explicit
 * newsletter checkbox. New/pending/unsubscribed emails become (or stay)
 * `pending` and get a confirmation email — nobody receives newsletters until
 * they confirm. Already-active subscribers are left untouched (no email).
 */
export async function subscribePendingToHouseNewsletter(
  emailRaw: string,
  opts: {
    name?: string | null;
    source?: string;
    referralSource?: string | null;
    /**
     * Skip the confirmation email. Used by the SLM chat onboarding, whose
     * account-verification magic link doubles as the newsletter confirmation
     * (one email, one click). The row still starts `pending`, so if the user
     * never verifies, they never receive a newsletter.
     */
    skipEmail?: boolean;
  } = {},
): Promise<{ ok: boolean; alreadySubscribed?: boolean; pending?: boolean }> {
  const emailClean = String(emailRaw ?? "").trim().toLowerCase();
  if (!emailClean || !isEmail(emailClean)) {
    throw new Error("A valid email is required");
  }
  const nameClean = opts.name ? String(opts.name).trim().slice(0, 200) : null;
  const sourceClean = opts.source
    ? String(opts.source).trim().slice(0, 80)
    : "web";
  const referralSourceClean = opts.referralSource
    ? String(opts.referralSource).trim().slice(0, 200)
    : null;

  const house = await ensureHousePublication();
  const branding = brandingForPublication(house);
  const isKarenPillar = sourceClean === "karen-parker-pillar";

  const existing = await db
    .select()
    .from(newsletterSubscribersTable)
    .where(
      and(
        eq(newsletterSubscribersTable.publicationId, house.id),
        eq(newsletterSubscribersTable.email, emailClean),
      ),
    )
    .limit(1);

  if (existing[0]) {
    // Already a confirmed, active subscriber — nothing to do, no email.
    if (existing[0].status === "active") {
      return { ok: true, alreadySubscribed: true };
    }
    // Pending or previously unsubscribed: (re)issue a fresh confirmation so
    // they re-prove ownership before we ever send them anything (double
    // opt-in). Stays/returns to pending until they click the link.
    const confirmToken = randomBytes(24).toString("hex");
    await db
      .update(newsletterSubscribersTable)
      .set({
        status: "pending",
        confirmToken,
        confirmedAt: null,
        unsubscribedAt: null,
        name: nameClean ?? existing[0].name,
        source: sourceClean,
        referralSource: referralSourceClean ?? existing[0].referralSource,
      })
      .where(eq(newsletterSubscribersTable.id, existing[0].id));
    if (opts.skipEmail) return { ok: true, pending: true };
    if (isKarenPillar) {
      await sendKarenPillarNotificationConfirmation({
        to: emailClean,
        name: nameClean ?? existing[0].name,
        confirmUrl: confirmUrlFor(confirmToken),
      });
    } else {
      await sendSubscriberConfirmationEmail({
        to: emailClean,
        name: nameClean ?? existing[0].name,
        confirmUrl: confirmUrlFor(confirmToken),
        branding,
      });
    }
    return { ok: true, pending: true };
  }

  // Brand-new subscriber: create as PENDING and email a confirmation link.
  // They receive no newsletters until they confirm (status flips to active).
  const confirmToken = randomBytes(24).toString("hex");
  await db.insert(newsletterSubscribersTable).values({
    publicationId: house.id,
    email: emailClean,
    name: nameClean,
    source: sourceClean,
    referralSource: referralSourceClean,
    status: "pending",
    unsubscribeToken: randomBytes(24).toString("hex"),
    confirmToken,
    confirmedAt: null,
  });
  if (opts.skipEmail) return { ok: true, pending: true };
  if (isKarenPillar) {
    await sendKarenPillarNotificationConfirmation({
      to: emailClean,
      name: nameClean,
      confirmUrl: confirmUrlFor(confirmToken),
    });
  } else {
    await sendSubscriberConfirmationEmail({
      to: emailClean,
      name: nameClean,
      confirmUrl: confirmUrlFor(confirmToken),
      branding,
    });
  }
  return { ok: true, pending: true };
}

router.post("/newsletter/subscribe", async (req: Request, res: Response) => {
  try {
    const { email, name, source, referralSource } = req.body as {
      email?: string;
      name?: string;
      source?: string;
      referralSource?: string;
    };
    const emailClean = String(email ?? "").trim().toLowerCase();
    if (!emailClean || !isEmail(emailClean)) {
      return res.status(400).json({ error: "A valid email is required" });
    }
    const result = await subscribePendingToHouseNewsletter(emailClean, {
      name: name ? String(name) : null,
      source: source ? String(source) : undefined,
      referralSource: referralSource ? String(referralSource) : null,
    });
    return res.json(result);
  } catch (e) {
    req.log.error({ err: e }, "newsletter subscribe failed");
    return res.status(500).json({ error: "Failed" });
  }
});

// ── Public: unsubscribe (one-click link from email) ──────────────────────────

function unsubPage(message: string, mastheadName = HOUSE_NAME): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe · Palonur</title></head>
<body style="margin:0;background:#FAF8F4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a0505;">
<div style="max-width:480px;margin:80px auto;padding:0 24px;text-align:center;">
  <p style="font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#8B1A1A;margin:0 0 10px;">${mastheadName.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>
  <p style="font-size:18px;line-height:1.6;">${message}</p>
</div></body></html>`;
}

router.get("/newsletter/unsubscribe", async (req: Request, res: Response) => {
  try {
    const token = String(req.query.token ?? "");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (!token) {
      return res.status(400).send(unsubPage("Invalid unsubscribe link."));
    }
    const rows = await db
      .select()
      .from(newsletterSubscribersTable)
      .where(eq(newsletterSubscribersTable.unsubscribeToken, token))
      .limit(1);
    if (!rows[0]) {
      return res.status(404).send(unsubPage("This unsubscribe link is no longer valid."));
    }
    // Brand the confirmation page with the subscriber's own publication.
    let mastheadName = HOUSE_NAME;
    if (rows[0].publicationId != null) {
      const pub = (
        await db
          .select({ name: newsletterPublicationsTable.name })
          .from(newsletterPublicationsTable)
          .where(eq(newsletterPublicationsTable.id, rows[0].publicationId))
          .limit(1)
      )[0];
      if (pub?.name) mastheadName = pub.name;
    }
    await db
      .update(newsletterSubscribersTable)
      .set({ status: "unsubscribed", unsubscribedAt: new Date() })
      .where(eq(newsletterSubscribersTable.id, rows[0].id));
    return res.send(
      unsubPage(
        "You've been unsubscribed. You won't receive any more newsletters.",
        mastheadName,
      ),
    );
  } catch (e) {
    req.log.error({ err: e }, "unsubscribe failed");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(500).send(unsubPage("Something went wrong. Please try again later."));
  }
});

// ── Public: confirm subscription (double opt-in link from email) ─────────────
// Clicked from the confirmation email. Activation is gated on `status='pending'`
// ONLY — this is the security boundary, not deletion of the token:
//   • pending      → flip to active + stamp confirmedAt (the happy path).
//   • active       → idempotent success (a re-click or an email-client/security
//                    scanner prefetch still lands on the success page).
//   • unsubscribed / bounced → treated as expired. A STALE confirmation email
//     (sent before the subscriber later unsubscribed) must NOT silently undo the
//     unsubscribe. They must subscribe again to mint a fresh token.
// An unknown/missing token lands on the "link no longer valid" state. We keep
// the confirm_token on the row so legitimate double-clicks resolve gracefully;
// it is inert once the row is non-pending because of the gate above.
router.get("/newsletter/confirm", async (req: Request, res: Response) => {
  try {
    const token = String(req.query.token ?? "").trim();
    if (!token) {
      return res.redirect(302, "/newsletter/subscribed?expired=1");
    }
    const rows = await db
      .select()
      .from(newsletterSubscribersTable)
      .where(eq(newsletterSubscribersTable.confirmToken, token))
      .limit(1);
    const sub = rows[0];
    if (!sub) {
      return res.redirect(302, "/newsletter/subscribed?expired=1");
    }
    if (sub.status === "active") {
      return res.redirect(302, "/newsletter/subscribed?confirmed=1");
    }
    if (sub.status !== "pending") {
      // unsubscribed / bounced — a stale link can't reactivate.
      return res.redirect(302, "/newsletter/subscribed?expired=1");
    }
    await db
      .update(newsletterSubscribersTable)
      .set({
        status: "active",
        confirmedAt: sub.confirmedAt ?? new Date(),
        unsubscribedAt: null,
      })
      .where(eq(newsletterSubscribersTable.id, sub.id));
    // Now that they've confirmed (double opt-in), this is the brand-new
    // active moment — send the one-time welcome, branded for the publication
    // they actually subscribed to (house keeps its original look; a faculty
    // newsletter carries its own masthead/accent/from-address and names the
    // steward). Fire-and-forget so the confirm redirect never blocks on or
    // fails because of email delivery; no-ops with a warn when Resend is
    // unconfigured.
    const welcomePub = sub.publicationId
      ? (
          await db
            .select({
              isHouse: newsletterPublicationsTable.isHouse,
              name: newsletterPublicationsTable.name,
              accentColor: newsletterPublicationsTable.accentColor,
              fromAddress: newsletterPublicationsTable.fromAddress,
              bylineName: newsletterPublicationsTable.bylineName,
            })
            .from(newsletterPublicationsTable)
            .where(eq(newsletterPublicationsTable.id, sub.publicationId))
            .limit(1)
        )[0]
      : null;
    if (sub.source === "karen-parker-pillar") {
      void sendKarenPillarWelcomeEmail({
        to: sub.email,
        name: sub.name,
        unsubscribeUrl: unsubscribeUrlFor(sub.unsubscribeToken),
      }).catch((err) => {
        req.log.error({ err }, "karen pillar welcome email failed");
      });
    } else {
      void sendWelcomeEmail({
        to: sub.email,
        name: sub.name,
        unsubscribeUrl: unsubscribeUrlFor(sub.unsubscribeToken),
        branding: brandingForPublication(welcomePub),
        stewardName: welcomePub?.bylineName ?? null,
      }).catch((err) => {
        req.log.error({ err }, "welcome email failed");
      });
    }
    return res.redirect(302, "/newsletter/subscribed?confirmed=1");
  } catch (e) {
    req.log.error({ err: e }, "newsletter confirm failed");
    return res.redirect(302, "/newsletter/subscribed?expired=1");
  }
});

// ── Public: list publications for the storefront ─────────────────────────────
// Surfaces the house SLM newsletter + each faculty/pillar publication so the
// subscribe storefront can present them as their own subscriptions and link to
// the existing public publication pages (/p/:slug) where the signup flow lives.
// Only the house plus publications that have at least one SENT issue are
// returned, so empty/test publications never appear on the storefront.

router.get(
  "/newsletter/publications",
  async (req: Request, res: Response) => {
    try {
      await ensureHousePublication();
      const result = await db.execute(sql`
        SELECT p.slug, p.name, p.tagline, p.is_house AS "isHouse"
        FROM newsletter_publications p
        WHERE p.is_house = true
           OR EXISTS (
             SELECT 1 FROM newsletter_issues i
             WHERE i.publication_id = p.id AND i.status = 'sent'
           )
        ORDER BY p.is_house DESC, p.name ASC
      `);
      const rows = result.rows as Array<{
        slug: string;
        name: string;
        tagline: string | null;
        isHouse: boolean;
      }>;
      return res.json({ publications: rows });
    } catch (err) {
      req.log.error({ err }, "Failed to list publications for storefront");
      // Degrade gracefully — the storefront simply omits the newsletter row.
      return res.json({ publications: [] });
    }
  },
);

// ── Public: per-publication signup (faculty-owned newsletters) ───────────────
// A faculty member's newsletter has its own public signup surface, addressed by
// the publication slug. These are anonymous (no auth) like /newsletter/subscribe
// but scoped to the named publication rather than the house.

router.get(
  "/newsletter/p/:slug",
  async (req: Request, res: Response) => {
    try {
      const slug = String(req.params.slug ?? "").trim().toLowerCase();
      const pub = (
        await db
          .select({
            id: newsletterPublicationsTable.id,
            name: newsletterPublicationsTable.name,
            slug: newsletterPublicationsTable.slug,
            tagline: newsletterPublicationsTable.tagline,
            description: newsletterPublicationsTable.description,
            bylineName: newsletterPublicationsTable.bylineName,
            bylineInstitution: newsletterPublicationsTable.bylineInstitution,
            accentColor: newsletterPublicationsTable.accentColor,
            isHouse: newsletterPublicationsTable.isHouse,
          })
          .from(newsletterPublicationsTable)
          .where(eq(newsletterPublicationsTable.slug, slug))
          .limit(1)
      )[0];
      if (!pub) {
        return res.status(404).json({ error: "Publication not found" });
      }
      return res.json({ publication: pub });
    } catch (e) {
      req.log.error({ err: e }, "load publication failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

router.post(
  "/newsletter/p/:slug/subscribe",
  async (req: Request, res: Response) => {
    try {
      const slug = String(req.params.slug ?? "").trim().toLowerCase();
      const { email, name, source, referralSource } = req.body as {
        email?: string;
        name?: string;
        source?: string;
        referralSource?: string;
      };
      const emailClean = String(email ?? "").trim().toLowerCase();
      if (!emailClean || !isEmail(emailClean)) {
        return res.status(400).json({ error: "A valid email is required" });
      }
      const pub = (
        await db
          .select({
            id: newsletterPublicationsTable.id,
            isHouse: newsletterPublicationsTable.isHouse,
            name: newsletterPublicationsTable.name,
            accentColor: newsletterPublicationsTable.accentColor,
            fromAddress: newsletterPublicationsTable.fromAddress,
          })
          .from(newsletterPublicationsTable)
          .where(eq(newsletterPublicationsTable.slug, slug))
          .limit(1)
      )[0];
      if (!pub) {
        return res.status(404).json({ error: "Publication not found" });
      }
      const nameClean = name ? String(name).trim().slice(0, 200) : null;
      const sourceClean = source ? String(source).trim().slice(0, 80) : "web";
      const referralSourceClean = referralSource ? String(referralSource).trim().slice(0, 200) : null;
      const branding = brandingForPublication(pub);

      const existing = await db
        .select()
        .from(newsletterSubscribersTable)
        .where(
          and(
            eq(newsletterSubscribersTable.publicationId, pub.id),
            eq(newsletterSubscribersTable.email, emailClean),
          ),
        )
        .limit(1);
      if (existing[0]) {
        if (existing[0].status === "active") {
          return res.json({ ok: true, alreadySubscribed: true });
        }
        // Pending or previously unsubscribed: (re)issue confirmation (double
        // opt-in). Stays/returns to pending until they click the link.
        const confirmToken = randomBytes(24).toString("hex");
        await db
          .update(newsletterSubscribersTable)
          .set({
            status: "pending",
            confirmToken,
            confirmedAt: null,
            unsubscribedAt: null,
            name: nameClean ?? existing[0].name,
            referralSource: referralSourceClean ?? existing[0].referralSource,
          })
          .where(eq(newsletterSubscribersTable.id, existing[0].id));
        await sendSubscriberConfirmationEmail({
          to: emailClean,
          name: nameClean ?? existing[0].name,
          confirmUrl: confirmUrlFor(confirmToken),
          branding,
        });
        return res.json({ ok: true, pending: true });
      }
      const confirmToken = randomBytes(24).toString("hex");
      await db.insert(newsletterSubscribersTable).values({
        publicationId: pub.id,
        email: emailClean,
        name: nameClean,
        source: sourceClean,
        referralSource: referralSourceClean,
        status: "pending",
        unsubscribeToken: randomBytes(24).toString("hex"),
        confirmToken,
        confirmedAt: null,
      });
      await sendSubscriberConfirmationEmail({
        to: emailClean,
        name: nameClean,
        confirmUrl: confirmUrlFor(confirmToken),
        branding,
      });
      return res.json({ ok: true, pending: true });
    } catch (e) {
      req.log.error({ err: e }, "publication subscribe failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

// ── Public: read sent issues for a publication ───────────────────────────────
// Anonymous, publication-scoped reading surface that backs the public
// publication home (/p/:slug) and per-issue reading pages. Only `sent` issues
// for the resolved publication are ever exposed — drafts and other
// publications' issues are never reachable. Returns structured data for native
// React rendering (not raw email HTML).

const publicPubSelect = {
  id: newsletterPublicationsTable.id,
  name: newsletterPublicationsTable.name,
  slug: newsletterPublicationsTable.slug,
  tagline: newsletterPublicationsTable.tagline,
  description: newsletterPublicationsTable.description,
  bylineName: newsletterPublicationsTable.bylineName,
  bylineInstitution: newsletterPublicationsTable.bylineInstitution,
  accentColor: newsletterPublicationsTable.accentColor,
  isHouse: newsletterPublicationsTable.isHouse,
  topic: newsletterPublicationsTable.topic,
  landingContent: newsletterPublicationsTable.landingContent,
  heroImagePath: newsletterPublicationsTable.heroImagePath,
} as const;

/**
 * Resolve an object-storage path to a relative URL the browser can fetch
 * through the shared proxy. Passes through absolute http(s) URLs, maps
 * `/objects/...` paths to `/api/storage/objects/...`, else null.
 */
function publicImageUrl(objectPath: string | null): string | null {
  if (!objectPath) return null;
  if (/^https?:\/\//i.test(objectPath)) return objectPath;
  if (objectPath.startsWith("/objects/")) {
    return `/api/storage${objectPath}`;
  }
  return null;
}

/**
 * Steward-tailored metadata surfaced on a faculty publication's public pages
 * (the /p/:slug author-landing page). All fields are joined read-only from data
 * that already exists; there are no new editable fields. Every field is nullable
 * and returns null when absent so the page can omit empty sections cleanly.
 *
 * This page already publicly shows the steward's name/byline by design, so
 * surfacing their photo, bio and topic here is intentional — distinct from the
 * "public pillar landing must be steward-free" rule for anonymous pillar
 * browsing.
 */
interface StewardMeta {
  /** Resolved (proxy-served) URL of the steward's headshot, or null. */
  photoUrl: string | null;
  /** Short steward bio from their voice profile's tone summary, or null. */
  bio: string | null;
  /** Topic description from the steward's primary stewarded pillar, or null. */
  topicDescription: string | null;
  /** Steward's full display name, or null. */
  stewardFullName: string | null;
  /** Steward's institution/affiliation, or null. */
  stewardInstitution: string | null;
  /** Steward-written achievements (awards, findings, highlights), in order. */
  achievements: string[];
}

const EMPTY_STEWARD_META: StewardMeta = {
  photoUrl: null,
  bio: null,
  topicDescription: null,
  stewardFullName: null,
  stewardInstitution: null,
  achievements: [],
};

async function loadStewardMeta(
  facultyUserId: number | null,
): Promise<StewardMeta> {
  if (!facultyUserId) return EMPTY_STEWARD_META;
  const [user, voice, pillar] = await Promise.all([
    db
      .select({
        photoUrl: facultyUsersTable.photoUrl,
        fullName: facultyUsersTable.fullName,
        institution: facultyUsersTable.institution,
        achievements: facultyUsersTable.achievements,
      })
      .from(facultyUsersTable)
      .where(eq(facultyUsersTable.id, facultyUserId))
      .limit(1),
    db
      .select({ toneSummary: facultyVoiceProfilesTable.toneSummary })
      .from(facultyVoiceProfilesTable)
      .where(eq(facultyVoiceProfilesTable.facultyUserId, facultyUserId))
      .limit(1),
    // Deterministic primary pillar: the steward's `steward`-role, non-retired
    // pillar with the lowest id. Choosing the lowest id keeps the public topic
    // blurb stable even when a steward stewards several pillars.
    db
      .select({ description: pillarsTable.description })
      .from(facultyMembershipsTable)
      .innerJoin(
        pillarsTable,
        eq(facultyMembershipsTable.pillarId, pillarsTable.id),
      )
      .where(
        and(
          eq(facultyMembershipsTable.userId, facultyUserId),
          eq(facultyMembershipsTable.role, "steward"),
          isNull(pillarsTable.retiredAt),
        ),
      )
      .orderBy(asc(pillarsTable.id))
      .limit(1),
  ]);
  const tone = voice[0]?.toneSummary?.trim();
  const topic = pillar[0]?.description?.trim();
  return {
    photoUrl: publicImageUrl(user[0]?.photoUrl ?? null),
    bio: tone ? tone : null,
    topicDescription: topic ? topic : null,
    stewardFullName: user[0]?.fullName?.trim() || null,
    stewardInstitution: user[0]?.institution?.trim() || null,
    achievements: Array.isArray(user[0]?.achievements)
      ? user[0]!.achievements.filter((a) => typeof a === "string" && a.trim())
      : [],
  };
}

const publicIssueParamsSchema = z.object({
  slug: z.string().trim().min(1).max(80),
  id: z.coerce.number().int().positive(),
});

router.get(
  "/newsletter/p/:slug/issues",
  async (req: Request, res: Response) => {
    try {
      const slug = String(req.params.slug ?? "").trim().toLowerCase();
      // The house SLM newsletter now resolves through this public surface so it
      // has a science-home render target at its slug. Its separate gated
      // /newsletter experience (premium teaser etc.) is untouched. The house
      // row is created lazily (on first subscribe), so materialize it here when
      // its slug is requested directly — otherwise a fresh DB would 404.
      if (slug === HOUSE_SLUG) {
        await ensureHousePublication();
      }
      const pubRow = (
        await db
          .select({
            ...publicPubSelect,
            facultyUserId: newsletterPublicationsTable.facultyUserId,
          })
          .from(newsletterPublicationsTable)
          .where(eq(newsletterPublicationsTable.slug, slug))
          .limit(1)
      )[0];
      if (!pubRow) {
        return res.status(404).json({ error: "Publication not found" });
      }
      const { facultyUserId, landingContent, heroImagePath, ...pub } = pubRow;
      const [steward, ask] = await Promise.all([
        loadStewardMeta(facultyUserId),
        loadStewardAskEligibility(facultyUserId),
      ]);
      const { landing, heroImageUrl } = resolveLandingForPublic(
        landingContent,
        heroImagePath,
        publicImageUrl,
      );
      // Paid steward Q&A: when the ask panel is live, ship the $9/mo plan
      // (price via lookup key so checkout works in any Stripe mode) plus
      // whether the CALLER is already a subscriber, so the client can render
      // "unlimited" vs the free-allowance state without a second request.
      // Best-effort: absent Stripe → plan null, subscribed false.
      let askPlan: {
        lookupKey: string;
        unitAmount: number | null;
        currency: string;
        interval: string;
        subscribed: boolean;
      } | null = null;
      if (ask.eligible && !pub.isHouse) {
        try {
          const [plan, account] = await Promise.all([
            getStewardPlan(pub.id),
            getConsumerFromRequest(req),
          ]);
          const subscribed = account
            ? await hasStewardAccess(account.stripeCustomerId, pub.id)
            : false;
          askPlan = {
            lookupKey: plan?.lookupKey ?? stewardLookupKey(pub.id),
            unitAmount: plan?.unitAmount ?? null,
            currency: plan?.currency ?? "usd",
            interval: plan?.interval ?? "month",
            subscribed,
          };
        } catch (err) {
          req.log.warn({ err }, "steward ask plan lookup failed");
        }
      }
      // Governed, read-only science for the resolved pillar(s): a faculty
      // publication surfaces its owner's primary stewarded pillar; the house
      // publication aggregates across all non-retired pillars. Degrades to an
      // empty list (page omits the science sections) on any failure.
      const science = await loadPillarScience(
        await resolvePublicationPillarIds(facultyUserId, pub.isHouse),
      ).catch((err) => {
        req.log.error({ err }, "load pillar science failed");
        return { pillars: [], items: [] };
      });
      const issues = await db
        .select({
          id: newsletterIssuesTable.id,
          title: newsletterIssuesTable.title,
          previewText: newsletterIssuesTable.previewText,
          heroImagePath: newsletterIssuesTable.heroImagePath,
          sentAt: newsletterIssuesTable.sentAt,
        })
        .from(newsletterIssuesTable)
        .where(
          and(
            eq(newsletterIssuesTable.publicationId, pub.id),
            eq(newsletterIssuesTable.status, "sent"),
            // The house newsletter keeps its premium issues gated to the paid
            // /newsletter flow — only non-premium sent issues appear on the
            // public science-home archive so a leaked /p link can't bypass the
            // paywall. Faculty publications are unaffected.
            ...(pub.isHouse
              ? [eq(newsletterIssuesTable.premium, false)]
              : []),
          ),
        )
        .orderBy(
          desc(newsletterIssuesTable.sentAt),
          desc(newsletterIssuesTable.id),
        );
      return res.json({
        publication: { ...pub, ...steward, ask, askPlan, landing, heroImageUrl },
        issues: issues.map((i) => ({
          id: i.id,
          title: i.title,
          previewText: i.previewText,
          heroImageUrl: publicImageUrl(i.heroImagePath),
          sentAt: i.sentAt,
        })),
        // Governed, read-only pillar science for the "science home" sections.
        science: science.items,
        sciencePillars: science.pillars,
        // Lightweight machine-readable discovery hook: an AI agent landing on
        // the publication can find its name, topic/pillar, and the anonymous,
        // idempotent, CORS-open subscribe call without scraping the page.
        discovery: {
          type: "palonur.publication",
          name: pub.name,
          slug: pub.slug,
          isHouse: pub.isHouse,
          pillars: science.pillars.map((p) => p.slug),
          subscribe: {
            method: "POST",
            url: `/api/newsletter/p/${pub.slug}/subscribe`,
            body: { email: "string", name: "string?", source: "string?" },
            idempotent: true,
            auth: "none",
          },
        },
      });
    } catch (e) {
      req.log.error({ err: e }, "list public publication issues failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

router.get(
  "/newsletter/p/:slug/issues/:id",
  async (req: Request, res: Response) => {
    const parsed = publicIssueParamsSchema.safeParse({
      slug: req.params.slug,
      id: req.params.id,
    });
    if (!parsed.success) {
      return res.status(404).json({ error: "Issue not found" });
    }
    try {
      const slug = parsed.data.slug.toLowerCase();
      // The house SLM newsletter now resolves here too (see list route), but its
      // PREMIUM issues stay gated to the paid /newsletter flow — non-premium
      // house issues are readable, premium ones 404 from this public surface.
      // Materialize the lazily-created house row so a fresh DB doesn't 404.
      if (slug === HOUSE_SLUG) {
        await ensureHousePublication();
      }
      const pubRow = (
        await db
          .select({
            ...publicPubSelect,
            facultyUserId: newsletterPublicationsTable.facultyUserId,
          })
          .from(newsletterPublicationsTable)
          .where(eq(newsletterPublicationsTable.slug, slug))
          .limit(1)
      )[0];
      if (!pubRow) {
        return res.status(404).json({ error: "Publication not found" });
      }
      const { facultyUserId, ...pub } = pubRow;
      const [steward, ask] = await Promise.all([
        loadStewardMeta(facultyUserId),
        loadStewardAskEligibility(facultyUserId),
      ]);
      const issue = (
        await db
          .select({
            id: newsletterIssuesTable.id,
            title: newsletterIssuesTable.title,
            previewText: newsletterIssuesTable.previewText,
            introHtml: newsletterIssuesTable.introHtml,
            heroImagePath: newsletterIssuesTable.heroImagePath,
            sentAt: newsletterIssuesTable.sentAt,
          })
          .from(newsletterIssuesTable)
          .where(
            and(
              eq(newsletterIssuesTable.id, parsed.data.id),
              eq(newsletterIssuesTable.publicationId, pub.id),
              eq(newsletterIssuesTable.status, "sent"),
              ...(pub.isHouse
                ? [eq(newsletterIssuesTable.premium, false)]
                : []),
            ),
          )
          .limit(1)
      )[0];
      if (!issue) {
        return res.status(404).json({ error: "Issue not found" });
      }
      const posts = await db
        .select()
        .from(newsletterPostsTable)
        .where(eq(newsletterPostsTable.issueId, issue.id))
        .orderBy(
          asc(newsletterPostsTable.position),
          asc(newsletterPostsTable.id),
        );
      return res.json({
        publication: { ...pub, ...steward, ask },
        issue: {
          id: issue.id,
          title: issue.title,
          previewText: issue.previewText,
          introHtml: sanitizeNewsletterHtml(issue.introHtml),
          heroImageUrl: publicImageUrl(issue.heroImagePath),
          sentAt: issue.sentAt,
        },
        posts: posts.map((p) => ({
          id: p.id,
          kind: p.kind,
          title: p.title,
          authorName: p.authorName,
          authorInstitution: p.authorInstitution,
          bodyHtml: sanitizeNewsletterHtml(p.bodyHtml),
          pullQuote: p.pullQuote,
          imageUrl: publicImageUrl(p.imagePath),
        })),
      });
    } catch (e) {
      req.log.error({ err: e }, "load public publication issue failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

// ── Editor: subscribers ──────────────────────────────────────────────────────

router.get(
  "/newsletter/subscribers",
  requireEditorOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const house = await ensureHousePublication();
      const rows = await db
        .select()
        .from(newsletterSubscribersTable)
        .where(eq(newsletterSubscribersTable.publicationId, house.id))
        .orderBy(desc(newsletterSubscribersTable.createdAt));
      const active = rows.filter((r) => r.status === "active").length;

      // Derive paid vs free from Stripe (read-time, never stored). MRR comes
      // from the same synced tables. Both degrade to empty/zero when Stripe
      // isn't connected, so the list still loads as free-only.
      const paidCustomerIds = await getPaidNewsletterCustomerIds();
      const revenue = await getNewsletterRevenue();
      const activeRows = rows.filter((r) => r.status === "active");
      const paid = activeRows.filter(
        (r) => r.stripeCustomerId && paidCustomerIds.has(r.stripeCustomerId),
      ).length;

      return res.json({
        subscribers: rows.map((r) => ({
          ...r,
          paid: Boolean(
            r.stripeCustomerId && paidCustomerIds.has(r.stripeCustomerId),
          ),
        })),
        counts: {
          total: rows.length,
          active,
          // Public subscribers who signed up but haven't clicked the
          // confirmation link yet (double opt-in). Never sent newsletters.
          pending: rows.filter((r) => r.status === "pending").length,
          unsubscribed: rows.filter((r) => r.status === "unsubscribed").length,
          paid,
          free: active - paid,
        },
        revenue: { mrrCents: revenue.mrrCents, currency: revenue.currency },
      });
    } catch (e) {
      req.log.error({ err: e }, "list subscribers failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

router.post(
  "/newsletter/subscribers",
  requireEditorOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const { email, name } = req.body as { email?: string; name?: string };
      const emailClean = String(email ?? "").trim().toLowerCase();
      if (!emailClean || !isEmail(emailClean)) {
        return res.status(400).json({ error: "A valid email is required" });
      }
      const house = await ensureHousePublication();
      const existing = await db
        .select()
        .from(newsletterSubscribersTable)
        .where(
          and(
            eq(newsletterSubscribersTable.publicationId, house.id),
            eq(newsletterSubscribersTable.email, emailClean),
          ),
        )
        .limit(1);
      if (existing[0]) {
        // Editor-added = trusted, so this is a real confirmation: stamp
        // confirmedAt and clear any pending confirm_token so a stale double
        // opt-in link can't later re-open the lifecycle on this row.
        await db
          .update(newsletterSubscribersTable)
          .set({
            status: "active",
            unsubscribedAt: null,
            confirmedAt: existing[0].confirmedAt ?? new Date(),
            confirmToken: null,
          })
          .where(eq(newsletterSubscribersTable.id, existing[0].id));
        return res.json({ ok: true, alreadyExists: true });
      }
      const [row] = await db
        .insert(newsletterSubscribersTable)
        .values({
          publicationId: house.id,
          email: emailClean,
          name: name ? String(name).trim().slice(0, 200) : null,
          source: "manual",
          unsubscribeToken: randomBytes(24).toString("hex"),
          confirmedAt: new Date(),
        })
        .returning();
      return res.json({ ok: true, subscriber: row });
    } catch (e) {
      req.log.error({ err: e }, "add subscriber failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

router.delete(
  "/newsletter/subscribers/:id",
  requireEditorOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Bad id" });
      const house = await ensureHousePublication();
      await db
        .delete(newsletterSubscribersTable)
        .where(
          and(
            eq(newsletterSubscribersTable.id, id),
            eq(newsletterSubscribersTable.publicationId, house.id),
          ),
        );
      return res.json({ ok: true });
    } catch (e) {
      req.log.error({ err: e }, "delete subscriber failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

// ── Editor: source-story pool (pull from /share submissions) ─────────────────

router.get(
  "/newsletter/source-stories",
  requireEditorOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const rows = await db
        .select({
          id: storiesTable.id,
          status: storiesTable.status,
          firstName: storiesTable.firstName,
          anonymous: storiesTable.anonymous,
          goal: storiesTable.goal,
          hook: storiesTable.hook,
          struggle: storiesTable.struggle,
          enablement: storiesTable.enablement,
          draftHtml: storiesTable.draftHtml,
          pullQuote: storiesTable.pullQuote,
          submittedAt: storiesTable.submittedAt,
        })
        .from(storiesTable)
        .where(inArray(storiesTable.status, ["new", "in_edit", "approved"]))
        .orderBy(desc(storiesTable.submittedAt));
      return res.json({ stories: rows });
    } catch (e) {
      req.log.error({ err: e }, "source-stories failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

// ── Editor: issues ───────────────────────────────────────────────────────────

router.get(
  "/newsletter/issues",
  requireEditorOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const house = await ensureHousePublication();
      const issues = await db
        .select()
        .from(newsletterIssuesTable)
        .where(eq(newsletterIssuesTable.publicationId, house.id))
        .orderBy(desc(newsletterIssuesTable.createdAt));
      const counts = await db
        .select({
          issueId: newsletterPostsTable.issueId,
          n: sql<number>`count(*)::int`,
        })
        .from(newsletterPostsTable)
        .groupBy(newsletterPostsTable.issueId);
      const byIssue = new Map(counts.map((c) => [c.issueId, c.n]));
      return res.json({
        issues: issues.map((i) => ({ ...i, postCount: byIssue.get(i.id) ?? 0 })),
      });
    } catch (e) {
      req.log.error({ err: e }, "list issues failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

router.post(
  "/newsletter/issues",
  requireEditorOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const { title } = req.body as { title?: string };
      const t = String(title ?? "").trim() || "Untitled issue";
      const house = await ensureHousePublication();
      const [row] = await db
        .insert(newsletterIssuesTable)
        .values({
          publicationId: house.id,
          title: t,
          createdBy: (req as any).editorIdentity ?? null,
        })
        .returning();
      return res.json({ issue: row });
    } catch (e) {
      req.log.error({ err: e }, "create issue failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

router.get(
  "/newsletter/issues/:id",
  requireEditorOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const house = await ensureHousePublication();
      const rows = await db
        .select()
        .from(newsletterIssuesTable)
        .where(
          and(
            eq(newsletterIssuesTable.id, id),
            eq(newsletterIssuesTable.publicationId, house.id),
          ),
        )
        .limit(1);
      if (!rows[0]) return res.status(404).json({ error: "Not found" });
      const posts = await db
        .select()
        .from(newsletterPostsTable)
        .where(eq(newsletterPostsTable.issueId, id))
        .orderBy(asc(newsletterPostsTable.position), asc(newsletterPostsTable.id));
      const activeRows = await db
        .select()
        .from(newsletterSubscribersTable)
        .where(
          and(
            eq(newsletterSubscribersTable.publicationId, house.id),
            eq(newsletterSubscribersTable.status, "active"),
          ),
        );
      const activeSubs = activeRows.length;
      // Paid split (for premium issues: paid → full, free → teaser).
      const paidCustomerIds = await getPaidNewsletterCustomerIds();
      const paidSubscribers = activeRows.filter(
        (r) => r.stripeCustomerId && paidCustomerIds.has(r.stripeCustomerId),
      ).length;
      return res.json({
        issue: rows[0],
        posts,
        activeSubscribers: activeSubs,
        paidSubscribers,
        freeSubscribers: activeSubs - paidSubscribers,
      });
    } catch (e) {
      req.log.error({ err: e }, "get issue failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

router.patch(
  "/newsletter/issues/:id",
  requireEditorOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const body = req.body as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      for (const k of [
        "title",
        "subjectLine",
        "previewText",
        "introHtml",
        "heroImagePath",
        "status",
        "premium",
      ] as const) {
        if (k in body) patch[k] = body[k];
      }
      if ("premium" in patch) patch.premium = Boolean(patch.premium);
      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: "Nothing to update" });
      }
      const house = await ensureHousePublication();
      const [row] = await db
        .update(newsletterIssuesTable)
        .set(patch)
        .where(
          and(
            eq(newsletterIssuesTable.id, id),
            eq(newsletterIssuesTable.publicationId, house.id),
          ),
        )
        .returning();
      if (!row) return res.status(404).json({ error: "Not found" });
      return res.json({ issue: row });
    } catch (e) {
      req.log.error({ err: e }, "patch issue failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

router.delete(
  "/newsletter/issues/:id",
  requireEditorOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const house = await ensureHousePublication();
      await db
        .delete(newsletterIssuesTable)
        .where(
          and(
            eq(newsletterIssuesTable.id, id),
            eq(newsletterIssuesTable.publicationId, house.id),
          ),
        );
      return res.json({ ok: true });
    } catch (e) {
      req.log.error({ err: e }, "delete issue failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

// ── Editor: posts ────────────────────────────────────────────────────────────

router.post(
  "/newsletter/issues/:id/posts",
  requireEditorOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const issueId = parseInt(String(req.params.id), 10);
      const issue = await db
        .select()
        .from(newsletterIssuesTable)
        .where(eq(newsletterIssuesTable.id, issueId))
        .limit(1);
      if (!issue[0]) return res.status(404).json({ error: "Issue not found" });
      const body = req.body as {
        kind?: "article" | "story";
        title?: string;
        authorName?: string;
        authorInstitution?: string;
        sourceId?: number;
        storyId?: number;
        sourceMaterial?: string;
      };
      const kind = body.kind === "story" ? "story" : "article";

      // If created from an existing /share story, seed fields from it
      let seed: {
        title?: string | null;
        bodyHtml?: string | null;
        pullQuote?: string | null;
        sourceMaterial?: string | null;
      } = {};
      if (body.storyId) {
        const s = (
          await db
            .select()
            .from(storiesTable)
            .where(eq(storiesTable.id, body.storyId))
            .limit(1)
        )[0];
        if (s) {
          seed = {
            bodyHtml: s.draftHtml,
            pullQuote: s.pullQuote,
            sourceMaterial: [s.goal, s.hook, s.struggle, s.enablement]
              .filter(Boolean)
              .join("\n\n"),
          };
        }
      }

      const [{ maxPos }] = await db
        .select({
          maxPos: sql<number>`coalesce(max(${newsletterPostsTable.position}), -1)::int`,
        })
        .from(newsletterPostsTable)
        .where(eq(newsletterPostsTable.issueId, issueId));

      const [row] = await db
        .insert(newsletterPostsTable)
        .values({
          issueId,
          kind,
          position: (maxPos ?? -1) + 1,
          title: body.title ?? seed.title ?? null,
          authorName: body.authorName ?? null,
          authorInstitution: body.authorInstitution ?? null,
          sourceId: body.sourceId ?? null,
          storyId: body.storyId ?? null,
          sourceMaterial: body.sourceMaterial ?? seed.sourceMaterial ?? null,
          bodyHtml: seed.bodyHtml ?? null,
          pullQuote: seed.pullQuote ?? null,
        })
        .returning();
      return res.json({ post: row });
    } catch (e) {
      req.log.error({ err: e }, "create post failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

router.patch(
  "/newsletter/posts/:postId",
  requireEditorOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.postId), 10);
      const body = req.body as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      for (const k of [
        "title",
        "authorName",
        "authorInstitution",
        "sourceId",
        "bodyHtml",
        "pullQuote",
        "sourceMaterial",
        "position",
        "imagePath",
      ] as const) {
        if (k in body) patch[k] = body[k];
      }
      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: "Nothing to update" });
      }
      const [row] = await db
        .update(newsletterPostsTable)
        .set(patch)
        .where(eq(newsletterPostsTable.id, id))
        .returning();
      if (!row) return res.status(404).json({ error: "Not found" });
      return res.json({ post: row });
    } catch (e) {
      req.log.error({ err: e }, "patch post failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

router.delete(
  "/newsletter/posts/:postId",
  requireEditorOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.postId), 10);
      await db
        .delete(newsletterPostsTable)
        .where(eq(newsletterPostsTable.id, id));
      return res.json({ ok: true });
    } catch (e) {
      req.log.error({ err: e }, "delete post failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

// ── Editor: AI generate a post body (anonymized for stories) ─────────────────

router.post(
  "/newsletter/posts/:postId/generate",
  requireEditorOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.postId), 10);
      const rows = await db
        .select()
        .from(newsletterPostsTable)
        .where(eq(newsletterPostsTable.id, id))
        .limit(1);
      const post = rows[0];
      if (!post) return res.status(404).json({ error: "Not found" });
      const { rawText, instructions } = req.body as {
        rawText?: string;
        instructions?: string;
      };
      const material =
        (rawText && String(rawText).trim()) || post.sourceMaterial || "";
      if (!material.trim()) {
        return res
          .status(400)
          .json({ error: "Add source material (paste notes or pick a story) first" });
      }

      const prompt =
        post.kind === "story"
          ? `You are writing a short, warm feature for the Stanford Lifestyle Medicine newsletter, based on a real reader/patient's experience.

CRITICAL ANONYMIZATION RULES:
- Do NOT include the person's real name. Refer to them generically (e.g. "one reader", "a member of our community", "she", "he", "they").
- Remove or generalize any identifying detail: employer, exact city/neighborhood, age combined with rare specifics, unique job titles, names of family members, named clinics or doctors.
- Keep the emotional truth and the practical lesson; lose the identity.

Source material (raw, may contain names — strip them):
${material}

${instructions ? `Editor's guidance: ${instructions}\n\n` : ""}Write a 150-220 word piece in three or four short paragraphs, third person, warm and human. Plain prose, no headings, no markdown. End with a single italic pull-quote sentence wrapped in <em>...</em>. Output HTML using only <p> and <em> tags.`
          : `You are writing a short newsletter item for the Stanford Lifestyle Medicine newsletter, summarizing an article/finding for a general audience.

${post.authorName ? `Author / expert: ${post.authorName}\n` : ""}Source material:
${material}

${instructions ? `Editor's guidance: ${instructions}\n\n` : ""}Write a 150-220 word piece in three or four short paragraphs, clear and engaging for non-experts, accurate to the source. Plain prose, no headings, no markdown. End with a single italic takeaway sentence wrapped in <em>...</em>. Output HTML using only <p> and <em> tags.`;

      let html = "";
      try {
        const msg = await anthropic.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 900,
          messages: [{ role: "user", content: prompt }],
        });
        const part = msg.content.find((p: any) => p.type === "text") as
          | { text?: string }
          | undefined;
        html = (part?.text ?? "").trim();
      } catch (e) {
        req.log.error({ err: e }, "newsletter post generation failed");
        return res.status(502).json({ error: "AI generation failed" });
      }

      // Extract a pull-quote from the trailing <em>...</em> if present
      let pullQuote = post.pullQuote;
      const m = html.match(/<em>([\s\S]*?)<\/em>\s*(?:<\/p>\s*)?$/i);
      if (m) pullQuote = m[1].trim();

      const [updated] = await db
        .update(newsletterPostsTable)
        .set({ bodyHtml: html, pullQuote, sourceMaterial: material })
        .where(eq(newsletterPostsTable.id, id))
        .returning();
      return res.json({ post: updated });
    } catch (e) {
      req.log.error({ err: e }, "generate post failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

// ── Editor: AI image generation (gpt-image-1 → object storage) ───────────────

router.post(
  "/newsletter/posts/:postId/image",
  requireEditorOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.postId), 10);
      const rows = await db
        .select()
        .from(newsletterPostsTable)
        .where(eq(newsletterPostsTable.id, id))
        .limit(1);
      const post = rows[0];
      if (!post) return res.status(404).json({ error: "Not found" });
      const { prompt } = req.body as { prompt?: string };
      const p = String(prompt ?? "").trim();
      if (!p) return res.status(400).json({ error: "An image prompt is required" });

      const openai = getOpenAI();
      if (!openai) {
        return res
          .status(503)
          .json({ error: "Image generation is not configured" });
      }

      let b64: string | undefined;
      try {
        const result = await openai.images.generate({
          model: "gpt-image-1",
          prompt: `Editorial illustration for a wellness newsletter. ${p}. Calm, warm, tasteful, no text, no watermark.`,
          size: "1536x1024",
        });
        b64 = result.data?.[0]?.b64_json;
      } catch (e) {
        req.log.error({ err: e }, "image generation failed");
        return res.status(502).json({ error: "Image generation failed" });
      }
      if (!b64) return res.status(502).json({ error: "No image returned" });

      // Store to object storage via presigned PUT
      const buffer = Buffer.from(b64, "base64");
      const { ObjectStorageService } = await import("../lib/objectStorage");
      const svc = new ObjectStorageService();
      const uploadURL = await svc.getObjectEntityUploadURL();
      const putRes = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": "image/png" },
        body: buffer,
      });
      if (!putRes.ok) {
        req.log.error({ status: putRes.status }, "image upload PUT failed");
        return res.status(502).json({ error: "Failed to store image" });
      }
      const objectPath = svc.normalizeObjectEntityPath(uploadURL);

      const [updated] = await db
        .update(newsletterPostsTable)
        .set({ imagePath: objectPath, imagePrompt: p })
        .where(eq(newsletterPostsTable.id, id))
        .returning();
      return res.json({ post: updated });
    } catch (e) {
      req.log.error({ err: e }, "post image failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

// ── Editor: landing page (Topic → auto-generated editorial landing) ──────────
// The house publication's public /p/:slug-style landing page is auto-generated
// from a Topic, then fully editable. Mirrors the faculty-owned routes in
// facultyNewsletter.ts (same lib). All AI work degrades gracefully.

const landingGenerateSchema = z.object({
  topic: z.string().trim().min(2).max(160),
});

const landingImageSchema = z.object({
  // "hero" regenerates the hero image; a number regenerates that section index.
  target: z.union([z.literal("hero"), z.coerce.number().int().min(0).max(7)]),
  prompt: z.string().trim().min(2).max(600),
});

router.get(
  "/newsletter/publication",
  requireEditorOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const house = await ensureHousePublication();
      return res.json({ publication: house, imageGenAvailable: isImageGenAvailable() });
    } catch (e) {
      req.log.error({ err: e }, "get house publication failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

router.post(
  "/newsletter/publication/landing/generate",
  requireEditorOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const parsed = landingGenerateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "A topic is required" });
      }
      const house = await ensureHousePublication();
      const draft = await generateLandingCopy({
        topic: parsed.data.topic,
        publicationName: house.name,
        bylineName: house.bylineName,
        bylineInstitution: house.bylineInstitution,
      });
      if (!draft) {
        return res
          .status(502)
          .json({ error: "Could not generate landing copy right now. Try again." });
      }
      const { heroImagePath, content } = await generateLandingImages(draft);
      const [updated] = await db
        .update(newsletterPublicationsTable)
        .set({
          topic: parsed.data.topic,
          landingContent: content,
          heroImagePath,
          heroImagePrompt: draft.heroImagePrompt,
          landingGeneratedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(newsletterPublicationsTable.id, house.id))
        .returning();
      return res.json({ publication: updated });
    } catch (e) {
      req.log.error({ err: e }, "generate house landing failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

router.put(
  "/newsletter/publication/landing",
  requireEditorOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const body = req.body as { topic?: unknown; landingContent?: unknown };
      const parsed = landingContentEditSchema.safeParse(body.landingContent);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid landing content" });
      }
      const house = await ensureHousePublication();
      const topic =
        typeof body.topic === "string" ? body.topic.trim().slice(0, 160) : house.topic;
      const [updated] = await db
        .update(newsletterPublicationsTable)
        .set({
          topic: topic || null,
          landingContent: normalizeEditedLanding(parsed.data),
          updatedAt: new Date(),
        })
        .where(eq(newsletterPublicationsTable.id, house.id))
        .returning();
      return res.json({ publication: updated });
    } catch (e) {
      req.log.error({ err: e }, "save house landing failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

router.post(
  "/newsletter/publication/landing/image",
  requireEditorOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const parsed = landingImageSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "An image prompt is required" });
      }
      if (!isImageGenAvailable()) {
        return res.status(503).json({ error: "Image generation is not configured" });
      }
      const house = await ensureHousePublication();
      const objectPath = await generateLandingImage(parsed.data.prompt);
      if (!objectPath) {
        return res.status(502).json({ error: "Image generation failed" });
      }
      if (parsed.data.target === "hero") {
        const [updated] = await db
          .update(newsletterPublicationsTable)
          .set({
            heroImagePath: objectPath,
            heroImagePrompt: parsed.data.prompt,
            updatedAt: new Date(),
          })
          .where(eq(newsletterPublicationsTable.id, house.id))
          .returning();
        return res.json({ publication: updated });
      }
      const content = house.landingContent;
      if (!content || !content.sections?.[parsed.data.target]) {
        return res.status(400).json({ error: "Section not found" });
      }
      const sections = content.sections.map((s, i) =>
        i === parsed.data.target
          ? { ...s, imagePath: objectPath, imagePrompt: parsed.data.prompt }
          : s,
      );
      const [updated] = await db
        .update(newsletterPublicationsTable)
        .set({ landingContent: { ...content, sections }, updatedAt: new Date() })
        .where(eq(newsletterPublicationsTable.id, house.id))
        .returning();
      return res.json({ publication: updated });
    } catch (e) {
      req.log.error({ err: e }, "house landing image failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

// ── Editor: assemble HTML (preview + export) ─────────────────────────────────

async function loadIssueForRender(id: number): Promise<{
  issue: IssueForEmail;
  posts: PostForEmail[];
} | null> {
  const issueRows = await db
    .select()
    .from(newsletterIssuesTable)
    .where(eq(newsletterIssuesTable.id, id))
    .limit(1);
  if (!issueRows[0]) return null;
  const posts = await db
    .select()
    .from(newsletterPostsTable)
    .where(eq(newsletterPostsTable.issueId, id))
    .orderBy(asc(newsletterPostsTable.position), asc(newsletterPostsTable.id));
  return {
    issue: {
      id: issueRows[0].id,
      title: issueRows[0].title,
      subjectLine: issueRows[0].subjectLine,
      previewText: issueRows[0].previewText,
      introHtml: issueRows[0].introHtml,
      heroImagePath: issueRows[0].heroImagePath,
    },
    posts: posts.map((p) => ({
      id: p.id,
      kind: p.kind,
      title: p.title,
      authorName: p.authorName,
      authorInstitution: p.authorInstitution,
      bodyHtml: p.bodyHtml,
      pullQuote: p.pullQuote,
      imagePath: p.imagePath,
    })),
  };
}

router.get(
  "/newsletter/issues/:id/preview",
  requireEditorOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const data = await loadIssueForRender(id);
      if (!data) return res.status(404).json({ error: "Not found" });
      const html = buildIssueHtml({ ...data, unsubscribeUrl: null });
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(html);
    } catch (e) {
      req.log.error({ err: e }, "preview failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

router.get(
  "/newsletter/issues/:id/export.html",
  requireEditorOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const data = await loadIssueForRender(id);
      if (!data) return res.status(404).json({ error: "Not found" });
      const html = buildIssueHtml({
        ...data,
        unsubscribeUrl: "{{unsubscribe_url}}",
      });
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="newsletter-${id}.html"`,
      );
      return res.send(html);
    } catch (e) {
      req.log.error({ err: e }, "export html failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

router.get(
  "/newsletter/issues/:id/export.md",
  requireEditorOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const data = await loadIssueForRender(id);
      if (!data) return res.status(404).json({ error: "Not found" });
      const lines: string[] = [`# ${data.issue.title}`, ""];
      if (data.issue.introHtml) lines.push(htmlToText(data.issue.introHtml), "");
      for (const p of data.posts) {
        if (p.title) lines.push(`## ${p.title}`, "");
        if (p.kind === "story") lines.push("_A reader's story_", "");
        else if (p.authorName)
          lines.push(
            `_By ${p.authorName}${p.authorInstitution ? ` · ${p.authorInstitution}` : ""}_`,
            "",
          );
        if (p.pullQuote) lines.push(`> _${p.pullQuote}_`, "");
        if (p.bodyHtml) lines.push(htmlToText(p.bodyHtml), "");
      }
      lines.push("---", "", "_Palonur · Stanford Lifestyle Medicine_");
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="newsletter-${id}.md"`,
      );
      return res.send(lines.join("\n"));
    } catch (e) {
      req.log.error({ err: e }, "export md failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

// ── Editor: send test + send to all ──────────────────────────────────────────

router.post(
  "/newsletter/issues/:id/test",
  requireEditorOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const { email } = req.body as { email?: string };
      const to = String(email ?? "").trim().toLowerCase();
      if (!to || !isEmail(to)) {
        return res.status(400).json({ error: "A valid test email is required" });
      }
      const data = await loadIssueForRender(id);
      if (!data) return res.status(404).json({ error: "Not found" });
      const html = buildIssueHtml({
        ...data,
        unsubscribeUrl: unsubscribeUrlFor("test-token"),
        replyToAsk: replyLoopConfigured(),
      });
      const subject = `[TEST] ${data.issue.subjectLine || data.issue.title}`;
      const ok = await sendNewsletterEmail({
        to,
        subject,
        html,
        text: htmlToText(html),
      });
      if (!ok) {
        return res
          .status(502)
          .json({ error: "Email sending is not configured or failed" });
      }
      return res.json({ ok: true });
    } catch (e) {
      req.log.error({ err: e }, "test send failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

router.post(
  "/newsletter/issues/:id/send",
  requireEditorOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const data = await loadIssueForRender(id);
      if (!data) return res.status(404).json({ error: "Not found" });
      if (data.posts.length === 0) {
        return res.status(400).json({ error: "Add at least one post before sending" });
      }
      const issueRow = (
        await db
          .select()
          .from(newsletterIssuesTable)
          .where(eq(newsletterIssuesTable.id, id))
          .limit(1)
      )[0];
      if (issueRow?.status === "sent") {
        return res.status(409).json({ error: "This issue was already sent" });
      }

      const house = await ensureHousePublication();
      const branding = brandingForPublication(house);
      const subs = await db
        .select()
        .from(newsletterSubscribersTable)
        .where(
          and(
            eq(newsletterSubscribersTable.publicationId, house.id),
            eq(newsletterSubscribersTable.status, "active"),
          ),
        );
      if (subs.length === 0) {
        return res.status(400).json({ error: "No active subscribers" });
      }

      const subject = data.issue.subjectLine || data.issue.title;
      const premium = Boolean(issueRow?.premium);
      // For premium issues, split the audience: paid subscribers (active Stripe
      // newsletter subscription) get the full edition; everyone else gets a
      // teaser + upgrade link. Non-premium issues go full to all. Paid status is
      // derived at read time; when Stripe isn't connected the set is empty, so a
      // premium issue safely degrades to teaser-for-all.
      const paidCustomerIds = premium
        ? await getPaidNewsletterCustomerIds()
        : new Set<string>();
      const upgradeUrl = `${siteBaseUrl(req)}/newsletter?upgrade=1`;
      let sent = 0;
      let failed = 0;
      let fullSent = 0;
      let teaserSent = 0;
      for (const sub of subs) {
        const isPaid =
          !premium ||
          Boolean(sub.stripeCustomerId && paidCustomerIds.has(sub.stripeCustomerId));
        const html = isPaid
          ? buildIssueHtml({
              ...data,
              unsubscribeUrl: unsubscribeUrlFor(sub.unsubscribeToken),
              branding,
              replyToAsk: replyLoopConfigured(),
            })
          : buildTeaserHtml({
              ...data,
              unsubscribeUrl: unsubscribeUrlFor(sub.unsubscribeToken),
              upgradeUrl,
              branding,
            });
        const ok = await sendNewsletterEmail({
          to: sub.email,
          subject,
          html,
          text: htmlToText(html),
          from: branding.fromAddress,
        });
        if (ok) {
          sent += 1;
          if (isPaid) fullSent += 1;
          else teaserSent += 1;
        } else failed += 1;
      }

      // Only lock the issue as "sent" if at least one email actually went out.
      // If every delivery failed (e.g. Resend not configured, provider outage),
      // leave the issue editable so the editor can fix and retry.
      if (sent === 0) {
        return res.status(502).json({
          error:
            "No emails could be delivered. Check email configuration and try again.",
          sent,
          failed,
          total: subs.length,
        });
      }

      // Lock the issue as "sent" AND mint the reimbursement ledger for any
      // faculty-attributed posts in one transaction, so the ledger can never
      // silently drift from a sent issue. Minting is idempotent via the
      // (issue_id, post_id) unique index, so a resend attempt never
      // double-credits. authorEmail/offerId are pulled from the originating
      // offer (linked by resultingPostId) so finance has a complete payee row.
      let creditsMinted = 0;
      await db.transaction(async (tx) => {
        await tx
          .update(newsletterIssuesTable)
          .set({ status: "sent", sentAt: new Date(), recipientCount: sent })
          .where(eq(newsletterIssuesTable.id, id));

        const facultyPosts = await tx
          .select()
          .from(newsletterPostsTable)
          .where(
            and(
              eq(newsletterPostsTable.issueId, id),
              sql`${newsletterPostsTable.facultyUserId} is not null`,
            ),
          );
        if (facultyPosts.length === 0) return;

        const postIds = facultyPosts.map((p) => p.id);
        const offers = await tx
          .select()
          .from(newsletterOffersTable)
          .where(inArray(newsletterOffersTable.resultingPostId, postIds));
        const offerByPost = new Map(
          offers
            .filter((o) => o.resultingPostId != null)
            .map((o) => [o.resultingPostId as number, o]),
        );

        for (const p of facultyPosts) {
          const offer = offerByPost.get(p.id);
          const inserted = await tx
            .insert(newsletterCreditsTable)
            .values({
              facultyUserId: p.facultyUserId as number,
              authorName: p.authorName ?? offer?.authorName ?? null,
              authorEmail: offer?.authorEmail ?? null,
              issueId: id,
              postId: p.id,
              offerId: offer?.id ?? null,
              postTitle: p.title ?? null,
              amountCents: CREDIT_CENTS,
            })
            .onConflictDoNothing({
              target: [
                newsletterCreditsTable.issueId,
                newsletterCreditsTable.postId,
              ],
            })
            .returning();
          if (inserted.length > 0) creditsMinted += 1;
        }
      });

      return res.json({
        ok: true,
        sent,
        failed,
        total: subs.length,
        creditsMinted,
        premium,
        fullSent,
        teaserSent,
      });
    } catch (e) {
      req.log.error({ err: e }, "send failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

// ── Editor: faculty offers (review queue) ────────────────────────────────────

// GET /newsletter/offers?status=offered — review pool of faculty offers.
router.get(
  "/newsletter/offers",
  requireEditorOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const status = String(req.query.status ?? "").trim();
      const rows = await db
        .select()
        .from(newsletterOffersTable)
        .where(
          status === "offered" || status === "accepted" || status === "declined"
            ? eq(newsletterOffersTable.status, status)
            : undefined,
        )
        .orderBy(desc(newsletterOffersTable.createdAt));
      return res.json({ offers: rows });
    } catch (e) {
      req.log.error({ err: e }, "list offers failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

// POST /newsletter/offers/:id/accept { issueId } — turn an offer into a draft
// post inside the chosen issue, carrying the faculty byline + attribution.
router.post(
  "/newsletter/offers/:id/accept",
  requireEditorOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const offerId = parseInt(String(req.params.id), 10);
      const issueId = parseInt(String((req.body ?? {}).issueId), 10);
      if (!Number.isFinite(issueId)) {
        return res.status(400).json({ error: "issueId is required" });
      }
      const offer = (
        await db
          .select()
          .from(newsletterOffersTable)
          .where(eq(newsletterOffersTable.id, offerId))
          .limit(1)
      )[0];
      if (!offer) return res.status(404).json({ error: "Offer not found" });
      if (offer.status !== "offered") {
        return res
          .status(409)
          .json({ error: `Offer already ${offer.status}` });
      }
      const issue = (
        await db
          .select()
          .from(newsletterIssuesTable)
          .where(eq(newsletterIssuesTable.id, issueId))
          .limit(1)
      )[0];
      if (!issue) return res.status(404).json({ error: "Issue not found" });
      if (issue.status === "sent") {
        return res
          .status(409)
          .json({ error: "Cannot add a post to an issue that was already sent" });
      }

      // Atomically claim the offer and create its post. The conditional update
      // (status = 'offered') guarantees only one concurrent accept wins, so an
      // offer can never spawn two posts.
      const out = await db.transaction(async (tx) => {
        const claimed = await tx
          .update(newsletterOffersTable)
          .set({
            status: "accepted",
            reviewedBy: (req as any).editorIdentity ?? null,
            reviewedAt: new Date(),
          })
          .where(
            and(
              eq(newsletterOffersTable.id, offerId),
              eq(newsletterOffersTable.status, "offered"),
            ),
          )
          .returning();
        if (claimed.length === 0) return null; // lost the race / already resolved

        const [{ maxPos }] = await tx
          .select({
            maxPos: sql<number>`coalesce(max(${newsletterPostsTable.position}), -1)::int`,
          })
          .from(newsletterPostsTable)
          .where(eq(newsletterPostsTable.issueId, issueId));

        const [post] = await tx
          .insert(newsletterPostsTable)
          .values({
            issueId,
            kind: "article",
            position: (maxPos ?? -1) + 1,
            title: offer.title,
            authorName: offer.authorName ?? null,
            authorInstitution: offer.authorInstitution ?? null,
            facultyUserId: offer.facultyUserId,
            sourceId: offer.interpretationId ?? null,
            bodyHtml: offer.bodyHtml ?? null,
            sourceMaterial: offer.sourceMaterial ?? offer.summary ?? null,
          })
          .returning();

        const [updated] = await tx
          .update(newsletterOffersTable)
          .set({ resultingPostId: post.id })
          .where(eq(newsletterOffersTable.id, offerId))
          .returning();

        return { offer: updated, post };
      });

      if (!out) {
        return res.status(409).json({ error: "Offer already accepted" });
      }
      return res.json(out);
    } catch (e) {
      req.log.error({ err: e }, "accept offer failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

// POST /newsletter/offers/:id/decline { reason }
router.post(
  "/newsletter/offers/:id/decline",
  requireEditorOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const offerId = parseInt(String(req.params.id), 10);
      const reason = String((req.body ?? {}).reason ?? "")
        .trim()
        .slice(0, 1000);
      // Atomically claim+decline so a concurrent accept can't also win.
      const [updated] = await db
        .update(newsletterOffersTable)
        .set({
          status: "declined",
          declineReason: reason || null,
          reviewedBy: (req as any).editorIdentity ?? null,
          reviewedAt: new Date(),
        })
        .where(
          and(
            eq(newsletterOffersTable.id, offerId),
            eq(newsletterOffersTable.status, "offered"),
          ),
        )
        .returning();
      if (!updated) {
        const existing = (
          await db
            .select({ status: newsletterOffersTable.status })
            .from(newsletterOffersTable)
            .where(eq(newsletterOffersTable.id, offerId))
            .limit(1)
        )[0];
        if (!existing) return res.status(404).json({ error: "Offer not found" });
        return res
          .status(409)
          .json({ error: `Offer already ${existing.status}` });
      }
      return res.json({ offer: updated });
    } catch (e) {
      req.log.error({ err: e }, "decline offer failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

// ── Editor: credit / reimbursement ledger ────────────────────────────────────

function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

// GET /newsletter/credits — full ledger with a summary.
router.get(
  "/newsletter/credits",
  requireEditorOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const credits = await db
        .select()
        .from(newsletterCreditsTable)
        .orderBy(desc(newsletterCreditsTable.createdAt));
      const totalCents = credits.reduce((s, c) => s + c.amountCents, 0);
      const outstandingCents = credits
        .filter((c) => c.status !== "paid")
        .reduce((s, c) => s + c.amountCents, 0);
      return res.json({
        credits,
        summary: {
          count: credits.length,
          totalCents,
          outstandingCents,
        },
      });
    } catch (e) {
      req.log.error({ err: e }, "list credits failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

// PATCH /newsletter/credits/:id { status, amountCents, note }
router.patch(
  "/newsletter/credits/:id",
  requireEditorOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const body = req.body as {
        status?: "pending" | "approved" | "paid";
        amountCents?: number;
        note?: string;
      };
      const patch: Record<string, unknown> = {};
      if (
        body.status === "pending" ||
        body.status === "approved" ||
        body.status === "paid"
      ) {
        patch.status = body.status;
        patch.paidAt = body.status === "paid" ? new Date() : null;
      }
      if (typeof body.amountCents === "number" && body.amountCents >= 0) {
        patch.amountCents = Math.round(body.amountCents);
      }
      if ("note" in body) patch.note = String(body.note ?? "").slice(0, 1000) || null;
      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: "Nothing to update" });
      }
      const [row] = await db
        .update(newsletterCreditsTable)
        .set(patch)
        .where(eq(newsletterCreditsTable.id, id))
        .returning();
      if (!row) return res.status(404).json({ error: "Not found" });
      return res.json({ credit: row });
    } catch (e) {
      req.log.error({ err: e }, "patch credit failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

// GET /newsletter/credits.csv — export the ledger for finance.
router.get(
  "/newsletter/credits.csv",
  requireEditorOrAdmin,
  async (req: Request, res: Response) => {
    try {
      const credits = await db
        .select()
        .from(newsletterCreditsTable)
        .orderBy(desc(newsletterCreditsTable.createdAt));
      const esc = (v: unknown) => {
        const s = v == null ? "" : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const header = [
        "id",
        "author_name",
        "author_email",
        "issue_id",
        "post_title",
        "amount_usd",
        "status",
        "created_at",
        "paid_at",
      ];
      const lines = [header.join(",")];
      for (const c of credits) {
        lines.push(
          [
            c.id,
            c.authorName,
            c.authorEmail,
            c.issueId,
            c.postTitle,
            dollars(c.amountCents),
            c.status,
            c.createdAt?.toISOString() ?? "",
            c.paidAt?.toISOString() ?? "",
          ]
            .map(esc)
            .join(","),
        );
      }
      res.setHeader("content-type", "text/csv; charset=utf-8");
      res.setHeader(
        "content-disposition",
        'attachment; filename="newsletter-credits.csv"',
      );
      return res.send(lines.join("\n"));
    } catch (e) {
      req.log.error({ err: e }, "credits csv failed");
      return res.status(500).json({ error: "Failed" });
    }
  },
);

// ── Public: paid newsletter tier (Stripe) ───────────────────────────────────
//
// Reuses the consumer-billing plumbing (consumer_accounts + Stripe customer +
// consumer_login_tokens) so a paid newsletter subscriber doesn't need a
// separate login system. Paid status is never stored — it's derived at read
// time from the Stripe-synced tables. All endpoints degrade gracefully when
// Stripe isn't connected.

// GET /newsletter/billing/plans — public newsletter plans for the upgrade card.
router.get(
  "/newsletter/billing/plans",
  async (_req: Request, res: Response) => {
    const plans = await getNewsletterPlans();
    return res.json({ plans });
  },
);

const nlCheckoutSchema = z.object({
  email: z.string().email(),
  priceId: z.string().min(1).optional(),
});

// POST /newsletter/billing/checkout — start a Stripe Checkout for the paid tier.
router.post(
  "/newsletter/billing/checkout",
  async (req: Request, res: Response) => {
    if (!(await isStripeConnected())) {
      return res.status(503).json({ error: "Billing is not available yet" });
    }
    const parsed = nlCheckoutSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "A valid email is required" });
    }
    const email = parsed.data.email.trim().toLowerCase();
    try {
      // Resolve the price server-side so a client can't pass an arbitrary
      // price: it must be one of the active newsletter prices. Default to the
      // cheapest (monthly) when none supplied.
      const plans = await getNewsletterPlans();
      if (plans.length === 0) {
        return res.status(503).json({ error: "No newsletter plan is available" });
      }
      let priceId = parsed.data.priceId;
      if (priceId) {
        if (!(await isNewsletterPrice(priceId))) {
          return res.status(400).json({ error: "Unknown plan" });
        }
      } else {
        priceId = plans[0]!.priceId;
      }

      // Ensure they're an active subscriber and carry the Stripe customer link.
      const existing = await db
        .select()
        .from(newsletterSubscribersTable)
        .where(eq(newsletterSubscribersTable.email, email))
        .limit(1);
      const account = await findOrCreateConsumerByEmail(email);
      const customerId = await ensureStripeCustomer(account);
      if (existing[0]) {
        await db
          .update(newsletterSubscribersTable)
          .set({
            status: "active",
            unsubscribedAt: null,
            stripeCustomerId: customerId,
          })
          .where(eq(newsletterSubscribersTable.id, existing[0].id));
      } else {
        await db.insert(newsletterSubscribersTable).values({
          email,
          source: "premium",
          unsubscribeToken: randomBytes(24).toString("hex"),
          confirmedAt: new Date(),
          stripeCustomerId: customerId,
        });
      }

      const stripe = await getUncachableStripeClient();
      const base = siteBaseUrl(req);
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${base}/newsletter?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${base}/newsletter?checkout=cancelled`,
        allow_promotion_codes: true,
      });
      if (!session.url) {
        return res.status(502).json({ error: "Could not start checkout" });
      }
      return res.json({ url: session.url });
    } catch (err) {
      req.log.error({ err }, "newsletter checkout creation failed");
      return res.status(500).json({ error: "Could not start checkout" });
    }
  },
);

const nlConfirmSchema = z.object({ sessionId: z.string().min(1) });

// POST /newsletter/billing/confirm — after checkout return: sync + link the
// subscriber to the customer. This never grants a session (none is needed: the
// reader simply receives premium issues by email), so there's no
// account-takeover surface here.
router.post(
  "/newsletter/billing/confirm",
  async (req: Request, res: Response) => {
    if (!(await isStripeConnected())) {
      return res.status(503).json({ error: "Billing is not available yet" });
    }
    const parsed = nlConfirmSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "sessionId required" });
    }
    try {
      const stripe = await getUncachableStripeClient();
      const session = await stripe.checkout.sessions.retrieve(
        parsed.data.sessionId,
      );
      if (session.status !== "complete" || session.payment_status === "unpaid") {
        return res.status(402).json({ error: "Checkout not completed" });
      }
      const customerId =
        typeof session.customer === "string"
          ? session.customer
          : (session.customer?.id ?? null);
      if (!customerId) {
        return res.status(400).json({ error: "No customer on session" });
      }
      // Pull the latest state so paid status reflects immediately rather than
      // waiting for the async webhook.
      try {
        const stripeSync = await getStripeSync();
        await stripeSync.syncSingleEntity(customerId);
        if (typeof session.subscription === "string") {
          await stripeSync.syncSingleEntity(session.subscription);
        }
      } catch (err) {
        req.log.warn(
          { err },
          "Post-checkout newsletter sync failed (webhook will catch up)",
        );
      }
      // Ensure the subscriber row carries the customer link (covers the case
      // where checkout customer email differs from what we stored).
      const customerEmail =
        typeof session.customer_details?.email === "string"
          ? session.customer_details.email.trim().toLowerCase()
          : null;
      if (customerEmail) {
        await db
          .update(newsletterSubscribersTable)
          .set({ stripeCustomerId: customerId, status: "active" })
          .where(eq(newsletterSubscribersTable.email, customerEmail));
      }
      const paid = (await getPaidNewsletterCustomerIds()).has(customerId);
      return res.json({ ok: true, paid });
    } catch (err) {
      req.log.error({ err }, "newsletter checkout confirm failed");
      return res.status(500).json({ error: "Could not confirm checkout" });
    }
  },
);

const nlPortalSchema = z.object({ email: z.string().email() });

// POST /newsletter/billing/portal — email a one-time link that opens the Stripe
// customer portal. Email-based identification (no login) — we always return a
// generic ok so we never leak whether an email is a paying customer.
router.post(
  "/newsletter/billing/portal",
  async (req: Request, res: Response) => {
    const parsed = nlPortalSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "A valid email is required" });
    }
    const email = parsed.data.email.trim().toLowerCase();
    try {
      const rows = await db
        .select()
        .from(consumerAccountsTable)
        .where(eq(consumerAccountsTable.email, email))
        .limit(1);
      const customerId = rows[0]?.stripeCustomerId ?? null;
      // Only email a link when there's actually an active newsletter customer,
      // but respond identically either way.
      if (customerId && (await getPaidNewsletterCustomerIds()).has(customerId)) {
        const token = randomBytes(24).toString("hex");
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
        await db.insert(consumerLoginTokensTable).values({
          email,
          magicToken: token,
          expiresAt,
        });
        const url = `${siteBaseUrl(req)}/newsletter?portal=${encodeURIComponent(token)}`;
        await sendNewsletterPortalLink({ to: email, url });
      }
      return res.json({ ok: true });
    } catch (err) {
      req.log.error({ err }, "newsletter portal request failed");
      return res.json({ ok: true });
    }
  },
);

const nlPortalConsumeSchema = z.object({ token: z.string().min(1) });

// POST /newsletter/billing/portal/consume — exchange the one-time token for a
// fresh Stripe billing-portal URL (created at click time so it can't expire).
router.post(
  "/newsletter/billing/portal/consume",
  async (req: Request, res: Response) => {
    if (!(await isStripeConnected())) {
      return res.status(503).json({ error: "Billing is not available yet" });
    }
    const parsed = nlPortalConsumeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Token required" });
    }
    try {
      const rows = await db
        .select()
        .from(consumerLoginTokensTable)
        .where(eq(consumerLoginTokensTable.magicToken, parsed.data.token))
        .limit(1);
      const t = rows[0];
      if (!t || t.consumedAt || t.expiresAt.getTime() < Date.now()) {
        return res.status(400).json({ error: "Link expired or already used" });
      }
      await db
        .update(consumerLoginTokensTable)
        .set({ consumedAt: new Date() })
        .where(eq(consumerLoginTokensTable.id, t.id));
      const acct = await db
        .select()
        .from(consumerAccountsTable)
        .where(eq(consumerAccountsTable.email, t.email))
        .limit(1);
      const customerId = acct[0]?.stripeCustomerId ?? null;
      if (!customerId) {
        return res.status(404).json({ error: "No subscription found" });
      }
      const stripe = await getUncachableStripeClient();
      const portal = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${siteBaseUrl(req)}/newsletter`,
      });
      return res.json({ url: portal.url });
    } catch (err) {
      req.log.error({ err }, "newsletter portal consume failed");
      return res.status(500).json({ error: "Could not open billing portal" });
    }
  },
);

export default router;
