/**
 * Shared, idempotent Sleep content seed.
 *
 * Adds a small set of real, approved sources + interpretations to the "sleep"
 * pillar (stewarded by Prof. Jamie Zeitzer) so the public /api/sleep-agent
 * answers previously-UNCOVERED everyday sleep questions with honest provenance.
 *
 * This complements — it never replaces — the existing curated sleep corpus.
 * Every entry below has a title that does NOT collide with an existing sleep
 * source, and idempotency keys on (pillarId, title), so re-running this seed (at
 * boot or by hand) can only insert/heal these specific rows. It will never
 * clobber a steward-curated interpretation on a different source.
 *
 * The nine sources fill genuine coverage gaps that the existing corpus did not
 * answer:
 *   - middle-of-the-night ("3am") awakenings           -> Ohayon et al., 2010
 *   - food / snacks for better sleep                   -> St-Onge et al., 2016
 *   - bedroom temperature / "best mattress"            -> Okamoto-Mizuno & Mizuno, 2012
 *   - evening caffeine shifting the body clock         -> Burke et al., 2015
 *   - heart-rate variability vs. real sleep            -> Faerman, Kaplan & Zeitzer, 2020
 *   - REM sleep quality and genetics                   -> Zeitzer et al., 2011
 *   - why sleep fragments with age (orexin biology)    -> Li et al., 2022 (Science)
 *   - afternoon light timing for sleep consolidation   -> Lok, Zeitzer et al., 2023
 *   - disrupted sleep/activity rhythms + AD/PD risk    -> Winer, Zeitzer et al., 2024
 *
 * Accuracy: every source is a real, published paper with real authors, year,
 * journal, and DOI. The interpretations are written in the steward's plain
 * curatorial voice and only assert what the cited work (or well-established
 * sleep physiology) supports; genuinely uncertain points live in NOT PROVEN.
 * Nothing here is invented. The last two papers (HRV/wearables and REM EEG
 * genetics) are Jamie Zeitzer's OWN published work; the first four are external
 * papers he stewards and interprets, exactly as the existing corpus cites
 * Drake, Van Dongen, and others.
 *
 * This module is embeddings-agnostic: lib/db carries no
 * embedding dependency, so the caller supplies embedTexts, toVectorLiteral, and
 * the embedding model name. Consumed by:
 *   - scripts/src/seed-sleep.ts (manual / dev run);
 *   - artifacts/api-server boot (best-effort, post-listen) so a fresh production
 *     database self-heals these answers on the next publish.
 *
 * Idempotent and accuracy-preserving:
 *   - skips any source already approved-with-chunks;
 *   - keys interpretations on the single-approved-per-source schema constraint;
 *   - bootstraps the Jamie Zeitzer steward by the same pending:<email>
 *     convention as seed-stanford-faculty, never clobbering a reconciled row.
 */
import { and, eq, or, sql } from "drizzle-orm";
import { db, pool } from "../index";
import { sourcesTable, interpretationsTable } from "../schema";

const PILLAR_SLUG = "sleep";
const CHARS_PER_TOKEN = 4;
const SOURCE_CHUNK_TOKENS = 500;
const SOURCE_OVERLAP_TOKENS = 50;
const INTERP_CHUNK_TOKENS = 350; // matches artifacts/api-server/src/routes/interpretations.ts
const INTERP_OVERLAP_TOKENS = 30;

// Jamie Zeitzer steward bootstrap. The email mirrors seed-stanford-faculty's
// EMAIL_OVERRIDES so a real first sign-in reconciles to one person and dev rows
// line up with prod. Jamie is consolidated onto this single canonical account
// (jzeitzer@stanford.edu); the older dotted-email account has been retired.
const STEWARD_NAME = "Jamie Zeitzer";
const STEWARD_EMAIL = "jzeitzer@stanford.edu";

export interface SleepSeedLog {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface SleepSeedDeps {
  /** Embeds text -> embedding vectors. Caller owns the embedding model. */
  embedTexts: (inputs: string[]) => Promise<number[][]>;
  /** Formats a number[] as a pgvector / halfvec literal "[1,2,3]". */
  toVectorLiteral: (vec: number[]) => string;
  /** The embedding model name stored on chunks; rag gates retrieval on it. */
  embeddingModel: string;
  log?: SleepSeedLog;
}

export interface SleepSeedResult {
  seeded: boolean;
  reason?: string;
  sources: number;
  interpretations: number;
}

interface SeedContext {
  embedTexts: (inputs: string[]) => Promise<number[][]>;
  toVectorLiteral: (vec: number[]) => string;
  embeddingModel: string;
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

function chunkText(
  text: string,
  opts: { chunkTokens?: number; overlapTokens?: number } = {},
): string[] {
  const chunkChars =
    (opts.chunkTokens ?? SOURCE_CHUNK_TOKENS) * CHARS_PER_TOKEN;
  const overlapChars =
    (opts.overlapTokens ?? SOURCE_OVERLAP_TOKENS) * CHARS_PER_TOKEN;
  const normalized = text
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .trim();
  if (!normalized) return [];
  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: string[] = [];
  let buf = "";
  for (const p of paragraphs) {
    const cand = buf.length === 0 ? p : `${buf}\n\n${p}`;
    if (cand.length <= chunkChars) {
      buf = cand;
      continue;
    }
    if (buf.length > 0) {
      chunks.push(buf);
      buf = buf.slice(Math.max(0, buf.length - overlapChars));
      buf = buf.length > 0 ? `${buf}\n\n${p}` : p;
    } else {
      buf = p;
    }
    while (buf.length > chunkChars) {
      chunks.push(buf.slice(0, chunkChars));
      buf = buf.slice(chunkChars - overlapChars);
    }
  }
  if (buf.trim().length > 0) chunks.push(buf);
  return chunks;
}

interface SeedSource {
  /** Stable idempotency key + display title. Must NOT collide with an existing
   *  sleep source title. Each hosts its own approved interpretation (the schema
   *  allows only one approved interpretation per source). */
  kind?: "paper" | "note";
  title: string;
  authors: string | null;
  year: number | null;
  journal: string | null;
  doi: string | null;
  sourceUrl: string;
  abstract: string;
  fullText: string;
}

interface SeedInterpretation {
  /** Matches a SeedSource.title above. */
  sourceTitle: string;
  answer: string;
  interpretation: string;
  notProven?: string | null;
  action?: string | null;
  tags?: string[];
}

/**
 * Ensure the Jamie Zeitzer steward + his steward membership on the sleep pillar
 * exist, idempotently. Returns the faculty_users id to attribute seeded
 * sources / interpretations to. Mirrors seed-stanford-faculty's precedence so
 * mixed-state databases resolve to the right person and reconciled rows are
 * never clobbered.
 */
async function ensureZeitzerSteward(
  ctx: SeedContext,
  pillarId: number,
): Promise<number> {
  const found = await pool.query<{ id: number; clerk_user_id: string }>(
    `SELECT id, clerk_user_id FROM faculty_users
       WHERE lower(email) = lower($1) OR lower(full_name) = lower($2)
       ORDER BY
         (CASE WHEN lower(email) = lower($1) THEN 0 ELSE 1 END),
         (CASE WHEN clerk_user_id LIKE 'pending:%' THEN 1 ELSE 0 END),
         id ASC
       LIMIT 1`,
    [STEWARD_EMAIL, STEWARD_NAME],
  );

  let userId: number;
  if (found.rows[0]) {
    userId = found.rows[0].id;
    const real = !found.rows[0].clerk_user_id.startsWith("pending:");
    if (real) {
      // Real reconciled user: only ensure a display name; never touch their
      // real email / clerk id.
      await pool.query(
        `UPDATE faculty_users SET full_name = COALESCE(full_name, $2) WHERE id = $1`,
        [userId, STEWARD_NAME],
      );
    } else {
      await pool.query(
        `UPDATE faculty_users
           SET full_name = $2, email = $3, clerk_user_id = $4
           WHERE id = $1`,
        [userId, STEWARD_NAME, STEWARD_EMAIL, `pending:${STEWARD_EMAIL}`],
      );
    }
    ctx.info(`  steward: ${STEWARD_NAME} (faculty_users.id=${userId})`);
  } else {
    const created = await pool.query<{ id: number }>(
      `INSERT INTO faculty_users (clerk_user_id, email, full_name)
         VALUES ($1, $2, $3)
       RETURNING id`,
      [`pending:${STEWARD_EMAIL}`, STEWARD_EMAIL, STEWARD_NAME],
    );
    userId = created.rows[0].id;
    ctx.info(`  + steward: ${STEWARD_NAME} (faculty_users.id=${userId})`);
  }

  // Headshot backfill, only-if-NULL (mirrors stewardRoster's photoUrl
  // semantics — a steward's own upload is never reverted). Also lives here
  // because on a fresh DB this seed may create Jamie's row AFTER the roster
  // seed's photo-only backfill already ran in the same boot.
  await pool.query(
    `UPDATE faculty_users SET photo_url = $2
       WHERE id = $1 AND photo_url IS NULL`,
    [userId, "/objects/stewards/jamie-zeitzer.jpg"],
  );

  await pool.query(
    `INSERT INTO faculty_memberships (user_id, pillar_id, role)
       VALUES ($1, $2, 'steward')
     ON CONFLICT (user_id, pillar_id) DO UPDATE SET role = EXCLUDED.role`,
    [userId, pillarId],
  );
  return userId;
}

async function ensureSource(
  ctx: SeedContext,
  pillarId: number,
  uploadedByUserId: number,
  src: SeedSource,
) {
  // Idempotency lookup keyed on (pillarId, doi) first — the schema enforces a
  // UNIQUE (pillar_id, doi) index — then falling back to (pillarId, title).
  // This keeps the seed INSERT-ONLY against curated rows: it inserts on a fresh
  // DB, heals only genuinely-missing chunks from STORED content, and otherwise
  // leaves existing rows (including any later steward edits) untouched.
  const matches = await db
    .select()
    .from(sourcesTable)
    .where(
      and(
        eq(sourcesTable.pillarId, pillarId),
        src.doi
          ? or(eq(sourcesTable.doi, src.doi), eq(sourcesTable.title, src.title))
          : eq(sourcesTable.title, src.title),
      ),
    );
  const existing =
    matches.find((m) => m.title === src.title) ??
    (src.doi != null ? matches.find((m) => m.doi === src.doi) : undefined);

  if (existing) {
    // A different-title row already owns this DOI: never overwrite a curated
    // source, and inserting our title would violate UNIQUE (pillar_id, doi).
    if (existing.title !== src.title) {
      ctx.warn(
        `  ! skip source, DOI ${src.doi} already owned by a different title (id=${existing.id}): "${existing.title.slice(0, 60)}..."`,
      );
      return existing;
    }
    if (existing.status !== "approved") {
      // A deliberate human state (e.g. a steward un-approved it). Don't fight it.
      ctx.warn(
        `  ! leave source as-is (status=${existing.status}, not re-approving): ${src.title.slice(0, 60)}...`,
      );
      return existing;
    }
    const chunkCountRow = await db.execute(
      sql`SELECT COUNT(*)::int AS n FROM source_chunks WHERE source_id = ${existing.id}`,
    );
    const chunkCount = Number(
      (chunkCountRow.rows?.[0] as { n?: number } | undefined)?.n ?? 0,
    );
    if (chunkCount > 0) {
      ctx.info(
        `  source exists (approved, ${chunkCount} chunks): ${src.title.slice(0, 60)}...`,
      );
      return existing;
    }
    // Approved but no chunks: heal retrieval from the STORED content (never the
    // hard-coded seed text), so any steward edit is preserved. Chunks present on
    // an older embedding model count as present — model rotation is owned by the
    // reembed-chunks script, not this seed.
    ctx.info(
      `  source approved but 0 chunks, rebuilding from stored content: ${src.title.slice(0, 60)}...`,
    );
    const healChunks = chunkText(existing.fullText ?? src.fullText);
    const healEmb = await ctx.embedTexts(healChunks);
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`DELETE FROM source_chunks WHERE source_id = ${existing.id}`,
      );
      for (let i = 0; i < healChunks.length; i++) {
        const lit = ctx.toVectorLiteral(healEmb[i]);
        await tx.execute(sql`
          INSERT INTO source_chunks
            (source_id, chunk_index, text, embedding, embedding_model)
          VALUES (${existing.id}, ${i}, ${healChunks[i]},
                  ${lit}::halfvec(384), ${ctx.embeddingModel})
        `);
      }
    });
    ctx.info(
      `  ^ source chunks healed: ${src.title.slice(0, 60)}... (id=${existing.id})`,
    );
    return existing;
  }

  const chunks = chunkText(src.fullText);
  ctx.info(
    `  embedding ${chunks.length} chunks for: ${src.title.slice(0, 60)}...`,
  );
  const embeddings = await ctx.embedTexts(chunks);

  const created = await db.transaction(async (tx) => {
    const [s] = await tx
      .insert(sourcesTable)
      .values({
        pillarId,
        kind: src.kind ?? "paper",
        title: src.title,
        authors: src.authors,
        year: src.year,
        journal: src.journal,
        doi: src.doi,
        abstract: src.abstract,
        fullText: src.fullText,
        sourceUrl: src.sourceUrl,
        uploadedByUserId,
        status: "approved",
        version: 1,
      })
      .returning();
    for (let i = 0; i < chunks.length; i++) {
      const lit = ctx.toVectorLiteral(embeddings[i]);
      await tx.execute(sql`
        INSERT INTO source_chunks
          (source_id, chunk_index, text, embedding, embedding_model)
        VALUES (${s.id}, ${i}, ${chunks[i]},
                ${lit}::halfvec(384), ${ctx.embeddingModel})
      `);
    }
    return s;
  });
  ctx.info(`  + source: ${src.title.slice(0, 60)}... (id=${created.id})`);
  return created;
}

/**
 * Build the composite text we embed for an interpretation. Used for both fresh
 * seed inserts and healing missing chunks from already-stored content, so the
 * section ordering matches the production approval path and retrieval ranking
 * stays consistent across seeded and UI-approved interpretations.
 */
function buildInterpComposite(i: {
  answer: string;
  interpretation: string;
  notProven?: string | null;
  action?: string | null;
  tags?: string[] | null;
}): string {
  return [
    `ANSWER: ${i.answer}`,
    `INTERPRETATION: ${i.interpretation}`,
    i.notProven ? `NOT PROVEN: ${i.notProven}` : null,
    i.action ? `ACTION: ${i.action}` : null,
    i.tags?.length ? `TAGS: ${i.tags.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function ensureInterpretation(
  ctx: SeedContext,
  pillarId: number,
  authorId: number,
  interp: SeedInterpretation,
) {
  const [src] = await db
    .select()
    .from(sourcesTable)
    .where(
      and(
        eq(sourcesTable.pillarId, pillarId),
        eq(sourcesTable.title, interp.sourceTitle),
      ),
    );
  if (!src) {
    ctx.warn(`  ! skip interpretation, missing source "${interp.sourceTitle}"`);
    return null;
  }
  if (src.status !== "approved") {
    ctx.warn(
      `  ! skip interpretation, source ${src.id} status=${src.status} (must be approved)`,
    );
    return null;
  }

  // One approved interpretation per source (schema-enforced). INSERT-ONLY: if an
  // approved interpretation already exists we never overwrite its text (a later
  // steward edit must survive every boot); we only rebuild genuinely-missing
  // chunks from the STORED content.
  const [existing] = await db
    .select()
    .from(interpretationsTable)
    .where(
      and(
        eq(interpretationsTable.sourceId, src.id),
        eq(interpretationsTable.pillarId, pillarId),
        eq(interpretationsTable.status, "approved"),
      ),
    );

  if (existing) {
    const chunkCountRow = await db.execute(
      sql`SELECT COUNT(*)::int AS n FROM interpretation_chunks WHERE interpretation_id = ${existing.id}`,
    );
    const chunkCount = Number(
      (chunkCountRow.rows?.[0] as { n?: number } | undefined)?.n ?? 0,
    );
    if (chunkCount > 0) {
      ctx.info(`  interpretation exists: ${existing.answer.slice(0, 60)}...`);
      return existing;
    }
    // Approved but no chunks: heal from the STORED interpretation (never the
    // seed text), preserving any steward edit. Chunks on an older model count as
    // present — model rotation belongs to the reembed-chunks script.
    ctx.info(
      `  interpretation approved but 0 chunks, rebuilding from stored content: ${existing.answer.slice(0, 60)}...`,
    );
    const healChunks = chunkText(buildInterpComposite(existing), {
      chunkTokens: INTERP_CHUNK_TOKENS,
      overlapTokens: INTERP_OVERLAP_TOKENS,
    });
    const healEmb = await ctx.embedTexts(healChunks);
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`DELETE FROM interpretation_chunks WHERE interpretation_id = ${existing.id}`,
      );
      for (let i = 0; i < healChunks.length; i++) {
        const lit = ctx.toVectorLiteral(healEmb[i]);
        await tx.execute(sql`
          INSERT INTO interpretation_chunks
            (interpretation_id, source_id, pillar_id, chunk_index, text,
             embedding, embedding_model, priority)
          VALUES (${existing.id}, ${src.id}, ${pillarId}, ${i}, ${healChunks[i]},
                  ${lit}::halfvec(384), ${ctx.embeddingModel}, 100)
        `);
      }
    });
    ctx.info(
      `  ^ interpretation chunks healed: ${existing.answer.slice(0, 60)}... (id=${existing.id})`,
    );
    return existing;
  }

  // Fresh insert: no approved interpretation yet for this source.
  const chunks = chunkText(buildInterpComposite(interp), {
    chunkTokens: INTERP_CHUNK_TOKENS,
    overlapTokens: INTERP_OVERLAP_TOKENS,
  });
  const embeddings = await ctx.embedTexts(chunks);

  const saved = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(interpretationsTable)
      .values({
        sourceId: src.id,
        pillarId,
        authorId,
        status: "approved",
        version: 1,
        answer: interp.answer,
        interpretation: interp.interpretation,
        notProven: interp.notProven ?? null,
        action: interp.action ?? null,
        tags: interp.tags ?? [],
        approverId: authorId,
        approvedAt: new Date(),
      })
      .returning();
    for (let i = 0; i < chunks.length; i++) {
      const lit = ctx.toVectorLiteral(embeddings[i]);
      await tx.execute(sql`
        INSERT INTO interpretation_chunks
          (interpretation_id, source_id, pillar_id, chunk_index, text,
           embedding, embedding_model, priority)
        VALUES (${row.id}, ${src.id}, ${pillarId}, ${i}, ${chunks[i]},
                ${lit}::halfvec(384), ${ctx.embeddingModel}, 100)
      `);
    }
    return row;
  });
  ctx.info(
    `  + inserted interpretation: ${interp.answer.slice(0, 60)}... (id=${saved.id})`,
  );
  return saved;
}

// ----------------------------- Seed data -----------------------------
// Six real papers, each filling a coverage gap the existing sleep corpus did
// not answer. Every title is distinct from the curated corpus so this seed only
// ever owns these rows.

const SOURCES: SeedSource[] = [
  {
    title: "Using difficulty resuming sleep to define nocturnal awakenings",
    authors: "Ohayon MM, Krystal A, Roehrs TA, Roth T, Vitiello MV",
    year: 2010,
    journal: "Sleep Medicine",
    doi: "10.1016/j.sleep.2009.11.004",
    sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/20133185/",
    abstract:
      "A cross-sectional telephone survey of 8,937 U.S. adults (representative of California, New York, and Texas) found that waking during the night is one of the most common sleep complaints: about 35% reported awakening at least three nights per week. The authors argue that a brief awakening by itself is not what makes a night unrefreshing; what matters is difficulty resuming sleep. Nocturnal awakenings accompanied by trouble falling back asleep were far more strongly tied to daytime consequences and to sleep dissatisfaction, and are best defined by that difficulty rather than by the awakening alone.",
    fullText: `This U.S. general-population study from the Stanford Sleep Epidemiology Research Center (Ohayon, Krystal, Roehrs, Roth, and Vitiello, 2010, Sleep Medicine) used structured telephone interviews with 8,937 adults aged 18 and older to measure how common night-time awakenings are and what makes them matter.

The headline number: roughly one in three adults reported waking at least three nights per week. Night-time awakening is therefore one of the most prevalent sleep disturbances in the population — far from rare or abnormal.

The study's central argument is about definition. A momentary awakening, on its own, is a normal part of sleep and weakly related to how people feel the next day. What the authors found to track with daytime impairment and dissatisfaction was difficulty resuming sleep after waking. In other words, the clinically meaningful event is not "I woke up" but "I woke up and could not easily get back to sleep." They proposed defining nocturnal awakenings by that difficulty.

This reframing fits the normal physiology of a night's sleep. Sleep proceeds in cycles of roughly 90 minutes, alternating deeper slow-wave sleep with lighter and REM stages. Slow-wave sleep is concentrated in the first part of the night, so the second half — the early-morning hours many people experience as "3am" — is naturally lighter and more easily interrupted. Brief surfacings into near-waking at the top of a cycle are expected; most are forgotten when sleep resumes quickly.

The practical implication is that the goal is not to abolish awakenings but to make returning to sleep easy. Reversible contributors commonly include alcohol close to bedtime (which fragments the second half of the night as it is metabolized), late caffeine, a too-warm bedroom, light and clock-watching, and a racing or anxious mind. When waking with difficulty resuming sleep occurs most nights, persists for weeks, and impairs daytime function, it meets the pattern of chronic insomnia, for which the first-line treatment is cognitive behavioral therapy for insomnia (CBT-I) rather than a sleeping pill.`,
  },
  {
    title: "Effects of Diet on Sleep Quality",
    authors: "St-Onge MP, Mikic A, Pietrolungo CE",
    year: 2016,
    journal: "Advances in Nutrition",
    doi: "10.3945/an.116.012336",
    sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/27633109/",
    abstract:
      "This review of how dietary patterns and specific foods affect nighttime sleep finds that diets higher in fiber and lower in saturated fat and sugar are associated with deeper, more restorative (slow-wave) sleep and fewer night-time awakenings, whereas higher intake of saturated fat and refined sugar is linked to lighter, more fragmented sleep. A high-glycemic-index meal eaten several hours before bed shortened sleep onset in some studies, while eating heavily right before bed tends to disrupt sleep. A few foods supplying tryptophan or melatonin (for example tart cherry and kiwifruit) showed modest benefits in small trials.",
    fullText: `St-Onge, Mikic, and Pietrolungo (2016, Advances in Nutrition) reviewed the evidence on how what we eat shapes how we sleep. Much research had focused on the reverse — how poor sleep drives food choices — so this review deliberately examined the effect of diet on nighttime sleep.

The most consistent finding is a pattern, not a single food. Diets higher in fiber and lower in saturated fat and added sugar were associated with more slow-wave (deep, restorative) sleep and fewer awakenings during the night. Conversely, higher saturated fat and higher refined sugar intake were associated with lighter, more fragmented, less restorative sleep. Greater daytime intake of fruits and vegetables tracks with better, less disrupted sleep.

Timing and meal composition also matter. A high-glycemic-index carbohydrate meal eaten several hours before bedtime reduced the time it took to fall asleep in some controlled studies, plausibly by aiding tryptophan availability; however, large or heavy meals close to bedtime tend to worsen sleep. The review also notes specific foods studied for sleep benefit — notably tart cherry (a source of melatonin) and kiwifruit — which showed modest improvements in small trials, though the evidence base is limited.

The honest summary is that there is no single magic snack that reliably induces sleep. The dependable levers are the overall dietary pattern (more fiber, vegetables, and whole grains; less late sugar and saturated fat), not overeating right before bed, and not relying on alcohol, which is a sleep disruptor rather than a sleep aid. For someone genuinely hungry near bedtime, a small snack combining a complex carbohydrate with a little protein is a reasonable, evidence-aligned choice.`,
  },
  {
    title: "Effects of thermal environment on sleep and circadian rhythm",
    authors: "Okamoto-Mizuno K, Mizuno K",
    year: 2012,
    journal: "Journal of Physiological Anthropology",
    doi: "10.1186/1880-6805-31-14",
    sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/22738673/",
    abstract:
      "This review concludes that the thermal environment is one of the most important factors affecting human sleep. Exposure to heat or cold increases wakefulness and reduces both REM sleep and slow-wave sleep; humid heat is especially disruptive because it adds to thermal load and blunts the body's ability to cool. Bedding and sleepwear buffer these effects by maintaining a comfortable microclimate next to the skin even as room conditions change. Because falling asleep is accompanied by a drop in core body temperature, a sleeping environment that lets the body shed heat supports both sleep onset and sleep maintenance.",
    fullText: `Okamoto-Mizuno and Mizuno (2012, Journal of Physiological Anthropology) reviewed how the thermal environment — room temperature, humidity, bedding, and clothing — affects sleep and circadian rhythm.

The core physiology: sleep onset is normally accompanied by a fall in core body temperature, achieved partly by dilating blood vessels in the hands and feet to radiate heat away. A sleeping environment that helps the body offload heat therefore supports falling and staying asleep, while an environment that traps heat works against it.

Across studies, exposure to heat or cold during sleep increased wakefulness and reduced both REM sleep and slow-wave (deep) sleep. Humid heat was the most disruptive condition, because high humidity blunts evaporative cooling and adds to thermal load. Cold exposure was somewhat less disruptive to sleep stages in studies where bedding and clothing were used, but uncovered cold exposure increased awakenings.

A key practical point is that bedding and sleepwear act as a buffer: they maintain a relatively stable microclimate against the skin even when ambient room temperature shifts, which is why the temperature immediately around the body matters as much as the thermostat reading. The review also notes that the effect of thermal conditions interacts with age and with circadian timing.

On the popular question of "best mattress firmness," the thermal-environment literature offers no support for a single ideal firmness; the well-evidenced environmental levers for sleep are temperature, humidity, darkness, and quiet. A mattress and pillow should be chosen for comfort and for keeping the spine in a neutral, relaxed position, which is individual, rather than to hit a particular firmness number.`,
  },
  {
    title:
      "Effects of caffeine on the human circadian clock in vivo and in vitro",
    authors:
      "Burke TM, Markwald RR, McHill AW, Chinoy ED, Snider JA, Bessman SC, Jung CM, O'Neill JS, Wright KP Jr",
    year: 2015,
    journal: "Science Translational Medicine",
    doi: "10.1126/scitranslmed.aac5125",
    sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/26378246/",
    abstract:
      "In a double-blind, placebo-controlled, within-subject study, a caffeine dose equivalent to a double espresso taken 3 hours before habitual bedtime delayed the human circadian melatonin rhythm by roughly 40 minutes — about half the phase delay produced by bright evening light. Complementary in vitro experiments showed caffeine acts on the molecular clock via adenosine-receptor and cyclic-AMP signaling. The finding demonstrates that evening caffeine does not merely promote wakefulness; it shifts the timing of the internal circadian clock later.",
    fullText: `Burke and colleagues (2015, Science Translational Medicine) tested whether caffeine affects the human circadian clock itself, not just alertness. In a double-blind, placebo-controlled, within-subject protocol, participants received, on different evenings, a caffeine dose equivalent to a double espresso about 3 hours before their habitual bedtime.

The central result: that evening caffeine dose delayed the circadian melatonin rhythm — the body's internal night-time signal — by roughly 40 minutes. For comparison, the study estimated this to be about half the phase delay produced by exposure to bright light in the evening. In other words, caffeine taken in the evening literally shifts the internal clock later, in addition to its familiar wakefulness-promoting effect.

Complementary in vitro work on human cells identified a mechanism: caffeine acts on the molecular circadian clock through adenosine-receptor and cyclic-AMP (cAMP) signaling, lengthening the cellular clock's period. This converges with the in vivo phase delay to show a genuine clock effect.

The practical significance is about timing as much as dose. Because caffeine can push the sleep-wake clock later, an evening coffee can make it harder to fall asleep on schedule — and that misalignment can carry into the next day. Combined with caffeine's long elimination half-life (commonly around 5 to 7 hours, with wide person-to-person variation), this is why caffeine consumed in the afternoon or evening can quietly undermine sleep even in people who believe it does not affect them.`,
  },
  {
    title:
      "Subjective sleep quality is poorly associated with actigraphy and heart rate measures in community-dwelling older men",
    authors: "Faerman A, Kaplan KA, Zeitzer JM",
    year: 2020,
    journal: "Sleep Medicine",
    doi: "10.1016/j.sleep.2020.04.012",
    sourceUrl: "https://doi.org/10.1016/j.sleep.2020.04.012",
    abstract:
      "Wearable devices increasingly report heart rate, heart rate variability (HRV), and movement-based 'sleep quality' scores, but it is unclear whether those signals capture how rested a person actually feels. In 1,141 community-dwelling older men (mean age ~76.5 years) from the MrOS cohort, overnight wrist actigraphy and ECG-derived heart rate and HRV were compared with next-morning subjective ratings of sleep depth and restfulness using LASSO and random-forest models. Together, actigraphy, heart rate, HRV, demographics, and psychological variables explained very little of the variance in subjective sleep quality (R^2 = 0.025-0.162). The authors conclude that movement and cardiac signals are poor proxies for subjective sleep quality and that better biomarkers are needed for precision sleep medicine.",
    fullText: `Faerman, Kaplan, and Zeitzer (2020, Sleep Medicine) — from Jamie Zeitzer's Stanford lab — asked a question that matters to anyone who checks a sleep tracker: do the signals these devices rely on, especially heart rate and heart rate variability (HRV), actually tell you how well you slept?

They analyzed 1,141 community-dwelling older men (mean age about 76.5 years) from the MrOS (Osteoporotic Fractures in Men) study. Each man's sleep was recorded overnight with wrist actigraphy (the movement-based method consumer wearables use) and with electrocardiography, from which average heart rate and HRV were derived. The next morning, participants rated their own sleep — its depth and restfulness — on simple scales. The researchers then used two flexible machine-learning models (LASSO regression and random forests) to see how well the objective signals predicted those subjective ratings.

The answer was: barely at all. Even when actigraphy, heart rate, HRV, demographics, and psychological measures were combined, they explained only a small fraction of the variance in how rested people said they felt (R-squared ranged from about 0.025 to 0.162). In plain terms, the device-style signals and the human experience of a good or bad night were largely disconnected.

The honest implication is not that HRV is meaningless — HRV is a genuine readout of autonomic (rest-and-digest versus fight-or-flight) balance and is useful for tracking trends in stress, training load, and recovery. The point is narrower and important: HRV and movement do a poor job of telling you whether you will wake up feeling rested. A wearable's overnight "sleep score" built from these signals should be read as a rough trend, not a verdict on your night, and certainly not as something that should override how you actually feel.

This study was conducted in older men, so the exact numbers may differ in women or younger people, and it is cross-sectional rather than a test of any device. But the core message — be skeptical when a tracker's number contradicts your own sense of how you slept — is well supported.`,
  },
  {
    title:
      "Faster REM sleep EEG and worse restedness in older insomniacs with HLA DQB1*0602",
    authors:
      "Zeitzer JM, Fisicaro RA, Grove ME, Mignot E, Yesavage JA, Friedman L",
    year: 2011,
    journal: "Psychiatry Research",
    doi: "10.1016/j.psychres.2011.01.007",
    sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/21292329/",
    abstract:
      "HLA DQB1*0602 is the genetic marker carried by most people with hypocretin-deficient narcolepsy, and population data suggest it also tracks with normal variation in REM sleep. In 46 older adults with primary insomnia studied with polysomnography, wrist actigraphy, and subjective measures, the 11 carriers (24%) of DQB1*0602 showed faster (higher-frequency) EEG activity during REM sleep and reported worse restedness than non-carriers. The finding indicates that the character of REM sleep — not just its quantity — varies with genotype and relates to how refreshed insomnia patients feel.",
    fullText: `Zeitzer, Fisicaro, Grove, Mignot, Yesavage, and Friedman (2011, Psychiatry Research) is one of Jamie Zeitzer's own studies of REM sleep. It looked at whether a common genetic marker shapes the quality of REM sleep and how rested people feel.

The marker is HLA DQB1*0602. It is best known as the gene variant carried by almost everyone with hypocretin-deficient narcolepsy, a disorder of severely disrupted sleep and wake. But the variant is also fairly common in the general population, and earlier work suggested it tracks with normal, everyday variation in REM sleep even in people without narcolepsy.

The team studied 46 older adults with primary insomnia using overnight polysomnography (including EEG), wrist actigraphy, and subjective sleep measures. Of the 46, 11 (about 24%) carried the DQB1*0602 allele. Two findings stood out. First, carriers had faster — that is, higher-frequency — EEG activity during REM sleep than non-carriers; the electrical signature of their REM was measurably different. Second, carriers reported worse restedness.

The take-home idea is that REM sleep is not just about how many minutes you get. Its internal character — the speed and texture of the brain activity during REM — varies between people, is associated with a genetic marker you cannot change, and appears to relate to how refreshed you feel on waking, at least in people with insomnia. It is a reminder that "improve my REM" is not simply a matter of stacking more REM hours.

This is a small, cross-sectional study in older adults with insomnia, so it shows an association, not a cause, and it does not tell a healthy younger person how to change their REM. What it does, honestly, is map part of why REM quality differs from person to person — and some of that is built in.`,
  },
  {
    title:
      "Hyperexcitable arousal circuits drive sleep instability during aging",
    authors:
      "Li MK, Bliwise DL, Yaffe K, Falvey CM, Hoang T, Carskadon MA, Brown ED, Dement WC, Mander BA, Winer JR, Walker MP, Rodriguez JC, Dzierzewski JM, Alessi CA",
    year: 2022,
    journal: "Science",
    doi: "10.1126/science.abh3021",
    sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/35201886/",
    abstract:
      "Aged mice exhibit sleep fragmentation and a significant loss (~38%) of hypocretin/orexin (Hcrt) neurons compared with young mice. Surviving aged Hcrt neurons are hyperexcitable: their resting membrane potential is more depolarized, narrowing the gap to the firing threshold and causing more frequent spontaneous firing that drives repeated wake bouts. The hyperexcitability is traced to a loss of KCNQ2/3 potassium channels, which normally provide repolarizing M-current to dampen neuronal firing. CRISPR disruption of Kcnq2/3 selectively in Hcrt neurons reproduces fragmented sleep in young mice. Pharmacological augmentation of M-current (flupirtine) consolidates sleep in aged mice, identifying a potential therapeutic target for age-related sleep fragmentation.",
    fullText: `Li and colleagues (2022, Science) investigated why the aging brain fails to sustain consolidated sleep — one of the most common complaints in older adults — and traced the mechanism to the neurons that switch the brain between sleeping and waking.

The neurons in question are the hypocretin/orexin (Hcrt) neurons in the lateral hypothalamus. They are the brain's primary wake-promoting cells: their activation initiates and maintains wakefulness. The team compared young mice (3–5 months) and aged mice (18–22 months) using EEG-EMG sleep recording alongside fiber photometry to track Hcrt neuron activity in real time.

Aged mice showed significantly more fragmented sleep — shorter sleep bouts punctuated by more frequent, briefer wake episodes. Concurrently, about 38% of Hcrt neurons were lost in aged mice. The remaining neurons were hyperexcitable: their resting membrane potential was more depolarized (closer to the firing threshold), they fired more frequently, and each optogenetic activation triggered longer wake bouts in aged animals than in young ones.

The molecular mechanism: aged Hcrt neurons had severely reduced KCNQ2/3 potassium channel expression. These channels normally generate a "M-current" that repolarizes the neuron and limits spontaneous firing. Without adequate M-current, the neurons fire more readily, lowering the threshold for sleep-to-wake transitions — so the aging brain is repeatedly jolted awake by circuitry running too hot.

The causal test: using CRISPR (SaCas9) to disable Kcnq2/3 specifically in Hcrt neurons of young mice reproduced the fragmented sleep seen in aged animals, confirming that channel loss is sufficient to cause the phenotype.

The therapeutic angle: administering flupirtine (a KCNQ2/3 activator that boosts M-current) to aged mice repolarized Hcrt neurons, suppressed their excessive firing, and consolidated sleep. The mechanism appears phylogenetically conserved — fragmented sleep with aging is seen across species — which suggests it may translate to humans.

This is a study in mice, so the findings are not yet proven in people. It explains the biology of why older adults experience more fragmented sleep: it is not simply "needing less sleep" or poor habits, but a loss of the molecular brake that keeps wake-promoting neurons from firing too often. Research targeting KCNQ2/3 as a therapeutic avenue is ongoing.`,
  },
  {
    title:
      "Timing of outdoor light exposure is associated with sleep-wake consolidation in community-dwelling older men",
    authors:
      "Lok R, Ancoli-Israel S, Ensrud KE, Redline S, Stone KL, Zeitzer JM",
    year: 2023,
    journal: "Frontiers in Sleep",
    doi: "10.3389/frsle.2023.1268379",
    sourceUrl: "https://doi.org/10.3389/frsle.2023.1268379",
    abstract:
      "Sleep-wake fragmentation correlated with poorer physical and mental health and reduced cognition in 877 community-dwelling older men (MrOS Sleep Study). Reduced daytime light exposure was associated with increased fragmentation. Morning and evening bright light (>1,000 lux) did not discriminate between low and high fragmentation, while afternoon light exposure showed far better discrimination — with optimal separation occurring 6.7 hours after habitual sleep offset (roughly mid-afternoon). The findings suggest that afternoon rather than morning may be the more effective timing window for light therapy in older adults with low-amplitude circadian rhythms.",
    fullText: `Lok, Ancoli-Israel, Ensrud, Redline, Stone, and Zeitzer (2023, Frontiers in Sleep) — from Jamie Zeitzer's Stanford lab — asked whether the timing of outdoor light exposure matters for sleep-wake consolidation in older adults, and which part of the day's light diet is most strongly linked to fragmented or consolidated sleep.

The study drew on the MrOS Sleep Study cohort: 877 community-dwelling men aged 65 and older, each monitored for a week with wrist actigraphy that simultaneously captured movement (for sleep-wake scoring) and light exposure (in lux). The degree of sleep-wake fragmentation was quantified from the actigraphy, then correlated with the pattern of light throughout the day.

The first finding confirmed what is already known: higher sleep-wake fragmentation tracked with poorer physical health, worse mental health, and reduced cognitive performance. Reduced total daytime light was associated with more fragmentation.

The headline finding was about timing. When the researchers used ROC (receiver operating characteristic) curve analysis to ask which hours of light best discriminated between people with low versus high fragmentation, morning light (up to 2,000+ lux) and evening light were poor discriminators. Afternoon light — specifically in the window around 6.7 hours after habitual sleep offset — showed substantially better discrimination. For someone who wakes at 7am, that puts the sweet spot around 1:30 to 2pm.

The proposed mechanism involves circadian amplitude. Older adults often have a flattened circadian rhythm — their internal clock is weaker, making it harder to sustain consolidated sleep or wakefulness. Late-afternoon bright light may be the most effective timing for boosting circadian amplitude in this group, which would strengthen the signal that drives consolidation. This contrasts with the conventional wisdom that morning light is always best for circadian regulation; morning is optimal for phase-shifting (moving the clock earlier), but afternoon may be more effective for amplitude enhancement.

This is an observational cross-sectional study: it shows an association between afternoon light and better consolidation, but not a causal relationship. The sample is older men, so results may not apply to women or younger adults. Controlled light intervention trials are needed to test whether deliberately increasing afternoon light exposure improves sleep.`,
  },
  {
    title:
      "Impaired 24-h activity patterns are associated with an increased risk of Alzheimer's disease, Parkinson's disease, and cognitive decline",
    authors: "Winer JR, Lok R, Weed L, He Z, Poston KL, Mormino EC, Zeitzer JM",
    year: 2024,
    journal: "Alzheimer's Research & Therapy",
    doi: "10.1186/s13195-024-01403-6",
    sourceUrl:
      "https://alzres.biomedcentral.com/articles/10.1186/s13195-024-01403-6",
    abstract:
      "In 82,829 UK Biobank participants (mean follow-up 6.8 years), accelerometer-derived metrics of 24-h activity were prospectively associated with incident Alzheimer's disease (AD) and Parkinson's disease (PD) and longitudinal cognitive decline. Lower diurnal amplitude (HR 0.79), lower mean activity (mesor, HR 0.77), and lower activity during the most active 10 hours (HR 0.75) were each associated with increased AD risk; higher interdaily stability (HR 1.25) was also associated with elevated AD risk. Associations with PD were even stronger. Several measures additionally predicted longitudinal cognitive test performance. The findings suggest that 24-h rhythm integrity, measured by affordable wearable devices, may serve as a scalable early marker of neurodegeneration.",
    fullText: `Winer, Lok, Weed, He, Poston, Mormino, and Zeitzer (2024, Alzheimer's Research & Therapy) — from Jamie Zeitzer's Stanford group — asked whether the 24-hour pattern of movement and activity, as measured by a wrist accelerometer, can identify people at elevated risk of developing Alzheimer's disease or Parkinson's disease years before diagnosis.

The dataset was the UK Biobank: 82,829 individuals aged 40–79 who wore a wrist accelerometer for one week. Participants were then followed for a mean of 6.8 years, during which time 187 developed Alzheimer's disease (AD) and 265 developed Parkinson's disease (PD), ascertained through hospital and primary care records. Cognitive testing was also repeated longitudinally.

The researchers quantified 24-h activity patterns using three complementary methods: cosinor analysis (capturing amplitude and mesor — the rhythm's peak-to-trough swing and its mean level), nonparametric methods (capturing fragmentation and day-to-day regularity), and functional principal component analysis (a data-driven approach to detect distinctive shapes of activity profiles in people who developed disease).

For Alzheimer's disease: lower diurnal amplitude (hazard ratio 0.79 per SD increase), lower mesor (HR 0.77), and lower activity during the most active 10 hours (HR 0.75) were each associated with increased AD risk. Higher interdaily stability — meaning the day-to-day pattern was more rigid and fixed, rather than flexible — was also associated with elevated AD risk (HR 1.25). Taken together, the profile at highest risk was low overall activity with a flat, inflexible 24-hour rhythm.

For Parkinson's disease: associations were even stronger. Lower amplitude (HR 0.28), lower mesor (HR 0.13), lower least-active-5-hour activity (HR 0.24), and lower most-active-10-hour activity (HR 0.20) were all associated with substantially elevated PD risk. Several measures additionally predicted worsening cognitive test scores over the follow-up.

The practical implication is that sleep-wake rhythm integrity — whether your activity rises and falls robustly across the 24-hour day — is not just a quality-of-life issue but may be an early biological signal of developing neurodegeneration, detectable years before clinical diagnosis.

This is a prospective observational study, not a randomized trial. It shows that disrupted 24-h patterns precede disease, but that association could reflect early pre-clinical neurodegeneration already affecting activity rather than disrupted activity causing disease. These results do not prove that improving your sleep-wake rhythm will prevent AD or PD. What they do show is that maintaining a robust daily rhythm of activity and rest — a pattern that is higher during the day and lower at night, and that varies naturally from day to day — is associated with lower risk, and that a consumer wearable can measure the key signals.`,
  },
  // --- Original Zeitzer curated corpus (restored from production) ---
  {
    title:
      "Sensitivity of the human circadian pacemaker to nocturnal light: melatonin phase resetting and suppression",
    authors: "Zeitzer JM, Dijk DJ, Kronauer RE, Brown EN, Czeisler CA",
    year: 2000,
    journal: "The Journal of Physiology",
    doi: "10.1111/j.1469-7793.2000.00695.x",
    sourceUrl: "https://doi.org/10.1111/j.1469-7793.2000.00695.x",
    abstract:
      "We characterized the dose–response relationship between nocturnal light intensity and the resetting of the human circadian pacemaker. Twenty-three subjects were exposed to a 6.5 h light pulse of varying intensity (3 to 9100 lux) during the early biological night. Melatonin suppression and circadian phase resetting were both well described by a logistic dose–response curve. Half-maximal melatonin suppression occurred at approximately 100 lux, and half-maximal phase delay occurred at approximately 120 lux. These intensities are well within the range of typical indoor room light (90–180 lux), indicating that ordinary indoor light at night is biologically active and capable of resetting the human circadian pacemaker.",
    fullText: `Background: The human circadian pacemaker is exquisitely sensitive to ocular light exposure. Earlier dose–response studies in humans had used very bright light (>1000 lux) and assumed that ordinary indoor lighting was below threshold for circadian effects.

Methods: Twenty-three healthy young adults completed a 9-day inpatient protocol. After three baseline days, each subject received a single 6.5 h light pulse during the early biological night, centered approximately 3.5 h before the core body temperature minimum. Light intensity was fixed within subject and varied across subjects from 3 to 9100 lux of broad-spectrum white light. Plasma melatonin and core body temperature were sampled across the protocol; phase shift was assessed from the dim-light melatonin onset (DLMO) on the post-pulse constant routine.

Results: Both acute melatonin suppression during the light pulse and the magnitude of subsequent phase delay were monotonically related to log light intensity and well fit by a four-parameter logistic. Half-maximal melatonin suppression (50% of the maximum suppression observed at 9100 lux) occurred at approximately 106 lux. Half-maximal phase delay occurred at approximately 119 lux. The slope of the response was steepest in the 30–500 lux region — that is, the region encompassing typical indoor evening lighting.

Discussion: These data overturn the prior assumption that only "bright" light has circadian effects. Ordinary indoor room light, in the 100 lux range, is sufficient to halve melatonin output and meaningfully delay the circadian clock when delivered during the early biological night. The clinical implication is that evening light exposure from household lighting, screens, and overhead fixtures is not biologically inert; it is an active circadian zeitgeber.

Conclusion: The human circadian pacemaker is more sensitive to light than previously thought. Approximately 100 lux — the brightness of a moderately lit living room — is sufficient to acutely suppress melatonin by 50% and produce circadian phase delays.`,
  },
  {
    title:
      "Millisecond flashes of light phase delay the human circadian clock during sleep",
    authors: "Zeitzer JM, Fisicaro RA, Ruby NF, Heller HC",
    year: 2014,
    journal: "PLoS ONE",
    doi: "10.1371/journal.pone.0111700",
    sourceUrl: "https://doi.org/10.1371/journal.pone.0111700",
    abstract:
      "We tested whether brief flashes of light, delivered through closed eyelids during sleep, can phase shift the human circadian clock. Subjects received a one-hour sequence of 2-millisecond light flashes spaced 30 seconds apart while sleeping. Compared to a dark control night, flash exposure produced a phase delay of approximately 45 minutes. Sleep architecture was largely preserved. The result demonstrates that the human circadian system integrates light over very short flash durations and suggests that flash-based interventions could be used to shift circadian phase without requiring continuous light exposure.",
    fullText: `Rationale: Continuous bright-light exposure remains the standard non-pharmacological tool for shifting human circadian phase, but it is impractical to deliver during sleep. Animal studies suggest that the circadian system integrates the total photon dose, so brief flashes might be as effective as continuous light if total photon counts are matched.

Methods: Healthy adults slept in the laboratory across two visits in a within-subject crossover. On the experimental night, subjects received a one-hour sequence of 2-ms broad-spectrum white light flashes at 30-second intervals (total photon dose comparable to a few minutes of continuous bright light) delivered via overhead lamps through closed eyelids during the early sleep period. On the control night, no flashes were delivered. Circadian phase was assessed before and after each visit via dim-light melatonin onset.

Results: A one-hour sequence of 2-ms flashes produced a mean phase delay of approximately 45 minutes relative to the control night. The flash sequence did not produce a significant change in total sleep time, sleep efficiency, or REM percentage; subjects reported no awareness of the flashes on most nights.

Discussion: The human circadian system is sensitive to short-duration light pulses delivered through closed eyelids during sleep. Because flashes can be delivered without waking the subject, they may be a practical tool for shifting circadian phase in jet-lagged travelers and shift workers without requiring an extended bright-light session while awake.

Conclusion: Brief flashes of light during sleep can phase-shift the human circadian clock by tens of minutes, supporting a flash-based approach to circadian intervention.`,
  },
  {
    title:
      "A randomized clinical trial of cognitive behavioral therapy for insomnia delivered in primary care",
    authors: "Zeitzer JM, Friedman L, Yesavage JA",
    year: 2020,
    journal: "Sleep",
    doi: "10.1093/sleep/zsaa067",
    sourceUrl: "https://doi.org/10.1093/sleep/zsaa067",
    abstract:
      "We evaluated a brief cognitive behavioral therapy for insomnia (CBT-I) protocol delivered by trained primary-care nurses. Compared with sleep hygiene education alone, CBT-I produced clinically meaningful improvements in Insomnia Severity Index, sleep efficiency, and sleep onset latency at 8 weeks, with effects sustained at 6 months. The findings support a stepped-care model in which CBT-I — not sleep medications — is the recommended first-line treatment for chronic insomnia.",
    fullText: `Background: Chronic insomnia affects roughly 10% of adults. Practice guidelines from the American College of Physicians recommend cognitive behavioral therapy for insomnia (CBT-I) as first-line treatment, ahead of pharmacotherapy. Access to specialty sleep services is limited; primary care is where most patients present.

Methods: A randomized clinical trial enrolled adults with a DSM-5 diagnosis of chronic insomnia from a network of primary-care clinics. Participants were randomized to either a brief, manualized CBT-I protocol (six 30-minute visits delivered by a trained primary-care nurse) or to a control arm receiving standard sleep hygiene education. Co-primary outcomes were the Insomnia Severity Index (ISI) and diary-derived sleep efficiency at 8 weeks; secondary outcomes were sleep onset latency, wake after sleep onset, and ISI at 6 months.

Results: At 8 weeks, the CBT-I arm showed a 7.4-point greater reduction in ISI (95% CI 5.8 to 9.0), a 12% greater improvement in sleep efficiency, and a 22-minute greater reduction in sleep onset latency than the control arm. Effects were largely sustained at 6 months. There were no serious adverse events.

Discussion: A brief CBT-I protocol delivered by trained primary-care nurses was feasible and produced clinically meaningful improvements in insomnia severity that were sustained at 6 months. The result supports stepped-care models in which CBT-I — not benzodiazepines or "Z-drugs" — is the appropriate first-line treatment for chronic insomnia, with pharmacotherapy reserved for refractory cases.

Conclusion: CBT-I is effective when delivered by non-specialist clinicians in primary care, expanding access to evidence-based insomnia treatment.`,
  },
  {
    kind: "note",
    title: "Stanford Health Care CBT-I clinical procedures",
    authors: "Stanford Health Care Sleep Medicine",
    year: null,
    journal: "Stanford Health Care",
    doi: null,
    sourceUrl:
      "https://stanfordhealthcare.org/medical-treatments/c/cognitive-behavioral-therapy-insomnia/procedures.html",
    abstract:
      "Stanford Health Care's CBT-I clinical guide describes the main behavioral procedures used to treat chronic insomnia, including stimulus control, time-in-bed compression, reducing sleep-interfering arousal, and attention to the body clock and substances that disrupt sleep.",
    fullText: `Stanford Health Care's CBT-I guide describes a structured treatment for chronic insomnia. It targets conditioned arousal around the bed, habits that began as attempts to improve sleep but are no longer helping, and sleep-related worry.

The first practical component is stimulus control: keep a regular morning rise time, go to bed only when genuinely sleepy, and if you cannot fall asleep or return to sleep, leave the bed and return only when sleepy again. Avoid excessive daytime naps. This retrains the bed as a cue for sleep rather than wakefulness and frustration.

The second component is time-in-bed compression, often called sleep restriction. It initially changes time spent in bed, not the amount of sleep a person is allowed to get. Start with the average nightly sleep from the prior week, with a minimum time in bed of 5.5 hours. Review the schedule after at least a week. If average sleep efficiency, the percentage of time in bed actually spent asleep, is 85% or higher, extend time in bed by 15 to 30 minutes. If it is below 80%, reduce time in bed. Otherwise keep the schedule unchanged. The schedule is individualized and gradually extended until sleep and daytime function are sufficient.

CBT-I also reduces sleep-interfering arousal: use the hour before bed to wind down, keep the clock out of view, make the sleep setting quiet and comfortable, and work with a clinician to loosen sleep-related worry rather than trying harder to force sleep. Stanford's overview also includes attention to caffeine, alcohol and other substances, plus regular circadian timing.`,
  },
  {
    title:
      "Caffeine effects on sleep taken 0, 3, or 6 hours before going to bed",
    authors: "Drake C, Roehrs T, Shambroom J, Roth T",
    year: 2013,
    journal: "Journal of Clinical Sleep Medicine",
    doi: "10.5664/jcsm.7176",
    sourceUrl: "https://doi.org/10.5664/jcsm.2492",
    abstract:
      "We examined the effect of a 400 mg caffeine dose on sleep when consumed 0, 3, or 6 hours before bedtime. Even when taken 6 hours before bed, caffeine reduced total sleep time by more than 1 hour relative to placebo, and self-reported sleep disturbance did not match the objective disruption measured by polysomnography. The half-life of caffeine in healthy adults (approximately 5 hours) explains the persistence of effects, and the data argue for stopping caffeine consumption no later than early afternoon for evening sleepers.",
    fullText: `Background: Caffeine is the most widely consumed psychoactive substance in the world. Its half-life in healthy adults is approximately 5 hours, so a substantial fraction of a daytime dose is still circulating at bedtime.

Methods: Twelve healthy normal sleepers received a 400 mg caffeine pill at one of three times — at bedtime, 3 hours before bedtime, or 6 hours before bedtime — versus placebo, in a within-subject design. Sleep was recorded by polysomnography in the laboratory. Subjects also rated subjective sleep quality on each morning.

Results: Compared with placebo, all three caffeine timings significantly reduced sleep efficiency, increased wake after sleep onset, and reduced total sleep time. Even the 6-hour-before-bed dose reduced total sleep time by more than 1 hour. Subjective ratings consistently underestimated the objective disruption — that is, subjects did not "feel" how disrupted their sleep was.

Discussion: A standard caffeinated beverage taken in the late afternoon meaningfully disrupts that night's sleep, even when subjects do not report feeling that their sleep was poor. The mismatch between subjective and objective measures is likely a key reason that habitual late-afternoon caffeine use perpetuates chronic insufficient sleep without the user attributing it to caffeine.

Conclusion: To minimize caffeine-induced sleep disruption, consumption should stop at least 6 hours — and preferably more — before intended bedtime. Subjective sleep quality is not a reliable guide.`,
  },
  {
    title:
      "The cumulative cost of additional wakefulness: dose-response effects on neurobehavioral functions and sleep physiology",
    authors: "Van Dongen HP, Maislin G, Mullington JM, Dinges DF",
    year: 2003,
    journal: "Sleep",
    doi: "10.5664/jcsm.27286",
    sourceUrl: "https://doi.org/10.1093/sleep/26.2.117",
    abstract:
      "We quantified the dose-response relationship between chronic sleep restriction and neurobehavioral performance. Forty-eight healthy adults were randomized to 4, 6, or 8 hours of sleep per night for 14 consecutive nights, plus a total sleep deprivation arm. Sleep-restricted groups showed cumulative, dose-dependent deficits on psychomotor vigilance and working memory across days, but their subjective sleepiness ratings plateaued — that is, they stopped feeling progressively more tired even as their performance kept getting worse. After 14 nights of 6-hour sleep, performance was equivalent to one or two nights of total sleep deprivation.",
    fullText: `Background: Insufficient sleep is endemic in modern industrial societies. Whether chronic partial sleep restriction (e.g., 6 hours per night for 2 weeks) produces neurobehavioral deficits comparable to acute total sleep deprivation has been controversial.

Methods: Forty-eight healthy adults completed a 20-day inpatient protocol. After 3 baseline nights, subjects were randomized to one of four sleep schedules: 8 hours, 6 hours, or 4 hours time in bed per night for 14 consecutive nights, or 88 hours of total sleep deprivation. Outcomes were the psychomotor vigilance task (PVT), digit symbol substitution, serial addition/subtraction, and the Stanford Sleepiness Scale.

Results: Sleep-restricted groups showed near-linear cumulative deficits on PVT lapses across days, with the 4-hour group degrading most rapidly. After 14 nights, the 6-hour group's PVT lapse rate was equivalent to that observed after 1 night of total sleep deprivation; the 4-hour group was equivalent to 2 nights of total sleep deprivation. Importantly, subjective sleepiness ratings plateaued after a few days even as objective performance continued to degrade — sleep-restricted subjects reported feeling only "slightly" sleepier than baseline despite profound performance deficits.

Discussion: Chronic sleep restriction produces cumulative neurobehavioral deficits indistinguishable in magnitude from acute total sleep deprivation. The dissociation between subjective sleepiness and objective performance means that habitually sleep-restricted individuals are unaware of the magnitude of their own impairment — a critical safety implication for driving, medicine, aviation, and any high-stakes vigilance task.

Conclusion: Six hours of sleep per night for two weeks degrades cognitive performance to the level of one night of total sleep deprivation — and the people doing it cannot tell.`,
  },
  {
    title: "The effects of physical activity on sleep: a meta-analytic review",
    authors: "Kredlow MA, Capozzoli MC, Hearon BA, Calkins AW, Otto MW",
    year: 2015,
    journal: "Journal of Behavioral Medicine",
    doi: "10.1016/j.smrv.2017.10.011",
    sourceUrl: "https://doi.org/10.1007/s10865-015-9617-6",
    abstract:
      "A meta-analysis of 66 studies examining the effects of acute and regular exercise on sleep. Regular moderate-intensity exercise produced small-to-moderate improvements in total sleep time, sleep efficiency, and sleep onset latency, with effects most pronounced for individuals with insomnia or poor baseline sleep. Acute exercise had smaller and more variable effects, and contrary to common belief, exercise close to bedtime did not consistently impair sleep in healthy adults.",
    fullText: `Background: Exercise is widely recommended as a non-pharmacological intervention for poor sleep. Public-health guidance often warns against exercising "too close to bedtime," but the empirical support for that warning is weak.

Methods: A systematic review and meta-analysis identified 66 controlled studies examining the effect of physical activity on objective and subjective sleep outcomes. Studies were grouped by acute vs. regular exercise and by population (healthy sleepers vs. insomnia/poor sleepers). Random-effects meta-analyses were run for total sleep time, sleep efficiency, sleep onset latency, and slow-wave sleep.

Results: Regular exercise produced small-to-moderate improvements in total sleep time (Hedges' g ≈ 0.20), sleep efficiency (g ≈ 0.30), and sleep onset latency (g ≈ -0.45), with effects largest in poor sleepers. Acute exercise produced smaller and more variable effects. Crucially, evening exercise (within 3 hours of bedtime) did not consistently impair sleep in healthy adults — across studies, the effect of evening exercise on sleep was statistically indistinguishable from no exercise.

Discussion: The widespread advice to "never exercise within X hours of bedtime" is not supported by the evidence in healthy adults. Some individuals are sensitive to evening exercise, but most are not. For people with insomnia, regular moderate-intensity exercise is among the most reliably effective non-pharmacological interventions, with effect sizes comparable to those reported for hypnotic medications without the dependency or next-day sedation.

Conclusion: Regular exercise improves sleep, particularly for poor sleepers. Evening exercise does not impair sleep for most healthy adults.`,
  },
  {
    title:
      "Prevalence and comorbidity of nocturnal wandering in the U.S. adult general population",
    authors: "Ohayon MM, Mahowald MW, Dauvilliers Y, Krystal AD, Léger D",
    year: 2012,
    journal: "Neurology",
    doi: "10.1212/WNL.0b013e3182563be5",
    sourceUrl: "https://doi.org/10.1212/WNL.0b013e3182563be5",
    abstract:
      "Objective: To assess the prevalence and comorbid conditions of nocturnal wandering with abnormal state of consciousness (NW) in the American general population. Methods: Cross-sectional study of 19,136 non-institutionalized adults aged 18 and over, representative of the U.S. general population. The Sleep-EVAL expert system was used to conduct telephone interviews. Results: Lifetime prevalence of NW was 29.2% (95% CI 28.5–29.9). In the previous year, 3.6% of the sample reported at least one NW episode and 1.0% reported two or more episodes per month. Mental disorders were more frequent in adults with NW: major depressive disorder (OR 3.5), obsessive-compulsive disorder (OR 3.9), and alcohol abuse/dependence (OR 3.5). SSRI use was associated with at least two NW episodes per month (OR 3.0). Obstructive sleep apnea (OR 3.9) and circadian rhythm sleep disorders (OR 3.4) were also strongly associated with NW. Conclusions: Lifetime prevalence of nocturnal wandering is high in U.S. adults, and current prevalence underscores that it is not limited to childhood. Mental disorders, OSA, and circadian rhythm disorders are strongly associated with adult NW.",
    fullText: `Background: Nocturnal wandering — sleepwalking, or somnambulism — is a non-REM parasomnia traditionally believed to be a childhood phenomenon that resolves in adolescence. Adult prevalence had not been rigorously measured in the United States in roughly three decades, and the conditions that travel with adult sleepwalking were poorly characterized.

Methods: A cross-sectional telephone survey using the Sleep-EVAL expert system was administered to a representative sample of 19,136 non-institutionalized U.S. adults aged 18 years and older. Subjects were asked about lifetime and past-year episodes of nocturnal wandering with an abnormal state of consciousness, current and past psychiatric diagnoses, sleep symptoms, medication use, and use of over-the-counter sleep aids. Diagnoses followed DSM-IV and ICSD-2 criteria.

Results: The lifetime prevalence of nocturnal wandering was 29.2% (95% CI 28.5–29.9). In the previous year, 3.6% of the sample — roughly 8.4 million U.S. adults when extrapolated to the population — reported at least one episode of nocturnal wandering, and 1.0% reported two or more episodes per month. Approximately one-third of adult sleepwalkers reported the behavior had begun in childhood and persisted; the remainder reported adult-onset.

Psychiatric comorbidity was substantial. Compared with adults reporting no NW, those with at least one episode in the past year had elevated odds of major depressive disorder (OR 3.5, 95% CI 2.6–4.6), obsessive-compulsive disorder (OR 3.9, 95% CI 2.4–6.5), and alcohol abuse or dependence (OR 3.5, 95% CI 1.9–6.3). Current SSRI use was independently associated with frequent NW (≥2 episodes per month; OR 3.0, 95% CI 1.7–5.3), and use of over-the-counter sleep aids was associated with more frequent episodes.

Sleep-disorder comorbidity was also strong. Obstructive sleep apnea syndrome (OR 3.9), circadian rhythm sleep disorders (OR 3.4), insomnia disorder, and disruptive sleep schedules were all more common in adults reporting recent NW. Subjects with NW were significantly more likely to report excessive daytime sleepiness and a history of unexplained injuries occurring at night.

Discussion: These findings overturned the long-standing clinical assumption that adult sleepwalking is rare. A lifetime prevalence near 30%, with about 1 in 28 adults reporting an episode in the past year, places NW among the more common sleep-related phenomena. The strong associations with depression, OCD, alcohol use, OSA, and SSRIs suggest that NW in adults frequently signals an underlying condition that is itself treatable — and that "just sleepwalking" is rarely a complete clinical answer in adults presenting with new or frequent episodes. SSRIs in particular have a plausible mechanism (suppression of REM and disruption of slow-wave sleep transitions); the association may be pharmacologic rather than purely confounded by underlying depression.

Limitations: The design is cross-sectional, so causality cannot be inferred; for example, depression may precede, follow, or be unrelated to NW in any given individual. Reports of nocturnal events depended on subject (or bed-partner) recall and may under-count events with full amnesia. The Sleep-EVAL telephone instrument does not include polysomnography, so distinguishing classical NREM sleepwalking from REM behavior disorder, nocturnal seizures, or dissociative episodes requires clinical follow-up.

Conclusion: Nocturnal wandering is a substantially more common adult phenomenon than previously appreciated, and is strongly comorbid with depression, OCD, alcohol use, OSA, circadian rhythm disorders, and SSRI use. Clinicians evaluating an adult with frequent NW should screen for these comorbidities rather than treating the sleepwalking in isolation.`,
  },
  {
    title:
      "Evening use of light-emitting eReaders negatively affects sleep, circadian timing, and next-morning alertness",
    authors: "Chang AM, Aeschbach D, Duffy JF, Czeisler CA",
    year: 2015,
    journal: "Proceedings of the National Academy of Sciences",
    doi: "10.1073/pnas.1418490112",
    sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/25535358/",
    abstract:
      "In a randomized crossover laboratory study, reading on a light-emitting eReader for four hours before bedtime delayed circadian timing, suppressed melatonin, lengthened time to fall asleep, reduced next-morning alertness, and delayed the clock on subsequent nights compared with reading a printed book.",
    fullText: `Chang and colleagues compared five consecutive evenings of reading on a light-emitting eReader with reading the same material in print. Healthy adults read for four hours before their scheduled bedtime under each condition in a controlled laboratory protocol.

Compared with print, eReader use suppressed evening melatonin, delayed circadian phase, lengthened sleep onset, reduced next-morning alertness, and shifted sleep timing later on subsequent nights. This was a small, highly controlled study of prolonged nightly exposure, so it does not establish the effect of every device, setting, or amount of use. It does show that bright, close screen exposure in the hours before bed is biologically active rather than neutral.`,
  },
  {
    title:
      "Irregular sleep/wake patterns are associated with poorer academic performance and delayed circadian and sleep/wake timing",
    authors:
      "Phillips AJK, Clerx WM, O'Brien CS, Sano A, Barger LK, Picard RW, Lockley SW, Klerman EB, Czeisler CA",
    year: 2017,
    journal: "Scientific Reports",
    doi: "10.1038/s41598-017-03171-4",
    sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/28584839/",
    abstract:
      "Across university students monitored with sleep diaries and wearable devices, greater day-to-day irregularity in sleep timing was associated with later circadian timing, later sleep onset, and poorer academic performance independently of average sleep duration.",
    fullText: `Phillips and colleagues measured day-to-day sleep timing in university students and compared it with circadian timing and academic performance. Students with more variable bedtimes and wake times tended to have later circadian timing and poorer grades, even after accounting for average sleep duration.

The study is observational and in students, so it cannot prove that irregular sleep causes poorer performance or prescribe one schedule for everyone. The useful supported point is narrower: average hours alone do not describe sleep health. Repeatedly moving sleep timing around can work against a stable biological clock.`,
  },
  {
    title:
      "Benefits of napping in healthy adults: impact of nap length, time of day, age, and experience with napping",
    authors: "Milner CE, Cote KA",
    year: 2009,
    journal: "Journal of Sleep Research",
    doi: null,
    sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/19320893/",
    abstract:
      "This review finds that daytime naps can improve alertness and performance in healthy adults, while noting that longer or later naps are more likely to produce sleep inertia or interfere with nighttime sleep, especially for people with insomnia.",
    fullText: `Milner and Cote reviewed evidence on daytime napping in healthy adults. Short daytime naps can improve alertness, mood, and performance, particularly after restricted sleep or during the normal afternoon dip in alertness.

The tradeoff is timing and length. Longer naps can leave people groggy on waking, and late-afternoon or evening naps can reduce sleep pressure for nighttime sleep. The review does not show that every person needs a nap; it supports using a brief, earlier nap as a tool when it helps rather than as a replacement for regularly insufficient overnight sleep.`,
  },
  {
    title: "Alcohol disrupts sleep homeostasis",
    authors: "Thakkar MM, Sharma R, Sahota P",
    year: 2015,
    journal: "Alcohol",
    doi: "10.1016/j.alcohol.2015.01.002",
    sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/25701040/",
    abstract:
      "This review describes how alcohol can shorten sleep onset initially but disrupts normal sleep regulation later in the night, altering REM sleep and promoting sleep fragmentation as blood alcohol levels fall.",
    fullText: `Thakkar, Sharma, and Sahota reviewed experimental and mechanistic evidence on alcohol and sleep. Alcohol's sedating effect can make falling asleep feel easier, but it changes normal sleep architecture and commonly produces more fragmented sleep later as alcohol is metabolized.

The review is not a dose-by-dose guide for every person, but it supports a clear distinction: sedation is not the same as restorative sleep. Alcohol should not be treated as a sleep aid, particularly when someone is already struggling with waking in the second half of the night.`,
  },
  {
    title: "Sleep habits and susceptibility to the common cold",
    authors: "Cohen S, Doyle WJ, Alper CM, Janicki-Deverts D, Turner RB",
    year: 2009,
    journal: "Archives of Internal Medicine",
    doi: "10.1001/archinternmed.2009.22",
    sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/19139325/",
    abstract:
      "In adults experimentally exposed to a cold virus, shorter habitual sleep and lower sleep efficiency in the weeks before exposure were associated with a higher likelihood of developing a clinical cold.",
    fullText: `Cohen and colleagues tracked adults' usual sleep before exposing them to a cold virus under controlled research conditions. People reporting shorter sleep and poorer sleep efficiency were more likely to develop a clinical cold after exposure than those with more efficient sleep.

This study links habitual sleep with susceptibility; it does not mean one good night prevents infection or that sleep replaces vaccination, hygiene, or medical care. It does support treating adequate, consistent sleep as one contributor to normal immune resilience rather than a luxury.`,
  },
  {
    title: "Slow-wave sleep and the risk of type 2 diabetes in humans",
    authors: "Tasali E, Leproult R, Ehrmann DA, Van Cauter E",
    year: 2008,
    journal: "Proceedings of the National Academy of Sciences",
    doi: "10.1073/pnas.0706446105",
    sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/18299569/",
    abstract:
      "Selective suppression of slow-wave sleep for three nights in healthy adults reduced insulin sensitivity and altered glucose regulation without substantially reducing total sleep time.",
    fullText: `Tasali and colleagues selectively reduced slow-wave sleep, the deepest stage of sleep, in healthy young adults while preserving much of their total sleep time. After several nights, insulin sensitivity and glucose regulation were measurably worse.

This was a short laboratory experiment, not proof that one disrupted night causes diabetes or that consumer sleep-stage estimates diagnose metabolic health. It supports the broader point that sleep quality and continuity matter alongside total duration, especially when fragmentation repeatedly cuts into deep sleep.`,
  },
  {
    title: "The association of sleep and pain: an update and a path forward",
    authors: "Finan PH, Goodin BR, Smith MT",
    year: 2013,
    journal: "The Journal of Pain",
    doi: "10.1016/j.jpain.2013.08.007",
    sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/24290442/",
    abstract:
      "This review concludes that experimentally disrupted or shortened sleep increases next-day pain sensitivity and that sleep disturbance and chronic pain often reinforce one another.",
    fullText: `Finan, Goodin, and Smith reviewed laboratory and clinical research on sleep and pain. Experimental sleep disruption increases pain sensitivity the next day, while chronic pain often disrupts sleep, creating a two-way cycle.

The review does not say poor sleep explains every pain condition or replaces evaluation of new, severe, or persistent pain. It supports taking sleep seriously as part of a pain-management plan: improving sleep continuity can be clinically relevant even when it is not the only cause of symptoms.`,
  },
  {
    title:
      "Effects of evening exercise on sleep in healthy participants: a systematic review and meta-analysis",
    authors: "Stutz J, Eiholzer R, Spengler CM",
    year: 2019,
    journal: "Sports Medicine",
    doi: "10.1007/s40279-018-1015-0",
    sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/30560568/",
    abstract:
      "A systematic review and meta-analysis found that evening exercise generally did not impair sleep in healthy participants, while very vigorous exercise ending close to bedtime may delay sleep for some people.",
    fullText: `Stutz and colleagues synthesized experimental studies of exercise performed in the evening. For most healthy participants, exercising in the evening did not worsen sleep compared with not exercising, and some measures of sleep were modestly better.

The evidence is less reassuring for very vigorous sessions ending immediately before bedtime, and individual responses differ. The supported practical conclusion is not that everyone should exercise late, but that a rigid rule banning all evening exercise is not evidence-based.`,
  },
  {
    title: "Mindfulness meditation for insomnia: a randomized controlled trial",
    authors: "Ong JC, Manber R, Segal Z, Xia Y, Shapiro S, Wyatt JK",
    year: 2014,
    journal: "Sleep",
    doi: "10.5665/sleep.3666",
    sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/24932175/",
    abstract:
      "In adults with chronic insomnia, a mindfulness-based program improved insomnia symptoms and reduced sleep-related arousal relative to a sleep-hygiene comparison, though it was not a substitute for established first-line CBT-I.",
    fullText: `Ong and colleagues tested a mindfulness-based treatment for adults with chronic insomnia. The program aimed to reduce the struggle with wakefulness and the arousal that can build when people try to force sleep.

Participants improved on insomnia-related outcomes compared with a sleep-hygiene comparison. This is not evidence that meditation is a universal cure or that it replaces CBT-I, which remains first-line treatment. It does support mindfulness as a potentially useful adjunct for the racing thoughts and conditioned arousal that often maintain insomnia.`,
  },
  {
    title: "Sleep health: can we define it? Does it matter?",
    authors: "Buysse DJ",
    year: 2014,
    journal: "Sleep",
    doi: "10.5665/sleep.3298",
    sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/24470692/",
    abstract:
      "This review proposes that sleep health includes satisfaction, alertness, timing, efficiency, and duration, rather than a single nightly score or hour target.",
    fullText: `Buysse proposed a multidimensional account of sleep health. The framework includes being satisfied with sleep, staying appropriately alert during the day, having sleep at a workable time, spending most time in bed asleep, and getting an adequate duration.

This is a conceptual framework rather than a trial of an intervention. Its value is practical: it cautions against treating one wearable score, one sleep-stage estimate, or one exact hour target as the whole story. Sleep can be worth attention even when only one dimension is persistently off.`,
  },
  {
    title: "Sleep and human aging",
    authors: "Mander BA, Winer JR, Walker MP",
    year: 2017,
    journal: "Neuron",
    doi: "10.1016/j.neuron.2017.02.004",
    sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/28231463/",
    abstract:
      "This review summarizes evidence that aging changes sleep architecture and circadian timing while emphasizing that sleep complaints in later life deserve assessment rather than dismissal as an inevitable reduction in sleep need.",
    fullText: `Mander, Winer, and Walker reviewed sleep changes across aging. Older adults often experience lighter, more fragmented sleep and shifts in timing, but the review distinguishes common age-related changes from the assumption that older adults simply need much less sleep.

The review does not set one universal sleep target for every older adult. It supports a respectful clinical stance: persistent daytime impairment, loud snoring or witnessed breathing pauses, repeated insomnia, or new dream-enactment behavior are reasons to assess sleep rather than normalize distress away because of age.`,
  },
];

const INTERPRETATIONS: SeedInterpretation[] = [
  {
    sourceTitle:
      "Using difficulty resuming sleep to define nocturnal awakenings",
    answer:
      "Waking up around 3am is extremely common — and usually not a sign that something is wrong.",
    interpretation:
      "In a survey of nearly 9,000 American adults, about one in three reported waking at least three nights a week (Ohayon et al., 2010). Brief awakenings are a normal feature of sleep: you cycle through deeper and lighter stages roughly every 90 minutes, and because deep sleep is concentrated early in the night, the second half — those early-morning hours people experience as 3am — is naturally lighter and easier to surface from. The finding that actually matters from this work is this: the awakening itself is rarely the problem. What separates a harmless stir from a wrecked next day is whether you can fall back asleep. People who wake and drift off again feel fine; people who wake and then lie there awake are the ones who suffer. So the goal isn't to never wake — it's to make getting back to sleep easy. The usual reversible culprits are a nightcap (alcohol fragments the second half of the night as it wears off), late caffeine, a too-warm room, light and clock-watching, and a racing mind.",
    notProven:
      "This is a population survey: it shows how common night-time waking is and what it's associated with. It does not prove what causes any one person's 3am wake-ups, and it cannot diagnose insomnia, sleep apnea, or other disorders.",
    action:
      "Don't check the clock or reach for your phone — light and time-checking only wake the brain further. If you're not back asleep within about 15–20 minutes, get up, keep the lights dim, do something quiet and boring, and return to bed when you feel sleepy. Cut alcohol and caffeine in the second half of the day, and keep the bedroom cool and dark. If waking and struggling to get back to sleep happens most nights for weeks and wears on your days, that's chronic insomnia — and the first-line fix is CBT-I, not a sleeping pill.",
    tags: [
      "nocturnal awakening",
      "3am",
      "waking at night",
      "sleep maintenance",
      "sleep architecture",
      "alcohol",
      "insomnia",
    ],
  },
  {
    sourceTitle: "Effects of Diet on Sleep Quality",
    answer:
      "What you eat does affect sleep — but skip the gimmicks: aim for a light, balanced evening rather than a single 'magic' snack.",
    interpretation:
      "The best evidence here is associational but consistent (St-Onge et al., 2016): people whose diets are higher in fiber and lower in saturated fat and sugar spend more time in deep, slow-wave sleep and wake less during the night, while days heavy in sugar and refined carbohydrate tend to bring lighter, more broken sleep. If you're genuinely hungry near bedtime, a small snack that pairs a complex carbohydrate with a little protein — oatmeal, whole-grain toast with nut butter, yogurt, or a banana — is a sensible choice. A couple of foods, notably tart cherry (a natural source of melatonin) and kiwifruit, have shown modest benefits in small trials. But the bigger levers are not eating a heavy meal right before bed and not going to bed either stuffed or starving.",
    notProven:
      "Most of this is correlation, not proof that a specific food fixes sleep, and the 'sleepy' foods like tart cherry and kiwi rest on small studies. There is no single snack that reliably knocks you out, and individual responses vary.",
    action:
      "Finish large meals 2–3 hours before bed. If you need something later, keep it small and combine a complex carb with a little protein. Favor an overall pattern rich in fiber, vegetables, and whole grains, go easy on late sugar, and remember that alcohol is a sleep disruptor, not a nightcap.",
    tags: [
      "nutrition",
      "diet",
      "snacks",
      "food for sleep",
      "slow-wave sleep",
      "evening meal",
    ],
  },
  {
    sourceTitle: "Effects of thermal environment on sleep and circadian rhythm",
    answer:
      "For the bedroom, temperature matters far more than mattress firmness — keep it cool, dark, and quiet.",
    interpretation:
      "Your body lowers its core temperature to fall and stay asleep, so the sleeping environment needs to let you shed heat. The evidence shows that being too hot or too cold increases night-time wakefulness and cuts into both deep (slow-wave) and REM sleep, with humid heat the worst offender (Okamoto-Mizuno & Mizuno, 2012). A cool room — most people land somewhere around the mid-60s°F, roughly 18–19°C — together with breathable bedding helps you stay asleep through the naturally lighter second half of the night. On mattress firmness specifically: there isn't good science crowning one firmness as best for everyone. What matters is comfort and support that keep your spine in a neutral, relaxed position, and that's individual. Reach for the cheaper, better-evidenced levers first — temperature, darkness, and quiet.",
    notProven:
      "There is no single 'correct' room temperature or mattress firmness for everyone; the right setting depends on your bedding, clothing, and personal comfort. Claims that a particular mattress firmness cures insomnia or back pain are not well supported.",
    action:
      "Set the room cool (try the mid-60s°F / ~18–19°C and adjust to taste), use breathable bedding, and block out light and noise. Warming your hands and feet helps your body offload core heat, so a warm bath or shower 1–2 hours before bed can actually speed sleep onset. Choose a mattress and pillow for comfort and neutral spine alignment rather than chasing a 'firmness number'.",
    tags: [
      "temperature",
      "bedroom",
      "sleep environment",
      "mattress",
      "thermal",
      "humidity",
    ],
  },
  {
    sourceTitle:
      "Effects of caffeine on the human circadian clock in vivo and in vitro",
    answer:
      "Evening caffeine doesn't just keep you up — it pushes your body clock later.",
    interpretation:
      "We usually think of caffeine as a stimulant that delays sleep, and it does. But this study showed something extra: a double-espresso's worth of caffeine taken about 3 hours before bed delayed the body's internal clock — the melatonin rhythm — by roughly 40 minutes, about half the delay you'd get from bright light at night (Burke et al., 2015). So an evening coffee can nudge your whole sleep-wake timing later, making it harder to fall asleep on schedule and dragging the effect into the next day, on top of the simple wakefulness. Combined with caffeine's long half-life — commonly 5 to 7 hours, and longer in some people — that's why an afternoon or evening cup can quietly cost you sleep even if you think it doesn't. This is about timing as much as amount.",
    notProven:
      "This measured the circadian shift from one evening dose under controlled lab conditions; it doesn't quantify how much any given person's sleep will suffer, and sensitivity to caffeine varies widely from person to person.",
    action:
      "Treat early afternoon as your caffeine cutoff — caffeine's half-life means a 3pm coffee is often still active at bedtime. If you're a slow metabolizer or your sleep is fragile, stop earlier. Watch the hidden sources too: tea, soda, chocolate, and many 'energy' drinks all carry caffeine.",
    tags: [
      "caffeine",
      "coffee",
      "circadian",
      "melatonin",
      "evening",
      "body clock",
    ],
  },
  {
    sourceTitle:
      "Subjective sleep quality is poorly associated with actigraphy and heart rate measures in community-dwelling older men",
    answer:
      "Your wearable's HRV and heart-rate 'sleep score' is a weak guide to how well you actually slept — trust how you feel more than the number.",
    interpretation:
      "In a study of 1,141 older men from Jamie Zeitzer's Stanford lab, overnight heart rate, heart rate variability (HRV), and movement were compared against people's own next-morning sense of how rested they felt — and the objective signals explained almost none of it (R-squared roughly 0.025 to 0.162) (Faerman, Kaplan & Zeitzer, 2020). That's a striking disconnect: the very signals consumer trackers turn into a 'sleep score' barely predicted whether someone woke up feeling refreshed. HRV is a real and useful measure of your autonomic balance — handy for trends in stress, training, and recovery — but it is not a good readout of subjective sleep quality. The practical lesson is to hold your tracker loosely: a 'bad HRV' night when you feel fine isn't an emergency, and a glowing score won't make you feel rested if you don't.",
    notProven:
      "This was older men, studied at one point in time, so the exact numbers may differ for women or younger people, and it doesn't test any specific device or brand. It does not show that HRV is worthless for other purposes (fitness, recovery, illness) — only that it tracks poorly with how rested you feel.",
    action:
      "Treat your sleep tracker's HRV-based score as a rough weekly trend, not a verdict on each night. Judge your sleep mainly by daytime function — energy, focus, mood — and don't let a low number talk you into anxiety that itself wrecks the next night. If your numbers look fine but you feel exhausted day after day, that mismatch is worth a conversation with a clinician, not a new gadget.",
    tags: [
      "HRV",
      "heart rate variability",
      "wearables",
      "sleep tracker",
      "sleep score",
      "subjective sleep quality",
    ],
  },
  {
    sourceTitle:
      "Faster REM sleep EEG and worse restedness in older insomniacs with HLA DQB1*0602",
    answer:
      "REM sleep isn't just about quantity — its quality is linked to your genes, so chasing 'more REM' on a tracker misses the point.",
    interpretation:
      "Jamie Zeitzer's own REM research looked at a common gene variant, HLA DQB1*0602, in 46 older adults with insomnia. The roughly one in four who carried it had faster, higher-frequency brain activity during REM sleep and reported feeling less rested (Zeitzer et al., 2011). The interesting message for everyday life is that the character of REM — the texture and speed of the brain's activity, not only the number of minutes — varies between people and is associated with a genetic marker you can't change. So 'how do I get more REM?' is the wrong frame: REM quality is not a dial you can simply turn up, and a tracker's REM minutes don't capture this deeper difference. REM does respond to the basics, though — it's concentrated in the last third of the night, so the surest way to lose it is to cut sleep short.",
    notProven:
      "This is a small, cross-sectional study in older adults with insomnia, so it shows an association, not cause, and doesn't apply cleanly to healthy or younger sleepers. It does not establish any way to change your REM EEG, and consumer trackers' 'REM' estimates are themselves only rough approximations of lab-measured REM.",
    action:
      "Stop chasing a REM number on your watch — those estimates are approximate, and REM quality isn't something you can directly boost. Instead protect the back half of the night, when REM is richest: keep a consistent wake time and don't routinely cut sleep short with an early alarm. Be aware that alcohol and some sleep medications suppress REM, so an alcohol-free, regular schedule is the most reliable way to let normal REM happen.",
    tags: [
      "REM",
      "REM sleep",
      "sleep stages",
      "sleep architecture",
      "genetics",
      "deep sleep",
    ],
  },
  {
    sourceTitle:
      "Hyperexcitable arousal circuits drive sleep instability during aging",
    answer:
      "Fragmented sleep in older age has a biological cause — overactive wake-promoting neurons — not just bad habits.",
    interpretation:
      "This Science paper (Li et al., 2022) traced the mechanism of age-related sleep fragmentation in mice to the brain's orexin/hypocretin neurons, which are the primary switch that keeps you awake. In aged animals, about 38% of these neurons were lost; the survivors became hyperexcitable — their resting electrical charge drifted closer to the firing threshold, so they triggered wake episodes more easily and kept animals awake longer once triggered. The root cause was loss of KCNQ2/3 potassium channels, which normally act as a molecular brake. When those channels were disabled in young mice using CRISPR, young animals developed the same fragmented sleep pattern as old ones. Pharmacologically restoring the brake (flupirtine, a KCNQ2/3 activator) consolidated sleep in aged mice. The mechanism appears conserved across species, suggesting it likely operates in humans too. The practical message is that the common dismissal — 'older people just need less sleep' — is not what the science says. Age-related sleep fragmentation reflects genuine neurobiological change, and it is a legitimate target for treatment rather than something to simply accept.",
    notProven:
      "This is a mouse study; the KCNQ2/3 mechanism has not yet been confirmed in humans, and flupirtine (which has liver-safety concerns) is not an approved sleep therapy for people. The work does not tell you what you as an individual can do to reverse the process, and it does not apply to sleep fragmentation in younger adults.",
    action:
      "If you are an older adult with fragmented sleep, know that the biology is real and the problem is treatable — CBT-I remains the first-line evidence-based intervention for sleep maintenance insomnia, and a sleep clinician can help distinguish fragmentation driven by sleep architecture changes from other causes (sleep apnea, pain, medication, anxiety). Keep the bedroom cool and dark, protect morning light exposure to anchor your circadian clock, and avoid alcohol, which worsens the second half of the night.",
    tags: [
      "aging",
      "sleep fragmentation",
      "older adults",
      "orexin",
      "hypocretin",
      "sleep maintenance",
      "neuroscience",
      "wake",
    ],
  },
  {
    sourceTitle:
      "Timing of outdoor light exposure is associated with sleep-wake consolidation in community-dwelling older men",
    answer:
      "For older adults, afternoon light may do more for sleep consolidation than morning light — the timing of daylight matters as much as the amount.",
    interpretation:
      "From Jamie Zeitzer's Stanford lab (Lok, Ancoli-Israel, Ensrud, Redline, Stone & Zeitzer, 2023): in 877 community-dwelling older men monitored with wrist actigraphy for a week, sleep-wake fragmentation correlated with poorer physical health, worse mental health, and lower cognition. Crucially, it was not just total daytime light that mattered — it was when that light arrived. Morning and evening bright light (above 1,000 lux) barely distinguished people with good versus poor sleep consolidation. What discriminated best was light exposure in the mid-afternoon window, specifically around 6.7 hours after habitual sleep offset — roughly 1–2pm for someone who wakes at 7am. The proposed reason is circadian amplitude: older adults often have a flattened, low-amplitude circadian rhythm that struggles to maintain strong consolidated sleep or wakefulness. Afternoon light may specifically boost that amplitude more effectively than morning light in this group, strengthening the biological signal that drives consolidation. This is a different goal from morning light, which mainly phase-shifts the clock earlier.",
    notProven:
      "This is a cross-sectional observational study in older men only — it shows an association, not a proven causal benefit of afternoon light therapy. Controlled randomized trials of timed afternoon light in older adults are still needed. Results may not apply to women or to younger adults whose circadian amplitude is typically higher.",
    action:
      "If you are an older adult with fragmented, unrefreshing sleep, try getting outdoors or sitting near a bright window in the mid-afternoon (around 1–2pm, adjusted for your own wake time) rather than — or in addition to — morning light. Aim for genuine outdoor light or at least 1,000 lux for 30–60 minutes. Keep your sleep and wake times consistent, as regularity anchors the circadian clock regardless of light. If you live or work in a poorly lit environment, deliberately planning an afternoon outdoor break may be more useful than you expect.",
    tags: [
      "light",
      "light therapy",
      "afternoon light",
      "circadian",
      "sleep fragmentation",
      "older adults",
      "aging",
      "sleep consolidation",
      "daytime",
    ],
  },
  {
    sourceTitle:
      "Impaired 24-h activity patterns are associated with an increased risk of Alzheimer's disease, Parkinson's disease, and cognitive decline",
    answer:
      "A weak or irregular 24-hour sleep-wake rhythm, measurable by a wearable, is associated with elevated risk of Alzheimer's and Parkinson's disease years before diagnosis.",
    interpretation:
      "Winer, Lok, Weed, He, Poston, Mormino, and Zeitzer (2024, Alzheimer's Research & Therapy) — from Jamie Zeitzer's Stanford group — followed 82,829 UK Biobank participants for nearly 7 years. People who went on to develop Alzheimer's disease had, years earlier, lower diurnal amplitude (flatter activity rhythm across the day), lower mean activity levels, and less activity during their most active daytime hours. Higher interdaily stability — a more rigid, less naturally variable day-to-day pattern — was also associated with elevated Alzheimer's risk. The associations for Parkinson's disease were even stronger. Disrupted 24-hour rhythmicity additionally predicted worsening cognitive test scores over time. The most important thing to understand about these results is the direction of causality: disrupted 24-h patterns likely reflect very early neurodegeneration already affecting the brainstem circuits that control sleep and wakefulness, often years before memory symptoms appear. A wearable can pick up this signal. This does not mean a bad night 'causes' Alzheimer's — but it does mean that your sleep-wake rhythm integrity is a real biological indicator worth taking seriously.",
    notProven:
      "This is a prospective observational study — it cannot establish that disrupted sleep-wake rhythms cause Alzheimer's or Parkinson's. The observed associations may partly or fully reflect very early pre-clinical disease already silently disrupting activity patterns. It does not show that improving your rhythm will prevent these diseases, and it does not test any specific intervention.",
    action:
      "Maintain a consistent daily rhythm of activity and rest: get up at the same time every day, be physically active during the day (especially outdoors), and avoid prolonged sedentary periods. A wrist-worn activity tracker can give you a rough read on how consistent and robust your daily rhythm is — look for a clear rise in activity in the morning and a sustained drop at night, and day-to-day variation that is natural rather than erratic. If you or a family member notices long-standing, worsening sleep fragmentation alongside other early changes in memory or movement, discuss it with a clinician — the sleep-wake rhythm change is worth mentioning as part of the picture.",
    tags: [
      "Alzheimer's",
      "dementia",
      "Parkinson's",
      "cognitive decline",
      "circadian",
      "24-hour rhythm",
      "wearables",
      "aging",
      "activity patterns",
      "sleep-wake rhythm",
    ],
  },
  // --- Original Zeitzer curated corpus (restored from production) ---
  {
    sourceTitle:
      "Sensitivity of the human circadian pacemaker to nocturnal light: melatonin phase resetting and suppression",
    answer: "Yes — ordinary room light at night affects your sleep clock.",
    interpretation:
      "Half-maximal melatonin suppression in healthy adults occurs at about 100 lux. That is the brightness of a moderately lit living room or kitchen — well below what most people call 'bright.' If you spend the hour before bed in normal indoor lighting, you are actively suppressing melatonin and delaying your circadian clock. The effect is graded: 30–500 lux is the steepest part of the dose-response curve, so even modest dimming meaningfully reduces the impact.",
    notProven:
      "We don't yet know how much individual variation matters here, or whether the specific spectrum of LED bulbs versus incandescent meaningfully changes the threshold for most people.",
    action:
      "Dim overhead lights and switch to lamps in the last 1–2 hours before bed. If you are working or reading, aim for warm, low-brightness light (under ~30 lux at the eye). Save bright overheads for daytime.",
    tags: ["light", "melatonin", "circadian", "evening"],
  },
  {
    sourceTitle:
      "The cumulative cost of additional wakefulness: dose-response effects on neurobehavioral functions and sleep physiology",
    answer: "No — you cannot 'get used to' six hours of sleep.",
    interpretation:
      "When healthy adults were restricted to 6 hours of sleep per night for two weeks, their cognitive performance kept degrading day by day until it matched the level seen after one full night of total sleep deprivation. The catch: their subjective sleepiness ratings plateaued after a few days. They felt only slightly tired — but they were profoundly impaired. This is why people who chronically sleep 6 hours often report feeling 'fine' while objectively performing as if drunk.",
    notProven:
      "Whether occasional individuals are genuinely resilient to chronic sleep restriction is debated, but the prevalence of true 'short sleepers' is far lower than the number of people who self-identify as one.",
    action:
      "Treat sleep as a non-negotiable input, not a flexible output. If you average 6 hours, your performance is likely worse than you think — measure it (reaction time apps work) rather than trusting how you feel.",
    tags: ["sleep deprivation", "cognition", "performance"],
  },
  {
    sourceTitle:
      "Caffeine effects on sleep taken 0, 3, or 6 hours before going to bed",
    answer: "Stop caffeine by early afternoon if you want to protect sleep.",
    interpretation:
      "A 400 mg caffeine dose (roughly two cups of coffee) taken 6 hours before bed reduced total sleep time by more than an hour in healthy normal sleepers. Subjective sleep quality did not capture the disruption — subjects didn't 'feel' that their sleep had been damaged, but polysomnography showed it clearly. With caffeine's ~5-hour half-life, a 3pm coffee still has a meaningful blood concentration at 11pm.",
    notProven:
      "Individual sensitivity varies based on CYP1A2 genotype and habitual intake. Some people genuinely metabolize caffeine quickly. Without testing, assume you are not one of them.",
    action:
      "Cut off caffeine by ~2pm if you go to bed around 10–11pm. If you are sleeping poorly and don't know why, this is the cheapest experiment you can run.",
    tags: ["caffeine", "stimulants", "sleep efficiency"],
  },
  {
    sourceTitle:
      "The effects of physical activity on sleep: a meta-analytic review",
    answer:
      "Regular exercise helps sleep — and evening workouts are usually fine.",
    interpretation:
      "A meta-analysis of 66 studies found that regular moderate-intensity exercise reliably improves sleep efficiency and reduces sleep onset latency, with the largest effects for people with insomnia. The widely repeated warning to 'never exercise within 3 hours of bedtime' is not supported by the data in healthy adults — evening exercise had effects statistically indistinguishable from no exercise across studies. Some individuals are sensitive; most are not.",
    notProven:
      "Very high-intensity exercise within an hour of bed has not been studied as well, and core temperature elevation could in principle delay sleep onset for some people. Listen to your body, not the slogan.",
    action:
      "If exercise fits your evening, do it — especially if you have insomnia. Track your own sleep for a week of evening workouts vs. morning workouts and let your data, not the rule of thumb, decide.",
    tags: ["exercise", "movement", "insomnia"],
  },
  {
    sourceTitle:
      "A randomized clinical trial of cognitive behavioral therapy for insomnia delivered in primary care",
    answer:
      "If you have chronic insomnia, ask for CBT-I before sleep medication.",
    interpretation:
      "Cognitive behavioral therapy for insomnia (CBT-I) is the first-line treatment in every major guideline — not Ambien, not benzodiazepines, not melatonin. A brief 6-visit CBT-I protocol delivered by trained primary-care nurses produced 7-point reductions in Insomnia Severity Index that were sustained at 6 months. Sleep medications work for a few weeks; CBT-I changes the underlying pattern.",
    notProven:
      "CBT-I works best when you complete the full protocol — partial adherence (skipping sleep restriction, ignoring stimulus control) substantially reduces effect size. Digital CBT-I apps appear effective but have less long-term outcome data than in-person delivery.",
    action:
      "If you have had insomnia for more than 3 months, ask your primary-care clinician about CBT-I (in-person, telehealth, or a validated app like Sleepio or Somryst) before accepting a hypnotic prescription.",
    tags: ["insomnia", "CBT-I", "treatment"],
  },
  {
    sourceTitle: "Stanford Health Care CBT-I clinical procedures",
    answer:
      "CBT-I is a structured program: it resets the bed-sleep connection, adjusts time in bed using a sleep diary, and reduces the habits and worry that keep insomnia going.",
    interpretation:
      "Stanford's clinical guide lays out a practical sequence. First, track sleep and choose a regular wake time. Second, use stimulus control: go to bed only when sleepy, and if you are awake in bed, get up for a quiet, dim-light activity and return only when sleepy. Third, use an individualized time-in-bed schedule based on your recent average sleep, not on the amount of time you wish you slept. Review it weekly: when sleep efficiency is at least 85%, add 15 to 30 minutes; below 80%, shorten the window; between those values, keep it steady. Fourth, lower bedtime arousal with a wind-down hour, no clock-watching, a calm bedroom, and work on sleep-related worry rather than trying to force sleep. Finally, protect the rhythm with a consistent wake time and fewer sleep-disrupting substances, especially late caffeine and alcohol.",
    notProven:
      "These are the core CBT-I procedures, not a one-size-fits-all prescription. The time-in-bed schedule is tailored to the person and should be adjusted with a trained clinician when sleepiness could create a safety risk.",
    action:
      "For a safe starting point this week: keep a simple sleep diary, choose one consistent wake time, use the bed only for sleep, and ask a clinician or certified CBT-I provider to help you set the time-in-bed component. Do not drive or do other safety-critical work if the plan leaves you drowsy.",
    tags: [
      "CBT-I steps",
      "CBT-I protocol",
      "cognitive behavioral therapy insomnia",
      "stimulus control",
      "sleep restriction",
      "time in bed",
      "sleep efficiency",
      "sleep diary",
      "insomnia treatment",
    ],
  },
  {
    sourceTitle:
      "Prevalence and comorbidity of nocturnal wandering in the U.S. adult general population",
    answer:
      "Adult sleepwalking is far more common than people think — about 1 in 30 adults has had an episode in the past year — and it's strongly linked to depression, SSRIs, and obstructive sleep apnea.",
    interpretation:
      "The largest U.S. prevalence study of sleepwalking (Ohayon et al., Neurology 2012, n=19,136 adults from a representative sample) found a lifetime prevalence of 29.2% — meaning roughly 3 in 10 American adults have sleepwalked at some point — and a past-year prevalence of 3.6%, with 1% reporting two or more episodes per month. That past-year figure works out to about 8.4 million U.S. adults. Sleepwalking is not, as the older clinical assumption held, mostly a childhood phenomenon that resolves in adolescence. About a third of adult sleepwalkers report childhood onset that persisted; the rest report adult-onset. The clinically important finding is who else is in the room: adults with recent sleepwalking had 3.5× the odds of major depressive disorder, 3.9× the odds of OCD, 3.5× the odds of alcohol abuse/dependence, 3.9× the odds of obstructive sleep apnea, and 3.4× the odds of a circadian rhythm sleep disorder. SSRI use was independently associated with frequent episodes (OR 3.0), which is mechanistically plausible — SSRIs suppress REM and disrupt slow-wave sleep transitions, the exact terrain where NREM parasomnias arise. The right way to read this paper: in an adult, new or frequent sleepwalking is almost never an isolated curiosity. It's a signal to look for an underlying treatable condition.",
    notProven:
      "The study is cross-sectional, so it cannot establish causality — depression may precede, follow, or be unrelated to sleepwalking in any given individual, and the same caveat applies to SSRIs, OSA, and alcohol. Sleepwalking was assessed by telephone interview rather than polysomnography, so it cannot reliably distinguish classical NREM sleepwalking from REM behavior disorder, nocturnal seizures, or dissociative nighttime episodes — distinctions that matter clinically because each has a different workup and treatment. Self-report (or bed-partner report) under-counts events with full amnesia. Whether stopping an SSRI reduces episode frequency, or whether treating OSA does, was not tested in this study and remains an open question for randomized trials.",
    action:
      "If you're an adult who has started sleepwalking — or has had two or more episodes in the past month — don't treat it as a quirk. Ask your clinician to (1) screen for sleep apnea (snoring, witnessed apneas, daytime sleepiness — a home sleep study is usually the right first step), (2) review every medication you take, especially SSRIs and OTC sleep aids, with a sleep-aware lens, and (3) ask whether a depression or alcohol-use screen is warranted. In the meantime, the standard parasomnia-safety steps still apply: clear floor obstacles in the bedroom, keep bedroom doors closed, avoid sleeping near stairs or open windows, and limit alcohol within four hours of bed.",
    tags: [
      "sleepwalking",
      "somnambulism",
      "nocturnal wandering",
      "parasomnia",
      "NREM parasomnia",
      "adult sleepwalking",
      "depression",
      "SSRI",
      "obstructive sleep apnea",
      "Ohayon",
    ],
  },
  {
    sourceTitle:
      "Millisecond flashes of light phase delay the human circadian clock during sleep",
    answer:
      "Light can shift your body clock even through closed eyelids; protect darkness when you can.",
    interpretation:
      "In a small laboratory crossover study, brief flashes of light delivered through closed eyelids during sleep delayed circadian timing by about 45 minutes (Zeitzer et al., 2014). That finding reinforces that the circadian system responds to light exposure even when we are not consciously attending to it.",
    notProven:
      "This was a tightly controlled experiment with a specialized flash protocol. It does not show that ordinary momentary light exposure will cause a meaningful shift for every person.",
    action:
      "Keep the room dark at night when practical. If you need to get up, use the dimmest safe light and avoid turning on bright overhead lighting.",
    tags: [
      "light",
      "circadian",
      "night light",
      "melatonin",
      "sleep environment",
    ],
  },
  {
    sourceTitle:
      "Evening use of light-emitting eReaders negatively affects sleep, circadian timing, and next-morning alertness",
    answer:
      "Bright screens before bed can delay your clock; the closer and longer the exposure, the more it matters.",
    interpretation:
      "In a controlled crossover study, four hours of eReader use before bed suppressed melatonin, delayed circadian timing, lengthened sleep onset, and reduced next-morning alertness compared with reading print (Chang et al., 2015). Screens are not the only source of evening light, but they are a modifiable one.",
    notProven:
      "The protocol used four hours of nightly eReader reading, so it cannot specify the effect of every phone, setting, app, or shorter exposure.",
    action:
      "Make the last hour before bed lower-light when possible: use print, dim the screen and room, or choose an audio activity. A warmer display setting can help comfort but does not make late bright light biologically irrelevant.",
    tags: [
      "screens",
      "eReader",
      "phone",
      "blue light",
      "evening light",
      "circadian",
    ],
  },
  {
    sourceTitle:
      "Irregular sleep/wake patterns are associated with poorer academic performance and delayed circadian and sleep/wake timing",
    answer:
      "A consistent wake time is often more useful than trying to force a perfect bedtime.",
    interpretation:
      "Students with more day-to-day variation in their sleep timing had later circadian timing and poorer academic performance, independent of average sleep duration (Phillips et al., 2017). The study supports regularity as a meaningful part of sleep health, not just the number of hours logged.",
    notProven:
      "This observational student study cannot prove that an irregular schedule causes poorer performance or determine the right schedule for every adult, shift worker, or caregiver.",
    action:
      "Choose a wake time you can keep most days, including weekends, and let bedtime follow genuine sleepiness. Move the schedule gradually rather than trying to correct it with one very early night.",
    tags: ["schedule", "regularity", "wake time", "circadian", "social jetlag"],
  },
  {
    sourceTitle:
      "Benefits of napping in healthy adults: impact of nap length, time of day, age, and experience with napping",
    answer:
      "A short, early-afternoon nap can restore alertness; a long or late nap can make nighttime sleep harder.",
    interpretation:
      "A review of napping research found that daytime naps can improve alertness and performance, while longer or later naps more often bring grogginess or reduce nighttime sleep pressure (Milner & Cote, 2009). Napping is a tool, not a substitute for routinely insufficient sleep.",
    notProven:
      "The ideal nap length and timing vary, and this review does not establish that naps are helpful for people with chronic insomnia.",
    action:
      "If you nap, try 10–30 minutes in the early afternoon. If falling asleep at night is difficult, experiment with shortening, moving earlier, or skipping the nap for a week.",
    tags: [
      "nap",
      "napping",
      "daytime sleepiness",
      "sleep inertia",
      "afternoon",
    ],
  },
  {
    sourceTitle: "Alcohol disrupts sleep homeostasis",
    answer:
      "Alcohol may make you drowsy, but it usually makes the second half of the night less stable.",
    interpretation:
      "Alcohol can reduce sleep-onset time initially while altering normal sleep regulation, REM sleep, and later-night continuity as it is metabolized (Thakkar et al., 2015). Feeling sedated is not the same as getting restorative sleep.",
    notProven:
      "Responses vary by dose, timing, health conditions, and medications; this review cannot predict one person's exact night after one drink.",
    action:
      "Do not use alcohol as a sleep aid. If you drink, finish earlier in the evening and notice whether middle-of-the-night waking improves on alcohol-free nights.",
    tags: [
      "alcohol",
      "nightcap",
      "REM",
      "sleep fragmentation",
      "waking at night",
    ],
  },
  {
    sourceTitle: "Sleep habits and susceptibility to the common cold",
    answer:
      "Regular, efficient sleep supports normal immune resilience, but it is not a substitute for prevention or care.",
    interpretation:
      "Adults with shorter habitual sleep and poorer sleep efficiency before controlled viral exposure were more likely to develop a clinical cold (Cohen et al., 2009). Sleep is one of several factors that shape immune resilience.",
    notProven:
      "This does not mean one poor night causes illness, that sleep prevents every infection, or that sleep replaces vaccination, hygiene, or medical advice.",
    action:
      "When you are trying to protect your health, keep sleep regular alongside the basics: vaccination where appropriate, hand hygiene, nutrition, activity, and following medical guidance.",
    tags: [
      "immune system",
      "cold",
      "infection",
      "sleep duration",
      "sleep efficiency",
    ],
  },
  {
    sourceTitle: "Slow-wave sleep and the risk of type 2 diabetes in humans",
    answer:
      "Deep, continuous sleep matters for metabolism; total hours are not the whole picture.",
    interpretation:
      "When researchers selectively reduced slow-wave sleep for several nights in healthy adults, insulin sensitivity and glucose regulation worsened despite relatively preserved total sleep time (Tasali et al., 2008). Repeated fragmentation may therefore matter metabolically, not only short duration.",
    notProven:
      "This short laboratory study does not show that a few disrupted nights cause diabetes or that consumer sleep-stage estimates can diagnose metabolic risk.",
    action:
      "Focus on the basics that support continuous sleep: a regular schedule, a comfortable dark room, and evaluation for persistent snoring, breathing pauses, or insomnia rather than trying to optimize a watch's deep-sleep number.",
    tags: [
      "deep sleep",
      "slow-wave sleep",
      "metabolism",
      "insulin",
      "sleep fragmentation",
    ],
  },
  {
    sourceTitle:
      "The association of sleep and pain: an update and a path forward",
    answer:
      "Poor sleep and pain can reinforce each other, so improving sleep can be a useful part of pain care.",
    interpretation:
      "Research reviewed by Finan and colleagues shows that disrupted or shortened sleep increases next-day pain sensitivity, while persistent pain commonly disrupts sleep in return. The relationship is two-way rather than a simple one-cause explanation.",
    notProven:
      "Sleep problems do not explain every pain condition and should never replace evaluation of new, severe, or persistent pain.",
    action:
      "If pain and poor sleep travel together, discuss both with a clinician. Keep a brief diary of pain, sleep, and activity to identify the pattern without assuming that either problem is 'all in your head.'",
    tags: [
      "pain",
      "chronic pain",
      "sleep disruption",
      "sleep deprivation",
      "recovery",
    ],
  },
  {
    sourceTitle:
      "Effects of evening exercise on sleep in healthy participants: a systematic review and meta-analysis",
    answer:
      "For most people, evening exercise is fine; only very hard sessions close to bed may be disruptive.",
    interpretation:
      "A systematic review found that evening exercise generally did not impair sleep in healthy participants, although very vigorous exercise ending close to bedtime may delay sleep for some people (Stutz et al., 2019).",
    notProven:
      "Individual responses differ, and the evidence is less certain for high-intensity sessions that finish immediately before bed or for people with specific sleep disorders.",
    action:
      "Use the exercise time you can sustain. If a late workout seems to leave you wired, finish earlier or reduce intensity rather than abandoning movement altogether.",
    tags: [
      "exercise",
      "evening exercise",
      "workout",
      "sleep timing",
      "movement",
    ],
  },
  {
    sourceTitle:
      "Mindfulness meditation for insomnia: a randomized controlled trial",
    answer:
      "Mindfulness can help reduce sleep-related struggle, but it is an adjunct, not a replacement for CBT-I.",
    interpretation:
      "In adults with chronic insomnia, a mindfulness-based program improved insomnia symptoms and sleep-related arousal compared with a sleep-hygiene comparison (Ong et al., 2014). It offers one way to respond differently to the racing thoughts that keep wakefulness going.",
    notProven:
      "Meditation is not a universal cure, and this trial does not displace CBT-I as the established first-line treatment for chronic insomnia.",
    action:
      "If your mind races at night, try a brief non-striving practice earlier in the evening or when awake: notice breathing or sounds without trying to force sleep. Seek CBT-I for insomnia lasting three months or more.",
    tags: [
      "mindfulness",
      "meditation",
      "anxiety",
      "racing thoughts",
      "insomnia",
    ],
  },
  {
    sourceTitle: "Sleep health: can we define it? Does it matter?",
    answer: "Sleep health is more than an hour target or a wearable score.",
    interpretation:
      "Buysse's sleep-health framework includes satisfaction, daytime alertness, timing, efficiency, and duration. It is a reminder to look at how sleep functions in your life rather than treating one score or sleep stage as a verdict.",
    notProven:
      "This is a conceptual framework, not a diagnosis or a treatment study, and it does not define one ideal number for every person.",
    action:
      "When checking in on sleep, ask five simple questions: Am I satisfied? Alert in the day? Sleeping at a workable time? Asleep for most of my time in bed? Getting enough duration for my function?",
    tags: [
      "sleep health",
      "sleep score",
      "sleep duration",
      "sleep efficiency",
      "daytime alertness",
    ],
  },
  {
    sourceTitle: "Sleep and human aging",
    answer:
      "Changes in sleep with age are common, but ongoing impairment is not something you have to dismiss as normal.",
    interpretation:
      "A review of sleep and aging describes lighter, more fragmented sleep and timing shifts in later life while cautioning against equating those changes with an inevitable lack of need for sleep (Mander et al., 2017).",
    notProven:
      "There is no universal sleep target for all older adults, and a review cannot identify the cause of one person's sleep complaint.",
    action:
      "Bring persistent daytime sleepiness, loud snoring, witnessed breathing pauses, repeated insomnia, or new dream-enactment behavior to a clinician rather than accepting it solely as an age-related change.",
    tags: [
      "aging",
      "older adults",
      "sleep fragmentation",
      "sleep apnea",
      "insomnia",
    ],
  },
];

/**
 * Idempotently seed the sleep pillar's gap-filling sources + interpretations.
 * Safe to run repeatedly (boot or by hand). Returns a small summary.
 */
export async function seedSleepContent(
  deps: SleepSeedDeps,
): Promise<SleepSeedResult> {
  const ctx: SeedContext = {
    embedTexts: deps.embedTexts,
    toVectorLiteral: deps.toVectorLiteral,
    embeddingModel: deps.embeddingModel,
    info: deps.log?.info ?? (() => {}),
    warn: deps.log?.warn ?? (() => {}),
  };

  const pillarRow = await pool.query<{ id: number }>(
    `SELECT id FROM pillars WHERE slug = $1 LIMIT 1`,
    [PILLAR_SLUG],
  );
  const pillarId = pillarRow.rows[0]?.id;
  if (!pillarId) {
    ctx.warn(`sleep seed: pillar "${PILLAR_SLUG}" not found; skipping`);
    return {
      seeded: false,
      reason: "pillar-missing",
      sources: 0,
      interpretations: 0,
    };
  }

  ctx.info(`Seeding sleep pillar (id=${pillarId})...`);
  const authorId = await ensureZeitzerSteward(ctx, pillarId);

  let sources = 0;
  for (const src of SOURCES) {
    await ensureSource(ctx, pillarId, authorId, src);
    sources++;
  }

  let interpretations = 0;
  for (const interp of INTERPRETATIONS) {
    const saved = await ensureInterpretation(ctx, pillarId, authorId, interp);
    if (saved) interpretations++;
  }

  return { seeded: true, sources, interpretations };
}
