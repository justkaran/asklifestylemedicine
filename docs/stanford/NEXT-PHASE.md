# Required before the clean Stanford repository handoff

## Completed boundary prerequisite

The SLM/Faculty table boundary, relationships, lifecycle and retention
semantics, and empty/current database handoff are documented in
[`DATABASE.md`](./DATABASE.md). The explicit code allowlist is exported as
`@workspace/db/schema/slm`. The bounded 38-table/18-enum baseline, journal,
empty-database smoke-test contract, insert-only seven-pillar seed, and read-only
inspection command are implemented; see
[`DATABASE-MIGRATIONS.md`](./DATABASE-MIGRATIONS.md). Stanford mode now bypasses
legacy boot DDL and uses the SLM-only route composition; legacy mode retains the
old compatibility path.

## 1. Extract an SLM-only API composition root — complete

`artifacts/api-server/src/routes/stanford.ts` now provides the functional
allowlisted composition when `STANFORD_EDITION=true`. It mounts the SLM and
Faculty routes required by the bounded database and returns 404 for excluded
Palonur product families (including their Faculty admin variants). The app also
skips the Stripe webhook, discovery documents, and non-SLM Clerk middleware in
this mode.

The current safe boundary reuses a few legacy monolithic router modules behind
path-level allowlists. Those imports can be split into smaller dedicated
modules later to reduce the Stanford bundle; they are not reachable routes.

The allowlist contains only:

- Ask Lifestyle Medicine question/answer and answer-link endpoints.
- Faculty authentication, directory, pillar, source, interpretation, knowledge,
  coverage, evaluation, research-discovery, and upload endpoints.
- Health checks and required object-storage endpoints.

agent licensing, or other Palonur routes when `STANFORD_EDITION=true`. A few
monolithic modules are still imported behind fail-closed path allowlists and
should eventually be split to reduce the bundle.

## 2. Retire legacy boot-time database DDL after compatibility review

`artifacts/api-server/src/index.ts` retains legacy additive boot DDL only for
existing Palonur/Replit databases. `STANFORD_EDITION=true` bypasses it and fails
closed unless the vector extension, all 38 manifest tables, and the Drizzle
migration journal are present. Retire the legacy implementation only after the
combined Palonur database no longer needs upgrade compatibility.

## 3. Authentication adapter

Define one server interface for:

- session verification,
- canonical email and user identifier,
- role/group claims,
- sign-in/sign-out URLs,
- directory provisioning.

Keep the existing Clerk adapter. Add Stanford OIDC/SAML only after Stanford
provides issuer metadata, client registration, claims, group mapping, logout,
key rotation, and account lifecycle requirements. Never provide an anonymous
fallback for Faculty routes.

## 4. Storage and email adapters

Replace Replit connector assumptions with explicit provider configuration:

- GCS bucket and workload identity/service account for uploads,
- Stanford-approved mail provider and sender domain,
- retry, retention, backup, and audit requirements.

## 5. CI and acceptance

Add GitHub and GitLab pipelines for install, typecheck, tests, build, migration
verification, dependency audit, and release artifact creation. Run a final
security review of cookies, CSP, CORS, iframe origins, upload scanning, and
Faculty/admin authorization before production launch.
