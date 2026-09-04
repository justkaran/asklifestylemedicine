# Stanford / SLM database migrations

`lib/db/migrations` is the authoritative, versioned PostgreSQL history for a
new Stanford database. It is generated only from the bounded
`lib/db/src/schema/slm.ts` manifest, reviewed as SQL, and applied by a separate
approval-gated release step. It is not run by API startup.

The large additive `migrate()` routine in `artifacts/api-server/src/index.ts`
is legacy compatibility for existing Palonur/Replit databases. It remains in
place during this first migration step, but it is not the Stanford migration
history and must not be copied into a new Stanford release process.

When `STANFORD_EDITION=true`, API startup is fail-closed: it does not run that
legacy `migrate()` routine, Stripe initialization, legacy boot seeds, or
unreviewed cron jobs. Before listening it performs read-only checks that
`vector` is installed, every table in `slmSchemaManifest.tables` exists in
`public`, and `drizzle.__drizzle_migrations` contains at least one row. A failed
check is logged and prevents the API from starting. Apply the approved
migrations (and enable `vector`) before deploying; application startup never
repairs this state.

In this mode the only scheduled jobs are the reviewed SLM-bounded jobs:
research discovery when explicitly enabled, query clustering, steward review
digest, and weekly coverage digest. Other jobs remain skipped until their
database footprint has been reviewed against the SLM manifest.

## Review a schema change

From the repository root:

```bash
pnpm --filter @workspace/db run stanford:generate
pnpm --filter @workspace/db run stanford:check
git diff -- lib/db/migrations
```

Generation and checking do not need `DATABASE_URL`. Commit the SQL, journal,
and snapshot together. Never edit only the journal or rename a migration after
it has been applied. Review every generated statement for locks, table
rewrites, destructive operations, extension requirements, and data backfills.

The initial migration represents the SLM manifest's 38 tables and 18 enums,
not the broad legacy Drizzle schema. The validator rejects a final migration
snapshot containing a table outside that manifest. It is not a script for
baselining or modifying an existing production database.

`pnpm --filter @workspace/db run push` remains the separate legacy broad-schema
compatibility workflow. It is not a Stanford migration command.

## Validate on an empty PostgreSQL database

Provision a disposable empty database and enable the PostgreSQL extensions
required by the application, including `vector`. Set its connection string only
in the dedicated `STANFORD_MIGRATION_DATABASE_URL` environment variable; these
commands intentionally ignore `DATABASE_URL` and accept no credential arguments.
Then run:

```bash
pnpm --filter @workspace/db run stanford:migrate
```

The command validates the checked-in journal/files first and refuses a database
containing tables, views, or sequences. This is the empty-database smoke-test
contract: it applies the bounded baseline only to an explicitly configured,
disposable empty database.

After a successful migration, seed only the seven canonical Lifestyle Medicine
pillars:

```bash
pnpm --filter @workspace/db run stanford:seed-pillars
```

The seed is insert-only (`ON CONFLICT DO NOTHING`) for `movement`, `nutrition`,
`sleep`, `stress-management`, `social-connection`, `cognitive-enhancement`, and
`gratitude-purpose`; it never overwrites a steward-edited row.

To inspect an existing database without changing it:

```bash
pnpm --filter @workspace/db run stanford:inspect
```

It reports missing required SLM tables/enums and the Drizzle migration journal,
while listing extra public tables as legacy compatibility separately. It exits
nonzero when required objects or expected migration hashes are absent.

For a Stanford release, use a dedicated migration role, require TLS or the
Cloud SQL Auth Proxy/connector, take/verify a backup, review the exact release
diff, and run the approved checked-in migration as a separate job before
restarting services. Do not add migration execution to application startup.
Use a reviewed forward-fix or Cloud SQL point-in-time recovery rather than
automated destructive down migrations.
