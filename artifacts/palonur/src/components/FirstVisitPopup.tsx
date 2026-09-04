import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";

const POPUP_KEY = "palonur-fvp-dismissed";
const CARDINAL = "#8C1515";

function shouldShow(): boolean {
  try { return !localStorage.getItem(POPUP_KEY); } catch { return false; }
}
function dismiss() {
  try { localStorage.setItem(POPUP_KEY, "1"); } catch { /* ignore */ }
}

export default function FirstVisitPopup() {
  const { t } = useTranslation("common");
  const [visible, setVisible] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!shouldShow()) return;
    const handler = () => setVisible(true);
    window.addEventListener("palonur:first-answer", handler);
    return () => window.removeEventListener("palonur:first-answer", handler);
  }, []);

  if (!visible) return null;

  function close() { dismiss(); setVisible(false); }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/beta/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() || undefined, email, foundingMember: true, variant: "popup" }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? t("popup.errorGeneric")); setLoading(false); return; }
      dismiss();
      setDone(true);
    } catch {
      setError(t("popup.errorServer"));
      setLoading(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box",
    border: "none", borderBottom: "1.5px solid #ccc",
    padding: "10px 0", fontSize: 16,
    background: "transparent", color: "#222",
    marginBottom: 20, display: "block",
    transition: "border-color .15s",
    fontFamily: "inherit",
    outline: "none",
  };

  return (
    <>
      <style>{`
        @keyframes fvp-fade { from{opacity:0} to{opacity:1} }
        @keyframes fvp-up { from{opacity:0;transform:translate(-50%,-47%)} to{opacity:1;transform:translate(-50%,-50%)} }
        .fvp-input::placeholder { color: #bbb; }
        .fvp-input:focus { border-color: #8C1515 !important; }
        @media (max-width: 540px) {
          .fvp-img-panel { display: none !important; }
          .fvp-content { padding: 40px 22px 28px !important; }
          .fvp-title { font-size: 26px !important; }
          .fvp-subtitle { font-size: 16px !important; }
        }
      `}</style>

      {/* Backdrop */}
      <div onClick={close} style={{
        position: "fixed", inset: 0,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(4px)",
        zIndex: 9998,
        animation: "fvp-fade .2s ease",
      }} />

      {/* Modal */}
      <div role="dialog" aria-modal="true" aria-label={t("popup.title")} style={{
        position: "fixed", top: "50%", left: "50%",
        transform: "translate(-50%, -50%)",
        zIndex: 9999,
        width: "min(860px, calc(100vw - 24px))",
        maxHeight: "calc(100dvh - 32px)",
        background: "#fff",
        borderRadius: 16,
        boxShadow: "0 32px 80px rgba(0,0,0,.4)",
        display: "flex",
        overflow: "hidden",
        animation: "fvp-up .3s cubic-bezier(.22,1,.36,1)",
      }}>

        {/* Left: image panel */}
        <div className="fvp-img-panel" style={{
          flex: "0 0 42%",
          position: "relative",
          display: "flex",
        }}>
          <img
            src="/expert-face.png"
            alt="Expert faculty"
            style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "center 20%", display: "block" }}
          />
          <div style={{
            position: "absolute", inset: 0,
            background: "linear-gradient(to right, transparent 70%, rgba(255,255,255,0.25) 100%)",
          }} />
        </div>

        {/* Right: content panel */}
        <div className="fvp-content" style={{ flex: 1, padding: "48px 44px 36px", position: "relative", overflowY: "auto" }}>

          {/* Close button */}
          <button onClick={close} aria-label="Close" style={{
            position: "absolute", top: 14, right: 14,
            width: 32, height: 32, borderRadius: "50%",
            background: "#f0f0f0", border: "none", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 14, color: "#555", lineHeight: 1,
          }}>&#x2715;</button>

          {done ? (
            <div style={{ textAlign: "center", paddingTop: 40 }}>
              <div style={{ fontSize: 44, marginBottom: 16 }}>&#127942;</div>
              <div style={{ fontFamily: "Georgia, serif", fontSize: 26, fontWeight: 700, color: CARDINAL, lineHeight: 1.2, marginBottom: 12 }}>
                {t("popup.successTitle")}
              </div>
              <p style={{ fontSize: 15, color: "#555", lineHeight: 1.6, marginBottom: 24 }}>
                {t("popup.successBody")}
              </p>
              <button onClick={close} style={{
                background: CARDINAL, color: "#fff",
                border: "none", borderRadius: 50, padding: "14px 36px",
                fontSize: 15, fontWeight: 700, cursor: "pointer", letterSpacing: ".04em",
              }}>{t("popup.continue")}</button>
            </div>
          ) : (
            <>
              {/* Headline */}
              <div className="fvp-title" style={{
                fontFamily: "Georgia, 'Times New Roman', serif",
                fontSize: 36, fontWeight: 800, color: CARDINAL,
                lineHeight: 1.1, letterSpacing: "-.01em", marginBottom: 6,
                textTransform: "uppercase",
              }}>
                {t("popup.title")}
              </div>

              {/* Sub-headline */}
              <div className="fvp-subtitle" style={{
                fontFamily: "Georgia, serif",
                fontSize: 20, fontWeight: 700, color: CARDINAL,
                marginBottom: 18, textTransform: "uppercase", letterSpacing: ".02em",
              }}>
                {t("popup.subTitle")}
              </div>

              {/* Body */}
              <p style={{ fontSize: 15, color: "#444", lineHeight: 1.6, margin: "0 0 22px" }}>
                {t("popup.body")}
              </p>

              {/* Form */}
              <form onSubmit={handleSubmit}>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Your name"
                  className="fvp-input"
                  style={inputStyle}
                />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder={t("popup.emailPlaceholder")}
                  className="fvp-input"
                  style={inputStyle}
                />

                {error && (
                  <div style={{
                    fontSize: 13, color: "#b91c1c",
                    background: "#fef2f2", border: "1px solid #fecaca",
                    borderRadius: 8, padding: "8px 12px", marginBottom: 12,
                  }}>{error}</div>
                )}

                {/* Legal */}
                <p style={{ fontSize: 11, color: "#aaa", lineHeight: 1.5, margin: "0 0 18px" }}>
                  {t("popup.legal")}
                </p>

                {/* CTA */}
                <button type="submit" disabled={loading || !email} style={{
                  width: "100%",
                  background: loading || !email ? "#c08080" : CARDINAL,
                  color: "#fff", fontWeight: 800, fontSize: 16,
                  border: "none", borderRadius: 50, padding: "16px",
                  cursor: loading || !email ? "not-allowed" : "pointer",
                  letterSpacing: ".08em", textTransform: "uppercase",
                  transition: "background .15s",
                }}>
                  {loading ? t("popup.saving") : t("popup.claimSpot")}
                </button>

                {/* Dismiss */}
                <div style={{ textAlign: "center", marginTop: 16 }}>
                  <button type="button" onClick={close} style={{
                    background: "none", border: "none", cursor: "pointer",
                    fontSize: 13, fontWeight: 700, color: CARDINAL,
                    letterSpacing: ".08em", textTransform: "uppercase",
                    textDecoration: "none", padding: 0,
                  }}>
                    {t("popup.noThanks")}
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      </div>
    </>
  );
}
