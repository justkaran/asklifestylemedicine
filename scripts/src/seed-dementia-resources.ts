/**
 * Dementia pillar resource seed — idempotent, additive, INSERT-ONLY by URL.
 *
 * Populates `pillar_resources` with curated Stanford ADRC pages for the
 * `dementia` pillar. The dementia pillar has no RAG corpus; on UNCOVERED the
 * agent surfaces these links as a "Learn more from Stanford's ADRC" panel.
 *
 * Safety rules:
 *   - INSERT ON CONFLICT DO NOTHING (keyed on url) — never overwrites operator edits.
 *   - Skips silently when the dementia pillar does not exist yet.
 *   - Safe to re-run at any time (called from post-merge.sh after each deploy).
 *
 * Run: pnpm --filter @workspace/scripts run seed-dementia-resources
 */
import { pool } from "@workspace/db";

interface ResourceEntry {
  title: string;
  url: string;
  description: string;
  category: string;
  displayOrder: number;
}

const ADRC_RESOURCES: ResourceEntry[] = [
  {
    title: "Stanford Alzheimer's Disease Research Center",
    url: "https://med.stanford.edu/adrc.html",
    description:
      "The Stanford ADRC advances Alzheimer's research and care through cutting-edge science, clinical programs, and community outreach.",
    category: "About",
    displayOrder: 0,
  },
  {
    title: "Clinical Core: Diagnosis & Care",
    url: "https://med.stanford.edu/adrc/clinical-core.html",
    description:
      "Provides expert diagnosis, longitudinal assessment, and care for individuals with Alzheimer's disease and related dementias.",
    category: "Research",
    displayOrder: 1,
  },
  {
    title: "Biomarker Research",
    url: "https://med.stanford.edu/adrc/biomarker-core.html",
    description:
      "Develops and validates blood, imaging, and cerebrospinal-fluid biomarkers to detect Alzheimer's disease earlier and track its progression.",
    category: "Research",
    displayOrder: 2,
  },
  {
    title: "Neuropathology Core",
    url: "https://med.stanford.edu/adrc/neuropathology-core.html",
    description:
      "Characterizes brain tissue to understand the molecular and cellular changes that underlie Alzheimer's and related dementias.",
    category: "Research",
    displayOrder: 3,
  },
  {
    title: "Research Education Component",
    url: "https://med.stanford.edu/adrc/research-education-component.html",
    description:
      "Trains the next generation of dementia researchers through mentorship, seminars, and hands-on research opportunities.",
    category: "Education",
    displayOrder: 4,
  },
  {
    title: "Outreach, Recruitment & Engagement",
    url: "https://med.stanford.edu/adrc/outreach.html",
    description:
      "Connects patients, caregivers, and diverse communities with ADRC research studies and educational resources.",
    category: "Community",
    displayOrder: 5,
  },
  {
    title: "Community Advisory Board",
    url: "https://med.stanford.edu/adrc/community-advisory-board.html",
    description:
      "A board of patients, family members, and advocates who guide the ADRC's research priorities and community engagement efforts.",
    category: "Community",
    displayOrder: 6,
  },
];

async function main() {
  console.log("Seeding dementia pillar resources...");

  const pillarResult = await pool.query<{ id: number }>(
    `SELECT id FROM pillars WHERE slug = 'dementia' LIMIT 1`,
  );
  if (!pillarResult.rows[0]) {
    console.warn(
      "Dementia pillar not found — skipping seed. Ensure CANONICAL_PILLARS includes 'dementia' and the server has booted at least once.",
    );
    return;
  }
  const pillarId = pillarResult.rows[0].id;

  let inserted = 0;
  for (const r of ADRC_RESOURCES) {
    const res = await pool.query(
      `INSERT INTO pillar_resources (pillar_id, title, url, description, category, display_order)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (url) DO NOTHING`,
      [pillarId, r.title, r.url, r.description, r.category, r.displayOrder],
    );
    inserted += res.rowCount ?? 0;
  }

  console.log(
    `Done. ${inserted} new resource(s) inserted (${ADRC_RESOURCES.length - inserted} already present).`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
