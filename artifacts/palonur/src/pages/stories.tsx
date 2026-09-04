import { useEffect, useState, useCallback } from "react";

const RED = "#8B1A1A";
const INK = "#0a0a0f";
const PAPER = "#FAF8F4";
const MUTED = "rgba(10,10,15,0.62)";
const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "-apple-system, BlinkMacSystemFont, 'Inter', sans-serif";

type Story = {
  id: number;
  status: string;
  firstName: string | null;
  email: string | null;
  anonymous: boolean;
  goal: string | null;
  hook: string | null;
  struggle: string | null;
  enablement: string | null;
  followUps: Record<string, string>;
  followUpAnswers: Record<string, string>;
  draftHtml: string | null;
  pullQuote: string | null;
  editorNotes: string | null;
  referrer: string | null;
  sleepQueryId: string | null;
  inviterNote: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
};
type StoryImage = {
  id: number;
  storyId: number;
  objectPath: string;
  originalName: string | null;
  caption: string | null;
  position: number;
  isPullImage: boolean;
};
type Invite = {
  id: number;
  email: string;
  inviterEmail: string;
  contextNote: string | null;
  usedAt: string | null;
  storyId: number | null;
  createdAt: string;
  expiresAt: string;
};

const STATUS_LABELS: Record<string, string> = {
  new: "New",
  in_edit: "In edit",
  approved: "Approved",
  archived: "Archived",
};

export default function StoriesDashboard() {
  const [me, setMe] = useState<{ email: string; role: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [stories, setStories] = useState<Story[]>([]);
  const [filter, setFilter] = useState<string>("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [showInvite, setShowInvite] = useState(false);

  useEffect(() => {
    document.title = "Stories · Palonur";
    document.body.style.background = PAPER;
    return () => { document.body.style.background = ""; };
  }, []);

  useEffect(() => {
    fetch("/api/stories-auth/me", { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) { window.location.href = "/stories-login"; return; }
        const d = await r.json();
        setMe(d);
      })
      .catch(() => { window.location.href = "/stories-login"; });
  }, []);

  const reload = useCallback(() => {
    if (!me) return;
    const safeJson = async (url: string) => {
      try {
        const r = await fetch(url, { credentials: "include" });
        const ct = r.headers.get("content-type") ?? "";
        if (!r.ok || !ct.includes("application/json")) {
          if (r.status === 401) window.location.href = "/stories-login";
          return null;
        }
        return await r.json();
      } catch {
        return null;
      }
    };
    const q = filter ? `?status=${filter}` : "";
    safeJson(`/api/stories${q}`).then((d) => {
      setStories(d?.stories ?? []);
      setLoading(false);
    });
    safeJson("/api/stories-invites").then((d) => setInvites(d?.invites ?? []));
  }, [filter, me]);
  useEffect(() => { reload(); }, [reload]);

  const selected = stories.find((s) => s.id === selectedId) ?? null;

  return (
    <div style={{ minHeight: "100vh", background: PAPER, fontFamily: SANS, color: INK }}>
      <header style={{ borderBottom: "1px solid rgba(10,10,15,0.08)", padding: "18px 24px", background: "#fff", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <a href="/" style={{ color: INK, textDecoration: "none", fontWeight: 700, fontSize: 18 }}>Palonur</a>
          <div style={{ fontSize: 11, letterSpacing: ".14em", textTransform: "uppercase", color: MUTED }}>Stories editor</div>
        </div>
        <div style={{ fontSize: 13, color: MUTED, display: "flex", gap: 14, alignItems: "center" }}>
          {me && <span>{me.email}</span>}
          <button onClick={() => setShowInvite(true)} style={{ background: RED, color: "#fff", border: "none", borderRadius: 999, padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            + Invite a contributor
          </button>
          <button onClick={async () => { await fetch("/api/stories-auth/logout", { method: "POST", credentials: "include" }); window.location.href = "/stories-login"; }} style={{ background: "transparent", border: "1px solid rgba(10,10,15,0.15)", color: INK, borderRadius: 8, padding: "6px 12px", fontSize: 12, cursor: "pointer" }}>Sign out</button>
        </div>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 360px) 1fr", minHeight: "calc(100vh - 56px)" }}>
        <aside style={{ borderRight: "1px solid rgba(10,10,15,0.08)", background: "#fff", padding: "18px 0" }}>
          <div style={{ display: "flex", gap: 6, padding: "0 18px 14px", flexWrap: "wrap" }}>
            {["", "new", "in_edit", "approved", "archived"].map((s) => (
              <button key={s || "all"} onClick={() => setFilter(s)} style={{
                background: filter === s ? INK : "transparent",
                color: filter === s ? "#fff" : INK,
                border: filter === s ? "none" : "1px solid rgba(10,10,15,0.15)",
                borderRadius: 999, padding: "4px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer",
                textTransform: s ? "capitalize" : "none",
              }}>{s ? STATUS_LABELS[s] : "All"}</button>
            ))}
          </div>
          <div>
            {loading && <div style={{ padding: 18, color: MUTED, fontSize: 13 }}>Loading…</div>}
            {!loading && stories.length === 0 && (
              <div style={{ padding: 24, color: MUTED, fontSize: 14, fontFamily: SERIF }}>No stories yet.</div>
            )}
            {stories.map((s) => (
              <button key={s.id} onClick={() => setSelectedId(s.id)} style={{
                display: "block", width: "100%", textAlign: "left",
                background: selectedId === s.id ? "rgba(139,26,26,0.06)" : "transparent",
                border: "none", borderTop: "1px solid rgba(10,10,15,0.06)",
                padding: "14px 18px", cursor: "pointer",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                  <div style={{ fontFamily: SERIF, fontSize: 15, fontWeight: 500, color: INK }}>
                    {s.anonymous ? "Anonymous" : s.firstName || "Untitled"}
                  </div>
                  <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: s.status === "approved" ? "#1E8449" : s.status === "in_edit" ? "#D4A017" : RED }}>
                    {STATUS_LABELS[s.status] ?? s.status}
                  </div>
                </div>
                <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.4 }}>
                  {(s.goal ?? s.hook ?? "").slice(0, 90)}{(s.goal ?? s.hook ?? "").length > 90 ? "…" : ""}
                </div>
                <div style={{ fontSize: 10, color: MUTED, marginTop: 4 }}>
                  {s.submittedAt ? new Date(s.submittedAt).toLocaleDateString() : ""}
                  {s.referrer ? ` · via ${s.referrer}` : ""}
                </div>
              </button>
            ))}
          </div>
        </aside>

        <main style={{ padding: 0 }}>
          {selected ? (
            <StoryEditor key={selected.id} storyId={selected.id} onUpdated={reload} />
          ) : (
            <div style={{ padding: 60, color: MUTED, fontFamily: SERIF, fontSize: 17 }}>
              Select a story to start editing.
            </div>
          )}
        </main>
      </div>

      {showInvite && <InviteModal onClose={() => { setShowInvite(false); reload(); }} invites={invites} />}
    </div>
  );
}

function StoryEditor({ storyId, onUpdated }: { storyId: number; onUpdated: () => void }) {
  const [story, setStory] = useState<Story | null>(null);
  const [images, setImages] = useState<StoryImage[]>([]);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/stories/${storyId}`, { credentials: "include" })
      .then((r) => r.json())
      .then((d) => { setStory(d.story); setImages(d.images ?? []); });
  }, [storyId]);
  useEffect(() => { load(); }, [load]);

  async function patch(p: Partial<Story>) {
    setSaving(true);
    try {
      const r = await fetch(`/api/stories/${storyId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(p),
      });
      const d = await r.json();
      if (d.story) { setStory(d.story); onUpdated(); }
    } finally { setSaving(false); }
  }

  async function generateDraft() {
    setGenerating(true);
    try {
      const r = await fetch(`/api/stories/${storyId}/generate-draft`, { method: "POST", credentials: "include" });
      const d = await r.json();
      if (d.story) { setStory(d.story); onUpdated(); }
    } finally { setGenerating(false); }
  }

  async function copyHtml() {
    if (!story) return;
    const r = await fetch(`/api/stories/${storyId}/export.html`, { credentials: "include" });
    const html = await r.text();
    await navigator.clipboard.writeText(html);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function setPullImage(imgId: number) {
    await fetch(`/api/stories/${storyId}/images/${imgId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ isPullImage: true }),
    });
    load();
  }
  async function removeImage(imgId: number) {
    await fetch(`/api/stories/${storyId}/images/${imgId}`, { method: "DELETE", credentials: "include" });
    load();
  }

  if (!story) return <div style={{ padding: 40, color: MUTED }}>Loading…</div>;

  const locked = story.status === "approved";

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0, minHeight: "100%" }}>
      {/* Raw answers */}
      <div style={{ padding: "28px 28px 60px", borderRight: "1px solid rgba(10,10,15,0.08)", background: PAPER }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ fontSize: 11, letterSpacing: ".18em", color: RED, fontWeight: 700, textTransform: "uppercase" }}>Raw answers</div>
          <div style={{ fontSize: 11, color: MUTED }}>
            {story.referrer ? `Source: ${story.referrer}` : ""}
            {story.sleepQueryId ? ` · q=${story.sleepQueryId.slice(0, 8)}` : ""}
          </div>
        </div>
        <div style={{ fontFamily: SERIF, fontSize: 16, lineHeight: 1.65, color: INK }}>
          {(["goal","hook","struggle","enablement"] as const).map((k) => (
            <div key={k} style={{ marginBottom: 22 }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".14em", color: RED, marginBottom: 6, textTransform: "uppercase" }}>{k}</div>
              <div style={{ whiteSpace: "pre-wrap" }}>{(story as any)[k]}</div>
              {story.followUps?.[k] && (
                <div style={{ marginTop: 10, borderLeft: `2px solid ${RED}`, paddingLeft: 12, color: MUTED, fontSize: 14 }}>
                  <em>Q: {story.followUps[k]}</em>
                  {story.followUpAnswers?.[k] && <div style={{ marginTop: 4, color: INK, whiteSpace: "pre-wrap" }}>{story.followUpAnswers[k]}</div>}
                </div>
              )}
            </div>
          ))}
        </div>

        {images.length > 0 && (
          <div style={{ marginTop: 18 }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".14em", color: RED, marginBottom: 10, textTransform: "uppercase" }}>Images</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 10 }}>
              {images.map((img) => (
                <div key={img.id} style={{ position: "relative", borderRadius: 10, overflow: "hidden", border: img.isPullImage ? `2px solid ${RED}` : "1px solid rgba(10,10,15,0.08)", background: "#fff" }}>
                  <img src={`/api/storage${img.objectPath}`} alt="" style={{ width: "100%", height: 110, objectFit: "cover", display: "block" }} />
                  {!locked && (
                    <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 6px", fontSize: 10 }}>
                      <button onClick={() => setPullImage(img.id)} style={{ background: "none", border: "none", color: img.isPullImage ? RED : MUTED, cursor: "pointer", fontWeight: 600 }}>
                        {img.isPullImage ? "★ Pull" : "☆ Set pull"}
                      </button>
                      <button onClick={() => removeImage(img.id)} style={{ background: "none", border: "none", color: MUTED, cursor: "pointer" }}>×</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Editor */}
      <div style={{ padding: "28px 28px 60px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ fontSize: 11, letterSpacing: ".18em", color: RED, fontWeight: 700, textTransform: "uppercase" }}>Newsletter draft</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={generateDraft} disabled={generating || locked} style={{
              background: "transparent", border: `1px solid ${RED}`, color: RED,
              borderRadius: 999, padding: "6px 12px", fontSize: 12, fontWeight: 600,
              cursor: generating || locked ? "default" : "pointer",
            }}>{generating ? "Drafting…" : story.draftHtml ? "Re-draft with AI" : "Draft with AI"}</button>
          </div>
        </div>

        {!locked && (
          <div style={{ marginBottom: 12, fontSize: 11, color: MUTED }}>
            Tip: edit the HTML directly. Use &lt;p&gt; for paragraphs, &lt;em&gt; for emphasis, &lt;strong&gt; for bold. {saving && <span style={{ color: RED }}>· saving</span>}
          </div>
        )}

        <textarea
          value={story.draftHtml ?? ""}
          onChange={(e) => setStory({ ...story, draftHtml: e.target.value })}
          onBlur={() => patch({ draftHtml: story.draftHtml })}
          rows={14}
          readOnly={locked}
          placeholder="Click 'Draft with AI' to generate a starting newsletter paragraph from the raw answers."
          style={{
            width: "100%", boxSizing: "border-box",
            fontFamily: SERIF, fontSize: 15, lineHeight: 1.55, color: INK,
            background: locked ? "rgba(0,0,0,0.03)" : "#fff",
            border: "1px solid rgba(10,10,15,0.12)", borderRadius: 12,
            padding: "14px 16px", outline: "none", resize: "vertical",
          }}
        />

        <div style={{ marginTop: 18 }}>
          <label style={{ fontSize: 11, letterSpacing: ".14em", color: RED, fontWeight: 700, textTransform: "uppercase" }}>Pull quote</label>
          <input
            value={story.pullQuote ?? ""}
            onChange={(e) => setStory({ ...story, pullQuote: e.target.value })}
            onBlur={() => patch({ pullQuote: story.pullQuote ?? "" })}
            readOnly={locked}
            placeholder="One short sentence to lift out."
            style={{
              width: "100%", boxSizing: "border-box", marginTop: 6,
              fontFamily: SERIF, fontStyle: "italic", fontSize: 16, color: INK,
              background: locked ? "rgba(0,0,0,0.03)" : "#fff",
              border: "1px solid rgba(10,10,15,0.12)", borderRadius: 10,
              padding: "10px 12px", outline: "none",
            }}
          />
        </div>

        <div style={{ marginTop: 18 }}>
          <label style={{ fontSize: 11, letterSpacing: ".14em", color: RED, fontWeight: 700, textTransform: "uppercase" }}>Editor notes</label>
          <textarea
            value={story.editorNotes ?? ""}
            onChange={(e) => setStory({ ...story, editorNotes: e.target.value })}
            onBlur={() => patch({ editorNotes: story.editorNotes ?? "" })}
            readOnly={locked}
            rows={2}
            placeholder="Internal notes (not published)"
            style={{
              width: "100%", boxSizing: "border-box", marginTop: 6,
              fontFamily: SANS, fontSize: 13, color: INK,
              background: locked ? "rgba(0,0,0,0.03)" : "#fff",
              border: "1px solid rgba(10,10,15,0.12)", borderRadius: 10,
              padding: "10px 12px", outline: "none", resize: "vertical",
            }}
          />
        </div>

        <div style={{ marginTop: 24, padding: "16px 18px", borderRadius: 12, background: "#fff", border: "1px solid rgba(10,10,15,0.08)" }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {!locked && (
              <>
                <button onClick={() => patch({ status: "in_edit" })} style={btn(false)}>Mark in edit</button>
                <button onClick={() => { if (confirm("Approve and lock this story?")) patch({ status: "approved" }); }} style={btn(true)}>Approve &amp; lock</button>
                <button onClick={() => patch({ status: "archived" })} style={btn(false)}>Archive</button>
              </>
            )}
            {locked && (
              <div style={{ fontSize: 13, color: "#1E8449", fontWeight: 600 }}>
                ✓ Approved {story.approvedAt ? `on ${new Date(story.approvedAt).toLocaleDateString()}` : ""} — edits locked.
              </div>
            )}
          </div>

          <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={copyHtml} style={btn(true)}>{copied ? "✓ Copied" : "📋 Copy newsletter HTML"}</button>
            <a href={`/api/stories/${storyId}/export.html`} style={{ ...btn(false), textDecoration: "none", display: "inline-block" }}>↓ HTML</a>
            <a href={`/api/stories/${storyId}/export.md`} style={{ ...btn(false), textDecoration: "none", display: "inline-block" }}>↓ Markdown</a>
            {images.length > 0 && (
              <a href={`/api/stories/${storyId}/images.zip`} style={{ ...btn(false), textDecoration: "none", display: "inline-block" }}>↓ Images.zip</a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function btn(primary: boolean): React.CSSProperties {
  return {
    background: primary ? RED : "transparent",
    color: primary ? "#fff" : INK,
    border: primary ? "none" : "1px solid rgba(10,10,15,0.18)",
    borderRadius: 999, padding: "8px 14px",
    fontSize: 12, fontWeight: 600, cursor: "pointer",
  };
}

function InviteModal({ onClose, invites }: { onClose: () => void; invites: Invite[] }) {
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    try {
      const r = await fetch("/api/stories-invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: email.trim(), contextNote: note.trim() || undefined }),
      });
      if (r.ok) { setSent(true); setEmail(""); setNote(""); }
    } finally { setSending(false); }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 16, padding: 28, maxWidth: 520, width: "90%", maxHeight: "85vh", overflow: "auto" }}>
        <div style={{ fontSize: 11, letterSpacing: ".18em", color: RED, fontWeight: 700, textTransform: "uppercase", marginBottom: 8 }}>Invite a contributor</div>
        <h2 style={{ fontFamily: SERIF, fontSize: 24, fontWeight: 500, margin: "0 0 14px" }}>Send a one-time share link.</h2>
        <form onSubmit={submit}>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="reader@email.com"
            style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", border: "1px solid rgba(10,10,15,0.12)", borderRadius: 10, fontSize: 14, marginBottom: 10 }}
          />
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional context note shown in the email and pre-filled in the dashboard."
            rows={3}
            style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", border: "1px solid rgba(10,10,15,0.12)", borderRadius: 10, fontSize: 14, fontFamily: SANS, resize: "vertical" }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button type="submit" disabled={sending} style={btn(true)}>{sending ? "Sending…" : "Send invite"}</button>
            <button type="button" onClick={onClose} style={btn(false)}>Close</button>
          </div>
          {sent && <div style={{ marginTop: 10, color: "#1E8449", fontSize: 13 }}>✓ Sent.</div>}
        </form>

        {invites.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".14em", color: MUTED, textTransform: "uppercase", marginBottom: 8 }}>Recent invites</div>
            <div style={{ maxHeight: 220, overflow: "auto" }}>
              {invites.slice(0, 20).map((iv) => (
                <div key={iv.id} style={{ borderTop: "1px solid rgba(10,10,15,0.06)", padding: "8px 0", fontSize: 12, color: MUTED, display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <span>{iv.email}</span>
                  <span>{iv.usedAt ? `✓ used ${new Date(iv.usedAt).toLocaleDateString()}` : `pending · expires ${new Date(iv.expiresAt).toLocaleDateString()}`}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
