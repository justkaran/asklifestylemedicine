# Stanford Compliance Posture

This is a scope and evidence statement for the bounded Stanford deployment, not a
certification or legal opinion.

## Boundary and responsibility

| Concern | Responsible party / evidence source |
|---|---|
| Stanford-owned Linux host, nginx, firewall/network, OS patching, endpoint monitoring, certificates and service operation | Stanford operations |
| GCP Cloud SQL physical/platform controls and service attestations | Google Cloud, as inherited under Stanford's account and contract |
| Cloud SQL configuration, connectivity, IAM/service accounts, backups, region and retention | Stanford cloud/database owners |
| Replit-managed Clerk identity service controls and configured tenant policy | Replit/Clerk plus Stanford identity/application owners |
| OpenAI, Anthropic, Resend and optional GCS contractual/privacy posture | Provider evidence and Stanford vendor/privacy review |
| Route boundary, application authentication/authorization, retrieval, discovery policy, citation checks and application audit events | Application controls documented in this package |
| Data classification, retention, incident response, vulnerability management and disaster recovery procedures | Stanford/owner policy and operations |

## Control posture

### Access control

Faculty users currently authenticate through a Replit-managed Clerk tenant and receive
application permissions only after database membership and role checks.
Platform-administrator functions, including manual research discovery, require an
application admin designation. Consumer sessions are signed. Stanford mode uses a
dedicated route composition and excludes billing, Apple Health, OTL, partner/MCP,
legacy Firecrawl collection, private storage/upload APIs, and unrelated product routes.

Evidence still required from the owner includes Clerk MFA/session settings, privileged
access review, joiner/mover/leaver procedure, service-account ownership, and periodic
role review.

### Data protection and third parties

Cloud SQL stores application records and 384-dimensional vectors. OpenAI receives corpus
or query text for direct embedding; Anthropic receives selected context for answer and
drafting flows; PubMed/Crossref receive Faculty name/topic searches for scholarly
discovery. Optional email and GCS flows apply only when configured.

Exact encryption configuration, network topology, data residency, provider retention,
backup retention, deletion procedures, and vendor terms require deployment or contract
evidence. Provider “no training” language, if applicable, is contractual and is not
claimed as a technical control. No zero-retention or data-locality claim is made.

### Content governance and accountability

Answers retrieve approved records and undergo citation/grounding checks. Eligible
published discovered records are system-auto-approved under required-metadata,
retraction-signal, and grounded-draft gates. Grounding uses a separate Claude decision
plus application validation of substantive exact abstract evidence and unsupported
numbers; failure is diverted to review. Topic fit remains observable but is not an
individual-approval gate. This policy intentionally does not require individual Faculty
approval, and audit/version records identify the system rather than an individual
approver.

An authorized pillar steward can exclude an unwanted discovered record. Exclusion
archives the source, removes it from approved retrieval, logs the actor and optional
reason, and preserves a durable tombstone against rediscovery. This is not independent
peer review. Governance for periodic sampling, appeal, and policy change remains an
owner decision.

### Audit and retention

The application records answer provenance/outcome, discovery status, source audit events,
and interpretation versions. Raw user questions may contain personal information.
Infrastructure, Cloud SQL administrative, Clerk, and provider logs are outside the
repository and must be supplied or described by their owners.

There is no formal Stanford retention/deletion schedule in this package. Retention for
questions, answers, identities, discovery/audit records, provider data, logs, and backups
must be approved and documented by the owner.

## HECVAT-oriented evidence map

| Topic | Current evidence / gap |
|---|---|
| System scope and data flow | `/threat_model.md` and `data-flow-inventory.md` |
| Authentication and authorization | `security-posture-summary.md` and threat model |
| Application/content integrity | Approved-only retrieval, embedding-space identity, discovery gates, citation/grounding checks and audit/version records |
| Hosting and infrastructure | Stanford Linux + GCP Cloud SQL architecture; deployment-specific diagram and configuration evidence required |
| Vendor management | Provider inventory exists; contracts, DPAs, subprocessors, retention and current attestations require owner/vendor evidence |
| Vulnerability management | 2026-09-04 scan: 0 critical/high production dependency findings; three unpatched development-tooling highs are dispositioned in `security-posture-summary.md`; cadence, remediation SLA and penetration-test evidence remain owner gaps |
| Incident response and breach notification | Owner-provided operational document required; out of scope for this rewrite |
| Business continuity and disaster recovery | Cloud SQL/host backup configuration, RTO/RPO, restore tests and runbook require owner evidence |
| Privacy and retention | Data categories and destinations are inventoried; classification, notices, retention and deletion policy remain owner decisions |

## Claims deliberately not made

- No application-level SOC 2 certification or attestation.
- No claim that inherited Google Cloud attestations cover application logic or Stanford's
  service configuration.
- No HIPAA, FERPA, PCI, or clinical-system claim.
- No claim of zero retention, provider-side technical no-training enforcement, or that
  question/corpus text remains entirely within Stanford.
- No claim that system-auto-approved scholarly records received individual Faculty or
  independent human approval.
- No claim that Stanford operational incident-response, vulnerability-management, or DR
  documents are included in this repository package.