/**
 * Shared landing-page generation for newsletter publications.
 *
 * A publication owner sets a Topic and we auto-generate a rich editorial landing
 * page (hero copy + image, an "About this topic" lead, 2–4 editorial sections
 * each with a heading/body/image, and a "what you'll get" band). The owner can
 * then fully edit every field and regenerate any image.
 *
 * Everything degrades gracefully:
 *  - When the text model is unavailable, `generateLandingCopy` returns null and
 *    the caller surfaces a clean error WITHOUT mutating the publication.
 *  - When the image model is unavailable (or a single image fails), image
 *    generation returns null and the section/hero simply has no image — the copy
 *    still saves. The owner can regenerate later.
 *
 * Both the house publication (routes/newsletter.ts) and faculty-owned
 * publications (routes/facultyNewsletter.ts) call into this module so the two
 * surfaces stay in lockstep.
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { z } from "zod/v4";
import type { LandingContent, LandingSection } from "@workspace/db";
import { ObjectStorageService } from "./objectStorage.js";

const anthropic = new Anthropic({
  baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
});

let openaiClient: OpenAI | null = null;
function getOpenAI(): OpenAI | null {
  if (openaiClient) return openaiClient;
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!baseURL || !apiKey) return null;
  openaiClient = new OpenAI({ baseURL, apiKey });
  return openaiClient;
}

/** True when AI image generation is configured (gpt-image-1 reachable). */
export function isImageGenAvailable(): boolean {
  return getOpenAI() !== null;
}

// ── Generated copy ───────────────────────────────────────────────────────────

/** The structured copy the text model returns, validated before use. */
const aiLandingSchema = z.object({
  heroEyebrow: z.string().trim().min(1).max(80),
  heroHeadline: z.string().trim().min(1).max(160),
  heroSubhead: z.string().trim().min(1).max(400),
  aboutLead: z.string().trim().min(1).max(1200),
  heroImagePrompt: z.string().trim().min(1).max(600),
  sections: z
    .array(
      z.object({
        heading: z.string().trim().min(1).max(160),
        body: z.string().trim().min(1).max(2000),
        imagePrompt: z.string().trim().min(1).max(600),
      }),
    )
    .min(2)
    .max(4),
  benefits: z.array(z.string().trim().min(1).max(280)).min(2).max(5),
});

export interface LandingDraft {
  /** Structured copy with section image PROMPTS set but image paths null. */
  content: LandingContent;
  /** Prompt to generate the hero image. */
  heroImagePrompt: string;
}

export interface LandingCopyInput {
  topic: string;
  publicationName: string;
  bylineName?: string | null;
  bylineInstitution?: string | null;
}

/** Pull the first balanced JSON object out of a model response. */
function extractJson(text: string): unknown | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Generate the editorial copy for a landing page from a Topic. Returns null on
 * any failure (model unavailable, malformed output) so the caller can degrade
 * gracefully without corrupting the stored publication.
 */
export async function generateLandingCopy(
  input: LandingCopyInput,
): Promise<LandingDraft | null> {
  const byline = [input.bylineName, input.bylineInstitution]
    .filter(Boolean)
    .join(", ");
  const prompt = `You are an editorial director writing the public landing page for a newsletter publication. The page introduces the publication's topic to a curious general reader and invites them to subscribe (subscribing is always free).

Publication name: ${input.publicationName}
${byline ? `Author: ${byline}\n` : ""}Topic: ${input.topic}

Write warm, intelligent, grounded editorial copy — never hype, never clickbait, no emojis. Be specific to the topic.

Return ONLY a JSON object (no markdown, no code fences, no commentary) with exactly these keys:
{
  "heroEyebrow": "a 1-3 word uppercase-style eyebrow label",
  "heroHeadline": "a short, evocative hero headline (max ~10 words)",
  "heroSubhead": "one or two sentences expanding the headline",
  "aboutLead": "a single rich 'About this topic' lead paragraph (2-4 sentences)",
  "heroImagePrompt": "a vivid, concrete prompt for a calm editorial hero illustration about the topic (no text in image)",
  "sections": [
    { "heading": "section heading", "body": "1-2 paragraph editorial body (plain prose, no markdown)", "imagePrompt": "a concrete editorial image prompt for this section (no text in image)" }
  ],
  "benefits": ["short 'what you'll get when you subscribe' point", "..."]
}

Provide between 2 and 4 sections and between 3 and 5 benefits. Do not promise a publishing cadence or any payment — subscribing is free.`;

  let raw = "";
  try {
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });
    const part = msg.content.find((p: any) => p.type === "text") as
      | { text?: string }
      | undefined;
    raw = (part?.text ?? "").trim();
  } catch {
    return null;
  }

  const json = extractJson(raw);
  if (!json) return null;
  const parsed = aiLandingSchema.safeParse(json);
  if (!parsed.success) return null;

  const d = parsed.data;
  const sections: LandingSection[] = d.sections.map((s) => ({
    heading: s.heading,
    body: s.body,
    imagePath: null,
    imagePrompt: s.imagePrompt,
  }));
  return {
    content: {
      heroEyebrow: d.heroEyebrow,
      heroHeadline: d.heroHeadline,
      heroSubhead: d.heroSubhead,
      aboutLead: d.aboutLead,
      sections,
      benefits: d.benefits,
    },
    heroImagePrompt: d.heroImagePrompt,
  };
}

// ── Generated images ─────────────────────────────────────────────────────────

/**
 * Generate a single editorial image from a prompt and store it in object
 * storage. Returns the normalized object path (e.g. `/objects/...`) or null on
 * any failure (model unavailable, generation error, upload error) so callers can
 * keep going without an image.
 */
export async function generateLandingImage(
  prompt: string,
): Promise<string | null> {
  const p = prompt.trim();
  if (!p) return null;
  const openai = getOpenAI();
  if (!openai) return null;

  let b64: string | undefined;
  try {
    const result = await openai.images.generate({
      model: "gpt-image-1",
      prompt: `Editorial illustration for a wellness publication landing page. ${p}. Calm, warm, tasteful, no text, no watermark.`,
      size: "1536x1024",
    });
    b64 = result.data?.[0]?.b64_json;
  } catch {
    return null;
  }
  if (!b64) return null;

  try {
    const buffer = Buffer.from(b64, "base64");
    const svc = new ObjectStorageService();
    const uploadURL = await svc.getObjectEntityUploadURL();
    const putRes = await fetch(uploadURL, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: buffer,
    });
    if (!putRes.ok) return null;
    return svc.normalizeObjectEntityPath(uploadURL);
  } catch {
    return null;
  }
}

/**
 * Generate the hero image plus every section image for a freshly-drafted landing
 * page, in parallel. Failures are tolerated individually — a null image path
 * simply means that image will be absent until regenerated.
 */
export async function generateLandingImages(
  draft: LandingDraft,
): Promise<{ heroImagePath: string | null; content: LandingContent }> {
  const [heroImagePath, ...sectionPaths] = await Promise.all([
    generateLandingImage(draft.heroImagePrompt),
    ...draft.content.sections.map((s) =>
      s.imagePrompt ? generateLandingImage(s.imagePrompt) : Promise.resolve(null),
    ),
  ]);
  const sections = draft.content.sections.map((s, i) => ({
    ...s,
    imagePath: sectionPaths[i] ?? null,
  }));
  return {
    heroImagePath,
    content: { ...draft.content, sections },
  };
}

// ── Public resolution ────────────────────────────────────────────────────────

/** A landing section with its image resolved to a browser-fetchable URL. */
export interface ResolvedLandingSection {
  heading: string;
  body: string;
  imageUrl: string | null;
}

/** Landing content with all image paths resolved to public URLs (or null). */
export interface ResolvedLandingContent {
  heroEyebrow: string;
  heroHeadline: string;
  heroSubhead: string;
  aboutLead: string;
  sections: ResolvedLandingSection[];
  benefits: string[];
}

/**
 * Resolve a stored landing blob + hero path into the public shape served to the
 * /p/:slug page, mapping object paths to proxy-served URLs.
 */
export function resolveLandingForPublic(
  content: LandingContent | null,
  heroImagePath: string | null,
  toPublicUrl: (path: string | null) => string | null,
): {
  landing: ResolvedLandingContent | null;
  heroImageUrl: string | null;
} {
  if (!content) {
    return { landing: null, heroImageUrl: toPublicUrl(heroImagePath) };
  }
  return {
    heroImageUrl: toPublicUrl(heroImagePath),
    landing: {
      heroEyebrow: content.heroEyebrow,
      heroHeadline: content.heroHeadline,
      heroSubhead: content.heroSubhead,
      aboutLead: content.aboutLead,
      benefits: Array.isArray(content.benefits) ? content.benefits : [],
      sections: (Array.isArray(content.sections) ? content.sections : []).map(
        (s) => ({
          heading: s.heading,
          body: s.body,
          imageUrl: toPublicUrl(s.imagePath),
        }),
      ),
    },
  };
}

// ── Editable-content validation (shared by save endpoints) ───────────────────

/** Zod schema validating an edited landing blob saved by the owner. */
export const landingContentEditSchema = z.object({
  heroEyebrow: z.string().trim().max(80),
  heroHeadline: z.string().trim().max(160),
  heroSubhead: z.string().trim().max(600),
  aboutLead: z.string().trim().max(2000),
  sections: z
    .array(
      z.object({
        heading: z.string().trim().max(200),
        body: z.string().trim().max(4000),
        imagePath: z.string().trim().max(500).nullable().optional(),
        imagePrompt: z.string().trim().max(600).nullable().optional(),
      }),
    )
    .max(8),
  benefits: z.array(z.string().trim().max(400)).max(8),
});

/** Normalize an edited blob into a stored LandingContent (fills nullable image fields). */
export function normalizeEditedLanding(
  input: z.infer<typeof landingContentEditSchema>,
): LandingContent {
  return {
    heroEyebrow: input.heroEyebrow,
    heroHeadline: input.heroHeadline,
    heroSubhead: input.heroSubhead,
    aboutLead: input.aboutLead,
    benefits: input.benefits,
    sections: input.sections.map((s) => ({
      heading: s.heading,
      body: s.body,
      imagePath: s.imagePath ?? null,
      imagePrompt: s.imagePrompt ?? null,
    })),
  };
}
