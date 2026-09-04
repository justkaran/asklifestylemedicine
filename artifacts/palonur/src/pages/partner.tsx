import { useCallback, useEffect, useState } from "react";

const INK = "#0A0A0F";
const CARDINAL = "#8B1A1A";
const PAPER = "#FAF8F4";
const RULE = "rgba(10,10,15,0.12)";
const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "-apple-system, BlinkMacSystemFont, 'Inter', sans-serif";

type KeySummary = {
  keyPrefix: string;
  billingMode: "subscription" | "credits" | string | null;
  requiresPayment: boolean;
  subscriptionActive: boolean | null;
  creditsRemaining: number | null;
} | null;

type Portal = {
  account: {
    email: string;
    companyName: string | null;
    contactName: string | null;
    status: string;
  };
  key: KeySummary;
  billing: {
    stripeReady: boolean;
    subscription: boolean;
    credits: boolean;
    creditsPerPurchase: number;
  };
  mcp: { url: string; agentUrl: string; keyHeader: string };
};

const BASE = import.meta.env.BASE_URL;

export default function Partner() {
  const [portal, setPortal] = useState<Portal | null>(null);
  const [loading, setLoading] = useState(true);
  const [authed, setAuthed] = useState(true);
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/partner/portal", { credentials: "include" });
      if (r.status === 401) {
        setAuthed(false);
        setLoading(false);
        return;
      }
      if (!r.ok) {
        setError("Could not load your portal.");
        setLoading(false);
        return;
      }
      const d = (await r.json()) as Portal;
      setPortal(d);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    document.title = "Partner portal · Palonur";
    document.body.style.background = PAPER;
    return () => {
      document.body.style.background = "";
    };
  }, []);

  // Handle Stripe return: confirm the session, then clean the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session_id");
    const cancelled = params.get("payment");
    if (cancelled === "cancelled") {
      setBanner("Payment was cancelled — no charge was made.");
      window.history.replaceState({}, "", `${BASE}partner`);
      load();
      return;
    }
    if (sessionId) {
      fetch("/api/partner-access/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ sessionId }),
      })
        .then(async (r) => {
          if (r.ok) setBanner("Payment confirmed — your access is active.");
          else setBanner("We're still confirming your payment. Refresh in a moment.");
        })
        .catch(() => setBanner("We're still confirming your payment."))
        .finally(() => {
          window.history.replaceState({}, "", `${BASE}partner`);
          load();
        });
      return;
    }
    load();
  }, [load]);

  async function logout() {
    await fetch("/api/partner-auth/logout", {
      method: "POST",
      credentials: "include",
    }).catch(() => {});
    window.location.href = `${BASE}partner-login`;
  }

  async function checkout(mode: "subscription" | "credits") {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/partner/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ mode }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.url) {
        setError(d.error ?? "Could not start checkout.");
        setBusy(false);
        return;
      }
      window.location.href = d.url;
    } catch {
      setError("Could not start checkout.");
      setBusy(false);
    }
  }

  async function generateKey() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/partner/key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({}),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.rawKey) {
        setError(d.error ?? "Could not generate a key.");
        setBusy(false);
        return;
      }
      setRawKey(d.rawKey);
      await load();
    } catch {
      setError("Could not generate a key.");
    } finally {
      setBusy(false);
    }
  }

  if (!authed) {
    return (
      <Shell>
        <h1 style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 30, margin: "0 0 12px" }}>
          Please sign in.
        </h1>
        <p style={{ color: "#4a4a50", lineHeight: 1.6 }}>
          Your session has expired.{" "}
          <a href={`${BASE}partner-login`} style={{ color: CARDINAL }}>
            Sign in again
          </a>
          .
        </p>
      </Shell>
    );
  }

  if (loading) {
    return (
      <Shell>
        <p style={{ color: "#8a8a90" }}>Loading…</p>
      </Shell>
    );
  }

  if (!portal) {
    return (
      <Shell>
        <p style={{ color: "#b3261e" }}>{error ?? "Something went wrong."}</p>
      </Shell>
    );
  }

  const { account, key, billing, mcp } = portal;
  const status = account.status;

  return (
    <Shell onLogout={logout}>
      {banner && (
        <div
          style={{
            background: "#eef7ee",
            border: "1px solid #cfe6cf",
            color: "#2f5d2f",
            borderRadius: 12,
            padding: "12px 16px",
            marginBottom: 24,
            fontSize: 14,
          }}
        >
          {banner}
        </div>
      )}

      <div
        style={{
          fontSize: 11,
          letterSpacing: ".16em",
          textTransform: "uppercase",
          color: "#8a6a4a",
          fontWeight: 700,
          marginBottom: 8,
        }}
      >
        Partner portal
      </div>
      <h1 style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 32, margin: "0 0 6px" }}>
        {account.companyName || account.email}
      </h1>
      <div style={{ color: "#8a8a90", fontSize: 14, marginBottom: 28 }}>
        {account.email} · <StatusPill status={status} />
      </div>

      {error && (
        <div style={{ color: "#b3261e", fontSize: 14, marginBottom: 16 }}>{error}</div>
      )}

      {status === "requested" && (
        <Card>
          <h2 style={cardTitle}>Your request is under review</h2>
          <p style={cardBody}>
            Thanks for requesting agent access. We review each partner by hand to
            scope the corpus, rate limits, and citation guarantees to your use
            case. You'll get an email the moment you're approved — then you can
            set up payment and generate your key right here.
          </p>
        </Card>
      )}

      {status === "rejected" && (
        <Card>
          <h2 style={cardTitle}>Request not approved</h2>
          <p style={cardBody}>
            We weren't able to approve this request. If you think this is a
            mistake, reply to our email and we'll take another look.
          </p>
        </Card>
      )}

      {status === "suspended" && (
        <Card>
          <h2 style={cardTitle}>Account suspended</h2>
          <p style={cardBody}>
            This partner account is currently suspended. Please reach out to us
            to restore access.
          </p>
        </Card>
      )}

      {(status === "approved" || status === "active") && (
        <>
          {/* Billing / payment */}
          {!key?.requiresPayment || !paymentSatisfied(key) ? (
            <Card>
              <h2 style={cardTitle}>Set up billing</h2>
              <p style={cardBody}>
                You're approved. Choose how you'd like to pay, then generate your
                partner key. No further approval needed.
              </p>
              {!billing.stripeReady ? (
                <p style={{ ...cardBody, color: "#b3261e" }}>
                  Self-serve checkout is temporarily unavailable. Please reach
                  out and we'll get you set up.
                </p>
              ) : (
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 16 }}>
                  {billing.subscription && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => checkout("subscription")}
                      style={primaryBtn}
                    >
                      Subscribe monthly →
                    </button>
                  )}
                  {billing.credits && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => checkout("credits")}
                      style={secondaryBtn}
                    >
                      Buy {billing.creditsPerPurchase.toLocaleString()} credits →
                    </button>
                  )}
                </div>
              )}
            </Card>
          ) : (
            <Card>
              <h2 style={cardTitle}>Billing active</h2>
              <p style={cardBody}>
                {key?.billingMode === "subscription"
                  ? "Your subscription is active."
                  : key?.creditsRemaining != null
                    ? `${key.creditsRemaining.toLocaleString()} credits remaining.`
                    : "Your access is active."}
              </p>
              {billing.stripeReady && key?.billingMode === "credits" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => checkout("credits")}
                  style={{ ...secondaryBtn, marginTop: 14 }}
                >
                  Buy more credits →
                </button>
              )}
            </Card>
          )}

          {/* API key */}
          <Card>
            <h2 style={cardTitle}>Your partner key</h2>
            {rawKey ? (
              <>
                <p style={cardBody}>
                  Copy this now — for your security we only show it once.
                </p>
                <code style={keyBox}>{rawKey}</code>
              </>
            ) : key ? (
              <>
                <p style={cardBody}>
                  Your key is active (<code>{key.keyPrefix}…</code>). For security
                  the full key is only shown at creation. You can rotate it below
                  — the old key stops working immediately.
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={generateKey}
                  style={{ ...secondaryBtn, marginTop: 14 }}
                >
                  Rotate key →
                </button>
              </>
            ) : (
              <>
                <p style={cardBody}>
                  Generate your partner key to start calling the API. We show it
                  once — store it somewhere safe.
                </p>
                <button
                  type="button"
                  disabled={busy || (key === null && !paymentSatisfiedOrPending(portal))}
                  onClick={generateKey}
                  style={{ ...primaryBtn, marginTop: 14 }}
                >
                  Generate key →
                </button>
              </>
            )}
          </Card>

          {/* MCP / quickstart */}
          <Card>
            <h2 style={cardTitle}>Connect your agent</h2>
            <p style={cardBody}>
              Send your key in the <code>{mcp.keyHeader}</code> header. Two ways
              to connect:
            </p>
            <div style={{ marginTop: 12 }}>
              <div style={quickLabel}>MCP server</div>
              <code style={urlBox}>{mcp.url}</code>
            </div>
            <div style={{ marginTop: 14 }}>
              <div style={quickLabel}>Streaming answer endpoint</div>
              <code style={urlBox}>{mcp.agentUrl}</code>
            </div>
            <pre style={codeBlock}>
{`curl -N ${mcp.agentUrl} \\
  -H "${mcp.keyHeader}: <your-key>" \\
  -H "Content-Type: application/json" \\
  -d '{"message":"How does light affect sleep?"}'`}
            </pre>
            <a
              href={`${BASE}agent-license`}
              style={{ color: CARDINAL, fontSize: 13.5, fontWeight: 600 }}
            >
              Read the agent license →
            </a>
          </Card>
        </>
      )}
    </Shell>
  );
}

function paymentSatisfied(key: NonNullable<KeySummary>): boolean {
  if (!key.requiresPayment) return true;
  if (key.billingMode === "subscription") return key.subscriptionActive === true;
  if (key.billingMode === "credits")
    return (key.creditsRemaining ?? 0) > 0;
  return false;
}

function paymentSatisfiedOrPending(portal: Portal): boolean {
  return !!portal.key && paymentSatisfied(portal.key);
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    requested: { bg: "#fff4e0", fg: "#8a6a1a", label: "Under review" },
    approved: { bg: "#e8f0ff", fg: "#1a4a8a", label: "Approved" },
    active: { bg: "#eef7ee", fg: "#2f5d2f", label: "Active" },
    rejected: { bg: "#fdeaea", fg: "#b3261e", label: "Not approved" },
    suspended: { bg: "#f3f3f3", fg: "#6a6a6a", label: "Suspended" },
  };
  const s = map[status] ?? { bg: "#f3f3f3", fg: "#6a6a6a", label: status };
  return (
    <span
      style={{
        display: "inline-block",
        background: s.bg,
        color: s.fg,
        borderRadius: 999,
        padding: "2px 10px",
        fontSize: 12,
        fontWeight: 700,
      }}
    >
      {s.label}
    </span>
  );
}

function Shell({
  children,
  onLogout,
}: {
  children: React.ReactNode;
  onLogout?: () => void;
}) {
  return (
    <div style={{ minHeight: "100vh", background: PAPER, fontFamily: SANS, color: INK }}>
      <div
        style={{
          maxWidth: 720,
          margin: "0 auto",
          padding: "40px 24px 96px",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 40,
          }}
        >
          <a
            href={import.meta.env.BASE_URL}
            style={{ textDecoration: "none", color: INK, fontWeight: 700, fontSize: 18 }}
          >
            Palonur
          </a>
          {onLogout && (
            <button
              type="button"
              onClick={onLogout}
              style={{
                background: "transparent",
                border: `1px solid ${RULE}`,
                borderRadius: 999,
                padding: "8px 16px",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                color: "#4a4a50",
              }}
            >
              Sign out
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

const cardTitle: React.CSSProperties = {
  fontFamily: SERIF,
  fontWeight: 400,
  fontSize: 22,
  margin: "0 0 10px",
};
const cardBody: React.CSSProperties = {
  fontSize: 15,
  lineHeight: 1.6,
  color: "#4a4a50",
  margin: 0,
};
function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: "#fff",
        border: `1px solid ${RULE}`,
        borderRadius: 18,
        padding: "26px 24px",
        marginBottom: 18,
        boxShadow: "0 8px 24px rgba(10,10,15,0.05)",
      }}
    >
      {children}
    </div>
  );
}

const primaryBtn: React.CSSProperties = {
  background: CARDINAL,
  color: "#fff",
  border: "none",
  borderRadius: 999,
  padding: "13px 24px",
  fontSize: 14.5,
  fontWeight: 700,
  cursor: "pointer",
  fontFamily: SANS,
};
const secondaryBtn: React.CSSProperties = {
  background: "transparent",
  color: INK,
  border: `1.5px solid ${INK}`,
  borderRadius: 999,
  padding: "13px 24px",
  fontSize: 14.5,
  fontWeight: 700,
  cursor: "pointer",
  fontFamily: SANS,
};
const keyBox: React.CSSProperties = {
  display: "block",
  marginTop: 12,
  background: INK,
  color: "#7CFFB2",
  borderRadius: 12,
  padding: "14px 16px",
  fontSize: 14,
  wordBreak: "break-all",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};
const urlBox: React.CSSProperties = {
  display: "block",
  marginTop: 4,
  background: "#f5f2ec",
  borderRadius: 10,
  padding: "10px 14px",
  fontSize: 13.5,
  wordBreak: "break-all",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  color: INK,
};
const quickLabel: React.CSSProperties = {
  fontSize: 11,
  letterSpacing: ".12em",
  textTransform: "uppercase",
  color: "#8a8a90",
  fontWeight: 700,
};
const codeBlock: React.CSSProperties = {
  marginTop: 16,
  background: INK,
  color: "#e8e8ec",
  borderRadius: 12,
  padding: "16px 18px",
  fontSize: 12.5,
  lineHeight: 1.6,
  overflowX: "auto",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};
