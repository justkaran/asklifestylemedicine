import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Audit log of successful logins to the Stanford OTL governance dashboard.
 *
 * The dashboard uses ONE shared password (no per-person account), so a row
 * here means "someone authenticated with the OTL password" — it records WHEN
 * and FROM WHERE (client IP + coarse ip-api geolocation + user-agent) so the
 * platform admin can see whether OTL has actually opened the dashboard and
 * from where. `country`/`country_code`/`city` are filled asynchronously and
 * stay null for private IPs or when the geo lookup fails.
 */
export const otlLoginEvents = pgTable("otl_login_events", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  via: text("via").notNull().default("password"),
  ip: text("ip"),
  country: text("country"),
  countryCode: text("country_code"),
  city: text("city"),
  userAgent: text("user_agent"),
});
