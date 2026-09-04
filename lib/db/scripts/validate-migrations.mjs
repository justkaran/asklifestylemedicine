import { validateMigrationFiles } from "./migration-files.mjs";

if (process.argv.length > 2) {
  throw new Error(
    "This check does not accept database credentials or arguments",
  );
}

const { sqlFiles } = await validateMigrationFiles();
process.stdout.write(
  `Validated ${sqlFiles.length} checked-in migration file(s).\n`,
);
