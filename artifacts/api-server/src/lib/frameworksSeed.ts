import { db, frameworksTable, pillarsTable, facultyUsersTable } from "@workspace/db";
import { and, eq, ilike } from "drizzle-orm";
import { logger } from "./logger";

/**
 * Boot seed for Allison Kluger's communication framework.
 *
 * Replit Publish migrates schema but NOT rows, so a fresh production DB has no
 * frameworks. This seed inserts Allison Kluger's real, publicly documented
 * framework (from her Stanford GSB course "Reputation Management: Strategies
 * for Successful Communicators" and its published Class Takeaways) into the
 * `communication` pillar as a published framework.
 *
 * INSERT-ONLY and idempotent: if a framework with this slug already exists in
 * the pillar (even edited or retired by the steward), the seed does nothing —
 * steward edits are never reverted on subsequent boots.
 */
const FRAMEWORK_SLUG = "reputation-is-an-echo";

export async function seedKlugerFramework(): Promise<void> {
  const [pillar] = await db
    .select({ id: pillarsTable.id })
    .from(pillarsTable)
    .where(eq(pillarsTable.slug, "communication"))
    .limit(1);
  if (!pillar) {
    logger.info("frameworks seed: no communication pillar yet, skipping");
    return;
  }

  const [existing] = await db
    .select({ id: frameworksTable.id })
    .from(frameworksTable)
    .where(
      and(
        eq(frameworksTable.pillarId, pillar.id),
        eq(frameworksTable.slug, FRAMEWORK_SLUG),
      ),
    )
    .limit(1);
  if (existing) return;

  // Link ownership to Allison's faculty account when it exists (roster seeds
  // use known stanford emails); otherwise leave NULL — decorate() falls back
  // to the pillar name.
  const [owner] = await db
    .select({ id: facultyUsersTable.id })
    .from(facultyUsersTable)
    .where(ilike(facultyUsersTable.email, "%kluger%"))
    .limit(1);

  // Note: Allison Kluger has no roster account today, so ownerUserId is
  // usually NULL and attribution falls back to the Communication pillar. If
  // her account is created later, a steward can re-publish under her name;
  // the insert-only guard intentionally never rewrites ownership.
  try {
    await insertFramework(pillar.id, owner?.id ?? null);
    logger.info("frameworks seed: published Allison Kluger's framework");
  } catch (err) {
    // Concurrent boot race: another instance inserted first. The unique
    // (pillar_id, slug) index makes the loser fail with 23505 — benign.
    if ((err as { code?: string }).code === "23505") return;
    throw err;
  }
}

async function insertFramework(
  pillarId: number,
  ownerUserId: number | null,
): Promise<void> {
  await db.insert(frameworksTable).values({
    pillarId,
    ownerUserId,
    name: "Reputation Is an Echo",
    slug: FRAMEWORK_SLUG,
    description:
      "Allison Kluger's reputation framework from her Stanford GSB course Reputation Management: Strategies for Successful Communicators. It treats your reputation as an echo: it precedes you into the room and it is what remains after you leave.",
    structure: [
      "1. Open with the echo. Name what precedes the reader into the room and what should remain after they leave. Frame the topic around the impression it creates before and after, not just the moment itself.",
      "2. Behave your way out of it. Reputations are fluid, never fixed. Give one concrete, repeatable behavior the reader can perform visibly and consistently until the new behavior becomes their norm and the old label fades.",
      "3. It's not what happens, it's how you choose to deal with it. Reframe the setback as a choice point: the same event can become a moment of disaster or a moment of impact depending on the response.",
      "4. Recover trust on four axes (after Diermeier's Trust Radar, which the course teaches for reputation repair): show empathy and take accountability; be transparent, never 'no comment'; put real expertise on the fix; and commit to a visible timetable.",
      "5. Close on leadership. Your reputation signals how you lead. Don't let someone else's bad behavior define you: stay in control, respond with compassion, and be the best version of yourself.",
    ].join("\n"),
    example:
      "A chronically late colleague can't just announce they'll be punctual — no one will believe them. Instead they arrive ten minutes early to every meeting. By the fourth or fifth meeting the old reputation fades and the new behavior has become their norm: they behaved their way out of it.",
    status: "published",
  });
}
