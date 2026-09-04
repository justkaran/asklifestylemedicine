import app from "./app";
import { logger } from "./lib/logger";
import { backfillBotIpFlags } from "./lib/botDetect";
import pool from "./lib/db";
import { ensureExtensions } from "@workspace/db";
import cron from "node-cron";
import {
  runMorningCheckins,
  runWeeklyPortraits,
  runNudgeEmails,
  runWeeklyReflections,
} from "./lib/jobs";
import { runStewardReviewDigest } from "./lib/interpretationDigestEmail";
import { runQueryClustering } from "./lib/clusterJobs";
import { runWeeklyCoverageDigest } from "./lib/coverageDigestEmail";
import { runDailyAnalyticsDigest } from "./lib/analyticsDigestEmail";
import { syncInvestorDecks } from "./lib/investorDecks";
import { seedEmpathy } from "./lib/empathySeed";
import { seedSlmArticlesAtBoot } from "./lib/slmArticlesSeed";
import { seedStripeProducts } from "./lib/stripeProductSeed";
import { seedStewardProducts } from "./lib/stewardBilling";
import { seedSleep } from "./lib/sleepSeed";
import { seedCorpusGapsContent } from "./lib/corpusGapsSeed";
import { seedStewards } from "./lib/stewardRosterSeed";
import { seedDistributionChannels } from "./lib/distributionChannelsSeed";
import { seedKlugerFramework } from "./lib/frameworksSeed";
import { consolidateZeitzerAccounts } from "./lib/consolidateZeitzer";
import {
  warmEmbedder,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  embeddingIndexName,
  embeddingSqlLiteral,
} from "./lib/embeddings";
import { pruneStaleEmailRateLimitHits } from "./middlewares/emailRateLimit";
import { runRetentionCleanup } from "./lib/retention";
import { runDailyResearchDiscovery } from "./lib/researchDiscovery";
import { reconcileReferralConversions } from "./routes/referral";
import { runMigrations } from "stripe-replit-sync";
import { getStripeSync, isStripeConnected } from "./lib/stripeClient";
import { isBillingEnabled, isStanfordEdition } from "./lib/features";
import { assertStanfordDatabaseReady } from "./lib/stanfordReadiness";
import {
  ensureOtlGovernancePage,
  ensureOtlSecurityPackagePage,
} from "./lib/otlGovernance";

const rawPort = process.env["PORT"];
const stanfordEdition = isStanfordEdition();

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

/**
 * Canonical pillar set the platform offers. The first seven are Stanford
 * Lifestyle Medicine's published pillars
 * (https://lifestylemedicine.stanford.edu/lifestyle-team/); the trailing three
 * are legacy/Palonur-specific pillars kept here so existing seeded content and
 * the auto-steward bootstrap still resolve them. Seeded idempotently in
 * migrate() so every pillar exists as a real row — including ones with no
 * faculty assigned yet — letting admins see and plan coverage for empty
 * pillars. Existing pillars are never modified (ON CONFLICT DO NOTHING); the
 * `seed-stanford-faculty` script curates names/people and soft-retires the
 * legacy pillars in each environment's database.
 */
const CANONICAL_PILLARS: Array<{
  slug: string;
  name: string;
  description: string;
}> = [
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
  {
    slug: "avoidance-of-risky-substances",
    name: "Avoidance of Risky Substances",
    description: "Stanford-attributable science on avoiding risky substances",
  },
  {
    slug: "communication",
    name: "Communication",
    description: "Stanford-attributable communication science",
  },
  {
    slug: "strategic-communication",
    name: "Strategic Communication",
    description:
      "Stanford-attributable strategic communication science — Matt Abrahams",
  },
  {
    slug: "autism",
    name: "Autism",
    description:
      "Stanford-attributable autism & behavioral science — Karen Parker",
  },
  {
    slug: "empathy",
    name: "Empathy",
    description:
      "The science of empathy as a learnable skill: how to read emotion, communicate compassion, and sustain care without burning out. Grounded in neuroscience and clinical research from Harvard Medical School.",
  },
  {
    slug: "slm-ai-lab",
    name: "AI Lab for Education and Leadership",
    description:
      "Artificial intelligence for education, scientific literacy, institutional leadership, and accountable decision-making.",
  },
  // Dementia & Alzheimer's — backed by Stanford ADRC resource links.
  // Deliberately unstewarded (same pattern as gratitude-purpose): this pillar
  // surfaces curated ADRC pointers on UNCOVERED rather than a RAG corpus.
  // The boot seed MUST NOT assign a steward row for this pillar.
  {
    slug: "dementia",
    name: "Dementia & Alzheimer's",
    description:
      "Alzheimer's disease and related dementias — resources from the Stanford Alzheimer's Disease Research Center (ADRC).",
  },
];

async function migrate() {
  await ensureExtensions();
  // A coach-video designation lives on its resource so a deletion or category
  // change has no orphaned public action. This is explicit boot DDL because
  // Publish applies the code bundle but not an interactive Drizzle push.
  await pool.query(`
    ALTER TABLE pillar_resources
      ADD COLUMN IF NOT EXISTS coach_lesson_id TEXT
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS pillar_resources_coach_lesson_idx
      ON pillar_resources (coach_lesson_id)
      WHERE coach_lesson_id IS NOT NULL
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS slides_state (
      id INTEGER PRIMARY KEY DEFAULT 1,
      deck_html TEXT,
      deleted_sids JSONB NOT NULL DEFAULT '[]',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT single_row CHECK (id = 1)
    )
  `);
  await pool.query(
    `INSERT INTO slides_state (id) VALUES (1) ON CONFLICT DO NOTHING`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dinner_edits (
      id INTEGER PRIMARY KEY DEFAULT 1,
      edits JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT dinner_single_row CHECK (id = 1)
    )
  `);
  await pool.query(
    `INSERT INTO dinner_edits (id) VALUES (1) ON CONFLICT DO NOTHING`,
  );

  // Public answer permalinks for the /slm ask surface (share links).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS slm_answer_links (
      id TEXT PRIMARY KEY,
      query_id UUID NOT NULL UNIQUE,
      question TEXT NOT NULL,
      answer_text TEXT NOT NULL,
      citations JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS palonur_users (
      id SERIAL PRIMARY KEY,
      first_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS palonur_sleep_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES palonur_users(id) ON DELETE CASCADE,
      log_date DATE NOT NULL,
      quality SMALLINT NOT NULL CHECK (quality BETWEEN 1 AND 5),
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, log_date)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS palonur_commitments (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES palonur_users(id) ON DELETE CASCADE,
      action_text TEXT NOT NULL,
      sleep_question TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS palonur_checkins (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES palonur_users(id) ON DELETE CASCADE,
      commitment_id INTEGER REFERENCES palonur_commitments(id) ON DELETE CASCADE,
      checkin_date DATE NOT NULL DEFAULT CURRENT_DATE,
      did_it BOOLEAN NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, commitment_id, checkin_date)
    )
  `);
  // Migrate legacy single-experiment uniqueness. Older deployments created the
  // table with UNIQUE(user_id, checkin_date), which silently overwrites
  // checkins across experiments now that a user can run several at once. Drop
  // the old constraint if present and ensure the per-commitment one exists.
  await pool.query(`
    ALTER TABLE palonur_checkins
      DROP CONSTRAINT IF EXISTS palonur_checkins_user_id_checkin_date_key
  `);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'palonur_checkins_user_id_commitment_id_checkin_date_key'
      ) THEN
        ALTER TABLE palonur_checkins
          ADD CONSTRAINT palonur_checkins_user_id_commitment_id_checkin_date_key
          UNIQUE (user_id, commitment_id, checkin_date);
      END IF;
    END $$;
  `);

  // Tonight's focus — which experiment the user pinned to lead their journey
  // for a given day. Scoped per user + day so the choice follows the user
  // across devices (localStorage is kept as an offline fallback on the client).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS palonur_tonights_focus (
      user_id INTEGER NOT NULL REFERENCES palonur_users(id) ON DELETE CASCADE,
      focus_date DATE NOT NULL,
      commitment_id INTEGER NOT NULL REFERENCES palonur_commitments(id) ON DELETE CASCADE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, focus_date)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS palonur_interactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES palonur_users(id) ON DELETE SET NULL,
      original_question TEXT NOT NULL,
      clarify_question TEXT,
      clarify_answer TEXT,
      final_question TEXT NOT NULL,
      ai_answer TEXT NOT NULL,
      article_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE palonur_commitments
      ADD COLUMN IF NOT EXISTS check_in_token UUID NOT NULL DEFAULT gen_random_uuid(),
      ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ
  `);

  await pool.query(`
    ALTER TABLE palonur_users
      ADD COLUMN IF NOT EXISTS email_opted_out BOOLEAN NOT NULL DEFAULT FALSE
  `);

  // Personalization job tracking
  await pool.query(`
    ALTER TABLE palonur_users
      ADD COLUMN IF NOT EXISTS last_portrait_sent_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_insight_sent_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_weekly_reflection_sent_at TIMESTAMPTZ
  `);

  // Weekly coaching loop — caches the (expensive) grounded RAG note once per
  // ISO week per user so repeated /journey loads and the weekly email reuse a
  // single generation. Stats are always recomputed live; only the note is
  // cached. `note` is NULL when the governed path declined to cover the week.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS palonur_weekly_reflections (
      user_id INTEGER NOT NULL REFERENCES palonur_users(id) ON DELETE CASCADE,
      week_start DATE NOT NULL,
      question TEXT NOT NULL,
      note JSONB,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, week_start)
    )
  `);

  // Timezone — captured silently from browser at registration
  await pool.query(`
    ALTER TABLE palonur_users
      ADD COLUMN IF NOT EXISTS timezone TEXT
  `);

  // Visitor analytics
  await pool.query(`
    CREATE TABLE IF NOT EXISTS palonur_pageviews (
      id SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      page TEXT NOT NULL,
      referrer TEXT,
      referrer_domain TEXT,
      device TEXT,
      ip TEXT,
      duration_ms INT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS palonur_pageviews_session ON palonur_pageviews (session_id);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS palonur_pageviews_created ON palonur_pageviews (created_at);
  `);
  await pool.query(`
    ALTER TABLE palonur_pageviews
      ADD COLUMN IF NOT EXISTS country TEXT,
      ADD COLUMN IF NOT EXISTS country_code TEXT,
      ADD COLUMN IF NOT EXISTS city TEXT,
      ADD COLUMN IF NOT EXISTS visitor_id TEXT
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS palonur_pageviews_visitor ON palonur_pageviews (visitor_id);
  `);
  // Bot/crawler flag — set at insert time from UA + IP; historical rows are
  // backfilled by IP range only (UA was never stored). The backfill is
  // idempotent (only flips FALSE→TRUE for matching ranges), so running it on
  // every boot is safe and also catches rows inserted by an older server
  // version during a rolling deploy.
  await pool.query(`
    ALTER TABLE palonur_pageviews
      ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT FALSE
  `);
  await backfillBotIpFlags(pool);
  // Landing-page video watch tracking
  await pool.query(`
    CREATE TABLE IF NOT EXISTS palonur_video_views (
      id SERIAL PRIMARY KEY,
      video TEXT NOT NULL,
      session_id TEXT,
      visitor_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS palonur_video_views_video ON palonur_video_views (video, created_at);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS palonur_waitlist (
      id        SERIAL PRIMARY KEY,
      name      TEXT NOT NULL,
      email     TEXT NOT NULL,
      source    TEXT DEFAULT 'sleep-agent',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS palonur_waitlist_email ON palonur_waitlist (LOWER(email))
  `);

  // Apple Watch integration
  await pool.query(`
    ALTER TABLE palonur_users
      ADD COLUMN IF NOT EXISTS apple_token UUID DEFAULT gen_random_uuid()
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS palonur_apple_health (
      id                 SERIAL PRIMARY KEY,
      user_id            INTEGER REFERENCES palonur_users(id) ON DELETE CASCADE,
      sleep_date         DATE NOT NULL,
      total_sleep_min    NUMERIC,
      deep_sleep_min     NUMERIC,
      rem_sleep_min      NUMERIC,
      light_sleep_min    NUMERIC,
      awake_min          NUMERIC,
      sleep_start        TIMESTAMPTZ,
      sleep_end          TIMESTAMPTZ,
      hrv_avg            NUMERIC,
      heart_rate_avg     NUMERIC,
      heart_rate_min     NUMERIC,
      respiratory_rate   NUMERIC,
      blood_oxygen       NUMERIC,
      wrist_temperature  NUMERIC,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, sleep_date)
    )
  `);

  // ── Faculty + sources (prereqs for interpretations) ─────────────────
  // Drizzle-kit push gets confused by legacy raw-SQL tables in this DB
  // and prompts interactive rename questions that we can't answer in a
  // headless workflow, so we create faculty/sources/interpretations
  // tables here directly. Schemas must stay in sync with
  // `lib/db/src/schema/{faculty,sources,interpretations}.ts`.
  await pool.query(`
    DO $$ BEGIN
      CREATE TYPE faculty_role AS ENUM ('steward','contributor','viewer');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  await pool.query(`
    DO $$ BEGIN
      CREATE TYPE faculty_invitation_status AS ENUM ('pending','accepted','revoked','expired');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  await pool.query(`
    DO $$ BEGIN
      CREATE TYPE source_kind AS ENUM ('paper','slm_article','note');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  await pool.query(`
    DO $$ BEGIN
      CREATE TYPE source_status AS ENUM ('draft','in_review','approved','archived');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pillars (
      id SERIAL PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Idempotent prod-safe seed of the canonical lifestyle-medicine pillar set.
  // Three of these (Stress Management, Social Connection, Avoidance of Risky
  // Substances) start with no faculty assigned, so they only become visible
  // once the rows exist. ON CONFLICT DO NOTHING never modifies an existing
  // pillar — it only fills in any that are missing. Same prod-bootstrap
  // rationale as the other seeds in this function.
  for (const p of CANONICAL_PILLARS) {
    await pool.query(
      `INSERT INTO pillars (slug, name, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO NOTHING`,
      [p.slug, p.name, p.description],
    );
  }
  // Soft-retire support: admins can hide a pillar that's no longer offered
  // without destroying its content. Nullable, so the canonical seed above is
  // unaffected. Prod migration handled by Replit Publish; this keeps dev DBs
  // and fresh bootstraps in sync.
  await pool.query(
    `ALTER TABLE pillars ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ`,
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS faculty_users (
      id SERIAL PRIMARY KEY,
      clerk_user_id TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      full_name TEXT,
      is_platform_admin TEXT NOT NULL DEFAULT 'false',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE faculty_users
      ADD COLUMN IF NOT EXISTS onboarded_at TIMESTAMPTZ
  `);
  await pool.query(`
    ALTER TABLE faculty_users
      ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ
  `);
  // Per-steward Tavus replica for the /slm video chat (null = default replica).
  await pool.query(`
    ALTER TABLE faculty_users
      ADD COLUMN IF NOT EXISTS tavus_replica_id TEXT
  `);
  // Registration channel: null = standard faculty flow; 'aslm' = arrived via
  // AskLifestyleMedicine (stamped from the accepted invitation; drives the
  // trimmed portal view for those members).
  await pool.query(`
    ALTER TABLE faculty_users
      ADD COLUMN IF NOT EXISTS registration_channel TEXT
  `);
  // Custodian account: internal system account auto-added as co-steward when
  // a real steward is archived. Uses a sentinel clerk_user_id so it can never
  // sign in. Hidden from the admin roster via HIDDEN_FACULTY_EMAILS.
  await pool.query(`
    INSERT INTO faculty_users (clerk_user_id, email, full_name)
    VALUES ('custodian-palonur', 'custodian@palonur.com', 'Custodian')
    ON CONFLICT (clerk_user_id) DO NOTHING
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS faculty_memberships (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES faculty_users(id) ON DELETE CASCADE,
      pillar_id INTEGER NOT NULL REFERENCES pillars(id) ON DELETE CASCADE,
      role faculty_role NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS faculty_memberships_user_pillar_unique ON faculty_memberships (user_id, pillar_id)`,
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS faculty_invitations (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      pillar_id INTEGER NOT NULL REFERENCES pillars(id) ON DELETE CASCADE,
      role faculty_role NOT NULL,
      token UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
      status faculty_invitation_status NOT NULL DEFAULT 'pending',
      invited_by_user_id INTEGER REFERENCES faculty_users(id) ON DELETE SET NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      accepted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Channel the invite was issued under (null = standard; 'aslm' =
  // AskLifestyleMedicine). Copied onto faculty_users on acceptance.
  await pool.query(`
    ALTER TABLE faculty_invitations
      ADD COLUMN IF NOT EXISTS registration_channel TEXT
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS faculty_channel_interest (
      id SERIAL PRIMARY KEY,
      faculty_user_id INTEGER NOT NULL REFERENCES faculty_users(id) ON DELETE CASCADE,
      channel_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS faculty_channel_interest_user_channel_unique ON faculty_channel_interest (faculty_user_id, channel_key)`,
  );

  // ── Self-serve faculty application funnel ─────────────────────────
  // Schema must stay in sync with `lib/db/src/schema/faculty.ts`
  // (facultyApplicationsTable, institutionAgreementsTable).
  await pool.query(`
    DO $$ BEGIN
      CREATE TYPE faculty_application_status AS ENUM ('applied','under_review','admitted','declined');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS faculty_applications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES faculty_users(id) ON DELETE CASCADE,
      institution TEXT NOT NULL,
      field TEXT NOT NULL,
      work_url TEXT,
      institutional_email TEXT NOT NULL,
      institutional_email_verified_at TIMESTAMPTZ,
      verification_token UUID NOT NULL DEFAULT gen_random_uuid(),
      verification_expires_at TIMESTAMPTZ NOT NULL,
      status faculty_application_status NOT NULL DEFAULT 'applied',
      decline_note TEXT,
      admitted_pillar_id INTEGER REFERENCES pillars(id) ON DELETE SET NULL,
      decided_by_user_id INTEGER REFERENCES faculty_users(id) ON DELETE SET NULL,
      decided_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS faculty_applications_user_unique ON faculty_applications (user_id)`,
  );
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS faculty_applications_token_unique ON faculty_applications (verification_token)`,
  );
  // Institution-level agreement flag: business-level fact, admin-editable,
  // never part of any professor-facing flow.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS institution_agreements (
      id SERIAL PRIMARY KEY,
      institution TEXT NOT NULL,
      agreement_active TEXT NOT NULL DEFAULT 'false',
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS institution_agreements_institution_unique ON institution_agreements (institution)`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sources (
      id SERIAL PRIMARY KEY,
      pillar_id INTEGER NOT NULL REFERENCES pillars(id) ON DELETE CASCADE,
      kind source_kind NOT NULL,
      title TEXT NOT NULL,
      authors TEXT,
      year INTEGER,
      journal TEXT,
      doi TEXT,
      abstract TEXT,
      full_text TEXT,
      source_url TEXT,
      status source_status NOT NULL DEFAULT 'draft',
      uploaded_by_user_id INTEGER REFERENCES faculty_users(id) ON DELETE SET NULL,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `ALTER TABLE sources ADD COLUMN IF NOT EXISTS study_design TEXT`,
  );
  // IP protection (corpus hashing + canaries): content hashes feed the
  // append-only corpus manifest; is_canary flags synthetic canary documents
  // (excluded pre-retrieval from all consumer surfaces).
  await pool.query(
    `ALTER TABLE sources ADD COLUMN IF NOT EXISTS content_hash TEXT`,
  );
  await pool.query(
    `ALTER TABLE sources ADD COLUMN IF NOT EXISTS is_canary BOOLEAN NOT NULL DEFAULT FALSE`,
  );
  await pool.query(`
    DO $$ BEGIN
      CREATE TYPE source_rights_basis AS ENUM
        ('open_license','permission','public_domain','no_documented_full_text_rights');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  await pool.query(`
    DO $$ BEGIN
      CREATE TYPE source_retention_status AS ENUM
        ('needs_review','review_window','retained_with_rights','purged_no_full_text_rights');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  await pool.query(
    `ALTER TABLE sources ADD COLUMN IF NOT EXISTS rights_basis source_rights_basis`,
  );
  await pool.query(
    `ALTER TABLE sources ADD COLUMN IF NOT EXISTS retention_status source_retention_status NOT NULL DEFAULT 'needs_review'`,
  );
  await pool.query(
    `ALTER TABLE sources ADD COLUMN IF NOT EXISTS rights_recorded_by_user_id INTEGER REFERENCES faculty_users(id) ON DELETE SET NULL`,
  );
  await pool.query(
    `ALTER TABLE sources ADD COLUMN IF NOT EXISTS rights_recorded_at TIMESTAMPTZ`,
  );
  await pool.query(
    `ALTER TABLE sources ADD COLUMN IF NOT EXISTS purged_by_user_id INTEGER REFERENCES faculty_users(id) ON DELETE SET NULL`,
  );
  await pool.query(
    `ALTER TABLE sources ADD COLUMN IF NOT EXISTS purged_at TIMESTAMPTZ`,
  );
  // Legacy rows predate a recorded decision. Do not infer rights from their
  // kind, URL, prior approval, or seed origin: quarantine their raw material
  // until a steward records a basis through the source-library review path.
  await pool.query(
    `UPDATE sources
        SET retention_status = 'needs_review'
      WHERE rights_basis IS NULL
        AND retention_status <> 'purged_no_full_text_rights'`,
  );
  await pool.query(
    `ALTER TABLE IF EXISTS crawl_runs ADD COLUMN IF NOT EXISTS rights_basis source_rights_basis`,
  );
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS sources_pillar_doi_unique ON sources (pillar_id, doi) WHERE doi IS NOT NULL`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS sources_pillar_status_idx ON sources (pillar_id, status)`,
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS source_chunks (
      id SERIAL PRIMARY KEY,
      source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      embedding halfvec,
      embedding_model TEXT,
      page INTEGER,
      section TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS source_chunks_source_chunk_unique ON source_chunks (source_id, chunk_index)`,
  );
  await pool.query(
    `ALTER TABLE source_chunks ADD COLUMN IF NOT EXISTS content_hash TEXT`,
  );
  // Append-only corpus manifests + private per-licensee fingerprint mapping.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS corpus_manifests (
      id SERIAL PRIMARY KEY,
      manifest_hash TEXT NOT NULL,
      source_count INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL,
      entries JSONB NOT NULL,
      reason TEXT NOT NULL DEFAULT 'boot',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS partner_key_fingerprints (
      id SERIAL PRIMARY KEY,
      partner_key_id INTEGER NOT NULL REFERENCES partner_keys(id) ON DELETE CASCADE,
      fingerprint_secret TEXT NOT NULL,
      marker_code TEXT NOT NULL,
      canary_variant INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS partner_key_fingerprints_key_unique ON partner_key_fingerprints (partner_key_id)`,
  );
  // Black-box misuse detection: private probe library + persisted detection
  // sessions (admin-only surfaces; never serialized publicly).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS misuse_probes (
      id SERIAL PRIMARY KEY,
      label TEXT NOT NULL,
      prompt TEXT NOT NULL,
      target_kind TEXT NOT NULL DEFAULT 'canary',
      canary_doi TEXT,
      expected_signals JSONB NOT NULL DEFAULT '[]',
      notes TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS detection_sessions (
      id SERIAL PRIMARY KEY,
      label TEXT NOT NULL,
      mode TEXT NOT NULL,
      target JSONB,
      results JSONB NOT NULL DEFAULT '[]',
      stats JSONB NOT NULL DEFAULT '{}',
      attribution JSONB NOT NULL DEFAULT '{}',
      manifest_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Partial expression HNSW index: HNSW needs a fixed width, but the column is
  // dimensionless so a model rotation is non-destructive. Cast to the current
  // width and scope to the current model so not-yet-re-embedded rows (old width)
  // are excluded from the index and never break the cast.
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${embeddingIndexName("source_chunks")} ON source_chunks USING hnsw ((embedding::halfvec(${EMBEDDING_DIMENSIONS})) halfvec_cosine_ops) WHERE embedding_model = '${embeddingSqlLiteral()}'`,
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS source_versions (
      id SERIAL PRIMARY KEY,
      source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      snapshot JSONB NOT NULL,
      archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS source_versions_source_version_unique ON source_versions (source_id, version)`,
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS source_audit_log (
      id SERIAL PRIMARY KEY,
      source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      actor_user_id INTEGER REFERENCES faculty_users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      from_status source_status,
      to_status source_status,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── Faculty interpretations (Task #10) ────────────────────────────────
  await pool.query(`
    DO $$ BEGIN
      CREATE TYPE interpretation_status AS ENUM ('proposed','approved','archived');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  await pool.query(`
    DO $$ BEGIN
      CREATE TYPE interpretation_origin AS ENUM ('palonur_ai','faculty');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interpretations (
      id SERIAL PRIMARY KEY,
      source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      pillar_id INTEGER NOT NULL REFERENCES pillars(id) ON DELETE CASCADE,
      author_id INTEGER REFERENCES faculty_users(id) ON DELETE SET NULL,
      status interpretation_status NOT NULL DEFAULT 'proposed',
      version INTEGER NOT NULL DEFAULT 1,
      answer TEXT NOT NULL,
      interpretation TEXT NOT NULL,
      not_proven TEXT,
      action TEXT,
      tags TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
      approver_id INTEGER REFERENCES faculty_users(id) ON DELETE SET NULL,
      approved_at TIMESTAMPTZ,
      parent_interpretation_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `ALTER TABLE interpretations ADD COLUMN IF NOT EXISTS origin interpretation_origin NOT NULL DEFAULT 'faculty'`,
  );
  await pool.query(
    `ALTER TABLE interpretations ADD COLUMN IF NOT EXISTS drafted_at TIMESTAMPTZ`,
  );
  await pool.query(
    `ALTER TABLE interpretations ADD COLUMN IF NOT EXISTS reviewed_by_user_id INTEGER REFERENCES faculty_users(id) ON DELETE SET NULL`,
  );
  await pool.query(
    `ALTER TABLE interpretations ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ`,
  );
  await pool.query(
    `ALTER TABLE interpretations ADD COLUMN IF NOT EXISTS last_edited_by_user_id INTEGER REFERENCES faculty_users(id) ON DELETE SET NULL`,
  );
  await pool.query(
    `ALTER TABLE interpretations ADD COLUMN IF NOT EXISTS last_edited_at TIMESTAMPTZ`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS interpretations_source_status_idx ON interpretations (source_id, status)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS interpretations_pillar_status_idx ON interpretations (pillar_id, status)`,
  );
  // Hard invariant: at most one approved interpretation per source.
  // Backstops the transactional demotion in routes/interpretations.ts
  // against concurrent approvals.
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS interpretations_one_approved_per_source
     ON interpretations (source_id) WHERE status = 'approved'`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS interpretation_versions (
      id SERIAL PRIMARY KEY,
      interpretation_id INTEGER NOT NULL REFERENCES interpretations(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      snapshot JSONB NOT NULL,
      approver_id INTEGER REFERENCES faculty_users(id) ON DELETE SET NULL,
      approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS interpretation_versions_interp_version_unique ON interpretation_versions (interpretation_id, version)`,
  );
  // Research discovery boot DDL is intentionally here, after every referenced
  // base table/type exists. It is additive-sync safe for fresh Publish DBs.
  await pool.query(
    `DO $$ BEGIN CREATE TYPE research_discovery_run_status AS ENUM ('pending','discovering','done','failed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  );
  await pool.query(
    `DO $$ BEGIN CREATE TYPE research_discovery_candidate_status AS ENUM ('discovered','review','ingested','auto_approved','duplicate','failed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS research_discovery_runs (id SERIAL PRIMARY KEY, faculty_user_id INTEGER NOT NULL REFERENCES faculty_users(id) ON DELETE CASCADE, pillar_id INTEGER NOT NULL REFERENCES pillars(id) ON DELETE CASCADE, started_by_user_id INTEGER REFERENCES faculty_users(id) ON DELETE SET NULL, faculty_name TEXT NOT NULL, pillar_topic TEXT NOT NULL, status research_discovery_run_status NOT NULL DEFAULT 'pending', error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS research_discovery_candidates (id SERIAL PRIMARY KEY, discovery_run_id INTEGER NOT NULL REFERENCES research_discovery_runs(id) ON DELETE CASCADE, pillar_id INTEGER NOT NULL REFERENCES pillars(id) ON DELETE CASCADE, provider TEXT NOT NULL, provider_id TEXT NOT NULL, doi TEXT, pmid TEXT, title TEXT NOT NULL, authors TEXT, journal TEXT, year INTEGER, abstract TEXT, source_url TEXT, status research_discovery_candidate_status NOT NULL DEFAULT 'discovered', review_reason TEXT, source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL, interpretation_id INTEGER REFERENCES interpretations(id) ON DELETE SET NULL, excluded_at TIMESTAMPTZ, excluded_by_user_id INTEGER REFERENCES faculty_users(id) ON DELETE SET NULL, exclusion_reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  );
  await pool.query(
    `ALTER TABLE research_discovery_candidates ADD COLUMN IF NOT EXISTS excluded_at TIMESTAMPTZ`,
  );
  await pool.query(
    `ALTER TABLE research_discovery_candidates ADD COLUMN IF NOT EXISTS excluded_by_user_id INTEGER REFERENCES faculty_users(id) ON DELETE SET NULL`,
  );
  await pool.query(
    `ALTER TABLE research_discovery_candidates ADD COLUMN IF NOT EXISTS exclusion_reason TEXT`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS research_discovery_runs_target_idx ON research_discovery_runs (faculty_user_id, pillar_id, created_at)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS research_discovery_candidates_run_idx ON research_discovery_candidates (discovery_run_id)`,
  );
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS research_discovery_provider_unique ON research_discovery_candidates (pillar_id, provider, provider_id)`,
  );
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS research_discovery_pillar_doi_unique ON research_discovery_candidates (pillar_id, doi) WHERE doi IS NOT NULL`,
  );
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS research_discovery_one_active_target ON research_discovery_runs (faculty_user_id, pillar_id) WHERE status IN ('pending','discovering')`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS interpretation_comments (
      id SERIAL PRIMARY KEY,
      interpretation_id INTEGER NOT NULL REFERENCES interpretations(id) ON DELETE CASCADE,
      author_id INTEGER REFERENCES faculty_users(id) ON DELETE SET NULL,
      body TEXT NOT NULL,
      quoted_text TEXT,
      parent_comment_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS interpretation_comments_interp_idx ON interpretation_comments (interpretation_id)`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS interpretation_chunks (
      id SERIAL PRIMARY KEY,
      interpretation_id INTEGER NOT NULL REFERENCES interpretations(id) ON DELETE CASCADE,
      source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      pillar_id INTEGER NOT NULL REFERENCES pillars(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      embedding halfvec,
      embedding_model TEXT,
      priority INTEGER NOT NULL DEFAULT 100,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS interpretation_chunks_interp_idx ON interpretation_chunks (interpretation_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS interpretation_chunks_pillar_idx ON interpretation_chunks (pillar_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${embeddingIndexName("interpretation_chunks")} ON interpretation_chunks USING hnsw ((embedding::halfvec(${EMBEDDING_DIMENSIONS})) halfvec_cosine_ops) WHERE embedding_model = '${embeddingSqlLiteral()}'`,
  );

  // ── Steward rubric checks (advisory draft checks; observe-only) ─────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rubric_checks (
      id SERIAL PRIMARY KEY,
      pillar_id INTEGER NOT NULL REFERENCES pillars(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      instruction TEXT NOT NULL,
      created_by_id INTEGER REFERENCES faculty_users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS rubric_checks_pillar_idx ON rubric_checks (pillar_id)`,
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rubric_check_results (
      id SERIAL PRIMARY KEY,
      check_id INTEGER NOT NULL REFERENCES rubric_checks(id) ON DELETE CASCADE,
      interpretation_id INTEGER NOT NULL REFERENCES interpretations(id) ON DELETE CASCADE,
      verdict TEXT NOT NULL,
      rationale TEXT,
      content_hash TEXT NOT NULL,
      model TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS rubric_check_results_check_interp_unique ON rubric_check_results (check_id, interpretation_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS rubric_check_results_interp_idx ON rubric_check_results (interpretation_id)`,
  );

  // ── Capture loop: agent_queries + query_clusters (Task #12) ──────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_queries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id TEXT NOT NULL,
      question TEXT NOT NULL,
      question_embedding halfvec,
      embedding_model TEXT,
      pillar_ids INTEGER[] NOT NULL DEFAULT ARRAY[]::int[],
      retrieved_source_ids INTEGER[] NOT NULL DEFAULT ARRAY[]::int[],
      retrieved_interpretation_ids INTEGER[] NOT NULL DEFAULT ARRAY[]::int[],
      top_score REAL NOT NULL DEFAULT 0,
      was_uncovered BOOLEAN NOT NULL DEFAULT FALSE,
      answer_text TEXT NOT NULL DEFAULT '',
      latency_ms INTEGER NOT NULL DEFAULT 0,
      user_flagged BOOLEAN NOT NULL DEFAULT FALSE,
      flag_reason TEXT,
      cluster_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `ALTER TABLE agent_queries ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'sleep-agent'`,
  );
  // Token accounting for the growth dashboard — per-answer LLM usage
  await pool.query(
    `ALTER TABLE agent_queries
       ADD COLUMN IF NOT EXISTS input_tokens INTEGER,
       ADD COLUMN IF NOT EXISTS output_tokens INTEGER`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS agent_queries_source_created_idx ON agent_queries (source, created_at)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS agent_queries_pillar_uncovered_created_idx ON agent_queries (was_uncovered, created_at)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS agent_queries_session_idx ON agent_queries (session_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${embeddingIndexName("agent_queries")} ON agent_queries USING hnsw ((question_embedding::halfvec(${EMBEDDING_DIMENSIONS})) halfvec_cosine_ops) WHERE embedding_model = '${embeddingSqlLiteral()}'`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS query_clusters (
      id SERIAL PRIMARY KEY,
      pillar_id INTEGER NOT NULL REFERENCES pillars(id) ON DELETE CASCADE,
      representative_question TEXT NOT NULL,
      representative_embedding halfvec,
      embedding_model TEXT,
      size INTEGER NOT NULL DEFAULT 0,
      last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS query_clusters_pillar_idx ON query_clusters (pillar_id)`,
  );

  // ── Consumer billing identity (paywalled sleep agent) ────────────────
  // Separate from faculty Clerk auth and from palonur_users (anonymous
  // journey profile). Must stay in sync with
  // `lib/db/src/schema/consumers.ts`. Same dev-bootstrap rationale as the
  // faculty tables above — prod migration is handled by Replit Publish.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS consumer_accounts (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      stripe_customer_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `ALTER TABLE consumer_accounts ADD COLUMN IF NOT EXISTS display_name TEXT`,
  );
  // email_verified_at: added together with a one-time backfill. Every account
  // that existed BEFORE this column was introduced was created by consuming a
  // magic link (that was the only way in), so those are verified. The backfill
  // must run ONLY when the column is first added — a plain UPDATE on every
  // boot would wrongly "verify" self-registered accounts awaiting their link.
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'consumer_accounts'
           AND column_name = 'email_verified_at'
      ) THEN
        ALTER TABLE consumer_accounts ADD COLUMN email_verified_at TIMESTAMPTZ;
        UPDATE consumer_accounts SET email_verified_at = created_at;
      END IF;
    END $$
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS consumer_login_tokens (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      magic_token TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── Journey passes ───────────────────────────────────────────────────────
  // One-time $49 pass granting unlimited questions for 90 days or until the
  // user presses "I've found my answer". Must stay in sync with
  // `lib/db/src/schema/consumers.ts`. Prod migration via Replit Publish.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS journey_passes (
      id SERIAL PRIMARY KEY,
      consumer_account_id INTEGER NOT NULL,
      product TEXT NOT NULL,
      stripe_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      expires_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── Admin-managed Stories/Newsletter editor allowlist ────────────────
  // Lets a platform admin add/remove editors without an engineer changing the
  // STORY_EDITOR_EMAILS env var. The env/code default seeds this table on first
  // read (see routes/stories.ts). Must stay in sync with
  // `lib/db/src/schema/stories.ts` (storyEditorsTable). Prod migration handled
  // by Replit Publish; this keeps dev DBs and fresh bootstraps in sync.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS story_editors (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      added_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Self-heal DBs whose story_editors table predates the UNIQUE(email)
  // constraint — CREATE TABLE IF NOT EXISTS never retrofits it, and without it
  // the duplicate-add path (onConflictDoNothing) silently inserts twice.
  // Conditional so fresh DBs (which already get UNIQUE from CREATE TABLE)
  // don't grow a second redundant unique index.
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'story_editors'
          AND indexdef ILIKE '%UNIQUE%(email)%'
      ) THEN
        DELETE FROM story_editors a USING story_editors b
          WHERE a.email = b.email AND a.id > b.id;
        CREATE UNIQUE INDEX story_editors_email_unique ON story_editors (email);
      END IF;
    END $$
  `);

  // ── Palonur Decision Room ────────────────────────────────────────────
  // Standalone decision workspace (artifacts/decision-room). Must stay in
  // sync with lib/db/src/schema/decisionRoom.ts. Prod migration handled by
  // Replit Publish; this keeps dev DBs and fresh bootstraps in sync.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS decision_room_decisions (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      question TEXT NOT NULL,
      context TEXT,
      own_view TEXT,
      final_call TEXT,
      outcome TEXT,
      status TEXT NOT NULL DEFAULT 'framing',
      checked_step_ids JSONB NOT NULL DEFAULT '[]',
      decided_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // ── CVO Release Governance columns (idempotent ALTER TABLE ADD COLUMN IF NOT EXISTS) ──
  // These extend the existing decision_room_decisions table with release
  // governance fields.  Existing rows default to live/draft safely.
  await pool.query(
    `ALTER TABLE decision_room_decisions ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'live'`,
  );
  await pool.query(
    `ALTER TABLE decision_room_decisions ADD COLUMN IF NOT EXISTS institution_name TEXT NOT NULL DEFAULT ''`,
  );
  await pool.query(
    `ALTER TABLE decision_room_decisions ADD COLUMN IF NOT EXISTS named_expert TEXT NOT NULL DEFAULT ''`,
  );
  await pool.query(
    `ALTER TABLE decision_room_decisions ADD COLUMN IF NOT EXISTS owner_faculty_user_id INTEGER`,
  );
  await pool.query(
    `ALTER TABLE decision_room_decisions ADD COLUMN IF NOT EXISTS externally_cleared BOOLEAN NOT NULL DEFAULT FALSE`,
  );
  await pool.query(
    `ALTER TABLE decision_room_decisions ADD COLUMN IF NOT EXISTS revenue_terms_acknowledged BOOLEAN NOT NULL DEFAULT FALSE`,
  );
  await pool.query(
    `ALTER TABLE decision_room_decisions ADD COLUMN IF NOT EXISTS revenue_terms_note TEXT`,
  );
  await pool.query(
    `ALTER TABLE decision_room_decisions ADD COLUMN IF NOT EXISTS faculty_approved_at TIMESTAMPTZ`,
  );
  await pool.query(
    `ALTER TABLE decision_room_decisions ADD COLUMN IF NOT EXISTS faculty_approved_by_id INTEGER`,
  );
  await pool.query(
    `ALTER TABLE decision_room_decisions ADD COLUMN IF NOT EXISTS faculty_approved_by_name TEXT`,
  );
  await pool.query(
    `ALTER TABLE decision_room_decisions ADD COLUMN IF NOT EXISTS cvo_verified_at TIMESTAMPTZ`,
  );
  await pool.query(
    `ALTER TABLE decision_room_decisions ADD COLUMN IF NOT EXISTS cvo_verified_by_id INTEGER`,
  );
  await pool.query(
    `ALTER TABLE decision_room_decisions ADD COLUMN IF NOT EXISTS cvo_verified_by_name TEXT`,
  );
  await pool.query(
    `ALTER TABLE decision_room_decisions ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`,
  );
  await pool.query(
    `ALTER TABLE decision_room_decisions ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ`,
  );
  await pool.query(
    `ALTER TABLE decision_room_decisions ADD COLUMN IF NOT EXISTS is_sample BOOLEAN NOT NULL DEFAULT FALSE`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS decision_room_consultations (
      id SERIAL PRIMARY KEY,
      decision_id INTEGER NOT NULL,
      pillar_slug TEXT NOT NULL,
      pillar_name TEXT NOT NULL,
      status TEXT NOT NULL,
      answer_text TEXT NOT NULL,
      citations JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS decision_room_consultations_decision_idx
      ON decision_room_consultations (decision_id)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS decision_room_ai_steps (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      position INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Seed release governance protocol steps when the table is empty.
  // Steps are framed as CVO release-governance checks, not generic AI advice.
  // INSERT-only: never overwrites user edits (they own the protocol after first boot).
  await pool.query(`
    INSERT INTO decision_room_ai_steps (text, position)
    SELECT * FROM (VALUES
      ('Confirm external clearance: verify all content is publicly releasable and not confidential.', 1),
      ('Name the responsible expert: record the named expert or faculty member who owns this guidance.', 2),
      ('State the public guidance clearly: write the release text so a non-specialist reader can act on it.', 3),
      ('Consult the governed pillars: run your question through pillar science for citations and provenance.', 4),
      ('Record source and provenance notes: note every source, reference, or dataset the guidance relies on.', 5),
      ('Set scope limits: document what the release does not cover and where it cannot be applied.', 6),
      ('Provide a recourse path: state how a reader can escalate, get help, or reach a human expert.', 7),
      ('Obtain faculty substantive sign-off: the named expert must explicitly approve the final text.', 8),
      ('Acknowledge revenue terms: confirm revenue and commercial-use terms are understood and accepted.', 9),
      ('Complete CVO process verification: a platform admin must verify the process before the release is marked ready.', 10),
      ('Publish: once status is ready and all checks are satisfied, a CVO admin may publish the release.', 11)
    ) AS seed(text, position)
    WHERE NOT EXISTS (SELECT 1 FROM decision_room_ai_steps)
  `);
  // Migrate old generic default steps to release-governance copy.
  // Targets ONLY the exact verbatim legacy text at the exact position so any
  // user-edited steps are never touched.
  await pool.query(`
    DO $upd$ BEGIN
      UPDATE decision_room_ai_steps SET text = 'Confirm external clearance: verify all content is publicly releasable and not confidential.', updated_at = NOW()
        WHERE text = 'Write down your own view and reasoning before consulting any AI.' AND position = 1;
      UPDATE decision_room_ai_steps SET text = 'Name the responsible expert: record the named expert or faculty member who owns this guidance.', updated_at = NOW()
        WHERE text = 'Frame the decision as a question a domain expert could answer.' AND position = 2;
      UPDATE decision_room_ai_steps SET text = 'State the public guidance clearly: write the release text so a non-specialist reader can act on it.', updated_at = NOW()
        WHERE text = 'Consult the governed pillars — prefer cited, steward-approved answers over general AI output.' AND position = 3;
      UPDATE decision_room_ai_steps SET text = 'Consult the governed pillars: run your question through pillar science for citations and provenance.', updated_at = NOW()
        WHERE text = 'Note where the pillars'' answers differ from your own view, and why.' AND position = 4;
      UPDATE decision_room_ai_steps SET text = 'Record source and provenance notes: note every source, reference, or dataset the guidance relies on.', updated_at = NOW()
        WHERE text = 'Treat uncovered areas as your responsibility to research — not as settled.' AND position = 5;
      UPDATE decision_room_ai_steps SET text = 'Set scope limits: document what the release does not cover and where it cannot be applied.', updated_at = NOW()
        WHERE text = 'Check how reversible the decision is before committing.' AND position = 6;
      UPDATE decision_room_ai_steps SET text = 'Provide a recourse path: state how a reader can escalate, get help, or reach a human expert.', updated_at = NOW()
        WHERE text = 'Decide yourself, record the call, and come back later to log the outcome.' AND position = 7;
    END $upd$;
  `);

  // ── CVO Release Governance — new tables ─────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS decision_room_audit_events (
      id SERIAL PRIMARY KEY,
      mode TEXT NOT NULL,
      release_id INTEGER NOT NULL,
      actor_id INTEGER NOT NULL,
      actor_name TEXT NOT NULL,
      event_type TEXT NOT NULL,
      detail JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS decision_room_audit_events_release_idx
      ON decision_room_audit_events (release_id)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS decision_room_comments (
      id SERIAL PRIMARY KEY,
      mode TEXT NOT NULL,
      release_id INTEGER NOT NULL,
      author_id INTEGER NOT NULL,
      author_name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'comment',
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      resolved_at TIMESTAMPTZ,
      resolved_by_id INTEGER,
      resolved_by_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS decision_room_comments_release_idx
      ON decision_room_comments (release_id)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS decision_room_review_links (
      id SERIAL PRIMARY KEY,
      mode TEXT NOT NULL,
      release_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      creator_id INTEGER NOT NULL,
      creator_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS decision_room_review_links_release_idx
      ON decision_room_review_links (release_id)
  `);

  // ── Test-mode sample seeds (idempotent) ──────────────────────────────────
  // Exactly three fictional sample cases for rehearsal coverage:
  //   1. Late-night digital support (needs attention — draft)
  //   2. Public sleep guidance     (ready to release)
  //   3. AI class explainer        (published / traced)
  // Only in mode='test'.  Live is NEVER seeded.
  await pool.query(`
    INSERT INTO decision_room_decisions (
      mode, is_sample, title, question, status,
      institution_name, named_expert,
      own_view, context,
      final_call, outcome,
      externally_cleared, revenue_terms_acknowledged
    )
    SELECT * FROM (VALUES
      ('test', TRUE,
       '[SAMPLE] Late-Night Digital Support Policy',
       'Should we recommend limiting digital device use after 10 pm for college students?',
       'draft',
       'Fictional University Health Services', 'Dr. A. Sample (fictional)',
       'Late-night screen use displaces sleep opportunity and delays circadian rhythm. The evidence for limiting it is robust.',
       'Targeted at undergraduate students aged 18-24 living in campus housing.',
       NULL, NULL,
       FALSE, FALSE),
      ('test', TRUE,
       '[SAMPLE] Public Sleep Hygiene Guidance',
       'What is an evidence-based, publicly accessible sleep hygiene recommendation for adults?',
       'ready',
       'Fictional Sleep Research Institute', 'Prof. B. Sample (fictional)',
       'Consistent sleep/wake timing and a cool, dark room are the two highest-impact low-cost interventions.',
       'Intended for general adult population aged 18-65 via public-facing website.',
       'Recommend 7-9 hours with consistent schedule; avoid caffeine after 2 pm.',
       'Approved for web publication.',
       TRUE, TRUE),
      ('test', TRUE,
       '[SAMPLE] AI Tools in the Classroom: Explainer',
       'How should faculty introduce AI tools to students in a way that preserves critical thinking?',
       'published',
       'Fictional College of Education', 'Dr. C. Sample (fictional)',
       'AI tools should be introduced as research accelerators, not answer machines; critical evaluation must be explicitly taught.',
       'Faculty audience: undergraduate instructors seeking curriculum guidance.',
       'Require students to cite AI use and explain their own reasoning independently.',
       'Published in faculty newsletter Vol. 3.',
       TRUE, TRUE)
    ) AS seed(
      mode, is_sample, title, question, status,
      institution_name, named_expert,
      own_view, context,
      final_call, outcome,
      externally_cleared, revenue_terms_acknowledged
    )
    WHERE NOT EXISTS (
      SELECT 1 FROM decision_room_decisions WHERE mode = 'test' AND is_sample = TRUE
    )
  `);
  // Idempotently back-fill faculty signoff and CVO verification timestamps
  // for the published sample so it shows as fully traced.
  await pool.query(`
    UPDATE decision_room_decisions
    SET
      faculty_approved_at = NOW() - INTERVAL '2 days',
      faculty_approved_by_name = 'Dr. C. Sample (fictional)',
      cvo_verified_at = NOW() - INTERVAL '1 day',
      cvo_verified_by_name = 'CVO Sample (fictional)',
      published_at = NOW() - INTERVAL '12 hours'
    WHERE mode = 'test' AND is_sample = TRUE
      AND title = '[SAMPLE] AI Tools in the Classroom: Explainer'
      AND faculty_approved_at IS NULL
  `);
  // Idempotently back-fill faculty signoff and CVO verification timestamps
  // for the ready sample so it is actually ready-to-release (signed off).
  await pool.query(`
    UPDATE decision_room_decisions
    SET
      faculty_approved_at = NOW() - INTERVAL '3 days',
      faculty_approved_by_name = 'Prof. B. Sample (fictional)',
      cvo_verified_at = NOW() - INTERVAL '2 days',
      cvo_verified_by_name = 'CVO Sample (fictional)'
    WHERE mode = 'test' AND is_sample = TRUE
      AND title = '[SAMPLE] Public Sleep Hygiene Guidance'
      AND faculty_approved_at IS NULL
  `);
  // Seed immutable audit events for the ready and published samples
  // so Published and Traceable dashboard section shows real audit trail.
  await pool.query(`
    INSERT INTO decision_room_audit_events (mode, release_id, actor_id, actor_name, event_type, detail)
    SELECT
      'test',
      d.id,
      0,
      'system_seed',
      e.event_type,
      e.detail::jsonb
    FROM decision_room_decisions d
    CROSS JOIN (VALUES
      ('create',            '{"note":"Sample record created at boot"}'),
      ('faculty_signoff',   '{"note":"Sample faculty sign-off seeded at boot"}'),
      ('cvo_verification',  '{"note":"Sample CVO verification seeded at boot"}')
    ) AS e(event_type, detail)
    WHERE d.mode = 'test' AND d.is_sample = TRUE
      AND d.title IN (
        '[SAMPLE] Public Sleep Hygiene Guidance',
        '[SAMPLE] AI Tools in the Classroom: Explainer'
      )
      AND NOT EXISTS (
        SELECT 1 FROM decision_room_audit_events ae
        WHERE ae.release_id = d.id AND ae.event_type = e.event_type
      )
  `);
  // Seed publish audit event for published sample only
  await pool.query(`
    INSERT INTO decision_room_audit_events (mode, release_id, actor_id, actor_name, event_type, detail)
    SELECT 'test', d.id, 0, 'system_seed', 'publish', '{"note":"Sample publish event seeded at boot"}'::jsonb
    FROM decision_room_decisions d
    WHERE d.mode = 'test' AND d.is_sample = TRUE
      AND d.title = '[SAMPLE] AI Tools in the Classroom: Explainer'
      AND NOT EXISTS (
        SELECT 1 FROM decision_room_audit_events ae
        WHERE ae.release_id = d.id AND ae.event_type = 'publish'
      )
  `);

  // Decision Room: chat-built six-page decision memos, shares, and per-page
  // comments. Admin/faculty-only; never exposed on public surfaces.
  await pool.query(`
    DO $$ BEGIN
      CREATE TYPE decision_memo_status AS ENUM ('draft', 'shared', 'decided');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS decision_memos (
      id SERIAL PRIMARY KEY,
      owner_id INTEGER NOT NULL REFERENCES faculty_users(id),
      title TEXT NOT NULL,
      topic TEXT NOT NULL DEFAULT '',
      status decision_memo_status NOT NULL DEFAULT 'draft',
      decided_outcome TEXT,
      decided_at TIMESTAMPTZ,
      page1 TEXT NOT NULL DEFAULT '',
      page2 TEXT NOT NULL DEFAULT '',
      page3 TEXT NOT NULL DEFAULT '',
      page4 TEXT NOT NULL DEFAULT '',
      page5 TEXT NOT NULL DEFAULT '',
      page6 TEXT NOT NULL DEFAULT '',
      science_check JSONB,
      science_checked_at TIMESTAMPTZ,
      science_check_passed TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS decision_memos_owner_idx ON decision_memos (owner_id)`,
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS decision_memo_shares (
      id SERIAL PRIMARY KEY,
      memo_id INTEGER NOT NULL REFERENCES decision_memos(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES faculty_users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS decision_memo_shares_unique ON decision_memo_shares (memo_id, user_id)`,
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS decision_memo_comments (
      id SERIAL PRIMARY KEY,
      memo_id INTEGER NOT NULL REFERENCES decision_memos(id) ON DELETE CASCADE,
      page INTEGER NOT NULL,
      author_id INTEGER NOT NULL REFERENCES faculty_users(id),
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS decision_memo_comments_memo_idx ON decision_memo_comments (memo_id)`,
  );

  // ── "How AI sees you" steward visibility reports ─────────────────────
  // Snapshot runs of what ChatGPT/Claude answer today for a steward's
  // topics: whether they are named, how they are characterized, and who is
  // recommended instead. faculty_user_id NULL = prospect report (admin
  // recruiting tool for someone without an account). payload holds the full
  // report JSON (questions, per-engine answers, classifier summary); answer
  // text inside is UNTRUSTED third-party model output and stays inside the
  // authenticated faculty portal.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_visibility_reports (
      id SERIAL PRIMARY KEY,
      subject_name TEXT NOT NULL,
      aliases TEXT[] NOT NULL DEFAULT '{}',
      topics TEXT[] NOT NULL DEFAULT '{}',
      pillar_id INTEGER REFERENCES pillars(id) ON DELETE SET NULL,
      faculty_user_id INTEGER REFERENCES faculty_users(id) ON DELETE CASCADE,
      requested_by INTEGER REFERENCES faculty_users(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'running',
      payload JSONB,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ai_visibility_reports_user_idx ON ai_visibility_reports (faculty_user_id, created_at DESC)`,
  );

  logger.info("Database migration complete");

  // Best-effort: copy the canonical investor decks from the Palonur public
  // folder into investor_decks so the gated viewer can serve them even after
  // the static files are stripped from the production build.
  await syncInvestorDecks().catch((err) =>
    logger.error({ err }, "Investor deck sync failed"),
  );
}

/**
 * Initialize the Stripe sync schema + managed webhook and backfill data.
 * Resilient by design: if the Stripe integration isn't connected yet, we log
 * a warning and skip the credential-dependent steps so the rest of the API
 * (sleep agent, faculty portal, etc.) keeps serving. Entitlement reads simply
 * find no subscriptions until Stripe is connected and synced.
 */
async function initStripe(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    logger.warn("DATABASE_URL missing — skipping Stripe init");
    return;
  }
  try {
    await runMigrations({ databaseUrl });
    logger.info("Stripe sync schema ready");
  } catch (err) {
    logger.error({ err }, "Stripe schema migration failed");
    return;
  }

  if (!(await isStripeConnected())) {
    logger.warn(
      "Stripe integration not connected — skipping webhook setup + backfill. " +
        "Connect Stripe via Integrations, then restart.",
    );
    return;
  }

  try {
    const stripeSync = await getStripeSync();
    const webhookBaseUrl = `https://${process.env.REPLIT_DOMAINS?.split(",")[0]}`;
    const webhook = await stripeSync.findOrCreateManagedWebhook(
      `${webhookBaseUrl}/api/stripe/webhook`,
    );
    logger.info(
      { webhook: webhook?.url ?? "setup complete" },
      "Stripe managed webhook configured",
    );

    // Idempotently ensure the subscription catalog exists in this
    // environment's Stripe account/mode before backfilling.
    // Awaited (not fire-and-forget) so the products exist before the backfill
    // snapshots them. Best-effort: never throws (per-product errors are logged).
    const seedResult = await seedStripeProducts().catch((err) => {
      logger.error({ err }, "Stripe product seed failed (continuing)");
      return null;
    });
    if (seedResult) {
      logger.info({ seedResult }, "Stripe product catalog ensured");
    }

    // Per-steward Q&A subscription products ($9/mo per ask-eligible steward
    // publication). Same idempotency + best-effort contract as the core
    // catalog seed above; awaited so the backfill snapshots them too.
    const stewardSeed = await seedStewardProducts().catch((err) => {
      logger.error({ err }, "Steward product seed failed (continuing)");
      return null;
    });
    if (stewardSeed) {
      logger.info({ stewardSeed }, "Steward Q&A product catalog ensured");
    }

    stripeSync
      .syncBackfill({ object: "all" })
      .then(() => logger.info("Stripe data backfilled"))
      .catch((err) => logger.error({ err }, "Stripe backfill failed"));
  } catch (err) {
    logger.error({ err }, "Stripe init failed (continuing without Stripe)");
  }
}

const databaseStartup = stanfordEdition
  ? assertStanfordDatabaseReady(pool)
  : migrate();

databaseStartup
  .then(() => {
    if (!stanfordEdition && isBillingEnabled()) {
      void initStripe();
    } else if (stanfordEdition) {
      logger.info("Stanford edition; skipping Stripe initialization");
    } else {
      logger.info("Billing disabled; skipping Stripe initialization");
    }
    app.listen(port, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }
      logger.info({ port }, "Server listening");

      // Pre-load the in-house embedding model so the first real request doesn't
      // pay the one-time cold start. Fire-and-forget; never blocks boot.
      void warmEmbedder().catch((err) =>
        logger.error({ err }, "Embedding model warmup failed"),
      );

      if (stanfordEdition) {
        // These jobs are bounded to tables in slmSchemaManifest. All other
        // legacy boot seeds and cron jobs are intentionally skipped here until
        // their table footprint has been reviewed for Stanford mode.
        logger.info(
          "Stanford edition; skipping legacy boot seeds and unreviewed cron jobs",
        );

        // Steward review digest — daily at 8am UTC.
        cron.schedule("0 8 * * *", () => {
          runStewardReviewDigest().catch((e) =>
            logger.error({ err: e }, "Steward review digest cron failed"),
          );
        });

        // Opt-in only: provider metadata/abstract discovery.
        if (process.env.RESEARCH_DISCOVERY_ENABLED === "true") {
          cron.schedule("23 3 * * *", () => {
            runDailyResearchDiscovery().catch((e) =>
              logger.error({ err: e }, "Research discovery cron failed"),
            );
          });
        }

        // Re-cluster uncovered/low-confidence queries — hourly.
        cron.schedule("17 * * * *", () => {
          runQueryClustering().catch((e) =>
            logger.error({ err: e }, "Query clustering cron failed"),
          );
        });

        // Weekly coverage digest to stewards — Mondays 7am UTC.
        cron.schedule("0 7 * * 1", () => {
          runWeeklyCoverageDigest().catch((e) =>
            logger.error({ err: e }, "Weekly coverage digest cron failed"),
          );
        });
        return;
      }

      // Best-effort, post-listen: seed the Empathy pillar's approved content
      // (five real Helen Riess papers + interpretations) so a fresh production
      // database answers with provenance instead of UNCOVERED. Idempotent.
      // Embeddings produced in-house; fire-and-forget.
      void seedEmpathy().catch((err) =>
        logger.error({ err }, "Empathy content seed failed"),
      );

      // Best-effort, post-listen: seed the Stanford Lifestyle Medicine
      // newsletter corpus (181 approved slm_article sources across the six
      // lifestyle-medicine pillars) so a fresh production database answers
      // the home-hero questions with grounded material instead of a boundary
      // line. The archive was imported into DEV by the one-shot
      // ingestSlmArticles script; publishing migrates schema, not rows.
      // INSERT-ONLY + keyed on (pillar_id, source_url) → dev is a no-op and
      // steward edits are never reverted. Embeddings are in-house; the cold
      // first run takes ~1–2 min, which is why it must stay fire-and-forget.
      void seedSlmArticlesAtBoot().catch((err) =>
        logger.error({ err }, "SLM articles content seed failed"),
      );

      // Best-effort, post-listen: ensure the steward roster (published SLM
      // pillar Heads + Karen Parker on Autism + the operator on the AI Lab
      // pillar) exists — pending faculty rows + steward memberships +
      // institution backfill. Publishing migrates schema, not rows, and the
      // sign-in allowlist only fires on login, so without this the stewards
      // stay invisible in production. Idempotent; never clobbers reconciled
      // accounts or edited institution values.
      void seedStewards().catch((err) =>
        logger.error({ err }, "Steward roster seed failed"),
      );

      // Best-effort, post-listen: bootstrap the default distribution channels
      // on a fresh DB (Publish migrates schema, not rows). Seed-when-empty, so
      // an admin's later edits/deletions are never reverted. Idempotent no-op
      // once any channel row exists.
      void seedDistributionChannels().catch((err) =>
        logger.error({ err }, "Distribution channels seed failed"),
      );

      // Best-effort, post-listen: publish Allison Kluger's real communication
      // framework on a fresh DB. INSERT-ONLY (keyed by pillar+slug), so a
      // steward's later edits or retirement are never reverted.
      void seedKlugerFramework().catch((err) =>
        logger.error({ err }, "Kluger framework seed failed"),
      );

      // Best-effort, post-listen: append the Governance & Accountability page
      // to an existing otl_doc snapshot (the DB snapshot is authoritative for
      // otl.html; the static file only seeds fresh saves). Idempotent via the
      // data-gov-page marker — a steward's later edits are never clobbered.
      void ensureOtlGovernancePage().catch((err) =>
        logger.error({ err }, "OTL governance page append failed"),
      );

      // Best-effort, post-listen: append the Security Review Package pointer
      // page to an existing otl_doc snapshot (same DB-snapshot-is-authoritative
      // rule; idempotent via the data-secpkg-page marker).
      void ensureOtlSecurityPackagePage().catch((err) =>
        logger.error({ err }, "OTL security package page append failed"),
      );

      // Best-effort, post-listen: first consolidate the two diverged Jamie
      // Zeitzer faculty accounts — production kept his content under the dotted
      // email (`jamie.zeitzer@…`) while his real Clerk login landed on an empty
      // canonical row (`jzeitzer@…`) — THEN seed the sleep corpus so the seed
      // sees the single consolidated steward. Both are guarded + idempotent:
      // no-op in dev and after the first successful merge.
      void (async () => {
        await consolidateZeitzerAccounts().catch((err) =>
          logger.error({ err }, "Zeitzer account consolidation failed"),
        );
        // Seed gap-filling sleep-pillar content (Jamie Zeitzer's steward corpus)
        // so previously-UNCOVERED everyday sleep questions answer with
        // provenance. Additive + idempotent; only ever owns its own titled rows,
        // never clobbers a curated interpretation.
        await seedSleep().catch((err) =>
          logger.error({ err }, "Sleep content seed failed"),
        );
      })();

      // Best-effort, post-listen: fill five concrete corpus gaps identified from
      // real agent-query logs, including focus, social connection, and sleep.
      // All content is Stanford-sourced; embeddings are in-house. Additive +
      // idempotent; never clobbers a steward-curated interpretation.
      void seedCorpusGapsContent().catch((err) =>
        logger.error({ err }, "Corpus-gaps content seed failed"),
      );

      // Best-effort, post-listen: IP-protection boot — backfill content
      // hashes for pre-existing rows, seed the synthetic canary registry
      // (insert-only, idempotent), then snapshot an append-only corpus
      // manifest iff the approved corpus changed.
      void (async () => {
        const {
          backfillContentHashes,
          seedCanaries,
          generateCorpusManifestIfChanged,
        } = await import("./lib/ipProtection.js");
        await backfillContentHashes();
        await seedCanaries();
        await generateCorpusManifestIfChanged("boot");
      })().catch((err) =>
        logger.error(
          { err },
          "IP-protection boot (hashes/canaries/manifest) failed",
        ),
      );

      // Best-effort, post-listen: heal any referral conversions that were
      // missed because /billing/confirm was never called (client drop-off,
      // blocked redirect, etc.). Idempotent — credits only users with an
      // active subscription and a signup event but no convert event yet.
      if (isBillingEnabled()) {
        void reconcileReferralConversions().catch((err) =>
          logger.error({ err }, "Referral reconciliation failed"),
        );
      }

      // Job 1: Morning commitment check-in — hourly, filters by each user's local 7am
      cron.schedule("0 * * * *", () => {
        runMorningCheckins().catch((e) =>
          logger.error({ err: e }, "Morning check-in cron failed"),
        );
      });

      // Job 2: Weekly sleep portrait — daily at 2am UTC; respects 6-day cooldown
      cron.schedule("0 2 * * *", () => {
        runWeeklyPortraits().catch((e) =>
          logger.error({ err: e }, "Weekly portrait cron failed"),
        );
      });

      // Job 3: Sleep insight nudge — daily at 9am UTC; respects 7-day cooldown per user
      cron.schedule("0 9 * * *", () => {
        runNudgeEmails().catch((e) =>
          logger.error({ err: e }, "Nudge email cron failed"),
        );
      });

      // Job 4: Steward review digest — daily at 8am UTC. Only emails
      // stewards with at least one pending interpretation in their pillar.
      cron.schedule("0 8 * * *", () => {
        runStewardReviewDigest().catch((e) =>
          logger.error({ err: e }, "Steward review digest cron failed"),
        );
      });

      // Opt-in only: provider metadata/abstract discovery, never publisher
      // scraping. Per-target 24h idempotency is enforced by the job itself.
      if (process.env.RESEARCH_DISCOVERY_ENABLED === "true") {
        cron.schedule("23 3 * * *", () => {
          runDailyResearchDiscovery().catch((e) =>
            logger.error({ err: e }, "Research discovery cron failed"),
          );
        });
      }

      // Job 5: Re-cluster uncovered/low-confidence queries — hourly.
      // Idempotent: stable cluster ids across runs.
      cron.schedule("17 * * * *", () => {
        runQueryClustering().catch((e) =>
          logger.error({ err: e }, "Query clustering cron failed"),
        );
      });

      // Job 6: Weekly coverage digest to stewards — Mondays 7am UTC.
      cron.schedule("0 7 * * 1", () => {
        runWeeklyCoverageDigest().catch((e) =>
          logger.error({ err: e }, "Weekly coverage digest cron failed"),
        );
      });

      // Job 7: Weekly coaching loop to consumers — Mondays 8am UTC. Respects
      // the per-user email opt-out + a 6-day cooldown.
      cron.schedule("0 8 * * 1", () => {
        runWeeklyReflections().catch((e) =>
          logger.error({ err: e }, "Weekly reflection cron failed"),
        );
      });

      // Job 10: Daily traffic digest — 7am Pacific, so it reports on the full
      // just-completed Pacific calendar day. Emails ANALYTICS_DIGEST_TO
      // (default karan@palonur.com) with users, growth, locations, and time on
      // site. Production-only + degrades gracefully without Resend.
      cron.schedule(
        "0 7 * * *",
        () => {
          runDailyAnalyticsDigest().catch((e) =>
            logger.error({ err: e }, "Daily analytics digest cron failed"),
          );
        },
        { timezone: "America/Los_Angeles" },
      );

      // Job 8: Prune stale email rate-limit hits — every 15 minutes. The
      // per-request path only prunes the bucket it touches, so quiet buckets
      // leave rows behind forever; this windowed DELETE reclaims them. Safe to
      // run concurrently across instances.
      cron.schedule("*/15 * * * *", () => {
        pruneStaleEmailRateLimitHits().catch((e) =>
          logger.error({ err: e }, "Email rate-limit prune cron failed"),
        );
      });

      // Job 11: Data-retention enforcement — daily at 03:40 UTC. Enforces the
      // documented schedule (docs/data-retention-policy.md): expired magic
      // links, aged doorway/SMS text, aged raw analytics, aged email-send
      // audit rows, stale visitor-session linkage. Idempotent; logs one line
      // per category. Also runs once at boot so a long-slept dev/prod
      // instance catches up immediately.
      cron.schedule("40 3 * * *", () => {
        runRetentionCleanup().catch((e) =>
          logger.error({ err: e }, "Retention cleanup cron failed"),
        );
      });
      void runRetentionCleanup().catch((e) =>
        logger.error({ err: e }, "Boot retention cleanup failed"),
      );
    });
  })
  .catch((err) => {
    logger.error(
      { err, stanfordEdition },
      stanfordEdition
        ? "Stanford database readiness failed; refusing to start"
        : "Migration failed",
    );
    process.exit(1);
  });
