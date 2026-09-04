import {
  pgTable,
  serial,
  integer,
  bigint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Steward earnings ledger — the 80/20 revenue split record for paid steward
 * Q&A subscriptions ($9/mo per publication).
 *
 * One row per PAID Stripe invoice on a steward-publication subscription. This
 * is a reimbursement record only (like the newsletter credit ledger): no money
 * moves through this table. Rows are minted lazily at read time from the
 * synced `stripe.invoices` mirror, so minting must be idempotent — the unique
 * index on `stripe_invoice_id` plus INSERT ... ON CONFLICT DO NOTHING
 * guarantees a re-read (or a webhook-triggered re-sync) never double-credits.
 *
 * `publication_id` / `faculty_user_id` are loose references (no FK) so a
 * later publication or account deletion can never orphan-fail the financial
 * record; slug + names are denormalized for the same reason (the ledger stays
 * legible even if the source rows change).
 */
export const stewardEarningsTable = pgTable(
  "steward_earnings",
  {
    id: serial("id").primaryKey(),
    stripeInvoiceId: text("stripe_invoice_id").notNull(),
    publicationId: integer("publication_id").notNull(),
    facultyUserId: integer("faculty_user_id"),
    publicationSlug: text("publication_slug").notNull(),
    publicationName: text("publication_name"),
    stewardName: text("steward_name"),
    /** Total invoice amount actually paid, in the smallest currency unit. */
    grossCents: bigint("gross_cents", { mode: "number" }).notNull(),
    /** Steward's 80% share. */
    stewardCents: bigint("steward_cents", { mode: "number" }).notNull(),
    /** Palonur's 20% share (gross - steward, so the split always sums). */
    palonurCents: bigint("palonur_cents", { mode: "number" }).notNull(),
    currency: text("currency").notNull().default("usd"),
    /** When the underlying Stripe invoice was created/paid (unix epoch sec). */
    invoiceCreated: integer("invoice_created"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("steward_earnings_invoice_uniq").on(t.stripeInvoiceId)],
);
