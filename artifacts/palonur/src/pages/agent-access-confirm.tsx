import { useEffect, useState } from "react";

const PAPER = "#FAF8F4";
const INK = "#1a0505";
const CARDINAL = "#8B1A1A";

type State =
  | { kind: "loading" }
  | { kind: "ok"; message: string }
  | { kind: "error"; message: string };

export default function AgentAccessConfirm() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    const prev = document.body.style.background;
    document.body.style.background = PAPER;
    document.title = "Confirming payment — Palonur";

    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session_id");
    if (params.get("payment") === "cancelled") {
      setState({ kind: "error", message: "Payment was cancelled. No changes were made." });
      return () => {
        document.body.style.background = prev;
      };
    }
    if (!sessionId) {
      setState({ kind: "error", message: "Missing checkout session. Please use the link from your email." });
      return () => {
        document.body.style.background = prev;
      };
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/partner-access/confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setState({
            kind: "error",
            message: data.error ?? "We couldn't confirm this payment.",
          });
          return;
        }
        setState({
          kind: "ok",
          message:
            data.kind === "subscription"
              ? "Your subscription is active. Your partner key now works for programmatic access."
              : data.alreadyApplied
                ? "This payment was already applied — your key is ready."
                : "Your request credits have been added. Your partner key is ready to use.",
        });
      } catch {
        if (!cancelled)
          setState({
            kind: "error",
            message: "Something went wrong confirming your payment. Please try again.",
          });
      }
    })();

    return () => {
      cancelled = true;
      document.body.style.background = prev;
    };
  }, []);

  return (
    <div
      style={{
        background: PAPER,
        minHeight: "100vh",
        color: INK,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        fontFamily: "ui-serif, Georgia, 'Times New Roman', serif",
      }}
    >
      <div
        style={{
          maxWidth: 460,
          textAlign: "center",
          background: "#fff",
          border: "1px solid #e8e0e0",
          borderRadius: 16,
          padding: "44px 36px",
        }}
      >
        <div
          style={{
            fontSize: 12,
            letterSpacing: ".18em",
            textTransform: "uppercase",
            color: CARDINAL,
            marginBottom: 16,
            fontFamily: "ui-sans-serif, system-ui, sans-serif",
          }}
        >
          Palonur · Partner Access
        </div>
        {state.kind === "loading" && (
          <div style={{ fontSize: 18, color: "#3a2020" }}>Confirming your payment…</div>
        )}
        {state.kind === "ok" && (
          <>
            <div style={{ fontSize: 26, fontWeight: 700, marginBottom: 12 }}>
              You're all set
            </div>
            <p style={{ fontSize: 16, lineHeight: 1.6, color: "#3a2020", margin: 0 }}>
              {state.message}
            </p>
          </>
        )}
        {state.kind === "error" && (
          <>
            <div style={{ fontSize: 26, fontWeight: 700, marginBottom: 12 }}>
              Hmm — that didn't work
            </div>
            <p style={{ fontSize: 16, lineHeight: 1.6, color: "#3a2020", margin: 0 }}>
              {state.message}
            </p>
          </>
        )}
        <div style={{ marginTop: 24 }}>
          <a
            href="/agent-license"
            style={{
              fontSize: 13,
              color: CARDINAL,
              fontFamily: "ui-sans-serif, system-ui, sans-serif",
            }}
          >
            Read the agent usage license →
          </a>
        </div>
      </div>
    </div>
  );
}
