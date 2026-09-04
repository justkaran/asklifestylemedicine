import pg from "pg";
import {
  canonicalLifestyleMedicinePillars,
  validateCanonicalPillars,
} from "./migration-files.mjs";
import { requireStanfordMigrationDatabaseUrl } from "./stanford-database-url.mjs";

validateCanonicalPillars();
const client = new pg.Client({
  connectionString: requireStanfordMigrationDatabaseUrl(),
  connectionTimeoutMillis: 10_000,
});

try {
  await client.connect();
  const inserted = [];
  for (const pillar of canonicalLifestyleMedicinePillars) {
    const result = await client.query(
      `INSERT INTO pillars (slug, name, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO NOTHING
       RETURNING slug`,
      [pillar.slug, pillar.name, pillar.description],
    );
    inserted.push(...result.rows.map((row) => row.slug));
  }
  const present = await client.query(
    "SELECT slug FROM pillars WHERE slug = ANY($1::text[]) ORDER BY slug",
    [canonicalLifestyleMedicinePillars.map((pillar) => pillar.slug)],
  );
  if (present.rowCount !== canonicalLifestyleMedicinePillars.length) {
    throw new Error(
      "Canonical pillar seed verification failed: one or more slugs are absent",
    );
  }
  process.stdout.write(
    `Seeded ${inserted.length} new canonical pillar(s); all seven canonical slugs are present.\n`,
  );
} finally {
  await client.end().catch(() => undefined);
}
