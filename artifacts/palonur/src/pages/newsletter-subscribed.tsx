import { useEffect, useMemo } from "react";
import { Link } from "wouter";
import { useTranslation } from "react-i18next";

const RED = "#8B1A1A";
const INK = "#0a0a0f";
const PAPER = "#FAF8F4";
const GOLD = "#B9924A";
const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "-apple-system, BlinkMacSystemFont, 'Inter', sans-serif";

type Mode = "pending" | "confirmed" | "already" | "expired" | "default";

export default function NewsletterSubscribed() {
  const { t } = useTranslation("newsletter");

  const mode = useMemo<Mode>(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("pending") === "1") return "pending";
    if (p.get("confirmed") === "1") return "confirmed";
    if (p.get("already") === "1") return "already";
    if (p.get("expired") === "1") return "expired";
    return "default";
  }, []);

  const docTitle = useMemo(() => {
    switch (mode) {
      case "pending":   return "Almost there · Palonur newsletter";
      case "already":   return "Already subscribed · Palonur newsletter";
      case "expired":   return "Link expired · Palonur newsletter";
      default:          return "You're subscribed · Palonur newsletter";
    }
  }, [mode]);

  useEffect(() => {
    const prevTitle = document.title;
    document.title = docTitle;
    const prevBg = document.body.style.background;
    document.body.style.background = PAPER;

    const prevDesc = document
      .querySelector('meta[name="description"]')
      ?.getAttribute("content");
    let meta = document.querySelector('meta[name="description"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "description");
      document.head.appendChild(meta);
    }
    meta.setAttribute(
      "content",
      "Confirm and manage your Palonur newsletter subscription — Stanford sleep science, in your inbox.",
    );

    return () => {
      document.title = prevTitle;
      document.body.style.background = prevBg;
      if (prevDesc && meta) meta.setAttribute("content", prevDesc);
    };
  }, [docTitle]);

  // Per-mode derived values
  const icon = mode === "pending" ? "✉" : mode === "expired" ? "↻" : "✓";
  const iconIsSuccess = mode !== "pending" && mode !== "expired";

  const headline = useMemo((): React.ReactNode => {
    switch (mode) {
      case "pending":
        return (
          <>
            {t("subscribed.pending.headline")}{" "}
            <em style={{ fontStyle: "italic", color: RED }}>
              {t("subscribed.pending.headlineEm")}
            </em>
          </>
        );
      case "already":
        return (
          <>
            {t("subscribed.already.headline")}{" "}
            <em style={{ fontStyle: "italic", color: RED }}>
              {t("subscribed.already.headlineEm")}
            </em>
          </>
        );
      case "expired":
        return (
          <>
            {t("subscribed.expired.headline")}{" "}
            <em style={{ fontStyle: "italic", color: RED }}>
              {t("subscribed.expired.headlineEm")}
            </em>
          </>
        );
      default:
        return (
          <>
            {t("subscribed.confirmed.headline")}{" "}
            <em style={{ fontStyle: "italic", color: RED }}>
              {t("subscribed.confirmed.headlineEm")}
            </em>
          </>
        );
    }
  }, [mode, t]);

  const body = useMemo(() => {
    switch (mode) {
      case "pending":  return t("subscribed.pending.body");
      case "already":  return t("subscribed.already.body");
      case "expired":  return t("subscribed.expired.body");
      case "confirmed": return t("subscribed.confirmed.bodyConfirmed");
      default:         return t("subscribed.confirmed.bodyDefault");
    }
  }, [mode, t]);

  const primary = useMemo(() => {
    switch (mode) {
      case "expired": return { href: "/newsletter", label: t("subscribed.expired.cta") };
      default:        return { href: "/sleep", label: t("subscribed.pending.cta") };
    }
  }, [mode, t]);

  return (
    <div
      style={{
        minHeight: "100dvh",
        background: PAPER,
        color: INK,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "48px 24px",
        textAlign: "center",
        fontFamily: SERIF,
        position: "relative",
        overflow: "hidden",
      }}
    >
      <style>{`
        @keyframes ns-rise {
          0%   { transform: translateY(10px); opacity: 0 }
          100% { transform: translateY(0);    opacity: 1 }
        }
        @keyframes ns-glow {
          0%,100% { transform: scale(1);    box-shadow: 0 0 40px rgba(185,146,74,.28) }
          50%     { transform: scale(1.03); box-shadow: 0 0 60px rgba(185,146,74,.42) }
        }
      `}</style>

      <div
        aria-hidden
        style={{
          width: 88,
          height: 88,
          borderRadius: "50%",
          background: iconIsSuccess
            ? "radial-gradient(circle at 35% 30%, #f6efd9 0%, #e3d4a8 55%, #c9b27e 100%)"
            : "radial-gradient(circle at 35% 30%, #fbf6ec 0%, #efe3c8 55%, #ddcca0 100%)",
          marginBottom: 30,
          animation: iconIsSuccess
            ? "ns-glow 6s ease-in-out infinite"
            : "ns-rise .5s ease both",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 36,
          color: RED,
        }}
      >
        {icon}
      </div>

      <div
        style={{
          fontFamily: SANS,
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: ".24em",
          textTransform: "uppercase",
          color: RED,
          marginBottom: 16,
          animation: "ns-rise .5s ease both",
        }}
      >
        {t("subscribed.label")}
      </div>

      <h1
        style={{
          fontSize: "clamp(32px, 5.5vw, 52px)",
          fontWeight: 500,
          lineHeight: 1.08,
          letterSpacing: "-0.018em",
          margin: "0 0 18px",
          maxWidth: 680,
          animation: "ns-rise .6s ease both",
        }}
      >
        {headline}
      </h1>

      <p
        style={{
          fontSize: "clamp(17px, 1.6vw, 19px)",
          lineHeight: 1.6,
          color: "rgba(10,10,15,0.72)",
          maxWidth: 540,
          margin: "0 0 36px",
          animation: "ns-rise .7s ease both",
        }}
      >
        {body}
      </p>

      <div
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          justifyContent: "center",
          animation: "ns-rise .8s ease both",
        }}
      >
        <Link
          href={primary.href}
          style={{
            background: INK,
            color: PAPER,
            padding: "13px 26px",
            borderRadius: 999,
            textDecoration: "none",
            fontFamily: SANS,
            fontSize: 14,
            fontWeight: 600,
            letterSpacing: "0.01em",
          }}
        >
          {primary.label}
        </Link>
        <Link
          href="/"
          style={{
            background: "transparent",
            color: INK,
            border: "1px solid rgba(10,10,15,0.16)",
            padding: "13px 26px",
            borderRadius: 999,
            textDecoration: "none",
            fontFamily: SANS,
            fontSize: 14,
            fontWeight: 500,
            letterSpacing: "0.01em",
          }}
        >
          {t("subscribed.backHome")}
        </Link>
      </div>

      <div
        style={{
          marginTop: 48,
          fontFamily: SANS,
          fontSize: 10.5,
          letterSpacing: ".18em",
          textTransform: "uppercase",
          color: GOLD,
        }}
      >
        {t("subscribed.collab")}
      </div>
    </div>
  );
}
