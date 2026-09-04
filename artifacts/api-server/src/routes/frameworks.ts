/**
 * Bookable framework routes — owner authoring, cross-pillar apply, and the
 * deferred revenue-share ledger.
 *
 *  Owner authoring (steward of the owning pillar):
 *   GET   /api/faculty/frameworks                 — frameworks the caller stewards
 *   POST  /api/faculty/frameworks                 — create (owner-gated by pillar)
 *   PATCH /api/faculty/frameworks/:id             — edit fields
 *   POST  /api/faculty/frameworks/:id/publish     — publish
 *   POST  /api/faculty/frameworks/:id/retire      — retire
 *
 *  Cross-pillar use:
 *   GET   /api/faculty/frameworks/published        — every published framework
 *   POST  /api/faculty/frameworks/:id/apply        — rewrite a draft via a framework
 *
 *  Bookings + revenue-share ledger (record only — no money moves):
 *   POST  /api/faculty/frameworks/bookings             — book a framework
 *   GET   /api/faculty/frameworks/bookings?box=        — mine (booker) / owner
 *   POST  /api/faculty/frameworks/bookings/:id/revenue — record revenue (booker/admin)
 *   GET   /api/faculty/frameworks/bookings/ledger      — admin ledger + summary
 *   GET   /api/faculty/frameworks/bookings/ledger.csv  — admin CSV export
 *   PATCH /api/faculty/frameworks/bookings/:id         — admin settle / adjust
 *
 * Conventions match the steward-voice routes: GET honors the admin "view-as"
 * preview (reads req.faculty.user.id, swapped on GET only); writes ALWAYS run as
 * the real caller. Framework writes are owner-gated by steward membership of the
 * framework's pillar. The ledger is record-only, mirroring newsletter credits.
 */
import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import {
  db,
  frameworksTable,
  frameworkBookingsTable,
  pillarsTable,
  facultyUsersTable,
  type Framework,
  type FrameworkBooking,
  type FacultyMembership,
} from "@workspace/db";
import { z } from "zod/v4";
import {
  requireFacultyAuth,
  requirePillarRoleFromBody,
  type FacultyRequest,
} from "../middlewares/facultyAuth.js";
import { RAG_MIN_SCORE } from "../lib/ragThreshold.js";
import {
  retrieve,
  buildContextBlock,
  buildProvenance,
  verifyCitation,
  type CitationVerification,
  type ProvenanceEntry,
} from "../lib/rag.js";
import {
  loadStewardVoiceContext,
  getAnthropic,
  VOICE_MODEL,
  verifyVoice,
  type VoiceVerification,
} from "../lib/stewardVoice.js";
import {
  buildFrameworkRewritePrompt,
  splitRewrite,
  type FrameworkApplyKind,
} from "../lib/frameworkRewrite.js";

const router: IRouter = Router();

/**
 * Pillar slugs whose stewards may AUTHOR (create / edit / publish / retire)
 * bookable frameworks. Frameworks are a communication-expert offering: only
 * Allison Kluger (`communication`) and Matt Abrahams (`strategic-communication`)
 * can offer them. Every other steward keeps the ability to book/apply a
 * published framework cross-pillar — that gate is unchanged. Platform admins
 * bypass this restriction. Add a slug here to let another pillar author.
 */
export const FRAMEWORK_OWNER_PILLAR_SLUGS = new Set<string>([
  "communication",
  "strategic-communication",
]);

/** Admin-configured default revenue share %, applied to every booking. */
function defaultSharePct(): number {
  const raw = Number(process.env.FRAMEWORK_REVENUE_SHARE_PCT);
  return Number.isFinite(raw) && raw >= 0 && raw <= 100 ? Math.round(raw) : 15;
}

function isAdmin(req: FacultyRequest): boolean {
  return req.faculty!.user.isPlatformAdmin === "true";
}

/** Pillar ids the (possibly view-as) caller stewards. */
function stewardPillarIds(req: FacultyRequest): number[] {
  return (req.faculty!.memberships as FacultyMembership[])
    .filter((m) => m.role === "steward")
    .map((m) => m.pillarId);
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "framework"
  );
}

/** Look up names for pillars + faculty so list responses are self-describing. */
async function decorate(rows: Framework[]): Promise<
  Array<
    Framework & {
      pillarName: string | null;
      pillarSlug: string | null;
      ownerName: string | null;
    }
  >
> {
  if (rows.length === 0) return [];
  const pillarIds = [...new Set(rows.map((r) => r.pillarId))];
  const ownerIds = [
    ...new Set(rows.map((r) => r.ownerUserId).filter((x): x is number => !!x)),
  ];
  const [pillars, owners] = await Promise.all([
    db
      .select({
        id: pillarsTable.id,
        name: pillarsTable.name,
        slug: pillarsTable.slug,
      })
      .from(pillarsTable)
      .where(inArray(pillarsTable.id, pillarIds)),
    ownerIds.length > 0
      ? db
          .select({
            id: facultyUsersTable.id,
            fullName: facultyUsersTable.fullName,
          })
          .from(facultyUsersTable)
          .where(inArray(facultyUsersTable.id, ownerIds))
      : Promise.resolve([] as Array<{ id: number; fullName: string | null }>),
  ]);
  const pMap = new Map(pillars.map((p) => [p.id, p]));
  const oMap = new Map(owners.map((o) => [o.id, o]));
  return rows.map((r) => ({
    ...r,
    pillarName: pMap.get(r.pillarId)?.name ?? null,
    pillarSlug: pMap.get(r.pillarId)?.slug ?? null,
    ownerName: r.ownerUserId ? (oMap.get(r.ownerUserId)?.fullName ?? null) : null,
  }));
}

// ── Owner authoring ─────────────────────────────────────────────────────────

/**
 * GET /faculty/frameworks — every framework in a pillar the caller stewards
 * (admins see all). Honors admin view-as (memberships are swapped on GET).
 */
router.get(
  "/faculty/frameworks",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    try {
      const rows = isAdmin(req)
        ? await db
            .select()
            .from(frameworksTable)
            .orderBy(desc(frameworksTable.updatedAt))
        : await (async () => {
            const ids = stewardPillarIds(req);
            if (ids.length === 0) return [] as Framework[];
            return db
              .select()
              .from(frameworksTable)
              .where(inArray(frameworksTable.pillarId, ids))
              .orderBy(desc(frameworksTable.updatedAt));
          })();
      res.json({ frameworks: await decorate(rows) });
    } catch (e) {
      req.log.error({ err: e }, "list frameworks failed");
      res.status(500).json({ error: "Failed to list frameworks" });
    }
  },
);

/**
 * GET /faculty/frameworks/published — the cross-pillar picker: published
 * frameworks owned by OTHER pillars (the caller's own pillars are excluded, since
 * a steward applies/books a colleague's framework, never their own).
 */
router.get(
  "/faculty/frameworks/published",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    try {
      const ownIds = stewardPillarIds(req);
      const where =
        ownIds.length > 0
          ? and(
              eq(frameworksTable.status, "published"),
              notInArray(frameworksTable.pillarId, ownIds),
            )
          : eq(frameworksTable.status, "published");
      const rows = await db
        .select()
        .from(frameworksTable)
        .where(where)
        .orderBy(desc(frameworksTable.updatedAt));
      res.json({ frameworks: await decorate(rows) });
    } catch (e) {
      req.log.error({ err: e }, "list published frameworks failed");
      res.status(500).json({ error: "Failed to list frameworks" });
    }
  },
);

const createSchema = z.object({
  pillarId: z.number().int().positive(),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  structure: z.string().trim().min(1).max(8000),
  example: z.string().trim().max(8000).optional(),
});

/**
 * POST /faculty/frameworks — create a framework in a pillar the caller stewards.
 * Owner-gated by `requirePillarRoleFromBody` (runs as the real caller).
 */
router.post(
  "/faculty/frameworks",
  requireFacultyAuth,
  requirePillarRoleFromBody("pillarId", ["steward"]),
  async (req: FacultyRequest, res): Promise<void> => {
    // Frameworks may only be authored by the communication-expert pillars
    // (Allison Kluger + Matt Abrahams). Admins bypass for testing/support.
    if (!isAdmin(req) && !FRAMEWORK_OWNER_PILLAR_SLUGS.has(req.pillar?.slug ?? "")) {
      res.status(403).json({
        error: "Only the communication pillars can author frameworks",
      });
      return;
    }
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid framework", details: parsed.error.issues });
      return;
    }
    const body = parsed.data;
    try {
      // Unique slug within the pillar (append a counter on collision).
      const base = slugify(body.name);
      const existing = await db
        .select({ slug: frameworksTable.slug })
        .from(frameworksTable)
        .where(eq(frameworksTable.pillarId, body.pillarId));
      const taken = new Set(existing.map((e) => e.slug));
      let slug = base;
      let n = 2;
      while (taken.has(slug)) slug = `${base}-${n++}`;

      const [row] = await db
        .insert(frameworksTable)
        .values({
          pillarId: body.pillarId,
          ownerUserId: req.faculty!.user.id,
          name: body.name,
          slug,
          description: body.description ?? null,
          structure: body.structure,
          example: body.example ?? null,
        })
        .returning();
      res.status(201).json({ framework: row });
    } catch (e) {
      req.log.error({ err: e }, "create framework failed");
      res.status(500).json({ error: "Failed to create framework" });
    }
  },
);

/** Load a framework and confirm the REAL caller may manage it. */
async function loadManageable(
  req: FacultyRequest,
  res: import("express").Response,
): Promise<Framework | null> {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return null;
  }
  const [row] = await db
    .select()
    .from(frameworksTable)
    .where(eq(frameworksTable.id, id));
  if (!row) {
    res.status(404).json({ error: "Framework not found" });
    return null;
  }
  const steward = (req.faculty!.memberships as FacultyMembership[]).some(
    (m) => m.pillarId === row.pillarId && m.role === "steward",
  );
  if (!isAdmin(req) && !steward) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  // Authoring (edit/publish/retire) is restricted to the communication-expert
  // pillars; admins bypass. A non-admin steward of any other pillar is rejected
  // even though they steward the pillar the framework lives in.
  if (!isAdmin(req)) {
    const [pillar] = await db
      .select({ slug: pillarsTable.slug })
      .from(pillarsTable)
      .where(eq(pillarsTable.id, row.pillarId));
    if (!pillar || !FRAMEWORK_OWNER_PILLAR_SLUGS.has(pillar.slug)) {
      res.status(403).json({
        error: "Only the communication pillars can author frameworks",
      });
      return null;
    }
  }
  return row;
}

const patchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  structure: z.string().trim().min(1).max(8000).optional(),
  example: z.string().trim().max(8000).nullable().optional(),
});

/** PATCH /faculty/frameworks/:id — edit fields. */
router.patch(
  "/faculty/frameworks/:id",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const existing = await loadManageable(req, res);
    if (!existing) return;
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid update", details: parsed.error.issues });
      return;
    }
    const b = parsed.data;
    const patch: Partial<Framework> = {};
    if (b.name !== undefined) patch.name = b.name;
    if (b.description !== undefined) patch.description = b.description;
    if (b.structure !== undefined) patch.structure = b.structure;
    if (b.example !== undefined) patch.example = b.example;
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }
    try {
      const [row] = await db
        .update(frameworksTable)
        .set(patch)
        .where(eq(frameworksTable.id, existing.id))
        .returning();
      res.json({ framework: row });
    } catch (e) {
      req.log.error({ err: e }, "patch framework failed");
      res.status(500).json({ error: "Failed to update framework" });
    }
  },
);

async function setStatus(
  req: FacultyRequest,
  res: import("express").Response,
  status: "published" | "retired",
): Promise<void> {
  const existing = await loadManageable(req, res);
  if (!existing) return;
  try {
    const [row] = await db
      .update(frameworksTable)
      .set({ status })
      .where(eq(frameworksTable.id, existing.id))
      .returning();
    res.json({ framework: row });
  } catch (e) {
    req.log.error({ err: e }, `framework ${status} failed`);
    res.status(500).json({ error: "Failed to update framework" });
  }
}

/** POST /faculty/frameworks/:id/publish */
router.post(
  "/faculty/frameworks/:id/publish",
  requireFacultyAuth,
  (req: FacultyRequest, res) => setStatus(req, res, "published"),
);

/** POST /faculty/frameworks/:id/retire */
router.post(
  "/faculty/frameworks/:id/retire",
  requireFacultyAuth,
  (req: FacultyRequest, res) => setStatus(req, res, "retired"),
);

// ── Cross-pillar apply (the generator) ──────────────────────────────────────

const applySchema = z.object({
  draft: z.string().trim().min(1).max(12000),
  kind: z.enum(["answer", "article"]).optional(),
});

/**
 * POST /faculty/frameworks/:id/apply — rewrite the caller's draft to follow a
 * published framework, grounded in the OWNER pillar's approved content and
 * attributed to the owner. Citation + voice guards run observe-only. Degrades
 * cleanly: no AI key → { ok:false, reason }, empty/weak retrieval → UNCOVERED.
 */
router.post(
  "/faculty/frameworks/:id/apply",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    // Borrowing is for stewards (or admins) — not every faculty account.
    if (!isAdmin(req) && stewardPillarIds(req).length === 0) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const fid = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(fid)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsed = applySchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid request", details: parsed.error.issues });
      return;
    }
    const kind: FrameworkApplyKind = parsed.data.kind ?? "answer";

    const [framework] = await db
      .select()
      .from(frameworksTable)
      .where(eq(frameworksTable.id, fid));
    if (!framework) {
      res.status(404).json({ error: "Framework not found" });
      return;
    }
    if (framework.status !== "published") {
      res.status(400).json({ error: "Framework is not published" });
      return;
    }
    // Cross-pillar only: a steward borrows a colleague's framework, never one
    // owned by a pillar they already steward. Admins are exempt.
    if (!isAdmin(req) && stewardPillarIds(req).includes(framework.pillarId)) {
      res
        .status(400)
        .json({ error: "You can't apply your own pillar's framework" });
      return;
    }

    const [pillar] = await db
      .select()
      .from(pillarsTable)
      .where(eq(pillarsTable.id, framework.pillarId));
    const ownerName = framework.ownerUserId
      ? ((
          await db
            .select({ fullName: facultyUsersTable.fullName })
            .from(facultyUsersTable)
            .where(eq(facultyUsersTable.id, framework.ownerUserId))
        )[0]?.fullName ?? null)
      : null;
    const attribution = {
      frameworkId: framework.id,
      frameworkName: framework.name,
      ownerName,
      pillarName: pillar?.name ?? null,
      pillarSlug: pillar?.slug ?? null,
    };

    // Retrieve from the OWNER pillar's approved knowledge, using the draft as
    // the query. Below threshold / empty → clean UNCOVERED (no LLM call).
    let provenance: ProvenanceEntry[] = [];
    let contextBlock: string;
    try {
      const result = await retrieve({
        question: parsed.data.draft,
        pillarIds: [framework.pillarId],
        k: 6,
      });
      if (result.chunks.length === 0 || result.topScore < RAG_MIN_SCORE) {
        res.json({
          ok: true,
          uncovered: true,
          refused: false,
          draft: `UNCOVERED: ${ownerName ?? "The owner"} hasn't published approved material to ground this with the ${framework.name} framework yet.`,
          attribution,
          provenance: [],
          citationVerification: null,
          voiceVerification: null,
        });
        return;
      }
      provenance = buildProvenance(result.chunks);
      contextBlock = buildContextBlock(result.chunks);
    } catch (e) {
      req.log.error({ err: e }, "framework apply retrieval failed");
      res.status(500).json({ error: "Retrieval failed" });
      return;
    }

    if (!process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY) {
      res.json({ ok: false, reason: "ai_unavailable", attribution });
      return;
    }

    const voiceContext = framework.ownerUserId
      ? await loadStewardVoiceContext({
          facultyUserId: framework.ownerUserId,
          pillarId: framework.pillarId,
        })
      : undefined;

    const system = buildFrameworkRewritePrompt({
      framework,
      contextBlock,
      ownerName,
      pillarName: pillar?.name ?? "this topic",
      kind,
      voiceContext,
    });

    try {
      const resp = await getAnthropic().messages.create({
        model: VOICE_MODEL,
        max_tokens: 1500,
        system,
        messages: [{ role: "user", content: parsed.data.draft }],
      });
      let out = "";
      for (const block of resp.content) {
        if (block.type === "text") out += block.text;
      }
      const trimmed = out.trim();
      const refused = trimmed.startsWith("REFUSE:");
      const uncovered = trimmed.startsWith("UNCOVERED:");

      let citationVerification: CitationVerification | null = null;
      let voiceVerification: VoiceVerification | null = null;
      let draft = trimmed;
      if (!refused && !uncovered) {
        const { body } = splitRewrite(trimmed);
        draft = body;
        if (provenance.length > 0) {
          citationVerification = verifyCitation(trimmed, provenance);
        }
        if (voiceContext) {
          // verifyVoice inspects the ANSWER section; the rewrite is prose, so
          // present it as the ANSWER body to get a meaningful (observe-only)
          // first-person/voice signal.
          voiceVerification = verifyVoice(`ANSWER:\n${body}`, voiceContext);
        }
      }

      res.json({
        ok: true,
        uncovered,
        refused,
        draft,
        attribution,
        provenance: refused || uncovered ? [] : provenance,
        citationVerification,
        voiceVerification,
      });
    } catch (e) {
      req.log.error({ err: e }, "framework apply generation failed");
      res.status(502).json({ error: "Generation failed" });
    }
  },
);

// ── Bookings + revenue-share ledger ─────────────────────────────────────────

function dollars(cents: number | null): string {
  return ((cents ?? 0) / 100).toFixed(2);
}

const bookSchema = z.object({
  frameworkId: z.number().int().positive(),
  bookerPillarId: z.number().int().positive(),
  targetType: z
    .enum(["interpretation", "newsletter_post", "communication_offer", "article"])
    .optional(),
  targetId: z.number().int().positive().optional(),
  targetTitle: z.string().trim().max(300).optional(),
  note: z.string().trim().max(1000).optional(),
});

/**
 * POST /faculty/frameworks/bookings — book a framework against a piece of work.
 * Owner-gated to a pillar the caller stewards (the BOOKER pillar). Idempotent
 * per concrete (framework, target): a re-book returns the existing row.
 */
router.post(
  "/faculty/frameworks/bookings",
  requireFacultyAuth,
  requirePillarRoleFromBody("bookerPillarId", ["steward"]),
  async (req: FacultyRequest, res): Promise<void> => {
    const parsed = bookSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid booking", details: parsed.error.issues });
      return;
    }
    const b = parsed.data;
    const [framework] = await db
      .select()
      .from(frameworksTable)
      .where(eq(frameworksTable.id, b.frameworkId));
    if (!framework) {
      res.status(404).json({ error: "Framework not found" });
      return;
    }
    if (framework.status !== "published") {
      res.status(400).json({ error: "Framework is not published" });
      return;
    }
    // Cross-pillar only: you can't book your own pillar's framework.
    if (!isAdmin(req) && framework.pillarId === b.bookerPillarId) {
      res
        .status(400)
        .json({ error: "You can't book your own pillar's framework" });
      return;
    }
    try {
      const inserted = await db
        .insert(frameworkBookingsTable)
        .values({
          frameworkId: framework.id,
          ownerPillarId: framework.pillarId,
          ownerUserId: framework.ownerUserId,
          bookerPillarId: b.bookerPillarId,
          bookerUserId: req.faculty!.user.id,
          targetType: b.targetType ?? null,
          targetId: b.targetId ?? null,
          targetTitle: b.targetTitle ?? null,
          sharePct: defaultSharePct(),
          note: b.note ?? null,
        })
        .onConflictDoNothing({
          target: [
            frameworkBookingsTable.frameworkId,
            frameworkBookingsTable.targetType,
            frameworkBookingsTable.targetId,
          ],
          where: sql`target_id IS NOT NULL`,
        })
        .returning();
      if (inserted[0]) {
        res.status(201).json({ booking: inserted[0] });
        return;
      }
      // Conflict → idempotent: return the existing booking.
      const [existing] = await db
        .select()
        .from(frameworkBookingsTable)
        .where(
          and(
            eq(frameworkBookingsTable.frameworkId, framework.id),
            b.targetType
              ? eq(frameworkBookingsTable.targetType, b.targetType)
              : undefined,
            b.targetId
              ? eq(frameworkBookingsTable.targetId, b.targetId)
              : undefined,
          ),
        );
      res.status(200).json({ booking: existing ?? null, idempotent: true });
    } catch (e) {
      req.log.error({ err: e }, "book framework failed");
      res.status(500).json({ error: "Failed to book framework" });
    }
  },
);

/** Names for bookings list/ledger rows. */
async function decorateBookings(rows: FrameworkBooking[]): Promise<
  Array<
    FrameworkBooking & {
      frameworkName: string | null;
      ownerName: string | null;
      ownerPillarName: string | null;
      bookerName: string | null;
      bookerPillarName: string | null;
    }
  >
> {
  if (rows.length === 0) return [];
  const fwIds = [...new Set(rows.map((r) => r.frameworkId))];
  const pillarIds = [
    ...new Set(rows.flatMap((r) => [r.ownerPillarId, r.bookerPillarId])),
  ];
  const userIds = [
    ...new Set(
      rows
        .flatMap((r) => [r.ownerUserId, r.bookerUserId])
        .filter((x): x is number => !!x),
    ),
  ];
  const [fws, pillars, users] = await Promise.all([
    db
      .select({ id: frameworksTable.id, name: frameworksTable.name })
      .from(frameworksTable)
      .where(inArray(frameworksTable.id, fwIds)),
    db
      .select({ id: pillarsTable.id, name: pillarsTable.name })
      .from(pillarsTable)
      .where(inArray(pillarsTable.id, pillarIds)),
    userIds.length > 0
      ? db
          .select({
            id: facultyUsersTable.id,
            fullName: facultyUsersTable.fullName,
          })
          .from(facultyUsersTable)
          .where(inArray(facultyUsersTable.id, userIds))
      : Promise.resolve([] as Array<{ id: number; fullName: string | null }>),
  ]);
  const fwMap = new Map(fws.map((f) => [f.id, f.name]));
  const pMap = new Map(pillars.map((p) => [p.id, p.name]));
  const uMap = new Map(users.map((u) => [u.id, u.fullName]));
  return rows.map((r) => ({
    ...r,
    frameworkName: fwMap.get(r.frameworkId) ?? null,
    ownerName: r.ownerUserId ? (uMap.get(r.ownerUserId) ?? null) : null,
    ownerPillarName: pMap.get(r.ownerPillarId) ?? null,
    bookerName: r.bookerUserId ? (uMap.get(r.bookerUserId) ?? null) : null,
    bookerPillarName: pMap.get(r.bookerPillarId) ?? null,
  }));
}

function bookingSummary(rows: FrameworkBooking[]) {
  const owedCents = rows.reduce(
    (s, r) => s + (r.status === "settled" ? 0 : (r.ownerShareCents ?? 0)),
    0,
  );
  const settledCents = rows.reduce(
    (s, r) => s + (r.status === "settled" ? (r.ownerShareCents ?? 0) : 0),
    0,
  );
  const revenueCents = rows.reduce((s, r) => s + (r.revenueCents ?? 0), 0);
  return { count: rows.length, owedCents, settledCents, revenueCents };
}

/**
 * GET /faculty/frameworks/bookings?box=mine|owner — bookings the caller made
 * (mine) or owns (owner). Honors admin view-as (user.id swapped on GET).
 */
router.get(
  "/faculty/frameworks/bookings",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const box = req.query.box === "owner" ? "owner" : "mine";
    const userId = req.faculty!.user.id;
    try {
      const rows = await db
        .select()
        .from(frameworkBookingsTable)
        .where(
          box === "owner"
            ? eq(frameworkBookingsTable.ownerUserId, userId)
            : eq(frameworkBookingsTable.bookerUserId, userId),
        )
        .orderBy(desc(frameworkBookingsTable.createdAt));
      res.json({
        bookings: await decorateBookings(rows),
        summary: bookingSummary(rows),
      });
    } catch (e) {
      req.log.error({ err: e }, "list bookings failed");
      res.status(500).json({ error: "Failed to list bookings" });
    }
  },
);

/**
 * GET /faculty/frameworks/bookings/ledger — admin-only full ledger + summary.
 */
router.get(
  "/faculty/frameworks/bookings/ledger",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!isAdmin(req)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    try {
      const rows = await db
        .select()
        .from(frameworkBookingsTable)
        .orderBy(desc(frameworkBookingsTable.createdAt));
      res.json({
        bookings: await decorateBookings(rows),
        summary: bookingSummary(rows),
      });
    } catch (e) {
      req.log.error({ err: e }, "ledger failed");
      res.status(500).json({ error: "Failed to load ledger" });
    }
  },
);

/** GET /faculty/frameworks/bookings/ledger.csv — admin-only CSV export. */
router.get(
  "/faculty/frameworks/bookings/ledger.csv",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!isAdmin(req)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    try {
      const rows = await decorateBookings(
        await db
          .select()
          .from(frameworkBookingsTable)
          .orderBy(desc(frameworkBookingsTable.createdAt)),
      );
      const esc = (v: unknown) => {
        const s = v == null ? "" : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const header = [
        "id",
        "framework",
        "owner",
        "owner_pillar",
        "booker",
        "booker_pillar",
        "target_type",
        "target_title",
        "status",
        "revenue_usd",
        "share_pct",
        "owner_share_usd",
        "created_at",
        "revenue_recorded_at",
        "settled_at",
      ];
      const lines = [header.join(",")];
      for (const r of rows) {
        lines.push(
          [
            r.id,
            r.frameworkName,
            r.ownerName,
            r.ownerPillarName,
            r.bookerName,
            r.bookerPillarName,
            r.targetType,
            r.targetTitle,
            r.status,
            r.revenueCents == null ? "" : dollars(r.revenueCents),
            r.sharePct,
            r.ownerShareCents == null ? "" : dollars(r.ownerShareCents),
            r.createdAt?.toISOString() ?? "",
            r.revenueRecordedAt?.toISOString() ?? "",
            r.settledAt?.toISOString() ?? "",
          ]
            .map(esc)
            .join(","),
        );
      }
      res.setHeader("content-type", "text/csv; charset=utf-8");
      res.setHeader(
        "content-disposition",
        'attachment; filename="framework-bookings.csv"',
      );
      res.send(lines.join("\n"));
    } catch (e) {
      req.log.error({ err: e }, "ledger csv failed");
      res.status(500).json({ error: "Failed" });
    }
  },
);

const revenueSchema = z.object({
  revenueCents: z.number().int().min(0),
});

/**
 * POST /faculty/frameworks/bookings/:id/revenue — record what the work earned.
 * Allowed for the BOOKER (real caller) or an admin. Computes the owner's share
 * from the snapshotted %, flips status to revenue_recorded.
 */
router.post(
  "/faculty/frameworks/bookings/:id/revenue",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsed = revenueSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid revenue", details: parsed.error.issues });
      return;
    }
    const [booking] = await db
      .select()
      .from(frameworkBookingsTable)
      .where(eq(frameworkBookingsTable.id, id));
    if (!booking) {
      res.status(404).json({ error: "Booking not found" });
      return;
    }
    if (!isAdmin(req) && booking.bookerUserId !== req.faculty!.user.id) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const revenueCents = parsed.data.revenueCents;
    const ownerShareCents = Math.round((revenueCents * booking.sharePct) / 100);
    try {
      const [row] = await db
        .update(frameworkBookingsTable)
        .set({
          revenueCents,
          ownerShareCents,
          status: booking.status === "settled" ? "settled" : "revenue_recorded",
          revenueRecordedAt: new Date(),
        })
        .where(eq(frameworkBookingsTable.id, id))
        .returning();
      res.json({ booking: row });
    } catch (e) {
      req.log.error({ err: e }, "record revenue failed");
      res.status(500).json({ error: "Failed to record revenue" });
    }
  },
);

const adminPatchSchema = z.object({
  status: z.enum(["booked", "revenue_recorded", "settled"]).optional(),
  ownerShareCents: z.number().int().min(0).optional(),
  note: z.string().trim().max(1000).nullable().optional(),
});

/**
 * PATCH /faculty/frameworks/bookings/:id — admin settle / adjust. Marking
 * `settled` stamps settledAt; reverting clears it.
 */
router.patch(
  "/faculty/frameworks/bookings/:id",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    if (!isAdmin(req)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsed = adminPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid update", details: parsed.error.issues });
      return;
    }
    const b = parsed.data;
    const patch: Partial<FrameworkBooking> = {};
    if (b.status !== undefined) {
      patch.status = b.status;
      patch.settledAt = b.status === "settled" ? new Date() : null;
    }
    if (b.ownerShareCents !== undefined) patch.ownerShareCents = b.ownerShareCents;
    if (b.note !== undefined) patch.note = b.note;
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }
    try {
      const [row] = await db
        .update(frameworkBookingsTable)
        .set(patch)
        .where(eq(frameworkBookingsTable.id, id))
        .returning();
      if (!row) {
        res.status(404).json({ error: "Booking not found" });
        return;
      }
      res.json({ booking: row });
    } catch (e) {
      req.log.error({ err: e }, "patch booking failed");
      res.status(500).json({ error: "Failed to update booking" });
    }
  },
);

export default router;
