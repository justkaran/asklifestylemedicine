import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  db,
  interpretationsTable,
  sourcesTable,
  pillarsTable,
  facultyUsersTable,
  facultyMembershipsTable,
  buildPublicReliability,
  normalizeRubric,
  type PublicReliability,
} from "@workspace/db";

/**
 * One governed, read-only science item shown on a public publication
 * "science home". Every item is a steward-APPROVED interpretation joined to
 * its APPROVED source. The same approved-content gating the agent retrieval
 * path enforces applies here: nothing is included unless the interpretation
 * status is `approved` AND the source status is `approved`, retired pillars
 * are excluded, and the reliability badge is present ONLY when the source's
 * assessment has been steward-approved. All free-text fields are nullable so
 * the page can omit empty pieces cleanly.
 */
export interface PublicScienceItem {
  interpretationId: number;
  /** The steward's headline answer / finding. */
  finding: string;
  /** The steward's plain-language interpretation. */
  interpretation: string;
  /** The stored practical step ("ACTION"), visually distinct from the
   * finding. Null when the steward left it blank. */
  practicalStep: string | null;
  /** Limitations / what is NOT proven. Null when blank. */
  limitations: string | null;
  /** Full name of the faculty steward behind the interpretation, if known. */
  stewardName: string | null;
  /** The pillar this item belongs to (used to group on the house page). */
  pillarSlug: string;
  pillarName: string;
  /** Citation of the underlying source. */
  source: {
    id: number;
    kind: string;
    title: string;
    authors: string | null;
    year: number | null;
    journal: string | null;
    doi: string | null;
    sourceUrl: string | null;
    studyDesign: string | null;
  };
  /**
   * Steward-approved three-axis reliability of the PAPER (Rigor /
   * Reproducibility / Open Science). Present ONLY when the source's
   * assessment is approved; null otherwise. Describes the paper, never the
   * steward (no PII).
   */
  reliability: PublicReliability | null;
}

/** A pillar surfaced in the public science payload (for grouping/labels). */
export interface PublicSciencePillar {
  slug: string;
  name: string;
}

export interface PublicPillarScience {
  pillars: PublicSciencePillar[];
  items: PublicScienceItem[];
}

const EMPTY_SCIENCE: PublicPillarScience = { pillars: [], items: [] };

/**
 * Load the governed science (approved interpretations + their approved source
 * citation + reliability when assessment-approved) for a set of pillar ids.
 * Retired pillars are excluded by an `isNull(retiredAt)` join condition, so a
 * caller can pass a stale id without leaking retired content.
 */
export async function loadPillarScience(
  pillarIds: number[],
): Promise<PublicPillarScience> {
  const ids = Array.from(new Set(pillarIds.map((n) => Number(n)))).filter(
    (n) => Number.isFinite(n) && n > 0,
  );
  if (ids.length === 0) return EMPTY_SCIENCE;

  const rows = await db
    .select({
      interpretationId: interpretationsTable.id,
      answer: interpretationsTable.answer,
      interpretation: interpretationsTable.interpretation,
      notProven: interpretationsTable.notProven,
      action: interpretationsTable.action,
      updatedAt: interpretationsTable.updatedAt,
      stewardName: facultyUsersTable.fullName,
      sourceId: sourcesTable.id,
      kind: sourcesTable.kind,
      title: sourcesTable.title,
      authors: sourcesTable.authors,
      year: sourcesTable.year,
      journal: sourcesTable.journal,
      doi: sourcesTable.doi,
      sourceUrl: sourcesTable.sourceUrl,
      studyDesign: sourcesTable.studyDesign,
      assessmentStatus: sourcesTable.assessmentStatus,
      assessmentRubric: sourcesTable.assessmentRubric,
      pillarSlug: pillarsTable.slug,
      pillarName: pillarsTable.name,
    })
    .from(interpretationsTable)
    .innerJoin(
      sourcesTable,
      eq(sourcesTable.id, interpretationsTable.sourceId),
    )
    .innerJoin(pillarsTable, eq(pillarsTable.id, interpretationsTable.pillarId))
    .leftJoin(
      facultyUsersTable,
      eq(facultyUsersTable.id, interpretationsTable.authorId),
    )
    .where(
      and(
        inArray(interpretationsTable.pillarId, ids),
        eq(interpretationsTable.status, "approved"),
        eq(sourcesTable.status, "approved"),
        isNull(pillarsTable.retiredAt),
      ),
    )
    .orderBy(asc(pillarsTable.name), desc(interpretationsTable.updatedAt));

  const pillars = new Map<string, PublicSciencePillar>();
  const items: PublicScienceItem[] = rows.map((r) => {
    if (!pillars.has(r.pillarSlug)) {
      pillars.set(r.pillarSlug, { slug: r.pillarSlug, name: r.pillarName });
    }
    // Reliability is gated on steward approval of the source assessment,
    // exactly mirroring the agent retrieval path (rag.ts). No approval, no
    // badge.
    const reliability =
      r.assessmentStatus === "approved" && r.assessmentRubric
        ? buildPublicReliability(normalizeRubric(r.assessmentRubric))
        : null;
    const trim = (s: string | null): string | null => {
      const t = s?.trim();
      return t ? t : null;
    };
    return {
      interpretationId: r.interpretationId,
      finding: r.answer.trim(),
      interpretation: r.interpretation.trim(),
      practicalStep: trim(r.action),
      limitations: trim(r.notProven),
      stewardName: trim(r.stewardName),
      pillarSlug: r.pillarSlug,
      pillarName: r.pillarName,
      source: {
        id: r.sourceId,
        kind: r.kind,
        title: r.title,
        authors: r.authors,
        year: r.year,
        journal: r.journal,
        doi: r.doi,
        sourceUrl: r.sourceUrl,
        studyDesign: r.studyDesign,
      },
      reliability,
    };
  });

  return {
    pillars: Array.from(pillars.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
    items,
  };
}

/**
 * Resolve which pillar(s) a public publication should surface science for.
 *
 *   - House publication (`isHouse`): ALL non-retired pillars, so the Stanford
 *     Lifestyle Medicine newsletter aggregates approved findings across the
 *     whole programme.
 *   - Faculty publication: the owner's deterministic PRIMARY stewarded pillar
 *     (the `steward`-role, non-retired pillar with the lowest id) — the same
 *     rule `loadStewardMeta` uses for the public topic blurb, so the page
 *     stays internally consistent.
 *
 * Returns the resolved pillar ids; pass them to `loadPillarScience`.
 */
export async function resolvePublicationPillarIds(
  facultyUserId: number | null,
  isHouse: boolean,
): Promise<number[]> {
  if (isHouse) {
    const rows = await db
      .select({ id: pillarsTable.id })
      .from(pillarsTable)
      .where(isNull(pillarsTable.retiredAt));
    return rows.map((r) => r.id);
  }
  if (!facultyUserId) return [];
  const rows = await db
    .select({ id: pillarsTable.id })
    .from(facultyMembershipsTable)
    .innerJoin(pillarsTable, eq(pillarsTable.id, facultyMembershipsTable.pillarId))
    .where(
      and(
        eq(facultyMembershipsTable.userId, facultyUserId),
        eq(facultyMembershipsTable.role, "steward"),
        isNull(pillarsTable.retiredAt),
      ),
    )
    .orderBy(asc(pillarsTable.id))
    .limit(1);
  return rows.map((r) => r.id);
}
