import { useState } from "react";

/**
 * Consent-gated phone opt-in form for the consumer sleep surface.
 * Additive to the existing email capture — a separate affordance for leaving a
 * phone number and explicitly opting in to texts. Posts to the public
 * `/api/phone/subscribe` endpoint, tagging the correct `product`.
 *
 * Visual style is fully themeable via props so it blends into each surface
 * Styling is configurable. Consent is an explicit, REQUIRED
 * checkbox — the submit button stays disabled until the number is filled and
 * the box is ticked, and the server independently re-checks consent.
 */
export function PhoneCapture({
  product,
  source,
  accent,
  ink,
  muted,
  border,
  card = "#fff",
  sans,
  serif,
  heading = "Get a text instead",
  blurb = "Leave your number to hear from us by text. We'll send one note to confirm — nothing else until you say yes.",
  compact = false,
  collapsible = false,
}: {
  product: "nightly";
  source: string;
  accent: string;
  ink: string;
  muted: string;
  border: string;
  card?: string;
  sans: string;
  serif: string;
  heading?: string;
  blurb?: string;
  /** Tighter single-row layout for surfaces where the card felt too big. */
  compact?: boolean;
  /**
   * Collapsed-by-default mode: renders just a small themed pill button; the
   * full form card only appears when clicked. Once a submit succeeds the card
   * stays pinned open (no auto-collapse mid-flow).
   */
  collapsible?: boolean;
}) {
  const [open, setOpen] = useState(!collapsible);
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">(
    "idle",
  );
  const [pending, setPending] = useState(false);
  const [msg, setMsg] = useState("");

  const canSubmit =
    phone.trim().length >= 7 &&
    consent &&
    state !== "loading" &&
    state !== "done";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!consent) {
      setState("error");
      setMsg("Please tick the box to opt in to texts.");
      return;
    }
    if (!phone.trim()) return;
    setState("loading");
    setMsg("");
    try {
      const r = await fetch(`/api/phone/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Send the consumer cookie (when signed in) so the server links the
        // number to the account instead of capturing it anonymously.
        credentials: "include",
        body: JSON.stringify({
          phone: phone.trim(),
          product,
          consent: true,
          source,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setState("error");
        setMsg(d.error ?? "Something went wrong. Please try again.");
        return;
      }
      setState("done");
      setPending(Boolean(d.pending) && !d.alreadySubscribed);
      setMsg(
        d.alreadySubscribed
          ? "You're already on the list — thanks."
          : "Almost there — check your messages and reply YES to confirm. We won't text you anything else until you do.",
      );
    } catch {
      setState("error");
      setMsg("Network error. Please try again.");
    }
  }

  const inputStyle: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: compact ? "9px 12px" : "13px 15px",
    fontSize: compact ? 14 : 16,
    borderRadius: compact ? 10 : 12,
    border: `1.5px solid ${border}`,
    background: card,
    color: ink,
    fontFamily: sans,
  };

  const buttonEl = (
    <button
      type="submit"
      disabled={!canSubmit}
      style={{
        background:
          state === "done"
            ? "#2e7d32"
            : canSubmit
              ? accent
              : "rgba(10,10,15,0.18)",
        color: "#fff",
        border: "none",
        borderRadius: 999,
        padding: compact ? "9px 18px" : "13px 22px",
        fontSize: compact ? 13.5 : 15,
        fontWeight: 700,
        cursor: canSubmit ? "pointer" : "default",
        fontFamily: sans,
        justifySelf: "start",
        flexShrink: 0,
        whiteSpace: "nowrap",
        transition: "background .2s",
      }}
    >
      {state === "loading"
        ? "Sending…"
        : state === "done"
          ? pending
            ? "Check your messages ✉"
            : "Done ✓"
          : "Text me"}
    </button>
  );

  if (collapsible && !open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          background: "transparent",
          color: accent,
          border: `1.5px solid ${accent}`,
          borderRadius: 999,
          padding: "8px 18px",
          fontSize: 13.5,
          fontWeight: 600,
          cursor: "pointer",
          fontFamily: sans,
          whiteSpace: "nowrap",
        }}
      >
        {heading}
      </button>
    );
  }

  const body = (
    <div
      style={{ maxWidth: compact ? 520 : 440, fontFamily: sans, width: "100%" }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div
          style={{
            fontFamily: serif,
            fontSize: compact ? 17 : 22,
            fontWeight: 500,
            color: ink,
            margin: compact ? "0 0 4px" : "0 0 8px",
          }}
        >
          {heading}
        </div>
        {collapsible && state !== "loading" && state !== "done" && (
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            style={{
              background: "transparent",
              border: "none",
              color: muted,
              fontSize: 16,
              lineHeight: 1,
              cursor: "pointer",
              padding: "2px 4px",
              fontFamily: sans,
              flexShrink: 0,
            }}
          >
            ×
          </button>
        )}
      </div>
      <p
        style={{
          fontSize: compact ? 12.5 : 14,
          color: muted,
          lineHeight: compact ? 1.5 : 1.6,
          margin: compact ? "0 0 10px" : "0 0 16px",
        }}
      >
        {blurb}
      </p>
      <form
        onSubmit={submit}
        style={{ display: "grid", gap: compact ? 8 : 12 }}
      >
        {compact ? (
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="(415) 555-0123"
              disabled={state === "loading" || state === "done"}
              style={{ ...inputStyle, flex: 1, minWidth: 0 }}
            />
            {buttonEl}
          </div>
        ) : (
          <input
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="(415) 555-0123"
            disabled={state === "loading" || state === "done"}
            style={inputStyle}
          />
        )}
        <label
          style={{
            display: "flex",
            gap: compact ? 8 : 10,
            alignItems: "flex-start",
            fontSize: compact ? 11.5 : 13.5,
            color: muted,
            lineHeight: 1.5,
          }}
        >
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            disabled={state === "loading" || state === "done"}
            style={{ marginTop: compact ? 2 : 3 }}
          />
          <span>
            I agree to receive text messages from Palonur at this number.
            Message and data rates may apply. Reply STOP to opt out at any time.
          </span>
        </label>
        {!compact && buttonEl}
        {msg && (
          <p
            style={{
              fontSize: compact ? 12.5 : 14,
              color: state === "error" ? "#b91c1c" : "#2e7d32",
              margin: "2px 0 0",
              lineHeight: 1.5,
            }}
          >
            {msg}
          </p>
        )}
      </form>
    </div>
  );

  if (!collapsible) return body;

  return (
    <div
      style={{
        background: card,
        border: `1px solid ${border}`,
        borderRadius: 14,
        padding: compact ? "14px 16px" : "18px 20px",
        width: "100%",
        maxWidth: compact ? 560 : 480,
        boxSizing: "border-box",
        animation: "phoneCaptureIn .18s ease-out",
      }}
    >
      <style>{`@keyframes phoneCaptureIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }`}</style>
      {body}
    </div>
  );
}
