import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  pgEnum,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ── Investors ───────────────────────────────────────────────────────────────
// The invite-only allowlist for the Investor Portal. `commitmentCents` and
// `notes` are ADMIN-ONLY and must never be serialized to an investor-facing
// response (see publicInvestor() in the investor route).

export const investorStatusEnum = pgEnum("investor_status", [
  "lead",
  "committed",
  "pending",
  "passed",
]);

export const investorsTable = pgTable(
  "investors",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    // Free-form public label shown to other investors, e.g. "Lead", "Angel".
    role: text("role"),
    status: investorStatusEnum("status").notNull().default("pending"),
    // ADMIN-ONLY — never expose to investors.
    commitmentCents: integer("commitment_cents"),
    notes: text("notes"),
    // Gates the newsletter card in the portal.
    newsletterAccess: boolean("newsletter_access").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    emailIdx: uniqueIndex("investors_email_uniq").on(t.email),
  }),
);

// ── Sessions (magic-link auth) ──────────────────────────────────────────────

export const investorSessionsTable = pgTable(
  "investor_sessions",
  {
    id: serial("id").primaryKey(),
    investorId: integer("investor_id")
      .notNull()
      .references(() => investorsTable.id, { onDelete: "cascade" }),
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
    magicTokenIdx: uniqueIndex("investor_sessions_magic_token_uniq").on(
      t.magicToken,
    ),
  }),
);

// ── Decks (server-gated pitch surfaces) ─────────────────────────────────────
// Canonical decks are synced from the Palonur public folder (syncInvestorDecks).
// The gated viewer serves `html` straight from this table so production never
// relies on the stripped static files.

export const investorDecksTable = pgTable("investor_decks", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  description: text("description"),
  html: text("html"),
  listed: boolean("listed").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// ── Per-investor deck grants ────────────────────────────────────────────────

export const investorDeckGrantsTable = pgTable(
  "investor_deck_grants",
  {
    id: serial("id").primaryKey(),
    investorId: integer("investor_id")
      .notNull()
      .references(() => investorsTable.id, { onDelete: "cascade" }),
    deckSlug: text("deck_slug").notNull(),
    grantedBy: text("granted_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    investorDeckIdx: uniqueIndex("investor_deck_grants_uniq").on(
      t.investorId,
      t.deckSlug,
    ),
  }),
);

// ── Updates feed (company progress) ─────────────────────────────────────────

export const investorUpdatesTable = pgTable("investor_updates", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  bodyHtml: text("body_html"),
  pinned: boolean("pinned").notNull().default(false),
  publishedAt: timestamp("published_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// ── Request-info tickets ────────────────────────────────────────────────────

export const investorRequestStatusEnum = pgEnum("investor_request_status", [
  "open",
  "in_progress",
  "answered",
  "closed",
]);

export const investorRequestsTable = pgTable("investor_requests", {
  id: serial("id").primaryKey(),
  investorId: integer("investor_id")
    .notNull()
    .references(() => investorsTable.id, { onDelete: "cascade" }),
  subject: text("subject").notNull(),
  body: text("body"),
  status: investorRequestStatusEnum("status").notNull().default("open"),
  responseHtml: text("response_html"),
  respondedBy: text("responded_by"),
  respondedAt: timestamp("responded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// ── Data room documents ─────────────────────────────────────────────────────

export const investorDocumentsTable = pgTable("investor_documents", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  // Either an object-storage path (served via /api/storage/objects/...) or an
  // external link. At least one is expected.
  objectPath: text("object_path"),
  externalUrl: text("external_url"),
  // Captured at upload time for object-storage files so the data room can show
  // a "PDF · 2.4 MB" style label. Null for external-URL documents.
  sizeBytes: integer("size_bytes"),
  contentType: text("content_type"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── Settings (singleton) ────────────────────────────────────────────────────
// Admin-editable portal settings: the playful hotline + the cap-table faculty
// note. Always a single row keyed "default".

export const investorSettingsTable = pgTable("investor_settings", {
  id: text("id").primaryKey().default("default"),
  hotlineNumber: text("hotline_number"),
  hotlineNote: text("hotline_note"),
  capTableNote: text("cap_table_note"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// ── Lead cash-flow plan (singleton, LEAD-INVESTOR-ONLY) ─────────────────────
// The latest AI-generated cash-flow plan the lead investor (platform admin)
// produced from a connected deck + the total committed funding. Singleton keyed
// "default" — only the most recent plan is kept. This row is SENSITIVE: it is
// derived from the private commitment totals and must never be exposed to any
// non-lead investor (see requireLeadInvestor in the investor route).

export const investorCashFlowTable = pgTable("investor_cash_flow", {
  id: text("id").primaryKey().default("default"),
  deckSlug: text("deck_slug").notNull(),
  deckTitle: text("deck_title"),
  targetDate: text("target_date").notNull(),
  totalCommittedCents: integer("total_committed_cents").notNull(),
  planText: text("plan_text").notNull(),
  generatedBy: text("generated_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
