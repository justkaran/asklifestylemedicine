import { pool } from "@workspace/db";
import { writeFileSync } from "fs";

const DOI = "10.1212/WNL.0b013e3182563be5";

function sqlStr(s: string | null): string {
  if (s === null) return "NULL";
  return "'" + s.replace(/'/g, "''") + "'";
}
function sqlArr(a: string[] | null | undefined): string {
  if (!a || a.length === 0) return "'{}'::text[]";
  return "ARRAY[" + a.map(sqlStr).join(",") + "]::text[]";
}

async function main() {
  const src = (await pool.query(`SELECT * FROM sources WHERE doi=$1`, [DOI])).rows[0];
  if (!src) throw new Error("source not found in dev");
  const srcChunks = (await pool.query(
    `SELECT chunk_index, text, embedding::text AS embedding, embedding_model
     FROM source_chunks WHERE source_id=$1 ORDER BY chunk_index`,
    [src.id],
  )).rows;
  const interp = (await pool.query(
    `SELECT * FROM interpretations WHERE source_id=$1 AND status='approved'`,
    [src.id],
  )).rows[0];
  if (!interp) throw new Error("interpretation not found");
  const interpChunks = (await pool.query(
    `SELECT chunk_index, text, embedding::text AS embedding, embedding_model, priority
     FROM interpretation_chunks WHERE interpretation_id=$1 ORDER BY chunk_index`,
    [interp.id],
  )).rows;

  const out: string[] = [];
  out.push(`-- Idempotent prod seed: Ohayon 2012 sleepwalking paper + Jamie's interpretation.`);
  out.push(`-- Safe to re-run. Paste into the Replit Database pane (production) once.`);
  out.push(`-- DOI: ${DOI}`);
  out.push(``);
  out.push(`-- 1) Insert source (skip if DOI already exists for the sleep pillar).`);
  out.push(`WITH ids AS (
  SELECT (SELECT id FROM pillars WHERE slug='sleep') AS pillar_id,
         (SELECT id FROM faculty_users WHERE email='jzeitzer@stanford.edu') AS uploader_id
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
  out.push(`-- 2) Insert source_chunks (skip if any exist for this source).`);
  out.push(`DO $$
DECLARE
  v_source_id int;
  v_pillar_id int;
  v_count int;
BEGIN
  SELECT id INTO v_pillar_id FROM pillars WHERE slug='sleep';
  SELECT id INTO v_source_id FROM sources WHERE pillar_id=v_pillar_id AND doi=${sqlStr(src.doi)};
  IF v_source_id IS NULL THEN RAISE EXCEPTION 'source row missing'; END IF;
  SELECT COUNT(*) INTO v_count FROM source_chunks WHERE source_id = v_source_id;
  IF v_count = 0 THEN`);
  for (const c of srcChunks) {
    out.push(`    INSERT INTO source_chunks (source_id, chunk_index, text, embedding, embedding_model)
      VALUES (v_source_id, ${c.chunk_index}, ${sqlStr(c.text)},
              '${c.embedding}'::halfvec(3072), ${sqlStr(c.embedding_model)});`);
  }
  out.push(`  END IF;
END $$;`);
  out.push(``);
  out.push(`-- 3) Insert interpretation (skip if an approved one already exists for this source).`);
  out.push(`DO $$
DECLARE
  v_pillar_id int;
  v_source_id int;
  v_author_id int;
  v_interp_id int;
BEGIN
  SELECT id INTO v_pillar_id FROM pillars WHERE slug='sleep';
  SELECT id INTO v_source_id FROM sources WHERE pillar_id=v_pillar_id AND doi=${sqlStr(src.doi)};
  SELECT id INTO v_author_id FROM faculty_users WHERE email='jzeitzer@stanford.edu';
  IF v_source_id IS NULL OR v_author_id IS NULL THEN
    RAISE EXCEPTION 'source or author missing'; END IF;
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
  out.push(`-- Sanity check:`);
  out.push(`SELECT s.id AS source_id, s.title,
       (SELECT COUNT(*) FROM source_chunks WHERE source_id=s.id) AS source_chunks,
       (SELECT i.id FROM interpretations i WHERE i.source_id=s.id AND i.status='approved') AS interp_id,
       (SELECT COUNT(*) FROM interpretation_chunks ic
          JOIN interpretations i ON i.id=ic.interpretation_id
         WHERE i.source_id=s.id AND i.status='approved') AS interp_chunks
FROM sources s WHERE s.doi=${sqlStr(src.doi)};`);

  const path = "/home/runner/workspace/.local/ohayon-sleepwalking-prod-seed.sql";
  writeFileSync(path, out.join("\n"));
  console.log(`wrote ${path} (${out.join("\n").length} bytes)`);
  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
