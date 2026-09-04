/**
 * Additive, non-interactive schema sync.
 *
 * Reads the Drizzle schema metadata, introspects a live Postgres database, and
 * applies ONLY additive changes (CREATE TYPE / ADD VALUE / CREATE TABLE / ADD
 * COLUMN / CREATE INDEX). It NEVER drops anything, so legacy objects that exist
 * in the DB but not in the schema barrel are preserved, and there is no
 * interactive "created or renamed?" prompt (the failure mode that makes
 * `drizzle-kit push` unusable on the shared dev DB).
 *
 * Used by:
 *   - `scripts/src/sync-dev-schema.ts` (post-merge dev-DB drift correction)
 *   - api-server test bootstrap (so a schema-changing merge no longer reds the
 *     suite with "column does not exist")
 *
 * Idempotent and race-tolerant: safe to run repeatedly and from parallel test
 * workers. It applies btree indexes including PARTIAL (`WHERE …`) and EXPRESSION
 * indexes — their predicate/expression is rendered straight from drizzle's SQL
 * metadata (it renders with zero bound params in this schema). Vector indexes
 * (hnsw / ivfflat) are still surfaced as `skipped` — they need pgvector operator
 * classes and a matching halfvec column shape and are (re)built model-keyed by
 * the reembed-chunks pipeline. Any destructive drift (objects in the DB but not
 * the schema) is returned as `warnings`, never applied.
 *
 * Implementation note: this intentionally does NOT use drizzle-kit. Its
 * programmatic `pushSchema` API drops query params in its introspection wrapper
 * (broken in this drizzle-orm version), and the CLI `push` either stalls on the
 * interactive prompt or, with `--force`, drops unmanaged tables. We derive DDL
 * straight from drizzle-orm's table metadata instead (drizzle-orm + pg only, no
 * extra deps).
 */
import { is } from "drizzle-orm";
import { PgTable, getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import * as schema from "./schema";

/**
 * Single dialect instance used to render index WHERE predicates and expression
 * columns straight from drizzle-orm's SQL metadata (no drizzle-kit).
 */
const dialect = new PgDialect();

/**
 * Render a drizzle `SQL` fragment (an index predicate or expression column) to
 * literal SQL text. Returns null when the fragment carries bound parameters —
 * we only auto-apply statically-renderable fragments so we never inline an
 * unbound `$1`. In this schema every index predicate/expression renders with
 * zero params (column refs and string/raw literals only).
 */
function renderSqlFragment(frag: SQL): string | null {
  try {
    const query = dialect.sqlToQuery(frag);
    if (query.params.length > 0) return null;
    return query.sql;
  } catch {
    return null;
  }
}

export interface SyncResult {
  applied: string[];
  skipped: string[];
  warnings: string[];
}

export interface SyncOptions {
  /** Report what would change without executing anything. */
  dryRun?: boolean;
  /** Sink for progress lines. Defaults to a no-op (silent). */
  log?: (line: string) => void;
}

/** A pg-compatible query runner (the `pg` Pool/Client `.query`). */
type Queryable = {
  query: (
    sql: string,
  ) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

function q(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

/** Render a column's SQL DEFAULT expression, or null if it can't be expressed. */
function renderDefault(col: PgColumn): string | null {
  if (!col.hasDefault) return null;
  const d = (col as unknown as { default: unknown }).default;
  if (d === undefined || d === null) return null;
  if (typeof d === "string") return `'${d.replace(/'/g, "''")}'`;
  if (typeof d === "number" || typeof d === "bigint") return String(d);
  if (typeof d === "boolean") return d ? "true" : "false";
  if (typeof d === "object") {
    // Drizzle SQL expression (e.g. now(), gen_random_uuid(), ARRAY[]::int[]).
    const chunks = (d as { queryChunks?: Array<{ value?: unknown }> })
      .queryChunks;
    if (Array.isArray(chunks)) {
      const txt = chunks
        .map((ch) => (Array.isArray(ch.value) ? ch.value.join("") : ""))
        .join("");
      return txt || null;
    }
    // Plain JSON default for a json/jsonb column (e.g. []).
    const sqlType = col.getSQLType().toLowerCase();
    if (sqlType === "jsonb" || sqlType === "json") {
      return `'${JSON.stringify(d).replace(/'/g, "''")}'::${sqlType}`;
    }
  }
  return null;
}

/**
 * Render a single column definition for CREATE TABLE / ADD COLUMN.
 * `freshTable` => the table is being created now (no existing rows), so NOT NULL
 * is always safe. For ADD COLUMN on a possibly-populated table we only keep
 * NOT NULL when a DEFAULT is available; otherwise we add the column nullable so
 * it can't fail on existing rows (the goal is to stop "column does not exist",
 * not to perfectly mirror every constraint).
 */
function renderColumnDef(col: PgColumn, freshTable: boolean): string {
  const parts = [q(col.name), col.getSQLType()];
  if (col.primary) parts.push("PRIMARY KEY");
  const def = renderDefault(col);
  if (def !== null) parts.push(`DEFAULT ${def}`);
  if (col.notNull && (freshTable || def !== null) && !col.primary) {
    parts.push("NOT NULL");
  }
  return parts.join(" ");
}

type EnumDef = { name: string; values: string[] };

function collectEnums(): EnumDef[] {
  const out: EnumDef[] = [];
  for (const val of Object.values(schema)) {
    const e = val as { enumName?: unknown; enumValues?: unknown };
    if (typeof e.enumName === "string" && Array.isArray(e.enumValues)) {
      out.push({ name: e.enumName, values: e.enumValues as string[] });
    }
  }
  return out;
}

function collectTables(): PgTable[] {
  const out: PgTable[] = [];
  for (const val of Object.values(schema)) {
    if (is(val, PgTable)) out.push(val);
  }
  return out;
}

/**
 * Apply additive schema changes from the Drizzle barrel to `db`.
 * `db` is anything with a pg-style `.query(sql)` (a Pool or Client).
 */
export async function syncSchemaAdditive(
  db: Queryable,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const dryRun = opts.dryRun ?? false;
  const log = opts.log ?? (() => {});
  const applied: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];

  async function run(sql: string, label: string): Promise<void> {
    if (dryRun) {
      applied.push(`[dry-run] ${label}`);
      return;
    }
    try {
      await db.query(sql);
      applied.push(label);
    } catch (e) {
      warnings.push(`FAILED ${label}: ${(e as Error).message}`);
    }
  }

  log(`Additive schema sync${dryRun ? " (dry run)" : ""} starting…`);

  await run(`CREATE EXTENSION IF NOT EXISTS vector`, "extension vector");

  // ---- Introspect the live DB up front ----
  const liveEnums = new Map<string, Set<string>>();
  {
    const { rows } = await db.query(
      `SELECT t.typname, e.enumlabel
         FROM pg_type t
         JOIN pg_enum e ON e.enumtypid = t.oid
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public'`,
    );
    for (const r of rows as Array<{ typname: string; enumlabel: string }>) {
      if (!liveEnums.has(r.typname)) liveEnums.set(r.typname, new Set());
      liveEnums.get(r.typname)!.add(r.enumlabel);
    }
  }

  const liveColumns = new Map<string, Set<string>>();
  {
    const { rows } = await db.query(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'`,
    );
    for (const r of rows as Array<{
      table_name: string;
      column_name: string;
    }>) {
      if (!liveColumns.has(r.table_name))
        liveColumns.set(r.table_name, new Set());
      liveColumns.get(r.table_name)!.add(r.column_name);
    }
  }

  const liveIndexes = new Set<string>();
  {
    const { rows } = await db.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    for (const r of rows as Array<{ indexname: string }>)
      liveIndexes.add(r.indexname);
  }

  // ---- 1. Enums: create missing types, append missing values ----
  for (const en of collectEnums()) {
    const live = liveEnums.get(en.name);
    if (!live) {
      const labels = en.values
        .map((v) => `'${v.replace(/'/g, "''")}'`)
        .join(", ");
      // DO/EXCEPTION makes CREATE TYPE safe under parallel callers (test
      // workers) — CREATE TYPE has no IF NOT EXISTS form.
      await run(
        `DO $$ BEGIN
           CREATE TYPE ${q(en.name)} AS ENUM (${labels});
         EXCEPTION
           WHEN duplicate_object THEN NULL;
           WHEN unique_violation THEN NULL;
         END $$`,
        `enum type ${en.name}`,
      );
    } else {
      for (const v of en.values) {
        if (!live.has(v)) {
          // ADD VALUE cannot run inside a transaction; the pg pool autocommits.
          await run(
            `ALTER TYPE ${q(en.name)} ADD VALUE IF NOT EXISTS '${v.replace(/'/g, "''")}'`,
            `enum ${en.name} += '${v}'`,
          );
        }
      }
    }
  }

  // ---- 2. Tables + columns ----
  const tables = collectTables();
  for (const t of tables) {
    const cfg = getTableConfig(t);
    if (cfg.schema && cfg.schema !== "public") {
      skipped.push(`table ${cfg.name} (non-public schema ${cfg.schema})`);
      continue;
    }
    const live = liveColumns.get(cfg.name);
    if (!live) {
      // Brand-new table: full CREATE.
      const colDefs = cfg.columns.map((c) => renderColumnDef(c, true));
      const compositePk = cfg.primaryKeys[0];
      if (compositePk) {
        const cols = compositePk.columns.map((c) => q(c.name)).join(", ");
        colDefs.push(`PRIMARY KEY (${cols})`);
      }
      await run(
        `CREATE TABLE IF NOT EXISTS ${q(cfg.name)} (\n  ${colDefs.join(",\n  ")}\n)`,
        `table ${cfg.name}`,
      );
    } else {
      // Existing table: add any missing columns.
      for (const c of cfg.columns) {
        if (!live.has(c.name)) {
          await run(
            `ALTER TABLE ${q(cfg.name)} ADD COLUMN IF NOT EXISTS ${renderColumnDef(c, false)}`,
            `column ${cfg.name}.${c.name}`,
          );
        }
      }
    }
  }

  // ---- 3. Foreign keys for newly created tables (best-effort) ----
  for (const t of tables) {
    const cfg = getTableConfig(t);
    if (liveColumns.has(cfg.name)) continue; // pre-existing table; leave FKs alone
    for (const fk of cfg.foreignKeys) {
      const ref = fk.reference();
      const cols = ref.columns.map((c) => q(c.name)).join(", ");
      const refTable = getTableConfig(ref.foreignTable as PgTable).name;
      const refCols = ref.foreignColumns.map((c) => q(c.name)).join(", ");
      const name = fk.getName();
      if (liveIndexes.has(name)) continue;
      const fkMeta = fk as unknown as { onDelete?: string; onUpdate?: string };
      const onDelete = fkMeta.onDelete ? ` ON DELETE ${fkMeta.onDelete}` : "";
      const onUpdate = fkMeta.onUpdate ? ` ON UPDATE ${fkMeta.onUpdate}` : "";
      await run(
        `ALTER TABLE ${q(cfg.name)} ADD CONSTRAINT ${q(name)} FOREIGN KEY (${cols}) REFERENCES ${q(refTable)} (${refCols})${onDelete}${onUpdate}`,
        `fk ${name}`,
      );
    }
  }

  // ---- 4. Indexes (btree, incl. partial + expression) ----
  for (const t of tables) {
    const cfg = getTableConfig(t);
    for (const idx of cfg.indexes) {
      const c = idx.config;
      const name = c.name;
      if (!name || liveIndexes.has(name)) continue;
      const method = (c.method ?? "btree").toLowerCase();

      // Vector indexes (hnsw / ivfflat) need pgvector operator classes and a
      // matching halfvec column shape; they're (re)built model-keyed by the
      // reembed-chunks pipeline, never here. Surface, don't guess.
      if (method !== "btree") {
        skipped.push(`index ${name} (${method}) — managed by reembed pipeline`);
        continue;
      }

      // Render each column: plain columns by name, expression columns from
      // their SQL metadata. A non-renderable expression (bound params) aborts
      // this index — we never inline an unbound parameter.
      const renderedCols: string[] = [];
      let columnsRenderable = true;
      for (const col of c.columns) {
        const plainName = (col as { name?: unknown }).name;
        if (typeof plainName === "string") {
          renderedCols.push(q(plainName));
        } else {
          const rendered = renderSqlFragment(col as unknown as SQL);
          if (rendered === null) {
            columnsRenderable = false;
            break;
          }
          renderedCols.push(rendered);
        }
      }

      // Partial index predicate (WHERE …), if any.
      let whereClause = "";
      if (c.where) {
        const rendered = renderSqlFragment(c.where);
        if (rendered === null) {
          skipped.push(`index ${name} (partial) — predicate not statically renderable`);
          continue;
        }
        whereClause = ` WHERE ${rendered}`;
      }

      if (!columnsRenderable) {
        skipped.push(`index ${name} (expression) — column not statically renderable`);
        continue;
      }

      const unique = c.unique ? "UNIQUE " : "";
      await run(
        `CREATE ${unique}INDEX IF NOT EXISTS ${q(name)} ON ${q(cfg.name)} (${renderedCols.join(", ")})${whereClause}`,
        `index ${name}${whereClause ? " (partial)" : ""}`,
      );
    }
  }

  // ---- 5. Report destructive drift (never auto-applied) ----
  const schemaTableNames = new Set(tables.map((t) => getTableConfig(t).name));
  const schemaColsByTable = new Map<string, Set<string>>();
  for (const t of tables) {
    const cfg = getTableConfig(t);
    schemaColsByTable.set(cfg.name, new Set(cfg.columns.map((c) => c.name)));
  }
  for (const [table, cols] of liveColumns) {
    if (!schemaTableNames.has(table)) continue; // legacy/unmanaged table — expected
    const schemaCols = schemaColsByTable.get(table)!;
    for (const col of cols) {
      if (!schemaCols.has(col)) {
        warnings.push(
          `drift: column ${table}.${col} exists in DB but not in schema (left in place — drop by hand if intended)`,
        );
      }
    }
  }

  log(`Applied ${applied.length}, skipped ${skipped.length}, warnings ${warnings.length}.`);
  return { applied, skipped, warnings };
}
