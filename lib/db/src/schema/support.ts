import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  pgEnum,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * Palonur Support Concierge.
 *
 * A scoped support role (Palonur employees, NOT admins) works a single calm
 * "Concierge" inbox that gathers the questions nobody answers today:
 *   1. questions readers asked the AI agents that came back uncovered, and
 *   2. new public "Ask Palonur" submissions.
 *
 * Each item is pre-triaged to a steward/pillar with a suggested draft reply,
 * then closed two ways: sent AS Palonur, or routed to the steward (who
 * approves/edits and sends it in their own voice).
 */

/** Magic-link + session table for the isolated `support_session` cookie.
 * Mirrors `story_editor_sessions` exactly. */
export const supportSessionsTable = pgTable(
  "support_sessions",
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
    magicTokenIdx: uniqueIndex("support_sessions_magic_token_uniq").on(
      t.magicToken,
    ),
  }),
);

/** Where an inbox item came from. */
export const supportSourceEnum = pgEnum("support_question_source", [
  "ask", // public "Ask Palonur" submission (has asker email)
  "uncovered", // a reader question the AI agents couldn't answer (anonymous)
]);

/** Inbox item lifecycle. Deliberately tiny — no tabs, no statuses to fiddle. */
export const supportStatusEnum = pgEnum("support_question_status", [
  "new", // arrived + triaged, awaiting support action
  "pending_steward", // routed to a steward, awaiting their approve/send
  "answered", // reply was sent (as Palonur or by the steward)
  "closed", // dismissed / drafted-for-steward-as-knowledge, no email
]);

/** How a reply was (or will be) written/sent. */
export const supportReplyModeEnum = pgEnum("support_reply_mode", [
  "palonur", // warm concierge reply, sent from the Palonur identity
  "steward", // steward approves + sends in their own voice/signature
]);

export const supportQuestionsTable = pgTable(
  "support_questions",
  {
    id: serial("id").primaryKey(),
    source: supportSourceEnum("source").notNull().default("ask"),
    status: supportStatusEnum("status").notNull().default("new"),

    // Asker (uncovered-agent items are anonymous → null email).
    askerName: text("asker_name"),
    askerEmail: text("asker_email"),
    message: text("message").notNull(),
    /** Optional asker-chosen "which expert" pillar. */
    targetPillarId: integer("target_pillar_id"),

    /** Link back to the originating agent_queries row for uncovered items.
     * Unique so re-syncing the inbox never duplicates an item. FK-less on
     * purpose so a since-deleted query never breaks the inbox. */
    agentQueryId: text("agent_query_id"),

    // Pre-triage (best-effort; null when AI/RAG unavailable).
    suggestedPillarId: integer("suggested_pillar_id"),
    suggestedPillarSlug: text("suggested_pillar_slug"),
    suggestedPillarName: text("suggested_pillar_name"),
    suggestedStewardUserId: integer("suggested_steward_user_id"),
    suggestedStewardName: text("suggested_steward_name"),
    /** Suggested draft reply, pre-written in the right voice. */
    draftReply: text("draft_reply"),
    draftMode: supportReplyModeEnum("draft_mode").notNull().default("palonur"),
    /** Relevant source context (provenance entries) for display. */
    sourceContext: jsonb("source_context"),

    // Resolution.
    assignedStewardUserId: integer("assigned_steward_user_id"),
    replyMode: supportReplyModeEnum("reply_mode"),
    sentReply: text("sent_reply"),
    answeredBy: text("answered_by"),
    answeredAt: timestamp("answered_at", { withTimezone: true }),

    // Dual consent (public Ask path only).
    consentTimestamp: timestamp("consent_timestamp", { withTimezone: true }),
    consentIpHash: text("consent_ip_hash"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    agentQueryIdx: uniqueIndex("support_questions_agent_query_uniq").on(
      t.agentQueryId,
    ),
    statusCreatedIdx: index("support_questions_status_created_idx").on(
      t.status,
      t.createdAt,
    ),
    assignedStewardIdx: index("support_questions_assigned_steward_idx").on(
      t.assignedStewardUserId,
    ),
  }),
);

export type SupportSession = typeof supportSessionsTable.$inferSelect;
export type SupportQuestion = typeof supportQuestionsTable.$inferSelect;
