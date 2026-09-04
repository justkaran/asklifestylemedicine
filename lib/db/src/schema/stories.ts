import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  pgEnum,
  jsonb,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const storyStatusEnum = pgEnum("story_status", [
  "draft",
  "new",
  "in_edit",
  "approved",
  "archived",
]);

export const storiesTable = pgTable("stories", {
  id: serial("id").primaryKey(),
  draftToken: text("draft_token").notNull().unique(),
  status: storyStatusEnum("status").notNull().default("draft"),
  // submitter
  firstName: text("first_name"),
  email: text("email"),
  anonymous: boolean("anonymous").notNull().default(false),
  // PACE answers (raw user input)
  goal: text("goal"),
  hook: text("hook"),
  struggle: text("struggle"),
  enablement: text("enablement"),
  // AI follow-ups (one per section, keyed)
  followUps: jsonb("follow_ups").$type<Record<string, string>>().notNull().default({}),
  followUpAnswers: jsonb("follow_up_answers").$type<Record<string, string>>().notNull().default({}),
  // Editorial
  draftHtml: text("draft_html"),
  pullQuote: text("pull_quote"),
  editorNotes: text("editor_notes"),
  // Referrer + invite context
  referrer: text("referrer"),
  sleepQueryId: text("sleep_query_id"),
  inviteId: integer("invite_id"),
  inviterNote: text("inviter_note"),
  // Consent
  consentCopyright: boolean("consent_copyright").notNull().default(false),
  consentPublish: boolean("consent_publish").notNull().default(false),
  consentTimestamp: timestamp("consent_timestamp", { withTimezone: true }),
  consentIpHash: text("consent_ip_hash"),
  // Submission/approval
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvedBy: text("approved_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const storyImagesTable = pgTable("story_images", {
  id: serial("id").primaryKey(),
  storyId: integer("story_id")
    .notNull()
    .references(() => storiesTable.id, { onDelete: "cascade" }),
  objectPath: text("object_path").notNull(),
  contentType: text("content_type"),
  originalName: text("original_name"),
  caption: text("caption"),
  position: integer("position").notNull().default(0),
  isPullImage: boolean("is_pull_image").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const storyInvitesTable = pgTable("story_invites", {
  id: serial("id").primaryKey(),
  token: text("token").notNull().unique(),
  email: text("email").notNull(),
  inviterEmail: text("inviter_email").notNull(),
  contextNote: text("context_note"),
  usedAt: timestamp("used_at", { withTimezone: true }),
  storyId: integer("story_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

// Admin-managed editor allowlist. Who may sign in as a Stories/Newsletter
// editor used to live only in the STORY_EDITOR_EMAILS env var; this table lets
// a platform admin add/remove editors without an engineer. The env/code
// default seeds this table on first read and is the fallback if the DB read
// fails. Emails are stored lowercased; the unique constraint dedupes.
export const storyEditorsTable = pgTable("story_editors", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  addedBy: text("added_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const storyEditorSessionsTable = pgTable(
  "story_editor_sessions",
  {
    id: serial("id").primaryKey(),
    email: text("email").notNull(),
    magicToken: text("magic_token").notNull().unique(),
    sessionToken: text("session_token").unique(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    sessionExpiresAt: timestamp("session_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailIdx: uniqueIndex("story_editor_sessions_magic_token_uniq").on(t.magicToken),
  }),
);
