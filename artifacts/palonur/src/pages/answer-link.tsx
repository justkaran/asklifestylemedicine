/**
 * /a/:id — public answer permalink.
 *
 * Shows a saved /slm answer (question, answer sections, citations) plus a
 * clear, friendly invitation to ask your own question. Read-only: the
 * snapshot never changes after creation, so a link forwarded to a friend
 * keeps working.
 *
 * Copy follows the 50+ plain-language rules: short sentences, explicit
 * instructions, no em dashes.
 */
import { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { parseAnswer, type ParsedAnswer } from "@/lib/parse-answer";
import { SLM_STANDALONE } from "@/lib/app-mode";

const BASE = import.meta.env.BASE_URL;
const SANS = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif";
const SERIF = "'Georgia','Times New Roman',serif";
const RED = "#B3261E";
const INK = "#0A0A0F";
const PAPER = "#FAF8F4";
const CARD = "#FFFFFF";
const MUTED = "rgba(10,10,15,0.64)";
const RULE = "rgba(10,10,15,0.10)";

interface PublicCitation {
  title: string;
  authors: string | null;
  year: number | null;
  journal: string | null;
  doi: string | null;
  source_url: string | null;
  pillar_slug: string;
}

interface Snapshot {
  question: string;
  answer: string;
  citations: PublicCitation[];
}

export default function AnswerLink() {
  const [, params] = useRoute("/a/:id");
  const id = params?.id ?? "";
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "missing">("loading");

  useEffect(() => {
    document.title = SLM_STANDALONE
      ? "A shared answer — Stanford Lifestyle Medicine"
      : "A shared answer — Palonur";
    const prevBg = document.body.style.background;
    document.body.style.background = PAPER;
    return () => {
      document.title = SLM_STANDALONE ? "Stanford Lifestyle Medicine" : "Palonur";
      document.body.style.background = prevBg;
    };
  }, []);

  useEffect(() => {
    if (!id) {
      setStatus("missing");
      return;
    }
    let cancelled = false;
    fetch(`${BASE}api/slm-answer-links/${encodeURIComponent(id)}`, {
      headers: { "Sec-Fetch-Site": "same-origin" },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Snapshot | null) => {
        if (cancelled) return;
        if (d && typeof d.question === "string" && typeof d.answer === "string") {
          setSnapshot({ ...d, citations: Array.isArray(d.citations) ? d.citations : [] });
          setStatus("ready");
        } else {
          setStatus("missing");
        }
      })
      .catch(() => {
        if (!cancelled) setStatus("missing");
      });
    return () => { cancelled = true; };
  }, [id]);

  const parsed: ParsedAnswer | null = snapshot ? parseAnswer(snapshot.answer) : null;

  const sectionLabel: React.CSSProperties = {
    fontSize: 10, fontWeight: 700, letterSpacing: ".2em",
    textTransform: "uppercase", color: RED, marginBottom: 6, fontFamily: SANS,
  };
  const sectionText: React.CSSProperties = {
    fontFamily: SERIF, fontSize: 17.5, lineHeight: 1.65, color: INK, margin: 0,
  };
  const divider: React.CSSProperties = {
    border: "none", borderTop: `1px solid ${RULE}`, margin: "20px 0",
  };

  return (
    <main style={{ background: PAPER, minHeight: "100vh", fontFamily: SANS }}>
      {/* Header */}
      <div style={{
        borderBottom: `1px solid ${RULE}`,
        padding: "20px clamp(20px, 5vw, 80px)",
        display: "flex", alignItems: "center", gap: 16,
      }}>
        {SLM_STANDALONE ? (
          <a href={BASE} style={{ textDecoration: "none" }}>
            <span style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 600, color: INK }}>
              Stanford Lifestyle Medicine
            </span>
          </a>
        ) : (
          <>
            <a href={BASE} style={{ textDecoration: "none", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 600, color: INK }}>Palonur</span>
            </a>
            <span style={{ color: RULE, fontSize: 18 }}>·</span>
            <span style={{ fontSize: 13, color: MUTED }}>Stanford Lifestyle Medicine</span>
          </>
        )}
      </div>

      <div style={{ maxWidth: 720, margin: "0 auto", padding: "clamp(36px, 6vh, 64px) clamp(20px, 5vw, 48px) 120px" }}>
        {status === "loading" && (
          <p style={{ fontFamily: SERIF, fontSize: 17, color: MUTED }}>Loading the answer…</p>
        )}

        {status === "missing" && (
          <div data-testid="text-answer-link-missing">
            <h1 style={{ margin: "0 0 14px", fontFamily: SERIF, fontWeight: 500, fontSize: "clamp(26px, 4vw, 36px)", color: INK }}>
              We could not find this answer.
            </h1>
            <p style={{ margin: "0 0 28px", fontFamily: SERIF, fontSize: 17, lineHeight: 1.6, color: "rgba(10,10,15,0.68)" }}>
              The link may be incomplete. Please check that the whole link was
              copied. You can still ask your own question. It is free. No
              account needed.
            </p>
            <a href={SLM_STANDALONE ? BASE : `${BASE}slm`} style={{
              display: "inline-block", background: RED, color: "#fff",
              padding: "14px 28px", borderRadius: 999, textDecoration: "none",
              fontWeight: 700, fontSize: 15,
            }}>
              Ask your own question
            </a>
          </div>
        )}

        {status === "ready" && snapshot && parsed && (
          <div>
            <div style={{
              fontSize: 11, fontWeight: 700, letterSpacing: ".18em",
              textTransform: "uppercase", color: MUTED, marginBottom: 18,
            }}>
              Someone shared this answer with you
            </div>

            <h1
              data-testid="text-answer-link-question"
              style={{
                margin: "0 0 22px", fontFamily: SERIF, fontWeight: 500,
                fontSize: "clamp(24px, 3.6vw, 34px)", lineHeight: 1.25, color: INK,
              }}
            >
              {snapshot.question}
            </h1>

            <div style={{ background: CARD, borderRadius: 18, padding: "28px 32px", border: `1px solid ${RULE}` }}>
              {parsed.uncovered ? (
                <>
                  <div style={sectionLabel}>Not yet covered</div>
                  <p style={{ ...sectionText, color: MUTED }}>{parsed.answer}</p>
                </>
              ) : (
                <>
                  {parsed.answer && (
                    <>
                      <div style={sectionLabel}>Answer</div>
                      <p data-testid="text-answer-link-answer" style={sectionText}>{parsed.answer}</p>
                    </>
                  )}
                  {parsed.finding && (
                    <>
                      <hr style={divider} />
                      <div style={sectionLabel}>Key finding</div>
                      <p style={{ ...sectionText, fontSize: 15.5 }}>{parsed.finding}</p>
                    </>
                  )}
                  {parsed.interpretation && (
                    <>
                      <hr style={divider} />
                      <div style={sectionLabel}>What this means</div>
                      <p style={{ ...sectionText, fontSize: 15.5 }}>{parsed.interpretation}</p>
                    </>
                  )}
                </>
              )}

              {snapshot.citations.length > 0 && (
                <div style={{ marginTop: 28, borderTop: `1px solid ${RULE}`, paddingTop: 18 }}>
                  <div style={{
                    fontSize: 10, fontWeight: 700, letterSpacing: ".2em",
                    textTransform: "uppercase", color: MUTED, marginBottom: 12, fontFamily: SANS,
                  }}>
                    Source
                  </div>
                  {snapshot.citations.map((c, i) => (
                    <div key={i} data-testid={`text-answer-link-citation-${i}`} style={{
                      marginBottom: 10, fontFamily: SERIF,
                      fontSize: 14, lineHeight: 1.5, color: "rgba(10,10,15,0.7)",
                    }}>
                      {c.authors && (
                        <span style={{ fontWeight: 600 }}>{c.authors}{c.year ? `, ${c.year}` : ""}. </span>
                      )}
                      {c.source_url ? (
                        <a href={c.source_url} target="_blank" rel="noopener noreferrer" style={{ color: RED, textDecoration: "none" }}>
                          {c.title}
                        </a>
                      ) : (
                        <span style={{ fontStyle: "italic" }}>{c.title}</span>
                      )}
                      {c.journal && <span style={{ color: MUTED }}>{" · "}{c.journal}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Invitation to ask your own question */}
            <div style={{
              marginTop: 32, background: CARD, borderRadius: 18,
              border: `1px solid ${RULE}`, padding: "26px 32px", textAlign: "center",
            }}>
              <p style={{
                margin: "0 0 16px", fontFamily: SERIF,
                fontSize: 18, lineHeight: 1.5, color: INK,
              }}>
                {SLM_STANDALONE
                  ? "This answer came from Stanford Lifestyle Medicine. Real faculty research, with the source shown. You can ask your own question. It is free. No account needed."
                  : "This answer came from Palonur. Real Stanford faculty research, with the source shown. You can ask your own question. It is free. No account needed."}
              </p>
              <a
                href={SLM_STANDALONE ? BASE : `${BASE}slm`}
                data-testid="link-answer-link-ask-own"
                style={{
                  display: "inline-block", background: RED, color: "#fff",
                  padding: "14px 28px", borderRadius: 999, textDecoration: "none",
                  fontWeight: 700, fontSize: 15,
                }}
              >
                Ask your own question
              </a>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
