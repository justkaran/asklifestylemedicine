import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

// Read the manifest directly so the Node-only migration tools cannot drift from
// the TypeScript allowlist. The manifest deliberately uses one quoted item per
// line, making this dependency-free extraction reviewable.
const slmManifestSource = await readFile(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../src/schema/slm.ts",
  ),
  "utf8",
);

function manifestNames(section) {
  const sectionMatch = slmManifestSource.match(
    new RegExp(`${section}: \\[([\\s\\S]*?)\\n  \\],`),
  );
  if (!sectionMatch) {
    throw new Error(`Could not read ${section} from slmSchemaManifest`);
  }
  const names = [...sectionMatch[1].matchAll(/"([^"]+)"/g)].map(
    (match) => match[1],
  );
  if (names.length === 0 || new Set(names).size !== names.length) {
    throw new Error(`Invalid ${section} list in slmSchemaManifest`);
  }
  return names.sort();
}

export const slmTables = manifestNames("tables");
export const slmEnums = manifestNames("enums");

export const canonicalLifestyleMedicinePillars = [
  {
    slug: "movement",
    name: "Movement & Exercise",
    description:
      "Movement is essential for physical and mental health. Cardiovascular and muscle-strengthening activity optimizes health and longevity.",
  },
  {
    slug: "nutrition",
    name: "Healthful Nutrition",
    description:
      "Evidence-based dietary habits that support long-term health, empowering educated and enjoyable nutrition decisions.",
  },
  {
    slug: "sleep",
    name: "Restorative Sleep",
    description:
      "Sleep is key for full-body restoration. Optimizing sleep improves health outcomes, intellectual function, and mood.",
  },
  {
    slug: "stress-management",
    name: "Stress Management",
    description:
      "Evaluating external stressors and learning stress-management techniques to modulate the body's stress response.",
  },
  {
    slug: "social-connection",
    name: "Social Engagement",
    description:
      "Humans are wired to connect. Social connection — family, friends, community, even strangers — supports health and longevity.",
  },
  {
    slug: "cognitive-enhancement",
    name: "Cognitive Enhancement",
    description:
      "Cognitive engagement as a key lever for healthy aging and long-term brain performance.",
  },
  {
    slug: "gratitude-purpose",
    name: "Gratitude & Purpose",
    description:
      "Cultivating joy, gratitude, and purpose as tools for mental and physical well-being.",
  },
];

export function validateCanonicalPillars() {
  const expectedSlugs = [
    "movement",
    "nutrition",
    "sleep",
    "stress-management",
    "social-connection",
    "cognitive-enhancement",
    "gratitude-purpose",
  ];
  const actualSlugs = canonicalLifestyleMedicinePillars.map(
    (pillar) => pillar.slug,
  );
  if (
    actualSlugs.length !== expectedSlugs.length ||
    new Set(actualSlugs).size !== expectedSlugs.length ||
    actualSlugs.some((slug, index) => slug !== expectedSlugs[index])
  ) {
    throw new Error(
      "Canonical Lifestyle Medicine pillar seed must contain exactly the seven approved slugs",
    );
  }
}

export async function validateMigrationFiles() {
  validateCanonicalPillars();
  const metadataDirectory = path.join(migrationsDirectory, "meta");
  const journalPath = path.join(metadataDirectory, "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));

  if (journal.version !== "7" || journal.dialect !== "postgresql") {
    throw new Error(
      `Unsupported migration journal format: version=${journal.version}, dialect=${journal.dialect}`,
    );
  }
  if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
    throw new Error("Migration journal must contain at least one entry");
  }

  const directoryEntries = await readdir(migrationsDirectory, {
    withFileTypes: true,
  });
  const sqlFiles = directoryEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
  const expectedSqlFiles = journal.entries
    .map((entry, index) => {
      if (
        entry.idx !== index ||
        typeof entry.when !== "number" ||
        !/^\d{4}_[a-z0-9_]+$/.test(entry.tag) ||
        entry.breakpoints !== true
      ) {
        throw new Error(`Invalid migration journal entry at index ${index}`);
      }
      if (index > 0 && entry.when <= journal.entries[index - 1].when) {
        throw new Error(
          "Migration journal timestamps must be strictly increasing",
        );
      }
      return `${entry.tag}.sql`;
    })
    .sort();

  if (JSON.stringify(sqlFiles) !== JSON.stringify(expectedSqlFiles)) {
    throw new Error(
      `Migration SQL files do not match the journal (expected ${expectedSqlFiles.join(", ")}, found ${sqlFiles.join(", ")})`,
    );
  }

  const metadataEntries = await readdir(metadataDirectory, {
    withFileTypes: true,
  });
  const snapshotFiles = metadataEntries
    .filter(
      (entry) => entry.isFile() && /^\d{4}_snapshot\.json$/.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
  const expectedSnapshotFiles = journal.entries.map(
    (entry) => `${String(entry.idx).padStart(4, "0")}_snapshot.json`,
  );
  if (JSON.stringify(snapshotFiles) !== JSON.stringify(expectedSnapshotFiles)) {
    throw new Error(
      `Migration snapshots do not match the journal (expected ${expectedSnapshotFiles.join(", ")}, found ${snapshotFiles.join(", ")})`,
    );
  }

  let previousSnapshotId = "00000000-0000-0000-0000-000000000000";
  for (const file of snapshotFiles) {
    const snapshot = JSON.parse(
      await readFile(path.join(metadataDirectory, file), "utf8"),
    );
    if (
      snapshot.version !== journal.version ||
      snapshot.dialect !== journal.dialect ||
      snapshot.prevId !== previousSnapshotId ||
      typeof snapshot.id !== "string" ||
      snapshot.id.length === 0
    ) {
      throw new Error(`Invalid or disconnected migration snapshot: ${file}`);
    }
    previousSnapshotId = snapshot.id;
  }

  const finalSnapshot = JSON.parse(
    await readFile(
      path.join(metadataDirectory, snapshotFiles[snapshotFiles.length - 1]),
      "utf8",
    ),
  );
  const snapshotTableNames = Object.keys(finalSnapshot.tables);
  if (snapshotTableNames.some((table) => !table.startsWith("public."))) {
    throw new Error(
      "Stanford/SLM migration tables must be in the public schema",
    );
  }
  const baselineTables = snapshotTableNames
    .map((table) => table.slice("public.".length))
    .sort();
  if (JSON.stringify(baselineTables) !== JSON.stringify(slmTables)) {
    const unexpected = baselineTables.filter(
      (table) => !slmTables.includes(table),
    );
    const missing = slmTables.filter(
      (table) => !baselineTables.includes(table),
    );
    throw new Error(
      `Stanford/SLM migration table boundary differs from slmSchemaManifest (unexpected: ${unexpected.join(", ") || "none"}; missing: ${missing.join(", ") || "none"})`,
    );
  }

  for (const file of sqlFiles) {
    const sql = await readFile(path.join(migrationsDirectory, file), "utf8");
    if (sql.trim().length === 0) {
      throw new Error(`Migration is empty: ${file}`);
    }
    if (!sql.includes("--> statement-breakpoint")) {
      throw new Error(
        `Migration has no Drizzle statement breakpoints: ${file}`,
      );
    }
  }

  return { journal, sqlFiles, snapshotFiles };
}
