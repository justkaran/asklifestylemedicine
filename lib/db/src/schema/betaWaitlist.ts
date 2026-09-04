import { pgTable, serial, text, timestamp, boolean } from "drizzle-orm/pg-core";

/**
 * Beta-testing pre-registration waitlist.
 *
 * Populated by POST /api/beta/register before Stripe review is complete.
 * When live keys are enabled an operator script loops these rows and emails
 * each registrant a personal checkout link via POST /api/beta/checkout.
 * Email is unique so a duplicate submission silently no-ops (idempotent).
 *
 * variant:         A/B test assignment — "all-pillars" | "sleep" | null
 * founding_member: visitor indicated founding-member intent ($12/mo vs $89/mo)
 */
export const betaWaitlistTable = pgTable("beta_waitlist", {
  id: serial("id").primaryKey(),
  name: text("name"),
  email: text("email").notNull().unique(),
  variant: text("variant"),
  foundingMember: boolean("founding_member").notNull().default(false),
  referralSource: text("referral_source"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
