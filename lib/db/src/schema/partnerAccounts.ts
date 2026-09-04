import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  pgEnum,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Self-serve partner account lifecycle for programmatic / MCP access.
 *
 *   requested → approved → active            (the happy path)
 *               ↘ rejected                    (admin declines a request)
 *   active     → suspended                    (reserved; not self-serve)
 *
 * A partner signs up (status `requested`), an admin approves (`approved`),
 * the partner self-serves a Stripe payment which flips them to `active`, and
 * only then can the portal mint their API key. The admin "hand-mint a key"
 * path (partner_keys with a NULL partner_account_id) is completely separate
 * and unchanged by this lifecycle.
 */
export const partnerAccountStatusEnum = pgEnum("partner_account_status", [
  "requested",
  "approved",
  "active",
  "rejected",
  "suspended",
]);

export const partnerAccountsTable = pgTable("partner_accounts", {
  id: serial("id").primaryKey(),
  /** Lowercased contact email — the magic-link identity for the portal. */
  email: text("email").notNull().unique(),
  companyName: text("company_name").notNull(),
  contactName: text("contact_name").notNull(),
  /** Free-text "what are you building" from the signup form. */
  intendedUse: text("intended_use"),
  status: partnerAccountStatusEnum("status").notNull().default("requested"),
  /** When the partner accepted the agent usage license at signup. */
  licenseAcceptedAt: timestamp("license_accepted_at", { withTimezone: true }),
  /** Stripe customer minted for this partner so checkout + subscription
   * lookups attach to a stable customer across rotations. */
  stripeCustomerId: text("stripe_customer_id"),
  /** Internal admin note (e.g. why rejected). Never serialized to the partner. */
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Magic-link sessions for the partner portal. Mirrors the investor/newsletter
 * pattern: a short-lived `magicToken` emailed as a one-time link is exchanged
 * for a long-lived `sessionToken` stored in a signed httpOnly cookie.
 */
export const partnerAccountSessionsTable = pgTable(
  "partner_account_sessions",
  {
    id: serial("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => partnerAccountsTable.id, { onDelete: "cascade" }),
    magicToken: text("magic_token").notNull().unique(),
    sessionToken: text("session_token").unique(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    sessionExpiresAt: timestamp("session_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    magicTokenIdx: uniqueIndex("partner_account_sessions_magic_token_uniq").on(
      t.magicToken,
    ),
  }),
);

export const insertPartnerAccountSchema = createInsertSchema(
  partnerAccountsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertPartnerAccount = z.infer<typeof insertPartnerAccountSchema>;
export type PartnerAccount = typeof partnerAccountsTable.$inferSelect;
export type PartnerAccountSession =
  typeof partnerAccountSessionsTable.$inferSelect;
