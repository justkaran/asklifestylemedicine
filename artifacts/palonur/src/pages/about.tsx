import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { TEAM } from "../lib/team";
import TavusAvatarButton from "../components/TavusAvatar";

const BASE = import.meta.env.BASE_URL;

const SANS  = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif";
const SERIF = "'Georgia','Times New Roman',serif";
const RED   = "#B3261E";
const INK   = "#0A0A0F";
const PAPER = "#FAF8F4";
const RULE  = "rgba(10,10,15,0.12)";
const MUTED = "rgba(10,10,15,0.64)";

const italic = (s: string) => (
  <em style={{ fontStyle: "italic", fontFamily: SERIF }}>{s}</em>
);

function renderWithEm(s: string) {
  const parts = s.split(/\{\{em\}\}|\{\{\/em\}\}/);
  return parts.map((p, i) =>
    i % 2 === 1 ? <em key={i} style={{ fontStyle: "italic", fontFamily: SERIF }}>{p}</em> : p
  );
}

const chapter: React.CSSProperties = {
  minHeight: "82vh",
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

export default function About() {
  const { t } = useTranslation("about");

  // Karan founder contact form state
  const [karanFormOpen, setKaranFormOpen] = useState(false);
  const [karanName, setKaranName] = useState("");
  const [karanEmail, setKaranEmail] = useState("");
  const [karanMsg, setKaranMsg] = useState("");
  const [karanSending, setKaranSending] = useState(false);
  const [karanDone, setKaranDone] = useState(false);

  const handleKaranContact = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!karanName.trim() || !karanEmail.trim()) return;
    setKaranSending(true);
    try {
      await fetch(`${BASE}api/contact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: karanName.trim(), email: karanEmail.trim(), message: karanMsg.trim() }),
      });
    } catch { /* degrade silently */ }
    setKaranDone(true);
    setKaranSending(false);
  };

  useEffect(() => {
    const prevTitle = document.title;
    document.title = t("title");
    const prevBg = document.body.style.background;
    document.body.style.background = PAPER;

    const setMeta = (name: string, content: string, attr: "name" | "property" = "name") => {
      let el = document.querySelector<HTMLMetaElement>(`meta[${attr}="${name}"]`);
      if (!el) {
        el = document.createElement("meta");
        el.setAttribute(attr, name);
        document.head.appendChild(el);
      }
      const prev = el.getAttribute("content");
      el.setAttribute("content", content);
      return () => {
        if (prev === null) el?.remove();
        else el?.setAttribute("content", prev);
      };
    };

    const restorers = [
      setMeta("description", "Why we're building Palonur — a Stanford-grounded trust layer for AI in sleep and lifestyle medicine. The team behind every answer."),
      setMeta("og:title", "Why we are building Palonur", "property"),
      setMeta("og:description", "AI at scale needs humans at scale. The team that makes Palonur credible.", "property"),
      setMeta("twitter:title", "Why we are building Palonur"),
      setMeta("twitter:description", "AI at scale needs humans at scale. The team that makes Palonur credible."),
    ];

    return () => {
      document.title = prevTitle;
      document.body.style.background = prevBg;
      restorers.forEach((r) => r());
    };
  }, []);

  return (
    <main style={{
      background: PAPER, color: INK, fontFamily: SANS,
      minHeight: "100vh",
    }}>
      {/* ─── Hero ──────────────────────────────────────────────────────── */}
      <div style={chapter}>
        <div style={innerSplit}>
          <div>
            <div style={eyebrow}>{t("hero.eyebrow")}</div>
            <h1 style={headline}>
              {renderWithEm(t("hero.headline"))}
            </h1>
            <p style={{ ...body, marginBottom: 22 }}>
              {t("hero.body1")}
            </p>
            <p style={body}>
              {t("hero.body2")}
            </p>
          </div>
          <aside style={aside}>
            “Confidence becomes a bug, not a feature.”
          </aside>
        </div>
      </div>

      {/* ─── Why this matters ─────────────────────────────────────────── */}
      <div style={chapter}>
        <div style={innerSplit}>
          <div>
            <div style={eyebrow}>{t("problem.eyebrow")}</div>
            <h2 style={headline}>
              {renderWithEm(t("problem.headline"))}
            </h2>
            <p style={{ ...body, marginBottom: 22 }}>
              {t("problem.body1")}
            </p>
            <p style={body}>
              {t("problem.body2")}
            </p>
          </div>
          <aside style={aside}>
            “The issue isn't that AI is wrong — it's that you can't tell
            the difference.”
          </aside>
        </div>
      </div>

      {/* ─── Founder ──────────────────────────────────────────────────── */}
      <div style={chapter}>
        <div style={{ ...inner, maxWidth: 720 }}>
          <div style={eyebrow}>{t("founder.eyebrow")}</div>

          {/* Identity */}
          <div style={{ display: "flex", alignItems: "center", gap: 18, marginBottom: 28 }}>
            <img
              src={`${BASE}karan-dehghani.jpg`}
              alt={t("founder.name")}
              loading="lazy"
              style={{
                width: 80, height: 80, borderRadius: "50%", objectFit: "cover",
                border: "2px solid rgba(10,10,15,0.14)",
                boxShadow: "0 2px 14px rgba(10,10,15,0.10)", flexShrink: 0,
              }}
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
            />
            <div>
              <div style={{ fontFamily: SERIF, fontSize: 24, fontWeight: 700, color: INK, lineHeight: 1.2 }}>
                {t("founder.name")}
              </div>
              <div style={{ fontFamily: SANS, fontSize: 12, fontWeight: 600, letterSpacing: ".06em",
                textTransform: "uppercase", color: MUTED, marginTop: 4 }}>
                {t("founder.role")}
              </div>
            </div>
          </div>

          <p style={{ ...body, marginBottom: 16 }}>
            {t("founder.origin1")}
          </p>
          <p style={{ ...body, marginBottom: 16 }}>
            {t("founder.origin2")}
          </p>
          <p style={{ ...body, marginBottom: 16 }}>
            {t("founder.body1")}
          </p>
          <p style={{ ...body, marginBottom: 40 }}>
            {t("founder.body2")}
          </p>

          <div
            data-testid="section-founder-why"
            style={{
              marginTop: 48,
              marginBottom: 44,
              paddingTop: 44,
              borderTop: `1px solid ${RULE}`,
            }}
          >
            <div style={eyebrow}>{t("why.eyebrow")}</div>
            <h2 style={{ ...headline, fontSize: "clamp(30px, 4vw, 48px)", marginBottom: 24 }}>
              {renderWithEm(t("why.headline"))}
            </h2>
            <p style={{ ...body, marginBottom: 16 }}>
              {t("why.body1")}
            </p>
            <p style={{ ...body, marginBottom: 16 }}>
              {t("why.body2")}
            </p>
            <p style={{ ...body, marginBottom: 20 }}>
              {t("why.body3")}
            </p>
            <img
              src={`${BASE}below-fold/why-founder-night.jpg`}
              alt=""
              loading="lazy"
              style={{
                width: "100%",
                maxHeight: 360,
                objectFit: "cover",
                objectPosition: "center 30%",
                borderRadius: 20,
                margin: "8px 0 28px",
                display: "block",
                boxShadow: "0 12px 40px rgba(10,10,15,0.12)",
              }}
              data-testid="img-why-night-about"
            />
            <div style={{
              borderLeft: `3px solid ${RED}`,
              paddingLeft: 22,
              margin: "8px 0 26px",
              maxWidth: 620,
            }}>
              <p style={{
                margin: 0,
                fontFamily: SERIF,
                fontSize: "clamp(19px, 1.7vw, 22px)",
                lineHeight: 1.4,
                color: INK,
                fontWeight: 500,
              }}>
                {renderWithEm(t("why.pullQuote"))}
              </p>
              <p style={{
                margin: "10px 0 0",
                fontFamily: SANS,
                fontSize: 12,
                lineHeight: 1.5,
                color: MUTED,
              }}>
                {t("why.pullSub")}
              </p>
            </div>
            <p style={{ ...body, marginBottom: 32 }}>
              {t("why.closing")}
            </p>

            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
              gap: 16,
            }}>
              {[
                { title: t("why.tenets.name.title"), text: t("why.tenets.name.text") },
                { title: t("why.tenets.citation.title"), text: t("why.tenets.citation.text") },
                { title: t("why.tenets.limits.title"), text: t("why.tenets.limits.text") },
              ].map((tenet) => (
                <div key={tenet.title} style={{
                  background: "#fff",
                  border: `1px solid ${RULE}`,
                  borderRadius: 18,
                  padding: "22px 20px",
                }}>
                  <div style={{
                    fontFamily: SERIF,
                    fontSize: 17,
                    fontWeight: 600,
                    color: INK,
                    marginBottom: 9,
                  }}>
                    {tenet.title}
                  </div>
                  <p style={{
                    margin: 0,
                    fontFamily: SERIF,
                    fontSize: 14,
                    lineHeight: 1.6,
                    color: "rgba(10,10,15,0.68)",
                  }}>
                    {tenet.text}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* CTAs */}
          {!karanFormOpen && !karanDone && (
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
              <TavusAvatarButton persona="karan" triggerVariant="pill" />
              <button
                type="button"
                onClick={() => setKaranFormOpen(true)}
                style={{
                  fontFamily: SANS, fontSize: 14, fontWeight: 600,
                  padding: "10px 22px", borderRadius: 10, cursor: "pointer",
                  background: "transparent", border: `1.5px solid ${RULE}`,
                  color: INK, letterSpacing: ".01em",
                }}
              >
                {t("founder.cta")}
              </button>
            </div>
          )}

          {/* Contact form */}
          {karanFormOpen && !karanDone && (
            <form onSubmit={handleKaranContact} style={{ marginTop: 8 }}>
              <p style={{ fontFamily: SANS, fontSize: 14, color: MUTED, margin: "0 0 20px" }}>
                {t("founder.formDesc")}
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 440 }}>
                <input
                  type="text"
                  placeholder={t("founder.namePlaceholder")}
                  required
                  value={karanName}
                  onChange={(e) => setKaranName(e.target.value)}
                  style={{
                    fontFamily: SANS, fontSize: 15, padding: "11px 14px",
                    border: `1px solid ${RULE}`, borderRadius: 10, outline: "none",
                    background: "#fff", color: INK,
                  }}
                />
                <input
                  type="email"
                  placeholder={t("founder.emailPlaceholder")}
                  required
                  value={karanEmail}
                  onChange={(e) => setKaranEmail(e.target.value)}
                  style={{
                    fontFamily: SANS, fontSize: 15, padding: "11px 14px",
                    border: `1px solid ${RULE}`, borderRadius: 10, outline: "none",
                    background: "#fff", color: INK,
                  }}
                />
                <textarea
                  placeholder={t("founder.msgPlaceholder")}
                  rows={3}
                  value={karanMsg}
                  onChange={(e) => setKaranMsg(e.target.value)}
                  style={{
                    fontFamily: SANS, fontSize: 15, padding: "11px 14px",
                    border: `1px solid ${RULE}`, borderRadius: 10, outline: "none",
                    background: "#fff", color: INK, resize: "vertical",
                  }}
                />
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <button
                    type="submit"
                    disabled={karanSending}
                    style={{
                      fontFamily: SANS, fontSize: 14, fontWeight: 700,
                      padding: "11px 28px", borderRadius: 10, cursor: karanSending ? "default" : "pointer",
                      background: RED, border: "none", color: "#fff",
                      opacity: karanSending ? 0.6 : 1,
                    }}
                  >
                    {karanSending ? t("founder.sending") : t("founder.send")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setKaranFormOpen(false)}
                    style={{
                      fontFamily: SANS, fontSize: 13, color: MUTED,
                      background: "none", border: "none", cursor: "pointer", padding: "8px 4px",
                    }}
                  >
                    {t("founder.cancel")}
                  </button>
                </div>
              </div>
            </form>
          )}

          {/* Success */}
          {karanDone && (
            <p style={{ fontFamily: SERIF, fontSize: 18, color: INK, margin: 0 }}>
              {t("founder.success")}
            </p>
          )}
        </div>
      </div>

      {/* ─── The team ─────────────────────────────────────────────────── */}
      <div style={{ ...chapter, borderBottom: "none" }}>
        <div style={inner}>
          <div style={eyebrow}>{t("team.eyebrow")}</div>
          <h2 style={{ ...headline, maxWidth: 900 }}>
            {renderWithEm(t("team.headline"))}
          </h2>
          <p style={{ ...body, marginBottom: 56, maxWidth: 720 }}>
            {t("team.body")}{" "}
            <a
              href={`${import.meta.env.BASE_URL}pillars`}
              style={{ color: RED, fontWeight: 600 }}
              data-testid="link-about-pillars"
            >
              {t("team.pillarsLink")}
            </a>.
          </p>

          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: 20,
            paddingTop: 8,
          }}>
            {TEAM.map((m) => (
              <div key={m.name} style={{
                background: "#fff",
                border: `1px solid ${RULE}`,
                borderRadius: 20,
                padding: "26px 28px",
                textAlign: "center",
              }}>
                <div style={{
                  fontFamily: SANS, fontSize: 17, fontWeight: 700,
                  color: INK, marginBottom: 10, lineHeight: 1.25,
                }}>
                  {m.name}
                  {m.badge ? (
                    <span style={{ fontWeight: 600, color: MUTED }}>
                      {" "}({m.badge})
                    </span>
                  ) : null}
                </div>
                <div style={{
                  fontFamily: SANS, fontSize: 14, lineHeight: 1.55,
                  color: "rgba(10,10,15,0.62)",
                }}>{m.role}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ─── Comparison · plain AI vs Stanford ───────────────────────────
          The two cards quietly react to the visitor: the plain-AI card
          desaturates and recedes when noticed (it's the bad option), and
          the Stanford-routed card sharpens, lifts, and a faint signature
          checkmark fades in (it's the trustworthy option). Reinforces
          "one of these is alive, one is not" without a single word. */}
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
          border-color: ${RED};
        }
        .palonur-cmp-stanford .palonur-cmp-check {
          opacity: 0;
          transform: translateX(-4px);
          transition: opacity .45s ease, transform .45s ease;
        }
        .palonur-cmp-stanford:hover .palonur-cmp-check {
          opacity: 1;
          transform: translateX(0);
        }
        @media (prefers-reduced-motion: reduce) {
          .palonur-cmp-plain, .palonur-cmp-stanford,
          .palonur-cmp-stanford .palonur-cmp-check {
            transition: none !important;
          }
        }
      `}</style>
      <div style={chapter}>
        <div style={inner}>
          <div style={eyebrow}>{t("comparison.eyebrow")}</div>
          <h2 style={{ ...headline, marginBottom: 18 }}>
            {renderWithEm(t("comparison.headline"))}
          </h2>
          <p style={{ ...body, marginBottom: 48, fontStyle: "italic" }}>
            You: “Does scrolling my phone in bed actually wreck my sleep?”
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
                textTransform: "uppercase", color: MUTED, marginBottom: 18,
              }}>Plain AI · without Palonur</div>
              <div style={{
                fontFamily: SERIF, fontSize: 16, lineHeight: 1.6,
                color: "rgba(10,10,15,0.72)",
                paddingBottom: 16, borderBottom: `1px solid ${RULE}`,
                marginBottom: 14,
              }}>
                “Yes, for a lot of people it does — but not because ‘screens
                are evil.’ Mental stimulation keeps the brain alert. Blue
                light can delay melatonin, though the effect is probably
                smaller than headlines suggest. A 10-minute scroll easily
                becomes 45, cutting sleep. Try keeping the phone farther and
                dimmer, avoid stimulating apps in the last 30–60 minutes,
                and turn on Night Shift.”
              </div>
              <div style={{
                display: "flex", alignItems: "center", gap: 8,
                fontSize: 12, color: "rgba(10,10,15,0.42)",
              }}>
                <span style={{
                  display: "inline-block", width: 8, height: 8, borderRadius: "50%",
                  background: "rgba(10,10,15,0.18)",
                }} />
{t("comparison.plainMeta")}
              </div>
            </div>

            <div className="palonur-cmp-stanford" style={{
              position: "relative",
              background: "#fff", border: `1px solid ${RED}`,
              borderRadius: 22, padding: "28px 28px 26px",
              boxShadow: "0 12px 36px rgba(232,53,42,0.08)",
            }}>
              {/* Faint signature checkmark — fades in on hover */}
              <svg
                className="palonur-cmp-check"
                aria-hidden
                width="22" height="22" viewBox="0 0 24 24"
                fill="none" stroke={RED} strokeWidth="2.4"
                strokeLinecap="round" strokeLinejoin="round"
                style={{ position: "absolute", top: 18, right: 18 }}
              >
                <polyline points="4 12 10 18 20 6" />
              </svg>
              <div style={{
                fontSize: 10, fontWeight: 700, letterSpacing: ".22em",
                textTransform: "uppercase", color: RED, marginBottom: 18,
              }}>Same AI · through Palonur</div>
              <div style={{
                fontFamily: SERIF, fontSize: 16, lineHeight: 1.6,
                color: "rgba(10,10,15,0.92)",
                paddingBottom: 16, borderBottom: `1px solid ${RULE}`,
                marginBottom: 14,
              }}>
                “Most of the effect is brightness, not color. About 100 lux —
                dimmer than a typical lit living room — already cuts evening
                melatonin in half and pushes sleep later. A phone held close
                to your face easily clears that. Dimming the whole room in
                the hour before bed moves the needle more than night-mode
                on any single screen.”
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
<span>{t("comparison.stanfordMeta")}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ─── Enhancement pillars ──────────────────────────────────────── */}
      <div style={{
        padding: "clamp(56px, 8vh, 100px) clamp(24px, 6vw, 96px)",
        borderBottom: `1px solid ${RULE}`,
        background: PAPER,
      }}>
        <div style={inner}>
          <div style={{ ...eyebrow, marginBottom: 12 }}>Also on Palonur</div>
          <h3 style={{
            margin: "0 0 10px", fontFamily: SERIF, fontWeight: 500,
            fontSize: "clamp(22px, 2.8vw, 32px)", lineHeight: 1.15,
            color: INK, letterSpacing: "-0.01em",
          }}>
            Pillars that enhance the whole experience
          </h3>
          <p style={{
            margin: "0 0 32px", fontFamily: SERIF,
            fontSize: "clamp(15px, 1.3vw, 17px)",
            lineHeight: 1.6, color: "rgba(10,10,15,0.60)", maxWidth: 560,
          }}>
            Alongside the core health science, we are building pillars that sharpen how you show up — in conversation, in your career, and in life.
          </p>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            {[
              { name: "Allison Kluger",  topic: "Communication",             badge: "Stanford" },
              { name: "Karan Dehghani",  topic: "AI Lab for Education and Leadership", badge: "Stanford GSB Fellow" },
            ].map(({ name, topic, badge }) => (
              <div key={name} style={{
                display: "flex", alignItems: "center", gap: 10,
                background: "#fff", border: `1px solid ${RULE}`,
                borderRadius: 999, padding: "10px 18px 10px 10px",
                boxShadow: "0 2px 8px rgba(10,10,15,0.04)",
              }}>
                <div style={{
                  width: 36, height: 36, borderRadius: "50%", flexShrink: 0,
                  background: "rgba(232,53,42,0.08)",
                  border: "1.5px solid rgba(232,53,42,0.18)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontFamily: SERIF, fontSize: 13, fontWeight: 600, color: RED,
                }}>
                  {name.split(" ").filter((w) => /^[A-Z]/.test(w)).slice(0, 2).map((w) => w[0]).join("")}
                </div>
                <div>
                  <div style={{ fontFamily: SANS, fontSize: 13, fontWeight: 600, color: INK, lineHeight: 1.2 }}>
                    {name}
                    <span style={{ fontWeight: 400, color: "rgba(10,10,15,0.45)", marginLeft: 6 }}>· {topic}</span>
                  </div>
                  <div style={{ fontFamily: SANS, fontSize: 10, fontWeight: 600, color: RED, letterSpacing: ".05em", textTransform: "uppercase", marginTop: 2 }}>
                    {badge}
                  </div>
                </div>
              </div>
            ))}

            {["Financial freedom", "Career advancement after 50", "Power"].map((label) => (
              <div key={label} style={{
                display: "flex", alignItems: "center", gap: 8,
                background: "rgba(10,10,15,0.03)", border: `1px dashed rgba(10,10,15,0.18)`,
                borderRadius: 999, padding: "10px 18px",
                fontFamily: SANS, fontSize: 13, color: "rgba(10,10,15,0.42)",
              }}>
                <span style={{ fontSize: 11, marginRight: 2 }}>＋</span>{label}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ─── Footer ───────────────────────────────────────────────────── */}
      <footer style={{
        padding: "32px clamp(24px, 6vw, 96px) 28px",
        background: PAPER,
        borderTop: `1px solid ${RULE}`,
        fontSize: 13, color: MUTED,
        display: "flex", flexWrap: "wrap", gap: 18,
        alignItems: "center", justifyContent: "space-between",
        letterSpacing: "0.02em",
      }}>
<span>{t("footer.copyright")}</span>
        <a href={`${import.meta.env.BASE_URL}`} style={{
          color: INK, textDecoration: "none", fontWeight: 600,
          letterSpacing: "0.04em",
        }}>
          {t("footer.backHome")}
        </a>
      </footer>
    </main>
  );
}
