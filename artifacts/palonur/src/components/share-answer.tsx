/**
 * "Share this answer" — creates a durable answer permalink and copies it.
 *
 * Wording follows the 50+ plain-language rules: explicit instructions and a
 * clear confirmation. If the clipboard is unavailable (older browsers, no
 * permission), the link is shown in a text box the visitor can copy by hand.
 */
import { useState } from "react";

const BASE = import.meta.env.BASE_URL;
const SANS =
  "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif";

export function ShareAnswerButton({
  queryId,
  accent = "#B3261E",
}: {
  queryId: string;
  accent?: string;
}) {
  const [state, setState] = useState<
    "idle" | "working" | "copied" | "manual" | "error"
  >("idle");
  const [link, setLink] = useState<string | null>(null);

  async function share() {
    if (state === "working") return;
    setState("working");
    try {
      const res = await fetch(`${BASE}api/slm-answer-links`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify({ queryId }),
      });
      if (!res.ok) throw new Error("share failed");
      const d = (await res.json()) as { id?: string };
      if (!d.id) throw new Error("share failed");
      const url = `${window.location.origin}${BASE}a/${d.id}`;
      setLink(url);
      try {
        await navigator.clipboard.writeText(url);
        setState("copied");
      } catch {
        setState("manual");
      }
    } catch {
      setState("error");
    }
  }

  return (
    <div style={{ fontFamily: SANS }}>
      <button
        type="button"
        onClick={() => void share()}
        disabled={state === "working"}
        data-testid="button-share-answer"
        style={{
          background: "transparent",
          border: "1.5px solid rgba(10,10,15,0.15)",
          borderRadius: 999,
          padding: "10px 22px",
          fontFamily: SANS,
          fontSize: 14,
          fontWeight: 600,
          color: "#0A0A0F",
          cursor: state === "working" ? "default" : "pointer",
        }}
      >
        {state === "working" ? "Making your link…" : "Share this answer"}
      </button>

      {state === "copied" && (
        <p
          data-testid="text-share-confirm"
          style={{ margin: "10px 0 0", fontSize: 13.5, lineHeight: 1.5, color: "#1e6b34" }}
        >
          The link is copied. Paste it into an email or a text message to
          share this answer with someone.
        </p>
      )}

      {state === "manual" && link && (
        <div style={{ marginTop: 10 }}>
          <p style={{ margin: "0 0 6px", fontSize: 13.5, lineHeight: 1.5, color: "rgba(10,10,15,0.7)" }}>
            Here is your link. Select it and copy it to share this answer.
          </p>
          <input
            readOnly
            value={link}
            data-testid="input-share-link"
            onFocus={(e) => e.currentTarget.select()}
            style={{
              width: "100%",
              fontFamily: SANS,
              fontSize: 13,
              padding: "8px 12px",
              border: "1px solid rgba(10,10,15,0.15)",
              borderRadius: 8,
              color: "#0A0A0F",
              background: "#fff",
            }}
          />
        </div>
      )}

      {state === "error" && (
        <p
          data-testid="text-share-error"
          style={{ margin: "10px 0 0", fontSize: 13.5, lineHeight: 1.5, color: accent }}
        >
          We could not make the link right now. Please try again in a moment.
        </p>
      )}
    </div>
  );
}
