import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { partnerKeysTable } from "./partnerKeys";

/**
 * IP-protection foundation (Task: corpus hashing, canaries, licensee
 * fingerprints).
 *
 * HONEST-LIMITS: everything in this module is a STATISTICAL EVIDENCE
 * mechanism. Content hashes prove what Palonur's corpus contained at a point
 * in time; canary tokens and zero-width fingerprints are forgeable and
 * strippable in principle and are NEVER cryptographic proof that a third
 * party copied the corpus. UI and docs must say the same (consistent with
 * the copy-watermark and external-data-protection-claims posture).
 */

/**
 * Append-only, timestamped corpus manifests: a hash-of-hashes over all
 * approved content (sources + chunks, canaries included). Rows are only ever
 * INSERTED — never updated or deleted — so the history is a tamper-evident
 * timeline Palonur can point to ("on date D the corpus hashed to H").
 */
export const corpusManifestsTable = pgTable("corpus_manifests", {
  id: serial("id").primaryKey(),
  /** sha256 over the ordered per-source entry lines. */
  manifestHash: text("manifest_hash").notNull(),
  sourceCount: integer("source_count").notNull(),
  chunkCount: integer("chunk_count").notNull(),
  /** Ordered per-source entries: { sourceId, version, contentHash, chunkCount, chunkHashesHash }. */
  entries: jsonb("entries").notNull(),
  /** What triggered this snapshot ("boot", "ingest", "status-change", "admin"). */
  reason: text("reason").notNull().default("boot"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * PRIVATE per-licensee fingerprint mapping. One row per partner key. The
 * secret is derived deterministically from a server-side master secret +
 * the key id, so it can be re-derived for attribution, and is ADMIN-ONLY:
 * it must never be serialized to public or partner-facing endpoints.
 */
export const partnerKeyFingerprintsTable = pgTable(
  "partner_key_fingerprints",
  {
    id: serial("id").primaryKey(),
    partnerKeyId: integer("partner_key_id")
      .notNull()
      .references(() => partnerKeysTable.id, { onDelete: "cascade" }),
    /** Hex HMAC secret this key's markers derive from. Admin-only. */
    fingerprintSecret: text("fingerprint_secret").notNull(),
    /** Short hex code embedded (zero-width encoded) in keyed output. */
    markerCode: text("marker_code").notNull(),
    /** Which canary document variant this licensee is served (index into
     * the seeded canary registry). Deterministic from the secret. */
    canaryVariant: integer("canary_variant").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    keyUnique: uniqueIndex("partner_key_fingerprints_key_unique").on(
      t.partnerKeyId,
    ),
  }),
);

/**
 * PRIVATE probe-prompt library for black-box misuse detection. Each probe is
 * a question designed to elicit a specific canary's fabricated content (or a
 * fingerprint marker) from an external RAG system / fine-tuned model.
 * ADMIN-ONLY: probes must never be serialized on public or partner-facing
 * endpoints — exposure would let a licensee filter them out.
 */
export const misuseProbesTable = pgTable("misuse_probes", {
  id: serial("id").primaryKey(),
  /** Short admin-facing label. */
  label: text("label").notNull(),
  /** The prompt sent to the external system. */
  prompt: text("prompt").notNull(),
  /** What the probe targets: 'canary' | 'fingerprint' | 'general'. */
  targetKind: text("target_kind").notNull().default("canary"),
  /** For canary probes: the canary DOI this probe is tied to (nullable). */
  canaryDoi: text("canary_doi"),
  /**
   * Expected-signal definitions: array of
   * { type: 'canary_token'|'fabricated_association'|'zero_width_marker', note? }.
   * Documents what a HIT looks like for this probe.
   */
  expectedSignals: jsonb("expected_signals").notNull().default([]),
  notes: text("notes"),
  /** Inactive probes are kept for history but skipped by default runs. */
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Persisted detection sessions: one admin-initiated run of probes against an
 * external endpoint or a pasted transcript set, with per-probe responses,
 * detected signals, statistical scoring, and licensee attribution — all
 * timestamped for later evidence export. ADMIN-ONLY.
 */
export const detectionSessionsTable = pgTable("detection_sessions", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  /** 'endpoint' (live HTTP run) or 'transcript' (pasted responses). */
  mode: text("mode").notNull(),
  /** Endpoint config used (URL + header NAMES only — values never stored). */
  target: jsonb("target"),
  /** Per-probe results: [{ probeId, label, prompt, responseText, error, signals }]. */
  results: jsonb("results").notNull().default([]),
  /** Statistical readout (probe/hit counts, base rates, confidence framing). */
  stats: jsonb("stats").notNull().default({}),
  /** Licensee attribution (best match + candidates + ambiguity flag). */
  attribution: jsonb("attribution").notNull().default({}),
  /** Corpus manifest id that was latest when the session ran (evidence anchor). */
  manifestId: integer("manifest_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type CorpusManifest = typeof corpusManifestsTable.$inferSelect;
export type PartnerKeyFingerprint =
  typeof partnerKeyFingerprintsTable.$inferSelect;
export type MisuseProbe = typeof misuseProbesTable.$inferSelect;
export type DetectionSession = typeof detectionSessionsTable.$inferSelect;
