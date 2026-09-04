# Stanford Deployment Threat Model

This document covers the bounded Stanford edition of Ask Lifestyle Medicine. Companion
documents are in `docs/security-review/`.

## Review boundary

**In scope**

- The Stanford-owned Linux host running the Node.js/Express API and the SLM and Faculty
  web applications, with the Stanford nginx/systemd deployment configuration.
- GCP Cloud SQL for PostgreSQL, including pgvector/`halfvec` storage.
- The Stanford-mode route composition boundary in `src/routes/stanford.ts`.
- Consumer question answering, Faculty corpus administration, scholarly discovery, and
  the providers needed by those functions: the current Replit-managed Clerk tenant,
  OpenAI, Anthropic, PubMed, Crossref, and optional email delivery.
- Delivery of intentionally public objects. Private-object reads and presigned upload
  routes are not exposed in Stanford mode.

**Out of scope and not deployed through the Stanford route graph**

Billing/Stripe, Apple Health and other sleep-companion functions, OTL/reviewer pages,
partner APIs and MCP, newsletters/communications, analytics, decision-room, investor,
support, phone, legacy Firecrawl collection, private storage/upload APIs, and other
unrelated Palonur product surfaces. Their legacy risks are not risks of this bounded
deployment. A future route or feature requires a boundary review before it is enabled.

## Architecture and trust boundaries

1. Browsers connect to the Stanford-operated Linux deployment over HTTPS. nginx proxies
   to the application. TLS certificate, host hardening, firewalling, patching, service
   accounts, and monitoring are Stanford operational responsibilities.
2. Stanford mode imports a dedicated route graph rather than the broad product router.
   Explicit route guards return 404 for excluded route families. This is an application
   boundary as well as a reduced Cloud SQL schema boundary.
3. Faculty access uses sessions from the current Replit-managed Clerk tenant and
   `requireFacultyAuth`; role and platform-admin checks are enforced server-side. Moving
   to Stanford SSO requires a separately implemented and reviewed adapter; there is no
   unauthenticated fallback.
4. Consumer chat uses the bounded consumer authentication endpoints and signed
   application sessions. Billing endpoints are unreachable in Stanford mode.
5. The API connects to GCP Cloud SQL. Database credentials and provider keys must be
   supplied through Stanford-controlled secret management and must not be committed.
6. Corpus and question text is sent directly to OpenAI to produce 384-dimensional
   embeddings. Question, bounded chat context, and retrieved excerpts are sent to
   Anthropic Claude for answer generation. Faculty drafting/checking actions may also
   send relevant source text to Claude.
7. PubMed and Crossref are queried for scholarly metadata and abstracts. Publisher pages
   and full text are not automatically scraped by this discovery path. Firecrawl
   collection routes are absent from the Stanford route graph.

## Protected assets

- Approved sources, interpretations, chunks, embeddings, provenance, and version history.
- Consumer account data, questions, answers, and signed sessions.
- Faculty identity, membership, role, and administrative data.
- Cloud SQL credentials, Clerk keys, session secret, OpenAI key, Anthropic key, and any
  optional email/GCS credentials.
- Discovery run, candidate, approval, citation, and answer audit records.

## Principal threats and controls

### Identity spoofing and privilege escalation

- Faculty routes validate Clerk authentication and then apply database-backed role or
  platform-admin authorization. A Clerk identity alone does not grant a Faculty role.
- Discovery administration is platform-admin gated. Faculty and admin checks remain
  server-side; browser behavior is not treated as an authorization boundary.
- Signed consumer sessions depend on a strong production `SESSION_SECRET`. The example
  configuration deliberately requires Stanford to provide it.
- Risk: compromise or misconfiguration of Clerk, a privileged Faculty account, or its
  role mapping can permit unauthorized corpus changes. MFA policy, account lifecycle,
  and privileged-user review are owner/provider operational controls to be evidenced
  outside this code package.

### Corpus tampering and automated approval

- Retrieval requires approved interpretations and approved sources and refuses to compare
  vectors from different embedding identities.
- Eligible published records discovered from PubMed/Crossref are **system-auto-approved**;
  they do not wait for, and must not be represented as receiving, individual faculty
  approval. The system actor is recorded with null individual approver/reviewer identity.
- Auto-approval is narrowly gated: the record needs an abstract and DOI/PMID, must not
  contain retraction/expression-of-concern signals, and must produce a grounded
  interpretation. A second Claude pass must verify every material claim and return
  substantive verbatim abstract evidence; application code independently checks that
  each quote occurs in the abstract and that the draft adds no unsupported number.
  Malformed verification, duplicates, missing required metadata, provider failures, or
  drafting failures go to review or failed status instead. Topic-fit is recorded as an
  observable signal but is not an individual-approval gate.
- No faculty member is credited as approver: system approval records carry null
  individual approver/reviewer identity. An authorized pillar steward can subsequently
  exclude an unwanted discovered record. Exclusion archives the source, removes it from
  approved retrieval, records the actor and optional reason, and retains a durable
  discovery tombstone so the same provider record/DOI is not reintroduced.
- System approvals create a version snapshot and source audit entries. Unlicensed source
  material is purged after the interpretation claim is embedded; provenance metadata is
  retained.
- Residual risk: metadata can be incomplete or wrong and automated grounding checks can
  produce false positives. Owner exclusion and audit records support correction, but a
  formal owner-defined sampling process is not supplied in this package.

### Prompt injection, hallucination, and citation integrity

- Retrieved material is treated as untrusted context and fenced in prompts; client chat
  history is sanitized.
- Answers are limited to approved retrieved material and use explicit refusal/uncovered
  outcomes when support is insufficient.
- Citation/grounding checks compare answer citations with retrieved provenance and
  replace or correct answers with unmatched citations. These controls reduce but cannot
  eliminate model error or malicious instructions embedded in source text.

### Information disclosure

- OpenAI receives embedding input text; Anthropic receives answer/drafting prompts and
  relevant excerpts. Provider no-training and retention positions are contractual, not
  technical guarantees. This package makes no zero-retention or “data never leaves
  Stanford” claim.
- Raw user questions may contain personal information and are recorded for answer audit.
  Users should not submit clinical records or sensitive personal data.
- Logs should avoid request bodies, credentials, and query strings. Application errors
  must not expose secrets or stack traces to clients.
- Stanford mode exposes intentionally public-object delivery only. Enabling private GCS
  reads or upload issuance would require a new route-boundary and deployment review.

### Availability and external dependency failure

- Cloud SQL, Clerk, OpenAI, Anthropic, PubMed, and Crossref are external dependencies.
  Provider failures can prevent sign-in, retrieval, drafting, answering, or discovery.
- Discovery is bounded per provider, serialized with a database advisory lock, limited
  to one run per faculty/pillar within 24 hours, and records provider failures.
- Capacity planning, host redundancy, Cloud SQL backup/restore, monitoring, rate-limit
  policy, and recovery objectives are Stanford operational decisions and are not
  evidenced by this repository package.

### Repudiation

- Answer records retain the question, selected provenance, outcome, and citation-check
  result.
- Interpretation versions and source audit entries distinguish system auto-approval from
  individual approval.
- Individual Faculty attribution depends on Clerk identity and application audit data.
  Infrastructure, database-administrator, and identity-provider logs are
  owner/provider-managed and outside this package.

### Dependency and static-analysis evidence

- Post-remediation production audit on 2026-09-04 found 0 critical and 0 high findings.
- The full development tree has three unpatched high advisories: two in development-only
  `xlsx`, used solely by the manually invoked scholarly bulk-import script, and one in
  development-only Puppeteer browser-install tooling through `extract-zip`. Neither is
  imported by a request-serving application path.
- Eight moderate and one low production advisory remain for owner review. Static
  analysis findings in legacy doorway/referral routes are outside the Stanford route
  graph; their redirect targets are closed internal paths and referral values are
  database-validated and signed.

## Open items requiring owner evidence or decision

1. Production network diagram, asset inventory, Linux/Cloud SQL hardening evidence, and
   secret-management procedure.
2. Replit-managed Clerk tenant settings, MFA/access-review policy, account
   provisioning/deprovisioning, and Stanford identity governance decision.
3. Vendor agreements and configured retention/data-use terms for Clerk, OpenAI,
   Anthropic, and optional email/GCS services.
4. Data classification and retention/deletion schedule for questions, answers, audit
   records, discovery metadata, and backups.
5. Operational incident response, breach notification, vulnerability management,
   monitoring, backup/restore, disaster recovery, and business continuity documentation.
6. Governance for sampling, correcting, or withdrawing system-auto-approved discoveries.

These are honestly identified as Stanford/owner-provided operational artifacts or gaps;
this review package does not invent them.