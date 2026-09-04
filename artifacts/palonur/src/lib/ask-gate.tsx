// ─── Ask gate ──────────────────────────────────────────────────────────────────
// Shared entry point for asking a question from any public surface.
// The default remains the Stanford Lifestyle Medicine-only experience
// (/slm?q=…). Palonur's general landing demo opts into the first-party
// all-pillar authority-router UI (/sleep?q=…) via { target: "sleep" }.
// The old early-access password modal is fully retired: the server enforces
// free-question limits and the paywall, so there is nothing to protect up
// front. `gate` is kept in the return shape (always null) so consumers'
// `{gate}` renders stay valid.

export const AUTH_KEY = "palonur_demo_authed";

export function isAuthed() {
  try { return sessionStorage.getItem(AUTH_KEY) === "1"; } catch { return false; }
}
export function setAuthed() {
  try { sessionStorage.setItem(AUTH_KEY, "1"); } catch {}
}

export function isRegistered() {
  // Two registration signals: the local journey profile (palonur_user_id)
  // and the auto-create claim flag set when an emailed magic link lands
  // (palonur_registered). Never write palonur_user_id from the claim path.
  try {
    return (
      !!localStorage.getItem("palonur_user_id") ||
      localStorage.getItem("palonur_registered") === "1"
    );
  } catch { return false; }
}

/**
 * useAskGate — returns `ask(question)` plus a (now always-null) gate element.
 * `ask` navigates straight to the agent: the ASLM surface (/slm) by default,
 * or Palonur's general authority-router UI when the caller passes
 * { target: "sleep" }. The default is intentionally unchanged for existing
 * consumers such as AskLifestyleMedicine.
 */
export function useAskGate(opts?: { target?: "slm" | "sleep" }) {
  const target = opts?.target ?? "slm";

  const ask = (t: string) => {
    if (!t) return;
    window.location.href = `${import.meta.env.BASE_URL}${target}?q=${encodeURIComponent(t)}`;
  };

  return { ask, gate: null as null };
}
