import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  pgEnum,
} from "drizzle-orm/pg-core";
import { facultyUsersTable } from "./faculty";

/**
 * Decision Room — Amazon-style six-page decision memos built via a chat with
 * Pal, checked against the governed science corpus, and shared with selected
 * faculty for read + per-page comments.
 *
 * Lifecycle: draft → shared → decided (with a recorded outcome). Admin/faculty
 * only — nothing here is ever exposed on public surfaces.
 */
export const decisionMemoStatusEnum = pgEnum("decision_memo_status", [
  "draft",
  "shared",
  "decided",
]);

export const decisionMemosTable = pgTable(
  "decision_memos",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => facultyUsersTable.id),
    title: text("title").notNull(),
    /** Short free-text topic used for Decision Library search. */
    topic: text("topic").notNull().default(""),
    status: decisionMemoStatusEnum("status").notNull().default("draft"),
    /** Recorded outcome, set when the memo transitions to `decided`. */
    decidedOutcome: text("decided_outcome"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    // The six pages, each prose (not bullets):
    // 1 decision & recommendation, 2 context, 3 proposal details,
    // 4 top risks + mitigations, 5 numbers & sensitivity,
    // 6 implementation plan + people impact + the ask.
    page1: text("page1").notNull().default(""),
    page2: text("page2").notNull().default(""),
    page3: text("page3").notNull().default(""),
    page4: text("page4").notNull().default(""),
    page5: text("page5").notNull().default(""),
    page6: text("page6").notNull().default(""),
    /**
     * Latest science-check result: array of per-claim verdicts
     * ({ page, claim, verdict: supported|contradicted|not_covered,
     *    citation|null, note }). Null until first run.
     */
    scienceCheck: jsonb("science_check"),
    scienceCheckedAt: timestamp("science_checked_at", { withTimezone: true }),
    /** "true"/"false" once checked: passed = zero contradicted claims. */
    scienceCheckPassed: text("science_check_passed"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("decision_memos_owner_idx").on(t.ownerId)],
);

export const decisionMemoSharesTable = pgTable(
  "decision_memo_shares",
  {
    id: serial("id").primaryKey(),
    memoId: integer("memo_id")
      .notNull()
      .references(() => decisionMemosTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => facultyUsersTable.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("decision_memo_shares_unique").on(t.memoId, t.userId)],
);

export const decisionMemoCommentsTable = pgTable(
  "decision_memo_comments",
  {
    id: serial("id").primaryKey(),
    memoId: integer("memo_id")
      .notNull()
      .references(() => decisionMemosTable.id, { onDelete: "cascade" }),
    /** 1-6, the page the comment is attached to. */
    page: integer("page").notNull(),
    authorId: integer("author_id")
      .notNull()
      .references(() => facultyUsersTable.id),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("decision_memo_comments_memo_idx").on(t.memoId)],
);

export type DecisionMemo = typeof decisionMemosTable.$inferSelect;
export type DecisionMemoShare = typeof decisionMemoSharesTable.$inferSelect;
export type DecisionMemoComment = typeof decisionMemoCommentsTable.$inferSelect;
