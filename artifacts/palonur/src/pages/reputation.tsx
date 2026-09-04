import { useEffect, useMemo, useState } from "react";

// ─── Palo-Alto-time-aligned sky tone ──────────────────────────────────────────
// Inlined so /reputation is self-contained, mirroring /platforms.
function hexToRgb(h: string): [number, number, number] {
  const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(h);
  return r ? [parseInt(r[1], 16), parseInt(r[2], 16), parseInt(r[3], 16)] : [0, 0, 0];
}
function rgbToHex(r: number, g: number, b: number) {
  return "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
}
function lerp(a: string, b: string, t: number) {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}
const SKY = [
  { h: 0,    top: "#01010A", upper: "#04041A", horizon: "#080825", glow: "#100818" },
  { h: 4,    top: "#01010A", upper: "#03030F", horizon: "#07071E", glow: "#0D0718" },
  { h: 5,    top: "#03030F", upper: "#08082A", horizon: "#120E38", glow: "#1E1448" },
  { h: 5.75, top: "#080530", upper: "#160A48", horizon: "#2A1258", glow: "#3E1858" },
  { h: 6.5,  top: "#130840", upper: "#3A1050", horizon: "#8A2035", glow: "#C83010" },
  { h: 7.0,  top: "#1C0A40", upper: "#6B2028", horizon: "#B84010", glow: "#F07020" },
  { h: 7.5,  top: "#251040", upper: "#7A3020", horizon: "#C86020", glow: "#FFB040" },
  { h: 8.5,  top: "#2A3860", upper: "#5878A0", horizon: "#D0A870", glow: "#FFE0A0" },
  { h: 10,   top: "#3858A0", upper: "#6898C0", horizon: "#E8D0A0", glow: "#FFF5E0" },
  { h: 12,   top: "#3D6AB0", upper: "#75A5C8", horizon: "#EED8B0", glow: "#FFFAF5" },
  { h: 14,   top: "#3860A8", upper: "#70A0C0", horizon: "#E8D0A8", glow: "#FFF5F0" },
  { h: 16,   top: "#305898", upper: "#6080A8", horizon: "#E0C080", glow: "#FFE8B8" },
  { h: 17.5, top: "#284070", upper: "#604858", horizon: "#D08040", glow: "#FFC860" },
  { h: 18.5, top: "#1C1840", upper: "#6A2828", horizon: "#C04010", glow: "#FF8030" },
  { h: 19.5, top: "#0E0A28", upper: "#3C1018", horizon: "#900808", glow: "#E04010" },
  { h: 20.5, top: "#070418", upper: "#180818", horizon: "#3C0808", glow: "#7A1010" },
  { h: 21.5, top: "#03020E", upper: "#090618", horizon: "#140A18", glow: "#200A18" },
  { h: 23,   top: "#01010A", upper: "#04041A", horizon: "#080825", glow: "#100818" },
  { h: 24,   top: "#01010A", upper: "#04041A", horizon: "#080825", glow: "#100818" },
];
function interpolateSky(h: number) {
  let p = SKY[0], n = SKY[SKY.length - 1];
  for (let i = 0; i < SKY.length - 1; i++) {
    if (h >= SKY[i].h && h < SKY[i + 1].h) { p = SKY[i]; n = SKY[i + 1]; break; }
  }
  const t = (h - p.h) / (n.h - p.h);
  const e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
  return {
    top:     lerp(p.top,     n.top,     e),
    upper:   lerp(p.upper,   n.upper,   e),
    horizon: lerp(p.horizon, n.horizon, e),
    glow:    lerp(p.glow,    n.glow,    e),
  };
}
function getPAHours() {
  const pa = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  return pa.getHours() + pa.getMinutes() / 60 + pa.getSeconds() / 3600;
}

// ─── Style tokens ─────────────────────────────────────────────────────────────
const SANS  = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif";
const SERIF = "'Georgia','Times New Roman',serif";
const RED   = "#B3261E";
const INK   = "#0A0A0F";
const PAPER = "#FAF8F4";
const RULE  = "rgba(10,10,15,0.12)";
const MUTED = "rgba(10,10,15,0.64)";

// ─── Anti-scraper mailto (subject pre-filled per task spec) ──────────────────
const _PART_USER   = "partners";
const _PART_DOMAIN = "palonur.com";
function openReputationMail() {
  const at = String.fromCharCode(64);
  const addr = `${_PART_USER}${at}${_PART_DOMAIN}`;
  const subject = encodeURIComponent("Reputation — <your institution>");
  window.location.href = `mailto:${addr}?subject=${subject}`;
}

const italic = (s: string) => (
  <em style={{ fontStyle: "italic", fontFamily: SERIF }}>{s}</em>
);

export default function Reputation() {
  // Time-aligned PA sky tone, refreshed every 30s.
  const [paHours, setPAHours] = useState(getPAHours);
  const colors = useMemo(() => interpolateSky(paHours), [paHours]);
  useEffect(() => {
    const id = setInterval(() => setPAHours(getPAHours()), 30_000);
    return () => clearInterval(id);
  }, []);

  // SEO meta — distinct from /platforms and the consumer homepage.
  useEffect(() => {
    const prevTitle = document.title;
    document.title = "Palonur Reputation — AI visibility for scientists & universities";
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
      setMeta("description", "AI is already answering questions in your field. Palonur is the reputation layer that lets scientists and universities see, shape, and earn that conversation."),
      setMeta("og:title",       "Palonur Reputation — AI visibility for scientists & universities", "property"),
      setMeta("og:description", "See, shape, and earn the AI answers about your science. For Stanford faculty and partner institutions.", "property"),
      setMeta("twitter:title",       "Palonur Reputation — AI visibility for scientists & universities"),
      setMeta("twitter:description", "See, shape, and earn the AI answers about your science. For Stanford faculty and partner institutions."),
    ];
    return () => {
      document.title = prevTitle;
      restorers.forEach((r) => r());
    };
  }, []);

  // Force body to PAPER while on this page; restore on unmount.
  useEffect(() => {
    const prevBg = document.body.style.background;
    document.body.style.background = PAPER;
    return () => { document.body.style.background = prevBg; };
  }, []);

  const skyBg = `radial-gradient(ellipse 85% 55% at 50% 100%, ${colors.glow} 0%, ${colors.horizon} 28%, ${colors.upper} 62%, ${colors.top} 100%)`;

  const Cta = ({ tone }: { tone: "light" | "dark" }) => (
    <button
      type="button"
      onClick={openReputationMail}
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
      Talk to us about your field →
    </button>
  );

  // Shared chapter shell.
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
  const innerSplit: React.CSSProperties = {
    ...inner,
    display: "grid",
    gridTemplateColumns: "minmax(0, 7fr) minmax(0, 3fr)",
    gap: "clamp(32px, 5vw, 80px)",
    alignItems: "start",
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
    color: INK, maxWidth: 820,
  };
  const body: React.CSSProperties = {
    margin: 0, maxWidth: 640,
    fontFamily: SERIF,
    fontSize: "clamp(17px, 1.5vw, 19px)",
    lineHeight: 1.6, color: "rgba(10,10,15,0.72)",
  };
  const aside: React.CSSProperties = {
    paddingTop: 8, borderLeft: `1px solid ${RULE}`, paddingLeft: 28,
    fontFamily: SERIF, fontStyle: "italic", lineHeight: 1.55,
    fontSize: "clamp(14px, 1.2vw, 16px)",
    color: "rgba(10,10,15,0.62)",
  };

  const pillars = [
    {
      n: "01",
      kicker: "AEO & SEO",
      head: <>Increase your <em style={{ fontStyle: "italic", fontFamily: SERIF }}>AI search visibility</em>.</>,
      body: "Your papers, your lab, and your university already show up in AI answers — usually paraphrased, often unattributed, sometimes wrong. Palonur indexes your published work into the engines people actually ask, so the answer points back to you and the source it came from.",
      aside: "“If the answer is about your science, your name should be on it.”",
    },
    {
      n: "02",
      kicker: "PR & Communications",
      head: <>Shape the {italic("AI conversation")} about your field.</>,
      body: "When a chatbot summarises your research, you don't get a press cycle to correct it — you get a confident sentence that millions will read. Palonur surfaces what the major models are saying about your work today, flags drift from what you actually published, and gives your comms team a way to push corrections upstream.",
      aside: "“Your press release reaches a thousand people. The AI answer reaches a million.”",
    },
    {
      n: "03",
      kicker: "Content & Demand",
      head: <>Drive {italic("human and bot traffic")} back to your lab.</>,
      body: "Citations from AI engines now route real readers — students, journalists, funders, and other researchers — to the labs and institutions that ground the answer. Palonur turns each AI mention into a tracked path back to your paper, your course, or your university page.",
      aside: "“Every cited answer is a front door to your lab.”",
    },
  ];

  return (
    <main style={{ background: PAPER, fontFamily: SANS, color: INK }}>
      {/* ─── HERO ─────────────────────────────────────────────────────── */}
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
          <span style={{ fontWeight: 500 }}>Reputation · For scientists &amp; universities</span>
        </div>

        <div style={{
          position: "relative", zIndex: 2,
          flex: 1,
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          textAlign: "center",
          padding: "0 clamp(20px, 6vw, 96px)",
        }}>
          <div style={{
            fontSize: 11, fontWeight: 700, letterSpacing: ".22em",
            textTransform: "uppercase",
            color: "rgba(255,255,255,0.7)",
            marginBottom: 28,
            textShadow: "0 1px 6px rgba(0,0,0,0.5)",
          }}>
            The AI reputation layer for science
          </div>
          <h1 style={{
            margin: "0 0 28px",
            fontFamily: SERIF, fontWeight: 500,
            fontSize: "clamp(44px, 7.6vw, 96px)",
            lineHeight: 0.98, letterSpacing: "-0.025em",
            maxWidth: 1100,
            color: "rgba(255,255,255,0.98)",
            textShadow: "0 2px 22px rgba(0,0,0,0.6)",
          }}>
            Your science. <em style={{ fontStyle: "italic" }}>Their answer.</em>
          </h1>
          <p style={{
            margin: "0 0 40px", maxWidth: 720,
            fontFamily: SERIF,
            fontSize: "clamp(17px, 1.7vw, 22px)",
            lineHeight: 1.55,
            color: "rgba(255,255,255,0.82)",
            textShadow: "0 1px 8px rgba(0,0,0,0.5)",
          }}>
            AI is already answering questions in your field — with or without
            you. Palonur lets scientists and universities see, shape, and earn
            that conversation.
          </p>
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

      {/* ─── PILLARS · 01 / 02 / 03 ───────────────────────────────────── */}
      {pillars.map((p) => (
        <section key={p.n} style={chapter}>
          <div style={innerSplit}>
            <div>
              <div style={eyebrow}>{p.n} · {p.kicker}</div>
              <h2 style={headline}>{p.head}</h2>
              <p style={body}>{p.body}</p>
            </div>
            <aside style={aside}>{p.aside}</aside>
          </div>
        </section>
      ))}

      {/* ─── HOW IT WORKS ─────────────────────────────────────────────── */}
      <section style={chapter}>
        <div style={inner}>
          <div style={eyebrow}>How it works</div>
          <h2 style={{ ...headline, marginBottom: 18 }}>
            Three steps. {italic("One reputation surface.")}
          </h2>
          <p style={{ ...body, marginBottom: 56 }}>
            Built for principal investigators and university comms teams who
            want a single view of how AI is talking about their work — and a
            way to act on it.
          </p>

          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: 28,
          }}>
            {[
              { n: "01", t: "Connect your field",
                d: "Tell us your lab, your published corpus, and the questions your field actually gets asked. We bootstrap from your publication record." },
              { n: "02", t: "We monitor the major engines",
                d: "Palonur tracks how ChatGPT, Perplexity, Gemini, Claude, and others answer questions about your work — citations, paraphrases, and gaps." },
              { n: "03", t: "You see what to publish next",
                d: "A weekly view of citations earned, drift from your published findings, and the open questions your next paper or post should answer." },
            ].map((s) => (
              <div key={s.n}>
                <div style={{
                  width: 56, height: 56, borderRadius: "50%",
                  border: `1.5px solid ${INK}`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontFamily: SERIF, fontSize: 20, fontWeight: 500,
                  color: INK, marginBottom: 22,
                }}>{s.n}</div>
                <div style={{
                  fontFamily: SERIF, fontSize: 22, fontWeight: 500,
                  color: INK, marginBottom: 12, lineHeight: 1.25,
                }}>{s.t}</div>
                <div style={{
                  fontFamily: SERIF, fontSize: 16, lineHeight: 1.6,
                  color: "rgba(10,10,15,0.62)",
                }}>{s.d}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── CLOSE — THE ASK ──────────────────────────────────────────── */}
      <section style={{
        ...chapter,
        borderBottom: "none",
        flexDirection: "column",
        justifyContent: "center",
        textAlign: "center",
        gap: "clamp(28px, 5vh, 56px)",
      }}>
        <div style={{ ...eyebrow, marginBottom: 0 }}>Pilot with us</div>
        <h2 style={{
          ...headline,
          margin: "0 auto",
          maxWidth: 900,
          textAlign: "center",
        }}>
          Put your name on {italic("the answer")}.
        </h2>
        <p style={{
          ...body,
          margin: "0 auto",
          textAlign: "center",
          color: MUTED,
        }}>
          We're now open for selected clients. Get in touch.
        </p>
        <Cta tone="dark" />
      </section>

      {/* ─── FOOTER ──────────────────────────────────────────────────── */}
      <footer style={{
        padding: "28px clamp(24px, 6vw, 96px) 40px",
        background: PAPER,
        borderTop: `1px solid ${RULE}`,
        fontSize: 12, color: "rgba(10,10,15,0.5)",
        display: "flex", flexWrap: "wrap", gap: 18,
        alignItems: "center", justifyContent: "space-between",
        letterSpacing: "0.02em",
      }}>
        <span>© Palonur</span>
        <span style={{ display: "flex", gap: 18, alignItems: "center" }}>
          <a href={`${import.meta.env.BASE_URL}reputation/dashboard`} style={{
            color: "rgba(10,10,15,0.5)", textDecoration: "none", fontSize: 11,
          }}>
            internal: live tracker →
          </a>
          <a href={import.meta.env.BASE_URL} style={{
            color: INK, textDecoration: "none", fontWeight: 600,
          }}>
            ← palonur.com
          </a>
        </span>
      </footer>
    </main>
  );
}
