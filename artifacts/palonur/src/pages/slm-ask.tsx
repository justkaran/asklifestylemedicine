import { useEffect, useRef, useState } from "react";
import i18n from "../i18n";
import { StewardChatPanel, StewardAvatar } from "../components/steward-chat-panel";
import { MinicastButton } from "../components/MinicastButton";
import { AnswerTrajectory } from "../components/answer-trajectory";
import { TakeawayButton } from "../components/takeaway-card";
import { ShareAnswerButton } from "../components/share-answer";
import { parseAnswer, type ParsedAnswer } from "../lib/parse-answer";
import { SLM_STANDALONE } from "../lib/app-mode";
import { useVisiblePillars, type ConsumerPillar } from "../lib/pillars";

/**
 * /slm — Combined Stanford Lifestyle Medicine ask surface.
 *
 * Every question is routed across ALL active SLM pillars; after the answer
 * arrives, only the stewards whose pillars actually contributed are shown.
 * AI Lab fallback answers are credited to the AI Lab steward.
 */

const BASE = import.meta.env.BASE_URL;
const SANS = "'Source Sans 3', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const SERIF = "'Source Serif 4', Georgia, 'Times New Roman', serif";
const RED = "#B3261E";
const INK = "#0A0A0F";
const PAPER = "#FAF8F4";
const CARD = "#FFFFFF";
const MUTED = "rgba(10,10,15,0.64)";
const RULE = "rgba(10,10,15,0.10)";

const SAMPLE_QUESTIONS = [
  "How does exercise affect sleep quality?",
  "What does the research say about loneliness and health?",
  "How much protein do I actually need after 50?",
  "Can stress management lower inflammation?",
  "What keeps the brain sharp as we age?",
  "Is gratitude practice backed by science?",
];

// One representative question per pillar — used by the standalone landing's
// pillar cards (the SLM domain must never link to Palonur routes, so cards
// ask a question instead of navigating).
const PILLAR_QUESTIONS: Record<string, string> = {
  sleep: "What actually improves sleep after 50?",
  "stress-management": "How does chronic stress speed up aging?",
  nutrition: "What should I eat differently after 50?",
  movement: "How do I slow age-related muscle loss?",
  "social-connection": "Why does social connection matter for healthy aging?",
  "cognitive-enhancement": "What keeps the brain sharp as we age?",
  "gratitude-purpose": "Does having a sense of purpose really help you live longer?",
};

// ── Types ──────────────────────────────────────────────────────────────────

interface StewardInfo {
  pillarSlug: string;
  pillarName: string;
  stewardName: string | null;
  institution: string | null;
  photoUrl: string | null;
  tags: string[];
}

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

// ── Helpers ────────────────────────────────────────────────────────────────

// ── Sub-components ─────────────────────────────────────────────────────────

function AnswerSourcesRail({ entries }: { entries: ProvenanceEntry[] }) {
  if (entries.length === 0) return null;
  const sourceCount = new Set(entries.map((entry) => entry.source_id)).size;
  return (
    <aside
      aria-label="Answer sources"
      style={{
        position: "sticky",
        top: 96,
        minWidth: 0,
      }}
    >
      <section
        style={{
          overflow: "hidden",
          border: `1px solid ${RULE}`,
          borderRadius: 18,
          background: CARD,
          boxShadow: "0 8px 32px rgba(10,10,15,0.04)",
        }}
      >
        <div style={{ padding: "17px 18px 14px", borderBottom: `1px solid ${RULE}` }}>
          <div
            style={{
              fontFamily: SANS,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: ".15em",
              textTransform: "uppercase",
              color: RED,
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
        <div style={{ padding: "17px 18px 8px" }}>
          {entries.map((e, i) => (
            <div
              key={i}
              style={{
                marginBottom: 14,
                paddingBottom: i === entries.length - 1 ? 0 : 14,
                borderBottom: i === entries.length - 1 ? "none" : `1px solid ${RULE}`,
                fontFamily: SERIF,
                fontSize: 13.5,
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
              {e.journal && <span style={{ color: MUTED }}>{" · "}{e.journal}</span>}
            </div>
          ))}
        </div>
      </section>
    </aside>
  );
}

function AnswerCard({ parsed }: { parsed: ParsedAnswer }) {
  const sectionLabel: React.CSSProperties = {
    fontSize: 10, fontWeight: 700, letterSpacing: ".2em",
    textTransform: "uppercase", color: RED, marginBottom: 6,
    fontFamily: SANS,
  };
  const sectionText: React.CSSProperties = {
    fontFamily: SERIF, fontSize: 16.5, lineHeight: 1.65, color: INK, margin: 0,
  };
  const divider: React.CSSProperties = {
    border: "none", borderTop: `1px solid ${RULE}`, margin: "20px 0",
  };

  if (parsed.refused) {
    return (
      <div style={{ background: CARD, borderRadius: 18, padding: "28px 32px", border: `1px solid ${RULE}` }}>
        <p style={{ ...sectionText, color: MUTED }}>{parsed.answer}</p>
      </div>
    );
  }

  if (parsed.uncovered) {
    return (
      <div style={{ background: CARD, borderRadius: 18, padding: "28px 32px", border: `1px solid ${RULE}` }}>
        <div style={sectionLabel}>Not yet covered</div>
        <p style={{ ...sectionText, color: MUTED }}>{parsed.answer}</p>
      </div>
    );
  }

  return (
    <div style={{ background: CARD, borderRadius: 18, padding: "28px 32px", border: `1px solid ${RULE}` }}>
      {parsed.answer && (
        <>
          <div style={sectionLabel}>Answer</div>
          <p style={sectionText}>{parsed.answer}</p>
        </>
      )}
      {parsed.finding && (
        <>
          <hr style={divider} />
          <div style={sectionLabel}>Key finding</div>
          <p style={{ ...sectionText, fontSize: 15 }}>{parsed.finding}</p>
        </>
      )}
      {parsed.interpretation && (
        <>
          <hr style={divider} />
          <div style={sectionLabel}>What this means</div>
          <p style={{ ...sectionText, fontSize: 15 }}>{parsed.interpretation}</p>
        </>
      )}
      {parsed.paper && (
        <>
          <hr style={divider} />
          <div style={sectionLabel}>Research</div>
          <p style={{ ...sectionText, fontSize: 14, color: MUTED, fontStyle: "italic" }}>
            {parsed.paper}
            {parsed.citation ? ` (${parsed.citation})` : ""}
          </p>
        </>
      )}
    </div>
  );
}

// ── Standalone landing (asklifestylemedicine.com only) ────────────────────
//
// The SLM domain serves ONLY this page, so in standalone mode the pre-answer
// screen doubles as the product's landing page: why Stanford Lifestyle
// Medicine matters, the seven pillars, and the healthy-aging story. Nothing
// here may link to a Palonur route or show Palonur branding.

function LandingEyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 700, letterSpacing: ".24em",
      textTransform: "uppercase", color: RED, marginBottom: 16,
      fontFamily: SANS,
    }}>
      {children}
    </div>
  );
}

function LandingHeadline({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{
      margin: "0 0 18px", fontFamily: SERIF, fontWeight: 500,
      fontSize: "clamp(26px, 3.6vw, 38px)", lineHeight: 1.15,
      letterSpacing: "-0.015em", color: INK,
    }}>
      {children}
    </h2>
  );
}

const landingBody: React.CSSProperties = {
  margin: "0 0 16px", fontFamily: SERIF,
  fontSize: "clamp(15.5px, 1.4vw, 17.5px)",
  lineHeight: 1.7, color: "rgba(10,10,15,0.72)",
};

function PillarCard({ pillar, onAsk }: { pillar: ConsumerPillar; onAsk: (q: string) => void }) {
  const question = PILLAR_QUESTIONS[pillar.slug];
  return (
    <div
      data-testid={`card-slm-pillar-${pillar.slug}`}
      style={{
        background: CARD, border: `1px solid ${RULE}`, borderRadius: 18,
        overflow: "hidden", display: "flex", flexDirection: "column",
        boxShadow: "0 2px 10px rgba(10,10,15,0.05)",
      }}
    >
      <div style={{ aspectRatio: "16 / 9", overflow: "hidden", background: "rgba(10,10,15,0.04)" }}>
        <img
          src={pillar.art}
          alt=""
          loading="lazy"
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      </div>
      <div style={{ padding: "20px 22px 22px", display: "flex", flexDirection: "column", flex: 1 }}>
        <h3 style={{
          margin: "0 0 8px", fontFamily: SERIF, fontWeight: 600,
          fontSize: 19, lineHeight: 1.25, color: INK,
        }}>
          {pillar.name}
        </h3>
        <p style={{
          margin: "0 0 14px", fontFamily: SERIF, fontSize: 14.5,
          lineHeight: 1.6, color: "rgba(10,10,15,0.66)", flex: 1,
        }}>
          {pillar.description}
        </p>
        {pillar.steward && (
          <div style={{
            display: "flex", alignItems: "center", gap: 8, marginBottom: 14,
            fontFamily: SANS, fontSize: 12, color: MUTED,
          }}>
            {pillar.stewardPhoto && (
              <img
                src={pillar.stewardPhoto}
                alt=""
                loading="lazy"
                style={{
                  width: 26, height: 26, borderRadius: "50%",
                  objectFit: "cover", border: `1px solid ${RULE}`,
                }}
              />
            )}
            <span>{pillar.steward}</span>
          </div>
        )}
        {question && (
          <button
            onClick={() => onAsk(question)}
            style={{
              alignSelf: "flex-start", background: "transparent",
              border: "none", padding: 0, cursor: "pointer",
              fontFamily: SANS, fontSize: 13, fontWeight: 700, color: RED,
            }}
          >
            Ask about {pillar.name.toLowerCase()} →
          </button>
        )}
      </div>
    </div>
  );
}

function StandaloneLanding({ onAsk }: { onAsk: (q: string) => void }) {
  const pillars = useVisiblePillars();
  return (
    <div data-testid="section-slm-landing">
      {/* ── Why Stanford Lifestyle Medicine ─────────────────────────── */}
      <div style={{ marginTop: 72, borderTop: `1px solid ${RULE}`, paddingTop: 56 }}>
        <LandingEyebrow>Why lifestyle medicine</LandingEyebrow>
        <LandingHeadline>Medicine that starts with how you live.</LandingHeadline>
        <p style={landingBody}>
          The chronic conditions that shape how we age — heart disease, type 2
          diabetes, cognitive decline — are driven to a remarkable degree by
          daily behavior: how we sleep, what we eat, how we move, how we handle
          stress, and how connected we stay to other people. Lifestyle medicine
          is the medical discipline that treats those behaviors as treatment,
          with the same seriousness as any prescription.
        </p>
        <p style={{ ...landingBody, marginBottom: 0 }}>
          Stanford Lifestyle Medicine brings that discipline out of the journal
          and into plain language. The faculty behind this page study these
          questions for a living — and every answer you get here is grounded in
          peer-reviewed research they have reviewed, with the study cited by
          name. No wellness folklore, no engagement bait. Science, signed.
        </p>
      </div>

      {/* ── The seven pillars ────────────────────────────────────────── */}
      <div style={{ marginTop: 72 }}>
        <LandingEyebrow>The seven pillars</LandingEyebrow>
        <LandingHeadline>Healthy aging rests on seven pillars.</LandingHeadline>
        <p style={{ ...landingBody, marginBottom: 32 }}>
          Each pillar is stewarded by Stanford Lifestyle Medicine faculty who
          curate the research it draws from. Ask a question and it is answered
          from the pillars that actually know.
        </p>
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 20,
        }}>
          {pillars.map((p) => (
            <PillarCard key={p.slug} pillar={p} onAsk={onAsk} />
          ))}
        </div>
      </div>

      {/* ── Healthy aging ────────────────────────────────────────────── */}
      <div style={{ marginTop: 72, borderTop: `1px solid ${RULE}`, paddingTop: 56 }}>
        <LandingEyebrow>Healthy aging</LandingEyebrow>
        <LandingHeadline>The second half of life is decided daily.</LandingHeadline>
        <p style={landingBody}>
          Aging well is not a matter of luck or genetics alone. The research is
          consistent: the way you sleep, eat, move, connect, and find purpose
          compounds — quietly, decade over decade — into how sharp, mobile, and
          independent you stay. Small changes made now matter more than dramatic
          ones made later.
        </p>
        <p style={{ ...landingBody, marginBottom: 28 }}>
          That is why this page exists. Instead of searching through
          contradictory headlines, ask the question you actually have and get
          an answer grounded in the research — with the study it came from and
          the Stanford faculty who stand behind it.
        </p>
        <button
          onClick={() => {
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
          style={{
            background: RED, color: "#fff", border: "none", borderRadius: 999,
            padding: "14px 28px", fontFamily: SANS, fontSize: 14,
            fontWeight: 700, cursor: "pointer",
          }}
        >
          Ask your question
        </button>
      </div>

      {/* ── Footnote ─────────────────────────────────────────────────── */}
      <div style={{
        marginTop: 72, borderTop: `1px solid ${RULE}`, paddingTop: 24,
        fontFamily: SANS, fontSize: 12, color: MUTED, lineHeight: 1.6,
      }}>
        Answers are grounded in faculty-reviewed, peer-reviewed research. For
        learning, not medical advice — talk to your clinician about decisions
        that affect your health.
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export default function SlmAsk() {
  const initialQ = (() => {
    try {
      return new URLSearchParams(window.location.search).get("q") ?? "";
    } catch {
      return "";
    }
  })();

  // Steward directory (for post-answer contributor attribution)
  const [stewardList, setStewardList] = useState<StewardInfo[]>([]);

  // Chat state
  const [query, setQuery] = useState(initialQ);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [parsed, setParsed] = useState<ParsedAnswer | null>(null);
  const [provenance, setProvenance] = useState<ProvenanceEntry[]>([]);
  const [pillarNames, setPillarNames] = useState<string[]>([]);
  const [fallbackSteward, setFallbackSteward] = useState<string | null>(null);
  // Citation-guard result from the SSE done event — drives the "checks we
  // ran" list in the trajectory panel. null when no check ran (fallback,
  // uncovered, refusal).
  const [citationStatus, setCitationStatus] =
    useState<"verified" | "missing" | "unmatched" | null>(null);
  // agent_queries row id from the SSE done event — enables "Share this
  // answer" (durable permalink). null while streaming or on error.
  const [queryId, setQueryId] = useState<string | null>(null);
  // Suggested follow-up chips from the done event (covered answers only) —
  // rendered by the steward chat panel above its composer.
  const [suggested, setSuggested] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const answerRef = useRef<HTMLDivElement>(null);

  // Load stewards on mount
  useEffect(() => {
    fetch(`${BASE}api/slm-agent/stewards`, {
      headers: { "Sec-Fetch-Site": "same-origin" },
    })
      .then((r) => r.json())
      .then((d: unknown) => {
        if (d && typeof d === "object" && "stewards" in d && Array.isArray((d as { stewards: unknown }).stewards)) {
          setStewardList((d as { stewards: StewardInfo[] }).stewards);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    document.title = SLM_STANDALONE
      ? "Ask Stanford Lifestyle Medicine"
      : "Ask Stanford Lifestyle Medicine — Palonur";
    const prevBg = document.body.style.background;
    document.body.style.background = PAPER;
    return () => {
      document.title = SLM_STANDALONE ? "Stanford Lifestyle Medicine" : "Palonur";
      document.body.style.background = prevBg;
    };
  }, []);

  const hasAnswer = parsed !== null;

  async function ask(q: string) {
    const question = q.trim();
    if (!question || streaming) return;

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setSubmitted(question);
    setStreaming(true);
    setStreamText("");
    setParsed(null);
    setProvenance([]);
    setPillarNames([]);
    setFallbackSteward(null);
    setCitationStatus(null);
    setQueryId(null);
    setSuggested([]);
    setError(null);

    const url = new URL(window.location.href);
    url.searchParams.set("q", question);
    window.history.replaceState(null, "", url.toString());

    const body: Record<string, unknown> = {
      message: question,
      lang: i18n.language?.slice(0, 2) || "en",
    };

    try {
      const res = await fetch(`${BASE}api/slm-agent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });

      if (!res.ok || !res.body) {
        const d = await res.json().catch(() => ({}));
        setError((d as { error?: string }).error ?? "Something went wrong. Please try again.");
        setStreaming(false);
        return;
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let acc = "";

      while (true) {
        const { done, value } = await reader.read();
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
            setStreamText(acc);
          }
          if (evt.done) {
            // Citation-guard correction: the server caught a fabricated
            // citation after streaming — replace the streamed answer with
            // the honest boundary line instead of showing it.
            if (typeof evt.correction === "string" && evt.correction) {
              acc = evt.correction;
              setStreamText(acc);
            }
            if (Array.isArray(evt.provenance)) {
              setProvenance(evt.provenance as ProvenanceEntry[]);
            }
            if (Array.isArray(evt.pillarNames)) {
              setPillarNames(evt.pillarNames as string[]);
            }
            if (
              evt.citationVerification &&
              typeof evt.citationVerification === "object" &&
              typeof (evt.citationVerification as { status?: unknown }).status === "string"
            ) {
              const st = (evt.citationVerification as { status: string }).status;
              if (st === "verified" || st === "missing" || st === "unmatched") {
                setCitationStatus(st);
              }
            }
            if (evt.slmFallback) {
              setFallbackSteward(
                typeof evt.stewardName === "string" && evt.stewardName
                  ? evt.stewardName
                  : "Stanford Lifestyle Medicine AI Lab",
              );
            }
            if (typeof evt.queryId === "string" && evt.queryId) {
              setQueryId(evt.queryId);
            }
            setSuggested(
              Array.isArray(evt.suggestedQuestions)
                ? (evt.suggestedQuestions as unknown[])
                    .filter((s): s is string => typeof s === "string")
                    .slice(0, 2)
                : [],
            );
            setParsed(parseAnswer(acc));
            setStreaming(false);
            setTimeout(() => answerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
          }
          if (typeof evt.error === "string") {
            setError(evt.error);
            setStreaming(false);
          }
        }
      }
    } catch (e) {
      if ((e as { name?: string }).name !== "AbortError") {
        setError("Something went wrong. Please try again.");
        setStreaming(false);
      }
    }
  }

  // Auto-fire from ?q= (skips picker)
  useEffect(() => {
    if (initialQ) {
      void ask(initialQ);
    }
  }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    void ask(query);
  }

  // Stewards whose pillars actually contributed to the current answer
  // (pillarNames arrives with the SSE `done` event).
  const contributingStewards = stewardList.filter((s) => pillarNames.includes(s.pillarName));
  const contributingNames = contributingStewards
    .map((s) => s.stewardName ?? s.pillarName)
    .join(" · ");

  // Attribution line — ONLY who actually contributed to this answer.
  const attributionLine =
    pillarNames.length > 0 ? (contributingNames || pillarNames.join(", ")) : null;

  // Responsive: keep the answer and source rail side by side on tablets and
  // desktops. Only true phone widths use the stacked layout.
  const [isNarrow, setIsNarrow] = useState(
    typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 760px)");
    const onChange = () => setIsNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Stewards shown in the chat panel: contributors, or the AI Lab steward
  // on fallback answers.
  const panelStewards: StewardInfo[] = fallbackSteward
    ? [{
        pillarSlug: "slm-ai-lab",
        pillarName: "Stanford Lifestyle Medicine AI Lab",
        stewardName: fallbackSteward,
        institution: "Stanford Lifestyle Medicine AI Lab",
        photoUrl: null,
        tags: [],
      }]
    : contributingStewards;
  const showPanel =
    hasAnswer && !streaming && parsed !== null &&
    !parsed.refused && !parsed.uncovered && panelStewards.length > 0;
  const showSourcesRail =
    hasAnswer &&
    !streaming &&
    parsed !== null &&
    !parsed.refused &&
    !parsed.uncovered &&
    !fallbackSteward &&
    provenance.length > 0;

    // ── Chat phase ─────────────────────────────────────────────────────────────

  return (
    <main style={{ background: PAPER, minHeight: "100vh", fontFamily: SANS }}>
      {/* Header */}
      <div style={{
        borderBottom: `1px solid ${RULE}`,
        padding: "20px clamp(20px, 5vw, 80px)",
        display: "flex", alignItems: "center", gap: 16,
        position: "sticky", top: 0, background: PAPER, zIndex: 10,
      }}>
        {SLM_STANDALONE ? (
          <span style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 600, color: INK }}>
            Stanford Lifestyle Medicine
          </span>
        ) : (
          <>
            <a href={BASE} style={{ textDecoration: "none", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 600, color: INK }}>Palonur</span>
            </a>
            <span style={{ color: RULE, fontSize: 18 }}>·</span>
            <span style={{ fontSize: 13, color: MUTED, fontFamily: SANS }}>Stanford Lifestyle Medicine</span>
          </>
        )}
      </div>

      <div style={{ maxWidth: showSourcesRail && !isNarrow ? 1440 : 720, margin: "0 auto", padding: "clamp(40px, 7vh, 80px) clamp(20px, 5vw, 48px) 120px" }}>

        {/* ── Hero ─────────────────────────────────────────────────────── */}
        {!hasAnswer && !streaming && (
          <div style={{ marginBottom: 48 }}>
            <div style={{
              fontSize: 10, fontWeight: 700, letterSpacing: ".24em",
              textTransform: "uppercase", color: RED, marginBottom: 20,
            }}>
              Science, signed
            </div>
            <h1 style={{
              margin: "0 0 18px",
              fontFamily: SERIF, fontWeight: 500,
              fontSize: "clamp(32px, 5vw, 52px)",
              lineHeight: 1.1, letterSpacing: "-0.018em", color: INK,
            }}>
              Ask Stanford Lifestyle Medicine.
            </h1>
            <p style={{
              margin: 0, fontFamily: SERIF,
              fontSize: "clamp(16px, 1.5vw, 18px)",
              lineHeight: 1.65, color: "rgba(10,10,15,0.68)",
            }}>
              {SLM_STANDALONE
                ? "The science of healthy aging — sleep, nutrition, movement, stress, connection, cognition, and purpose — answered from peer-reviewed research and reviewed by the Stanford faculty who study it."
                : "Every answer comes from peer-reviewed research, cited by name, reviewed by world-class Stanford faculty."}
            </p>
          </div>
        )}

        {/* ── Search form ──────────────────────────────────────────────── */}
        <form onSubmit={submit}>
          <div style={{ display: "flex", gap: 10, marginBottom: 32 }}>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder="Ask a question about sleep, nutrition, movement, stress…"
              disabled={streaming}
              className="pill-field"
              style={{
                flex: 1,
                minWidth: 0,
                fontFamily: SERIF,
                fontSize: 16,
                padding: "14px 18px",
                border: `1.5px solid ${RULE}`,
                borderRadius: 999,
                background: CARD,
                color: INK,
                outline: "none",
                boxShadow: "0 2px 8px rgba(10,10,15,0.06)",
                opacity: streaming ? 0.6 : 1,
              }}
            />
            <button
              type="submit"
              disabled={!query.trim() || streaming}
              style={{
                background: RED,
                color: "#fff",
                border: "none",
                borderRadius: 999,
                padding: "14px 24px",
                fontFamily: SANS,
                fontSize: 14,
                fontWeight: 700,
                cursor: !query.trim() || streaming ? "not-allowed" : "pointer",
                opacity: !query.trim() || streaming ? 0.5 : 1,
                whiteSpace: "nowrap",
              }}
            >
              {streaming ? "Asking…" : "Ask"}
            </button>
          </div>
        </form>

        {/* ── Sample questions ─────────────────────────────────────────── */}
        {!hasAnswer && !streaming && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 48 }}>
            {SAMPLE_QUESTIONS.map((q) => (
              <button
                key={q}
                onClick={() => {
                  setQuery(q);
                  void ask(q);
                }}
                style={{
                  background: CARD,
                  border: `1px solid ${RULE}`,
                  borderRadius: 999,
                  padding: "8px 16px",
                  fontFamily: SERIF,
                  fontSize: 13.5,
                  color: "rgba(10,10,15,0.75)",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                {q}
              </button>
            ))}
          </div>
        )}

        {/* ── Standalone landing (SLM domain only) ─────────────────────── */}
        {SLM_STANDALONE && !hasAnswer && !streaming && (
          <StandaloneLanding
            onAsk={(q) => {
              window.scrollTo({ top: 0, behavior: "smooth" });
              setQuery(q);
              void ask(q);
            }}
          />
        )}

        {/* ── Question header ───────────────────────────────────────────── */}
        {submitted && (
          <div style={{
            marginBottom: 24,
            fontFamily: SERIF,
            fontSize: "clamp(18px, 2.5vw, 24px)",
            fontWeight: 500,
            lineHeight: 1.3,
            color: INK,
          }}>
            {submitted}
          </div>
        )}

        {/* ── Streaming text ───────────────────────────────────────────── */}
        {streaming && (
          <div style={{
            background: CARD, borderRadius: 18,
            padding: "28px 32px", border: `1px solid ${RULE}`,
            fontFamily: SERIF, fontSize: 16.5, lineHeight: 1.65, color: INK,
            whiteSpace: "pre-wrap",
          }}>
            {streamText || (
              <span style={{ color: MUTED }}>
                Searching across Stanford Lifestyle Medicine research…
              </span>
            )}
            <span style={{
              display: "inline-block", width: 2, height: 18,
              background: RED, marginLeft: 2, verticalAlign: "middle",
              animation: "blink 1s step-end infinite",
            }} />
            <style>{`@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }`}</style>
          </div>
        )}

        {/* ── Parsed answer ─────────────────────────────────────────────── */}
        {hasAnswer && !streaming && parsed && (
          <div
            ref={answerRef}
            style={
              showSourcesRail && !isNarrow
                ? {
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 1fr) minmax(300px, 340px)",
                    gap: "clamp(28px, 3.5vw, 52px)",
                    alignItems: "start",
                  }
                : undefined
            }
          >
            <div style={{ minWidth: 0 }}>
            {!parsed.refused && !parsed.uncovered && (
              <div style={{ marginBottom: 14, display: "flex", justifyContent: "flex-end" }}>
                <MinicastButton
                  question={submitted ?? ""}
                  sections={{
                    answer: parsed.answer,
                    finding: parsed.finding,
                    action: parsed.interpretation,
                  }}
                  ready={!streaming && !!(parsed.answer || parsed.finding)}
                />
              </div>
            )}

            <AnswerCard parsed={parsed} />

            {/* Printable takeaway sheet — a keepable output: clean,
                large-type page with the answer, the practical step, and
                the source. Covered answers only. */}
            {!parsed.refused && !parsed.uncovered && parsed.answer &&
              !fallbackSteward && citationStatus === "verified" && provenance.length > 0 && (
              <TakeawayButton
                question={submitted ?? ""}
                sections={{ answer: parsed.answer, finding: parsed.finding, action: parsed.interpretation }}
                sourceLines={provenance.map((p) =>
                  [[p.authors, p.year].filter(Boolean).join(", "), p.title, p.journal].filter(Boolean).join(" · "),
                )}
                brand={{
                  accent: RED,
                  name: "Stanford Lifestyle Medicine",
                  footer: "Grounded in faculty-approved Stanford Lifestyle Medicine research. For learning, not medical advice.",
                }}
                labels={{
                  button: "Print this answer",
                  hint: "Opens a clean page you can print or save.",
                  actionHeading: "What this means for you",
                  sourceHeading: "Source",
                  blocked: "Please allow pop-ups for this site, then try again.",
                }}
              />
            )}

            {/* How this answer was built — collapsed trajectory panel.
                Provenance is already same-work-collapsed server-side; no
                steward identity or internal scores are passed. Refusals get
                no panel (boundaries only). */}
            {!parsed.refused && (
              <AnswerTrajectory
                pillarNames={pillarNames}
                sources={provenance.map((p) => ({
                  title: p.title,
                  authors: p.authors,
                  year: p.year,
                }))}
                citationStatus={citationStatus}
                outcome={
                  parsed.uncovered
                    ? "boundary"
                    : fallbackSteward
                      ? "fallback"
                      : "covered"
                }
                accent={RED}
              />
            )}

            {/* Attribution */}
            <div style={{ marginTop: 16, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 12, flexWrap: "wrap" }}>
              {fallbackSteward && !parsed.refused && !parsed.uncovered && (
                <span style={{ fontSize: 12, color: MUTED, fontFamily: SANS }}>
                  From {fallbackSteward} ·{" "}
                  {SLM_STANDALONE ? (
                    <span>Stanford Lifestyle Medicine AI Lab</span>
                  ) : (
                    <a
                      href="/ai-lab"
                      style={{ color: MUTED, textDecoration: "underline" }}
                    >
                      Stanford Lifestyle Medicine AI Lab
                    </a>
                  )}
                </span>
              )}
              {!fallbackSteward && attributionLine && provenance.length > 0 && !parsed.refused && !parsed.uncovered && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  {contributingStewards.length > 0 && (
                    <span style={{ display: "inline-flex" }}>
                      {contributingStewards.slice(0, 3).map((s, i) => (
                        <span key={s.pillarSlug} style={{ marginLeft: i > 0 ? -8 : 0, display: "inline-flex" }}>
                          <StewardAvatar steward={s} size={24} />
                        </span>
                      ))}
                    </span>
                  )}
                  <span style={{ fontSize: 12, color: MUTED, fontFamily: SANS }}>
                    From {attributionLine}
                  </span>
                </span>
              )}

            </div>

            {/* Share this answer — durable permalink a friend can open. */}
            {queryId && !parsed.refused && (
              <div style={{ marginTop: 20, textAlign: "center" }}>
                <ShareAnswerButton queryId={queryId} />
              </div>
            )}

            {/* Ask another */}
            <div style={{ marginTop: 24, textAlign: "center" }}>
              <button
                onClick={() => {
                  setQuery("");
                  setParsed(null);
                  setProvenance([]);
                  setPillarNames([]);
                  setFallbackSteward(null);
                  setCitationStatus(null);
                  setQueryId(null);
                  setStreamText("");
                  setSubmitted(null);
                  setError(null);
                  const url = new URL(window.location.href);
                  url.searchParams.delete("q");
                  window.history.replaceState(null, "", url.toString());
                }}
                style={{
                  background: "transparent",
                  border: `1.5px solid ${RULE}`,
                  borderRadius: 999,
                  padding: "12px 28px",
                  fontFamily: SANS, fontSize: 14, fontWeight: 600,
                  color: INK, cursor: "pointer",
                }}
              >
                Ask another question
              </button>
            </div>

            {/* ── Faculty conversation stays with the answer, so the only
                desktop side rail is the source trail. */}
            {showPanel && (
              <div style={{ marginTop: 28 }}>
                <StewardChatPanel
                  stewards={panelStewards}
                  question={submitted ?? ""}
                  parsed={parsed}
                  isFallback={fallbackSteward !== null}
                  initialSuggestions={suggested}
                />
              </div>
            )}
            </div>
            {showSourcesRail && <AnswerSourcesRail entries={provenance} />}
          </div>
        )}

        {/* ── Error ────────────────────────────────────────────────────── */}
        {error && (
          <div style={{
            marginTop: 16, padding: "14px 20px",
            background: "rgba(232,53,42,0.07)", borderRadius: 12,
            fontFamily: SANS, fontSize: 14, color: "#c0392b",
          }}>
            {error}
          </div>
        )}

        {/* ── Footer ───────────────────────────────────────────────────── */}
        {!hasAnswer && !streaming && !SLM_STANDALONE && (
          <div style={{ marginTop: 64, textAlign: "center" }}>

            <a href={`${BASE}pillars`} style={{
              fontSize: 13, color: MUTED, fontFamily: SANS, textDecoration: "none",
            }}>
              About the pillars →
            </a>
            <span style={{ margin: "0 16px", color: RULE }}>·</span>
            <a href={`${BASE}sleep`} style={{
              fontSize: 13, color: MUTED, fontFamily: SANS, textDecoration: "none",
            }}>
              Sleep agent →
            </a>
          </div>
        )}
      </div>
    </main>
  );
}
