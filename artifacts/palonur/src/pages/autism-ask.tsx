import { useEffect, useRef, useState } from "react";

/**
 * /autism — Karen Parker's autism research ask surface.
 *
 * Streams answers from POST /api/embed-agent with pillar="autism".
 * Hard-locked to Karen Parker's approved autism corpus; UNCOVERED when the
 * question falls outside her published material.
 */

const BASE = import.meta.env.BASE_URL;
const SANS = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif";
const SERIF = "'Georgia','Times New Roman',serif";
const RED = "#B3261E";
const INK = "#0A0A0F";
const PAPER = "#FAF8F4";
const CARD = "#FFFFFF";
const MUTED = "rgba(10,10,15,0.64)";
const RULE = "rgba(10,10,15,0.10)";

const SAMPLE_QUESTIONS = [
  "What does the research say about oxytocin and autism?",
  "How does social behavior differ in autistic adults?",
  "Are there evidence-based interventions for social communication in autism?",
  "What is known about the genetics of autism spectrum disorder?",
  "How do sensory sensitivities affect quality of life in autism?",
  "What role does the gut-brain connection play in autism?",
];

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

interface ParsedAnswer {
  answer: string;
  citation: string;
  paper: string;
  finding: string;
  interpretation: string;
  refused: boolean;
  uncovered: boolean;
  raw: string;
}

function parseAnswer(text: string): ParsedAnswer {
  const raw = text.trim();
  const refused = raw.startsWith("REFUSE:");
  const uncovered = raw.startsWith("UNCOVERED:");

  function extract(label: string): string {
    const re = new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n[A-Z]+:|$)`, "i");
    const m = re.exec(raw);
    return m ? m[1].trim() : "";
  }

  return {
    raw,
    refused,
    uncovered,
    answer: refused
      ? raw.replace(/^REFUSE:\s*/i, "")
      : uncovered
        ? raw.replace(/^UNCOVERED:\s*/i, "")
        : extract("ANSWER"),
    citation: extract("CITATION"),
    paper: extract("PAPER"),
    finding: extract("FINDING"),
    interpretation: extract("INTERPRETATION"),
  };
}

function ProvenanceStrip({ entries }: { entries: ProvenanceEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div style={{ marginTop: 28, borderTop: `1px solid ${RULE}`, paddingTop: 18 }}>
      <div style={{
        fontSize: 10, fontWeight: 700, letterSpacing: ".2em",
        textTransform: "uppercase", color: MUTED, marginBottom: 12, fontFamily: SANS,
      }}>
        Source
      </div>
      {entries.map((e, i) => (
        <div key={i} style={{
          marginBottom: 10, fontFamily: SERIF,
          fontSize: 13.5, lineHeight: 1.5, color: "rgba(10,10,15,0.7)",
        }}>
          {e.authors && (
            <span style={{ fontWeight: 600 }}>
              {e.authors}{e.year ? `, ${e.year}` : ""}. {" "}
            </span>
          )}
          {e.source_url ? (
            <a href={e.source_url} target="_blank" rel="noopener noreferrer"
              style={{ color: RED, textDecoration: "none" }}>
              {e.title}
            </a>
          ) : (
            <span style={{ fontStyle: "italic" }}>{e.title}</span>
          )}
          {e.journal && <span style={{ color: MUTED }}>{" · "}{e.journal}</span>}
        </div>
      ))}
    </div>
  );
}

function AnswerCard({ parsed, provenance }: { parsed: ParsedAnswer; provenance: ProvenanceEntry[] }) {
  const sectionLabel: React.CSSProperties = {
    fontSize: 10, fontWeight: 700, letterSpacing: ".2em",
    textTransform: "uppercase", color: RED, marginBottom: 6, fontFamily: SANS,
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
        <p style={{ fontFamily: SANS, fontSize: 13, color: MUTED, marginTop: 16 }}>
          Karen Parker's approved research does not yet include material on this topic.
        </p>
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
      <ProvenanceStrip entries={provenance} />
    </div>
  );
}

export default function AutismAsk() {
  const initialQ = (() => {
    try {
      return new URLSearchParams(window.location.search).get("q") ?? "";
    } catch {
      return "";
    }
  })();

  const [query, setQuery] = useState(initialQ);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [parsed, setParsed] = useState<ParsedAnswer | null>(null);
  const [provenance, setProvenance] = useState<ProvenanceEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const answerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.title = "Autism Research — Palonur";
    const prevBg = document.body.style.background;
    document.body.style.background = PAPER;
    return () => {
      document.title = "Palonur";
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
    setError(null);

    const url = new URL(window.location.href);
    url.searchParams.set("q", question);
    window.history.replaceState(null, "", url.toString());

    try {
      const res = await fetch("/api/embed-agent", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify({ message: question, pillar: "autism" }),
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
            if (Array.isArray(evt.provenance)) {
              setProvenance(evt.provenance as ProvenanceEntry[]);
            }
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

  useEffect(() => {
    if (initialQ) {
      void ask(initialQ);
    }
  }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    void ask(query);
  }

  return (
    <main style={{ background: PAPER, minHeight: "100vh", fontFamily: SANS }}>
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div style={{
        borderBottom: `1px solid ${RULE}`,
        padding: "20px clamp(20px, 5vw, 80px)",
        display: "flex", alignItems: "center", gap: 16,
        position: "sticky", top: 0, background: PAPER, zIndex: 10,
      }}>
        <a href={BASE} style={{ textDecoration: "none" }}>
          <span style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 600, color: INK }}>Palonur</span>
        </a>
        <span style={{ color: RULE, fontSize: 18 }}>·</span>
        <span style={{ fontSize: 13, color: MUTED, fontFamily: SANS }}>Autism Research</span>
      </div>

      <div style={{ maxWidth: 720, margin: "0 auto", padding: "clamp(40px, 7vh, 80px) clamp(20px, 5vw, 48px) 120px" }}>
        {/* ── Hero ────────────────────────────────────────────────────── */}
        {!hasAnswer && !streaming && (
          <div style={{ marginBottom: 48 }}>
            <div style={{
              fontSize: 10, fontWeight: 700, letterSpacing: ".24em",
              textTransform: "uppercase", color: RED, marginBottom: 20,
            }}>
              America's Finest Experts
            </div>
            <h1 style={{
              margin: "0 0 18px",
              fontFamily: SERIF, fontWeight: 500,
              fontSize: "clamp(32px, 5vw, 52px)",
              lineHeight: 1.1, letterSpacing: "-0.018em", color: INK,
            }}>
              Ask about autism research.
            </h1>
            <p style={{
              margin: 0, fontFamily: SERIF,
              fontSize: "clamp(16px, 1.5vw, 18px)",
              lineHeight: 1.65, color: "rgba(10,10,15,0.68)",
            }}>
              Answers grounded in Karen Parker's peer-reviewed work on autism, social behavior, and neurobiological research.
            </p>
          </div>
        )}

        {/* ── Search form ─────────────────────────────────────────────── */}
        <form onSubmit={submit}>
          <div style={{ display: "flex", gap: 10, marginBottom: 32 }}>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder="Ask a question about autism research…"
              disabled={streaming}
              style={{
                flex: 1,
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
                onClick={() => { setQuery(q); void ask(q); }}
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

        {/* ── Question header ──────────────────────────────────────────── */}
        {submitted && (
          <div style={{
            marginBottom: 24,
            fontFamily: SERIF,
            fontSize: "clamp(18px, 2.5vw, 24px)",
            fontWeight: 500, lineHeight: 1.3, color: INK,
          }}>
            {submitted}
          </div>
        )}

        {/* ── Streaming ────────────────────────────────────────────────── */}
        {streaming && (
          <div style={{
            background: CARD, borderRadius: 18,
            padding: "28px 32px", border: `1px solid ${RULE}`,
            fontFamily: SERIF, fontSize: 16.5, lineHeight: 1.65, color: INK,
            whiteSpace: "pre-wrap",
          }}>
            {streamText || <span style={{ color: MUTED }}>Searching Karen Parker's approved research…</span>}
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
          <div ref={answerRef}>
            <AnswerCard parsed={parsed} provenance={provenance} />
            <div style={{ marginTop: 36, textAlign: "center" }}>
              <button
                onClick={() => {
                  setQuery("");
                  setParsed(null);
                  setProvenance([]);
                  setStreamText("");
                  setSubmitted(null);
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
          </div>
        )}

        {/* ── Error ───────────────────────────────────────────────────── */}
        {error && (
          <div style={{
            marginTop: 16, padding: "14px 20px",
            background: "rgba(232,53,42,0.07)", borderRadius: 12,
            fontFamily: SANS, fontSize: 14, color: "#c0392b",
          }}>
            {error}
          </div>
        )}
      </div>
    </main>
  );
}
