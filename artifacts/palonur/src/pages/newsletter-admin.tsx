import { useEffect, useState, useCallback } from "react";

const RED = "#8B1A1A";
const INK = "#0a0a0f";
const PAPER = "#FAF8F4";
const CARD = "#fff";
const MUTED = "rgba(10,10,15,0.6)";
const LINE = "rgba(10,10,15,0.12)";
const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "-apple-system, BlinkMacSystemFont, 'Inter', sans-serif";

type Issue = {
  id: number;
  title: string;
  subjectLine: string | null;
  previewText: string | null;
  introHtml: string | null;
  heroImagePath: string | null;
  status: "draft" | "scheduled" | "sent";
  recipientCount: number | null;
  sentAt: string | null;
  createdAt: string;
  postCount?: number;
  premium?: boolean;
};
type Post = {
  id: number;
  issueId: number;
  kind: "article" | "story";
  position: number;
  title: string | null;
  authorName: string | null;
  authorInstitution: string | null;
  sourceId: number | null;
  storyId: number | null;
  bodyHtml: string | null;
  pullQuote: string | null;
  sourceMaterial: string | null;
  imagePath: string | null;
  imagePrompt: string | null;
};
type Subscriber = {
  id: number;
  email: string;
  name: string | null;
  status: string;
  source: string | null;
  createdAt: string;
  paid?: boolean;
};
type SourceStory = {
  id: number;
  status: string;
  firstName: string | null;
  anonymous: boolean;
  goal: string | null;
  draftHtml: string | null;
  submittedAt: string | null;
};

async function api(url: string, opts?: RequestInit) {
  const r = await fetch(url, { credentials: "include", ...opts });
  if (r.status === 401) {
    window.location.href = "/stories-login";
    throw new Error("unauthorized");
  }
  const ct = r.headers.get("content-type") ?? "";
  const data = ct.includes("application/json") ? await r.json() : null;
  if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
  return data;
}

export default function NewsletterAdmin() {
  const [me, setMe] = useState<{ email: string; role: string } | null>(null);
  const [tab, setTab] = useState<
    "issues" | "offers" | "credits" | "subscribers" | "landing"
  >("issues");

  useEffect(() => {
    document.title = "Newsletter · Palonur";
    document.body.style.background = PAPER;
    return () => {
      document.body.style.background = "";
    };
  }, []);

  useEffect(() => {
    fetch("/api/stories-auth/me", { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) {
          window.location.href = "/stories-login";
          return;
        }
        setMe(await r.json());
      })
      .catch(() => {
        window.location.href = "/stories-login";
      });
  }, []);

  if (!me) {
    return (
      <div style={{ minHeight: "100dvh", background: PAPER, color: MUTED, fontFamily: SANS, display: "grid", placeItems: "center" }}>
        Loading…
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100dvh", background: PAPER, color: INK, fontFamily: SANS }}>
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "28px 24px 80px" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <p style={{ fontSize: 12, letterSpacing: ".18em", textTransform: "uppercase", color: RED, margin: 0 }}>
              Stanford Lifestyle Medicine
            </p>
            <h1 style={{ fontFamily: SERIF, fontWeight: 500, fontSize: 30, margin: "4px 0 0" }}>Newsletter</h1>
          </div>
          <div style={{ display: "flex", gap: 14, alignItems: "center", fontSize: 14 }}>
            <a href="/stories" style={{ color: MUTED, textDecoration: "none" }}>Stories →</a>
            <span style={{ color: MUTED }}>{me.email}</span>
          </div>
        </div>

        <div style={{ display: "flex", gap: 6, marginTop: 24, borderBottom: `1px solid ${LINE}` }}>
          {(["issues", "offers", "credits", "subscribers", "landing"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                border: "none",
                background: "none",
                padding: "10px 14px",
                fontSize: 15,
                fontWeight: 600,
                cursor: "pointer",
                color: tab === t ? INK : MUTED,
                borderBottom: tab === t ? `2px solid ${RED}` : "2px solid transparent",
                fontFamily: SANS,
                textTransform: "capitalize",
              }}
            >
              {t}
            </button>
          ))}
        </div>

        {tab === "issues" && <IssuesTab />}
        {tab === "offers" && <OffersTab />}
        {tab === "credits" && <CreditsTab />}
        {tab === "subscribers" && <SubscribersTab />}
        {tab === "landing" && <LandingTab />}
      </div>
    </div>
  );
}

// ── Issues ───────────────────────────────────────────────────────────────────

function IssuesTab() {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [newTitle, setNewTitle] = useState("");

  const load = useCallback(() => {
    api("/api/newsletter/issues").then((d) => setIssues(d.issues)).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  async function create() {
    const d = await api("/api/newsletter/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: newTitle.trim() || "Untitled issue" }),
    });
    setNewTitle("");
    load();
    setOpenId(d.issue.id);
  }

  if (openId != null) {
    return <IssueEditor issueId={openId} onBack={() => { setOpenId(null); load(); }} />;
  }

  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="New issue title…"
          style={field}
          onKeyDown={(e) => { if (e.key === "Enter") create(); }}
        />
        <button onClick={create} style={primaryBtn}>+ New issue</button>
      </div>
      {issues.length === 0 && <p style={{ color: MUTED }}>No issues yet. Create your first one above.</p>}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {issues.map((i) => (
          <button
            key={i.id}
            onClick={() => setOpenId(i.id)}
            style={{ ...card, textAlign: "left", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}
          >
            <div>
              <div style={{ fontFamily: SERIF, fontSize: 19 }}>
                {i.title}
                {i.premium && (
                  <span style={{ marginLeft: 10, fontSize: 11, fontWeight: 700, letterSpacing: ".06em", color: RED, background: "#f2dede", padding: "2px 8px", borderRadius: 999, verticalAlign: "middle" }}>
                    PREMIUM
                  </span>
                )}
              </div>
              <div style={{ fontSize: 13, color: MUTED, marginTop: 4 }}>
                {i.postCount ?? 0} post{(i.postCount ?? 0) === 1 ? "" : "s"}
                {i.status === "sent" && i.sentAt
                  ? ` · sent to ${i.recipientCount ?? 0} on ${new Date(i.sentAt).toLocaleDateString()}`
                  : ""}
              </div>
            </div>
            <StatusPill status={i.status} />
          </button>
        ))}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    draft: ["Draft", "#6b6b6b"],
    scheduled: ["Scheduled", "#b8860b"],
    sent: ["Sent", "#2e7d32"],
  };
  const [label, color] = map[status] ?? [status, MUTED];
  return (
    <span style={{ fontSize: 12, fontWeight: 700, color, border: `1px solid ${color}`, borderRadius: 999, padding: "3px 10px", whiteSpace: "nowrap" }}>
      {label}
    </span>
  );
}

// ── Issue editor ─────────────────────────────────────────────────────────────

function IssueEditor({ issueId, onBack }: { issueId: number; onBack: () => void }) {
  const [issue, setIssue] = useState<Issue | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [activeSubs, setActiveSubs] = useState(0);
  const [paidSubs, setPaidSubs] = useState(0);
  const [freeSubs, setFreeSubs] = useState(0);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [showStoryPicker, setShowStoryPicker] = useState(false);

  const load = useCallback(() => {
    api(`/api/newsletter/issues/${issueId}`).then((d) => {
      setIssue(d.issue);
      setPosts(d.posts);
      setActiveSubs(d.activeSubscribers ?? 0);
      setPaidSubs(d.paidSubscribers ?? 0);
      setFreeSubs(d.freeSubscribers ?? 0);
    }).catch(() => {});
  }, [issueId]);
  useEffect(() => { load(); }, [load]);

  function flash(kind: "ok" | "err", text: string) {
    setBanner({ kind, text });
    setTimeout(() => setBanner(null), 4000);
  }

  async function saveIssue(patch: Partial<Issue>) {
    setSaving(true);
    try {
      const d = await api(`/api/newsletter/issues/${issueId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      setIssue(d.issue);
    } catch (e: any) {
      flash("err", e.message);
    } finally {
      setSaving(false);
    }
  }

  async function addPost(kind: "article" | "story", storyId?: number) {
    await api(`/api/newsletter/issues/${issueId}/posts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, storyId }),
    });
    setShowStoryPicker(false);
    load();
  }

  async function sendAll() {
    if (!confirm(`Send "${issue?.subjectLine || issue?.title}" to ${activeSubs} active subscriber${activeSubs === 1 ? "" : "s"}? This cannot be undone.`)) return;
    try {
      const d = await api(`/api/newsletter/issues/${issueId}/send`, { method: "POST" });
      flash("ok", `Sent to ${d.sent} subscriber${d.sent === 1 ? "" : "s"}${d.failed ? ` (${d.failed} failed)` : ""}.`);
      load();
    } catch (e: any) {
      flash("err", e.message);
    }
  }

  async function sendTest() {
    const email = prompt("Send a test to which email?");
    if (!email) return;
    try {
      await api(`/api/newsletter/issues/${issueId}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      flash("ok", `Test sent to ${email}.`);
    } catch (e: any) {
      flash("err", e.message);
    }
  }

  if (!issue) return <p style={{ color: MUTED, marginTop: 24 }}>Loading…</p>;
  const sent = issue.status === "sent";

  return (
    <div style={{ marginTop: 20 }}>
      <button onClick={onBack} style={{ ...ghostBtn, marginBottom: 16 }}>← All issues</button>

      {banner && (
        <div style={{ padding: "10px 14px", borderRadius: 8, marginBottom: 16, fontSize: 14, background: banner.kind === "ok" ? "#e8f5e9" : "#fdecea", color: banner.kind === "ok" ? "#2e7d32" : RED }}>
          {banner.text}
        </div>
      )}

      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        {/* Left: meta + posts */}
        <div style={{ flex: "1 1 520px", minWidth: 320 }}>
          <div style={card}>
            <Label>Internal title</Label>
            <input style={field} defaultValue={issue.title} onBlur={(e) => saveIssue({ title: e.target.value })} disabled={sent} />
            <Label style={{ marginTop: 14 }}>Email subject line</Label>
            <input style={field} defaultValue={issue.subjectLine ?? ""} placeholder="What recipients see in their inbox" onBlur={(e) => saveIssue({ subjectLine: e.target.value })} disabled={sent} />
            <Label style={{ marginTop: 14 }}>Preview text</Label>
            <input style={field} defaultValue={issue.previewText ?? ""} placeholder="The grey preview snippet after the subject" onBlur={(e) => saveIssue({ previewText: e.target.value })} disabled={sent} />
            <Label style={{ marginTop: 14 }}>Intro (optional HTML)</Label>
            <textarea style={{ ...field, minHeight: 70, resize: "vertical" }} defaultValue={issue.introHtml ?? ""} placeholder="A short welcome paragraph" onBlur={(e) => saveIssue({ introHtml: e.target.value })} disabled={sent} />
            <label style={{ display: "flex", alignItems: "flex-start", gap: 10, marginTop: 16, cursor: sent ? "default" : "pointer" }}>
              <input
                type="checkbox"
                checked={Boolean(issue.premium)}
                disabled={sent}
                onChange={(e) => saveIssue({ premium: e.target.checked } as Partial<Issue>)}
                style={{ marginTop: 3 }}
              />
              <span>
                <span style={{ fontWeight: 600, fontSize: 14 }}>Premium issue</span>
                <span style={{ display: "block", fontSize: 13, color: MUTED, marginTop: 2 }}>
                  Paid subscribers get the full edition; free subscribers get a teaser with an upgrade link.
                </span>
              </span>
            </label>
            {saving && <p style={{ fontSize: 12, color: MUTED, margin: "8px 0 0" }}>Saving…</p>}
          </div>

          <div style={{ display: "flex", gap: 8, margin: "20px 0 14px", flexWrap: "wrap" }}>
            <button onClick={() => addPost("article")} style={primaryBtn} disabled={sent}>+ Article post</button>
            <button onClick={() => addPost("story")} style={secondaryBtn} disabled={sent}>+ Blank story</button>
            <button onClick={() => setShowStoryPicker(true)} style={secondaryBtn} disabled={sent}>+ From a submission</button>
          </div>

          {showStoryPicker && (
            <StoryPicker onPick={(sid) => addPost("story", sid)} onClose={() => setShowStoryPicker(false)} />
          )}

          {posts.length === 0 && <p style={{ color: MUTED }}>No posts yet. Add an article or a reader story above.</p>}
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {posts.map((p) => (
              <PostCard key={p.id} post={p} disabled={sent} onChange={load} onFlash={flash} />
            ))}
          </div>
        </div>

        {/* Right: send/export rail */}
        <div style={{ flex: "0 0 280px", minWidth: 260 }}>
          <div style={{ ...card, position: "sticky", top: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <Label style={{ margin: 0 }}>Status</Label>
              <StatusPill status={issue.status} />
            </div>
            <p style={{ fontSize: 14, color: MUTED, margin: "0 0 16px" }}>
              {activeSubs} active subscriber{activeSubs === 1 ? "" : "s"}
              {issue.premium && (
                <span style={{ display: "block", marginTop: 4 }}>
                  {paidSubs} paid get full · {freeSubs} free get a teaser
                </span>
              )}
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <a href={`/api/newsletter/issues/${issueId}/preview`} target="_blank" rel="noreferrer" style={{ ...secondaryBtn, textAlign: "center", textDecoration: "none" }}>Preview in browser</a>
              <button onClick={sendTest} style={secondaryBtn}>Send a test…</button>
              <button onClick={sendAll} style={{ ...primaryBtn, opacity: sent ? 0.5 : 1 }} disabled={sent}>
                {sent ? "Already sent" : `Send to ${activeSubs}`}
              </button>
            </div>
            <hr style={{ border: "none", borderTop: `1px solid ${LINE}`, margin: "16px 0" }} />
            <Label>Export</Label>
            <div style={{ display: "flex", gap: 8 }}>
              <a href={`/api/newsletter/issues/${issueId}/export.html`} style={{ ...ghostBtn, flex: 1, textAlign: "center", textDecoration: "none" }}>HTML</a>
              <a href={`/api/newsletter/issues/${issueId}/export.md`} style={{ ...ghostBtn, flex: 1, textAlign: "center", textDecoration: "none" }}>Markdown</a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StoryPicker({ onPick, onClose }: { onPick: (id: number) => void; onClose: () => void }) {
  const [stories, setStories] = useState<SourceStory[]>([]);
  useEffect(() => {
    api("/api/newsletter/source-stories").then((d) => setStories(d.stories)).catch(() => {});
  }, []);
  return (
    <div style={{ ...card, marginBottom: 14, borderColor: RED }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <strong style={{ fontSize: 15 }}>Pick a submission</strong>
        <button onClick={onClose} style={ghostBtn}>Close</button>
      </div>
      {stories.length === 0 && <p style={{ color: MUTED, fontSize: 14, margin: 0 }}>No submissions available yet.</p>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 300, overflowY: "auto" }}>
        {stories.map((s) => (
          <button key={s.id} onClick={() => onPick(s.id)} style={{ ...ghostBtn, textAlign: "left", padding: "10px 12px" }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>
              {s.anonymous ? "Anonymous reader" : s.firstName || "Reader"} · #{s.id}
            </div>
            <div style={{ fontSize: 13, color: MUTED, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {s.goal || s.draftHtml?.replace(/<[^>]+>/g, "") || "—"}
            </div>
          </button>
        ))}
      </div>
      <p style={{ fontSize: 12, color: MUTED, margin: "10px 0 0" }}>
        Names are stripped automatically when you generate the story with AI.
      </p>
    </div>
  );
}

function PostCard({ post, disabled, onChange, onFlash }: { post: Post; disabled: boolean; onChange: () => void; onFlash: (k: "ok" | "err", t: string) => void }) {
  const [busy, setBusy] = useState<"" | "text" | "image">("");
  const [instr, setInstr] = useState("");
  const [imgPrompt, setImgPrompt] = useState(post.imagePrompt ?? "");
  const [expanded, setExpanded] = useState(true);

  async function patch(p: Partial<Post>) {
    try {
      await api(`/api/newsletter/posts/${post.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p),
      });
      onChange();
    } catch (e: any) {
      onFlash("err", e.message);
    }
  }
  async function generate() {
    setBusy("text");
    try {
      await api(`/api/newsletter/posts/${post.id}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructions: instr || undefined }),
      });
      onChange();
      onFlash("ok", "Draft generated.");
    } catch (e: any) {
      onFlash("err", e.message);
    } finally {
      setBusy("");
    }
  }
  async function genImage() {
    if (!imgPrompt.trim()) { onFlash("err", "Describe the image first."); return; }
    setBusy("image");
    try {
      await api(`/api/newsletter/posts/${post.id}/image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: imgPrompt }),
      });
      onChange();
      onFlash("ok", "Image generated.");
    } catch (e: any) {
      onFlash("err", e.message);
    } finally {
      setBusy("");
    }
  }
  async function remove() {
    if (!confirm("Delete this post?")) return;
    await api(`/api/newsletter/posts/${post.id}`, { method: "DELETE" });
    onChange();
  }

  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: expanded ? 12 : 0 }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: post.kind === "story" ? RED : "#6b6b6b" }}>
          {post.kind === "story" ? "Reader story" : "Article"}
        </span>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={() => setExpanded((v) => !v)} style={ghostBtn}>{expanded ? "Collapse" : "Expand"}</button>
          {!disabled && <button onClick={remove} style={{ ...ghostBtn, color: RED }}>Delete</button>}
        </div>
      </div>

      {expanded && (
        <>
          <input style={field} defaultValue={post.title ?? ""} placeholder="Headline" onBlur={(e) => patch({ title: e.target.value })} disabled={disabled} />
          {post.kind === "article" && (
            <>
              <input style={{ ...field, marginTop: 8 }} defaultValue={post.authorName ?? ""} placeholder="Author / expert name" onBlur={(e) => patch({ authorName: e.target.value })} disabled={disabled} />
              <input style={{ ...field, marginTop: 8 }} defaultValue={post.authorInstitution ?? ""} placeholder="Institution (optional) — shown as “By Name · Institution”" onBlur={(e) => patch({ authorInstitution: e.target.value })} disabled={disabled} />
            </>
          )}

          <Label style={{ marginTop: 14 }}>
            {post.kind === "story" ? "Raw material (notes / transcript — names OK, AI strips them)" : "Source material (article text or summary)"}
          </Label>
          <textarea style={{ ...field, minHeight: 80, resize: "vertical" }} defaultValue={post.sourceMaterial ?? ""} placeholder="Paste here, then Generate" onBlur={(e) => patch({ sourceMaterial: e.target.value })} disabled={disabled} />

          {!disabled && (
            <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
              <input style={{ ...field, flex: 1 }} value={instr} onChange={(e) => setInstr(e.target.value)} placeholder="Optional guidance (tone, length, focus)" />
              <button onClick={generate} style={primaryBtn} disabled={busy === "text"}>
                {busy === "text" ? "Writing…" : post.bodyHtml ? "Regenerate" : "Generate with AI"}
              </button>
            </div>
          )}

          <Label style={{ marginTop: 14 }}>Body (editable HTML)</Label>
          <textarea style={{ ...field, minHeight: 120, resize: "vertical", fontFamily: SERIF, fontSize: 15 }} defaultValue={post.bodyHtml ?? ""} placeholder="Generated text appears here — edit freely" onBlur={(e) => patch({ bodyHtml: e.target.value })} disabled={disabled} />
          <Label style={{ marginTop: 14 }}>Pull-quote</Label>
          <input style={field} defaultValue={post.pullQuote ?? ""} onBlur={(e) => patch({ pullQuote: e.target.value })} disabled={disabled} />

          <Label style={{ marginTop: 14 }}>Image</Label>
          {post.imagePath && (
            <img src={`/api/storage${post.imagePath}`} alt="" style={{ width: "100%", borderRadius: 8, marginBottom: 8, border: `1px solid ${LINE}` }} />
          )}
          {!disabled && (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input style={{ ...field, flex: 1 }} value={imgPrompt} onChange={(e) => setImgPrompt(e.target.value)} placeholder="Describe an image to generate" />
              <button onClick={genImage} style={secondaryBtn} disabled={busy === "image"}>
                {busy === "image" ? "Generating…" : post.imagePath ? "Regenerate" : "Generate image"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Subscribers ──────────────────────────────────────────────────────────────

function SubscribersTab() {
  const [subs, setSubs] = useState<Subscriber[]>([]);
  const [counts, setCounts] = useState({ total: 0, active: 0, unsubscribed: 0, paid: 0, free: 0 });
  const [revenue, setRevenue] = useState<{ mrrCents: number; currency: string }>({ mrrCents: 0, currency: "usd" });
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");

  const load = useCallback(() => {
    api("/api/newsletter/subscribers").then((d) => {
      setSubs(d.subscribers);
      setCounts(d.counts);
      if (d.revenue) setRevenue(d.revenue);
    }).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  async function add() {
    if (!email.trim()) return;
    try {
      await api("/api/newsletter/subscribers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), name: name.trim() || undefined }),
      });
      setEmail(""); setName(""); load();
    } catch { /* surfaced via reload */ }
  }
  async function remove(id: number) {
    if (!confirm("Remove this subscriber?")) return;
    await api(`/api/newsletter/subscribers/${id}`, { method: "DELETE" });
    load();
  }

  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ display: "flex", gap: 24, marginBottom: 20, flexWrap: "wrap" }}>
        <Stat n={counts.active} label="Active" />
        <Stat n={counts.paid} label="Paid" />
        <Stat n={counts.free} label="Free" />
        <Stat n={counts.unsubscribed} label="Unsubscribed" />
        <Stat n={counts.total} label="Total" />
        <div>
          <div style={{ fontFamily: SERIF, fontSize: 28, color: RED }}>
            {new Intl.NumberFormat("en-US", {
              style: "currency",
              currency: (revenue.currency ?? "usd").toUpperCase(),
              minimumFractionDigits: 0,
            }).format(revenue.mrrCents / 100)}
          </div>
          <div style={{ fontSize: 12, color: MUTED, letterSpacing: ".06em", textTransform: "uppercase" }}>MRR</div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        <input style={{ ...field, flex: "1 1 200px" }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" />
        <input style={{ ...field, flex: "1 1 240px" }} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@example.com" onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
        <button onClick={add} style={primaryBtn}>+ Add subscriber</button>
      </div>

      <div style={{ ...card, padding: 0, overflow: "hidden" }}>
        {subs.length === 0 && <p style={{ color: MUTED, padding: 16, margin: 0 }}>No subscribers yet.</p>}
        {subs.map((s, i) => (
          <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderTop: i === 0 ? "none" : `1px solid ${LINE}` }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>{s.email}</div>
              <div style={{ fontSize: 12, color: MUTED }}>
                {s.name ? `${s.name} · ` : ""}{s.source ?? "web"} · {new Date(s.createdAt).toLocaleDateString()}
              </div>
            </div>
            {s.paid && (
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".06em", color: RED, background: "#f2dede", padding: "2px 8px", borderRadius: 999 }}>
                PAID
              </span>
            )}
            <span style={{ fontSize: 12, color: s.status === "active" ? "#2e7d32" : MUTED }}>{s.status}</span>
            <button onClick={() => remove(s.id)} style={{ ...ghostBtn, color: RED }}>Remove</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div>
      <div style={{ fontFamily: SERIF, fontSize: 32, lineHeight: 1 }}>{n}</div>
      <div style={{ fontSize: 13, color: MUTED, marginTop: 4 }}>{label}</div>
    </div>
  );
}

// ── Landing page (Topic → auto-generated, then editable, editorial page) ─────

type LandingSection = {
  heading: string;
  body: string;
  imagePath: string | null;
  imagePrompt: string | null;
};
type LandingContent = {
  heroEyebrow: string;
  heroHeadline: string;
  heroSubhead: string;
  aboutLead: string;
  sections: LandingSection[];
  benefits: string[];
};
type HousePublication = {
  id: number;
  name: string;
  slug: string;
  topic: string | null;
  landingContent: LandingContent | null;
  heroImagePath: string | null;
};

function LandingTab() {
  const [pub, setPub] = useState<HousePublication | null>(null);
  const [topic, setTopic] = useState("");
  const [landing, setLanding] = useState<LandingContent | null>(null);
  const [heroImagePath, setHeroImagePath] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = useCallback((p: HousePublication) => {
    setPub(p);
    setTopic(p.topic ?? "");
    setLanding(p.landingContent ?? null);
    setHeroImagePath(p.heroImagePath ?? null);
  }, []);

  useEffect(() => {
    api("/api/newsletter/publication")
      .then((d) => apply(d.publication))
      .catch(() => {});
  }, [apply]);

  async function generate() {
    if (topic.trim().length < 2) return;
    setBusy(true);
    setMsg("Generating… this can take a minute.");
    try {
      const d = await api("/api/newsletter/publication/landing/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: topic.trim() }),
      });
      apply(d.publication);
      setMsg("Generated. Edit anything below, then Save.");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!landing) return;
    setBusy(true);
    try {
      const d = await api("/api/newsletter/publication/landing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: topic.trim() || null, landingContent: landing }),
      });
      apply(d.publication);
      setMsg("Saved.");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function regenImage(target: "hero" | number, prompt: string) {
    if (prompt.trim().length < 2) return;
    setBusy(true);
    setMsg("Generating image…");
    try {
      const d = await api("/api/newsletter/publication/landing/image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target, prompt: prompt.trim() }),
      });
      apply(d.publication);
      setMsg("Image updated.");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const previewUrl = pub ? `/p/${pub.slug}` : "#";

  return (
    <div style={{ marginTop: 24, maxWidth: 720 }}>
      <p style={{ color: MUTED, fontSize: 14, lineHeight: 1.6, margin: "0 0 16px" }}>
        Set a topic and we'll draft a rich editorial landing page for{" "}
        <span style={{ fontFamily: "monospace" }}>/p/{pub?.slug ?? "…"}</span> —
        hero, an "about this topic" lead, a few sections and a "what you'll get"
        band. Everything below is fully editable. Re-generating replaces the
        current draft.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        <input
          style={{ ...field, flex: "1 1 280px" }}
          value={topic}
          onChange={(e) => {
            setTopic(e.target.value);
            setMsg(null);
          }}
          placeholder="e.g. Lifestyle medicine for clinicians"
        />
        <button onClick={generate} disabled={busy || topic.trim().length < 2} style={primaryBtn}>
          {busy ? "Working…" : landing ? "Re-generate" : "Generate"}
        </button>
      </div>

      {landing && (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <AdminField
            label="Hero eyebrow"
            value={landing.heroEyebrow}
            onChange={(v) => setLanding({ ...landing, heroEyebrow: v })}
          />
          <AdminField
            label="Hero headline"
            value={landing.heroHeadline}
            onChange={(v) => setLanding({ ...landing, heroHeadline: v })}
          />
          <AdminField
            label="Hero subhead"
            value={landing.heroSubhead}
            textarea
            onChange={(v) => setLanding({ ...landing, heroSubhead: v })}
          />
          <AdminField
            label="About this topic (lead)"
            value={landing.aboutLead}
            textarea
            onChange={(v) => setLanding({ ...landing, aboutLead: v })}
          />

          <AdminImage
            label="Hero image"
            imagePath={heroImagePath}
            promptValue={landing.heroEyebrow}
            busy={busy}
            onRegen={(p) => regenImage("hero", p)}
          />

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <p style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Sections</p>
            {landing.sections.map((s, i) => (
              <div key={i} style={{ ...card, display: "flex", flexDirection: "column", gap: 12 }}>
                <AdminField
                  label={`Section ${i + 1} heading`}
                  value={s.heading}
                  onChange={(v) =>
                    setLanding({
                      ...landing,
                      sections: landing.sections.map((x, j) =>
                        j === i ? { ...x, heading: v } : x,
                      ),
                    })
                  }
                />
                <AdminField
                  label="Body"
                  value={s.body}
                  textarea
                  onChange={(v) =>
                    setLanding({
                      ...landing,
                      sections: landing.sections.map((x, j) =>
                        j === i ? { ...x, body: v } : x,
                      ),
                    })
                  }
                />
                <AdminImage
                  label="Section image"
                  imagePath={s.imagePath}
                  promptValue={s.imagePrompt ?? s.heading}
                  busy={busy}
                  onRegen={(p) => regenImage(i, p)}
                />
              </div>
            ))}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <p style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>What you'll get</p>
            {landing.benefits.map((b, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <textarea
                  style={{ ...field, flex: 1, minHeight: 52, resize: "vertical" }}
                  value={b}
                  onChange={(e) =>
                    setLanding({
                      ...landing,
                      benefits: landing.benefits.map((x, j) =>
                        j === i ? e.target.value : x,
                      ),
                    })
                  }
                />
                <button
                  onClick={() =>
                    setLanding({
                      ...landing,
                      benefits: landing.benefits.filter((_, j) => j !== i),
                    })
                  }
                  style={{ ...ghostBtn, color: RED, padding: "8px 6px" }}
                  aria-label="Remove point"
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              onClick={() => setLanding({ ...landing, benefits: [...landing.benefits, ""] })}
              style={{ ...ghostBtn, color: RED }}
            >
              + Add point
            </button>
          </div>

          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <button onClick={save} disabled={busy} style={primaryBtn}>
              {busy ? "Saving…" : "Save landing page"}
            </button>
            <a href={previewUrl} target="_blank" rel="noreferrer" style={{ ...ghostBtn, color: RED }}>
              Preview →
            </a>
          </div>
        </div>
      )}

      {msg && (
        <p
          style={{
            fontSize: 13,
            marginTop: 14,
            color: /saved|generated|updated/i.test(msg) ? "#2e7d32" : MUTED,
          }}
        >
          {msg}
        </p>
      )}
    </div>
  );
}

function AdminField({
  label,
  value,
  onChange,
  textarea,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  textarea?: boolean;
}) {
  return (
    <label style={{ display: "block" }}>
      <span style={{ fontSize: 13, color: MUTED }}>{label}</span>
      {textarea ? (
        <textarea
          style={{ ...field, marginTop: 4, minHeight: 80, resize: "vertical" }}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          style={{ ...field, marginTop: 4 }}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  );
}

function AdminImage({
  label,
  imagePath,
  promptValue,
  busy,
  onRegen,
}: {
  label: string;
  imagePath: string | null;
  promptValue: string;
  busy: boolean;
  onRegen: (prompt: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const effective = (prompt.trim() || promptValue || "").trim();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span style={{ fontSize: 13, color: MUTED }}>{label}</span>
      {imagePath ? (
        <img
          src={`/api/storage${imagePath}`}
          alt=""
          style={{
            width: "100%",
            maxWidth: 420,
            aspectRatio: "16 / 9",
            objectFit: "cover",
            borderRadius: 8,
            border: `1px solid ${LINE}`,
          }}
        />
      ) : (
        <p style={{ fontSize: 12, color: MUTED, margin: 0 }}>No image yet.</p>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          style={{ ...field, flex: "1 1 240px" }}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe the image (optional — uses the heading otherwise)"
        />
        <button
          onClick={() => onRegen(effective)}
          disabled={busy || effective.length < 2}
          style={secondaryBtn}
        >
          {imagePath ? "Replace image" : "Generate image"}
        </button>
      </div>
    </div>
  );
}

// ── Offers ─────────────────────────────────────────────────────────────────

type Offer = {
  id: number;
  facultyUserId: number;
  authorName: string | null;
  authorEmail: string | null;
  authorInstitution: string | null;
  title: string;
  summary: string | null;
  bodyHtml: string | null;
  status: "offered" | "accepted" | "declined";
  declineReason: string | null;
  resultingPostId: number | null;
  createdAt: string;
};

const offerPill: Record<Offer["status"], { bg: string; fg: string }> = {
  offered: { bg: "#F3E9D8", fg: "#8a6a5a" },
  accepted: { bg: "#E3F0E3", fg: "#2f6b3a" },
  declined: { bg: "#F3E0DE", fg: RED },
};

function OffersTab() {
  const [offers, setOffers] = useState<Offer[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [pick, setPick] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [banner, setBanner] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(() => {
    api("/api/newsletter/offers").then((d) => setOffers(d.offers)).catch(() => {});
    api("/api/newsletter/issues").then((d) => setIssues(d.issues)).catch(() => {});
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const openIssues = issues.filter((i) => i.status !== "sent");

  async function accept(o: Offer) {
    const issueId = pick[o.id] ?? openIssues[0]?.id;
    if (!issueId) {
      setBanner({ kind: "err", text: "Create a draft issue first." });
      return;
    }
    setBusy(o.id);
    try {
      await api(`/api/newsletter/offers/${o.id}/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ issueId }),
      });
      setBanner({ kind: "ok", text: `Accepted "${o.title}" into the issue.` });
      load();
    } catch (e) {
      setBanner({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function decline(o: Offer) {
    const reason = window.prompt("Reason for declining (optional, shared with faculty):", "");
    if (reason === null) return;
    setBusy(o.id);
    try {
      await api(`/api/newsletter/offers/${o.id}/decline`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      setBanner({ kind: "ok", text: `Declined "${o.title}".` });
      load();
    } catch (e) {
      setBanner({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const pending = offers.filter((o) => o.status === "offered");
  const resolved = offers.filter((o) => o.status !== "offered");

  return (
    <div style={{ marginTop: 24 }}>
      {banner && (
        <div
          style={{
            marginBottom: 16,
            padding: "10px 14px",
            borderRadius: 8,
            fontSize: 14,
            background: banner.kind === "ok" ? "#E3F0E3" : "#F3E0DE",
            color: banner.kind === "ok" ? "#2f6b3a" : RED,
          }}
        >
          {banner.text}
        </div>
      )}

      <h2 style={{ fontFamily: SERIF, fontWeight: 500, fontSize: 20, margin: "0 0 12px" }}>
        Pending offers
      </h2>
      {pending.length === 0 ? (
        <p style={{ color: MUTED, fontSize: 14 }}>No offers awaiting review.</p>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {pending.map((o) => (
            <div key={o.id} style={card} data-testid={`offer-${o.id}`}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
                <div style={{ fontFamily: SERIF, fontSize: 17, fontWeight: 600 }}>{o.title}</div>
                <span style={{ fontSize: 12, color: MUTED }}>
                  {o.authorName ?? o.authorEmail ?? `Faculty #${o.facultyUserId}`}
                  {o.authorInstitution ? ` · ${o.authorInstitution}` : ""}
                </span>
              </div>
              {o.summary && <p style={{ color: MUTED, fontSize: 14, margin: "6px 0 0" }}>{o.summary}</p>}
              {o.bodyHtml && (
                <p style={{ color: INK, fontSize: 13, margin: "8px 0 0", whiteSpace: "pre-wrap", maxHeight: 120, overflow: "auto" }}>
                  {o.bodyHtml}
                </p>
              )}
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 14, flexWrap: "wrap" }}>
                <select
                  value={pick[o.id] ?? openIssues[0]?.id ?? ""}
                  onChange={(e) => setPick((p) => ({ ...p, [o.id]: Number(e.target.value) }))}
                  style={{ ...field, width: "auto", minWidth: 200 }}
                  data-testid={`offer-issue-${o.id}`}
                >
                  {openIssues.length === 0 ? (
                    <option value="">No draft issues</option>
                  ) : (
                    openIssues.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.title} ({i.status})
                      </option>
                    ))
                  )}
                </select>
                <button
                  onClick={() => accept(o)}
                  disabled={busy === o.id || openIssues.length === 0}
                  style={{ ...primaryBtn, opacity: busy === o.id || openIssues.length === 0 ? 0.5 : 1 }}
                  data-testid={`offer-accept-${o.id}`}
                >
                  Accept into issue
                </button>
                <button
                  onClick={() => decline(o)}
                  disabled={busy === o.id}
                  style={secondaryBtn}
                  data-testid={`offer-decline-${o.id}`}
                >
                  Decline
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {resolved.length > 0 && (
        <>
          <h2 style={{ fontFamily: SERIF, fontWeight: 500, fontSize: 20, margin: "28px 0 12px" }}>
            Reviewed
          </h2>
          <div style={{ display: "grid", gap: 8 }}>
            {resolved.map((o) => {
              const p = offerPill[o.status];
              return (
                <div key={o.id} style={{ ...card, display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
                  <div>
                    <span style={{ fontWeight: 600 }}>{o.title}</span>
                    <span style={{ color: MUTED, fontSize: 13, marginLeft: 8 }}>
                      {o.authorName ?? o.authorEmail ?? `#${o.facultyUserId}`}
                      {o.authorInstitution ? ` · ${o.authorInstitution}` : ""}
                    </span>
                    {o.status === "declined" && o.declineReason && (
                      <div style={{ color: RED, fontSize: 12, marginTop: 4 }}>Note: {o.declineReason}</div>
                    )}
                  </div>
                  <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".1em", padding: "3px 8px", borderRadius: 6, background: p.bg, color: p.fg }}>
                    {o.status}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ── Credits ────────────────────────────────────────────────────────────────

type Credit = {
  id: number;
  authorName: string | null;
  authorEmail: string | null;
  issueId: number;
  postTitle: string | null;
  amountCents: number;
  status: "pending" | "approved" | "paid";
  note: string | null;
  createdAt: string;
  paidAt: string | null;
};

const creditPill: Record<Credit["status"], { bg: string; fg: string }> = {
  pending: { bg: "#F3E9D8", fg: "#8a6a5a" },
  approved: { bg: "#E6ECF6", fg: "#2a4d8f" },
  paid: { bg: "#E3F0E3", fg: "#2f6b3a" },
};

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function CreditsTab() {
  const [credits, setCredits] = useState<Credit[]>([]);
  const [summary, setSummary] = useState<{ count: number; totalCents: number; outstandingCents: number } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(() => {
    api("/api/newsletter/credits")
      .then((d) => {
        setCredits(d.credits);
        setSummary(d.summary);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function setStatus(c: Credit, status: Credit["status"]) {
    setBusy(c.id);
    try {
      await api(`/api/newsletter/credits/${c.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      load();
    } catch {
      /* surfaced via reload */
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20, alignItems: "center" }}>
        <div style={{ ...card, flex: "1 1 160px" }}>
          <div style={{ fontFamily: SERIF, fontSize: 24 }} data-testid="credits-count">{summary?.count ?? 0}</div>
          <div style={{ color: MUTED, fontSize: 12 }}>Credits</div>
        </div>
        <div style={{ ...card, flex: "1 1 160px" }}>
          <div style={{ fontFamily: SERIF, fontSize: 24 }} data-testid="credits-outstanding">{money(summary?.outstandingCents ?? 0)}</div>
          <div style={{ color: MUTED, fontSize: 12 }}>Outstanding</div>
        </div>
        <div style={{ ...card, flex: "1 1 160px" }}>
          <div style={{ fontFamily: SERIF, fontSize: 24 }} data-testid="credits-total">{money(summary?.totalCents ?? 0)}</div>
          <div style={{ color: MUTED, fontSize: 12 }}>Total minted</div>
        </div>
        <a href="/api/newsletter/credits.csv" style={{ ...secondaryBtn, textDecoration: "none", display: "inline-block" }} data-testid="link-credits-csv">
          Export CSV
        </a>
      </div>

      {credits.length === 0 ? (
        <p style={{ color: MUTED, fontSize: 14 }}>No credits yet. They appear when an issue carrying a faculty post is sent.</p>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {credits.map((c) => {
            const p = creditPill[c.status];
            return (
              <div key={c.id} style={{ ...card, display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }} data-testid={`credit-${c.id}`}>
                <div>
                  <div style={{ fontWeight: 600 }}>{c.postTitle ?? `Issue #${c.issueId}`}</div>
                  <div style={{ color: MUTED, fontSize: 13 }}>
                    {c.authorName ?? c.authorEmail ?? "—"} · {new Date(c.createdAt).toLocaleDateString()}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <span style={{ fontFamily: SERIF, fontSize: 18 }}>{money(c.amountCents)}</span>
                  <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".1em", padding: "3px 8px", borderRadius: 6, background: p.bg, color: p.fg }}>
                    {c.status}
                  </span>
                  {c.status === "pending" && (
                    <button onClick={() => setStatus(c, "approved")} disabled={busy === c.id} style={secondaryBtn} data-testid={`credit-approve-${c.id}`}>
                      Approve
                    </button>
                  )}
                  {c.status !== "paid" && (
                    <button onClick={() => setStatus(c, "paid")} disabled={busy === c.id} style={{ ...primaryBtn, opacity: busy === c.id ? 0.5 : 1 }} data-testid={`credit-paid-${c.id}`}>
                      Mark paid
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Shared styles ────────────────────────────────────────────────────────────

function Label({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: MUTED, margin: "0 0 6px", ...style }}>{children}</div>;
}

const card: React.CSSProperties = {
  background: CARD,
  border: `1px solid ${LINE}`,
  borderRadius: 12,
  padding: 16,
};
const field: React.CSSProperties = {
  width: "100%",
  border: `1px solid ${LINE}`,
  borderRadius: 8,
  padding: "10px 12px",
  fontSize: 14,
  fontFamily: SANS,
  background: "#fff",
  color: INK,
  outline: "none",
  boxSizing: "border-box",
};
const primaryBtn: React.CSSProperties = {
  background: RED,
  color: "#fff",
  border: "none",
  borderRadius: 8,
  padding: "10px 14px",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: SANS,
  whiteSpace: "nowrap",
};
const secondaryBtn: React.CSSProperties = {
  background: "#fff",
  color: INK,
  border: `1px solid ${LINE}`,
  borderRadius: 8,
  padding: "10px 14px",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: SANS,
  whiteSpace: "nowrap",
};
const ghostBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  color: MUTED,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: SANS,
  padding: 0,
};
