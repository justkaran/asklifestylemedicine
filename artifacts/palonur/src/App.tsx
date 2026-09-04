import { useState, useEffect, useRef } from "react";
import FirstVisitPopup from "@/components/FirstVisitPopup";
import { SLM_STANDALONE } from "@/lib/app-mode";
import { usePageView } from "@/lib/usePageView";
import { useVisiblePillars } from "@/lib/pillars";
import {
  Switch,
  Route,
  Router as WouterRouter,
  useLocation,
  useSearch,
} from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import WatermarkCheck from "@/pages/watermark-check";
import { installCopyWatermark } from "@/lib/watermark";
import Pillars from "@/pages/pillars";
import TopicPage from "@/pages/topic";
import SleepAgent from "@/pages/sleep-agent";
import Journey from "@/pages/journey";
import Settings from "@/pages/settings";
import Admin from "@/pages/admin";
import Share from "@/pages/share";
import StoriesLogin from "@/pages/stories-login";
import StoriesDashboard from "@/pages/stories";
import CommunicationLogin from "@/pages/communication-login";
import Communication from "@/pages/communication";
import ParentDataLogin from "@/pages/parentdata-login";
import ParentData from "@/pages/parentdata";
import InvestorLogin from "@/pages/investor-login";
import Investor from "@/pages/investor";
import PartnerLogin from "@/pages/partner-login";
import Partner from "@/pages/partner";
import Subscribe from "@/pages/subscribe";
import AppleWatch from "@/pages/apple-watch";
import CureInsomnia from "@/pages/cure-insomnia";
import Agents from "@/pages/agents";
import Platforms from "@/pages/platforms";
import Reputation from "@/pages/reputation";
import ReputationDashboard from "@/pages/reputation-dashboard";
import About from "@/pages/about";
import Embed from "@/pages/embed";
import EmbedAgent from "@/pages/embed-agent";
import Newsletter from "@/pages/newsletter";
import NewsletterSubscribed from "@/pages/newsletter-subscribed";
import NewsletterAdmin from "@/pages/newsletter-admin";
import NewsletterPub from "@/pages/newsletter-pub";
import NewsletterIssue from "@/pages/newsletter-issue";
import CommandCenter from "@/pages/command-center";
import OTLDashboard from "@/pages/otl-dashboard";
import Growth from "@/pages/growth";
import AgentLicense from "@/pages/agent-license";
import Terms from "@/pages/terms";
import AiLab from "@/pages/ai-lab";
import FacultyAI from "@/pages/faculty-ai";
import Stewards from "@/pages/stewards";
import Privacy from "@/pages/privacy";
import AgentAccessConfirm from "@/pages/agent-access-confirm";
import MembersLogin from "@/pages/members-login";
import Members from "@/pages/members";
import Account from "@/pages/account";
import AgentAccess from "@/pages/agent-access";
import SupportLogin from "@/pages/support-login";
import Support from "@/pages/support";
import Ask from "@/pages/ask";
import Pal from "@/pages/pal";
import SlmAsk from "@/pages/slm-ask";
import SlmChat from "@/pages/slm-chat";
import AnswerLink from "@/pages/answer-link";
import AutismAsk from "@/pages/autism-ask";
import Reflect from "@/pages/reflect";
import Apply from "@/pages/apply";
import WhatIsPalonur from "@/pages/what-is-palonur";
import AiWithoutTraining from "@/pages/ai-without-training";
import { SkyPage } from "@/components/sky";
import { NewsletterPitch } from "@/components/newsletter-pitch";
import { SiteFooter } from "@/components/site-footer";
import { isAuthed, isRegistered, useAskGate } from "@/lib/ask-gate";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import Home from "@/pages/home";
const SERIF = "'Cormorant Garamond', Georgia, serif";
const SANS = "'DM Sans', Arial, sans-serif";

const queryClient = new QueryClient();

// ─── Sleep landing ("/sleep") ──────────────────────────────────────────────────
// The original Palonur homepage — live sky, hero search, sleep story. Shown to
// first-time visitors on /sleep; returning users go straight to the agent.
function SleepHome() {
  return (
    <SkyPage
      hero={(darkness) => <HeroSearch darkness={darkness} />}
      below={<BelowFold />}
    />
  );
}

/**
 * LivePortrait — a still photograph that quietly notices the viewer.
 *
 * • Cursor inside the card: the portrait makes "eye contact" by leaning a few
 *   pixels toward the cursor (max ±6px translate, ±1.5° tilt). Subtle enough
 *   to register subliminally, not enough to feel like a gimmick.
 * • Idle for >6s anywhere on the page: the portrait slowly "falls asleep" —
 *   it dims ~12%, breathes (1.0 ↔ 1.012 over 4.2s, like sleep respiration),
 *   and a tiny "z" drifts up from the corner. Any mouse movement wakes it.
 * On-brand for a sleep product, and quietly reinforces the "a real human is
 * behind this answer" idea without shouting.
 */
function LivePortrait({ src, alt }: { src: string; alt: string }) {
  const RED = "#B3261E"; // local copy — palette consts live inside BelowFold
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [asleep, setAsleep] = useState(false);

  useEffect(() => {
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const wake = () => {
      setAsleep(false);
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => setAsleep(true), 6000);
    };
    const onMove = (e: MouseEvent) => {
      wake();
      const el = wrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // Distance from card center, clamped to a generous radius.
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = (e.clientX - cx) / Math.max(r.width, 1);
      const dy = (e.clientY - cy) / Math.max(r.height, 1);
      // Cap the lean to ±6px so it never looks twitchy.
      const max = 6;
      setOffset({
        x: Math.max(-max, Math.min(max, dx * 14)),
        y: Math.max(-max, Math.min(max, dy * 14)),
      });
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    wake();
    return () => {
      window.removeEventListener("mousemove", onMove);
      if (idleTimer) clearTimeout(idleTimer);
    };
  }, []);

  const tiltX = -offset.y * 0.18; // tilt head with vertical mouse
  const tiltY = offset.x * 0.18;

  return (
    <div
      ref={wrapRef}
      data-palonur-portrait
      style={{
        position: "relative",
        width: "100%",
        maxWidth: 280,
        aspectRatio: "1 / 1",
        borderRadius: 20,
        overflow: "hidden",
        border: `1.5px solid ${RED}`,
        margin: "0 auto",
        boxShadow: "0 8px 22px rgba(232,53,42,0.12)",
        perspective: 600,
        background: "#fff",
      }}
    >
      <img
        src={src}
        alt={alt}
        loading="lazy"
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: asleep
            ? "scale(var(--breath, 1))"
            : `translate3d(${offset.x}px, ${offset.y}px, 0) rotateX(${tiltX}deg) rotateY(${tiltY}deg) scale(1.02)`,
          transformOrigin: "center 60%",
          transition: asleep
            ? "transform 1.6s ease, filter 1.6s ease"
            : "transform .35s cubic-bezier(.2,.7,.2,1), filter .6s ease",
          filter: asleep ? "brightness(0.88) saturate(0.92)" : "none",
          animation: asleep
            ? "palonurBreath 4.2s ease-in-out infinite"
            : "none",
          willChange: "transform",
        }}
      />
      {/* Sleeping "z" — only visible while asleep */}
      <span
        aria-hidden
        style={{
          position: "absolute",
          top: 14,
          right: 18,
          fontFamily: SERIF,
          fontSize: 22,
          fontWeight: 600,
          color: "rgba(232,53,42,0.55)",
          opacity: asleep ? 1 : 0,
          transform: asleep ? "translateY(0)" : "translateY(8px)",
          transition: "opacity 1.2s ease, transform 1.2s ease",
          pointerEvents: "none",
          animation: asleep
            ? "palonurDriftZ 4.2s ease-in-out infinite"
            : "none",
        }}
      >
        z
      </span>
      <style>{`
        @keyframes palonurBreath {
          0%, 100% { transform: scale(1.0); }
          50% { transform: scale(1.012); }
        }
        @keyframes palonurDriftZ {
          0% { opacity: 0; transform: translate(0, 8px); }
          25% { opacity: 1; }
          100% { opacity: 0; transform: translate(-6px, -14px); }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-palonur-portrait] img,
          [data-palonur-portrait] span { animation: none !important; }
        }
      `}</style>
    </div>
  );
}

function BelowFold() {
  // Same API-filtered pillar set as /pillars, so retired pillars auto-hide
  // on the homepage strip too.
  const visiblePillars = useVisiblePillars();
  // ─── Watney-style cream design (matches /platforms aesthetic) ───────────
  const SANS =
    "'Source Sans 3', -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif";
  const SERIF = "'Source Serif 4', 'Georgia','Times New Roman',serif";
  const RED = "#B3261E";
  const INK = "#0A0A0F";
  const PAPER = "#FAF8F4";
  const RULE = "rgba(10,10,15,0.12)";
  const MUTED = "rgba(10,10,15,0.64)";
  const GOLD = "#7A5F2A"; // legible-on-cream version of the gold accent

  // Each chapter ≈ 92vh, like /platforms.
  const chapter: React.CSSProperties = {
    minHeight: "92vh",
    padding: "clamp(72px, 12vh, 140px) clamp(24px, 6vw, 96px)",
    display: "flex",
    alignItems: "center",
    borderBottom: `1px solid ${RULE}`,
    background: PAPER,
  };
  const inner: React.CSSProperties = {
    width: "100%",
    maxWidth: 1100,
    margin: "0 auto",
  };
  const innerSplit: React.CSSProperties = {
    ...inner,
    display: "grid",
    gridTemplateColumns: "minmax(0, 7fr) minmax(0, 3fr)",
    gap: "clamp(32px, 5vw, 80px)",
    alignItems: "start",
  };
  const eyebrow: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: ".24em",
    textTransform: "uppercase",
    color: RED,
    marginBottom: 28,
  };
  const headline: React.CSSProperties = {
    margin: "0 0 28px",
    fontFamily: SERIF,
    fontWeight: 500,
    fontSize: "clamp(34px, 5vw, 60px)",
    lineHeight: 1.06,
    letterSpacing: "-0.018em",
    color: INK,
    maxWidth: 780,
  };
  const body: React.CSSProperties = {
    margin: 0,
    maxWidth: 620,
    fontFamily: SERIF,
    fontSize: "clamp(17px, 1.5vw, 19px)",
    lineHeight: 1.6,
    color: "rgba(10,10,15,0.72)",
  };
  const aside: React.CSSProperties = {
    paddingTop: 8,
    borderLeft: `1px solid ${RULE}`,
    paddingLeft: 28,
    fontFamily: SERIF,
    fontStyle: "italic",
    lineHeight: 1.55,
    fontSize: "clamp(14px, 1.2vw, 16px)",
    color: "rgba(10,10,15,0.62)",
  };
  const italic = (s: string) => (
    <em style={{ fontStyle: "italic", fontFamily: SERIF }}>{s}</em>
  );

  // soft tinted variant for the Jamie centerpiece (Midi-style break in tone)
  const BLUSH = "#F4EAE5";

  return (
    <section
      id="how"
      style={{
        background: PAPER,
        color: INK,
        fontFamily: SANS,
      }}
    >
      {/* ─── Prologue · Why this exists · purpose story ──────────────
          Chatwani-style opening: a name, a moment, the stakes, the
          north star. Sits BEFORE the canned demo chapter so the
          reader meets the cause before the product. Keep deliberately
          short — Jobs-style declarative lines, one idea per line.
          The Maya scenario is archetypal (not a named patient);
          replace with the real founding moment when ready. */}
      <div style={{ ...chapter, background: PAPER }}>
        <div style={inner}>
          <div style={eyebrow}>Why we are building this</div>
          <h2 style={headline}>
            It starts at {italic("2 a.m.")}
            <br />
            Someone you love asks an AI.
          </h2>
          <p style={{ ...body, marginBottom: 20 }}>
            A new mother. Three weeks of broken sleep. She opens a chatbot and
            types <em>why can't I sleep when the baby finally does?</em>
          </p>
          <p style={{ ...body, marginBottom: 20 }}>
            The AI answers in two seconds. Confident. Specific. Nameless. No
            source. No expert. No way to know if it is right or wrong.
          </p>
          <p style={{ ...body, marginBottom: 32 }}>
            This is now happening millions of times a night, in every language,
            on every platform. The expertise of people like Prof. Jamie Zeitzer
            trained these models &mdash; and then disappeared from the answer.
          </p>

          <div
            style={{
              borderLeft: `3px solid ${RED}`,
              paddingLeft: 22,
              margin: "8px 0 32px",
              maxWidth: 620,
            }}
          >
            <p
              style={{
                margin: 0,
                fontFamily: SERIF,
                fontSize: "clamp(19px, 1.7vw, 22px)",
                lineHeight: 1.4,
                color: INK,
                fontWeight: 500,
              }}
            >
              We are putting a {italic("name")} back on the answer.
            </p>
            <p
              style={{
                margin: "10px 0 0",
                fontFamily: SANS,
                fontSize: 13,
                letterSpacing: ".02em",
                color: MUTED,
              }}
            >
              One question. One Stanford faculty member. One answer they signed.
            </p>
          </div>

          <p
            style={{
              margin: 0,
              fontFamily: SANS,
              fontSize: 13,
              color: MUTED,
              letterSpacing: ".02em",
            }}
          >
            That mother &mdash; and the next thousand people asking the same
            question tonight &mdash; deserves a Stanford faculty answer, not a
            confident guess.
          </p>
        </div>
      </div>

      {/* ─── 00 · What an answer looks like · canned demo exchange ─────
          Show, don't tell. The hero promises "Stanford's answer through
          any AI" — this is what one looks like. Five seconds of magic
          before any further explanation. */}
      <div
        style={{
          ...chapter,
          background: "#0A0A0F",
          color: "#F5F1EA",
          borderBottom: "none",
        }}
      >
        <div style={inner}>
          <div style={{ ...eyebrow, color: "#FF7A6E" }}>
            What an answer looks like
          </div>
          <h2
            style={{
              ...headline,
              color: "#F5F1EA",
              marginBottom: 36,
            }}
          >
            One question. {italic("One Stanford faculty answer.")}
          </h2>

          <div
            style={{
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.10)",
              borderRadius: 22,
              padding: "clamp(24px, 3vw, 40px)",
              maxWidth: 820,
            }}
          >
            {/* The question */}
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: ".22em",
                textTransform: "uppercase",
                color: "rgba(245,241,234,0.68)",
                marginBottom: 10,
              }}
            >
              You asked
            </div>
            <p
              style={{
                margin: "0 0 32px",
                fontFamily: SERIF,
                fontSize: "clamp(20px, 2.2vw, 26px)",
                fontWeight: 500,
                lineHeight: 1.35,
                color: "#F5F1EA",
              }}
            >
              I had coffee at 4&nbsp;p.m. Can I still fall asleep at 11?
            </p>

            {/* The answer */}
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: ".22em",
                textTransform: "uppercase",
                color: "#FF7A6E",
                marginBottom: 10,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span
                style={{
                  background: "#B3261E",
                  color: "#fff",
                  padding: "4px 8px",
                  borderRadius: 4,
                  fontSize: 9,
                  letterSpacing: ".18em",
                }}
              >
                STANFORD-SIGNED
              </span>
              <span>Prof. Jamie Zeitzer · Stanford School of Medicine</span>
            </div>
            <p
              style={{
                margin: "0 0 22px",
                fontFamily: SERIF,
                fontSize: "clamp(19px, 2.1vw, 24px)",
                fontWeight: 500,
                lineHeight: 1.4,
                color: "#F5F1EA",
              }}
            >
              Probably yes — but expect to fall asleep about{" "}
              <span style={{ color: "#FF7A6E" }}>40&nbsp;minutes later</span>{" "}
              than usual, and to spend less time in deep sleep.
            </p>
            <p
              style={{
                margin: "0 0 28px",
                fontFamily: SERIF,
                fontSize: 16,
                lineHeight: 1.6,
                color: "rgba(245,241,234,0.78)",
                maxWidth: 680,
              }}
            >
              Caffeine has a half-life of roughly five hours, so a 4&nbsp;p.m.
              cup still has a quarter of its dose circulating at bedtime. That's
              enough to delay sleep onset and blunt slow-wave sleep, even if you
              don't feel "wired".
            </p>

            {/* The receipts */}
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 18,
                padding: "18px 0",
                borderTop: "1px solid rgba(255,255,255,0.10)",
                borderBottom: "1px solid rgba(255,255,255,0.10)",
                marginBottom: 22,
              }}
            >
              <div style={{ minWidth: 200 }}>
                <div
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    letterSpacing: ".22em",
                    textTransform: "uppercase",
                    color: "rgba(245,241,234,0.68)",
                    marginBottom: 4,
                  }}
                >
                  Paper
                </div>
                <div
                  style={{
                    fontFamily: SERIF,
                    fontStyle: "italic",
                    fontSize: 14,
                    lineHeight: 1.4,
                    color: "rgba(245,241,234,0.88)",
                  }}
                >
                  "Caffeine effects on sleep taken 0, 3, or 6 hours before going
                  to bed."
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: "rgba(245,241,234,0.72)",
                    marginTop: 4,
                  }}
                >
                  Drake et&nbsp;al., J&nbsp;Clin&nbsp;Sleep&nbsp;Med, 2013
                </div>
              </div>
              <div style={{ minWidth: 180 }}>
                <div
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    letterSpacing: ".22em",
                    textTransform: "uppercase",
                    color: "rgba(245,241,234,0.68)",
                    marginBottom: 4,
                  }}
                >
                  Try tonight
                </div>
                <div
                  style={{
                    fontFamily: SERIF,
                    fontSize: 14,
                    lineHeight: 1.4,
                    color: "#F5F1EA",
                  }}
                >
                  Cap caffeine at <strong>2&nbsp;p.m.</strong> for the next
                  three nights. See if onset gets faster.
                </div>
              </div>
            </div>

            {/* "Now ask your own" CTA — points back to the search */}
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 12,
                alignItems: "center",
              }}
            >
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  background: "#B3261E",
                  color: "#fff",
                  padding: "14px 22px",
                  borderRadius: 999,
                  textDecoration: "none",
                  fontWeight: 700,
                  fontSize: 14,
                  letterSpacing: "0.02em",
                }}
              >
                Now ask your own question →
              </a>
              <span
                style={{
                  fontSize: 12,
                  color: "rgba(245,241,234,0.5)",
                  fontFamily: SANS,
                }}
              >
                Or paste{" "}
                <code style={{ color: "rgba(245,241,234,0.75)" }}>
                  palonur.com/api/agent/spec
                </code>{" "}
                into ChatGPT or Claude.
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ─── 01 · Why Palonur · split benefit block ───────────────────── */}
      <div style={chapter}>
        <div
          style={{
            ...inner,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
            gap: "clamp(40px, 6vw, 96px)",
            alignItems: "center",
          }}
        >
          <div>
            <div style={eyebrow}>Why Palonur</div>
            <h2 style={headline}>
              Sleep guidance from a {italic("real Stanford team")} — not a
              chatbot guess.
            </h2>
            <p style={{ ...body, marginBottom: 22 }}>
              When you ask Palonur about your sleep, the question is routed
              through Prof. Jamie Zeitzer's lab at the Stanford School of
              Medicine. The answer comes back with a real paper, a named
              scientist, and one concrete thing you can try tonight.
            </p>
            <p style={{ ...body, marginBottom: 32, color: MUTED }}>
              No subscription. No app to install. No advice we can't defend in
              clinic.
            </p>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 10,
                background: INK,
                color: "#fff",
                padding: "16px 26px",
                borderRadius: 999,
                textDecoration: "none",
                fontWeight: 700,
                fontSize: 15,
                letterSpacing: "0.01em",
              }}
            >
              Ask Stanford faculty about your sleep →
            </a>
          </div>

          {/* Visual: editorial nightscape photo with caption overlay */}
          <figure
            style={{
              margin: 0,
              position: "relative",
              borderRadius: 24,
              overflow: "hidden",
              boxShadow: "0 24px 60px rgba(10,10,15,0.10)",
            }}
          >
            <img
              src={`${import.meta.env.BASE_URL}below-fold/why-night.jpg`}
              alt="Moonlit landscape at night"
              loading="lazy"
              style={{
                display: "block",
                width: "100%",
                height: "clamp(320px, 48vh, 480px)",
                objectFit: "cover",
              }}
            />
            <figcaption
              style={{
                position: "absolute",
                left: 22,
                right: 22,
                bottom: 22,
                color: "#fff",
                display: "flex",
                flexWrap: "wrap",
                gap: 10,
                alignItems: "center",
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: ".18em",
                textTransform: "uppercase",
              }}
            >
              <span
                style={{
                  background: "#8B1A1A",
                  color: "#fff",
                  padding: "5px 9px",
                  borderRadius: 4,
                  fontSize: 9,
                  letterSpacing: ".18em",
                }}
              >
                STANFORD-SIGNED
              </span>
              <span style={{ opacity: 0.9 }}>
                Zeitzer et al. · J Physiol, 2000
              </span>
            </figcaption>
          </figure>
        </div>
      </div>

      {/* ─── 02 · How it works · numbered 1-2-3 ───────────────────────── */}
      <div style={chapter}>
        <div style={inner}>
          <div
            style={{
              borderRadius: 22,
              overflow: "hidden",
              marginBottom: 48,
              boxShadow: "0 18px 44px rgba(10,10,15,0.06)",
            }}
          >
            <img
              src={`${import.meta.env.BASE_URL}below-fold/howitworks-bedroom.jpg`}
              alt="A calm, light-filled bedroom in the morning"
              loading="lazy"
              style={{
                display: "block",
                width: "100%",
                height: "clamp(220px, 32vh, 340px)",
                objectFit: "cover",
              }}
            />
          </div>
          <div style={eyebrow}>How it works</div>
          <h2 style={{ ...headline, marginBottom: 18 }}>
            Three steps. {italic("One trustworthy answer.")}
          </h2>
          <p style={{ ...body, marginBottom: 56 }}>
            Built for the moment you actually need it — in bed, awake, holding
            your phone, asking why.
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
              gap: 28,
            }}
          >
            {[
              {
                n: "01",
                t: "Ask anything about sleep",
                d: "Caffeine cutoff, jet lag, scrolling at night, weekend lie-ins — type it the way you'd think it.",
              },
              {
                n: "02",
                t: "Routed through Stanford",
                d: "Your question is matched to Prof. Jamie Zeitzer's published research, not generic web text.",
              },
              {
                n: "03",
                t: "One thing to try tonight",
                d: "You leave with a single concrete change — plus the paper and the scientist behind it.",
              },
            ].map((s) => (
              <div key={s.n}>
                <div
                  style={{
                    width: 56,
                    height: 56,
                    borderRadius: "50%",
                    border: `1.5px solid ${INK}`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontFamily: SERIF,
                    fontSize: 20,
                    fontWeight: 500,
                    color: INK,
                    marginBottom: 22,
                  }}
                >
                  {s.n}
                </div>
                <div
                  style={{
                    fontFamily: SERIF,
                    fontSize: 22,
                    fontWeight: 500,
                    color: INK,
                    marginBottom: 12,
                    lineHeight: 1.25,
                  }}
                >
                  {s.t}
                </div>
                <div
                  style={{
                    fontFamily: SERIF,
                    fontSize: 16,
                    lineHeight: 1.6,
                    color: "rgba(10,10,15,0.62)",
                  }}
                >
                  {s.d}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ─── Why this matters · one devastating stat (replaces the
          generic 6-card benefits grid). The grid was Wikipedia-tier
          ("sharper focus / steadier mood / immunity / metabolism /
          recovery / longevity"); we replaced it with one number that
          actually earns its space and a single sentence about why we
          built Palonur. ──────────────────────────────────────────── */}
      <div style={chapter}>
        <div style={inner}>
          <div style={eyebrow}>Why this matters</div>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "baseline",
              gap: "clamp(14px, 2vw, 28px)",
              marginBottom: 28,
            }}
          >
            <div
              style={{
                fontFamily: SERIF,
                fontWeight: 600,
                fontSize: "clamp(72px, 12vw, 168px)",
                lineHeight: 0.95,
                letterSpacing: "-0.04em",
                color: RED,
              }}
            >
              1&nbsp;in&nbsp;3
            </div>
            <div
              style={{
                fontFamily: SERIF,
                fontWeight: 500,
                fontSize: "clamp(22px, 2.4vw, 32px)",
                lineHeight: 1.2,
                color: INK,
                maxWidth: 520,
              }}
            >
              American adults sleep less than seven hours a night.
              <span style={{ color: MUTED }}> Most don't know why.</span>
            </div>
          </div>
          <p style={{ ...body, maxWidth: 720 }}>
            That's the gap Palonur was built to close — not with another
            tracker, but with one Stanford-faculty answer to the question
            keeping you awake. <em>Source:</em> CDC Behavioral Risk Factor
            Surveillance System.
          </p>
        </div>
      </div>

      {/* ─── NEW · The science · circadian + light ─────────────────────── */}
      <div style={chapter}>
        <div
          style={{
            ...inner,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
            gap: "clamp(40px, 6vw, 96px)",
            alignItems: "center",
          }}
        >
          <figure
            style={{
              margin: 0,
              borderRadius: 22,
              overflow: "hidden",
              boxShadow: "0 18px 44px rgba(10,10,15,0.06)",
              order: -1,
            }}
          >
            <img
              src={`${import.meta.env.BASE_URL}below-fold/sleep-science.png`}
              alt="Warm morning light through a window onto a bedside notebook"
              loading="lazy"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
              style={{
                display: "block",
                width: "100%",
                height: "clamp(320px, 48vh, 480px)",
                objectFit: "cover",
              }}
            />
          </figure>

          <div>
            <div style={eyebrow}>The science</div>
            <h2 style={headline}>
              Light, timing, and a {italic("body clock")} that runs on both.
            </h2>
            <p style={{ ...body, marginBottom: 22 }}>
              Sleep science isn't really about beds. It's about your circadian
              system — the internal clock that decides when you feel sleepy,
              alert, hungry, focused, or flat. The biggest lever isn't
              supplements. It's <em>light</em>: how bright, what colour, and at
              what hour.
            </p>
            <p style={{ ...body, marginBottom: 0, color: MUTED }}>
              Prof. Jamie Zeitzer's lab at Stanford has spent two decades
              measuring exactly how light, screens, naps, jet lag, and caffeine
              shift that clock. Palonur turns those findings into one plain
              answer to your question.
            </p>
          </div>
        </div>
      </div>

      {/* ─── 03 · Meet Jamie · the scientist behind sleep ──────────────── */}
      <div
        style={{
          ...chapter,
          background: BLUSH,
          borderBottom: `1px solid ${RULE}`,
        }}
      >
        <div style={inner}>
          <div style={{ ...eyebrow, marginBottom: 22 }}>
            The scientist behind your sleep answer
          </div>
          <h2 style={{ ...headline, marginBottom: 28 }}>
            Meet {italic("Prof. Jamie Zeitzer")}.
          </h2>
          <p style={{ ...body, marginBottom: 56, maxWidth: 720 }}>
            Every sleep answer on Palonur is signed by one person — because in
            science, a name on the line is what makes an answer worth trusting.
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns:
                "repeat(auto-fit, minmax(min(280px, 100%), 1fr))",
              gap: "clamp(28px, 5vw, 72px)",
              alignItems: "start",
              background: "#fff",
              border: `1px solid ${RED}`,
              borderRadius: 24,
              padding: "clamp(22px, 4vw, 48px)",
              boxShadow: "0 18px 44px rgba(232,53,42,0.10)",
            }}
          >
            <LivePortrait
              src={`${import.meta.env.BASE_URL}below-fold/sleep-professor.png`}
              alt="Portrait of a Stanford sleep scientist"
            />

            <div>
              <div
                style={{
                  fontSize: 9,
                  fontWeight: 800,
                  letterSpacing: ".18em",
                  color: "#fff",
                  background: RED,
                  padding: "5px 10px",
                  borderRadius: 999,
                  display: "inline-block",
                  marginBottom: 14,
                }}
              >
                SLEEP LEAD
              </div>
              <div
                style={{
                  fontFamily: SANS,
                  fontSize: 22,
                  fontWeight: 700,
                  color: INK,
                  marginBottom: 6,
                  lineHeight: 1.2,
                }}
              >
                Jamie Zeitzer, PhD
              </div>
              <div
                style={{
                  fontFamily: SANS,
                  fontSize: 14,
                  lineHeight: 1.55,
                  color: "rgba(10,10,15,0.62)",
                  marginBottom: 22,
                }}
              >
                Professor, Sleep &amp; Circadian Sciences · Stanford School of
                Medicine · Co-Director, Stanford Center for Sleep Research ·
                Advisor to NASA astronaut sleep protocols
              </div>

              <p style={{ ...body, marginBottom: 16 }}>
                For more than two decades, Jamie's lab at Stanford has measured
                exactly how light, screens, naps, jet lag, and caffeine shift
                the human body clock. His landmark 2000 paper showed that
                ordinary room light — far dimmer than most people realise — is
                enough to delay melatonin and push sleep later.
              </p>
              <p style={{ ...body, marginBottom: 16 }}>
                Today his work shapes how astronauts sleep on the International
                Space Station, how shift workers protect their health, and how
                clinicians counsel patients who simply can't fall asleep.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* ─── Start your sleep journey · 3-tier CTAs ────────────────────── */}
      <div
        style={{ ...chapter, borderBottom: "none", flexDirection: "column" }}
      >
        <div
          style={{
            ...inner,
            borderRadius: 22,
            overflow: "hidden",
            marginBottom: 56,
            boxShadow: "0 18px 44px rgba(10,10,15,0.06)",
          }}
        >
          <img
            src={`${import.meta.env.BASE_URL}below-fold/cta-goldenhour.jpg`}
            alt="Golden hour light through tall grasses at sunrise"
            loading="lazy"
            style={{
              display: "block",
              width: "100%",
              height: "clamp(180px, 26vh, 280px)",
              objectFit: "cover",
            }}
          />
        </div>
        <div style={inner}>
          <div style={eyebrow}>Start your sleep journey</div>
          <h2 style={{ ...headline, marginBottom: 18 }}>
            Three ways to ask {italic("Stanford faculty about your sleep")}.
          </h2>
          <p style={{ ...body, marginBottom: 48, maxWidth: 720 }}>
            Test it now with one question. Sign up free for a few a day. Or get
            Palonur Pal: unlimited answers from all pillars, each cited to the
            researcher who reviewed it.
          </p>

          {(() => {
            const tier = (
              variant: "test" | "free" | "pro",
              eyebrowText: string,
              price: string,
              title: string,
              bullets: string[],
              cta: {
                label: string;
                href: string;
                onClick?: (e: React.MouseEvent) => void;
              },
            ) => {
              const isPro = variant === "pro";
              return (
                <div
                  style={{
                    background: "#fff",
                    border: `1px solid ${isPro ? RED : RULE}`,
                    borderRadius: 24,
                    padding: "32px 28px 30px",
                    display: "flex",
                    flexDirection: "column",
                    boxShadow: isPro
                      ? "0 18px 44px rgba(232,53,42,0.10)"
                      : "0 8px 22px rgba(10,10,15,0.04)",
                    position: "relative",
                  }}
                >
                  {isPro && (
                    <div
                      style={{
                        position: "absolute",
                        top: -12,
                        left: 24,
                        fontSize: 9,
                        fontWeight: 800,
                        letterSpacing: ".18em",
                        color: "#fff",
                        background: RED,
                        padding: "5px 10px",
                        borderRadius: 999,
                      }}
                    >
                      MOST POPULAR
                    </div>
                  )}
                  <div
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: ".22em",
                      textTransform: "uppercase",
                      color: isPro ? RED : MUTED,
                      marginBottom: 14,
                    }}
                  >
                    {eyebrowText}
                  </div>
                  <div
                    style={{
                      fontFamily: SERIF,
                      fontSize: 26,
                      fontWeight: 500,
                      color: INK,
                      lineHeight: 1.2,
                      marginBottom: 6,
                    }}
                  >
                    {title}
                  </div>
                  <div
                    style={{
                      fontFamily: SANS,
                      fontSize: 14,
                      fontWeight: 700,
                      color: isPro ? RED : "rgba(10,10,15,0.64)",
                      marginBottom: 22,
                      letterSpacing: "0.02em",
                    }}
                  >
                    {price}
                  </div>

                  <ul
                    style={{
                      listStyle: "none",
                      padding: 0,
                      margin: "0 0 28px",
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                      flexGrow: 1,
                    }}
                  >
                    {bullets.map((b) => (
                      <li
                        key={b}
                        style={{
                          fontFamily: SERIF,
                          fontSize: 15,
                          lineHeight: 1.5,
                          color: "rgba(10,10,15,0.72)",
                          paddingLeft: 18,
                          position: "relative",
                        }}
                      >
                        <span
                          style={{
                            position: "absolute",
                            left: 0,
                            top: 8,
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            background: isPro ? RED : "rgba(10,10,15,0.3)",
                          }}
                        />
                        {b}
                      </li>
                    ))}
                  </ul>

                  <a
                    href={cta.href}
                    onClick={cta.onClick}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 8,
                      background: isPro
                        ? RED
                        : variant === "test"
                          ? INK
                          : "#fff",
                      color: isPro || variant === "test" ? "#fff" : INK,
                      border:
                        variant === "free" ? `1.5px solid ${INK}` : "none",
                      padding: "16px 22px",
                      borderRadius: 999,
                      textDecoration: "none",
                      fontWeight: 700,
                      fontSize: 14,
                      letterSpacing: "0.02em",
                    }}
                  >
                    {cta.label}
                  </a>
                </div>
              );
            };

            return (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "repeat(auto-fit, minmax(min(260px, 100%), 1fr))",
                  gap: 22,
                }}
              >
                {tier(
                  "test",
                  "Test it now",
                  "No signup",
                  "Try one Stanford faculty answer.",
                  [
                    "Ask one question, see what a Stanford faculty answer looks like.",
                    "Real citation. Real scientist. One thing to try tonight.",
                    "No email. No card. Takes ten seconds.",
                  ],
                  {
                    label: "Ask one question →",
                    href: `${import.meta.env.BASE_URL}`,
                    onClick: (e) => {
                      e.preventDefault();
                      window.scrollTo({ top: 0, behavior: "smooth" });
                    },
                  },
                )}
                {tier(
                  "free",
                  "Free account",
                  "$0 · forever",
                  "Sign up for the basics.",
                  [
                    "1 sleep question a day, free forever.",
                    "Save your answers and revisit them anytime.",
                    "Get a weekly Stanford sleep tip in your inbox.",
                  ],
                  {
                    label: "Sign up free →",
                    href: `${import.meta.env.BASE_URL}subscribe?plan=free`,
                  },
                )}
                {tier(
                  "pro",
                  "Palonur Pal",
                  "$49 / month",
                  "Dr. Jamie Zeitzer's sleep science, plus every other Palonur expert.",
                  [
                    "Unlimited answers from all pillars, any hour.",
                    "Every answer cited to the study it came from, signed by name.",
                    "A personal brief built from what you asked.",
                    "Access to every new Palonur expert as their pillar opens.",
                  ],
                  {
                    label: "Get Palonur Pal →",
                    href: `${import.meta.env.BASE_URL}subscribe`,
                  },
                )}
              </div>
            );
          })()}

          <p
            style={{
              margin: "32px 0 0",
              fontFamily: SANS,
              fontSize: 13,
              color: MUTED,
              textAlign: "center",
            }}
          >
            Prefer a structured plan?{" "}
            <a
              href={`${import.meta.env.BASE_URL}course`}
              style={{ color: GOLD, textDecoration: "none", fontWeight: 700 }}
            >
              Take the 7-night Cure Insomnia course →
            </a>
          </p>
        </div>
      </div>

      {/* ─── The pillars · compact strip → /pillars ─────────────────────
          Sleep is only the first pillar. A compact strip of the Stanford
          Lifestyle Medicine pillars (editorial constant in lib/pillars.ts)
          so visitors immediately see the bigger picture; the fuller story
          lives on the dedicated /pillars page. */}
      <div style={{ ...chapter, minHeight: "auto" }}>
        <div style={inner}>
          <div style={eyebrow}>Beyond sleep</div>
          <h2 style={headline}>Sleep is just {italic("the first pillar")}.</h2>
          <p style={{ ...body, marginBottom: 40 }}>
            Stanford Lifestyle Medicine is one use case for Palonur, which
            covers all of its pillars. Sleep is live today; the rest are on the
            way, each with a named Stanford faculty member behind it.
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))",
              gap: 16,
              marginBottom: 36,
            }}
          >
            {visiblePillars.map((p) => (
              <div
                key={p.slug}
                data-testid={`strip-pillar-${p.slug}`}
                style={{
                  background: "#fff",
                  border: `1px solid ${p.live ? RED : RULE}`,
                  borderRadius: 16,
                  padding: "18px 14px 16px",
                  textAlign: "center",
                }}
              >
                <img
                  src={p.art}
                  alt=""
                  aria-hidden
                  loading="lazy"
                  style={{
                    width: 52,
                    height: 52,
                    objectFit: "contain",
                    marginBottom: 10,
                  }}
                />
                <div
                  style={{
                    fontFamily: SANS,
                    fontSize: 13,
                    fontWeight: 700,
                    color: INK,
                    lineHeight: 1.3,
                    marginBottom: 6,
                  }}
                >
                  {p.name}
                </div>
                <div
                  style={{
                    fontSize: 9,
                    fontWeight: 800,
                    letterSpacing: ".14em",
                    textTransform: "uppercase",
                    color: p.live ? RED : MUTED,
                  }}
                >
                  {p.live ? "Live now" : "Coming soon"}
                </div>
              </div>
            ))}
          </div>
          <a
            href={`${import.meta.env.BASE_URL}pillars`}
            data-testid="link-home-pillars"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              background: INK,
              color: "#fff",
              padding: "14px 24px",
              borderRadius: 999,
              textDecoration: "none",
              fontWeight: 700,
              fontSize: 14,
              fontFamily: SANS,
              letterSpacing: "0.02em",
            }}
          >
            Explore all the pillars →
          </a>
        </div>
      </div>

      {/* ─── Footer ─ shared site footer ─────────────────────────────────── */}
      <SiteFooter />
    </section>
  );
}

// ─── Time-aware sleep hero headline ────────────────────────────────────────────
// Night bands (0–4, 21–23): the fix didn't hold — you're up again.
// Day bands (5–20): every tab contradicts the last — no answer is signed.
// The time-detection and routing logic are unchanged; this is copy only.
function sleepHeroMoment(): React.ReactNode {
  const h = new Date().getHours();
  const RED = "#FF7A6E"; // dark-hero variant: readable over the night sky
  const sci = <span style={{ color: RED }}>Ask the scientist.</span>;
  if (h < 5) {
    return (
      <>
        The fix didn't hold. You're up again.
        <br />
        {sci}
      </>
    );
  } else if (h < 12) {
    return (
      <>
        You'll search it again this morning.
        <br />
        Every tab contradicts the last. {sci}
      </>
    );
  } else if (h < 17) {
    return (
      <>
        Twelve answers, twelve sources, none of them signed.
        <br />
        {sci}
      </>
    );
  } else if (h < 21) {
    return (
      <>
        Tonight the questions return, and the answers still contradict.
        <br />
        {sci}
      </>
    );
  } else {
    return (
      <>
        Tonight you'll try something. Not sure if it'll hold.
        <br />
        {sci}
      </>
    );
  }
}

function HeroSearch({ darkness }: { darkness: number }) {
  // API-filtered pillar set (retired pillars auto-hide) for the hero strip.
  const heroPillars = useVisiblePillars();
  const [q, setQ] = useState("");
  const [focus, setFocus] = useState(false);
  const [heroHeadline] = useState(() => sleepHeroMoment());
  const [storedUserId] = useState(() => {
    try {
      return localStorage.getItem("palonur_user_id");
    } catch {
      return null;
    }
  });
  const [storedUserName] = useState(() => {
    try {
      return localStorage.getItem("palonur_user_name");
    } catch {
      return null;
    }
  });
  // Sleep landing keeps its questions on the sleep agent.
  const { ask, gate } = useAskGate({ target: "sleep" });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    ask(q.trim());
  };

  return (
    <div
      style={{
        position: "relative",
        zIndex: 10,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "clamp(18px, 4.5vh, 44px)",
        padding: "0 20px",
        width: "100%",
      }}
    >
      {/* Logo — Palonur is the product, Stanford Lifestyle Medicine is
          the partner. The flower mark sits to the left of the wordmark
          so the visual identity reads first; the wordmark is set in a
          lighter weight so the lockup feels more editorial, less
          corporate. */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 14,
          textAlign: "center",
          filter: "drop-shadow(0 2px 18px rgba(0,0,0,0.55))",
        }}
      >
        {/* Flower + PALONUR wordmark — the product */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "clamp(10px, 1.4vw, 16px)",
          }}
        >
          <img
            src={`${import.meta.env.BASE_URL}palonur-flower-red.svg`}
            alt=""
            aria-hidden
            style={{
              width: "clamp(30px, min(5vw, 5.5vh), 52px)",
              height: "clamp(30px, min(5vw, 5.5vh), 52px)",
              opacity: 0.92,
              flexShrink: 0,
            }}
          />
          <div
            style={{
              fontFamily: SERIF,
              fontSize: "clamp(30px, min(5.4vw, 5.8vh), 54px)",
              fontWeight: 400,
              color: "rgba(255,255,255,0.95)",
              letterSpacing: "0.005em",
              textShadow: "0 1px 14px rgba(0,0,0,0.7)",
              lineHeight: 1,
            }}
          >
            Palonur
          </div>
        </div>
        {/* tagline below logo */}
        <div
          style={{
            fontFamily: SERIF,
            fontSize: "clamp(14px, min(2.2vw, 2.6vh), 22px)",
            fontWeight: 400,
            color: "rgba(255,255,255,0.88)",
            letterSpacing: "0.01em",
            textShadow: "0 1px 10px rgba(0,0,0,0.65)",
            lineHeight: 1.3,
          }}
        >
          Get answers you can trust, backed by a named Stanford expert.
        </div>
      </div>

      {/* Hero — one sentence, one input, one badge */}
      <div
        style={{
          width: "min(720px, 96vw)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "clamp(14px, 2.6vh, 26px)",
        }}
      >
        {/* Headline — time-aware, names the contradiction crisis */}
        <h1
          style={{
            margin: 0,
            textAlign: "center",
            fontFamily: SERIF,
            fontSize: "clamp(28px, min(5.4vw, 6.6vh), 60px)",
            fontWeight: 600,
            lineHeight: 1.05,
            letterSpacing: "-0.018em",
            color: "rgba(255,255,255,0.97)",
            textShadow: "0 2px 18px rgba(0,0,0,0.6)",
          }}
        >
          {heroHeadline}
        </h1>

        {/* The one input — promoted to hero */}
        <form
          onSubmit={submit}
          style={{
            width: "min(620px, 94vw)",
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: "rgba(8,6,4,0.5)",
            borderRadius: 999,
            padding: "8px 8px 8px 24px",
            backdropFilter: "blur(32px) saturate(180%)",
            WebkitBackdropFilter: "blur(32px) saturate(180%)",
            border: `1.5px solid rgba(255,255,255,${focus ? 0.55 : 0.22})`,
            boxShadow: focus
              ? "0 0 0 4px rgba(255,255,255,0.06), 0 12px 36px rgba(0,0,0,0.32)"
              : "0 6px 26px rgba(0,0,0,0.28)",
            transition: "border-color .2s ease, box-shadow .2s ease",
          }}
        >
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => setFocus(true)}
            onBlur={() => setFocus(false)}
            placeholder="What's keeping you up?"
            aria-label="Ask Stanford anything about your sleep"
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              fontSize: "clamp(16px, 1.6vw, 18px)",
              color: "#fff",
              background: "transparent",
              fontFamily: SANS,
              fontWeight: 400,
              letterSpacing: "-0.005em",
              minWidth: 0,
              padding: "14px 0",
              caretColor: "#e8c8c8",
            }}
          />
          <button
            type="submit"
            disabled={!q.trim()}
            aria-label="Ask"
            style={{
              height: 46,
              borderRadius: 999,
              border: "none",
              padding: "0 22px",
              background: q.trim() ? "#fff" : "rgba(255,255,255,0.14)",
              color: q.trim() ? "#1a0505" : "rgba(255,255,255,0.4)",
              cursor: q.trim() ? "pointer" : "default",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 7,
              fontSize: 14,
              fontWeight: 700,
              letterSpacing: "0.01em",
              fontFamily: SANS,
              whiteSpace: "nowrap",
              transition:
                "background .2s ease, color .2s ease, transform .15s cubic-bezier(.34,1.56,.64,1)",
              flexShrink: 0,
            }}
            onMouseDown={(e) => {
              if (q.trim()) e.currentTarget.style.transform = "scale(0.95)";
            }}
            onMouseUp={(e) => {
              e.currentTarget.style.transform = "scale(1)";
            }}
          >
            Ask
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="5" y1="12" x2="19" y2="12"></line>
              <polyline points="12 5 19 12 12 19"></polyline>
            </svg>
          </button>
        </form>

        {/* Category badge — "Science, signed" named at the decision point */}
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            padding: "5px 14px",
            borderRadius: 999,
            border: "1px solid rgba(232,53,42,0.45)",
            background: "rgba(232,53,42,0.10)",
          }}
        >
          <span
            style={{
              fontSize: "clamp(11px, 1.1vw, 13px)",
              color: "rgba(255,180,170,0.95)",
              fontFamily: SERIF,
              fontStyle: "italic",
              letterSpacing: "0.02em",
              textShadow: "0 1px 4px rgba(0,0,0,0.7)",
            }}
          >
            Science, signed
          </span>
        </div>

        {/* Progress promise — what they'll leave with, in human language.
            Placed directly under the input so it reads as "what this does"
            not "what we sell." */}
        <div
          style={{
            fontSize: "clamp(13px, 1.3vw, 15px)",
            color: "rgba(255,255,255,0.7)",
            textShadow: "0 1px 4px rgba(0,0,0,0.8)",
            fontFamily: SERIF,
            fontStyle: "italic",
            letterSpacing: "0.005em",
            textAlign: "center",
            lineHeight: 1.4,
          }}
        >
          You'll leave with one answer for tonight — and the study behind it.
        </div>

        {/* Verified by — Stanford Lifestyle Medicine wordmark + Zeitzer
            "Leans in" 2px when the search input is focused, like it's
            tilting an ear toward what the visitor is about to ask. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
            justifyContent: "center",
            transform: focus ? "translateY(-2px)" : "translateY(0)",
            opacity: focus ? 1 : 0.92,
            transition:
              "transform .28s cubic-bezier(.2,.7,.2,1), opacity .28s ease",
          }}
        >
          <span
            style={{
              fontSize: "clamp(12px, 1.2vw, 14px)",
              color: "rgba(255,255,255,0.78)",
              textShadow: "0 1px 4px rgba(0,0,0,0.85)",
              fontFamily: SERIF,
              fontStyle: "italic",
              letterSpacing: "0.01em",
            }}
          >
            Not just plausible. Verified.
          </span>
          <span
            style={{
              display: "inline-block",
              width: 1,
              height: 14,
              background: "rgba(255,255,255,0.25)",
            }}
          />
          <span
            style={{
              fontSize: "clamp(12px, 1.2vw, 14px)",
              color: "rgba(255,255,255,0.78)",
              textShadow: "0 1px 4px rgba(0,0,0,0.85)",
              fontFamily: SERIF,
              fontStyle: "italic",
              letterSpacing: "0.01em",
            }}
          >
            Verified by Prof. Jamie Zeitzer
          </span>
          <span
            style={{
              display: "inline-block",
              width: 1,
              height: 14,
              background: "rgba(255,255,255,0.25)",
            }}
          />
          <span
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 6,
              fontFamily: SERIF,
              textShadow: "0 1px 6px rgba(0,0,0,0.7)",
            }}
          >
            <span
              style={{
                color: "#FF7A6E",
                fontWeight: 700,
                fontSize: "clamp(13px, 1.3vw, 15px)",
                letterSpacing: "-0.005em",
              }}
            >
              Stanford
            </span>
            <span
              style={{
                color: "rgba(255,255,255,0.3)",
                fontSize: "clamp(11px, 1.1vw, 13px)",
                fontWeight: 200,
                fontFamily: SANS,
              }}
            >
              |
            </span>
            <span
              style={{
                color: "rgba(255,255,255,0.92)",
                fontSize: "clamp(12px, 1.2vw, 14px)",
                fontWeight: 400,
                letterSpacing: "0.01em",
              }}
            >
              Lifestyle Medicine
            </span>
          </span>
        </div>

        {/* How to use it — one plain sentence + tappable example questions.
            Clicking an example fires the same ask() path as the search box. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 10,
            marginTop: 2,
          }}
        >
          <div
            style={{
              fontSize: "clamp(12px, 1.2vw, 14px)",
              color: "rgba(255,255,255,0.62)",
              textShadow: "0 1px 4px rgba(0,0,0,0.7)",
              fontFamily: SANS,
              letterSpacing: "0.01em",
            }}
          >
            Just type a question in your own words — or try one of these:
          </div>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "center",
              gap: 8,
            }}
          >
            {[
              "Why do I wake up at 3am?",
              "Does melatonin actually work?",
              "How much deep sleep do I need?",
            ].map((ex) => (
              <button
                key={ex}
                type="button"
                data-testid={`hero-example-${ex.slice(0, 12)}`}
                onClick={() => ask(ex)}
                style={{
                  border: "1px solid rgba(255,255,255,0.22)",
                  background: "rgba(8,6,4,0.35)",
                  color: "rgba(255,255,255,0.82)",
                  borderRadius: 999,
                  padding: "7px 14px",
                  fontSize: 13,
                  fontFamily: SANS,
                  cursor: "pointer",
                  backdropFilter: "blur(12px)",
                  WebkitBackdropFilter: "blur(12px)",
                  transition: "border-color .15s ease, background .15s ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "rgba(255,255,255,0.5)";
                  e.currentTarget.style.background = "rgba(8,6,4,0.55)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "rgba(255,255,255,0.22)";
                  e.currentTarget.style.background = "rgba(8,6,4,0.35)";
                }}
              >
                {ex}
              </button>
            ))}
          </div>
        </div>

        {/* The pillars — on the very first screen. Sleep is live; the other
            Stanford Lifestyle Medicine pillars are following. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 12,
            marginTop: 10,
          }}
        >
          <div
            style={{
              fontSize: "clamp(12px, 1.25vw, 14px)",
              color: "rgba(255,255,255,0.78)",
              textShadow: "0 1px 4px rgba(0,0,0,0.75)",
              fontFamily: SERIF,
              fontStyle: "italic",
              letterSpacing: "0.01em",
              textAlign: "center",
            }}
          >
            We're starting with the pillar of{" "}
            <span
              style={{ color: "#FF7A6E", fontStyle: "normal", fontWeight: 700 }}
            >
              sleep
            </span>{" "}
            — the other Stanford Lifestyle Medicine pillars are following.
          </div>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "center",
              gap: 8,
              maxWidth: 640,
            }}
          >
            {heroPillars.map((p) => (
              <span
                key={p.slug}
                data-testid={`hero-pillar-${p.slug}`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  border: p.live
                    ? "1px solid rgba(232,53,42,0.85)"
                    : "1px solid rgba(255,255,255,0.16)",
                  background: p.live
                    ? "rgba(232,53,42,0.16)"
                    : "rgba(8,6,4,0.3)",
                  color: p.live
                    ? "rgba(255,255,255,0.95)"
                    : "rgba(255,255,255,0.55)",
                  borderRadius: 999,
                  padding: "5px 12px",
                  fontSize: 12,
                  fontWeight: p.live ? 700 : 400,
                  fontFamily: SANS,
                  letterSpacing: "0.01em",
                  backdropFilter: "blur(12px)",
                  WebkitBackdropFilter: "blur(12px)",
                  whiteSpace: "nowrap",
                }}
              >
                {p.live && (
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 999,
                      background: "#FF7A6E",
                      flexShrink: 0,
                    }}
                  />
                )}
                {p.name}
                {!p.live && (
                  <span
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      letterSpacing: ".1em",
                      textTransform: "uppercase",
                      color: "rgba(255,255,255,0.35)",
                    }}
                  >
                    soon
                  </span>
                )}
              </span>
            ))}
            <a
              href={`${import.meta.env.BASE_URL}pillars`}
              data-testid="hero-link-pillars"
              style={{
                display: "inline-flex",
                alignItems: "center",
                border: "1px solid rgba(255,255,255,0.3)",
                background: "transparent",
                color: "rgba(255,255,255,0.85)",
                borderRadius: 999,
                padding: "5px 12px",
                fontSize: 12,
                fontWeight: 600,
                fontFamily: SANS,
                textDecoration: "none",
                whiteSpace: "nowrap",
              }}
            >
              All pillars →
            </a>
          </div>
        </div>

        {/* Scroll cue */}
        <a
          href="#how"
          style={{
            marginTop: 6,
            fontSize: 11,
            letterSpacing: ".16em",
            textTransform: "uppercase",
            color: "rgba(255,255,255,0.45)",
            textDecoration: "none",
            textShadow: "0 1px 4px rgba(0,0,0,0.7)",
          }}
        >
          How it works ↓
        </a>
      </div>
      {/* Returning-user nav link — fixed top-right, invisible to new visitors */}
      {storedUserId && (
        <a
          href={`${import.meta.env.BASE_URL}journey`}
          style={{
            position: "absolute",
            top: 20,
            right: 24,
            zIndex: 20,
            textDecoration: "none",
            fontSize: 13,
            fontWeight: 500,
            color: "rgba(255,255,255,0.55)",
            fontFamily: SANS,
            letterSpacing: "0.02em",
            textShadow: "0 1px 6px rgba(0,0,0,0.6)",
            transition: "color .15s",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLAnchorElement).style.color =
              "rgba(255,255,255,0.9)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLAnchorElement).style.color =
              "rgba(255,255,255,0.55)";
          }}
        >
          {storedUserName ? storedUserName : "My journey"} →
        </a>
      )}

      <style>{`
        input::placeholder {
          color: rgba(255,255,255,0.52);
          font-weight: 400;
          /* The placeholder breathes — opacity drifts 0.55 ↔ 0.92 over 3.6s,
             like the field is quietly waiting for the visitor to speak. */
          animation: palonurBreathPlaceholder 3.6s ease-in-out infinite;
        }
        input:focus::placeholder { animation: none; opacity: 0.62; }
        .pw-input::placeholder { color: rgba(255,255,255,0.42); animation: none; }
        @keyframes palonurBreathPlaceholder {
          0%, 100% { opacity: 0.55; }
          50% { opacity: 0.92; }
        }
        @media (prefers-reduced-motion: reduce) {
          input::placeholder { animation: none !important; opacity: 0.7; }
        }
      `}</style>

      {/* PASSWORD GATE MODAL */}
      {gate}
    </div>
  );
}

function Tracked({ page, C }: { page: string; C: React.ComponentType }) {
  usePageView(page);
  return <C />;
}
// /sleep: inbound question links (?q=… / ?dw=…) and returning users
// (early-access authed or registered) go straight to the agent; everyone
// else sees the sleep landing (the former homepage).
// MUST subscribe via wouter's useSearch(): wouter's location snapshot is
// pathname-only, so the agent guard's setLocation("/sleep") from
// /sleep?q=… would otherwise never re-render this route (same pathname) and
// an unauthenticated visitor would stay stuck on the agent. useSearch()'s
// snapshot IS location.search ("?q=…" → ""), which forces the re-render so
// the guard's bounce lands on the landing — and can't loop, because the
// clean /sleep recomputes to the landing.
function SleepRoute() {
  const search = useSearch();
  const goAgent = (() => {
    try {
      const sp = new URLSearchParams(search);
      if (sp.has("q") || sp.has("dw") || sp.has("claimed")) return true;
    } catch {
      /* noop */
    }
    return isAuthed() || isRegistered();
  })();
  return goAgent ? (
    <Tracked page="sleep-agent" C={SleepAgent} />
  ) : (
    <Tracked page="sleep-home" C={SleepHome} />
  );
}

function Router() {
  // Standalone Stanford Lifestyle Medicine product (separate domain): the
  // ENTIRE site is the /slm ask experience. No Palonur routes exist here.
  if (SLM_STANDALONE) {
    return (
      <Switch>
        {/* Stable, public path for WordPress iframe/script integrations. */}
        <Route
          path="/embed/slm"
          component={() => <Tracked page="slm-embed" C={SlmChat} />}
        />
        {/* Shared answer links (/a/:id) must keep working on the SLM domain —
            the page itself renders SLM-only chrome in standalone mode. */}
        <Route
          path="/a/:id"
          component={() => <Tracked page="answer-link" C={AnswerLink} />}
        />
        {/* Stanford OTL / IT reviewers reach the governance dashboard on the
            SLM domain too — same password-gated page as on palonur.com. */}
        <Route
          path="/otl-dashboard"
          component={() => <Tracked page="otl-dashboard" C={OTLDashboard} />}
        />
        <Route
          path="/dashboard"
          component={() => <Tracked page="otl-dashboard" C={OTLDashboard} />}
        />
        {/* Legal pages are linked from the chat footer on this domain too. */}
        <Route
          path="/terms"
          component={() => <Tracked page="terms" C={Terms} />}
        />
        <Route
          path="/privacy"
          component={() => <Tracked page="privacy" C={Privacy} />}
        />
        <Route
          component={() => <Tracked page="slm-standalone" C={SlmChat} />}
        />
      </Switch>
    );
  }
  return (
    <Switch>
      <Route path="/" component={() => <Tracked page="home" C={Home} />} />
      <Route path="/sleep" component={SleepRoute} />
      <Route
        path="/journey"
        component={() => <Tracked page="journey" C={Journey} />}
      />
      <Route
        path="/settings"
        component={() => <Tracked page="settings" C={Settings} />}
      />
      <Route
        path="/admin"
        component={() => <Tracked page="admin" C={Admin} />}
      />
      <Route
        path="/apply"
        component={() => <Tracked page="apply" C={Apply} />}
      />
      <Route
        path="/subscribe"
        component={() => <Tracked page="subscribe" C={Subscribe} />}
      />
      <Route
        path="/apple-watch"
        component={() => <Tracked page="apple-watch" C={AppleWatch} />}
      />
      <Route
        path="/course"
        component={() => <Tracked page="course" C={CureInsomnia} />}
      />
      <Route
        path="/cure-insomnia"
        component={() => <Tracked page="course" C={CureInsomnia} />}
      />
      <Route
        path="/agents"
        component={() => <Tracked page="agents" C={Agents} />}
      />
      <Route
        path="/platforms"
        component={() => <Tracked page="platforms" C={Platforms} />}
      />
      <Route
        path="/reputation"
        component={() => <Tracked page="reputation" C={Reputation} />}
      />
      <Route
        path="/reputation/dashboard"
        component={() => (
          <Tracked page="reputation-dashboard" C={ReputationDashboard} />
        )}
      />
      <Route
        path="/about"
        component={() => <Tracked page="about" C={About} />}
      />
      <Route
        path="/what-is-palonur"
        component={() => <Tracked page="what-is-palonur" C={WhatIsPalonur} />}
      />
      <Route
        path="/ai-without-training"
        component={() => (
          <Tracked page="ai-without-training" C={AiWithoutTraining} />
        )}
      />
      <Route path="/pal" component={() => <Tracked page="pal" C={Pal} />} />
      <Route
        path="/pillars"
        component={() => <Tracked page="pillars" C={Pillars} />}
      />
      <Route
        path="/t/:slug"
        component={() => <Tracked page="topic" C={TopicPage} />}
      />
      <Route
        path="/share"
        component={() => <Tracked page="share" C={Share} />}
      />
      <Route
        path="/stories-login"
        component={() => <Tracked page="stories-login" C={StoriesLogin} />}
      />
      <Route
        path="/stories"
        component={() => <Tracked page="stories" C={StoriesDashboard} />}
      />
      <Route
        path="/communication-login"
        component={() => (
          <Tracked page="communication-login" C={CommunicationLogin} />
        )}
      />
      <Route
        path="/communication"
        component={() => <Tracked page="communication" C={Communication} />}
      />
      <Route
        path="/parentdata-login"
        component={() => (
          <Tracked page="parentdata-login" C={ParentDataLogin} />
        )}
      />
      <Route
        path="/parentdata"
        component={() => <Tracked page="parentdata" C={ParentData} />}
      />
      <Route
        path="/investor-login"
        component={() => <Tracked page="investor-login" C={InvestorLogin} />}
      />
      <Route
        path="/investor"
        component={() => <Tracked page="investor" C={Investor} />}
      />
      <Route
        path="/partner-login"
        component={() => <Tracked page="partner-login" C={PartnerLogin} />}
      />
      <Route
        path="/partner"
        component={() => <Tracked page="partner" C={Partner} />}
      />
      <Route
        path="/embed"
        component={() => <Tracked page="embed" C={Embed} />}
      />
      <Route
        path="/embed-agent"
        component={() => <Tracked page="embed-agent" C={EmbedAgent} />}
      />
      <Route
        path="/newsletter"
        component={() => <Tracked page="newsletter" C={Newsletter} />}
      />
      <Route
        path="/newsletter/subscribed"
        component={() => (
          <Tracked page="newsletter-subscribed" C={NewsletterSubscribed} />
        )}
      />
      <Route
        path="/newsletter-admin"
        component={() => (
          <Tracked page="newsletter-admin" C={NewsletterAdmin} />
        )}
      />
      <Route
        path="/p/:slug/:issueId"
        component={() => (
          <Tracked page="newsletter-issue" C={NewsletterIssue} />
        )}
      />
      <Route
        path="/p/:slug"
        component={() => <Tracked page="newsletter-pub" C={NewsletterPub} />}
      />
      <Route
        path="/command-center"
        component={() => <Tracked page="command-center" C={CommandCenter} />}
      />
      <Route
        path="/otl-dashboard"
        component={() => <Tracked page="otl-dashboard" C={OTLDashboard} />}
      />
      <Route
        path="/dashboard"
        component={() => <Tracked page="otl-dashboard" C={OTLDashboard} />}
      />
      <Route
        path="/growth"
        component={() => <Tracked page="growth" C={Growth} />}
      />
      <Route
        path="/agent-license"
        component={() => <Tracked page="agent-license" C={AgentLicense} />}
      />
      <Route
        path="/terms"
        component={() => <Tracked page="terms" C={Terms} />}
      />
      <Route
        path="/ai-lab"
        component={() => <Tracked page="ai-lab" C={AiLab} />}
      />
      <Route
        path="/FacultyAI"
        component={() => <Tracked page="faculty-ai" C={FacultyAI} />}
      />
      <Route
        path="/faculty-ai"
        component={() => <Tracked page="faculty-ai" C={FacultyAI} />}
      />
      <Route
        path="/stewards"
        component={() => <Tracked page="stewards" C={Stewards} />}
      />
      <Route
        path="/privacy"
        component={() => <Tracked page="privacy" C={Privacy} />}
      />
      <Route
        path="/agent-access/confirm"
        component={() => (
          <Tracked page="agent-access-confirm" C={AgentAccessConfirm} />
        )}
      />
      <Route
        path="/agent-access"
        component={() => <Tracked page="agent-access" C={AgentAccess} />}
      />
      <Route
        path="/members-login"
        component={() => <Tracked page="members-login" C={MembersLogin} />}
      />
      <Route
        path="/members"
        component={() => <Tracked page="members" C={Members} />}
      />
      <Route
        path="/account"
        component={() => <Tracked page="account" C={Account} />}
      />
      <Route
        path="/reflect"
        component={() => <Tracked page="reflect" C={Reflect} />}
      />
      <Route
        path="/support-login"
        component={() => <Tracked page="support-login" C={SupportLogin} />}
      />
      <Route
        path="/support"
        component={() => <Tracked page="support" C={Support} />}
      />
      <Route path="/ask" component={() => <Tracked page="ask" C={Ask} />} />
      <Route
        path="/slm"
        component={() => <Tracked page="slm-ask" C={SlmAsk} />}
      />
      <Route
        path="/embed/slm"
        component={() => <Tracked page="slm-embed" C={SlmAsk} />}
      />
      <Route
        path="/a/:id"
        component={() => <Tracked page="answer-link" C={AnswerLink} />}
      />
      <Route
        path="/autism"
        component={() => <Tracked page="autism-ask" C={AutismAsk} />}
      />
      <Route
        path="/watermark-check"
        component={() => <Tracked page="watermark-check" C={WatermarkCheck} />}
      />
      <Route component={NotFound} />
    </Switch>
  );
}

export default function App() {
  // Invisible provenance signature: anything copied off the site (landing
  // page, answers, articles) carries a zero-width "palonur:<page>" mark.
  // See lib/watermark.ts for the honest limits.
  useEffect(
    () =>
      installCopyWatermark(() => `palonur:${window.location.pathname || "/"}`),
    [],
  );
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        {!SLM_STANDALONE && <FirstVisitPopup />}
        {!SLM_STANDALONE && <LanguageSwitcher />}
      </TooltipProvider>
    </QueryClientProvider>
  );
}
