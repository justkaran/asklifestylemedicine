import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  boolean,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ── Reply-as-doorway channel ─────────────────────────────────────────────────
// A registered consumer texts our number in a hard moment (canonically 3am).
// The inbound webhook screens the message (crisis first, fail-closed), then
// replies with a short CANNED acknowledgment — never an AI-generated message,
// never the steward's voice — plus one magic link that opens the governed
// answer surface (/sleep) with their message prefilled and
// comped past the free-question paywall. The answer itself ALWAYS renders
// on-page; the text thread never delivers agent answers.

/** What the pipeline did with an inbound message (one row per inbound). */
export const doorwayEventsTable = pgTable(
  "doorway_events",
  {
    id: serial("id").primaryKey(),
    /** Channel the message arrived on. Only iMessage today. */
    channel: text("channel").notNull().default("imessage"),
    /**
     * SHA-256(phone + SESSION_SECRET). The raw number is NEVER stored here —
     * matches the redaction posture of the email rate-limit + stories tables.
     */
    fromPhoneHash: text("from_phone_hash").notNull(),
    /** Loose ref to consumer_accounts.id when the sender's number matched. */
    consumerAccountId: integer("consumer_account_id"),
    /** Which surface the doorway opens: nightly (sleep). */
    product: text("product").notNull(),
    /**
     * First ~500 chars of the inbound message, stored ONLY when
     * crisis_flagged (the admin review surface needs the text); non-crisis
     * message text lives solely in the short-lived doorway_links row.
     */
    bodyExcerpt: text("body_excerpt"),
    crisisFlagged: boolean("crisis_flagged").notNull().default(false),
    /** Pipeline outcome: 'ack' | 'crisis' | 'capped' | 'ignored'. */
    outcome: text("outcome").notNull(),
    /** Provider message handle (or derived key) for webhook-retry dedup. */
    providerEventId: text("provider_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    providerEventUniq: uniqueIndex("doorway_events_provider_event_uniq").on(
      t.providerEventId,
    ),
    // The rolling per-night cap counts recent ack'd events per sender.
    phoneHashCreatedIdx: index("doorway_events_phone_created_idx").on(
      t.fromPhoneHash,
      t.createdAt,
    ),
  }),
);

/**
 * One magic link per acknowledged inbound message. NOT single-use: iMessage
 * fetches a URL preview before the user taps, so a single-use token would be
 * consumed by Apple's crawler. Instead: short expiry + a small used_count cap.
 */
export const doorwayLinksTable = pgTable("doorway_links", {
  id: serial("id").primaryKey(),
  /** Random URL token (hex). */
  token: text("token").notNull().unique(),
  /** Loose ref to doorway_events.id. */
  doorwayEventId: integer("doorway_event_id"),
  /** Which surface this link opens ('nightly'). */
  product: text("product").notNull(),
  /** The user's message, prefilled as the question on the answer page. */
  question: text("question").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedCount: integer("used_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── Crisis screen terms ──────────────────────────────────────────────────────
// Admin-editable phrase list scanned FIRST against every inbound doorway
// message. A match (or a screening error — fail closed) gets a static crisis
// resources reply, no magic link, never the agent. Deliberately a SEPARATE
// table from advice_guard_terms: that list scans agent ANSWERS at read time in
// the advice-review tab, and crisis phrases there would falsely flag answers.
// Seeded when empty from DEFAULT_CRISIS_TERMS in the api-server (same
// seed-when-empty pattern), so the screen can never silently go blind.
export const crisisTermsTable = pgTable(
  "crisis_terms",
  {
    id: serial("id").primaryKey(),
    /** Plain phrase, matched case-insensitively on word boundaries. */
    phrase: text("phrase").notNull(),
    /** 'seed' for defaults, 'admin' for terms added via the panel. */
    addedBy: text("added_by").notNull().default("admin"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    phraseUniq: uniqueIndex("crisis_terms_phrase_uniq").on(
      sql`lower(${t.phrase})`,
    ),
  }),
);

export type DoorwayEvent = typeof doorwayEventsTable.$inferSelect;
export type DoorwayLink = typeof doorwayLinksTable.$inferSelect;
export type CrisisTerm = typeof crisisTermsTable.$inferSelect;
