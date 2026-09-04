import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { facultyUsersTable } from "./faculty";

/**
 * A steward's "I'm interested" signal for an upcoming ("Soon") distribution
 * channel that isn't live yet (e.g. "Think Fast, Talk Smart", "The New York
 * Times"). Lets stewards register demand for channels that don't exist as a
 * row anywhere yet, so operators can see which upcoming channels to prioritize.
 *
 * `channelKey` is a stable string identifier for the channel (NOT a foreign
 * key) — Soon channels are defined in the faculty frontend's `channels` array,
 * not in the database, so the key is the only link. One row per
 * (faculty user, channel); the unique index makes "register interest"
 * idempotent (re-clicking does nothing).
 */
export const facultyChannelInterestTable = pgTable(
  "faculty_channel_interest",
  {
    id: serial("id").primaryKey(),
    facultyUserId: integer("faculty_user_id")
      .notNull()
      .references(() => facultyUsersTable.id, { onDelete: "cascade" }),
    channelKey: text("channel_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userChannelUnique: uniqueIndex(
      "faculty_channel_interest_user_channel_unique",
    ).on(t.facultyUserId, t.channelKey),
  }),
);

export type FacultyChannelInterest =
  typeof facultyChannelInterestTable.$inferSelect;
