import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  pgEnum,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ── Communication offers (to Matt Abrahams) ─────────────────────────────────
// A faculty steward offers a written article to Matt Abrahams for
// communication-focused content (how to communicate / express / persuade on a
// topic). This is a SEPARATE destination from the SLM newsletter: an offer
// here never enters a newsletter issue, and a newsletter offer never reaches
// Matt. Matt reviews these in his own queue and accepts or declines each.
//
// Unlike the newsletter contribution loop, there is intentionally NO credit /
// reimbursement ledger — Matt isn't compensating stewards, so accepting an
// offer only marks it accepted and notifies the author.

export const communicationOfferStatusEnum = pgEnum(
  "communication_offer_status",
  ["offered", "accepted", "declined"],
);

export const communicationOffersTable = pgTable("communication_offers", {
  id: serial("id").primaryKey(),
  // loose ref → faculty_users.id (cross-file, matches the newsletter offer
  // convention).
  facultyUserId: integer("faculty_user_id").notNull(),
  authorName: text("author_name"),
  authorEmail: text("author_email"),
  // Author's institution snapshotted at offer time (from the faculty profile).
  authorInstitution: text("author_institution"),
  title: text("title").notNull(),
  summary: text("summary"),
  bodyHtml: text("body_html"),
  status: communicationOfferStatusEnum("status").notNull().default("offered"),
  // Matt's optional note, set on accept OR decline; shown back to the steward.
  reviewerNote: text("reviewer_note"),
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type CommunicationOffer = typeof communicationOffersTable.$inferSelect;

// ── Communication reviewer sessions ─────────────────────────────────────────
// Magic-link auth for Matt's review queue. Mirrors story_editor_sessions but is
// a SEPARATE table + cookie + allowlist so Matt's access is fully isolated from
// the newsletter editors' Stories sessions (and vice versa). A leaked Stories
// session token can never reach Matt's queue, and a Matt session can never
// reach the editor surfaces.

export const communicationReviewerSessionsTable = pgTable(
  "communication_reviewer_sessions",
  {
    id: serial("id").primaryKey(),
    email: text("email").notNull(),
    magicToken: text("magic_token").notNull().unique(),
    sessionToken: text("session_token").unique(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    sessionExpiresAt: timestamp("session_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    magicTokenUniq: uniqueIndex(
      "communication_reviewer_sessions_magic_token_uniq",
    ).on(t.magicToken),
  }),
);
