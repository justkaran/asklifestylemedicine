import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

const PAPER = "#FAF8F4";
const INK   = "#0a0a0f";
const BG    = "#0D0D14";
const GOLD  = "#C9A87C";
const RULE  = "rgba(10,10,15,0.1)";
const SERIF = "'Georgia','Times New Roman',serif";
const SANS  = "-apple-system, BlinkMacSystemFont,'SF Pro Text','Inter',system-ui,sans-serif";
const MONO  = "ui-monospace, SFMono-Regular, Menlo, Consolas,'Liberation Mono',monospace";

// ─── Sky interpolation ────────────────────────────────────────────────────────
// Map 24-hr floating-point local PA time to a sky color set (top, upper,
// horizon, glow). Times & colors are hand-tuned keyframes; values between them
// are linearly interpolated in the hex → rgb domain so the transitions feel
// atmospheric rather than mechanical.
type SkyColors = { top: string; upper: string; horizon: string; glow: string };

const SKY_FRAMES: Array<{ h: number } & SkyColors> = [
  { h:  0, top: "#01010A", upper: "#060614", horizon: "#0D0D22", glow: "#1a1a3a" },
  { h:  4, top: "#01010A", upper: "#080818", horizon: "#14122a", glow: "#23203d" },
  { h:  5, top: "#050520", upper: "#0d0b2e", horizon: "#261e40", glow: "#3b1f4a" },
  { h:  6, top: "#0d0820", upper: "#1e1238", horizon: "#5c2a50", glow: "#c8503a" },
  { h:  7, top: "#182040", upper: "#2e3060", horizon: "#7a4070", glow: "#f0804a" },
  { h:  8, top: "#1a3060", upper: "#2060a0", horizon: "#4898d0", glow: "#f0c070" },
  { h: 10, top: "#1a4080", upper: "#2880c0", horizon: "#60b0e0", glow: "#ffe0a0" },
  { h: 13, top: "#0e3565", upper: "#1060a8", horizon: "#40a0d8", glow: "#ffe8a8" },
  { h: 16, top: "#1a3a6e", upper: "#1a5090", horizon: "#38a0cc", glow: "#ffd080" },
  { h: 18, top: "#2a1840", upper: "#602050", horizon: "#c04030", glow: "#ffa030" },
  { h: 19, top: "#1a0820", upper: "#380828", horizon: "#801828", glow: "#d04018" },
  { h: 20, top: "#080414", upper: "#180820", horizon: "#2a1030", glow: "#481220" },
  { h: 22, top: "#03020e", upper: "#07061a", horizon: "#100e24", glow: "#1c1a38" },
  { h: 24, top: "#01010A", upper: "#060614", horizon: "#0D0D22", glow: "#1a1a3a" },
];

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function lerpColor(c1: string, c2: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(c1);
  const [r2, g2, b2] = hexToRgb(c2);
  return rgbToHex(lerp(r1, r2, t), lerp(g1, g2, t), lerp(b1, b2, t));
}
function interpolateSky(h: number): SkyColors {
  for (let i = 0; i < SKY_FRAMES.length - 1; i++) {
    const a = SKY_FRAMES[i], b = SKY_FRAMES[i + 1];
    if (h >= a.h && h <= b.h) {
      const t = (h - a.h) / (b.h - a.h);
      return {
        top:     lerpColor(a.top,     b.top,     t),
        upper:   lerpColor(a.upper,   b.upper,   t),
        horizon: lerpColor(a.horizon, b.horizon, t),
        glow:    lerpColor(a.glow,    b.glow,    t),
      };
    }
  }
  return SKY_FRAMES[0];
}
function getPAHours(): number {
  const d = new Date();
  const ms = d.getTime() + d.getTimezoneOffset() * 60_000 - 7 * 3_600_000;
  const local = new Date(ms);
  return local.getHours() + local.getMinutes() / 60;
}

// ─── Partner mail (obfuscated) ────────────────────────────────────────────────
function openPartnerMail() {
  const parts = ["partners", "@", "palonur", ".", "com"];
  window.location.href = "mailto:" + parts.join("") + "?subject=Palonur%20pilot";
}

// ─── Code snippets ────────────────────────────────────────────────────────────
const QUICKSTART_CURL = `curl -N -X POST https://palonur.replit.app/api/sleep-agent \\
  -H "Content-Type: application/json" \\
  -H "X-Palonur-Key: $PALONUR_KEY" \\
  -d '{"message": "Does evening light affect sleep?", "history": []}'`;

const QUICKSTART_NODE = `// Node 18+ (built-in fetch)
const res = await fetch("https://palonur.replit.app/api/sleep-agent", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Palonur-Key": process.env.PALONUR_KEY,
  },
  body: JSON.stringify({ message: "Does evening light affect sleep?" }),
});
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  for (const line of buf.split("\\n")) {
    if (!line.startsWith("data:")) continue;
    const j = JSON.parse(line.slice(5).trim());
    if (j.content) process.stdout.write(j.content);
  }
  buf = buf.split("\\n").pop() ?? "";
}`;

const QUICKSTART_PYTHON = `# Python 3.10+ (httpx)
import os, json, httpx

with httpx.stream(
    "POST",
    "https://palonur.replit.app/api/sleep-agent",
    headers={
        "Content-Type": "application/json",
        "X-Palonur-Key": os.environ["PALONUR_KEY"],
    },
    json={"message": "Does evening light affect sleep?"},
    timeout=60.0,
) as r:
    for line in r.iter_lines():
        if not line.startswith("data:"):
            continue
        ev = json.loads(line[5:].strip())
        if "content" in ev:
            print(ev["content"], end="", flush=True)`;

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function Platforms() {
  const { t } = useTranslation("platforms");
  // Time-aligned PA sky tone, refreshed every 30s.
  const [paHours, setPAHours] = useState(getPAHours);
  const colors = useMemo(() => interpolateSky(paHours), [paHours]);
  useEffect(() => {
    const id = setInterval(() => setPAHours(getPAHours()), 30_000);
    return () => clearInterval(id);
  }, []);

  // SEO meta — distinct from the consumer homepage.
  useEffect(() => {
    const prevTitle = document.title;
    document.title = t("heroTagline");
    const setMeta = (name: string, content: string, attr: "name" | "property" = "name") => {
      let el = document.querySelector(`meta[${attr}="${name}"]`) as HTMLMetaElement | null;
      const created = !el;
      if (!el) {
        el = document.createElement("meta");
        el.setAttribute(attr, name);
        document.head.appendChild(el);
      }
      const prev = el.getAttribute("content");
      el.setAttribute("content", content);
      return () => {
        if (created) el!.remove();
        else if (prev !== null) el!.setAttribute("content", prev);
      };
    };
    const restorers = [
      setMeta("description", "Palonur routes your users' sleep questions through Prof. Jamie Zeitzer and his team at the Stanford School of Medicine. Every answer comes back with a name on it."),
      setMeta("og:title",       "Palonur — Stanford sleep science, signed by Jamie Zeitzer", "property"),
      setMeta("og:description", "Ship Stanford's sleep science. Routed through Prof. Jamie Zeitzer and his team.", "property"),
      setMeta("twitter:title",       "Palonur — Stanford sleep science, signed by Jamie Zeitzer"),
      setMeta("twitter:description", "Ship Stanford's sleep science. Routed through Prof. Jamie Zeitzer and his team."),
    ];
    return () => {
      document.title = prevTitle;
      restorers.forEach((r) => r());
    };
  }, []);

  // Force body to PAPER while on this page; restore on unmount so the
  // consumer routes (which expect #01010A) aren't affected.
  useEffect(() => {
    const prevBg = document.body.style.background;
    document.body.style.background = PAPER;
    return () => { document.body.style.background = prevBg; };
  }, []);

  const skyBg = `radial-gradient(ellipse 85% 55% at 50% 100%, ${colors.glow} 0%, ${colors.horizon} 28%, ${colors.upper} 62%, ${colors.top} 100%)`;

  // CTA button — used in the hero and the closing screen.
  const Cta = ({ tone }: { tone: "light" | "dark" }) => (
    <button
      type="button"
      onClick={openPartnerMail}
      style={{
        appearance: "none", border: "none", cursor: "pointer",
        background: tone === "light" ? "#fff" : INK,
        color:      tone === "light" ? INK    : "#fff",
        padding: "18px 32px", borderRadius: 999,
        fontFamily: SANS, fontWeight: 700, fontSize: 15,
        letterSpacing: "0.01em",
        boxShadow: tone === "light"
          ? "0 12px 32px rgba(0,0,0,0.18)"
          : "0 8px 22px rgba(10,10,15,0.18)",
      }}
    >
      {t("requestPilot")}
    </button>
  );

  // Render "Jamie Zeitzer {{em}}signs{{/em}} every sleep answer." with italic em.
  const heroRaw = t("heroHeadline");
  const heroMatch = heroRaw.match(/^(.*)\{\{em\}\}(.*)\{\{\/em\}\}(.*)$/s);
  const heroHeadline = heroMatch ? (
    <>{heroMatch[1]}<em style={{ fontStyle: "italic" }}>{heroMatch[2]}</em>{heroMatch[3]}</>
  ) : <>{heroRaw}</>;

  return (
    <main style={{ background: PAPER, fontFamily: SANS, color: INK }}>
      {/* ─── HERO ─────────────────────────────────────────────────────────
          Single promise. Single button. The italic accent on "signs" is the
          one and only italic moment on the entire page — it's the verb that
          does the work. Everything else stays in roman type.            */}
      <section
        style={{
          position: "relative",
          minHeight: "100dvh",
          background: skyBg,
          transition: "background 90s ease",
          overflow: "hidden",
          color: "#fff",
          display: "flex", flexDirection: "column",
        }}
      >
        <div style={{
          position: "absolute", inset: 0, pointerEvents: "none",
          background: "radial-gradient(ellipse at center, rgba(0,0,0,0) 35%, rgba(0,0,0,0.18) 75%, rgba(0,0,0,0.38) 100%)",
        }} />

        <div style={{
          position: "relative", zIndex: 2,
          padding: "26px 32px",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          fontSize: 12, letterSpacing: ".18em", textTransform: "uppercase",
          textShadow: "0 1px 6px rgba(0,0,0,0.5)",
          color: "rgba(255,255,255,0.78)",
        }}>
          <a href={import.meta.env.BASE_URL} style={{
            color: "rgba(255,255,255,0.9)", textDecoration: "none", fontWeight: 700,
          }}>
            Palonur
          </a>
          <span style={{ fontWeight: 500 }}>{t("heroTagline")}</span>
        </div>

        <div style={{
          position: "relative", zIndex: 2,
          flex: 1,
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          textAlign: "center",
          padding: "0 clamp(20px, 6vw, 96px)",
        }}>
          <h1 style={{
            margin: "0 0 40px",
            fontFamily: SERIF, fontWeight: 500,
            fontSize: "clamp(44px, 7.6vw, 96px)",
            lineHeight: 0.98, letterSpacing: "-0.025em",
            maxWidth: 1100,
            color: "rgba(255,255,255,0.98)",
            textShadow: "0 2px 22px rgba(0,0,0,0.6)",
          }}>
            {heroHeadline}
          </h1>
          <Cta tone="light" />
        </div>

        <div style={{
          position: "relative", zIndex: 2,
          alignSelf: "center", marginBottom: 32,
          fontSize: 11, letterSpacing: ".22em", textTransform: "uppercase",
          color: "rgba(255,255,255,0.55)",
          textShadow: "0 1px 6px rgba(0,0,0,0.55)",
        }}>
          ↓
        </div>
      </section>

      {/* ─── BEAT 1 — THE MOMENT ─────────────────────────────────────── */}
      <section style={beatStyle()}>
        <h2 style={beatHead()}>{t("beat1")}</h2>
      </section>

      {/* ─── BEAT 2 — THE ANSWER ─────────────────────────────────────── */}
      <section style={beatStyle()}>
        <h2 style={beatHead()}>{t("beat2")}</h2>
      </section>

      {/* ─── BEAT 3 — THE TEAM ───────────────────────────────────────── */}
      <section style={beatStyle()}>
        <div style={{ maxWidth: 1000 }}>
          <h2 style={beatHead()}>{t("beat3.headline")}</h2>
          <p style={{
            margin: "28px auto 0", maxWidth: 720,
            fontFamily: SERIF, fontSize: "clamp(17px, 1.6vw, 21px)",
            lineHeight: 1.6, color: "rgba(10,10,15,0.7)",
          }}>
            {t("beat3.body1")}
          </p>
          <p style={{
            margin: "20px auto 0", maxWidth: 720,
            fontFamily: SERIF, fontSize: "clamp(17px, 1.6vw, 21px)",
            fontStyle: "italic",
            lineHeight: 1.6, color: "rgba(10,10,15,0.82)",
          }}>
            {t("beat3.body2")}
          </p>
        </div>
      </section>

      {/* ─── INTEGRATION ─────────────────────────────────────────────── */}
      <section
        id="integration"
        style={{
          background: BG,
          color: "rgba(255,255,255,0.95)",
          padding: "clamp(80px, 12vh, 140px) clamp(24px, 6vw, 96px)",
          borderBottom: `1px solid ${RULE}`,
        }}
      >
        <div style={{ maxWidth: 880, margin: "0 auto" }}>
          <div style={{
            fontSize: 11, fontWeight: 700, letterSpacing: ".22em",
            textTransform: "uppercase", color: GOLD, marginBottom: 14,
          }}>
            {t("integration.eyebrow")}
          </div>
          <h2 style={{
            margin: "0 0 14px",
            fontFamily: SERIF, fontWeight: 600,
            fontSize: "clamp(30px, 4vw, 48px)",
            lineHeight: 1.1, letterSpacing: "-0.018em",
            color: "rgba(255,255,255,0.98)",
          }}>
            {t("integration.headline")}
          </h2>
          <p style={{
            margin: "0 0 28px", maxWidth: 720,
            fontSize: 16, lineHeight: 1.6, color: "rgba(255,255,255,0.65)",
          }}>
            {t("integration.body")}{" "}
            <a href={`${import.meta.env.BASE_URL}agents`} style={{
              color: GOLD, textDecoration: "none", borderBottom: `1px solid ${GOLD}`,
            }}>
              /agents
            </a>.
          </p>

          {/* Quick-start curl */}
          <SubLabel>{t("integration.quickstartCurl")}</SubLabel>
          <Code>{QUICKSTART_CURL}</Code>
          <Hint>
            {t("integration.curlHint")}{" "}
            <code>data:</code>{" "}
            {t("integration.curlHint2")}{" "}
            <code>content</code>{" "}
            {t("integration.curlHint3")}
          </Hint>

          <SubLabel>{t("integration.node")}</SubLabel>
          <Code>{QUICKSTART_NODE}</Code>

          <SubLabel>{t("integration.python")}</SubLabel>
          <Code>{QUICKSTART_PYTHON}</Code>

          {/* Auth */}
          <SubLabel>{t("integration.auth")}</SubLabel>
          <p style={{
            margin: "0 0 12px", fontSize: 15, lineHeight: 1.6,
            color: "rgba(255,255,255,0.75)",
          }}>
            {t("integration.authBody1")}{" "}
            <code>X-Palonur-Key</code>{" "}
            {t("integration.authBody2")}
          </p>
          <p style={{
            margin: "0 0 8px", fontSize: 15, lineHeight: 1.6,
            color: "rgba(255,255,255,0.75)",
          }}>
            {t("integration.authBody3")}
          </p>
          <Hint>{t("integration.authHint")}</Hint>

          {/* Rate limits */}
          <SubLabel>{t("integration.rateLabel")}</SubLabel>
          <div style={{
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 10,
            padding: "16px 20px",
            background: "rgba(255,255,255,0.02)",
            marginBottom: 12,
          }}>
            <Row k={t("integration.rateEval")} v={t("integration.rateEvalVal")} />
            <Row k={t("integration.ratePilot")} v={t("integration.ratePilotVal")} />
            <Row k={t("integration.rateProd")} v={t("integration.rateProdVal")} />
            <Row k={t("integration.rateConc")} v={t("integration.rateConcVal")} last />
          </div>
          <Hint>
            {t("integration.rateHint")}{" "}
            <code>429</code>{" "}
            {t("integration.rateHint2")}{" "}
            <code>Retry-After</code>{" "}
            {t("integration.rateHint3")}
          </Hint>

          {/* Versioning */}
          <SubLabel>{t("integration.versioning")}</SubLabel>
          <p style={{
            margin: "0 0 12px", fontSize: 15, lineHeight: 1.6,
            color: "rgba(255,255,255,0.75)",
          }}>
            {t("integration.versionBody")}{" "}
            <code>v1</code>{t("integration.versionServed")}{" "}
            <code>/api/sleep-agent</code>.{" "}
            {t("integration.versionRules")}
          </p>
          <ul style={{
            margin: "0 0 12px 20px", padding: 0,
            fontSize: 15, lineHeight: 1.7, color: "rgba(255,255,255,0.7)",
          }}>
            <li>
              <strong style={{ color: "rgba(255,255,255,0.92)" }}>
                {t("integration.versionAdditive")}
              </strong>{" "}
              {t("integration.versionAdditiveBody")}{" "}
              <code>data:</code>{" "}
              {t("integration.versionAdditiveBody2")}
            </li>
            <li>
              <strong style={{ color: "rgba(255,255,255,0.92)" }}>
                {t("integration.versionBreaking")}
              </strong>{" "}
              {t("integration.versionBreakingBody")}
            </li>
            <li>
              <strong style={{ color: "rgba(255,255,255,0.92)" }}>
                {t("integration.versionPin")}
              </strong>{" "}
              {t("integration.versionPinBody")}{" "}
              <code>X-Palonur-Api-Version: 2026-05-01</code>
              {t("integration.versionPinBody2")}
            </li>
            <li>
              <strong style={{ color: "rgba(255,255,255,0.92)" }}>
                {t("integration.versionRefusal")}
              </strong>{" "}
              <code>REFUSE:</code>{" "}
              {t("integration.versionRefusalBody")}{" "}
              <code>UNCOVERED:</code>{" "}
              {t("integration.versionRefusalBody2")}
            </li>
          </ul>
          <Hint>{t("integration.versionHint")}</Hint>

          {/* Drop into ChatGPT / Claude */}
          <SubLabel>{t("integration.chatgpt")}</SubLabel>
          <p style={{
            margin: "0 0 12px", fontSize: 15, lineHeight: 1.6,
            color: "rgba(255,255,255,0.75)",
          }}>
            {t("integration.chatgptBody")}
          </p>
          <Code>{`POST  https://palonur.replit.app/api/agent/query
GET   https://palonur.replit.app/api/agent/query?q=<question>
GET   https://palonur.replit.app/api/agent/spec   # OpenAPI 3.0 — paste into ChatGPT/Claude`}</Code>
          <Hint>
            {t("integration.chatgptHint")}{" "}
            <code>/api/sleep-agent</code>{" "}
            {t("integration.chatgptHint2")}{" "}
            <code>provenance</code>{" "}
            {t("integration.chatgptHint3")}{" "}
            <code>/api/agent/query</code>{" "}
            {t("integration.chatgptHint4")}{" "}
            <code>provenance</code>.
          </Hint>

          {/* Cross-link to /agents */}
          <div style={{
            marginTop: 28, padding: "18px 22px",
            border: `1px solid ${GOLD}`, borderRadius: 12,
            background: "rgba(201,168,124,0.05)",
            display: "flex", flexWrap: "wrap", gap: 14,
            alignItems: "center", justifyContent: "space-between",
          }}>
            <div style={{ fontSize: 14, color: "rgba(255,255,255,0.78)", lineHeight: 1.5 }}>
              {t("integration.interactiveConsole")}{" "}
              <code>/agents</code>.
            </div>
            <a href={`${import.meta.env.BASE_URL}agents`} style={{
              color: GOLD, textDecoration: "none", fontWeight: 700,
              fontSize: 13, letterSpacing: ".06em",
              whiteSpace: "nowrap",
            }}>
              {t("integration.viewDocs")}
            </a>
          </div>
        </div>
      </section>

      {/* ─── CLOSE — THE ASK ─────────────────────────────────────────── */}
      <section style={{
        ...beatStyle(),
        borderBottom: "none",
        flexDirection: "column",
        gap: "clamp(36px, 6vh, 72px)",
      }}>
        <h2 style={{
          ...beatHead(),
          maxWidth: 900,
        }}>
          {t("closing.ship")}
        </h2>
        <Cta tone="dark" />
      </section>

      {/* ─── Comparison · plain AI vs Stanford ───────────────────────────── */}
      <style>{`
        .palonur-cmp-plain {
          transition: filter .35s ease, transform .35s ease, opacity .35s ease;
        }
        .palonur-cmp-plain:hover {
          filter: grayscale(0.55) brightness(0.97);
          transform: scale(0.99);
          opacity: 0.86;
        }
        .palonur-cmp-stanford {
          transition: transform .35s ease, box-shadow .35s ease, border-color .35s ease;
        }
        .palonur-cmp-stanford:hover {
          transform: translateY(-3px) scale(1.008);
          box-shadow: 0 22px 56px rgba(232,53,42,0.18);
        }
        .palonur-cmp-stanford .palonur-cmp-check {
          opacity: 0; transform: translateX(-4px);
          transition: opacity .45s ease, transform .45s ease;
        }
        .palonur-cmp-stanford:hover .palonur-cmp-check {
          opacity: 1; transform: translateX(0);
        }
        @media (prefers-reduced-motion: reduce) {
          .palonur-cmp-plain, .palonur-cmp-stanford,
          .palonur-cmp-stanford .palonur-cmp-check {
            transition: none !important;
          }
        }
      `}</style>
      <section style={{
        background: PAPER, color: INK,
        padding: "clamp(72px, 12vh, 120px) clamp(24px, 6vw, 96px)",
        borderTop: `1px solid ${RULE}`,
      }}>
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          <div style={{
            fontSize: 11, fontWeight: 700, letterSpacing: ".24em",
            textTransform: "uppercase", color: "#B3261E", marginBottom: 24,
          }}>{t("comparison.label")}</div>
          <h2 style={{
            margin: "0 0 18px",
            fontFamily: "'Georgia','Times New Roman',serif", fontWeight: 500,
            fontSize: "clamp(30px, 4.4vw, 52px)",
            lineHeight: 1.08, letterSpacing: "-0.018em",
            color: INK, maxWidth: 820,
          }}>
            {t("comparison.headline")}{" "}
            <em style={{ fontStyle: "italic" }}>{t("comparison.headlineEm")}</em>.
          </h2>
          <p style={{
            margin: "0 0 48px", maxWidth: 640,
            fontFamily: "'Georgia','Times New Roman',serif",
            fontSize: 17, lineHeight: 1.6,
            color: "rgba(10,10,15,0.72)", fontStyle: "italic",
          }}>
            {t("comparison.question")}
          </p>

          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: 20,
          }}>
            <div className="palonur-cmp-plain" style={{
              background: "#fff", border: `1px solid ${RULE}`,
              borderRadius: 22, padding: "28px 28px 26px",
            }}>
              <div style={{
                fontSize: 10, fontWeight: 700, letterSpacing: ".22em",
                textTransform: "uppercase", color: "rgba(10,10,15,0.64)",
                marginBottom: 18,
              }}>{t("comparison.plainLabel")}</div>
              <div style={{
                fontFamily: "'Georgia','Times New Roman',serif",
                fontSize: 16, lineHeight: 1.6,
                color: "rgba(10,10,15,0.72)",
                paddingBottom: 16, borderBottom: `1px solid ${RULE}`,
                marginBottom: 14,
              }}>
                "Yes, for a lot of people it does — but not because 'screens
                are evil.' Mental stimulation keeps the brain alert. Blue
                light can delay melatonin, though the effect is probably
                smaller than headlines suggest. A 10-minute scroll easily
                becomes 45, cutting sleep. Try keeping the phone farther and
                dimmer, avoid stimulating apps in the last 30–60 minutes,
                and turn on Night Shift."
              </div>
              <div style={{
                display: "flex", alignItems: "center", gap: 8,
                fontSize: 12, color: "rgba(10,10,15,0.42)",
              }}>
                <span style={{
                  display: "inline-block", width: 8, height: 8, borderRadius: "50%",
                  background: "rgba(10,10,15,0.18)",
                }} />
                {t("comparison.noSource")}
              </div>
            </div>

            <div className="palonur-cmp-stanford" style={{
              position: "relative",
              background: "#fff", border: `1px solid #B3261E`,
              borderRadius: 22, padding: "28px 28px 26px",
              boxShadow: "0 12px 36px rgba(232,53,42,0.08)",
            }}>
              <svg
                className="palonur-cmp-check"
                aria-hidden
                width="22" height="22" viewBox="0 0 24 24"
                fill="none" stroke="#B3261E" strokeWidth="2.4"
                strokeLinecap="round" strokeLinejoin="round"
                style={{ position: "absolute", top: 18, right: 18 }}
              >
                <polyline points="4 12 10 18 20 6" />
              </svg>
              <div style={{
                fontSize: 10, fontWeight: 700, letterSpacing: ".22em",
                textTransform: "uppercase", color: "#B3261E", marginBottom: 18,
              }}>{t("comparison.stanfordLabel")}</div>
              <div style={{
                fontFamily: "'Georgia','Times New Roman',serif",
                fontSize: 16, lineHeight: 1.6,
                color: "rgba(10,10,15,0.92)",
                paddingBottom: 16, borderBottom: `1px solid ${RULE}`,
                marginBottom: 14,
              }}>
                "Most of the effect is brightness, not color. About 100 lux —
                dimmer than a typical lit living room — already cuts evening
                melatonin in half and pushes sleep later. A phone held close
                to your face easily clears that. Dimming the whole room in
                the hour before bed moves the needle more than night-mode
                on any single screen."
              </div>
              <div style={{
                display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
                fontSize: 12, color: "rgba(10,10,15,0.7)",
              }}>
                <span style={{
                  fontSize: 9, fontWeight: 800, letterSpacing: ".18em",
                  color: "#fff", background: "#8B1A1A",
                  padding: "3px 7px", borderRadius: 3,
                }}>STANFORD</span>
                <span>{t("comparison.citation")}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ─── FOOTER ─────────────────────────────────────────────────── */}
      <footer style={{
        padding: "28px clamp(24px, 6vw, 96px) 40px",
        background: PAPER,
        borderTop: `1px solid ${RULE}`,
        fontSize: 12, color: "rgba(10,10,15,0.5)",
        display: "flex", flexWrap: "wrap", gap: 18,
        alignItems: "center", justifyContent: "space-between",
        letterSpacing: "0.02em",
      }}>
        <span>{t("footer.copyright")}</span>
        <a href={import.meta.env.BASE_URL} style={{
          color: INK, textDecoration: "none", fontWeight: 600,
        }}>
          ← {t("footer.back")}
        </a>
      </footer>
    </main>
  );
}

// ─── Shared screen styles ────────────────────────────────────────────────────
function beatStyle(): React.CSSProperties {
  return {
    minHeight: "92vh",
    padding: "clamp(72px, 12vh, 140px) clamp(24px, 6vw, 96px)",
    display: "flex", alignItems: "center", justifyContent: "center",
    textAlign: "center",
    background: PAPER,
    borderBottom: `1px solid ${RULE}`,
  };
}
function beatHead(): React.CSSProperties {
  return {
    margin: 0,
    fontFamily: SERIF, fontWeight: 500,
    fontSize: "clamp(36px, 6vw, 76px)",
    lineHeight: 1.05, letterSpacing: "-0.02em",
    color: INK,
    maxWidth: 1000,
  };
}

// ─── Integration beat helpers ─────────────────────────────────────────────────
function SubLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      marginTop: 28, marginBottom: 10,
      fontSize: 12, fontWeight: 700,
      letterSpacing: ".14em", textTransform: "uppercase",
      color: "rgba(255,255,255,0.85)",
    }}>
      {children}
    </div>
  );
}

function Code({ children }: { children: string }) {
  return (
    <pre style={{
      margin: 0,
      background: "#000",
      border: "1px solid rgba(255,255,255,0.1)",
      borderRadius: 10,
      padding: 18,
      fontFamily: MONO, fontSize: 13, lineHeight: 1.55,
      color: "rgba(255,255,255,0.88)",
      whiteSpace: "pre-wrap", wordBreak: "break-word",
      overflow: "auto",
    }}>
      {children}
    </pre>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      marginTop: 10, fontSize: 13, lineHeight: 1.55,
      color: "rgba(255,255,255,0.55)",
    }}>
      {children}
    </div>
  );
}

function Row({ k, v, last }: { k: string; v: string; last?: boolean }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", gap: 16,
      padding: "10px 0",
      borderBottom: last ? "none" : "1px solid rgba(255,255,255,0.06)",
      fontSize: 14,
    }}>
      <span style={{ color: "rgba(255,255,255,0.7)" }}>{k}</span>
      <span style={{ color: "rgba(255,255,255,0.95)", fontFamily: MONO, fontSize: 13 }}>{v}</span>
    </div>
  );
}
