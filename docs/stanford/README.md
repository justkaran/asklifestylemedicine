# Stanford self-hosting handoff

This directory describes the target deployment for Ask Lifestyle Medicine:

- Stanford runs the public web app and API on Stanford-managed Linux servers.
- GCP Cloud SQL for PostgreSQL stores application data.
- WordPress embeds the public Ask Lifestyle Medicine experience.
- Faculty authentication is isolated behind a provider boundary. The current
  implementation uses **Replit-managed Clerk**; Stanford OIDC/SAML is a future
  adapter, not a flag that can safely be switched on without code and security
  review.
- Billing code remains in the repository but is disabled in the Stanford
  environment with `BILLING_ENABLED=false`.

## Current readiness status

The repository now contains:

1. A stable `/embed/slm` public route.
2. A credential-free JavaScript embed loader.
3. A minimal WordPress shortcode plugin with iframe and script modes.
4. Nginx and systemd examples for a non-Replit Linux host.
5. An environment template that defaults billing off.
6. Server-side billing and Stripe startup gating.
7. A documented SLM database boundary and dependency-free schema allowlist at
   `@workspace/db/schema/slm`; see [DATABASE.md](./DATABASE.md).
8. A checked-in bounded SLM baseline (38 tables, 18 enums), migration journal,
   empty-database smoke-test contract, and insert-only seven-pillar seed; see
   [DATABASE-MIGRATIONS.md](./DATABASE-MIGRATIONS.md).
9. A functional Stanford API composition selected with
   `STANFORD_EDITION=true`. It allowlists the SLM/Faculty endpoints needed by
   the bounded database and returns 404 for billing and other Palonur product
   families.

Faculty remain stewards of their pillars. They approve interpretations they
author and can exclude unwanted discoveries. Eligible published discoveries
may also be system-approved after the separate grounding checks described in
the [security posture summary](../security-review/security-posture-summary.md).

The repository is **not yet a minimal Stanford-only export**. The functional
composition boundary currently reuses a few legacy monolithic router modules
behind path-level allowlists; those modules can be split later for a smaller
Stanford bundle. Legacy boot-time DDL remains only on the non-Stanford
compatibility path for existing Palonur/Replit databases; Stanford startup
bypasses it and requires the reviewed migration state.

## WordPress

Copy `deploy/stanford/wordpress/ask-lifestyle-medicine.php` into a WordPress
plugin directory and activate it.

Recommended iframe shortcode:

```text
[ask_lifestyle_medicine origin="https://ask.example.stanford.edu" mode="iframe" height="760"]
```

Script-loader alternative:

```text
[ask_lifestyle_medicine origin="https://ask.example.stanford.edu" mode="script" height="760"]
```

The script mode still creates a cross-origin iframe. It is easier for WordPress
editors to install, but it does not move API credentials or application code
into WordPress.

Before launch, replace the wildcard example in the Nginx
`Content-Security-Policy` with Stanford's approved WordPress origins.

## Build

Use Node.js 22 and pnpm 10 on the build host:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/palonur run build
BASE_PATH=/faculty/ pnpm --filter @workspace/faculty run build
```

Copy `deploy/stanford/.env.example` to Stanford's secret/configuration system.
Do not commit the completed file.

## Embedding provider cutover

The default development provider is the local `Xenova/gte-small` model. Stanford
production may select direct OpenAI embeddings with `EMBEDDING_PROVIDER=openai`,
`OPENAI_API_KEY`, `OPENAI_EMBEDDING_MODEL=text-embedding-3-small`, and
`OPENAI_EMBEDDING_DIMENSIONS=384`. This calls `https://api.openai.com/v1/embeddings`
directly; the Replit AI Integrations OpenAI proxy does not implement embeddings.

Do not change `EMBEDDING_PROVIDER` on a database containing local vectors. First
run `pnpm --filter @workspace/scripts run reembed-chunks -- --dry-run` with the
target OpenAI variables, review its count, then run it without `--dry-run`.
It widens legacy columns where needed and rotates source, interpretation, query,
cluster, and knowledge-version vectors while stamping the provider/model/dimension
identity per row. API retrieval only considers rows with the active identity.
At boot the API creates an additional hashed, model-specific partial HNSW index;
old static/local indexes may remain safely during a rotation but are not selected
for active-model predicates.

## Runtime

1. Install the two example systemd units.
2. Point their `EnvironmentFile` at a root-readable, service-user-readable file.
3. Install the Nginx site configuration and replace all example domains/paths.
4. Start the API and web services.
5. Verify:
   - `GET /api/healthz` returns a healthy response.
   - `/` shows only Ask Lifestyle Medicine on the SLM host.
   - `/faculty/` requires Faculty authentication.
   - `/embed/slm` renders inside an approved Stanford WordPress origin.
   - `/api/billing/*` and `/api/stripe/webhook` return 404 when billing is off.

## Cloud SQL

Use a dedicated least-privilege application role and a separate migration role.
Require TLS or use the Cloud SQL Auth Proxy/connector on the host. Enable the
`vector` extension before starting the application.

The bounded SLM baseline, checked-in journal, empty-database smoke test,
insert-only canonical pillar seed, and read-only inspection procedure are in
[DATABASE-MIGRATIONS.md](./DATABASE-MIGRATIONS.md). Use a dedicated migration
role and `STANFORD_MIGRATION_DATABASE_URL` only in the approval-gated migration
job; do not place credentials in command arguments or configuration committed to
Git. [DATABASE.md](./DATABASE.md) remains the ownership boundary and handoff
checklist.

## Release flow

Recommended:

1. GitHub remains the main development repository.
2. Stanford mirrors reviewed release tags into GitLab.
3. Stanford CI builds immutable release artifacts from tags.
4. Database migrations run as a separate approval-gated job.
5. Services are restarted only after the migration succeeds.
6. Keep the previous release directory for immediate application rollback.
7. Database rollback uses tested forward-fix migrations or a Cloud SQL
   point-in-time restore; do not automatically run destructive down migrations.
