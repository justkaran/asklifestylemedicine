// ─── Site footer ───────────────────────────────────────────────────────────────
// One promise, one CTA, quiet nav + inline newsletter signup. Shared by the
// brand home ("/") and the sleep landing ("/sleep"). Extracted from App.tsx.
import { useState } from "react";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";

function FooterNewsletterSignup() {
  const RED = "#8B1A1A";
  const INK = "#0a0a0f";
  const RULE = "rgba(10,10,15,0.12)";
  const MUTED = "rgba(10,10,15,0.64)";
  const SANS = "-apple-system, BlinkMacSystemFont, 'Inter', sans-serif";
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");
  const [, setLocation] = useLocation();
  const { t } = useTranslation();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setState("loading");
    setMsg("");
    try {
      const r = await fetch("/api/newsletter/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), source: "home-footer" }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setState("error");
        setMsg(d.error ?? t("footer.newsletter.errorFallback"));
        return;
      }
      setState("done");
      setLocation(
        `/newsletter/subscribed${d.alreadySubscribed ? "?already=1" : d.pending ? "?pending=1" : ""}`,
      );
    } catch {
      setState("error");
      setMsg(t("footer.newsletter.networkError"));
    }
  }

  return (
    <div style={{ marginTop: 40, paddingTop: 32, borderTop: `1px solid ${RULE}`, maxWidth: 520, marginLeft: "auto", marginRight: "auto" }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".18em", textTransform: "uppercase", color: RED, marginBottom: 10 }}>
        {t("footer.newsletter.label")}
      </div>
      <p style={{ fontFamily: SANS, fontSize: 14, color: MUTED, margin: "0 0 16px", lineHeight: 1.55 }}>
        {t("footer.newsletter.description")}
      </p>
      <form onSubmit={submit} style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t("footer.newsletter.placeholder")}
          disabled={state === "loading" || state === "done"}
          style={{
            flex: "1 1 240px", minWidth: 0,
            border: `1px solid ${RULE}`, borderRadius: 999,
            padding: "12px 18px", fontSize: 14, fontFamily: SANS,
            background: "#fff", color: INK, outline: "none",
          }}
        />
        <button
          type="submit"
          disabled={state === "loading" || state === "done"}
          style={{
            background: state === "done" ? "#2e7d32" : RED, color: "#fff",
            border: "none", borderRadius: 999, padding: "12px 24px",
            fontSize: 14, fontWeight: 600, cursor: state === "done" ? "default" : "pointer",
            fontFamily: SANS, whiteSpace: "nowrap",
          }}
        >
          {state === "loading"
            ? t("footer.newsletter.subscribing")
            : state === "done"
              ? t("footer.newsletter.subscribed")
              : t("footer.newsletter.subscribe")}
        </button>
      </form>
      {msg && (
        <p style={{ fontFamily: SANS, fontSize: 13, color: state === "error" ? RED : "#2e7d32", margin: "10px 0 0" }}>
          {msg}
        </p>
      )}
    </div>
  );
}

interface SiteFooterProps {
  showNewsletterSignup?: boolean;
}

export function SiteFooter({ showNewsletterSignup = true }: SiteFooterProps = {}) {
  const SANS  = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif";
  const SERIF = "'Georgia','Times New Roman',serif";
  const RED   = "#B3261E";
  const INK   = "#0A0A0F";
  const PAPER = "#FAF8F4";
  const RULE  = "rgba(10,10,15,0.12)";
  const MUTED = "rgba(10,10,15,0.64)";
  const { t } = useTranslation();

  return (
    <footer
      style={{
        padding: "72px clamp(24px, 6vw, 96px) 36px",
        background: PAPER,
        borderTop: `1px solid ${RULE}`,
        fontFamily: SANS,
      }}
    >
      <div style={{
        maxWidth: 880, margin: "0 auto", textAlign: "center",
      }}>
        <div style={{
          fontSize: 11, fontWeight: 700, letterSpacing: ".24em",
          textTransform: "uppercase", color: RED, marginBottom: 16,
        }}>
          Palonur
        </div>
        <h2 style={{
          fontFamily: SERIF, fontSize: "clamp(32px, 5vw, 52px)",
          fontWeight: 500, lineHeight: 1.12, letterSpacing: -0.5,
          margin: "0 0 14px", color: INK,
        }}>
          {t("footer.tagline")}
        </h2>
        <p style={{
          fontFamily: SERIF, fontSize: "clamp(16px, 1.6vw, 19px)",
          lineHeight: 1.5, color: "rgba(10,10,15,0.62)",
          margin: "0 auto 32px", maxWidth: 620, fontStyle: "italic",
        }}>
          {t("footer.subTagline")}
        </p>
        <a
          href="mailto:partners@palonur.com"
          style={{
            display: "inline-block",
            background: INK, color: "#fff",
            padding: "14px 28px",
            borderRadius: 999,
            fontFamily: SANS, fontSize: 14, fontWeight: 600,
            letterSpacing: "0.02em",
            textDecoration: "none",
          }}
        >
          {t("footer.cta")}
        </a>

        {showNewsletterSignup && <FooterNewsletterSignup />}

        <div style={{
          marginTop: 36,
          display: "flex", flexWrap: "wrap", justifyContent: "center",
          gap: 22, fontSize: 12,
          color: "rgba(10,10,15,0.62)", letterSpacing: "0.02em",
        }}>
          {[
            { label: t("nav.about"),       href: `${import.meta.env.BASE_URL}about` },
            { label: t("nav.whatIsPalonur", "What is Palonur?"), href: `${import.meta.env.BASE_URL}what-is-palonur` },
            { label: t("nav.aiWithoutTraining", "AI without training"), href: `${import.meta.env.BASE_URL}ai-without-training` },
            { label: t("nav.pillars"),     href: `${import.meta.env.BASE_URL}pillars` },
            { label: t("nav.stewards"),    href: `${import.meta.env.BASE_URL}stewards` },
            { label: t("nav.sleep"),       href: `${import.meta.env.BASE_URL}sleep` },
            { label: t("nav.newsletter"),  href: `${import.meta.env.BASE_URL}newsletter` },
            { label: t("nav.readingRoom"), href: `${import.meta.env.BASE_URL}members-login` },
            { label: t("nav.forAgents"),   href: `${import.meta.env.BASE_URL}agents` },
            { label: t("nav.forPlatforms"),href: `${import.meta.env.BASE_URL}platforms` },
            { label: t("nav.terms"),       href: `${import.meta.env.BASE_URL}terms` },
            { label: t("nav.privacy"),     href: `${import.meta.env.BASE_URL}privacy` },
          ].map((l) => (
            <a key={l.label} href={l.href} style={{
              color: "inherit", textDecoration: "none",
            }}>{l.label}</a>
          ))}
        </div>
      </div>

      <div style={{
        maxWidth: 1100, margin: "44px auto 0",
        display: "flex", flexWrap: "wrap", gap: 18,
        alignItems: "center", justifyContent: "space-between",
        fontSize: 13, color: MUTED, letterSpacing: "0.02em",
        paddingTop: 28, borderTop: `1px solid ${RULE}`,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <svg width="14" height="14" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="24" cy="24" r="9"     stroke={INK} strokeWidth="1.6" />
            <circle cx="24" cy="15" r="9"     stroke={INK} strokeWidth="1.6" />
            <circle cx="31.8" cy="19.5" r="9" stroke={INK} strokeWidth="1.6" />
            <circle cx="31.8" cy="28.5" r="9" stroke={INK} strokeWidth="1.6" />
            <circle cx="24" cy="33"  r="9"    stroke={INK} strokeWidth="1.6" />
            <circle cx="16.2" cy="28.5" r="9" stroke={INK} strokeWidth="1.6" />
            <circle cx="16.2" cy="19.5" r="9" stroke={INK} strokeWidth="1.6" />
          </svg>
          <span>{t("footer.copyright")}</span>
        </div>
        <span>{t("footer.disclaimer")}</span>
      </div>

      <div style={{
        maxWidth: 1100, margin: "32px auto 0", textAlign: "center",
        fontFamily: SERIF, fontSize: "clamp(15px, 1.7vw, 19px)",
        fontStyle: "italic", color: "rgba(10,10,15,0.64)",
        letterSpacing: "0.01em",
      }}>
        {t("footer.slogan")}
      </div>
    </footer>
  );
}
