import { useEffect, useMemo, useState } from "react";

// ─── Palo-Alto-time-aligned sky tone ──────────────────────────────────────────
// Inlined so this page is self-contained, matching /platforms.
function hexToRgb(h: string): [number, number, number] {
  const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(h);
  return r ? [parseInt(r[1], 16), parseInt(r[2], 16), parseInt(r[3], 16)] : [0, 0, 0];
}
function rgbToHex(r: number, g: number, b: number) {
  return (
    "#" +
    [r, g, b]
      .map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0"))
      .join("")
  );
}
function lerp(a: string, b: string, t: number) {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}
const SKY = [
  { h: 0, top: "#01010A", upper: "#04041A", horizon: "#080825", glow: "#100818" },
  { h: 5, top: "#03030F", upper: "#08082A", horizon: "#120E38", glow: "#1E1448" },
  { h: 6.5, top: "#130840", upper: "#3A1050", horizon: "#8A2035", glow: "#C83010" },
  { h: 8.5, top: "#2A3860", upper: "#5878A0", horizon: "#D0A870", glow: "#FFE0A0" },
  { h: 12, top: "#3D6AB0", upper: "#75A5C8", horizon: "#EED8B0", glow: "#FFFAF5" },
  { h: 17.5, top: "#284070", upper: "#604858", horizon: "#D08040", glow: "#FFC860" },
  { h: 18.5, top: "#1C1840", upper: "#6A2828", horizon: "#C04010", glow: "#FF8030" },
  { h: 20.5, top: "#070418", upper: "#180818", horizon: "#3C0808", glow: "#7A1010" },
  { h: 23, top: "#01010A", upper: "#04041A", horizon: "#080825", glow: "#100818" },
  { h: 24, top: "#01010A", upper: "#04041A", horizon: "#080825", glow: "#100818" },
];
function interpolateSky(h: number) {
  let p = SKY[0],
    n = SKY[SKY.length - 1];
  for (let i = 0; i < SKY.length - 1; i++) {
    if (h >= SKY[i].h && h < SKY[i + 1].h) {
      p = SKY[i];
      n = SKY[i + 1];
      break;
    }
  }
  const t = (h - p.h) / (n.h - p.h);
  const e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
  return {
    top: lerp(p.top, n.top, e),
    upper: lerp(p.upper, n.upper, e),
    horizon: lerp(p.horizon, n.horizon, e),
    glow: lerp(p.glow, n.glow, e),
  };
}
function getPAHours() {
  const pa = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }),
  );
  return pa.getHours() + pa.getMinutes() / 60 + pa.getSeconds() / 3600;
}

// ─── Style tokens (match /platforms) ──────────────────────────────────────────
const SANS = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif";
const SERIF = "'Georgia','Times New Roman',serif";
const INK = "#0A0A0F";
const PAPER = "#FAF8F4";
const RULE = "rgba(10,10,15,0.12)";

// ─── Self-serve partner signup modal ─────────────────────────────────────────
function SignupModal({ onClose }: { onClose: () => void }) {
  const [companyName, setCompanyName] = useState("");
  const [contactName, setContactName] = useState("");
  const [email, setEmail] = useState("");
  const [intendedUse, setIntendedUse] = useState("");
  const [accept, setAccept] = useState(false);
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!accept || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch("/api/partner-auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          companyName: companyName.trim(),
          contactName: contactName.trim(),
          intendedUse: intendedUse.trim() || undefined,
          acceptLicense: true,
        }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setError(d.error ?? "Something went wrong. Please try again.");
        setSubmitting(false);
        return;
      }
      setSent(true);
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const field: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: "12px 14px",
    border: `1px solid ${RULE}`,
    borderRadius: 12,
    fontSize: 15,
    fontFamily: SANS,
    background: "#fff",
    color: INK,
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgba(10,10,15,0.64)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: PAPER,
          color: INK,
          borderRadius: 20,
          padding: "32px 30px",
          maxWidth: 440,
          width: "100%",
          boxShadow: "0 30px 80px rgba(0,0,0,0.4)",
          maxHeight: "90vh",
          overflowY: "auto",
        }}
      >
        {sent ? (
          <>
            <h2 style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 28, margin: "0 0 14px" }}>
              Check your inbox.
            </h2>
            <p style={{ fontSize: 15, lineHeight: 1.6, color: "#4a4a50", margin: 0 }}>
              We've emailed <strong>{email.trim()}</strong> a one-time link to
              the partner portal. Once we approve your request you'll be able to
              set up payment and generate your API key — all self-serve.
            </p>
            <button
              type="button"
              onClick={onClose}
              style={{
                marginTop: 24,
                background: INK,
                color: "#fff",
                border: "none",
                borderRadius: 999,
                padding: "12px 22px",
                fontSize: 14,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Done
            </button>
          </>
        ) : (
          <>
            <div
              style={{
                fontSize: 11,
                letterSpacing: ".16em",
                textTransform: "uppercase",
                color: "#8a6a4a",
                fontWeight: 700,
                marginBottom: 8,
              }}
            >
              Request agent access
            </div>
            <h2 style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 26, margin: "0 0 18px" }}>
              Tell us about your agent.
            </h2>
            <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <input
                style={field}
                placeholder="Company or product name"
                required
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
              />
              <input
                style={field}
                placeholder="Your name"
                required
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
              />
              <input
                style={field}
                type="email"
                placeholder="you@company.com"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <textarea
                style={{ ...field, minHeight: 80, resize: "vertical" }}
                placeholder="What will your agent do with Palonur? (optional)"
                value={intendedUse}
                onChange={(e) => setIntendedUse(e.target.value)}
              />
              <label
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "flex-start",
                  fontSize: 13,
                  lineHeight: 1.5,
                  color: "#4a4a50",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={accept}
                  onChange={(e) => setAccept(e.target.checked)}
                  style={{ marginTop: 3 }}
                />
                <span>
                  I agree to the{" "}
                  <a
                    href={`${import.meta.env.BASE_URL}agent-license`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: "#8B1A1A" }}
                  >
                    agent usage license
                  </a>{" "}
                  (governed, cited, no-training).
                </span>
              </label>
              {error && (
                <div style={{ color: "#b3261e", fontSize: 13 }}>{error}</div>
              )}
              <button
                type="submit"
                disabled={!accept || submitting}
                style={{
                  marginTop: 4,
                  background: accept ? INK : "#bdbdc2",
                  color: "#fff",
                  border: "none",
                  borderRadius: 999,
                  padding: "13px 22px",
                  fontSize: 15,
                  fontWeight: 700,
                  cursor: accept && !submitting ? "pointer" : "default",
                }}
              >
                {submitting ? "Sending…" : "Request access →"}
              </button>
              <div style={{ fontSize: 12.5, color: "#8a8a90", textAlign: "center" }}>
                Already a partner?{" "}
                <a href={`${import.meta.env.BASE_URL}partner-login`} style={{ color: "#8B1A1A" }}>
                  Sign in
                </a>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

// Anchored high on purpose: the enterprise tier leads, the free Pilot closes
// the row as an on-ramp — visitors adjust toward the premium offer.
const TIERS = [
  {
    name: "Embedded",
    price: "Enterprise",
    cadence: "annual license",
    blurb: "White-label the expert agent under your own brand.",
    points: [
      "Dedicated pillars & steward voices",
      "Custom corpus onboarding",
      "SLA + security review",
      "Co-marketing with Stanford faculty",
    ],
    cta: "Talk to us",
    featured: false,
  },
  {
    name: "Scale",
    price: "Custom",
    cadence: "per agent / volume",
    blurb: "Production access for live consumer or clinical agents.",
    points: [
      "Multiple keys & agents",
      "Volume-based pricing, billed per agent",
      "Priority routing & higher rate limits",
      "Usage analytics + citation verification logs",
      "Shared Slack channel",
    ],
    cta: "Talk to us",
    featured: true,
  },
  {
    name: "Pilot",
    price: "Free",
    cadence: "for 30 days",
    blurb: "Your on-ramp — evaluate governed, cited answers in your product.",
    points: [
      "One partner key, one agent",
      "Up to 1,000 answered questions",
      "Every answer cited to a named Stanford researcher",
      "Email support",
    ],
    cta: "Request a pilot key",
    featured: false,
  },
];

export default function AgentAccess() {
  const [signupOpen, setSignupOpen] = useState(false);
  const [paHours, setPAHours] = useState(getPAHours);
  const colors = useMemo(() => interpolateSky(paHours), [paHours]);
  useEffect(() => {
    const id = setInterval(() => setPAHours(getPAHours()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Deep-link support: scroll to a hash target (e.g. #pricing) after render.
  useEffect(() => {
    const hash = window.location.hash.replace("#", "");
    if (!hash) return;
    const t = setTimeout(() => {
      document.getElementById(hash)?.scrollIntoView({ block: "start" });
    }, 150);
    return () => clearTimeout(t);
  }, []);

  // SEO meta — B2B, distinct from the consumer storefront.
  useEffect(() => {
    const prevTitle = document.title;
    document.title = "Palonur for Agents — Stanford sleep science, on tap";
    const setMeta = (
      name: string,
      content: string,
      attr: "name" | "property" = "name",
    ) => {
      let el = document.querySelector(
        `meta[${attr}="${name}"]`,
      ) as HTMLMetaElement | null;
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
      setMeta(
        "description",
        "Give your AI agent governed, cited access to Stanford lifestyle-medicine science via one partner key. Per-agent pricing, not a consumer subscription.",
      ),
      setMeta("og:title", "Palonur for Agents — Stanford science, on tap", "property"),
      setMeta(
        "og:description",
        "One partner key. Governed, cited answers in your product. Per-agent pricing.",
        "property",
      ),
      setMeta("twitter:title", "Palonur for Agents — Stanford science, on tap"),
    ];
    return () => {
      document.title = prevTitle;
      restorers.forEach((r) => r());
    };
  }, []);

  useEffect(() => {
    const prevBg = document.body.style.background;
    document.body.style.background = PAPER;
    return () => {
      document.body.style.background = prevBg;
    };
  }, []);

  const skyBg = `radial-gradient(ellipse 85% 55% at 50% 100%, ${colors.glow} 0%, ${colors.horizon} 28%, ${colors.upper} 62%, ${colors.top} 100%)`;

  const Cta = ({
    tone,
    label,
  }: {
    tone: "light" | "dark";
    label: string;
  }) => (
    <button
      type="button"
      onClick={() => setSignupOpen(true)}
      style={{
        appearance: "none",
        border: "none",
        cursor: "pointer",
        background: tone === "light" ? "#fff" : INK,
        color: tone === "light" ? INK : "#fff",
        padding: "18px 32px",
        borderRadius: 999,
        fontFamily: SANS,
        fontWeight: 700,
        fontSize: 15,
        letterSpacing: "0.01em",
        boxShadow:
          tone === "light"
            ? "0 12px 32px rgba(0,0,0,0.18)"
            : "0 8px 22px rgba(10,10,15,0.18)",
      }}
    >
      {label}
    </button>
  );

  return (
    <main style={{ background: PAPER, fontFamily: SANS, color: INK }}>
      {signupOpen && <SignupModal onClose={() => setSignupOpen(false)} />}
      {/* ─── HERO ───────────────────────────────────────────────────────── */}
      <section
        style={{
          position: "relative",
          minHeight: "100dvh",
          background: skyBg,
          transition: "background 90s ease",
          overflow: "hidden",
          color: "#fff",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            background:
              "radial-gradient(ellipse at center, rgba(0,0,0,0) 35%, rgba(0,0,0,0.18) 75%, rgba(0,0,0,0.38) 100%)",
          }}
        />
        <div
          style={{
            position: "relative",
            zIndex: 2,
            padding: "26px 32px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 12,
            letterSpacing: ".18em",
            textTransform: "uppercase",
            textShadow: "0 1px 6px rgba(0,0,0,0.5)",
            color: "rgba(255,255,255,0.78)",
          }}
        >
          <a
            href={import.meta.env.BASE_URL}
            style={{
              color: "rgba(255,255,255,0.9)",
              textDecoration: "none",
              fontWeight: 700,
            }}
          >
            Palonur
          </a>
          <span>For agents &amp; platforms</span>
        </div>

        <div
          style={{
            position: "relative",
            zIndex: 2,
            flex: 1,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            padding: "0 32px 8vh",
            maxWidth: 920,
          }}
        >
          <h1
            style={{
              fontFamily: SERIF,
              fontWeight: 400,
              fontSize: "clamp(38px, 7vw, 82px)",
              lineHeight: 1.04,
              letterSpacing: "-0.02em",
              textShadow: "0 2px 18px rgba(0,0,0,0.45)",
              margin: 0,
            }}
          >
            Give your agent a{" "}
            <span style={{ fontStyle: "italic" }}>source</span>.
          </h1>
          <p
            style={{
              marginTop: 24,
              maxWidth: 620,
              fontSize: "clamp(16px, 2.2vw, 21px)",
              lineHeight: 1.5,
              color: "rgba(255,255,255,0.9)",
              textShadow: "0 1px 10px rgba(0,0,0,0.5)",
            }}
          >
            One partner key wires your product into governed, cited answers from
            Stanford lifestyle-medicine faculty. Built for agents and platforms —
            priced per agent, not as a consumer subscription.
          </p>
          <div
            style={{
              marginTop: 36,
              display: "flex",
              gap: 14,
              flexWrap: "wrap",
            }}
          >
            <Cta tone="light" label="Request a pilot key →" />
            <a
              href={`${import.meta.env.BASE_URL}agent-license`}
              style={{
                appearance: "none",
                cursor: "pointer",
                background: "rgba(255,255,255,0.12)",
                color: "#fff",
                border: "1px solid rgba(255,255,255,0.4)",
                padding: "18px 30px",
                borderRadius: 999,
                fontFamily: SANS,
                fontWeight: 700,
                fontSize: 15,
                textDecoration: "none",
                backdropFilter: "blur(4px)",
              }}
            >
              Read the agent license
            </a>
          </div>
        </div>
      </section>

      {/* ─── WHY ─────────────────────────────────────────────────────────── */}
      <section style={{ padding: "clamp(64px, 10vw, 130px) 32px", maxWidth: 980, margin: "0 auto" }}>
        <div
          style={{
            fontSize: 12,
            letterSpacing: ".18em",
            textTransform: "uppercase",
            color: "#8a6a4a",
            marginBottom: 18,
          }}
        >
          Not a consumer plan
        </div>
        <p
          style={{
            margin: "0 0 18px",
            maxWidth: 680,
            fontSize: 18,
            lineHeight: 1.62,
            color: "#3a3a40",
          }}
        >
          This is governed, scientist-signed expert knowledge for agents — not a
          generic API. Every answer is grounded in a curated Stanford corpus and
          signed by the named researcher who stewards it.
        </p>
        <h2
          style={{
            fontFamily: SERIF,
            fontWeight: 400,
            fontSize: "clamp(28px, 4.5vw, 48px)",
            lineHeight: 1.12,
            letterSpacing: "-0.015em",
            margin: 0,
            maxWidth: 760,
          }}
        >
          Consumers subscribe at a few dollars a month. Agents are different — so
          the pricing is too.
        </h2>
        <p
          style={{
            marginTop: 22,
            maxWidth: 680,
            fontSize: 18,
            lineHeight: 1.62,
            color: "#3a3a40",
          }}
        >
          The consumer storefront sells unlimited answers to one person. Agent
          access is metered by the work your agent does on behalf of many people,
          governed by a partner key you control. There's no self-serve checkout —
          we onboard each partner so the corpus, rate limits, and citation
          guarantees fit your use case.
        </p>
      </section>

      {/* ─── PRICING ─────────────────────────────────────────────────────── */}
      <section
        id="pricing"
        style={{
          padding: "0 24px clamp(64px, 10vw, 120px)",
          maxWidth: 1080,
          margin: "0 auto",
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: 20,
          }}
        >
          {TIERS.map((t) => (
            <div
              key={t.name}
              style={{
                position: "relative",
                background: t.featured ? INK : "#fff",
                color: t.featured ? "#fff" : INK,
                border: t.featured ? "none" : `1px solid ${RULE}`,
                borderRadius: 20,
                padding: "30px 26px",
                boxShadow: t.featured
                  ? "0 24px 60px rgba(10,10,15,0.28)"
                  : "0 8px 24px rgba(10,10,15,0.06)",
                display: "flex",
                flexDirection: "column",
              }}
            >
              {t.featured && (
                <div
                  style={{
                    position: "absolute",
                    top: 18,
                    right: 18,
                    fontSize: 10.5,
                    fontWeight: 700,
                    letterSpacing: ".12em",
                    textTransform: "uppercase",
                    color: "#FAD9A0",
                    border: "1px solid rgba(250,217,160,0.5)",
                    borderRadius: 999,
                    padding: "3px 9px",
                  }}
                >
                  Most partners
                </div>
              )}
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  letterSpacing: ".1em",
                  textTransform: "uppercase",
                  color: t.featured ? "rgba(255,255,255,0.7)" : "#8a6a4a",
                  marginBottom: 14,
                }}
              >
                {t.name}
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span
                  style={{
                    fontFamily: SERIF,
                    fontSize: 38,
                    fontWeight: 400,
                    letterSpacing: "-0.02em",
                  }}
                >
                  {t.price}
                </span>
                <span
                  style={{
                    fontSize: 13.5,
                    color: t.featured ? "rgba(255,255,255,0.6)" : "#8a8a90",
                  }}
                >
                  {t.cadence}
                </span>
              </div>
              <p
                style={{
                  marginTop: 12,
                  fontSize: 14.5,
                  lineHeight: 1.55,
                  color: t.featured ? "rgba(255,255,255,0.82)" : "#4a4a50",
                }}
              >
                {t.blurb}
              </p>
              <ul
                style={{
                  listStyle: "none",
                  margin: "18px 0 24px",
                  padding: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                  flex: 1,
                }}
              >
                {t.points.map((p) => (
                  <li
                    key={p}
                    style={{
                      display: "flex",
                      gap: 10,
                      fontSize: 14,
                      lineHeight: 1.45,
                      color: t.featured ? "rgba(255,255,255,0.9)" : "#33333a",
                    }}
                  >
                    <span
                      style={{
                        color: t.featured ? "#FAD9A0" : "#8B1A1A",
                        fontWeight: 700,
                      }}
                    >
                      ✓
                    </span>
                    {p}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => setSignupOpen(true)}
                style={{
                  appearance: "none",
                  cursor: "pointer",
                  border: t.featured ? "none" : `1.5px solid ${INK}`,
                  background: t.featured ? "#fff" : "transparent",
                  color: INK,
                  padding: "13px 20px",
                  borderRadius: 999,
                  fontFamily: SANS,
                  fontWeight: 700,
                  fontSize: 14,
                  width: "100%",
                }}
              >
                {t.cta} →
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* ─── HOW IT WORKS ────────────────────────────────────────────────── */}
      <section
        style={{
          padding: "clamp(56px, 9vw, 110px) 32px",
          maxWidth: 980,
          margin: "0 auto",
          borderTop: `1px solid ${RULE}`,
        }}
      >
        <h2
          style={{
            fontFamily: SERIF,
            fontWeight: 400,
            fontSize: "clamp(26px, 4vw, 42px)",
            lineHeight: 1.12,
            margin: "0 0 36px",
          }}
        >
          How a partner key works
        </h2>
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
              h: "We issue a key",
              b: "After a short onboarding call we mint a partner key scoped to the pillars and rate limits you need.",
            },
            {
              n: "02",
              h: "Your agent calls the API",
              b: "Send questions to the streaming endpoint with the key in a header. Answers come back governed and cited.",
            },
            {
              n: "03",
              h: "Every answer is accountable",
              b: "Each response carries a citation to a named Stanford researcher, verified by our citation guard.",
            },
          ].map((s) => (
            <div key={s.n}>
              <div
                style={{
                  fontFamily: SERIF,
                  fontSize: 30,
                  color: "#cbb89a",
                  marginBottom: 10,
                }}
              >
                {s.n}
              </div>
              <div
                style={{ fontSize: 17, fontWeight: 700, marginBottom: 8 }}
              >
                {s.h}
              </div>
              <p style={{ fontSize: 14.5, lineHeight: 1.55, color: "#4a4a50", margin: 0 }}>
                {s.b}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ─── CLOSING CTA ─────────────────────────────────────────────────── */}
      <section
        style={{
          background: INK,
          color: "#fff",
          padding: "clamp(64px, 10vw, 120px) 32px",
          textAlign: "center",
        }}
      >
        <h2
          style={{
            fontFamily: SERIF,
            fontWeight: 400,
            fontSize: "clamp(30px, 5vw, 56px)",
            lineHeight: 1.08,
            margin: "0 auto 18px",
            maxWidth: 760,
          }}
        >
          Ship Stanford's science with a name on every answer.
        </h2>
        <p
          style={{
            fontSize: 17,
            lineHeight: 1.55,
            color: "rgba(255,255,255,0.72)",
            maxWidth: 560,
            margin: "0 auto 36px",
          }}
        >
          Tell us about your agent and we'll get you a pilot key.
        </p>
        <div style={{ display: "flex", gap: 14, justifyContent: "center", flexWrap: "wrap" }}>
          <Cta tone="light" label="Request a pilot key →" />
          <a
            href={`${import.meta.env.BASE_URL}platforms`}
            style={{
              cursor: "pointer",
              background: "rgba(255,255,255,0.12)",
              color: "#fff",
              border: "1px solid rgba(255,255,255,0.4)",
              padding: "18px 30px",
              borderRadius: 999,
              fontFamily: SANS,
              fontWeight: 700,
              fontSize: 15,
              textDecoration: "none",
            }}
          >
            For AI platforms →
          </a>
        </div>
      </section>
    </main>
  );
}
