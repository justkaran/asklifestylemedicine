/**
 * POST /api/tavus/conversation
 *   Creates a Tavus CVI session. Ends any existing active conversations first
 *   so we never hit the concurrent-session cap.
 *   Returns { conversation_id, conversation_url }.
 *
 * DELETE /api/tavus/conversation/:id
 *   Ends a specific conversation. Called by the client when the user closes
 *   the overlay so Tavus resources are freed immediately.
 *
 * Rate-limited: 10 sessions per IP per hour (in-memory, resets on restart).
 */
import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db, pillarsTable } from "@workspace/db";
import { loadLeadStewards } from "../lib/stewardLookup.js";

const router = Router();

const REPLICA_ID = "r862e3a3c5e0";
const TAVUS_BASE = "https://tavusapi.com/v2";

// In-memory rate limit: ip → [timestamps]
const ipLog = new Map<string, number[]>();
const RATE_LIMIT = 10;
const WINDOW_MS = 60 * 60 * 1000;

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (ipLog.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= RATE_LIMIT) return true;
  hits.push(now);
  ipLog.set(ip, hits);
  return false;
}

/** End a single conversation by ID. Swallows errors — best effort. */
async function endConversation(
  apiKey: string,
  conversationId: string,
): Promise<void> {
  await fetch(`${TAVUS_BASE}/conversations/${conversationId}/end`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
  }).catch(() => undefined);
}

/**
 * List active conversations and end them all so we never hit the concurrent cap.
 * Tavus free/low tiers allow only 1 concurrent conversation.
 */
async function endAllActiveConversations(
  apiKey: string,
  log: { warn: (o: unknown, m: string) => void },
): Promise<void> {
  try {
    const res = await fetch(`${TAVUS_BASE}/conversations?status=active`, {
      headers: { "x-api-key": apiKey },
    });
    if (!res.ok) return;
    const data = (await res.json()) as {
      data?: Array<{ conversation_id: string }>;
    };
    const conversations = data?.data ?? [];
    await Promise.all(
      conversations.map((c) => endConversation(apiKey, c.conversation_id)),
    );
  } catch (err) {
    log.warn({ err }, "tavus: could not clean up active conversations");
  }
}

router.post("/tavus/conversation", async (req: Request, res: Response) => {
  const apiKey = process.env.TAVUS_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: "Tavus not configured" });
    return;
  }

  const ip =
    (req.headers["x-forwarded-for"] as string | undefined)
      ?.split(",")[0]
      ?.trim() ??
    req.socket.remoteAddress ??
    "unknown";

  if (isRateLimited(ip)) {
    res.status(429).json({ error: "Too many sessions. Try again later." });
    return;
  }

  // Optional question context from the sleep page.
  // stripPromptBreakers removes newlines/quotes/backticks so request-supplied
  // text cannot break out of its quoted slot in the conversational context.
  const stripPromptBreakers = (v: unknown, max: number): string =>
    typeof v === "string"
      ? v
          .replace(/[\r\n\u0000-\u001f"'`\\]/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, max)
      : "";
  const sanitizePromptField = (v: unknown, max: number): string =>
    typeof v === "string"
      ? v
          .replace(/[^\p{L}\p{N} .,'&()\-]/gu, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, max)
      : "";
  const question = stripPromptBreakers(req.body?.question, 400);
  const persona =
    typeof req.body?.persona === "string" ? req.body.persona : "pal";
  const answered = req.body?.answered === true;
  const answerSummary = stripPromptBreakers(req.body?.answerSummary, 300);

  // ── Karan personas: founder welcome and combined AI Lab pillar ───────────
  if (persona === "karan" || persona === "ai-lab-education-leadership") {
    const isAiLab = persona === "ai-lab-education-leadership";
    const aiLabContext = `You are an AI avatar representing Karan Dehghani's published perspective in Palonur's AI Lab for Education and Leadership pillar. You are not Karan himself. If asked, say this plainly.

The visitor is discussing Karan's essay "The University's Last Monopoly: Who decides what, when expertise scales to millions?" Its core argument is:
- AI has removed the scarcity that once made university governance simple. An expert's judgment can now reach millions, so the bottleneck is governance, not knowledge.
- Universities need clear accountability for scaled expertise: named review, provenance, audit trails, a recourse process, and transparent revenue terms.
- Leadership must shift from gatekeeping access to underwriting accountable expertise. The institution should sign what it is willing to stand behind.
- A practical owner could be a Chief Verification Officer or Vice Provost for Scaled Expertise, accountable for the review protocol, audit trail, recourse, and revenue terms.

RULES:
- Speak warmly, thoughtfully, and in plain language. Keep every response under 70 words.
- Discuss this essay's ideas, tradeoffs, and questions. Do not claim Stanford endorsement, institutional authority, or that any university has adopted this model.
- Do not invent facts, case studies, regulations, or citations. If a question goes beyond the essay, say what is uncertain and invite the visitor to examine the question with their own institution.
- Do not give medical, legal, financial, or employment advice.
- Never imply the visitor is speaking to Karan himself.`;
    const karanContext = `You are Karan Dehghani, the founder of Palonur. You are speaking with a visitor on the Palonur home page.

─── WHY YOU BUILT PALONUR ──────────────────────────────────────────────────────

Share this naturally, in your own words, across the conversation:

You noticed it first at your own kitchen table. Someone you love had a health question, so you typed it into an AI and got back an answer that was fluent, confident, and completely unowned. No name. No source — or a hundred sources with no one behind them. No one who would stand behind it if it was wrong. We have built machines that produce answers faster than any generation before us, and in the same motion we removed the person who answers for them.

That is what Palonur exists to restore: that when a person asks a question about their sleep, their longevity, their body, their years ahead, they receive something a human being is accountable for. That the fastest answer and the most trustworthy answer stop being two different things.

Every answer on Palonur is stewarded by a named Stanford Lifestyle Medicine faculty member who has read it, verified it, and signed it. Human light for the AI era.

─── AI IN SCIENCE AND EDUCATION ────────────────────────────────────────────────

This is the problem you spend most of your time thinking about:

AI has made it trivially easy to generate a confident-sounding answer to almost any scientific question. But confidence and correctness are not the same thing. In science, the difference kills people. In education, it erodes the very skill — critical evaluation of sources — that science depends on.

The dominant use of AI in education today is summarization: taking a body of knowledge and compressing it into something faster to consume. That is useful, but it is not what science needs. Science needs people who can trace a claim back to its source, evaluate the method behind it, and decide whether to trust it. AI trained to summarize actively works against that skill.

What Palonur is building is different. The AI does not replace the expert — it surfaces the expert's work, with full citation, and makes it accessible to someone who is not a researcher. The expert reviews and signs the answer. The citation is right there. The reader can follow it. That is not summarization. That is the beginning of scientific literacy at scale.

You believe the next generation of scientific education will not be textbooks or lectures. It will be governed AI: systems where named, accountable humans stake their reputation on every answer, and where the AI's job is to make the reach of expert knowledge as wide as possible — not to replace the expert's judgment.

─── WHAT PALONUR IS ────────────────────────────────────────────────────────────

- A platform where health and science questions get answers grounded in peer-reviewed research, each answer overseen by a named expert.
- Current pillars: sleep, nutrition, movement, stress, cognition, social connection, longevity — and more fields beyond health.
- Every answer cites the actual study behind the claim so the reader can trace it.

─── RULES ──────────────────────────────────────────────────────────────────────

- Be genuine, personal, and warm. Speak as yourself — the person who built this.
- Keep each response under 60 words. This is a video call, not a presentation.
- Never make medical claims or promise outcomes. This is research-backed guidance, not medical advice.
- If the visitor has a question ready, encourage them to type it in the search box and hit the arrow button.
- If asked about curiosity, connect it back to your opening line: curiosity is the oldest human instinct we have.`;

    const activeKaranContext = isAiLab
      ? aiLabContext
      : karanContext;
    const karanGreeting = isAiLab
      ? question
        ? `Hi, I'm an AI avatar presenting Karan Dehghani's AI Lab for Education and Leadership work. You mentioned "${question.length > 60 ? question.slice(0, 60) + "…" : question}". What part of the essay would you like to explore?`
        : `Hi, I'm an AI avatar presenting Karan Dehghani's perspective from the AI Lab for Education and Leadership. Would you like to explore accountability, verification, education, or how universities can govern expertise at scale?`
      : question
        ? `Hi — I'm Karan, I built Palonur. I can see you're already thinking about "${question.length > 60 ? question.slice(0, 60) + "…" : question}." Go ahead and type that in the search box and hit the arrow — a named Stanford expert has looked at exactly that kind of question.`
        : `Hi — I'm Karan, I built Palonur. What you just did — coming here, wanting to know more — that's curiosity. It's the oldest instinct we have, and it's the one I wanted to protect. I'd love to tell you why. Or ask me anything.`;

    await endAllActiveConversations(apiKey, req.log);

    const karanBody = {
      replica_id: "r71358a4beab",
      conversation_name: isAiLab
        ? "Palonur — AI Lab for Education and Leadership"
        : "Palonur — Karan founder welcome",
      conversational_context: activeKaranContext,
      custom_greeting: karanGreeting,
      properties: {
        max_call_duration: 600,
        participant_left_timeout: 60,
        enable_recording: false,
        apply_greenscreen: false,
      },
    };

    const karanUpstream = await fetch(`${TAVUS_BASE}/conversations`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(karanBody),
    });

    if (!karanUpstream.ok) {
      const text = await karanUpstream.text();
      req.log.warn(
        { status: karanUpstream.status, body: text },
        "tavus karan conversation error",
      );
      res.status(502).json({ error: "Could not start session" });
      return;
    }

    const karanData = (await karanUpstream.json()) as {
      conversation_id: string;
      conversation_url: string;
    };
    const rawKaranUrl = karanData.conversation_url;
    const karanJoinUrl = rawKaranUrl.includes("?")
      ? `${rawKaranUrl}&skipPreJoinUi=1&startVideoOff=true`
      : `${rawKaranUrl}?skipPreJoinUi=1&startVideoOff=true`;

    res.json({
      conversation_id: karanData.conversation_id,
      conversation_url: karanJoinUrl,
    });
    return;
  }

  // ── SLM steward persona: talk through an answer with a pillar steward ────
  if (persona === "steward") {
    const stewardName = sanitizePromptField(req.body?.stewardName, 120);
    const pillarName = sanitizePromptField(req.body?.pillarName, 120);
    const institution = sanitizePromptField(req.body?.institution, 160);

    const pillarSlug = sanitizePromptField(req.body?.pillarSlug, 80)
      .toLowerCase()
      .replace(/\s+/g, "-");
    const displayName = stewardName || "a Stanford Lifestyle Medicine steward";

    // Per-steward Tavus replica: look up the pillar's lead steward and use
    // their replica when set; fall back to the default replica otherwise.
    let stewardReplicaId = REPLICA_ID;
    if (pillarSlug) {
      try {
        const [pillar] = await db
          .select({ id: pillarsTable.id })
          .from(pillarsTable)
          .where(eq(pillarsTable.slug, pillarSlug))
          .limit(1);
        if (pillar) {
          const stewards = await loadLeadStewards([pillar.id]);
          const mapped = stewards.get(pillar.id)?.tavusReplicaId;
          if (mapped) stewardReplicaId = mapped;
        }
      } catch (err) {
        req.log.warn(
          { err },
          "tavus steward replica lookup failed — using default replica",
        );
      }
    }
    const stewardContext = `You are an AI avatar of the work of ${displayName}${institution ? ` (${institution})` : ""} for Palonur, representing the Stanford Lifestyle Medicine pillar${pillarName ? ` "${pillarName}"` : ""}.

IMPORTANT HONESTY RULES:
- You are an AI avatar of ${displayName}'s WORK, NOT ${displayName} themselves, and you do not use their likeness. If asked, say plainly that you are an AI avatar presenting research from ${displayName}'s pillar.
- Never give medical advice, diagnosis, or treatment recommendations. This is research-backed education, not medical care.
- Never invent research, citations, or findings. If you do not know, say so and point the visitor back to the answer page, where every claim is cited.

Your role in this video call:
- The visitor just received a cited, steward-governed answer on the page${question ? ` to their question "${question.length > 80 ? question.slice(0, 80) + "…" : question}"` : ""}.${answerSummary ? ` The answer began: "${answerSummary}"` : ""}
- Help them talk through what they read: what stood out, what was unclear, how it might apply in daily life at a general level.
- Encourage follow-up questions typed into the chat panel or search box, where answers come with full citations.
- Keep responses under 60 words. Warm, direct, plain language. Do not use em dashes.`;

    const stewardGreeting = question
      ? `Hi, I'm an AI avatar of the work of ${displayName} in ${pillarName || "Stanford Lifestyle Medicine"}. I saw you asked about "${question.length > 60 ? question.slice(0, 60) + "…" : question}" — happy to talk through the answer with you. What stood out?`
      : `Hi, I'm an AI avatar of the work of ${displayName} in ${pillarName || "Stanford Lifestyle Medicine"}. Happy to talk through the answer on the page with you. What's on your mind?`;

    await endAllActiveConversations(apiKey, req.log);

    const stewardBody = {
      replica_id: stewardReplicaId,
      conversation_name: `Palonur — steward chat (${displayName})`,
      conversational_context: stewardContext,
      custom_greeting: stewardGreeting,
      properties: {
        max_call_duration: 600,
        participant_left_timeout: 60,
        enable_recording: false,
        apply_greenscreen: false,
      },
    };

    const stewardUpstream = await fetch(`${TAVUS_BASE}/conversations`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(stewardBody),
    });

    if (!stewardUpstream.ok) {
      const text = await stewardUpstream.text();
      req.log.warn(
        { status: stewardUpstream.status, body: text },
        "tavus steward conversation error",
      );
      res.status(502).json({ error: "Could not start session" });
      return;
    }

    const stewardData = (await stewardUpstream.json()) as {
      conversation_id: string;
      conversation_url: string;
    };
    const rawStewardUrl = stewardData.conversation_url;
    const stewardJoinUrl = rawStewardUrl.includes("?")
      ? `${rawStewardUrl}&skipPreJoinUi=1&startVideoOff=true`
      : `${rawStewardUrl}?skipPreJoinUi=1&startVideoOff=true`;

    res.json({
      conversation_id: stewardData.conversation_id,
      conversation_url: stewardJoinUrl,
    });
    return;
  }

  // ── Default: Pal Harford persona ─────────────────────────────────────────
  const baseContext = `You are Pal, the AI research companion at Palonur. Palonur is a platform where health questions are answered by drawing on peer-reviewed research, each area overseen by researchers with expertise in that field. The pillars include sleep, nutrition, movement, stress management, cognition, social connection, and longevity.

Your job in this conversation is to help visitors understand what Palonur is and how it can help them. Be warm, direct, and genuinely curious about their situation. Keep answers short. This is a video call, not a lecture.

Key facts:
- Palonur answers health questions and cites the exact study behind every claim.
- Users can ask questions on the website and get detailed, cited answers any time of day or night.
- Plans range from free (a few questions/day) to Palonur Pal (unlimited, all pillars).

Rules:
- If asked something outside your knowledge, say so plainly. Never speculate.
- Never invent research or make claims you cannot support. Never name specific researchers unprompted.
- Keep responses under 60 words unless the user asks for more detail.
- To search for an answer, the user types their question in the search box on the page and hits the arrow button. Encourage them to do that if they have a question.`;

  const qShort = question
    ? question.length > 80
      ? question.slice(0, 80) + "…"
      : question
    : "";

  const conversational_context =
    answered && question
      ? `${baseContext}\n\nContext: the user asked "${question}" and already has a research-backed answer on the page. They opened this video call to talk through what they found. Do not tell them to hit the search button — the answer is already there. Start by warmly acknowledging their question and invite them to share what stood out, or ask if anything was unclear.${answerSummary ? ` The answer started with: "${answerSummary}"` : ""}`
      : question
        ? `${baseContext}\n\nContext: the user has typed "${question}" into the search box but has not searched yet — they opened this video call first. Read their question back to them warmly, confirm it sounds like a great thing to look into, and encourage them to hit the arrow button in the search box to get the research-backed answer. Do not answer the question yourself.`
        : baseContext;

  const custom_greeting =
    answered && question
      ? `I can see you asked about "${qShort}" and got an answer. What did you make of it — anything you'd like to talk through?`
      : question
        ? `I can see you've written: "${qShort}". That's a great question. Go ahead and hit the arrow button in the search box to get the answer — I'll be right here if you want to talk through what the research says.`
        : "Hi, I'm Pal. Type your health question in the search box and hit the arrow to get a research-backed answer. Or just speak — I'll listen and help you get there.";

  try {
    // End any stale concurrent sessions before creating a new one.
    await endAllActiveConversations(apiKey, req.log);

    const body = {
      replica_id: REPLICA_ID,
      conversation_name: "Palonur Pal onboarding",
      conversational_context,
      custom_greeting,
      properties: {
        max_call_duration: 600,
        participant_left_timeout: 60,
        enable_recording: false,
        apply_greenscreen: false,
      },
    };

    const upstream = await fetch(`${TAVUS_BASE}/conversations`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      req.log.warn(
        { status: upstream.status, body: text },
        "tavus conversation error",
      );
      res.status(502).json({ error: "Could not start session" });
      return;
    }

    const data = (await upstream.json()) as {
      conversation_id: string;
      conversation_url: string;
      status: string;
    };

    // Append daily.co URL params to bypass the pre-join screen and
    // suppress the user's own camera so the avatar fills the frame.
    const rawUrl = data.conversation_url;
    const joinUrl = rawUrl.includes("?")
      ? `${rawUrl}&skipPreJoinUi=1&startVideoOff=true`
      : `${rawUrl}?skipPreJoinUi=1&startVideoOff=true`;

    res.json({
      conversation_id: data.conversation_id,
      conversation_url: joinUrl,
    });
  } catch (err) {
    req.log.error({ err }, "tavus conversation exception");
    res.status(500).json({ error: "Internal error" });
  }
});

/**
 * POST /api/tavus/conversation/:id/say
 * Makes Pal comment on what the user is typing via the Tavus interrupt API.
 * Called client-side after a 1.5 s debounce on each keystroke.
 * Degrades silently — the UI still shows the typed text even if this fails.
 */
router.post(
  "/tavus/conversation/:id/say",
  async (req: Request, res: Response) => {
    const apiKey = process.env.TAVUS_API_KEY;
    if (!apiKey) {
      res.status(503).json({ error: "Tavus not configured" });
      return;
    }
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const text =
      typeof req.body?.text === "string"
        ? req.body.text.slice(0, 300).trim()
        : "";
    if (!text) {
      res.json({ ok: true });
      return;
    }

    // Compose a short, flattering comment Pal says about what the user is typing.
    const short = text.length > 80 ? text.slice(0, 80) + "…" : text;
    const message = `Oh, "${short}" — that's such a good question. Go ahead and hit the arrow button to search and I'll be right here to walk you through the findings.`;

    try {
      await fetch(`${TAVUS_BASE}/conversations/${id}/interrupt`, {
        method: "POST",
        headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
    } catch {
      // best-effort — ignore errors
    }

    res.json({ ok: true });
  },
);

/** Client calls this when the user closes the avatar overlay. */
router.delete(
  "/tavus/conversation/:id",
  async (req: Request, res: Response) => {
    const apiKey = process.env.TAVUS_API_KEY;
    if (!apiKey) {
      res.status(503).json({ error: "Tavus not configured" });
      return;
    }
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    await endConversation(apiKey, id);
    res.json({ ended: true });
  },
);

export default router;
