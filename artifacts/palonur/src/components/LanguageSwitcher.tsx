import { useTranslation } from "react-i18next";

const LANGS = ["EN", "DE"] as const;
type Lang = (typeof LANGS)[number];

/** Floating EN / DE pill toggle. Placed in App root so it overlays every page. */
export function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const current = (i18n.language?.slice(0, 2).toUpperCase() ?? "EN") as Lang;

  function choose(lang: Lang) {
    const lc = lang.toLowerCase();
    // Explicitly persist so the LanguageDetector reads the right value on
    // the next page load (belt-and-suspenders alongside the detector cache).
    try { localStorage.setItem("palonur_lang", lc); } catch { /* noop */ }
    void i18n.changeLanguage(lc);
  }

  return (
    <div
      role="group"
      aria-label="Language"
      style={{
        position: "fixed",
        bottom: 24,
        right: 20,
        zIndex: 9999,
        display: "flex",
        gap: 0,
        borderRadius: 999,
        overflow: "hidden",
        boxShadow: "0 2px 10px rgba(0,0,0,0.18)",
        border: "1px solid rgba(255,255,255,0.18)",
      }}
    >
      {LANGS.map((lang) => {
        const active = current === lang;
        return (
          <button
            key={lang}
            onClick={() => choose(lang)}
            aria-pressed={active}
            style={{
              background: active ? "rgba(255,255,255,0.92)" : "rgba(10,10,15,0.64)",
              color: active ? "#0A0A0F" : "rgba(255,255,255,0.82)",
              border: "none",
              padding: "6px 13px",
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: ".12em",
              cursor: active ? "default" : "pointer",
              fontFamily: "-apple-system, BlinkMacSystemFont, 'Inter', sans-serif",
              transition: "background .15s, color .15s",
              backdropFilter: "blur(8px)",
              WebkitBackdropFilter: "blur(8px)",
            }}
          >
            {lang}
          </button>
        );
      })}
    </div>
  );
}
