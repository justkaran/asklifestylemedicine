# Palonur Data Retention & Deletion Policy

_Last updated: August 13, 2026_

This document states how long each category of personal data is kept, how the
schedule is enforced, and how a consumer can export or delete their data. The
enforcement code lives in `artifacts/api-server/src/lib/retention.ts`
(`runRetentionCleanup()`, scheduled daily) and the consumer self-serve flows in
`artifacts/api-server/src/routes/consumerData.ts`. A plain-language summary is
published on the public privacy page (`/privacy`, section "How long we keep
data").

## Retention schedule

| Category                      | Data                                                                                                                   | Retention                                                                                                                                                                                                      | Enforcement                            |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Magic-link sign-in tokens     | `consumer_login_tokens` (email + one-time token)                                                                       | Tokens expire in ≤30 minutes; rows deleted **30 days** after expiry                                                                                                                                            | Daily job                              |
| Members reading-room sessions | `newsletter_subscriber_sessions` (email + tokens)                                                                      | Magic tokens/sessions deleted **30 days** after expiry                                                                                                                                                         | Daily job                              |
| Doorway (inbound SMS) events  | `doorway_events` — phone stored **only as a salted hash**; a raw text excerpt is kept only for crisis-flagged messages | Text excerpt blanked after **90 days**; the event row (hash, outcome, timestamp) is kept for audit                                                                                                             | Daily job                              |
| Doorway links                 | `doorway_links.question` (the user's raw message)                                                                      | Blanked **24 hours** after link expiry; row kept for use-count audit                                                                                                                                           | Opportunistic on each mint + daily job |
| Agent question history        | `agent_queries` (question, answer, random session id — never IP/UA/email)                                              | Kept as pseudonymous operational logs; account linkage (`visitor_sessions`) deleted after **24 months** of inactivity, and immediately on account deletion                                                     | Daily job + deletion flow              |
| Raw analytics                 | `palonur_pageviews`, `palonur_video_views`                                                                             | IP nulled after **90 days**; raw rows deleted after **~13 months** (400 days). Aggregates are non-personal and may be kept                                                                                     | Daily job                              |
| Email send log                | `email_sends` — recipient stored **only as a salted hash**                                                             | Rows deleted after **~13 months** (396 days)                                                                                                                                                                   | Daily job                              |
| Consumer accounts             | `consumer_accounts`, phone opt-ins, notification preferences                                                           | Kept while the account exists; deleted/anonymized on request via the account page (see below). Inactive accounts are reviewed for anonymization after **36 months** without any sign-in or active subscription | Deletion flow (self-serve)             |
| Phone numbers                 | `phone_subscribers` (raw number, held only with explicit opt-in)                                                       | Kept while the opt-in is active; deleted on account deletion; STOP opts out immediately                                                                                                                        | Deletion flow + STOP handling          |
| Referral data                 | `referral_codes.owner_email`, `referral_events.recipient_email`                                                        | Kept while the account exists; owner code deleted and recipient emails nulled on account deletion (click IPs already stored only as hashes)                                                                    | Deletion flow                          |
| Billing records               | Stripe-synced rows (`stripe.*` schema)                                                                                 | Retained as required for financial/tax records, but **detached** from the deleted account (our side stores no remaining link); card data never touches our servers                                             | Deletion flow                          |

## Explicit exemption: governance data

Steward/faculty governance data — approved sources, interpretation versions,
approval/audit logs, crawl provenance, and eval records — is **retained
indefinitely, by design**. It is the accountability record proving every public
answer was grounded in steward-approved science. It concerns professional
activity of faculty stewards (not consumer personal data) and is never subject
to consumer deletion requests. The retention job never touches these tables.

## Consumer export ("download my data")

A signed-in consumer (magic-link authenticated, `/account`) can request a data
export. The server compiles their stored profile, active subscriptions,
weekly-call bookings, referral data, and question history (including saved
answers) and emails it to the account's verified address
through the guarded email path. Only the verified owner of the email can
trigger it, because the session cookie is only ever minted by consuming an
emailed magic link.

## Consumer deletion

The same authenticated surface offers account deletion behind an explicit
confirm step (typing DELETE). An account with a still-active subscription must
cancel it first (via the billing portal) so deletion can never orphan a
recurring charge. All local data changes run in a single transaction — a
mid-flow failure rolls everything back, never leaving a half-deleted account.
Deletion:

- anonymizes the `consumer_accounts` row in place (email replaced with a
  non-identifying placeholder, display name and Stripe customer link cleared) —
  in-place anonymization rather than row deletion so foreign keys (journey
  passes, bookings, referrals) survive without PII;
- deletes phone opt-ins and notification preferences;
- deletes `visitor_sessions` linkage rows, severing the account from its
  question history (the queries remain as pseudonymous logs);
- nulls the account link and blanks any text excerpt/question on doorway rows
  (event rows kept for audit, without content);
- deletes login tokens, newsletter subscriber rows, and reading-room sessions
  for the email;
- deletes all account-linked conversation threads and their messages (sleep
  Stripe id and self-reported call time from weekly-call booking markers, and
  nulls the Stripe checkout handle on journey passes;
- deletes the account's referral code, nulls their email from referral events
  where they were the referred party, and deletes their bonus counter;
- **detaches** billing: Stripe-synced records are retained (financial records
  must be kept) but the deleted account no longer references them and holds no
  PII;
- clears the session cookies and sends a confirmation email to the (now
  removed) address.

## Out of scope

Vendor-side retention (Anthropic/OpenAI/Tavus/Stripe/Resend) is governed by
each provider's terms; see the privacy policy for what crosses to providers.
Admin/faculty accounts are Clerk-managed and handled separately.
