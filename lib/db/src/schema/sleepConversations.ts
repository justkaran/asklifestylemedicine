import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  index,
  uuid,
  jsonb,
} from "drizzle-orm/pg-core";

/**
 * Threaded conversations on the governed answer surface (/sleep).
 *
 * After the first answer, a reader keeps asking follow-ups in the same
 * thread; the server (not the client) is the conversational memory. Each
 * conversation is owned by the anonymous `palonur_session` cookie that
 * created it; a request may only read or extend a conversation whose
 * `session_id` matches its own cookie (ownership enforced in the route,
 * with foreign ids returning 404
 * indistinguishably from missing ones).
 *
 * This surface runs the full governed pipeline per turn (citation guard,
 * provenance, steward attribution, and refusal semantics). Partner-key and
 * neutral-brand traffic never creates or extends conversations (stays one-shot).
 *
 * `free_turns_used` backs the per-conversation free follow-up allowance
 * (SLEEP_CONVERSATION_FREE_TURNS, default 3) layered on top of the daily
 * first-question limit. Consumed via an atomic conditional UPDATE so
 * concurrent follow-ups can't double-spend, and blocked turns never
 * increment.
 */
export const sleepConversationsTable = pgTable(
  "sleep_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The anonymous `palonur_session` cookie value that owns this thread. */
    sessionId: text("session_id").notNull(),
    /** Signed-in consumer account, when known at creation/extension time. */
    consumerAccountId: integer("consumer_account_id"),
    /** Free FOLLOW-UP turns consumed (turn 1 is charged to the daily limit,
     * not this counter). Incremented only when a follow-up actually streams. */
    freeTurnsUsed: integer("free_turns_used").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    sessionIdx: index("sleep_conversations_session_idx").on(t.sessionId),
  }),
);

export const sleepConversationMessagesTable = pgTable(
  "sleep_conversation_messages",
  {
    id: serial("id").primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => sleepConversationsTable.id, { onDelete: "cascade" }),
    /** `user` | `assistant`. */
    role: text("role").notNull(),
    /** For user rows: the enriched question actually embedded/answered
     * (intake context included on turn 1). For assistant rows: the full
     * streamed answer text (labeled sections / REFUSE / UNCOVERED lines). */
    content: text("content").notNull(),
    /**
     * Assistant rows only: the done-event governance payload verbatim
     * (queryId, provenance, pillarNames, winnerPillarName, steward,
     * citationVerification, facultyVerified, triageLabel, slmFallback,
     * alsoCovered, governedMiss, displayQuestion of the paired user turn…)
     * so the governance rail can rebuild prior turns on resume without
     * re-running retrieval. NULL on user rows.
     */
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    conversationIdx: index("sleep_conversation_messages_conversation_idx").on(
      t.conversationId,
    ),
  }),
);

export type SleepConversation = typeof sleepConversationsTable.$inferSelect;
export type SleepConversationMessage =
  typeof sleepConversationMessagesTable.$inferSelect;
