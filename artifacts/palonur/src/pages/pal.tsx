import { useEffect, useState } from "react";

const INK = "#0f0505";
const PAPER = "#fafaf7";
const RED = "#8B1A1A";
const MUTED = "#7a6060";
const RULE = "rgba(139,26,26,0.10)";
const SERIF = "'Georgia', 'Times New Roman', serif";
const SANS = "'Inter', -apple-system, system-ui, sans-serif";

const TRAITS: { icon: string; label: string; detail: string }[] = [
  {
    icon: "🔬",
    label: "Rigorously grounded",
    detail:
      "Every statement Pal makes is anchored to a published study and a named researcher. Pal will not speculate, and will tell you plainly when the evidence is thin.",
  },
  {
    icon: "🌙",
    label: "Available at 3 a.m.",
    detail:
      "Pal keeps the same hours you do. The research does not get sleepier at 2:47 a.m., and neither does Pal.",
  },
  {
    icon: "💬",
    label: "Genuinely curious",
    detail:
      "Pal is interested in your specific situation, not a generic one. The more context you give, the sharper the answer.",
  },
  {
    icon: "🙅",
    label: "Allergic to vague",
    detail:
      "If an answer cannot be grounded, Pal says so. No hedge words, no false confidence, no supplements-everyone-online-swears-by.",
  },
  {
    icon: "📚",
    label: "Widely read",
    detail:
      "Sleep, nutrition, movement, stress, cognition, social connection. Pal has read the primary literature across all of it, and will tell you what holds up.",
  },
  {
    icon: "🤝",
    label: "On your side",
    detail:
      "Pal is not trying to sell you anything in the answer. The goal is the same as yours: that you leave the conversation better informed than when you arrived.",
  },
];

const QUESTIONS: { q: string; teaser: string }[] = [
  {
    q: "Why do I wake up at the same time every night?",
    teaser:
      "Your internal clock is more precise than you think. Pal can walk you through the circadian mechanisms behind predictable night waking.",
  },
  {
    q: "Does morning light actually matter for sleep?",
    teaser:
      "Yes, and the timing is specific. Pal cites the Zeitzer lab work on photoreceptor sensitivity windows.",
  },
  {
    q: "How does stress affect deep sleep?",
    teaser:
      "There is a measurable physiological pathway. Pal traces it from cortisol to slow-wave suppression.",
  },
  {
    q: "Is 7 hours enough, or do I need 8?",
    teaser:
      "It depends on factors most sleep advice ignores. Pal will explain what the population data actually shows.",
  },
];

const FACTS: string[] = [
  "Favorite paper: Zeitzer et al. (2000) on light sensitivity and circadian phase shifting",
  "Reads new preprints every day — and flags when something has not been replicated",
  "Has never said 'that's a great question' in its life",
  "Will correct a misconception with the same warmth it uses for everything else",
  "Believes sleep is the most underrated health lever most people have",
];

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: "inline-block",
        background: "rgba(139,26,26,0.06)",
        border: `1px solid rgba(139,26,26,0.14)`,
        borderRadius: 999,
        padding: "4px 12px",
        fontSize: 13,
        color: RED,
        fontWeight: 600,
        fontFamily: SANS,
      }}
    >
      {children}
    </span>
  );
}

export default function Pal() {
  const [hovered, setHovered] = useState<number | null>(null);
  const [blink, setBlink] = useState(false);

  useEffect(() => {
    document.title = "Pal Harford. Palonur";
    const prevBg = document.body.style.background;
    document.body.style.background = PAPER;
    return () => {
      document.body.style.background = prevBg;
    };
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      setBlink((b) => !b);
    }, 3200);
    return () => clearInterval(t);
  }, []);

  return (
    <div
      style={{
        minHeight: "100dvh",
        background: PAPER,
        fontFamily: SANS,
        color: INK,
      }}
    >
      <style>{`
        @keyframes fadeUp { from { opacity:0; transform:translateY(18px);} to { opacity:1; transform:translateY(0);} }
        @keyframes pulse { 0%,100% { transform:scale(1); } 50% { transform:scale(1.04); } }
        @keyframes blink { 0%,90%,100% { opacity:1; } 92%,98% { opacity:0; } }
        .pal-trait:hover { background: rgba(139,26,26,0.04) !important; border-color: rgba(139,26,26,0.18) !important; }
        .pal-q:hover { background: rgba(139,26,26,0.05) !important; }
        .pal-cta:hover { opacity: 0.88; }
      `}</style>

      {/* Header */}
      <header
        style={{
          padding: "20px 32px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: `1px solid ${RULE}`,
        }}
      >
        <a
          href={import.meta.env.BASE_URL}
          style={{ textDecoration: "none", fontWeight: 700, fontSize: 18, color: INK }}
        >
          Palonur
        </a>
        <a
          href={`${import.meta.env.BASE_URL}sleep`}
          style={{ fontSize: 13, fontWeight: 600, color: RED, textDecoration: "none" }}
        >
          Ask Pal a question →
        </a>
      </header>

      <main style={{ maxWidth: 760, margin: "0 auto", padding: "64px 24px 120px" }}>

        {/* Hero */}
        <div style={{ animation: "fadeUp .5s ease both", marginBottom: 72 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: ".16em",
              textTransform: "uppercase",
              color: RED,
              marginBottom: 18,
            }}
          >
            Meet your research companion
          </div>

          {/* Avatar */}
          <div style={{ display: "flex", alignItems: "flex-start", gap: 28, marginBottom: 32 }}>
            <div
              style={{
                flexShrink: 0,
                width: 88,
                height: 88,
                borderRadius: "50%",
                background: "linear-gradient(135deg, #8B1A1A 0%, #c0392b 100%)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 38,
                boxShadow: "0 8px 24px rgba(139,26,26,0.22)",
                animation: "pulse 4s ease-in-out infinite",
                position: "relative",
              }}
            >
              🤓
              {/* Blinking dot */}
              <span
                style={{
                  position: "absolute",
                  bottom: 6,
                  right: 6,
                  width: 14,
                  height: 14,
                  borderRadius: "50%",
                  background: "#22c55e",
                  border: "2.5px solid #fafaf7",
                  animation: "blink 3.2s ease-in-out infinite",
                }}
              />
            </div>
            <div>
              <h1
                style={{
                  fontFamily: SERIF,
                  fontSize: "clamp(32px, 5vw, 44px)",
                  fontWeight: 500,
                  lineHeight: 1.1,
                  letterSpacing: "-0.02em",
                  color: INK,
                  margin: "0 0 6px",
                }}
              >
                Pal Harford
              </h1>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
                <Chip>Research companion</Chip>
                <Chip>All pillars</Chip>
                <Chip>Always on</Chip>
              </div>
            </div>
          </div>

          <p
            style={{
              fontFamily: SERIF,
              fontSize: "clamp(18px, 2.5vw, 22px)",
              color: MUTED,
              lineHeight: 1.65,
              margin: "0 0 20px",
            }}
          >
            Pal is the AI at the heart of Palonur. Named for the way a good answer
            should feel. Not a chatbot. Not a search engine. More like a friend who
            happens to have read every relevant study and will tell you what they actually found.
          </p>
          <p
            style={{
              fontFamily: SERIF,
              fontSize: "clamp(16px, 2vw, 19px)",
              color: MUTED,
              lineHeight: 1.65,
              margin: 0,
            }}
          >
            Every answer Pal gives is reviewed by a named Stanford researcher before
            it enters the corpus. Pal quotes the paper, cites the author, and tells
            you plainly when the evidence does not support what you heard on a podcast.
          </p>
        </div>

        {/* Traits */}
        <section style={{ marginBottom: 72 }}>
          <h2
            style={{
              fontFamily: SERIF,
              fontSize: 26,
              fontWeight: 500,
              color: INK,
              margin: "0 0 24px",
              letterSpacing: "-0.01em",
            }}
          >
            What Pal is like
          </h2>
          <div style={{ display: "grid", gap: 12 }}>
            {TRAITS.map((trait, i) => (
              <div
                key={i}
                className="pal-trait"
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
                style={{
                  display: "flex",
                  gap: 16,
                  padding: "16px 20px",
                  borderRadius: 14,
                  border: `1px solid ${RULE}`,
                  background: "#fff",
                  transition: "background .15s, border-color .15s",
                  cursor: "default",
                }}
              >
                <div style={{ fontSize: 22, flexShrink: 0, marginTop: 2 }}>{trait.icon}</div>
                <div>
                  <div
                    style={{
                      fontSize: 15,
                      fontWeight: 700,
                      color: INK,
                      marginBottom: 3,
                    }}
                  >
                    {trait.label}
                  </div>
                  <div
                    style={{
                      fontSize: 14,
                      color: hovered === i ? MUTED : "#9a8080",
                      lineHeight: 1.55,
                      transition: "color .15s",
                    }}
                  >
                    {trait.detail}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Fun facts */}
        <section
          style={{
            marginBottom: 72,
            background: "#fff",
            border: `1px solid ${RULE}`,
            borderRadius: 20,
            padding: "28px 28px 24px",
          }}
        >
          <h2
            style={{
              fontFamily: SERIF,
              fontSize: 22,
              fontWeight: 500,
              color: INK,
              margin: "0 0 18px",
            }}
          >
            A few things about Pal
          </h2>
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 10 }}>
            {FACTS.map((fact, i) => (
              <li
                key={i}
                style={{
                  display: "flex",
                  gap: 10,
                  fontSize: 14,
                  color: MUTED,
                  lineHeight: 1.55,
                }}
              >
                <span style={{ color: RED, fontWeight: 700, flexShrink: 0 }}>—</span>
                <span>{fact}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* Sample questions */}
        <section style={{ marginBottom: 72 }}>
          <h2
            style={{
              fontFamily: SERIF,
              fontSize: 26,
              fontWeight: 500,
              color: INK,
              margin: "0 0 8px",
              letterSpacing: "-0.01em",
            }}
          >
            Questions Pal loves
          </h2>
          <p
            style={{
              fontSize: 14,
              color: MUTED,
              margin: "0 0 24px",
              lineHeight: 1.5,
            }}
          >
            These are the kinds of questions where Pal shines. Click one to ask it.
          </p>
          <div style={{ display: "grid", gap: 12 }}>
            {QUESTIONS.map(({ q, teaser }, i) => (
              <a
                key={i}
                href={`${import.meta.env.BASE_URL}sleep?q=${encodeURIComponent(q)}`}
                className="pal-q"
                style={{
                  display: "block",
                  padding: "18px 20px",
                  borderRadius: 14,
                  border: `1px solid ${RULE}`,
                  background: "#fff",
                  textDecoration: "none",
                  transition: "background .15s",
                }}
              >
                <div
                  style={{
                    fontSize: 15,
                    fontWeight: 600,
                    color: INK,
                    marginBottom: 5,
                  }}
                >
                  {q}
                </div>
                <div style={{ fontSize: 13, color: MUTED, lineHeight: 1.5 }}>
                  {teaser}
                </div>
              </a>
            ))}
          </div>
        </section>

        {/* CTA */}
        <div
          style={{
            textAlign: "center",
            padding: "40px 24px",
            background: "linear-gradient(135deg, #8B1A1A 0%, #a01a1a 100%)",
            borderRadius: 24,
            boxShadow: "0 12px 36px rgba(139,26,26,0.18)",
          }}
        >
          <div
            style={{
              fontSize: 28,
              marginBottom: 12,
            }}
          >
            🤓
          </div>
          <h2
            style={{
              fontFamily: SERIF,
              fontSize: "clamp(22px, 3.5vw, 30px)",
              fontWeight: 500,
              color: "#fff",
              margin: "0 0 10px",
              letterSpacing: "-0.01em",
            }}
          >
            Say hello to Pal.
          </h2>
          <p
            style={{
              fontSize: 15,
              color: "rgba(255,255,255,0.75)",
              lineHeight: 1.6,
              margin: "0 0 28px",
              maxWidth: 420,
              marginLeft: "auto",
              marginRight: "auto",
            }}
          >
            Ask anything about sleep, nutrition, movement, stress, or any pillar of
            lifestyle medicine. Your first question is free.
          </p>
          <a
            href={`${import.meta.env.BASE_URL}sleep`}
            className="pal-cta"
            style={{
              display: "inline-block",
              background: "#fff",
              color: RED,
              borderRadius: 999,
              padding: "14px 32px",
              fontSize: 15,
              fontWeight: 700,
              textDecoration: "none",
              boxShadow: "0 4px 14px rgba(0,0,0,0.12)",
              transition: "opacity .15s",
            }}
          >
            Ask Pal a question →
          </a>
        </div>

      </main>

      {/* Footer */}
      <footer
        style={{
          borderTop: `1px solid ${RULE}`,
          padding: "24px 32px",
          textAlign: "center",
          fontSize: 13,
          color: MUTED,
        }}
      >
        Palonur. Grounded in Stanford research.
      </footer>
    </div>
  );
}
