import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import i18n from "../i18n";
import { parseAnswer, type ParsedAnswer } from "../lib/parse-answer";
import { StewardChatPanel } from "../components/steward-chat-panel";
import TavusAvatarButton from "../components/TavusAvatar";
import { MinicastButton } from "../components/MinicastButton";
import { useTtsController } from "../lib/use-tts-controller";
import { warmReturnGreeting } from "../lib/return-greeting";
import { SLM_STANDALONE } from "../lib/app-mode";
import { SLM_COACH_LESSONS, type SlmCoachLesson } from "../lib/slm-articles";
import { SlmCoach, type VerifiedCoachVideo } from "../components/slm-coach";

/**
 * Standalone Stanford Lifestyle Medicine chat — the ONLY surface served on
 * the SLM domain (asklifestylemedicine.com). A familiar Gemini/ChatGPT-style
 * conversation: centered greeting, message thread, composer pinned at the
 * bottom, nothing else.
 *
 * Questions are unlimited and free but require a registered account
 * (magic-link email sign-in — no payment gate is shown anywhere here).
 * The server enforces this via `standalone: true` on /api/slm-agent.
 */

const BASE = import.meta.env.BASE_URL;

export function buildSlmAuthDestination(
  standalone: boolean,
  base = BASE,
): { slmStandalone: boolean; next?: string } {
  return standalone
    ? { slmStandalone: true }
    : { slmStandalone: false, next: `${base}slm` };
}

const SANS =
  "'Source Sans 3', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const SERIF = "'Source Serif 4', Georgia, 'Times New Roman', serif";
const INK = "#0A0A0F";
// Stanford Cardinal red — used sparingly as an accent (headings, key names).
const CARDINAL = "#8C1515";
const RED = SLM_STANDALONE ? CARDINAL : "#B3261E";
const PAPER = SLM_STANDALONE ? "#FFFFFF" : "#FAF8F4";
const CARD = "#FFFFFF";
const MUTED = "rgba(10,10,15,0.64)";
const RULE = "rgba(10,10,15,0.10)";
const LOGO_SRC = SLM_STANDALONE
  ? `${BASE}asklifestylemedicine-logo.png`
  : `${BASE}stanford-lifestyle-medicine-logo-transparent.png`;

const LOCAL_STEWARD_PHOTOS: Record<string, string> = {
  "anne friedlander": "anne-friedlander.jpg",
  "jamie zeitzer": "jamie-zeitzer.jpg",
  "karen parker": "karen-parker.jpg",
  "marily oppezzo": "marily-oppezzo.jpg",
  "michael fredericson": "michael-fredericson.jpg",
  "sarah meyer tapia": "sarah-meyer-tapia.jpg",
  "shaliza shorey": "shaliza-shorey.jpg",
  "steven crane": "steven-crane.png",
};

function stewardPhotoSrc(steward: SlmSteward): string {
  const local = LOCAL_STEWARD_PHOTOS[(steward.stewardName ?? "").toLowerCase()];
  return local ? `${BASE}stewards/${local}` : (steward.photoUrl ?? "");
}

const PENDING_KEY = "slm_pending_question";
// Held questions expire with the magic link (30 min): never auto-submit a
// stale question from an earlier visit (possibly someone else's on a shared
// browser).
const PENDING_TTL_MS = 30 * 60 * 1000;

function savePending(q: string) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ q, ts: Date.now() }));
  } catch {
    /* private mode etc. — gate still works, question just isn't restored */
  }
}

function takePending(): string | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    localStorage.removeItem(PENDING_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as { q?: unknown; ts?: unknown };
    if (typeof d.q !== "string" || typeof d.ts !== "number") return null;
    if (Date.now() - d.ts > PENDING_TTL_MS) return null;
    return d.q;
  } catch {
    return null;
  }
}

// Onboarding state that must survive the browser session: after registering,
// we remember who they are so a RETURNING unverified visitor sees a "confirm
// your email" reminder (and is blocked) instead of the full onboarding again.
const ONBOARD_KEY = "slm_onboard";
// This is intentionally browser-only and exists solely for the pre-signup
// welcome. Account identity and return greetings always come from /consumer/me.
const VISITOR_NAME_KEY = "slm_standalone_visitor_name";

interface OnboardState {
  name: string;
  email: string;
  verifyPending: boolean;
}

function saveOnboard(s: OnboardState) {
  try {
    localStorage.setItem(ONBOARD_KEY, JSON.stringify(s));
  } catch {
    /* private mode — server still enforces the gate */
  }
}

function readOnboard(): OnboardState | null {
  try {
    const raw = localStorage.getItem(ONBOARD_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<OnboardState>;
    if (typeof d.email !== "string" || typeof d.name !== "string") return null;
    return {
      name: d.name,
      email: d.email,
      verifyPending: d.verifyPending === true,
    };
  } catch {
    return null;
  }
}

function clearOnboard() {
  try {
    localStorage.removeItem(ONBOARD_KEY);
  } catch {
    /* ignore */
  }
}

function readVisitorName(): string {
  try {
    return firstNameOf(sessionStorage.getItem(VISITOR_NAME_KEY)) ?? "";
  } catch {
    return "";
  }
}

function saveVisitorName(name: string) {
  try {
    sessionStorage.setItem(VISITOR_NAME_KEY, firstNameOf(name) ?? "");
  } catch {
    /* private mode — the welcome simply remains in this React session */
  }
}

function clearVisitorName() {
  try {
    sessionStorage.removeItem(VISITOR_NAME_KEY);
  } catch {
    /* ignore */
  }
}

function firstNameOf(name: string | null | undefined): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first ? first : null;
}

function greetingNameOf(name: string | null | undefined): string | null {
  const first = firstNameOf(name);
  return first?.includes("@") ? null : first;
}

const WELCOME_NAME_PROMPT =
  "Welcome to the Stanford Lifestyle Medicine Program.\n\n" +
  "Let's get to know each other first. I was built by faculty at Stanford, so you can ask us questions about Lifestyle Medicine.\n\n" +
  "I would love to get to know you. What's your name?";

/**
 * A deliberately quiet first impression: the prompt arrives one character at
 * a time, while the bottom composer stays ready for the visitor's reply.
 * The accessible name is complete from the start so assistive tech does not
 * announce every individual letter.
 */
function TypewriterGreeting({
  text,
  onComplete,
}: {
  text: string;
  onComplete?: () => void;
}) {
  const [visibleText, setVisibleText] = useState("");
  const onCompleteRef = useRef(onComplete);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    const reduceMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reduceMotion) {
      setVisibleText(text);
      onCompleteRef.current?.();
      return;
    }

    setVisibleText("");
    let index = 0;
    // The opening is intentionally unhurried: it should feel like a person
    // settling into a conversation, not a loading animation.
    const characterDelay = text.length > 100 ? 65 : 46;
    const timer = window.setInterval(() => {
      index += 1;
      setVisibleText(text.slice(0, index));
      if (index >= text.length) {
        window.clearInterval(timer);
        onCompleteRef.current?.();
      }
    }, characterDelay);
    return () => window.clearInterval(timer);
  }, [text]);

  return (
    <span aria-label={text} style={{ whiteSpace: "pre-wrap" }}>
      <span aria-hidden="true">{visibleText}</span>
      <span className="slm-typewriter-cursor" aria-hidden="true">
        _
      </span>
    </span>
  );
}

interface TypewriterPart {
  text: string;
  render: (content: string, cursor: boolean) => React.ReactNode;
}

function StructuredTypewriterGreeting({
  parts,
  onComplete,
}: {
  parts: TypewriterPart[];
  onComplete?: () => void;
}) {
  const fullText = parts.map((p) => p.text).join("");
  const ariaText = parts.map((p) => p.text).join(" ");
  const [visibleChars, setVisibleChars] = useState(0);
  const onCompleteRef = useRef(onComplete);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    const reduceMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reduceMotion) {
      setVisibleChars(fullText.length);
      onCompleteRef.current?.();
      return;
    }

    setVisibleChars(0);
    let index = 0;
    const characterDelay = fullText.length > 100 ? 65 : 46;
    const timer = window.setInterval(() => {
      index += 1;
      setVisibleChars(index);
      if (index >= fullText.length) {
        window.clearInterval(timer);
        onCompleteRef.current?.();
      }
    }, characterDelay);
    return () => window.clearInterval(timer);
  }, [fullText]);

  let charsLeft = visibleChars;
  let cursorRendered = false;

  return (
    <div aria-label={ariaText}>
      {parts.map((part, i) => {
        const take = Math.max(0, Math.min(charsLeft, part.text.length));
        const textToRender = part.text.slice(0, take);
        charsLeft -= part.text.length;

        let isCursorHere = false;
        if (!cursorRendered) {
          if (charsLeft < 0 && take > 0) {
            isCursorHere = true;
            cursorRendered = true;
          } else if (
            visibleChars >= fullText.length &&
            i === parts.length - 1
          ) {
            isCursorHere = true;
            cursorRendered = true;
          } else if (visibleChars === 0 && i === 0) {
            isCursorHere = true;
            cursorRendered = true;
          }
        }

        if (take === 0 && visibleChars > 0 && charsLeft < -part.text.length)
          return null;

        return (
          <Fragment key={i}>{part.render(textToRender, isCursorHere)}</Fragment>
        );
      })}
    </div>
  );
}

const WELCOME_NAME_PARTS: TypewriterPart[] = [
  {
    text: "Welcome to the Stanford Lifestyle Medicine Program.",
    render: (content, cursor) => (
      <div
        style={{
          color: CARDINAL,
          fontSize: 14,
          fontWeight: 700,
          letterSpacing: ".14em",
          textTransform: "uppercase",
          marginBottom: 30,
          fontFamily: SANS,
        }}
      >
        <span aria-hidden="true">{content}</span>
        {cursor && (
          <span className="slm-typewriter-cursor" aria-hidden="true">
            _
          </span>
        )}
      </div>
    ),
  },
  {
    text: "Let's get to know each other first. I was built by faculty at Stanford, so you can ask us questions about Lifestyle Medicine.",
    render: (content, cursor) => (
      <h1
        id="slm-welcome-title"
        style={{
          fontFamily: SANS,
          fontSize: "clamp(42px, 6vw, 72px)",
          fontWeight: 300,
          lineHeight: 1.08,
          color: INK,
          maxWidth: 760,
          margin: "0 0 28px 0",
        }}
      >
        <span aria-hidden="true">{content}</span>
        {cursor && (
          <span className="slm-typewriter-cursor" aria-hidden="true">
            _
          </span>
        )}
      </h1>
    ),
  },
];

const SUGGESTIONS = [
  "How does exercise affect sleep?",
  "What should I eat after 50?",
  "Can stress raise inflammation?",
  "Why does connection matter as we age?",
];

const COMPANION_CONVERSATION_CUE =
  /\b(i want|i'd like|i need|help me|how can i|struggl|trying to|improv|change|build|develop|habit|routine|goal|progress)\b/i;

/**
 * Per-pillar personal chip copy: a real-life problem first, with the steward
 * portrait providing the human anchor. One is chosen at random per visit from
 * the stewards the server returns, so the hero always names a real person
 * whose pillar will answer.
 */
const STEWARD_CHIP_TOPICS: Record<string, { topic: string; question: string }> =
  {
    nutrition: {
      topic: "protein after 60",
      question: "How much protein do I need after 60?",
    },
    sleep: {
      topic: "waking up at 3am",
      question:
        "Why do I wake up in the middle of the night, and how do I get back to sleep?",
    },
    movement: {
      topic: "keeping your strength",
      question: "How do I keep my strength as I get older?",
    },
    "stress-management": {
      topic: "calming everyday stress",
      question: "What actually helps lower stress day to day?",
    },
    "social-connection": {
      topic: "loneliness and health",
      question: "How does loneliness affect health, and what helps?",
    },
    "cognitive-enhancement": {
      topic: "keeping your memory sharp",
      question: "How can I keep my memory sharp as I age?",
    },
  };

interface ProvenanceEntry {
  source_id: number;
  interpretation_id: number | null;
  title: string;
  authors: string | null;
  year: number | null;
  journal: string | null;
  doi: string | null;
  source_url: string | null;
  pillar_slug: string;
}

type Turn =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      status: "streaming" | "done" | "error";
      text: string;
      parsed: ParsedAnswer | null;
      provenance: ProvenanceEntry[];
      pillarNames: string[];
      fallbackSteward: string | null;
      /** Suggested follow-up chips (covered answers only). */
      suggested?: string[];
    }
  | { role: "signin" }
  /** Small centered status line (e.g. post-registration verification note). */
  | { role: "notice"; text: string };

// ── Assistant answer rendering ─────────────────────────────────────────────

function Sources({
  entries,
  rail = false,
}: {
  entries: ProvenanceEntry[];
  rail?: boolean;
}) {
  if (entries.length === 0) return null;
  return (
    <div
      style={
        rail
          ? { padding: "4px 18px" }
          : { marginTop: 16, borderTop: `1px solid ${RULE}`, paddingTop: 12 }
      }
    >
      {!rail && (
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: ".18em",
            textTransform: "uppercase",
            color: MUTED,
            marginBottom: 8,
            fontFamily: SANS,
          }}
        >
          Sources
        </div>
      )}
      {entries.map((e, i) => (
        <div
          key={i}
          style={{
            marginBottom: rail ? 0 : 7,
            padding: rail ? "13px 0" : 0,
            borderBottom:
              rail && i < entries.length - 1 ? `1px solid ${RULE}` : "none",
            fontFamily: SERIF,
            fontSize: rail ? 13.5 : 13,
            lineHeight: 1.5,
            color: "rgba(10,10,15,0.7)",
          }}
        >
          {e.authors && (
            <span style={{ fontWeight: 600 }}>
              {e.authors}
              {e.year ? `, ${e.year}` : ""}.{" "}
            </span>
          )}
          {e.source_url ? (
            <a
              href={e.source_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: RED, textDecoration: "none" }}
            >
              {e.title}
            </a>
          ) : (
            <span style={{ fontStyle: "italic" }}>{e.title}</span>
          )}
          {e.journal && (
            <span style={{ color: MUTED }}>
              {" · "}
              {e.journal}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** Lead steward of an SLM pillar, from GET /api/slm-agent/stewards. */
interface SlmSteward {
  pillarSlug: string;
  pillarName: string;
  stewardName: string;
  institution: string | null;
  photoUrl: string | null;
}

/**
 * Steward attribution, redesigned as an invitation rather than a directory:
 * the ONE steward whose pillar contributed most is shown with a "Keep
 * talking with …" action; any other contributing stewards collapse into a
 * single quiet line. Clicking the action focuses the conversation on that
 * steward's pillar (grounding rules unchanged — the server still answers
 * only from approved content).
 */
function StewardStrip({
  pillarNames,
  provenance,
  stewards,
  focusedSlug,
  onContinueWith,
}: {
  pillarNames: string[];
  provenance: ProvenanceEntry[];
  stewards: Map<string, SlmSteward>;
  focusedSlug: string | null;
  onContinueWith: (s: SlmSteward) => void;
}) {
  const matched = pillarNames
    .map((n) => stewards.get(n))
    .filter((s): s is SlmSteward => !!s);
  if (matched.length === 0) return null;

  // Rank by how much of the answer's evidence came from each pillar.
  const weight = new Map<string, number>();
  for (const p of provenance) {
    weight.set(p.pillar_slug, (weight.get(p.pillar_slug) ?? 0) + 1);
  }
  const ranked = [...matched].sort(
    (a, b) => (weight.get(b.pillarSlug) ?? 0) - (weight.get(a.pillarSlug) ?? 0),
  );
  const primary = ranked[0];
  const others = ranked.slice(1);

  return (
    <div
      style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${RULE}` }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        {primary.photoUrl && (
          <img
            src={stewardPhotoSrc(primary)}
            alt={primary.stewardName}
            width={40}
            height={40}
            style={{ borderRadius: "50%", objectFit: "cover", flexShrink: 0 }}
          />
        )}
        <div style={{ fontFamily: SANS, lineHeight: 1.35, flex: "1 1 160px" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: CARDINAL }}>
            {primary.stewardName}
          </div>
          <div style={{ fontSize: 11.5, color: MUTED }}>
            {primary.pillarName}
            {primary.institution ? ` · ${primary.institution}` : ""}
          </div>
        </div>
        {focusedSlug !== primary.pillarSlug && (
          <button
            type="button"
            onClick={() => onContinueWith(primary)}
            className="slm-chip"
            style={{
              padding: "8px 16px",
              borderRadius: 999,
              border: `1px solid ${CARDINAL}`,
              background: "transparent",
              fontFamily: SANS,
              fontSize: 12.5,
              fontWeight: 600,
              color: CARDINAL,
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            Keep talking with{" "}
            {firstNameOf(primary.stewardName) ?? primary.stewardName}
          </button>
        )}
      </div>
      {others.length > 0 && (
        <div
          style={{
            marginTop: 8,
            fontFamily: SANS,
            fontSize: 11.5,
            color: MUTED,
          }}
        >
          Also drew on{" "}
          {others.map((s) => `${s.stewardName} (${s.pillarName})`).join(", ")}
        </div>
      )}
    </div>
  );
}

/** One-shot flag: the visitor has seen the "How this answer was found" trace. */
const HOWFOUND_SEEN_KEY = "slm_howfound_seen";

/**
 * Collapsed "How this answer was found" panel: a plain-language trace of the
 * governed path — search the approved library, ground in N sources, check
 * every citation. Honesty first: fallback answers say so instead.
 */
function HowFound({
  sourceCount,
  pillarNames,
  fallback,
}: {
  sourceCount: number;
  pillarNames: string[];
  fallback: boolean;
}) {
  // The very first governed answer a visitor ever completes auto-opens the
  // trace — it is the payoff of the whole surface. One-shot per browser.
  const [open, setOpen] = useState(() => {
    if (fallback) return false;
    try {
      if (localStorage.getItem(HOWFOUND_SEEN_KEY)) return false;
      localStorage.setItem(HOWFOUND_SEEN_KEY, "1");
      return true;
    } catch {
      return false;
    }
  });
  const steps: string[] = fallback
    ? [
        "We searched the faculty-approved research library, but it does not cover this topic yet.",
        "So this answer comes from the Stanford Lifestyle Medicine AI Lab instead, and is labeled that way.",
      ]
    : [
        "Your question was matched against the faculty-approved research library.",
        `The answer was built only from ${sourceCount === 1 ? "1 approved source" : `${sourceCount} approved sources`}${pillarNames.length > 0 ? ` in ${pillarNames.join(" and ")}` : ""} — nothing outside them.`,
        "Every citation was checked against those sources before the answer reached you.",
      ];
  return (
    <div style={{ marginTop: 12 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          border: "none",
          background: "transparent",
          padding: 0,
          fontFamily: SANS,
          fontSize: 11.5,
          fontWeight: 600,
          color: MUTED,
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
        }}
      >
        <span
          style={{
            fontSize: 9,
            transform: open ? "rotate(90deg)" : "none",
            transition: "transform .15s ease",
            display: "inline-block",
          }}
        >
          ▶
        </span>
        How this answer was found
      </button>
      {open && (
        <ol
          style={{
            margin: "8px 0 0",
            paddingLeft: 18,
            fontFamily: SANS,
            fontSize: 12.5,
            lineHeight: 1.6,
            color: MUTED,
          }}
        >
          {steps.map((s, i) => (
            <li key={i} style={{ marginBottom: 3 }}>
              {s}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

interface InlineFollowUpProps {
  value: string;
  suggestions: string[];
  disabled: boolean;
  onChange: (value: string) => void;
  onAsk: (question: string) => void;
}

function InlineFollowUp({
  value,
  suggestions,
  disabled,
  onChange,
  onAsk,
}: InlineFollowUpProps) {
  return (
    <section
      className="slm-inline-followup"
      aria-labelledby="slm-inline-followup-title"
    >
      <div
        style={{
          fontFamily: SANS,
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: ".15em",
          textTransform: "uppercase",
          color: CARDINAL,
        }}
      >
        Continue the conversation
      </div>
      <h2
        id="slm-inline-followup-title"
        style={{
          margin: "6px 0 5px",
          fontFamily: SERIF,
          fontSize: 18,
          fontWeight: 500,
          lineHeight: 1.25,
          color: INK,
        }}
      >
        What would you like to ask next?
      </h2>
      <p
        style={{
          margin: "0 0 12px",
          fontFamily: SANS,
          fontSize: 12.5,
          lineHeight: 1.5,
          color: MUTED,
        }}
      >
        Choose a direction or ask your own question. It will stay connected to
        this answer.
      </p>
      {suggestions.length > 0 && (
        <div
          aria-label="Suggested follow-up questions"
          style={{ display: "flex", flexWrap: "wrap", gap: 8 }}
        >
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="slm-chip"
              disabled={disabled}
              onClick={() => onAsk(suggestion)}
              style={{
                padding: "8px 12px",
                borderRadius: 999,
                border: `1px solid rgba(140,21,21,0.25)`,
                background: "transparent",
                fontFamily: SANS,
                fontSize: 12.5,
                lineHeight: 1.35,
                color: CARDINAL,
                cursor: disabled ? "default" : "pointer",
                textAlign: "left",
              }}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
      <form
        className="slm-inline-followup-entry"
        onSubmit={(event) => {
          event.preventDefault();
          onAsk(value);
        }}
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 10,
          marginTop: 12,
        }}
      >
        <textarea
          rows={1}
          value={value}
          disabled={disabled}
          aria-label="Ask a follow-up question"
          placeholder="Ask a follow-up…"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onAsk(value);
            }
          }}
          style={{
            flex: 1,
            minHeight: 43,
            maxHeight: 110,
            resize: "vertical",
            border: "none",
            borderBottom: `1px solid rgba(10,10,15,0.22)`,
            borderRadius: 0,
            outline: "none",
            background: "transparent",
            padding: "10px 2px",
            fontFamily: SANS,
            fontSize: 13,
            lineHeight: 1.45,
            color: INK,
          }}
        />
        <button
          type="submit"
          disabled={disabled || !value.trim()}
          style={{
            minHeight: 42,
            border: "none",
            borderRadius: 999,
            background:
              value.trim() && !disabled ? CARDINAL : "rgba(10,10,15,0.12)",
            color: "#fff",
            padding: "0 16px",
            fontFamily: SANS,
            fontSize: 13,
            fontWeight: 700,
            cursor: value.trim() && !disabled ? "pointer" : "default",
          }}
        >
          Ask
        </button>
      </form>
    </section>
  );
}

function AnswerSourcesRail({
  turn,
  stewards,
  focusedSlug,
  onContinueWith,
}: {
  turn: Extract<Turn, { role: "assistant" }>;
  stewards: Map<string, SlmSteward>;
  focusedSlug: string | null;
  onContinueWith: (s: SlmSteward) => void;
}) {
  const sourceCount = new Set(turn.provenance.map((entry) => entry.source_id))
    .size;

  return (
    <aside
      className="slm-sources-rail"
      aria-label="Answer sources and review trail"
    >
      <section className="slm-sources-panel">
        <div
          style={{
            padding: "17px 18px 14px",
            borderBottom: `1px solid ${RULE}`,
          }}
        >
          <div
            style={{
              fontFamily: SANS,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: ".15em",
              textTransform: "uppercase",
              color: CARDINAL,
            }}
          >
            Sources for this answer
          </div>
          <p
            style={{
              margin: "6px 0 0",
              fontFamily: SANS,
              fontSize: 12,
              lineHeight: 1.45,
              color: MUTED,
            }}
          >
            {sourceCount === 1
              ? "One approved source informed this response."
              : `${sourceCount} approved sources informed this response.`}
          </p>
        </div>
        <Sources entries={turn.provenance} rail />
        <div
          style={{ borderTop: `1px solid ${RULE}`, padding: "3px 18px 15px" }}
        >
          <HowFound
            sourceCount={sourceCount}
            pillarNames={turn.pillarNames}
            fallback={false}
          />
        </div>
        <div style={{ borderTop: `1px solid ${RULE}`, padding: "0 18px 17px" }}>
          <StewardStrip
            pillarNames={turn.pillarNames}
            provenance={turn.provenance}
            stewards={stewards}
            focusedSlug={focusedSlug}
            onContinueWith={onContinueWith}
          />
        </div>
      </section>
    </aside>
  );
}

function CompanionSuggestion({
  onStart,
  onDismiss,
}: {
  onStart: () => void;
  onDismiss: () => void;
}) {
  return (
    <aside
      className="slm-companion-suggestion"
      aria-label="Optional Lifestyle Medicine companion"
      data-testid="section-conversation-companion-suggestion"
      style={{
        alignItems: "center",
        borderTop: `1px solid ${RULE}`,
        display: "flex",
        flexWrap: "wrap",
        gap: "8px 12px",
        margin: "12px 0 0",
        maxWidth: 760,
        paddingTop: 12,
      }}
    >
      <span
        style={{
          color: CARDINAL,
          fontFamily: SANS,
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: ".12em",
          textTransform: "uppercase",
        }}
      >
        Optional
      </span>
      <p
        style={{
          color: MUTED,
          fontFamily: SANS,
          fontSize: 13,
          lineHeight: 1.45,
          margin: 0,
        }}
      >
        Would a Lifestyle Medicine companion help you keep exploring this?
      </p>
      <button
        type="button"
        onClick={onStart}
        data-testid="button-conversation-start-companion"
        style={{
          background: "transparent",
          border: 0,
          color: CARDINAL,
          cursor: "pointer",
          fontFamily: SANS,
          fontSize: 13,
          fontWeight: 700,
          padding: 0,
          textDecoration: "underline",
          textUnderlineOffset: 3,
        }}
      >
        Explore with a companion
      </button>
      <button
        type="button"
        onClick={onDismiss}
        data-testid="button-conversation-skip-companion"
        style={{
          background: "transparent",
          border: 0,
          color: MUTED,
          cursor: "pointer",
          fontFamily: SANS,
          fontSize: 12.5,
          padding: 0,
          textDecoration: "underline",
          textUnderlineOffset: 3,
        }}
      >
        Not now
      </button>
    </aside>
  );
}

/** One stored Q&A from GET /api/slm-agent/history (oldest first). */
interface HistoryEntry {
  question: string;
  answer: string;
  pillarNames: string[];
  askedAt: string | null;
}

/** Gap (ms) between questions that starts a new conversation group. */
const CONVERSATION_GAP_MS = 60 * 60 * 1000;

/**
 * Group flat history rows into conversations by time proximity: the server
 * stores individual Q&As, so a pause of an hour or more starts a new
 * conversation. Returns newest-first groups of oldest-first entries.
 */
function groupConversations(entries: HistoryEntry[]): HistoryEntry[][] {
  const groups: HistoryEntry[][] = [];
  let current: HistoryEntry[] = [];
  let prevTs: number | null = null;
  for (const e of entries) {
    const ts = e.askedAt ? Date.parse(e.askedAt) : NaN;
    if (Number.isNaN(ts)) {
      // No usable timestamp: isolate the row and reset the comparison
      // baseline — never lump it with neighbors on a stale prevTs.
      if (current.length > 0) groups.push(current);
      groups.push([e]);
      current = [];
      prevTs = null;
      continue;
    }
    if (
      current.length > 0 &&
      (prevTs === null || ts - prevTs > CONVERSATION_GAP_MS)
    ) {
      groups.push(current);
      current = [];
    }
    current.push(e);
    prevTs = ts;
  }
  if (current.length > 0) groups.push(current);
  return groups.reverse();
}

/** Convert stored history entries into renderable thread turns. */
function entriesToTurns(entries: HistoryEntry[]): Turn[] {
  const out: Turn[] = [];
  for (const t of entries) {
    if (!t.question || !t.answer) continue;
    out.push({ role: "user", text: t.question });
    const pa = parseAnswer(t.answer);
    // Defensive: unlabeled stored text should still render.
    if (!pa.answer && !pa.refused && !pa.uncovered) pa.answer = pa.raw;
    out.push({
      role: "assistant",
      status: "done",
      text: t.answer,
      parsed: pa,
      provenance: [],
      pillarNames: Array.isArray(t.pillarNames) ? t.pillarNames : [],
      fallbackSteward: null,
    });
  }
  return out;
}

function AssistantBubble({
  turn,
  stewards,
  focusedSlug,
  onContinueWith,
  listen,
  question,
  minicast,
  avatarBridge,
  visitorName,
  followUp,
}: {
  turn: Extract<Turn, { role: "assistant" }>;
  stewards: Map<string, SlmSteward>;
  focusedSlug: string | null;
  onContinueWith: (s: SlmSteward) => void;
  listen?: {
    active: boolean;
    loading: boolean;
    error: string | null;
    onToggle: () => void;
  };
  /** The reader question this answer responded to (for the avatar chat). */
  question?: string;
  /** Two-voice podcast episode of this answer (covered answers only). */
  minicast?: {
    onStart: () => void;
    stopRef: React.MutableRefObject<(() => void) | null>;
  };
  /** Bridge that routes the page's MAIN composer into an open avatar panel. */
  avatarBridge?: {
    ref: React.MutableRefObject<((q: string) => boolean) | null>;
    onCapture?: (firstName: string | null) => void;
  };
  /** Known browser-local or account name for the camera-off avatar handoff. */
  visitorName?: string | null;
  /** Inline continuation for the newest completed answer. */
  followUp?: InlineFollowUpProps;
}) {
  // Faculty avatar chat — opt-in per answer, opened from the steward strip.
  const [avatarOpen, setAvatarOpen] = useState(false);
  const label: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: ".18em",
    textTransform: "uppercase",
    color: RED,
    marginBottom: 5,
    fontFamily: SANS,
  };
  const bodyText: React.CSSProperties = {
    fontFamily: SERIF,
    fontSize: SLM_STANDALONE ? 17 : 16,
    lineHeight: SLM_STANDALONE ? "21px" : 1.65,
    color: INK,
    margin: 0,
  };

  if (turn.status === "streaming") {
    // Before the first token arrives, show WHO is being consulted and WHAT
    // is happening — a blank bubble is where the wonder dies. Focused mode
    // shows just the chosen steward; otherwise the faculty faces appear.
    if (!turn.text) {
      const faces = (
        focusedSlug
          ? [...stewards.values()].filter((s) => s.pillarSlug === focusedSlug)
          : [...stewards.values()]
      )
        .filter((s) => s.photoUrl)
        .slice(0, 5);
      return (
        <div style={{ maxWidth: "92%" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {faces.length > 0 && (
              <div style={{ display: "flex", flexShrink: 0 }}>
                {faces.map((s, i) => (
                  <img
                    key={s.pillarSlug}
                    src={stewardPhotoSrc(s)}
                    alt={s.stewardName}
                    width={30}
                    height={30}
                    style={{
                      borderRadius: "50%",
                      objectFit: "cover",
                      border: "2px solid #fff",
                      marginLeft: i === 0 ? 0 : -9,
                    }}
                  />
                ))}
              </div>
            )}
            <span
              className="slm-trace"
              style={{ fontFamily: SANS, fontSize: 13.5, color: MUTED }}
            >
              Checking the faculty-approved research library…
            </span>
          </div>
        </div>
      );
    }
    return (
      <div style={{ maxWidth: "92%" }}>
        <p style={{ ...bodyText, whiteSpace: "pre-wrap" }}>
          {turn.text.replace(
            /^(ANSWER|CITATION|PAPER|FINDING|INTERPRETATION):\s*/gm,
            "",
          )}
          <span className="slm-cursor" />
        </p>
      </div>
    );
  }
  if (turn.status === "error") {
    return (
      <div
        style={{
          background: CARD,
          border: `1px solid ${RULE}`,
          borderRadius: 16,
          padding: "14px 18px",
          fontFamily: SANS,
          fontSize: 14,
          color: MUTED,
          maxWidth: "92%",
        }}
      >
        {turn.text || "Something went wrong. Please try again."}
      </div>
    );
  }

  const p = turn.parsed;
  if (!p) return null;
  if (p.refused || p.uncovered) {
    return (
      <div
        style={{
          background: CARD,
          border: `1px solid ${RULE}`,
          borderRadius: 16,
          padding: "16px 20px",
          maxWidth: "92%",
        }}
      >
        <p style={{ ...bodyText, fontSize: SLM_STANDALONE ? 17 : 15.5 }}>
          {p.answer || turn.text}
        </p>
      </div>
    );
  }
  const showSourcesRail = turn.provenance.length > 0 && !turn.fallbackSteward;
  return (
    <div className="slm-answer-layout">
      <div
        className="slm-answer-card"
        style={{
          background: CARD,
          border: `1px solid ${RULE}`,
          borderRadius: 16,
          padding: "20px 22px",
          boxShadow: "0 1px 3px rgba(10,10,15,0.04)",
        }}
      >
        <p style={bodyText}>{p.answer}</p>
        {p.finding && (
          <div style={{ marginTop: 14 }}>
            <div style={label}>Key finding</div>
            <p style={{ ...bodyText, fontSize: SLM_STANDALONE ? 16.5 : 15 }}>
              {p.finding}
            </p>
          </div>
        )}
        {p.interpretation && (
          <div style={{ marginTop: 14 }}>
            <div style={label}>What this means</div>
            <p style={{ ...bodyText, fontSize: SLM_STANDALONE ? 16.5 : 15 }}>
              {p.interpretation}
            </p>
          </div>
        )}
        {listen && (
          <div
            style={{
              marginTop: 12,
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            {minicast &&
              turn.parsed &&
              !turn.parsed.refused &&
              !turn.parsed.uncovered && (
                <MinicastButton
                  question={question ?? ""}
                  sections={{
                    answer: turn.parsed.answer,
                    finding: turn.parsed.finding,
                    action: turn.parsed.interpretation,
                  }}
                  ready={
                    turn.status === "done" &&
                    !!(turn.parsed.answer || turn.parsed.finding)
                  }
                  pillar={turn.pillarNames[0]}
                  expert={
                    turn.pillarNames
                      .map((n) => stewards.get(n))
                      .find((s): s is SlmSteward => !!s)?.stewardName
                  }
                  onStart={minicast.onStart}
                  stopRef={minicast.stopRef}
                />
              )}
            <button
              onClick={listen.onToggle}
              aria-label={
                listen.active || listen.loading
                  ? "Stop reading this answer aloud"
                  : "Read this answer aloud"
              }
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                padding: "6px 14px",
                borderRadius: 999,
                border: `1px solid ${RULE}`,
                background: "rgba(255,255,255,0.75)",
                fontFamily: SANS,
                fontSize: 12.5,
                color: listen.active || listen.loading ? CARDINAL : MUTED,
                cursor: "pointer",
              }}
            >
              <span aria-hidden="true" style={{ fontSize: 11 }}>
                {listen.active || listen.loading ? "■" : "▶"}
              </span>
              {listen.loading
                ? "Preparing audio…"
                : listen.active
                  ? "Stop"
                  : "Listen"}
            </button>
            {listen.error && (
              <div
                role="status"
                style={{
                  marginTop: 6,
                  fontFamily: SANS,
                  fontSize: 12.5,
                  lineHeight: 1.45,
                  color: "#b91c1c",
                }}
              >
                {listen.error}
              </div>
            )}
          </div>
        )}
        {turn.fallbackSteward && (
          <div
            style={{
              marginTop: 12,
              fontFamily: SANS,
              fontSize: 12,
              color: MUTED,
            }}
          >
            Answered by {turn.fallbackSteward}
          </div>
        )}
        {!showSourcesRail && (
          <>
            <Sources entries={turn.provenance} />
            {(turn.provenance.length > 0 || turn.fallbackSteward) && (
              <HowFound
                sourceCount={
                  new Set(turn.provenance.map((e) => e.source_id)).size
                }
                pillarNames={turn.pillarNames}
                fallback={Boolean(turn.fallbackSteward)}
              />
            )}
            {/* Fallback answers are the AI Lab's, never a pillar steward's. */}
            {!turn.fallbackSteward && (
              <StewardStrip
                pillarNames={turn.pillarNames}
                provenance={turn.provenance}
                stewards={stewards}
                focusedSlug={focusedSlug}
                onContinueWith={onContinueWith}
              />
            )}
          </>
        )}
        {/* Faculty avatar chat: per-answer opt-in card with pill tabs to switch
          faculty and the face-to-face video call. Only on completed covered
          answers with a matched steward — fallback answers are the AI Lab's. */}
        {!SLM_STANDALONE &&
          !turn.fallbackSteward &&
          turn.status === "done" &&
          turn.parsed &&
          !turn.parsed.refused &&
          !turn.parsed.uncovered &&
          turn.pillarNames.some((n) => stewards.has(n)) && (
            <div style={{ marginTop: 12 }}>
              {avatarOpen ? (
                <div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "flex-end",
                      marginBottom: 6,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setAvatarOpen(false)}
                      style={{
                        border: "none",
                        background: "transparent",
                        fontFamily: SANS,
                        fontSize: 12,
                        color: MUTED,
                        cursor: "pointer",
                        padding: "4px 6px",
                      }}
                    >
                      ✕ Close avatar chat
                    </button>
                  </div>
                  <StewardChatPanel
                    stewards={turn.pillarNames
                      .map((n) => stewards.get(n))
                      .filter((s): s is SlmSteward => !!s)}
                    question={question ?? ""}
                    parsed={turn.parsed}
                    isFallback={false}
                    initialSuggestions={(turn.suggested ?? []).slice(0, 2)}
                    standalone
                    composerBridge={avatarBridge}
                    visitorName={visitorName}
                    hideAvatar={SLM_STANDALONE}
                  />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setAvatarOpen(true)}
                  className="slm-chip"
                  style={{
                    padding: "8px 16px",
                    borderRadius: 999,
                    border: `1px solid ${RULE}`,
                    background: "transparent",
                    fontFamily: SANS,
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: INK,
                    cursor: "pointer",
                  }}
                >
                  🎥 Talk with the faculty AI avatars
                </button>
              )}
            </div>
          )}
        {followUp && <InlineFollowUp {...followUp} />}
      </div>
      {showSourcesRail && (
        <AnswerSourcesRail
          turn={turn}
          stewards={stewards}
          focusedSlug={focusedSlug}
          onContinueWith={onContinueWith}
        />
      )}
    </div>
  );
}

export function ConsumerSignInCard({ onBack }: { onBack?: () => void }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const emailClean = email.trim();
    if (!emailClean || state === "sending") return;
    setState("sending");
    try {
      const res = await fetch(`${BASE}api/consumer/auth/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          email: emailClean,
          ...buildSlmAuthDestination(SLM_STANDALONE),
        }),
      });
      if (!res.ok) throw new Error("failed");
      setState("sent");
    } catch {
      setState("error");
    }
  }

  if (state === "sent") {
    return (
      <div style={cardShell} data-testid="card-consumer-signin-sent">
        <div style={cardTitle}>Check your email</div>
        <p style={{ ...cardBody, margin: 0 }}>
          We sent a secure sign-in link to{" "}
          <strong style={{ color: INK }}>{email.trim()}</strong>. Open it on
          this device to continue. The link expires in 30 minutes.
        </p>
        <div
          style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 16 }}
        >
          <button
            type="button"
            onClick={() => setState("idle")}
            style={{
              border: "none",
              background: "transparent",
              padding: 0,
              fontFamily: SANS,
              fontSize: 13,
              color: CARDINAL,
              textDecoration: "underline",
              cursor: "pointer",
            }}
          >
            Use another email
          </button>
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              style={{
                border: "none",
                background: "transparent",
                padding: 0,
                fontFamily: SANS,
                fontSize: 13,
                color: MUTED,
                cursor: "pointer",
              }}
            >
              Back
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={cardShell} data-testid="card-consumer-signin">
      <div style={cardTitle}>Sign in to continue</div>
      <p style={cardBody}>
        Use the email on your account. We will send you a secure link — no
        password needed.
      </p>
      <form
        onSubmit={submit}
        style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
      >
        <input
          type="email"
          required
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          aria-label="Email address"
          className="pill-field"
          style={fieldStyle}
        />
        <button
          type="submit"
          disabled={state === "sending"}
          style={{ ...primaryBtn, opacity: state === "sending" ? 0.6 : 1 }}
        >
          {state === "sending" ? "Sending…" : "Email me a sign-in link"}
        </button>
      </form>
      {state === "error" && (
        <p
          role="alert"
          style={{
            margin: "10px 0 0",
            fontFamily: SANS,
            fontSize: 13,
            color: RED,
          }}
        >
          Could not send the link. Please try again.
        </p>
      )}
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          style={{
            marginTop: 14,
            border: "none",
            background: "transparent",
            padding: 0,
            fontFamily: SANS,
            fontSize: 13,
            color: MUTED,
            cursor: "pointer",
          }}
        >
          Back
        </button>
      )}
    </div>
  );
}

// ── Onboarding card (name → email + newsletter, no payment) ────────────────

const cardShell: React.CSSProperties = {
  background: CARD,
  border: `1px solid ${RULE}`,
  borderRadius: 16,
  padding: "22px 24px",
  maxWidth: "92%",
  boxShadow: "0 1px 3px rgba(10,10,15,0.04)",
};

const cardTitle: React.CSSProperties = {
  fontFamily: SERIF,
  fontSize: 17,
  fontWeight: 600,
  color: INK,
  marginBottom: 6,
};

const cardBody: React.CSSProperties = {
  margin: "0 0 14px",
  fontFamily: SANS,
  fontSize: 14,
  lineHeight: 1.6,
  color: MUTED,
};

const fieldStyle: React.CSSProperties = {
  flex: "1 1 220px",
  padding: "12px 16px",
  borderRadius: 0,
  border: `1px solid ${RULE}`,
  fontFamily: SANS,
  fontSize: 15,
  outline: "none",
  background: PAPER,
  color: INK,
};

const primaryBtn: React.CSSProperties = {
  padding: "12px 22px",
  borderRadius: 12,
  border: "none",
  background: RED,
  color: "#fff",
  fontFamily: SANS,
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};

export function OnboardCard({
  onRegistered,
  initialName = "",
}: {
  /** Called when a provisional session was granted — chatting may continue. */
  onRegistered: (firstName: string) => void;
  /** A name offered in the standalone welcome, never an account field yet. */
  initialName?: string;
}) {
  // A pre-signup welcome name is only a convenient draft, never an account
  // identity. It has already been supplied by the visitor, though, so a
  // continued chat should ask for email rather than making them repeat it.
  const [step, setStep] = useState<"name" | "email" | "sent" | "error">(
    initialName.trim() ? "email" : "name",
  );
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [name, setName] = useState(initialName);
  const [email, setEmail] = useState("");
  // Unchecked by default: newsletter consent must be an active choice.
  const [newsletter, setNewsletter] = useState(false);
  const [busy, setBusy] = useState(false);
  const [signInMode, setSignInMode] = useState(false);

  function submitName(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim()) setStep("email");
  }

  async function submitEmail(e: React.FormEvent) {
    e.preventDefault();
    const emailClean = email.trim();
    const nameClean = name.trim();
    if (!emailClean || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`${BASE}api/consumer/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          email: emailClean,
          firstName: nameClean,
          newsletter,
          ...buildSlmAuthDestination(SLM_STANDALONE),
        }),
      });
      if (!res.ok) {
        // Surface the server's reason when it has one (e.g. the per-network
        // registration limit) instead of the generic retry copy.
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        setErrMsg(typeof d.error === "string" ? d.error : null);
        setStep("error");
        return;
      }
      const d = (await res.json()) as { provisional?: boolean };
      saveOnboard({ name: nameClean, email: emailClean, verifyPending: true });
      if (d.provisional) {
        // Brand-new account: a browser-session pass was granted — keep going.
        onRegistered(nameClean);
      } else {
        // Existing account: they must click the emailed link to continue.
        setStep("sent");
      }
    } catch {
      setStep("error");
    } finally {
      setBusy(false);
    }
  }

  if (signInMode) {
    return <ConsumerSignInCard onBack={() => setSignInMode(false)} />;
  }

  if (step === "sent") {
    return (
      <div style={cardShell}>
        <div style={cardTitle}>Check your email</div>
        <p style={{ ...cardBody, margin: 0 }}>
          This email already has an account, so we sent a sign-in link to{" "}
          <strong style={{ color: INK }}>{email.trim()}</strong>. Open it and
          your question will be answered right away. The link expires in 30
          minutes.
        </p>
      </div>
    );
  }

  if (step === "error") {
    return (
      <div style={cardShell}>
        <div style={cardTitle}>Something went wrong</div>
        <p style={{ ...cardBody, margin: "0 0 14px" }}>
          {errMsg ??
            "We could not finish setting up your account. Please try again."}
        </p>
        <button
          type="button"
          style={primaryBtn}
          onClick={() => setStep("email")}
        >
          Try again
        </button>
      </div>
    );
  }

  if (step === "name") {
    return (
      <div style={cardShell}>
        <div style={cardTitle}>
          {initialName.trim()
            ? "Before we continue, please confirm your first name."
            : "Happy to help. First, what is your first name?"}
        </div>
        <p style={cardBody}>
          Asking is free and unlimited. We just need to know who we are talking
          to.
        </p>
        <form
          onSubmit={submitName}
          style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
        >
          <input
            type="text"
            required
            autoFocus
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your first name"
            aria-label="Your first name"
            className="pill-field"
            style={fieldStyle}
          />
          <button type="submit" style={primaryBtn}>
            Continue
          </button>
        </form>
        <button
          type="button"
          onClick={() => setSignInMode(true)}
          style={{
            marginTop: 14,
            border: "none",
            background: "transparent",
            padding: 0,
            fontFamily: SANS,
            fontSize: 13,
            color: CARDINAL,
            textDecoration: "underline",
            cursor: "pointer",
          }}
        >
          Already have an account? Sign in
        </button>
      </div>
    );
  }

  return (
    <div style={cardShell}>
      <div style={cardTitle}>
        Nice to meet you, {firstNameOf(name) ?? name.trim()}. Where should we
        reach you?
      </div>
      <p style={cardBody}>
        Enter your email to create your free account. We will send a
        confirmation link, and you can keep chatting right away. No password, no
        payment.
      </p>
      <form
        onSubmit={submitEmail}
        style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
      >
        <input
          type="email"
          required
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="pill-field"
          style={fieldStyle}
        />
        <button
          type="submit"
          disabled={busy}
          style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }}
        >
          {busy ? "Setting up…" : "Create my account"}
        </button>
      </form>
      <button
        type="button"
        onClick={() => setSignInMode(true)}
        style={{
          marginTop: 14,
          border: "none",
          background: "transparent",
          padding: 0,
          fontFamily: SANS,
          fontSize: 13,
          color: CARDINAL,
          textDecoration: "underline",
          cursor: "pointer",
        }}
      >
        Already have an account? Sign in
      </button>
      <label
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 8,
          marginTop: 12,
          fontFamily: SANS,
          fontSize: 13,
          lineHeight: 1.5,
          color: MUTED,
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={newsletter}
          onChange={(e) => setNewsletter(e.target.checked)}
          style={{ marginTop: 2 }}
        />
        <span>
          Send me the Stanford Lifestyle Medicine newsletter. Evidence-based
          guidance from the faculty, free.
        </span>
      </label>
    </div>
  );
}

// ── Verify reminder (returning, unverified) ────────────────────────────────

export function VerifyReminderCard({
  email,
  name,
}: {
  email: string;
  name: string | null;
}) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );

  async function resend() {
    if (state === "sending") return;
    setState("sending");
    try {
      const res = await fetch(`${BASE}api/consumer/auth/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          ...buildSlmAuthDestination(SLM_STANDALONE),
        }),
      });
      if (!res.ok) throw new Error("failed");
      setState("sent");
    } catch {
      setState("error");
    }
  }

  return (
    <div
      style={{
        ...cardShell,
        margin: "0 auto",
        maxWidth: 480,
        textAlign: "left",
      }}
    >
      <div style={cardTitle}>Please confirm your email to continue</div>
      <p style={cardBody}>
        {warmReturnGreeting(name, i18n.language)} Before you can keep asking
        questions, please open the confirmation link we sent to{" "}
        <strong style={{ color: INK }}>{email}</strong>. Clicking it signs you
        in here right away.
      </p>
      <button
        type="button"
        onClick={() => void resend()}
        disabled={state === "sending"}
        style={{ ...primaryBtn, opacity: state === "sending" ? 0.6 : 1 }}
      >
        {state === "sending" ? "Sending…" : "Send a new link"}
      </button>
      {state === "sent" && (
        <p
          style={{
            margin: "10px 0 0",
            fontFamily: SANS,
            fontSize: 13,
            color: MUTED,
          }}
        >
          Sent. Check your inbox (and spam folder). The link expires in 30
          minutes.
        </p>
      )}
      {state === "error" && (
        <p
          style={{
            margin: "10px 0 0",
            fontFamily: SANS,
            fontSize: 13,
            color: RED,
          }}
        >
          Could not send the link. Please try again in a moment.
        </p>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export default function SlmChat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  // Standalone-only first impression: no account is created here. The name
  // stays browser-local until the visitor voluntarily starts registration.
  const [standaloneView, setStandaloneView] = useState<
    "welcome" | "faculty" | "coach"
  >(SLM_STANDALONE ? "welcome" : "faculty");
  const [showSignIn, setShowSignIn] = useState(false);
  const [visitorName, setVisitorName] = useState(() => readVisitorName());
  const [companionAlreadyChosen, setCompanionAlreadyChosen] = useState(() => {
    try {
      return (
        localStorage.getItem("slm_coach_companion_opt_in") === "true" ||
        Boolean(localStorage.getItem("slm_coach_reflection"))
      );
    } catch {
      return false;
    }
  });
  const [companionSuggestionShown, setCompanionSuggestionShown] =
    useState(false);
  const [companionSuggestionDismissed, setCompanionSuggestionDismissed] =
    useState(false);
  const [typedWelcomeDoneFor, setTypedWelcomeDoneFor] = useState<string | null>(
    null,
  );
  const [coachVideos, setCoachVideos] = useState<
    Partial<Record<SlmCoachLesson["id"], VerifiedCoachVideo>>
  >({});
  // Read-aloud: one shared audio controller; ttsTurn tracks which answer is
  // playing so only that bubble's button shows the stop state.
  const { speaking, ttsLoading, ttsError, stopAudio, playText } =
    useTtsController();
  const [ttsTurn, setTtsTurn] = useState<number | null>(null);
  // Stops an in-progress minicast episode (set by MinicastButton while
  // playing) — plain Listen and the minicast must never overlap.
  const minicastStopRef = useRef<(() => void) | null>(null);
  // While an avatar panel is open, the main composer sends INTO that chat
  // (the avatar answers). The open panel registers its send() here and
  // reports the active steward's first name for the composer placeholder.
  const avatarComposerRef = useRef<((q: string) => boolean) | null>(null);
  const [avatarCaptureName, setAvatarCaptureName] = useState<string | null>(
    null,
  );
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [firstName, setFirstName] = useState<string | null>(null);
  // True when the visitor was already signed in at page load — they get the
  // warm by-name return greeting even before their first saved conversation.
  const [returningVisitor, setReturningVisitor] = useState(false);
  // When set, the visitor registered earlier but never confirmed their email
  // and their provisional session is gone: chatting is blocked until they
  // click the emailed link (the server enforces this too).
  const [verifyLock, setVerifyLock] = useState<string | null>(null);
  // A provisional (registered-but-unverified) session may chat, but has no
  // account capabilities: the Account drawer explains instead of erroring.
  const [provisionalSession, setProvisionalSession] = useState(false);
  // Pillar name → lead steward (photo + name) for the attribution strip.
  const [stewardMap, setStewardMap] = useState<Map<string, SlmSteward>>(
    new Map(),
  );
  // Full fetched history (oldest first) and the "Past conversations" panel.
  const [pastEntries, setPastEntries] = useState<HistoryEntry[]>([]);
  // Brief cardinal shimmer on the three-dot history button when tapped.
  const [dotsGlow, setDotsGlow] = useState(false);
  const [showPast, setShowPast] = useState(false);
  // Account settings drawer: profile (name, email, member since) plus the
  // house-newsletter opt-in toggle.
  const [showAccount, setShowAccount] = useState(false);
  const [acctSettings, setAcctSettings] = useState<{
    email: string;
    displayName: string | null;
    memberSince: string | null;
    newsletterOptedIn: boolean;
  } | null>(null);
  const [acctNameDraft, setAcctNameDraft] = useState("");
  const [acctBusy, setAcctBusy] = useState(false);
  const [acctError, setAcctError] = useState<string | null>(null);
  const [acctNameSaved, setAcctNameSaved] = useState(false);
  // Two-step account deletion: first click reveals the confirm card.
  const [acctDeleteConfirming, setAcctDeleteConfirming] = useState(false);
  // "Keep talking with <steward>": subsequent questions focus on that
  // steward's pillar in conversational mode. Ref mirrors state so ask()
  // never reads a stale closure.
  const [focusSteward, setFocusStewardState] = useState<SlmSteward | null>(
    null,
  );
  // Choosing a faculty avatar is a visitor preference, separate from the
  // temporary retrieval focus used by a suggested question.
  const [selectedAvatar, setSelectedAvatar] = useState<SlmSteward | null>(null);
  const focusRef = useRef<SlmSteward | null>(null);
  const setFocusSteward = (s: SlmSteward | null) => {
    focusRef.current = s;
    setFocusStewardState(s);
  };
  const abortRef = useRef<AbortController | null>(null);
  // Bumped by "New conversation": a late history restore (fetch still in
  // flight during bootstrap) must never repopulate a thread the visitor
  // explicitly cleared.
  const conversationGenRef = useRef(0);
  // Session generation: bumped on registration/sign-out so in-flight session
  // bootstrap responses from the previous session are discarded.
  const sessionGenRef = useRef(0);
  const inFlightRef = useRef(false);
  // First taste is free: an unregistered visitor gets ONE full answer before
  // the sign-in card appears (the wow must land before the ask). The server
  // enforces its own anonymous allowance, so this is UX pacing, not security.
  const freeUsedRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Personal hero chips: every steward with a photo and a mapped topic is
  // invited by name — faces and names are the wow. Order is shuffled once
  // per visit and stays stable across re-renders.
  const heroStewards = useMemo(() => {
    const candidates = [...stewardMap.values()].filter(
      (s) => s.photoUrl && STEWARD_CHIP_TOPICS[s.pillarSlug],
    );
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    return candidates.slice(0, 3);
  }, [stewardMap]);
  const avatarChoices = useMemo(
    () =>
      [...stewardMap.values()]
        .filter((steward) => steward.photoUrl)
        .sort((a, b) => a.pillarName.localeCompare(b.pillarName)),
    [stewardMap],
  );
  useEffect(() => {
    document.title = "Stanford Lifestyle Medicine";
    const prevBg = document.body.style.background;
    document.body.style.background = PAPER;
    return () => {
      document.body.style.background = prevBg;
    };
  }, []);

  // Bootstrap: consume a ?login= magic-link token if present (standalone
  // domain links land here), then resolve the session, then restore any
  // question that was held while the visitor registered.
  useEffect(() => {
    (async () => {
      const params = new URLSearchParams(window.location.search);
      const token = params.get("login");
      if (token) {
        try {
          await fetch(
            `${BASE}api/consumer/auth/consume?token=${encodeURIComponent(token)}`,
            { credentials: "include" },
          );
        } catch {
          /* fall through to the /me check */
        }
        params.delete("login");
        const qs = params.toString();
        window.history.replaceState(
          null,
          "",
          window.location.pathname + (qs ? `?${qs}` : ""),
        );
      }
      let isAuthed = false;
      // Session boundary: registration (or sign-out) while /me is in flight
      // bumps the generation — a stale pre-registration response must never
      // overwrite the new session's state (it would setAuthed(false) and
      // verify-lock a user whose provisional session is perfectly valid).
      const sessionGenAtFetch = sessionGenRef.current;
      try {
        const me = await fetch(`${BASE}api/consumer/me`, {
          credentials: "include",
          cache: "no-store",
        });
        const d = (await me.json()) as {
          authenticated?: boolean;
          displayName?: string | null;
          emailVerified?: boolean;
          provisional?: boolean;
        };
        if (sessionGenRef.current !== sessionGenAtFetch) return;
        isAuthed = d.authenticated === true;
        if (isAuthed) {
          // Already signed in when the page loaded → a returning visitor
          // (fresh registrations in this visit go through onRegistered
          // instead), so the hero greets them warmly by name.
          setReturningVisitor(true);
          setProvisionalSession(d.provisional === true);
          setFirstName(greetingNameOf(d.displayName));
          // Verified: onboarding is complete for good.
          if (d.emailVerified) clearOnboard();
          if (d.emailVerified) {
            clearVisitorName();
            setVisitorName("");
          }
          setShowSignIn(false);
        } else {
          setProvisionalSession(false);
        }
      } catch {
        /* treated as signed out */
      }
      if (sessionGenRef.current !== sessionGenAtFetch) return;
      setAuthed(isAuthed);
      if (SLM_STANDALONE && isAuthed) {
        // A returning account should not be sent back through the welcome
        // choice on every visit. Remember the last signed-in work surface,
        // while keeping brand-new signed-out visitors on the welcome screen.
        setStandaloneView(companionAlreadyChosen ? "coach" : "faculty");
      }

      // Steward photos for the attribution strip under answers. Cosmetic:
      // failures just leave the strip off.
      void fetch(`${BASE}api/slm-agent/stewards`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { stewards?: SlmSteward[] } | null) => {
          if (Array.isArray(d?.stewards)) {
            setStewardMap(new Map(d.stewards.map((s) => [s.pillarName, s])));
          }
        })
        .catch(() => {});

      // Returning visitor who registered but never confirmed their email and
      // whose provisional session has expired with the browser: block until
      // the emailed link is clicked. (Server enforces the same rule.)
      if (!isAuthed) {
        const ob = readOnboard();
        if (ob?.verifyPending) {
          setFirstName(firstNameOf(ob.name));
          setVerifyLock(ob.email);
          return;
        }
      }

      // Signed in: returning visitors get a CLEAN slate — every saved
      // conversation (including the most recent) lives behind the three-dot
      // history button instead of being restored into the thread. Guard the
      // drawer contents on the SESSION generation (sign-out/registration),
      // not the conversation generation: pressing "New conversation" while
      // the fetch is in flight must not empty the history drawer.
      const sessionGenAtHistory = sessionGenRef.current;
      if (isAuthed) {
        try {
          const h = await fetch(`${BASE}api/slm-agent/history`, {
            credentials: "include",
          });
          if (h.ok) {
            const d = (await h.json()) as {
              turns?: Array<{
                question: string;
                answer: string;
                pillarNames?: string[];
                askedAt?: string;
              }>;
            };
            const entries: HistoryEntry[] = (d.turns ?? [])
              .filter((t) => t.question && t.answer)
              .map((t) => ({
                question: t.question,
                answer: t.answer,
                pillarNames: Array.isArray(t.pillarNames) ? t.pillarNames : [],
                askedAt: typeof t.askedAt === "string" ? t.askedAt : null,
              }));
            // Account boundary: a sign-out while this fetch was in flight
            // bumps the session generation — a late response must never
            // (re)populate another account's Past conversations.
            if (sessionGenRef.current === sessionGenAtHistory) {
              setPastEntries(entries);
            }
          }
        } catch {
          /* history is a convenience; start fresh on failure */
        }
      }
      const pending = isAuthed ? takePending() : null;
      const urlQ = params.get("q");
      if (urlQ) {
        // Consume the link once: strip ?q= so a reload doesn't re-ask.
        params.delete("q");
        const qs = params.toString();
        window.history.replaceState(
          null,
          "",
          window.location.pathname + (qs ? `?${qs}` : ""),
        );
      }
      if (isAuthed && pending) {
        void ask(pending, true, []);
      } else if (urlQ) {
        // Shared/bookmarked question links auto-ask (the gate still applies).
        if (isAuthed) {
          void ask(urlQ, true, []);
        } else {
          // Unregistered visitors get their first answer free too — the
          // shared link should deliver the wow, not a sign-up form. If the
          // server's anonymous allowance is exhausted it returns 401 and
          // ask() holds the question behind the sign-in card as before.
          freeUsedRef.current = true;
          void ask(urlQ, true, []);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A video is never inferred. Coach cards may only show an explicitly
  // lesson-designated Video resource through the public coach-video API.
  useEffect(() => {
    if (!SLM_STANDALONE || standaloneView !== "coach") return;
    let cancelled = false;
    type CoachVideo = { lessonId?: unknown; title?: unknown; url?: unknown };
    void Promise.all(
      [...new Set(SLM_COACH_LESSONS.map((lesson) => lesson.pillarSlug))].map(
        async (slug) => {
          try {
            const response = await fetch(
              `${BASE}api/pillars/${slug}/coach-videos`,
            );
            if (!response.ok) return [slug, []] as const;
            const data = (await response.json()) as { videos?: CoachVideo[] };
            return [slug, data.videos ?? []] as const;
          } catch {
            return [slug, []] as const;
          }
        },
      ),
    ).then((rows) => {
      if (cancelled) return;
      const next: Partial<Record<SlmCoachLesson["id"], VerifiedCoachVideo>> =
        {};
      for (const [slug, videos] of rows) {
        for (const video of videos) {
          const lesson = SLM_COACH_LESSONS.find(
            (candidate) =>
              candidate.id === video.lessonId && candidate.pillarSlug === slug,
          );
          if (
            lesson &&
            typeof video.title === "string" &&
            typeof video.url === "string"
          ) {
            next[lesson.id] = { title: video.title, url: video.url };
          }
        }
      }
      setCoachVideos(next);
    });
    return () => {
      cancelled = true;
    };
  }, [standaloneView]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [turns]);

  function historyForApi(): Array<{
    role: "user" | "assistant";
    content: string;
  }> {
    const h: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (const t of turns) {
      if (t.role === "user") h.push({ role: "user", content: t.text });
      else if (
        t.role === "assistant" &&
        t.status === "done" &&
        t.parsed?.answer
      ) {
        h.push({ role: "assistant", content: t.parsed.answer });
      }
    }
    return h.slice(-8);
  }

  async function ask(
    q: string,
    knownAuthed = false,
    // Conversation context restored from the server that may not be in the
    // `turns` state yet (bootstrap auto-ask runs before React commits it).
    priorHistory: Array<{ role: "user" | "assistant"; content: string }> = [],
  ) {
    const question = q.trim();
    if (!question || streaming || verifyLock) return;
    if (companionSuggestionShown) {
      setCompanionSuggestionDismissed(true);
    }

    // An avatar panel is open: the entry belongs to that conversation — the
    // faculty avatar answers it there. Closing the panel restores normal
    // main-thread questions.
    if (avatarComposerRef.current) {
      // Only clear the composer if the panel actually accepted the question
      // (it rejects while its own reply is still streaming) — never lose
      // what the visitor typed.
      if (avatarComposerRef.current(question)) {
        setInput("");
        if (inputRef.current) inputRef.current.style.height = "auto";
      }
      return;
    }

    // Registration gate (client-side fast path; the server enforces too).
    // The very first question is free — the visitor sees one full answer
    // with citations and faces before any email ask. From question two on,
    // replace any previously held question so the transcript always matches
    // the single question that will be asked after sign-in.
    if (!knownAuthed && authed === false && !freeUsedRef.current) {
      freeUsedRef.current = true;
    } else if (!knownAuthed && authed === false) {
      savePending(question);
      setTurns((t) => {
        const kept = [...t];
        while (
          kept.length > 0 &&
          (kept[kept.length - 1].role === "signin" ||
            kept[kept.length - 1].role === "user")
        ) {
          kept.pop();
        }
        return [...kept, { role: "user", text: question }, { role: "signin" }];
      });
      setInput("");
      return;
    }

    // Synchronous in-flight guard: two rapid submits can both pass the
    // `streaming` state check before React re-renders.
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    // Conversation generation at launch: if the visitor opens a past
    // conversation or presses "New conversation" mid-stream, every state
    // update from this request must become a no-op (abort alone can lose the
    // race with an in-flight SSE chunk or the finally block).
    const genAtAsk = conversationGenRef.current;

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    const history = [...priorHistory, ...historyForApi()].slice(-8);
    setTurns((t) => [
      ...t.filter((x) => x.role !== "signin"),
      { role: "user", text: question },
      {
        role: "assistant",
        status: "streaming",
        text: "",
        parsed: null,
        provenance: [],
        pillarNames: [],
        fallbackSteward: null,
      },
    ]);
    setInput("");
    setStreaming(true);

    const updateLast = (
      patch: Partial<Extract<Turn, { role: "assistant" }>>,
    ) => {
      if (conversationGenRef.current !== genAtAsk) return;
      setTurns((t) => {
        const copy = [...t];
        for (let i = copy.length - 1; i >= 0; i--) {
          const turn = copy[i];
          if (turn.role === "assistant") {
            copy[i] = { ...turn, ...patch };
            break;
          }
        }
        return copy;
      });
    };

    // True when the visitor has since started a new conversation or opened a
    // past one: EVERY state update derived from this request must be dropped.
    const stale = () => conversationGenRef.current !== genAtAsk;

    try {
      const res = await fetch(`${BASE}api/slm-agent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Sec-Fetch-Site": "same-origin",
        },
        credentials: "include",
        body: JSON.stringify({
          message: question,
          history,
          lang: i18n.language?.slice(0, 2) || "en",
          standalone: true,
          // Focused mode narrows RETRIEVAL to the chosen steward's pillar
          // only. Deliberately NOT chat:true — chat replies drop the
          // CITATION: label the citation guard enforces on, so they would
          // bypass it. The labeled governed format keeps every guarantee.
          ...(focusRef.current
            ? { pillarSlugs: [focusRef.current.pillarSlug] }
            : {}),
        }),
        signal: ac.signal,
      });

      // Async boundary: the response may arrive after a generation change —
      // a stale 401 must NOT flip auth state, drop turns of, or inject the
      // sign-in card into, a conversation that is no longer ours.
      if (stale()) return;

      if (res.status === 401) {
        // Server says: register first. Hold the question, show the card.
        // Use savePending so the stored value matches the {q, ts} JSON shape
        // readPending expects — a raw string would be dropped after login.
        savePending(question);
        // Drop the optimistic user turn too — handleRegistered re-asks the
        // pending question, which would otherwise show it twice.
        setTurns((t) => {
          const copy = [...t];
          for (let i = copy.length - 1; i >= 0; i--) {
            if (copy[i].role === "user") {
              copy.splice(i, 1);
              break;
            }
          }
          return copy;
        });
        setAuthed(false);
        // If they registered before but never confirmed, the only way forward
        // is the emailed link — show the reminder, not the onboarding.
        const ob = readOnboard();
        if (ob?.verifyPending) {
          setVerifyLock(ob.email);
          setStreaming(false);
          return;
        }
        setTurns((t) => [
          ...t.filter(
            (x) => !(x.role === "assistant" && x.status === "streaming"),
          ),
          { role: "signin" },
        ]);
        setStreaming(false);
        return;
      }
      if (!res.ok || !res.body) {
        const d = await res.json().catch(() => ({}));
        if (stale()) return;
        updateLast({
          status: "error",
          text:
            (d as { error?: string }).error ??
            "Something went wrong. Please try again.",
        });
        setStreaming(false);
        return;
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let acc = "";

      while (true) {
        const { done, value } = await reader.read();
        // Async boundary: a late SSE chunk (including the final `done` event)
        // from a superseded request must never mirror into Past
        // conversations or clear the NEW request's streaming state.
        if (stale()) return;
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;
          let evt: Record<string, unknown>;
          try {
            evt = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (typeof evt.content === "string") {
            acc += evt.content;
            updateLast({ text: acc });
          }
          if (evt.done) {
            if (typeof evt.correction === "string" && evt.correction) {
              acc = evt.correction;
            }
            // Focused (chat-mode) replies are plain conversational text with
            // no ANSWER:/FINDING: labels — fall back to the raw text so the
            // bubble never renders empty.
            const pa = parseAnswer(acc);
            if (!pa.answer && !pa.refused && !pa.uncovered) pa.answer = pa.raw;
            // Mirror what the server stores (covered answers only) into the
            // local history so "Past conversations" reflects this session
            // without a reload.
            if (!evt.slmFallback && !pa.refused && !pa.uncovered) {
              const entryPillars = Array.isArray(evt.pillarNames)
                ? (evt.pillarNames as string[])
                : [];
              setPastEntries((p) => [
                ...p,
                {
                  question,
                  answer: acc,
                  pillarNames: entryPillars,
                  askedAt: new Date().toISOString(),
                },
              ]);
            }
            updateLast({
              status: "done",
              text: acc,
              parsed: pa,
              provenance: Array.isArray(evt.provenance)
                ? (evt.provenance as ProvenanceEntry[])
                : [],
              pillarNames: Array.isArray(evt.pillarNames)
                ? (evt.pillarNames as string[])
                : [],
              fallbackSteward: evt.slmFallback
                ? typeof evt.stewardName === "string" && evt.stewardName
                  ? evt.stewardName
                  : "Stanford Lifestyle Medicine AI Lab"
                : null,
              // Follow-up chips — server omits the field on fallback,
              // refused, uncovered, and corrected answers.
              suggested:
                !evt.slmFallback && Array.isArray(evt.suggestedQuestions)
                  ? (evt.suggestedQuestions as unknown[])
                      .filter((s): s is string => typeof s === "string")
                      .slice(0, 2)
                  : [],
            });
            setStreaming(false);
          }
          if (typeof evt.error === "string") {
            updateLast({ status: "error", text: evt.error });
            setStreaming(false);
          }
        }
      }
    } catch (e) {
      if ((e as { name?: string }).name !== "AbortError") {
        updateLast({
          status: "error",
          text: "Something went wrong. Please try again.",
        });
      }
    } finally {
      // ONLY the still-active generation may touch shared request-control
      // state. "New conversation" / opening a past one bumps the generation,
      // resets these fields itself, and may let a NEW request start before
      // this (aborted) request's finally runs — an unconditional reset here
      // would clear the new request's in-flight guard and allow concurrent
      // streams writing to the same last assistant turn.
      if (conversationGenRef.current === genAtAsk) {
        inFlightRef.current = false;
        setStreaming(false);
        // Never leave a turn stuck in "streaming" (e.g. aborted mid-stream).
        setTurns((t) =>
          t.map((x) =>
            x.role === "assistant" && x.status === "streaming"
              ? {
                  ...x,
                  status: "error" as const,
                  text: x.text || "Interrupted. Please ask again.",
                }
              : x,
          ),
        );
      }
    }
  }

  // The input's placeholder offers a REAL follow-up question from the latest
  // answer: pressing Enter with an empty box asks it, clicking into the box
  // dismisses it so the visitor can type their own. Dismissal is keyed to the
  // suggestion text, so the next answer's suggestion appears fresh.
  const [placeholderDismissedFor, setPlaceholderDismissedFor] = useState<
    string | null
  >(null);
  const lastTurnForSuggest = turns[turns.length - 1];
  const suggestedNext =
    !streaming &&
    !verifyLock &&
    lastTurnForSuggest &&
    lastTurnForSuggest.role === "assistant" &&
    lastTurnForSuggest.status === "done" &&
    (lastTurnForSuggest.suggested?.length ?? 0) > 0
      ? lastTurnForSuggest.suggested![0]
      : null;
  const placeholderSuggestion =
    suggestedNext && placeholderDismissedFor !== suggestedNext
      ? suggestedNext
      : null;
  useEffect(() => {
    if (
      !SLM_STANDALONE ||
      companionAlreadyChosen ||
      companionSuggestionDismissed ||
      companionSuggestionShown
    ) {
      return;
    }
    const latestTurn = turns[turns.length - 1];
    if (
      !latestTurn ||
      latestTurn.role !== "assistant" ||
      latestTurn.status !== "done" ||
      latestTurn.fallbackSteward ||
      !latestTurn.text.trim()
    ) {
      return;
    }
    const precedingQuestion = [...turns]
      .slice(0, -1)
      .reverse()
      .find(
        (turn): turn is Extract<Turn, { role: "user" }> => turn.role === "user",
      )?.text;
    if (
      precedingQuestion &&
      COMPANION_CONVERSATION_CUE.test(precedingQuestion)
    ) {
      setCompanionSuggestionShown(true);
    }
  }, [
    companionAlreadyChosen,
    companionSuggestionDismissed,
    companionSuggestionShown,
    turns,
  ]);
  const isWelcomeNameCapture =
    SLM_STANDALONE &&
    standaloneView === "welcome" &&
    authed === false &&
    !showSignIn &&
    !(firstName ?? visitorName);
  const isLoggedInWelcome =
    SLM_STANDALONE && standaloneView === "welcome" && authed === true;
  const welcomeGreetingText = showSignIn
    ? "Welcome back."
    : isWelcomeNameCapture
      ? WELCOME_NAME_PROMPT
      : isLoggedInWelcome
        ? firstName
          ? `The day got better. Welcome back, ${firstName}.`
          : "The day got better. Welcome back."
        : null;
  const isWelcomeGreetingTyping =
    !showSignIn &&
    isLoggedInWelcome &&
    typedWelcomeDoneFor !== welcomeGreetingText;

  // Textarea placeholders wrap and clip on phones, and browsers don't
  // reliably honor `::placeholder { white-space: nowrap }` on textareas —
  // so long suggestions are hard-truncated to one visual line. Enter still
  // asks the FULL suggestion; only the display is shortened.
  const [narrowScreen, setNarrowScreen] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 480,
  );
  useEffect(() => {
    const onResize = () => setNarrowScreen(window.innerWidth < 480);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  function fitPlaceholder(s: string): string {
    const cap = narrowScreen ? 38 : 72;
    return s.length > cap ? `${s.slice(0, cap - 1).trimEnd()}…` : s;
  }

  function submitComposer() {
    if (isWelcomeNameCapture) {
      const clean = firstNameOf(input);
      if (!clean) return;
      saveVisitorName(clean);
      setVisitorName(clean);
      setInput("");
      if (inputRef.current) inputRef.current.style.height = "auto";
      return;
    }
    if (!input.trim() && placeholderSuggestion) {
      void ask(placeholderSuggestion);
      return;
    }
    void ask(input);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    submitComposer();
  }

  /**
   * Start a clean slate without signing out: clears the on-screen thread and
   * the context sent with the next question. Past questions stay saved in
   * the visitor's account history on the server — this only resets the page.
   */
  function newConversation() {
    conversationGenRef.current += 1;
    abortRef.current?.abort();
    inFlightRef.current = false;
    setStreaming(false);
    setTurns([]);
    setInput("");
    setFocusSteward(null);
    setCompanionSuggestionShown(false);
    setCompanionSuggestionDismissed(false);
    // A clear conversation returns to the familiar faculty composer. The
    // coach is always available from the welcome choice, while an in-progress
    // faculty question is never hidden behind a view change.
    if (SLM_STANDALONE) setStandaloneView("faculty");
    inputRef.current?.focus();
  }

  // Friendly copy for a session that can chat but has no account access yet.
  const VERIFY_FIRST_MSG =
    "Please confirm your email first. We sent you a sign-in link — click it, then open Account again.";

  async function openAccount() {
    setShowAccount(true);
    // Never show a previous session's cached settings while loading.
    setAcctSettings(null);
    setAcctError(null);
    setAcctNameSaved(false);
    setAcctDeleteConfirming(false);
    // A provisional session has no account capabilities by design: explain
    // instead of firing a request that will 401.
    if (provisionalSession) {
      setAcctError(VERIFY_FIRST_MSG);
      return;
    }
    // Account boundary: if the user signs out (or a new conversation
    // generation starts) while this request is in flight, drop the response.
    const gen = conversationGenRef.current;
    try {
      const res = await fetch(`${BASE}api/account/settings`, {
        credentials: "include",
      });
      if (gen !== conversationGenRef.current) return;
      if (res.status === 401) {
        // Session is provisional or expired server-side: guide, don't error.
        setAcctError(VERIFY_FIRST_MSG);
        return;
      }
      if (!res.ok) throw new Error("load failed");
      const data = (await res.json()) as {
        email: string;
        displayName: string | null;
        memberSince: string | null;
        newsletterOptedIn: boolean;
      };
      setAcctSettings(data);
      setAcctNameDraft(data.displayName ?? "");
    } catch {
      setAcctError("Could not load your settings. Please try again.");
    }
  }

  async function saveAccountName() {
    if (!acctSettings) return;
    setAcctBusy(true);
    setAcctError(null);
    try {
      const res = await fetch(`${BASE}api/account/name`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ displayName: acctNameDraft }),
      });
      if (!res.ok) throw new Error("save failed");
      const data = (await res.json()) as { displayName: string | null };
      setAcctSettings({ ...acctSettings, displayName: data.displayName });
      setFirstName(data.displayName ? data.displayName.split(/\s+/)[0] : null);
      setAcctNameSaved(true);
    } catch {
      setAcctError("Could not save your name. Please try again.");
    } finally {
      setAcctBusy(false);
    }
  }

  async function toggleNewsletter(optIn: boolean) {
    if (!acctSettings) return;
    setAcctBusy(true);
    setAcctError(null);
    try {
      const res = await fetch(`${BASE}api/account/newsletter`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ optIn }),
      });
      if (!res.ok) throw new Error("toggle failed");
      setAcctSettings({ ...acctSettings, newsletterOptedIn: optIn });
    } catch {
      setAcctError(
        "Could not update your newsletter preference. Please try again.",
      );
    } finally {
      setAcctBusy(false);
    }
  }

  async function deleteAccount() {
    setAcctBusy(true);
    setAcctError(null);
    try {
      const res = await fetch(`${BASE}api/consumer/delete-account`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ confirm: "DELETE" }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setAcctError(
          body?.error ?? "Could not delete your account. Please try again.",
        );
        return;
      }
      // The server already cleared the cookie and anonymized the data —
      // reset the page exactly like a sign-out (which also wipes drawer PII).
      await signOut();
    } catch {
      setAcctError("Could not delete your account. Please try again.");
    } finally {
      setAcctBusy(false);
      setAcctDeleteConfirming(false);
    }
  }

  async function signOut() {
    // Invalidate any in-flight /me bootstrap BEFORE awaiting the logout
    // request: a pre-sign-out response must never restore authed/provisional
    // state after the cookie is cleared.
    sessionGenRef.current += 1;
    try {
      await fetch(`${BASE}api/consumer/auth/logout`, {
        method: "POST",
        credentials: "include",
      });
    } catch {
      /* cookie clear is best-effort; state reset below regardless */
    }
    clearOnboard();
    // Account boundary: everything belonging to the signed-out account must
    // go — including the locally mirrored history — and any in-flight
    // request or late history response must not repopulate it for the next
    // visitor on this device (cross-account privacy).
    conversationGenRef.current += 1;
    abortRef.current?.abort();
    inFlightRef.current = false;
    setStreaming(false);
    setAuthed(false);
    setProvisionalSession(false);
    setFirstName(null);
    clearVisitorName();
    setVisitorName("");
    if (SLM_STANDALONE) {
      setStandaloneView("welcome");
      setShowSignIn(false);
    }
    setVerifyLock(null);
    setFocusSteward(null);
    setTurns([]);
    setPastEntries([]);
    setShowPast(false);
    // Account boundary: drawer state carries PII (email, name, member date)
    // and must never survive into the next visitor's session.
    setShowAccount(false);
    setAcctSettings(null);
    setAcctNameDraft("");
    setAcctError(null);
    setAcctNameSaved(false);
    setAcctBusy(false);
    setAcctDeleteConfirming(false);
  }

  /**
   * A brand-new account just registered and received a provisional session:
   * greet them by name, note the verification email, and answer the held
   * question right away.
   */
  function handleRegistered(nameClean: string) {
    // Invalidate any in-flight pre-registration /me bootstrap: its stale
    // "signed out" result must not clobber this brand-new session.
    sessionGenRef.current += 1;
    const first = firstNameOf(nameClean) ?? nameClean;
    // The browser-only welcome name is no longer needed once the visitor has
    // chosen to create an account. From this point the server account name is
    // the source of truth for greetings.
    clearVisitorName();
    setVisitorName("");
    setFirstName(first);
    setAuthed(true);
    setShowSignIn(false);
    setProvisionalSession(true);
    setTurns((t) => [
      ...t.filter((x) => x.role !== "signin"),
      {
        role: "notice",
        text: `Nice to meet you, ${first}. We emailed you a confirmation link. Please click it when you get a moment. You can keep asking questions in the meantime.`,
      },
    ]);
    const pending = takePending();
    if (pending) void ask(pending, true);
  }

  function continueFromWelcome(view: "faculty" | "coach") {
    const clean = firstNameOf(firstName ?? visitorName);
    if (!clean) return;
    if (!firstName) {
      saveVisitorName(clean);
      setVisitorName(clean);
    }
    setStandaloneView(view);
    if (view === "faculty") {
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }

  function openCompanionFromConversation() {
    try {
      localStorage.setItem("slm_coach_companion_opt_in", "true");
    } catch {
      // Private browsing can block localStorage; the current session still works.
    }
    setCompanionAlreadyChosen(true);
    setCompanionSuggestionDismissed(true);
    setStandaloneView("coach");
  }

  function askFromCoach(lesson: SlmCoachLesson) {
    const matchingSteward = [...stewardMap.values()].find(
      (steward) => steward.pillarSlug === lesson.pillarSlug,
    );
    // Set the ref synchronously before ask() builds its retrieval request.
    setFocusSteward(matchingSteward ?? null);
    setStandaloneView("faculty");
    void ask(lesson.relatedQuestion);
  }

  const empty = turns.length === 0;
  const isInitialQuestionEntry =
    SLM_STANDALONE && standaloneView === "faculty" && empty;
  const lastTurn = turns[turns.length - 1];
  // A completed governed answer owns the single follow-up composer inside its
  // card. Keep the fixed composer for the landing state, streaming/error
  // states, and fallback answers, but do not show two equivalent inputs after
  // a normal answer.
  const inlineFollowUpVisible =
    lastTurn?.role === "assistant" &&
    lastTurn.status === "done" &&
    !lastTurn.fallbackSteward &&
    Boolean(lastTurn.parsed) &&
    !lastTurn.parsed?.refused &&
    !lastTurn.parsed?.uncovered &&
    !verifyLock;
  const pastGroups = useMemo(
    () => groupConversations(pastEntries),
    [pastEntries],
  );

  /** Load a past conversation into the thread (replaces what's on screen). */
  function openConversation(group: HistoryEntry[]) {
    conversationGenRef.current += 1;
    abortRef.current?.abort();
    inFlightRef.current = false;
    setStreaming(false);
    setFocusSteward(null);
    setTurns(entriesToTurns(group));
    setShowPast(false);
  }

  return (
    <main
      className="slm-page"
      style={{
        background: PAPER,
        height: "100dvh",
        display: "flex",
        flexDirection: "column",
        fontFamily: SANS,
        ...(SLM_STANDALONE
          ? {
              // Keep the Stanford page's typography optically tuned: the
              // default body leading is intentionally close to the 2–4 pt
              // guidance, while display styles below can tighten themselves.
              lineHeight: 1.35,
              letterSpacing: "0.01em",
              fontKerning: "normal",
              fontOpticalSizing: "auto",
              textRendering: "optimizeLegibility",
            }
          : {}),
      }}
    >
      <style>{`
        .slm-page button { border-radius: 0 !important; }
        .slm-header-action:hover { background: #741010 !important; border-color: #741010 !important; }
        .slm-chip { transition: background .15s ease, border-color .15s ease; }
        .slm-name-input {
          flex: 1;
          background: transparent;
          border: none;
          border-bottom: none;
          border-radius: 0;
          padding: 10px 0;
          font-family: 'Source Sans 3', sans-serif;
          font-size: 30px;
          font-weight: 400;
          color: #0A0A0F;
          outline: none;
          transition: border-color 0.2s ease;
        }
        .slm-name-input:focus {
          border: none;
          border-bottom: none;
        }
        .slm-name-input:focus-visible {
          outline: none !important;
          outline-offset: 0 !important;
          box-shadow: none !important;
          background: rgba(10,10,15,0.04);
        }
        .slm-name-form {
          width: 100%;
        }
        .slm-main-entry:focus-within {
          border: none !important;
          box-shadow: none !important;
          background: rgba(10,10,15,0.04) !important;
        }

        .slm-thread-inner { width:100%; }
        .slm-assistant-turn { width:100%; }
        .slm-answer-layout {
          display:grid;
           grid-template-columns:minmax(0, 1fr) 340px;
          align-items:start;
          justify-content:space-between;
           gap:clamp(28px, 3.5vw, 52px);
           width:min(calc(100vw - 64px), 1440px);
           max-width:none;
           margin-left:0;
           margin-right:0;
        }
        .slm-answer-card { min-width:0; }
         .slm-sources-rail { position:sticky; top:16px; min-width:0; justify-self:end; width:100%; }
        .slm-sources-panel {
          overflow:hidden;
          border:1px solid ${RULE};
          border-radius:18px;
          background:${CARD};
          box-shadow:0 8px 32px rgba(10,10,15,0.04);
        }
        .slm-inline-followup {
          margin-top:20px;
          padding-top:17px;
          border-top:1px solid ${RULE};
        }
        .slm-inline-followup-entry:focus-within textarea {
          border-bottom-color:rgba(140,21,21,0.65) !important;
        }
        @media (min-width: 981px) {
           .slm-answer-card { padding:32px 40px !important; }
           .slm-user-turn { padding-right:calc(340px + clamp(28px, 3.5vw, 52px)); }
          .slm-assistant-turn > :not(.slm-answer-layout) { max-width:760px !important; }
        }
         @media (min-width: 981px) and (max-width: 1150px) {
           .slm-answer-layout { grid-template-columns:minmax(0, 1fr) 300px; gap:24px; }
           .slm-answer-card { padding:28px 32px !important; }
           .slm-user-turn { padding-right:304px; }
         }
        @media (max-width: 980px) {
          .slm-thread-inner { max-width:760px !important; }
           .slm-answer-layout { display:block; width:100%; }
          .slm-sources-rail { position:static; margin-top:14px; }
          .slm-sources-panel { border-radius:16px; }
        }
        .slm-trace { animation: slmTracePulse 1.6s ease-in-out infinite; }
        @keyframes slmTracePulse { 0%,100% {opacity:.55;} 50% {opacity:1;} }
        .slm-drawer-backdrop { animation: slmFadeIn .2s ease both; }
        @keyframes slmFadeIn { from {opacity:0;} to {opacity:1;} }
        .slm-drawer { animation: slmSlideIn .26s cubic-bezier(.32,.72,.28,1) both; }
        @keyframes slmSlideIn { from {transform:translateX(-100%);} to {transform:translateX(0);} }
        .slm-dots-btn { transition: color .15s ease, border-color .15s ease; }
        .slm-dots-btn:hover { border-color: rgba(140,21,21,0.45) !important; color:#8C1515 !important; }
        .slm-dots-btn.glow { animation: slmDotShimmer .9s ease; }
        @keyframes slmDotShimmer {
          0% { color:#8C1515; border-color: rgba(140,21,21,0.6); box-shadow: 0 0 0 0 rgba(140,21,21,0.45); }
          50% { color:#8C1515; border-color: rgba(140,21,21,0.9); box-shadow: 0 0 12px 3px rgba(140,21,21,0.35); }
          100% { box-shadow: 0 0 0 0 rgba(140,21,21,0); }
        }
        @media (prefers-reduced-motion: reduce) { .slm-dots-btn.glow { animation: none; } }
        .slm-past-card { transition: border-color .15s ease, background .15s ease, transform .15s ease; }
        .slm-past-card:hover { border-color: rgba(140,21,21,0.45) !important; background:#fff !important; transform: translateX(2px); }
        @media (prefers-reduced-motion: reduce) {
          .slm-drawer, .slm-drawer-backdrop { animation: none; }
        }
        .slm-chip:hover { background:#fff; border-color: rgba(10,10,15,0.25) !important; transform:translateY(-1px); }
        .slm-chip { transition: background .15s ease, border-color .15s ease, transform .15s ease; }
        .slm-chip-copy { display:flex; flex-direction:column; align-items:flex-start; text-align:left; gap:2px; }
        .slm-chip-meta { color:${MUTED}; font-size:11.5px; }
        .slm-chips { display:flex; flex-wrap:wrap; gap:10px; justify-content:center; }
         .slm-welcome-options { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; max-width:680px; margin:0 auto; }
         .slm-welcome-option { appearance:none; display:flex; min-height:178px; flex-direction:column; align-items:flex-start; justify-content:space-between; border:1px solid #8c1515; border-radius:18px; background:#8c1515; color:#fff; cursor:pointer; padding:22px; text-align:left; font-family:${SANS}; transition:background .18s ease,border-color .18s ease,box-shadow .18s ease,transform .18s ease; }
         .slm-welcome-option:hover { border-color:#741010; background:#741010; box-shadow:0 10px 24px rgba(10,10,15,.08); transform:translateY(-2px); }
         .slm-welcome-option:first-child { background:#8c1515; border-color:#8c1515; color:#fff; }
         .slm-welcome-option:first-child:hover { background:#741010; border-color:#741010; }
         .slm-welcome-option-kicker { color:#f4c7c1; font-size:10px; font-weight:800; letter-spacing:.16em; text-transform:uppercase; }
         .slm-welcome-option:first-child .slm-welcome-option-kicker { color:#f4c7c1; }
          .slm-welcome-option strong { display:block; font-family:${SANS}; font-size:26px; font-weight:${SLM_STANDALONE ? 700 : 500}; line-height:1; letter-spacing:${SLM_STANDALONE ? "0.01em" : "normal"}; }
          .slm-welcome-option-description { display:block; color:rgba(255,255,255,.8); font-size:${SLM_STANDALONE ? 14 : 13}px; line-height:${SLM_STANDALONE ? "21px" : 1.45}; letter-spacing:${SLM_STANDALONE ? "0.01em" : "normal"}; margin-top:8px; max-width:250px; }
         .slm-welcome-option:first-child .slm-welcome-option-description { color:rgba(255,255,255,.8); }
         .slm-welcome-option-link { align-items:center; display:flex; color:#fff; font-size:12px; font-weight:800; gap:7px; }
         .slm-welcome-option:first-child .slm-welcome-option-link { color:#fff; }
         .slm-welcome-option-link span { font-size:17px; line-height:1; transition:transform .18s ease; }
         .slm-welcome-option:hover .slm-welcome-option-link span { transform:translateX(3px); }
         .slm-welcome-option:focus-visible { outline:3px solid #d29a27; outline-offset:3px; }
        @media (prefers-reduced-motion: reduce) {
            .slm-welcome-option, .slm-welcome-option-link span { transition:none; }
        }
        .slm-hero { padding-top: 10vh; }
        .slm-sub { display:block; }
        .slm-chip-short { display:none; }
        .slm-foot-short { display:none; }
        @media (max-width: 560px) {
          /* One idea per row on phones: a tidy, tappable list — never awkward
             two-line pill wraps. Phones get the calm version: short one-line
             chips, no helper label, one-line footer. */
          .slm-chips { flex-direction:column; align-items:stretch; max-width:340px; margin:0 auto; }
          .slm-chips .slm-chip { text-align:left; }
          .slm-hero { padding-top: 6vh; }
          .slm-welcome { padding-top:32px !important; }
          .slm-welcome > div:first-child { display:flex !important; flex-direction:column; align-items:stretch !important; }
          .slm-name-form { max-width:100% !important; }
          .slm-name-form > button { width:60px !important; height:60px !important; }
          .slm-name-input { font-size:22px; min-width:0; }
          .slm-main-entry > button { width:60px !important; height:60px !important; }
          .slm-main-entry textarea { font-size:22px !important; min-width:0; }
           .slm-welcome-options { grid-template-columns:1fr; }
           .slm-welcome-option { min-height:148px; padding:20px; }
            .slm-welcome-option strong { font-size:23px; }
          .slm-standalone-free-question { margin: 8px auto 22px !important; }
          .slm-sub { display:none; }
           .slm-standalone-sub { display:block; margin-bottom:22px !important; line-height:21px !important; }
          .slm-example-label { display:none; }
          .slm-chip-full { display:none; }
          .slm-chip-short { display:inline; }
          .slm-foot-full { display:none; }
          .slm-foot-short { display:block; }
          .slm-partner { display:none !important; }
          /* Phones: just the logo up top — no header buttons. */
          .slm-head-actions { display:none !important; }
        }
        /* Focus indicator lives on the rounded pill, not the inner textarea:
           the global a11y :focus-visible ring would draw a rectangle inside
           the pill (browsers treat any focus on text fields as
           focus-visible, even mouse clicks). Suppressing it here is fine for
           WCAG 2.4.7 because the pill itself shows a clearly visible ring. */
        .slm-input:focus-within {
          border: none !important;
          box-shadow: none !important;
          background: transparent !important;
        }
        textarea.slm-ta { resize:none; border:none; outline:none; background:transparent; }
        /* Long rotating suggestions wrap into a second line that a 1-row
           textarea clips on phones — keep the placeholder to one tidy line. */
        textarea.slm-ta::placeholder { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .slm-input textarea.slm-ta:focus-visible {
          outline: none !important;
          outline-offset: 0 !important;
          box-shadow: none !important;
        }
      `}</style>

      {/* Header */}
      <header
        style={{
          padding: "16px clamp(20px, 4vw, 40px)",
          display: "flex",
          alignItems: "center",
          borderBottom: `1px solid ${RULE}`,
          flexShrink: 0,
        }}
      >
        <a
          href="https://lifestylemedicine.stanford.edu"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Stanford Lifestyle Medicine website"
          style={{ display: "block", lineHeight: 0 }}
        >
          <img
            src={LOGO_SRC}
            alt="Stanford Lifestyle Medicine"
            style={{
              height: SLM_STANDALONE ? "clamp(64px, 5.5vw, 78px)" : 32,
              width: "auto",
              display: "block",
            }}
          />
        </a>
        {/* History lives OUTSIDE .slm-head-actions so phones (which hide the
            header buttons) still get an entry point to past conversations. */}
        {authed && pastGroups.length > 0 && !verifyLock && (
          <button
            type="button"
            aria-label="Past conversations"
            title="Past conversations"
            aria-expanded={showPast}
            aria-controls="slm-past-drawer"
            className={`slm-dots-btn${dotsGlow ? " glow" : ""}`}
            onClick={() => {
              setDotsGlow(true);
              window.setTimeout(() => setDotsGlow(false), 900);
              setShowPast(true);
            }}
            data-testid="button-past-conversations"
            style={{
              marginLeft: "auto",
              border: `1px solid ${RULE}`,
              background: "transparent",
              borderRadius: 0,
              width: 30,
              height: 30,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: SANS,
              fontSize: 16,
              lineHeight: 1,
              color: INK,
              cursor: "pointer",
              padding: 0,
              flexShrink: 0,
            }}
          >
            ⋯
          </button>
        )}
        {authed && (
          <span
            className="slm-head-actions"
            style={{
              marginLeft: pastGroups.length > 0 && !verifyLock ? 12 : "auto",
              display: "flex",
              alignItems: "center",
              gap: 12,
              fontFamily: SANS,
              fontSize: SLM_STANDALONE ? 15 : 13.5,
              lineHeight: SLM_STANDALONE ? "21px" : undefined,
              color: MUTED,
            }}
          >
            <span>
              {firstName ? (
                <>
                  Signed in as{" "}
                  <strong style={{ color: INK, fontWeight: 600 }}>
                    {firstName}
                  </strong>
                </>
              ) : (
                "Signed in"
              )}
            </span>
            {!empty && !verifyLock && (
              <button
                type="button"
                onClick={newConversation}
                style={{
                  border: `1px solid ${RULE}`,
                  background: "transparent",
                  borderRadius: 0,
                  padding: "5px 14px",
                  fontFamily: SANS,
                  fontSize: 12.5,
                  color: INK,
                  cursor: "pointer",
                }}
              >
                New conversation
              </button>
            )}
            {!verifyLock && (
              <button
                type="button"
                onClick={() => void openAccount()}
                style={{
                  border: `1px solid ${RULE}`,
                  background: "transparent",
                  borderRadius: 0,
                  padding: "5px 14px",
                  fontFamily: SANS,
                  fontSize: 12.5,
                  color: INK,
                  cursor: "pointer",
                }}
              >
                Account
              </button>
            )}
            <button
              type="button"
              onClick={() => void signOut()}
              style={{
                border: `1px solid ${RULE}`,
                background: "transparent",
                borderRadius: 0,
                padding: "5px 14px",
                fontFamily: SANS,
                fontSize: 12.5,
                color: INK,
                cursor: "pointer",
              }}
            >
              Sign out
            </button>
          </span>
        )}
        {/* Keep regular reader sign-in separate from the faculty portal. Do
            not show either while the returning-session check is unresolved. */}
        {authed === false && (
          <span
            className="slm-head-actions"
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: 16,
            }}
          >
            {SLM_STANDALONE && (
              <button
                type="button"
                className="slm-header-action"
                data-testid="button-header-consumer-signin"
                onClick={() => {
                  setStandaloneView("welcome");
                  setShowSignIn(true);
                }}
                style={{
                  fontFamily: SANS,
                  fontSize: 18,
                  fontWeight: 400,
                  lineHeight: 1.15,
                  color: "#fff",
                  background: CARDINAL,
                  border: `1px solid ${CARDINAL}`,
                  borderRadius: 0,
                  padding: "10px 22px",
                  minWidth: 120,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  textAlign: "center",
                  boxSizing: "border-box",
                  whiteSpace: "nowrap",
                  cursor: "pointer",
                }}
              >
                Sign in
              </button>
            )}
            <a
              className="slm-header-action"
              href={
                // In the dev preview (and any non-production host) the faculty
                // portal lives on the SAME host at /faculty; only the real
                // standalone domain needs the cross-domain jump to palonur.com.
                typeof window !== "undefined" &&
                /(^|\.)asklifestylemedicine\.com$/.test(
                  window.location.hostname,
                )
                  ? "https://palonur.com/faculty/?aslm=1"
                  : "/faculty/?aslm=1"
              }
              style={{
                fontFamily: SANS,
                fontSize: 18,
                fontWeight: 400,
                lineHeight: 1.15,
                color: "#fff",
                textDecoration: "none",
                background: CARDINAL,
                border: `1px solid ${CARDINAL}`,
                borderRadius: 0,
                padding: "10px 22px",
                minWidth: 150,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                textAlign: "center",
                boxSizing: "border-box",
                whiteSpace: "nowrap",
              }}
            >
              Faculty login
            </a>
          </span>
        )}
      </header>

      {/* Past conversations panel */}
      {showPast && (
        <div
          role="dialog"
          aria-label="Past conversations"
          onClick={() => setShowPast(false)}
          className="slm-drawer-backdrop"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(10,10,15,0.32)",
            zIndex: 40,
            display: "flex",
            justifyContent: "flex-start",
          }}
        >
          <div
            id="slm-past-drawer"
            onClick={(e) => e.stopPropagation()}
            className="slm-drawer"
            style={{
              width: "min(400px, 92vw)",
              height: "100%",
              background: PAPER,
              borderRight: `1px solid ${RULE}`,
              boxShadow: "8px 0 32px rgba(10,10,15,0.14)",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                padding: "20px 20px 14px",
                borderBottom: `1px solid ${RULE}`,
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
              }}
            >
              <div>
                <span
                  style={{
                    fontFamily: SERIF,
                    fontSize: 18,
                    fontWeight: 600,
                    color: INK,
                  }}
                >
                  Past conversations
                </span>
                <div
                  style={{
                    marginTop: 3,
                    fontFamily: SANS,
                    fontSize: 12.5,
                    color: MUTED,
                  }}
                >
                  Pick one to continue where you left off
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowPast(false)}
                aria-label="Close"
                style={{
                  border: "none",
                  background: "transparent",
                  fontSize: 20,
                  color: MUTED,
                  cursor: "pointer",
                  lineHeight: 1,
                  padding: 4,
                }}
              >
                ×
              </button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "10px 12px" }}>
              {pastGroups.map((g, i) => {
                const first = g[0];
                const parsedWhen = first.askedAt
                  ? new Date(first.askedAt)
                  : null;
                const when =
                  parsedWhen && !Number.isNaN(parsedWhen.getTime())
                    ? parsedWhen
                    : null;
                return (
                  <button
                    key={i}
                    type="button"
                    className="slm-past-card"
                    onClick={() => openConversation(g)}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      background: CARD,
                      border: `1px solid ${RULE}`,
                      borderRadius: 12,
                      padding: "12px 14px",
                      marginBottom: 8,
                      cursor: "pointer",
                      fontFamily: SANS,
                    }}
                  >
                    <div
                      className="slm-name-form"
                      style={{
                        fontSize: 13.5,
                        fontWeight: 600,
                        color: INK,
                        lineHeight: 1.4,
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {first.question}
                    </div>
                    <div style={{ marginTop: 4, fontSize: 11.5, color: MUTED }}>
                      {when
                        ? when.toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })
                        : ""}
                      {when ? " · " : ""}
                      {g.length === 1 ? "1 question" : `${g.length} questions`}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Account settings drawer */}
      {showAccount && (
        <div
          role="dialog"
          aria-label="Account settings"
          onClick={() => setShowAccount(false)}
          className="slm-drawer-backdrop"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(10,10,15,0.32)",
            zIndex: 40,
            display: "flex",
            justifyContent: "flex-start",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="slm-drawer"
            style={{
              width: "min(400px, 92vw)",
              height: "100%",
              background: PAPER,
              borderRight: `1px solid ${RULE}`,
              boxShadow: "8px 0 32px rgba(10,10,15,0.14)",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                padding: "20px 20px 14px",
                borderBottom: `1px solid ${RULE}`,
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
              }}
            >
              <div>
                <span
                  style={{
                    fontFamily: SERIF,
                    fontSize: 18,
                    fontWeight: 600,
                    color: INK,
                  }}
                >
                  Account
                </span>
                <div
                  style={{
                    marginTop: 3,
                    fontFamily: SANS,
                    fontSize: 12.5,
                    color: MUTED,
                  }}
                >
                  Your details and preferences
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowAccount(false)}
                aria-label="Close"
                style={{
                  border: "none",
                  background: "transparent",
                  fontSize: 20,
                  color: MUTED,
                  cursor: "pointer",
                  lineHeight: 1,
                  padding: 4,
                }}
              >
                ×
              </button>
            </div>
            <div
              style={{
                flex: 1,
                overflowY: "auto",
                padding: "18px 20px",
                fontFamily: SANS,
              }}
            >
              {acctError && (
                <div
                  style={{
                    marginBottom: 14,
                    padding: "10px 12px",
                    borderRadius: 10,
                    background: "rgba(140,21,21,0.07)",
                    border: `1px solid rgba(140,21,21,0.25)`,
                    fontSize: 13,
                    color: CARDINAL,
                  }}
                >
                  {acctError}
                </div>
              )}
              {!acctSettings && !acctError && (
                <div style={{ fontSize: 13.5, color: MUTED }}>Loading…</div>
              )}
              {acctSettings && (
                <>
                  <label
                    style={{
                      display: "block",
                      fontSize: 12,
                      fontWeight: 600,
                      color: MUTED,
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      marginBottom: 6,
                    }}
                  >
                    Name
                  </label>
                  <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                    <input
                      type="text"
                      value={acctNameDraft}
                      onChange={(e) => {
                        setAcctNameDraft(e.target.value);
                        setAcctNameSaved(false);
                      }}
                      maxLength={80}
                      placeholder="Your name"
                      style={{
                        flex: 1,
                        fontFamily: SANS,
                        fontSize: 14.5,
                        color: INK,
                        background: CARD,
                        border: `1px solid ${RULE}`,
                        borderRadius: 10,
                        padding: "9px 12px",
                        outline: "none",
                      }}
                    />
                    <button
                      type="button"
                      disabled={
                        acctBusy ||
                        acctNameDraft.trim() ===
                          (acctSettings.displayName ?? "")
                      }
                      onClick={() => void saveAccountName()}
                      style={{
                        border: "none",
                        borderRadius: 10,
                        padding: "9px 16px",
                        fontFamily: SANS,
                        fontSize: 13.5,
                        fontWeight: 600,
                        color: "#fff",
                        background:
                          acctBusy ||
                          acctNameDraft.trim() ===
                            (acctSettings.displayName ?? "")
                            ? "rgba(10,10,15,0.25)"
                            : CARDINAL,
                        cursor: "pointer",
                      }}
                    >
                      Save
                    </button>
                  </div>
                  {acctNameSaved && (
                    <div
                      style={{
                        fontSize: 12.5,
                        color: "#2e7d32",
                        marginBottom: 6,
                      }}
                    >
                      Saved
                    </div>
                  )}

                  <div style={{ height: 18 }} />
                  <label
                    style={{
                      display: "block",
                      fontSize: 12,
                      fontWeight: 600,
                      color: MUTED,
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      marginBottom: 6,
                    }}
                  >
                    Email
                  </label>
                  <div style={{ fontSize: 14.5, color: INK }}>
                    {acctSettings.email}
                  </div>

                  <div style={{ height: 18 }} />
                  <label
                    style={{
                      display: "block",
                      fontSize: 12,
                      fontWeight: 600,
                      color: MUTED,
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      marginBottom: 6,
                    }}
                  >
                    Member since
                  </label>
                  <div style={{ fontSize: 14.5, color: INK }}>
                    {acctSettings.memberSince
                      ? new Date(acctSettings.memberSince).toLocaleDateString(
                          undefined,
                          {
                            month: "long",
                            day: "numeric",
                            year: "numeric",
                          },
                        )
                      : "—"}
                  </div>

                  <div
                    style={{
                      margin: "22px 0 0",
                      padding: "14px 14px",
                      borderRadius: 12,
                      background: CARD,
                      border: `1px solid ${RULE}`,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <div>
                      <div
                        style={{ fontSize: 14, fontWeight: 600, color: INK }}
                      >
                        Newsletter
                      </div>
                      <div
                        style={{
                          marginTop: 2,
                          fontSize: 12.5,
                          color: MUTED,
                          lineHeight: 1.5,
                        }}
                      >
                        Occasional evidence-based updates from the Stanford
                        Lifestyle Medicine faculty.
                      </div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={acctSettings.newsletterOptedIn}
                      disabled={acctBusy}
                      onClick={() =>
                        void toggleNewsletter(!acctSettings.newsletterOptedIn)
                      }
                      style={{
                        flexShrink: 0,
                        width: 46,
                        height: 26,
                        borderRadius: 999,
                        border: "none",
                        cursor: "pointer",
                        position: "relative",
                        background: acctSettings.newsletterOptedIn
                          ? CARDINAL
                          : "rgba(10,10,15,0.18)",
                        transition: "background .18s ease",
                      }}
                    >
                      <span
                        style={{
                          position: "absolute",
                          top: 3,
                          left: acctSettings.newsletterOptedIn ? 23 : 3,
                          width: 20,
                          height: 20,
                          borderRadius: "50%",
                          background: "#fff",
                          transition: "left .18s ease",
                        }}
                      />
                    </button>
                  </div>

                  {/* Danger zone: delete account (two-step confirm) */}
                  <div
                    style={{
                      marginTop: 26,
                      paddingTop: 18,
                      borderTop: `1px solid ${RULE}`,
                    }}
                  >
                    {!acctDeleteConfirming ? (
                      <button
                        type="button"
                        onClick={() => setAcctDeleteConfirming(true)}
                        style={{
                          border: "none",
                          background: "transparent",
                          padding: 0,
                          fontFamily: SANS,
                          fontSize: 13,
                          color: MUTED,
                          textDecoration: "underline",
                          cursor: "pointer",
                        }}
                      >
                        Delete my account
                      </button>
                    ) : (
                      <div
                        style={{
                          padding: "16px 16px",
                          borderRadius: 12,
                          background: "rgba(140,21,21,0.05)",
                          border: `1px solid rgba(140,21,21,0.25)`,
                        }}
                      >
                        <blockquote
                          style={{
                            margin: "0 0 10px",
                            fontFamily: SERIF,
                            fontSize: 15,
                            fontStyle: "italic",
                            lineHeight: 1.55,
                            color: INK,
                          }}
                        >
                          "I will not say: do not weep; for not all tears are an
                          evil."
                        </blockquote>
                        <div
                          style={{
                            fontSize: 12.5,
                            color: MUTED,
                            marginBottom: 12,
                          }}
                        >
                          J.R.R. Tolkien, Oxford professor
                        </div>
                        <div
                          style={{
                            fontSize: 13,
                            color: INK,
                            lineHeight: 1.55,
                            marginBottom: 14,
                          }}
                        >
                          This deletes your account and personal data for good.
                          Your conversations will no longer be linked to you,
                          and this cannot be undone. We will send one last email
                          confirming it is done.
                        </div>
                        <div style={{ display: "flex", gap: 8 }}>
                          <button
                            type="button"
                            disabled={acctBusy}
                            onClick={() => void deleteAccount()}
                            style={{
                              border: "none",
                              borderRadius: 10,
                              padding: "9px 16px",
                              fontFamily: SANS,
                              fontSize: 13.5,
                              fontWeight: 600,
                              color: "#fff",
                              background: acctBusy
                                ? "rgba(10,10,15,0.25)"
                                : CARDINAL,
                              cursor: "pointer",
                            }}
                          >
                            {acctBusy ? "Deleting…" : "Yes, delete everything"}
                          </button>
                          <button
                            type="button"
                            disabled={acctBusy}
                            onClick={() => setAcctDeleteConfirming(false)}
                            style={{
                              border: `1px solid ${RULE}`,
                              borderRadius: 10,
                              padding: "9px 16px",
                              fontFamily: SANS,
                              fontSize: 13.5,
                              color: INK,
                              background: "transparent",
                              cursor: "pointer",
                            }}
                          >
                            Keep my account
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Thread */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        <div
          className="slm-thread-inner"
          style={{
            maxWidth: 1480,
            margin: "0 auto",
            padding: "clamp(24px, 4vh, 48px) clamp(16px, 4vw, 32px) 24px",
          }}
        >
          {SLM_STANDALONE && authed === null ? (
            <div
              role="status"
              data-testid="status-restoring-session"
              style={{
                minHeight: "calc(100dvh - 340px)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: SANS,
                fontSize: 14,
                color: MUTED,
              }}
            >
              Opening your space…
            </div>
          ) : verifyLock ? (
            <div
              className="slm-hero"
              style={{ display: "flex", justifyContent: "center" }}
            >
              <VerifyReminderCard email={verifyLock} name={firstName} />
            </div>
          ) : SLM_STANDALONE && standaloneView === "coach" ? (
            <SlmCoach
              visitorName={firstName ?? visitorName}
              stewards={[...stewardMap.values()].map((steward) => ({
                pillarSlug: steward.pillarSlug,
                name: steward.stewardName,
                pillarName: steward.pillarName,
                photoUrl: steward.photoUrl,
              }))}
              lessons={SLM_COACH_LESSONS}
              videos={coachVideos}
              openCompanion={companionAlreadyChosen}
              onAskLesson={askFromCoach}
              onBackToFaculty={() => setStandaloneView("faculty")}
            />
          ) : SLM_STANDALONE && showSignIn && !empty ? (
            <section
              className="slm-welcome"
              aria-label="Sign in"
              style={{
                boxSizing: "border-box",
                maxWidth: 640,
                minHeight: "calc(100dvh - 340px)",
                margin: "0 auto",
                padding: "clamp(36px, 7vh, 84px) clamp(16px, 4vw, 32px)",
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
              }}
            >
              <h1
                style={{
                  margin: "0 0 28px",
                  fontFamily: SANS,
                  fontSize: "clamp(34px, 4vw, 48px)",
                  fontWeight: 400,
                  lineHeight: 1.05,
                  color: INK,
                }}
              >
                Welcome back.
              </h1>
              <ConsumerSignInCard onBack={() => setShowSignIn(false)} />
            </section>
          ) : empty ? (
            SLM_STANDALONE && standaloneView === "welcome" ? (
              <section
                className="slm-welcome"
                aria-labelledby="slm-welcome-title"
                data-testid="section-slm-welcome"
                style={{
                  boxSizing: "border-box",
                  maxWidth: 840,
                  minHeight: "calc(100dvh - 340px)",
                  margin: "0 auto",
                  padding: "clamp(36px, 7vh, 84px) clamp(16px, 4vw, 32px)",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center",
                  alignItems: isWelcomeNameCapture ? "flex-start" : "center",
                }}
              >
                <div
                  style={{
                    maxWidth: 840,
                    width: "100%",
                    margin: "0 auto",
                    textAlign: isWelcomeNameCapture ? "left" : "center",
                  }}
                >
                  {isWelcomeNameCapture ? (
                    <StructuredTypewriterGreeting
                      parts={WELCOME_NAME_PARTS}
                      onComplete={() =>
                        setTypedWelcomeDoneFor(WELCOME_NAME_PROMPT)
                      }
                    />
                  ) : (
                    <h1
                      id="slm-welcome-title"
                      style={{
                        margin: 0,
                        fontFamily: SANS,
                        fontSize: "clamp(25px, 3.1vw, 38px)",
                        fontWeight: 400,
                        lineHeight: 1,
                        letterSpacing: "0.01em",
                        textTransform: "uppercase",
                        color: INK,
                      }}
                    >
                      {welcomeGreetingText ? (
                        <TypewriterGreeting
                          text={welcomeGreetingText}
                          onComplete={() =>
                            setTypedWelcomeDoneFor(welcomeGreetingText)
                          }
                        />
                      ) : (
                        `Nice to meet you, ${firstName ?? visitorName}.`
                      )}
                    </h1>
                  )}

                  {!showSignIn && isWelcomeNameCapture && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        submitComposer();
                      }}
                      style={{
                        marginTop: 48,
                        opacity:
                          typedWelcomeDoneFor === WELCOME_NAME_PROMPT ? 1 : 0,
                        transition: "opacity 0.6s ease",
                        pointerEvents:
                          typedWelcomeDoneFor === WELCOME_NAME_PROMPT
                            ? "auto"
                            : "none",
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        width: "100%",
                        maxWidth: 800,
                      }}
                    >
                      <input
                        type="text"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        placeholder="I would love to get to know you. What's your name?"
                        aria-label="Your first name"
                        className="slm-name-input"
                        autoFocus
                      />
                      <button
                        type="submit"
                        disabled={!input.trim()}
                        style={{
                          background: input.trim()
                            ? CARDINAL
                            : "rgba(10,10,15,0.06)",
                          color: input.trim() ? "#fff" : "rgba(10,10,15,0.3)",
                          border: "none",
                          borderRadius: "50%",
                          width: 88,
                          height: 88,
                          padding: 0,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          cursor: input.trim() ? "pointer" : "default",
                          transition: "background 0.2s ease, color 0.2s ease",
                          flexShrink: 0,
                        }}
                        aria-label="Continue with your name"
                      >
                        <svg
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <polyline points="9 18 15 12 9 6"></polyline>
                        </svg>
                      </button>
                    </form>
                  )}
                </div>

                {showSignIn && (
                  <div
                    style={{
                      marginTop: 30,
                      maxWidth: 560,
                      width: "100%",
                      alignSelf: "center",
                      textAlign: "left",
                    }}
                  >
                    <ConsumerSignInCard onBack={() => setShowSignIn(false)} />
                  </div>
                )}

                {!showSignIn &&
                  !isWelcomeNameCapture &&
                  !isWelcomeGreetingTyping && (
                    <div
                      style={{
                        marginTop: 38,
                        paddingTop: 26,
                        borderTop: `1px solid ${RULE}`,
                        maxWidth: 680,
                        width: "100%",
                        alignSelf: "center",
                      }}
                    >
                      <p
                        style={{
                          margin: "0 0 14px",
                          fontFamily: SANS,
                          fontSize: SLM_STANDALONE ? 15 : 13,
                          lineHeight: SLM_STANDALONE ? "21px" : undefined,
                          color: MUTED,
                        }}
                      >
                        Choose how you would like to begin.
                      </p>
                      <div
                        className="slm-welcome-options"
                        aria-label="Choose a faculty mode"
                      >
                        <button
                          type="button"
                          onClick={() => continueFromWelcome("faculty")}
                          className="slm-welcome-option"
                          data-testid="button-ask-faculty"
                        >
                          <span className="slm-welcome-option-kicker">Ask</span>
                          <strong>Faculty chat</strong>
                          <span className="slm-welcome-option-description">
                            Ask a question and get a grounded answer with its
                            sources.
                          </span>
                          <span className="slm-welcome-option-link">
                            Start with a question{" "}
                            <span aria-hidden="true">→</span>
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => continueFromWelcome("coach")}
                          className="slm-welcome-option"
                          data-testid="button-learn-with-coach"
                        >
                          <span className="slm-welcome-option-kicker">
                            Explore
                          </span>
                          <strong>Faculty work</strong>
                          <span className="slm-welcome-option-description">
                            Learn, reflect, and build your next steps at your
                            own pace.
                          </span>
                          <span className="slm-welcome-option-link">
                            Open the seven pillars{" "}
                            <span aria-hidden="true">→</span>
                          </span>
                        </button>
                      </div>
                    </div>
                  )}
              </section>
            ) : (
              <div className="slm-hero" style={{ textAlign: "center" }}>
                {/* Warm return greeting: any signed-in visitor who arrived
                  already logged in counts as returning (past conversations
                  also qualify) — brand-new visitors keep the plain hero. */}
                {authed && (returningVisitor || pastGroups.length > 0) && (
                  <div
                    style={{
                      marginBottom: 10,
                      fontFamily: SANS,
                      fontSize: 15,
                      fontWeight: 600,
                      color: CARDINAL,
                    }}
                  >
                    {warmReturnGreeting(firstName, i18n.language)}
                  </div>
                )}
                <h1
                  style={{
                    margin: SLM_STANDALONE ? "0 auto 12px" : "0 0 12px",
                    maxWidth: SLM_STANDALONE ? 860 : undefined,
                    fontFamily: SANS,
                    fontWeight: SLM_STANDALONE ? 700 : 500,
                    fontSize: SLM_STANDALONE
                      ? "clamp(30px, 3.7vw, 48px)"
                      : "clamp(28px, 4.4vw, 42px)",
                    lineHeight: SLM_STANDALONE ? 1 : 1.15,
                    letterSpacing: SLM_STANDALONE ? "0.01em" : "-0.015em",
                    textTransform: SLM_STANDALONE ? "uppercase" : undefined,
                    color: INK,
                  }}
                >
                  {firstName && (
                    <>
                      Hello <span style={{ color: CARDINAL }}>{firstName}</span>
                      .{" "}
                    </>
                  )}
                  {SLM_STANDALONE ? (
                    <>
                      Ask{" "}
                      <span style={{ color: CARDINAL }}>Stanford Faculty</span>{" "}
                      a{" "}
                      <span style={{ color: CARDINAL }}>
                        Lifestyle Medicine
                      </span>{" "}
                      question.
                    </>
                  ) : (
                    <>
                      Ask one question.{" "}
                      <span style={{ color: CARDINAL }}>
                        Get a clear answer.
                      </span>
                    </>
                  )}
                </h1>
                <p
                  className={
                    SLM_STANDALONE ? "slm-sub slm-standalone-sub" : "slm-sub"
                  }
                  style={{
                    margin: "0 auto 32px",
                    maxWidth: SLM_STANDALONE ? 660 : 440,
                    fontFamily: SANS,
                    fontSize: SLM_STANDALONE ? 19 : 15,
                    lineHeight: SLM_STANDALONE ? "21px" : 1.6,
                    color: MUTED,
                  }}
                >
                  {SLM_STANDALONE ? (
                    <>
                      Turn breakthrough science into an answer you can{" "}
                      <span style={{ color: CARDINAL, fontWeight: 600 }}>
                        trust
                      </span>
                      , backed by{" "}
                      <span style={{ color: CARDINAL, fontWeight: 600 }}>
                        Stanford&apos;s top faculty
                      </span>{" "}
                      and a purpose-built AI for health and joy
                    </>
                  ) : (
                    "Ask the AI avatars of Stanford Lifestyle Medicine faculty about sleep, movement, nutrition, stress, and healthy aging. Every answer shows its approved sources and the faculty steward behind it."
                  )}
                </p>
                <div
                  className={
                    SLM_STANDALONE ? "slm-standalone-free-question" : undefined
                  }
                  style={{
                    margin: "-18px auto 22px",
                    fontFamily: SANS,
                    fontSize: SLM_STANDALONE ? 14 : 13.5,
                    lineHeight: SLM_STANDALONE ? "21px" : undefined,
                    letterSpacing: SLM_STANDALONE ? "0.01em" : undefined,
                    color: INK,
                  }}
                >
                  <strong style={{ color: SLM_STANDALONE ? CARDINAL : INK }}>
                    First question free.
                  </strong>{" "}
                  <span style={{ color: MUTED }}>No account required.</span>
                </div>
                <div
                  className="slm-example-label"
                  style={{
                    marginTop: 8,
                    fontFamily: SANS,
                    fontSize: SLM_STANDALONE ? 14 : 12.5,
                    fontWeight: SLM_STANDALONE ? 700 : undefined,
                    letterSpacing: SLM_STANDALONE ? "0.01em" : undefined,
                    textTransform: SLM_STANDALONE ? "uppercase" : undefined,
                    color: MUTED,
                  }}
                >
                  <span style={{ color: SLM_STANDALONE ? CARDINAL : MUTED }}>
                    Try one of these questions
                  </span>
                </div>
                <div className="slm-chips" style={{ marginTop: 8 }}>
                  {heroStewards.map((s) => (
                    <button
                      key={s.pillarSlug}
                      className="slm-chip"
                      aria-label={`Try this question: ${STEWARD_CHIP_TOPICS[s.pillarSlug].question}`}
                      title="Try this question"
                      onClick={() => {
                        setFocusSteward(s);
                        void ask(STEWARD_CHIP_TOPICS[s.pillarSlug].question);
                      }}
                      style={{
                        padding: "7px 18px 7px 8px",
                        borderRadius: 999,
                        border: `1px solid ${RULE}`,
                        background: "rgba(255,255,255,0.75)",
                        fontFamily: SANS,
                        fontSize: SLM_STANDALONE ? 14.5 : 13.5,
                        color: INK,
                        cursor: "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 10,
                      }}
                    >
                      <img
                        src={stewardPhotoSrc(s)}
                        alt={s.stewardName}
                        width={30}
                        height={30}
                        style={{
                          borderRadius: "50%",
                          objectFit: "cover",
                          flexShrink: 0,
                        }}
                      />
                      <span className="slm-chip-copy">
                        <span className="slm-chip-full">
                          {STEWARD_CHIP_TOPICS[s.pillarSlug].question}
                        </span>
                        <span className="slm-chip-meta slm-chip-full">
                          {s.stewardName} · {s.pillarName}
                        </span>
                      </span>
                      {/* Phones get the calm one-liner: just the topic. */}
                      <span className="slm-chip-short">
                        {(() => {
                          const t = STEWARD_CHIP_TOPICS[s.pillarSlug].topic;
                          return t.charAt(0).toUpperCase() + t.slice(1);
                        })()}
                      </span>
                    </button>
                  ))}
                  {heroStewards.length === 0 &&
                    SUGGESTIONS.slice(0, 3).map((s) => (
                      <button
                        key={s}
                        className="slm-chip"
                        aria-label={`Try this question: ${s}`}
                        title="Try this question"
                        onClick={() => void ask(s)}
                        style={{
                          padding: "10px 18px",
                          borderRadius: 999,
                          border: `1px solid ${RULE}`,
                          background: "rgba(255,255,255,0.6)",
                          fontFamily: SANS,
                          fontSize: SLM_STANDALONE ? 14.5 : 13.5,
                          color: INK,
                          cursor: "pointer",
                        }}
                      >
                        {s}
                      </button>
                    ))}
                </div>
                {!SLM_STANDALONE && avatarChoices.length > 0 && (
                  <section
                    aria-label="Choose a faculty avatar"
                    style={{
                      maxWidth: 760,
                      margin: "28px auto 0",
                      paddingTop: 20,
                      borderTop: `1px solid ${RULE}`,
                    }}
                  >
                    <div
                      style={{
                        fontFamily: SANS,
                        fontSize: 12.5,
                        fontWeight: 700,
                        color: INK,
                      }}
                    >
                      Or choose a faculty avatar to talk with
                    </div>
                    <p
                      style={{
                        fontFamily: SANS,
                        fontSize: 12.5,
                        lineHeight: SLM_STANDALONE ? 1.35 : 1.5,
                        color: MUTED,
                        margin: "5px 0 12px",
                      }}
                    >
                      Start with a natural voice conversation. Your camera stays
                      off.
                    </p>
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        justifyContent: "center",
                        gap: 8,
                      }}
                    >
                      {avatarChoices.map((steward) => {
                        const selected =
                          selectedAvatar?.pillarSlug === steward.pillarSlug;
                        return (
                          <button
                            key={steward.pillarSlug}
                            type="button"
                            data-testid={`button-choose-avatar-${steward.pillarSlug}`}
                            aria-pressed={selected}
                            aria-label={`Choose ${steward.stewardName ?? steward.pillarName} as your faculty avatar`}
                            onClick={() => {
                              setSelectedAvatar(steward);
                              setFocusSteward(steward);
                            }}
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 8,
                              padding: "6px 12px 6px 6px",
                              borderRadius: 999,
                              border: `1px solid ${selected ? CARDINAL : RULE}`,
                              background: selected
                                ? "rgba(140,21,21,0.07)"
                                : CARD,
                              color: INK,
                              cursor: "pointer",
                              fontFamily: SANS,
                              fontSize: 12.5,
                              fontWeight: 650,
                            }}
                          >
                            <img
                              src={stewardPhotoSrc(steward)}
                              alt=""
                              width={28}
                              height={28}
                              style={{
                                borderRadius: "50%",
                                objectFit: "cover",
                              }}
                            />
                            {steward.stewardName ?? steward.pillarName}
                          </button>
                        );
                      })}
                    </div>
                    {selectedAvatar && (
                      <div
                        data-testid="section-selected-avatar"
                        style={{
                          margin: "16px auto 0",
                          maxWidth: 480,
                          padding: "14px 16px",
                          border: `1px solid ${RULE}`,
                          borderRadius: 16,
                          background: CARD,
                          textAlign: "left",
                        }}
                      >
                        <div
                          style={{
                            fontFamily: SANS,
                            fontSize: 13.5,
                            fontWeight: 700,
                            color: INK,
                          }}
                        >
                          Talk with{" "}
                          {selectedAvatar.stewardName ??
                            selectedAvatar.pillarName}
                        </div>
                        <p
                          style={{
                            margin: "4px 0 0",
                            fontFamily: SANS,
                            fontSize: 12.5,
                            lineHeight: 1.5,
                            color: MUTED,
                          }}
                        >
                          Speak naturally with the avatar, or type a question
                          below. We will use the name you already gave us and
                          never turn on your camera.
                        </p>
                        <TavusAvatarButton
                          persona="steward"
                          steward={selectedAvatar}
                          visitorName={firstName ?? visitorName}
                          triggerVariant="inline"
                          triggerLabel={`🎙 Start a voice conversation with ${selectedAvatar.stewardName?.split(" ")[0] ?? "this avatar"} (camera off)`}
                        />
                      </div>
                    )}
                  </section>
                )}
              </div>
            )
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              {/* Warm by-name welcome at the top of a RESTORED conversation —
                  returning visitors usually land here (their last thread is
                  reloaded), so the empty-hero greeting alone would never be
                  seen by them. */}
              {authed && returningVisitor && (
                <div
                  style={{
                    textAlign: "center",
                    fontFamily: SANS,
                    fontSize: 14.5,
                    fontWeight: 600,
                    color: CARDINAL,
                    padding: "2px 0 6px",
                  }}
                >
                  {warmReturnGreeting(firstName, i18n.language)}
                </div>
              )}
              {turns.map((t, i) => {
                if (t.role === "user") {
                  return (
                    <div
                      key={i}
                      className="slm-user-turn"
                      style={{ display: "flex", justifyContent: "flex-end" }}
                    >
                      <div
                        style={{
                          background: INK,
                          color: "#fff",
                          borderRadius: "18px 18px 4px 18px",
                          padding: "12px 18px",
                          maxWidth: "82%",
                          fontFamily: SANS,
                          fontSize: SLM_STANDALONE ? 16 : 15,
                          lineHeight: SLM_STANDALONE ? "21px" : 1.55,
                        }}
                      >
                        {t.text}
                      </div>
                    </div>
                  );
                }
                if (t.role === "signin") {
                  return (
                    <div key={i} style={{ display: "flex" }}>
                      <OnboardCard
                        onRegistered={handleRegistered}
                        initialName={visitorName}
                      />
                    </div>
                  );
                }
                if (t.role === "notice") {
                  return (
                    <div
                      key={i}
                      style={{
                        textAlign: "center",
                        fontFamily: SANS,
                        fontSize: 13,
                        lineHeight: 1.6,
                        color: MUTED,
                        maxWidth: 480,
                        margin: "0 auto",
                      }}
                    >
                      {t.text}
                    </div>
                  );
                }
                const precedingQuestion = (() => {
                  for (let j = i - 1; j >= 0; j -= 1) {
                    const previousTurn = turns[j];
                    if (previousTurn.role === "user") return previousTurn.text;
                  }
                  return "";
                })();
                return (
                  <div
                    key={i}
                    className="slm-assistant-turn"
                    style={{ display: "flex" }}
                  >
                    <div style={{ width: "100%" }}>
                      <AssistantBubble
                        turn={t}
                        question={precedingQuestion}
                        stewards={stewardMap}
                        focusedSlug={focusSteward?.pillarSlug ?? null}
                        onContinueWith={(s) => {
                          setFocusSteward(s);
                          inputRef.current?.focus();
                        }}
                        listen={
                          t.status === "done" && t.parsed?.answer
                            ? {
                                active: ttsTurn === i && speaking,
                                loading: ttsTurn === i && ttsLoading,
                                error: ttsTurn === i ? ttsError : null,
                                onToggle: () => {
                                  if (
                                    ttsTurn === i &&
                                    (speaking || ttsLoading)
                                  ) {
                                    stopAudio();
                                    setTtsTurn(null);
                                    return;
                                  }
                                  const p = t.parsed;
                                  const spoken = [
                                    p?.answer,
                                    p?.finding,
                                    p?.interpretation,
                                  ]
                                    .filter(Boolean)
                                    .join(" ");
                                  minicastStopRef.current?.();
                                  setTtsTurn(i);
                                  void playText(spoken || t.text);
                                },
                              }
                            : undefined
                        }
                        minicast={{
                          onStart: () => {
                            stopAudio();
                            setTtsTurn(null);
                          },
                          stopRef: minicastStopRef,
                        }}
                        avatarBridge={{
                          ref: avatarComposerRef,
                          onCapture: setAvatarCaptureName,
                        }}
                        visitorName={firstName ?? visitorName}
                        followUp={
                          i === turns.length - 1 &&
                          t.status === "done" &&
                          !t.fallbackSteward &&
                          t.parsed &&
                          !t.parsed.refused &&
                          !t.parsed.uncovered &&
                          !verifyLock
                            ? {
                                value: input,
                                suggestions: t.suggested ?? [],
                                disabled: streaming,
                                onChange: setInput,
                                onAsk: (question) => void ask(question),
                              }
                            : undefined
                        }
                      />
                      {companionSuggestionShown &&
                        !companionSuggestionDismissed &&
                        !companionAlreadyChosen &&
                        i === turns.length - 1 && (
                          <CompanionSuggestion
                            onStart={openCompanionFromConversation}
                            onDismiss={() =>
                              setCompanionSuggestionDismissed(true)
                            }
                          />
                        )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Composer + footer */}
      <div
        style={{
          flexShrink: 0,
          padding:
            "8px clamp(16px, 4vw, 32px) calc(10px + env(safe-area-inset-bottom, 0px))",
        }}
      >
        {!inlineFollowUpVisible && focusSteward && (
          <div
            style={{
              maxWidth: 760,
              margin: "0 auto 8px",
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontFamily: SANS,
              fontSize: 12.5,
              color: MUTED,
            }}
          >
            {focusSteward.photoUrl && (
              <img
                src={stewardPhotoSrc(focusSteward)}
                alt=""
                width={22}
                height={22}
                style={{ borderRadius: "50%", objectFit: "cover" }}
              />
            )}
            <span>
              Talking with{" "}
              <strong style={{ color: CARDINAL, fontWeight: 600 }}>
                {focusSteward.stewardName}
              </strong>{" "}
              about {focusSteward.pillarName}
            </span>
            <button
              type="button"
              onClick={() => setFocusSteward(null)}
              aria-label="Stop focusing on this steward"
              style={{
                border: "none",
                background: "transparent",
                color: MUTED,
                cursor: "pointer",
                fontFamily: SANS,
                fontSize: 12,
                textDecoration: "underline",
                padding: 0,
              }}
            >
              ask about anything
            </button>
          </div>
        )}
        <form
          onSubmit={submit}
          className={`slm-input${isInitialQuestionEntry ? " slm-main-entry" : ""}`}
          style={{
            maxWidth: isInitialQuestionEntry ? 800 : 760,
            margin: "0 auto",
            display:
              SLM_STANDALONE && standaloneView === "welcome"
                ? "none"
                : inlineFollowUpVisible
                  ? "none"
                  : "flex",
            alignItems: "flex-end",
            gap: isInitialQuestionEntry ? 12 : 10,
            background: "transparent",
            border: "none",
            borderRadius: 0,
            padding: isInitialQuestionEntry ? 0 : "10px 0",
            boxShadow: "none",
          }}
        >
          <textarea
            ref={inputRef}
            className="slm-ta"
            rows={1}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              const el = e.target;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitComposer();
              }
            }}
            onMouseDown={() => {
              // A click means "I want to type my own" — drop the suggestion.
              if (placeholderSuggestion && !input.trim()) {
                setPlaceholderDismissedFor(placeholderSuggestion);
              }
            }}
            disabled={Boolean(verifyLock)}
            aria-label={
              isWelcomeNameCapture
                ? "Your first name"
                : "Ask a Lifestyle Medicine question"
            }
            placeholder={
              verifyLock
                ? "Confirm your email to continue"
                : isWelcomeNameCapture
                  ? "Type your first name…"
                  : avatarCaptureName
                    ? `Ask ${avatarCaptureName}…`
                    : empty
                      ? "Dear Professor, please help me decide…"
                      : placeholderSuggestion
                        ? fitPlaceholder(placeholderSuggestion)
                        : "Ask a follow-up…"
            }
            style={{
              flex: 1,
              fontFamily: SANS,
              fontSize: isInitialQuestionEntry
                ? 30
                : SLM_STANDALONE
                  ? 17
                  : 15.5,
              lineHeight: isInitialQuestionEntry
                ? 1.25
                : SLM_STANDALONE
                  ? "21px"
                  : 1.5,
              color: INK,
              padding: isInitialQuestionEntry ? "10px 0" : "6px 0",
              maxHeight: 140,
            }}
          />
          <button
            type="submit"
            disabled={
              streaming ||
              (!input.trim() && !placeholderSuggestion) ||
              Boolean(verifyLock)
            }
            aria-label={
              isWelcomeNameCapture ? "Continue with your name" : "Send"
            }
            style={{
              width: isInitialQuestionEntry ? 88 : 42,
              height: isInitialQuestionEntry ? 88 : 42,
              borderRadius: "50%",
              border: "none",
              background:
                (input.trim() || placeholderSuggestion) && !streaming
                  ? RED
                  : "rgba(10,10,15,0.12)",
              color: "#fff",
              cursor: input.trim() && !streaming ? "pointer" : "default",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              transition: "background .15s ease",
            }}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 19V5" />
              <path d="M5 12l7-7 7 7" />
            </svg>
          </button>
        </form>

        {/* Footer */}
        <div
          style={{
            maxWidth: 760,
            margin: "10px auto 0",
            textAlign: "center",
          }}
        >
          <p
            className="slm-foot-full"
            style={{
              margin: "0 auto 6px",
              maxWidth: 560,
              fontFamily: SANS,
              fontSize: 10.5,
              lineHeight: 1.5,
              // 0.5 alpha failed WCAG AA contrast on the cream background
              // (flagged by the axe scan) — 0.72 clears 4.5:1 comfortably.
              color: "rgba(10,10,15,0.72)",
            }}
          >
            Answers are grounded in faculty-reviewed, peer-reviewed research.
            For learning, not medical advice. Talk to your clinician about
            decisions that affect your health.
          </p>
        </div>
      </div>
    </main>
  );
}
