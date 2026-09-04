import { pgTable, serial, text, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Append-only audit of every SUCCESSFUL outbound email send, written by
 * `emailGuard.sendGuarded` only after a send returns without error.
 *
 * It backs the daily + monthly send caps: counting rows in the current UTC
 * day / month window survives process restarts and is shared across instances,
 * unlike the old in-memory counter (which reset to zero on every redeploy,
 * restart, or crash and counted per-process). Failed sends are NEVER recorded,
 * so a failure can never consume budget.
 *
 * The recipient is stored only as a SHA-256 hash (never the raw address),
 * matching the Stories IP-hash privacy posture, so this audit trail carries no
 * PII while still being countable per window.
 */
export const emailSendsTable = pgTable(
  "email_sends",
  {
    id: serial("id").primaryKey(),
    label: text("label").notNull(),
    recipientHash: text("recipient_hash").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    sentAtIdx: index("email_sends_sent_at_idx").on(t.sentAt),
  }),
);
