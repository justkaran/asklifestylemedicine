import { desc, eq } from "drizzle-orm";
import {
  db,
  knowledgeVersionChunksTable,
  knowledgeVersionsTable,
} from "@workspace/db";

export interface CurrentKnowledgeVersion {
  id: number;
  version: number;
  label: string;
}

export interface KnowledgeVersionState {
  /** A version row exists, even if its frozen material is malformed or incomplete. */
  hasPublishedVersion: boolean;
  knowledgeVersion: CurrentKnowledgeVersion | null;
}

/**
 * Lets callers distinguish an unversioned pillar (which may use its existing
 * retrieval path) from a broken published snapshot (which must fail closed).
 */
export async function getCurrentKnowledgeVersionState(
  pillarId: number,
): Promise<KnowledgeVersionState> {
  const knowledgeVersion = await getCurrentKnowledgeVersion(pillarId);
  if (knowledgeVersion) {
    return { hasPublishedVersion: true, knowledgeVersion };
  }
  const [latest] = await db
    .select({ id: knowledgeVersionsTable.id })
    .from(knowledgeVersionsTable)
    .where(eq(knowledgeVersionsTable.pillarId, pillarId))
    .orderBy(desc(knowledgeVersionsTable.version))
    .limit(1);
  return { hasPublishedVersion: Boolean(latest), knowledgeVersion: null };
}

/**
 * Reads the latest immutable snapshot that has its own frozen retrieval
 * material. A version without frozen chunks is invalid for governed answers:
 * silently falling back to mutable corpus rows would break reproducibility.
 */
export async function getCurrentKnowledgeVersion(
  pillarId: number,
): Promise<CurrentKnowledgeVersion | null> {
  const [version] = await db
    .select({
      id: knowledgeVersionsTable.id,
      version: knowledgeVersionsTable.version,
      label: knowledgeVersionsTable.label,
      snapshot: knowledgeVersionsTable.snapshot,
    })
    .from(knowledgeVersionsTable)
    .where(eq(knowledgeVersionsTable.pillarId, pillarId))
    .orderBy(desc(knowledgeVersionsTable.version))
    .limit(1);

  if (!version || !version.snapshot || typeof version.snapshot !== "object") {
    return null;
  }
  const claims = (version.snapshot as { claims?: unknown }).claims;
  if (!Array.isArray(claims)) return null;
  if (claims.length === 0) return null;
  const expectedInterpretationIds = claims
    .map((claim) =>
      claim && typeof claim === "object"
        ? Number((claim as { interpretationId?: unknown }).interpretationId)
        : NaN,
    )
    .filter((id) => Number.isInteger(id) && id > 0);
  const expectedSourceIds = claims
    .map((claim) =>
      claim && typeof claim === "object"
        ? Number((claim as { source?: { id?: unknown } }).source?.id)
        : NaN,
    )
    .filter((id) => Number.isInteger(id) && id > 0);
  if (
    expectedInterpretationIds.length !== claims.length ||
    expectedSourceIds.length !== claims.length
  ) {
    return null;
  }
  const frozenRows = await db
    .select({
      kind: knowledgeVersionChunksTable.kind,
      sourceId: knowledgeVersionChunksTable.sourceId,
      interpretationId: knowledgeVersionChunksTable.interpretationId,
    })
    .from(knowledgeVersionChunksTable)
    .where(eq(knowledgeVersionChunksTable.knowledgeVersionId, version.id));
  const sameIds = (actual: number[] | null, expected: number[]) => {
    const actualSet = new Set(actual ?? []);
    const expectedSet = new Set(expected);
    return (
      actualSet.size === expectedSet.size &&
      [...expectedSet].every((id) => actualSet.has(id))
    );
  };
  const expectedClaimSources = new Map(
    claims.map((claim) => {
      const typed = claim as {
        interpretationId: number;
        source: { id: number };
      };
      return [typed.interpretationId, typed.source.id];
    }),
  );
  const frozenInterpretationSources = new Map(
    frozenRows
      .filter(
        (row) =>
          row.kind === "interpretation" && row.interpretationId != null,
      )
      .map((row) => [row.interpretationId!, row.sourceId]),
  );
  const frozenSourceIds = frozenRows
    .filter((row) => row.kind === "source")
    .map((row) => row.sourceId);
  if (
    !sameIds([...frozenInterpretationSources.keys()], expectedInterpretationIds) ||
    !sameIds(frozenSourceIds, expectedSourceIds) ||
    frozenInterpretationSources.size !== expectedClaimSources.size ||
    [...expectedClaimSources].some(
      ([interpretationId, sourceId]) =>
        frozenInterpretationSources.get(interpretationId) !== sourceId,
    )
  ) {
    return null;
  }
  return {
    id: version.id,
    version: version.version,
    label: version.label,
  };
}
