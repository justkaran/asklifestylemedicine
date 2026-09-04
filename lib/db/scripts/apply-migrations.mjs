import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import {
  migrationsDirectory,
  validateMigrationFiles,
} from "./migration-files.mjs";
import { requireStanfordMigrationDatabaseUrl } from "./stanford-database-url.mjs";

const connectionString = requireStanfordMigrationDatabaseUrl();

await validateMigrationFiles();

const client = new pg.Client({
  connectionString,
  connectionTimeoutMillis: 10_000,
});

try {
  await client.connect();
  const existingObjects = await client.query(`
    SELECT n.nspname AS schema_name, c.relname AS object_name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg_toast%'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
     ORDER BY n.nspname, c.relname
     LIMIT 1
  `);
  if (existingObjects.rowCount !== 0) {
    const existing = existingObjects.rows[0];
    throw new Error(
      `Refusing to migrate a non-empty database; found ${existing.schema_name}.${existing.object_name}`,
    );
  }

  await migrate(drizzle(client), { migrationsFolder: migrationsDirectory });
  process.stdout.write(
    "Applied all checked-in migrations to the empty database.\n",
  );
} finally {
  await client.end().catch(() => undefined);
}
