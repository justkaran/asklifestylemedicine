import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import {
  migrationsDirectory,
  slmEnums,
  slmTables,
  validateMigrationFiles,
} from "./migration-files.mjs";
import { requireStanfordMigrationDatabaseUrl } from "./stanford-database-url.mjs";

const { journal } = await validateMigrationFiles();
const client = new pg.Client({
  connectionString: requireStanfordMigrationDatabaseUrl(),
  connectionTimeoutMillis: 10_000,
});

try {
  await client.connect();
  const [tableResult, enumResult] = await Promise.all([
    client.query(`
      SELECT c.relname AS name
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
       ORDER BY c.relname
    `),
    client.query(`
      SELECT t.typname AS name
        FROM pg_catalog.pg_type t
        JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public' AND t.typtype = 'e'
       ORDER BY t.typname
    `),
  ]);

  const actualTables = tableResult.rows.map((row) => row.name);
  const actualEnums = enumResult.rows.map((row) => row.name);
  let appliedHashes = [];
  let journalReadable = true;
  try {
    const result = await client.query(
      'SELECT hash FROM drizzle."__drizzle_migrations" ORDER BY created_at',
    );
    appliedHashes = result.rows.map((row) => row.hash);
  } catch (error) {
    if (error?.code !== "42P01" && error?.code !== "3F000") throw error;
    journalReadable = false;
  }

  const expectedHashes = await Promise.all(
    journal.entries.map(async (entry) =>
      createHash("sha256")
        .update(
          await readFile(
            path.join(migrationsDirectory, `${entry.tag}.sql`),
            "utf8",
          ),
        )
        .digest("hex"),
    ),
  );
  const report = {
    requiredTables: {
      missing: slmTables.filter((table) => !actualTables.includes(table)),
      present: slmTables.filter((table) => actualTables.includes(table)),
    },
    requiredEnums: {
      missing: slmEnums.filter((enumName) => !actualEnums.includes(enumName)),
      present: slmEnums.filter((enumName) => actualEnums.includes(enumName)),
    },
    migrationJournal: {
      readable: journalReadable,
      expectedEntries: expectedHashes.length,
      appliedEntries: appliedHashes.length,
      missingHashes: expectedHashes.filter(
        (hash) => !appliedHashes.includes(hash),
      ),
      unexpectedHashes: appliedHashes.filter(
        (hash) => !expectedHashes.includes(hash),
      ),
    },
    extraLegacyTables: actualTables.filter(
      (table) => !slmTables.includes(table),
    ),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (
    report.requiredTables.missing.length ||
    report.requiredEnums.missing.length ||
    !journalReadable ||
    report.migrationJournal.missingHashes.length ||
    report.migrationJournal.unexpectedHashes.length
  ) {
    process.exitCode = 1;
  }
} finally {
  await client.end().catch(() => undefined);
}
