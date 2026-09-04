/**
 * Generate a portable, idempotent prod-seed SQL file for the Matt Abrahams
 * Communication-pillar content. Paste into the prod Replit Database pane.
 *
 * Reads everything from the dev DB (which seed-demo populated) and emits:
 *  1) faculty_users + faculty_memberships for Matt on the Communication pillar
 *  2) Each source + its source_chunks
 *  3) Each approved interpretation + its interpretation_chunks
 *
 * Embeddings are baked into the SQL as halfvec(3072) literals. The script
 * resolves pillar / user by slug/email at paste time so dev<->prod id drift
 * doesn't matter. NO BEGIN/COMMIT wrappers — the Replit SQL Console splits on
 * statements and runs each independently; each block here is self-idempotent.
 */
import { pool } from "@workspace/db";
import { writeFileSync } from "fs";

const PILLAR_SLUG = "communication";
const STEWARD_EMAIL = "abrahams_matt@gsb.stanford.edu";
const STEWARD_NAME = "Matt Abrahams";
const SOURCE_DOIS = [
  "isbn:9781668010600",
  "podcast:stanford-think-fast-talk-smart",
  "isbn:9781626342286",
];

function sqlStr(s: string | null | undefined): string {
  if (s === null || s === undefined) return "NULL";
  return "'" + s.replace(/'/g, "''") + "'";
}
function sqlArr(a: string[] | null | undefined): string {
  if (!a || a.length === 0) return "'{}'::text[]";
  return "ARRAY[" + a.map(sqlStr).join(",") + "]::text[]";
}

async function main() {
  const out: string[] = [];
  out.push(`-- Idempotent prod seed: Matt Abrahams (Stanford GSB) Communication pillar content.`);
  out.push(`-- Pillar: ${PILLAR_SLUG} · Steward: ${STEWARD_EMAIL}`);
  out.push(`-- Safe to re-run. Paste into the Replit Database pane (production) once.`);
  out.push(`-- Each top-level statement is independently idempotent — no BEGIN/COMMIT needed.`);
  out.push(``);

  // ── 1) Steward upsert ──────────────────────────────────────────────────
  out.push(`-- 1) Ensure Matt Abrahams faculty_user + steward membership on the ${PILLAR_SLUG} pillar.`);
  out.push(`DO $$
DECLARE
  v_user_id int;
  v_pillar_id int;
BEGIN
  SELECT id INTO v_pillar_id FROM pillars WHERE slug=${sqlStr(PILLAR_SLUG)};
  IF v_pillar_id IS NULL THEN
    RAISE EXCEPTION '${PILLAR_SLUG} pillar missing — seed pillars first';
  END IF;

  SELECT id INTO v_user_id FROM faculty_users WHERE email=${sqlStr(STEWARD_EMAIL)};
  IF v_user_id IS NULL THEN
    INSERT INTO faculty_users (clerk_user_id, email, full_name)
    VALUES (${sqlStr("pending:" + STEWARD_EMAIL)}, ${sqlStr(STEWARD_EMAIL)}, ${sqlStr(STEWARD_NAME)})
    RETURNING id INTO v_user_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM faculty_memberships
     WHERE user_id=v_user_id AND pillar_id=v_pillar_id
  ) THEN
    INSERT INTO faculty_memberships (user_id, pillar_id, role)
    VALUES (v_user_id, v_pillar_id, 'steward');
  END IF;
END $$;`);
  out.push(``);

  // ── 2) Sources + chunks + interpretations + interpretation chunks ───────
  for (let idx = 0; idx < SOURCE_DOIS.length; idx++) {
    const doi = SOURCE_DOIS[idx];
    const src = (await pool.query(`SELECT * FROM sources WHERE doi=$1`, [doi])).rows[0];
    if (!src) throw new Error(`source ${doi} not found in dev — run seed-demo first`);

    const srcChunks = (await pool.query(
      `SELECT chunk_index, text, embedding::text AS embedding, embedding_model
       FROM source_chunks WHERE source_id=$1 ORDER BY chunk_index`,
      [src.id],
    )).rows;

    const interp = (await pool.query(
      `SELECT * FROM interpretations WHERE source_id=$1 AND status='approved'`,
      [src.id],
    )).rows[0];

    out.push(`-- ─── Source ${idx + 1}/${SOURCE_DOIS.length}: ${(src.title as string).slice(0, 70)} ───`);
    out.push(`-- DOI key: ${doi}`);
    out.push(``);

    // Insert source if not present.
    out.push(`WITH ids AS (
  SELECT (SELECT id FROM pillars WHERE slug=${sqlStr(PILLAR_SLUG)}) AS pillar_id,
         (SELECT id FROM faculty_users WHERE email=${sqlStr(STEWARD_EMAIL)}) AS uploader_id
), ins AS (
  INSERT INTO sources (pillar_id, uploaded_by_user_id, kind, title, authors, year, journal, doi,
                       abstract, full_text, source_url, status, version)
  SELECT ids.pillar_id, ids.uploader_id, ${sqlStr(src.kind)}, ${sqlStr(src.title)},
         ${sqlStr(src.authors)}, ${src.year}, ${sqlStr(src.journal)}, ${sqlStr(src.doi)},
         ${sqlStr(src.abstract)}, ${sqlStr(src.full_text)}, ${sqlStr(src.source_url)},
         'approved', 1
  FROM ids
  WHERE NOT EXISTS (
    SELECT 1 FROM sources WHERE pillar_id=ids.pillar_id AND doi=${sqlStr(src.doi)}
  )
  RETURNING id
)
SELECT 1;`);
    out.push(``);

    // Source chunks.
    out.push(`DO $$
DECLARE
  v_source_id int;
  v_pillar_id int;
  v_count int;
BEGIN
  SELECT id INTO v_pillar_id FROM pillars WHERE slug=${sqlStr(PILLAR_SLUG)};
  SELECT id INTO v_source_id FROM sources WHERE pillar_id=v_pillar_id AND doi=${sqlStr(src.doi)};
  IF v_source_id IS NULL THEN RAISE EXCEPTION 'source row missing for ${doi}'; END IF;
  SELECT COUNT(*) INTO v_count FROM source_chunks WHERE source_id=v_source_id;
  IF v_count = 0 THEN`);
    for (const c of srcChunks) {
      out.push(`    INSERT INTO source_chunks (source_id, chunk_index, text, embedding, embedding_model)
      VALUES (v_source_id, ${c.chunk_index}, ${sqlStr(c.text)},
              '${c.embedding}'::halfvec(3072), ${sqlStr(c.embedding_model)});`);
    }
    out.push(`  END IF;
END $$;`);
    out.push(``);

    // Interpretation + interpretation chunks.
    if (interp) {
      const interpChunks = (await pool.query(
        `SELECT chunk_index, text, embedding::text AS embedding, embedding_model, priority
         FROM interpretation_chunks WHERE interpretation_id=$1 ORDER BY chunk_index`,
        [interp.id],
      )).rows;

      out.push(`DO $$
DECLARE
  v_pillar_id int;
  v_source_id int;
  v_author_id int;
  v_interp_id int;
BEGIN
  SELECT id INTO v_pillar_id FROM pillars WHERE slug=${sqlStr(PILLAR_SLUG)};
  SELECT id INTO v_source_id FROM sources WHERE pillar_id=v_pillar_id AND doi=${sqlStr(src.doi)};
  SELECT id INTO v_author_id FROM faculty_users WHERE email=${sqlStr(STEWARD_EMAIL)};
  IF v_source_id IS NULL OR v_author_id IS NULL THEN
    RAISE EXCEPTION 'source or author missing for ${doi}'; END IF;
  SELECT id INTO v_interp_id FROM interpretations
    WHERE source_id=v_source_id AND pillar_id=v_pillar_id AND status='approved';
  IF v_interp_id IS NULL THEN
    INSERT INTO interpretations (source_id, pillar_id, author_id, status, version,
                                 answer, interpretation, not_proven, action, tags,
                                 approver_id, approved_at)
    VALUES (v_source_id, v_pillar_id, v_author_id, 'approved', 1,
            ${sqlStr(interp.answer)},
            ${sqlStr(interp.interpretation)},
            ${sqlStr(interp.not_proven)},
            ${sqlStr(interp.action)},
            ${sqlArr(interp.tags)},
            v_author_id, NOW())
    RETURNING id INTO v_interp_id;`);
      for (const c of interpChunks) {
        out.push(`    INSERT INTO interpretation_chunks
      (interpretation_id, source_id, pillar_id, chunk_index, text, embedding, embedding_model, priority)
    VALUES (v_interp_id, v_source_id, v_pillar_id, ${c.chunk_index}, ${sqlStr(c.text)},
            '${c.embedding}'::halfvec(3072), ${sqlStr(c.embedding_model)}, ${c.priority});`);
      }
      out.push(`  END IF;
END $$;`);
      out.push(``);
    }
  }

  // ── 3) Sanity check ────────────────────────────────────────────────────
  out.push(`-- Sanity check:`);
  out.push(`SELECT s.id AS source_id, LEFT(s.title, 40) AS title,
       (SELECT COUNT(*) FROM source_chunks WHERE source_id=s.id) AS src_chunks,
       (SELECT i.id FROM interpretations i WHERE i.source_id=s.id AND i.status='approved') AS interp_id,
       (SELECT COUNT(*) FROM interpretation_chunks ic
          JOIN interpretations i ON i.id=ic.interpretation_id
         WHERE i.source_id=s.id AND i.status='approved') AS interp_chunks
FROM sources s
WHERE s.pillar_id=(SELECT id FROM pillars WHERE slug=${sqlStr(PILLAR_SLUG)})
  AND s.doi IN (${SOURCE_DOIS.map(sqlStr).join(", ")})
ORDER BY s.id;`);

  const path = "/home/runner/workspace/.local/abrahams-communication-prod-seed.sql";
  writeFileSync(path, out.join("\n"));
  console.log(`wrote ${path} (${out.join("\n").length} bytes)`);
  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
