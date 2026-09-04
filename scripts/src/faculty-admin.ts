/**
 * Admin script: bootstrap pillars and assign initial stewards.
 *
 * Usage examples:
 *   pnpm --filter @workspace/scripts run faculty-admin -- create-pillar --slug sleep --name "Sleep"
 *   pnpm --filter @workspace/scripts run faculty-admin -- assign-steward --pillar sleep --email jamie@stanford.edu --name "Jamie Zeitzer"
 *   pnpm --filter @workspace/scripts run faculty-admin -- list
 *   pnpm --filter @workspace/scripts run faculty-admin -- bootstrap-sleep
 *
 * `assign-steward` creates a placeholder faculty_users row keyed by email.
 * The Clerk user_id is filled in on the user's first sign-in (the auth
 * middleware reconciles by clerk_user_id, not email — so we instead create
 * a *pre-claim* row and rely on an invitation to bind it). For v1 we use
 * a separate row with a synthetic clerk_user_id of `pending:<email>` and
 * upgrade it on first sign-in via the same email.
 */

import { and, eq } from "drizzle-orm";
import {
  db,
  pillarsTable,
  facultyUsersTable,
  facultyMembershipsTable,
  pool,
} from "@workspace/db";

type Cmd =
  | "create-pillar"
  | "assign-steward"
  | "list"
  | "bootstrap-sleep"
  | "set-platform-admin";

function parseArgs(argv: string[]): {
  cmd: Cmd;
  flags: Record<string, string>;
} {
  const [cmd, ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = rest[i + 1];
      if (val == null || val.startsWith("--")) {
        flags[key] = "true";
      } else {
        flags[key] = val;
        i++;
      }
    }
  }
  return { cmd: cmd as Cmd, flags };
}

async function createPillar(slug: string, name: string, description?: string) {
  const [existing] = await db
    .select()
    .from(pillarsTable)
    .where(eq(pillarsTable.slug, slug));
  if (existing) {
    console.log(`Pillar already exists: ${slug} (#${existing.id})`);
    return existing;
  }
  const [created] = await db
    .insert(pillarsTable)
    .values({ slug, name, description: description ?? null })
    .returning();
  console.log(`Created pillar: ${created.slug} (#${created.id})`);
  return created;
}

async function assignSteward(pillarSlug: string, email: string, name?: string) {
  const [pillar] = await db
    .select()
    .from(pillarsTable)
    .where(eq(pillarsTable.slug, pillarSlug));
  if (!pillar) throw new Error(`Pillar not found: ${pillarSlug}`);

  const lowerEmail = email.toLowerCase();
  const placeholderClerkId = `pending:${lowerEmail}`;
  let [user] = await db
    .select()
    .from(facultyUsersTable)
    .where(eq(facultyUsersTable.email, lowerEmail));
  if (!user) {
    [user] = await db
      .insert(facultyUsersTable)
      .values({
        clerkUserId: placeholderClerkId,
        email: lowerEmail,
        fullName: name ?? null,
      })
      .returning();
    console.log(`Created placeholder faculty_user for ${lowerEmail} (#${user.id})`);
  }

  const [existingMembership] = await db
    .select()
    .from(facultyMembershipsTable)
    .where(
      and(
        eq(facultyMembershipsTable.userId, user.id),
        eq(facultyMembershipsTable.pillarId, pillar.id),
      ),
    );
  if (existingMembership) {
    console.log(
      `Steward already assigned: ${lowerEmail} → ${pillar.slug} (role=${existingMembership.role})`,
    );
    return;
  }
  await db.insert(facultyMembershipsTable).values({
    userId: user.id,
    pillarId: pillar.id,
    role: "steward",
  });
  console.log(`Assigned steward: ${lowerEmail} → ${pillar.slug}`);
}

async function listAll() {
  const pillars = await db.select().from(pillarsTable);
  console.log("Pillars:");
  for (const p of pillars) {
    console.log(`  #${p.id} ${p.slug} — ${p.name}`);
  }
  const users = await db.select().from(facultyUsersTable);
  const memberships = await db.select().from(facultyMembershipsTable);
  console.log("\nFaculty users:");
  for (const u of users) {
    const ms = memberships.filter((m) => m.userId === u.id);
    const ps = ms
      .map((m) => {
        const p = pillars.find((p) => p.id === m.pillarId);
        return `${p?.slug ?? "?"}:${m.role}`;
      })
      .join(", ");
    console.log(
      `  #${u.id} ${u.email} (clerk:${u.clerkUserId}) — ${ps || "(no memberships)"}`,
    );
  }
}

async function main() {
  const { cmd, flags } = parseArgs(
    process.argv.slice(2).filter((a) => a !== "--"),
  );
  switch (cmd) {
    case "create-pillar": {
      const slug = flags.slug;
      const name = flags.name;
      if (!slug || !name) {
        throw new Error("Required: --slug --name [--description]");
      }
      await createPillar(slug, name, flags.description);
      break;
    }
    case "assign-steward": {
      const pillar = flags.pillar;
      const email = flags.email;
      if (!pillar || !email) {
        throw new Error("Required: --pillar <slug> --email <email> [--name]");
      }
      await assignSteward(pillar, email, flags.name);
      break;
    }
    case "list": {
      await listAll();
      break;
    }
    case "set-platform-admin": {
      const email = flags.email;
      if (!email) {
        throw new Error("Required: --email <email> [--name] [--off]");
      }
      const lowerEmail = email.toLowerCase();
      const target = flags.off === "true" ? "false" : "true";
      let [user] = await db
        .select()
        .from(facultyUsersTable)
        .where(eq(facultyUsersTable.email, lowerEmail));
      if (!user) {
        [user] = await db
          .insert(facultyUsersTable)
          .values({
            clerkUserId: `pending:${lowerEmail}`,
            email: lowerEmail,
            fullName: flags.name ?? null,
            isPlatformAdmin: target,
          })
          .returning();
        console.log(
          `Created placeholder faculty_user for ${lowerEmail} (#${user.id}) with is_platform_admin=${target}`,
        );
      } else {
        const updateValues: {
          isPlatformAdmin: string;
          fullName?: string;
        } = { isPlatformAdmin: target };
        if (flags.name && !user.fullName) updateValues.fullName = flags.name;
        await db
          .update(facultyUsersTable)
          .set(updateValues)
          .where(eq(facultyUsersTable.id, user.id));
        console.log(
          `Updated faculty_user #${user.id} (${lowerEmail}) is_platform_admin=${target}`,
        );
      }
      break;
    }
    case "bootstrap-sleep": {
      await createPillar(
        "sleep",
        "Sleep",
        "Stanford sleep & circadian sciences — Prof. Jamie Zeitzer",
      );
      const email = flags.email ?? "jamie@stanford.edu";
      await assignSteward("sleep", email, flags.name ?? "Jamie Zeitzer");
      break;
    }
    default:
      console.log(
        "Usage: faculty-admin <create-pillar|assign-steward|set-platform-admin|list|bootstrap-sleep> [flags]",
      );
      process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
