# Stanford Security Posture Summary

## Scope and architecture

Ask Lifestyle Medicine's Stanford edition runs on a **Stanford-owned Linux host** with
nginx/systemd and uses **GCP Cloud SQL PostgreSQL**. It loads a dedicated Stanford route
graph and a reduced database footprint. Billing, Apple Health, OTL, partner/MCP, and
unrelated Palonur products are outside this boundary and are not deployment risks
described by this package.

## Identity and access

- Faculty authentication currently uses a **Replit-managed Clerk tenant**. Application
  middleware maps the authenticated Clerk identity to Faculty membership and enforces
  role/platform-admin checks server-side.
- Consumer chat uses bounded consumer authentication endpoints and signed sessions.
  Billing routes are not exposed in Stanford mode.
- A strong Stanford-managed `SESSION_SECRET` and provider credentials are required in
  production. Stanford SSO is not currently implemented; adopting it requires a reviewed
  adapter rather than a fallback.
- The Stanford route allowlist imports only selected SLM/Faculty routers and explicitly
  returns 404 for excluded product families, legacy Firecrawl collection, private-object
  reads, and presigned upload routes. Only intentionally public object delivery remains.

## AI and scholarly data flows

- **OpenAI:** corpus and query text is sent directly to the embeddings endpoint using
  `text-embedding-3-small`, explicitly requesting **384-dimensional** vectors.
- **Anthropic Claude:** receives the question, bounded history, and retrieved approved
  excerpts for answers; it also supports Faculty interpretation drafting, checks, and a
  separate fail-closed grounding verification before discovery auto-approval.
- **PubMed and Crossref:** receive Faculty name/topic searches and return publication
  metadata and abstracts for automatic scholarly discovery.
- Provider retention/no-training terms are contractual matters. There is no technical
  zero-retention or “data never leaves Stanford” claim.

## Governance and answer integrity

- Retrieval filters to approved sources and interpretations and to the active embedding
  identity.
- Prompts fence retrieved material as untrusted context. Answers use explicit
  refusal/uncovered outcomes when evidence is insufficient.
- Citation/grounding checks compare output with retrieved provenance and correct or
  replace answers containing unmatched citations.
- Eligible published PubMed/Crossref discoveries are **system-auto-approved**. They do
  **not** require individual Faculty approval. Missing required metadata, retraction
  signals, duplicates, and ungrounded drafts are diverted to review or failure.
- A nonempty draft is not enough. A second Claude pass must affirm that every material
  claim is supported and return substantive verbatim abstract evidence. The application
  independently checks that each quote occurs in the abstract and that the draft adds no
  number absent from the abstract. Malformed output or provider failure fails to review.
- System approval records have no individual approver/reviewer, so authorship is not
  presented as approval or endorsement. Topic fit is observable rather than an
  individual-approval gate.
- An authorized pillar steward can exclude an unwanted discovered record. Exclusion
  archives it, removes it from approved retrieval, records the actor/reason, and keeps a
  durable tombstone that suppresses rediscovery of the same provider record/DOI.
- Version snapshots and source audit entries identify system auto-approval. Material
  without documented full-text rights is purged after the approved interpretation claim
  is embedded.

## Logging and data handling

Cloud SQL stores corpus/provenance, vectors, Faculty role mappings, consumer account
data, discovery records, and answer audit data including raw question text and selected
sources. Application HTTP logging omits bodies and query strings by design. Formal
Stanford retention, deletion, backup, and log-handling schedules are not supplied in
this repository.

## Dependency and code-scan evidence

Scans run on 2026-09-04 after remediation found **0 critical and 0 high
production-dependency findings**. The full development tree retains three unpatched
high advisories:

- `xlsx@0.18.5`: prototype-pollution and ReDoS advisories. It is a development-only
  dependency used solely by the manually invoked `ingestSlmArticles` bulk-import script,
  not by a request-serving route.
- `extract-zip@2.0.1`: a symlink path-traversal advisory through development-only
  Puppeteer browser-install tooling. The application has no request-serving Puppeteer
  import.

The same scan reported eight moderate and one low production advisory for owner review.
Static analysis reported three medium findings in excluded legacy doorway/referral
routes; the redirect destinations are closed internal paths and the referral value is
database-validated and signed. Secret scanning reported low-severity email-address
output in operator scripts, not credential exposure.

## Reviewer-visible residual risks and evidence gaps

| Item | Status / owner |
|---|---|
| Automated discovery can misclassify metadata or grounding | Residual application risk; define owner sampling governance; correction is supported by durable owner exclusion |
| Questions and corpus excerpts leave Stanford/GCP for OpenAI/Anthropic processing | Requires Stanford vendor/privacy approval and configured-term evidence |
| Replit-managed Clerk tenant configuration, MFA, privileged access review, and account lifecycle | Stanford/identity-owner evidence required |
| Linux hardening, network controls, Cloud SQL private connectivity/encryption configuration, monitoring, and secret management | Stanford/GCP operational evidence required |
| Data classification, retention/deletion, backup retention, and provider retention | Policy gap / Stanford decision |
| Incident response, breach notification, vulnerability management, backup/restore testing, DR and business continuity | Owner-provided operational documents; not created or claimed by this package |
| Optional GCS/private Faculty upload path | Not exposed in Stanford mode; any future enablement requires a new boundary, authentication, ACL, bucket, and retention review |

This summary makes no SOC 2, HIPAA, FERPA, zero-retention, or independent human-review
claim. See `/threat_model.md`, `data-flow-inventory.md`, and
`compliance-posture.md`.