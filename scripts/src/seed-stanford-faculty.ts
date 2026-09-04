/**
 * Seed the faculty roster from Stanford Lifestyle Medicine's public team page
 * (https://lifestylemedicine.stanford.edu/lifestyle-team/).
 *
 * Populates the seven Stanford Lifestyle Medicine pillars, the people listed
 * under each pillar, and a steward (the pillar Head / Co-Heads) per pillar.
 *
 * Idempotent: re-running upserts pillars (by slug), faculty users (deduped by
 * full name, then email), and memberships (by user+pillar). Safe to run against
 * any environment via DATABASE_URL.
 *
 *   pnpm --filter @workspace/scripts run seed-stanford-faculty
 *   pnpm --filter @workspace/scripts run seed-stanford-faculty -- --dry-run
 *
 * IMPORTANT: this seeds the database directly. It never sends invitation
 * emails — real people are not contacted. Placeholder faculty rows use the
 * `pending:<email>` clerk-id convention; on a real first sign-in the auth
 * middleware reconciles the row by matching email. Where a person's real
 * Stanford sunet email is already known to the platform (auto-steward
 * bootstrap / existing demo seed) we reuse it so the rows line up.
 */

import { pool } from "@workspace/db";

const DRY_RUN = process.argv.slice(2).includes("--dry-run");

type Role = "steward" | "contributor" | "advisor" | "viewer";

interface PillarSeed {
  slug: string;
  name: string;
  description: string;
}

/** The seven active Stanford Lifestyle Medicine pillars. */
const PILLARS: PillarSeed[] = [
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

/**
 * Additional active pillars stewarded by individual experts outside Stanford
 * Lifestyle Medicine's seven-pillar program. Seeded active (un-retired) with
 * their steward, exactly like the LM pillars. Their stewards are also wired
 * into the auto-steward allowlist so they self-provision on first sign-in.
 */
const EXTRA_PILLARS: PillarSeed[] = [
  {
    slug: "autism",
    name: "Autism",
    description:
      "Stanford-attributable autism & behavioral science — Karen Parker",
  },
  {
    slug: "slm-ai-lab",
    name: "AI Lab for Education and Leadership",
    description:
      "Artificial intelligence for education, scientific literacy, institutional leadership, and accountable decision-making.",
  },
];

/**
 * Pillars previously seeded that are NOT currently offered. Soft-retire them
 * (reversible, preserves any content). Restore any in /admin → Pillars if
 * still wanted. NOTE: `communication` (Allison Kluger), `strategic-communication`
 * (Matt Abrahams) and `autism` (Karen Parker) are ACTIVE stewarded pillars and
 * must NOT be listed here.
 */
const RETIRE_SLUGS = ["avoidance-of-risky-substances"];

/**
 * Real emails already known to the platform (auto-steward bootstrap / demo
 * seed). Reused so seeded rows reconcile with the real users on first sign-in
 * instead of creating duplicates.
 */
const EMAIL_OVERRIDES: Record<string, string> = {
  "Michael Fredericson": "mfred2@stanford.edu",
  "Anne Friedlander": "friedlan@stanford.edu",
  "Jamie Zeitzer": "jzeitzer@stanford.edu",
  "Karen Parker": "kjparker@stanford.edu",
};

interface PersonSeed {
  name: string;
  role: Role;
}

/** Roster per pillar, transcribed from the Stanford LM team page. */
const ROSTER: Record<string, PersonSeed[]> = {
  movement: [
    { name: "Anne Friedlander", role: "steward" }, // Head
    { name: "Michael Fredericson", role: "contributor" },
    { name: "Jonathan Bonnet", role: "contributor" },
    { name: "Marcia Stefanick", role: "contributor" },
    { name: "Robert C. Oh", role: "contributor" },
    { name: "Levi Frehlich", role: "contributor" },
    { name: "Corey Rovzar", role: "contributor" },
    { name: "Peter Park", role: "contributor" },
    { name: "Kelly Starrett", role: "contributor" },
    { name: "Juliet Starrett", role: "contributor" },
    { name: "Tala Khalaf", role: "contributor" },
    { name: "Keith Baar", role: "contributor" },
    { name: "Brooke Gurland", role: "contributor" },
    { name: "M. Javad Ershad", role: "contributor" },
  ],
  nutrition: [
    { name: "Marily Oppezzo", role: "steward" }, // Head
    { name: "Stacy Sims", role: "contributor" },
    { name: "Michelle Hauser", role: "contributor" },
    { name: "Rachele Pojednic", role: "contributor" },
    { name: "Jessica Hope", role: "contributor" },
    { name: "Ken Vereschagin", role: "contributor" },
    { name: "Carlie Arbaugh", role: "contributor" },
    { name: "Beth Gillepsie", role: "contributor" },
    { name: "Cindy Kin", role: "contributor" },
    { name: "Sean Spencer", role: "contributor" },
  ],
  sleep: [
    { name: "Cheri Mah", role: "steward" }, // Co-Head
    { name: "Jamie Zeitzer", role: "steward" }, // Co-Head
    { name: "Rafael Pelayo", role: "contributor" },
    { name: "Katie Cederberg", role: "contributor" },
  ],
  "cognitive-enhancement": [
    { name: "Shaliza Shorey", role: "steward" }, // Head
    { name: "Douglas Noordsy", role: "contributor" },
    { name: "Maris Loeffler", role: "contributor" },
    { name: "Fanglin Zhang", role: "contributor" },
  ],
  "social-connection": [
    { name: "Steven Crane", role: "steward" }, // Head
    { name: "Rusly Harsono", role: "contributor" },
    { name: "David Shi-Ann Chang", role: "contributor" },
    { name: "BJ Fogg", role: "contributor" },
    { name: "Ann Hsing", role: "contributor" },
  ],
  "stress-management": [
    { name: "Sarah Meyer Tapia", role: "steward" }, // Head
    { name: "Alia Crum", role: "contributor" },
    { name: "Eva Weinlander", role: "contributor" },
    { name: "Sharon Brock", role: "contributor" },
  ],
  "gratitude-purpose": [
    { name: "Bruce Feldstein", role: "steward" }, // Co-Head
    { name: "Barbara Waxman", role: "steward" }, // Co-Head
    { name: "Akivah Dixon Northern", role: "contributor" },
    { name: "Lisa Shah", role: "contributor" },
    { name: "Diane Friedlaender", role: "contributor" },
  ],
  autism: [{ name: "Karen Parker", role: "steward" }],
};

function emailFor(name: string): string {
  if (EMAIL_OVERRIDES[name]) return EMAIL_OVERRIDES[name];
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "");
  return `${slug}@stanford.edu`;
}

async function upsertPillar(p: PillarSeed): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO pillars (slug, name, description, retired_at)
       VALUES ($1, $2, $3, NULL)
     ON CONFLICT (slug) DO UPDATE
       SET name = EXCLUDED.name,
           description = EXCLUDED.description,
           retired_at = NULL
     RETURNING id`,
    [p.slug, p.name, p.description],
  );
  return rows[0].id;
}

/**
 * Find an existing faculty user by full name (case-insensitive) or email.
 * Returns the row id and whether the stored clerk id is a real (non-pending)
 * id, so we never clobber a reconciled user's email/clerk id.
 */
async function findUser(
  name: string,
  email: string,
): Promise<{ id: number; real: boolean } | null> {
  // Deterministic precedence so mixed-state DBs (a pending placeholder AND a
  // reconciled row for the same person, or a same-name collision) always
  // resolve to the right row:
  //   1. exact email match beats a name-only match (email is the stable key);
  //   2. a real (non-`pending:`) row beats a pending placeholder;
  //   3. oldest id as a final tiebreaker.
  const { rows } = await pool.query<{ id: number; clerk_user_id: string }>(
    `SELECT id, clerk_user_id FROM faculty_users
       WHERE lower(full_name) = lower($1) OR lower(email) = lower($2)
       ORDER BY
         (CASE WHEN lower(email) = lower($2) THEN 0 ELSE 1 END),
         (CASE WHEN clerk_user_id LIKE 'pending:%' THEN 1 ELSE 0 END),
         id ASC
       LIMIT 1`,
    [name, email],
  );
  if (rows.length === 0) return null;
  return {
    id: rows[0].id,
    real: !rows[0].clerk_user_id.startsWith("pending:"),
  };
}

async function upsertUser(name: string): Promise<number> {
  const email = emailFor(name);
  const existing = await findUser(name, email);
  if (existing) {
    if (existing.real) {
      // Real reconciled user: only ensure the display name is set; never touch
      // their real email / clerk id.
      await pool.query(
        `UPDATE faculty_users SET full_name = COALESCE(full_name, $2) WHERE id = $1`,
        [existing.id, name],
      );
    } else {
      await pool.query(
        `UPDATE faculty_users
           SET full_name = $2, email = $3, clerk_user_id = $4
           WHERE id = $1`,
        [existing.id, name, email, `pending:${email}`],
      );
    }
    return existing.id;
  }
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name)
       VALUES ($1, $2, $3)
     RETURNING id`,
    [`pending:${email}`, email, name],
  );
  return rows[0].id;
}

async function upsertMembership(userId: number, pillarId: number, role: Role) {
  await pool.query(
    `INSERT INTO faculty_memberships (user_id, pillar_id, role)
       VALUES ($1, $2, $3)
     ON CONFLICT (user_id, pillar_id) DO UPDATE SET role = EXCLUDED.role`,
    [userId, pillarId, role],
  );
}

async function main() {
  const allPillars = [...PILLARS, ...EXTRA_PILLARS];

  if (DRY_RUN) {
    console.log("[dry-run] no writes will be made\n");
    for (const p of allPillars) {
      const people = ROSTER[p.slug] ?? [];
      const stewards = people.filter((x) => x.role === "steward");
      console.log(
        `${p.name} (${p.slug}) — ${people.length} people, steward(s): ${stewards
          .map((s) => s.name)
          .join(", ")}`,
      );
    }
    console.log(`\nWould retire: ${RETIRE_SLUGS.join(", ")}`);
    await pool.end();
    return;
  }

  let pillarCount = 0;
  let memberCount = 0;

  for (const p of allPillars) {
    const pillarId = await upsertPillar(p);
    pillarCount++;
    const people = ROSTER[p.slug] ?? [];
    for (const person of people) {
      const userId = await upsertUser(person.name);
      await upsertMembership(userId, pillarId, person.role);
      memberCount++;
    }
    const stewards = people
      .filter((x) => x.role === "steward")
      .map((x) => x.name);
    console.log(
      `✓ ${p.name}: ${people.length} members · steward(s): ${stewards.join(", ")}`,
    );
  }

  // Soft-retire non-Stanford pillars so the active roster matches Stanford's
  // published seven pillars. Reversible; content is preserved.
  const retire = await pool.query(
    `UPDATE pillars SET retired_at = NOW()
       WHERE slug = ANY($1::text[]) AND retired_at IS NULL
     RETURNING slug`,
    [RETIRE_SLUGS],
  );
  if (retire.rows.length > 0) {
    console.log(
      `↪ retired (soft) non-Stanford pillars: ${retire.rows
        .map((r) => r.slug)
        .join(", ")}`,
    );
  }

  console.log(
    `\nDone. ${pillarCount} pillars ensured, ${memberCount} memberships upserted.`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
