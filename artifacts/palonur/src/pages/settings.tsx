import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { SLMBrand } from "../components/SLMBrand";

const API_BASE = "/api";
const USER_ID_KEY = "palonur_user_id";
const USER_NAME_KEY = "palonur_user_name";
const USER_EMAIL_KEY = "palonur_user_email";

interface UserData {
  id: number;
  first_name: string;
  email: string;
  email_opted_out: boolean;
}

export default function Settings() {
  const [, setLocation] = useLocation();
  const userId = localStorage.getItem(USER_ID_KEY);

  const [user, setUser] = useState<UserData | null>(null);
  const [loading, setLoading] = useState(true);

  const [firstName, setFirstName] = useState("");
  const [email, setEmail] = useState("");
  const [emailOptedOut, setEmailOptedOut] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!userId) { setLocation("/"); return; }
    fetch(`${API_BASE}/user/${userId}`)
      .then(r => r.json())
      .then((d: UserData) => {
        setUser(d);
        setFirstName(d.first_name);
        setEmail(d.email);
        setEmailOptedOut(d.email_opted_out);
        setLoading(false);
      })
      .catch(() => { setError("Couldn't load your settings."); setLoading(false); });
  }, [userId, setLocation]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!userId || !firstName.trim() || !email.trim()) return;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const res = await fetch(`${API_BASE}/user/${userId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          first_name: firstName.trim(),
          email: email.trim(),
          email_opted_out: emailOptedOut,
        }),
      });
      const data: UserData = await res.json();
      if (!res.ok) throw new Error((data as unknown as { error: string }).error ?? "Save failed");
      setUser(data);
      setFirstName(data.first_name);
      setEmail(data.email);
      setEmailOptedOut(data.email_opted_out);
      localStorage.setItem(USER_NAME_KEY, data.first_name);
      localStorage.setItem(USER_EMAIL_KEY, data.email.toLowerCase());
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!userId) return;
    setDeleting(true);
    try {
      await fetch(`${API_BASE}/user/${userId}`, { method: "DELETE" });
      localStorage.removeItem(USER_ID_KEY);
      localStorage.removeItem(USER_NAME_KEY);
      setLocation("/");
    } catch {
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  if (loading) return (
    <div style={{
      minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "#fafaf7",
    }}>
      <div style={{
        width: 24, height: 24, borderRadius: "50%",
        border: "2px solid rgba(139,26,26,.15)", borderTopColor: "#8B1A1A",
        animation: "spin 0.8s linear infinite",
      }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );

  return (
    <div style={{
      minHeight: "100dvh", background: "#fafaf7",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif",
      color: "#1a0505",
    }}>
      <style>{`
        @media (max-width: 600px) {
          .set-header { padding: 12px 16px !important; }
          .set-brand  { display: none !important; }
          .set-main   { padding: 32px 16px 64px !important; }
        }
      `}</style>

      <header className="set-header" style={{
        padding: "16px 28px",
        display: "grid",
        gridTemplateColumns: "1fr auto 1fr",
        alignItems: "center",
        borderBottom: "1px solid rgba(139,26,26,.08)",
      }}>
        <a
          href={`${import.meta.env.BASE_URL}journey`}
          style={{ textDecoration: "none", color: "#8B1A1A", fontSize: 13, fontWeight: 600, letterSpacing: ".02em" }}
        >
          ← journey
        </a>
        <span className="set-brand"><SLMBrand /></span>
        <div />
      </header>

      <main className="set-main" style={{ maxWidth: 480, margin: "0 auto", padding: "48px 24px 80px" }}>

        <div style={{ marginBottom: 40 }}>
          <div style={{
            fontSize: "clamp(26px, 3vw, 34px)",
            fontWeight: 500, letterSpacing: "-0.02em",
            fontFamily: "'Georgia', 'Times New Roman', serif",
            color: "#0f0505", marginBottom: 8,
          }}>
            Your settings
          </div>
          <div style={{ fontSize: 15, color: "#888" }}>
            {user?.first_name ? `Logged in as ${user.first_name}` : "Manage your account preferences."}
          </div>
        </div>

        <form onSubmit={handleSave}>

          {/* Account section */}
          <div style={{
            background: "#fff", borderRadius: 16,
            border: "1px solid rgba(139,26,26,.1)",
            overflow: "hidden", marginBottom: 16,
          }}>
            <div style={{
              padding: "14px 20px",
              borderBottom: "1px solid rgba(139,26,26,.06)",
              fontSize: 11, fontWeight: 700, letterSpacing: ".14em",
              textTransform: "uppercase", color: "#8B1A1A",
            }}>
              Account
            </div>

            <div style={{ padding: "20px" }}>
              <label style={{ display: "block", marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#444", marginBottom: 6 }}>First name</div>
                <input
                  type="text"
                  value={firstName}
                  onChange={e => setFirstName(e.target.value)}
                  required
                  style={{
                    width: "100%", padding: "10px 12px",
                    border: "1px solid rgba(139,26,26,.2)", borderRadius: 8,
                    fontSize: 15, color: "#1a0505", background: "#fafaf7",
                    outline: "none", boxSizing: "border-box",
                  }}
                />
              </label>

              <label style={{ display: "block" }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#444", marginBottom: 6 }}>Email</div>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  style={{
                    width: "100%", padding: "10px 12px",
                    border: "1px solid rgba(139,26,26,.2)", borderRadius: 8,
                    fontSize: 15, color: "#1a0505", background: "#fafaf7",
                    outline: "none", boxSizing: "border-box",
                  }}
                />
              </label>
            </div>
          </div>

          {/* Notifications section */}
          <div style={{
            background: "#fff", borderRadius: 16,
            border: "1px solid rgba(139,26,26,.1)",
            overflow: "hidden", marginBottom: 28,
          }}>
            <div style={{
              padding: "14px 20px",
              borderBottom: "1px solid rgba(139,26,26,.06)",
              fontSize: 11, fontWeight: 700, letterSpacing: ".14em",
              textTransform: "uppercase", color: "#8B1A1A",
            }}>
              Notifications
            </div>

            <div style={{ padding: "20px" }}>
              <label style={{
                display: "flex", alignItems: "center",
                justifyContent: "space-between", cursor: "pointer", gap: 16,
              }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 500, color: "#1a0505", marginBottom: 3 }}>
                    Morning check-in emails
                  </div>
                  <div style={{ fontSize: 13, color: "#888", lineHeight: 1.4 }}>
                    A daily nudge the morning after you make a commitment.
                  </div>
                </div>
                <div
                  onClick={() => setEmailOptedOut(v => !v)}
                  style={{
                    flexShrink: 0,
                    width: 44, height: 26, borderRadius: 13,
                    background: emailOptedOut ? "#ddd" : "#8B1A1A",
                    position: "relative", cursor: "pointer",
                    transition: "background .2s",
                  }}
                >
                  <div style={{
                    position: "absolute",
                    top: 3, left: emailOptedOut ? 3 : 21,
                    width: 20, height: 20, borderRadius: "50%",
                    background: "#fff",
                    boxShadow: "0 1px 3px rgba(0,0,0,.2)",
                    transition: "left .2s",
                  }} />
                </div>
              </label>
            </div>
          </div>

          {error && (
            <div style={{
              padding: "12px 16px", borderRadius: 10, marginBottom: 16,
              background: "rgba(139,26,26,.06)", color: "#8B1A1A",
              fontSize: 14, fontWeight: 500,
            }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={saving}
            style={{
              width: "100%", padding: "14px",
              background: saving ? "#ccc" : "#8B1A1A",
              color: "#fff", border: "none", borderRadius: 12,
              fontSize: 15, fontWeight: 600, cursor: saving ? "wait" : "pointer",
              transition: "background .15s",
            }}
          >
            {saving ? "Saving…" : saved ? "✓ Saved" : "Save changes"}
          </button>

        </form>

        {saved && (
          <div style={{
            marginTop: 16, textAlign: "center",
            fontSize: 13, color: "#888",
          }}>
            Your preferences have been updated.
          </div>
        )}

        {/* Delete account */}
        <div style={{ marginTop: 48, paddingTop: 32, borderTop: "1px solid rgba(139,26,26,.08)" }}>
          {!confirmDelete ? (
            <button
              onClick={() => setConfirmDelete(true)}
              style={{
                background: "none", border: "none", padding: 0,
                fontSize: 13, color: "#bbb", cursor: "pointer",
                textDecoration: "underline", textUnderlineOffset: 3,
              }}
            >
              Delete my account
            </button>
          ) : (
            <div style={{
              padding: "20px", borderRadius: 14,
              border: "1.5px solid rgba(180,30,30,.2)",
              background: "rgba(180,30,30,.03)",
            }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: "#8B1A1A", marginBottom: 6 }}>
                Delete your account?
              </div>
              <div style={{ fontSize: 13, color: "#666", lineHeight: 1.55, marginBottom: 18 }}>
                This permanently removes your profile, sleep logs, commitments, and check-in history. It cannot be undone.
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  style={{
                    flex: 1, padding: "11px",
                    background: deleting ? "#ccc" : "#8B1A1A",
                    color: "#fff", border: "none", borderRadius: 9,
                    fontSize: 14, fontWeight: 600,
                    cursor: deleting ? "wait" : "pointer",
                  }}
                >
                  {deleting ? "Deleting…" : "Yes, delete everything"}
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  disabled={deleting}
                  style={{
                    flex: 1, padding: "11px",
                    background: "transparent", color: "#666",
                    border: "1.5px solid #ddd", borderRadius: 9,
                    fontSize: 14, fontWeight: 500, cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

      </main>
    </div>
  );
}
