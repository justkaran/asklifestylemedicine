import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  pgEnum,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ── Landing-page content ─────────────────────────────────────────────────────
// A publication owner can set a Topic and auto-generate (then fully edit) a rich
// editorial landing page rendered at /p/:slug. The structured copy lives in the
// `landingContent` jsonb blob; the hero image (path + prompt) and a generated-at
// marker are dedicated columns. All of it is nullable — a publication with no
// generated landing content keeps the existing fallback layout.

/** One editorial section: a heading, prose body, and an optional generated image. */
export interface LandingSection {
  heading: string;
  body: string;
  /** Object-storage path of the section image (e.g. /objects/...), or null. */
  imagePath: string | null;
  /** Prompt used to generate the section image (kept for regeneration), or null. */
  imagePrompt: string | null;
}

/** Structured editorial landing-page copy generated from a Topic, then editable. */
export interface LandingContent {
  /** Small uppercase eyebrow above the hero headline. */
  heroEyebrow: string;
  /** Large serif hero headline. */
  heroHeadline: string;
  /** One- or two-sentence hero subhead. */
  heroSubhead: string;
  /** "About this topic" lead paragraph. */
  aboutLead: string;
  /** 2–4 editorial sections, each with a heading, body and optional image. */
  sections: LandingSection[];
  /** "What you'll get" bullet points. */
  benefits: string[];
}

// ── Publications ────────────────────────────────────────────────────────────
// A publication owns its own subscribers + issues + branding. There is exactly
// one "house" publication (the original Stanford Lifestyle Medicine newsletter,
// isHouse = true, facultyUserId = null); every other publication belongs to a
// single faculty member who self-publishes to their own audience. Faculty
// self-publish mints NO reimbursement credits — only the house offer→accept→
// send path does.

export const newsletterPublicationsTable = pgTable(
  "newsletter_publications",
  {
    id: serial("id").primaryKey(),
    // The house newsletter has isHouse = true and facultyUserId = null. A
    // faculty-owned publication has isHouse = false and a facultyUserId.
    isHouse: boolean("is_house").notNull().default(false),
    // loose ref → faculty_users.id (cross-file, matches the offers/posts
    // convention). Unique-when-set so a faculty member owns at most one
    // publication; multiple NULLs are allowed (only the house row is null).
    facultyUserId: integer("faculty_user_id"),
    // Display name of the publication, e.g. "Stanford Lifestyle Medicine" or a
    // faculty member's own newsletter title.
    name: text("name").notNull(),
    // URL-safe identifier used in public signup/unsubscribe links; unique across
    // all publications. Stewards may edit their own publication's slug to a
    // memorable handle (faculty PATCH /faculty/publication/slug). Changing it
    // breaks any previously shared link — there is no redirect from the old slug.
    slug: text("slug").notNull(),
    // Email masthead byline ("By {bylineName} · {bylineInstitution}"). The house
    // publication uses the Stanford Lifestyle Medicine branding.
    bylineName: text("byline_name"),
    bylineInstitution: text("byline_institution"),
    // Short tagline shown under the masthead / on the public signup surface.
    tagline: text("tagline"),
    description: text("description"),
    // Optional accent color (hex) for the email masthead + CTA. Falls back to
    // the house red when unset.
    accentColor: text("accent_color"),
    // Optional from-address override ("Name <addr@domain>"); falls back to the
    // shared NEWSLETTER_FROM / STORY_FROM env default when unset.
    fromAddress: text("from_address"),
    // ── Landing page (all nullable; absent → fallback layout on /p/:slug) ──────
    // The Topic the owner set, which seeds AI generation of the landing page.
    topic: text("topic"),
    // Structured editorial copy (hero / about / sections / benefits). Section
    // images live inside this blob; the hero image is stored separately below.
    landingContent: jsonb("landing_content").$type<LandingContent>(),
    // Hero image (object-storage path) + the prompt used to generate it (kept so
    // the owner can regenerate). The hero image also feeds the per-route OG meta.
    heroImagePath: text("hero_image_path"),
    heroImagePrompt: text("hero_image_prompt"),
    // When the landing page was last (re)generated from a Topic.
    landingGeneratedAt: timestamp("landing_generated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    slugUniq: uniqueIndex("newsletter_publications_slug_uniq").on(t.slug),
    // A faculty member owns at most one publication. NULL facultyUserId (the
    // house row) is exempt because Postgres treats NULLs as distinct.
    facultyUniq: uniqueIndex("newsletter_publications_faculty_uniq").on(
      t.facultyUserId,
    ),
    // At most one house publication. Partial index so only isHouse = true rows
    // participate in the uniqueness constraint.
    houseUniq: uniqueIndex("newsletter_publications_house_uniq")
      .on(t.isHouse)
      .where(sql`${t.isHouse} = true`),
  }),
);

// ── Subscribers ─────────────────────────────────────────────────────────────

export const newsletterSubscriberStatusEnum = pgEnum(
  "newsletter_subscriber_status",
  // "pending" = signed up via a public form but has NOT yet clicked the
  // confirmation link emailed to them (double opt-in). Pending subscribers are
  // never sent newsletters — every recipient/stat query gates on status
  // = 'active', so a pending row is excluded everywhere until it confirms.
  ["active", "unsubscribed", "bounced", "pending"],
);

export const newsletterSubscribersTable = pgTable(
  "newsletter_subscribers",
  {
    id: serial("id").primaryKey(),
    // The publication this subscriber belongs to. Nullable for backwards
    // compatibility; the idempotent backfill assigns all legacy rows to the
    // house publication. New subscribes always carry a publicationId.
    publicationId: integer("publication_id").references(
      () => newsletterPublicationsTable.id,
      { onDelete: "cascade" },
    ),
    email: text("email").notNull(),
    name: text("name"),
    status: newsletterSubscriberStatusEnum("status").notNull().default("active"),
    source: text("source"),
    // Linkage to the Stripe customer used for the paid newsletter tier. The
    // paid/free status itself is NEVER stored here — it is derived at read time
    // by querying the synced `stripe.subscriptions` table for an active
    // subscription to the newsletter product (see lib/newsletterBilling.ts),
    // mirroring the consumer-account entitlement model. This column only holds
    // the durable email→customer link so that derivation is possible.
    stripeCustomerId: text("stripe_customer_id"),
    unsubscribeToken: text("unsubscribe_token").notNull().unique(),
    // Double opt-in: a random token emailed to a public subscriber. They click
    // the link to confirm, which flips status pending → active. Editor-added
    // (trusted) subscribers skip this and are created active with no token.
    confirmToken: text("confirm_token"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
    referralSource: text("referral_source"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Uniqueness is now per-publication: the same email may subscribe to
    // multiple publications, but only once within each. The old global
    // email-only unique index is replaced by this composite.
    pubEmailIdx: uniqueIndex("newsletter_subscribers_pub_email_uniq").on(
      t.publicationId,
      t.email,
    ),
    // Confirm tokens are looked up directly on the confirm endpoint, so they
    // must be unique. Multiple NULLs are allowed (active/editor-added rows carry
    // no token), which a plain Postgres unique index permits.
    confirmTokenIdx: uniqueIndex("newsletter_subscribers_confirm_token_uniq").on(
      t.confirmToken,
    ),
  }),
);

// ── Subscriber (members area) sessions ──────────────────────────────────────
// Passwordless magic-link sessions for the consumer-facing members area, where a
// newsletter subscriber signs in to read the publications they're subscribed to
// and use the auto-routing Q&A. Keyed by EMAIL, not by a single subscriber row,
// because one email may subscribe to several publications — the session spans
// all of that email's active subscriptions.
//
// Deliberately isolated from every other auth surface (editor `stories_session`,
// admin `palonur_admin`, investor `investor_session`, Clerk faculty): its own
// table + its own `members_session` cookie, so a members session can never reach
// an editor/admin/investor surface and vice-versa. A session is minted ONLY by
// clicking an emailed one-time link — never by subscribing or paying.

export const newsletterSubscriberSessionsTable = pgTable(
  "newsletter_subscriber_sessions",
  {
    id: serial("id").primaryKey(),
    // The subscriber's email (lowercased). Not a FK to a single subscriber row
    // because the same email can hold rows across multiple publications; the
    // members portal resolves every active subscription for this email.
    email: text("email").notNull(),
    // One-time token embedded in the emailed sign-in link. Consumed atomically.
    magicToken: text("magic_token").notNull().unique(),
    // Long-lived session token set in the signed httpOnly cookie on consume.
    sessionToken: text("session_token").unique(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    // Magic-link expiry (short — 30 min, mirroring the other magic-link flows).
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // Session expiry once consumed (longer — the cookie lifetime).
    sessionExpiresAt: timestamp("session_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

// ── Issues ──────────────────────────────────────────────────────────────────

export const newsletterIssueStatusEnum = pgEnum("newsletter_issue_status", [
  "draft",
  "scheduled",
  "sent",
]);

export const newsletterIssuesTable = pgTable("newsletter_issues", {
  id: serial("id").primaryKey(),
  // The publication this issue belongs to. Nullable for backwards
  // compatibility; the idempotent backfill assigns all legacy rows to the
  // house publication. New issues always carry a publicationId.
  publicationId: integer("publication_id").references(
    () => newsletterPublicationsTable.id,
    { onDelete: "cascade" },
  ),
  title: text("title").notNull(),
  subjectLine: text("subject_line"),
  previewText: text("preview_text"),
  introHtml: text("intro_html"),
  heroImagePath: text("hero_image_path"),
  status: newsletterIssueStatusEnum("status").notNull().default("draft"),
  // Premium issues are delivered in full only to paid newsletter subscribers;
  // free subscribers receive a teaser/preview with an upgrade link. Non-premium
  // issues go to every active subscriber.
  premium: boolean("premium").notNull().default(false),
  createdBy: text("created_by"),
  recipientCount: integer("recipient_count"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// ── Posts ───────────────────────────────────────────────────────────────────

export const newsletterPostKindEnum = pgEnum("newsletter_post_kind", [
  "article",
  "story",
]);

export const newsletterPostsTable = pgTable("newsletter_posts", {
  id: serial("id").primaryKey(),
  issueId: integer("issue_id")
    .notNull()
    .references(() => newsletterIssuesTable.id, { onDelete: "cascade" }),
  kind: newsletterPostKindEnum("kind").notNull().default("article"),
  position: integer("position").notNull().default(0),
  title: text("title"),
  authorName: text("author_name"),
  // Author's institution/affiliation, snapshotted onto the post so the byline
  // ("By {name} · {institution}") is stable even if the contributor later edits
  // their profile. Set from the offer (and ultimately the faculty profile) on
  // accept; editors can also set it manually. Null/empty → name-only byline.
  authorInstitution: text("author_institution"),
  // optional link back to a source/article (sources table id) — loose coupling
  sourceId: integer("source_id"),
  // optional link to a /share story this post was generated from
  storyId: integer("story_id"),
  // optional attribution to a faculty contributor (loose ref → faculty_users.id).
  // Set when an editor accepts a faculty newsletter offer; drives the byline and
  // the credit ledger minted on send.
  facultyUserId: integer("faculty_user_id"),
  bodyHtml: text("body_html"),
  pullQuote: text("pull_quote"),
  // raw material an editor pasted (article text / interview notes)
  sourceMaterial: text("source_material"),
  imagePath: text("image_path"),
  imagePrompt: text("image_prompt"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// ── Faculty offers ──────────────────────────────────────────────────────────
// A faculty contributor offers a post to the SLM newsletter from their portal.
// Editors review the pool, then accept (mints a draft post in a chosen issue,
// bylined to the faculty member) or decline.

export const newsletterOfferStatusEnum = pgEnum("newsletter_offer_status", [
  "offered",
  "accepted",
  "declined",
]);

export const newsletterOffersTable = pgTable("newsletter_offers", {
  id: serial("id").primaryKey(),
  // loose ref → faculty_users.id (cross-file, matches sourceId/storyId convention)
  facultyUserId: integer("faculty_user_id").notNull(),
  authorName: text("author_name"),
  authorEmail: text("author_email"),
  // Author's institution snapshotted at offer time (from the faculty profile),
  // carried onto the resulting post's byline on accept.
  authorInstitution: text("author_institution"),
  // optional loose refs to the faculty content this offer is seeded from
  pillarId: integer("pillar_id"),
  interpretationId: integer("interpretation_id"),
  title: text("title").notNull(),
  summary: text("summary"),
  bodyHtml: text("body_html"),
  sourceMaterial: text("source_material"),
  status: newsletterOfferStatusEnum("status").notNull().default("offered"),
  declineReason: text("decline_reason"),
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  // set when accepted → the resulting newsletter_posts.id
  resultingPostId: integer("resulting_post_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// ── Credit / reimbursement ledger ───────────────────────────────────────────
// One row per faculty-attributed post in a SENT issue. Minted idempotently on
// send (unique on issue_id + post_id). Tracks what is owed; payouts are out of
// scope (this is the honest "reimbursement" record, not a money mover).

export const newsletterCreditStatusEnum = pgEnum("newsletter_credit_status", [
  "pending",
  "approved",
  "paid",
]);

export const newsletterCreditsTable = pgTable(
  "newsletter_credits",
  {
    id: serial("id").primaryKey(),
    facultyUserId: integer("faculty_user_id").notNull(),
    authorName: text("author_name"),
    authorEmail: text("author_email"),
    issueId: integer("issue_id")
      .notNull()
      .references(() => newsletterIssuesTable.id, { onDelete: "cascade" }),
    postId: integer("post_id").references(() => newsletterPostsTable.id, {
      onDelete: "set null",
    }),
    offerId: integer("offer_id"),
    postTitle: text("post_title"),
    amountCents: integer("amount_cents").notNull().default(5000),
    status: newsletterCreditStatusEnum("status").notNull().default("pending"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
  },
  (t) => ({
    issuePostUniq: uniqueIndex("newsletter_credits_issue_post_uniq").on(
      t.issueId,
      t.postId,
    ),
  }),
);
