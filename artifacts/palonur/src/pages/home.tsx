// ─── Brand home ("/") ──────────────────────────────────────────────────────────
// Palonur's front door: the pillars of lifestyle medicine, opened to end
// users. Live sky hero with one featured question, then cream chapters that
// tell the story — what Palonur is, why sleep opened first, why the science
// needs protecting, Palonur Nightly, and the machine-readable surface for AI
// agents. The sleep-specific product story lives on /sleep.
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { SkyPage } from "@/components/sky";
import { NewsletterPitch } from "@/components/newsletter-pitch";
import { SiteFooter } from "@/components/site-footer";
import { useAskGate } from "@/lib/ask-gate";
import {
  fetchLandingAuthority,
  fetchLandingFollowUp,
  LANDING_SEARCH_STAGES,
  type LandingAuthorityDemo,
  type LandingFollowUp,
} from "@/lib/landing-authority-demo";
import { LandingAuthorityDemoPanel } from "@/components/landing-authority-demo-panel";
import { useVisiblePillars } from "@/lib/pillars";
import { STEWARD_SPOTLIGHT } from "@/lib/stewards";
import { FacultyTribute } from "@/components/faculty-tribute";
import { IntroVideo } from "@/components/intro-video";
import TavusAvatarButton from "@/components/TavusAvatar";

const BASE = import.meta.env.BASE_URL;
const LANDING_STEWARD_SPOTLIGHT = STEWARD_SPOTLIGHT;
const FEATURED_QUESTION = "Why do I wake up at 3am each night?";

/* ─── Faculty headline rotation — REMOVED ─────────────────────────────────────
   The hero used to rotate faculty names on a 3s fade. Per the 50+
   plain-language rules (single static headline, no rotating text) the hero
   now shows one clear static promise.
──────────────────────────────────────────────────────────────────────────────*/

// Warm accent reserved for the promise label.

// \u2500\u2500\u2500 Hero \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
export function BrandHero() {
  const { t } = useTranslation("home");
  const SERIF = "'Georgia','Times New Roman',serif";
  const SANS  = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif";

  // ── Ask / search ──
  const [q, setQ]         = useState("");
  const [qFocus, setQFocus] = useState(false);
  const [demoStatus, setDemoStatus] = useState<"idle" | "searching" | "analyzing" | "complete" | "error">("idle");
  const [searchIndex, setSearchIndex] = useState(-1);
  const [demoQuestion, setDemoQuestion] = useState("");
  const [demoResult, setDemoResult] = useState<LandingAuthorityDemo | null>(null);
  const [demoError, setDemoError] = useState("");
  const [followUps, setFollowUps] = useState<LandingFollowUp[]>([]);
  const [followUpStatus, setFollowUpStatus] = useState<"idle" | "loading">("idle");
  const [followUpError, setFollowUpError] = useState("");

  useEffect(() => {
    if (demoStatus !== "searching") return;
    if (searchIndex >= LANDING_SEARCH_STAGES.length) {
      setDemoStatus("analyzing");
      return;
    }
    const timer = window.setTimeout(() => {
      setSearchIndex((index) => index + 1);
    }, 260);
    return () => window.clearTimeout(timer);
  }, [demoStatus, searchIndex]);

  useEffect(() => {
    if (demoStatus !== "analyzing") return;
    let cancelled = false;
    void fetchLandingAuthority(demoQuestion)
      .then((result) => {
        if (cancelled) return;
        setDemoResult(result);
        setDemoStatus("complete");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setDemoError(
          error instanceof Error
            ? error.message
            : t("landingDemo.genericError"),
        );
        setDemoStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [demoStatus, demoQuestion, t]);

  const placeholder = t("hero.placeholderDay");

  const submitAsk = (e: React.FormEvent) => {
    e.preventDefault();
    const question = q.trim();
    if (!question) return;
    setDemoQuestion(question);
    setDemoResult(null);
    setDemoError("");
    setFollowUps([]);
    setFollowUpError("");
    setSearchIndex(0);
    setDemoStatus("searching");
  };

  const submitFollowUp = async (question: string) => {
    if (!demoResult?.authority || followUpStatus === "loading") return;
    setFollowUpStatus("loading");
    setFollowUpError("");
    try {
      const followUp = await fetchLandingFollowUp({
        originalQuestion: demoResult.question,
        authorityId: demoResult.authority.id,
        topic: demoResult.topic,
        question,
      });
      setFollowUps((current) => [...current, followUp]);
    } catch (error) {
      setFollowUpError(
        error instanceof Error
          ? error.message
          : t("landingDemo.genericError"),
      );
    } finally {
      setFollowUpStatus("idle");
    }
  };

  const resetDemo = () => {
    setQ("");
    setDemoQuestion("");
    setDemoResult(null);
    setDemoError("");
    setFollowUps([]);
    setFollowUpStatus("idle");
    setFollowUpError("");
    setSearchIndex(-1);
    setDemoStatus("idle");
  };

  return (
    <div className="brand-hero" style={{
      position: "absolute", inset: 0, zIndex: 10,
      display: "flex", flexDirection: "column", alignItems: "center",
      gap: "clamp(10px, 2.2vh, 20px)",
      padding: demoStatus === "idle" ? "0 20px" : "clamp(88px, 10vh, 110px) 20px 42px",
      width: "100%", boxSizing: "border-box",
      overflowX: "hidden",
      overflowY: demoStatus === "idle" ? "hidden" : "auto",
      justifyContent: demoStatus === "idle" ? "center" : "flex-start",
      overscrollBehavior: "contain",
      WebkitOverflowScrolling: "touch",
    }}>
      {/* Wordmark — pinned upper left */}
      <div style={{
        position: "absolute",
        top: "clamp(16px, 3vh, 28px)", left: "clamp(18px, 2.5vw, 32px)",
        display: "flex", alignItems: "center", gap: "clamp(8px, 1vw, 12px)",
        filter: "drop-shadow(0 2px 18px rgba(0,0,0,0.55))",
      }}>
        <img
          src={`${BASE}palonur-flower-red.svg`}
          alt="" aria-hidden
          style={{
            width: "clamp(22px, min(3vw, 3.4vh), 32px)",
            height: "clamp(22px, min(3vw, 3.4vh), 32px)",
            opacity: 0.92, flexShrink: 0,
          }}
        />
        <div style={{
          fontFamily: SERIF,
          fontSize: "clamp(20px, min(3.2vw, 3.6vh), 32px)",
          fontWeight: 400,
          color: "rgba(255,255,255,0.95)",
          letterSpacing: "0.005em",
          textShadow: "0 1px 14px rgba(0,0,0,0.7)",
          lineHeight: 1,
        }}>
          Palonur
        </div>
      </div>

      {/* Make the counter-position the only message competing with the question field. */}
      <div style={{
        width: "min(820px, 100%)",
        textAlign: "center",
        display: demoStatus === "idle" ? "flex" : "none",
        flexDirection: "column", alignItems: "center", gap: 14,
      }}>
        <h1
          className="brand-hero-heading"
          data-testid="text-hero-headline"
          style={{
            margin: 0,
            fontFamily: SERIF,
            fontSize: "clamp(30px, 4.8vw, 56px)",
            fontWeight: 500, lineHeight: 1.02, letterSpacing: "-0.035em",
            color: "rgba(255,255,255,0.97)",
            textShadow: "0 2px 24px rgba(0,0,0,0.6)",
          }}
        >
          {t("hero.headline")}
        </h1>
        <p
          className="brand-hero-subhead"
          data-testid="text-hero-subhead"
          style={{
            margin: 0,
            maxWidth: 700,
            fontFamily: SANS,
            fontSize: "clamp(15px, 1.7vw, 19px)",
            fontWeight: 400,
            color: "rgba(255,255,255,0.78)",
            lineHeight: 1.4,
            textShadow: "0 1px 12px rgba(0,0,0,0.6)",
          }}
        >
          {t("hero.subhead")}
        </p>
      </div>

      {/* The form is the live product demonstration and the only primary CTA. */}
      <div
        className="brand-hero-ask-label"
        id="hero-ask-label"
        style={{
          width: "min(760px, 100%)",
          boxSizing: "border-box",
          padding: "0 4px",
          display: demoStatus === "idle" ? "block" : "none",
          fontFamily: SANS,
          fontSize: 15,
          fontWeight: 700,
          color: "rgba(255,255,255,0.9)",
          textShadow: "0 1px 10px rgba(0,0,0,0.5)",
        }}
      >
        {t("hero.askLabel")}
      </div>
      <form
        onSubmit={submitAsk}
        data-testid="form-hero-ask"
        className="brand-hero-form pill-focus"
        aria-labelledby="hero-ask-label"
        style={{
          width: "min(760px, 100%)",
          boxSizing: "border-box",
          background: "#FFFDF9",
          borderRadius: 20,
          padding: 5,
          border: "1px solid rgba(255,255,255,0.24)",
          boxShadow: qFocus
            ? "0 22px 48px -14px rgba(0,0,0,0.58), 0 0 0 3px rgba(255,255,255,0.12)"
            : "0 16px 34px -12px rgba(0,0,0,0.48), 0 0 0 1px rgba(255,255,255,0.1)",
          transform: qFocus ? "translateY(-2px)" : "translateY(0)",
          transition: "transform 0.35s ease, box-shadow 0.35s ease",
          display: demoStatus === "idle" ? "flex" : "none",
          flexDirection: "column",
        }}
      >
        <div style={{
          borderRadius: 14,
          border: "1px solid rgba(0,0,0,0.06)",
          background: "#FFFDF9",
          display: "flex", flexDirection: "column",
          position: "relative", overflow: "hidden",
        }}>
          <input
            className="brand-hero-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => setQFocus(true)}
            onBlur={() => setQFocus(false)}
            placeholder={placeholder}
            aria-label={t("hero.inputLabel")}
            data-testid="input-hero-ask"
            autoFocus
            required
            style={{
              border: "none", outline: "none",
              fontSize: "clamp(16px, 2vw, 22px)",
              color: "#1C1A19", background: "transparent",
              fontFamily: SERIF,
              fontWeight: 400, lineHeight: 1.5,
              padding: "34px 26px 22px",
              caretColor: "#B3261E",
            }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 14px 22px 26px" }}>
            <span
              className="brand-hero-free-line"
              data-testid="text-hero-free-line"
              style={{
                fontFamily: SANS, fontSize: 13.5, color: "rgba(28,26,25,0.6)",
                fontWeight: 600, letterSpacing: "0.01em", lineHeight: 1.4,
              }}
            >
              {t("hero.freeLine")}
            </span>
            <button
              type="submit"
              disabled={!q.trim()}
              aria-label={t("hero.askButton")}
              data-testid="button-hero-ask"
              className="brand-hero-submit"
              style={{
                height: 44, minWidth: 112, padding: "0 16px", borderRadius: 999, border: "none",
                background: q.trim() ? "#B3261E" : "#EBE7DF",
                color: q.trim() ? "#fff" : "rgba(28,26,25,0.52)",
                cursor: q.trim() ? "pointer" : "not-allowed",
                display: "flex", alignItems: "center", justifyContent: "center",
                gap: 7,
                fontFamily: SANS, fontSize: 13, fontWeight: 750,
                transition: "all 0.4s cubic-bezier(0.16, 1, 0.3, 1)",
                boxShadow: q.trim() ? "0 4px 16px rgba(232, 53, 42, 0.4), inset 0 -2px 0 rgba(0,0,0,0.15)" : "none",
                transform: q.trim() && qFocus ? "scale(1.05)" : "scale(1)",
                flexShrink: 0,
              }}
            >
              <span>{t("hero.askButton")}</span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="5 12 12 5 19 12" />
              </svg>
            </button>
          </div>
        </div>
      </form>

      {demoStatus !== "idle" ? (
        <LandingAuthorityDemoPanel
          status={demoStatus}
          searchIndex={searchIndex}
          question={demoQuestion}
          result={demoResult}
          error={demoError}
          followUps={followUps}
          followUpStatus={followUpStatus}
          followUpError={followUpError}
          onFollowUp={submitFollowUp}
          onReset={resetDemo}
        />
      ) : (
        <a
          className="brand-hero-how"
          href="#how-it-works"
          data-testid="link-hero-how-it-works"
          onClick={(e) => {
            e.preventDefault();
            document.getElementById("how-it-works")?.scrollIntoView({ behavior: "smooth" });
          }}
          style={{
            fontFamily: SANS, fontSize: 13.5, fontWeight: 600,
            letterSpacing: "0.04em",
            color: "rgba(255,255,255,0.66)",
            textDecoration: "underline",
            textUnderlineOffset: 4,
            textDecorationColor: "rgba(255,255,255,0.3)",
            marginTop: 2,
          }}
        >
          {t("hero.ctaHow")}
        </a>
      )}
    </div>
  );
}


function BrandBelowFold() {
  const visiblePillars = useVisiblePillars();
  // Keep every question CTA on the Palonur landing page on the general
  // authority-router path, not the ASLM-only /slm surface.
  const { ask, gate } = useAskGate({ target: "sleep" });
  const stewardPhotos: Record<string, string> = {};
  const { t, i18n } = useTranslation("home");
  const lang = i18n.language;
  const _ = lang; // consumed to re-render on language change
  const renderWithEm = (s: string, emStyle?: React.CSSProperties) => {
    const parts = s.split(/\{\{em\}\}(.*?)\{\{\/em\}\}/);
    if (parts.length === 1) return <>{s}</>;
    return <>{parts[0]}<em style={{ fontStyle: "italic", fontFamily: SERIF, ...(emStyle ?? {}) }}>{parts[1]}</em>{parts[2]}</>;
  };

  // Karen Parker early-access form state
  const [karenEmail, setKarenEmail] = useState("");
  const [karenQ, setKarenQ] = useState("");
  const [karenSubmitted, setKarenSubmitted] = useState(false);
  const [karenLoading, setKarenLoading] = useState(false);

  const handleKarenSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!karenEmail.trim()) return;
    setKarenLoading(true);
    try {
      await fetch(`${BASE}api/newsletter/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: karenEmail.trim(), source: 'karen-parker-pillar' }),
      });
    } catch {
      // degrade silently — confirmation state still shows
    }
    setKarenSubmitted(true);
    setKarenLoading(false);
  };

  const SANS  = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif";
  const SERIF = "'Georgia','Times New Roman',serif";
  const RED   = "#B3261E";
  const RED_DARK = "#FF7A6E"; // accessible red on dark chapters (4.5:1+)
  const INK   = "#0A0A0F";
  const PAPER = "#FAF8F4";
  const BLUSH = "#F4EAE5";
  const RULE  = "rgba(10,10,15,0.12)";
  const MUTED = "rgba(10,10,15,0.64)";

  const chapter: React.CSSProperties = {
    minHeight: "92vh",
    padding: "clamp(72px, 12vh, 140px) clamp(24px, 6vw, 96px)",
    display: "flex", alignItems: "center",
    borderBottom: `1px solid ${RULE}`,
    background: PAPER,
  };
  const inner: React.CSSProperties = {
    width: "100%", maxWidth: 1100, margin: "0 auto",
  };
  const eyebrow: React.CSSProperties = {
    fontSize: 11, fontWeight: 700, letterSpacing: ".24em",
    textTransform: "uppercase", color: RED, marginBottom: 28,
  };
  const headline: React.CSSProperties = {
    margin: "0 0 28px",
    fontFamily: SERIF, fontWeight: 500,
    fontSize: "clamp(34px, 5vw, 60px)",
    lineHeight: 1.06, letterSpacing: "-0.018em",
    color: INK, maxWidth: 780,
  };
  const body: React.CSSProperties = {
    margin: 0, maxWidth: 620,
    fontFamily: SERIF,
    fontSize: "clamp(17px, 1.5vw, 19px)",
    lineHeight: 1.6, color: "rgba(10,10,15,0.72)",
  };
  const italic = (s: string) => (
    <em style={{ fontStyle: "italic", fontFamily: SERIF }}>{s}</em>
  );
  const redPill: React.CSSProperties = {
    display: "inline-flex", alignItems: "center", gap: 8,
    background: RED, color: "#fff",
    padding: "14px 24px", borderRadius: 999,
    textDecoration: "none", fontWeight: 700, fontSize: 14,
    letterSpacing: "0.02em", fontFamily: SANS, border: "none",
    cursor: "pointer",
  };
  const inkPill: React.CSSProperties = {
    ...redPill, background: INK,
  };

  return (
    <section id="story" style={{ background: PAPER, color: INK, fontFamily: SANS }}>

      <FacultyTribute />

      <IntroVideo />

      {/* ─── S1 · How it works ── */}
      <div style={chapter} id="how-it-works" data-testid="section-how-it-works">
        <div style={inner}>
          <div style={eyebrow}>{t("how.eyebrow")}</div>
          <h2 style={{ ...headline, fontSize: "clamp(38px, 5.5vw, 68px)", maxWidth: 840 }}>{renderWithEm(t("how.headline"))}</h2>

          <p style={{ ...body, marginBottom: 48, fontSize: "clamp(18px, 1.8vw, 22px)", maxWidth: 760 }}>
            {t("how.intro")}
          </p>

          <div
            style={{
              marginBottom: 40,
              borderRadius: 24,
              overflow: "hidden",
              boxShadow: "0 16px 64px rgba(10,10,15,0.10)",
              lineHeight: 0,
            }}
          >
            <img
              src={`${BASE}lecture-hall.jpg`}
              alt="A faculty member addresses a packed historic university lecture hall — your expertise, on your terms"
              style={{
                width: "100%",
                display: "block",
                borderRadius: 24,
                objectFit: "cover",
                maxHeight: 480,
              }}
              loading="lazy"
              decoding="async"
            />
          </div>

          {/* Flow diagram: work → protected layer → answers → channels.
              Pure markup in the page palette — crisp at any size, translates
              with the rest of the page. */}
          <div
            data-testid="diagram-how-flow"
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "stretch",
              justifyContent: "center",
              gap: 14,
              marginBottom: 56,
              maxWidth: 980,
            }}
          >
            {([
              { title: t("how.diagram.source"), sub: t("how.diagram.sourceSub"), accent: false },
              { title: t("how.diagram.vault"), sub: t("how.diagram.vaultSub"), accent: true },
              { title: t("how.diagram.out"), sub: t("how.diagram.outSub"), accent: false },
            ] as const).map((node, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 14, flex: "1 1 240px", minWidth: 240 }}>
                <div
                  style={{
                    flex: 1,
                    background: node.accent ? INK : "#fff",
                    border: `1px solid ${node.accent ? INK : RULE}`,
                    borderRadius: 18,
                    padding: "22px 22px",
                    textAlign: "center" as const,
                    boxShadow: "0 8px 32px rgba(10,10,15,0.04)",
                  }}
                >
                  <div style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 600, lineHeight: 1.3, color: node.accent ? "#fff" : INK }}>
                    {node.title}
                  </div>
                  <div style={{ fontFamily: SANS, fontSize: 13, marginTop: 6, color: node.accent ? "rgba(255,255,255,0.72)" : "rgba(10,10,15,0.6)" }}>
                    {node.sub}
                  </div>
                </div>
                {i < 2 && (
                  <div aria-hidden style={{ fontFamily: SANS, fontSize: 20, color: RED, fontWeight: 700 }}>→</div>
                )}
              </div>
            ))}
            <div style={{ flexBasis: "100%", display: "flex", justifyContent: "center", gap: 10, marginTop: 4, flexWrap: "wrap" }}>
              {(t("how.diagram.channels", { returnObjects: true }) as string[]).map((c) => (
                <span
                  key={c}
                  style={{
                    fontFamily: SANS,
                    fontSize: 13.5,
                    fontWeight: 600,
                    color: INK,
                    border: `1px solid ${RULE}`,
                    background: "#fff",
                    borderRadius: 999,
                    padding: "7px 16px",
                  }}
                >
                  {c}
                </span>
              ))}
            </div>
          </div>

          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: 22,
            marginBottom: 64,
          }}>
            {(["boundaries", "retrieval", "named", "gaps", "noTraining", "reach"] as const).map((key, i) => (
              <div key={key} data-testid={`item-story-step-${key}`} style={{
                background: "#fff",
                border: `1px solid ${RULE}`,
                borderRadius: 20,
                padding: "36px 32px",
                boxShadow: "0 8px 32px rgba(10,10,15,0.03)",
                display: "flex", flexDirection: "column", gap: 14
              }}>
                <div style={{
                  fontFamily: SANS, fontSize: 13, fontWeight: 700,
                  color: RED, letterSpacing: ".1em",
                }}>
                  {String(i + 1).padStart(2, "0")}
                </div>
                <div style={{
                  fontFamily: SERIF, fontSize: 20, fontWeight: 600, color: INK, lineHeight: 1.25
                }}>
                  {t(`how.steps.${key}.title`)}
                </div>
                <div style={{
                  fontFamily: SERIF, fontSize: 16, lineHeight: 1.6, color: "rgba(10,10,15,0.7)"
                }}>
                  {t(`how.steps.${key}.text`)}
                </div>
              </div>
            ))}
          </div>

          {/* Steward CTA — moved out of the hero */}
          <div style={{ marginBottom: 64 }}>
            <a
              href="#apply-steward"
              data-testid="link-how-apply-steward"
              onClick={(e) => {
                e.preventDefault();
                document.getElementById("apply-steward")?.scrollIntoView({ behavior: "smooth" });
              }}
              style={redPill}
            >
              {t("hero.ctaApply")}
            </a>
          </div>

          {/* Showcase: the Stanford Lifestyle Medicine entry field */}
          <div style={{ marginBottom: 20, maxWidth: 720 }} data-testid="showcase-slm-entry">
            <div style={{
              fontFamily: SANS, fontSize: 12, fontWeight: 700,
              letterSpacing: ".14em", color: "rgba(10,10,15,0.64)",
              textTransform: "uppercase" as const, marginBottom: 14,
            }}>
              {t("story.slm.eyebrow")}
            </div>
            <button
              onClick={() => ask(FEATURED_QUESTION)}
              data-testid="button-slm-entry-showcase"
              style={{
                width: "100%", textAlign: "left" as const, cursor: "pointer",
                background: "#fff",
                border: `1.5px solid rgba(10,10,15,0.14)`,
                borderRadius: 22,
                padding: "22px 26px",
                boxShadow: "0 14px 40px rgba(10,10,15,0.10)",
                display: "flex", alignItems: "center", gap: 16,
              }}
            >
              <span style={{
                flex: 1, fontFamily: SERIF, fontSize: "clamp(16px, 1.6vw, 20px)",
                color: "rgba(10,10,15,0.62)", fontStyle: "italic" as const,
              }}>
                {t("story.slm.placeholder")}
              </span>
              <span aria-hidden style={{
                width: 40, height: 40, borderRadius: 999, flexShrink: 0,
                background: RED, color: "#fff", display: "inline-flex",
                alignItems: "center", justifyContent: "center", fontSize: 18,
              }}>
                ↑
              </span>
            </button>
            <p style={{
              margin: "12px 4px 0", fontFamily: SANS, fontSize: 13,
              color: "rgba(10,10,15,0.64)", lineHeight: 1.55,
            }}>
              {t("story.slm.caption")}
            </p>
          </div>

          <div
            data-testid="section-neuroscience-coming-soon"
            style={{
              maxWidth: 720,
              marginTop: 44,
              paddingTop: 34,
              borderTop: `1px solid ${RULE}`,
            }}
          >
            <div style={{ ...eyebrow, marginBottom: 18 }}>
              {t("karen.launchEyebrow")}
            </div>
            <h3
              style={{
                margin: "0 0 18px",
                maxWidth: 660,
                fontFamily: SERIF,
                fontSize: "clamp(30px, 4vw, 48px)",
                fontWeight: 500,
                lineHeight: 1.08,
                letterSpacing: "-0.02em",
                color: INK,
              }}
            >
              {renderWithEm(t("karen.headline"))}
            </h3>
            <p style={{ ...body, marginBottom: 18 }}>
              {t("karen.body1")}
            </p>
            <div
              style={{
                fontFamily: SANS,
                fontSize: 12.5,
                fontWeight: 700,
                letterSpacing: ".04em",
                color: RED,
              }}
            >
              {t("karen.launchAttribution")}
            </div>
          </div>
        </div>
      </div>

      {/* ─── 03b · What an answer looks like — sample answer ─────────────── */}
      <div style={chapter} data-testid="section-sample-answer">
        <div style={inner}>
          <div style={eyebrow}>{t("sampleAnswer.eyebrow")}</div>
          <h2 style={headline}>
            {renderWithEm(t("sampleAnswer.headline"))}
          </h2>

          <div style={{
            maxWidth: 720,
            background: "#fff",
            border: `1px solid ${RULE}`,
            borderRadius: 22,
            padding: "clamp(24px, 4vw, 44px)",
            boxShadow: "0 16px 48px rgba(10,10,15,0.07)",
            marginBottom: 32,
          }}>
            {/* The question */}
            <div style={{
              fontFamily: SERIF, fontStyle: "italic",
              fontSize: "clamp(19px, 2vw, 24px)", lineHeight: 1.35,
              color: INK, marginBottom: 24,
            }}>
              “{t("sampleAnswer.question")}”
            </div>
            <div style={{ height: 1, background: RULE, marginBottom: 24 }} />

            {/* The answer */}
            <p style={{ ...body, maxWidth: "none", marginBottom: 16 }}>
              {t("sampleAnswer.answer1")}
            </p>
            <p style={{ ...body, maxWidth: "none", marginBottom: 24 }}>
              {t("sampleAnswer.answer2")}
              <sup style={{ color: RED, fontWeight: 700, fontFamily: SANS, fontSize: 12 }}> [1]</sup>
            </p>

            {/* Citation card */}
            <div style={{
              background: "rgba(232,53,42,0.04)",
              border: `1px solid rgba(232,53,42,0.18)`,
              borderRadius: 14,
              padding: "14px 18px",
              marginBottom: 24,
            }}>
              <div style={{
                fontSize: 10, fontWeight: 800, letterSpacing: ".18em",
                textTransform: "uppercase", color: RED, marginBottom: 6,
              }}>
                [1] · {t("sampleAnswer.citationLabel")}
              </div>
              <div style={{
                fontFamily: SERIF, fontSize: 15.5, lineHeight: 1.45,
                color: INK, marginBottom: 4,
              }}>
                {t("sampleAnswer.citationTitle")}
              </div>
              <div style={{ fontSize: 12.5, color: MUTED, fontFamily: SANS }}>
                {t("sampleAnswer.citationMeta")}
              </div>
            </div>

            {/* Signature */}
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <img
                src={`${BASE}stewards/zeitzer.png`}
                alt={t("sampleAnswer.signedBy")}
                loading="lazy"
                style={{
                  width: 52, height: 52, borderRadius: "50%",
                  objectFit: "cover", border: `1px solid ${RULE}`,
                }}
              />
              <div>
                <div style={{
                  fontFamily: SERIF, fontSize: 16.5, fontWeight: 600, color: INK,
                }}>
                  {t("sampleAnswer.signedBy")}
                </div>
                <div style={{ fontSize: 12.5, color: MUTED, fontFamily: SANS }}>
                  {t("sampleAnswer.signedRole")}
                </div>
              </div>
            </div>
          </div>

          <p style={{ ...body, marginBottom: 32 }}>
            {t("sampleAnswer.note")}
          </p>

          <a
            href="#top"
            onClick={(e) => {
              e.preventDefault();
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
            style={redPill}
            data-testid="link-sample-ask"
          >
            {t("sampleAnswer.cta")}
          </a>
        </div>
      </div>

      {/* ─── S3 · Benefits — the four value-prop pairs ────────────────────── */}
      <div style={{ ...chapter, background: BLUSH, position: "relative", overflow: "hidden" }} id="benefits" data-testid="section-benefits">
        <div style={inner}>
          <div style={eyebrow}>{t("benefits.eyebrow")}</div>
          <h2 style={{ ...headline, fontSize: "clamp(38px, 5.5vw, 68px)", maxWidth: 840 }}>{renderWithEm(t("benefits.headline"))}</h2>
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: 22, marginTop: 32,
          }}>
            {(["scale", "governance", "identity", "trust"] as const).map((key) => (
              <div key={key} data-testid={`card-benefit-${key}`} style={{
                background: "#fff",
                border: `1px solid ${RULE}`,
                borderRadius: 18,
                padding: "26px 24px",
                boxShadow: "0 4px 16px rgba(10,10,15,0.04)",
              }}>
                <div style={{
                  fontFamily: SERIF, fontSize: 20, fontWeight: 600,
                  color: INK, marginBottom: 10,
                }}>
                  {t(`benefits.cards.${key}.title`)}
                </div>
                <p style={{
                  margin: 0, fontFamily: SERIF, fontSize: 15,
                  lineHeight: 1.6, color: "rgba(10,10,15,0.68)",
                }}>
                  {t(`benefits.cards.${key}.text`)}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ─── S3b · "How AI sees you" — steward visibility report feature ──── */}
      {/* Illustrative example card only: no live steward data is ever shown
          publicly. The real reports live inside the faculty portal. */}
      <div style={{ ...chapter }} id="ai-visibility" data-testid="section-ai-visibility">
        <div style={inner}>
          <div style={eyebrow}>{t("aiVisibility.eyebrow")}</div>
          <h2 style={{ ...headline, fontSize: "clamp(38px, 5.5vw, 68px)", maxWidth: 840 }}>
            {renderWithEm(t("aiVisibility.headline"))}
          </h2>
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
            gap: 40, marginTop: 12, alignItems: "start",
          }}>
            <div>
              <p style={{ ...body, marginBottom: 18 }}>{t("aiVisibility.body1")}</p>
              <p style={{ ...body, marginBottom: 18 }}>{t("aiVisibility.body2")}</p>
              <p style={{ ...body }}>{t("aiVisibility.body3")}</p>
              <a
                href="#apply-steward"
                data-testid="link-ai-visibility-apply"
                onClick={(e) => {
                  e.preventDefault();
                  document.getElementById("apply-steward")?.scrollIntoView({ behavior: "smooth" });
                }}
                style={{ ...inkPill, marginTop: 26 }}
              >
                {t("aiVisibility.cta")}
              </a>
            </div>
            {/* Illustrative example report card */}
            <div data-testid="card-ai-visibility-example" style={{
              background: "#fff",
              border: `1px solid ${RULE}`,
              borderRadius: 18,
              padding: "26px 24px",
              boxShadow: "0 8px 28px rgba(10,10,15,0.07)",
            }}>
              <div style={{
                fontSize: 10, fontWeight: 700, letterSpacing: ".18em",
                textTransform: "uppercase", color: MUTED, marginBottom: 14,
              }}>
                {t("aiVisibility.example.label")}
              </div>
              <div style={{ fontFamily: SERIF, fontSize: 19, fontWeight: 600, color: INK, marginBottom: 6 }}>
                {t("aiVisibility.example.title")}
              </div>
              <div style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 15.5, color: "rgba(10,10,15,0.68)", marginBottom: 18 }}>
                “{t("aiVisibility.example.question")}”
              </div>
              {(["a", "b"] as const).map((k) => (
                <div key={k} style={{
                  borderTop: `1px solid ${RULE}`, padding: "14px 0",
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: INK }}>
                      {t(`aiVisibility.example.rows.${k}.assistant`)}
                    </span>
                    <span style={{
                      fontSize: 11, fontWeight: 700,
                      color: k === "a" ? "#9A3B00" : "#9A3B00",
                      background: "#FBEEE4", borderRadius: 999, padding: "2px 10px",
                      whiteSpace: "nowrap",
                    }}>
                      {t(`aiVisibility.example.rows.${k}.verdict`)}
                    </span>
                  </div>
                  <p style={{ margin: 0, fontFamily: SERIF, fontSize: 14, lineHeight: 1.55, color: "rgba(10,10,15,0.68)" }}>
                    {t(`aiVisibility.example.rows.${k}.finding`)}
                  </p>
                </div>
              ))}
              <div style={{
                borderTop: `1px solid ${RULE}`, paddingTop: 14,
                fontSize: 13, fontFamily: SERIF, color: INK, lineHeight: 1.55,
              }}>
                <span style={{ fontWeight: 700 }}>{t("aiVisibility.example.afterLabel")} </span>
                {t("aiVisibility.example.afterText")}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ─── 04 · The stewards — spotlight, dark chapter ─────────────────── */}
      {false && <div
        id="stewards"
        data-testid="chapter-stewards"
        style={{ ...chapter, background: "#0A0A0F", color: "#F5F1EA" }}
      >
        <div style={inner}>
          <div style={{ ...eyebrow, color: RED_DARK }}>{t("stewards.eyebrow")}</div>
          <h2 style={{ ...headline, color: "#F5F1EA", fontSize: "clamp(38px, 5.5vw, 68px)", maxWidth: 840 }}>
            {renderWithEm(t("stewards.headline"))}
          </h2>
          <p style={{ ...body, color: "rgba(245,241,234,0.78)", marginBottom: 12 }}>{t("stewards.body")}</p>
          <p style={{ ...body, color: "rgba(245,241,234,0.78)", marginBottom: 44 }}>{t("stewards.body2")}</p>

          <div>
            {LANDING_STEWARD_SPOTLIGHT.map((s, i) => {
              const photo = stewardPhotos[s.surname] ?? s.photoUrl;
              const initials = s.name.split(" ").map((w) => w[0]).join("");
              return (
                <div
                  key={s.surname}
                  data-testid={`card-steward-${s.surname.toLowerCase()}`}
                  style={{
                    display: "flex", flexWrap: "wrap",
                    gap: "26px 36px", alignItems: "flex-start",
                    padding: "40px 0",
                    borderTop: "1px solid rgba(255,255,255,0.12)",
                    borderBottom: i === LANDING_STEWARD_SPOTLIGHT.length - 1
                      ? "1px solid rgba(255,255,255,0.12)"
                      : "none",
                  }}
                >
                  {photo ? (
                    <img
                      src={photo}
                      alt={s.name}
                      loading="lazy"
                      style={{
                        width: 136, height: 136, borderRadius: "50%",
                        objectFit: "cover",
                        border: "1px solid rgba(255,255,255,0.18)",
                        display: "block", flexShrink: 0,
                      }}
                    />
                  ) : (
                    <div
                      aria-hidden
                      style={{
                        width: 136, height: 136, borderRadius: "50%",
                        border: "1px solid rgba(255,255,255,0.18)",
                        background: "rgba(232,53,42,0.14)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontFamily: SERIF, fontSize: 38, fontWeight: 600,
                        color: "rgba(245,241,234,0.85)",
                        flexShrink: 0,
                      }}
                    >
                      {initials}
                    </div>
                  )}
                  <div style={{ flex: 1, minWidth: 280 }}>
                    <div style={{
                      fontFamily: SANS, fontSize: 12, fontWeight: 700,
                      letterSpacing: ".14em", color: "rgba(245,241,234,0.68)",
                      marginBottom: 10,
                    }}>
                      {String(i + 1).padStart(2, "0")}
                    </div>
                    <div style={{
                      fontFamily: SERIF, fontSize: "clamp(24px, 2.2vw, 30px)",
                      fontWeight: 600,
                      color: "#F5F1EA", lineHeight: 1.2, marginBottom: 6,
                    }}>
                      {s.name}
                      <span style={{
                        fontFamily: SANS, fontSize: 13, fontWeight: 600,
                        color: "rgba(245,241,234,0.72)", marginLeft: 10,
                      }}>
                        {s.credentials}
                      </span>
                    </div>
                    <div style={{
                      fontFamily: SANS, fontSize: 13, fontWeight: 600,
                      letterSpacing: ".02em", color: RED_DARK,
                      lineHeight: 1.45, marginBottom: 14,
                    }}>
                      {t(`stewards.spotlight.${s.surname.toLowerCase()}.title`, { defaultValue: s.title })}
                    </div>
                    <p style={{
                      margin: "0 0 20px", fontFamily: SERIF,
                      fontSize: "clamp(15.5px, 1.35vw, 17px)",
                      lineHeight: 1.65, color: "rgba(245,241,234,0.72)",
                      maxWidth: 640,
                    }}>
                      {t(`stewards.spotlight.${s.surname.toLowerCase()}.blurb`, { defaultValue: s.blurb })}
                    </p>
                    {s.href ? (
                      <a
                        href={s.href}
                        data-testid={`link-steward-${s.surname.toLowerCase()}`}
                        style={{
                          fontFamily: SANS, fontSize: 13.5, fontWeight: 700,
                          letterSpacing: ".03em", color: "#F5F1EA",
                          textDecoration: "none",
                          borderBottom: `2px solid ${RED}`,
                          paddingBottom: 2, display: "inline-block",
                        }}
                      >
                        {t(`stewards.spotlight.${s.surname.toLowerCase()}.linkLabel`, { defaultValue: s.linkLabel ?? "" })}
                      </a>
                    ) : (
                      <span
                        data-testid={`badge-steward-${s.surname.toLowerCase()}`}
                        style={{
                          fontFamily: SANS, fontSize: 12, fontWeight: 700,
                          letterSpacing: ".08em", textTransform: "uppercase",
                          color: "rgba(245,241,234,0.5)",
                          border: "1px solid rgba(255,255,255,0.18)",
                          borderRadius: 999, padding: "6px 14px",
                          display: "inline-block",
                        }}
                      >
                        {t(`stewards.spotlight.${s.surname.toLowerCase()}.comingSoon`, { defaultValue: s.comingSoon ?? "" })}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <a
            href={`${import.meta.env.BASE_URL}stewards`}
            data-testid="link-all-stewards"
            style={{
              marginTop: 28,
              display: "inline-block",
              fontFamily: SANS, fontSize: 13.5, fontWeight: 700,
              letterSpacing: ".03em", color: "#F5F1EA",
              textDecoration: "none",
              borderBottom: `2px solid ${RED}`, paddingBottom: 2,
            }}
          >
            {t("stewards.viewAll")}
          </a>


          {/* Peer CTA — join these colleagues (quiet text link, not a button) */}
          <div style={{ marginTop: 40 }}>
            <a
              href="#apply-steward"
              data-testid="link-stewards-apply"
              onClick={(e) => {
                e.preventDefault();
                document.getElementById("apply-steward")?.scrollIntoView({ behavior: "smooth" });
              }}
              style={{
                fontFamily: SERIF, fontSize: "clamp(18px, 2vw, 24px)", fontStyle: "italic",
                color: "#F5F1EA", textDecoration: "underline",
                textUnderlineOffset: 6, textDecorationColor: RED,
              }}
            >
              {t("stewards.joinCta")}
            </a>
          </div>

        </div>
      </div>}

      {/* ─── S5 · Apply to become a steward — interest form ──────────────── */}
      <div style={chapter} id="apply-steward" data-testid="section-apply-steward">
        <div style={inner}>
          <div style={eyebrow}>{t("applyForm.eyebrow")}</div>
          <h2 style={headline}>{renderWithEm(t("applyForm.headline"))}</h2>
          <p style={{ ...body, marginBottom: 40 }}>{t("applyForm.body")}</p>
          <div
            data-testid="card-steward-apply"
            style={{
              maxWidth: 620,
              background: "#fff",
              border: `1px solid ${RULE}`,
              borderRadius: 22,
              padding: "clamp(24px, 3.4vw, 40px)",
              boxShadow: "0 12px 36px rgba(10,10,15,0.07)",
              display: "flex", flexDirection: "column", gap: 18,
            }}
          >
            <ol style={{
              margin: 0, paddingLeft: 22, listStyle: "decimal",
              fontFamily: SANS, fontSize: 14.5, lineHeight: 1.7,
              color: "rgba(10,10,15,0.72)",
              display: "flex", flexDirection: "column", gap: 6,
            }}>
              <li>{t("applyForm.steps.apply")}</li>
              <li>{t("applyForm.steps.verify")}</li>
              <li>{t("applyForm.steps.admit")}</li>
            </ol>
            <a
              href="/faculty/sign-up"
              data-testid="link-steward-apply"
              style={{ ...redPill, justifyContent: "center" }}
            >
              {t("applyForm.cta")}
            </a>
            <p style={{
              margin: 0, fontFamily: SANS, fontSize: 12,
              color: "rgba(10,10,15,0.62)", lineHeight: 1.5,
            }}>
              {t("applyForm.note")}
            </p>
          </div>
        </div>
      </div>

      {/* ─── 01 · What Palonur is — the pillars, illustrated ─────────────── */}
      <div style={chapter}>
        <div style={inner}>
          <div style={eyebrow}>{t("pillars.eyebrow")}</div>
          <h2 style={headline}>
            {renderWithEm(t("pillars.headline"))}
          </h2>
          <p style={{ ...body, marginBottom: 20 }}>{t("pillars.body1")}</p>
          <p style={{ ...body, marginBottom: 44 }}>{t("pillars.body2")}</p>

          {/* Pillar grid with illustrations */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 18, marginBottom: 40,
          }}>
            {visiblePillars.map((p) => (
              <div
                key={p.slug}
                data-testid={`card-pillar-${p.slug}`}
                style={{
                  background: "#fff",
                  border: `1px solid ${RULE}`,
                  borderRadius: 18,
                  padding: "22px 20px",
                  boxShadow: "0 4px 16px rgba(10,10,15,0.04)",
                }}
              >
                {p.stewardPhoto ? (
                  <img
                    src={p.stewardPhoto}
                    alt={p.steward ?? ""}
                    loading="lazy"
                    style={{
                      width: 64, height: 64, marginBottom: 14, display: "block",
                      objectFit: "cover", borderRadius: "50%",
                      boxShadow: "0 2px 8px rgba(10,10,15,0.12)",
                    }}
                  />
                ) : (
                  <div style={{
                    width: 64, height: 64, borderRadius: "50%",
                    background: "rgba(232,53,42,0.10)",
                    border: "1.5px solid rgba(232,53,42,0.22)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    marginBottom: 14, flexShrink: 0,
                    fontFamily: SERIF, fontSize: 20, fontWeight: 600,
                    color: RED, letterSpacing: "0.02em",
                  }}>
                    {(p.steward ?? p.name)
                      .replace(/,.*/, "")
                      .replace(/^Dr\.?\s+/i, "")
                      .replace(/^Drs\.?\s+/i, "")
                      .split(/\s+/)
                      .filter((w) => /^[A-Z]/.test(w))
                      .slice(0, 2)
                      .map((w) => w[0])
                      .join("")}
                  </div>
                )}
                <div style={{ marginBottom: 8 }}>
                  <div style={{
                    fontFamily: SERIF, fontSize: 19, fontWeight: 600, color: INK,
                    lineHeight: 1.2,
                  }}>
                    {t(`pillars.cards.${p.slug}.name`, { defaultValue: p.name })}
                  </div>
                  {p.steward && (
                    <div style={{
                      fontFamily: SANS, fontSize: 11, fontWeight: 600,
                      letterSpacing: ".04em", color: RED,
                      marginTop: 4,
                    }}>
                      {p.steward}
                    </div>
                  )}
                </div>
                <p style={{
                  margin: "0 0 12px", fontFamily: SERIF, fontSize: 14,
                  lineHeight: 1.5, color: "rgba(10,10,15,0.62)",
                }}>
                  {t(`pillars.cards.${p.slug}.description`, { defaultValue: p.description })}
                </p>
                {p.live && p.href ? (
                  <a
                    href={p.href}
                    data-testid={`link-topic-${p.slug}`}
                    style={{
                      fontFamily: SANS, fontSize: 12, fontWeight: 700,
                      letterSpacing: ".04em", color: RED, textDecoration: "none",
                    }}
                  >
                    {t(`pillars.cards.${p.slug}.linkLabel`, { defaultValue: t("pillars.askQuestion") })}
                  </a>
                ) : (
                  <a
                    href={`${BASE}t/${p.slug}`}
                    data-testid={`link-topic-${p.slug}`}
                    style={{
                      fontFamily: SANS, fontSize: 12, fontWeight: 700,
                      letterSpacing: ".04em", color: INK, textDecoration: "none",
                    }}
                  >
                    {t("pillars.exploreTopic")}
                  </a>
                )}
              </div>
            ))}

          </div>

          <a href={`${BASE}pillars`} style={inkPill} data-testid="link-all-pillars">
            {t("pillars.exploreAll")}
          </a>
        </div>
      </div>

      {/* ─── 02 · Sleep opened first ─────────────────────────────────────── */}
      {false && <div style={{ ...chapter, background: BLUSH }}>
        <div style={{
          ...inner,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
          gap: "clamp(36px, 5vw, 80px)",
          alignItems: "center",
        }}>
          <div>
            <div style={eyebrow}>{t("sleep.eyebrow")}</div>
            <h2 style={headline}>
              {renderWithEm(t("sleep.headline"))}
            </h2>
            <p style={{ ...body, marginBottom: 20 }}>
              {t("sleep.body1")}
            </p>
            <p style={{ ...body, marginBottom: 32 }}>
              {t("sleep.body2")}
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center" }}>
              <a href={`${BASE}sleep`} style={redPill} data-testid="link-sleep-pillar">
                {t("sleep.visitSleep")}
              </a>
              <button
                onClick={() => ask(FEATURED_QUESTION)}
                style={{
                  background: "none", border: "none", cursor: "pointer",
                  fontFamily: SANS, fontSize: 13, fontWeight: 600,
                  color: "rgba(10,10,15,0.6)", textDecoration: "underline",
                  padding: 0,
                }}
              >
                {t("sleep.orAsk")}
              </button>
            </div>
          </div>
          {/* Jamie Zeitzer steward card */}
          <a
            href={`${BASE}sleep`}
            style={{
              display: "flex", flexDirection: "column", alignItems: "flex-start",
              background: "#fff",
              border: `1px solid ${RULE}`,
              borderRadius: 20,
              padding: "28px 26px",
              boxShadow: "0 6px 28px rgba(10,10,15,0.07)",
              textDecoration: "none",
              maxWidth: 380,
              transition: "box-shadow .2s ease",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.boxShadow = "0 10px 36px rgba(10,10,15,0.13)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.boxShadow = "0 6px 28px rgba(10,10,15,0.07)"; }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 18 }}>
              <img
                src={`${BASE}stewards/zeitzer.png`}
                alt="Jamie Zeitzer"
                loading="lazy"
                style={{
                  width: 68, height: 68, borderRadius: "50%",
                  objectFit: "cover", flexShrink: 0,
                  border: "2.5px solid rgba(232,53,42,0.35)",
                  boxShadow: "0 2px 10px rgba(10,10,15,0.10)",
                }}
              />
              <div>
                <div style={{
                  fontFamily: SERIF, fontSize: 17, fontWeight: 600,
                  color: INK, lineHeight: 1.2, marginBottom: 4,
                }}>Jamie Zeitzer, PhD</div>
                <div style={{
                  fontFamily: SANS, fontSize: 11, fontWeight: 700,
                  letterSpacing: ".06em", textTransform: "uppercase",
                  color: RED,
                }}>Sleep · Stanford</div>
              </div>
            </div>
            <p style={{
              margin: "0 0 20px", fontFamily: SERIF, fontSize: 14.5,
              lineHeight: 1.6, color: "rgba(10,10,15,0.65)",
            }}>
              Co-Director of the Stanford Center for Sleep Sciences. NASA sleep advisor. Every sleep answer on Palonur is drawn from his lab's published research — and carries his name.
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {["Circadian biology", "Insomnia", "Shift work", "Aging"].map((tag) => (
                <span key={tag} style={{
                  fontFamily: SANS, fontSize: 11, fontWeight: 600,
                  background: "rgba(232,53,42,0.07)", color: RED,
                  borderRadius: 30, padding: "3px 10px",
                  letterSpacing: ".02em",
                }}>
                  {tag}
                </span>
              ))}
            </div>
            <div style={{
              marginTop: 22, fontFamily: SANS, fontSize: 12, fontWeight: 700,
              letterSpacing: ".04em", color: RED,
            }}>
              Ask a sleep question →
            </div>
          </a>
        </div>
      </div>}

      {/* ─── Technical side ──────────────────────────────────────────────── */}
      <section
        id="technical-side"
        aria-labelledby="technical-side-heading"
        data-testid="section-technical-side"
        style={{ background: "#0A0A0F" }}
      >
        <div style={{ ...chapter, minHeight: "auto", background: "#0A0A0F", color: "#F5F1EA" }}>
          <div style={inner}>
            <div style={{ ...eyebrow, color: RED_DARK }}>{t("technical.eyebrow")}</div>
            <h2
              id="technical-side-heading"
              style={{ ...headline, color: "#F5F1EA", marginBottom: 18 }}
            >
              {renderWithEm(t("technical.headline"))}
            </h2>
            <p style={{ ...body, color: "rgba(245,241,234,0.76)", maxWidth: 720 }}>
              {t("technical.intro")}
            </p>
          </div>
        </div>

      {/* ─── 03 · Authority router — the version-control idea ───────────── */}
      <div
        style={{
          ...chapter,
          background: "#0A0A0F",
          color: "#F5F1EA",
          position: "relative",
          overflow: "hidden",
        }}
        id="authority-router"
        data-testid="section-authority-router"
      >
        <style>{`
          .authority-router-intro {
            display: grid;
            grid-template-columns: minmax(0, 1.15fr) minmax(280px, .75fr);
            gap: clamp(28px, 6vw, 92px);
            align-items: end;
            margin-bottom: 42px;
          }
          .authority-router-intro h2,
          .authority-router-intro p {
            margin-top: 0;
          }
          .authority-router-flow {
            display: grid;
            grid-template-columns: minmax(0, 1fr) 92px minmax(0, 1.12fr);
            gap: 12px;
            align-items: stretch;
          }
          .authority-router-panel {
            min-width: 0;
            min-height: 306px;
            padding: 28px;
            border: 1px solid rgba(245,241,234,.16);
            border-radius: 24px;
          }
          .authority-router-request {
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            background: rgba(245,241,234,.055);
          }
          .authority-router-request-quote {
            max-width: 420px;
            margin: 36px 0;
            font-family: ${SERIF};
            font-size: clamp(28px, 3vw, 42px);
            line-height: 1.08;
            letter-spacing: -.02em;
          }
          .authority-router-request-context {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
            padding-top: 18px;
            border-top: 1px solid rgba(245,241,234,.14);
            font-family: ${SANS};
          }
          .authority-router-request-context span {
            display: block;
            margin-bottom: 5px;
            color: rgba(245,241,234,.46);
            font-size: 10px;
            font-weight: 800;
            letter-spacing: .14em;
            text-transform: uppercase;
          }
          .authority-router-request-context strong {
            display: block;
            color: rgba(245,241,234,.82);
            font-size: 12px;
            line-height: 1.4;
          }
          .authority-router-resolver {
            display: flex;
            align-items: center;
            justify-content: center;
            flex-direction: column;
            gap: 12px;
            color: #FF7A6E;
            font-family: ${SANS};
            text-align: center;
          }
          .authority-router-resolver-step {
            color: #FF7A6E;
            font-size: 10px;
            font-weight: 800;
            letter-spacing: .14em;
            line-height: 1.35;
            text-transform: uppercase;
          }
          .authority-router-resolver-line {
            width: 1px;
            height: 54px;
            background: linear-gradient(to bottom, rgba(255,122,110,.18), #FF7A6E, rgba(255,122,110,.18));
          }
          .authority-router-resolver-arrow {
            font-size: 26px;
            line-height: 1;
          }
          .authority-router-resolver-caption {
            max-width: 86px;
            color: rgba(245,241,234,.54);
            font-size: 11px;
            line-height: 1.35;
          }
          .authority-router-result {
            background: #F4EAE5;
            border-color: #F4EAE5;
            color: #0A0A0F;
          }
          .authority-router-result-top {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 16px;
          }
          .authority-router-result-badge {
            flex: 0 0 auto;
            border: 1px solid rgba(180,57,49,.35);
            border-radius: 999px;
            padding: 6px 9px;
            color: #A8322D;
            font-size: 10px;
            font-weight: 800;
            letter-spacing: .04em;
            white-space: nowrap;
          }
          .authority-router-result-level {
            margin: 16px 0 24px;
            padding-bottom: 22px;
            border-bottom: 1px solid rgba(10,10,15,.14);
            font-family: ${SERIF};
            font-size: clamp(28px, 3vw, 42px);
            line-height: 1.04;
            letter-spacing: -.02em;
          }
          .authority-router-result-row {
            display: grid;
            grid-template-columns: 82px minmax(0, 1fr);
            gap: 12px;
            padding: 10px 0;
            border-bottom: 1px solid rgba(10,10,15,.1);
            font-family: ${SANS};
          }
          .authority-router-result-row:last-child { border-bottom: 0; }
          .authority-router-result-row span {
            color: rgba(10,10,15,.54);
            font-size: 11px;
            font-weight: 800;
            letter-spacing: .08em;
            text-transform: uppercase;
          }
          .authority-router-result-row strong {
            color: rgba(10,10,15,.8);
            font-size: 12px;
            font-weight: 600;
            line-height: 1.4;
          }
          .authority-router-loop {
            margin-top: 18px;
            padding: 14px 16px;
            border-left: 2px solid #FF7A6E;
            background: rgba(255,122,110,.08);
            color: rgba(245,241,234,.76);
            font-family: ${SANS};
            font-size: 13px;
            line-height: 1.5;
          }
          @media (max-width: 820px) {
            .authority-router-intro {
              grid-template-columns: 1fr;
              gap: 18px;
              margin-bottom: 30px;
            }
            .authority-router-flow {
              grid-template-columns: 1fr;
              gap: 10px;
            }
            .authority-router-panel {
              min-height: 0;
              padding: 22px;
            }
            .authority-router-request-quote {
              margin: 28px 0;
            }
            .authority-router-resolver {
              min-height: 52px;
              flex-direction: row;
              gap: 12px;
            }
            .authority-router-resolver-line {
              width: 54px;
              height: 1px;
              background: linear-gradient(to right, rgba(255,122,110,.18), #FF7A6E, rgba(255,122,110,.18));
            }
            .authority-router-resolver-arrow {
              transform: rotate(90deg);
            }
            .authority-router-resolver-caption {
              max-width: none;
            }
          }
          @media (max-width: 460px) {
            .authority-router-request-context {
              grid-template-columns: 1fr;
            }
            .authority-router-result-row {
              grid-template-columns: 70px minmax(0, 1fr);
            }
          }
        `}</style>
        <div style={inner}>
          <div style={{ ...eyebrow, color: RED_DARK }}>{t("authorityRouter.eyebrow")}</div>
          <div className="authority-router-intro">
            <h2 style={{ ...headline, color: "#F5F1EA", maxWidth: 760, marginBottom: 0 }}>
              {renderWithEm(t("authorityRouter.headline"))}
            </h2>
            <p style={{ ...body, color: "rgba(245,241,234,0.76)", maxWidth: 520, marginBottom: 0 }}>
              {t("authorityRouter.intro")}
            </p>
          </div>

          <div
            className="authority-router-flow"
            role="img"
            aria-label={t("authorityRouter.graphLabel")}
            data-testid="authority-router-graph"
          >
            <div className="authority-router-panel authority-router-request">
              <div style={{
                color: RED_DARK,
                fontFamily: SANS,
                fontSize: 10,
                fontWeight: 800,
                letterSpacing: ".16em",
                textTransform: "uppercase",
              }}>
                {t("authorityRouter.request.label")}
              </div>
              <div className="authority-router-request-quote">
                “{t("authorityRouter.request.question")}”
              </div>
              <div className="authority-router-request-context">
                <div>
                  <span>{t("authorityRouter.request.fieldLabel")}</span>
                  <strong>{t("authorityRouter.request.fieldValue")}</strong>
                </div>
                <div>
                  <span>{t("authorityRouter.request.intentLabel")}</span>
                  <strong>{t("authorityRouter.request.intentValue")}</strong>
                </div>
              </div>
            </div>

            <div className="authority-router-resolver" aria-hidden>
              <div className="authority-router-resolver-step">{t("authorityRouter.resolveLabel")}</div>
              <div className="authority-router-resolver-line" />
              <div className="authority-router-resolver-arrow">→</div>
              <div className="authority-router-resolver-caption">{t("authorityRouter.resolveText")}</div>
            </div>

            <div className="authority-router-panel authority-router-result" data-testid="authority-router-release">
              <div className="authority-router-result-top">
                <div style={{
                  color: RED,
                  fontFamily: SANS,
                  fontSize: 10,
                  fontWeight: 800,
                  letterSpacing: ".16em",
                  textTransform: "uppercase",
                }}>
                  {t("authorityRouter.result.label")}
                </div>
                <div className="authority-router-result-badge">
                  {t("authorityRouter.result.badge")}
                </div>
              </div>
              <div className="authority-router-result-level">
                {t("authorityRouter.result.level")}
              </div>
              <div>
                {(["field", "steward", "record", "trace"] as const).map((key) => (
                  <div className="authority-router-result-row" key={key}>
                    <span>{t(`authorityRouter.result.${key}Label`)}</span>
                    <strong>{t(`authorityRouter.result.${key}Text`)}</strong>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="authority-router-loop">
            <strong style={{ color: "#F5F1EA" }}>{t("authorityRouter.loopLabel")}</strong>{" "}
            {t("authorityRouter.loopText")}
          </div>
        </div>
      </div>

      {/* ─── 03a · Provenance chain — faculty access to traceability ──────── */}
      {/* Six-stage "defensible knowledge" chain, flowing straight out of the
          faculty-access chapter above. Framed explicitly as a provenance/IP
          feature, NOT security: it does not prevent copying; its value is
          detectable, attributable reuse. Shipped claims only (versioned
          corpus, copy watermark + checker, keyed access, no-training license,
          revocable keys); hashing/canaries/fingerprints/black-box detection
          are worded as roadmap ("designed to", "we are building"). */}
      <div style={{ ...chapter, background: BLUSH }} id="provenance" data-testid="section-provenance">
        <div style={inner}>
          <div style={eyebrow}>{t("provenance.eyebrow")}</div>
          <h2 style={{ ...headline, fontSize: "clamp(38px, 5.5vw, 68px)", maxWidth: 840 }}>
            {renderWithEm(t("provenance.headline"))}
          </h2>
          <p style={{ ...body, maxWidth: 720, marginBottom: 14 }}>{t("provenance.intro1")}</p>
          <p style={{ ...body, maxWidth: 720, marginBottom: 44 }}>{t("provenance.intro2")}</p>

          <ol style={{ listStyle: "none", margin: 0, padding: 0, maxWidth: 780 }}>
            {(["faculty", "protocols", "knowledge", "marks", "licensing", "detection"] as const).map((key, i, arr) => (
              <li
                key={key}
                data-testid={`stage-provenance-${key}`}
                style={{ display: "flex", gap: 18, paddingBottom: i === arr.length - 1 ? 0 : 26 }}
              >
                {/* numbered node + connector line */}
                <div aria-hidden style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
                  <div style={{
                    width: 34, height: 34, borderRadius: 999,
                    background: INK, color: "#fff",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontFamily: SANS, fontSize: 14, fontWeight: 700,
                  }}>
                    {i + 1}
                  </div>
                  {i < arr.length - 1 && (
                    <div style={{ width: 2, flex: 1, background: "rgba(10,10,15,0.18)", marginTop: 6 }} />
                  )}
                </div>
                <div style={{
                  background: "#fff",
                  border: `1px solid ${RULE}`,
                  borderRadius: 18,
                  padding: "20px 22px",
                  boxShadow: "0 4px 16px rgba(10,10,15,0.04)",
                  flex: 1,
                  minWidth: 0,
                }}>
                  <div style={{ fontFamily: SERIF, fontSize: 19, fontWeight: 600, color: INK, marginBottom: 8 }}>
                    {t(`provenance.stages.${key}.title`)}
                  </div>
                  <p style={{ margin: 0, fontFamily: SERIF, fontSize: 15, lineHeight: 1.6, color: "rgba(10,10,15,0.72)" }}>
                    {t(`provenance.stages.${key}.text`)}
                  </p>
                </div>
              </li>
            ))}
          </ol>

          <p style={{ ...body, fontSize: 15.5, maxWidth: 720, margin: "34px 0 28px" }}>
            {t("provenance.limits")}
          </p>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
            <a href={`${BASE}agent-access`} style={inkPill} data-testid="link-provenance-agent-access">
              {t("provenance.ctaAccess")}
            </a>
            <a
              href={`${BASE}agent-license`}
              style={{ ...inkPill, background: "transparent", color: INK, border: `1.5px solid ${INK}` }}
              data-testid="link-provenance-license"
            >
              {t("provenance.ctaLicense")}
            </a>
          </div>
        </div>
      </div>

      {/* ─── 04.5 · Karen Parker — coming next ───────────────────────────── */}
      {false && (() => {
        const KAREN = STEWARD_SPOTLIGHT.find((s) => s.surname === "Parker")!;
        const SAMPLE_QS = [
          t("karen.sampleQ0"),
          t("karen.sampleQ1"),
          t("karen.sampleQ2"),
        ];
        return (
          <div style={chapter} id="karen-parker" data-testid="chapter-karen">
            <div style={inner}>
              <div style={eyebrow}>{t("karen.eyebrow")}</div>
              <div style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
                gap: "clamp(44px, 7vw, 100px)",
                alignItems: "start",
              }}>

                {/* ── Left: identity + value ── */}
                <div>
                  {/* Photo + name lockup */}
                  <div style={{
                    display: "flex", alignItems: "center", gap: 18, marginBottom: 32,
                  }}>
                    <img
                      src={`${BASE}stewards/parker.jpg`}
                      alt="Karen Parker"
                      loading="lazy"
                      style={{
                        width: 80, height: 80, borderRadius: "50%",
                        objectFit: "cover",
                        border: `2px solid ${RULE}`,
                        flexShrink: 0,
                      }}
                    />
                    <div>
                      <div style={{
                        fontFamily: SERIF, fontSize: 21, fontWeight: 600, color: INK,
                        lineHeight: 1.2,
                      }}>
                        {KAREN.name}
                        <span style={{
                          fontFamily: SANS, fontSize: 13, fontWeight: 500,
                          color: MUTED, marginLeft: 8,
                        }}>
                          {KAREN.credentials}
                        </span>
                      </div>
                      <div style={{
                        fontFamily: SANS, fontSize: 12, fontWeight: 700,
                        letterSpacing: ".04em", color: RED, marginTop: 5,
                      }}>
                        {t("karen.department")}
                      </div>
                    </div>
                  </div>

                  <h2 style={headline}>
                    {renderWithEm(t("karen.headline"))}
                  </h2>

                  <p style={{ ...body, marginBottom: 18 }}>
                    {t("karen.body1")}
                  </p>
                  <p style={{ ...body, marginBottom: 30 }}>
                    {t("karen.body2")}
                  </p>

                  {/* Trust badges */}
                  <div style={{
                    display: "flex", flexWrap: "wrap", gap: 9, marginBottom: 36,
                  }}>
                    {[
                      t("karen.badge0"),
                      t("karen.badge1"),
                      t("karen.badge2"),
                      t("karen.badge3"),
                    ].map((badge) => (
                      <span key={badge} style={{
                        fontFamily: SANS, fontSize: 11.5, fontWeight: 700,
                        letterSpacing: ".05em",
                        background: "rgba(10,10,15,0.06)",
                        border: `1px solid rgba(10,10,15,0.10)`,
                        borderRadius: 999, padding: "6px 13px",
                        color: "rgba(10,10,15,0.65)",
                      }}>
                        {badge}
                      </span>
                    ))}
                  </div>

                  {/* Three value cards */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    {[
                      { label: t("karen.value1Label"), text: t("karen.value1Text") },
                      { label: t("karen.value2Label"), text: t("karen.value2Text") },
                      { label: t("karen.value3Label"), text: t("karen.value3Text") },
                    ].map((card) => (
                      <div key={card.label} style={{
                        display: "flex", gap: 14,
                      }}>
                        <div style={{
                          width: 3, borderRadius: 3, flexShrink: 0,
                          background: `rgba(232,53,42,0.25)`,
                          alignSelf: "stretch",
                          minHeight: 16,
                        }} />
                        <div>
                          <div style={{
                            fontFamily: SERIF, fontSize: 15, fontWeight: 600,
                            color: INK, marginBottom: 4,
                          }}>
                            {card.label}
                          </div>
                          <p style={{
                            margin: 0, fontFamily: SERIF, fontSize: 14,
                            lineHeight: 1.6, color: "rgba(10,10,15,0.62)",
                          }}>
                            {card.text}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* ── Right: ask UI + podcast ── */}
                <div>
                  {/* Ask card */}
                  <div style={{
                    background: "#fff",
                    border: `1px solid ${RULE}`,
                    borderRadius: 22,
                    padding: "clamp(22px, 2.8vw, 36px)",
                    marginBottom: 16,
                    boxShadow: "0 6px 28px rgba(10,10,15,0.07)",
                  }}>
                    <div style={{
                      fontFamily: SERIF, fontSize: 18, fontWeight: 600,
                      color: INK, marginBottom: 6,
                    }}>
                      {t("karen.askHeadline")}
                    </div>
                    <p style={{
                      margin: "0 0 18px", fontFamily: SERIF, fontSize: 14,
                      lineHeight: 1.55, color: MUTED,
                    }}>
                      {t("karen.askSub")}
                    </p>

                    {/* Sample questions */}
                    <div style={{
                      display: "flex", flexDirection: "column", gap: 8, marginBottom: 22,
                    }}>
                      {SAMPLE_QS.map((q) => (
                        <button
                          key={q}
                          onClick={() => setKarenQ(q === karenQ ? "" : q)}
                          style={{
                            background: q === karenQ
                              ? "rgba(232,53,42,0.05)"
                              : "rgba(10,10,15,0.028)",
                            border: q === karenQ
                              ? `1.5px solid rgba(232,53,42,0.30)`
                              : `1px solid rgba(10,10,15,0.10)`,
                            borderRadius: 11, padding: "11px 15px",
                            fontFamily: SERIF, fontSize: 13.5,
                            lineHeight: 1.45, color: q === karenQ ? INK : "rgba(10,10,15,0.62)",
                            cursor: "pointer", textAlign: "left",
                            transition: "background .13s, border-color .13s, color .13s",
                          }}
                        >
                          {q}
                        </button>
                      ))}
                    </div>

                    {/* Email capture */}
                    {karenSubmitted ? (
                      <div style={{
                        background: "rgba(10,10,15,0.04)", borderRadius: 12,
                        padding: "16px 18px",
                        fontFamily: SERIF, fontSize: 15,
                        color: INK, lineHeight: 1.55,
                      }}>
                        <span style={{ color: RED, fontWeight: 700, marginRight: 8 }}>✓</span>
                        {t("karen.onList")}
                      </div>
                    ) : (
                      <form
                        onSubmit={handleKarenSubmit}
                        style={{ display: "flex", gap: 10, flexWrap: "wrap" }}
                      >
                        <input
                          type="email"
                          value={karenEmail}
                          onChange={(e) => setKarenEmail(e.target.value)}
                          placeholder={t("karen.emailPlaceholder")}
                          required
                          style={{
                            flex: "1 1 180px",
                            padding: "12px 18px", borderRadius: 999,
                            border: `1.5px solid rgba(10,10,15,0.18)`,
                            fontFamily: SANS, fontSize: 14, color: INK,
                            outline: "none", background: "#fff",
                            minWidth: 0,
                          }}
                        />
                        <button
                          type="submit"
                          disabled={karenLoading}
                          style={{
                            ...redPill,
                            opacity: karenLoading ? 0.65 : 1,
                            flexShrink: 0,
                          }}
                        >
                          {karenLoading ? "..." : t("karen.notifyMe")}
                        </button>
                      </form>
                    )}
                  </div>

                  {/* Podcast card */}
                  <div style={{
                    background: INK,
                    borderRadius: 18,
                    padding: "22px 22px",
                    display: "flex", gap: 18, alignItems: "flex-start",
                  }}>
                    {/* Mic icon block */}
                    <div style={{
                      width: 48, height: 48, borderRadius: 12, flexShrink: 0,
                      background: "rgba(232,53,42,0.22)",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      <svg
                        width="22" height="22" viewBox="0 0 24 24"
                        fill="none" stroke="#B3261E" strokeWidth="2"
                        strokeLinecap="round" strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <rect x="9" y="2" width="6" height="12" rx="3" />
                        <path d="M5 10a7 7 0 0 0 14 0" />
                        <line x1="12" y1="19" x2="12" y2="22" />
                        <line x1="8" y1="22" x2="16" y2="22" />
                      </svg>
                    </div>
                    <div>
                      <div style={{
                        fontFamily: SANS, fontSize: 10, fontWeight: 700,
                        letterSpacing: ".18em", textTransform: "uppercase",
                        color: "rgba(245,241,234,0.68)", marginBottom: 6,
                      }}>
                        {t("karen.podcastLabel")}
                      </div>
                      <div style={{
                        fontFamily: SERIF, fontSize: 16, fontWeight: 600,
                        color: "#F5F1EA", lineHeight: 1.3, marginBottom: 7,
                      }}>
                        {t("karen.podcastTitle")}
                      </div>
                      <p style={{
                        margin: "0 0 14px", fontFamily: SERIF, fontSize: 13,
                        lineHeight: 1.6, color: "rgba(245,241,234,0.62)",
                      }}>
                        {t("karen.podcastBody")}
                      </p>
                      <span style={{
                        fontFamily: SANS, fontSize: 11, fontWeight: 700,
                        letterSpacing: ".10em", textTransform: "uppercase",
                        color: "rgba(245,241,234,0.68)",
                        border: "1px solid rgba(255,255,255,0.16)",
                        borderRadius: 999, padding: "5px 13px",
                        display: "inline-block",
                      }}>
                        {t("karen.comingSoon")}
                      </span>
                    </div>
                  </div>
                </div>

              </div>
            </div>
          </div>
        );
      })()}

      {/* ─── 07 · For AI agents & platforms — dark chapter ───────────────── */}
      <div
        id="technical-agents"
        data-testid="section-technical-agents"
        style={{ ...chapter, background: "#0A0A0F", color: "#F5F1EA" }}
      >
        <div style={inner}>
          <div style={{ ...eyebrow, color: RED_DARK }}>{t("agents.eyebrow")}</div>
          <h2 style={{ ...headline, color: "#F5F1EA" }}>
            {renderWithEm(t("agents.headline"))}
          </h2>
          <p style={{
            ...body, color: "rgba(245,241,234,0.78)", marginBottom: 36,
          }}>
            {t("agents.body")}
          </p>

          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: 22, marginBottom: 36,
          }}>
            <div style={{
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.10)",
              borderRadius: 18, padding: "24px 22px",
            }}>
              <div style={{
                fontSize: 10, fontWeight: 700, letterSpacing: ".22em",
                textTransform: "uppercase",
                color: "rgba(245,241,234,0.68)", marginBottom: 12,
              }}>
                {t("agents.specLabel")}
              </div>
              <code style={{
                display: "block", fontSize: 14,
                color: "#F5F1EA", marginBottom: 12,
                wordBreak: "break-all",
              }}>
                palonur.com/api/agent/spec
              </code>
              <p style={{
                margin: 0, fontFamily: SERIF, fontSize: 14,
                lineHeight: 1.55, color: "rgba(245,241,234,0.7)",
              }}>
                {t("agents.specDesc")}
              </p>
            </div>
            <div style={{
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.10)",
              borderRadius: 18, padding: "24px 22px",
            }}>
              <div style={{
                fontSize: 10, fontWeight: 700, letterSpacing: ".22em",
                textTransform: "uppercase",
                color: "rgba(245,241,234,0.68)", marginBottom: 12,
              }}>
                {t("agents.mcpLabel")}
              </div>
              <code style={{
                display: "block", fontSize: 14,
                color: "#F5F1EA", marginBottom: 12,
                wordBreak: "break-all",
              }}>
                palonur.com/api/mcp
              </code>
              <p style={{
                margin: 0, fontFamily: SERIF, fontSize: 14,
                lineHeight: 1.55, color: "rgba(245,241,234,0.7)",
              }}>
                {t("agents.mcpDesc")}
              </p>
            </div>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
            <a href={`${BASE}agents`} style={{ ...redPill }} data-testid="link-agents">
              {t("agents.forAgents")}
            </a>
            <a href={`${BASE}platforms`} style={{
              ...redPill, background: "transparent",
              border: "1px solid rgba(255,255,255,0.35)", color: "#F5F1EA",
            }}>
              {t("agents.forPlatforms")}
            </a>
            <a href={`${BASE}agent-access`} style={{
              ...redPill, background: "transparent",
              border: "1px solid rgba(255,255,255,0.35)", color: "#F5F1EA",
            }}>
              {t("agents.agentAccess")}
            </a>
          </div>
        </div>
      </div>
      </section>

      <SiteFooter showNewsletterSignup={false} />
      {gate}
    </section>
  );
}

export default function Home() {
  // SPA renders after the browser's native anchor pass, so direct loads of
  // /#stewards (or any chapter hash) never scroll. Do it once after mount.
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    const t = setTimeout(() => {
      document.getElementById(hash)?.scrollIntoView();
    }, 150);
    return () => clearTimeout(t);
  }, []);
  return (
    <SkyPage
      hero={() => <BrandHero />}
      below={<BrandBelowFold />}
    />
  );
}
