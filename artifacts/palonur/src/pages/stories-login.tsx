import { useEffect, useState } from "react";

const RED = "#8B1A1A";
const INK = "#0a0a0f";
const PAPER = "#FAF8F4";
const MUTED = "rgba(10,10,15,0.62)";
const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "-apple-system, BlinkMacSystemFont, 'Inter', sans-serif";

export default function StoriesLogin() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [consuming, setConsuming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Stories sign-in · Palonur";
    document.body.style.background = PAPER;
    return () => { document.body.style.background = ""; };
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    if (!token) return;
    setConsuming(true);
    fetch(`/api/stories-auth/consume?token=${encodeURIComponent(token)}`, { credentials: "include" })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          setError(d.error ?? "This link is no longer valid.");
          setConsuming(false);
          return;
        }
        window.location.href = "/stories";
      })
      .catch(() => {
        setError("Could not verify the link.");
        setConsuming(false);
      });
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setError(null);
    const r = await fetch("/api/stories-auth/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim() }),
    });
    if (r.ok) setSent(true);
    else setError("Something went wrong. Try again.");
  }

  return (
    <div style={{ minHeight: "100vh", background: PAPER, fontFamily: SANS, color: INK }}>
      <div style={{ maxWidth: 460, margin: "0 auto", padding: "120px 24px" }}>
        <a href="/" style={{ textDecoration: "none", color: INK, fontWeight: 700, fontSize: 18 }}>Palonur</a>
        <div style={{ fontSize: 11, letterSpacing: ".18em", color: RED, fontWeight: 700, textTransform: "uppercase", marginTop: 36 }}>
          Stories editor sign-in
        </div>
        <h1 style={{ fontFamily: SERIF, fontSize: 34, fontWeight: 500, lineHeight: 1.2, margin: "10px 0 14px" }}>
          {consuming ? "Signing you in…" : sent ? "Check your inbox." : "Sign in with email."}
        </h1>
        {!sent && !consuming && (
          <>
            <p style={{ fontFamily: SERIF, fontSize: 17, color: MUTED, lineHeight: 1.55 }}>
              We'll email a one-time link. It expires in 30 minutes.
            </p>
            <form onSubmit={submit} style={{ marginTop: 24 }}>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@stanfordlifestyle.com"
                style={{
                  width: "100%", boxSizing: "border-box",
                  padding: "14px 16px", border: "1px solid rgba(10,10,15,0.15)",
                  borderRadius: 12, fontSize: 16, fontFamily: SANS, background: "#fff",
                }}
              />
              <button type="submit" style={{
                marginTop: 14, width: "100%",
                background: RED, color: "#fff", border: "none",
                borderRadius: 999, padding: "14px 22px",
                fontSize: 15, fontWeight: 700, cursor: "pointer",
              }}>Email me a link</button>
            </form>
          </>
        )}
        {sent && (
          <p style={{ fontFamily: SERIF, fontSize: 17, color: MUTED, lineHeight: 1.55, marginTop: 14 }}>
            If <strong style={{ color: INK }}>{email}</strong> is on the editor allowlist, a sign-in link is on its way.
          </p>
        )}
        {error && <div style={{ color: RED, marginTop: 14, fontSize: 14 }}>{error}</div>}
      </div>
    </div>
  );
}
