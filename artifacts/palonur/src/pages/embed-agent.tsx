/**
 * Live embeddable expert agent — a white-label, single-pillar "ask anything"
 * surface designed to be iframed onto an independent expert's own website.
 *
 * Reads theming + scope from URL params (set by the loader snippet or a raw
 * iframe src):
 *   ?pillar=<slug>   (required) — the ONLY pillar this widget answers from
 *   ?color=<hex>     primary / accent color (buttons, rules, citation)
 *   ?bg=<css color>  page background (default white)
 *   ?logo=<url>      expert's logo shown in the header
 *   ?name=<text>     display name override (defaults to the pillar's steward)
 *
 * It POSTs to /api/embed-agent, which is HARD-LOCKED to the pillar: answers
 * come only from that expert's approved sources + interpretations, with no
 * cross-pillar or legacy-corpus fallback. SSE shape matches /sleep-agent.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { studyDesignLabel } from "@workspace/db/study-design";
import {
  AnswerLimitNotices,
  parseLimitNotices,
  type AnswerLimitNotice,
} from "../components/AnswerLimitNotices";

const ENDPOINT = "/api/embed-agent";

interface ProvenanceEntry {
  source_id: number;
  interpretation_id: number | null;
  title: string;
  authors: string | null;
  year: number | null;
  journal: string | null;
  doi: string | null;
  source_url: string | null;
  study_design: string | null;
  pillar_slug: string;
}

interface ParsedAnswer {
  answer?: string;
  citation?: string;
  paper?: string;
  finding?: string;
  interpretation?: string;
  action?: string;
  insight?: string;
  refuse?: string;
  uncovered?: string;
}

/** Parse the labelled streaming response into its sections. Mirrors the
 * parser on /sleep so the same server output renders here. */
function parseAnswer(raw: string): ParsedAnswer {
  const text = raw.trim();
  if (!text) return {};
  const refuse = text.match(/^REFUSE:\s*([\s\S]*)/i);
  if (refuse) return { refuse: refuse[1].trim() };
  const uncovered = text.match(/^UNCOVERED:\s*([\s\S]*)/i);
  if (uncovered) return { uncovered: uncovered[1].trim() };

  const grab = (label: string, stops: string[]): string | undefined => {
    const stopAlt = stops.join("|");
    const re = new RegExp(
      `${label}:\\s*([\\s\\S]*?)(?=\\n(?:${stopAlt}):|$)`,
      "i",
    );
    const m = text.match(re);
    return m ? m[1].trim() : undefined;
  };
  const ALL = [
    "ANSWER",
    "CITATION",
    "PAPER",
    "FINDING",
    "INTERPRETATION",
    "ACTION",
    "INSIGHT",
    "CLARIFY",
    "ADVISOR_NOTE",
  ];
  return {
    answer: grab("ANSWER", ALL),
    citation: grab("CITATION", ALL),
    paper: grab("PAPER", ALL),
    finding: grab("FINDING", ALL),
    interpretation: grab("INTERPRETATION", ALL),
    action: grab("ACTION", ALL),
    insight: grab("INSIGHT", ALL),
  };
}

/** Only allow http(s) URLs (logo, source links). */
function safeHref(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const p = new URL(u);
    return p.protocol === "https:" || p.protocol === "http:" ? u : null;
  } catch {
    return null;
  }
}

/** Accept only hex colors or a short list of CSS keywords — never arbitrary
 * strings that could smuggle CSS into an inline style. */
function safeColor(c: string | null | undefined, fallback: string): string {
  if (!c) return fallback;
  const v = c.trim();
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return v;
  if (/^(transparent|white|black)$/i.test(v)) return v.toLowerCase();
  return fallback;
}

/** Lighten/tint a hex color toward white for soft backgrounds. */
function tint(hex: string, amount: number): string {
  const m = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

const SANS =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Inter', system-ui, sans-serif";
const SERIF = "'Georgia','Times New Roman',serif";

export default function EmbedAgent() {
  const params = useMemo(
    () => new URLSearchParams(window.location.search),
    [],
  );
  const pillar = params.get("pillar") || "communication";
  const primary = safeColor(params.get("color"), "#1f2937");
  const bg = safeColor(params.get("bg"), "#ffffff");
  const logo = safeHref(params.get("logo"));
  const nameOverride = params.get("name")?.trim() || null;

  const [expertName, setExpertName] = useState<string | null>(nameOverride);
  const [pillarName, setPillarName] = useState<string>("");
  const [q, setQ] = useState("");
  const [out, setOut] = useState("");
  const [provenance, setProvenance] = useState<ProvenanceEntry[]>([]);
  // Amber limit notices from the done event — honest-limitation lines shown
  // under a covered answer; empty on well-covered answers and boundaries.
  const [limitNotices, setLimitNotices] = useState<AnswerLimitNotice[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [submittedQ, setSubmittedQ] = useState("");
  const [pillarResources, setPillarResources] = useState<
    Array<{
      id: number;
      title: string;
      url: string;
      description: string | null;
      category: string | null;
      displayOrder: number;
    }>
  >([]);
  const [escalateEmail, setEscalateEmail] = useState("");
  const [escalateState, setEscalateState] = useState<"idle" | "submitting" | "done" | "error">("idle");
  // Suggested follow-up chips from the done event (covered answers only).
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const autoEscalateRef = useRef(false);
  const { t, i18n } = useTranslation("common");
  const abortRef = useRef<AbortController | null>(null);

  // Strip host chrome — this renders inside someone else's page.
  useEffect(() => {
    const prevTitle = document.title;
    document.title = `Ask · ${nameOverride ?? pillar}`;
    document.body.style.margin = "0";
    document.body.style.padding = "0";
    document.body.style.background = "transparent";
    document.documentElement.style.background = "transparent";
    return () => {
      document.title = prevTitle;
    };
  }, [pillar, nameOverride]);

  // Pull the pillar's display name + steward name for the header (only when
  // a name override wasn't supplied).
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/embed/pillar/${encodeURIComponent(pillar)}`)
      .then(async (r) => (r.ok ? ((await r.json()) as {
        pillar: { name: string };
        steward: { name: string | null } | null;
      }) : null))
      .then((d) => {
        if (cancelled || !d) return;
        setPillarName(d.pillar?.name ?? "");
        if (!nameOverride && d.steward?.name) setExpertName(d.steward.name);
      })
      .catch(() => {
        /* header just falls back to defaults */
      });
    return () => {
      cancelled = true;
    };
  }, [pillar, nameOverride]);

  const run = useCallback(
    async (message: string) => {
      if (!message.trim() || streaming) return;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setOut("");
      setProvenance([]);
      setLimitNotices([]);
      setPillarResources([]);
      setSuggestions([]);
      setErr(null);
      setStreaming(true);
      setSubmittedQ(message.trim());
      setEscalateState("idle");
      setEscalateEmail("");
      autoEscalateRef.current = false;
      try {
        const r = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, pillar, lang: i18n.language?.slice(0, 2) || "en" }),
          signal: ac.signal,
        });
        if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const s of parts) {
            if (!s.startsWith("data:")) continue;
            try {
              const j = JSON.parse(s.slice(5).trim());
              if (j.content) setOut((p) => p + j.content);
              if (j.error) setErr(String(j.error));
              if (Array.isArray(j.provenance)) setProvenance(j.provenance);
              if (j.done) setLimitNotices(parseLimitNotices(j.limitNotices));
              // Citation-guard correction: replace the streamed answer with
              // the server's honest boundary line (fabricated citation caught).
              if (j.done && typeof j.correction === "string" && j.correction) {
                setOut(j.correction);
              }
              if (j.done && Array.isArray(j.resources)) setPillarResources(j.resources);
              // Follow-up chips — covered answers only (field omitted on
              // boundary/corrected answers, so this stays []).
              if (j.done && Array.isArray(j.suggestedQuestions)) {
                setSuggestions(
                  (j.suggestedQuestions as unknown[])
                    .filter((s): s is string => typeof s === "string")
                    .slice(0, 2),
                );
              }
            } catch {
              /* swallow partial frames */
            }
          }
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") setErr((e as Error).message);
      } finally {
        setStreaming(false);
      }
    },
    [streaming, pillar],
  );

  const parsed = useMemo(() => parseAnswer(out), [out]);
  const topic = pillarName || pillar;
  const displayName = expertName || nameOverride;

  // Auto-fire escalation when UNCOVERED is detected — fire-and-forget, no email required.
  useEffect(() => {
    if (!streaming && parsed.uncovered && !autoEscalateRef.current) {
      autoEscalateRef.current = true;
      fetch("/api/uncovered-escalation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: submittedQ || q,
          surface: pillar,
          userEmail: null,
        }),
      }).catch(() => {});
    }
  }, [streaming, parsed.uncovered]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    run(q);
  };

  const cardBg = tint(primary, 0.94);
  const muted = "rgba(0,0,0,0.55)";

  return (
    <main
      style={{
        minHeight: "100vh",
        background: bg,
        color: "#111",
        fontFamily: SANS,
        boxSizing: "border-box",
        padding: "22px 18px 28px",
      }}
    >
      <div style={{ maxWidth: 640, margin: "0 auto" }}>
        {/* Header — white-label */}
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginBottom: 18,
          }}
        >
          {logo && (
            <img
              src={logo}
              alt=""
              style={{ height: 34, width: "auto", objectFit: "contain" }}
            />
          )}
          <div>
            <div
              style={{
                fontFamily: SERIF,
                fontSize: 18,
                lineHeight: 1.2,
                color: "#111",
              }}
            >
              {displayName ? `Ask ${displayName}` : `Ask about ${topic}`}
            </div>
            <div style={{ fontSize: 12, color: muted, marginTop: 2 }}>
              {displayName
                ? `Answers grounded in ${displayName}'s published work on ${topic}.`
                : `Answers grounded in approved sources on ${topic}.`}
            </div>
          </div>
        </header>

        {/* Suggested follow-up chips — neutral presentation; tapping one
            re-asks exactly like a normal submit. */}
        {!streaming && !err && suggestions.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setQ(s);
                  run(s);
                }}
                style={{
                  padding: "8px 14px",
                  fontFamily: SANS,
                  fontSize: 13,
                  color: "#111",
                  background: tint(primary, 0.96),
                  border: `1px solid ${tint(primary, 0.7)}`,
                  borderRadius: 999,
                  cursor: "pointer",
                  textAlign: "left",
                  lineHeight: 1.4,
                }}
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {/* Ask box */}
        <form
          onSubmit={onSubmit}
          style={{ display: "flex", gap: 8, marginBottom: 16 }}
        >
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Ask anything about ${topic}…`}
            disabled={streaming}
            style={{
              flex: 1,
              padding: "13px 16px",
              background: "#fff",
              border: `1px solid ${tint(primary, 0.65)}`,
              borderRadius: 10,
              color: "#111",
              fontFamily: SANS,
              fontSize: 15,
              outline: "none",
            }}
          />
          <button
            type="submit"
            disabled={streaming || !q.trim()}
            style={{
              padding: "0 20px",
              background: streaming || !q.trim() ? tint(primary, 0.55) : primary,
              color: "#fff",
              border: "none",
              borderRadius: 10,
              fontWeight: 600,
              fontSize: 14,
              cursor: streaming || !q.trim() ? "default" : "pointer",
            }}
          >
            {streaming ? "…" : "Ask"}
          </button>
        </form>

        {/* Answer surface */}
        {err ? (
          <div style={{ fontSize: 14, color: "#b91c1c" }}>
            Something went wrong: {err}
          </div>
        ) : !out && !streaming ? (
          <div style={{ fontSize: 14, color: muted, lineHeight: 1.6 }}>
            Ask a question and the answer will stream here, with the source it
            is grounded in.
          </div>
        ) : parsed.refuse ? (
          <div style={{ fontSize: 15, color: "#111", lineHeight: 1.6 }}>
            {parsed.refuse}
          </div>
        ) : parsed.uncovered ? (
          <div>
            <div style={{ fontSize: 15, color: "#111", lineHeight: 1.6, marginBottom: 16 }}>
              {parsed.uncovered}
            </div>

            {/* ADRC (or other pillar) curated resource links */}
            {!streaming && pillarResources.length > 0 && (
              <div style={{
                marginBottom: 16,
                padding: "18px 20px", borderRadius: 12,
                background: tint(primary, 0.97),
                border: `1px solid ${tint(primary, 0.78)}`,
              }}>
                <div style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: ".14em",
                  color: primary, textTransform: "uppercase", marginBottom: 12,
                }}>
                  Learn more from Stanford's ADRC
                </div>
                {pillarResources.map((r) => (
                  <div key={r.id} style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 2 }}>
                      {r.category && (
                        <span style={{
                          fontSize: 9.5, fontWeight: 700, letterSpacing: ".1em",
                          textTransform: "uppercase", color: primary,
                          border: `1px solid ${tint(primary, 0.55)}`,
                          borderRadius: 999, padding: "1px 7px",
                          flexShrink: 0,
                        }}>
                          {r.category}
                        </span>
                      )}
                    </div>
                    <a
                      href={safeHref(r.url) ?? undefined}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        display: "block", fontSize: 14, fontWeight: 600,
                        color: primary, textDecoration: "none",
                        marginBottom: r.description ? 2 : 0,
                      }}
                    >
                      {r.title} ↗
                    </a>
                    {r.description && (
                      <div style={{ fontSize: 13, color: "#555", lineHeight: 1.45 }}>
                        {r.description}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {!streaming && (
              <div style={{
                padding: "18px 20px", borderRadius: 12,
                background: tint(primary, 0.96),
                border: `1px solid ${tint(primary, 0.72)}`,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10 }}>
                  <span style={{ fontSize: 14 }}>✓</span>
                  <span style={{
                    fontSize: 10, fontWeight: 700, letterSpacing: ".14em",
                    color: primary, textTransform: "uppercase",
                  }}>Team notified</span>
                </div>
                <div style={{
                  fontSize: 14, lineHeight: 1.55, color: "#111", marginBottom: 12,
                }}>
                  {t("uncoveredCard.autoNotice")}
                </div>
                {escalateState !== "done" ? (
                  <>
                    <div style={{ fontSize: 12, color: "#555", marginBottom: 8 }}>
                      {t("uncoveredCard.followUpPrompt")}
                    </div>
                    <input
                      type="email"
                      value={escalateEmail}
                      onChange={(e) => setEscalateEmail(e.target.value)}
                      placeholder={t("uncoveredCard.placeholder")}
                      style={{
                        display: "block", width: "100%", boxSizing: "border-box",
                        padding: "10px 13px", marginBottom: 10,
                        fontFamily: SANS, fontSize: 14, color: "#111",
                        background: "#fff",
                        border: `1px solid ${tint(primary, 0.65)}`, borderRadius: 8,
                        outline: "none",
                      }}
                    />
                    {escalateState === "error" && (
                      <div style={{ fontSize: 12, color: "#b91c1c", marginBottom: 8 }}>
                        {t("uncoveredCard.error")}
                      </div>
                    )}
                    {escalateEmail.trim() && (
                      <button
                        type="button"
                        disabled={escalateState === "submitting"}
                        onClick={async () => {
                          setEscalateState("submitting");
                          try {
                            const r = await fetch("/api/uncovered-escalation", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                question: submittedQ || q,
                                surface: pillar,
                                userEmail: escalateEmail.trim(),
                              }),
                            });
                            if (!r.ok) throw new Error("request failed");
                            setEscalateState("done");
                          } catch {
                            setEscalateState("error");
                          }
                        }}
                        style={{
                          padding: "9px 18px", borderRadius: 8,
                          background: escalateState === "submitting" ? tint(primary, 0.5) : primary,
                          color: "#fff", border: "none",
                          fontFamily: SANS, fontSize: 13, fontWeight: 600,
                          cursor: escalateState === "submitting" ? "default" : "pointer",
                          transition: "background .15s",
                        }}
                      >
                        {escalateState === "submitting" ? t("uncoveredCard.sending") : t("uncoveredCard.button")}
                      </button>
                    )}
                  </>
                ) : (
                  <div style={{ fontSize: 13, color: "#1a3a1a" }}>
                    {t("uncoveredCard.emailSent")}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <article>
            {parsed.answer ? (
              <p
                style={{
                  fontFamily: SERIF,
                  fontSize: 21,
                  lineHeight: 1.4,
                  margin: "0 0 14px",
                  color: "#111",
                }}
              >
                {parsed.answer}
                {streaming && <span style={{ color: primary }}>▍</span>}
              </p>
            ) : (
              <p style={{ fontSize: 14, color: muted, margin: 0 }}>
                {streaming ? "Thinking…" : out}
                {streaming && <span style={{ color: primary }}>▍</span>}
              </p>
            )}

            {parsed.interpretation && (
              <p
                style={{
                  fontSize: 15,
                  lineHeight: 1.65,
                  color: "rgba(0,0,0,0.78)",
                  margin: "0 0 14px",
                }}
              >
                {parsed.interpretation}
              </p>
            )}

            {parsed.action && (
              <div
                style={{
                  background: cardBg,
                  borderRadius: 10,
                  padding: "12px 14px",
                  fontSize: 14,
                  lineHeight: 1.55,
                  color: "#111",
                  marginBottom: 14,
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: "0.14em",
                    textTransform: "uppercase",
                    color: primary,
                    display: "block",
                    marginBottom: 4,
                  }}
                >
                  Try this
                </span>
                {parsed.action}
              </div>
            )}

            {/* Amber limit notices — honest-limitation lines under the
                answer; frames what is still under review, never
                "this answer is unsafe". */}
            {!streaming && <AnswerLimitNotices notices={limitNotices} />}

            {(parsed.citation || provenance.length > 0) && (
              <div
                style={{
                  borderTop: `1px solid ${tint(primary, 0.78)}`,
                  paddingTop: 12,
                  marginTop: 4,
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: "0.14em",
                    textTransform: "uppercase",
                    color: muted,
                    marginBottom: 6,
                  }}
                >
                  Source
                </div>
                {provenance.length > 0 ? (
                  provenance.map((p) => {
                    const href =
                      safeHref(p.source_url) ||
                      (p.doi ? `https://doi.org/${p.doi}` : null);
                    const label = `${p.title}${p.year ? ` (${p.year})` : ""}`;
                    const studyType = studyDesignLabel(p.study_design);
                    return (
                      <div
                        key={p.source_id}
                        style={{ fontSize: 13, marginBottom: 4, color: "#111" }}
                      >
                        {href ? (
                          <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: primary, textDecoration: "none" }}
                          >
                            {label}
                          </a>
                        ) : (
                          label
                        )}
                        {p.authors && (
                          <span style={{ color: muted }}> · {p.authors}</span>
                        )}
                        {studyType && (
                          <span
                            style={{
                              display: "inline-block",
                              marginLeft: 6,
                              fontSize: 10.5,
                              fontWeight: 600,
                              color: muted,
                              border: `1px solid ${muted}`,
                              borderRadius: 999,
                              padding: "1px 7px",
                              verticalAlign: "middle",
                            }}
                          >
                            {studyType}
                          </span>
                        )}
                      </div>
                    );
                  })
                ) : (
                  <div style={{ fontSize: 13, color: "#111" }}>
                    {parsed.citation}
                    {parsed.paper && (
                      <div style={{ color: muted, marginTop: 2 }}>
                        {parsed.paper}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Supplementary curated resource links — shown below a grounded
                answer so readers can always reach primary ADRC (or other
                pillar) links even when the corpus covers the question. */}
            {!streaming && pillarResources.length > 0 && (
              <div style={{
                marginTop: 18,
                padding: "18px 20px", borderRadius: 12,
                background: tint(primary, 0.97),
                border: `1px solid ${tint(primary, 0.78)}`,
              }}>
                <div style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: ".14em",
                  color: primary, textTransform: "uppercase", marginBottom: 12,
                }}>
                  Learn more from Stanford's ADRC
                </div>
                {pillarResources.map((r) => (
                  <div key={r.id} style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 2 }}>
                      {r.category && (
                        <span style={{
                          fontSize: 9.5, fontWeight: 700, letterSpacing: ".1em",
                          textTransform: "uppercase", color: primary,
                          border: `1px solid ${tint(primary, 0.55)}`,
                          borderRadius: 999, padding: "1px 7px",
                          flexShrink: 0,
                        }}>
                          {r.category}
                        </span>
                      )}
                    </div>
                    <a
                      href={safeHref(r.url) ?? undefined}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        display: "block", fontSize: 14, fontWeight: 600,
                        color: primary, textDecoration: "none",
                        marginBottom: r.description ? 2 : 0,
                      }}
                    >
                      {r.title} ↗
                    </a>
                    {r.description && (
                      <div style={{ fontSize: 13, color: "#555", lineHeight: 1.45 }}>
                        {r.description}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </article>
        )}

        {/* Powered by */}
        <div
          style={{
            marginTop: 26,
            fontSize: 11,
            color: muted,
            letterSpacing: "0.04em",
          }}
        >
          Science, signed · Powered by{" "}
          <a
            href="https://palonur.com"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: muted }}
          >
            Palonur
          </a>
        </div>
      </div>
    </main>
  );
}
