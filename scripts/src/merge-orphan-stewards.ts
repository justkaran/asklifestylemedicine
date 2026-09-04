/**
 * One-shot backfill: merge duplicate steward accounts created before the
 * first-sign-in reconciliation fix landed.
 *
 * Background: `assign-steward` seeds a placeholder `faculty_users` row keyed
 * by `clerk_user_id = pending:<email>` (with the real pillar memberships
 * attached). On first sign-in, the auth middleware (`facultyAuth.ts`) now
 * upgrades that placeholder in place. But any steward who signed in BEFORE
 * that fix shipped already has two rows:
 *   1. the placeholder `pending:<email>` row, still holding their memberships
 *   2. a fresh row with their real Clerk id, but no memberships
 * Those people see "awaiting invitation" forever. This script finds those
 * pairs and merges them, mirroring the middleware's reconciliation logic.
 *
 * Idempotent: re-runs are safe — placeholders without a matching real row
 * are left alone.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run merge-orphan-stewards
 *   pnpm --filter @workspace/scripts run merge-orphan-stewards -- --dry-run
 */

import { eq, like } from "drizzle-orm";
import {
  db,
  facultyUsersTable,
  facultyMembershipsTable,
  pool,
} from "@workspace/db";

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");

  const placeholders = await db
    .select()
    .from(facultyUsersTable)
    .where(like(facultyUsersTable.clerkUserId, "pending:%"));

  if (placeholders.length === 0) {
    console.log("No placeholder faculty_users rows found. Nothing to merge.");
    return;
  }

  console.log(
    `Found ${placeholders.length} placeholder row(s). Scanning for real-id duplicates…`,
  );

  let mergedCount = 0;
  let membershipsMoved = 0;
  let membershipsDropped = 0;
  let skippedNoDuplicate = 0;

  for (const placeholder of placeholders) {
    const email = placeholder.email.toLowerCase();

    const candidates = await db
      .select()
      .from(facultyUsersTable)
      .where(eq(facultyUsersTable.email, email));

    const realRow = candidates.find(
      (r) => r.id !== placeholder.id && !r.clerkUserId.startsWith("pending:"),
    );

    if (!realRow) {
      skippedNoDuplicate++;
      continue;
    }

    const placeholderMemberships = await db
      .select()
      .from(facultyMembershipsTable)
      .where(eq(facultyMembershipsTable.userId, placeholder.id));

    const realMemberships = await db
      .select()
      .from(facultyMembershipsTable)
      .where(eq(facultyMembershipsTable.userId, realRow.id));

    const realPillarIds = new Set(realMemberships.map((m) => m.pillarId));

    let movedForUser = 0;
    let droppedForUser = 0;

    if (dryRun) {
      for (const m of placeholderMemberships) {
        if (realPillarIds.has(m.pillarId)) droppedForUser++;
        else {
          movedForUser++;
          realPillarIds.add(m.pillarId);
        }
      }
      console.log(
        `[dry-run] would merge placeholder #${placeholder.id} (${email}) → real #${realRow.id} ` +
          `(${realRow.clerkUserId}): move ${movedForUser}, drop ${droppedForUser} duplicate membership(s)`,
      );
    } else {
      for (const m of placeholderMemberships) {
        if (realPillarIds.has(m.pillarId)) {
          await db
            .delete(facultyMembershipsTable)
            .where(eq(facultyMembershipsTable.id, m.id));
          droppedForUser++;
        } else {
          await db
            .update(facultyMembershipsTable)
            .set({ userId: realRow.id })
            .where(eq(facultyMembershipsTable.id, m.id));
          realPillarIds.add(m.pillarId);
          movedForUser++;
        }
      }
      await db
        .delete(facultyUsersTable)
        .where(eq(facultyUsersTable.id, placeholder.id));
      console.log(
        `Merged placeholder #${placeholder.id} (${email}) → real #${realRow.id} ` +
          `(${realRow.clerkUserId}): moved ${movedForUser}, dropped ${droppedForUser} duplicate membership(s)`,
      );
    }

    mergedCount++;
    membershipsMoved += movedForUser;
    membershipsDropped += droppedForUser;
  }

  console.log("");
  console.log(
    `Summary${dryRun ? " (dry-run, no changes written)" : ""}:`,
  );
  console.log(`  placeholders examined:           ${placeholders.length}`);
  console.log(
    `  ${dryRun ? "would merge into real account: " : "merged into real account:      "}${mergedCount}`,
  );
  console.log(`  no real-id duplicate:            ${skippedNoDuplicate}`);
  console.log(
    `  memberships ${dryRun ? "would move:         " : "moved:               "}${membershipsMoved}`,
  );
  console.log(
    `  memberships ${dryRun ? "would drop (dup):   " : "dropped (dup):       "}${membershipsDropped}`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
