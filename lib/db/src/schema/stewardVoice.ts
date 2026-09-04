import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
  pgEnum,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { facultyUsersTable } from "./faculty";

/**
 * Provenance of a voice profile's *current* content. A profile is always the
 * single active, steward-approved description of how an expert speaks; this
 * records how that content was produced:
 *   - `manual`      — the steward wrote it from scratch.
 *   - `ai_distilled` — saved verbatim from an AI distillation of their corpus.
 *   - `manual_edit`  — AI-distilled, then hand-edited by the steward before saving.
 */
export const voiceProfileSourceEnum = pgEnum("voice_profile_source", [
  "manual",
  "ai_distilled",
  "manual_edit",
]);

/**
 * Per-steward "voice profile" — the structured description of how an expert
 * personally speaks, injected into the embeddable expert agent's VOICE block so
 * answers sound like that specific steward rather than a generic warm expert.
 *
 * Exactly one row per faculty user (unique FK). The row that exists is the
 * active, steward-approved profile; the embed agent reads it directly. There is
 * no draft/active split in the DB — an in-progress AI draft lives only in the
 * portal editor until the steward saves it here. Voice content NEVER licenses
 * an ungrounded claim: it shapes tone only, and the agent's citation discipline
 * is unaffected.
 */
export const facultyVoiceProfilesTable = pgTable(
  "faculty_voice_profiles",
  {
    id: serial("id").primaryKey(),
    facultyUserId: integer("faculty_user_id")
      .notNull()
      .references(() => facultyUsersTable.id, { onDelete: "cascade" }),
    /** One- or two-sentence headline of how this expert sounds. */
    toneSummary: text("tone_summary").notNull().default(""),
    /** Longer first-person "how I talk" guidance for the model. */
    guidance: text("guidance").notNull().default(""),
    /** Characteristic words/phrases the steward actually uses. */
    signaturePhrases: text("signature_phrases")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    /** Words/phrases/patterns that do NOT sound like this steward. Also fed to
     * the voice guard as banned phrasing. */
    avoidPhrases: text("avoid_phrases")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    /** When the content was AI-distilled, the provenance of that distillation:
     * { interpretationIds: number[], talkSourceIds: number[], model: string,
     *   generatedAt: string }. Null for purely manual profiles. */
    distilledFrom: jsonb("distilled_from"),
    source: voiceProfileSourceEnum("source").notNull().default("manual"),
    /** When the steward last saved/approved this profile. */
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    facultyUserUnique: uniqueIndex("faculty_voice_profiles_user_unique").on(
      t.facultyUserId,
    ),
  }),
);

export const insertVoiceProfileSchema = createInsertSchema(
  facultyVoiceProfilesTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertVoiceProfile = z.infer<typeof insertVoiceProfileSchema>;
export type VoiceProfile = typeof facultyVoiceProfilesTable.$inferSelect;
export type VoiceProfileSource = "manual" | "ai_distilled" | "manual_edit";
