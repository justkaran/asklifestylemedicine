# Stanford External Data-Flow Inventory

This inventory is limited to the Stanford edition described in `/threat_model.md`.
Excluded Palonur products are not deployed through the Stanford route graph and are not
inventoried here.

## Deployment boundary

| Component | Operator | Data |
|---|---|---|
| Linux application host, nginx, systemd, SLM and Faculty applications | Stanford | Application code, runtime configuration, transient requests and application logs |
| GCP Cloud SQL for PostgreSQL | Google Cloud under Stanford configuration | Accounts, Faculty roles, corpus, interpretations, chunks, 384-dimensional vectors, questions/answers, provenance, discovery and audit records |
| Browser | Consumer or Faculty user | Session data, submitted questions, Faculty administration requests |

TLS, host controls, Cloud SQL network configuration, backups, regional placement, and
log retention must be confirmed from the actual Stanford/GCP deployment. This package
does not infer them from application code.

## Provider flows

| Provider / destination | Data sent | Purpose and timing | Data returned / local use |
|---|---|---|---|
| **Replit-managed Clerk tenant** | Faculty browser sign-in/session data; application token validation and Clerk user identifier | Current Faculty authentication and session maintenance | Authenticated identity is mapped to application Faculty membership and roles. No corpus or consumer question is needed for this flow. |
| **OpenAI, direct `api.openai.com` embeddings endpoint** | Corpus chunks/approved interpretation text during ingestion or re-embedding; consumer query text during retrieval | `text-embedding-3-small` with an explicit output size of **384 dimensions** | Vectors are stored in Cloud SQL with provider/model/dimension identity. This is not in-house embedding and does not use an intermediary AI proxy. |
| **Anthropic Claude, direct configured API endpoint** | Consumer question, bounded chat context, and top retrieved approved excerpts; relevant source text and instructions for Faculty interpretation/drafting, checks, and discovery grounding verification | Per answer, Faculty drafting/check action, or eligible discovered draft | Generated answer, draft, classification, grounding decision, or check result is processed and, where applicable, stored in Cloud SQL. |
| **NCBI PubMed** | Faculty name and pillar topic in search requests; returned PubMed IDs in metadata fetches | Manual/admin or enabled daily scholarly discovery | Publication metadata and abstracts are normalized, deduplicated, and evaluated for eligibility. |
| **Crossref** | Faculty name and pillar topic | Same discovery run as PubMed | Publication metadata and available abstracts are normalized, deduplicated, and evaluated for eligibility. |
| **Email provider (Resend), if configured** | Consumer email address and sign-in/registration link | Consumer authentication email delivery | Delivery result only; email operation depends on Stanford configuration. |
| **Public object storage, if configured** | Public-object key requested by a browser | Delivery of intentionally public assets | Stanford mode permits public-object delivery only. Private-object reads and presigned upload issuance return 404. |

Provider credentials are server-side secrets. The repository does not establish the
contract, configured region, retention period, or training/data-use settings for any
provider; those require owner/vendor evidence.

## Answer flow

1. A consumer authenticates through the bounded consumer endpoints and submits a
   question over HTTPS.
2. The API sends the question text directly to OpenAI and receives a 384-dimensional
   embedding.
3. Cloud SQL retrieval compares only the active embedding identity and selects approved
   interpretation/source material.
4. The API sends the question, bounded conversation context, and selected excerpts to
   Anthropic Claude.
5. Citation and grounding checks compare the generated answer with retrieved
   provenance. Unsupported/unmatched citation output is corrected or replaced; uncovered
   questions receive an explicit non-answer.
6. The application stores answer/audit information, including question text and selected
   provenance, in Cloud SQL.

Therefore question text leaves the Stanford/GCP boundary twice in the normal flow:
directly to OpenAI for embedding and to Anthropic for generation. Only relevant corpus
text is sent, not a bulk corpus export. No zero-retention claim is made.

## Faculty drafting and corpus flow

Faculty users authenticate with the current Replit-managed Clerk tenant. Server-side membership/role checks govern source,
interpretation, coverage, evaluation, discovery, and related corpus routes. Source text
may be sent to Anthropic for drafting and quality checks, and text selected for retrieval
is sent to OpenAI for 384-dimensional embedding. Approved corpus and provenance reside
in Cloud SQL.

## Automatic scholarly discovery and approval flow

1. A platform administrator can start discovery; an optional scheduled run is controlled
   by `RESEARCH_DISCOVERY_ENABLED`.
2. PubMed and Crossref receive a Faculty name and pillar topic and return metadata and
   abstracts. Publisher landing pages and full text are not crawled by this path.
3. Records are deduplicated by DOI or provider identity. Missing abstracts/identifiers,
   retraction signals, duplicates, and provider errors are retained for review or marked
   failed rather than auto-approved.
4. Anthropic may draft an interpretation from an eligible abstract. A separate Claude
   pass must verify that every material claim is supported and return substantive exact
   quotes from the abstract. Application code verifies those quotes and rejects numbers
   absent from the abstract. Any malformed output or verifier failure goes to review.
   Topic fit is observable to owners but is not an individual-approval gate.
5. Eligible published records are **system-auto-approved without individual faculty
   approval**. Version and audit rows record a system event with null individual
   approver/reviewer; authorship is not presented as endorsement.
6. Approved interpretation claims are embedded through OpenAI and become retrievable.
   Material lacking documented full-text rights is purged under the source-retention
   transaction after the approved claim is embedded.
7. An authorized pillar steward can exclude an unwanted discovered record after
   auto-approval. Exclusion archives it so approved retrieval no longer selects it,
   records the actor and optional reason, and preserves a durable candidate tombstone to
   suppress rediscovery of the same provider record/DOI.

Automatic approval is an application policy check, not external peer review and not a
claim that a named Faculty member endorsed the record.

## Dependency and scanner disposition

The 2026-09-04 post-remediation production audit reported 0 critical and 0 high
findings. The full development tree retains two unpatched `xlsx` highs in the manual
bulk-import script and one unpatched `extract-zip` high in Puppeteer browser-install
tooling; both dependency families are development-only and have no request-serving
Stanford import. Eight moderate and one low production advisory remain disclosed for
owner review. Static-analysis findings in legacy doorway/referral routes and
low-severity operator-script email output are outside the bounded Stanford route flow.

## Stored data and retention

Cloud SQL stores Faculty identity mappings/roles, consumer account data, corpus and
provenance, vectors, raw question/answer audit data, discovery candidates/runs, and
approval/version events. The repository package does not define Stanford backup
retention, log retention, deletion SLAs, legal holds, or provider-side retention. Those
are owner decisions/evidence gaps recorded in `compliance-posture.md`.

## Explicitly excluded flows

There is no Stanford-review flow for billing/Stripe, Apple Health, OTL, partner/MCP,
sleep, analytics/geolocation, decision-room, phone, unrelated newsletters, or other
Palonur surfaces. Legacy Firecrawl collection, private-object reads, and presigned
upload issuance are also blocked or absent. They must undergo review before any future
enablement.