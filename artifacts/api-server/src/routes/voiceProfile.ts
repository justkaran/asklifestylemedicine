/**
 * Faculty voice-profile routes — the steward-facing loop for the embeddable
 * expert agent's voice.
 *
 *   GET  /api/faculty/voice-profile            — current profile + corpus counts
 *   PUT  /api/faculty/voice-profile            — upsert the active profile
 *   POST /api/faculty/voice-profile/distill    — AI draft from the steward's own
 *                                                corpus (NOT persisted)
 *   POST /api/faculty/voice-profile/preview    — answer one question in the
 *                                                steward's voice (non-streaming,
 *                                                NEVER logged as embed usage)
 *
 * All routes require a Clerk faculty session. GET honors the admin "view-as"
 * preview (it reads `req.faculty.user.id`, which the auth middleware swaps to the
 * previewed member on GET only). Writes always run as the real caller.
 *
 * The preview deliberately does NOT reuse the public /api/embed-agent path: it
 * is authenticated, non-streaming, carries no partner key / CORS, and is never
 * written to `agent_queries` — a steward testing their own voice must not look
 * like real public usage.
 */
import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, facultyVoiceProfilesTable } from "@workspace/db";
import { RAG_MIN_SCORE } from "../lib/ragThreshold.js";
import { z } from "zod/v4";
import {
  requireFacultyAuth,
  requirePillarRoleFromBody,
  type FacultyRequest,
} from "../middlewares/facultyAuth.js";
import {
  retrieve,
  buildContextBlock,
  buildProvenance,
  verifyCitation,
  type CitationVerification,
  type ProvenanceEntry,
} from "../lib/rag.js";
import {
  loadStyleExemplars,
  loadTalkVoiceSamples,
  loadActiveVoiceProfile,
  loadStewardVoiceContext,
  distillVoiceProfile,
  buildExpertSystemPrompt,
  verifyVoice,
  getAnthropic,
  VOICE_MODEL,
  type StewardVoiceContext,
  type VoiceProfileLite,
  type VoiceVerification,
} from "../lib/stewardVoice.js";

const router: IRouter = Router();


const phraseArray = z.array(z.string().trim().min(1).max(200)).max(20);

/** The four steward-authored fields that shape the voice. */
const profileFieldsSchema = z.object({
  toneSummary: z.string().trim().max(2000).default(""),
  guidance: z.string().trim().max(4000).default(""),
  signaturePhrases: phraseArray.default([]),
  avoidPhrases: phraseArray.default([]),
});

const distilledFromSchema = z
  .object({
    interpretationIds: z.array(z.number().int()).optional(),
    talkSourceIds: z.array(z.number().int()).optional(),
    model: z.string().optional(),
    generatedAt: z.string().optional(),
  })
  .nullable()
  .optional();

const upsertSchema = profileFieldsSchema.extend({
  source: z.enum(["manual", "ai_distilled", "manual_edit"]).optional(),
  distilledFrom: distilledFromSchema,
});

const previewSchema = z.object({
  pillarId: z.number().int().positive(),
  message: z.string().trim().min(1).max(2000),
  // Optional unsaved editor state, so a steward can preview edits before saving.
  profile: profileFieldsSchema.partial().optional(),
});

/**
 * GET /api/faculty/voice-profile — the caller's current profile (or null) plus
 * how much raw material exists to distill from. Honors admin view-as.
 */
router.get(
  "/faculty/voice-profile",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const userId = req.faculty!.user.id;
    try {
      const [profileRow, exemplars, talkSamples] = await Promise.all([
        db
          .select()
          .from(facultyVoiceProfilesTable)
          .where(eq(facultyVoiceProfilesTable.facultyUserId, userId))
          .limit(1),
        loadStyleExemplars({ facultyUserId: userId }),
        loadTalkVoiceSamples({ facultyUserId: userId }),
      ]);
      res.json({
        profile: profileRow[0] ?? null,
        exemplarCount: exemplars.length,
        talkSampleCount: talkSamples.length,
        aiAvailable: Boolean(process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY),
      });
    } catch (e) {
      req.log.error({ err: e }, "voice-profile GET failed");
      res.status(500).json({ error: "Failed to load voice profile" });
    }
  },
);

/**
 * PUT /api/faculty/voice-profile — upsert the single active profile for the
 * caller (one row per faculty user). Stamps `approvedAt` because saving IS the
 * steward's approval. Always runs as the real caller (view-as is GET-only), so
 * an admin can never write another member's profile.
 */
router.put(
  "/faculty/voice-profile",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const userId = req.faculty!.user.id;
    const parsed = upsertSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid profile", details: parsed.error.issues });
      return;
    }
    const body = parsed.data;
    const now = new Date();
    const values = {
      facultyUserId: userId,
      toneSummary: body.toneSummary,
      guidance: body.guidance,
      signaturePhrases: body.signaturePhrases,
      avoidPhrases: body.avoidPhrases,
      source: body.source ?? "manual",
      distilledFrom: body.distilledFrom ?? null,
      approvedAt: now,
    };
    try {
      const [row] = await db
        .insert(facultyVoiceProfilesTable)
        .values(values)
        .onConflictDoUpdate({
          target: facultyVoiceProfilesTable.facultyUserId,
          set: {
            toneSummary: values.toneSummary,
            guidance: values.guidance,
            signaturePhrases: values.signaturePhrases,
            avoidPhrases: values.avoidPhrases,
            source: values.source,
            distilledFrom: values.distilledFrom,
            approvedAt: values.approvedAt,
          },
        })
        .returning();
      res.json({ profile: row });
    } catch (e) {
      req.log.error({ err: e }, "voice-profile PUT failed");
      res.status(500).json({ error: "Failed to save voice profile" });
    }
  },
);

/**
 * POST /api/faculty/voice-profile/distill — analyze the caller's OWN approved
 * interpretations + talk transcripts into a draft profile. The draft is
 * returned, NOT persisted: the steward reviews/edits it and saves via PUT.
 * Degrades cleanly to `{ ok: false, reason }` when there is no material or no
 * AI key, so the UI can explain why instead of erroring.
 */
router.post(
  "/faculty/voice-profile/distill",
  requireFacultyAuth,
  async (req: FacultyRequest, res): Promise<void> => {
    const userId = req.faculty!.user.id;
    try {
      const [exemplars, talkSamples] = await Promise.all([
        loadStyleExemplars({ facultyUserId: userId }),
        loadTalkVoiceSamples({ facultyUserId: userId }),
      ]);
      const result = await distillVoiceProfile({ exemplars, talkSamples });
      if (!result.ok) {
        res.json({
          ok: false,
          reason: result.reason,
          exemplarCount: exemplars.length,
          talkSampleCount: talkSamples.length,
        });
        return;
      }
      res.json({
        ok: true,
        draft: result.profile,
        provenance: result.provenance,
        exemplarCount: exemplars.length,
        talkSampleCount: talkSamples.length,
      });
    } catch (e) {
      req.log.error({ err: e }, "voice-profile distill failed");
      res.status(500).json({ error: "Distillation failed" });
    }
  },
);

/**
 * POST /api/faculty/voice-profile/preview — answer a single question exactly as
 * the embed agent would for the caller's pillar, so the steward can hear their
 * own voice. Authenticated + steward-gated, non-streaming, and NEVER written to
 * `agent_queries` (this is a private rehearsal, not public usage).
 */
router.post(
  "/faculty/voice-profile/preview",
  requireFacultyAuth,
  requirePillarRoleFromBody("pillarId", ["steward"]),
  async (req: FacultyRequest, res): Promise<void> => {
    const parsed = previewSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid preview request", details: parsed.error.issues });
      return;
    }
    const { message } = parsed.data;
    const pillar = req.pillar!;
    const userId = req.faculty!.user.id;

    // Voice context = the caller's saved profile + live exemplars, but if the
    // request carries unsaved editor fields, preview THOSE instead so a steward
    // can hear edits before committing them.
    let voiceContext: StewardVoiceContext;
    try {
      const base = await loadStewardVoiceContext({
        facultyUserId: userId,
        pillarId: pillar.id,
      });
      if (parsed.data.profile) {
        const o = parsed.data.profile;
        const fallback = await loadActiveVoiceProfile(userId);
        const overrideProfile: VoiceProfileLite = {
          toneSummary: o.toneSummary ?? fallback?.toneSummary ?? "",
          guidance: o.guidance ?? fallback?.guidance ?? "",
          signaturePhrases: o.signaturePhrases ?? fallback?.signaturePhrases ?? [],
          avoidPhrases: o.avoidPhrases ?? fallback?.avoidPhrases ?? [],
        };
        voiceContext = { profile: overrideProfile, exemplars: base.exemplars };
      } else {
        voiceContext = base;
      }
    } catch (e) {
      req.log.error({ err: e }, "voice-profile preview voice-context failed");
      res.status(500).json({ error: "Preview failed" });
      return;
    }

    // Same hard-locked, single-pillar retrieval as the embed agent.
    let provenance: ProvenanceEntry[] = [];
    let contextBlock: string;
    try {
      const result = await retrieve({
        question: message,
        pillarIds: [pillar.id],
        k: 6,
      });
      if (result.chunks.length === 0 || result.topScore < RAG_MIN_SCORE) {
        res.json({
          answer: "UNCOVERED: I haven't published approved material on this yet.",
          uncovered: true,
          provenance: [],
          citationVerification: null,
          voiceVerification: null,
        });
        return;
      }
      provenance = buildProvenance(result.chunks);
      contextBlock = buildContextBlock(result.chunks);
    } catch (e) {
      req.log.error({ err: e }, "voice-profile preview retrieval failed");
      res.status(500).json({ error: "Retrieval failed" });
      return;
    }

    if (!process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY) {
      res.status(503).json({ error: "AI is not configured" });
      return;
    }

    const system = buildExpertSystemPrompt(
      contextBlock,
      pillar.name,
      req.faculty!.user.fullName ?? null,
      voiceContext,
    );

    try {
      const resp = await getAnthropic().messages.create({
        model: VOICE_MODEL,
        max_tokens: 1024,
        system,
        messages: [{ role: "user", content: message }],
      });
      let answer = "";
      for (const block of resp.content) {
        if (block.type === "text") answer += block.text;
      }
      const trimmed = answer.trim();
      const wasRefused = trimmed.startsWith("REFUSE:");
      const wasUncovered = trimmed.startsWith("UNCOVERED:");

      let citationVerification: CitationVerification | null = null;
      let voiceVerification: VoiceVerification | null = null;
      if (!wasRefused && !wasUncovered) {
        if (provenance.length > 0) {
          citationVerification = verifyCitation(trimmed, provenance);
        }
        voiceVerification = verifyVoice(trimmed, voiceContext);
      }

      res.json({
        answer: trimmed,
        uncovered: wasUncovered,
        refused: wasRefused,
        provenance: wasRefused || wasUncovered ? [] : provenance,
        citationVerification,
        voiceVerification,
      });
    } catch (e) {
      req.log.error({ err: e }, "voice-profile preview generation failed");
      res.status(502).json({ error: "Generation failed" });
    }
  },
);

export default router;
