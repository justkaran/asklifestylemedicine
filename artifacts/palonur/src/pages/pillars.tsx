import { useEffect } from "react";
import { useVisiblePillars, type ConsumerPillar } from "../lib/pillars";

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

function PillarCard({ p }: { p: ConsumerPillar }) {
  const card = (
    <div
      data-testid={`card-pillar-${p.slug}`}
      style={{
        background: "#fff",
        border: `1px solid ${p.live ? RED : RULE}`,
        borderRadius: 22,
        padding: "28px 28px 26px",
        display: "flex", flexDirection: "column",
        height: "100%",
        boxShadow: p.live ? "0 12px 36px rgba(232,53,42,0.08)" : "none",
      }}
    >
      <img
        src={p.art}
        alt=""
        aria-hidden
        loading="lazy"
        style={{
          width: "calc(100% + 56px)",
          margin: "-28px -28px 20px",
          height: 150, objectFit: "cover", objectPosition: "center",
          borderRadius: "21px 21px 0 0",
          display: "block",
          borderBottom: `1px solid ${RULE}`,
        }}
      />
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "flex-end",
        marginBottom: 14,
      }}>
        <span style={{
          fontSize: 9, fontWeight: 800, letterSpacing: ".18em",
          textTransform: "uppercase",
          color: p.live ? "#fff" : MUTED,
          background: p.live ? RED : "rgba(10,10,15,0.06)",
          padding: "5px 10px", borderRadius: 999,
        }}>
          {p.live ? "Live now" : "Coming soon"}
        </span>
      </div>
      <div style={{
        fontFamily: SERIF, fontSize: 24, fontWeight: 500,
        color: INK, lineHeight: 1.2, marginBottom: 10,
      }}>
        {p.name}
      </div>
      <p style={{
        margin: "0 0 18px", flexGrow: 1,
        fontFamily: SERIF, fontSize: 15.5, lineHeight: 1.55,
        color: "rgba(10,10,15,0.68)",
      }}>
        {p.description}
      </p>
      {p.live && p.href ? (
        <span style={{
          fontFamily: SANS, fontSize: 14, fontWeight: 700,
          color: RED, letterSpacing: "0.02em",
        }}>
          {p.linkLabel ?? "Open →"}
        </span>
      ) : (
        <span style={{
          fontFamily: SANS, fontSize: 13, color: MUTED,
          letterSpacing: "0.02em",
        }}>
          Explore the topic →
        </span>
      )}
    </div>
  );

  const href = p.live && p.href
    ? p.href
    : `${import.meta.env.BASE_URL}t/${p.slug}`;
  return (
    <a
      href={href}
      style={{ textDecoration: "none", display: "block", height: "100%" }}
      data-testid={`link-pillar-${p.slug}`}
    >
      {card}
    </a>
  );
}

export default function Pillars() {
  const pillars = useVisiblePillars();

  useEffect(() => {
    const prevTitle = document.title;
    document.title = "The pillars of Stanford Lifestyle Medicine — Palonur";
    const prevBg = document.body.style.background;
    document.body.style.background = PAPER;

    const setMeta = (name: string, content: string, attr: "name" | "property" = "name") => {
      let el = document.querySelector<HTMLMetaElement>(`meta[${attr}="${name}"]`);
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
      setMeta("description", "Palonur covers the whole of Stanford Lifestyle Medicine — ask any question and it reaches the right pillar's faculty steward."),
      setMeta("og:title", "The pillars of Stanford Lifestyle Medicine — Palonur", "property"),
      setMeta("og:description", "Sleep, Movement, Nutrition, Stress Management, and more — every pillar answers with its Stanford steward's published research.", "property"),
      setMeta("twitter:title", "The pillars of Stanford Lifestyle Medicine — Palonur"),
      setMeta("twitter:description", "Sleep, Movement, Nutrition, Stress Management, and more — every pillar answers with its Stanford steward's published research."),
    ];

    return () => {
      document.title = prevTitle;
      document.body.style.background = prevBg;
      restorers.forEach((r) => r());
    };
  }, []);

  const live = pillars.filter((p) => p.live);
  const soon = pillars.filter((p) => !p.live);

  return (
    <main style={{
      background: PAPER, color: INK, fontFamily: SANS, minHeight: "100vh",
    }}>
      {/* ─── Hero ─────────────────────────────────────────────────────── */}
      <div style={{
        padding: "clamp(72px, 12vh, 130px) clamp(24px, 6vw, 96px) clamp(48px, 7vh, 80px)",
        borderBottom: `1px solid ${RULE}`,
      }}>
        <div style={{ width: "100%", maxWidth: 1100, margin: "0 auto" }}>
          <div style={eyebrow}>The pillars</div>
          <h1 style={headline}>
            Seven pillars. All of them {italic("open")}.
          </h1>
          <p style={{ ...body, marginBottom: 20 }}>
            Stanford Lifestyle Medicine is one use case for Palonur, organizing
            healthy living into pillars: sleep, movement, nutrition, stress,
            connection, cognition, and purpose. Every pillar has the same
            contract: a named Stanford faculty member standing behind every
            answer.
          </p>
          <p style={body}>
            Ask a question on any pillar and get a cited, peer-reviewed answer
            from the faculty who study it for a living.
          </p>
        </div>
      </div>

      {/* ─── Live now ─────────────────────────────────────────────────── */}
      {live.length > 0 && (
        <div style={{
          padding: "clamp(48px, 7vh, 80px) clamp(24px, 6vw, 96px)",
          borderBottom: `1px solid ${RULE}`,
        }}>
          <div style={{ width: "100%", maxWidth: 1100, margin: "0 auto" }}>
            <div style={eyebrow}>Live now</div>
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
              gap: 20,
            }}>
              {live.map((p) => <PillarCard key={p.slug} p={p} />)}
            </div>
          </div>
        </div>
      )}

      {/* ─── CTA ──────────────────────────────────────────────────────── */}
      <div style={{
        padding: "clamp(48px, 7vh, 80px) clamp(24px, 6vw, 96px) clamp(64px, 9vh, 110px)",
        borderTop: `1px solid ${RULE}`,
        textAlign: "center",
      }}>
        <div style={{ maxWidth: 640, margin: "0 auto" }}>
          <h2 style={{
            ...headline, maxWidth: "none",
            fontSize: "clamp(26px, 3.4vw, 40px)", marginBottom: 16,
          }}>
            Ask across {italic("all the pillars")} at once.
          </h2>
          <p style={{ ...body, maxWidth: "none", marginBottom: 28 }}>
            One question, every pillar. The Stanford Lifestyle Medicine
            combined surface searches across all seven fields simultaneously
            and returns the best-matched, faculty-signed answer.
          </p>
          <a
            href={`${import.meta.env.BASE_URL}slm`}
            data-testid="link-pillars-slm"
            style={{
              display: "inline-block",
              background: RED, color: "#fff",
              padding: "16px 30px", borderRadius: 999,
              fontFamily: SANS, fontSize: 14, fontWeight: 700,
              letterSpacing: "0.02em", textDecoration: "none",
            }}
          >
            Ask Stanford Lifestyle Medicine →
          </a>
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
        <span>© Palonur</span>
        <a href={`${import.meta.env.BASE_URL}`} style={{
          color: INK, textDecoration: "none", fontWeight: 600,
          letterSpacing: "0.04em",
        }}>
          ← Back to palonur.com
        </a>
      </footer>
    </main>
  );
}
