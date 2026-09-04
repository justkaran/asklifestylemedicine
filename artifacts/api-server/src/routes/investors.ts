import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { randomBytes } from "crypto";
import { eq, desc, and, isNull, gt, inArray } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import {
  db,
  investorsTable,
  investorSessionsTable,
  investorDecksTable,
  investorDeckGrantsTable,
  investorUpdatesTable,
  investorRequestsTable,
  investorDocumentsTable,
  investorSettingsTable,
  investorCashFlowTable,
} from "@workspace/db";
import { sendInvestorMagicLink } from "../lib/investorEmail";
import { emailRateLimit } from "../middlewares/emailRateLimit";
import { syncInvestorDecks } from "../lib/investorDecks";
import { AUTO_PLATFORM_ADMIN_EMAILS } from "../middlewares/facultyAuth";

const router: IRouter = Router();

const anthropic = new Anthropic({
  baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
});

const INVESTOR_COOKIE = "investor_session";

// Build a safe `Content-Disposition` filename from a deck slug. Deck slugs are
// already URL-safe, but strip anything that isn't [a-z0-9-_] defensively so a
// slug can never inject header characters (quotes, CR/LF).
function safeDeckFilename(slug: string): string {
  const base = slug.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "deck";
  return `${base}.html`;
}

// ── Cap table (investor-facing, fixed) ──────────────────────────────────────
// Beneficial ownership behind the 20% unallocated pool: Karan 95% / Allison 5%.
// Faculty equity is deliberately undecided — see the conflict-of-interest note
// surfaced from investor_settings.cap_table_note.
const CAP_TABLE = {
  rows: [
    { holder: "Karan", role: "Founder", percent: 76 },
    { holder: "Allison", role: "Co-founder", percent: 4 },
    {
      holder: "Unallocated pool",
      role: "Reserved (beneficially Karan 95% / Allison 5%)",
      percent: 20,
    },
  ],
  faculty: ["Michael", "Jamie", "Anne"],
};

const DEFAULT_CAP_TABLE_NOTE =
  "Faculty equity (Michael, Jamie, Anne) is still to be decided. Because they also steward the science on the platform, their participation carries a potential conflict of interest, so no final faculty percentage has been set.";

const DEFAULT_HOTLINE_NOTE = "Miss me? Call me :)";

const INVESTOR_STATUSES = ["lead", "committed", "pending", "passed"];

// Roster display order: the lead investor first, then committed backers, then
// everyone still in conversation, then those who passed. This is investor-facing
// and money-free, so it's safe to apply to the shared portal payload.
const ROSTER_STATUS_RANK: Record<string, number> = {
  lead: 0,
  committed: 1,
  pending: 2,
  passed: 3,
};

function byRosterOrder(a: InvestorRow, b: InvestorRow): number {
  const ra = ROSTER_STATUS_RANK[a.status] ?? 99;
  const rb = ROSTER_STATUS_RANK[b.status] ?? 99;
  if (ra !== rb) return ra - rb;
  // Stable within a status: keep the existing newest-first ordering.
  return b.createdAt.getTime() - a.createdAt.getTime();
}

// ── Settings helpers ────────────────────────────────────────────────────────

async function getSettings() {
  const rows = await db
    .select()
    .from(investorSettingsTable)
    .where(eq(investorSettingsTable.id, "default"))
    .limit(1);
  return rows[0] ?? null;
}

function hotlineView(s: Awaited<ReturnType<typeof getSettings>>) {
  return {
    number: s?.hotlineNumber ?? null,
    note: s?.hotlineNote ?? DEFAULT_HOTLINE_NOTE,
  };
}

function capTableView(s: Awaited<ReturnType<typeof getSettings>>) {
  return {
    rows: CAP_TABLE.rows,
    faculty: CAP_TABLE.faculty,
    facultyNote: s?.capTableNote ?? DEFAULT_CAP_TABLE_NOTE,
  };
}

// ── Serializers (money is admin-only) ───────────────────────────────────────

type InvestorRow = typeof investorsTable.$inferSelect;

/** Investor-facing projection — NEVER includes commitment amounts or notes. */
function publicInvestor(i: InvestorRow) {
  return {
    id: i.id,
    name: i.name,
    role: i.role,
    status: i.status,
  };
}

/** The signed-in investor's own profile (still no money). */
function selfInvestor(i: InvestorRow) {
  return {
    id: i.id,
    name: i.name,
    email: i.email,
    role: i.role,
    status: i.status,
    newsletterAccess: i.newsletterAccess,
  };
}

/** Admin projection — includes the private money fields. */
function adminInvestor(i: InvestorRow) {
  return {
    id: i.id,
    name: i.name,
    email: i.email,
    role: i.role,
    status: i.status,
    commitmentCents: i.commitmentCents,
    notes: i.notes,
    newsletterAccess: i.newsletterAccess,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
}

// ── Investor auth ───────────────────────────────────────────────────────────

async function getSessionInvestor(req: Request): Promise<InvestorRow | null> {
  const token = req.signedCookies?.[INVESTOR_COOKIE] as string | undefined;
  if (!token) return null;
  const rows = await db
    .select()
    .from(investorSessionsTable)
    .where(eq(investorSessionsTable.sessionToken, token))
    .limit(1);
  const s = rows[0];
  if (!s) return null;
  if (s.sessionExpiresAt && s.sessionExpiresAt.getTime() < Date.now())
    return null;
  const inv = await db
    .select()
    .from(investorsTable)
    .where(eq(investorsTable.id, s.investorId))
    .limit(1);
  return inv[0] ?? null;
}

async function requireInvestorAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const inv = await getSessionInvestor(req);
  if (!inv) return res.status(401).json({ error: "Unauthorized" });
  (req as any).investor = inv;
  return next();
}

// ── Lead-investor gate (platform admin) ─────────────────────────────────────
// The lead surfaces (total committed amount + AI cash-flow planner) are visible
// ONLY to the platform admin — matched by the signed-in investor's email against
// the same allowlist that grants faculty platform-admin. Everything behind this
// gate is derived from the private commitment totals, so the check is enforced
// server-side, never just hidden in the UI.

function isLeadInvestor(inv: InvestorRow): boolean {
  return (
    !!inv.email && AUTO_PLATFORM_ADMIN_EMAILS.has(inv.email.toLowerCase())
  );
}

async function requireLeadInvestor(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const inv = await getSessionInvestor(req);
  if (!inv) return res.status(401).json({ error: "Unauthorized" });
  if (!isLeadInvestor(inv)) return res.status(403).json({ error: "Forbidden" });
  (req as any).investor = inv;
  return next();
}

// ── Admin auth (reuse the signed palonur_admin cookie) ──────────────────────

function isAdmin(req: Request): boolean {
  return req.signedCookies?.palonur_admin === "1";
}

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (isAdmin(req)) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

// ── Magic-link auth routes ──────────────────────────────────────────────────

router.post("/investor-auth/request", emailRateLimit, async (req: Request, res: Response) => {
  const email = String((req.body as { email?: string }).email ?? "")
    .trim()
    .toLowerCase();
  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "Email required" });
  }
  const rows = await db
    .select()
    .from(investorsTable)
    .where(eq(investorsTable.email, email))
    .limit(1);
  const inv = rows[0];
  if (!inv) {
    // Never leak who is on the allowlist — generic success.
    req.log.warn({ email }, "investor magic-link requested for unknown email");
    return res.json({ ok: true });
  }
  const token = randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  await db.insert(investorSessionsTable).values({
    investorId: inv.id,
    magicToken: token,
    expiresAt,
  });
  await sendInvestorMagicLink({ to: inv.email, name: inv.name, token });
  return res.json({ ok: true });
});

router.get("/investor-auth/consume", async (req: Request, res: Response) => {
  const token = String(req.query.token ?? "");
  if (!token) return res.status(400).json({ error: "Token required" });
  const sessionToken = randomBytes(32).toString("hex");
  const sessionExpiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
  // Atomic single-use consume: only the first request whose token is still
  // unconsumed AND unexpired wins the row, so concurrent consumes can't both
  // succeed.
  const consumed = await db
    .update(investorSessionsTable)
    .set({ consumedAt: new Date(), sessionToken, sessionExpiresAt })
    .where(
      and(
        eq(investorSessionsTable.magicToken, token),
        isNull(investorSessionsTable.consumedAt),
        gt(investorSessionsTable.expiresAt, new Date()),
      ),
    )
    .returning();
  if (consumed.length === 0) {
    return res.status(400).json({ error: "Link expired or already used" });
  }
  res.cookie(INVESTOR_COOKIE, sessionToken, {
    signed: true,
    httpOnly: true,
    sameSite: "lax",
    maxAge: 8 * 60 * 60 * 1000,
  });
  return res.json({ ok: true });
});

router.get("/investor-auth/me", async (req: Request, res: Response) => {
  const inv = await getSessionInvestor(req);
  if (!inv) return res.status(401).json({ error: "Unauthorized" });
  return res.json({ investor: selfInvestor(inv) });
});

router.post("/investor-auth/logout", (_req: Request, res: Response) => {
  res.clearCookie(INVESTOR_COOKIE);
  return res.json({ ok: true });
});

// ── Investor portal bundle ──────────────────────────────────────────────────

router.get(
  "/investor/portal",
  requireInvestorAuth,
  async (req: Request, res: Response) => {
    const inv = (req as any).investor as InvestorRow;
    const settings = await getSettings();

    const [updates, grants, allInvestors, documents, myRequests] =
      await Promise.all([
        db
          .select()
          .from(investorUpdatesTable)
          .orderBy(
            desc(investorUpdatesTable.pinned),
            desc(investorUpdatesTable.publishedAt),
          ),
        db
          .select()
          .from(investorDeckGrantsTable)
          .where(eq(investorDeckGrantsTable.investorId, inv.id)),
        db.select().from(investorsTable).orderBy(desc(investorsTable.createdAt)),
        db
          .select()
          .from(investorDocumentsTable)
          .orderBy(desc(investorDocumentsTable.createdAt)),
        db
          .select()
          .from(investorRequestsTable)
          .where(eq(investorRequestsTable.investorId, inv.id))
          .orderBy(desc(investorRequestsTable.createdAt)),
      ]);

    // Resolve granted decks to their metadata.
    const grantedSlugs = grants.map((g) => g.deckSlug);
    let decks: { slug: string; title: string; description: string | null }[] =
      [];
    if (grantedSlugs.length > 0) {
      const deckRows = await db.select().from(investorDecksTable);
      const bySlug = new Map(deckRows.map((d) => [d.slug, d]));
      decks = grantedSlugs
        .map((slug) => bySlug.get(slug))
        .filter((d): d is NonNullable<typeof d> => !!d && d.listed)
        .map((d) => ({
          slug: d.slug,
          title: d.title,
          description: d.description,
        }));
    }

    return res.json({
      investor: selfInvestor(inv),
      updates: updates.map((u) => ({
        id: u.id,
        title: u.title,
        bodyHtml: u.bodyHtml,
        pinned: u.pinned,
        publishedAt: u.publishedAt,
      })),
      capTable: capTableView(settings),
      roster: allInvestors.slice().sort(byRosterOrder).map(publicInvestor),
      decks,
      documents: documents.map((d) => ({
        id: d.id,
        title: d.title,
        description: d.description,
        objectPath: d.objectPath,
        externalUrl: d.externalUrl,
        sizeBytes: d.sizeBytes,
        contentType: d.contentType,
      })),
      hotline: hotlineView(settings),
      newsletterAccess: inv.newsletterAccess,
      requests: myRequests.map((r) => ({
        id: r.id,
        subject: r.subject,
        body: r.body,
        status: r.status,
        responseHtml: r.responseHtml,
        respondedAt: r.respondedAt,
        createdAt: r.createdAt,
      })),
    });
  },
);

// ── Lead-investor surfaces (platform admin only) ────────────────────────────
// These are derived from the private commitment totals and must NEVER fold into
// the shared /investor/portal bundle. Guarded by requireLeadInvestor.

/** Sum committed money across investors whose status is `lead` or `committed`. */
async function totalCommittedCents(): Promise<number> {
  const rows = await db
    .select({
      status: investorsTable.status,
      commitmentCents: investorsTable.commitmentCents,
    })
    .from(investorsTable)
    .where(inArray(investorsTable.status, ["lead", "committed"]));
  return rows.reduce((sum, r) => sum + (r.commitmentCents ?? 0), 0);
}

/** The persisted (singleton) cash-flow plan, or null if none generated yet. */
async function getCashFlowPlan() {
  const rows = await db
    .select()
    .from(investorCashFlowTable)
    .where(eq(investorCashFlowTable.id, "default"))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    deckSlug: row.deckSlug,
    deckTitle: row.deckTitle,
    targetDate: row.targetDate,
    totalCommittedCents: row.totalCommittedCents,
    planText: row.planText,
    updatedAt: row.updatedAt,
  };
}

/** Listed decks (with HTML content) the lead can connect to the planner. */
async function connectableDecks() {
  const rows = await db.select().from(investorDecksTable);
  return rows
    .filter((d) => d.listed && !!d.html)
    .map((d) => ({ slug: d.slug, title: d.title, description: d.description }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

router.get(
  "/investor/lead-summary",
  requireLeadInvestor,
  async (_req: Request, res: Response) => {
    const [total, decks, plan] = await Promise.all([
      totalCommittedCents(),
      connectableDecks(),
      getCashFlowPlan(),
    ]);
    return res.json({ totalCommittedCents: total, decks, plan });
  },
);

// Strip HTML tags + collapse whitespace so the model receives the deck's prose,
// not its markup. Capped so a long deck never blows the prompt budget.
function deckPlainText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12000);
}

function fmtUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

router.post(
  "/investor/cash-flow",
  requireLeadInvestor,
  async (req: Request, res: Response) => {
    const inv = (req as any).investor as InvestorRow;
    const b = req.body as { deckSlug?: string; targetDate?: string };
    const deckSlug = String(b.deckSlug ?? "").trim();
    const targetDate = String(b.targetDate ?? "").trim();
    if (!deckSlug) return res.status(400).json({ error: "deckSlug required" });
    // Expect an ISO date (YYYY-MM-DD from a <input type="date">).
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
      return res.status(400).json({ error: "A valid target date is required" });
    }
    const parsed = new Date(`${targetDate}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
      return res.status(400).json({ error: "Target date must be in the future" });
    }

    const deckRows = await db
      .select()
      .from(investorDecksTable)
      .where(eq(investorDecksTable.slug, deckSlug))
      .limit(1);
    const deck = deckRows[0];
    if (!deck || !deck.html) {
      return res.status(404).json({ error: "Deck not available" });
    }

    const total = await totalCommittedCents();
    const deckText = deckPlainText(deck.html);

    // IMPORTANT: the output must read as Palonur's OWN cash flow only. Apply any
    // SLM revenue split silently — never name or display a split / donation /
    // revenue-share line (see the investor-deck cash-flow convention).
    const system = `You are a financial analyst building a cash-flow plan for Palonur, a governed-RAG startup. Produce ONLY Palonur's own cash flow. Apply any revenue split with partners silently inside your reasoning — NEVER name, label, or show a "split", "donation", or "revenue share" line, column, or note anywhere in the output. Be concrete and grounded in the provided deck content. Do not invent funding beyond the stated committed total.`;

    const prompt = `Committed funding available (the starting cash): ${fmtUsd(total)}.
Plan horizon: from today through ${targetDate}.

Source deck "${deck.title}":
"""
${deckText}
"""

Write a clear, period-by-period cash-flow plan (use monthly or quarterly periods, whichever fits the horizon best) projecting Palonur's cash from the committed total out to ${targetDate}. For each period show: expected inflows, key outflows/spend, net change, and ending cash balance. Ground the spend and revenue assumptions in the deck's plan. End with a short note on runway and the cash position at the target date. Use plain text with clear period headers — no markdown tables.`;

    let planText = "";
    try {
      const msg = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        system,
        messages: [{ role: "user", content: prompt }],
      });
      const part = msg.content.find((p: any) => p.type === "text") as
        | { text?: string }
        | undefined;
      planText = (part?.text ?? "").trim();
    } catch (e) {
      req.log.error({ err: e }, "cash-flow generation failed");
      return res
        .status(502)
        .json({ error: "Could not generate the cash-flow plan. Try again." });
    }
    if (!planText) {
      return res
        .status(502)
        .json({ error: "Could not generate the cash-flow plan. Try again." });
    }

    await db
      .insert(investorCashFlowTable)
      .values({
        id: "default",
        deckSlug,
        deckTitle: deck.title,
        targetDate,
        totalCommittedCents: total,
        planText,
        generatedBy: inv.email,
      })
      .onConflictDoUpdate({
        target: investorCashFlowTable.id,
        set: {
          deckSlug,
          deckTitle: deck.title,
          targetDate,
          totalCommittedCents: total,
          planText,
          generatedBy: inv.email,
        },
      });

    const plan = await getCashFlowPlan();
    return res.json({ totalCommittedCents: total, plan });
  },
);

// ── Gated deck viewer ───────────────────────────────────────────────────────

router.get(
  "/investor/decks/:slug",
  requireInvestorAuth,
  async (req: Request, res: Response) => {
    const inv = (req as any).investor as InvestorRow;
    const slug = String(req.params.slug);
    const grant = await db
      .select()
      .from(investorDeckGrantsTable)
      .where(
        and(
          eq(investorDeckGrantsTable.investorId, inv.id),
          eq(investorDeckGrantsTable.deckSlug, slug),
        ),
      )
      .limit(1);
    if (grant.length === 0) {
      return res.status(403).json({ error: "No access to this deck" });
    }
    const deckRows = await db
      .select()
      .from(investorDecksTable)
      .where(eq(investorDecksTable.slug, slug))
      .limit(1);
    const deck = deckRows[0];
    if (!deck || !deck.html) {
      return res.status(404).json({ error: "Deck not available" });
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    if ("download" in req.query) {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${safeDeckFilename(slug)}"`,
      );
    }
    return res.send(deck.html);
  },
);

// ── Investor: request-info tickets ──────────────────────────────────────────

router.post(
  "/investor/requests",
  requireInvestorAuth,
  async (req: Request, res: Response) => {
    const inv = (req as any).investor as InvestorRow;
    const body = req.body as { subject?: string; body?: string };
    const subject = String(body.subject ?? "").trim();
    if (!subject) return res.status(400).json({ error: "Subject required" });
    const rows = await db
      .insert(investorRequestsTable)
      .values({
        investorId: inv.id,
        subject,
        body: body.body ? String(body.body) : null,
      })
      .returning();
    const r = rows[0];
    return res.json({
      request: {
        id: r.id,
        subject: r.subject,
        body: r.body,
        status: r.status,
        createdAt: r.createdAt,
      },
    });
  },
);

// ════════════════════════════════════════════════════════════════════════════
// Admin routes (palonur_admin cookie)
// ════════════════════════════════════════════════════════════════════════════

// — Investors CRUD —
router.get(
  "/investor-admin/investors",
  requireAdmin,
  async (_req: Request, res: Response) => {
    const rows = await db
      .select()
      .from(investorsTable)
      .orderBy(desc(investorsTable.createdAt));
    return res.json({ investors: rows.map(adminInvestor) });
  },
);

router.post(
  "/investor-admin/investors",
  requireAdmin,
  async (req: Request, res: Response) => {
    const b = req.body as {
      name?: string;
      email?: string;
      role?: string;
      status?: string;
      commitmentCents?: number;
      notes?: string;
      newsletterAccess?: boolean;
    };
    const name = String(b.name ?? "").trim();
    const email = String(b.email ?? "").trim().toLowerCase();
    if (!name || !email.includes("@")) {
      return res.status(400).json({ error: "Name and valid email required" });
    }
    if (b.status != null && !INVESTOR_STATUSES.includes(String(b.status))) {
      return res.status(400).json({ error: "Invalid status" });
    }
    try {
      const rows = await db
        .insert(investorsTable)
        .values({
          name,
          email,
          role: b.role ? String(b.role) : null,
          status: (b.status as any) ?? "pending",
          commitmentCents:
            typeof b.commitmentCents === "number" ? b.commitmentCents : null,
          notes: b.notes ? String(b.notes) : null,
          newsletterAccess: b.newsletterAccess ?? true,
        })
        .returning();
      return res.json({ investor: adminInvestor(rows[0]) });
    } catch (e: any) {
      const code = e?.code ?? e?.cause?.code;
      if (String(code) === "23505") {
        return res.status(409).json({ error: "An investor with that email already exists" });
      }
      req.log.error({ err: e }, "Failed to create investor");
      return res.status(500).json({ error: "Failed to create investor" });
    }
  },
);

router.patch(
  "/investor-admin/investors/:id",
  requireAdmin,
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Bad id" });
    const b = req.body as Record<string, unknown>;
    const set: Record<string, unknown> = {};
    if (typeof b.name === "string") set.name = b.name.trim();
    if (typeof b.email === "string") set.email = b.email.trim().toLowerCase();
    if (typeof b.role === "string" || b.role === null) set.role = b.role;
    if (typeof b.status === "string") {
      if (!INVESTOR_STATUSES.includes(b.status))
        return res.status(400).json({ error: "Invalid status" });
      set.status = b.status;
    }
    if (typeof b.commitmentCents === "number" || b.commitmentCents === null)
      set.commitmentCents = b.commitmentCents;
    if (typeof b.notes === "string" || b.notes === null) set.notes = b.notes;
    if (typeof b.newsletterAccess === "boolean")
      set.newsletterAccess = b.newsletterAccess;
    if (Object.keys(set).length === 0)
      return res.status(400).json({ error: "Nothing to update" });
    const rows = await db
      .update(investorsTable)
      .set(set)
      .where(eq(investorsTable.id, id))
      .returning();
    if (rows.length === 0)
      return res.status(404).json({ error: "Not found" });
    return res.json({ investor: adminInvestor(rows[0]) });
  },
);

router.delete(
  "/investor-admin/investors/:id",
  requireAdmin,
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Bad id" });
    await db.delete(investorsTable).where(eq(investorsTable.id, id));
    return res.json({ ok: true });
  },
);

// — Admin: generate a magic link to hand to an investor manually —
router.post(
  "/investor-admin/investors/:id/magic-link",
  requireAdmin,
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Bad id" });
    const inv = (
      await db.select().from(investorsTable).where(eq(investorsTable.id, id)).limit(1)
    )[0];
    if (!inv) return res.status(404).json({ error: "Not found" });
    const token = randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    await db
      .insert(investorSessionsTable)
      .values({ investorId: inv.id, magicToken: token, expiresAt });
    const send = req.query.send === "1" || (req.body as any)?.send === true;
    if (send) await sendInvestorMagicLink({ to: inv.email, name: inv.name, token });
    const base = process.env.PUBLIC_URL ?? "https://palonur.replit.app";
    return res.json({
      link: `${base}/investor-login?token=${encodeURIComponent(token)}`,
      sent: send,
    });
  },
);

// — Decks (metadata + resync) —
router.get(
  "/investor-admin/decks",
  requireAdmin,
  async (req: Request, res: Response) => {
    let rows = await db.select().from(investorDecksTable);
    // Self-heal: the canonical decks are seeded on boot, but a wiped table
    // (e.g. the dev DB after a test-suite TRUNCATE) would leave the admin
    // deck-access panel empty. Re-sync once on demand so the list never shows
    // blank when the source decks are available on disk.
    if (rows.length === 0) {
      try {
        await syncInvestorDecks();
        rows = await db.select().from(investorDecksTable);
      } catch (err) {
        req.log.warn({ err }, "On-demand investor deck sync failed");
      }
    }
    return res.json({
      decks: rows
        .map((d) => ({
          slug: d.slug,
          title: d.title,
          description: d.description,
          listed: d.listed,
          hasHtml: !!d.html,
        }))
        .sort((a, b) => a.title.localeCompare(b.title)),
    });
  },
);

router.post(
  "/investor-admin/decks/resync",
  requireAdmin,
  async (_req: Request, res: Response) => {
    const result = await syncInvestorDecks();
    return res.json(result);
  },
);

// Admin download of a deck's HTML (so Karan can send it to an investor).
router.get(
  "/investor-admin/decks/:slug/download",
  requireAdmin,
  async (req: Request, res: Response) => {
    const slug = String(req.params.slug);
    const deckRows = await db
      .select()
      .from(investorDecksTable)
      .where(eq(investorDecksTable.slug, slug))
      .limit(1);
    const deck = deckRows[0];
    if (!deck || !deck.html) {
      return res.status(404).json({ error: "Deck not available" });
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeDeckFilename(slug)}"`,
    );
    return res.send(deck.html);
  },
);

// — Deck grants —
router.get(
  "/investor-admin/investors/:id/grants",
  requireAdmin,
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Bad id" });
    const rows = await db
      .select()
      .from(investorDeckGrantsTable)
      .where(eq(investorDeckGrantsTable.investorId, id));
    return res.json({ grants: rows.map((g) => g.deckSlug) });
  },
);

router.post(
  "/investor-admin/investors/:id/grants",
  requireAdmin,
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Bad id" });
    const slug = String((req.body as { deckSlug?: string }).deckSlug ?? "").trim();
    if (!slug) return res.status(400).json({ error: "deckSlug required" });
    await db
      .insert(investorDeckGrantsTable)
      .values({ investorId: id, deckSlug: slug, grantedBy: "admin" })
      .onConflictDoNothing();
    return res.json({ ok: true });
  },
);

router.delete(
  "/investor-admin/investors/:id/grants/:slug",
  requireAdmin,
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Bad id" });
    const slug = String(req.params.slug);
    await db
      .delete(investorDeckGrantsTable)
      .where(
        and(
          eq(investorDeckGrantsTable.investorId, id),
          eq(investorDeckGrantsTable.deckSlug, slug),
        ),
      );
    return res.json({ ok: true });
  },
);

// — Updates feed CRUD —
router.get(
  "/investor-admin/updates",
  requireAdmin,
  async (_req: Request, res: Response) => {
    const rows = await db
      .select()
      .from(investorUpdatesTable)
      .orderBy(
        desc(investorUpdatesTable.pinned),
        desc(investorUpdatesTable.publishedAt),
      );
    return res.json({ updates: rows });
  },
);

router.post(
  "/investor-admin/updates",
  requireAdmin,
  async (req: Request, res: Response) => {
    const b = req.body as { title?: string; bodyHtml?: string; pinned?: boolean };
    const title = String(b.title ?? "").trim();
    if (!title) return res.status(400).json({ error: "Title required" });
    const rows = await db
      .insert(investorUpdatesTable)
      .values({
        title,
        bodyHtml: b.bodyHtml ? String(b.bodyHtml) : null,
        pinned: b.pinned ?? false,
        createdBy: "admin",
      })
      .returning();
    return res.json({ update: rows[0] });
  },
);

router.patch(
  "/investor-admin/updates/:id",
  requireAdmin,
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Bad id" });
    const b = req.body as Record<string, unknown>;
    const set: Record<string, unknown> = {};
    if (typeof b.title === "string") set.title = b.title.trim();
    if (typeof b.bodyHtml === "string" || b.bodyHtml === null)
      set.bodyHtml = b.bodyHtml;
    if (typeof b.pinned === "boolean") set.pinned = b.pinned;
    if (Object.keys(set).length === 0)
      return res.status(400).json({ error: "Nothing to update" });
    const rows = await db
      .update(investorUpdatesTable)
      .set(set)
      .where(eq(investorUpdatesTable.id, id))
      .returning();
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });
    return res.json({ update: rows[0] });
  },
);

router.delete(
  "/investor-admin/updates/:id",
  requireAdmin,
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Bad id" });
    await db.delete(investorUpdatesTable).where(eq(investorUpdatesTable.id, id));
    return res.json({ ok: true });
  },
);

// — Data-room documents CRUD —
router.get(
  "/investor-admin/documents",
  requireAdmin,
  async (_req: Request, res: Response) => {
    const rows = await db
      .select()
      .from(investorDocumentsTable)
      .orderBy(desc(investorDocumentsTable.createdAt));
    return res.json({ documents: rows });
  },
);

router.post(
  "/investor-admin/documents",
  requireAdmin,
  async (req: Request, res: Response) => {
    const b = req.body as {
      title?: string;
      description?: string;
      objectPath?: string;
      externalUrl?: string;
      sizeBytes?: number;
      contentType?: string;
    };
    const title = String(b.title ?? "").trim();
    if (!title) return res.status(400).json({ error: "Title required" });
    if (!b.objectPath && !b.externalUrl) {
      return res
        .status(400)
        .json({ error: "Either an uploaded file or an external link is required" });
    }
    // Size/type are only meaningful for uploaded files; external links keep them null.
    const sizeBytes =
      b.objectPath && typeof b.sizeBytes === "number" && Number.isFinite(b.sizeBytes)
        ? Math.max(0, Math.round(b.sizeBytes))
        : null;
    const contentType =
      b.objectPath && b.contentType ? String(b.contentType) : null;
    const rows = await db
      .insert(investorDocumentsTable)
      .values({
        title,
        description: b.description ? String(b.description) : null,
        objectPath: b.objectPath ? String(b.objectPath) : null,
        externalUrl: b.externalUrl ? String(b.externalUrl) : null,
        sizeBytes,
        contentType,
        createdBy: "admin",
      })
      .returning();
    return res.json({ document: rows[0] });
  },
);

router.patch(
  "/investor-admin/documents/:id",
  requireAdmin,
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Bad id" });
    const b = req.body as {
      title?: string;
      description?: string | null;
      objectPath?: string | null;
      externalUrl?: string | null;
      sizeBytes?: number;
      contentType?: string;
    };
    const set: Record<string, unknown> = {};
    if (typeof b.title === "string") {
      const title = b.title.trim();
      if (!title) return res.status(400).json({ error: "Title required" });
      set.title = title;
    }
    if (typeof b.description === "string" || b.description === null)
      set.description = b.description ? String(b.description).trim() || null : null;
    // Allow swapping the underlying source. Setting one source clears the other
    // so a document never points at both an uploaded file and an external URL.
    // Size/type travel with the uploaded file and are cleared whenever the
    // source becomes an external link (or is removed).
    if (b.objectPath !== undefined) {
      const objectPath = b.objectPath ? String(b.objectPath) : null;
      if (objectPath) {
        set.objectPath = objectPath;
        set.externalUrl = null;
        set.sizeBytes =
          typeof b.sizeBytes === "number" && Number.isFinite(b.sizeBytes)
            ? Math.max(0, Math.round(b.sizeBytes))
            : null;
        set.contentType = b.contentType ? String(b.contentType) : null;
      } else {
        set.objectPath = null;
        set.sizeBytes = null;
        set.contentType = null;
      }
    }
    if (b.externalUrl !== undefined) {
      const externalUrl = b.externalUrl ? String(b.externalUrl).trim() : null;
      if (externalUrl) {
        set.externalUrl = externalUrl;
        set.objectPath = null;
        set.sizeBytes = null;
        set.contentType = null;
      } else {
        set.externalUrl = null;
      }
    }
    if (Object.keys(set).length === 0)
      return res.status(400).json({ error: "Nothing to update" });
    const rows = await db
      .update(investorDocumentsTable)
      .set(set)
      .where(eq(investorDocumentsTable.id, id))
      .returning();
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });
    const updated = rows[0];
    // Guard against an update that would leave the document with no source.
    if (!updated.objectPath && !updated.externalUrl) {
      return res.status(400).json({
        error: "A document must keep either an uploaded file or an external link",
      });
    }
    return res.json({ document: updated });
  },
);

router.delete(
  "/investor-admin/documents/:id",
  requireAdmin,
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Bad id" });
    await db
      .delete(investorDocumentsTable)
      .where(eq(investorDocumentsTable.id, id));
    return res.json({ ok: true });
  },
);

// — Requests triage —
router.get(
  "/investor-admin/requests",
  requireAdmin,
  async (_req: Request, res: Response) => {
    const rows = await db
      .select({
        id: investorRequestsTable.id,
        investorId: investorRequestsTable.investorId,
        subject: investorRequestsTable.subject,
        body: investorRequestsTable.body,
        status: investorRequestsTable.status,
        responseHtml: investorRequestsTable.responseHtml,
        respondedAt: investorRequestsTable.respondedAt,
        createdAt: investorRequestsTable.createdAt,
        investorName: investorsTable.name,
        investorEmail: investorsTable.email,
      })
      .from(investorRequestsTable)
      .leftJoin(
        investorsTable,
        eq(investorRequestsTable.investorId, investorsTable.id),
      )
      .orderBy(desc(investorRequestsTable.createdAt));
    return res.json({ requests: rows });
  },
);

router.patch(
  "/investor-admin/requests/:id",
  requireAdmin,
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Bad id" });
    const b = req.body as { status?: string; responseHtml?: string };
    const set: Record<string, unknown> = {};
    if (typeof b.status === "string") set.status = b.status;
    if (typeof b.responseHtml === "string" || b.responseHtml === null) {
      set.responseHtml = b.responseHtml;
      set.respondedBy = "admin";
      set.respondedAt = new Date();
    }
    if (Object.keys(set).length === 0)
      return res.status(400).json({ error: "Nothing to update" });
    const rows = await db
      .update(investorRequestsTable)
      .set(set)
      .where(eq(investorRequestsTable.id, id))
      .returning();
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });
    return res.json({ request: rows[0] });
  },
);

// — Settings (hotline + cap-table note) —
router.get(
  "/investor-admin/settings",
  requireAdmin,
  async (_req: Request, res: Response) => {
    const s = await getSettings();
    return res.json({
      hotlineNumber: s?.hotlineNumber ?? null,
      hotlineNote: s?.hotlineNote ?? DEFAULT_HOTLINE_NOTE,
      capTableNote: s?.capTableNote ?? DEFAULT_CAP_TABLE_NOTE,
    });
  },
);

router.put(
  "/investor-admin/settings",
  requireAdmin,
  async (req: Request, res: Response) => {
    const b = req.body as {
      hotlineNumber?: string;
      hotlineNote?: string;
      capTableNote?: string;
    };
    const values = {
      id: "default",
      hotlineNumber: b.hotlineNumber ?? null,
      hotlineNote: b.hotlineNote ?? null,
      capTableNote: b.capTableNote ?? null,
    };
    await db
      .insert(investorSettingsTable)
      .values(values)
      .onConflictDoUpdate({
        target: investorSettingsTable.id,
        set: {
          hotlineNumber: values.hotlineNumber,
          hotlineNote: values.hotlineNote,
          capTableNote: values.capTableNote,
        },
      });
    return res.json({ ok: true });
  },
);

export default router;
