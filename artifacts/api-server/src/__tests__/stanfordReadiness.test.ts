import { describe, expect, it } from "vitest";
import { slmSchemaManifest } from "@workspace/db/schema/slm";
import { isStanfordEdition } from "../lib/features";
import {
  assertStanfordDatabaseReady,
  DRIZZLE_MIGRATIONS_RELATION,
  type ReadonlyQueryable,
} from "../lib/stanfordReadiness";

function queryable(
  options: {
    vectorInstalled?: boolean;
    tables?: readonly string[];
    journalPresent?: boolean;
    migrationCount?: number;
  },
  queryLog?: string[],
): ReadonlyQueryable {
  const tables = options.tables ?? slmSchemaManifest.tables;
  return {
    async query(text) {
      queryLog?.push(text);
      if (text.includes("count(*)::text")) {
        return { rows: [{ count: String(options.migrationCount ?? 1) }] };
      }
      return {
        rows: [
          {
            vector_installed: options.vectorInstalled ?? true,
            table_names: [...tables],
            migration_journal_present: options.journalPresent ?? true,
          },
        ],
      };
    },
  };
}

describe("isStanfordEdition", () => {
  it("only enables Stanford mode for an explicit true value", () => {
    expect(isStanfordEdition({})).toBe(false);
    expect(isStanfordEdition({ STANFORD_EDITION: "false" })).toBe(false);
    expect(isStanfordEdition({ STANFORD_EDITION: " TRUE " })).toBe(true);
  });
});

describe("Stanford database readiness", () => {
  it("accepts a migrated database with the bounded schema", async () => {
    const queryLog: string[] = [];
    await expect(
      assertStanfordDatabaseReady(queryable({}, queryLog)),
    ).resolves.toBeUndefined();
    expect(queryLog.join("\n")).toContain(DRIZZLE_MIGRATIONS_RELATION);
    expect(queryLog.join("\n")).toContain("table_name::text");
  });

  it("reports missing prerequisites without exiting the process", async () => {
    await expect(
      assertStanfordDatabaseReady(
        queryable({
          vectorInstalled: false,
          tables: ["pillars"],
          journalPresent: false,
        }),
      ),
    ).rejects.toThrow(
      /vector extension.*required SLM tables.*migration journal/i,
    );
  });
});
