import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";

const router: IRouter = Router();

const anthropic = new Anthropic({
  baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
});

const MODEL = "claude-sonnet-5";
const DESIGNATION_CLAIM =
  "This is Palonur's own Steward designation. A public profile supports current-expertise matching; while we are rolling out our partnerships with leading universities, it does not state that the person or university has accepted, endorsed, or adopted Palonur.";

export const LANDING_ROUTING_STAGES = [
  { id: "stanford", label: "Stanford" },
  { id: "chicago", label: "University of Chicago" },
  { id: "harvard", label: "Harvard" },
  { id: "oxford", label: "Oxford" },
  { id: "cambridge", label: "Cambridge" },
  { id: "other-ivies", label: "Other Ivy League universities" },
] as const;

type AuthorityRecord = {
  id: string;
  name: string;
  institution: string;
  stage: string;
  field: string;
  expertise: string;
  sourceLabel: string;
  sourceUrl: string;
  profile: string;
};

const authorityRecords: readonly AuthorityRecord[] = [
  {
    id: "christopher-gardner",
    name: "Christopher Gardner",
    institution: "Stanford",
    stage: "stanford",
    field: "nutrition and dietary patterns",
    expertise: "nutrition, food, and dietary-pattern research",
    sourceLabel: "Stanford research profile",
    sourceUrl: "https://profiles.stanford.edu/christopher-gardner",
    profile:
      "Stanford professor and nutrition scientist whose public research profile focuses on dietary patterns, food, and health.",
  },
  {
    id: "jamie-zeitzer",
    name: "Jamie Zeitzer",
    institution: "Stanford",
    stage: "stanford",
    field: "sleep and circadian science",
    expertise: "sleep, circadian timing, and light",
    sourceLabel: "Stanford research profile",
    sourceUrl: "https://profiles.stanford.edu/jamie-zeitzer",
    profile:
      "Stanford sleep scientist whose public research profile focuses on circadian timing, sleep, light, and biological rhythms.",
  },
  {
    id: "john-list",
    name: "John A. List",
    institution: "University of Chicago",
    stage: "chicago",
    field: "behavioral economics and decision-making",
    expertise: "behavioral economics, incentives, and decisions",
    sourceLabel: "University of Chicago research profile",
    sourceUrl: "https://harris.uchicago.edu/directory/john-list",
    profile:
      "University of Chicago economist whose public profile focuses on behavioral economics, incentives, and decision-making.",
  },
  {
    id: "walter-willett",
    name: "Walter Willett",
    institution: "Harvard",
    stage: "harvard",
    field: "nutrition and population health",
    expertise: "nutrition, population health, and dietary patterns",
    sourceLabel: "Harvard nutrition research profile",
    sourceUrl: "https://www.hsph.harvard.edu/nutritionsource/author/walter-willett/",
    profile:
      "Harvard epidemiologist whose public profile focuses on nutrition, dietary patterns, and population health.",
  },
  {
    id: "robert-waldinger",
    name: "Robert Waldinger",
    institution: "Harvard",
    stage: "harvard",
    field: "adult development and human connection",
    expertise: "adult development, relationships, and social connection",
    sourceLabel: "Harvard adult development research profile",
    sourceUrl: "https://adultdevelopmentstudy.org/people/robert-waldinger",
    profile:
      "Harvard psychiatrist and adult-development researcher whose public profile focuses on relationships and human connection.",
  },
  {
    id: "russell-foster",
    name: "Russell Foster",
    institution: "Oxford",
    stage: "oxford",
    field: "circadian neuroscience and sleep",
    expertise: "circadian neuroscience, sleep, and biological timing",
    sourceLabel: "University of Oxford research profile",
    sourceUrl: "https://www.ndcn.ox.ac.uk/team/russell-foster",
    profile:
      "Oxford neuroscientist whose public profile focuses on circadian rhythms, sleep, and biological timing.",
  },
  {
    id: "barbara-sahakian",
    name: "Barbara J. Sahakian",
    institution: "Cambridge",
    stage: "cambridge",
    field: "cognitive neuroscience and mental health",
    expertise: "cognitive neuroscience, attention, and mental health",
    sourceLabel: "University of Cambridge research profile",
    sourceUrl: "https://www.psychiatry.cam.ac.uk/staff/barbara-sahakian",
    profile:
      "Cambridge neuroscientist whose public profile focuses on cognition, attention, and mental health.",
  },
  {
    id: "angela-duckworth",
    name: "Angela Duckworth",
    institution: "University of Pennsylvania",
    stage: "other-ivies",
    field: "motivation and behavior change",
    expertise: "motivation, habits, and behavior change",
    sourceLabel: "University of Pennsylvania research profile",
    sourceUrl: "https://psychology.sas.upenn.edu/people/angela-duckworth",
    profile:
      "University of Pennsylvania psychologist whose public profile focuses on motivation, habits, and behavior change.",
  },
];

const lookupBody = z.object({
  question: z.string().trim().min(1).max(500),
});

const followUpBody = z.object({
  originalQuestion: z.string().trim().min(1).max(500),
  authorityId: z.string().trim().min(1).max(80),
  topic: z.string().trim().min(1).max(160),
  question: z.string().trim().min(1).max(500),
});

const publicProfileUrl = z
  .string()
  .url()
  .refine((value) => new URL(value).protocol === "https:", {
    message: "A public profile must use HTTPS.",
  });

const discoveredAuthorityOutput = z.object({
  name: z.string().min(2).max(160),
  institution: z.string().min(2).max(160),
  field: z.string().min(2).max(160),
  expertise: z.string().min(2).max(240),
  sourceLabel: z.string().min(2).max(180),
  sourceUrl: publicProfileUrl,
  profile: z.string().min(2).max(700),
});

const lookupOutput = z.object({
  authorityId: z.string().nullable(),
  authority: discoveredAuthorityOutput.nullable().optional(),
  topic: z.string().min(1).max(160),
  response: z.string().min(1).max(900),
  whyThisSteward: z.string().min(1).max(500),
});

const followUpAnswerOutput = z.string().trim().min(1).max(1400);

const recentRequests = new Map<string, { count: number; resetAt: number }>();
const discoveredAuthorities = new Map<
  string,
  { record: AuthorityRecord; expiresAt: number }
>();
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 12;

function allowRequest(req: Request, res: Response): boolean {
  const now = Date.now();
  const key = req.ip || "unknown";
  const current = recentRequests.get(key);
  if (!current || current.resetAt <= now) {
    recentRequests.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (current.count >= RATE_LIMIT) {
    res.status(429).json({ error: "Too many demo questions. Please try again shortly." });
    return false;
  }
  current.count += 1;
  return true;
}

function parseJson<T>(text: string, schema: z.ZodType<T>): T | null {
  const withoutFence = text
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const parsed = schema.safeParse(JSON.parse(withoutFence.slice(start, end + 1)));
  return parsed.success ? parsed.data : null;
}

function cleanVisitorText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function authorityCatalogForPrompt(): string {
  return authorityRecords
    .map(
      (record, index) =>
        `${index + 1}. ${record.id} | ${record.name} | ${record.institution} | ${record.field} | ${record.expertise} | ${record.profile}`,
    )
    .join("\n");
}

function rememberDiscoveredAuthority(candidate: z.infer<typeof discoveredAuthorityOutput>): AuthorityRecord {
  const record: AuthorityRecord = {
    id: `discovered-${randomUUID()}`,
    name: candidate.name,
    institution: candidate.institution,
    stage: "discovered",
    field: candidate.field,
    expertise: candidate.expertise,
    sourceLabel: candidate.sourceLabel,
    sourceUrl: candidate.sourceUrl,
    profile: candidate.profile,
  };
  discoveredAuthorities.set(record.id, {
    record,
    expiresAt: Date.now() + RATE_WINDOW_MS,
  });
  return record;
}

function findAuthorityById(id: string): AuthorityRecord | undefined {
  const catalogRecord = authorityRecords.find((record) => record.id === id);
  if (catalogRecord) return catalogRecord;
  const discovered = discoveredAuthorities.get(id);
  if (!discovered) return undefined;
  if (discovered.expiresAt <= Date.now()) {
    discoveredAuthorities.delete(id);
    return undefined;
  }
  return discovered.record;
}

async function findAuthority(question: string) {
  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8192,
    system:
      "You are Palonur's private authority-routing analyst. Prefer the supplied public authority records when one is a direct current-expertise match. If none is a direct match, discover exactly one leading, currently affiliated university faculty member or public academic whose documented expertise directly matches the question. Never invent a person, affiliation, source, quote, credential, or profile URL. Only return a discovered authority when you are confident the person is real and you know a specific public university or research-institution profile URL for them. For every successful match, name that one person in the response and say that Palonur routed the question to them. Never mention a catalog, supplied records, candidates, or the routing prompt in the public response. The institution order for supplied records is part of the routing demonstration and must be considered in this order: Stanford, University of Chicago, Harvard, Oxford, Cambridge, Other Ivy League universities. Return JSON only.",
    messages: [
      {
        role: "user",
        content: `Visitor question:
${question}

Public authority records, in routing order:
${authorityCatalogForPrompt()}

Return exactly this JSON shape:
{"authorityId":"one supplied id or null","authority":null,"topic":"short topic","response":"one concise, useful routing response that does not pretend to quote the person","whyThisSteward":"one short sentence explaining the current expertise match"}

If a supplied record is not a reasonable topic match, do not stop at a refusal. Find exactly one leading public academic and return authorityId as null plus this authority object:
{"name":"full name","institution":"current university or research institution","field":"field","expertise":"current documented expertise","sourceLabel":"name of the public profile","sourceUrl":"https://...","profile":"brief factual summary of the public profile"}
If you cannot identify one real person and one specific HTTPS public profile URL with confidence, use null for both authorityId and authority, and say so without inventing an answer. Do not return a list or multiple candidates.`,
      },
    ],
  });
  const text = message.content.find((block) => block.type === "text");
  if (!text || text.type !== "text") throw new Error("Authority lookup returned no text");
  return parseJson(text.text, lookupOutput);
}

async function answerFollowUp(
  originalQuestion: string,
  authority: AuthorityRecord,
  topic: string,
  question: string,
) {
  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8192,
    system:
      "You answer a short public demo follow-up for Palonur. Be concise, plain-spoken, and useful. Use only the supplied topic and profile context. Do not write as the named person, do not claim to quote them, and do not claim university endorsement. If the question needs evidence beyond the supplied context, say that the demo can only route it here and does not have enough source material to answer it.",
    messages: [
      {
        role: "user",
        content: `Original visitor question: ${originalQuestion}
Matched topic: ${topic}
Palonur Steward: ${authority.name}
Institution: ${authority.institution}
Current expertise: ${authority.expertise}
Public profile context: ${authority.profile}

Follow-up question:
${question}

Return only the answer text in 2 to 4 short paragraphs, with no greeting, JSON, code fence, heading, or attribution quote.`,
      },
    ],
  });
  const text = message.content.find((block) => block.type === "text");
  if (!text || text.type !== "text") throw new Error("Follow-up returned no text");
  const parsed = followUpAnswerOutput.safeParse(text.text);
  return parsed.success ? parsed.data : null;
}

router.post("/landing-demo/route", async (req, res): Promise<void> => {
  if (!allowRequest(req, res)) return;
  const parsed = lookupBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Please enter a question under 500 characters." });
    return;
  }
  if (!process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY) {
    res.status(503).json({ error: "The routing demo is temporarily unavailable." });
    return;
  }

  try {
    const question = cleanVisitorText(parsed.data.question);
    if (!question) {
      res.status(400).json({ error: "Please enter a question under 500 characters." });
      return;
    }
    const result = await findAuthority(question);
    if (!result) {
      res.status(502).json({ error: "The routing demo returned an invalid result." });
      return;
    }
    let authority = result.authorityId
      ? findAuthorityById(result.authorityId)
      : undefined;
    if (result.authorityId && !authority) {
      res.status(502).json({ error: "The routing demo selected an unknown authority." });
      return;
    }
    if (!authority && result.authority) {
      authority = rememberDiscoveredAuthority(result.authority);
    }
    res.json({
      question,
      topic: result.topic,
      response: result.response,
      whyThisSteward: result.whyThisSteward,
      designationClaim: DESIGNATION_CLAIM,
      stages: LANDING_ROUTING_STAGES,
      authority: authority
        ? {
            id: authority.id,
            name: authority.name,
            institution: authority.institution,
            field: authority.field,
            expertise: authority.expertise,
            sourceLabel: authority.sourceLabel,
            sourceUrl: authority.sourceUrl,
          }
        : null,
    });
  } catch (error) {
    req.log?.warn?.({ err: error }, "landing-demo: authority lookup failed");
    res.status(502).json({ error: "The routing demo could not complete this question." });
  }
});

router.post("/landing-demo/follow-up", async (req, res): Promise<void> => {
  if (!allowRequest(req, res)) return;
  const parsed = followUpBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Please enter a follow-up under 500 characters." });
    return;
  }
  if (!process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY) {
    res.status(503).json({ error: "The follow-up demo is temporarily unavailable." });
    return;
  }
  const authority = findAuthorityById(parsed.data.authorityId);
  if (!authority) {
    res.status(400).json({ error: "That Steward is no longer available." });
    return;
  }

  try {
    const result = await answerFollowUp(
      cleanVisitorText(parsed.data.originalQuestion),
      authority,
      cleanVisitorText(parsed.data.topic),
      cleanVisitorText(parsed.data.question),
    );
    if (!result) {
      res.status(502).json({ error: "The follow-up returned an invalid result." });
      return;
    }
    res.json({
      question: cleanVisitorText(parsed.data.question),
      answer: result,
    });
  } catch (error) {
    req.log?.warn?.({ err: error }, "landing-demo: follow-up failed");
    res.status(502).json({ error: "The follow-up could not be completed." });
  }
});

export default router;