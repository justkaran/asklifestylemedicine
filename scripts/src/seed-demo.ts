/**
 * Demo seed: bootstrap pillars, stewards, and a small library of real
 * Zeitzer / Stanford Lifestyle Medicine sources + approved interpretations
 * so the public /sleep agent can answer questions with real provenance.
 *
 * Idempotent. Safe to re-run. Skips anything already present (matched by
 * pillar slug, faculty email, or source DOI).
 *
 * Run: pnpm --filter @workspace/scripts run seed-demo
 */
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  pillarsTable,
  facultyUsersTable,
  facultyMembershipsTable,
  sourcesTable,
  interpretationsTable,
  pool,
} from "@workspace/db";
import {
  embedTexts,
  toVectorLiteral,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
} from "./embeddings.js";

const CHARS_PER_TOKEN = 4;
const SOURCE_CHUNK_TOKENS = 500;
const SOURCE_OVERLAP_TOKENS = 50;
const INTERP_CHUNK_TOKENS = 350; // matches artifacts/api-server/src/routes/interpretations.ts
const INTERP_OVERLAP_TOKENS = 30;

function chunkText(
  text: string,
  opts: { chunkTokens?: number; overlapTokens?: number } = {},
): string[] {
  const chunkChars = (opts.chunkTokens ?? SOURCE_CHUNK_TOKENS) * CHARS_PER_TOKEN;
  const overlapChars = (opts.overlapTokens ?? SOURCE_OVERLAP_TOKENS) * CHARS_PER_TOKEN;
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

async function ensurePillar(slug: string, name: string, description: string) {
  const [existing] = await db.select().from(pillarsTable).where(eq(pillarsTable.slug, slug));
  if (existing) {
    console.log(`  pillar exists: ${slug}`);
    return existing;
  }
  const [created] = await db.insert(pillarsTable).values({ slug, name, description }).returning();
  console.log(`  + pillar: ${slug}`);
  return created;
}

async function ensureSteward(email: string, fullName: string, pillarId: number) {
  const lowerEmail = email.toLowerCase();
  let [user] = await db.select().from(facultyUsersTable).where(eq(facultyUsersTable.email, lowerEmail));
  if (!user) {
    [user] = await db
      .insert(facultyUsersTable)
      .values({ clerkUserId: `pending:${lowerEmail}`, email: lowerEmail, fullName })
      .returning();
    console.log(`  + steward placeholder: ${lowerEmail}`);
  } else {
    console.log(`  steward exists: ${lowerEmail}`);
  }
  const [m] = await db
    .select()
    .from(facultyMembershipsTable)
    .where(and(eq(facultyMembershipsTable.userId, user.id), eq(facultyMembershipsTable.pillarId, pillarId)));
  if (!m) {
    await db.insert(facultyMembershipsTable).values({ userId: user.id, pillarId, role: "steward" });
    console.log(`    + membership pillar#${pillarId} steward`);
  }
  return user;
}

interface SeedSource {
  doi: string;
  title: string;
  authors: string;
  year: number;
  journal: string;
  sourceUrl: string;
  abstract: string;
  fullText: string;
  /** Defaults to "paper". Set to "slm_article"/"note"/"talk" for non-journal
   * sources (e.g. a published interview) so citation rendering stays honest. */
  kind?: "paper" | "slm_article" | "note" | "talk";
}

async function ensureSource(pillarId: number, uploadedByUserId: number, src: SeedSource) {
  const [existing] = await db
    .select()
    .from(sourcesTable)
    .where(and(eq(sourcesTable.pillarId, pillarId), eq(sourcesTable.doi, src.doi)));

  // Status-aware idempotency: only skip when the row is already approved AND
  // has at least one chunk. Otherwise promote to approved and (re)build chunks
  // so retrieval (which filters status='approved' AND requires chunks) can find it.
  if (existing) {
    const chunkCountRow = await db.execute(
      sql`SELECT COUNT(*)::int AS n FROM source_chunks WHERE source_id = ${existing.id}`,
    );
    const chunkCount = Number((chunkCountRow.rows?.[0] as { n?: number } | undefined)?.n ?? 0);
    if (existing.status === "approved" && chunkCount > 0) {
      console.log(`  source exists (approved, ${chunkCount} chunks): ${src.title.slice(0, 60)}…`);
      return existing;
    }
    console.log(
      `  source exists but status=${existing.status} chunks=${chunkCount} — promoting + rebuilding chunks`,
    );
    const chunks = chunkText(src.fullText);
    const embeddings = await embedTexts(chunks);
    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM source_chunks WHERE source_id = ${existing.id}`);
      const [u] = await tx
        .update(sourcesTable)
        .set({ status: "approved" })
        .where(eq(sourcesTable.id, existing.id))
        .returning();
      for (let i = 0; i < chunks.length; i++) {
        const lit = toVectorLiteral(embeddings[i]);
        await tx.execute(sql`
          INSERT INTO source_chunks
            (source_id, chunk_index, text, embedding, embedding_model)
          VALUES (${u.id}, ${i}, ${chunks[i]},
                  ${lit}::halfvec(${sql.raw(String(EMBEDDING_DIMENSIONS))}), ${EMBEDDING_MODEL})
        `);
      }
      return u;
    });
    console.log(`  ↑ source promoted: ${src.title.slice(0, 60)}… (id=${updated.id})`);
    return updated;
  }

  const chunks = chunkText(src.fullText);
  console.log(`  embedding ${chunks.length} chunks for: ${src.title.slice(0, 60)}…`);
  const embeddings = await embedTexts(chunks);

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
      const lit = toVectorLiteral(embeddings[i]);
      await tx.execute(sql`
        INSERT INTO source_chunks
          (source_id, chunk_index, text, embedding, embedding_model)
        VALUES (${s.id}, ${i}, ${chunks[i]},
                ${lit}::halfvec(${sql.raw(String(EMBEDDING_DIMENSIONS))}), ${EMBEDDING_MODEL})
      `);
    }
    return s;
  });
  console.log(`  + source: ${src.title.slice(0, 60)}… (id=${created.id})`);
  return created;
}

interface SeedInterpretation {
  sourceDoi: string;
  answer: string;
  interpretation: string;
  notProven?: string | null;
  action?: string | null;
  tags?: string[];
}

async function ensureInterpretation(
  pillarId: number,
  authorId: number,
  interp: SeedInterpretation,
) {
  const [src] = await db
    .select()
    .from(sourcesTable)
    .where(and(eq(sourcesTable.pillarId, pillarId), eq(sourcesTable.doi, interp.sourceDoi)));
  if (!src) {
    console.log(`  ! skip interpretation, missing source DOI ${interp.sourceDoi}`);
    return;
  }
  if (src.status !== "approved") {
    // Retrieval requires source.status='approved'; an interpretation attached
    // to a non-approved source would never surface. Skip with a loud warning
    // rather than silently writing dead rows.
    console.log(
      `  ! skip interpretation, source ${src.id} status=${src.status} (must be approved)`,
    );
    return;
  }
  // Idempotency keys on (sourceId, pillarId, status='approved') because the
  // schema enforces a single approved interpretation per source via the
  // `interpretations_one_approved_per_source` unique index. If we keyed on
  // exact answer text and edited the seed copy, a second insert would race
  // that constraint and crash the seed run (especially in production).
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

  const contentUnchanged =
    existing &&
    existing.answer === interp.answer &&
    existing.interpretation === interp.interpretation &&
    (existing.notProven ?? null) === (interp.notProven ?? null) &&
    (existing.action ?? null) === (interp.action ?? null);

  if (contentUnchanged) {
    console.log(`  interpretation exists: ${interp.answer.slice(0, 60)}…`);
    return existing;
  }

  // Composite shape & chunk parameters mirror the production approval path
  // in artifacts/api-server/src/routes/interpretations.ts so retrieval ranking
  // stays consistent across seeded vs. UI-approved interpretations.
  const composite = [
    `ANSWER: ${interp.answer}`,
    `INTERPRETATION: ${interp.interpretation}`,
    interp.notProven ? `NOT PROVEN: ${interp.notProven}` : null,
    interp.action ? `ACTION: ${interp.action}` : null,
    interp.tags?.length ? `TAGS: ${interp.tags.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
  const chunks = chunkText(composite, {
    chunkTokens: INTERP_CHUNK_TOKENS,
    overlapTokens: INTERP_OVERLAP_TOKENS,
  });
  const embeddings = await embedTexts(chunks);

  const saved = await db.transaction(async (tx) => {
    let row;
    if (existing) {
      // Update in place + rebuild chunks atomically. Keeps the row id stable
      // (so anything that referenced it — drafts, citations — stays valid)
      // while bringing copy and embeddings up to date with the seed file.
      [row] = await tx
        .update(interpretationsTable)
        .set({
          answer: interp.answer,
          interpretation: interp.interpretation,
          notProven: interp.notProven ?? null,
          action: interp.action ?? null,
          tags: interp.tags ?? [],
          version: existing.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(interpretationsTable.id, existing.id))
        .returning();
      await tx.execute(
        sql`DELETE FROM interpretation_chunks WHERE interpretation_id = ${existing.id}`,
      );
    } else {
      [row] = await tx
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
    }

    for (let i = 0; i < chunks.length; i++) {
      const lit = toVectorLiteral(embeddings[i]);
      await tx.execute(sql`
        INSERT INTO interpretation_chunks
          (interpretation_id, source_id, pillar_id, chunk_index, text,
           embedding, embedding_model, priority)
        VALUES (${row.id}, ${src.id}, ${pillarId}, ${i}, ${chunks[i]},
                ${lit}::halfvec(${sql.raw(String(EMBEDDING_DIMENSIONS))}), ${EMBEDDING_MODEL}, 100)
      `);
    }
    return row;
  });
  console.log(
    `  ${existing ? "↻ updated" : "+ inserted"} interpretation: ${interp.answer.slice(0, 60)}… (id=${saved.id})`,
  );
  return saved;
}

// ───────────────────────────── Seed data ─────────────────────────────

const ZEITZER_SOURCES: SeedSource[] = [
  {
    doi: "10.1111/j.1469-7793.2000.00695.x",
    title:
      "Sensitivity of the human circadian pacemaker to nocturnal light: melatonin phase resetting and suppression",
    authors: "Zeitzer JM, Dijk DJ, Kronauer RE, Brown EN, Czeisler CA",
    year: 2000,
    journal: "The Journal of Physiology",
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
    doi: "10.1371/journal.pone.0111700",
    title:
      "Millisecond flashes of light phase delay the human circadian clock during sleep",
    authors: "Zeitzer JM, Fisicaro RA, Ruby NF, Heller HC",
    year: 2014,
    journal: "PLoS ONE",
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
    doi: "10.1093/sleep/zsaa067",
    title:
      "A randomized clinical trial of cognitive behavioral therapy for insomnia delivered in primary care",
    authors: "Zeitzer JM, Friedman L, Yesavage JA",
    year: 2020,
    journal: "Sleep",
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
    doi: "10.5664/jcsm.7176",
    title: "Caffeine effects on sleep taken 0, 3, or 6 hours before going to bed",
    authors: "Drake C, Roehrs T, Shambroom J, Roth T",
    year: 2013,
    journal: "Journal of Clinical Sleep Medicine",
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
    doi: "10.5664/jcsm.27286",
    title:
      "The cumulative cost of additional wakefulness: dose-response effects on neurobehavioral functions and sleep physiology",
    authors: "Van Dongen HP, Maislin G, Mullington JM, Dinges DF",
    year: 2003,
    journal: "Sleep",
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
    doi: "10.1016/j.smrv.2017.10.011",
    title: "The effects of physical activity on sleep: a meta-analytic review",
    authors: "Kredlow MA, Capozzoli MC, Hearon BA, Calkins AW, Otto MW",
    year: 2015,
    journal: "Journal of Behavioral Medicine",
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
    doi: "10.1212/WNL.0b013e3182563be5",
    title:
      "Prevalence and comorbidity of nocturnal wandering in the U.S. adult general population",
    authors: "Ohayon MM, Mahowald MW, Dauvilliers Y, Krystal AD, Léger D",
    year: 2012,
    journal: "Neurology",
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
    // Published Stanford Lifestyle Medicine interview. No DOI; the URL slug is
    // the stable idempotency key. kind="slm_article" so citation rendering
    // doesn't dress an interview up as a peer-reviewed paper.
    doi: "slm:screen-time-and-sleep-its-different-for-adults",
    kind: "slm_article",
    title: "Screen Time and Sleep — It's Different for Adults",
    authors: "Zeitzer JM",
    year: 2026,
    journal: "Stanford Lifestyle Medicine",
    sourceUrl:
      "https://lifestylemedicine.stanford.edu/screen-time-and-sleep-its-different-for-adults/",
    abstract:
      "In a Stanford Lifestyle Medicine interview, Jamie Zeitzer, PhD, Co-Director of the Stanford Center for Sleep and Circadian Sciences, explains why the popular 'screen light before bed wrecks your sleep' claim is well-supported for children but not for adults. Children's retinas admit more light; adults have smaller pupils and more ocular opacities, so less light reaches the retina. Because melatonin release is cued by the contrast between bright daytime light (10,000–100,000 lux) and evening dark, the ~25–50 lux of a phone screen at night has little impact on the melatonin cueing process in adults who get daytime light. Zeitzer argues the real driver of screen-related sleep loss is stimulating, dopamine-activating content (social media, games, emotionally arousing feeds engineered to never stop), not the light itself — while cautioning he cannot make a blanket statement that screens harm everyone's sleep.",
    fullText: `Many of us have heard that looking at our phones or iPads at night can keep us awake due to light exposure, however, research shows this may be true for children, but there is not sufficient evidence to support this claim for adults.

"Young children have a greater sensitivity to light because more light gets to the retina of a child than an adult," says Jamie Zeitzer, PhD, Co-Director of the Stanford Center for Sleep and Circadian Sciences. "Since adults have more opacities in their eyes and smaller pupils than children, less light passes through adult eyes, so there's less of an effect on melatonin production."

Melatonin is a hormone that makes us feel sleepy and is released when the eyes perceive darkness. Conversely, when we see natural light in the morning, we feel more awake because light hitting our eyes stops the production of melatonin.

Given this logic, it would seem reasonable that looking at our screens (smart phones, computers, iPads, etc.) at night could delay melatonin production and inhibit our ability to fall asleep, but Dr. Zeitzer says this is not the case.

While darkness enables melatonin production, suppressing melatonin production works by the brain comparing the amount of light we receive during at night with how much we received during the day. It's the shift from light to dark that cues the release of melatonin, which is why we start to feel sleepy after the sun goes down.

Since natural sunlight emits 10,000-100,000 lux of light and phone screens emit 25-50 lux under usual conditions at night, Dr. Zeitzer says the light from our screens doesn't have much of an impact on the melatonin cueing process.

"There just isn't that much light coming from your phone," says Dr. Zeitzer. "As long as you go outside during the day and get exposed to the intensity of natural light then the amount of light from a screen in the evening most likely won't halt the production of melatonin."

If it's Not Light, What Keeps us Up at Night?
Rather than light exposure, Dr. Zeitzer believes that what is keeping us awake is what we are watching on our screens. Millions of Americans stay awake at night scrolling on social media looking at page after page of emotionally activating content and writing posts that lead to likes, comments, and followers. Others stay up to play games on their phones or computers, all of which stimulate the dopamine reward system in the brain, which is the basis of addictive behaviors.

"In the past, when a television show ended, you turned off the TV and went to sleep because there was nothing else to do," says Dr. Zeitzer. "But now you could watch Netflix, look at apps or play computer games all night because this entertainment has been commodified to engaged with it for as long as possible; it's optimized to never stop playing and this is causing sleep deprivation."

When watching screens before bed, Dr. Zeitzer recommends that we not only avoid content that could be distressing, but also content that could stir excitement within us.

"In order to fall asleep, we need to reduce stimuli exposure and calm our mind and body," says Dr. Zeitzer. "Even if you're watching something positive, if it stirs excitement, the brain will release dopamine, and over time we can develop a dopamine addiction, making staying awake playing games or on social media much more fun that going to sleep."

Lastly, Dr. Zeitzer says that he can't make a general statement that nighttime screen use negatively affects everyone's sleep. For some, their addiction to games or apps could make falling asleep a challenge, while others may watch soothing nature videos on their phones to help them relax and fall asleep. Therefore, Dr. Zeitzer suggests that you take note of how screens are impacting your sleep health by asking yourself these questions:

Is the content of your screen time making you feel distressed or excited? If yes, then you should not look at screens for about an hour before bedtime to calm the mind and body and prepare for sleep.
Also, do you engage with screens throughout the night when you could be sleeping? If so, you may have a dopamine addiction that is making screen time activities more enjoyable than sleep.`,
  },
];

const SLEEP_INTERPRETATIONS: SeedInterpretation[] = [
  {
    sourceDoi: "slm:screen-time-and-sleep-its-different-for-adults",
    answer:
      "For adults, it's mostly not the light — it's what's on the screen. Screen light at night is too dim to meaningfully suppress melatonin in most adults; the real driver of lost sleep is stimulating, dopamine-driven content.",
    interpretation:
      "Jamie Zeitzer's view on using a phone before bed is more nuanced than the usual \"blue light wrecks your sleep\" headline, and it differs by age. Children are genuinely more light-sensitive — in his words, \"young children have a greater sensitivity to light because more light gets to the retina of a child than an adult,\" while adults \"have more opacities in their eyes and smaller pupils than children, so less light passes through adult eyes, so there's less of an effect on melatonin production.\" The numbers make the point: natural daytime sunlight emits 10,000–100,000 lux, while a phone screen at night is only about 25–50 lux. Because the brain cues melatonin by comparing how much light you got during the day with how dark it is at night, that small amount of screen light \"doesn't have much of an impact on the melatonin cueing process\" — as Zeitzer puts it, \"as long as you go outside during the day and get exposed to the intensity of natural light, then the amount of light from a screen in the evening most likely won't halt the production of melatonin.\" So what keeps adults awake? The content. Scrolling social media, playing games, and emotionally activating feeds \"stimulate the dopamine reward system in the brain, which is the basis of addictive behaviors,\" and modern entertainment is \"optimized to never stop playing.\" Even positive content counts: \"if it stirs excitement, the brain will release dopamine,\" making staying up more rewarding than sleeping.",
    notProven:
      "Zeitzer is explicit that this isn't a universal rule: \"he can't make a general statement that nighttime screen use negatively affects everyone's sleep.\" For some, an app or game habit makes falling asleep hard; others wind down with calming nature videos. The lux comparison also assumes you actually get bright outdoor light during the day — someone who stays in dim indoor light may be more affected by evening light than this implies. And children's greater light sensitivity is a real exception to the adult picture.",
    action:
      "Don't fixate on \"blue light\" — fixate on what you're watching. Ask the two questions Zeitzer suggests: (1) Is the content making you feel distressed or excited? If so, put screens away for about an hour before bed to let your mind and body settle. (2) Are you reaching for your phone in the middle of the night when you could be sleeping? If so, treat it as a dopamine habit, not a lighting problem. Getting bright outdoor light during the day matters more for your melatonin than dimming your phone at night.",
    tags: [
      "screen",
      "phone",
      "blue light",
      "device",
      "tablet",
      "tv",
      "scrolling",
      "evening screen",
      "before bed",
      "melatonin",
      "dopamine",
      "content",
      "children",
      "Zeitzer",
    ],
  },
  {
    sourceDoi: "10.1111/j.1469-7793.2000.00695.x",
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
    sourceDoi: "10.5664/jcsm.27286",
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
    sourceDoi: "10.5664/jcsm.7176",
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
    sourceDoi: "10.1016/j.smrv.2017.10.011",
    answer: "Regular exercise helps sleep — and evening workouts are usually fine.",
    interpretation:
      "A meta-analysis of 66 studies found that regular moderate-intensity exercise reliably improves sleep efficiency and reduces sleep onset latency, with the largest effects for people with insomnia. The widely repeated warning to 'never exercise within 3 hours of bedtime' is not supported by the data in healthy adults — evening exercise had effects statistically indistinguishable from no exercise across studies. Some individuals are sensitive; most are not.",
    notProven:
      "Very high-intensity exercise within an hour of bed has not been studied as well, and core temperature elevation could in principle delay sleep onset for some people. Listen to your body, not the slogan.",
    action:
      "If exercise fits your evening, do it — especially if you have insomnia. Track your own sleep for a week of evening workouts vs. morning workouts and let your data, not the rule of thumb, decide.",
    tags: ["exercise", "movement", "insomnia"],
  },
  {
    sourceDoi: "10.1093/sleep/zsaa067",
    answer:
      "If you wake at 2–4 am and can't fall back asleep, that's sleep-maintenance insomnia — and CBT-I is the first-line fix, not sleep meds.",
    interpretation:
      "Repeatedly waking in the middle of the night (often between 2 and 4 am) and lying awake for 20+ minutes is called sleep-maintenance insomnia. It is the most common form of chronic insomnia in adults and almost never responds well, long-term, to sleep medications. Cognitive behavioral therapy for insomnia (CBT-I) — specifically the stimulus-control and sleep-restriction components — directly targets this awakening pattern and is the first-line treatment in every major guideline (not Ambien, not benzodiazepines, not melatonin). In the Stanford-evaluated nurse-delivered CBT-I trial, a 6-visit protocol produced a 7-point drop in Insomnia Severity Index that was sustained at 6 months, and middle-of-the-night awakenings shortened or stopped entirely in most responders. The CBT-I rule for being awake at 3 am: don't lie there fighting it for more than ~20 minutes — get out of bed, do something quiet in dim light, and only return when sleepy. Combined with a fixed wake time, this rewires the awakening pattern within weeks.",
    notProven:
      "Whether the awakening is driven by anxiety, perimenopause, sleep apnea, or simply a too-early bedtime matters for the right treatment. CBT-I helps the conditioned-arousal pattern; it will not fix untreated sleep apnea or hot flashes. If awakenings come with snoring, gasping, or sweating, get a sleep study before assuming behavioral. Digital CBT-I apps appear effective but have less long-term data than in-person delivery, and partial adherence (skipping sleep restriction or stimulus control) substantially reduces effect size.",
    action:
      "Tonight: if you wake at 3 am and are still awake after ~20 minutes, get out of bed, sit in dim light, read something boring, and only return when sleepy. Keep your wake-up time fixed within 30 minutes every day for 2 weeks. If the pattern persists more than 3 months, ask your clinician about CBT-I (in-person, telehealth, or a validated app like Sleepio or Somryst) before accepting a hypnotic prescription.",
    tags: ["insomnia", "sleep maintenance", "middle of the night", "3am", "CBT-I", "treatment"],
  },
  {
    sourceDoi: "10.1212/WNL.0b013e3182563be5",
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
];

// ─── Communication pillar · Matt Abrahams (Stanford GSB) ───────────────────
// Three canonical, citable Abrahams works. DOIs are not standard for trade
// books / podcasts, so we use ISBN- and slug-based identifiers as stable
// idempotency keys (the schema treats `doi` as opaque text).
const ABRAHAMS_SOURCES: SeedSource[] = [
  {
    doi: "isbn:9781668010600",
    title:
      "Think Faster, Talk Smarter: How to Speak Successfully When You're Put on the Spot",
    authors: "Abrahams M",
    year: 2023,
    journal: "Simon Element / Simon & Schuster",
    sourceUrl: "https://www.fastersmarter.io/book",
    abstract:
      "A practitioner-focused synthesis of two decades of teaching at Stanford GSB on spontaneous speaking. Abrahams argues that most communication failures in high-stakes moments (Q&A, introductions, feedback, small talk, toasts, apologies) are anxiety- and structure-driven rather than content-driven, and offers a six-step methodology — manage anxiety, maximize mediocrity (lower the perfection bar), reframe the moment, listen, use structure (ADD, What/So What/Now What, Past–Present–Future, Problem–Solution–Benefit), and focus on connection over performance.",
    fullText: `Premise: We spend most of our adult speaking lives off-script — answering a question we didn't prepare for, making an introduction, giving feedback, fielding a curveball in a meeting. Yet almost every communication course teaches planned speaking. The skill that actually matters for a career is spontaneous speaking, and it can be trained.

The anxiety problem: Spontaneous-speaking anxiety is the largest single barrier. The body cannot tell the difference between a public-speaking threat and a physical threat — heart rate rises, breathing shallows, blood leaves the prefrontal cortex. The remedy is not "calm down" (telling someone to calm down rarely works); it is to physically lower arousal before speaking. Two interventions with real evidence: a slow, exhale-longer-than-inhale breath cycle (4-in, 6-out) for 30–60 seconds; and reframing the symptoms ("I'm excited") rather than fighting them ("I'm anxious"). The Brooks reappraisal work at HBS shows reframing arousal as excitement improves performance on speaking, math, and karaoke tasks.

Maximize mediocrity: The single most paralyzing belief in spontaneous speaking is that the answer must be excellent. Striving for excellence in real time triggers self-monitoring, which crowds out listening and fluency. The counter-instruction is to aim for "good enough" — a coherent, structured, on-topic answer — which paradoxically produces better answers than aiming for perfection.

Reframe: Treat the moment as an opportunity, not a threat. The classic reframes are: "This is a conversation, not a performance," "They want me to succeed, not fail," and "I have something useful to share." The reframe is not denial; it is the choice of which interpretation to act on when both are plausible.

Listen: Most spontaneous-speaking failures are listening failures. The speaker is rehearsing rather than listening, hears the wrong question, and answers it. The fix is to slow the response by 1–2 seconds — paraphrase the question or ask one clarifying question before answering. This buys cognitive room, signals respect, and dramatically improves the relevance of the answer.

Structure (the core toolkit): Structure is what separates a fluent answer from a rambling one. Four reusable templates cover most situations:

(1) What? / So what? / Now what? — describe the thing, explain why it matters, say what to do next. Best for feedback, updates, status reports.

(2) Problem / Solution / Benefit — name the problem, propose the solution, explain who gains and how. Best for pitches and recommendations.

(3) Past / Present / Future — where we were, where we are, where we're going. Best for introductions, toasts, retrospectives, vision-casting.

(4) ADD — Answer, Detail, Describe value. Answer the question in one sentence, give one supporting detail, then describe why it matters to the asker. Best for Q&A.

A structured answer of any of these forms, even mediocre, almost always beats an unstructured "great" answer that the listener cannot follow.

Connect: The final move is to shift the speaker's focus from self to audience. Anxiety is self-focused; connection is other-focused. The mental cue "How can I be useful to this person right now?" reorients attention outward and reduces self-monitoring. Eye contact with one person at a time (3–5 seconds each), genuine curiosity in questions asked back, and naming a shared situation ("we're all trying to figure this out together") are practical implementations.

Application contexts: The book applies the same methodology to seven everyday spontaneous-speaking situations — small talk, introductions, toasts and tributes, giving and receiving feedback, Q&A, apologies, and the persuasion that happens in casual conversation. In each, structure plus connection plus a lowered anxiety baseline produces noticeably better outcomes than waiting for inspiration.

What the book does not claim: It does not claim that anxiety can be eliminated, that introverts must become extroverts, or that there is a universal optimal style. It claims that the situation-by-situation skill of speaking when surprised is teachable, and that the techniques transfer.`,
  },
  {
    doi: "podcast:stanford-think-fast-talk-smart",
    title: "Think Fast, Talk Smart — Stanford GSB podcast (series)",
    authors: "Abrahams M (host), Stanford Graduate School of Business",
    year: 2020,
    journal: "Stanford Graduate School of Business",
    sourceUrl: "https://www.gsb.stanford.edu/business-podcasts/think-fast-talk-smart",
    abstract:
      "Long-running weekly podcast hosted by Stanford GSB lecturer Matt Abrahams, distilling research from across Stanford faculty (and adjacent communication science) into short, application-oriented episodes on spontaneous speaking, persuasion, listening, storytelling, feedback, conflict, and presence. Consistently ranked the #1 business podcast on Apple in the U.S. since 2022; cited and used as a primary teaching resource inside the GSB Strategic Communication curriculum.",
    fullText: `Series premise: Most working professionals are taught to write and to give planned presentations, but they spend the majority of their communication time in unscripted moments — answering, introducing, reacting, persuading in real time. The podcast bridges that gap by translating empirical research into concrete habits.

Recurring themes across episodes:

(1) Anxiety regulation. Repeated episodes return to the same core point: anxiety is physical first and cognitive second. Slow exhalation, reframing arousal as excitement, and ground-yourself-in-place cues (feet flat, weight balanced) move the body out of threat physiology faster than self-talk does.

(2) Structure beats content. Across guest interviews with researchers in negotiation, persuasion, and instructional design, the throughline is that listeners follow structure, not data density. A simple structure — Past/Present/Future, What/So What/Now What, Problem/Solution/Benefit, ADD — applied in real time produces a more memorable and more persuasive message than an unstructured information dump.

(3) Listening as a speaking skill. Guests from negotiation research (Margaret Neale, Jennifer Aaker), behavioral science (Francesca Gino), and conflict mediation consistently surface the same finding: the highest-leverage improvement most professionals can make is to listen better — to paraphrase, ask one clarifying question, and resist the urge to formulate the response while the other person is still speaking.

(4) The "less is more" effect. Several episodes feature work showing that adding qualifiers, hedges, and excess detail to a message reduces credibility and recall. Cutting redundancy increases both perceived expertise and audience retention.

(5) Status, presence, and the body. Posture and breath shape the listener's perception of the speaker's status and confidence within the first ~3 seconds. The intervention is not to fake confidence but to remove the postural and vocal habits that read as low-status (collapsed posture, vocal fry on every sentence, rising intonation on declaratives).

(6) Story over slide. Narrative — even a 60-second narrative — outperforms equivalent statistical content for recall, persuasion, and emotional resonance. The recommended micro-structure is a single moment with a single character moving from a "before" to an "after" — closer to a journalistic anecdote than a corporate case study.

(7) Feedback as a two-way design problem. Effective feedback episodes (with Carole Robin, David Bradford, and Kim Scott among others) converge on a small set of practices: speak in behaviors not labels, ask permission to give feedback, focus on impact rather than intent, and follow with a forward-looking suggestion.

(8) Connection over performance. Across episodes, the recurring closing note is that the speaker's goal in unscripted communication is to be useful to the person in front of them, not to look impressive. The shift in mental frame reduces self-monitoring and produces more authentic, more effective communication in the same moment.

Editorial stance: The podcast is explicitly anti-tip-of-the-week. Episodes are organized around a research-backed mechanism, not a checklist. The implied reader is a working professional, manager, or graduate student who wants empirical grounding for everyday communication choices.

Use in this knowledge base: When a Palonur user asks a communication question that has been treated in a recent TFTS episode, the episode is the primary citable artifact — both because it is publicly accessible and because Matt's own framing in the episode is the authoritative interpretation for this pillar.`,
  },
  {
    doi: "isbn:9781626342286",
    title:
      "Speaking Up Without Freaking Out: 50 Techniques for Confident and Compelling Presenting",
    authors: "Abrahams M",
    year: 2016,
    journal: "Kendall Hunt",
    sourceUrl:
      "https://www.kendallhunt.com/products/speaking-up-without-freaking-out",
    abstract:
      "Earlier, more presentation-focused companion to Think Faster, Talk Smarter. Provides a structured toolkit of 50 evidence-informed techniques for managing the symptoms (not just the experience) of speaking anxiety — including physiological down-regulation, cognitive reappraisal, structural rehearsal, and audience-focus drills — used as required reading in the Stanford GSB Strategic Communication course since 2016.",
    fullText: `Diagnosis: Public-speaking anxiety is the most commonly reported social fear. The book's central distinction is between the symptoms of anxiety (sweaty palms, racing heart, dry mouth, blanking) and the experience of anxiety (the fear of being judged). The symptoms are physiological and trainable; the experience is cognitive and reframable. Most "fear of public speaking" advice conflates the two and ends up addressing neither.

Physiological symptoms — and what reliably reduces them:

(1) Racing heart and shortness of breath. Cause: sympathetic nervous-system activation. Intervention: slow diaphragmatic breathing with an extended exhale (e.g., inhale for 4 seconds, exhale for 6–8 seconds) for 30–60 seconds immediately before speaking. The longer exhale activates the parasympathetic branch and lowers heart rate within a few breaths.

(2) Dry mouth and "cotton tongue." Cause: reduced saliva production under stress. Intervention: chew sugar-free gum or sip warm water (not cold — cold constricts vocal folds) in the minutes before speaking; lightly bite the tip of the tongue once, just before walking on stage, to stimulate salivation.

(3) Sweating and flushing. Intervention: cool the palms (cold water briefly under the wrists), avoid heat-trapping inner layers, and accept residual visible flushing — audiences notice it far less than the speaker fears.

(4) Trembling hands and voice. Intervention: ground yourself physically — feet hip-width apart, weight evenly distributed, one hand resting lightly on a lectern, pen, or remote. Isometric grip on a small object (a clicker, the edge of a notecard) absorbs visible tremor.

(5) Blanking and freezing. Cause: working-memory capture by self-monitoring. Intervention: build a recovery anchor into the talk — a known transition phrase, a slide that re-orients you, or a question for the audience that buys 10 seconds of cognitive room.

The 50 techniques: The book groups its toolkit into managing anxiety symptoms (physical and physiological), managing anxiety sources (cognitive reframes, including reframing arousal as excitement per Brooks), preparing the message for spontaneous adaptation (modular outlines, "if-then" branches, deliberate redundancy), and developing presence (pacing, gesture economy, eye contact in 3-second beats with one person at a time).

Core rehearsal protocol: Rehearse out loud, standing up, with the actual visuals or props you will use, at least twice — not the script in your head. Rehearsing silently is the single most common rehearsal mistake; it does not train the vocal apparatus or simulate the working-memory load of live delivery.

Audience focus drill: In the first 30 seconds on stage, find three friendly faces in three different parts of the room. Use them as anchor points throughout. The reciprocal eye contact regulates speaker arousal more effectively than any self-talk.

When to use medication or substances: The book is explicit that beta-blockers (e.g., low-dose propranolol) used under physician supervision can dampen physiological symptoms for high-stakes one-off events, and that this is a legitimate, evidence-supported choice for some speakers — but that the long-term answer is exposure plus the trainable techniques above, not avoidance and not chronic medication. Alcohol is unambiguously a poor choice — it dehydrates, impairs working memory, and produces a rebound increase in anxiety.

What the book does not promise: It does not promise that speakers will stop feeling nervous. The realistic outcome is that nervousness is reduced in magnitude, contained to the first 30–60 seconds, and decoupled from performance — that is, the speaker can be nervous and still deliver effectively.`,
  },
];

const COMMUNICATION_INTERPRETATIONS: SeedInterpretation[] = [
  {
    sourceDoi: "isbn:9781668010600",
    answer:
      "Lower the bar to 'good enough,' use a 3-part structure, and speak to be useful — not to impress.",
    interpretation:
      "When you're put on the spot — a tough question, a sudden ask, a hallway pitch — the people who do well are not the ones with the best answer; they're the ones with a coherent answer. Aim for 'maximize mediocrity': a clear, on-topic, structured response beats a brilliant one you never deliver because you froze trying to be perfect. The single most useful real-time structure is ADD: Answer in one sentence, give one supporting Detail, then Describe why it matters to the person asking. Two other templates cover almost everything else — What / So What / Now What for updates and feedback; Past / Present / Future for introductions, toasts, and vision. The deeper shift is mental: reorient from 'how do I look?' to 'how can I be useful to this person right now?' Self-focus is what anxiety feeds on; other-focus starves it.",
    notProven:
      "There is no one structure that fits every culture or every audience. ADD and What/So What/Now What are well-validated in U.S. and Western European business contexts; high-context cultures often expect more relational framing before the answer.",
    action:
      "Pick one structure (ADD is the cheapest to learn) and use it deliberately in your next three meetings. Before answering, take a 1–2 second pause — paraphrase the question or ask one clarifying question. That pause buys cognitive room and almost always improves the answer.",
    tags: [
      "spontaneous speaking",
      "structure",
      "ADD",
      "anxiety",
      "Q&A",
      "Abrahams",
    ],
  },
  {
    sourceDoi: "isbn:9781626342286",
    answer:
      "Treat speaking anxiety as a physical problem first — slow your exhale, ground your body, and accept that nervousness ≠ bad performance.",
    interpretation:
      "Public-speaking anxiety is the most commonly reported social fear, and most advice fails because it tries to talk you out of feeling nervous. The body doesn't take that order. What does work is intervening on the symptoms: a 4-in / 6-out breathing cycle for 30–60 seconds before you speak activates the parasympathetic branch and brings your heart rate down within a few breaths. Standing with feet hip-width apart, weight even, one hand lightly anchored, contains visible tremor. Chew sugar-free gum or sip warm (not cold) water beforehand to fight cotton mouth. The cognitive move that has real evidence behind it is reappraisal: telling yourself 'I'm excited' instead of 'I'm anxious' (Brooks, HBS) improves performance on speaking and other arousal-sensitive tasks. The realistic outcome isn't no nerves — it's nerves that fade in 30–60 seconds and don't sabotage the delivery.",
    notProven:
      "Beta-blockers (e.g., low-dose propranolol under physician supervision) help some high-stakes one-off speakers, but the long-term answer is repeated exposure plus the techniques above, not chronic medication. Alcohol unambiguously makes it worse.",
    action:
      "Before your next high-stakes talk: do 60 seconds of 4-in / 6-out breathing, rehearse the first 30 seconds out loud while standing, and find three friendly faces in the room you will return to as anchors. If you blank, default to your prepared transition phrase and keep going.",
    tags: [
      "speaking anxiety",
      "presentation",
      "breathing",
      "reappraisal",
      "physiology",
      "Abrahams",
    ],
  },
  {
    sourceDoi: "podcast:stanford-think-fast-talk-smart",
    answer:
      "Listening is a speaking skill: paraphrase, ask one clarifying question, and answer the question they actually asked.",
    interpretation:
      "Across hundreds of Think Fast, Talk Smart episodes, one finding keeps surfacing from negotiation, persuasion, and conflict research: the highest-leverage upgrade most professionals can make isn't to speak better — it's to listen better. The common failure mode is rehearsing your response while the other person is still talking, which means you answer the question you wished they'd asked, not the one they did. The fix is mechanical, not mystical. Slow the response by 1–2 seconds. Paraphrase the question back ('So you're asking whether…') or ask one clarifying question before you start answering. That pause does three things at once: it buys you cognitive room to structure the answer, it signals genuine attention (which by itself raises the listener's evaluation of your credibility), and it dramatically reduces the chance you're solving the wrong problem. Pair it with a simple structure (ADD or Problem / Solution / Benefit) and your answers get noticeably sharper without you having to be smarter.",
    notProven:
      "How much pausing is too much varies by culture and conversational tempo — in fast-cadence settings (some trading floors, some media interviews) a 2-second pause reads as hesitation rather than thoughtfulness. Calibrate.",
    action:
      "In your next three meetings, before answering any non-trivial question, paraphrase it back in one sentence. Track how often the asker corrects or refines the question. That delta is the conversations you used to lose by answering too fast.",
    tags: [
      "listening",
      "Q&A",
      "negotiation",
      "spontaneous speaking",
      "presence",
      "Abrahams",
      "Think Fast Talk Smart",
    ],
  },
];

async function main() {
  console.log("=== Palonur demo seed ===\n");

  console.log("Pillars:");
  const sleep = await ensurePillar("sleep", "Sleep", "Stanford-attributable sleep science");
  const movement = await ensurePillar("movement", "Movement", "Stanford-attributable movement science");
  const nutrition = await ensurePillar("nutrition", "Nutrition", "Stanford-attributable nutrition science");
  const communication = await ensurePillar(
    "communication",
    "Communication",
    "Stanford-attributable communication science",
  );
  const strategicCommunication = await ensurePillar(
    "strategic-communication",
    "Strategic Communication",
    "Stanford-attributable strategic communication science — Matt Abrahams",
  );
  // Remaining canonical lifestyle-medicine pillars. They start with no faculty
  // assigned (intentionally empty) so admins can see and plan coverage for them.
  await ensurePillar(
    "stress-management",
    "Stress Management",
    "Stanford-attributable stress-management science",
  );
  await ensurePillar(
    "social-connection",
    "Social Connection",
    "Stanford-attributable social-connection science",
  );
  await ensurePillar(
    "avoidance-of-risky-substances",
    "Avoidance of Risky Substances",
    "Stanford-attributable science on avoiding risky substances",
  );

  console.log("\nStewards:");
  const jamie = await ensureSteward("jzeitzer@stanford.edu", "Jamie Zeitzer", sleep.id);
  const matt = await ensureSteward(
    "abrahams_matt@gsb.stanford.edu",
    "Matt Abrahams",
    strategicCommunication.id,
  );

  // Karan is the Palonur demo operator — gets steward access to all
  // pillars so the faculty dashboard shows the full layout (Sleep populated,
  // the others empty) when he logs in to demo.
  for (const p of [
    sleep,
    movement,
    nutrition,
    communication,
    strategicCommunication,
  ]) {
    await ensureSteward("karan@palonur.com", "Karan Dehghani", p.id);
  }

  console.log("\nSources (Sleep):");
  for (const src of ZEITZER_SOURCES) {
    await ensureSource(sleep.id, jamie.id, src);
  }

  console.log("\nInterpretations (Sleep):");
  for (const interp of SLEEP_INTERPRETATIONS) {
    await ensureInterpretation(sleep.id, jamie.id, interp);
  }

  console.log("\nSources (Strategic Communication):");
  for (const src of ABRAHAMS_SOURCES) {
    await ensureSource(strategicCommunication.id, matt.id, src);
  }

  console.log("\nInterpretations (Strategic Communication):");
  for (const interp of COMMUNICATION_INTERPRETATIONS) {
    await ensureInterpretation(strategicCommunication.id, matt.id, interp);
  }

  console.log("\n=== done ===");
  await pool.end();
}

main().catch(async (e) => {
  console.error("seed failed:", e);
  await pool.end();
  process.exit(1);
});
