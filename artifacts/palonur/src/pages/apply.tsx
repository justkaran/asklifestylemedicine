import { useState, useEffect } from "react";

const PAPER = "#FBF7F0";
const CARDINAL = "#8C1515";
const VARIANT_KEY = "apply-ab-variant";

type Variant = "all-pillars" | "sleep";

function assignVariant(): Variant {
  try {
    const stored = localStorage.getItem(VARIANT_KEY);
    if (stored === "all-pillars" || stored === "sleep") return stored;
    const v: Variant = Math.random() < 0.5 ? "all-pillars" : "sleep";
    localStorage.setItem(VARIANT_KEY, v);
    return v;
  } catch {
    return "all-pillars";
  }
}

const CHECK = (
  <span style={{ color: CARDINAL, fontSize: 18, marginTop: 2, flexShrink: 0 }}>&#10003;</span>
);

function AllPillarsVariant() {
  return (
    <>
      <div
        style={{
          fontSize: 11, fontWeight: 700, letterSpacing: ".16em",
          textTransform: "uppercase", color: CARDINAL, marginBottom: 10,
        }}
      >
        Limited Beta
      </div>

      <h1
        style={{
          fontFamily: "Georgia, 'Times New Roman', serif",
          fontSize: 36, fontWeight: 700, color: "#3a2010",
          lineHeight: 1.15, marginBottom: 16,
        }}
      >
        Ask any health question.<br />Get a scientist's answer.
      </h1>

      <p style={{ fontSize: 16, color: "#5a3a20", lineHeight: 1.65, marginBottom: 28 }}>
        Palonur gives you direct access to faculty scientists across all seven
        Stanford Lifestyle Medicine pillars. Ask about sleep, food, movement,
        stress, cognition, connection, or purpose and get evidence-backed answers
        from the researchers who study these topics every day.
      </p>

      <div
        style={{
          borderRadius: 16, border: "1px solid #E8DDD0",
          background: "rgba(255,255,255,0.6)", padding: "20px 22px",
          marginBottom: 28, display: "flex", flexDirection: "column", gap: 14,
        }}
      >
        {[
          ["Sleep", "How to fall asleep faster, stay asleep, and wake up rested — answered by sleep researchers."],
          ["Nutrition", "What to eat, when, and why — evidence from nutrition scientists, not influencers."],
          ["Movement", "Exercise that actually fits your life, grounded in exercise physiology research."],
          ["Stress management", "Proven techniques for nervous-system regulation and resilience."],
          ["Cognitive enhancement", "Memory, focus, and brain health — what the science actually supports."],
          ["Social connection", "Why relationships are medicine and how to build lasting ones."],
          ["Purpose", "The biology and psychology of meaning, contribution, and flourishing."],
        ].map(([title, desc]) => (
          <div key={title} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            {CHECK}
            <div>
              <div style={{ fontWeight: 600, color: "#3a2010", marginBottom: 2 }}>{title}</div>
              <div style={{ fontSize: 13, color: "#7a5a40", lineHeight: 1.45 }}>{desc}</div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function SleepVariant() {
  return (
    <>
      <div
        style={{
          fontSize: 11, fontWeight: 700, letterSpacing: ".16em",
          textTransform: "uppercase", color: CARDINAL, marginBottom: 10,
        }}
      >
        Limited Beta
      </div>

      <h1
        style={{
          fontFamily: "Georgia, 'Times New Roman', serif",
          fontSize: 36, fontWeight: 700, color: "#3a2010",
          lineHeight: 1.15, marginBottom: 16,
        }}
      >
        Finally understand your sleep.<br />Ask the expert directly.
      </h1>

      <p style={{ fontSize: 16, color: "#5a3a20", lineHeight: 1.65, marginBottom: 28 }}>
        Palonur gives you direct access to Prof. Jamie Zeitzer, one of the
        world's leading sleep scientists at Stanford University. Ask your exact
        sleep question and get a grounded, personalised answer rooted in decades
        of peer-reviewed research.
      </p>

      <div
        style={{
          borderRadius: 16, border: "1px solid #E8DDD0",
          background: "rgba(255,255,255,0.6)", padding: "20px 22px",
          marginBottom: 28, display: "flex", flexDirection: "column", gap: 14,
        }}
      >
        {[
          ["A world-famous sleep scientist", "Prof. Jamie Zeitzer's lab at Stanford has published over 200 papers on sleep, circadian biology, and insomnia."],
          ["Answers to your exact question", "Not generic tips — real answers to what keeps you awake, disrupts your rhythm, or stops you recovering."],
          ["Evidence you can trust", "Every answer is grounded in peer-reviewed research, not wellness trends or supplement marketing."],
          ["Better sleep starts here", "Understanding the science changes how you approach bedtime, light, caffeine, and everything in between."],
        ].map(([title, desc]) => (
          <div key={title} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            {CHECK}
            <div>
              <div style={{ fontWeight: 600, color: "#3a2010", marginBottom: 2 }}>{title}</div>
              <div style={{ fontSize: 13, color: "#7a5a40", lineHeight: 1.45 }}>{desc}</div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

const REFERRAL_OPTIONS = [
  { value: "", label: "How did you hear about us? (optional)" },
  { value: "Search engine", label: "Search engine" },
  { value: "Social media", label: "Social media" },
  { value: "A friend or colleague", label: "A friend or colleague" },
  { value: "Stanford / academic", label: "Stanford / academic" },
  { value: "Other", label: "Other" },
];

export default function Apply() {
  const [variant] = useState<Variant>(assignVariant);
  const [email, setEmail] = useState("");
  const [referralSource, setReferralSource] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registered, setRegistered] = useState(false);

  useEffect(() => {
    document.body.style.background = PAPER;
    document.title = "Apply for Beta Access - Palonur";
    return () => { document.body.style.background = ""; };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/beta/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, variant, referralSource: referralSource || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Something went wrong. Please try again.");
        setLoading(false);
        return;
      }
      setRegistered(true);
    } catch {
      setError("Could not reach the server. Please check your connection and try again.");
      setLoading(false);
    }
  }

  return (
    <div
      style={{ background: PAPER, minHeight: "100vh" }}
      className="flex flex-col items-center justify-start px-6 pt-16 pb-24"
    >
      <div className="w-full max-w-lg">
        {variant === "all-pillars" ? <AllPillarsVariant /> : <SleepVariant />}

        {registered ? (
          <div
            style={{
              borderRadius: 16, border: "1px solid #C8E6C9",
              background: "#F1F8E9", padding: "24px", textAlign: "center",
            }}
          >
            <div style={{ fontSize: 28, marginBottom: 10 }}>&#9993;</div>
            <div style={{ fontWeight: 600, color: "#2E7D32", fontSize: 17, marginBottom: 6 }}>
              You're on the list.
            </div>
            <div style={{ color: "#4a7a50", fontSize: 13.5, lineHeight: 1.6 }}>
              We'll email <strong>{email}</strong> when your spot opens up,
              along with a member discount on your first period.
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label
              htmlFor="beta-email"
              style={{ fontSize: 13.5, fontWeight: 600, color: "#5a3a20" }}
            >
              Your email address
            </label>
            <input
              id="beta-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              style={{
                width: "100%", borderRadius: 12,
                border: "1px solid #D8CCBC", background: "#fff",
                padding: "12px 16px", fontSize: 15, color: "#3a2010",
                outline: "none", boxSizing: "border-box",
              }}
            />

            <select
              value={referralSource}
              onChange={(e) => setReferralSource(e.target.value)}
              disabled={loading}
              style={{
                width: "100%", borderRadius: 12,
                border: "1px solid #D8CCBC", background: "#fff",
                padding: "12px 16px", fontSize: 15,
                color: referralSource ? "#3a2010" : "#9a7a60",
                outline: "none", boxSizing: "border-box",
              }}
            >
              {REFERRAL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value} disabled={o.value === "" ? true : undefined}>
                  {o.label}
                </option>
              ))}
            </select>

            {error && (
              <div
                style={{
                  borderRadius: 12, border: "1px solid #fecaca",
                  background: "#fef2f2", padding: "10px 14px",
                  fontSize: 13.5, color: "#b91c1c",
                }}
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !email}
              style={{
                width: "100%", borderRadius: 12,
                background: loading || !email ? "#b06060" : CARDINAL,
                color: "#fff", fontWeight: 700,
                padding: "14px", fontSize: 15,
                border: "none", cursor: loading || !email ? "not-allowed" : "pointer",
                transition: "background .15s",
              }}
            >
              {loading ? "Reserving your spot..." : "Reserve my spot"}
            </button>

            <p
              style={{
                textAlign: "center", fontSize: 12, color: "#9a7a60", margin: 0,
              }}
            >
              No payment now. Early members get a discount when we open access.
            </p>
          </form>
        )}

        <div
          style={{
            marginTop: 40, paddingTop: 24,
            borderTop: "1px solid #E8DDD0",
            fontSize: 11.5, color: "#b0907a", textAlign: "center",
          }}
        >
          Limited testing cohort. Access is subject to availability.
          Questions? Email{" "}
          <a
            href="mailto:hello@palonur.com"
            style={{ color: CARDINAL, textDecoration: "underline" }}
          >
            hello@palonur.com
          </a>
        </div>
      </div>
    </div>
  );
}
