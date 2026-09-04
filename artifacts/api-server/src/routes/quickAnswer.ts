import { Router, type IRouter, type Response } from "express";
import { z } from "zod";
import {
  requireFacultyAuth,
  requirePillarRole,
  type FacultyRequest,
} from "../middlewares/facultyAuth.js";
import {
  draftQuickAnswer,
  findPillarSourceMatches,
} from "../lib/draftInterpretation.js";
import {
  loadStewardVoiceContext,
  formatVoiceBlock,
  hasVoiceMaterial,
} from "../lib/stewardVoice.js";

const router: IRouter = Router();

const draftSchema = z.object({
  question: z.string().min(1).max(2000),
  sourceId: z.number().int().positive().optional(),
});

/**
 * POST /api/faculty/pillars/:slug/quick-answer/draft
 *
 * Stateless drafter for the steward Quick Answer flow. Embeds the
 * reader-demand question, auto-grounds against the best-matching source
 * in the steward's pillar, and asks Claude for a structured, in-voice
 * first pass (headline / reading / limits / action). Writes nothing —
 * the client materialises an interpretation only when the steward picks
 * a finish action, so abandoning a draft never leaves an orphan row.
 *
 * Degrades cleanly:
 *  - no embedded source in the pillar → { ok:false, reason:"no_source" }
 *  - AI key unset or the draft call throws → { ok:true, aiAvailable:false }
 *  - source matched but no chunks came back → { ok:true, reason:"empty_retrieval", draft:null }
 */
router.post(
  "/faculty/pillars/:slug/quick-answer/draft",
  requireFacultyAuth,
  requirePillarRole({ slugParam: "slug" }, ["steward", "contributor"]),
  async (req: FacultyRequest, res: Response): Promise<void> => {
    const pillar = req.pillar!;
    const ctx = req.faculty!;
    const parsed = draftSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const question = parsed.data.question.trim();

    let suggestions;
    try {
      suggestions = await findPillarSourceMatches({
        pillarId: pillar.id,
        question,
        limit: 3,
        allowUnrecordedRights: true,
      });
    } catch (err) {
      req.log?.warn?.({ err }, "quick-answer: source match failed");
      res.json({ ok: false, reason: "no_source", suggestions: [] });
      return;
    }

    if (suggestions.length === 0) {
      res.json({ ok: false, reason: "no_source", suggestions: [] });
      return;
    }

    // Steward may re-ground against any of the offered matches; otherwise
    // hang the answer off the best match.
    let chosen = suggestions[0]!;
    if (parsed.data.sourceId != null) {
      const picked = suggestions.find(
        (s) => s.sourceId === parsed.data.sourceId,
      );
      if (picked) chosen = picked;
    }

    const voiceCtx = await loadStewardVoiceContext({
      facultyUserId: ctx.user.id,
      pillarId: pillar.id,
    });
    const hasVoiceProfile = hasVoiceMaterial(voiceCtx);
    const voiceName = ctx.user.fullName?.trim() || "the steward";
    const voiceBlock = formatVoiceBlock(voiceName, voiceCtx);

    const base = {
      ok: true as const,
      hasVoiceProfile,
      question,
      source: { id: chosen.sourceId, title: chosen.title },
      suggestions,
    };

    if (!process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY) {
      res.json({
        ...base,
        aiAvailable: false,
        reason: "ai_unavailable",
        draft: null,
        chunks: [],
        usedChunks: 0,
      });
      return;
    }

    try {
      const result = await draftQuickAnswer({
        sourceId: chosen.sourceId,
        question,
        voiceBlock,
        allowUnrecordedRights: true,
      });
      const hasBody =
        result.usedChunks > 0 &&
        (result.draft.headline.trim() !== "" ||
          result.draft.reading.trim() !== "");
      if (!hasBody) {
        res.json({
          ...base,
          aiAvailable: true,
          reason: "empty_retrieval",
          draft: null,
          chunks: result.chunks,
          usedChunks: result.usedChunks,
        });
        return;
      }
      res.json({
        ...base,
        aiAvailable: true,
        draft: {
          answer: result.draft.headline || question,
          interpretation: result.draft.reading,
          notProven: result.draft.limits,
          action: result.draft.action,
        },
        aiDraft: result.draft.reading,
        chunks: result.chunks,
        usedChunks: result.usedChunks,
      });
    } catch (err) {
      req.log?.warn?.(
        { err, sourceId: chosen.sourceId },
        "quick-answer: AI draft failed",
      );
      res.json({
        ...base,
        aiAvailable: false,
        reason: "ai_error",
        draft: null,
        chunks: [],
        usedChunks: 0,
      });
    }
  },
);

export default router;
