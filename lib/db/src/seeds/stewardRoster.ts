/**
 * Shared, idempotent steward-roster boot seed.
 *
 * Publishing migrates schema, not row data, so steward assignments made in the
 * dev database never reach production on their own, and the sign-in allowlist
 * (AUTO_STEWARD_MEMBERSHIPS in facultyAuth) only fires when the person
 * actually signs in. This seed makes the named stewards exist — visible on
 * the roster and public steward surfaces — on every boot, in dev AND prod.
 *
 * Operator directive (July 2026): put the published Stanford Lifestyle
 * Medicine pillar Heads on the pillars that received the imported SLM
 * newsletter articles, EXCEPT gratitude-purpose (deliberately left
 * unstewarded) and sleep (Jamie Zeitzer already stewards it via the sleep
 * seed). Karen Parker (Autism) stewards a pillar outside the Stanford
 * Lifestyle Medicine program.
 *
 * Conventions (mirrors seed-stanford-faculty):
 *   - people are bootstrapped with the `pending:<email>` clerk-id convention;
 *     a real first sign-in reconciles onto the row (matched by email) and the
 *     seed never clobbers a reconciled (non-pending) row's email/clerk id;
 *   - emails mirror seed-stanford-faculty's emailFor()/EMAIL_OVERRIDES so rows
 *     seeded by either path resolve to the same person;
 *   - membership upsert sets role='steward' (the seed list is the source of
 *     truth for these grants — remove an entry to stop re-granting);
 *   - institution is backfilled ONLY when currently NULL, so a steward's or
 *     admin's later edit is never reverted;
 *   - operator accounts are matched by EMAIL ONLY (never by name) so they can
 *     never collide with the other same-named operator accounts.
 */
import { pool } from "../index";

export interface StewardRosterLog {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface StewardEntry {
  name: string;
  email: string;
  pillarSlug: string;
  /** Backfilled only when the resolved row's institution is NULL. */
  institution?: string;
  /** Object-storage headshot ("/objects/..." path). Backfilled only when the
   *  resolved row's photo_url is NULL — a steward's own upload is never
   *  reverted. */
  photoUrl?: string;
  /** Match by email only — required for operator accounts whose display name
   *  collides with other accounts of the same person. */
  matchEmailOnly?: boolean;
  /** Tavus replica used when this steward is selected for a video conversation. */
  tavusReplicaId?: string;
}

/**
 * The steward roster ensured at boot. Sleep (Jamie Zeitzer, via seeds/sleep),
 * gratitude-purpose (deliberately unstewarded), and dementia (deliberately
 * unstewarded — backed by ADRC resource links, no RAG corpus steward) are
 * intentionally absent.
 */
export const STEWARD_ROSTER: StewardEntry[] = [
  // Published Stanford Lifestyle Medicine pillar Heads --------------------
  {
    name: "Anne Friedlander",
    email: "friedlan@stanford.edu",
    pillarSlug: "movement",
    institution: "Stanford Lifestyle Medicine",
    photoUrl: "/objects/stewards/anne-friedlander.png",
  },
  {
    name: "Michael Fredericson",
    email: "mfred2@stanford.edu",
    pillarSlug: "movement",
    institution: "Stanford Lifestyle Medicine",
    photoUrl: "/objects/stewards/michael-fredericson.jpg",
  },
  {
    name: "Marily Oppezzo",
    email: "marily.oppezzo@stanford.edu",
    pillarSlug: "nutrition",
    institution: "Stanford Lifestyle Medicine",
    photoUrl: "/objects/stewards/marily-oppezzo.jpg",
  },
  {
    name: "Sarah Meyer Tapia",
    email: "sarah.meyer.tapia@stanford.edu",
    pillarSlug: "stress-management",
    institution: "Stanford Lifestyle Medicine",
    photoUrl: "/objects/stewards/sarah-meyer-tapia.png",
  },
  {
    name: "Shaliza Shorey",
    email: "shaliza.shorey@stanford.edu",
    pillarSlug: "cognitive-enhancement",
    institution: "Stanford Lifestyle Medicine",
    photoUrl: "/objects/stewards/shaliza-shorey.png",
  },
  {
    name: "Steven Crane",
    email: "steven.crane@stanford.edu",
    pillarSlug: "social-connection",
    institution: "Stanford Lifestyle Medicine",
    photoUrl: "/objects/stewards/steven-crane.png",
  },
  // America's Finest Experts — Stanford ecosystem, NOT Stanford Lifestyle
  // Medicine ---------------------------------------------------------------
  {
    name: "Karen Parker",
    email: "kjparker@stanford.edu",
    pillarSlug: "autism",
    institution: "Stanford Medicine · America's Finest Experts",
  },
  // AI Lab ------------------------------------------------------------------
  {
    name: "Karan Dehghani",
    email: "kdegani@stanford.edu",
    pillarSlug: "slm-ai-lab",
    institution: "Stanford Lifestyle Medicine",
    matchEmailOnly: true,
    tavusReplicaId: "r71358a4beab",
  },
];

export interface EnsuredSteward {
  email: string;
  pillarSlug: string;
  userId: number;
  pillarId: number;
}

export interface StewardRosterResult {
  ensured: EnsuredSteward[];
  /** Pillar slugs that could not be resolved (entry skipped with a warn). */
  skippedPillars: string[];
}

/**
 * Ensure one steward: resolve/create the faculty_users row, grant the steward
 * membership, and backfill institution when NULL. Returns null when the
 * entry's pillar does not exist (the caller logs + skips — this seed never
 * creates pillars; CANONICAL_PILLARS bootstrap owns that).
 */
export async function ensureSteward(
  entry: StewardEntry,
  log: StewardRosterLog = {},
): Promise<EnsuredSteward | null> {
  const info = log.info ?? (() => {});
  const warn = log.warn ?? (() => {});

  const pillar = await pool.query<{ id: number }>(
    `SELECT id FROM pillars WHERE slug = $1 LIMIT 1`,
    [entry.pillarSlug],
  );
  if (!pillar.rows[0]) {
    warn(
      `steward roster: pillar "${entry.pillarSlug}" not found — skipping ${entry.name}`,
    );
    return null;
  }
  const pillarId = pillar.rows[0].id;

  // Same precedence as seed-stanford-faculty: exact email
  // beats a name-only match; a real (reconciled) row beats a pending
  // placeholder; oldest id as final tiebreaker.
  const found = entry.matchEmailOnly
    ? await pool.query<{ id: number; clerk_user_id: string }>(
        `SELECT id, clerk_user_id FROM faculty_users
           WHERE lower(email) = lower($1)
           ORDER BY
             (CASE WHEN clerk_user_id LIKE 'pending:%' THEN 1 ELSE 0 END),
             id ASC
           LIMIT 1`,
        [entry.email],
      )
    : await pool.query<{ id: number; clerk_user_id: string }>(
        `SELECT id, clerk_user_id FROM faculty_users
           WHERE lower(email) = lower($1) OR lower(full_name) = lower($2)
           ORDER BY
             (CASE WHEN lower(email) = lower($1) THEN 0 ELSE 1 END),
             (CASE WHEN clerk_user_id LIKE 'pending:%' THEN 1 ELSE 0 END),
             id ASC
           LIMIT 1`,
        [entry.email, entry.name],
      );

  let userId: number;
  if (found.rows[0]) {
    userId = found.rows[0].id;
    const real = !found.rows[0].clerk_user_id.startsWith("pending:");
    if (real) {
      // Real reconciled user: only ever backfill a missing display name;
      // never touch their real email / clerk id.
      await pool.query(
        `UPDATE faculty_users SET full_name = COALESCE(full_name, $2) WHERE id = $1`,
        [userId, entry.name],
      );
    } else {
      // The pending guard closes a boot-time race: if the user's first
      // sign-in reconciles this placeholder between our SELECT and UPDATE,
      // we must not revert their real clerk id back to pending.
      await pool.query(
        `UPDATE faculty_users
           SET full_name = $2, email = $3, clerk_user_id = $4
           WHERE id = $1 AND clerk_user_id LIKE 'pending:%'`,
        [userId, entry.name, entry.email, `pending:${entry.email}`],
      );
    }
    info(`  steward: ${entry.name} → ${entry.pillarSlug} (id=${userId})`);
  } else {
    const created = await pool.query<{ id: number }>(
      `INSERT INTO faculty_users (clerk_user_id, email, full_name)
         VALUES ($1, $2, $3)
       RETURNING id`,
      [`pending:${entry.email}`, entry.email, entry.name],
    );
    userId = created.rows[0].id;
    info(`  + steward: ${entry.name} → ${entry.pillarSlug} (id=${userId})`);
  }

  if (entry.institution) {
    // Backfill only — a steward's or admin's later edit is never reverted.
    await pool.query(
      `UPDATE faculty_users SET institution = $2
         WHERE id = $1 AND institution IS NULL`,
      [userId, entry.institution],
    );
  }

  if (entry.photoUrl) {
    // Backfill only — a steward's own headshot upload is never reverted.
    await pool.query(
      `UPDATE faculty_users SET photo_url = $2
         WHERE id = $1 AND photo_url IS NULL`,
      [userId, entry.photoUrl],
    );
  }

  if (entry.tavusReplicaId) {
    // Backfill only. The boot seed owns the initial replica mapping, but a
    // steward can later replace it in the faculty portal without this seed
    // reverting that deliberate change.
    await pool.query(
      `UPDATE faculty_users SET tavus_replica_id = $2
         WHERE id = $1 AND tavus_replica_id IS NULL`,
      [userId, entry.tavusReplicaId],
    );
  }

  await pool.query(
    `INSERT INTO faculty_memberships (user_id, pillar_id, role)
       VALUES ($1, $2, 'steward')
     ON CONFLICT (user_id, pillar_id) DO UPDATE SET role = 'steward'`,
    [userId, pillarId],
  );

  return { email: entry.email, pillarSlug: entry.pillarSlug, userId, pillarId };
}

/** Run the full roster. Idempotent; safe to fire on every boot. */
export async function seedStewardRoster(
  log: StewardRosterLog = {},
): Promise<StewardRosterResult> {
  const ensured: EnsuredSteward[] = [];
  const skippedPillars: string[] = [];

  // Headshot backfill for stewards seeded elsewhere (Jamie Zeitzer arrives
  // via the sleep seed, not this roster). Only-if-NULL, matched by email.
  const PHOTO_ONLY_BACKFILL: Record<string, string> = {
    "jzeitzer@stanford.edu": "/objects/stewards/jamie-zeitzer.jpg",
  };
  for (const [email, photoUrl] of Object.entries(PHOTO_ONLY_BACKFILL)) {
    try {
      await pool.query(
        `UPDATE faculty_users SET photo_url = $2
           WHERE lower(email) = lower($1) AND photo_url IS NULL`,
        [email, photoUrl],
      );
    } catch (err) {
      (log.warn ?? (() => {}))(
        `steward roster: photo backfill failed for ${email}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  for (const entry of STEWARD_ROSTER) {
    try {
      const result = await ensureSteward(entry, log);
      if (result) {
        ensured.push(result);
      } else {
        skippedPillars.push(entry.pillarSlug);
      }
    } catch (err) {
      // Per-entry isolation ensures one collision does not skip the remaining
      // roster entries for this boot.
      (log.warn ?? (() => {}))(
        `steward roster: failed for ${entry.email} → ${entry.pillarSlug}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return { ensured, skippedPillars };
}
