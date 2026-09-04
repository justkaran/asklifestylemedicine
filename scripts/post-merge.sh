#!/bin/bash
set -e

# Post-merge setup for the artifacts monorepo.
#
# We intentionally do NOT run `drizzle-kit push` (or `push-force`) here.
# The dev database contains legacy tables/columns that are not part of the
# Drizzle schema barrel (e.g. palonur_pageviews, palonur_interactions,
# palonur_sleep_logs, slides_state, reach_deck, faculty_users.name). Because
# of this drift, `drizzle-kit push`:
#   - with --force, would silently DROP those tables/columns (real data loss), and
#   - without --force, prompts interactively and hangs (post-merge stdin is closed).
pnpm install

# Correct dev-DB schema drift non-interactively. `sync-dev-schema` reads the
# Drizzle metadata, introspects the live DB, and applies ONLY additive changes
# (CREATE TYPE/TABLE/INDEX, ADD COLUMN, ADD VALUE) — it never drops, so legacy
# objects survive and there is no interactive prompt. This stops the recurring
# "column does not exist" cascade that reds the whole test suite after a
# schema-changing merge. Idempotent: a no-op once dev is in sync.
pnpm --filter @workspace/scripts run sync-dev-schema

# Idempotent embedding heal: dev/isolated DBs created before the in-house
# gte-small migration still pin every halfvec column to a fixed `halfvec(3072)`
# and hold retired text-embedding-3-large vectors. Until healed, 384-d inserts
# 500 and several suites either skip their grounded-success assertions
# (`embeddingsUsable` guard) or fail with "expected 3072 dimensions, not 384".
# `reembed-chunks` widens all four halfvec columns to dimensionless, re-embeds
# the corpus to gte-small, and rebuilds the partial HNSW indexes. Idempotent: a
# no-op once a DB is already on gte-small. Must run AFTER sync-dev-schema so the
# embedding tables/columns exist.
pnpm --filter @workspace/scripts run reembed-chunks

# Idempotent heal for the one partial unique index `sync-dev-schema` can't apply.
# `syncSchemaAdditive` deliberately skips partial/expression/vector indexes
# ("apply manually if needed"), so a fresh dev DB never gets
# `framework_bookings_one_per_target`. Without it, the bookings upsert's
# `onConflictDoNothing` has no matching arbiter and every booking 500s, reding
# the frameworks ledger tests. `IF NOT EXISTS` makes this a no-op once present.
# Mirror the schema definition in lib/db/src/schema/frameworks.ts exactly.
if [ -n "$DATABASE_URL" ]; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
    "CREATE UNIQUE INDEX IF NOT EXISTS framework_bookings_one_per_target \
       ON framework_bookings (framework_id, target_type, target_id) \
       WHERE target_id IS NOT NULL;"
fi

# Idempotent backfill: assign every legacy newsletter subscriber + issue to the
# single "house" publication. Safe to run repeatedly and a no-op once done; it
# also skips cleanly if the publication schema isn't present yet.
pnpm --filter @workspace/scripts run backfill-publications

# Idempotent cleanup: purge leftover `@example.com` test faculty accounts that
# an interrupted api-server test run may have stranded in the shared dev DB.
# Safe to run repeatedly and a no-op once dev is clean.
pnpm --filter @workspace/scripts run purge-test-faculty

# Idempotent seed for the dementia pillar's curated Stanford ADRC resource links.
# INSERT-ONLY by URL (ON CONFLICT DO NOTHING), so re-runs are safe and never
# overwrite operator edits. Requires the dementia pillar to exist (created by
# the CANONICAL_PILLARS boot seed on first api-server start). Skips cleanly if
# the pillar is not present yet.
pnpm --filter @workspace/scripts run seed-dementia-resources
