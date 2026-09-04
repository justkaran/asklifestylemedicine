import { useState, useEffect } from "react";

const OUTCOME_COPY: Record<string, { emoji: string; headline: string; sub: string; searchLabel: string }> = {
  helped: {
    emoji: "✓",
    headline: "Glad it helped.",
    sub: "One night at a time. Keep going.",
    searchLabel: "Keep the momentum. Ask your next sleep question:",
  },
  no_change: {
    emoji: "○",
    headline: "Not every technique clicks right away.",
    sub: "Sleep science is iterative. Let's find a different angle.",
    searchLabel: "Ask a different sleep question:",
  },
  not_tried: {
    emoji: "◇",
    headline: "No pressure.",
    sub: "Give it another shot tonight. Small steps still count.",
    searchLabel: "Or ask a new sleep question for tonight:",
  },
};

export default function Reflect() {
  const [query, setQuery] = useState("");

  const params = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  const done = params.get("done") === "1";
  const outcome = params.get("outcome") ?? "";
  const hasError = params.get("error") === "1";

  const copy = OUTCOME_COPY[outcome];

  useEffect(() => {
    document.title = "Your reflection · Palonur";
    const prev = document.body.style.background;
    document.body.style.background = "#fafaf7";
    return () => { document.body.style.background = prev; };
  }, []);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    window.location.href = `${import.meta.env.BASE_URL}sleep?q=${encodeURIComponent(q)}`;
  }

  return (
    <div style={{
      minHeight: "100dvh", background: "#fafaf7",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif",
      color: "#1a0505",
    }}>
      <header style={{
        padding: "16px 28px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        borderBottom: "1px solid rgba(139,26,26,.08)",
      }}>
        <a href={import.meta.env.BASE_URL} style={{
          textDecoration: "none", color: "#8B1A1A",
          fontSize: 13, fontWeight: 600, letterSpacing: ".02em",
        }}>
          palonur
        </a>
      </header>

      <main style={{ maxWidth: 520, margin: "0 auto", padding: "64px 24px 96px" }}>

        {hasError && (
          <div style={{ textAlign: "center" }}>
            <div style={{
              fontSize: "clamp(28px,3.5vw,38px)", fontWeight: 500,
              fontFamily: "'Georgia','Times New Roman',serif",
              color: "#0f0505", lineHeight: 1.25, marginBottom: 14,
            }}>
              Link not found.
            </div>
            <div style={{ fontSize: 15, color: "#777", lineHeight: 1.6, marginBottom: 40 }}>
              This link may have already been used or expired. Head back to your journey.
            </div>
            <a href={`${import.meta.env.BASE_URL}journey`} style={{
              display: "inline-block", padding: "14px 28px",
              background: "#8B1A1A", color: "#fff",
              textDecoration: "none", borderRadius: 12,
              fontSize: 15, fontWeight: 600, letterSpacing: ".01em",
            }}>
              Go to my journey
            </a>
          </div>
        )}

        {done && copy && (
          <>
            <div style={{
              display: "flex", flexDirection: "column", alignItems: "center",
              textAlign: "center", marginBottom: 56,
            }}>
              <div style={{
                width: 64, height: 64, borderRadius: "50%",
                background: outcome === "helped" ? "rgba(74,124,89,0.1)" : "rgba(139,26,26,0.07)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 26, marginBottom: 24,
                color: outcome === "helped" ? "#4a7c59" : "#8B1A1A",
              }}>
                {copy.emoji}
              </div>

              <div style={{
                fontSize: "clamp(26px,3.5vw,36px)", fontWeight: 500,
                fontFamily: "'Georgia','Times New Roman',serif",
                color: "#0f0505", lineHeight: 1.25, marginBottom: 12,
              }}>
                {copy.headline}
              </div>
              <div style={{ fontSize: 16, color: "#666", lineHeight: 1.6 }}>
                {copy.sub}
              </div>
            </div>

            <div style={{
              padding: "28px 24px", borderRadius: 16,
              background: "#fff", border: "1px solid rgba(139,26,26,.1)",
              boxShadow: "0 4px 20px rgba(139,26,26,.05)",
              marginBottom: 32,
            }}>
              <div style={{
                fontSize: 14, color: "#555", lineHeight: 1.55, marginBottom: 16,
              }}>
                {copy.searchLabel}
              </div>
              <form onSubmit={handleSearch}>
                <input
                  type="text"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="e.g. How do I fall back asleep at 3am?"
                  style={{
                    width: "100%", padding: "12px 14px",
                    border: "1.5px solid rgba(139,26,26,0.2)",
                    borderRadius: 10, fontSize: 15,
                    fontFamily: "inherit", color: "#1a0505",
                    background: "#fafaf7", outline: "none",
                    boxSizing: "border-box", marginBottom: 12,
                    transition: "border-color .15s",
                  }}
                  onFocus={e => { e.currentTarget.style.borderColor = "#8B1A1A"; }}
                  onBlur={e => { e.currentTarget.style.borderColor = "rgba(139,26,26,0.2)"; }}
                />
                <button
                  type="submit"
                  disabled={!query.trim()}
                  style={{
                    width: "100%", padding: "13px",
                    background: query.trim() ? "#8B1A1A" : "rgba(139,26,26,0.25)",
                    color: "#fff", border: "none", borderRadius: 10,
                    fontSize: 15, fontWeight: 600, cursor: query.trim() ? "pointer" : "default",
                    transition: "background .15s",
                  }}
                >
                  Ask the sleep agent
                </button>
              </form>
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <a href={`${import.meta.env.BASE_URL}journey`} style={{
                flex: 1, display: "block", textAlign: "center",
                padding: "13px 16px", borderRadius: 10,
                border: "1px solid rgba(139,26,26,.2)",
                color: "#8B1A1A", textDecoration: "none",
                fontSize: 14, fontWeight: 600, letterSpacing: ".01em",
                transition: "background .15s",
              }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "rgba(139,26,26,0.04)"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
              >
                My journey
              </a>
              <a href={`${import.meta.env.BASE_URL}sleep`} style={{
                flex: 1, display: "block", textAlign: "center",
                padding: "13px 16px", borderRadius: 10,
                border: "1px solid rgba(139,26,26,.2)",
                color: "#8B1A1A", textDecoration: "none",
                fontSize: 14, fontWeight: 600, letterSpacing: ".01em",
                transition: "background .15s",
              }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "rgba(139,26,26,0.04)"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
              >
                Sleep agent
              </a>
            </div>
          </>
        )}

        {!done && !hasError && (
          <div style={{ textAlign: "center" }}>
            <div style={{
              fontSize: "clamp(28px,3.5vw,38px)", fontWeight: 500,
              fontFamily: "'Georgia','Times New Roman',serif",
              color: "#0f0505", lineHeight: 1.25, marginBottom: 14,
            }}>
              Your reflection
            </div>
            <div style={{ fontSize: 15, color: "#777", lineHeight: 1.6, marginBottom: 40 }}>
              Come back here after using the outcome links in your morning check-in email.
            </div>
            <a href={`${import.meta.env.BASE_URL}journey`} style={{
              display: "inline-block", padding: "14px 28px",
              background: "#8B1A1A", color: "#fff",
              textDecoration: "none", borderRadius: 12,
              fontSize: 15, fontWeight: 600, letterSpacing: ".01em",
            }}>
              Go to my journey
            </a>
          </div>
        )}
      </main>
    </div>
  );
}
