/**
 * Shared helper: load lead stewards for a set of pillar IDs.
 * Used by routes/topics.ts (public topic pages) and routes/sleep-agent.ts
 * (governed-RAG done event attribution).
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { db, newsletterPublicationsTable } from "@workspace/db";
import {
  facultyMembershipsTable,
  facultyUsersTable,
} from "@workspace/db/schema/slm";
import { isHiddenFacultyEmail } from "../middlewares/facultyAuth.js";
import { isStanfordEdition } from "./features.js";

export type StewardProfile = {
  fullName: string | null;
  institution: string | null;
  photoUrl: string | null;
  achievements: string[];
  tavusReplicaId: string | null;
  publicationSlug: string | null;
  publicationName: string | null;
};

export function publicImageUrl(objectPath: string | null): string | null {
  if (!objectPath) return null;
  if (/^https?:\/\//i.test(objectPath)) return objectPath;
  if (objectPath.startsWith("/objects/")) return `/api/storage${objectPath}`;
  return null;
}

/**
 * Lead steward (earliest steward membership, hidden demo accounts skipped)
 * for each of the given pillar ids, joined with their publication when one
 * exists. Returns a map pillarId -> steward.
 */
export async function loadLeadStewards(
  pillarIds: number[],
): Promise<Map<number, StewardProfile>> {
  if (pillarIds.length === 0) return new Map();
  const baseSelection = {
    pillarId: facultyMembershipsTable.pillarId,
    email: facultyUsersTable.email,
    fullName: facultyUsersTable.fullName,
    institution: facultyUsersTable.institution,
    photoUrl: facultyUsersTable.photoUrl,
    achievements: facultyUsersTable.achievements,
    tavusReplicaId: facultyUsersTable.tavusReplicaId,
  };
  const rows = isStanfordEdition()
    ? await db
        .select({
          ...baseSelection,
          publicationSlug: sql<string | null>`NULL::text`,
          publicationName: sql<string | null>`NULL::text`,
        })
        .from(facultyMembershipsTable)
        .innerJoin(
          facultyUsersTable,
          eq(facultyUsersTable.id, facultyMembershipsTable.userId),
        )
        .where(eq(facultyMembershipsTable.role, "steward"))
        .orderBy(
          asc(facultyMembershipsTable.createdAt),
          asc(facultyMembershipsTable.id),
        )
    : await db
        .select({
          ...baseSelection,
          publicationSlug: newsletterPublicationsTable.slug,
          publicationName: newsletterPublicationsTable.name,
        })
        .from(facultyMembershipsTable)
        .innerJoin(
          facultyUsersTable,
          eq(facultyUsersTable.id, facultyMembershipsTable.userId),
        )
        .leftJoin(
          newsletterPublicationsTable,
          and(
            eq(newsletterPublicationsTable.facultyUserId, facultyUsersTable.id),
            eq(newsletterPublicationsTable.isHouse, false),
          ),
        )
        .where(eq(facultyMembershipsTable.role, "steward"))
        .orderBy(
          asc(facultyMembershipsTable.createdAt),
          asc(facultyMembershipsTable.id),
        );
  const byPillar = new Map<number, StewardProfile>();
  for (const r of rows) {
    if (!pillarIds.includes(r.pillarId)) continue;
    if (byPillar.has(r.pillarId)) continue;
    if (isHiddenFacultyEmail(r.email)) continue;
    byPillar.set(r.pillarId, {
      fullName: r.fullName,
      institution: r.institution,
      photoUrl: publicImageUrl(r.photoUrl),
      achievements: Array.isArray(r.achievements)
        ? r.achievements.filter((a) => typeof a === "string" && a.trim())
        : [],
      tavusReplicaId:
        typeof r.tavusReplicaId === "string" && r.tavusReplicaId.trim()
          ? r.tavusReplicaId.trim()
          : null,
      publicationSlug: r.publicationSlug,
      publicationName: r.publicationName,
    });
  }
  return byPillar;
}
