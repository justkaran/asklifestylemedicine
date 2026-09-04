/**
 * Admin-only IP-protection surface: corpus manifest history (view +
 * download), canary registry, and per-licensee fingerprint assignments.
 *
 * Secret material policy: fingerprint secrets and marker codes are
 * ADMIN-ONLY — they are served exclusively behind `checkAdmin` here and are
 * never serialized by any public or partner-facing endpoint.
 *
 * HONEST-LIMITS: manifests prove what Palonur's corpus contained at a point
 * in time; canary tokens and zero-width markers are statistical evidence of
 * copying, forgeable and strippable in principle — never cryptographic
 * proof. The admin UI repeats this framing.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { desc, eq, lte } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  corpusManifestsTable,
  partnerKeysTable,
  misuseProbesTable,
  detectionSessionsTable,
} from "@workspace/db";
import { checkAdmin } from "./admin.js";
import {
  generateCorpusManifestIfChanged,
  listCanaries,
  ensureFingerprint,
  CANARY_SPECS,
} from "../lib/ipProtection.js";
import {
  detectSignals,
  scoreSession,
  attributeSession,
  buildMethodologyDoc,
  assertSafeExternalUrl,
  runProbeAgainstEndpoint,
  CANARY_ASSOCIATIONS,
  MAX_RESPONSE_CHARS,
  type ProbeResult,
  type FingerprintInfo,
  type SessionStats,
  type Attribution,
} from "../lib/misuseDetection.js";

const router: IRouter = Router();

/** GET /api/admin/ip/manifests — append-only manifest history (no entries). */
router.get("/admin/ip/manifests", checkAdmin, async (_req, res) => {
  const rows = await db
    .select({
      id: corpusManifestsTable.id,
      manifestHash: corpusManifestsTable.manifestHash,
      sourceCount: corpusManifestsTable.sourceCount,
      chunkCount: corpusManifestsTable.chunkCount,
      reason: corpusManifestsTable.reason,
      createdAt: corpusManifestsTable.createdAt,
    })
    .from(corpusManifestsTable)
    .orderBy(desc(corpusManifestsTable.id))
    .limit(200);
  res.json({ manifests: rows });
});

/** GET /api/admin/ip/manifests/:id/download — full manifest JSON. */
router.get(
  "/admin/ip/manifests/:id/download",
  checkAdmin,
  async (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [row] = await db
      .select()
      .from(corpusManifestsTable)
      .where(eq(corpusManifestsTable.id, id))
      .limit(1);
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="palonur_corpus_manifest_${row.id}.json"`,
    );
    res.json({
      note: "Append-only corpus manifest. Proves what the Palonur corpus contained at the timestamp below. Statistical evidence mechanism - not cryptographic proof that any third party copied the corpus.",
      ...row,
    });
  },
);

/** POST /api/admin/ip/manifests/generate — manual snapshot. */
router.post("/admin/ip/manifests/generate", checkAdmin, async (_req, res) => {
  const row = await generateCorpusManifestIfChanged("admin");
  res.json({ created: Boolean(row), manifest: row ?? null });
});

/** GET /api/admin/ip/canaries — canary registry with seeding status. */
router.get("/admin/ip/canaries", checkAdmin, async (_req, res) => {
  res.json({ canaries: await listCanaries(), variantCount: CANARY_SPECS.length });
});

/**
 * GET /api/admin/ip/fingerprints — per-licensee fingerprint assignments.
 * Lazily ensures a mapping row for every partner key so the admin always
 * sees a complete picture. Secrets shown here are ADMIN-ONLY.
 */
router.get("/admin/ip/fingerprints", checkAdmin, async (_req, res) => {
  const keys = await db
    .select({
      id: partnerKeysTable.id,
      partnerName: partnerKeysTable.partnerName,
      revokedAt: partnerKeysTable.revokedAt,
    })
    .from(partnerKeysTable)
    .orderBy(partnerKeysTable.id);
  const out = [];
  for (const k of keys) {
    const fp = await ensureFingerprint(k.id);
    out.push({
      partnerKeyId: k.id,
      partnerName: k.partnerName,
      revoked: k.revokedAt != null,
      markerCode: fp.markerCode,
      canaryVariant: fp.canaryVariant,
      canaryDoi: CANARY_SPECS[fp.canaryVariant % CANARY_SPECS.length]?.doi ?? null,
      createdAt: fp.createdAt,
    });
  }
  res.json({ fingerprints: out });
});

// ═══════════════════════════════════════════════════════════════════════
// Black-box misuse detection (probes, sessions, evidence export).
// ALL routes below are checkAdmin — probes and sessions are private and
// must never be reachable from public or partner-facing surfaces.
// ═══════════════════════════════════════════════════════════════════════

async function loadFingerprintInfos(): Promise<FingerprintInfo[]> {
  const keys = await db
    .select({
      id: partnerKeysTable.id,
      partnerName: partnerKeysTable.partnerName,
      revokedAt: partnerKeysTable.revokedAt,
    })
    .from(partnerKeysTable)
    .orderBy(partnerKeysTable.id);
  const out: FingerprintInfo[] = [];
  for (const k of keys) {
    const fp = await ensureFingerprint(k.id);
    out.push({
      partnerKeyId: k.id,
      partnerName: k.partnerName,
      markerCode: fp.markerCode,
      canaryVariant: fp.canaryVariant,
      canaryDoi: CANARY_SPECS[fp.canaryVariant % CANARY_SPECS.length]?.doi ?? null,
      revoked: k.revokedAt != null,
    });
  }
  return out;
}

// ── Probe library CRUD ──────────────────────────────────────────────────

const signalTypeEnum = z.enum([
  "canary_token",
  "fabricated_association",
  "zero_width_marker",
]);
const expectedSignalSchema = z.object({
  type: signalTypeEnum,
  note: z.string().max(500).optional(),
});

const probeSchema = z.object({
  label: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(4000),
  targetKind: z.enum(["canary", "fingerprint", "general"]).default("canary"),
  canaryDoi: z.string().trim().nullish(),
  expectedSignals: z.array(expectedSignalSchema).default([]),
  notes: z.string().max(2000).nullish(),
  active: z.boolean().default(true),
});

router.get("/admin/ip/probes", checkAdmin, async (_req, res) => {
  const probes = await db
    .select()
    .from(misuseProbesTable)
    .orderBy(desc(misuseProbesTable.id));
  res.json({ probes, canaryDois: CANARY_SPECS.map((c) => c.doi) });
});

router.post("/admin/ip/probes", checkAdmin, async (req, res) => {
  const parsed = probeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid probe", details: parsed.error.issues });
  }
  const d = parsed.data;
  if (d.canaryDoi && !CANARY_SPECS.some((c) => c.doi === d.canaryDoi)) {
    return res.status(400).json({ error: "Unknown canary DOI" });
  }
  const [row] = await db
    .insert(misuseProbesTable)
    .values({
      label: d.label,
      prompt: d.prompt,
      targetKind: d.targetKind,
      canaryDoi: d.canaryDoi ?? null,
      expectedSignals: d.expectedSignals,
      notes: d.notes ?? null,
      active: d.active,
    })
    .returning();
  return res.json({ probe: row });
});

router.put("/admin/ip/probes/:id", checkAdmin, async (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  const parsed = probeSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid probe", details: parsed.error.issues });
  }
  const d = parsed.data;
  if (d.canaryDoi && !CANARY_SPECS.some((c) => c.doi === d.canaryDoi)) {
    return res.status(400).json({ error: "Unknown canary DOI" });
  }
  const [row] = await db
    .update(misuseProbesTable)
    .set({
      ...(d.label !== undefined ? { label: d.label } : {}),
      ...(d.prompt !== undefined ? { prompt: d.prompt } : {}),
      ...(d.targetKind !== undefined ? { targetKind: d.targetKind } : {}),
      ...(d.canaryDoi !== undefined ? { canaryDoi: d.canaryDoi ?? null } : {}),
      ...(d.expectedSignals !== undefined ? { expectedSignals: d.expectedSignals } : {}),
      ...(d.notes !== undefined ? { notes: d.notes ?? null } : {}),
      ...(d.active !== undefined ? { active: d.active } : {}),
      updatedAt: new Date(),
    })
    .where(eq(misuseProbesTable.id, id))
    .returning();
  if (!row) return res.status(404).json({ error: "Probe not found" });
  return res.json({ probe: row });
});

router.delete("/admin/ip/probes/:id", checkAdmin, async (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  await db.delete(misuseProbesTable).where(eq(misuseProbesTable.id, id));
  return res.json({ ok: true });
});

// ── Detection runner ────────────────────────────────────────────────────

const MAX_PROBES_PER_RUN = 25;

const endpointRunSchema = z.object({
  mode: z.literal("endpoint"),
  label: z.string().trim().min(1).max(200),
  url: z.string().trim().url(),
  method: z.enum(["POST", "GET"]).default("POST"),
  /** Header values are USED for the run but only header NAMES are persisted. */
  headers: z.record(z.string(), z.string()).default({}),
  /** JSON body template; "{{prompt}}" is replaced with the probe prompt. */
  bodyTemplate: z.string().max(4000).default('{"question": "{{prompt}}"}'),
  /** Dot-path into the JSON response for the answer text (blank = raw body). */
  responsePath: z.string().max(200).default(""),
  probeIds: z.array(z.number().int().positive()).max(MAX_PROBES_PER_RUN).default([]),
});

const transcriptRunSchema = z.object({
  mode: z.literal("transcript"),
  label: z.string().trim().min(1).max(200),
  transcripts: z
    .array(
      z.object({
        probeId: z.number().int().positive().nullish(),
        prompt: z.string().max(4000).default(""),
        response: z.string().min(1).max(MAX_RESPONSE_CHARS),
      }),
    )
    .min(1)
    .max(MAX_PROBES_PER_RUN),
});

const runSchema = z.discriminatedUnion("mode", [endpointRunSchema, transcriptRunSchema]);

router.post("/admin/ip/detect/run", checkAdmin, async (req: Request, res: Response) => {
  const parsed = runSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid run", details: parsed.error.issues });
  }
  const d = parsed.data;
  try {
    const results: ProbeResult[] = [];
    let target: Record<string, unknown> | null = null;

    if (d.mode === "endpoint") {
      // SSRF guard: HTTPS-only, public addresses only, redirects refused by
      // the runner. Even admin-only surfaces must not be a fetch-anything
      // primitive against internal services or cloud metadata.
      try {
        await assertSafeExternalUrl(d.url);
      } catch (err) {
        return res.status(400).json({
          error: err instanceof Error ? err.message : "Unsafe endpoint URL",
        });
      }
      const probes = await db
        .select()
        .from(misuseProbesTable)
        .orderBy(misuseProbesTable.id);
      const selected =
        d.probeIds.length > 0
          ? probes.filter((p) => d.probeIds.includes(p.id))
          : probes.filter((p) => p.active);
      if (selected.length === 0) {
        return res.status(400).json({ error: "No probes to run" });
      }
      if (selected.length > MAX_PROBES_PER_RUN) {
        return res.status(400).json({ error: `At most ${MAX_PROBES_PER_RUN} probes per run` });
      }
      // Persist the endpoint config WITHOUT header values (they can carry
      // the external system's API keys — evidence needs names only).
      target = {
        url: d.url,
        method: d.method,
        headerNames: Object.keys(d.headers),
        bodyTemplate: d.bodyTemplate,
        responsePath: d.responsePath,
      };
      for (const p of selected) {
        const { responseText, error } = await runProbeAgainstEndpoint(d, p.prompt);
        results.push({
          probeId: p.id,
          label: p.label,
          prompt: p.prompt,
          responseText,
          error,
          signals: responseText ? detectSignals(responseText) : [],
        });
      }
    } else {
      const probeIds = d.transcripts
        .map((t) => t.probeId)
        .filter((x): x is number => typeof x === "number");
      const probes =
        probeIds.length > 0
          ? await db.select().from(misuseProbesTable)
          : [];
      for (const t of d.transcripts) {
        const probe = probes.find((p) => p.id === t.probeId) ?? null;
        results.push({
          probeId: probe?.id ?? null,
          label: probe?.label ?? "Pasted transcript",
          prompt: probe?.prompt ?? t.prompt,
          responseText: t.response,
          error: null,
          signals: detectSignals(t.response),
        });
      }
    }

    const stats = scoreSession(results);
    const fingerprints = await loadFingerprintInfos();
    const attribution = attributeSession(stats, fingerprints);

    // Anchor the session to the corpus manifest that was current at run time.
    const [latestManifest] = await db
      .select({ id: corpusManifestsTable.id })
      .from(corpusManifestsTable)
      .orderBy(desc(corpusManifestsTable.id))
      .limit(1);

    const [session] = await db
      .insert(detectionSessionsTable)
      .values({
        label: d.label,
        mode: d.mode,
        target,
        results,
        stats,
        attribution,
        manifestId: latestManifest?.id ?? null,
      })
      .returning();
    return res.json({ session });
  } catch (err) {
    req.log.error({ err }, "Detection run failed");
    return res.status(500).json({ error: "Detection run failed" });
  }
});

// ── Sessions ────────────────────────────────────────────────────────────

router.get("/admin/ip/sessions", checkAdmin, async (_req, res) => {
  const rows = await db
    .select({
      id: detectionSessionsTable.id,
      label: detectionSessionsTable.label,
      mode: detectionSessionsTable.mode,
      stats: detectionSessionsTable.stats,
      attribution: detectionSessionsTable.attribution,
      manifestId: detectionSessionsTable.manifestId,
      createdAt: detectionSessionsTable.createdAt,
    })
    .from(detectionSessionsTable)
    .orderBy(desc(detectionSessionsTable.id))
    .limit(200);
  res.json({ sessions: rows });
});

router.get("/admin/ip/sessions/:id", checkAdmin, async (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  const [row] = await db
    .select()
    .from(detectionSessionsTable)
    .where(eq(detectionSessionsTable.id, id))
    .limit(1);
  if (!row) return res.status(404).json({ error: "Not found" });
  return res.json({ session: row });
});

// ── Evidence-package export ─────────────────────────────────────────────

router.get(
  "/admin/ip/sessions/:id/evidence",
  checkAdmin,
  async (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    try {
      const [session] = await db
        .select()
        .from(detectionSessionsTable)
        .where(eq(detectionSessionsTable.id, id))
        .limit(1);
      if (!session) return res.status(404).json({ error: "Not found" });

      const stats = session.stats as SessionStats;
      const attribution = session.attribution as Attribution;

      // Manifests: the one anchored at run time (full entries) plus the
      // metadata of the most recent manifests at-or-before the session, so
      // the package shows the corpus timeline leading up to the observation.
      const anchored = session.manifestId
        ? await db
            .select()
            .from(corpusManifestsTable)
            .where(eq(corpusManifestsTable.id, session.manifestId))
            .limit(1)
        : [];
      const timeline = await db
        .select({
          id: corpusManifestsTable.id,
          manifestHash: corpusManifestsTable.manifestHash,
          sourceCount: corpusManifestsTable.sourceCount,
          chunkCount: corpusManifestsTable.chunkCount,
          reason: corpusManifestsTable.reason,
          createdAt: corpusManifestsTable.createdAt,
        })
        .from(corpusManifestsTable)
        .where(lte(corpusManifestsTable.createdAt, session.createdAt))
        .orderBy(desc(corpusManifestsTable.id))
        .limit(20);

      // Triggered canaries: full spec + live seeding record.
      const triggeredDois = new Set(stats.perCanary.map((c) => c.canaryDoi));
      const canaries = (await listCanaries()).filter((c) => triggeredDois.has(c.doi));
      const triggeredCanaries = canaries.map((c) => ({
        ...c,
        fabricatedAssociationPhrases: CANARY_ASSOCIATIONS[c.doi] ?? [],
      }));

      // Suspected licensee: best-match key metadata + fingerprint spec.
      let suspectedLicensee: Record<string, unknown> | null = null;
      const suspectId =
        attribution.best?.partnerKeyId ?? attribution.candidates?.[0]?.partnerKeyId;
      if (suspectId) {
        const [key] = await db
          .select({
            id: partnerKeysTable.id,
            keyPrefix: partnerKeysTable.keyPrefix,
            partnerName: partnerKeysTable.partnerName,
            contactEmail: partnerKeysTable.contactEmail,
            scopes: partnerKeysTable.scopes,
            tier: partnerKeysTable.tier,
            origin: partnerKeysTable.origin,
            createdAt: partnerKeysTable.createdAt,
            revokedAt: partnerKeysTable.revokedAt,
          })
          .from(partnerKeysTable)
          .where(eq(partnerKeysTable.id, suspectId))
          .limit(1);
        if (key) {
          const fp = await ensureFingerprint(key.id);
          suspectedLicensee = {
            key,
            fingerprintSpecification: {
              markerCode: fp.markerCode,
              markerPayload: `plnrfp:${fp.markerCode}`,
              encoding:
                "Zero-width binary framing: U+200B frame, U+200C = 0, U+200D = 1, injected after the first word of keyed responses.",
              canaryVariant: fp.canaryVariant,
              canaryDoi:
                CANARY_SPECS[fp.canaryVariant % CANARY_SPECS.length]?.doi ?? null,
              assignedAt: fp.createdAt,
            },
            attributionNote: attribution.note,
            ambiguous: attribution.ambiguous,
          };
        }
      }

      const methodology = buildMethodologyDoc({
        sessionLabel: session.label,
        createdAt: new Date(session.createdAt as unknown as string).toISOString(),
        stats,
        attribution,
      });

      res.setHeader("Content-Type", "application/json");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="palonur_evidence_package_session_${session.id}.json"`,
      );
      return res.json({
        note: "Palonur corpus-misuse evidence package. STATISTICAL EVIDENCE ONLY - canary tokens and zero-width markers are forgeable and strippable in principle and never constitute cryptographic proof of copying. See methodologyMarkdown for the full limitations statement.",
        generatedAt: new Date().toISOString(),
        session: {
          id: session.id,
          label: session.label,
          mode: session.mode,
          target: session.target,
          createdAt: session.createdAt,
          transcripts: session.results,
        },
        statistics: stats,
        attribution,
        suspectedLicensee,
        corpusManifests: {
          anchoredAtRunTime: anchored[0] ?? null,
          timeline,
        },
        triggeredCanaries,
        methodologyMarkdown: methodology,
      });
    } catch (err) {
      req.log.error({ err }, "Evidence export failed");
      return res.status(500).json({ error: "Evidence export failed" });
    }
  },
);

export default router;
