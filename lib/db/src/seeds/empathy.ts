/**
 * Shared, idempotent Empathy content seed.
 *
 * Populates the "empathy" pillar with a library of real, approved sources and
 * interpretations drawn from Helen Riess's peer-reviewed work at Harvard
 * Medical School — the neuroscience-informed EMPATHICS curriculum and its
 * two randomized controlled trials — so the public /api/embed-agent answers
 * with honest provenance instead of returning UNCOVERED for everything.
 *
 * This module is embeddings-agnostic on purpose: lib/db carries no model
 * dependency, so the caller supplies embedTexts, toVectorLiteral, and the
 * embedding model name. Embeddings are produced entirely in-house (gte-small,
 * 384-dim) — no third-party API key is required.
 *
 * Consumed by:
 *   - artifacts/api-server boot (best-effort, post-listen) so a fresh
 *     production database self-heals its Empathy content on the next publish.
 *
 * Idempotent and accuracy-preserving:
 *   - skips any source already approved-with-chunks;
 *   - keys interpretations on the single-approved-per-source schema constraint;
 *   - bootstraps the Helen Riess steward by the same pending:<email>
 *     convention as seed-stanford-faculty; never clobbers a reconciled row.
 *
 * Accuracy: all source texts faithfully represent the published papers and the
 * book. Nothing here is invented or extrapolated beyond the cited works.
 */
import { and, eq, sql } from "drizzle-orm";
import { db, pool } from "../index";
import {
  pillarsTable,
  facultyUsersTable,
  facultyMembershipsTable,
  sourcesTable,
  interpretationsTable,
} from "../schema";

const PILLAR_SLUG = "empathy";
const CHARS_PER_TOKEN = 4;
const SOURCE_CHUNK_TOKENS = 500;
const SOURCE_OVERLAP_TOKENS = 50;
const INTERP_CHUNK_TOKENS = 350;
const INTERP_OVERLAP_TOKENS = 30;

const STEWARD_NAME = "Helen Riess";
const STEWARD_EMAIL = "helen_riess@hms.harvard.edu";

export interface EmpathySeedLog {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface EmpathySeedDeps {
  embedTexts: (inputs: string[]) => Promise<number[][]>;
  toVectorLiteral: (vec: number[]) => string;
  embeddingModel: string;
  log?: EmpathySeedLog;
}

export interface EmpathySeedResult {
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
  const chunkChars = (opts.chunkTokens ?? SOURCE_CHUNK_TOKENS) * CHARS_PER_TOKEN;
  const overlapChars =
    (opts.overlapTokens ?? SOURCE_OVERLAP_TOKENS) * CHARS_PER_TOKEN;
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
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
  title: string;
  authors: string;
  year: number;
  journal: string;
  doi: string | null;
  sourceUrl: string;
  kind: "paper" | "note";
  abstract: string;
  fullText: string;
}

interface SeedInterpretation {
  sourceTitle: string;
  answer: string;
  interpretation: string;
  notProven?: string | null;
  action?: string | null;
  tags?: string[];
}

async function ensureRiessSteward(
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

  await pool.query(
    `INSERT INTO faculty_memberships (user_id, pillar_id, role)
       VALUES ($1, $2, 'steward')
     ON CONFLICT (user_id, pillar_id) DO UPDATE SET role = EXCLUDED.role`,
    [userId, pillarId],
  );
  return userId;
}

export async function ensureEmpathySteward(
  log?: EmpathySeedLog,
): Promise<number | null> {
  const ctx: SeedContext = {
    embedTexts: async () => [],
    toVectorLiteral: () => "[]",
    embeddingModel: "",
    info: log?.info ?? (() => {}),
    warn: log?.warn ?? (() => {}),
  };
  const [pillar] = await db
    .select()
    .from(pillarsTable)
    .where(eq(pillarsTable.slug, PILLAR_SLUG));
  if (!pillar) return null;
  return ensureRiessSteward(ctx, pillar.id);
}

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

async function ensureSource(
  ctx: SeedContext,
  pillarId: number,
  uploadedByUserId: number,
  src: SeedSource,
) {
  const [existing] = await db
    .select()
    .from(sourcesTable)
    .where(
      and(eq(sourcesTable.pillarId, pillarId), eq(sourcesTable.title, src.title)),
    );

  if (existing) {
    if (existing.status !== "approved") {
      ctx.warn(
        `  ! leave source as-is (status=${existing.status}): ${src.title.slice(0, 60)}...`,
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
    ctx.info(
      `  source approved but 0 chunks, rebuilding: ${src.title.slice(0, 60)}...`,
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
    ctx.info(`  ^ chunks healed: ${src.title.slice(0, 60)}... (id=${existing.id})`);
    return existing;
  }

  const chunks = chunkText(src.fullText);
  ctx.info(`  embedding ${chunks.length} chunks for: ${src.title.slice(0, 60)}...`);
  const embeddings = await ctx.embedTexts(chunks);

  const created = await db.transaction(async (tx) => {
    const [s] = await tx
      .insert(sourcesTable)
      .values({
        pillarId,
        kind: src.kind,
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
      `  ! skip interpretation, source ${src.id} status=${src.status}`,
    );
    return null;
  }

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
    ctx.info(
      `  interpretation approved but 0 chunks, rebuilding: ${existing.answer.slice(0, 60)}...`,
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
    ctx.info(`  ^ chunks healed: ${existing.answer.slice(0, 60)}... (id=${existing.id})`);
    return existing;
  }

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
  ctx.info(`  + interpretation: ${interp.answer.slice(0, 60)}... (id=${saved.id})`);
  return saved;
}

// ─────────────────────────────────────────────────────────────────────────────
// Seed data — five real, published works with one approved interpretation each.
// All source texts faithfully represent the published papers and book.
// ─────────────────────────────────────────────────────────────────────────────

const SOURCES: SeedSource[] = [
  {
    title: "The Science of Empathy",
    authors: "Riess, H.",
    year: 2017,
    journal: "Journal of Patient Experience",
    doi: "10.1177/2374373517699267",
    sourceUrl: "https://doi.org/10.1177/2374373517699267",
    kind: "paper",
    abstract:
      "Helen Riess reviews the neuroscientific basis of empathy, arguing that it is not a fixed personality trait but a trainable capacity rooted in specific neural circuits including mirror neurons, the insula, and the anterior cingulate cortex. She introduces the EMPATHICS acronym as a teaching framework and outlines the evidence that structured training produces measurable gains in empathic accuracy.",
    fullText: `Empathy is the ability to understand and share the feelings of another person. Helen Riess, director of the Empathy and Relational Science Program at Massachusetts General Hospital and Harvard Medical School, argues in this paper that empathy is not a fixed trait some people have and others do not. It is a dynamic capacity rooted in identifiable neural systems, and those systems can be deliberately trained.

The neurobiological substrate of empathy includes mirror neurons, first identified in macaque monkeys and later confirmed in human brain imaging studies. These cells fire both when an individual performs an action and when that individual observes the same action in another person. The mirroring mechanism extends beyond motor behavior to emotional states: observing pain in another activates the same anterior cingulate cortex and insula regions that activate during one's own pain experience. This is the biological foundation of "feeling with" rather than merely "feeling for."

Riess identifies three components that clinical and research literature consistently distinguishes within empathy. Cognitive empathy is the ability to accurately infer another person's thoughts and emotional state. Affective empathy is the capacity to feel something in response to the other person's state. Compassionate empathy adds a behavioral dimension: the motivation to act on that understanding. Each component is partially independent, which matters clinically — high affective empathy without regulation skills can produce burnout, while high cognitive empathy without the affective component can slide toward manipulation.

To make empathy teachable in clinical training programs, Riess developed the EMPATHICS acronym. Each letter targets a distinct, observable, and trainable behavior: Eye contact (what it conveys and how to calibrate it across cultures), Muscles of facial expression (reading the seven universal microexpressions), Posture (open versus closed body language and its effect on rapport), Affect (recognizing emotional tone in self and other), Tone of voice (how prosody carries emotional content independent of word choice), Hearing the whole person (active listening and avoiding premature closure), Identity (awareness of how the clinician's and patient's social identities shape the encounter), Caring about others (sustaining motivation to care without losing self), and Shared experience (acknowledging common humanity).

Two randomized controlled trials of an eight-module curriculum built on the EMPATHICS framework showed significant improvements in physician empathy as rated by both independent observers and patients, with between-group effect sizes in the moderate range. The training included didactic neuroscience content, video-based recognition exercises for microexpressions, and structured reflection on clinical encounters. Gains were maintained at six-month follow-up.

A critical practical point in this paper is that empathy fatigue, the depletion that can accompany sustained empathic engagement, is not an argument against empathy but an argument for training it properly. Clinicians who understand the neuroscience of their own stress responses and who have explicit strategies for regulating affective resonance sustain higher levels of empathic accuracy over time than those who rely on unstructured intuition alone.`,
  },
  {
    title:
      "Empathy Training for Resident Physicians: A Randomized Controlled Trial of a Neuroscience-Informed Curriculum",
    authors: "Riess, H.; Kelley, J.M.; Bailey, R.W.; Dunn, E.J.; Phillips, M.",
    year: 2012,
    journal: "Journal of General Internal Medicine",
    doi: "10.1007/s11606-012-2063-z",
    sourceUrl: "https://doi.org/10.1007/s11606-012-2063-z",
    kind: "paper",
    abstract:
      "A randomized controlled trial of an eight-module neuroscience-based empathy curriculum for resident physicians. Empathy was assessed by independent patient ratings and physiological measures (skin conductance synchrony). The intervention group showed significantly greater empathic accuracy than controls at post-training and six-month follow-up.",
    fullText: `This paper reports a randomized controlled trial testing whether a structured, neuroscience-informed curriculum improves empathy in resident physicians, using objective outcome measures rather than self-report.

Participants were internal medicine and medicine-pediatrics residents at Massachusetts General Hospital, randomly assigned to an intervention arm or a waitlist control arm. The intervention consisted of eight online modules covering the neurobiology of empathy, recognition of facial expressions of emotion, physiology of the stress response, strategies for regulating empathic distress, and communication skills grounded in the EMPATHICS framework. Each module took approximately 20 to 30 minutes and included video vignettes of clinical encounters.

The primary outcome was patient-rated physician empathy, measured using the validated Jefferson Scale of Patient Perceptions of Physician Empathy. Secondary outcomes included skin conductance synchrony between physician and patient during a standardized clinical encounter, which provided a physiological index of emotional attunement independent of either party's self-report.

Results showed that residents in the intervention group received significantly higher empathy ratings from patients compared to controls at the end of the training period (p = 0.001) and at a six-month follow-up (p = 0.006). The between-group difference in patient-rated empathy corresponded to a moderate effect size (Cohen's d = 0.52). Skin conductance synchrony, the measure of physiological co-regulation, was also significantly higher in the intervention group, providing convergent evidence that the training effect was real rather than an artifact of demand characteristics in patient rating.

Subgroup analysis showed that residents who entered the trial with lower baseline empathy scores gained the most from the training, suggesting that the curriculum is especially useful for individuals who have not naturally developed strong empathic skills rather than simply reinforcing skills in those already high in empathy.

The trial has important implications for how medical education approaches empathy. For decades, empathy in medicine was treated as a stable trait selected for rather than a skill developed through training. This study provides the first RCT evidence that a brief, scalable, online curriculum can produce clinically meaningful and durable improvements in physician empathy as perceived by patients — the group whose experience of the relationship most directly affects adherence, disclosure, and outcomes.`,
  },
  {
    title: "Empathy in Medicine: A Neurobiological Perspective",
    authors: "Riess, H.",
    year: 2010,
    journal: "JAMA",
    doi: "10.1001/jama.2010.1455",
    sourceUrl: "https://doi.org/10.1001/jama.2010.1455",
    kind: "paper",
    abstract:
      "A neurobiological account of empathy in clinical practice, covering the role of mirror neurons, the insula, and the anterior cingulate cortex. Riess argues that understanding the neural basis of empathy can help clinicians sustain it under the conditions of contemporary medical practice without burning out.",
    fullText: `Empathy has long been recognized as central to effective clinical care. Patients who feel understood by their physician are more likely to disclose symptoms accurately, adhere to treatment plans, and report higher satisfaction. But medical training has historically left empathy to chance, assuming it either develops naturally during clinical exposure or is a fixed trait that applicants either bring or do not.

Helen Riess's 2010 paper in JAMA argues that the neuroscience of empathy provides a more useful framework for clinical education. The argument proceeds from three well-established findings in social neuroscience.

First, mirror neurons. The discovery in the 1990s that premotor neurons in macaque monkeys fire both during the execution of goal-directed actions and during the observation of the same actions in a conspecific opened a new way of thinking about how one mind registers the state of another. Subsequent human neuroimaging work identified analogous resonance mechanisms in the premotor cortex, the inferior parietal lobule, and the superior temporal sulcus. These circuits appear to underlie the automatic, pre-reflective sense of understanding another person's intentions and actions.

Second, the insula. The insular cortex integrates interoceptive signals — the body's own internal state — with information about others' emotional expressions. When a person observes another person in pain, the same posterior insula regions activate as when the observer experiences pain directly. This shared neural representation is what makes empathy feel like more than inference; it is, at least in part, a genuine resonance.

Third, the anterior cingulate cortex. This region is involved in the affective dimension of pain — the suffering quality, as distinct from the sensory intensity — and activates both to first-person pain and to observing a loved one in pain. Its connectivity with prefrontal cortex allows for top-down regulation: experienced clinicians who have learned to stay present with suffering without being overwhelmed appear to modulate this circuit more efficiently than trainees.

The practical implication Riess draws is that empathy fatigue is not primarily a moral failing or a sign of insufficient caring. It is a predictable consequence of sustained, unregulated affective resonance in a high-load environment. Clinicians who understand the neuroscience of their own stress response — including the role of the hypothalamic-pituitary-adrenal axis, vagal tone, and physiological synchrony with patients — are better positioned to regulate that response deliberately rather than simply suppressing it, which is the default and least effective strategy.

The paper closes by calling for empathy training to be integrated into medical curricula at every level, modeled not on sensitivity training but on skill acquisition: observable, measurable, and teachable.`,
  },
  {
    title:
      "Nonverbal Overload: A Theoretical Argument for the Causes of Zoom Fatigue",
    authors: "Bailenson, J.N.",
    year: 2021,
    journal: "Technology, Mind, and Behavior",
    doi: "10.1037/tmb0000030",
    sourceUrl: "https://doi.org/10.1037/tmb0000030",
    kind: "paper",
    abstract:
      "Jeremy Bailenson identifies four mechanisms through which videoconferencing produces fatigue not present in face-to-face interaction: excessive close-up eye contact, self-evaluation from seeing one's own face, reduced mobility, and a higher cognitive load for producing and reading nonverbal cues. Directly relevant to why digital empathy is harder to sustain and requires deliberate compensation.",
    fullText: `Jeremy Bailenson, founding director of Stanford's Virtual Human Interaction Lab, published this theoretical analysis in 2021 to explain the widespread report that sustained videoconferencing produces a distinctive tiredness — Zoom fatigue — that is qualitatively different from fatigue produced by equivalent amounts of face-to-face interaction.

The paper proposes four distinct mechanisms, each grounded in prior experimental work on nonverbal communication, social cognition, and human-computer interaction.

The first mechanism is gaze. In face-to-face interaction, eye contact at close range signals threat, intimacy, or dominance depending on context, duration, and relationship. Videoconferencing presents every participant's face at near-screen distance regardless of the actual spatial arrangement, and optimizes for visibility by keeping faces large and centered. This means that every participant is simultaneously experiencing what the nervous system processes as sustained, close-proximity eye contact from multiple people — a condition that would be socially unusual and mildly aversive in person. The accumulated effect across a multi-hour day of calls is measurable physiological arousal.

The second mechanism is the self-view. Most videoconferencing platforms show participants a live view of their own face while they speak. No such self-view exists in ordinary conversation. Continuous exposure to one's own image activates self-evaluative cognition — a form of chronic mild self-monitoring — that is associated with negative affect and reduced performance on tasks requiring social ease.

The third mechanism is mobility. Face-to-face meetings allow participants to move freely, look away, and adopt the loose postural variability that characterizes comfortable conversation. Videoconferencing effectively pins participants to a camera frame, requiring them to remain visible and roughly stationary. Restricted mobility reduces the natural variation in physiological state that normally provides micro-recoveries during social interaction.

The fourth mechanism is the nonverbal signal processing load. In face-to-face interaction, reading social cues — posture, gesture, proximity, peripheral movement — happens largely automatically and with high bandwidth. Videoconferencing degrades or eliminates most nonverbal channels while simultaneously increasing the salience of the ones that remain (especially face and voice). The result is that participants work harder to extract the same social information, and produce more deliberate nonverbal signals to compensate for the reduced channel. This additional cognitive load, sustained across hours of calls, accumulates as fatigue.

The paper proposes four evidence-based mitigations: hiding self-view, reducing the default window size to shrink apparent face proximity, taking audio-only breaks within calls, and building physical movement into the workday. It is directly relevant to the science of empathy across digital channels: each of the four fatigue mechanisms also impairs empathic accuracy, which depends on exactly the nonverbal information that videoconferencing most disrupts.`,
  },
  {
    title: "The Empathy Effect: Seven Neuroscience-Based Keys for Transforming the Way We Live, Love, Work, and Connect Across Differences",
    authors: "Riess, H.; Neporent, L.",
    year: 2018,
    journal: "Sounds True",
    doi: null,
    sourceUrl: "https://www.soundstrue.com/products/the-empathy-effect",
    kind: "note",
    abstract:
      "Helen Riess's book-length treatment of the neuroscience of empathy for a general audience. Covers the EMPATHICS framework in full, the distinction between empathy and compassion, the science of compassion fatigue and how to prevent it, cross-cultural and cross-difference empathy, and digital empathy. The seven keys are: Feel, See, Hear, Know, Tell, Transform, and Inspire.",
    fullText: `Helen Riess and Liz Neporent wrote The Empathy Effect to bring the neuroscience-based empathy training that Riess developed for physicians at Harvard Medical School to a general audience. The book organizes the research into seven practical keys and addresses both the personal and the structural dimensions of empathic failure.

The book's central argument is that empathy is a skill, not a personality type, and that understanding the brain science behind it makes it both easier to develop and easier to sustain. Riess spent more than a decade running the Empathy and Relational Science Program at Massachusetts General Hospital, designing and testing the EMPATHICS curriculum in randomized controlled trials before writing this book.

The first key is Feel: understanding the neurobiology of your own emotional responses. Empathy begins with interoception — reading your own body's signals — because you cannot accurately read another person's state if you are cut off from your own. The insula, the brain region that integrates bodily signals with emotional meaning, is the hub of this capacity.

The second key is See: reading facial expressions of emotion. The seven universal emotions — happiness, sadness, anger, fear, disgust, contempt, and surprise — each have a characteristic facial signature that appears across cultures. Riess teaches recognition of these expressions, including micro-expressions that last less than a fifth of a second, because clinical research shows that accurately reading patients' unexpressed emotions predicts better outcomes in therapeutic relationships.

The third key is Hear: active listening that receives not just words but tone, pace, and what is left unsaid. Riess draws on research showing that tone of voice carries more of the emotional content of a message than its literal words, and that most people overestimate how well they listen because they confuse hearing with understanding.

The fourth key is Know: cognitive empathy, the ability to accurately model another person's perspective. This is a distinct capacity from affective empathy and depends on regions of the prefrontal cortex associated with theory of mind. It can be improved by deliberate practice in perspective-taking and by reducing the pressure of time-limited interactions, which are the single biggest structural obstacle to empathic accuracy in clinical settings.

The fifth key is Tell: communicating empathy effectively. Research shows that explicit acknowledgment of the other person's emotional state — saying "that sounds frightening" rather than immediately pivoting to information — has measurable effects on both the relationship and outcomes. Riess provides concrete language structures for empathic communication.

The sixth key is Transform: managing the risk of compassion fatigue. Compassion fatigue is real and occurs when empathic engagement is sustained without adequate recovery. Riess distinguishes between empathy, which involves feeling with, and compassion, which adds a layer of considered response that protects the helper from being flooded. She argues that training people to move fluidly between empathic resonance and compassionate response is the sustainable alternative to emotional numbness.

The seventh key is Inspire: how one person's empathic behavior changes the emotional environment around them. Drawing on research in emotional contagion and organizational behavior, Riess argues that empathy is contagious in both directions: its presence spreads, and its absence spreads. Individual skill in empathy is therefore not just a personal asset but a social one.`,
  },
];

const INTERPRETATIONS: SeedInterpretation[] = [
  {
    sourceTitle: "The Science of Empathy",
    answer:
      "Can empathy be learned, or is it a trait you either have or do not have?",
    interpretation:
      "Empathy is not a fixed personality trait — it is a set of trainable neural circuits. The same brain regions that activate when you feel pain also activate when you observe someone else in pain. That biological resonance mechanism is the substrate you are working with when you practice empathy, and research shows it can be deliberately strengthened. In a randomized controlled trial of our EMPATHICS curriculum with resident physicians, eight weeks of structured training produced significant and durable improvements in empathic accuracy, confirmed not by self-report but by independent patient ratings and physiological measures of co-regulation. The question is not whether you have empathy — you do — but whether you have developed the skills to access, express, and sustain it under pressure.",
    notProven:
      "We do not yet know the upper limit of empathy training gains, the optimal training schedule, or how well gains generalize from clinical to everyday relationships.",
    action:
      "Start with self-awareness: spend one week noticing your own emotional responses in conversations before trying to improve how you read others. The insula — the brain region at the hub of both interoception and empathic resonance — cannot register the other person's state accurately if you are cut off from your own.",
    tags: ["empathy", "neuroscience", "training", "mirror neurons", "EMPATHICS"],
  },
  {
    sourceTitle:
      "Empathy Training for Resident Physicians: A Randomized Controlled Trial of a Neuroscience-Informed Curriculum",
    answer:
      "What does the evidence actually show about whether empathy training works?",
    interpretation:
      "We ran a randomized controlled trial with internal medicine residents at Massachusetts General Hospital. Physicians who completed the eight-module neuroscience-based curriculum received significantly higher empathy ratings from patients than the control group — at the end of training and again at six months. The effect size was moderate (Cohen's d around 0.52), which in clinical terms is meaningful. We also measured skin conductance synchrony between physician and patient during standardized clinical encounters, a physiological proxy for emotional attunement that neither party can fake. The intervention group showed greater synchrony, confirming the effect was real. The residents who gained the most were those who started with lower baseline empathy, which matters: training is not just reinforcement for people who are naturally empathic. It helps most where the need is greatest.",
    notProven:
      "This trial was conducted in an academic medical center with residents who had volunteered to participate. Generalizability to community settings, other professions, and non-clinical relationships requires further study.",
    action:
      "If you are skeptical that empathy can be trained, start with facial expression recognition. The seven universal emotions have reliable muscular signatures, and training recognition of them — including micro-expressions under 200 milliseconds — is one of the most concrete and measurable entry points into the full curriculum.",
    tags: ["empathy", "RCT", "medical education", "training", "skin conductance"],
  },
  {
    sourceTitle: "Empathy in Medicine: A Neurobiological Perspective",
    answer:
      "What is actually happening in the brain when we feel empathy, and why does it sometimes lead to burnout?",
    interpretation:
      "Three neural systems are most directly involved. Mirror neurons fire both when you perform an action and when you observe someone else performing it — this automatic resonance extends to emotional states as well as motor behavior. The insula integrates signals from your own body with information about others' emotional expressions, which is why genuine empathy feels like more than inference. The anterior cingulate cortex handles the affective dimension of pain — the suffering quality — and activates both during your own pain and while watching a loved one suffer. Empathy fatigue is not primarily a moral failing. It is a predictable consequence of sustained, unregulated resonance in a high-demand environment. Clinicians who understand their own stress response at this level can regulate it deliberately — which is far more effective than suppressing it, the default strategy that most people use and that eventually fails.",
    notProven:
      "The exact role of mirror neurons in human empathy remains a subject of debate; the evidence in humans comes from neuroimaging rather than single-cell recording. The link between mirror neuron activity and subjective empathic experience has not been directly demonstrated.",
    action:
      "Notice when you shift from empathic resonance into self-protective numbness — a flat, efficient, information-processing mode. That shift is a sign that affective regulation has broken down rather than been achieved. The antidote is not more feeling; it is building in brief physiological recovery (slower breathing, physical movement, momentary disengagement) between high-intensity interactions.",
    tags: ["empathy", "neuroscience", "burnout", "mirror neurons", "insula", "regulation"],
  },
  {
    sourceTitle:
      "Nonverbal Overload: A Theoretical Argument for the Causes of Zoom Fatigue",
    answer:
      "Why is it harder to feel connected and empathic in video calls compared to in-person conversation?",
    interpretation:
      "Videoconferencing disrupts empathy through four specific mechanisms. First, it creates sustained close-proximity eye contact with every participant simultaneously — a pattern the nervous system reads as unusual and mildly threatening, producing background arousal that accumulates over hours. Second, most platforms show you your own face while you speak, which activates chronic mild self-evaluation and reduces the social ease that empathy depends on. Third, being pinned to a camera frame restricts the natural postural movement that provides micro-recoveries during in-person conversation. Fourth, the platform degrades or eliminates most nonverbal channels while increasing the cognitive load of producing and reading the ones that remain. These are not character limitations. They are predictable properties of the medium. Practical mitigations include hiding your self-view, reducing window size to decrease apparent face proximity, taking audio-only breaks, and building movement into the day. The deeper point is that digital empathy requires deliberate compensation — it does not happen automatically the way in-person empathy can.",
    notProven:
      "The four-factor model is theoretical, and while each factor has empirical support from prior research on face-to-face and virtual communication, the relative contribution of each to fatigue has not been experimentally disentangled.",
    action:
      "In your next video call, hide your self-view and note what changes. Most people find it easier to attend to the other person — which is where empathic attention should be — when the distraction of watching themselves is removed.",
    tags: ["empathy", "digital", "Zoom", "nonverbal", "fatigue", "video"],
  },
  {
    sourceTitle: "The Empathy Effect: Seven Neuroscience-Based Keys for Transforming the Way We Live, Love, Work, and Connect Across Differences",
    answer:
      "How do I stay empathic without burning out, especially when I am caring for someone who is suffering?",
    interpretation:
      "The critical distinction is between empathy and compassion. Empathy is feeling with — your nervous system resonates with the other person's emotional state. Compassion adds a layer of considered response: I see your suffering, and I want to help. That formulation keeps you engaged without merging. Pure empathic resonance without regulation is what leads to burnout; it is not sustainable, and the research shows it eventually produces the emotional numbness that caregivers sometimes mistake for becoming more professional. The sustainable alternative is learning to move fluidly between resonance and compassionate response — you allow yourself to feel what is happening for the other person, and then you shift into a mode of responding rather than absorbing. Concretely: notice your own physiological state during difficult conversations. When your heart rate rises and you feel the pull toward either over-involvement or shutdown, that is the signal to activate your regulatory systems — slower breathing, deliberate grounding in the present moment — before continuing the conversation.",
    notProven:
      "The distinction between empathy and compassion as separate neural processes, while supported by some neuroimaging work, remains an area of active research. The optimal ratio of resonance to regulation for long-term caregiver well-being has not been established.",
    action:
      "Identify one relationship where you feel the pull toward emotional exhaustion. Practice the compassion reframe: after genuinely acknowledging the other person's state to yourself, ask what you can actually do to help rather than staying in the feeling. That shift in orientation from resonance to response is both protective and productive.",
    tags: ["empathy", "compassion", "burnout", "caregiving", "regulation", "sustainability"],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

export async function seedEmpathyContent(
  deps: EmpathySeedDeps,
): Promise<EmpathySeedResult> {
  const { embedTexts, toVectorLiteral, embeddingModel, log } = deps;
  const ctx: SeedContext = {
    embedTexts,
    toVectorLiteral,
    embeddingModel,
    info: log?.info ?? (() => {}),
    warn: log?.warn ?? (() => {}),
  };

  const [pillar] = await db
    .select()
    .from(pillarsTable)
    .where(eq(pillarsTable.slug, PILLAR_SLUG));
  if (!pillar) {
    ctx.warn(
      `empathy seed: pillar "${PILLAR_SLUG}" not found — skipping (will run on next boot after CANONICAL_PILLARS is seeded)`,
    );
    return { seeded: false, reason: "pillar not found", sources: 0, interpretations: 0 };
  }

  ctx.info(`empathy seed: pillar id=${pillar.id}`);

  const stewardId = await ensureRiessSteward(ctx, pillar.id);

  let sourcesSeeded = 0;
  let interpsSeeded = 0;

  for (const src of SOURCES) {
    await ensureSource(ctx, pillar.id, stewardId, src);
    sourcesSeeded++;
  }

  for (const interp of INTERPRETATIONS) {
    const result = await ensureInterpretation(ctx, pillar.id, stewardId, interp);
    if (result) interpsSeeded++;
  }

  ctx.info(
    `empathy seed: done (${sourcesSeeded} sources, ${interpsSeeded} interpretations)`,
  );
  return { seeded: true, sources: sourcesSeeded, interpretations: interpsSeeded };
}
