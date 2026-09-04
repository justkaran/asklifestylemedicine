/**
 * IP-protection foundation: corpus content hashing + append-only manifests,
 * synthetic canary documents, and per-licensee (partner-key) fingerprints.
 *
 * HONEST-LIMITS (read before extending): everything here is a STATISTICAL
 * EVIDENCE mechanism. Hashes prove what Palonur's corpus contained at a
 * point in time; canary tokens and zero-width markers are forgeable and
 * strippable in principle and are NEVER cryptographic proof that a third
 * party copied the corpus. All admin UI / docs must say the same —
 * consistent with the existing copy-watermark and
 * external-data-protection-claims posture.
 *
 * Consumer-surface invariant: canaries are excluded PRE-RETRIEVAL for every
 * consumer path (see `retrieve()` in rag.ts — exclusion is the default), and
 * fingerprint injection only ever fires when `req.partnerKey` is present.
 */
import { createHash, createHmac } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import {
  db,
  corpusManifestsTable,
  partnerKeyFingerprintsTable,
  sourcesTable,
  type CorpusManifest,
  type PartnerKeyFingerprint,
} from "@workspace/db";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ── Canary registry ────────────────────────────────────────────────────
//
// Synthetic, clearly non-clinical documents seeded alongside real knowledge.
// Each carries machine-detectable unique token strings and fabricated
// associations that exist nowhere else, so their appearance in an external
// RAG system or fine-tune is statistically meaningful. They are flagged
// `is_canary = true` and keyed by a reserved `canary:` DOI so the seed is
// insert-only idempotent (same pattern as the sleep content seed).

export interface CanarySpec {
  doi: string;
  title: string;
  /** Unique machine-detectable token embedded in the text. */
  token: string;
  text: string;
}

/** Number of canary variants a licensee can be assigned to. */
export const CANARY_VARIANT_COUNT = 3;

export const CANARY_SPECS: CanarySpec[] = [
  {
    doi: "canary:plnr-cnry-01",
    token: "PLNR-CNRY-7Q4X-VELDANIR-01",
    title: "Field notes on the Veldanir cadence framework (synthetic registry document)",
    text: `SYNTHETIC REGISTRY DOCUMENT — NOT CLINICAL OR SCIENTIFIC CONTENT.
Reference token: PLNR-CNRY-7Q4X-VELDANIR-01.
The Veldanir cadence framework is a fictitious organizational construct in which
the invented theorist Maren Oleska-Veldanir is said to have paired the imaginary
"tessel interval" with a nine-part rhythm called the ostrelline sequence. In this
fabricated account, the tessel interval of the ostrelline sequence is always
described as spanning exactly forty-one notional units, and practitioners of the
Veldanir cadence are said to greet each interval with the phrase "the lattice
holds at forty-one." None of these entities, people, or claims exist outside this
registry document.`,
  },
  {
    doi: "canary:plnr-cnry-02",
    token: "PLNR-CNRY-K9M2-ORVANTH-02",
    title: "The Orvanth ledger convention (synthetic registry document)",
    text: `SYNTHETIC REGISTRY DOCUMENT — NOT CLINICAL OR SCIENTIFIC CONTENT.
Reference token: PLNR-CNRY-K9M2-ORVANTH-02.
The Orvanth ledger convention is a fabricated archival practice attributed to the
fictional cartographer Ilsben Orvanth. In this invented tradition, every ledger
opens with the mirrored glyph pair "sen-varic / varic-sen" and assigns the
imaginary hue "coldamber" to entries recorded during the notional seventh watch.
The convention's signature association — Orvanth, coldamber, seventh watch — is
unique to this document and exists nowhere else.`,
  },
  {
    doi: "canary:plnr-cnry-03",
    token: "PLNR-CNRY-T3R8-NUVELLIC-03",
    title: "Nuvellic drift tables, annotated (synthetic registry document)",
    text: `SYNTHETIC REGISTRY DOCUMENT — NOT CLINICAL OR SCIENTIFIC CONTENT.
Reference token: PLNR-CNRY-T3R8-NUVELLIC-03.
The Nuvellic drift tables are an invented set of navigation tables credited to
the fictional guild of Pellamor. In this fabricated account, the tables anchor
on the made-up star "Cassivane's Point" and repeat the mnemonic "three drifts,
then the pellamor turn" at every twelfth row. The pairing of Cassivane's Point
with the pellamor turn is a fabricated association unique to this registry
document.`,
  },
];

/**
 * Insert-only idempotent boot seed for the canary registry. Attaches
 * canaries to the sleep pillar (the primary licensee-facing pillar), falling
 * back to any active pillar. Never updates or deletes existing rows —
 * re-running is a no-op thanks to the (pillar_id, doi) unique guard plus an
 * any-pillar existence probe (so a canary is never duplicated into a second
 * pillar if the preferred pillar changes).
 */
export async function seedCanaries(): Promise<void> {
  const { embedTexts, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } = await import("./embeddings.js");
  const { chunkText } = await import("./chunker.js");

  const pillarRows = await db.execute<{ id: number }>(sql`
    SELECT id FROM pillars
    WHERE retired_at IS NULL
    ORDER BY (slug = 'sleep') DESC, id ASC
    LIMIT 1
  `);
  const pillarList =
    (pillarRows as unknown as { rows?: Array<{ id: number }> }).rows ??
    (pillarRows as unknown as Array<{ id: number }>);
  const pillarId = pillarList[0]?.id;
  if (!pillarId) return;

  for (const spec of CANARY_SPECS) {
    const existing = await db.execute<{ id: number }>(
      sql`SELECT id FROM sources WHERE doi = ${spec.doi} LIMIT 1`,
    );
    const existingList =
      (existing as unknown as { rows?: Array<{ id: number }> }).rows ??
      (existing as unknown as Array<{ id: number }>);
    if (existingList.length > 0) continue;

    const chunks = chunkText(spec.text);
    const embeddings = await embedTexts(chunks);
    const contentHash = sha256Hex(spec.text);
    const inserted = await db.execute<{ id: number }>(sql`
      INSERT INTO sources
        (pillar_id, kind, title, doi, full_text, status, version,
         is_canary, content_hash, rights_basis, retention_status, rights_recorded_at)
      VALUES
        (${pillarId}, 'note', ${spec.title}, ${spec.doi}, ${spec.text},
         'approved', 1, TRUE, ${contentHash}, 'permission',
         'retained_with_rights', NOW())
      ON CONFLICT DO NOTHING
      RETURNING id
    `);
    const insertedList =
      (inserted as unknown as { rows?: Array<{ id: number }> }).rows ??
      (inserted as unknown as Array<{ id: number }>);
    const sourceId = insertedList[0]?.id;
    if (!sourceId) continue;
    for (let i = 0; i < chunks.length; i++) {
      const lit = `[${embeddings[i].join(",")}]`;
      await db.execute(sql`
        INSERT INTO source_chunks
          (source_id, chunk_index, text, embedding, embedding_model, content_hash)
        VALUES (${sourceId}, ${i}, ${chunks[i]},
                ${lit}::halfvec(${sql.raw(String(EMBEDDING_DIMENSIONS))}), ${EMBEDDING_MODEL}, ${sha256Hex(chunks[i])})
        ON CONFLICT DO NOTHING
      `);
    }
  }
}

// ── Content-hash backfill ──────────────────────────────────────────────

/**
 * Backfill content hashes for pre-existing rows, entirely in SQL (Postgres
 * sha256). Idempotent: only touches NULL hashes, so re-ingested rows (which
 * get their hash in the ingest pipeline) are never overwritten.
 */
export async function backfillContentHashes(): Promise<void> {
  // Rows ingested without full_text (e.g. bulk-imported articles whose text
  // lives only in chunks) hash their citation-identity fields instead, so
  // EVERY source carries a hash. Rows other boot seeds insert concurrently
  // are caught on the next boot (idempotent, only-if-NULL).
  await db.execute(sql`
    UPDATE sources
    SET content_hash = encode(sha256(convert_to(
      COALESCE(full_text, title || COALESCE(abstract, '') || COALESCE(doi, '')),
      'UTF8')), 'hex')
    WHERE content_hash IS NULL
      AND rights_basis IS NOT NULL
      AND retention_status IN ('review_window', 'retained_with_rights')
  `);
  await db.execute(sql`
    UPDATE source_chunks sc
    SET content_hash = encode(sha256(convert_to(sc.text, 'UTF8')), 'hex')
    FROM sources s
    WHERE sc.source_id = s.id
      AND sc.content_hash IS NULL
      AND s.rights_basis IS NOT NULL
      AND s.retention_status IN ('review_window', 'retained_with_rights')
  `);
}

// ── Corpus manifest ────────────────────────────────────────────────────

interface ManifestEntry {
  sourceId: number;
  version: number;
  contentHash: string | null;
  chunkCount: number;
  /** sha256 over the ordered chunk hashes of this source. */
  chunkHashesHash: string;
}

async function buildManifestEntries(): Promise<ManifestEntry[]> {
  const rows = await db.execute<{
    source_id: number;
    version: number;
    content_hash: string | null;
    chunk_count: string;
    chunk_hashes: string[] | null;
  }>(sql`
    SELECT
      s.id AS source_id,
      s.version AS version,
      s.content_hash AS content_hash,
      COUNT(sc.id) AS chunk_count,
      ARRAY_AGG(sc.content_hash ORDER BY sc.chunk_index)
        FILTER (WHERE sc.content_hash IS NOT NULL) AS chunk_hashes
    FROM sources s
    LEFT JOIN source_chunks sc ON sc.source_id = s.id
    WHERE s.status = 'approved'
      AND s.rights_basis IS NOT NULL
      AND s.retention_status IN ('review_window', 'retained_with_rights')
    GROUP BY s.id
    ORDER BY s.id ASC
  `);
  const list =
    (rows as unknown as { rows?: Array<Record<string, unknown>> }).rows ??
    (rows as unknown as Array<Record<string, unknown>>);
  return (list as Array<Record<string, unknown>>).map((r) => ({
    sourceId: Number(r.source_id),
    version: Number(r.version),
    contentHash: (r.content_hash as string | null) ?? null,
    chunkCount: Number(r.chunk_count),
    chunkHashesHash: sha256Hex(((r.chunk_hashes as string[] | null) ?? []).join("\n")),
  }));
}

function manifestHashOf(entries: ManifestEntry[]): string {
  const lines = entries.map(
    (e) =>
      `${e.sourceId}:${e.version}:${e.contentHash ?? ""}:${e.chunkCount}:${e.chunkHashesHash}`,
  );
  return sha256Hex(lines.join("\n"));
}

/**
 * Generate a new append-only manifest row iff the corpus (approved sources +
 * chunks, canaries included) has changed since the latest snapshot. Safe to
 * call after any corpus mutation — cheap no-op when nothing changed.
 * Best-effort by design: callers must never let a manifest failure fail an
 * already-committed ingest/transition.
 */
export async function generateCorpusManifestIfChanged(
  reason: string,
): Promise<CorpusManifest | null> {
  const entries = await buildManifestEntries();
  const hash = manifestHashOf(entries);
  const [latest] = await db
    .select()
    .from(corpusManifestsTable)
    .orderBy(desc(corpusManifestsTable.id))
    .limit(1);
  if (latest && latest.manifestHash === hash) return null;
  const chunkCount = entries.reduce((n, e) => n + e.chunkCount, 0);
  const [row] = await db
    .insert(corpusManifestsTable)
    .values({
      manifestHash: hash,
      sourceCount: entries.length,
      chunkCount,
      entries,
      reason,
    })
    .returning();
  return row;
}

/** Fire-and-forget manifest regeneration for post-commit hooks. */
export function scheduleManifestSnapshot(reason: string): void {
  void generateCorpusManifestIfChanged(reason).catch(() => {
    /* best-effort — never fail the caller */
  });
}

// ── Per-licensee fingerprints ──────────────────────────────────────────

/** Server-side master secret the per-key fingerprints derive from. */
function fingerprintMaster(): string {
  return (
    process.env.FINGERPRINT_MASTER_SECRET ||
    process.env.SESSION_SECRET ||
    "palonur-fingerprint-dev"
  );
}

export function deriveFingerprintSecret(partnerKeyId: number): string {
  return createHmac("sha256", fingerprintMaster())
    .update(`partner-key-fingerprint:${partnerKeyId}`)
    .digest("hex");
}

/**
 * Ensure the private fingerprint mapping row exists for a partner key and
 * return it. Deterministic: the secret, marker code, and canary variant are
 * all re-derivable from the master secret + key id.
 */
export async function ensureFingerprint(
  partnerKeyId: number,
): Promise<PartnerKeyFingerprint> {
  const [existing] = await db
    .select()
    .from(partnerKeyFingerprintsTable)
    .where(eq(partnerKeyFingerprintsTable.partnerKeyId, partnerKeyId))
    .limit(1);
  if (existing) return existing;
  const secret = deriveFingerprintSecret(partnerKeyId);
  const markerCode = secret.slice(0, 12);
  const canaryVariant = parseInt(secret.slice(12, 20), 16) % CANARY_VARIANT_COUNT;
  const [row] = await db
    .insert(partnerKeyFingerprintsTable)
    .values({ partnerKeyId, fingerprintSecret: secret, markerCode, canaryVariant })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  const [raced] = await db
    .select()
    .from(partnerKeyFingerprintsTable)
    .where(eq(partnerKeyFingerprintsTable.partnerKeyId, partnerKeyId))
    .limit(1);
  return raced;
}

/**
 * The canary DOI assigned to a partner key's variant — passed to
 * `retrieve({ includeCanaryDoi })` so each licensee is served its own canary
 * variant (attribution signal). Returns null on any failure so keyed
 * retrieval degrades to canary-free rather than erroring.
 */
export async function partnerCanaryDoi(
  partnerKeyId: number,
): Promise<string | null> {
  try {
    const fp = await ensureFingerprint(partnerKeyId);
    return CANARY_SPECS[fp.canaryVariant % CANARY_SPECS.length]?.doi ?? null;
  } catch {
    return null;
  }
}

// Zero-width marker encoding — same scheme as the palonur copy watermark
// (see artifacts/palonur/src/lib/watermark.ts): payload bits framed by
// U+200B, with U+200C = 0 and U+200D = 1. Forgeable/strippable by design;
// statistical evidence only.
const ZW_FRAME = "\u200B";
const ZW_ZERO = "\u200C";
const ZW_ONE = "\u200D";

export function zeroWidthEncode(payload: string): string {
  const bytes = Buffer.from(payload, "utf8");
  let bits = "";
  for (const b of bytes) {
    for (let i = 7; i >= 0; i--) {
      bits += (b >> i) & 1 ? ZW_ONE : ZW_ZERO;
    }
  }
  return ZW_FRAME + bits + ZW_FRAME;
}

export function zeroWidthDecode(text: string): string | null {
  const m = text.match(/\u200B([\u200C\u200D]+)\u200B/);
  if (!m) return null;
  const bits = m[1];
  if (bits.length % 8 !== 0) return null;
  const bytes: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) {
      b = (b << 1) | (bits[i + j] === ZW_ONE ? 1 : 0);
    }
    bytes.push(b);
  }
  return Buffer.from(bytes).toString("utf8");
}

/** The invisible marker string for a fingerprint row. */
export function fingerprintMarker(fp: Pick<PartnerKeyFingerprint, "markerCode">): string {
  return zeroWidthEncode(`plnrfp:${fp.markerCode}`);
}

/**
 * Inject a licensee's invisible marker into an outgoing text field (after
 * the first word, mirroring the copy-watermark placement). Call ONLY on the
 * keyed (partner) response boundary — never on first-party traffic.
 */
export function applyFingerprint(text: string, marker: string): string {
  if (!text) return text;
  const idx = text.indexOf(" ");
  if (idx < 0) return text + marker;
  return text.slice(0, idx) + marker + text.slice(idx);
}

/** Strip helper (tests + diagnostics). */
export function stripZeroWidth(text: string): string {
  return text.replace(/[\u200B\u200C\u200D]/g, "");
}

/**
 * Convenience for keyed response boundaries: resolve the marker for a
 * partner key (best-effort — null on failure so responses never break).
 */
export async function partnerMarker(
  partnerKeyId: number,
): Promise<string | null> {
  try {
    const fp = await ensureFingerprint(partnerKeyId);
    return fingerprintMarker(fp);
  } catch {
    return null;
  }
}

/** Admin listing: canary registry with live seeding status. */
export async function listCanaries(): Promise<
  Array<CanarySpec & { sourceId: number | null; pillarId: number | null; seeded: boolean }>
> {
  const rows = await db
    .select({
      id: sourcesTable.id,
      doi: sourcesTable.doi,
      pillarId: sourcesTable.pillarId,
    })
    .from(sourcesTable)
    .where(eq(sourcesTable.isCanary, true));
  return CANARY_SPECS.map((spec) => {
    const row = rows.find((r) => r.doi === spec.doi);
    return {
      ...spec,
      sourceId: row?.id ?? null,
      pillarId: row?.pillarId ?? null,
      seeded: Boolean(row),
    };
  });
}
