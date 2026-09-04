import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  pillarsTable,
  facultyUsersTable,
  facultyMembershipsTable,
  facultyInvitationsTable,
  sourcesTable,
  interpretationsTable,
} from "@workspace/db";
import { clerkClient } from "@clerk/express";
import { isHiddenFacultyEmail } from "../middlewares/facultyAuth.js";
import { logger } from "./logger.js";
import { ROUTING_KEYWORDS } from "./pillarRouter.js";

/**
 * Shared read models for the faculty roster + pillar overview. These power BOTH
 * the Clerk-gated faculty portal admin (`/api/faculty/admin/*`) and the
 * password-gated internal Palonur admin (`/api/admin/faculty`), so the steward
 * and pillar numbers are computed in exactly one place and can never drift
 * between the two surfaces.
 */

/**
 * Best-effort view of a member's Clerk account state:
 *  - "active"  — a real Clerk account exists and is not banned or locked
 *  - "banned"  — the Clerk account is banned (sign-in blocked at Clerk)
 *  - "locked"  — the Clerk account is temporarily locked by Clerk's
 *                brute-force protection (too many failed sign-in attempts);
 *                clears on its own after the lockout window, or immediately
 *                via the admin unlock action
 *  - "unknown" — no real Clerk account (pending: placeholder / seed) or the
 *                Clerk lookup failed; never treated as an error.
 */
export type ClerkAccountStatus = "active" | "banned" | "locked" | "unknown";

export type RosterMember = {
  id: number;
  fullName: string | null;
  email: string;
  institution: string | null;
  photoUrl: string | null;
  isPlatformAdmin: boolean;
  registered: boolean;
  onboardedAt: string | null;
  deactivatedAt: string | null;
  /** When set, this member is archived (on leave). Portal shows a suspension
   * screen; Clerk account remains active; memberships preserved; custodian
   * is co-steward. Cleared by restore. */
  archivedAt: string | null;
  clerkStatus: ClerkAccountStatus;
  /**
   * True when Clerk and the local DB disagree: banned in Clerk while active
   * locally (silent lockout) or active in Clerk while removed locally (can
   * still sign in). Always false when clerkStatus is "unknown".
   */
  clerkMismatch: boolean;
  memberships: Array<{
    pillarId: number;
    pillarSlug: string;
    pillarName: string;
    role: string;
    /** True when custodian@palonur.com is currently a steward on this pillar
     * (i.e. the pillar is in a temporary handoff state after archiving). */
    isCustodianHeld: boolean;
  }>;
};

/**
 * Best-effort batched Clerk account-state lookup for a set of Clerk user ids.
 * Returns a map of clerkUserId → { banned, locked }. Ids missing from the
 * result (deleted accounts, lookup failure) stay "unknown". NEVER throws — a
 * Clerk outage must not break the roster.
 */
async function fetchClerkAccountState(
  clerkUserIds: string[],
): Promise<Map<string, { banned: boolean; locked: boolean }>> {
  const state = new Map<string, { banned: boolean; locked: boolean }>();
  const CHUNK = 100;
  for (let i = 0; i < clerkUserIds.length; i += CHUNK) {
    const chunk = clerkUserIds.slice(i, i + CHUNK);
    try {
      const page = await clerkClient.users.getUserList({
        userId: chunk,
        limit: CHUNK,
      });
      for (const u of page.data) {
        state.set(u.id, {
          banned: u.banned === true,
          locked: u.locked === true,
        });
      }
    } catch (err) {
      logger.warn(
        { err, chunkSize: chunk.length },
        "faculty roster: Clerk account-state lookup failed; statuses left unknown",
      );
    }
  }
  return state;
}

/**
 * Every faculty member (including admins and not-yet-onboarded invitees with
 * zero memberships), with their roles per pillar and onboarding status. Retired
 * demo/preview accounts in `HIDDEN_FACULTY_EMAILS` are excluded.
 *
 * When `includeClerkStatus` is true, each member is enriched with their Clerk
 * ban status (single batched lookup, best-effort — the roster loads with
 * status "unknown" if Clerk is unreachable) and a server-computed mismatch
 * flag (Clerk-banned vs. local deactivated_at disagreement).
 */
export async function getFacultyRoster(
  opts: { includeClerkStatus?: boolean } = {},
): Promise<RosterMember[]> {
  const rows = await db
    .select({
      userId: facultyUsersTable.id,
      fullName: facultyUsersTable.fullName,
      email: facultyUsersTable.email,
      institution: facultyUsersTable.institution,
      photoUrl: facultyUsersTable.photoUrl,
      isPlatformAdmin: facultyUsersTable.isPlatformAdmin,
      clerkUserId: facultyUsersTable.clerkUserId,
      onboardedAt: facultyUsersTable.onboardedAt,
      deactivatedAt: facultyUsersTable.deactivatedAt,
      archivedAt: facultyUsersTable.archivedAt,
      pillarId: pillarsTable.id,
      pillarSlug: pillarsTable.slug,
      pillarName: pillarsTable.name,
      role: facultyMembershipsTable.role,
    })
    .from(facultyUsersTable)
    .leftJoin(
      facultyMembershipsTable,
      eq(facultyMembershipsTable.userId, facultyUsersTable.id),
    )
    .leftJoin(
      pillarsTable,
      eq(pillarsTable.id, facultyMembershipsTable.pillarId),
    );

  // Compute custodian-held pillar IDs: pillars where custodian@palonur.com is
  // a steward (indicating a temporary handoff after archiving a real steward).
  // Runs as a single extra query; custodian is hidden from roster rows above.
  const custodianMemberships = await db
    .select({ pillarId: facultyMembershipsTable.pillarId })
    .from(facultyMembershipsTable)
    .innerJoin(
      facultyUsersTable,
      eq(facultyUsersTable.id, facultyMembershipsTable.userId),
    )
    .where(
      and(
        eq(facultyUsersTable.email, "custodian@palonur.com"),
        eq(facultyMembershipsTable.role, "steward"),
      ),
    );
  const custodianPillarIds = new Set(
    custodianMemberships.map((r) => r.pillarId),
  );

  const byUser = new Map<number, RosterMember>();
  const clerkIdByUser = new Map<number, string>();
  for (const r of rows) {
    let m = byUser.get(r.userId);
    if (!m) {
      m = {
        id: r.userId,
        fullName: r.fullName,
        email: r.email,
        institution: r.institution,
        photoUrl: r.photoUrl,
        isPlatformAdmin: r.isPlatformAdmin === "true",
        // A faculty_users row starts life as a `pending:<email>` placeholder
        // (seeded or invited). Its clerkUserId is rewritten to a real Clerk id
        // only after the person actually signs in, so a non-placeholder id
        // means the steward has activated/registered their account.
        registered: !r.clerkUserId.startsWith("pending:"),
        onboardedAt: r.onboardedAt ? r.onboardedAt.toISOString() : null,
        deactivatedAt: r.deactivatedAt ? r.deactivatedAt.toISOString() : null,
        archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null,
        clerkStatus: "unknown",
        clerkMismatch: false,
        memberships: [],
      };
      byUser.set(r.userId, m);
      clerkIdByUser.set(r.userId, r.clerkUserId);
    }
    if (
      r.pillarId != null &&
      r.pillarSlug != null &&
      r.pillarName != null &&
      r.role != null
    ) {
      m.memberships.push({
        pillarId: r.pillarId,
        pillarSlug: r.pillarSlug,
        pillarName: r.pillarName,
        role: r.role,
        isCustodianHeld: custodianPillarIds.has(r.pillarId),
      });
    }
  }
  const members = Array.from(byUser.values())
    .filter((m) => !isHiddenFacultyEmail(m.email))
    .sort((a, b) =>
      (a.fullName ?? a.email).localeCompare(b.fullName ?? b.email),
    );

  if (opts.includeClerkStatus) {
    // Only real (non-placeholder) Clerk ids can be looked up — pending: seeds
    // have no Clerk account and stay "unknown".
    const realIds = members
      .filter((m) => m.registered)
      .map((m) => clerkIdByUser.get(m.id))
      .filter((id): id is string => id != null);
    const stateById = await fetchClerkAccountState(realIds);
    for (const m of members) {
      const clerkId = clerkIdByUser.get(m.id);
      if (!m.registered || clerkId == null) continue;
      const state = stateById.get(clerkId);
      if (state === undefined) continue; // deleted in Clerk / lookup failed
      // Ban (permanent, admin-applied) takes precedence over a temporary
      // brute-force lockout when both are set.
      m.clerkStatus = state.banned
        ? "banned"
        : state.locked
          ? "locked"
          : "active";
      // Mismatch tracks the deliberate ban ↔ local-deactivation pairing only;
      // a temporary lockout is never a mismatch.
      m.clerkMismatch =
        (state.banned && m.deactivatedAt == null) ||
        (!state.banned && m.deactivatedAt != null);
    }
  }
  return members;
}

export type PublicPillar = {
  slug: string;
  name: string;
  description: string | null;
};

/**
 * Anonymous-friendly view of the LIVE community: every active (non-retired)
 * pillar by name + description only. Stewards are deliberately NOT surfaced
 * here yet — the signed-out faculty landing page mentions the pillars without
 * revealing who stewards them. Retired pillars are excluded.
 */
export async function getPublicPillars(): Promise<PublicPillar[]> {
  return db
    .select({
      slug: pillarsTable.slug,
      name: pillarsTable.name,
      description: pillarsTable.description,
    })
    .from(pillarsTable)
    .where(isNull(pillarsTable.retiredAt))
    .orderBy(asc(pillarsTable.name));
}

export type PillarOverview = {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  retiredAt: string | null;
  facultyCount: number;
  sourceCount: number;
  interpretationCount: number;
  pendingInviteCount: number;
  /**
   * Human-readable routing terms from the public question router
   * (`lib/pillarRouter.ts`). Empty for pillars with no keyword entry —
   * those are only reachable when no keyword matches and the router fans
   * out to all pillars. Display-only; the regexes remain the source of
   * truth for matching.
   */
  routingKeywords: string[];
};

/**
 * Every pillar in the system with its faculty count, independent of who has
 * memberships — so pillars with zero faculty assigned still appear and an admin
 * can plan coverage. Faculty counts exclude retired demo/preview accounts in
 * `HIDDEN_FACULTY_EMAILS`, matching the roster.
 */
export async function getPillarOverview(): Promise<PillarOverview[]> {
  const rows = await db
    .select({
      pillarId: pillarsTable.id,
      pillarSlug: pillarsTable.slug,
      pillarName: pillarsTable.name,
      pillarDescription: pillarsTable.description,
      pillarRetiredAt: pillarsTable.retiredAt,
      memberUserId: facultyUsersTable.id,
      memberEmail: facultyUsersTable.email,
    })
    .from(pillarsTable)
    .leftJoin(
      facultyMembershipsTable,
      eq(facultyMembershipsTable.pillarId, pillarsTable.id),
    )
    .leftJoin(
      facultyUsersTable,
      eq(facultyUsersTable.id, facultyMembershipsTable.userId),
    );

  // Content counts are gathered separately (grouped) rather than via more
  // joins, which would multiply the membership rows above and inflate counts.
  const [sourceRows, interpRows] = await Promise.all([
    db
      .select({ pillarId: sourcesTable.pillarId, c: count() })
      .from(sourcesTable)
      // Canary registry rows are excluded from faculty analytics.
      .where(eq(sourcesTable.isCanary, false))
      .groupBy(sourcesTable.pillarId),
    db
      .select({ pillarId: interpretationsTable.pillarId, c: count() })
      .from(interpretationsTable)
      .groupBy(interpretationsTable.pillarId),
  ]);
  const sourceCounts = new Map(sourceRows.map((r) => [r.pillarId, r.c]));
  const interpCounts = new Map(interpRows.map((r) => [r.pillarId, r.c]));

  // Pending invitations that haven't been accepted/revoked/expired and are
  // still within their TTL. These represent "in flight" coverage.
  const pendingInvites = await db
    .select({
      pillarId: facultyInvitationsTable.pillarId,
      email: facultyInvitationsTable.email,
    })
    .from(facultyInvitationsTable)
    .where(
      and(
        eq(facultyInvitationsTable.status, "pending"),
        sql`${facultyInvitationsTable.expiresAt} > now()`,
      ),
    );
  const pendingByPillar = new Map<number, Set<string>>();
  for (const inv of pendingInvites) {
    let s = pendingByPillar.get(inv.pillarId);
    if (!s) {
      s = new Set<string>();
      pendingByPillar.set(inv.pillarId, s);
    }
    s.add(inv.email.toLowerCase());
  }

  const byPillar = new Map<
    number,
    PillarOverview & { _users: Set<number> }
  >();
  for (const r of rows) {
    let p = byPillar.get(r.pillarId);
    if (!p) {
      p = {
        id: r.pillarId,
        slug: r.pillarSlug,
        name: r.pillarName,
        description: r.pillarDescription,
        retiredAt: r.pillarRetiredAt ? r.pillarRetiredAt.toISOString() : null,
        facultyCount: 0,
        sourceCount: sourceCounts.get(r.pillarId) ?? 0,
        interpretationCount: interpCounts.get(r.pillarId) ?? 0,
        pendingInviteCount: 0,
        routingKeywords: ROUTING_KEYWORDS[r.pillarSlug] ?? [],
        _users: new Set<number>(),
      };
      byPillar.set(r.pillarId, p);
    }
    if (
      r.memberUserId != null &&
      r.memberEmail != null &&
      !isHiddenFacultyEmail(r.memberEmail)
    ) {
      p._users.add(r.memberUserId);
    }
  }
  return Array.from(byPillar.values())
    .map(({ _users, ...p }) => ({
      ...p,
      facultyCount: _users.size,
      pendingInviteCount: pendingByPillar.get(p.id)?.size ?? 0,
    }))
    // Active pillars first, retired last, then alphabetical within each group.
    .sort((a, b) => {
      const aR = a.retiredAt ? 1 : 0;
      const bR = b.retiredAt ? 1 : 0;
      if (aR !== bR) return aR - bR;
      return a.name.localeCompare(b.name);
    });
}
