import { useEffect } from "react";
import { Link } from "wouter";
import { useTranslation } from "react-i18next";

const INK = "#01010A";
const PAPER = "#FAF8F4";
const RED = "#B3261E";
const GOLD = "#B9924A";

export default function NotFound() {
  const { t } = useTranslation("notfound");

  useEffect(() => {
    const prev = document.body.style.background;
    document.body.style.background = INK;
    document.title = "Lost in the dark · Palonur";
    return () => {
      document.body.style.background = prev;
    };
  }, []);

  return (
    <div
      style={{
        minHeight: "100dvh",
        background: INK,
        color: PAPER,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "32px 24px",
        textAlign: "center",
        position: "relative",
        overflow: "hidden",
        fontFamily:
          '"Source Serif 4", "Source Serif Pro", Georgia, "Times New Roman", serif',
      }}
    >
      <style>{`
        @keyframes pulse-moon {
          0%,100% { transform: translateY(0) scale(1); opacity:.95 }
          50%     { transform: translateY(-6px) scale(1.02); opacity:1 }
        }
        @keyframes twinkle {
          0%,100% { opacity:.25 }
          50%     { opacity:.95 }
        }
        @keyframes drift {
          0%   { transform: translate3d(0,0,0) }
          100% { transform: translate3d(0,-12px,0) }
        }
        .nf-star{
          position:absolute;width:2px;height:2px;border-radius:50%;
          background:#fff;animation: twinkle 3.6s ease-in-out infinite;
          will-change: opacity;
        }
      `}</style>

      {/* twinkling stars */}
      {STARS.map((s, i) => (
        <span
          key={i}
          className="nf-star"
          style={{
            top: `${s.t}%`,
            left: `${s.l}%`,
            width: s.s,
            height: s.s,
            animationDelay: `${s.d}s`,
            opacity: 0.6,
          }}
        />
      ))}

      {/* moon */}
      <div
        aria-hidden
        style={{
          width: 110,
          height: 110,
          borderRadius: "50%",
          background:
            "radial-gradient(circle at 35% 30%, #f6efd9 0%, #d8cba2 55%, #a89770 100%)",
          boxShadow:
            "0 0 60px rgba(232,235,180,.22), inset -10px -8px 24px rgba(0,0,0,.35)",
          marginBottom: 36,
          animation: "pulse-moon 6s ease-in-out infinite",
        }}
      />

      <div
        style={{
          fontFamily:
            '-apple-system, "Segoe UI", Helvetica, Arial, sans-serif',
          fontSize: 11,
          letterSpacing: ".22em",
          textTransform: "uppercase",
          color: GOLD,
          marginBottom: 14,
        }}
      >
        {t("eyebrow")}
      </div>

      <h1
        style={{
          fontSize: "clamp(34px, 6vw, 56px)",
          fontWeight: 500,
          lineHeight: 1.05,
          margin: "0 0 14px",
          maxWidth: 720,
        }}
      >
        {t("headline")
          .split(/\{\{em\}\}(.*?)\{\{\/em\}\}/)
          .map((part, i) =>
            i % 2 === 1 ? (
              <em key={i} style={{ color: RED, fontStyle: "italic" }}>
                {part}
              </em>
            ) : (
              part
            )
          )}
      </h1>

      <p
        style={{
          fontSize: 16,
          lineHeight: 1.55,
          color: "#cfccc4",
          maxWidth: 540,
          margin: "0 0 28px",
        }}
      >
        {t("body")}
      </p>

      <div
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          justifyContent: "center",
        }}
      >
        <Link
          href="/"
          style={{
            background: PAPER,
            color: INK,
            padding: "12px 22px",
            borderRadius: 999,
            textDecoration: "none",
            fontFamily:
              '-apple-system, "Segoe UI", Helvetica, Arial, sans-serif',
            fontSize: 14,
            fontWeight: 600,
            letterSpacing: ".02em",
          }}
        >
          {t("askSleep")}
        </Link>
        <Link
          href="/about"
          style={{
            background: "transparent",
            color: PAPER,
            border: "1px solid #2a2a30",
            padding: "12px 22px",
            borderRadius: 999,
            textDecoration: "none",
            fontFamily:
              '-apple-system, "Segoe UI", Helvetica, Arial, sans-serif',
            fontSize: 14,
            fontWeight: 500,
            letterSpacing: ".02em",
          }}
        >
          {t("whyBuilding")}
        </Link>
      </div>

      <div
        style={{
          position: "absolute",
          bottom: 24,
          left: 0,
          right: 0,
          fontFamily:
            '-apple-system, "Segoe UI", Helvetica, Arial, sans-serif',
          fontSize: 10.5,
          letterSpacing: ".18em",
          textTransform: "uppercase",
          color: "#6a6a72",
        }}
      >
        {t("collab")}
      </div>
    </div>
  );
}

type Star = { t: number; l: number; s: number; d: number };
const STARS: Star[] = Array.from({ length: 60 }, (_, i) => {
  const seed = (i * 9301 + 49297) % 233280;
  const r = (n: number) => (((seed * (n + 1)) % 1000) / 1000);
  return {
    t: r(1) * 100,
    l: r(2) * 100,
    s: 1 + Math.round(r(3) * 2),
    d: r(4) * 4,
  };
});
