import {
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ── Advice-guard terms ──────────────────────────────────────────────────────
// Admin-editable "boundary" phrases used by the FDA / advice review surface on
// the internal /admin panel. Every agent answer (agent_queries.answer_text) is
// scanned AT READ TIME against this list, so adding or removing a term
// instantly re-classifies past answers — no re-processing job, no per-row
// flag column that could go stale when the boundaries change.
//
// Each row is a plain phrase (matched case-insensitively on word boundaries)
// in one of three regulatory categories:
//   - `diagnosis` — language that labels the person or their condition
//                   ("you have insomnia", "sounds like sleep apnea")
//   - `dosage`    — dose / dosing / mg-style medication-quantity language
//   - `treatment` — prescriptive treatment or medication directives
//                   ("you should take", "stop taking your medication")
//
// Seeded when empty from DEFAULT_ADVICE_TERMS in the api-server (same
// seed-when-empty pattern as story_editors): deleting every term restores the
// defaults on next read, so the scanner can never silently go blind.
export const adviceGuardTermsTable = pgTable(
  "advice_guard_terms",
  {
    id: serial("id").primaryKey(),
    /** One of: diagnosis | dosage | treatment (validated at the API). */
    category: text("category").notNull(),
    /** Plain phrase, matched case-insensitively on word boundaries. */
    phrase: text("phrase").notNull(),
    /** 'seed' for defaults, 'admin' for terms added via the panel. */
    addedBy: text("added_by").notNull().default("admin"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    categoryPhraseIdx: uniqueIndex("advice_guard_terms_category_phrase_idx").on(
      t.category,
      sql`lower(${t.phrase})`,
    ),
  }),
);

export type AdviceGuardTerm = typeof adviceGuardTermsTable.$inferSelect;
