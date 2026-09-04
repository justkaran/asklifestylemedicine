// ─── Newsletter pitch band ─────────────────────────────────────────────────────
// Blush conversion band shared by the brand home ("/") and the sleep landing
// ("/sleep"). Extracted from App.tsx unchanged.
import { useState } from "react";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";

export function NewsletterPitch() {
  const SANS  = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif";
  const SERIF = "'Georgia','Times New Roman',serif";
  const RED   = "#B3261E";
  const INK   = "#0A0A0F";
  const BLUSH = "#F4EAE5";
  const RULE  = "rgba(10,10,15,0.12)";
  const { t } = useTranslation();

  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");
  const [, setLocation] = useLocation();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setState("loading");
    setMsg("");
    try {
      const r = await fetch("/api/newsletter/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), source: "home-inline" }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setState("error");
        setMsg(d.error ?? t("newsletterPitch.errorFallback"));
        return;
      }
      setState("done");
      setLocation(
        `/newsletter/subscribed${d.alreadySubscribed ? "?already=1" : d.pending ? "?pending=1" : ""}`,
      );
    } catch {
      setState("error");
      setMsg(t("newsletterPitch.networkError"));
    }
  }

  return (
    <div
      style={{
        minHeight: "auto",
        padding: "clamp(64px, 9vh, 110px) clamp(24px, 6vw, 96px)",
        borderBottom: `1px solid ${RULE}`,
        background: BLUSH,
        fontFamily: SANS,
        color: INK,
      }}
    >
      <div style={{ width: "100%", maxWidth: 760, margin: "0 auto", textAlign: "center" }}>
        <div style={{
          fontSize: 11, fontWeight: 700, letterSpacing: ".24em",
          textTransform: "uppercase", color: RED, marginBottom: 22,
        }}>
          {t("newsletterPitch.label")}
        </div>
        <h2 style={{
          margin: "0 0 22px",
          fontFamily: SERIF, fontWeight: 500,
          fontSize: "clamp(30px, 4.4vw, 50px)",
          lineHeight: 1.08, letterSpacing: "-0.018em",
          color: INK,
        }}>
          {t("newsletterPitch.headline")}{" "}
          <em style={{ fontStyle: "italic" }}>{t("newsletterPitch.headlineEm")}</em>
        </h2>
        <p style={{
          margin: "0 auto 32px", maxWidth: 560,
          fontFamily: SERIF,
          fontSize: "clamp(17px, 1.5vw, 19px)",
          lineHeight: 1.6, color: "rgba(10,10,15,0.72)",
        }}>
          {t("newsletterPitch.body")}
        </p>

        <form
          onSubmit={submit}
          style={{
            display: "flex", gap: 10, flexWrap: "wrap",
            justifyContent: "center", maxWidth: 520, margin: "0 auto",
          }}
        >
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("newsletterPitch.placeholder")}
            disabled={state === "loading" || state === "done"}
            data-testid="input-newsletter-inline-email"
            style={{
              flex: "1 1 260px", minWidth: 0,
              border: `1px solid ${RULE}`, borderRadius: 999,
              padding: "15px 22px", fontSize: 15, fontFamily: SANS,
              background: "#fff", color: INK, outline: "none",
            }}
          />
          <button
            type="submit"
            disabled={state === "loading" || state === "done"}
            data-testid="button-newsletter-inline-subscribe"
            style={{
              background: state === "done" ? "#2e7d32" : RED, color: "#fff",
              border: "none", borderRadius: 999, padding: "15px 30px",
              fontSize: 15, fontWeight: 700,
              cursor: state === "done" ? "default" : "pointer",
              fontFamily: SANS, whiteSpace: "nowrap", letterSpacing: "0.01em",
            }}
          >
            {state === "loading"
              ? t("newsletterPitch.subscribing")
              : state === "done"
                ? t("newsletterPitch.subscribed")
                : t("newsletterPitch.subscribe")}
          </button>
        </form>
        {msg && (
          <p style={{
            fontFamily: SANS, fontSize: 14,
            color: state === "error" ? RED : "#2e7d32",
            margin: "14px 0 0",
          }}>
            {msg}
          </p>
        )}
      </div>
    </div>
  );
}
