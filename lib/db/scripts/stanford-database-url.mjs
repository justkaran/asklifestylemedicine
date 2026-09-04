export function requireStanfordMigrationDatabaseUrl() {
  if (process.argv.length !== 2) {
    throw new Error(
      "This command does not accept arguments; set STANFORD_MIGRATION_DATABASE_URL instead",
    );
  }

  const connectionString = process.env.STANFORD_MIGRATION_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "STANFORD_MIGRATION_DATABASE_URL is required; DATABASE_URL is intentionally ignored",
    );
  }

  const parsedUrl = new URL(connectionString);
  if (
    parsedUrl.protocol !== "postgres:" &&
    parsedUrl.protocol !== "postgresql:"
  ) {
    throw new Error("STANFORD_MIGRATION_DATABASE_URL must be a PostgreSQL URL");
  }
  return connectionString;
}
