import { beforeAll, beforeEach, describe, test, expect, vi } from "vitest";

vi.hoisted(() => {
  process.env.SESSION_SECRET = "test-newsletter-secret";
  process.env.STORY_EDITOR_EMAILS = "editor@test.local";
  process.env.NEWSLETTER_CREDIT_CENTS = "5000";
});

// The newsletter route delivers via Resend through this lib — stub it so a
// "send" succeeds without network and we can exercise credit minting.
const welcomeEmailCalls: Array<{
  to: string;
  name?: string | null;
  branding?: { masthead?: string } | undefined;
  stewardName?: string | null;
}> = [];
vi.mock("../lib/newsletterEmail", () => ({
  buildIssueHtml: () => "<html>full</html>",
  buildTeaserHtml: () => "<html>teaser</html>",
  buildWelcomeEmail: (args: {
    branding?: { masthead?: string };
    stewardName?: string | null;
  }) => ({
    subject: `Welcome to ${args.branding?.masthead ?? "Stanford Lifestyle Medicine"}`,
    html: `<html>welcome ${args.branding?.masthead ?? ""}${args.stewardName ? ` · ${args.stewardName}` : ""}</html>`,
    text: "stub",
  }),
  newsletterResendConfigured: async () => true,
  htmlToText: () => "stub",
  unsubscribeUrlFor: (t: string) => `https://example.test/u?token=${t}`,
  confirmUrlFor: (t: string) => `https://example.test/newsletter/confirm?token=${t}`,
  sendSubscriberConfirmationEmail: async () => true,
  sendNewsletterEmail: async () => true,
  sendNewsletterPortalLink: async () => true,
  sendWelcomeEmail: async (args: {
    to: string;
    name?: string | null;
    branding?: { masthead?: string };
    stewardName?: string | null;
  }) => {
    welcomeEmailCalls.push({
      to: args.to,
      name: args.name,
      branding: args.branding,
      stewardName: args.stewardName,
    });
    return true;
  },
  // Echo enough of the real derivation that the confirm handler's per-publication
  // branding is observable: house keeps its masthead, faculty carries the pub name.
  brandingForPublication: (pub?: {
    isHouse?: boolean | null;
    name?: string | null;
  }) => ({
    masthead:
      !pub || pub.isHouse
        ? "Stanford Lifestyle Medicine"
        : (pub.name ?? "Palonur"),
    fromAddress: undefined,
  }),
}));

// `stubFacultyUserId` lets each test act as a specific signed-in faculty member
// (faculty self-publish routes). Set it before a request, 0 → unauthorized.
let stubFacultyUserId = 0;
vi.mock("../middlewares/facultyAuth.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../middlewares/facultyAuth.js")
  >();
  const { db, facultyUsersTable, facultyMembershipsTable } = await import(
    "@workspace/db"
  );
  const { eq } = await import("drizzle-orm");
  return {
    ...actual,
    requireFacultyAuth: async (
      req: { faculty?: unknown },
      res: { status: (n: number) => { json: (b: unknown) => void } },
      next: () => void,
    ) => {
      if (!stubFacultyUserId) {
        res.status(401).json({ error: "no stub user" });
        return;
      }
      const [user] = await db
        .select()
        .from(facultyUsersTable)
        .where(eq(facultyUsersTable.id, stubFacultyUserId));
      const memberships = await db
        .select()
        .from(facultyMembershipsTable)
        .where(eq(facultyMembershipsTable.userId, stubFacultyUserId));
      (req as { faculty: unknown }).faculty = { user, memberships };
      next();
    },
  };
});

// Both AI SDKs are instantiated at import time; stub to avoid env/network reads.
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      create: async () => ({ content: [{ type: "text", text: "stub" }] }),
    };
  }
  return { default: FakeAnthropic };
});
vi.mock("openai", () => {
  class FakeOpenAI {
    images = { generate: async () => ({ data: [{ b64_json: "" }] }) };
  }
  return { default: FakeOpenAI };
});

import type { Express } from "express";
import request from "supertest";
import { createHmac } from "crypto";
import pool from "../lib/db.js";

function signCookie(val: string, secret: string): string {
  const hash = createHmac("sha256", secret)
    .update(val)
    .digest("base64")
    .replace(/=+$/, "");
  return val + "." + hash;
}
function signed(value: string): string {
  return "s:" + signCookie(value, process.env.SESSION_SECRET as string);
}
function adminCookie(): string {
  return `palonur_admin=${encodeURIComponent(signed("1"))}`;
}

let app: Express;
const FACULTY_ID = 987654;

async function ensureSchema(): Promise<void> {
  for (const ddl of [
    `CREATE TYPE newsletter_subscriber_status AS ENUM ('active','unsubscribed','bounced')`,
    `CREATE TYPE newsletter_issue_status AS ENUM ('draft','scheduled','sent')`,
    `CREATE TYPE newsletter_post_kind AS ENUM ('article','story')`,
    `CREATE TYPE newsletter_offer_status AS ENUM ('offered','accepted','declined')`,
    `CREATE TYPE newsletter_credit_status AS ENUM ('pending','approved','paid')`,
  ]) {
    await pool.query(
      `DO $$ BEGIN ${ddl}; EXCEPTION WHEN duplicate_object THEN NULL; WHEN unique_violation THEN NULL; END $$;`,
    );
  }
  // Double opt-in: pending subscribers exist until they click the email link.
  await pool.query(
    `ALTER TYPE newsletter_subscriber_status ADD VALUE IF NOT EXISTS 'pending'`,
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS newsletter_publications (
    id SERIAL PRIMARY KEY,
    is_house BOOLEAN NOT NULL DEFAULT false,
    faculty_user_id INTEGER,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    byline_name TEXT,
    byline_institution TEXT,
    tagline TEXT,
    description TEXT,
    accent_color TEXT,
    from_address TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  // Landing-page columns (Task: Topic → auto-generated editorial landing). Tests
  // import app.ts, not index.ts, so boot-time DDL never runs — self-provision.
  for (const ddl of [
    `ALTER TABLE newsletter_publications ADD COLUMN IF NOT EXISTS topic TEXT`,
    `ALTER TABLE newsletter_publications ADD COLUMN IF NOT EXISTS landing_content JSONB`,
    `ALTER TABLE newsletter_publications ADD COLUMN IF NOT EXISTS hero_image_path TEXT`,
    `ALTER TABLE newsletter_publications ADD COLUMN IF NOT EXISTS hero_image_prompt TEXT`,
    `ALTER TABLE newsletter_publications ADD COLUMN IF NOT EXISTS landing_generated_at TIMESTAMPTZ`,
  ]) {
    await pool.query(ddl);
  }
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS newsletter_publications_slug_uniq ON newsletter_publications (slug)`,
  );
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS newsletter_publications_faculty_uniq ON newsletter_publications (faculty_user_id)`,
  );
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS newsletter_publications_house_uniq ON newsletter_publications (is_house) WHERE is_house = true`,
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS newsletter_subscribers (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT,
    status newsletter_subscriber_status NOT NULL DEFAULT 'active',
    source TEXT,
    unsubscribe_token TEXT NOT NULL UNIQUE,
    confirmed_at TIMESTAMPTZ,
    unsubscribed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(
    `ALTER TABLE newsletter_subscribers ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT`,
  );
  await pool.query(
    `ALTER TABLE newsletter_subscribers ADD COLUMN IF NOT EXISTS publication_id INTEGER REFERENCES newsletter_publications(id) ON DELETE CASCADE`,
  );
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS newsletter_subscribers_pub_email_uniq ON newsletter_subscribers (publication_id, email)`,
  );
  await pool.query(
    `ALTER TABLE newsletter_subscribers ADD COLUMN IF NOT EXISTS confirm_token TEXT`,
  );
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS newsletter_subscribers_confirm_token_uniq ON newsletter_subscribers (confirm_token)`,
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS newsletter_issues (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    subject_line TEXT,
    preview_text TEXT,
    intro_html TEXT,
    hero_image_path TEXT,
    status newsletter_issue_status NOT NULL DEFAULT 'draft',
    created_by TEXT,
    recipient_count INTEGER,
    sent_at TIMESTAMPTZ,
    scheduled_for TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(
    `ALTER TABLE newsletter_issues ADD COLUMN IF NOT EXISTS premium BOOLEAN NOT NULL DEFAULT false`,
  );
  await pool.query(
    `ALTER TABLE newsletter_issues ADD COLUMN IF NOT EXISTS publication_id INTEGER REFERENCES newsletter_publications(id) ON DELETE CASCADE`,
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS newsletter_posts (
    id SERIAL PRIMARY KEY,
    issue_id INTEGER NOT NULL REFERENCES newsletter_issues(id) ON DELETE CASCADE,
    kind newsletter_post_kind NOT NULL DEFAULT 'article',
    position INTEGER NOT NULL DEFAULT 0,
    title TEXT,
    author_name TEXT,
    source_id INTEGER,
    story_id INTEGER,
    faculty_user_id INTEGER,
    body_html TEXT,
    pull_quote TEXT,
    source_material TEXT,
    image_path TEXT,
    image_prompt TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(
    `ALTER TABLE newsletter_posts ADD COLUMN IF NOT EXISTS faculty_user_id INTEGER`,
  );
  await pool.query(
    `ALTER TABLE newsletter_posts ADD COLUMN IF NOT EXISTS author_institution TEXT`,
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS newsletter_offers (
    id SERIAL PRIMARY KEY,
    faculty_user_id INTEGER NOT NULL,
    author_name TEXT,
    author_email TEXT,
    pillar_id INTEGER,
    interpretation_id INTEGER,
    title TEXT NOT NULL,
    summary TEXT,
    body_html TEXT,
    source_material TEXT,
    status newsletter_offer_status NOT NULL DEFAULT 'offered',
    decline_reason TEXT,
    reviewed_by TEXT,
    reviewed_at TIMESTAMPTZ,
    resulting_post_id INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(
    `ALTER TABLE newsletter_offers ADD COLUMN IF NOT EXISTS author_institution TEXT`,
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS newsletter_credits (
    id SERIAL PRIMARY KEY,
    faculty_user_id INTEGER NOT NULL,
    author_name TEXT,
    author_email TEXT,
    issue_id INTEGER NOT NULL REFERENCES newsletter_issues(id) ON DELETE CASCADE,
    post_id INTEGER REFERENCES newsletter_posts(id) ON DELETE SET NULL,
    offer_id INTEGER,
    post_title TEXT,
    amount_cents INTEGER NOT NULL DEFAULT 5000,
    status newsletter_credit_status NOT NULL DEFAULT 'pending',
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paid_at TIMESTAMPTZ
  )`);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS newsletter_credits_issue_post_uniq ON newsletter_credits (issue_id, post_id)`,
  );
}

async function seedOffer(
  overrides: Partial<{
    title: string;
    status: string;
    institution: string;
  }> = {},
): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO newsletter_offers (faculty_user_id, author_name, author_email, author_institution, title, summary, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [
      FACULTY_ID,
      "Dr. Faculty",
      "faculty@test.local",
      overrides.institution ?? null,
      overrides.title ?? "Reset your circadian clock",
      "A short summary",
      overrides.status ?? "offered",
    ],
  );
  return rows[0].id as number;
}

// Find-or-create the house publication, mirroring the route's
// ensureHousePublication() so seeded house issues/subscribers carry the same
// publicationId the house-scoped routes filter on.
async function housePubId(): Promise<number> {
  const found = await pool.query(
    `SELECT id FROM newsletter_publications WHERE is_house = true LIMIT 1`,
  );
  if (found.rows[0]) return found.rows[0].id as number;
  const ins = await pool.query(
    `INSERT INTO newsletter_publications (is_house, name, slug)
     VALUES (true, 'Stanford Lifestyle Medicine', 'stanford-lifestyle-medicine')
     RETURNING id`,
  );
  return ins.rows[0].id as number;
}

async function seedIssue(): Promise<number> {
  const pubId = await housePubId();
  const { rows } = await pool.query(
    `INSERT INTO newsletter_issues (title, status, publication_id) VALUES ($1,'draft',$2) RETURNING id`,
    ["May Issue", pubId],
  );
  return rows[0].id as number;
}

// Minimal `stripe` schema mirroring the columns the newsletter billing lib
// reads, so paid-status derivation + MRR can be exercised without a real
// Stripe connection. The real schema is owned by stripe-replit-sync.
const NL_CUSTOMER_ID = "cus_paid_reader";

// The dev DB carries the REAL stripe schema (synced by stripe-replit-sync),
// where every business column is GENERATED ALWAYS from a `_raw_data` jsonb
// blob — so explicit inserts into e.g. `active` are rejected. When that schema
// is present we seed through `_raw_data`; otherwise we self-provision a minimal
// plain-column schema and seed explicitly. This flag records which path applies.
let stripeUsesRawData = false;
async function ensureStripeSchema(): Promise<void> {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS stripe`);
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'stripe' AND table_name = 'products'
       AND column_name = '_raw_data' LIMIT 1`,
  );
  stripeUsesRawData = rows.length > 0;
  if (stripeUsesRawData) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS stripe.products (
    id TEXT PRIMARY KEY,
    name TEXT,
    description TEXT,
    active BOOLEAN,
    metadata JSONB
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS stripe.prices (
    id TEXT PRIMARY KEY,
    product TEXT,
    active BOOLEAN,
    type TEXT,
    unit_amount INTEGER,
    currency TEXT,
    recurring JSONB
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS stripe.subscriptions (
    id TEXT PRIMARY KEY,
    customer TEXT,
    status TEXT
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS stripe.subscription_items (
    id TEXT PRIMARY KEY,
    subscription TEXT,
    price TEXT
  )`);
}

async function resetStripe(): Promise<void> {
  // CASCADE because the real `stripe` schema (synced by stripe-replit-sync in
  // the dev DB) has stripe.invoices -> stripe.subscriptions FKs; plain TRUNCATE
  // of subscriptions trips that constraint.
  await pool.query(
    `TRUNCATE stripe.subscription_items, stripe.subscriptions, stripe.prices, stripe.products CASCADE`,
  );
}

// On the real synced schema every object FKs back to stripe.accounts(id) via
// `_account_id`. Reuse an existing account if one is present, else mint a
// minimal one so the seed is self-contained.
async function ensureStripeAccountId(): Promise<string> {
  const found = await pool.query(`SELECT id FROM stripe.accounts LIMIT 1`);
  if (found.rows[0]) return found.rows[0].id as string;
  const ins = await pool.query(
    `INSERT INTO stripe.accounts (_raw_data, _last_synced_at, _updated_at)
     VALUES ($1::jsonb, now(), now()) RETURNING id`,
    [JSON.stringify({ id: "acct_test", object: "account" })],
  );
  return ins.rows[0].id as string;
}

// Seed one active newsletter subscription for NL_CUSTOMER_ID at $5/mo.
async function seedPaidNewsletter(): Promise<void> {
  if (stripeUsesRawData) {
    const accountId = await ensureStripeAccountId();
    await pool.query(
      `INSERT INTO stripe.products (_account_id, _raw_data) VALUES ($1, $2::jsonb)`,
      [
        accountId,
        JSON.stringify({
          id: "prod_nl",
          object: "product",
          name: "Palonur Newsletter Premium",
          description: "Full issues",
          active: true,
          metadata: { palonur_plan: "newsletter" },
        }),
      ],
    );
    await pool.query(
      `INSERT INTO stripe.prices (_account_id, _raw_data) VALUES ($1, $2::jsonb)`,
      [
        accountId,
        JSON.stringify({
          id: "price_nl_m",
          object: "price",
          product: "prod_nl",
          active: true,
          type: "recurring",
          unit_amount: 500,
          currency: "usd",
          recurring: { interval: "month" },
        }),
      ],
    );
    await pool.query(
      `INSERT INTO stripe.subscriptions (_account_id, _raw_data) VALUES ($1, $2::jsonb)`,
      [
        accountId,
        JSON.stringify({
          id: "sub_1",
          object: "subscription",
          customer: NL_CUSTOMER_ID,
          status: "active",
        }),
      ],
    );
    await pool.query(
      `INSERT INTO stripe.subscription_items (_account_id, _raw_data) VALUES ($1, $2::jsonb)`,
      [
        accountId,
        JSON.stringify({
          id: "si_1",
          object: "subscription_item",
          subscription: "sub_1",
          price: "price_nl_m",
        }),
      ],
    );
    return;
  }
  await pool.query(
    `INSERT INTO stripe.products (id, name, description, active, metadata)
     VALUES ('prod_nl','Palonur Newsletter Premium','Full issues',true,'{"palonur_plan":"newsletter"}'::jsonb)`,
  );
  await pool.query(
    `INSERT INTO stripe.prices (id, product, active, type, unit_amount, currency, recurring)
     VALUES ('price_nl_m','prod_nl',true,'recurring',500,'usd','{"interval":"month"}'::jsonb)`,
  );
  await pool.query(
    `INSERT INTO stripe.subscriptions (id, customer, status) VALUES ('sub_1',$1,'active')`,
    [NL_CUSTOMER_ID],
  );
  await pool.query(
    `INSERT INTO stripe.subscription_items (id, subscription, price) VALUES ('si_1','sub_1','price_nl_m')`,
  );
}

let facultyAId = 0;
let facultyBId = 0;

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for newsletter.test.ts");
  }
  await ensureSchema();
  await ensureStripeSchema();
  const stamp = Date.now();
  const { rows: uRows } = await pool.query<{ id: number }>(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name, institution)
     VALUES ($1,$2,$3,$4),($5,$6,$7,$8) RETURNING id`,
    [
      `nl-fa-clerk-${stamp}`,
      `nl-fa-${stamp}@test.local`,
      "Faculty Alpha",
      "Stanford University",
      `nl-fb-clerk-${stamp}`,
      `nl-fb-${stamp}@test.local`,
      "Faculty Beta",
      "Harvard Medical School",
    ],
  );
  facultyAId = uRows[0].id;
  facultyBId = uRows[1].id;
  app = (await import("../app")).default;
});

beforeEach(async () => {
  await pool.query(
    `TRUNCATE newsletter_credits, newsletter_offers, newsletter_posts, newsletter_issues, newsletter_subscribers, newsletter_publications RESTART IDENTITY CASCADE`,
  );
  // Re-ensure the faculty fixtures: another suite's CASCADE truncation of
  // faculty_users can delete these mid-run in the shared dev DB (see
  // .agents/memory/api-server-test-fixture-cascade.md). Idempotent re-insert
  // keeps every describe block working regardless of scheduling.
  const { rows: fa } = await pool.query<{ id: number }>(
    `SELECT id FROM faculty_users WHERE id = ANY($1::int[])`,
    [[facultyAId, facultyBId]],
  );
  if (fa.length < 2) {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const { rows: uRows } = await pool.query<{ id: number }>(
      `INSERT INTO faculty_users (clerk_user_id, email, full_name, institution)
       VALUES ($1,$2,$3,$4),($5,$6,$7,$8) RETURNING id`,
      [
        `nl-fa-clerk-${stamp}`,
        `nl-fa-${stamp}@test.local`,
        "Faculty Alpha",
        "Stanford University",
        `nl-fb-clerk-${stamp}`,
        `nl-fb-${stamp}@test.local`,
        "Faculty Beta",
        "Harvard Medical School",
      ],
    );
    facultyAId = uRows[0].id;
    facultyBId = uRows[1].id;
  }
  welcomeEmailCalls.length = 0;
  await resetStripe();
});

describe("newsletter offers (editor)", () => {
  test("requires editor/admin auth", async () => {
    const res = await request(app).get("/api/newsletter/offers");
    expect(res.status).toBe(401);
  });

  test("lists the pending offer pool", async () => {
    await seedOffer();
    const res = await request(app)
      .get("/api/newsletter/offers")
      .set("Cookie", adminCookie());
    expect(res.status).toBe(200);
    expect(res.body.offers).toHaveLength(1);
    expect(res.body.offers[0].status).toBe("offered");
  });

  test("accept turns an offer into a faculty-attributed post", async () => {
    const offerId = await seedOffer();
    const issueId = await seedIssue();
    const res = await request(app)
      .post(`/api/newsletter/offers/${offerId}/accept`)
      .set("Cookie", adminCookie())
      .send({ issueId });
    expect(res.status).toBe(200);
    expect(res.body.offer.status).toBe("accepted");
    expect(res.body.post.facultyUserId).toBe(FACULTY_ID);
    expect(res.body.post.issueId).toBe(issueId);
    expect(res.body.post.authorName).toBe("Dr. Faculty");
  });

  test("accept carries the author institution onto the post", async () => {
    const offerId = await seedOffer({ institution: "Harvard Medical School" });
    const issueId = await seedIssue();
    const res = await request(app)
      .post(`/api/newsletter/offers/${offerId}/accept`)
      .set("Cookie", adminCookie())
      .send({ issueId });
    expect(res.status).toBe(200);
    expect(res.body.post.authorInstitution).toBe("Harvard Medical School");
  });

  test("byline shows name · institution, name-only when blank", async () => {
    const issueId = await seedIssue();
    // One post with an institution, one without.
    const withInst = await seedOffer({
      title: "With institution",
      institution: "Harvard Medical School",
    });
    await request(app)
      .post(`/api/newsletter/offers/${withInst}/accept`)
      .set("Cookie", adminCookie())
      .send({ issueId });
    const noInst = await seedOffer({ title: "No institution" });
    await request(app)
      .post(`/api/newsletter/offers/${noInst}/accept`)
      .set("Cookie", adminCookie())
      .send({ issueId });

    const md = await request(app)
      .get(`/api/newsletter/issues/${issueId}/export.md`)
      .set("Cookie", adminCookie());
    expect(md.status).toBe(200);
    expect(md.text).toContain("_By Dr. Faculty · Harvard Medical School_");
    // The no-institution post renders name-only (no trailing separator).
    expect(md.text).toContain("_By Dr. Faculty_");
  });

  test("accept requires an issueId", async () => {
    const offerId = await seedOffer();
    const res = await request(app)
      .post(`/api/newsletter/offers/${offerId}/accept`)
      .set("Cookie", adminCookie())
      .send({});
    expect(res.status).toBe(400);
  });

  test("accepting an already-resolved offer is a 409", async () => {
    const offerId = await seedOffer({ status: "declined" });
    const issueId = await seedIssue();
    const res = await request(app)
      .post(`/api/newsletter/offers/${offerId}/accept`)
      .set("Cookie", adminCookie())
      .send({ issueId });
    expect(res.status).toBe(409);
  });

  test("decline records the reason", async () => {
    const offerId = await seedOffer();
    const res = await request(app)
      .post(`/api/newsletter/offers/${offerId}/decline`)
      .set("Cookie", adminCookie())
      .send({ reason: "Off topic for this issue" });
    expect(res.status).toBe(200);
    expect(res.body.offer.status).toBe("declined");
    expect(res.body.offer.declineReason).toBe("Off topic for this issue");
  });
});

describe("newsletter credit ledger", () => {
  async function acceptOfferIntoIssue(): Promise<{ issueId: number }> {
    const offerId = await seedOffer();
    const issueId = await seedIssue();
    await request(app)
      .post(`/api/newsletter/offers/${offerId}/accept`)
      .set("Cookie", adminCookie())
      .send({ issueId });
    await pool.query(
      `INSERT INTO newsletter_subscribers (email, unsubscribe_token, status, publication_id) VALUES ('reader@test.local','tok-1','active',$1)`,
      [await housePubId()],
    );
    return { issueId };
  }

  test("sending an issue mints a credit for each faculty post (idempotent)", async () => {
    const { issueId } = await acceptOfferIntoIssue();

    const send1 = await request(app)
      .post(`/api/newsletter/issues/${issueId}/send`)
      .set("Cookie", adminCookie());
    expect(send1.status).toBe(200);
    expect(send1.body.creditsMinted).toBe(1);

    // A re-send attempt is blocked (issue already sent) and never double-credits.
    const send2 = await request(app)
      .post(`/api/newsletter/issues/${issueId}/send`)
      .set("Cookie", adminCookie());
    expect(send2.status).toBe(409);

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM newsletter_credits WHERE issue_id = $1`,
      [issueId],
    );
    expect(rows[0].n).toBe(1);
  });

  test("credit amount honors NEWSLETTER_CREDIT_CENTS", async () => {
    const { issueId } = await acceptOfferIntoIssue();
    await request(app)
      .post(`/api/newsletter/issues/${issueId}/send`)
      .set("Cookie", adminCookie());
    const res = await request(app)
      .get("/api/newsletter/credits")
      .set("Cookie", adminCookie());
    expect(res.status).toBe(200);
    expect(res.body.credits[0].amountCents).toBe(5000);
    // Payee email + offer linkage carried from the originating offer.
    expect(res.body.credits[0].authorEmail).toBe("faculty@test.local");
    expect(res.body.credits[0].offerId).toBeTruthy();
    expect(res.body.summary.outstandingCents).toBe(5000);
  });

  test("PATCH marks a credit paid and clears outstanding", async () => {
    const { issueId } = await acceptOfferIntoIssue();
    await request(app)
      .post(`/api/newsletter/issues/${issueId}/send`)
      .set("Cookie", adminCookie());
    const list = await request(app)
      .get("/api/newsletter/credits")
      .set("Cookie", adminCookie());
    const creditId = list.body.credits[0].id;

    const patched = await request(app)
      .patch(`/api/newsletter/credits/${creditId}`)
      .set("Cookie", adminCookie())
      .send({ status: "paid" });
    expect(patched.status).toBe(200);
    expect(patched.body.credit.status).toBe("paid");
    expect(patched.body.credit.paidAt).toBeTruthy();

    const after = await request(app)
      .get("/api/newsletter/credits")
      .set("Cookie", adminCookie());
    expect(after.body.summary.outstandingCents).toBe(0);
  });

  test("CSV export carries the ledger", async () => {
    const { issueId } = await acceptOfferIntoIssue();
    await request(app)
      .post(`/api/newsletter/issues/${issueId}/send`)
      .set("Cookie", adminCookie());
    const res = await request(app)
      .get("/api/newsletter/credits.csv")
      .set("Cookie", adminCookie());
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.text).toContain("author_name");
    expect(res.text).toContain("Dr. Faculty");
  });
});

describe("paid newsletter tier", () => {
  async function seedSubscriber(
    email: string,
    customerId: string | null,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO newsletter_subscribers (email, unsubscribe_token, status, stripe_customer_id, publication_id)
       VALUES ($1,$2,'active',$3,$4)`,
      [email, `tok-${email}`, customerId, await housePubId()],
    );
  }

  test("subscribers list reports paid/free counts + MRR from Stripe", async () => {
    await seedPaidNewsletter();
    await seedSubscriber("paid@test.local", NL_CUSTOMER_ID);
    await seedSubscriber("free@test.local", null);

    const res = await request(app)
      .get("/api/newsletter/subscribers")
      .set("Cookie", adminCookie());
    expect(res.status).toBe(200);
    expect(res.body.counts.active).toBe(2);
    expect(res.body.counts.paid).toBe(1);
    expect(res.body.counts.free).toBe(1);
    expect(res.body.revenue.mrrCents).toBe(500);
    const paidRow = res.body.subscribers.find(
      (s: { email: string }) => s.email === "paid@test.local",
    );
    expect(paidRow.paid).toBe(true);
  });

  test("paid/free split is empty when Stripe has no newsletter subs", async () => {
    await seedSubscriber("free@test.local", null);
    const res = await request(app)
      .get("/api/newsletter/subscribers")
      .set("Cookie", adminCookie());
    expect(res.status).toBe(200);
    expect(res.body.counts.paid).toBe(0);
    expect(res.body.counts.free).toBe(1);
    expect(res.body.revenue.mrrCents).toBe(0);
  });

  test("issue PATCH toggles premium", async () => {
    const issueId = await seedIssue();
    const res = await request(app)
      .patch(`/api/newsletter/issues/${issueId}`)
      .set("Cookie", adminCookie())
      .send({ premium: true });
    expect(res.status).toBe(200);
    expect(res.body.issue.premium).toBe(true);
  });

  test("issue GET returns the paid/free split", async () => {
    await seedPaidNewsletter();
    const issueId = await seedIssue();
    await seedSubscriber("paid@test.local", NL_CUSTOMER_ID);
    await seedSubscriber("free@test.local", null);
    const res = await request(app)
      .get(`/api/newsletter/issues/${issueId}`)
      .set("Cookie", adminCookie());
    expect(res.status).toBe(200);
    expect(res.body.paidSubscribers).toBe(1);
    expect(res.body.freeSubscribers).toBe(1);
  });

  test("premium send: paid get full, free get teaser", async () => {
    await seedPaidNewsletter();
    const issueId = await seedIssue();
    await pool.query(
      `UPDATE newsletter_issues SET premium = true WHERE id = $1`,
      [issueId],
    );
    await pool.query(
      `INSERT INTO newsletter_posts (issue_id, kind, position, title, body_html)
       VALUES ($1,'article',0,'A post','<p>body</p>')`,
      [issueId],
    );
    await seedSubscriber("paid@test.local", NL_CUSTOMER_ID);
    await seedSubscriber("free@test.local", null);

    const res = await request(app)
      .post(`/api/newsletter/issues/${issueId}/send`)
      .set("Cookie", adminCookie());
    expect(res.status).toBe(200);
    expect(res.body.premium).toBe(true);
    expect(res.body.sent).toBe(2);
    expect(res.body.fullSent).toBe(1);
    expect(res.body.teaserSent).toBe(1);
  });

  test("non-premium send: everyone gets the full edition", async () => {
    await seedPaidNewsletter();
    const issueId = await seedIssue();
    await pool.query(
      `INSERT INTO newsletter_posts (issue_id, kind, position, title, body_html)
       VALUES ($1,'article',0,'A post','<p>body</p>')`,
      [issueId],
    );
    await seedSubscriber("paid@test.local", NL_CUSTOMER_ID);
    await seedSubscriber("free@test.local", null);

    const res = await request(app)
      .post(`/api/newsletter/issues/${issueId}/send`)
      .set("Cookie", adminCookie());
    expect(res.status).toBe(200);
    expect(res.body.premium).toBe(false);
    expect(res.body.fullSent).toBe(2);
    expect(res.body.teaserSent).toBe(0);
  });

  test("billing plans endpoint is public and lists newsletter plans", async () => {
    await seedPaidNewsletter();
    const res = await request(app).get("/api/newsletter/billing/plans");
    expect(res.status).toBe(200);
    expect(res.body.plans).toHaveLength(1);
    expect(res.body.plans[0].priceId).toBe("price_nl_m");
    expect(res.body.plans[0].plan).toBe("monthly");
  });

  test("portal request returns generic ok without leaking membership", async () => {
    const res = await request(app)
      .post("/api/newsletter/billing/portal")
      .send({ email: "nobody@test.local" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe("faculty self-publish (own newsletter)", () => {
  test("GET /faculty/publication requires faculty auth", async () => {
    stubFacultyUserId = 0;
    const res = await request(app).get("/api/faculty/publication");
    expect(res.status).toBe(401);
  });

  test("GET /faculty/publication find-or-creates a non-house publication", async () => {
    stubFacultyUserId = facultyAId;
    const first = await request(app).get("/api/faculty/publication");
    expect(first.status).toBe(200);
    expect(first.body.publication.isHouse).toBe(false);
    expect(first.body.publication.facultyUserId).toBe(facultyAId);
    const pubId = first.body.publication.id;
    // Idempotent: a second call returns the same row, not a duplicate.
    const second = await request(app).get("/api/faculty/publication");
    expect(second.body.publication.id).toBe(pubId);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM newsletter_publications WHERE faculty_user_id = $1`,
      [facultyAId],
    );
    expect(rows[0].n).toBe(1);
  });

  test("welcome-preview renders the caller's own branding; test send goes to self", async () => {
    stubFacultyUserId = facultyAId;
    // Brand the publication so the preview reflects the steward's masthead.
    await request(app)
      .patch("/api/faculty/publication")
      .send({ name: "Aurelia's Sleep Letter" });

    const preview = await request(app).get(
      "/api/faculty/publication/welcome-preview",
    );
    expect(preview.status).toBe(200);
    expect(preview.body.subject).toContain("Aurelia's Sleep Letter");
    expect(preview.body.html).toContain("Aurelia's Sleep Letter");

    welcomeEmailCalls.length = 0;
    const test = await request(app).post(
      "/api/faculty/publication/welcome-test",
    );
    expect(test.status).toBe(200);
    expect(test.body.ok).toBe(true);
    // The test always goes to the signed-in steward's own address.
    expect(test.body.to).toBe(test.body.to.toLowerCase());
    expect(test.body.to).toMatch(/^nl-fa-/);
    expect(welcomeEmailCalls).toHaveLength(1);
    expect(welcomeEmailCalls[0]!.to).toBe(test.body.to);

    // Unauthenticated callers get nothing.
    stubFacultyUserId = 0;
    expect(
      (await request(app).get("/api/faculty/publication/welcome-preview"))
        .status,
    ).toBe(401);
    expect(
      (await request(app).post("/api/faculty/publication/welcome-test")).status,
    ).toBe(401);
  });

  test("faculty A cannot read or mutate faculty B's issues/posts/subscribers", async () => {
    // Faculty A builds an issue with a post and a subscriber.
    stubFacultyUserId = facultyAId;
    const issue = await request(app)
      .post("/api/faculty/publication/issues")
      .send({ title: "Alpha issue" });
    expect(issue.status).toBe(200);
    const issueId = issue.body.issue.id;
    const post = await request(app)
      .post(`/api/faculty/publication/issues/${issueId}/posts`)
      .send({ title: "Alpha post", bodyHtml: "<p>hi</p>" });
    expect(post.status).toBe(200);
    const postId = post.body.post.id;
    const sub = await request(app)
      .post("/api/faculty/publication/subscribers")
      .send({ email: "areader@test.local" });
    expect(sub.status).toBe(200);
    const subId = sub.body.subscriber.id;

    // Faculty B sees none of A's data and cannot touch any of it.
    stubFacultyUserId = facultyBId;
    const bIssues = await request(app).get("/api/faculty/publication/issues");
    expect(bIssues.status).toBe(200);
    expect(bIssues.body.issues).toHaveLength(0);

    expect(
      (await request(app).get(`/api/faculty/publication/issues/${issueId}`))
        .status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .patch(`/api/faculty/publication/issues/${issueId}`)
          .send({ title: "hijack" })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app).delete(
          `/api/faculty/publication/issues/${issueId}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .patch(`/api/faculty/publication/posts/${postId}`)
          .send({ title: "hijack" })
      ).status,
    ).toBe(404);
    expect(
      (await request(app).delete(`/api/faculty/publication/posts/${postId}`))
        .status,
    ).toBe(404);

    // B deleting "subscriber subId" is scoped to B's own publication, so A's
    // subscriber survives.
    await request(app).delete(`/api/faculty/publication/subscribers/${subId}`);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM newsletter_subscribers WHERE id = $1`,
      [subId],
    );
    expect(rows[0].n).toBe(1);
  });

  test("PATCH /faculty/publication/slug edits the caller's own handle", async () => {
    stubFacultyUserId = facultyAId;
    const before = (await request(app).get("/api/faculty/publication")).body
      .publication;

    // Normalizes a messy desired handle into a safe slug.
    const ok = await request(app)
      .patch("/api/faculty/publication/slug")
      .send({ slug: "  Dr. Café Rückert!! " });
    expect(ok.status).toBe(200);
    expect(ok.body.publication.slug).toBe("dr-cafe-ruckert");
    expect(ok.body.publication.id).toBe(before.id);

    // The new handle resolves on the public surface; the old one 404s.
    expect(
      (await request(app).get("/api/newsletter/p/dr-cafe-ruckert")).status,
    ).toBe(200);
    expect(
      (await request(app).get(`/api/newsletter/p/${before.slug}`)).status,
    ).toBe(404);
  });

  test("slug update rejects reserved words and taken handles", async () => {
    stubFacultyUserId = facultyAId;
    // Reserved (would collide with the house publication's slug).
    const reserved = await request(app)
      .patch("/api/faculty/publication/slug")
      .send({ slug: "Stanford Lifestyle Medicine" });
    expect(reserved.status).toBe(409);

    // Empty-after-normalization is a 400.
    const empty = await request(app)
      .patch("/api/faculty/publication/slug")
      .send({ slug: "!!!" });
    expect(empty.status).toBe(400);

    // Faculty B claims a clean handle; A then can't take the same one.
    stubFacultyUserId = facultyBId;
    const bOk = await request(app)
      .patch("/api/faculty/publication/slug")
      .send({ slug: "taken-handle" });
    expect(bOk.status).toBe(200);
    stubFacultyUserId = facultyAId;
    const clash = await request(app)
      .patch("/api/faculty/publication/slug")
      .send({ slug: "taken-handle" });
    expect(clash.status).toBe(409);
  });

  test("self-publish send delivers but mints NO credits", async () => {
    stubFacultyUserId = facultyAId;
    const issue = await request(app)
      .post("/api/faculty/publication/issues")
      .send({ title: "Send me" });
    const issueId = issue.body.issue.id;
    await request(app)
      .post(`/api/faculty/publication/issues/${issueId}/posts`)
      .send({ title: "A post", bodyHtml: "<p>body</p>" });
    await request(app)
      .post("/api/faculty/publication/subscribers")
      .send({ email: "reader1@test.local" });

    const send = await request(app).post(
      `/api/faculty/publication/issues/${issueId}/send`,
    );
    expect(send.status).toBe(200);
    expect(send.body.sent).toBe(1);

    // Issue is marked sent...
    const { rows: issueRows } = await pool.query(
      `SELECT status, recipient_count FROM newsletter_issues WHERE id = $1`,
      [issueId],
    );
    expect(issueRows[0].status).toBe("sent");
    expect(issueRows[0].recipient_count).toBe(1);
    // ...and absolutely no credits were minted (self-publish is unpaid).
    const { rows: creditRows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM newsletter_credits`,
    );
    expect(creditRows[0].n).toBe(0);

    // Re-send is blocked (already sent).
    const resend = await request(app).post(
      `/api/faculty/publication/issues/${issueId}/send`,
    );
    expect(resend.status).toBe(409);
  });

  test("subscriber email is unique per publication, not globally", async () => {
    // Same email subscribes to BOTH faculty A's and faculty B's newsletters.
    stubFacultyUserId = facultyAId;
    const pubA = (await request(app).get("/api/faculty/publication")).body
      .publication;
    stubFacultyUserId = facultyBId;
    const pubB = (await request(app).get("/api/faculty/publication")).body
      .publication;

    const a = await request(app)
      .post(`/api/newsletter/p/${pubA.slug}/subscribe`)
      .send({ email: "shared@test.local" });
    expect(a.status).toBe(200);
    const b = await request(app)
      .post(`/api/newsletter/p/${pubB.slug}/subscribe`)
      .send({ email: "shared@test.local" });
    expect(b.status).toBe(200);

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM newsletter_subscribers WHERE email = 'shared@test.local'`,
    );
    expect(rows[0].n).toBe(2);

    // Re-subscribing to the same publication is idempotent (no third row).
    // Under double opt-in the rows are still PENDING (never confirmed), so the
    // re-subscribe re-issues the confirmation (pending) rather than reporting
    // alreadySubscribed — that flag is reserved for confirmed/active rows.
    const again = await request(app)
      .post(`/api/newsletter/p/${pubA.slug}/subscribe`)
      .send({ email: "shared@test.local" });
    expect(again.body.pending || again.body.alreadySubscribed).toBe(true);
    const { rows: rows2 } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM newsletter_subscribers WHERE email = 'shared@test.local'`,
    );
    expect(rows2[0].n).toBe(2);
  });

  test("faculty subscribe → confirm sends a welcome branded for that publication", async () => {
    welcomeEmailCalls.length = 0;
    stubFacultyUserId = facultyAId;
    const pub = (await request(app).get("/api/faculty/publication")).body
      .publication;

    // Subscribing only creates a PENDING row — no welcome yet.
    const sub = await request(app)
      .post(`/api/newsletter/p/${pub.slug}/subscribe`)
      .send({ email: "fac-welcome@test.local", name: "Reader" });
    expect(sub.status).toBe(200);
    expect(welcomeEmailCalls).toHaveLength(0);

    const { rows } = await pool.query(
      `SELECT confirm_token FROM newsletter_subscribers WHERE email = 'fac-welcome@test.local'`,
    );
    const confirm = await request(app).get(
      `/api/newsletter/confirm?token=${encodeURIComponent(rows[0].confirm_token)}`,
    );
    expect(confirm.status).toBe(302);

    // The welcome fires once, branded for the faculty publication (not the
    // house masthead).
    expect(welcomeEmailCalls).toHaveLength(1);
    expect(welcomeEmailCalls[0].to).toBe("fac-welcome@test.local");
    expect(welcomeEmailCalls[0].branding?.masthead).toBe(pub.name);
    expect(welcomeEmailCalls[0].branding?.masthead).not.toBe(
      "Stanford Lifestyle Medicine",
    );
  });

  test("public subscribe to an unknown publication slug is a 404", async () => {
    const res = await request(app)
      .post("/api/newsletter/p/no-such-pub/subscribe")
      .send({ email: "x@test.local" });
    expect(res.status).toBe(404);
  });

  test("house publication remains a singleton (idempotent ensure)", async () => {
    // Two house-scoped subscribes must not create two house publications.
    await request(app)
      .post("/api/newsletter/subscribe")
      .send({ email: "house1@test.local" });
    await request(app)
      .post("/api/newsletter/subscribe")
      .send({ email: "house2@test.local" });
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM newsletter_publications WHERE is_house = true`,
    );
    expect(rows[0].n).toBe(1);
  });

  test("welcome email fires on confirm (not subscribe) and only once", async () => {
    // Under double opt-in, subscribing only creates a PENDING row and sends a
    // confirmation link — NO welcome email yet (we don't welcome an unverified
    // address).
    const first = await request(app)
      .post("/api/newsletter/subscribe")
      .send({ email: "welcome@test.local", name: "Pat" });
    expect(first.status).toBe(200);
    expect(first.body.pending).toBe(true);
    expect(welcomeEmailCalls).toHaveLength(0);

    // Clicking the confirmation link flips pending → active — THIS is the
    // brand-new active moment, so the one-time branded welcome fires here.
    const { rows } = await pool.query(
      `SELECT confirm_token FROM newsletter_subscribers WHERE email = 'welcome@test.local'`,
    );
    const token = rows[0].confirm_token as string;
    const confirm = await request(app).get(
      `/api/newsletter/confirm?token=${encodeURIComponent(token)}`,
    );
    expect(confirm.status).toBe(302);
    expect(welcomeEmailCalls).toHaveLength(1);
    expect(welcomeEmailCalls[0].to).toBe("welcome@test.local");
    expect(welcomeEmailCalls[0].name).toBe("Pat");

    // Re-clicking the (idempotent) confirm link does not send a second welcome.
    const again = await request(app).get(
      `/api/newsletter/confirm?token=${encodeURIComponent(token)}`,
    );
    expect(again.status).toBe(302);
    expect(welcomeEmailCalls).toHaveLength(1);
  });
});

describe("double opt-in (public subscribe → confirm)", () => {
  test("house subscribe creates a PENDING subscriber excluded from sends", async () => {
    const res = await request(app)
      .post("/api/newsletter/subscribe")
      .send({ email: "optin@test.local", name: "Opt In" });
    expect(res.status).toBe(200);
    expect(res.body.pending).toBe(true);
    expect(res.body.alreadySubscribed).toBeFalsy();

    const { rows } = await pool.query(
      `SELECT status, confirm_token, confirmed_at FROM newsletter_subscribers WHERE email = 'optin@test.local'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].confirm_token).toBeTruthy();
    expect(rows[0].confirmed_at).toBeNull();

    // The send paths select recipients WHERE status = 'active', so a pending
    // subscriber is invisible to the audience until they confirm.
    const active = await pool.query(
      `SELECT COUNT(*)::int AS n FROM newsletter_subscribers WHERE status = 'active'`,
    );
    expect(active.rows[0].n).toBe(0);
  });

  test("confirm flips pending → active and is idempotent", async () => {
    await request(app)
      .post("/api/newsletter/subscribe")
      .send({ email: "confirm-me@test.local" });
    const { rows } = await pool.query(
      `SELECT confirm_token FROM newsletter_subscribers WHERE email = 'confirm-me@test.local'`,
    );
    const token = rows[0].confirm_token as string;
    expect(token).toBeTruthy();

    const r1 = await request(app).get(
      `/api/newsletter/confirm?token=${encodeURIComponent(token)}`,
    );
    expect(r1.status).toBe(302);
    expect(r1.headers.location).toContain("confirmed=1");

    const after = await pool.query(
      `SELECT status, confirmed_at FROM newsletter_subscribers WHERE email = 'confirm-me@test.local'`,
    );
    expect(after.rows[0].status).toBe("active");
    expect(after.rows[0].confirmed_at).not.toBeNull();
    const firstConfirmedAt = after.rows[0].confirmed_at;

    // Re-clicking the same link stays active and keeps the original timestamp.
    const r2 = await request(app).get(
      `/api/newsletter/confirm?token=${encodeURIComponent(token)}`,
    );
    expect(r2.status).toBe(302);
    expect(r2.headers.location).toContain("confirmed=1");
    const after2 = await pool.query(
      `SELECT status, confirmed_at FROM newsletter_subscribers WHERE email = 'confirm-me@test.local'`,
    );
    expect(after2.rows[0].status).toBe("active");
    expect(after2.rows[0].confirmed_at).toEqual(firstConfirmedAt);
  });

  test("an unknown confirm token redirects to the expired state", async () => {
    const res = await request(app).get(
      "/api/newsletter/confirm?token=not-a-real-token",
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("expired=1");
  });

  test("a missing confirm token redirects to the expired state", async () => {
    const res = await request(app).get("/api/newsletter/confirm");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("expired=1");
  });

  test("re-subscribing an active subscriber returns alreadySubscribed (no re-pending)", async () => {
    await request(app)
      .post("/api/newsletter/subscribe")
      .send({ email: "already@test.local" });
    const { rows } = await pool.query(
      `SELECT confirm_token FROM newsletter_subscribers WHERE email = 'already@test.local'`,
    );
    await request(app).get(
      `/api/newsletter/confirm?token=${encodeURIComponent(rows[0].confirm_token)}`,
    );

    const again = await request(app)
      .post("/api/newsletter/subscribe")
      .send({ email: "already@test.local" });
    expect(again.status).toBe(200);
    expect(again.body.alreadySubscribed).toBe(true);
    expect(again.body.pending).toBeFalsy();

    const status = await pool.query(
      `SELECT status FROM newsletter_subscribers WHERE email = 'already@test.local'`,
    );
    expect(status.rows[0].status).toBe("active");
  });

  test("faculty-publication subscribe is also pending until confirmed", async () => {
    stubFacultyUserId = facultyAId;
    const pub = (await request(app).get("/api/faculty/publication")).body
      .publication;
    stubFacultyUserId = 0;

    const sub = await request(app)
      .post(`/api/newsletter/p/${pub.slug}/subscribe`)
      .send({ email: "pub-optin@test.local" });
    expect(sub.status).toBe(200);
    expect(sub.body.pending).toBe(true);

    const { rows } = await pool.query(
      `SELECT status, confirm_token FROM newsletter_subscribers WHERE email = 'pub-optin@test.local'`,
    );
    expect(rows[0].status).toBe("pending");
    const token = rows[0].confirm_token as string;
    expect(token).toBeTruthy();

    const confirm = await request(app).get(
      `/api/newsletter/confirm?token=${encodeURIComponent(token)}`,
    );
    expect(confirm.status).toBe(302);
    const after = await pool.query(
      `SELECT status FROM newsletter_subscribers WHERE email = 'pub-optin@test.local'`,
    );
    expect(after.rows[0].status).toBe("active");
  });

  test("editor-added subscribers are auto-confirmed (active, no token)", async () => {
    const res = await request(app)
      .post("/api/newsletter/subscribers")
      .set("Cookie", adminCookie())
      .send({ email: "trusted@test.local", name: "Trusted" });
    expect([200, 201]).toContain(res.status);
    const { rows } = await pool.query(
      `SELECT status FROM newsletter_subscribers WHERE email = 'trusted@test.local'`,
    );
    expect(rows[0].status).toBe("active");
  });

  test("a stale confirm link cannot reactivate an unsubscribed subscriber", async () => {
    // Subscribe, confirm, then unsubscribe. The original confirmation email is
    // still sitting in their inbox with a live-looking token — clicking it must
    // NOT silently undo the unsubscribe.
    await request(app)
      .post("/api/newsletter/subscribe")
      .send({ email: "stale@test.local" });
    const { rows } = await pool.query(
      `SELECT confirm_token, unsubscribe_token FROM newsletter_subscribers WHERE email = 'stale@test.local'`,
    );
    const confirmToken = rows[0].confirm_token as string;
    const unsubToken = rows[0].unsubscribe_token as string;

    await request(app).get(
      `/api/newsletter/confirm?token=${encodeURIComponent(confirmToken)}`,
    );
    await request(app).get(
      `/api/newsletter/unsubscribe?token=${encodeURIComponent(unsubToken)}`,
    );

    const stale = await request(app).get(
      `/api/newsletter/confirm?token=${encodeURIComponent(confirmToken)}`,
    );
    expect(stale.status).toBe(302);
    expect(stale.headers.location).toContain("expired=1");

    const after = await pool.query(
      `SELECT status FROM newsletter_subscribers WHERE email = 'stale@test.local'`,
    );
    expect(after.rows[0].status).toBe("unsubscribed");
  });

  test("editor adding an existing pending subscriber confirms it and clears the token", async () => {
    // A pending row exists (public subscribe, not yet confirmed). An editor then
    // adds the same email — that trusted action should activate the row, stamp
    // confirmedAt, and clear the pending confirm_token so the old link is dead.
    await request(app)
      .post("/api/newsletter/subscribe")
      .send({ email: "editor-converts@test.local" });
    const before = await pool.query(
      `SELECT status, confirm_token FROM newsletter_subscribers WHERE email = 'editor-converts@test.local'`,
    );
    expect(before.rows[0].status).toBe("pending");
    const oldToken = before.rows[0].confirm_token as string;
    expect(oldToken).toBeTruthy();

    const add = await request(app)
      .post("/api/newsletter/subscribers")
      .set("Cookie", adminCookie())
      .send({ email: "editor-converts@test.local" });
    expect([200, 201]).toContain(add.status);

    const after = await pool.query(
      `SELECT status, confirm_token, confirmed_at FROM newsletter_subscribers WHERE email = 'editor-converts@test.local'`,
    );
    expect(after.rows[0].status).toBe("active");
    expect(after.rows[0].confirm_token).toBeNull();
    expect(after.rows[0].confirmed_at).not.toBeNull();

    // The now-stale link resolves to nothing (token was cleared).
    const stale = await request(app).get(
      `/api/newsletter/confirm?token=${encodeURIComponent(oldToken)}`,
    );
    expect(stale.headers.location).toContain("expired=1");
  });

  test("re-subscribing after unsubscribe mints a fresh token; only the new one works", async () => {
    await request(app)
      .post("/api/newsletter/subscribe")
      .send({ email: "fresh@test.local" });
    const first = await pool.query(
      `SELECT confirm_token, unsubscribe_token FROM newsletter_subscribers WHERE email = 'fresh@test.local'`,
    );
    const oldToken = first.rows[0].confirm_token as string;
    await request(app).get(
      `/api/newsletter/confirm?token=${encodeURIComponent(oldToken)}`,
    );
    await request(app).get(
      `/api/newsletter/unsubscribe?token=${encodeURIComponent(first.rows[0].unsubscribe_token)}`,
    );

    // Re-subscribe: returns to pending with a brand-new confirm token.
    const again = await request(app)
      .post("/api/newsletter/subscribe")
      .send({ email: "fresh@test.local" });
    expect(again.body.pending).toBe(true);
    const second = await pool.query(
      `SELECT status, confirm_token FROM newsletter_subscribers WHERE email = 'fresh@test.local'`,
    );
    expect(second.rows[0].status).toBe("pending");
    const newToken = second.rows[0].confirm_token as string;
    expect(newToken).toBeTruthy();
    expect(newToken).not.toBe(oldToken);

    // The OLD token is dead (overwritten); the NEW token activates.
    const staleClick = await request(app).get(
      `/api/newsletter/confirm?token=${encodeURIComponent(oldToken)}`,
    );
    expect(staleClick.headers.location).toContain("expired=1");

    const freshClick = await request(app).get(
      `/api/newsletter/confirm?token=${encodeURIComponent(newToken)}`,
    );
    expect(freshClick.headers.location).toContain("confirmed=1");
    const done = await pool.query(
      `SELECT status FROM newsletter_subscribers WHERE email = 'fresh@test.local'`,
    );
    expect(done.rows[0].status).toBe("active");
  });
});

describe("public publication reading page sanitizes stored HTML (XSS guard)", () => {
  // The public reading page renders introHtml/bodyHtml via dangerouslySetInnerHTML,
  // so the public read endpoint must neutralize stored markup a (trusted-but-
  // fallible) steward could inject — script tags, inline event handlers, and
  // javascript: URLs — while preserving safe rich-text prose.
  test("house /p/:slug surface resolves but keeps PREMIUM issues gated", async () => {
    // The house SLM newsletter is now a public "science home" at its slug, but
    // its PREMIUM issues stay gated to the paid /newsletter flow — only
    // non-premium sent issues appear on the public surface so a leaked /p link
    // can't bypass the paywall.
    const houseListBefore = await request(app).get(
      `/api/newsletter/p/stanford-lifestyle-medicine/issues`,
    );
    // Resolves even on a fresh DB (the house row is materialized lazily).
    expect(houseListBefore.status).toBe(200);
    expect(houseListBefore.body.publication.isHouse).toBe(true);

    const house = (
      await pool.query<{ id: number; slug: string }>(
        `SELECT id, slug FROM newsletter_publications WHERE is_house = true LIMIT 1`,
      )
    ).rows[0];
    expect(house).toBeTruthy();

    // One non-premium and one premium sent issue.
    const freeIssueId = (
      await pool.query<{ id: number }>(
        `INSERT INTO newsletter_issues (publication_id, title, status, sent_at, premium)
         VALUES ($1, 'House free issue', 'sent', now(), false) RETURNING id`,
        [house.id],
      )
    ).rows[0].id;
    const premiumIssueId = (
      await pool.query<{ id: number }>(
        `INSERT INTO newsletter_issues (publication_id, title, status, sent_at, premium)
         VALUES ($1, 'House premium issue', 'sent', now(), true) RETURNING id`,
        [house.id],
      )
    ).rows[0].id;

    try {
      // The list only includes the non-premium issue.
      const list = await request(app).get(
        `/api/newsletter/p/${house.slug}/issues`,
      );
      expect(list.status).toBe(200);
      const ids = (list.body.issues as { id: number }[]).map((i) => i.id);
      expect(ids).toContain(freeIssueId);
      expect(ids).not.toContain(premiumIssueId);

      // The non-premium issue reads; the premium one 404s from this surface.
      expect(
        (
          await request(app).get(
            `/api/newsletter/p/${house.slug}/issues/${freeIssueId}`,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await request(app).get(
            `/api/newsletter/p/${house.slug}/issues/${premiumIssueId}`,
          )
        ).status,
      ).toBe(404);
    } finally {
      await pool.query(`DELETE FROM newsletter_issues WHERE id = ANY($1)`, [
        [freeIssueId, premiumIssueId],
      ]);
    }
  });

  test("strips script/handlers/javascript: from intro and post HTML, keeps prose", async () => {
    const slug = `xss-pub-${Date.now()}`;
    const pubId = (
      await pool.query(
        `INSERT INTO newsletter_publications (is_house, name, slug)
         VALUES (false, 'XSS Test Letter', $1) RETURNING id`,
        [slug],
      )
    ).rows[0].id as number;
    const issueId = (
      await pool.query(
        `INSERT INTO newsletter_issues (publication_id, title, status, sent_at, intro_html)
         VALUES ($1, 'Dangerous issue', 'sent', now(), $2) RETURNING id`,
        [
          pubId,
          `<p>Safe intro</p><script>window.__x=1</script>` +
            `<img src=x onerror="alert(1)"><a href="javascript:alert(2)">link</a>`,
        ],
      )
    ).rows[0].id as number;
    await pool.query(
      `INSERT INTO newsletter_posts (issue_id, kind, position, title, body_html)
       VALUES ($1, 'article', 0, 'Dangerous post', $2)`,
      [
        issueId,
        `<p>Safe body</p><script>steal()</script>` +
          `<div onclick="evil()">x</div><a href="JavaScript:evil()">y</a>`,
      ],
    );

    try {
      const res = await request(app).get(
        `/api/newsletter/p/${slug}/issues/${issueId}`,
      );
      expect(res.status).toBe(200);
      const intro = res.body.issue.introHtml as string;
      const body = res.body.posts[0].bodyHtml as string;

      for (const html of [intro, body]) {
        expect(html).not.toMatch(/<script/i);
        expect(html).not.toMatch(/onerror/i);
        expect(html).not.toMatch(/onclick/i);
        expect(html).not.toMatch(/javascript:/i);
      }
      // Safe prose survives sanitization.
      expect(intro).toContain("Safe intro");
      expect(body).toContain("Safe body");
    } finally {
      // Cascade removes the issue + posts.
      await pool.query(`DELETE FROM newsletter_publications WHERE id = $1`, [
        pubId,
      ]);
    }
  });
});

describe("public publication reading surface (/p/:slug)", () => {
  // Create a non-house publication, returning its id + slug.
  async function seedPublication(slug: string): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO newsletter_publications (is_house, name, slug)
       VALUES (false, $1, $2) RETURNING id`,
      [`Letter ${slug}`, slug],
    );
    return rows[0].id;
  }

  // Insert an issue for a publication. `sentAt` null leaves it unsent.
  async function seedPubIssue(
    pubId: number,
    overrides: Partial<{
      title: string;
      status: string;
      sentAt: Date | null;
      heroImagePath: string | null;
    }> = {},
  ): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO newsletter_issues (publication_id, title, status, sent_at, hero_image_path)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [
        pubId,
        overrides.title ?? "An issue",
        overrides.status ?? "sent",
        overrides.sentAt === undefined ? new Date() : overrides.sentAt,
        overrides.heroImagePath ?? null,
      ],
    );
    return rows[0].id;
  }

  test("issues list returns only sent issues for that exact publication, newest first", async () => {
    const pubId = await seedPublication(`pub-a-${Date.now()}`);
    const otherPubId = await seedPublication(`pub-b-${Date.now()}`);
    const slug = (
      await pool.query<{ slug: string }>(
        `SELECT slug FROM newsletter_publications WHERE id = $1`,
        [pubId],
      )
    ).rows[0].slug;

    // Two sent issues at different times + a draft, all on this publication.
    const older = await seedPubIssue(pubId, {
      title: "Older sent",
      status: "sent",
      sentAt: new Date("2026-01-01T00:00:00Z"),
    });
    const newer = await seedPubIssue(pubId, {
      title: "Newer sent",
      status: "sent",
      sentAt: new Date("2026-02-01T00:00:00Z"),
    });
    await seedPubIssue(pubId, { title: "A draft", status: "draft", sentAt: null });
    // A sent issue on a DIFFERENT publication must not bleed in.
    await seedPubIssue(otherPubId, { title: "Other pub sent", status: "sent" });

    const res = await request(app).get(`/api/newsletter/p/${slug}/issues`);
    expect(res.status).toBe(200);
    const ids = (res.body.issues as Array<{ id: number; title: string }>).map(
      (i) => i.id,
    );
    // Only this publication's sent issues, newest first.
    expect(ids).toEqual([newer, older]);
    expect(res.body.issues.map((i: { title: string }) => i.title)).toEqual([
      "Newer sent",
      "Older sent",
    ]);
  });

  test("single-issue read 404s for a draft, a cross-publication id, and an unknown slug", async () => {
    const pubId = await seedPublication(`pub-c-${Date.now()}`);
    const otherPubId = await seedPublication(`pub-d-${Date.now()}`);
    const slug = (
      await pool.query<{ slug: string }>(
        `SELECT slug FROM newsletter_publications WHERE id = $1`,
        [pubId],
      )
    ).rows[0].slug;

    const draftId = await seedPubIssue(pubId, { status: "draft", sentAt: null });
    const otherSentId = await seedPubIssue(otherPubId, { status: "sent" });

    // Draft on the right publication → 404 (never expose unsent content).
    expect(
      (await request(app).get(`/api/newsletter/p/${slug}/issues/${draftId}`))
        .status,
    ).toBe(404);
    // A sent issue that belongs to ANOTHER publication → 404 under this slug.
    expect(
      (
        await request(app).get(
          `/api/newsletter/p/${slug}/issues/${otherSentId}`,
        )
      ).status,
    ).toBe(404);
    // Unknown slug (even with a real sent id) → 404.
    expect(
      (
        await request(app).get(
          `/api/newsletter/p/no-such-slug-${Date.now()}/issues/${otherSentId}`,
        )
      ).status,
    ).toBe(404);
  });

  test("object-storage image paths are rewritten to /api/storage/...", async () => {
    const pubId = await seedPublication(`pub-e-${Date.now()}`);
    const slug = (
      await pool.query<{ slug: string }>(
        `SELECT slug FROM newsletter_publications WHERE id = $1`,
        [pubId],
      )
    ).rows[0].slug;

    const issueId = await seedPubIssue(pubId, {
      status: "sent",
      heroImagePath: "/objects/hero.png",
    });
    await pool.query(
      `INSERT INTO newsletter_posts (issue_id, kind, position, title, body_html, image_path)
       VALUES ($1, 'article', 0, 'Post with image', '<p>body</p>', '/objects/post.png')`,
      [issueId],
    );

    // List endpoint rewrites the hero image path.
    const list = await request(app).get(`/api/newsletter/p/${slug}/issues`);
    expect(list.status).toBe(200);
    expect(list.body.issues[0].heroImageUrl).toBe("/api/storage/objects/hero.png");

    // Single-issue endpoint rewrites both the hero and the post image path.
    const single = await request(app).get(
      `/api/newsletter/p/${slug}/issues/${issueId}`,
    );
    expect(single.status).toBe(200);
    expect(single.body.issue.heroImageUrl).toBe("/api/storage/objects/hero.png");
    expect(single.body.posts[0].imageUrl).toBe("/api/storage/objects/post.png");
  });

  test("publication payload exposes resolved landing content + hero image", async () => {
    const pubId = await seedPublication(`pub-landing-${Date.now()}`);
    const slug = (
      await pool.query<{ slug: string }>(
        `SELECT slug FROM newsletter_publications WHERE id = $1`,
        [pubId],
      )
    ).rows[0].slug;

    const landingContent = {
      heroEyebrow: "A weekly letter",
      heroHeadline: "Sleep, clearly",
      heroSubhead: "Evidence over folklore.",
      aboutLead: "What this publication is about.",
      sections: [
        {
          heading: "Why it matters",
          body: "Because rest is foundational.",
          imagePath: "/objects/sec0.png",
          imagePrompt: "a calm bedroom",
        },
        {
          heading: "How we work",
          body: "Grounded in studies.",
          imagePath: null,
          imagePrompt: null,
        },
      ],
      benefits: ["Honest takes", "Free to read"],
    };
    await pool.query(
      `UPDATE newsletter_publications
       SET topic = $2, landing_content = $3, hero_image_path = $4
       WHERE id = $1`,
      [pubId, "Sleep science", JSON.stringify(landingContent), "/objects/hero.png"],
    );

    const res = await request(app).get(`/api/newsletter/p/${slug}/issues`);
    expect(res.status).toBe(200);
    const pub = res.body.publication;
    expect(pub.heroImageUrl).toBe("/api/storage/objects/hero.png");
    expect(pub.landing).toBeTruthy();
    expect(pub.landing.heroHeadline).toBe("Sleep, clearly");
    expect(pub.landing.benefits).toEqual(["Honest takes", "Free to read"]);
    // Section image paths resolved to proxy URLs; null stays null.
    expect(pub.landing.sections[0].imageUrl).toBe("/api/storage/objects/sec0.png");
    expect(pub.landing.sections[1].imageUrl).toBeNull();
    // Raw storage paths must never leak to the public payload.
    expect(JSON.stringify(pub.landing)).not.toContain("imagePath");
  });

  test("a publication with no landing content omits it (fallback layout)", async () => {
    const pubId = await seedPublication(`pub-nolanding-${Date.now()}`);
    const slug = (
      await pool.query<{ slug: string }>(
        `SELECT slug FROM newsletter_publications WHERE id = $1`,
        [pubId],
      )
    ).rows[0].slug;

    const res = await request(app).get(`/api/newsletter/p/${slug}/issues`);
    expect(res.status).toBe(200);
    expect(res.body.publication.landing).toBeNull();
    expect(res.body.publication.heroImageUrl).toBeNull();
  });

  // ── "Ask the steward" eligibility ──────────────────────────────────────────
  // Seed a faculty steward who owns a pillar, optionally giving them a published
  // voice profile and/or an approved interpretation, then attach a publication.
  async function seedSteward(opts: {
    voice: boolean;
    approvedInterp: boolean;
    fullName?: string;
  }): Promise<{ slug: string; pillarSlug: string; fullName: string }> {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const fullName = opts.fullName ?? `Dr Steward ${stamp}`;
    const { rows: u } = await pool.query<{ id: number }>(
      `INSERT INTO faculty_users (clerk_user_id, email, full_name)
       VALUES ($1, $2, $3) RETURNING id`,
      [`clerk-${stamp}`, `steward-${stamp}@test.local`, fullName],
    );
    const userId = u[0].id;

    const pillarSlug = `ask-pillar-${stamp}`;
    const { rows: p } = await pool.query<{ id: number }>(
      `INSERT INTO pillars (slug, name) VALUES ($1, $2) RETURNING id`,
      [pillarSlug, `Ask Pillar ${stamp}`],
    );
    const pillarId = p[0].id;
    await pool.query(
      `INSERT INTO faculty_memberships (user_id, pillar_id, role)
       VALUES ($1, $2, 'steward')`,
      [userId, pillarId],
    );

    if (opts.voice) {
      await pool.query(
        `INSERT INTO faculty_voice_profiles (faculty_user_id, tone_summary, approved_at)
         VALUES ($1, $2, NOW())`,
        [userId, "Warm, precise, evidence-first."],
      );
    }
    if (opts.approvedInterp) {
      const { rows: s } = await pool.query<{ id: number }>(
        `INSERT INTO sources (pillar_id, kind, title, status)
         VALUES ($1, 'paper', 'A grounding paper', 'approved') RETURNING id`,
        [pillarId],
      );
      await pool.query(
        `INSERT INTO interpretations (source_id, pillar_id, status, answer, interpretation)
         VALUES ($1, $2, 'approved', 'An answer', 'An interpretation')`,
        [s[0].id, pillarId],
      );
    }

    const pubSlug = `ask-pub-${stamp}`;
    await pool.query(
      `INSERT INTO newsletter_publications (is_house, faculty_user_id, name, slug, byline_name)
       VALUES (false, $1, $2, $3, $4)`,
      [userId, `Letter ${stamp}`, pubSlug, fullName],
    );
    return { slug: pubSlug, pillarSlug, fullName };
  }

  test("steward with a published voice profile + approved content is ask-eligible", async () => {
    const { slug, pillarSlug, fullName } = await seedSteward({
      voice: true,
      approvedInterp: true,
    });
    const res = await request(app).get(`/api/newsletter/p/${slug}/issues`);
    expect(res.status).toBe(200);
    expect(res.body.publication.ask).toEqual({
      eligible: true,
      pillarSlug,
      stewardName: fullName,
    });
    // The single-issue endpoint surfaces the same eligibility verdict.
    const issueId = await seedPubIssue(
      (
        await pool.query<{ id: number }>(
          `SELECT id FROM newsletter_publications WHERE slug = $1`,
          [slug],
        )
      ).rows[0].id,
      { status: "sent" },
    );
    const single = await request(app).get(
      `/api/newsletter/p/${slug}/issues/${issueId}`,
    );
    expect(single.status).toBe(200);
    expect(single.body.publication.ask.eligible).toBe(true);
    expect(single.body.publication.ask.pillarSlug).toBe(pillarSlug);
  });

  test("steward without a published voice profile is not ask-eligible", async () => {
    const { slug } = await seedSteward({ voice: false, approvedInterp: true });
    const res = await request(app).get(`/api/newsletter/p/${slug}/issues`);
    expect(res.status).toBe(200);
    expect(res.body.publication.ask.eligible).toBe(false);
    expect(res.body.publication.ask.pillarSlug).toBeNull();
  });

  test("steward with a voice profile but no approved content is not ask-eligible", async () => {
    const { slug } = await seedSteward({ voice: true, approvedInterp: false });
    const res = await request(app).get(`/api/newsletter/p/${slug}/issues`);
    expect(res.status).toBe(200);
    expect(res.body.publication.ask.eligible).toBe(false);
  });

  test("the house publication is never ask-eligible", async () => {
    const pubId = await seedPublication(`pub-house-ask-${Date.now()}`);
    // Force it to the house shape (no steward author).
    await pool.query(
      `UPDATE newsletter_publications SET is_house = true, faculty_user_id = NULL WHERE id = $1`,
      [pubId],
    );
    const slug = (
      await pool.query<{ slug: string }>(
        `SELECT slug FROM newsletter_publications WHERE id = $1`,
        [pubId],
      )
    ).rows[0].slug;
    const res = await request(app).get(`/api/newsletter/p/${slug}/issues`);
    expect(res.status).toBe(200);
    expect(res.body.publication.ask).toEqual({
      eligible: false,
      pillarSlug: null,
      stewardName: null,
    });
  });
});

describe("house landing editor (editor/admin)", () => {
  test("PUT /newsletter/publication/landing saves edits; public reflects them", async () => {
    // House publication is auto-provisioned by ensureHousePublication().
    const landingContent = {
      heroEyebrow: "Stanford Lifestyle Medicine",
      heroHeadline: "The house letter",
      heroSubhead: "From the SLM faculty.",
      aboutLead: "Our editorial mission.",
      sections: [
        {
          heading: "Section one",
          body: "Body one.",
          imagePath: null,
          imagePrompt: null,
        },
      ],
      benefits: ["Faculty-authored", "Free"],
    };

    const save = await request(app)
      .put("/api/newsletter/publication/landing")
      .set("Cookie", adminCookie())
      .send({ topic: "Lifestyle medicine", landingContent });
    expect(save.status).toBe(200);
    expect(save.body.publication.topic).toBe("Lifestyle medicine");
    expect(save.body.publication.landingContent.heroHeadline).toBe(
      "The house letter",
    );
    expect(save.body.publication.landingContent.benefits).toEqual([
      "Faculty-authored",
      "Free",
    ]);

    // The edit persisted to the house row. (The house publication is
    // intentionally NOT exposed through the steward /p/:slug surface; it has its
    // own gated /newsletter experience, so we verify the stored row directly.)
    const stored = (
      await pool.query<{ landing_content: { heroHeadline: string } }>(
        `SELECT landing_content FROM newsletter_publications WHERE is_house = true LIMIT 1`,
      )
    ).rows[0];
    expect(stored.landing_content.heroHeadline).toBe("The house letter");

    // The editor GET surfaces it back for re-editing.
    const get = await request(app)
      .get("/api/newsletter/publication")
      .set("Cookie", adminCookie());
    expect(get.status).toBe(200);
    expect(get.body.publication.landingContent.heroHeadline).toBe(
      "The house letter",
    );
  });

  test("landing endpoints require an editor/admin session", async () => {
    const res = await request(app)
      .put("/api/newsletter/publication/landing")
      .send({ topic: "x", landingContent: { heroHeadline: "nope" } });
    expect(res.status).toBe(401);
  });

  test("PUT rejects invalid landing content", async () => {
    const res = await request(app)
      .put("/api/newsletter/publication/landing")
      .set("Cookie", adminCookie())
      .send({ landingContent: "not-an-object" });
    expect(res.status).toBe(400);
  });
});
