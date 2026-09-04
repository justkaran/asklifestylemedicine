import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";

/**
 * Single shared document for the private SLM AI-newsletter proposal page
 * (`artifacts/palonur/public/ai-newsletter.html`, id = "slm").
 *
 * `content` is the array of `.page` `outerHTML` strings the page serializes
 * on edit, so edits persist in the database instead of only this browser's
 * localStorage. The page stays private (stripped from prod static), but the
 * table ships via the Drizzle barrel so Publish provisions it.
 */
export const aiNewsletterDoc = pgTable("ai_newsletter_doc", {
  id: text("id").primaryKey(),
  content: jsonb("content").$type<string[]>().default([]).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
