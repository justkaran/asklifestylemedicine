<div align="center">

# Ask Lifestyle Medicine

**A governed research-to-answer platform for Stanford Lifestyle Medicine.**

Faculty stewards keep authority over their pillars. People ask practical
questions and receive answers grounded in published evidence, approved
interpretations, and visible provenance.

<a href="docs/security-review/security-posture-summary.md">Security posture</a>
&nbsp; · &nbsp;
<a href="docs/stanford/README.md">Stanford handoff</a>
&nbsp; · &nbsp;
<a href="docs/stanford/DATABASE-MIGRATIONS.md">Database migrations</a>

</div>

---

## What this repository contains

Ask Lifestyle Medicine is the Stanford-focused composition of the Palonur
platform:

| Surface | Purpose |
| --- | --- |
| **Ask Lifestyle Medicine** | Public, evidence-grounded questions and answers |
| **Faculty portal** | Steward sign-in, source and interpretation management, distribution, and review |
| **API server** | Authentication, retrieval, answer generation, provenance, discovery, and governance routes |
| **Stanford embed** | WordPress-compatible iframe and script-loader integration |
| **Bounded database** | PostgreSQL schema and migrations for the Stanford Lifestyle Medicine edition |

The product is organized around seven Stanford Lifestyle Medicine pillars.
Faculty remain stewards of those pillars: they approve the interpretations they
author, shape what is published, and can exclude unwanted discoveries.

## How knowledge enters the system

1. A visitor asks a question through the public Ask Lifestyle Medicine surface.
2. Retrieval uses approved sources, approved interpretations, and a consistent
   embedding identity.
3. Claude drafts an answer from the retrieved, fenced context and returns
   provenance with the response.
4. PubMed and Crossref discovery runs automatically for eligible published
   scholarship. A record must have the required identifiers and abstract
   metadata, no retraction signal, a generated interpretation, and a separate
   fail-closed grounding verification.
5. Topic fit is advisory rather than an approval veto. A pillar steward can
   exclude an unwanted discovery; the source is archived and a durable
   rediscovery tombstone prevents it from returning.

System approval of an eligible discovery is kept distinct from a faculty
steward's approval of an interpretation they authored.

## Stanford deployment boundary

The Stanford edition is designed for:

- Stanford-managed Linux with nginx and systemd.
- GCP Cloud SQL for PostgreSQL with the vector extension.
- WordPress embedding through `/embed/slm`.
- Replit-managed Clerk for the current Faculty identity boundary.
  Stanford OIDC/SAML is a future adapter and is not enabled by a flag.
- Direct OpenAI 384-dimensional embeddings and Anthropic Claude drafting,
  answering, and grounding flows.
- Billing disabled with `BILLING_ENABLED=false`.

Stanford mode is intentionally bounded. It does not expose legacy Firecrawl
collection, private-object reads, presigned upload issuance, billing/Stripe,
partner, investor, OTL, or unrelated Palonur product routes.

## Security review package

The reviewer-facing package is deliberately split into four documents:

- [Threat model](threat_model.md)
- [Security posture summary](docs/security-review/security-posture-summary.md)
- [Data-flow inventory](docs/security-review/data-flow-inventory.md)
- [Compliance posture](docs/security-review/compliance-posture.md)

The package records the current provider boundary, storage and route
allowlists, automatic discovery controls, data flows, known gaps, and
dependency-scan disposition. It does not claim that Stanford has completed its
own operational, identity, retention, or vendor review.

## Repository guide

| Path | Contents |
| --- | --- |
| `artifacts/api-server/` | Express API, retrieval, governance, discovery, and tests |
| `artifacts/faculty/` | Stanford Faculty portal |
| `artifacts/palonur/` | Public Ask Lifestyle Medicine and related web surfaces |
| `lib/db/` | Shared schema, Stanford schema boundary, and migrations |
| `docs/stanford/` | Self-hosting, WordPress, database, and release handoff |
| `deploy/stanford/` | Environment template, nginx, systemd, and WordPress files |
| `docs/security-review/` | Stanford reviewer-facing security documentation |
| `scripts/` | Idempotent operator and maintenance scripts |

## Local development

### Prerequisites

- Node.js 22
- pnpm 10
- PostgreSQL 16 with `DATABASE_URL` for API tests and runtime work

Install dependencies:

```bash
corepack enable
pnpm install --frozen-lockfile
```

Run the full validation suite:

```bash
pnpm run typecheck
pnpm run test
```

Build the main applications:

```bash
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/faculty run build
pnpm --filter @workspace/palonur run build
```

The API test suite uses a real PostgreSQL database. Never point test commands
at a production database.

## Stanford handoff

Start with the [Stanford self-hosting handoff](docs/stanford/README.md), then
review:

1. [Database ownership and inspection](docs/stanford/DATABASE.md)
2. [Migration and empty-database procedure](docs/stanford/DATABASE-MIGRATIONS.md)
3. [`deploy/stanford/.env.example`](deploy/stanford/.env.example)
4. [WordPress integration](deploy/stanford/wordpress/ask-lifestyle-medicine.php)
5. [Release flow and rollback guidance](docs/stanford/README.md#release-flow)

The completed environment file belongs in Stanford's secret/configuration
system and must never be committed.

## Readiness

The repository is ready for Stanford IT/security review. The code package has
passed the workspace typecheck, Stanford migration validation, API and frontend
builds, and the complete test workflow.

Production dependency scanning is at **0 critical / 0 high**. Three high
advisories remain in development-only tooling used by manual import or browser
installation workflows; they are documented in the security package and are
not reachable from production request-serving paths.

Review approval, Stanford identity and infrastructure evidence, provider
terms, retention decisions, and production launch approval remain Stanford
deployment-owner decisions.

## License

MIT