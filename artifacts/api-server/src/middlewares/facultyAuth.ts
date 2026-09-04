import type { Request, Response, NextFunction } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  facultyUsersTable,
  facultyMembershipsTable,
  pillarsTable,
  type FacultyUser,
  type FacultyMembership,
} from "@workspace/db";

export interface FacultyAuthContext {
  user: FacultyUser;
  memberships: FacultyMembership[];
}

/**
 * Hard-coded allowlist of emails that are auto-promoted to
 * `is_platform_admin = "true"` on every sign-in (idempotent).
 *
 * This is the production bootstrap path: rather than running a one-off
 * seed against the production database (which the agent cannot do — prod
 * SQL is read-only from outside the deployed app), the middleware itself
 * upgrades these accounts the moment they sign in. Works identically in
 * dev and prod, and is safe to re-run forever.
 *
 * Keep this list TINY — it only exists for the founding team.
 */
export const AUTO_PLATFORM_ADMIN_EMAILS = new Set<string>([
  "kdegani@stanford.edu",
]);

/**
 * Named Faculty accounts that may open the read-only pillar-data inventory.
 *
 * This is intentionally separate from platform-admin promotion. The inventory
 * helps Stanford IT understand the pillar → steward → source pipeline, but it
 * does not grant destructive roster, pillar, or publication controls.
 */
export const PILLAR_DATA_ADMIN_EMAILS = new Set<string>([
  "kdegani@stanford.edu",
]);

export function isPillarDataAdmin(
  user: Pick<FacultyUser, "email" | "isPlatformAdmin">,
): boolean {
  return PILLAR_DATA_ADMIN_EMAILS.has(user.email.trim().toLowerCase());
}

/**
 * Hard-coded allowlist of email → pillar memberships granted on every
 * sign-in (idempotent). Same prod-bootstrap rationale as
 * AUTO_PLATFORM_ADMIN_EMAILS: lets founding stewards self-provision the
 * moment they sign in to production, since the agent cannot write to the
 * prod DB from outside the deployed app.
 *
 * Each entry adds the listed memberships if missing; existing memberships
 * are NEVER downgraded or replaced. Keep this list TINY.
 */
export const AUTO_STEWARD_MEMBERSHIPS: Record<
  string,
  Array<{
    pillarSlug: string;
    role: "steward" | "contributor" | "advisor" | "viewer";
  }>
> = {
  "akluger@stanford.edu": [{ pillarSlug: "communication", role: "steward" }],
  // Matt Abrahams — steward of the Strategic Communication pillar.
  "abrahams_matt@gsb.stanford.edu": [
    { pillarSlug: "strategic-communication", role: "steward" },
  ],
  // Michael Fredericson — steward of the Movement pillar.
  "mfred2@stanford.edu": [{ pillarSlug: "movement", role: "steward" }],
  // Anne Friedlander — co-steward of the Movement pillar.
  "friedlan@stanford.edu": [{ pillarSlug: "movement", role: "steward" }],
  // Karen Parker — steward of the Autism pillar.
  "kjparker@stanford.edu": [{ pillarSlug: "autism", role: "steward" }],
  // Jamie Zeitzer — steward of the Sleep pillar. This is the single canonical
  // account he signs in with; faculty self-registration doesn't grant a steward
  // role, so this allowlist provisions it on sign-in. The older dotted-email
  // account (jamie.zeitzer@stanford.edu) has been consolidated onto this one and
  // its Sleep role is revoked below.
  "jzeitzer@stanford.edu": [{ pillarSlug: "sleep", role: "steward" }],
  // Karan Dehghani — the Stanford account is the single canonical steward
  // identity for the combined AI Lab pillar.
  "kdegani@stanford.edu": [
    { pillarSlug: "slm-ai-lab", role: "steward" },
  ],
};

/**
 * Hard-coded allowlist of email → memberships to REVOKE on every sign-in.
 * Symmetric to AUTO_STEWARD_MEMBERSHIPS: the only agent-safe way to remove a
 * membership from the prod DB (which the agent cannot write from outside the
 * deployed app) is to delete it the moment the affected user signs in.
 *
 * Value is `"*"` to remove ALL of the user's memberships, or a list of pillar
 * slugs to remove only those. Idempotent — deleting an already-absent
 * membership is a no-op. Keep this list TINY.
 */
const AUTO_REVOKE_MEMBERSHIPS: Record<string, "*" | string[]> = {
  // Nicole Knauber — previously held read-only `viewer` access to every
  // pillar. Revoked so she no longer surfaces across stewards' pillars.
  "nknauber@gmail.com": "*",
  // Allison Demo — a retired demo/preview account that was a steward of the
  // Communication pillar. Revoked so it no longer surfaces as a faculty
  // member; the real Allison Kluger (akluger@stanford.edu) stewards that
  // pillar.
  "demo-allison@palonur.com": "*",
  // Matt Abrahams stewards ONLY the Strategic Communication pillar
  // (auto-granted above). He was previously also a steward of the broader
  // `communication` pillar (Allison Kluger's); revoke that so he sees only
  // strategic-communication.
  "abrahams_matt@gsb.stanford.edu": ["communication"],
  // Jamie Zeitzer (older DUPLICATE account, dotted email) — Jamie is
  // consolidated onto jzeitzer@stanford.edu (granted Sleep steward above), so
  // strip this duplicate's Sleep steward role to leave a single Jamie. NOTE:
  // like all revokes, this only fires when THIS account itself signs in; if it
  // is never used again the row lingers and an admin must remove it directly.
  "jamie.zeitzer@stanford.edu": ["sleep"],
  // Karan (Palonur operator main account) — was a demo steward of multiple
  // pillars. The Stanford account is now the sole AI Lab steward identity, so
  // every operator/legacy account holds NO pillar stewardships.
  "karan@palonur.com": "*",
  "karan+slm@palonur.com": "*",
  "kdegani@gmail.com": "*",
  // Remove the two superseded split-pillar assignments after granting the
  // canonical combined AI Lab above.
  "kdegani@stanford.edu": ["ai-leadership", "ai-education"],
};

/**
 * Superseded pillars to hide after a canonical steward signs in. Development
 * cleanup deletes empty rows outright; production uses this non-destructive
 * path so an unexpected historical reference can never break sign-in.
 */
export const AUTO_RETIRE_PILLARS: Record<string, string[]> = {
  "kdegani@stanford.edu": ["ai-leadership", "ai-education"],
};

/**
 * Retired faculty accounts that should never appear in the admin roster
 * (`GET /api/faculty/admin/members`). These are demo/preview logins, not real
 * people — hiding them keeps the roster to actual faculty. Emails are matched
 * case-insensitively. Keep this list TINY.
 */
export const HIDDEN_FACULTY_EMAILS = new Set<string>([
  "demo-allison@palonur.com",
  // Palonur platform operator accounts — real, but not Stanford faculty
  // (platform admins, not pillar stewards); hiding them keeps the roster to
  // actual Stanford Lifestyle Medicine faculty.
  "karan@palonur.com",
  "kdegani@gmail.com",
  // Jamie Zeitzer's older DUPLICATE account (dotted email). Jamie is the single
  // canonical Sleep steward via jzeitzer@stanford.edu; this duplicate's Sleep
  // role is auto-revoked above, but the lingering row kept surfacing in the
  // roster. Hide it so only the canonical jzeitzer@stanford.edu account shows.
  "jamie.zeitzer@stanford.edu",
  // Internal custodian account — automatically added as co-steward when a real
  // steward is archived. System-only placeholder; not a real faculty member.
  "custodian@palonur.com",
]);

/**
 * True if a faculty email should be hidden from the admin roster and pillar
 * faculty counts. Hides accounts in the explicit {@link HIDDEN_FACULTY_EMAILS}
 * allowlist OR any address on the reserved `@example.com` test domain. The api-
 * server test suites mint timestamped `@example.com` accounts each run, so an
 * exact-match allowlist can never catch them; `@example.com` is reserved for
 * tests/docs (RFC 2606), so no real faculty can legitimately use it. Matching
 * is case-insensitive.
 */
export function isHiddenFacultyEmail(email: string): boolean {
  const normalized = email.toLowerCase();
  return (
    HIDDEN_FACULTY_EMAILS.has(normalized) || normalized.endsWith("@example.com")
  );
}

/**
 * Pillar rows that must exist for the auto-steward allowlist to resolve.
 *
 * Same prod-bootstrap rationale as the allowlists above: the agent cannot
 * write the prod DB from outside the deployed app, so when an allowlisted
 * steward signs in we idempotently ensure their pillar row exists before
 * granting membership. Existing pillars are NEVER modified. Only pillars
 * referenced by AUTO_STEWARD_MEMBERSHIPS that may not already be seeded
 * need an entry here.
 */
export const AUTO_PILLAR_DEFINITIONS: Record<
  string,
  { name: string; description: string }
> = {
  "strategic-communication": {
    name: "Strategic Communication",
    description:
      "Stanford-attributable strategic communication science — Matt Abrahams",
  },
  autism: {
    name: "Autism",
    description:
      "Stanford-attributable autism & behavioral science — Karen Parker",
  },
  "slm-ai-lab": {
    name: "AI Lab for Education and Leadership",
    description:
      "Artificial intelligence for education, scientific literacy, institutional leadership, and accountable decision-making.",
  },
};

/**
 * Route groups an ASLM-channel member (faculty_users.registration_channel =
 * 'aslm') may NOT reach. Those members get a trimmed portal — Workspace and
 * Pillar Settings only — so the API mirrors that by rejecting the hidden
 * groups. The list is deliberately conservative: shared essentials (auth,
 * profile, pillar library/settings, voice, evals, frameworks) keep working;
 * only the clearly-hidden surfaces are denied. Platform admins are always
 * exempt.
 */
export const ASLM_BLOCKED_PATH_PREFIXES = [
  "/api/faculty/ai-visibility",
  "/api/faculty/cross-pillar",
  "/api/faculty/decision-room",
  "/api/faculty/admin",
  "/api/faculty/evals",
  "/api/faculty/newsletter-offers",
  "/api/faculty/newsletter-credits",
  "/api/faculty/publication",
  "/api/faculty/distribution-channels",
  "/api/faculty/channel-interest",
  "/api/faculty/communication-offers",
  "/api/faculty/parentdata-offers",
  "/api/faculty/parentdata-calls",
] as const;

/** True when an ASLM-channel member must be denied this pathname. */
export function isAslmBlockedPath(pathname: string): boolean {
  return ASLM_BLOCKED_PATH_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

import type { Pillar } from "@workspace/db";

export type FacultyRequest = Request & {
  faculty?: FacultyAuthContext;
  pillar?: Pillar;
  pillarRole?: "steward" | "contributor" | "advisor" | "viewer" | null;
  /**
   * Set when a platform admin is previewing another member's portal via the
   * `x-faculty-view-as` header. Holds the REAL admin's user id (for logging);
   * `req.faculty` is swapped to the previewed member's context.
   */
  viewAsAdminUserId?: number;
};

/**
 * Middleware that requires a valid Clerk session and resolves the faculty
 * user + membership context once per request.
 *
 * On first sign-in for a Clerk user, a row is created in `faculty_users`
 * mirroring the Clerk user_id. Memberships start empty — the user lands
 * on the "awaiting invitation" screen until a steward invites them.
 */
export async function requireFacultyAuth(
  req: FacultyRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = getAuth(req);
  const clerkUserId = auth?.userId;
  if (!clerkUserId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    let [user] = await db
      .select()
      .from(facultyUsersTable)
      .where(eq(facultyUsersTable.clerkUserId, clerkUserId));

    if (!user) {
      // Resolve email(s) + name from Clerk so we can either (a) reconcile a
      // pre-seeded placeholder row keyed by email, or (b) mirror a fresh row.
      let primaryEmail = "";
      const candidateEmails: string[] = [];
      let fullName: string | null = null;
      try {
        const clerkUser = await clerkClient.users.getUser(clerkUserId);
        primaryEmail = (
          clerkUser.primaryEmailAddress?.emailAddress ??
          clerkUser.emailAddresses[0]?.emailAddress ??
          ""
        ).toLowerCase();
        // Consider every email address Clerk knows about — admins may have
        // seeded the placeholder against a non-primary address.
        for (const e of clerkUser.emailAddresses ?? []) {
          const addr = e.emailAddress?.toLowerCase();
          if (addr && !candidateEmails.includes(addr)) {
            candidateEmails.push(addr);
          }
        }
        if (primaryEmail && !candidateEmails.includes(primaryEmail)) {
          candidateEmails.unshift(primaryEmail);
        }
        const first = clerkUser.firstName ?? "";
        const last = clerkUser.lastName ?? "";
        const composed = `${first} ${last}`.trim();
        fullName = composed.length > 0 ? composed : null;
      } catch (e) {
        req.log.warn({ err: e }, "Failed to fetch Clerk user");
      }

      // Reconciliation: the admin script seeds steward placeholders with
      // clerk_user_id = `pending:<email>`. On first real sign-in matching
      // any of the Clerk user's emails, upgrade the placeholder in place
      // so the pre-seeded memberships (which reference user.id) transfer
      // automatically to the real Clerk identity.
      if (candidateEmails.length > 0) {
        // candidateEmails are lowercased, but a placeholder may have been
        // seeded with a mixed-case email — match case-insensitively or the
        // reconciliation silently misses and a duplicate membership-less
        // account is created (user lands on "awaiting invitation").
        const placeholderIds = candidateEmails.map((e) => `pending:${e}`);
        // Find every matching placeholder. Normally there is exactly one,
        // but an admin could have seeded the same person against multiple
        // email addresses — handle that without violating the
        // clerk_user_id unique constraint.
        const matches = await db
          .select()
          .from(facultyUsersTable)
          .where(
            inArray(
              sql`lower(${facultyUsersTable.clerkUserId})`,
              placeholderIds,
            ),
          );

        if (matches.length > 0) {
          // Prefer the placeholder that matches the user's primary email,
          // otherwise pick the lowest-id (oldest) row deterministically.
          const primaryPlaceholder = `pending:${primaryEmail}`;
          const survivor =
            matches.find(
              (m) => m.clerkUserId.toLowerCase() === primaryPlaceholder,
            ) ?? matches.slice().sort((a, b) => a.id - b.id)[0];

          // Move any memberships from the soon-to-be-deleted duplicates
          // onto the survivor, respecting the (user_id, pillar_id)
          // unique index by skipping pillars the survivor already covers.
          const duplicateIds = matches
            .filter((m) => m.id !== survivor.id)
            .map((m) => m.id);
          if (duplicateIds.length > 0) {
            req.log.warn(
              {
                clerkUserId,
                duplicatePlaceholderIds: duplicateIds,
                survivorId: survivor.id,
              },
              "Multiple pending faculty_user placeholders matched; merging",
            );
            const survivorMemberships = await db
              .select()
              .from(facultyMembershipsTable)
              .where(eq(facultyMembershipsTable.userId, survivor.id));
            const survivorPillarIds = new Set(
              survivorMemberships.map((m) => m.pillarId),
            );
            const dupMemberships = await db
              .select()
              .from(facultyMembershipsTable)
              .where(inArray(facultyMembershipsTable.userId, duplicateIds));
            for (const m of dupMemberships) {
              if (survivorPillarIds.has(m.pillarId)) {
                // Survivor already has access to this pillar; drop the dup.
                await db
                  .delete(facultyMembershipsTable)
                  .where(eq(facultyMembershipsTable.id, m.id));
              } else {
                await db
                  .update(facultyMembershipsTable)
                  .set({ userId: survivor.id })
                  .where(eq(facultyMembershipsTable.id, m.id));
                survivorPillarIds.add(m.pillarId);
              }
            }
            await db
              .delete(facultyUsersTable)
              .where(inArray(facultyUsersTable.id, duplicateIds));
          }

          const [upgraded] = await db
            .update(facultyUsersTable)
            .set({
              clerkUserId,
              fullName: fullName ?? undefined,
              email: primaryEmail || survivor.email,
            })
            .where(eq(facultyUsersTable.id, survivor.id))
            .returning();
          if (upgraded) {
            user = upgraded;
            req.log.info(
              {
                facultyUserId: upgraded.id,
                clerkUserId,
                email: upgraded.email,
              },
              "Reconciled placeholder faculty_user with Clerk identity",
            );
          }
        }
      }

      if (!user) {
        [user] = await db
          .insert(facultyUsersTable)
          .values({
            clerkUserId,
            email: primaryEmail,
            fullName,
          })
          .returning();
      }
    }

    // Deactivated members have NO access. Skip every auto-grant/auto-promote
    // path below (so an admin's removal is never silently re-granted via the
    // steward/admin allowlists) and reject the request. The faculty_users row
    // is deliberately preserved for content provenance; only an admin
    // reactivation restores access. This is the local backstop for the Clerk
    // sign-in ban, which is best-effort and may not have applied.
    if (user.deactivatedAt) {
      req.log.info(
        { facultyUserId: user.id, email: user.email },
        "Rejected request for deactivated faculty user",
      );
      res.status(403).json({ error: "This account has been deactivated." });
      return;
    }

    // Archived (on-leave) members have their portal SUSPENDED server-side,
    // not just visually. The only endpoint an archived member may reach is
    // GET /api/faculty/me — the minimal read the "on leave" screen needs
    // (it returns `archived: true` so the client renders that screen).
    // Every other faculty API — reads and writes alike — is rejected with a
    // dedicated `archived` error until an admin restores the account.
    // Note this check runs on the REAL caller before the admin view-as swap
    // below, so a platform admin previewing an archived member's portal is
    // unaffected. Unlike deactivation, the Clerk account stays active and
    // memberships are preserved; restore instantly resumes access.
    if (user.archivedAt) {
      const pathname = (req.originalUrl ?? "").split("?")[0];
      const allowed =
        req.method === "GET" && /^\/api\/faculty\/me\/?$/.test(pathname);
      if (!allowed) {
        req.log.info(
          { facultyUserId: user.id, email: user.email, path: pathname },
          "Rejected request for archived faculty user",
        );
        res.status(403).json({
          error:
            "This account is on leave. Portal access is suspended until an administrator restores it.",
          archived: true,
        });
        return;
      }
    }

    // The allowlist is authoritative at request time, in both directions.
    // This prevents a stale historical DB flag from granting any admin bypass.
    // Demotion deliberately touches only faculty_users: explicit pillar
    // memberships remain intact.
    const shouldBePlatformAdmin =
      !!user.email &&
      AUTO_PLATFORM_ADMIN_EMAILS.has(user.email.trim().toLowerCase());
    const effectiveAdminFlag = shouldBePlatformAdmin ? "true" : "false";
    if (user.isPlatformAdmin !== effectiveAdminFlag) {
      const [updatedAdmin] = await db
        .update(facultyUsersTable)
        .set({ isPlatformAdmin: effectiveAdminFlag })
        .where(eq(facultyUsersTable.id, user.id))
        .returning();
      if (updatedAdmin) {
        user = updatedAdmin;
        req.log.info(
          {
            facultyUserId: user.id,
            email: user.email,
            isPlatformAdmin: effectiveAdminFlag,
          },
          shouldBePlatformAdmin
            ? "Auto-promoted faculty_user to platform admin via allowlist"
            : "Demoted non-allowlisted faculty_user with stale platform admin flag",
        );
      }
    }

    let memberships = await db
      .select()
      .from(facultyMembershipsTable)
      .where(eq(facultyMembershipsTable.userId, user.id));

    // Auto-grant pillar memberships from the steward allowlist. Idempotent:
    // only inserts memberships that don't already exist; never downgrades
    // or modifies an existing role.
    const stewardGrants = user.email
      ? AUTO_STEWARD_MEMBERSHIPS[user.email.toLowerCase()]
      : undefined;
    if (stewardGrants && stewardGrants.length > 0) {
      const existingPillarIds = new Set(memberships.map((m) => m.pillarId));
      const wantedSlugs = stewardGrants.map((g) => g.pillarSlug);
      const pillars = await db
        .select()
        .from(pillarsTable)
        .where(inArray(pillarsTable.slug, wantedSlugs));
      const slugToPillar = new Map(pillars.map((p) => [p.slug, p]));

      // Prod bootstrap: ensure any allowlisted pillar that has a definition
      // exists before granting membership.
      for (const slug of wantedSlugs) {
        const def = AUTO_PILLAR_DEFINITIONS[slug];
        if (!def) continue;
        const existing = slugToPillar.get(slug);
        if (existing) {
          // The consolidated AI Lab name is product identity, not editable
          // research content. Keep it canonical across existing deployments.
          if (
            slug === "slm-ai-lab" &&
            (existing.name !== def.name ||
              existing.description !== def.description)
          ) {
            const [updated] = await db
              .update(pillarsTable)
              .set({ name: def.name, description: def.description })
              .where(eq(pillarsTable.id, existing.id))
              .returning();
            if (updated) slugToPillar.set(slug, updated);
          }
          continue;
        }
        const [created] = await db
          .insert(pillarsTable)
          .values({ slug, name: def.name, description: def.description })
          .onConflictDoNothing({ target: pillarsTable.slug })
          .returning();
        const row =
          created ??
          (
            await db
              .select()
              .from(pillarsTable)
              .where(eq(pillarsTable.slug, slug))
          )[0];
        if (row) {
          slugToPillar.set(slug, row);
          req.log.info(
            { pillarSlug: slug, facultyUserId: user.id },
            "Auto-provisioned pillar row for allowlisted steward",
          );
        }
      }
      // Un-retire any allowlisted steward pillar that was previously
      // soft-retired. A steward signing in is the authoritative signal that
      // their pillar is active again; the canonical boot seed (ON CONFLICT DO
      // NOTHING) cannot clear `retired_at` on an existing row, so we do it
      // here. Idempotent — only touches rows that are actually retired.
      for (const slug of wantedSlugs) {
        const pillar = slugToPillar.get(slug);
        if (pillar && pillar.retiredAt != null) {
          await db
            .update(pillarsTable)
            .set({ retiredAt: null })
            .where(eq(pillarsTable.id, pillar.id));
          pillar.retiredAt = null;
          req.log.info(
            { pillarSlug: slug, facultyUserId: user.id },
            "Un-retired pillar for allowlisted steward",
          );
        }
      }
      let inserted = 0;
      for (const grant of stewardGrants) {
        const pillar = slugToPillar.get(grant.pillarSlug);
        if (!pillar) {
          req.log.warn(
            { pillarSlug: grant.pillarSlug, email: user.email },
            "Auto-steward grant skipped: pillar slug not found",
          );
          continue;
        }
        if (existingPillarIds.has(pillar.id)) continue;
        await db.insert(facultyMembershipsTable).values({
          userId: user.id,
          pillarId: pillar.id,
          role: grant.role,
        });
        inserted++;
      }
      if (inserted > 0) {
        req.log.info(
          { facultyUserId: user.id, email: user.email, inserted },
          "Auto-granted faculty pillar memberships via allowlist",
        );
        memberships = await db
          .select()
          .from(facultyMembershipsTable)
          .where(eq(facultyMembershipsTable.userId, user.id));
      }
    }

    // Auto-revoke memberships from the revoke allowlist. Idempotent: deletes
    // only the listed memberships (or all of them for `"*"`), never errors when
    // already absent. Symmetric prod-bootstrap to the grant path above.
    const revoke = user.email
      ? AUTO_REVOKE_MEMBERSHIPS[user.email.toLowerCase()]
      : undefined;
    if (revoke && memberships.length > 0) {
      let revokeIds: number[];
      if (revoke === "*") {
        revokeIds = memberships.map((m) => m.pillarId);
      } else {
        const wanted = new Set(revoke);
        const pillars = await db
          .select()
          .from(pillarsTable)
          .where(inArray(pillarsTable.slug, revoke));
        const ids = new Set(
          pillars.filter((p) => wanted.has(p.slug)).map((p) => p.id),
        );
        revokeIds = memberships
          .map((m) => m.pillarId)
          .filter((id) => ids.has(id));
      }
      if (revokeIds.length > 0) {
        await db
          .delete(facultyMembershipsTable)
          .where(
            and(
              eq(facultyMembershipsTable.userId, user.id),
              inArray(facultyMembershipsTable.pillarId, revokeIds),
            ),
          );
        req.log.info(
          {
            facultyUserId: user.id,
            email: user.email,
            revoked: revokeIds.length,
          },
          "Auto-revoked faculty pillar memberships via allowlist",
        );
        memberships = await db
          .select()
          .from(facultyMembershipsTable)
          .where(eq(facultyMembershipsTable.userId, user.id));
      }
    }

    const retireSlugs = user.email
      ? AUTO_RETIRE_PILLARS[user.email.toLowerCase()]
      : undefined;
    if (retireSlugs && retireSlugs.length > 0) {
      await db
        .update(pillarsTable)
        .set({
          retiredAt: sql`COALESCE(${pillarsTable.retiredAt}, NOW())`,
        })
        .where(inArray(pillarsTable.slug, retireSlugs));
    }

    req.faculty = { user, memberships };

    // Auto-mint the palonur_admin signed cookie for platform admins so their
    // browser session is recognised as admin on consumer-facing routes (e.g.
    // the sleep-agent paywall bypass) without a separate password login.
    // Idempotent: re-sets the cookie on every faculty request so it stays fresh.
    if (user.isPlatformAdmin === "true") {
      res.cookie("palonur_admin", "1", {
        signed: true,
        httpOnly: true,
        sameSite: "strict",
        maxAge: 8 * 60 * 60 * 1000, // 8 hours — matches /admin-auth
      });
    }

    // ---- Admin "view as" (read-only preview) -------------------------
    // A platform admin can preview another member's portal exactly as that
    // member sees it. Honored ONLY on GET requests (writes always run as the
    // real admin) and ONLY when the real caller is a platform admin — any
    // other caller's header is ignored, so there is no privilege escalation.
    const viewAsHeader = req.header("x-faculty-view-as");
    if (
      viewAsHeader &&
      req.method === "GET" &&
      user.isPlatformAdmin === "true"
    ) {
      const targetId = parseInt(viewAsHeader, 10);
      if (!Number.isNaN(targetId) && targetId !== user.id) {
        const [target] = await db
          .select()
          .from(facultyUsersTable)
          .where(eq(facultyUsersTable.id, targetId));
        if (target) {
          const targetMemberships = await db
            .select()
            .from(facultyMembershipsTable)
            .where(eq(facultyMembershipsTable.userId, target.id));
          req.viewAsAdminUserId = user.id;
          req.faculty = { user: target, memberships: targetMemberships };
          req.log.info(
            {
              viewAsAdminUserId: user.id,
              targetUserId: target.id,
              method: req.method,
              path: req.path,
            },
            "Admin view-as preview",
          );
        }
      }
    }

    // ---- ASLM-channel trimmed portal (server-side mirror) --------------
    // Members who registered via AskLifestyleMedicine see only Workspace and
    // Pillar Settings; the hidden route groups are denied here so the
    // restriction isn't UI-only. Checked on the EFFECTIVE context (so an
    // admin's view-as preview of an ASLM member behaves like that member);
    // platform admins themselves are never restricted.
    const effective = req.faculty!.user;
    if (
      effective.registrationChannel === "aslm" &&
      effective.isPlatformAdmin !== "true"
    ) {
      const pathname = (req.originalUrl ?? "").split("?")[0];
      if (isAslmBlockedPath(pathname)) {
        req.log.info(
          { facultyUserId: effective.id, path: pathname },
          "Denied hidden route group for ASLM-channel member",
        );
        res.status(403).json({
          error: "This area isn't part of your portal.",
          aslmRestricted: true,
        });
        return;
      }
    }

    next();
  } catch (e) {
    req.log.error({ err: e }, "Faculty auth resolution failed");
    res.status(500).json({ error: "Auth resolution failed" });
  }
}

type AllowedRole = "steward" | "contributor" | "advisor" | "viewer";

/**
 * Centralized pillar authorization. Resolves the pillar from either an
 * `:id` numeric route param or a `:slug` route param, looks up the
 * caller's membership once (already loaded by `requireFacultyAuth`), and
 * enforces that the membership role is in `allowedRoles`. Platform admins
 * bypass the check.
 *
 * On success, attaches `req.pillar` so handlers can read the resolved row
 * without a second DB hit.
 */
export function requirePillarRole(
  source: { idParam?: string; slugParam?: string },
  allowedRoles: AllowedRole[],
) {
  return async (
    req: FacultyRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const ctx = req.faculty;
    if (!ctx) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { pillarsTable } = await import("@workspace/db");
    let pillar: typeof pillarsTable.$inferSelect | undefined;
    if (source.idParam) {
      const raw = req.params[source.idParam];
      const pillarId = parseInt(Array.isArray(raw) ? raw[0] : (raw ?? ""), 10);
      if (Number.isNaN(pillarId)) {
        res.status(400).json({ error: "Invalid pillar id" });
        return;
      }
      [pillar] = await db
        .select()
        .from(pillarsTable)
        .where(eq(pillarsTable.id, pillarId));
    } else if (source.slugParam) {
      const raw = req.params[source.slugParam];
      const slug = Array.isArray(raw) ? raw[0] : (raw ?? "");
      [pillar] = await db
        .select()
        .from(pillarsTable)
        .where(eq(pillarsTable.slug, slug));
    }

    if (!pillar) {
      res.status(404).json({ error: "Pillar not found" });
      return;
    }

    const isAdmin = ctx.user.isPlatformAdmin === "true";
    const m = ctx.memberships.find(
      (m: FacultyMembership) => m.pillarId === pillar!.id,
    );
    if (!isAdmin && (!m || !allowedRoles.includes(m.role as AllowedRole))) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    req.pillar = pillar;
    req.pillarRole = (m?.role as AllowedRole) ?? (isAdmin ? "steward" : null);
    next();
  };
}

/**
 * Variant for endpoints whose pillar identifier comes from the request
 * body (e.g. POST /faculty/invitations { pillarId }).
 */
export function requirePillarRoleFromBody(
  bodyKey: string,
  allowedRoles: AllowedRole[],
) {
  return async (
    req: FacultyRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const ctx = req.faculty;
    if (!ctx) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const raw = (req.body ?? {})[bodyKey];
    const pillarId =
      typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
    if (!Number.isFinite(pillarId)) {
      res.status(400).json({ error: `Invalid ${bodyKey}` });
      return;
    }

    const { pillarsTable } = await import("@workspace/db");
    const [pillar] = await db
      .select()
      .from(pillarsTable)
      .where(eq(pillarsTable.id, pillarId));
    if (!pillar) {
      res.status(404).json({ error: "Pillar not found" });
      return;
    }

    const isAdmin = ctx.user.isPlatformAdmin === "true";
    const m = ctx.memberships.find(
      (m: FacultyMembership) => m.pillarId === pillar.id,
    );
    if (!isAdmin && (!m || !allowedRoles.includes(m.role as AllowedRole))) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    req.pillar = pillar;
    req.pillarRole = (m?.role as AllowedRole) ?? (isAdmin ? "steward" : null);
    next();
  };
}
