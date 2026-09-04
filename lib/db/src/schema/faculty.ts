import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
  pgEnum,
  uuid,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const facultyRoleEnum = pgEnum("faculty_role", [
  "steward",
  "contributor",
  "advisor",
  "viewer",
]);

export const facultyInvitationStatusEnum = pgEnum(
  "faculty_invitation_status",
  ["pending", "accepted", "revoked", "expired"],
);

export const pillarsTable = pgTable("pillars", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  // When set, the pillar is retired/hidden: it stays in the database (so its
  // existing sources, interpretations and memberships are preserved) but is no
  // longer offered as an active coverage area. Soft-retire is the safe way to
  // take a pillar out of rotation without destroying its content.
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const facultyUsersTable = pgTable("faculty_users", {
  id: serial("id").primaryKey(),
  clerkUserId: text("clerk_user_id").notNull().unique(),
  email: text("email").notNull(),
  fullName: text("full_name"),
  // Affiliation shown as a "from [Institution]" byline credit on newsletter
  // posts. Lets vetted outside researchers contribute under the SLM brand while
  // making their home institution visible. Null/empty for unset (Stanford
  // contributors who leave it blank simply render name-only).
  institution: text("institution"),
  // Object-storage path of the steward's uploaded headshot (e.g. "/objects/..."),
  // served via /api/storage<path>. Shown as the steward's face on faculty-portal
  // pillar cards. Null/empty until a steward or admin uploads one; cards fall
  // back to a tidy initials avatar.
  photoUrl: text("photo_url"),
  // Self-written, ordered list of the steward's remarkable achievements
  // (awards, notable findings, career highlights) shown in the public
  // achievements panel behind their avatar. Stored as a JSON array of short
  // strings; empty array / null both mean "none written yet". Edited only by
  // the steward themself via PATCH /api/faculty/me.
  achievements: jsonb("achievements").$type<string[]>().notNull().default([]),
  // Tavus replica id used by the /slm "Talk face-to-face" video chat so each
  // steward can have their own AI avatar face. Null/empty means "use the
  // shared default replica". Set by operators (no self-serve UI yet); the
  // avatar always states it is an AI and never claims to be the person.
  tavusReplicaId: text("tavus_replica_id"),
  isPlatformAdmin: text("is_platform_admin").notNull().default("false"),
  // How this member registered. Null = the standard faculty flow; "aslm" =
  // arrived via AskLifestyleMedicine (stamped from the accepted invitation).
  // ASLM-channel members see a trimmed portal (Workspace + Pillar Settings
  // only) — enforced both in the SPA shell and server-side in facultyAuth.
  registrationChannel: text("registration_channel"),
  onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
  // When set, the member is deactivated: all pillar access is revoked and their
  // portal sign-in is disabled (mirrored to Clerk). The row is preserved — never
  // hard-deleted — so authored sources/interpretations/voice keep their
  // authorship/provenance and citations don't break. A deactivated user is
  // excluded from active access; the auth middleware skips auto-grant/promote for
  // them so an admin's removal is never silently re-granted on next sign-in.
  deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
  // When set, the member's portal is suspended and shows an "on leave" screen,
  // but their Clerk sign-in account remains active and their pillar memberships
  // are preserved. The custodian account (custodian@palonur.com) is automatically
  // added as co-steward on each of their steward pillars at archive time. Neutral
  // and reversible — an admin restores by clearing this timestamp.
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const facultyMembershipsTable = pgTable(
  "faculty_memberships",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => facultyUsersTable.id, { onDelete: "cascade" }),
    pillarId: integer("pillar_id")
      .notNull()
      .references(() => pillarsTable.id, { onDelete: "cascade" }),
    role: facultyRoleEnum("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userPillarUnique: uniqueIndex("faculty_memberships_user_pillar_unique").on(
      t.userId,
      t.pillarId,
    ),
  }),
);

export const facultyInvitationsTable = pgTable("faculty_invitations", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  pillarId: integer("pillar_id")
    .notNull()
    .references(() => pillarsTable.id, { onDelete: "cascade" }),
  role: facultyRoleEnum("role").notNull(),
  // Optional affiliation captured at invite time; copied onto the new
  // faculty_users row when the invitee accepts (only if they don't already
  // have an institution set, so it never clobbers a self-edited value).
  institution: text("institution"),
  // Registration channel carried by the invite. Null = standard; "aslm" =
  // the invitee arrives via AskLifestyleMedicine. Copied onto the accepting
  // member's faculty_users.registration_channel (only if theirs is unset).
  registrationChannel: text("registration_channel"),
  token: uuid("token").notNull().unique().defaultRandom(),
  status: facultyInvitationStatusEnum("status").notNull().default("pending"),
  invitedByUserId: integer("invited_by_user_id").references(
    () => facultyUsersTable.id,
    { onDelete: "set null" },
  ),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Self-serve faculty application funnel. A professor who registered without an
// invitation applies here; Palonur admission (a human admin) is the quality
// gate. Statuses: applied (submitted), under_review (an admin picked it up),
// admitted (membership created), declined (with an optional warm note).
export const facultyApplicationStatusEnum = pgEnum(
  "faculty_application_status",
  ["applied", "under_review", "admitted", "declined"],
);

export const facultyApplicationsTable = pgTable(
  "faculty_applications",
  {
    id: serial("id").primaryKey(),
    // One application per faculty user (enforced by unique index below).
    userId: integer("user_id")
      .notNull()
      .references(() => facultyUsersTable.id, { onDelete: "cascade" }),
    institution: text("institution").notNull(),
    // Their field / area of expertise in their own words.
    field: text("field").notNull(),
    // Link to their work: faculty profile, publications page, lab site, etc.
    workUrl: text("work_url"),
    // The institutional email they claim (may differ from their Clerk email).
    // Ownership is proven by clicking a link sent to this address.
    institutionalEmail: text("institutional_email").notNull(),
    institutionalEmailVerifiedAt: timestamp(
      "institutional_email_verified_at",
      { withTimezone: true },
    ),
    verificationToken: uuid("verification_token").notNull().defaultRandom(),
    verificationExpiresAt: timestamp("verification_expires_at", {
      withTimezone: true,
    }).notNull(),
    status: facultyApplicationStatusEnum("status").notNull().default("applied"),
    // Optional warm note shown to a declined applicant.
    declineNote: text("decline_note"),
    // Set on admission: which pillar the admin admitted them into.
    admittedPillarId: integer("admitted_pillar_id").references(
      () => pillarsTable.id,
      { onDelete: "set null" },
    ),
    decidedByUserId: integer("decided_by_user_id").references(
      () => facultyUsersTable.id,
      { onDelete: "set null" },
    ),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    userUnique: uniqueIndex("faculty_applications_user_unique").on(t.userId),
    tokenUnique: uniqueIndex("faculty_applications_token_unique").on(
      t.verificationToken,
    ),
  }),
);

// Institution-level agreement flag. A business-level fact recorded per
// institution (admin-editable) that can later gate public-facing pillar
// behavior. It never appears anywhere in a professor-facing flow.
export const institutionAgreementsTable = pgTable(
  "institution_agreements",
  {
    id: serial("id").primaryKey(),
    institution: text("institution").notNull(),
    // Text 'true'/'false' for consistency with faculty_users.is_platform_admin.
    agreementActive: text("agreement_active").notNull().default("false"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    institutionUnique: uniqueIndex("institution_agreements_institution_unique").on(
      t.institution,
    ),
  }),
);

export type FacultyApplication = typeof facultyApplicationsTable.$inferSelect;
export type InstitutionAgreement =
  typeof institutionAgreementsTable.$inferSelect;

export const insertPillarSchema = createInsertSchema(pillarsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertPillar = z.infer<typeof insertPillarSchema>;
export type Pillar = typeof pillarsTable.$inferSelect;

export const insertFacultyUserSchema = createInsertSchema(
  facultyUsersTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertFacultyUser = z.infer<typeof insertFacultyUserSchema>;
export type FacultyUser = typeof facultyUsersTable.$inferSelect;

export const insertFacultyMembershipSchema = createInsertSchema(
  facultyMembershipsTable,
).omit({ id: true, createdAt: true });
export type InsertFacultyMembership = z.infer<
  typeof insertFacultyMembershipSchema
>;
export type FacultyMembership = typeof facultyMembershipsTable.$inferSelect;

export const insertFacultyInvitationSchema = createInsertSchema(
  facultyInvitationsTable,
).omit({ id: true, token: true, createdAt: true, acceptedAt: true });
export type InsertFacultyInvitation = z.infer<
  typeof insertFacultyInvitationSchema
>;
export type FacultyInvitation = typeof facultyInvitationsTable.$inferSelect;
