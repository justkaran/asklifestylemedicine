import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  jsonb,
  boolean,
} from "drizzle-orm/pg-core";

/**
 * Palonur Decision Room — a standalone decision-making workspace.
 *
 * The core rule is anti-automation-bias: the owner writes their OWN view
 * before consulting the governed pillars (server-enforced — the consult
 * endpoint 400s when own_view is empty). Consultations reuse the governed
 * RAG pipeline (governedAnswer, pinned to one pillar) so every AI answer is
 * steward-approved science with citations, or an honest "uncovered".
 *
 * Kept in sync with raw CREATE TABLE IF NOT EXISTS DDL in
 * artifacts/api-server/src/index.ts migrate(); prod migration via Publish.
 */
export const decisionsTable = pgTable("decision_room_decisions", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  question: text("question").notNull(),
  context: text("context"),
  ownView: text("own_view"),
  finalCall: text("final_call"),
  outcome: text("outcome"),
  /** framing → consulting → deciding → decided */
  status: text("status").notNull().default("framing"),
  /** Per-decision progress through the global AI-consideration protocol. */
  checkedStepIds: jsonb("checked_step_ids").notNull().default([]),
  decidedAt: timestamp("decided_at", { withTimezone: true }),

  // ── CVO Release Governance extensions ─────────────────────────────────
  /** test | live — strict server-enforced mode isolation */
  mode: text("mode").notNull().default("live"),
  institutionName: text("institution_name").notNull().default(""),
  namedExpert: text("named_expert").notNull().default(""),
  ownerFacultyUserId: integer("owner_faculty_user_id"),
  /**
   * Live mode only: explicit acknowledgement that content is externally
   * cleared for public release.  Required before status can become ready/published.
   */
  externallyCleared: boolean("externally_cleared").notNull().default(false),
  revenueTermsAcknowledged: boolean("revenue_terms_acknowledged")
    .notNull()
    .default(false),
  revenueTermsNote: text("revenue_terms_note"),
  // Faculty substantive sign-off (distinct from CVO process verification)
  facultyApprovedAt: timestamp("faculty_approved_at", { withTimezone: true }),
  facultyApprovedById: integer("faculty_approved_by_id"),
  facultyApprovedByName: text("faculty_approved_by_name"),
  // CVO process verification (platform-admin only; requires faculty signoff)
  cvoVerifiedAt: timestamp("cvo_verified_at", { withTimezone: true }),
  cvoVerifiedById: integer("cvo_verified_by_id"),
  cvoVerifiedByName: text("cvo_verified_by_name"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
  /** Fictional/sample record inserted at boot for Test mode rehearsal */
  isSample: boolean("is_sample").notNull().default(false),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** One governed pillar answer captured for a decision/release. */
export const decisionConsultationsTable = pgTable(
  "decision_room_consultations",
  {
    id: serial("id").primaryKey(),
    decisionId: integer("decision_id").notNull(),
    pillarSlug: text("pillar_slug").notNull(),
    pillarName: text("pillar_name").notNull(),
    /** covered | uncovered | error */
    status: text("status").notNull(),
    answerText: text("answer_text").notNull(),
    /** [{ title, authors?, year?, sourceUrl? }] */
    citations: jsonb("citations").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

/**
 * Global, user-editable "AI consideration steps" protocol (ordered).
 * Seeded when empty in migrate(); per-decision checkoffs live on the
 * decision row (checked_step_ids).
 */
export const decisionAiStepsTable = pgTable("decision_room_ai_steps", {
  id: serial("id").primaryKey(),
  text: text("text").notNull(),
  position: integer("position").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Immutable audit events for CVO release governance.
 * Records every significant lifecycle action with actor info and JSON detail.
 */
export const decisionRoomAuditEventsTable = pgTable(
  "decision_room_audit_events",
  {
    id: serial("id").primaryKey(),
    mode: text("mode").notNull(),
    releaseId: integer("release_id").notNull(),
    actorId: integer("actor_id").notNull(),
    actorName: text("actor_name").notNull(),
    eventType: text("event_type").notNull(),
    detail: jsonb("detail").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

/**
 * Comments and challenges on a CVO release record.
 */
export const decisionRoomCommentsTable = pgTable("decision_room_comments", {
  id: serial("id").primaryKey(),
  mode: text("mode").notNull(),
  releaseId: integer("release_id").notNull(),
  authorId: integer("author_id").notNull(),
  authorName: text("author_name").notNull(),
  /** comment | challenge */
  kind: text("kind").notNull().default("comment"),
  body: text("body").notNull(),
  /** open | resolved */
  status: text("status").notNull().default("open"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedById: integer("resolved_by_id"),
  resolvedByName: text("resolved_by_name"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Opaque review links that grant read-only public access to a release.
 * Raw token returned once; stored only as SHA-256 hash.
 */
export const decisionRoomReviewLinksTable = pgTable(
  "decision_room_review_links",
  {
    id: serial("id").primaryKey(),
    mode: text("mode").notNull(),
    releaseId: integer("release_id").notNull(),
    /** SHA-256(rawToken) — never store the plaintext token */
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    creatorId: integer("creator_id").notNull(),
    creatorName: text("creator_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export type Release = typeof decisionsTable.$inferSelect;
export type ReleaseAuditEvent =
  typeof decisionRoomAuditEventsTable.$inferSelect;
export type ReleaseComment = typeof decisionRoomCommentsTable.$inferSelect;
export type ReleaseReviewLink =
  typeof decisionRoomReviewLinksTable.$inferSelect;
