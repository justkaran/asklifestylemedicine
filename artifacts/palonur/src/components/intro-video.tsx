import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const RED = "#B3261E";
const INK = "#0A0A0F";
const SERIF = "'Georgia','Times New Roman',serif";

const VIDEO_ID = "palonur-intro";
const OVERLAY_SEEN_KEY = "palonur_intro_video_seen";

function readStorage(store: Storage | undefined, key: string): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(store: Storage | undefined, key: string, value: string) {
  try {
    store?.setItem(key, value);
  } catch {
    // ignore
  }
}

function useTrackPlay() {
  const trackedRef = useRef(false);
  return () => {
    if (trackedRef.current) return;
    trackedRef.current = true;
    fetch("/api/video-view", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        video: VIDEO_ID,
        session_id: readStorage(window.sessionStorage, "palonur_sid"),
        visitor_id: readStorage(window.localStorage, "palonur_vid"),
      }),
    }).catch(() => {});
  };
}

const videoStyle: React.CSSProperties = {
  width: "100%",
  borderRadius: 24,
  boxShadow: "0 24px 80px rgba(10,10,15,0.18)",
  background: INK,
  display: "block",
};

export function IntroVideoOverlay() {
  const { t } = useTranslation("home");
  const handlePlay = useTrackPlay();
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (readStorage(window.sessionStorage, OVERLAY_SEEN_KEY)) return;
    setOpen(true);
    writeStorage(window.sessionStorage, OVERLAY_SEEN_KEY, "1");
  }, []);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      if (e.key === "Tab") {
        const dialog = dialogRef.current;
        if (!dialog) return;
        const focusables = Array.from(
          dialog.querySelectorAll<HTMLElement>(
            "button, video, [href], [tabindex]:not([tabindex='-1'])",
          ),
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (!dialog.contains(active)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      previousFocusRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      data-testid="overlay-intro-video"
      role="dialog"
      aria-modal="true"
      aria-label={t("introVideo.headline")}
      onClick={() => setOpen(false)}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(10,10,15,0.72)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "clamp(16px, 4vw, 48px)",
      }}
    >
      <div
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 880 }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 14,
            gap: 16,
          }}
        >
          <div
            style={{
              fontFamily: SERIF,
              fontSize: 16,
              fontWeight: 500,
              color: "#FFFFFF",
            }}
          >
            {t("introVideo.headline")}
          </div>
          <button
            type="button"
            ref={closeButtonRef}
            data-testid="button-close-intro-video"
            onClick={() => setOpen(false)}
            style={{
              flexShrink: 0,
              border: "1px solid rgba(255,255,255,0.4)",
              background: "rgba(255,255,255,0.1)",
              color: "#FFFFFF",
              borderRadius: 999,
              padding: "8px 18px",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {t("introVideo.close")}
          </button>
        </div>
        <video
          data-testid="video-palonur-intro-overlay"
          controls
          preload="auto"
          playsInline
          onPlay={handlePlay}
          poster={`${import.meta.env.BASE_URL}palonur-intro-poster.jpg`}
          style={videoStyle}
          src={`${import.meta.env.BASE_URL}palonur-intro.mp4`}
        />
      </div>
    </div>
  );
}

export function IntroVideo() {
  const { t } = useTranslation("home");
  const handlePlay = useTrackPlay();

  return (
    <div
      data-testid="section-intro-video"
      style={{
        padding: "0 clamp(24px, 6vw, 96px) clamp(80px, 12vh, 140px)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: ".24em",
          textTransform: "uppercase",
          color: RED,
          marginBottom: 28,
        }}
      >
        {t("introVideo.eyebrow")}
      </div>
      <div
        style={{
          fontFamily: SERIF,
          fontSize: "clamp(24px, 3.2vw, 36px)",
          fontWeight: 500,
          lineHeight: 1.2,
          color: INK,
          marginBottom: 36,
          maxWidth: 720,
        }}
      >
        {t("introVideo.headline")}
      </div>
      <video
        data-testid="video-palonur-intro"
        controls
        preload="metadata"
        playsInline
        onPlay={handlePlay}
        poster={`${import.meta.env.BASE_URL}palonur-intro-poster.jpg`}
        style={{ ...videoStyle, maxWidth: 880 }}
        src={`${import.meta.env.BASE_URL}palonur-intro.mp4`}
      />
    </div>
  );
}
