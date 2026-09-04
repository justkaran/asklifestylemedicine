import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  pgEnum,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// ── ParentData.org article offers ───────────────────────────────────────────
// A faculty steward proposes a written article to ParentData.org, an outside
// media outlet. ParentData's editor reviews proposals in her OWN dashboard and
// accepts or declines each one. This is a SEPARATE destination from the SLM
// newsletter and from Matt Abrahams' communication queue: a proposal here never
// enters a newsletter issue, never reaches Matt, and carries NO credit /
// reimbursement ledger.
//
// Each proposal also has a back-and-forth conversation thread
// (`parentdata_offer_messages`) so the steward and the editor can discuss the
// piece before/after a decision.

export const parentdataOfferStatusEnum = pgEnum("parentdata_offer_status", [
  "offered",
  "accepted",
  "declined",
]);

export const parentdataOffersTable = pgTable("parentdata_offers", {
  id: serial("id").primaryKey(),
  // loose ref → faculty_users.id (cross-file, matches the communication/newsletter
  // offer convention).
  facultyUserId: integer("faculty_user_id").notNull(),
  authorName: text("author_name"),
  authorEmail: text("author_email"),
  // Author's institution snapshotted at offer time (from the faculty profile).
  authorInstitution: text("author_institution"),
  title: text("title").notNull(),
  summary: text("summary"),
  bodyHtml: text("body_html"),
  // Optional: the editor-authored call for articles this proposal responds to
  // (loose ref → parentdata_calls.id). Null for an unsolicited proposal.
  callId: integer("call_id"),
  status: parentdataOfferStatusEnum("status").notNull().default("offered"),
  // ParentData editor's optional note, set on accept OR decline; shown back to
  // the steward.
  reviewerNote: text("reviewer_note"),
  // The editor's payment decision, set at accept time. NULL = undecided,
  // 0 = decided not to pay, >0 = amount in cents. RECORD-ONLY (no real charge) —
  // mirrors the newsletter credit ledger / framework bookings: nothing moves.
  paymentCents: integer("payment_cents"),
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

export type ParentDataOffer = typeof parentdataOffersTable.$inferSelect;

// ── ParentData reviewer sessions ────────────────────────────────────────────
// Magic-link auth for the ParentData editor's review queue. A SEPARATE table +
// cookie (`parentdata_session`) + allowlist (`PARENTDATA_REVIEWER_EMAILS`) so
// the editor's access is fully isolated from the newsletter editors (Stories),
// Matt's communication queue, and `/admin`. A leaked token from any other queue
// can never reach this one, and vice versa.

export const parentdataReviewerSessionsTable = pgTable(
  "parentdata_reviewer_sessions",
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
      "parentdata_reviewer_sessions_magic_token_uniq",
    ).on(t.magicToken),
  }),
);

// ── ParentData proposal conversation ────────────────────────────────────────
// A threaded conversation on a single proposal. Both the steward (senderRole
// 'faculty') and the ParentData editor (senderRole 'reviewer') can post. The
// faculty side may only read/write messages on offers they own; the reviewer
// side may read/write on any offer.

export const parentdataMessageSenderEnum = pgEnum(
  "parentdata_message_sender",
  ["faculty", "reviewer"],
);

export const parentdataOfferMessagesTable = pgTable(
  "parentdata_offer_messages",
  {
    id: serial("id").primaryKey(),
    // loose ref → parentdata_offers.id.
    offerId: integer("offer_id").notNull(),
    senderRole: parentdataMessageSenderEnum("sender_role").notNull(),
    // Display name snapshotted at send time (faculty full name or editor email).
    senderName: text("sender_name"),
    senderEmail: text("sender_email"),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    offerIdx: index("parentdata_offer_messages_offer_created_idx").on(
      t.offerId,
      t.createdAt,
    ),
  }),
);

export type ParentDataOfferMessage =
  typeof parentdataOfferMessagesTable.$inferSelect;

// ── ParentData calls for articles ───────────────────────────────────────────
// The ParentData editor can post a "call for articles" — a solicitation
// (title + brief, optionally an advertised budget) that faculty stewards see in
// their portal and can respond to with a proposal. A call is authored only by
// the editor (reviewer/admin); faculty read OPEN calls and may link a proposal
// to one via `parentdata_offers.call_id`. Closing a call hides it from faculty
// but never deletes proposals already linked to it.

export const parentdataCallStatusEnum = pgEnum("parentdata_call_status", [
  "open",
  "closed",
]);

export const parentdataCallsTable = pgTable("parentdata_calls", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  // The editor's description of what they're looking for.
  brief: text("brief"),
  // Optional advertised budget in cents. NULL = unspecified. RECORD-ONLY — this
  // is what the outlet signals it may pay; the actual per-proposal decision
  // lives on `parentdata_offers.payment_cents`. No money moves.
  budgetCents: integer("budget_cents"),
  status: parentdataCallStatusEnum("status").notNull().default("open"),
  // The reviewer identity that authored the call ("admin" or an editor email).
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type ParentDataCall = typeof parentdataCallsTable.$inferSelect;
