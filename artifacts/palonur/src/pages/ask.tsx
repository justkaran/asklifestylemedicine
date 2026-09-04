import { useEffect, useState } from "react";
import {
  RED,
  INK,
  PAPER,
  MUTED,
  SERIF,
  SANS,
} from "@/components/newsletter-subscribe";
import { PhoneCapture } from "@/components/phone-capture";

/**
 * Public "Ask Palonur" intake. Anyone can send a question to the Stanford
 * Lifestyle Medicine experts. We capture name (optional), email, the question,
 * and MANDATORY dual consent (we may email a reply + a privacy acknowledgement).
 * The server hashes the IP for the consent record (never stores the raw IP) and
 * pre-triages the question for the support concierge. POSTs /api/support/ask.
 */
function tint(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  if (h.length !== 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export default function Ask() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [consentReply, setConsentReply] = useState(false);
  const [consentPrivacy, setConsentPrivacy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Ask Palonur";
    document.body.style.background = PAPER;
    return () => {
      document.body.style.background = "";
    };
  }, []);

  const canSubmit =
    email.trim().includes("@") &&
    message.trim().length >= 5 &&
    consentReply &&
    consentPrivacy &&
    !submitting;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!consentReply || !consentPrivacy) {
      setError("Please tick both consent boxes.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch("/api/support/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || undefined,
          email: email.trim(),
          message: message.trim(),
          consentReply,
          consentPrivacy,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(d.error ?? "Something went wrong. Please try again.");
        return;
      }
      setDone(true);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const border = tint(RED, 0.2);

  return (
    <div style={{ minHeight: "100vh", background: PAPER, fontFamily: SANS, color: INK }}>
      <div style={{ maxWidth: 620, margin: "0 auto", padding: "96px 24px 120px" }}>
        <a href="/" style={{ textDecoration: "none", color: INK, fontWeight: 700, fontSize: 18 }}>
          Palonur
        </a>
        <div
          style={{
            fontSize: 11,
            letterSpacing: ".18em",
            color: RED,
            fontWeight: 700,
            textTransform: "uppercase",
            marginTop: 36,
          }}
        >
          Ask Palonur
        </div>

        {done ? (
          <>
            <h1
              style={{
                fontFamily: SERIF,
                fontSize: 36,
                fontWeight: 500,
                lineHeight: 1.18,
                margin: "10px 0 14px",
                color: INK,
              }}
            >
              Your question is in good hands.
            </h1>
            <p style={{ fontFamily: SERIF, fontSize: 18, color: MUTED, lineHeight: 1.6 }}>
              A real person on the Palonur team reads every question and routes it
              to the Stanford expert who knows it best. If it needs a reply, we'll
              email you at <strong style={{ color: INK }}>{email}</strong>.
            </p>
            <a
              href="/"
              style={{
                display: "inline-block",
                marginTop: 24,
                color: RED,
                fontWeight: 700,
                textDecoration: "none",
              }}
            >
              ← Back to Palonur
            </a>
          </>
        ) : (
          <>
            <h1
              style={{
                fontFamily: SERIF,
                fontSize: 36,
                fontWeight: 500,
                lineHeight: 1.18,
                margin: "10px 0 12px",
                color: INK,
              }}
            >
              Ask a Stanford lifestyle-medicine expert.
            </h1>
            <p style={{ fontFamily: SERIF, fontSize: 18, color: MUTED, lineHeight: 1.6, margin: "0 0 28px" }}>
              Send us your question about sleep, movement, nutrition, or anything
              under lifestyle medicine. A person reads it, routes it to the right
              expert, and replies grounded in real research.
            </p>

            <form onSubmit={submit} style={{ display: "grid", gap: 16 }}>
              <label style={{ display: "block" }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: INK }}>
                  Your name <span style={{ color: MUTED, fontWeight: 400 }}>(optional)</span>
                </span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Jane Doe"
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    marginTop: 6,
                    padding: "13px 15px",
                    border: `1.5px solid ${border}`,
                    borderRadius: 12,
                    fontSize: 16,
                    fontFamily: SANS,
                    background: "#fff",
                    color: INK,
                  }}
                />
              </label>

              <label style={{ display: "block" }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: INK }}>Email</span>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@email.com"
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    marginTop: 6,
                    padding: "13px 15px",
                    border: `1.5px solid ${border}`,
                    borderRadius: 12,
                    fontSize: 16,
                    fontFamily: SANS,
                    background: "#fff",
                    color: INK,
                  }}
                />
              </label>

              <label style={{ display: "block" }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: INK }}>
                  Your question
                </span>
                <textarea
                  required
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={5}
                  placeholder="e.g. Does morning light actually help me fall asleep earlier?"
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    marginTop: 6,
                    padding: "13px 15px",
                    border: `1.5px solid ${border}`,
                    borderRadius: 12,
                    fontSize: 16,
                    fontFamily: SANS,
                    lineHeight: 1.55,
                    background: "#fff",
                    color: INK,
                    resize: "vertical",
                  }}
                />
              </label>

              <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 14, color: tint(INK, 0.82), lineHeight: 1.5 }}>
                <input
                  type="checkbox"
                  checked={consentReply}
                  onChange={(e) => setConsentReply(e.target.checked)}
                  style={{ marginTop: 4 }}
                />
                <span>
                  I agree that Palonur may use my email to send a reply to my
                  question.
                </span>
              </label>

              <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 14, color: tint(INK, 0.82), lineHeight: 1.5 }}>
                <input
                  type="checkbox"
                  checked={consentPrivacy}
                  onChange={(e) => setConsentPrivacy(e.target.checked)}
                  style={{ marginTop: 4 }}
                />
                <span>
                  I understand my question is reviewed by the Palonur team and is
                  general education, not personal medical advice.
                </span>
              </label>

              {error && (
                <div style={{ color: "#b91c1c", fontSize: 14 }}>{error}</div>
              )}

              <button
                type="submit"
                disabled={!canSubmit}
                style={{
                  background: canSubmit ? RED : "rgba(10,10,15,0.18)",
                  color: "#fff",
                  border: "none",
                  borderRadius: 999,
                  padding: "14px 24px",
                  fontSize: 15,
                  fontWeight: 700,
                  cursor: canSubmit ? "pointer" : "default",
                  justifySelf: "start",
                }}
              >
                {submitting ? "Sending…" : "Send my question"}
              </button>
            </form>

            <div
              style={{
                marginTop: 40,
                paddingTop: 32,
                borderTop: `1px solid ${border}`,
              }}
            >
              <PhoneCapture
                product="nightly"
                source="ask"
                accent={RED}
                ink={INK}
                muted={MUTED}
                border={border}
                sans={SANS}
                serif={SERIF}
                collapsible
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
