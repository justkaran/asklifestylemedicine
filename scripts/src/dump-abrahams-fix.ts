/**
 * Bulletproof prod-seed for missing Matt Abrahams chunks + interpretations.
 *
 * The original dump used DO $$ ... END $$; blocks. The Replit SQL Console
 * naively splits pasted SQL on `;` without respecting $$ quoting, which
 * fragments the DO body and produces "unterminated dollar-quoted string"
 * errors. This script emits plain INSERT ... SELECT ... WHERE NOT EXISTS
 * statements — no DO blocks, no $$ — so the console can split on `;` safely.
 *
 * Assumes the source rows already exist in prod (they were inserted by the
 * earlier paste). Only inserts source_chunks, interpretations, and
 * interpretation_chunks if they are missing.
 */
import { pool } from "@workspace/db";
import { writeFileSync } from "fs";

const PILLAR_SLUG = "communication";
const STEWARD_EMAIL = "abrahams_matt@gsb.stanford.edu";
const EMBED_MODEL = "text-embedding-3-large";
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
  out.push(`-- Idempotent prod fix: insert missing source_chunks + interpretations`);
  out.push(`-- for the 3 Abrahams Communication sources already present in prod.`);
  out.push(`-- Pure INSERT...SELECT...WHERE NOT EXISTS — no DO blocks, no $$.`);
  out.push(`-- Each statement ends in a single semicolon; safe to split on \`;\`.`);
  out.push(``);

  for (let idx = 0; idx < SOURCE_DOIS.length; idx++) {
    const doi = SOURCE_DOIS[idx];
    const src = (await pool.query(`SELECT * FROM sources WHERE doi=$1`, [doi])).rows[0];
    if (!src) throw new Error(`source ${doi} not in dev`);

    const srcChunks = (await pool.query(
      `SELECT chunk_index, text, embedding::text AS embedding, embedding_model
       FROM source_chunks WHERE source_id=$1 ORDER BY chunk_index`,
      [src.id],
    )).rows;

    const interp = (await pool.query(
      `SELECT * FROM interpretations WHERE source_id=$1 AND status='approved'`,
      [src.id],
    )).rows[0];

    out.push(`-- ─── Source ${idx + 1}/${SOURCE_DOIS.length} · doi=${doi} ───`);
    out.push(``);

    // Source chunks — each as its own INSERT...SELECT...WHERE NOT EXISTS.
    for (const c of srcChunks) {
      out.push(`INSERT INTO source_chunks (source_id, chunk_index, text, embedding, embedding_model)
SELECT s.id, ${c.chunk_index}, ${sqlStr(c.text)},
       '${c.embedding}'::halfvec(3072), ${sqlStr(c.embedding_model)}
FROM sources s
WHERE s.pillar_id = (SELECT id FROM pillars WHERE slug=${sqlStr(PILLAR_SLUG)})
  AND s.doi = ${sqlStr(doi)}
  AND NOT EXISTS (
    SELECT 1 FROM source_chunks sc WHERE sc.source_id = s.id AND sc.chunk_index = ${c.chunk_index}
  );`);
      out.push(``);
    }

    if (interp) {
      // Interpretation row.
      out.push(`INSERT INTO interpretations (source_id, pillar_id, author_id, status, version,
                              answer, interpretation, not_proven, action, tags,
                              approver_id, approved_at)
SELECT s.id, p.id, u.id, 'approved', 1,
       ${sqlStr(interp.answer)},
       ${sqlStr(interp.interpretation)},
       ${sqlStr(interp.not_proven)},
       ${sqlStr(interp.action)},
       ${sqlArr(interp.tags)},
       u.id, NOW()
FROM sources s
JOIN pillars p ON p.id = s.pillar_id
JOIN faculty_users u ON u.email = ${sqlStr(STEWARD_EMAIL)}
WHERE p.slug = ${sqlStr(PILLAR_SLUG)}
  AND s.doi = ${sqlStr(doi)}
  AND NOT EXISTS (
    SELECT 1 FROM interpretations i
     WHERE i.source_id = s.id AND i.status = 'approved'
  );`);
      out.push(``);

      const interpChunks = (await pool.query(
        `SELECT chunk_index, text, embedding::text AS embedding, embedding_model, priority
         FROM interpretation_chunks WHERE interpretation_id=$1 ORDER BY chunk_index`,
        [interp.id],
      )).rows;

      for (const c of interpChunks) {
        out.push(`INSERT INTO interpretation_chunks
  (interpretation_id, source_id, pillar_id, chunk_index, text, embedding, embedding_model, priority)
SELECT i.id, s.id, p.id, ${c.chunk_index}, ${sqlStr(c.text)},
       '${c.embedding}'::halfvec(3072), ${sqlStr(c.embedding_model)}, ${c.priority}
FROM interpretations i
JOIN sources s ON s.id = i.source_id
JOIN pillars p ON p.id = i.pillar_id
WHERE p.slug = ${sqlStr(PILLAR_SLUG)}
  AND s.doi = ${sqlStr(doi)}
  AND i.status = 'approved'
  AND NOT EXISTS (
    SELECT 1 FROM interpretation_chunks ic
     WHERE ic.interpretation_id = i.id AND ic.chunk_index = ${c.chunk_index}
  );`);
        out.push(``);
      }
    }

    // Write per-source file.
    const path = `/home/runner/workspace/.local/abrahams-fix2-source${idx + 1}.sql.txt`;
    writeFileSync(path, out.join("\n"));
    console.log(`wrote ${path} (${out.join("\n").length} bytes)`);
    out.length = 0;
  }

  // Sanity check file (standalone).
  const sanity = `-- Sanity check after running all three source files:
SELECT s.id, LEFT(s.title, 40) AS title,
       (SELECT COUNT(*) FROM source_chunks WHERE source_id=s.id) AS src_chunks,
       (SELECT i.id FROM interpretations i WHERE i.source_id=s.id AND i.status='approved') AS interp_id,
       (SELECT COUNT(*) FROM interpretation_chunks ic
          JOIN interpretations i ON i.id=ic.interpretation_id
         WHERE i.source_id=s.id AND i.status='approved') AS interp_chunks
FROM sources s
WHERE s.pillar_id = (SELECT id FROM pillars WHERE slug=${sqlStr(PILLAR_SLUG)})
  AND s.doi IN (${SOURCE_DOIS.map(sqlStr).join(", ")})
ORDER BY s.id;
`;
  writeFileSync("/home/runner/workspace/.local/abrahams-fix2-sanity.sql.txt", sanity);
  console.log(`wrote .local/abrahams-fix2-sanity.sql.txt`);

  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
