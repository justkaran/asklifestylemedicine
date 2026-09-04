import { slmSchemaManifest } from "@workspace/db/schema/slm";

type QueryResult<Row> = { rows: Row[] };

/** Drizzle's PostgreSQL migrator stores its journal outside the public schema. */
export const DRIZZLE_MIGRATIONS_SCHEMA = "drizzle";
export const DRIZZLE_MIGRATIONS_TABLE = "__drizzle_migrations";
export const DRIZZLE_MIGRATIONS_RELATION =
  `${DRIZZLE_MIGRATIONS_SCHEMA}.${DRIZZLE_MIGRATIONS_TABLE}` as const;

export type ReadonlyQueryable = {
  query(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Record<string, unknown>>>;
};

export type StanfordReadiness = {
  vectorInstalled: boolean;
  missingTables: string[];
  migrationJournalPresent: boolean;
  migrationCount: number;
};

type CatalogRow = {
  vector_installed: boolean;
  table_names: string[] | null;
  migration_journal_present: boolean;
};

/**
 * Reads the bounded Stanford database contract without modifying it. This is
 * intentionally separate from process startup so it can be tested without
 * process.exit and reused by operational readiness checks.
 */
export async function getStanfordDatabaseReadiness(
  db: ReadonlyQueryable,
): Promise<StanfordReadiness> {
  const catalog = await db.query(
    `SELECT
       EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS vector_installed,
       COALESCE(
          array_agg(table_name::text) FILTER (WHERE table_name IS NOT NULL),
         ARRAY[]::text[]
       ) AS table_names,
       to_regclass('${DRIZZLE_MIGRATIONS_RELATION}') IS NOT NULL AS migration_journal_present
     FROM (
       SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_type = 'BASE TABLE'
         AND table_name = ANY($1::text[])
     ) AS manifest_tables`,
    [slmSchemaManifest.tables],
  );
  const firstRow = catalog.rows[0] as CatalogRow | undefined;
  const tableNames = new Set(firstRow?.table_names ?? []);
  const migrationJournalPresent = firstRow?.migration_journal_present ?? false;
  let migrationCount = 0;

  if (migrationJournalPresent) {
    const journal = await db.query(
      `SELECT count(*)::text AS count FROM ${DRIZZLE_MIGRATIONS_RELATION}`,
    );
    migrationCount = Number(
      (journal.rows[0] as { count?: string } | undefined)?.count ?? "0",
    );
  }

  return {
    vectorInstalled: firstRow?.vector_installed ?? false,
    missingTables: slmSchemaManifest.tables.filter(
      (table) => !tableNames.has(table),
    ),
    migrationJournalPresent,
    migrationCount,
  };
}

export async function assertStanfordDatabaseReady(
  db: ReadonlyQueryable,
): Promise<void> {
  const readiness = await getStanfordDatabaseReadiness(db);
  const failures: string[] = [];
  if (!readiness.vectorInstalled)
    failures.push("the vector extension is absent");
  if (readiness.missingTables.length > 0) {
    failures.push(
      `required SLM tables are absent: ${readiness.missingTables.join(", ")}`,
    );
  }
  if (!readiness.migrationJournalPresent) {
    failures.push("the Drizzle migration journal is absent");
  } else if (readiness.migrationCount < 1) {
    failures.push("the Drizzle migration journal has no rows");
  }

  if (failures.length > 0) {
    throw new Error(
      `Stanford database readiness failed: ${failures.join("; ")}. ` +
        "Apply the approved Stanford migrations before starting the API.",
    );
  }
}
