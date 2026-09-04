import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  pgEnum,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sql } from "drizzle-orm";
import { pillarsTable, facultyUsersTable } from "./faculty";

/**
 * Bookable, revenue-shared frameworks — connective tissue across pillars.
 *
 * A pillar steward (e.g. Allison Kluger on the `communication` pillar) authors
 * named frameworks (What / So What / Now What, ADD, …). A steward in ANY OTHER
 * pillar can "apply" a published framework to rewrite an answer or article
 * draft — grounded in the owner's approved content and attributed to the owner
 * — and "book" that use, which mints a deferred revenue-share obligation that is
 * later settled out of the article's recorded revenue.
 *
 * Generalized: any pillar can own frameworks and any pillar can book them.
 */
export const frameworkStatusEnum = pgEnum("framework_status", [
  "draft",
  "published",
  "retired",
]);

export const frameworksTable = pgTable(
  "frameworks",
  {
    id: serial("id").primaryKey(),
    /** The pillar that owns the framework. */
    pillarId: integer("pillar_id")
      .notNull()
      .references(() => pillarsTable.id, { onDelete: "cascade" }),
    /** The steward who authored it (the owner credited on every booking). */
    ownerUserId: integer("owner_user_id").references(
      () => facultyUsersTable.id,
      { onDelete: "set null" },
    ),
    name: text("name").notNull(),
    /** Stable slug, unique within the owning pillar. */
    slug: text("slug").notNull(),
    /** Short description of when/why to reach for this framework. */
    description: text("description"),
    /** The structure / steps body the rewrite must follow. */
    structure: text("structure").notNull(),
    /** Optional worked example. */
    example: text("example"),
    status: frameworkStatusEnum("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    pillarIdx: index("frameworks_pillar_idx").on(t.pillarId),
    ownerIdx: index("frameworks_owner_idx").on(t.ownerUserId),
    statusIdx: index("frameworks_status_idx").on(t.status),
    pillarSlugUniq: uniqueIndex("frameworks_pillar_slug_uniq").on(
      t.pillarId,
      t.slug,
    ),
  }),
);

export const insertFrameworkSchema = createInsertSchema(frameworksTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  status: true,
});
export type InsertFramework = z.infer<typeof insertFrameworkSchema>;
export type Framework = typeof frameworksTable.$inferSelect;
export type FrameworkStatus = "draft" | "published" | "retired";

/**
 * Framework bookings + deferred revenue-share ledger (record only).
 *
 * Mirrors the newsletter credit ledger: NO money moves. A booking records that
 * a borrowing steward committed an owner's framework to a piece of work. When
 * the work's revenue is later recorded, the owner's share is computed from a
 * single admin-configured default % (snapshotted onto the row at booking time)
 * and credited to the owner.
 *
 * State machine: booked → revenue_recorded → settled.
 */
export const frameworkBookingStatusEnum = pgEnum("framework_booking_status", [
  "booked",
  "revenue_recorded",
  "settled",
]);

/** What a booking was applied to (the borrowing steward's work). */
export const frameworkBookingTargetEnum = pgEnum("framework_booking_target", [
  "interpretation",
  "newsletter_post",
  "communication_offer",
  "article",
]);

export const frameworkBookingsTable = pgTable(
  "framework_bookings",
  {
    id: serial("id").primaryKey(),
    frameworkId: integer("framework_id")
      .notNull()
      .references(() => frameworksTable.id, { onDelete: "cascade" }),
    /** Owner snapshot (the credited pillar + steward). */
    ownerPillarId: integer("owner_pillar_id")
      .notNull()
      .references(() => pillarsTable.id, { onDelete: "cascade" }),
    ownerUserId: integer("owner_user_id").references(
      () => facultyUsersTable.id,
      { onDelete: "set null" },
    ),
    /** Booker snapshot (the borrowing pillar + steward). */
    bookerPillarId: integer("booker_pillar_id")
      .notNull()
      .references(() => pillarsTable.id, { onDelete: "cascade" }),
    bookerUserId: integer("booker_user_id").references(
      () => facultyUsersTable.id,
      { onDelete: "set null" },
    ),
    /** Optional link to the borrowing steward's work. */
    targetType: frameworkBookingTargetEnum("target_type"),
    targetId: integer("target_id"),
    /** Human label for the work, snapshotted for the ledger. */
    targetTitle: text("target_title"),
    status: frameworkBookingStatusEnum("status").notNull().default("booked"),
    /** Revenue the work earned, entered manually by the steward/admin. */
    revenueCents: integer("revenue_cents"),
    /** Share % snapshotted at booking time (e.g. 15 = 15%). */
    sharePct: integer("share_pct").notNull(),
    /** Computed owner share = revenueCents * sharePct / 100. */
    ownerShareCents: integer("owner_share_cents"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revenueRecordedAt: timestamp("revenue_recorded_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    frameworkIdx: index("framework_bookings_framework_idx").on(t.frameworkId),
    ownerIdx: index("framework_bookings_owner_idx").on(t.ownerUserId),
    bookerIdx: index("framework_bookings_booker_idx").on(t.bookerUserId),
    statusIdx: index("framework_bookings_status_idx").on(t.status),
    // Idempotency: the same framework can't be booked twice against the same
    // concrete piece of work, so a re-book never double-credits the owner.
    // Bookings with no linked target (targetId IS NULL) are exempt.
    oneBookingPerTarget: uniqueIndex("framework_bookings_one_per_target")
      .on(t.frameworkId, t.targetType, t.targetId)
      .where(sql`target_id IS NOT NULL`),
  }),
);

export const insertFrameworkBookingSchema = createInsertSchema(
  frameworkBookingsTable,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  status: true,
  revenueCents: true,
  ownerShareCents: true,
  revenueRecordedAt: true,
  settledAt: true,
});
export type InsertFrameworkBooking = z.infer<
  typeof insertFrameworkBookingSchema
>;
export type FrameworkBooking = typeof frameworkBookingsTable.$inferSelect;
export type FrameworkBookingStatus = "booked" | "revenue_recorded" | "settled";
export type FrameworkBookingTarget =
  | "interpretation"
  | "newsletter_post"
  | "communication_offer"
  | "article";
