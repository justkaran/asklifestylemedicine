import { useState, useEffect, useCallback } from "react";

const API_BASE = "/api";

const CARDINAL = "#8B1A1A";
const BORDER = "#e8e0e0";

interface PartnerKey {
  id: number;
  keyPrefix: string;
  partnerName: string;
  contactEmail: string | null;
  scopes: string[];
  tier: string;
  ratePerMinute: number;
  ratePerDay: number;
  concurrentStreams: number;
  notes: string | null;
  origin: string;
  requiresPayment: boolean;
  billingMode: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  creditsTotal: number | null;
  creditsUsed: number;
  creditsRemaining: number | null;
  createdAt: string;
  revokedAt: string | null;
  queryCount: number;
  lastUsed: string | null;
  active: boolean;
  subscriptionActive: boolean | null;
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  border: `1px solid ${BORDER}`,
  borderRadius: 8,
  fontSize: 13,
  boxSizing: "border-box",
};
const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "#8a6a5a",
  textTransform: "uppercase",
  letterSpacing: ".05em",
  marginBottom: 4,
  display: "block",
};
const btnPrimary: React.CSSProperties = {
  background: CARDINAL,
  color: "#fff",
  border: "none",
  borderRadius: 8,
  padding: "9px 16px",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};
const btnGhost: React.CSSProperties = {
  background: "transparent",
  color: "#572020",
  border: `1px solid ${BORDER}`,
  borderRadius: 8,
  padding: "7px 12px",
  fontSize: 12,
  cursor: "pointer",
};

function fmtDate(s: string | null): string {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return s;
  }
}

function paymentLabel(k: PartnerKey): { text: string; color: string } {
  if (!k.requiresPayment)
    return { text: "Granted (no payment)", color: "#3a7d44" };
  if (k.billingMode === "subscription") {
    if (k.subscriptionActive === true)
      return { text: "Subscription · active", color: "#3a7d44" };
    if (k.subscriptionActive === false)
      return { text: "Subscription · inactive", color: "#b3261e" };
    return { text: "Subscription · pending", color: "#9a6a00" };
  }
  if (k.billingMode === "credits") {
    const rem = k.creditsRemaining ?? 0;
    return {
      text: `Credits · ${rem} left`,
      color: rem > 0 ? "#3a7d44" : "#b3261e",
    };
  }
  return { text: "Payment required", color: "#9a6a00" };
}

export default function AgentAccessPanel() {
  const [keys, setKeys] = useState<PartnerKey[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showGrant, setShowGrant] = useState(false);
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [payingId, setPayingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/partner-access`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Could not load partner keys");
      const data = await res.json();
      setKeys(Array.isArray(data.keys) ? data.keys : []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(id: number) {
    if (
      !window.confirm("Revoke this key? Programmatic access stops immediately.")
    )
      return;
    await fetch(`${API_BASE}/partner-access/${id}/revoke`, {
      method: "POST",
      credentials: "include",
    });
    void load();
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          marginBottom: 18,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 20,
              fontWeight: 700,
              color: "#1a0505",
              marginBottom: 4,
            }}
          >
            Agent Access
          </div>
          <div style={{ fontSize: 13, color: "#888", maxWidth: 620 }}>
            Partner API keys for programmatic / external-agent access to the
            Palonur agent surfaces. Admin grants always work immediately;
            payment (a Stripe link for one-time credits or a monthly
            subscription) is secondary and only enforced when a key{" "}
            <em>requires payment</em>. Every keyed answer carries a no-training
            usage license (
            <a href="/agent-license" style={{ color: CARDINAL }}>
              terms
            </a>
            ).
          </div>
        </div>
        <button style={btnPrimary} onClick={() => setShowGrant((v) => !v)}>
          {showGrant ? "Close" : "+ Grant key"}
        </button>
      </div>

      {rawKey && (
        <div
          style={{
            background: "#fff8e6",
            border: "1px solid #e8d28a",
            borderRadius: 10,
            padding: "14px 16px",
            marginBottom: 16,
          }}
        >
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: "#7a5a00",
              marginBottom: 6,
            }}
          >
            Copy this key now — it is shown only once.
          </div>
          <code
            style={{
              display: "block",
              fontSize: 13,
              wordBreak: "break-all",
              background: "#fff",
              border: `1px solid ${BORDER}`,
              borderRadius: 6,
              padding: "8px 10px",
            }}
          >
            {rawKey}
          </code>
          <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
            <button
              style={btnGhost}
              onClick={() => navigator.clipboard?.writeText(rawKey)}
            >
              Copy
            </button>
            <button style={btnGhost} onClick={() => setRawKey(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {showGrant && (
        <GrantForm
          onGranted={(raw) => {
            setRawKey(raw);
            setShowGrant(false);
            void load();
          }}
        />
      )}

      <PendingRequests />

      {error && (
        <div style={{ color: "#b3261e", fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {loading && !keys ? (
        <div style={{ color: "#888", fontSize: 13 }}>Loading…</div>
      ) : keys && keys.length === 0 ? (
        <div style={{ color: "#888", fontSize: 13 }}>No partner keys yet.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table
            style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}
          >
            <thead>
              <tr style={{ textAlign: "left", color: "#8a6a5a", fontSize: 11 }}>
                <th style={{ padding: "8px 8px" }}>Partner</th>
                <th style={{ padding: "8px 8px" }}>Key</th>
                <th style={{ padding: "8px 8px" }}>Scopes</th>
                <th style={{ padding: "8px 8px" }}>Payment</th>
                <th style={{ padding: "8px 8px" }}>Usage</th>
                <th style={{ padding: "8px 8px" }}>Status</th>
                <th style={{ padding: "8px 8px" }}></th>
              </tr>
            </thead>
            <tbody>
              {keys?.map((k) => {
                const pay = paymentLabel(k);
                return (
                  <>
                    <tr key={k.id} style={{ borderTop: `1px solid ${BORDER}` }}>
                      <td style={{ padding: "10px 8px", verticalAlign: "top" }}>
                        <div style={{ fontWeight: 600, color: "#1a0505" }}>
                          {k.partnerName}
                        </div>
                        <div style={{ fontSize: 11, color: "#999" }}>
                          {k.contactEmail ?? "—"} · {k.tier}
                        </div>
                      </td>
                      <td
                        style={{
                          padding: "10px 8px",
                          verticalAlign: "top",
                          fontFamily: "monospace",
                          fontSize: 11,
                          color: "#666",
                        }}
                      >
                        {k.keyPrefix}…
                      </td>
                      <td
                        style={{
                          padding: "10px 8px",
                          verticalAlign: "top",
                          fontSize: 11,
                        }}
                      >
                        {k.scopes.join(", ")}
                      </td>
                      <td style={{ padding: "10px 8px", verticalAlign: "top" }}>
                        <span
                          style={{
                            color: pay.color,
                            fontWeight: 600,
                            fontSize: 12,
                          }}
                        >
                          {pay.text}
                        </span>
                      </td>
                      <td
                        style={{
                          padding: "10px 8px",
                          verticalAlign: "top",
                          fontSize: 12,
                        }}
                      >
                        {k.queryCount} reqs
                        <div style={{ fontSize: 11, color: "#999" }}>
                          last {fmtDate(k.lastUsed)}
                        </div>
                      </td>
                      <td style={{ padding: "10px 8px", verticalAlign: "top" }}>
                        {k.active ? (
                          <span
                            style={{
                              color: "#3a7d44",
                              fontWeight: 600,
                              fontSize: 12,
                            }}
                          >
                            active
                          </span>
                        ) : (
                          <span
                            style={{
                              color: "#b3261e",
                              fontWeight: 600,
                              fontSize: 12,
                            }}
                          >
                            revoked
                          </span>
                        )}
                      </td>
                      <td
                        style={{
                          padding: "10px 8px",
                          verticalAlign: "top",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <button
                          style={{ ...btnGhost, marginRight: 6 }}
                          onClick={() =>
                            setEditingId(editingId === k.id ? null : k.id)
                          }
                        >
                          Edit
                        </button>
                        <button
                          style={{ ...btnGhost, marginRight: 6 }}
                          onClick={() =>
                            setPayingId(payingId === k.id ? null : k.id)
                          }
                        >
                          Payment link
                        </button>
                        {k.active && (
                          <button
                            style={{
                              ...btnGhost,
                              color: "#b3261e",
                              borderColor: "#e6b3ae",
                            }}
                            onClick={() => revoke(k.id)}
                          >
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                    {editingId === k.id && (
                      <tr>
                        <td
                          colSpan={7}
                          style={{
                            padding: "0 8px 14px",
                            background: "#faf7f2",
                          }}
                        >
                          <EditForm
                            k={k}
                            onSaved={() => {
                              setEditingId(null);
                              void load();
                            }}
                          />
                        </td>
                      </tr>
                    )}
                    {payingId === k.id && (
                      <tr>
                        <td
                          colSpan={7}
                          style={{
                            padding: "0 8px 14px",
                            background: "#f4f8fb",
                          }}
                        >
                          <PaymentLinkForm k={k} />
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function GrantForm({ onGranted }: { onGranted: (rawKey: string) => void }) {
  const [partnerName, setPartnerName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [scopes, setScopes] = useState("sleep-agent");
  const [tier, setTier] = useState("pilot");
  const [requiresPayment, setRequiresPayment] = useState(false);
  const [billingMode, setBillingMode] = useState("none");
  const [creditsTotal, setCreditsTotal] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!partnerName.trim()) {
      setErr("Partner name is required");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        partnerName: partnerName.trim(),
        scopes: scopes
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        tier,
        requiresPayment,
        billingMode: requiresPayment ? billingMode : "none",
      };
      if (contactEmail.trim()) body.contactEmail = contactEmail.trim();
      if (notes.trim()) body.notes = notes.trim();
      if (requiresPayment && billingMode === "credits" && creditsTotal.trim())
        body.creditsTotal = Number(creditsTotal);

      const res = await fetch(`${API_BASE}/partner-access`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not grant key");
      onGranted(data.rawKey);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        background: "#fff",
        border: `1px solid ${BORDER}`,
        borderRadius: 12,
        padding: 18,
        marginBottom: 18,
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <label style={labelStyle}>Partner name *</label>
          <input
            style={inputStyle}
            value={partnerName}
            onChange={(e) => setPartnerName(e.target.value)}
            placeholder="Acme Health"
          />
        </div>
        <div>
          <label style={labelStyle}>Contact email</label>
          <input
            style={inputStyle}
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            placeholder="pm@acme.com"
          />
        </div>
        <div>
          <label style={labelStyle}>Scopes (comma-separated)</label>
          <input
            style={inputStyle}
            value={scopes}
            onChange={(e) => setScopes(e.target.value)}
            placeholder="sleep-agent, embed-agent"
          />
        </div>
        <div>
          <label style={labelStyle}>Tier</label>
          <select
            style={inputStyle}
            value={tier}
            onChange={(e) => setTier(e.target.value)}
          >
            <option value="pilot">pilot</option>
            <option value="production">production</option>
          </select>
        </div>
      </div>

      <div
        style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 8 }}
      >
        <input
          type="checkbox"
          id="reqpay"
          checked={requiresPayment}
          onChange={(e) => setRequiresPayment(e.target.checked)}
        />
        <label htmlFor="reqpay" style={{ fontSize: 13, color: "#572020" }}>
          Require active payment for this key to work
        </label>
      </div>

      {requiresPayment && (
        <div
          style={{
            marginTop: 12,
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 12,
          }}
        >
          <div>
            <label style={labelStyle}>Billing mode</label>
            <select
              style={inputStyle}
              value={billingMode}
              onChange={(e) => setBillingMode(e.target.value)}
            >
              <option value="subscription">monthly subscription</option>
              <option value="credits">one-time credits</option>
            </select>
          </div>
          {billingMode === "credits" && (
            <div>
              <label style={labelStyle}>Initial credits (optional)</label>
              <input
                style={inputStyle}
                value={creditsTotal}
                onChange={(e) => setCreditsTotal(e.target.value)}
                placeholder="0 — top up via payment link"
                inputMode="numeric"
              />
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <label style={labelStyle}>Notes</label>
        <input
          style={inputStyle}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="alpha pilot, sleep only"
        />
      </div>

      {err && (
        <div style={{ color: "#b3261e", fontSize: 12, marginTop: 10 }}>
          {err}
        </div>
      )}
      <div style={{ marginTop: 14 }}>
        <button style={btnPrimary} onClick={submit} disabled={busy}>
          {busy ? "Granting…" : "Grant key"}
        </button>
      </div>
    </div>
  );
}

function EditForm({ k, onSaved }: { k: PartnerKey; onSaved: () => void }) {
  const [scopes, setScopes] = useState(k.scopes.join(", "));
  const [tier, setTier] = useState(k.tier);
  const [ratePerMinute, setRatePerMinute] = useState(String(k.ratePerMinute));
  const [ratePerDay, setRatePerDay] = useState(String(k.ratePerDay));
  const [concurrentStreams, setConcurrentStreams] = useState(
    String(k.concurrentStreams),
  );
  const [requiresPayment, setRequiresPayment] = useState(k.requiresPayment);
  const [billingMode, setBillingMode] = useState(k.billingMode);
  const [creditsTotal, setCreditsTotal] = useState(
    k.creditsTotal == null ? "" : String(k.creditsTotal),
  );
  const [notes, setNotes] = useState(k.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        scopes: scopes
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        tier,
        ratePerMinute: Number(ratePerMinute),
        ratePerDay: Number(ratePerDay),
        concurrentStreams: Number(concurrentStreams),
        requiresPayment,
        billingMode: requiresPayment ? billingMode : "none",
        notes: notes.trim() ? notes.trim() : null,
      };
      if (creditsTotal.trim()) body.creditsTotal = Number(creditsTotal);
      const res = await fetch(`${API_BASE}/partner-access/${k.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save");
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: "14px 0" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 12,
        }}
      >
        <div style={{ gridColumn: "span 3" }}>
          <label style={labelStyle}>Scopes</label>
          <input
            style={inputStyle}
            value={scopes}
            onChange={(e) => setScopes(e.target.value)}
          />
        </div>
        <div>
          <label style={labelStyle}>Tier</label>
          <select
            style={inputStyle}
            value={tier}
            onChange={(e) => setTier(e.target.value)}
          >
            <option value="pilot">pilot</option>
            <option value="production">production</option>
          </select>
        </div>
        <div>
          <label style={labelStyle}>Rate / min</label>
          <input
            style={inputStyle}
            value={ratePerMinute}
            onChange={(e) => setRatePerMinute(e.target.value)}
            inputMode="numeric"
          />
        </div>
        <div>
          <label style={labelStyle}>Rate / day</label>
          <input
            style={inputStyle}
            value={ratePerDay}
            onChange={(e) => setRatePerDay(e.target.value)}
            inputMode="numeric"
          />
        </div>
        <div>
          <label style={labelStyle}>Concurrent</label>
          <input
            style={inputStyle}
            value={concurrentStreams}
            onChange={(e) => setConcurrentStreams(e.target.value)}
            inputMode="numeric"
          />
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 18,
          }}
        >
          <input
            type="checkbox"
            id={`reqpay-${k.id}`}
            checked={requiresPayment}
            onChange={(e) => setRequiresPayment(e.target.checked)}
          />
          <label
            htmlFor={`reqpay-${k.id}`}
            style={{ fontSize: 12, color: "#572020" }}
          >
            Require payment
          </label>
        </div>
        {requiresPayment && (
          <div>
            <label style={labelStyle}>Billing mode</label>
            <select
              style={inputStyle}
              value={billingMode}
              onChange={(e) => setBillingMode(e.target.value)}
            >
              <option value="subscription">subscription</option>
              <option value="credits">credits</option>
            </select>
          </div>
        )}
      </div>
      {requiresPayment && billingMode === "credits" && (
        <div style={{ marginTop: 12, maxWidth: 220 }}>
          <label style={labelStyle}>Credits total</label>
          <input
            style={inputStyle}
            value={creditsTotal}
            onChange={(e) => setCreditsTotal(e.target.value)}
            inputMode="numeric"
          />
          <div style={{ fontSize: 11, color: "#999", marginTop: 4 }}>
            Used so far: {k.creditsUsed}
          </div>
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <label style={labelStyle}>Notes</label>
        <input
          style={inputStyle}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>
      {err && (
        <div style={{ color: "#b3261e", fontSize: 12, marginTop: 10 }}>
          {err}
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <button style={btnPrimary} onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
  );
}

function PaymentLinkForm({ k }: { k: PartnerKey }) {
  const [mode, setMode] = useState<"subscription" | "credits">(
    k.billingMode === "credits" ? "credits" : "subscription",
  );
  const [priceId, setPriceId] = useState("");
  const [creditsToAdd, setCreditsToAdd] = useState("");
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    if (!priceId.trim()) {
      setErr("A Stripe price ID is required");
      return;
    }
    if (mode === "credits" && !creditsToAdd.trim()) {
      setErr("Credits to add is required");
      return;
    }
    setBusy(true);
    setErr(null);
    setUrl(null);
    try {
      const body: Record<string, unknown> = { mode, priceId: priceId.trim() };
      if (mode === "credits") body.creditsToAdd = Number(creditsToAdd);
      const res = await fetch(
        `${API_BASE}/partner-access/${k.id}/payment-link`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not create link");
      setUrl(data.url);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: "14px 0" }}>
      <div
        style={{ fontSize: 12, color: "#666", marginBottom: 10, maxWidth: 620 }}
      >
        Generate a Stripe Checkout link to send to {k.partnerName}. A
        subscription link gates the key on an active monthly subscription; a
        credits link adds one-time request credits when paid. The partner is
        prompted to confirm after paying — no action needed here beyond sending
        the link.
      </div>
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "flex-end",
          flexWrap: "wrap",
        }}
      >
        <div>
          <label style={labelStyle}>Mode</label>
          <select
            style={{ ...inputStyle, width: 200 }}
            value={mode}
            onChange={(e) =>
              setMode(e.target.value as "subscription" | "credits")
            }
          >
            <option value="subscription">monthly subscription</option>
            <option value="credits">one-time credits</option>
          </select>
        </div>
        <div>
          <label style={labelStyle}>Stripe price ID</label>
          <input
            style={{ ...inputStyle, width: 260 }}
            value={priceId}
            onChange={(e) => setPriceId(e.target.value)}
            placeholder="price_…"
          />
        </div>
        {mode === "credits" && (
          <div>
            <label style={labelStyle}>Credits to add</label>
            <input
              style={{ ...inputStyle, width: 160 }}
              value={creditsToAdd}
              onChange={(e) => setCreditsToAdd(e.target.value)}
              inputMode="numeric"
              placeholder="1000"
            />
          </div>
        )}
        <button style={btnPrimary} onClick={create} disabled={busy}>
          {busy ? "Creating…" : "Create link"}
        </button>
      </div>
      {err && (
        <div style={{ color: "#b3261e", fontSize: 12, marginTop: 10 }}>
          {err}
        </div>
      )}
      {url && (
        <div style={{ marginTop: 12 }}>
          <code
            style={{
              display: "block",
              fontSize: 12,
              wordBreak: "break-all",
              background: "#fff",
              border: `1px solid ${BORDER}`,
              borderRadius: 6,
              padding: "8px 10px",
            }}
          >
            {url}
          </code>
          <button
            style={{ ...btnGhost, marginTop: 8 }}
            onClick={() => navigator.clipboard?.writeText(url)}
          >
            Copy link
          </button>
        </div>
      )}
    </div>
  );
}

interface PartnerAccount {
  id: number;
  email: string;
  companyName: string;
  contactName: string;
  intendedUse: string | null;
  status: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  hasKey: boolean;
}

function accountStatusStyle(status: string): { text: string; color: string } {
  switch (status) {
    case "requested":
      return { text: "Under review", color: "#9a6a00" };
    case "approved":
      return { text: "Approved", color: "#1a4a8a" };
    case "active":
      return { text: "Active", color: "#3a7d44" };
    case "rejected":
      return { text: "Rejected", color: "#b3261e" };
    case "suspended":
      return { text: "Suspended", color: "#888" };
    default:
      return { text: status, color: "#888" };
  }
}

function PendingRequests() {
  const [accounts, setAccounts] = useState<PartnerAccount[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(`${API_BASE}/partner-access/accounts`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Could not load partner requests");
      const data = await res.json();
      setAccounts(Array.isArray(data.accounts) ? data.accounts : []);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function approve(id: number) {
    setBusyId(id);
    try {
      await fetch(`${API_BASE}/partner-access/accounts/${id}/approve`, {
        method: "POST",
        credentials: "include",
      });
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function reject(id: number) {
    if (
      !window.confirm("Reject this request? The partner will not get access.")
    )
      return;
    setBusyId(id);
    try {
      const notes =
        window.prompt("Optional note (visible to admins only):") ?? undefined;
      await fetch(`${API_BASE}/partner-access/accounts/${id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(notes ? { notes } : {}),
      });
      await load();
    } finally {
      setBusyId(null);
    }
  }

  const pending = accounts?.filter((a) => a.status === "requested") ?? [];
  const others = accounts?.filter((a) => a.status !== "requested") ?? [];

  return (
    <div style={{ marginBottom: 28 }}>
      <div
        style={{
          fontSize: 16,
          fontWeight: 700,
          color: "#1a0505",
          marginBottom: 4,
        }}
      >
        Self-serve requests
      </div>
      <div
        style={{
          fontSize: 12.5,
          color: "#888",
          marginBottom: 12,
          maxWidth: 620,
        }}
      >
        Partners who signed up at <code>/agent-access</code>. Approving emails
        them a sign-in link; they then pay and generate their own key — no admin
        in the loop after approval.
      </div>

      {err && (
        <div style={{ color: "#b3261e", fontSize: 13, marginBottom: 10 }}>
          {err}
        </div>
      )}

      {loading && !accounts ? (
        <div style={{ color: "#888", fontSize: 13 }}>Loading…</div>
      ) : accounts && accounts.length === 0 ? (
        <div style={{ color: "#888", fontSize: 13 }}>
          No self-serve requests yet.
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table
            style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}
          >
            <thead>
              <tr style={{ textAlign: "left", color: "#8a6a5a", fontSize: 11 }}>
                <th style={{ padding: "8px 8px" }}>Company</th>
                <th style={{ padding: "8px 8px" }}>Contact</th>
                <th style={{ padding: "8px 8px" }}>Intended use</th>
                <th style={{ padding: "8px 8px" }}>Status</th>
                <th style={{ padding: "8px 8px" }}></th>
              </tr>
            </thead>
            <tbody>
              {[...pending, ...others].map((a) => {
                const s = accountStatusStyle(a.status);
                return (
                  <tr key={a.id} style={{ borderTop: `1px solid ${BORDER}` }}>
                    <td style={{ padding: "10px 8px", verticalAlign: "top" }}>
                      <div style={{ fontWeight: 600, color: "#1a0505" }}>
                        {a.companyName}
                      </div>
                      <div style={{ fontSize: 11, color: "#999" }}>
                        {fmtDate(a.createdAt)}
                      </div>
                    </td>
                    <td
                      style={{
                        padding: "10px 8px",
                        verticalAlign: "top",
                        fontSize: 12,
                      }}
                    >
                      <div>{a.contactName}</div>
                      <div style={{ fontSize: 11, color: "#999" }}>
                        {a.email}
                      </div>
                    </td>
                    <td
                      style={{
                        padding: "10px 8px",
                        verticalAlign: "top",
                        fontSize: 12,
                        maxWidth: 260,
                        color: "#555",
                      }}
                    >
                      {a.intendedUse || "—"}
                    </td>
                    <td style={{ padding: "10px 8px", verticalAlign: "top" }}>
                      <span
                        style={{
                          color: s.color,
                          fontWeight: 600,
                          fontSize: 12,
                        }}
                      >
                        {s.text}
                      </span>
                      {a.hasKey && (
                        <div style={{ fontSize: 11, color: "#999" }}>
                          key issued
                        </div>
                      )}
                    </td>
                    <td
                      style={{
                        padding: "10px 8px",
                        verticalAlign: "top",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {(a.status === "requested" ||
                        a.status === "approved") && (
                        <button
                          style={{
                            ...btnPrimary,
                            marginRight: 6,
                            padding: "7px 12px",
                            fontSize: 12,
                          }}
                          disabled={busyId === a.id}
                          onClick={() => approve(a.id)}
                        >
                          {a.status === "approved" ? "Resend link" : "Approve"}
                        </button>
                      )}
                      {a.status !== "rejected" && (
                        <button
                          style={{
                            ...btnGhost,
                            color: "#b3261e",
                            borderColor: "#e6b3ae",
                          }}
                          disabled={busyId === a.id}
                          onClick={() => reject(a.id)}
                        >
                          Reject
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
