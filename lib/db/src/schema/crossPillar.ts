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
import { interpretationsTable } from "./interpretations";
import { sourcesTable } from "./sources";

/**
 * Cross-pillar merge requests ("pull requests for science").
 *
 * A steward of the RECEIVING pillar opens a request to adopt another
 * pillar's published (approved) interpretation as an attributed,
 * additional source+interpretation in their own pillar. The OWNING
 * pillar's steward reviews and either approves (which atomically performs
 * the merge, crediting the original steward + source pillar) or declines.
 *
 * State machine: proposed → approved | declined.
 *   - `approved` means approved AND merged (done in one transaction).
 *   - The conditional `WHERE status = 'proposed'` update on review makes
 *     approve/decline idempotent: a request can never double-merge.
 */
export const crossPillarRequestStatusEnum = pgEnum(
  "cross_pillar_request_status",
  ["proposed", "approved", "declined"],
);

export const crossPillarMergeRequestsTable = pgTable(
  "cross_pillar_merge_requests",
  {
    id: serial("id").primaryKey(),
    /** The interpretation being adopted (must be `approved`). */
    sourceInterpretationId: integer("source_interpretation_id")
      .notNull()
      .references(() => interpretationsTable.id, { onDelete: "cascade" }),
    /** The pillar that owns the original interpretation. */
    sourcePillarId: integer("source_pillar_id")
      .notNull()
      .references(() => pillarsTable.id, { onDelete: "cascade" }),
    /** The pillar adopting the topic (the requester's pillar). */
    targetPillarId: integer("target_pillar_id")
      .notNull()
      .references(() => pillarsTable.id, { onDelete: "cascade" }),
    /** The steward who opened the request. */
    requesterUserId: integer("requester_user_id").references(
      () => facultyUsersTable.id,
      { onDelete: "set null" },
    ),
    status: crossPillarRequestStatusEnum("status")
      .notNull()
      .default("proposed"),
    /** Optional message from the requester to the owning steward. */
    note: text("note"),
    /** Set when declined. */
    declineReason: text("decline_reason"),
    /** Owning steward who approved/declined. */
    reviewedByUserId: integer("reviewed_by_user_id").references(
      () => facultyUsersTable.id,
      { onDelete: "set null" },
    ),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    /** The attributed source created in the target pillar on approval. */
    resultingSourceId: integer("resulting_source_id").references(
      () => sourcesTable.id,
      { onDelete: "set null" },
    ),
    /** The attributed interpretation created in the target pillar on approval. */
    resultingInterpretationId: integer(
      "resulting_interpretation_id",
    ).references(() => interpretationsTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    sourcePillarIdx: index("cpmr_source_pillar_idx").on(t.sourcePillarId),
    targetPillarIdx: index("cpmr_target_pillar_idx").on(t.targetPillarId),
    requesterIdx: index("cpmr_requester_idx").on(t.requesterUserId),
    // At most one OPEN (proposed) request per (target pillar, source
    // interpretation) — prevents a steward spamming duplicate requests for
    // the same item. Resolved (approved/declined) rows are exempt so a
    // declined request can be re-opened later.
    oneOpenPerTarget: uniqueIndex("cpmr_one_open_per_target")
      .on(t.targetPillarId, t.sourceInterpretationId)
      .where(sql`status = 'proposed'`),
  }),
);

export const insertCrossPillarMergeRequestSchema = createInsertSchema(
  crossPillarMergeRequestsTable,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  status: true,
  reviewedByUserId: true,
  reviewedAt: true,
  declineReason: true,
  resultingSourceId: true,
  resultingInterpretationId: true,
});
export type InsertCrossPillarMergeRequest = z.infer<
  typeof insertCrossPillarMergeRequestSchema
>;
export type CrossPillarMergeRequest =
  typeof crossPillarMergeRequestsTable.$inferSelect;
export type CrossPillarRequestStatus = "proposed" | "approved" | "declined";
