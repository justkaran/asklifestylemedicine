/**
 * Shared steward-achievements panel — an elegant overlay opened by clicking a
 * steward's avatar on public surfaces (the sleep answer surface, topic pages,
 * public publication pages). Shows the steward's photo, name, institution, and
 * their self-written achievements list; when no achievements exist it degrades
 * gracefully to just the identity (plus an optional bio) — never an empty or
 * broken state. Closes via the close button, clicking the backdrop, or Escape.
 */
import { useEffect } from "react";

const SANS =
  "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif";
const SERIF = "'Georgia','Times New Roman',serif";

export interface StewardPanelData {
  fullName: string | null;
  institution: string | null;
  photoUrl: string | null;
  achievements: string[];
  bio?: string | null;
}

const initialsOf = (name: string | null | undefined): string =>
  (name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("") || "?";

export function StewardAchievementsPanel({
  steward,
  onClose,
}: {
  steward: StewardPanelData;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const achievements = (steward.achievements ?? []).filter(
    (a) => typeof a === "string" && a.trim(),
  );

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={steward.fullName ?? "Steward"}
      data-testid="steward-achievements-overlay"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9000,
        background: "rgba(10,10,15,0.45)",
        backdropFilter: "blur(3px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        animation: "stewardPanelFade 0.18s ease both",
      }}
    >
      <style>{`
        @keyframes stewardPanelFade { from { opacity: 0 } to { opacity: 1 } }
        @keyframes stewardPanelRise { from { opacity: 0; transform: translateY(14px) } to { opacity: 1; transform: translateY(0) } }
      `}</style>
      <div
        onClick={(e) => e.stopPropagation()}
        data-testid="steward-achievements-panel"
        style={{
          background: "#FAF8F4",
          color: "#1a0505",
          fontFamily: SANS,
          borderRadius: 18,
          maxWidth: 520,
          width: "100%",
          maxHeight: "85dvh",
          overflowY: "auto",
          boxShadow: "0 30px 80px rgba(10,10,15,0.35)",
          padding: "clamp(28px, 5vw, 44px)",
          position: "relative",
          animation: "stewardPanelRise 0.22s ease both",
        }}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          data-testid="button-close-steward-panel"
          style={{
            position: "absolute",
            top: 16,
            right: 16,
            width: 34,
            height: 34,
            borderRadius: "50%",
            border: "1px solid rgba(10,10,15,0.15)",
            background: "transparent",
            color: "#1a0505",
            fontSize: 16,
            lineHeight: 1,
            cursor: "pointer",
          }}
        >
          ×
        </button>

        {steward.photoUrl ? (
          <img
            src={steward.photoUrl}
            alt={steward.fullName ?? "Steward"}
            style={{
              width: 96,
              height: 96,
              borderRadius: "50%",
              objectFit: "cover",
              display: "block",
              border: "2px solid rgba(139,26,26,.18)",
              boxShadow: "0 6px 18px rgba(26,5,5,.10)",
              marginBottom: 18,
            }}
          />
        ) : (
          <div
            style={{
              width: 96,
              height: 96,
              borderRadius: "50%",
              background: "linear-gradient(135deg, #8B1A1A, #5e0f0f)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
              fontSize: 32,
              fontWeight: 600,
              fontFamily: SERIF,
              marginBottom: 18,
            }}
          >
            {initialsOf(steward.fullName)}
          </div>
        )}

        <h2
          style={{
            margin: "0 0 6px",
            fontFamily: SERIF,
            fontWeight: 500,
            fontSize: "clamp(24px, 4vw, 30px)",
            lineHeight: 1.15,
            letterSpacing: "-0.01em",
          }}
          data-testid="text-steward-panel-name"
        >
          {steward.fullName ?? "Pillar steward"}
        </h2>
        {steward.institution && (
          <p
            style={{
              margin: "0 0 18px",
              fontSize: 14,
              color: "rgba(10,10,15,0.64)",
            }}
            data-testid="text-steward-panel-institution"
          >
            {steward.institution}
          </p>
        )}

        {achievements.length > 0 ? (
          <>
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: ".2em",
                textTransform: "uppercase",
                color: "#8B1A1A",
                margin: "10px 0 12px",
              }}
            >
              Remarkable achievements
            </div>
            <ul
              style={{ listStyle: "none", margin: 0, padding: 0 }}
              data-testid="list-steward-achievements"
            >
              {achievements.map((a, i) => (
                <li
                  key={i}
                  style={{
                    display: "flex",
                    gap: 12,
                    alignItems: "flex-start",
                    padding: "10px 0",
                    borderTop:
                      i === 0 ? "none" : "1px solid rgba(10,10,15,0.08)",
                    fontFamily: SERIF,
                    fontSize: 16,
                    lineHeight: 1.55,
                    color: "rgba(10,10,15,0.82)",
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      color: "#8B1A1A",
                      fontSize: 13,
                      lineHeight: "24px",
                      flexShrink: 0,
                    }}
                  >
                    ◆
                  </span>
                  <span>{a}</span>
                </li>
              ))}
            </ul>
          </>
        ) : steward.bio?.trim() ? (
          <p
            style={{
              margin: "6px 0 0",
              fontFamily: SERIF,
              fontSize: 16,
              lineHeight: 1.6,
              color: "rgba(10,10,15,0.78)",
            }}
            data-testid="text-steward-panel-bio"
          >
            {steward.bio.trim()}
          </p>
        ) : (
          <p
            style={{
              margin: "6px 0 0",
              fontFamily: SERIF,
              fontStyle: "italic",
              fontSize: 15,
              lineHeight: 1.6,
              color: "rgba(10,10,15,0.64)",
            }}
          >
            This steward puts their name — and their published research —
            behind every answer here.
          </p>
        )}
      </div>
    </div>
  );
}

export default StewardAchievementsPanel;
