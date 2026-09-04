import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  pgEnum,
} from "drizzle-orm/pg-core";

// ── Distribution channels ───────────────────────────────────────────────────
// The cards shown on the faculty portal's "Distribution Channels" page
// (FacultyNewsletter, route /newsletter): where a steward's vetted voice lands
// — the SLM newsletter, social outlets, media partners, and "coming soon"
// podcasts / national outlets.
//
// Previously a hardcoded array in the faculty frontend; now DB-backed so a
// platform admin can create / edit / reorder / delete channels without an
// engineer. A channel's behaviour is derived from its fields:
//   - `outlet` set  → the card opens a bespoke in-page detail view that lives in
//                     CODE (newsletter / matt / parentdata). Admins can point a
//                     card at one of those existing views but cannot invent a
//                     new interactive outlet from data alone.
//   - `href` set    → the card links out to an external URL.
//   - status 'soon' → the card shows a "notify me / I'm interested" control,
//                     keyed by `key` (see faculty_channel_interest).
//
// `key` is a stable string identifier (immutable after create) that anchors
// `faculty_channel_interest.channel_key` rows — renaming a channel must never
// orphan a steward's prior interest signal.

export const distributionChannelStatusEnum = pgEnum(
  "distribution_channel_status",
  ["live", "soon"],
);

// The bespoke, code-backed detail views a channel card may open. Stored as text
// (validated at the API boundary) rather than a DB enum so adding a new
// code-backed view later doesn't require an enum migration.
export type DistributionChannelOutlet = "newsletter" | "matt" | "parentdata";

export const distributionChannelsTable = pgTable("distribution_channels", {
  id: serial("id").primaryKey(),
  // Stable, immutable identifier. Anchors faculty_channel_interest rows for
  // "soon" channels; set on create, never patched.
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  // Small kicker — "Newsletter", "Podcast", "News outlet", etc.
  category: text("category").notNull().default(""),
  status: distributionChannelStatusEnum("status").notNull().default("soon"),
  // External link target (http/https), when the card just links out.
  href: text("href"),
  // One of the code-backed detail views, or NULL. Validated in the route.
  outlet: text("outlet"),
  // Highlights the card as the primary channel (the newsletter).
  isPrimary: boolean("is_primary").notNull().default(false),
  // Ascending display order in the grid; ties broken by id.
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type DistributionChannel =
  typeof distributionChannelsTable.$inferSelect;
