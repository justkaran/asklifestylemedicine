# Stanford SLM database boundary

This document defines the database bounded context for **Ask Lifestyle
Medicine (SLM)** and its Faculty governance workflow. The machine-readable
allowlist is `@workspace/db/schema/slm`
(`lib/db/src/schema/slm.ts`). It can be imported without opening a database
connection or requiring `DATABASE_URL`. The existing `@workspace/db/schema`
barrel remains broader for the combined repository and is not the Stanford
boundary.

This is a schema ownership and handoff document. The versioned Stanford
migration process is described in `DATABASE-MIGRATIONS.md`; it is applied as an
approval-gated release step, never by API startup.

## Startup readiness

With `STANFORD_EDITION=true`, the API fails closed before listening unless the
database is already prepared. Its read-only readiness assertion requires the
`vector` extension, every `slmSchemaManifest.tables` table in the `public`
schema, and at least one row in `drizzle.__drizzle_migrations`. It does not
create extensions or tables, run legacy seeds, or initialize Stripe. Correct a
failure by applying the approved Stanford migration release, then restart the
API.

## Relationship map

```text
pillars
  ├─< faculty_memberships >─ faculty_users
  ├─< faculty_invitations ── invited_by ─> faculty_users
  ├─< sources ── uploaded/rights/purge actors ─> faculty_users
  │    ├─< source_chunks
  │    ├─< source_versions (JSON snapshots)
  │    ├─< source_audit_log ── actor ─> faculty_users
  │    └─< interpretations ── author/reviewer/approver ─> faculty_users
  │          ├─< interpretation_versions (JSON snapshots)
  │          ├─< interpretation_comments
  │          ├─< interpretation_chunks
  │          └─< rubric_check_results >─ rubric_checks ─> pillars
  ├─< knowledge_relations >─ interpretations
  ├─< knowledge_versions
  │    └─< knowledge_version_chunks (frozen retrieval corpus)
  ├─< query_clusters
  ├─< crawl_runs ─< crawl_candidates ──> sources / interpretations
  ├─< research_discovery_runs ─< research_discovery_candidates
  │                                  └─> sources / interpretations
  ├─< gap_discovery_events ──> sources
  └─< pillar_resources

faculty_users ──< faculty_applications ── admitted_pillar ─> pillars
faculty_users ──< faculty_voice_profiles
faculty_users ──< eval_gradings >─ eval_items >─ eval_runs
consumer_accounts ──< visitor_sessions

consumer_login_tokens  expiring, single-use email verification tokens
email_rate_limit_hits  hashed IP/email throttle events

agent_queries         query/answer telemetry; logical pillar/source/
                      interpretation/knowledge-version identifiers
slm_answer_links      durable public answer snapshots; logical query id
uncovered_escalations standalone contact/escalation records
advice_guard_terms    centrally governed answer-safety phrases
institution_agreements institution-level Faculty governance records
```

`<` means “many”. Actor references generally use `ON DELETE SET NULL` so
provenance records survive account removal. Content children generally cascade
from their source, interpretation, knowledge version, or pillar. A pillar
should therefore be retired with `pillars.retired_at`, not deleted.

## Ownership

### Core SLM-owned

- Corpus and review: `pillars`, `sources`, `source_chunks`,
  `source_versions`, `source_audit_log`, `interpretations`,
  `interpretation_versions`, `interpretation_comments`,
  `interpretation_chunks`, `rubric_checks`, `rubric_check_results`.
- Published knowledge: `knowledge_relations`, `knowledge_versions`,
  `knowledge_version_chunks`.
- Public answer operation: `agent_queries`, `query_clusters`,
  `slm_answer_links`, `uncovered_escalations`, `pillar_resources`, and
  `advice_guard_terms`.
- Discovery and coverage: `crawl_runs`, `crawl_candidates`,
  `research_discovery_runs`, `research_discovery_candidates`, and
  `gap_discovery_events`. These support Faculty talk ingestion, the
  PubMed/Crossref metadata-discovery workflow, and follow-up on public
  uncovered questions.
- Quality evaluation: `eval_runs`, `eval_items`, and `eval_gradings`.
- Runtime abuse protection: `email_rate_limit_hits`, a hashed-key sliding
  window for anonymous email-triggering SLM endpoints.

### Shared but required by SLM

- Faculty identity and authorization: `faculty_users`,
  `faculty_memberships`, `faculty_invitations`.
- Faculty admission/governance: `faculty_applications`,
  `institution_agreements`, `faculty_voice_profiles`.
- Consumer identity for the registered Ask SLM experience:
  `consumer_accounts`, `consumer_login_tokens`, and `visitor_sessions`.
  The consumer-account Stripe customer field is dormant when billing is off;
  no Stripe, subscription, journey-pass, or other billing table is included
  in this Stanford boundary.

These are shared because the combined application also uses Faculty identity
outside SLM. Stanford must keep them in the export until an authentication and
directory split supplies equivalent identifiers, roles, deactivation, and
provenance behavior.

### Legacy or other-product tables excluded

Everything absent from `slmSchemaManifest.tables` is outside this boundary.
Notable exclusions include billing/Stripe and partner licensing, consumer
investors, ParentData, stories, support/phone, decision-room, and other
experimental product tables.
Exclusion from the manifest does not delete a table from a current combined
database and does not alter the broad schema barrel.

## Lifecycle transitions

| Record                  | Initial                         | Allowed forward transitions                                                             | Terminal/retained state                                  |
| ----------------------- | ------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Pillar                  | active (`retired_at` null)      | active → retired                                                                        | Retired row remains for content and membership integrity |
| Faculty user            | active (`deactivated_at` null)  | active → deactivated                                                                    | Preserve row and authorship; access is revoked           |
| Invitation              | `pending`                       | pending → `accepted`, `revoked`, or `expired`                                           | Keep outcome and timestamps for governance history       |
| Application             | `applied`                       | applied → `under_review` → `admitted` or `declined`                                     | Decision, actor, and optional note remain                |
| Source content          | `draft`                         | draft → `in_review` → `approved` → `archived`                                           | Archive rather than delete published provenance          |
| Source rights retention | `needs_review`                  | needs_review → `review_window` → `retained_with_rights` or `purged_no_full_text_rights` | Independent of source publication status                 |
| Source assessment       | null                            | null → `draft` → `approved`                                                             | Independent of both source status and rights retention   |
| Interpretation          | `proposed`                      | proposed → `approved` → `archived`                                                      | Version snapshots retain approved history                |
| Knowledge version       | created as a publication        | publish a new immutable version; do not update an old snapshot                          | Older versions remain addressable                        |
| Query cluster           | open/current operational record | Updated by clustering/coverage work                                                     | No schema-level terminal enum                            |
| Public answer link      | immutable snapshot at creation  | No content lifecycle transition                                                         | Expiry/deletion policy is operational, not encoded       |
| Talk crawl run          | `pending`                       | pending → discovering → review → collecting → done or failed                            | Candidates retain per-appearance outcomes                |
| Talk crawl candidate    | `discovered`                    | discovered → fetching → transcribed → ingested, failed, or discarded                    | Ingested rows link to the governed source/interpretation |
| Research discovery run  | `pending`                       | pending → discovering → done or failed                                                  | Provider metadata is retained in candidates              |
| Research candidate      | `discovered`                    | discovered → review → ingested, auto_approved, duplicate, or failed                     | Links to created content use `SET NULL`                  |
| Faculty voice profile   | no row or `manual`              | upsert manual, AI-distilled, or manually edited profile                                 | One active profile per Faculty user                      |
| Evaluation              | run and seeded items            | items are graded; run metrics are recomputed                                            | Runs/items/gradings retain quality evidence              |
| Consumer account        | unverified or verified account  | magic-link verification stamps `email_verified_at`                                      | Identity is retained independently of dormant billing    |
| Consumer login token    | issued                          | issued → consumed or expired                                                            | One-time token; never an entitlement record              |
| Visitor session         | anonymous                       | anonymous → linked → claimed                                                            | Consumer link is `SET NULL` on account deletion          |
| Email rate-limit hit    | allowed request recorded        | no status transition; ages out of throttle window                                       | Hash-keyed operational security record                   |

Authorization code must validate transitions; PostgreSQL enums constrain values
but do not themselves enforce every edge in this matrix.

## Retention, snapshots, and foreign keys

- **Rights purge is not row deletion.** For
  `purged_no_full_text_rights`, remove disallowed full text/derived chunks as
  the application procedure requires, and retain the source metadata, rights
  decision, purge actor/time, and audit trail.
- **Soft retention protects provenance.** Retire pillars, deactivate Faculty
  users, and archive sources/interpretations instead of hard-deleting them.
  Hard deletion invokes declared cascades and is an exceptional,
  approval-controlled operation.
- **Snapshots are deliberate.** `source_versions` and
  `interpretation_versions` preserve review history as JSON.
  `knowledge_versions` freezes the complete published graph, while
  `knowledge_version_chunks` freezes exact retrieval text and embedding
  identity. `slm_answer_links` snapshots the public question, answer, and safe
  citations so a share link does not silently change after corpus edits.
- **Some links intentionally have no FK.** `agent_queries` stores arrays of
  retrieved IDs and a logical `knowledge_version_id`; telemetry must survive
  later corpus cleanup and must not make best-effort logging fail.
  `slm_answer_links.query_id` is logical and unique, but the snapshot survives
  query-log removal. `partner_key_id` is also FK-less, though partner tables are
  outside this boundary. `uncovered_escalations` is standalone by design.
- **Identity deletion preserves attribution shape.** Most actor FKs are
  `SET NULL`; immutable snapshots and audit text remain. Membership/application
  ownership cascades from a hard-deleted Faculty user, which is another reason
  normal offboarding uses deactivation.
- **Discovery links preserve completed work.** Crawl and research candidates
  use `SET NULL` for a subsequently removed source or interpretation, while
  their parent run and candidate rows cascade together. Gap-discovery events
  retain direct pillar/source FKs because they document the resulting governed
  draft.
- **Quality and voice records are Faculty-scoped.** A voice profile cascades
  with its Faculty user. Evaluation items cascade with their run, and a grading
  cascades with its item or grader; normal Faculty offboarding should therefore
  use deactivation when grading history must remain.
- **Consumer identity is runtime-required, not billing scope.**
  `consumer_accounts` supports registered Ask SLM identity and
  `visitor_sessions` links a browser session to it with `SET NULL` on account
  deletion. `consumer_login_tokens` are expiring, single-use verification
  tokens. A nullable Stripe customer identifier may exist on an account, but
  billing remains disabled and this manifest intentionally includes no billing
  tables.
- **Throttle records are minimized operational data.**
  `email_rate_limit_hits` stores a salted hash rather than a raw IP address or
  email and is opportunistically pruned after its limiter window. Stanford
  must still approve the applicable operational retention duration.
- **Durations are not yet encoded.** Stanford must approve concrete retention
  periods for free-text queries, session identifiers, escalation contact data,
  invitations/applications, audit records, and public share links. Until then,
  do not infer a deletion schedule from this schema or purge snapshots needed
  for provenance/legal hold.

## Empty and current database handoff

### Empty Cloud SQL database

1. Create separate least-privilege application and migration roles and enable
   the `vector` extension.
2. Do not treat Drizzle imports or application boot as migration execution.
   First produce and review ordered SQL migrations for exactly the SLM
   manifest, including enums, indexes, constraints, and the seven-pillar seed.
3. Run those migrations in a disposable empty PostgreSQL instance, verify the
   manifest tables/enums/indexes, then run application acceptance tests.

### Existing combined database

1. Take a restorable backup and inventory schema versions/extensions before
   changing anything.
2. Export allowlisted tables only, preserving primary keys, timestamps,
   sequences, enum values, and snapshot JSON. Transfer referenced object-store
   files through a separately verified process.
3. Treat non-FK logical IDs as historical values, not import dependencies.
   Check dangling declared FKs, uniqueness, row counts, sequence positions,
   vector dimensions/model identity, and source purge state before cutover.
4. Reconcile the current schema against reviewed baseline migrations in a
   staging copy. Do not point first-run boot-time DDL at Stanford production.
5. Handle Faculty/application/escalation/query data as sensitive data and use
   Stanford-approved encrypted transfer, access, retention, and deletion
   procedures.
