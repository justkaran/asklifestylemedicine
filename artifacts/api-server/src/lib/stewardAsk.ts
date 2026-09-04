/**
 * "Ask the steward" eligibility — shared between the public publication API
 * (which decides whether to surface the Ask panel) and the email send paths
 * (which decide whether to inject the "Ask <steward> a question" CTA).
 *
 * A publication's owning steward is eligible only when BOTH hold:
 *   1. They have a published voice profile (a saved/approved
 *      `faculty_voice_profiles` row with some actual content), so the embed
 *      agent can answer in their genuine first-person voice.
 *   2. Their primary pillar has at least one approved interpretation, so a
 *      pillar-locked answer has governed material to ground in and readers
 *      don't hit an immediate dead-end "UNCOVERED".
 *
 * The "primary pillar" derivation mirrors loadStewardMeta: the steward-role,
 * non-retired pillar with the lowest id (stable when a steward owns several).
 *
 * The house (SLM) publication has no single steward (facultyUserId is null), so
 * it is never eligible — the Ask panel/CTA stay hidden there.
 */
import { eq, and, asc, isNull } from "drizzle-orm";
import {
  db,
  facultyUsersTable,
  facultyMembershipsTable,
  facultyVoiceProfilesTable,
  pillarsTable,
  interpretationsTable,
} from "@workspace/db";

export type StewardAskEligibility = {
  eligible: boolean;
  /** The pillar the embed agent must be locked to (null when not eligible). */
  pillarSlug: string | null;
  /** The steward's display name for "Ask <name>" labels (null when unknown). */
  stewardName: string | null;
};

const NOT_ELIGIBLE: StewardAskEligibility = {
  eligible: false,
  pillarSlug: null,
  stewardName: null,
};

export async function loadStewardAskEligibility(
  facultyUserId: number | null | undefined,
): Promise<StewardAskEligibility> {
  if (!facultyUserId) return NOT_ELIGIBLE;

  const [user, voice, pillar] = await Promise.all([
    db
      .select({ fullName: facultyUsersTable.fullName })
      .from(facultyUsersTable)
      .where(eq(facultyUsersTable.id, facultyUserId))
      .limit(1),
    db
      .select({
        toneSummary: facultyVoiceProfilesTable.toneSummary,
        guidance: facultyVoiceProfilesTable.guidance,
        signaturePhrases: facultyVoiceProfilesTable.signaturePhrases,
        avoidPhrases: facultyVoiceProfilesTable.avoidPhrases,
        approvedAt: facultyVoiceProfilesTable.approvedAt,
      })
      .from(facultyVoiceProfilesTable)
      .where(eq(facultyVoiceProfilesTable.facultyUserId, facultyUserId))
      .limit(1),
    db
      .select({ id: pillarsTable.id, slug: pillarsTable.slug })
      .from(facultyMembershipsTable)
      .innerJoin(
        pillarsTable,
        eq(facultyMembershipsTable.pillarId, pillarsTable.id),
      )
      .where(
        and(
          eq(facultyMembershipsTable.userId, facultyUserId),
          eq(facultyMembershipsTable.role, "steward"),
          isNull(pillarsTable.retiredAt),
        ),
      )
      .orderBy(asc(pillarsTable.id))
      .limit(1),
  ]);

  const stewardName = user[0]?.fullName?.trim() || null;
  const primaryPillar = pillar[0];
  if (!primaryPillar) return { ...NOT_ELIGIBLE, stewardName };

  // Published voice profile = a saved/approved row that actually carries voice
  // content (not an empty placeholder). Saving in the steward portal stamps
  // approvedAt, so approvedAt + any content is the "published" signal.
  const v = voice[0];
  const hasVoice = Boolean(
    v?.approvedAt &&
      ((v.toneSummary && v.toneSummary.trim()) ||
        (v.guidance && v.guidance.trim()) ||
        (v.signaturePhrases && v.signaturePhrases.length > 0) ||
        (v.avoidPhrases && v.avoidPhrases.length > 0)),
  );
  if (!hasVoice) return { ...NOT_ELIGIBLE, stewardName };

  // At least one approved interpretation in the primary pillar — the governed
  // material the pillar-locked answer grounds in.
  const approved = await db
    .select({ id: interpretationsTable.id })
    .from(interpretationsTable)
    .where(
      and(
        eq(interpretationsTable.pillarId, primaryPillar.id),
        eq(interpretationsTable.status, "approved"),
      ),
    )
    .limit(1);
  if (!approved[0]) return { ...NOT_ELIGIBLE, stewardName };

  return { eligible: true, pillarSlug: primaryPillar.slug, stewardName };
}
