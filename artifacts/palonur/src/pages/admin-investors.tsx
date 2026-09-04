import { useEffect, useRef, useState } from "react";

const API = "/api";
const RED = "#8B1A1A";
const INK = "#1a0505";
const BORDER = "#e8e0e0";

interface AdminInvestor {
  id: number;
  name: string;
  email: string;
  role: string | null;
  status: string;
  commitmentCents: number | null;
  notes: string | null;
  newsletterAccess: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}
interface DeckMeta {
  slug: string;
  title: string;
  description: string | null;
  listed: boolean;
  hasHtml: boolean;
}
interface UpdateRow {
  id: number;
  title: string;
  bodyHtml: string | null;
  pinned: boolean;
  publishedAt: string;
}
interface DocRow {
  id: number;
  title: string;
  description: string | null;
  objectPath: string | null;
  externalUrl: string | null;
  sizeBytes: number | null;
  contentType: string | null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 100 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function fileTypeLabel(contentType: string | null): string | null {
  if (!contentType) return null;
  const map: Record<string, string> = {
    "application/pdf": "PDF",
    "application/zip": "ZIP",
    "application/msword": "DOC",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
    "application/vnd.ms-excel": "XLS",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
    "application/vnd.ms-powerpoint": "PPT",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PPTX",
    "text/plain": "TXT",
    "text/csv": "CSV",
    "image/png": "PNG",
    "image/jpeg": "JPG",
  };
  if (map[contentType]) return map[contentType];
  const sub = contentType.split("/")[1];
  if (!sub) return null;
  return sub.split(/[.+]/).pop()!.toUpperCase().slice(0, 5);
}

function fileMetaLabel(d: { sizeBytes: number | null; contentType: string | null }): string | null {
  const type = fileTypeLabel(d.contentType);
  const size = typeof d.sizeBytes === "number" ? formatBytes(d.sizeBytes) : null;
  return [type, size].filter(Boolean).join(" · ") || null;
}
interface ReqRow {
  id: number;
  investorId: number;
  subject: string;
  body: string | null;
  status: string;
  responseHtml: string | null;
  respondedAt: string | null;
  createdAt: string;
  investorName: string | null;
  investorEmail: string | null;
}
interface Settings {
  hotlineNumber: string | null;
  hotlineNote: string;
  capTableNote: string;
}

const STATUSES = ["lead", "committed", "pending", "passed"];

async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
  return r.json();
}

function money(cents: number | null) {
  if (cents == null) return "—";
  return `$${(cents / 100).toLocaleString("en-US")}`;
}
function fmt(s: string | null) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const card: React.CSSProperties = {
  background: "#fff",
  border: `1px solid ${BORDER}`,
  borderRadius: 14,
  padding: 20,
};
const input: React.CSSProperties = {
  padding: "8px 11px",
  border: `1px solid ${BORDER}`,
  borderRadius: 8,
  fontSize: 13,
  fontFamily: "inherit",
};
const btn: React.CSSProperties = {
  background: RED,
  color: "#fff",
  border: "none",
  borderRadius: 8,
  padding: "8px 16px",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};
const ghostBtn: React.CSSProperties = {
  background: "transparent",
  color: "#777",
  border: `1px solid ${BORDER}`,
  borderRadius: 8,
  padding: "6px 12px",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

function SubHead({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 16, fontWeight: 700, color: INK, margin: "0 0 12px" }}>{children}</div>
  );
}

export default function InvestorsPanel() {
  const [section, setSection] = useState<"investors" | "updates" | "documents" | "requests" | "settings">("investors");

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: INK, marginBottom: 4 }}>Investor Portal</div>
        <div style={{ fontSize: 13, color: "#888" }}>
          Manage the invite-only investor allowlist, deck access, updates, and incoming requests. Commitment
          amounts are visible here only and never sent to investors.
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 18, flexWrap: "wrap" }}>
        {(["investors", "updates", "documents", "requests", "settings"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSection(s)}
            style={{
              ...ghostBtn,
              background: section === s ? RED : "transparent",
              color: section === s ? "#fff" : "#777",
              borderColor: section === s ? RED : BORDER,
              textTransform: "capitalize",
            }}
          >
            {s}
          </button>
        ))}
      </div>
      {section === "investors" && <InvestorsSection />}
      {section === "updates" && <UpdatesSection />}
      {section === "documents" && <DocumentsSection />}
      {section === "requests" && <RequestsSection />}
      {section === "settings" && <SettingsSection />}
    </div>
  );
}

interface EditDraft {
  name: string;
  email: string;
  role: string;
  status: string;
  commitment: string;
  notes: string;
  newsletterAccess: boolean;
}

function InvestorsSection() {
  const [investors, setInvestors] = useState<AdminInvestor[]>([]);
  const [decks, setDecks] = useState<DeckMeta[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [grants, setGrants] = useState<string[]>([]);
  const [linkOut, setLinkOut] = useState<Record<number, string>>({});
  const [form, setForm] = useState({ name: "", email: "", role: "", status: "pending", commitment: "", notes: "" });
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    const [a, b] = await Promise.all([
      api<{ investors: AdminInvestor[] }>("/investor-admin/investors"),
      api<{ decks: DeckMeta[] }>("/investor-admin/decks"),
    ]);
    setInvestors(a.investors);
    setDecks(b.decks);
  }
  useEffect(() => {
    load().catch((e) => setErr(String(e)));
  }, []);

  async function expand(id: number) {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    const g = await api<{ grants: string[] }>(`/investor-admin/investors/${id}/grants`);
    setGrants(g.grants);
    setExpanded(id);
  }

  async function toggleGrant(id: number, slug: string, has: boolean) {
    if (has) {
      await api(`/investor-admin/investors/${id}/grants/${slug}`, { method: "DELETE" });
      setGrants((g) => g.filter((s) => s !== slug));
    } else {
      await api(`/investor-admin/investors/${id}/grants`, {
        method: "POST",
        body: JSON.stringify({ deckSlug: slug }),
      });
      setGrants((g) => [...g, slug]);
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await api("/investor-admin/investors", {
        method: "POST",
        body: JSON.stringify({
          name: form.name,
          email: form.email,
          role: form.role || null,
          status: form.status,
          commitmentCents: form.commitment ? Math.round(parseFloat(form.commitment) * 100) : null,
          notes: form.notes || null,
        }),
      });
      setForm({ name: "", email: "", role: "", status: "pending", commitment: "", notes: "" });
      await load();
    } catch (e) {
      setErr(String(e));
    }
  }

  async function patch(id: number, set: Record<string, unknown>) {
    await api(`/investor-admin/investors/${id}`, { method: "PATCH", body: JSON.stringify(set) });
    await load();
  }

  function startEdit(inv: AdminInvestor) {
    if (editing === inv.id) {
      setEditing(null);
      setDraft(null);
      return;
    }
    setEditing(inv.id);
    setDraft({
      name: inv.name,
      email: inv.email,
      role: inv.role ?? "",
      status: inv.status,
      commitment: inv.commitmentCents != null ? String(inv.commitmentCents / 100) : "",
      notes: inv.notes ?? "",
      newsletterAccess: inv.newsletterAccess,
    });
  }

  async function saveEdit(id: number) {
    if (!draft) return;
    setErr(null);
    try {
      await patch(id, {
        name: draft.name.trim(),
        email: draft.email.trim(),
        role: draft.role.trim() || null,
        status: draft.status,
        commitmentCents: draft.commitment ? Math.round(parseFloat(draft.commitment) * 100) : null,
        notes: draft.notes.trim() || null,
        newsletterAccess: draft.newsletterAccess,
      });
      setEditing(null);
      setDraft(null);
    } catch (e) {
      setErr(String(e));
    }
  }

  async function genLink(id: number, send: boolean) {
    const r = await api<{ link: string; sent: boolean }>(
      `/investor-admin/investors/${id}/magic-link`,
      { method: "POST", body: JSON.stringify({ send }) },
    );
    setLinkOut((m) => ({ ...m, [id]: send ? "Sent ✓" : r.link }));
  }

  async function remove(id: number) {
    if (!confirm("Remove this investor and all their access?")) return;
    await api(`/investor-admin/investors/${id}`, { method: "DELETE" });
    await load();
  }

  const totals = (() => {
    const sumFor = (...statuses: string[]) =>
      investors
        .filter((i) => statuses.includes(i.status))
        .reduce((s, i) => s + (i.commitmentCents ?? 0), 0);
    return {
      committed: sumFor("lead", "committed"),
      lead: sumFor("lead"),
      committedOnly: sumFor("committed"),
      pending: sumFor("pending"),
    };
  })();

  return (
    <div style={{ display: "grid", gap: 18 }}>
      {err && <div style={{ color: RED, fontSize: 13 }}>{err}</div>}
      <div style={card}>
        <SubHead>Add investor</SubHead>
        <form onSubmit={create} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input style={{ ...input, flex: "1 1 140px" }} placeholder="Name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input style={{ ...input, flex: "1 1 180px" }} placeholder="Email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input style={{ ...input, flex: "0 1 120px" }} placeholder="Role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} />
          <select style={input} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <input style={{ ...input, flex: "0 1 130px" }} placeholder="$ commitment" value={form.commitment} onChange={(e) => setForm({ ...form, commitment: e.target.value })} />
          <button type="submit" style={btn}>Add</button>
        </form>
      </div>

      <div style={card}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 12, color: "#888", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>Total committed</div>
            <div style={{ fontSize: 26, fontWeight: 800, color: "#1f7a4d" }}>{money(totals.committed)}</div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: "#8a5a00", background: "#fdf3dc", border: "1px solid #f0e0b0", borderRadius: 999, padding: "5px 11px" }}>
              Lead {money(totals.lead)}
            </span>
            <span style={{ fontSize: 12, fontWeight: 700, color: "#1f7a4d", background: "#eaf6ef", border: "1px solid #c5e6d2", borderRadius: 999, padding: "5px 11px" }}>
              Committed {money(totals.committedOnly)}
            </span>
            <span style={{ fontSize: 12, fontWeight: 700, color: "#777", background: "#f4f1f1", border: `1px solid ${BORDER}`, borderRadius: 999, padding: "5px 11px" }}>
              Pending {money(totals.pending)}
            </span>
          </div>
        </div>
        <SubHead>Allowlist ({investors.length})</SubHead>
        <div style={{ display: "grid", gap: 8 }}>
          {investors.map((inv) => (
            <div key={inv.id} style={{ border: `1px solid ${BORDER}`, borderRadius: 10, padding: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 160px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span style={{ fontWeight: 700, color: INK }}>{inv.name}</span>
                    {inv.status === "lead" && (
                      <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.8, color: "#fff", background: "#c08a00", borderRadius: 5, padding: "2px 7px" }}>LEAD</span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: "#888" }}>{inv.email}{inv.role ? ` · ${inv.role}` : ""}</div>
                </div>
                <select value={inv.status} onChange={(e) => patch(inv.id, { status: e.target.value })} style={{ ...input, fontSize: 12 }}>
                  {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#1f7a4d", minWidth: 70, textAlign: "right" }}>{money(inv.commitmentCents)}</div>
                <button style={{ ...ghostBtn, background: editing === inv.id ? RED : "transparent", color: editing === inv.id ? "#fff" : "#777" }} onClick={() => startEdit(inv)}>{editing === inv.id ? "Close" : "Edit"}</button>
                <button style={ghostBtn} onClick={() => expand(inv.id)}>{expanded === inv.id ? "Hide" : "Decks"}</button>
                <button style={ghostBtn} onClick={() => genLink(inv.id, false)}>Link</button>
                <button style={ghostBtn} onClick={() => genLink(inv.id, true)}>Email link</button>
                <button style={{ ...ghostBtn, color: RED, borderColor: "#e8b0b0" }} onClick={() => remove(inv.id)}>✕</button>
              </div>
              {inv.notes && editing !== inv.id && (
                <div style={{ marginTop: 6, fontSize: 12, color: "#8a6a5a", fontStyle: "italic" }}>📝 {inv.notes}</div>
              )}
              {editing === inv.id && draft && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px dashed ${BORDER}`, display: "grid", gap: 8 }}>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <input style={{ ...input, flex: "1 1 140px" }} placeholder="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                    <input style={{ ...input, flex: "1 1 180px" }} placeholder="Email" type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <input style={{ ...input, flex: "1 1 130px" }} placeholder="Role" value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })} />
                    <select style={input} value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
                      {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <input style={{ ...input, flex: "0 1 140px" }} placeholder="$ commitment" value={draft.commitment} onChange={(e) => setDraft({ ...draft, commitment: e.target.value })} />
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#777" }}>
                      <input type="checkbox" checked={draft.newsletterAccess} onChange={(e) => setDraft({ ...draft, newsletterAccess: e.target.checked })} /> Newsletter
                    </label>
                  </div>
                  <textarea style={{ ...input, minHeight: 60, resize: "vertical" }} placeholder="Private notes (admin-only — never shown to investors)" value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
                  <div>
                    <button style={btn} onClick={() => saveEdit(inv.id)}>Save changes</button>
                  </div>
                </div>
              )}
              {linkOut[inv.id] && (
                <div style={{ marginTop: 8, fontSize: 12, color: "#555", wordBreak: "break-all", background: "#faf7f7", padding: 8, borderRadius: 6 }}>
                  {linkOut[inv.id]}
                </div>
              )}
              {expanded === inv.id && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px dashed ${BORDER}` }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#777", marginBottom: 8 }}>Deck access</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 6 }}>
                    {decks.map((d) => {
                      const has = grants.includes(d.slug);
                      return (
                        <div key={d.slug} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", flex: 1, minWidth: 0 }}>
                            <input type="checkbox" checked={has} onChange={() => toggleGrant(inv.id, d.slug, has)} />
                            <span>{d.title}{!d.hasHtml && <span style={{ color: "#c00", fontSize: 11 }}> (no file)</span>}</span>
                          </label>
                          {d.hasHtml && (
                            <a
                              href={`${API}/investor-admin/decks/${d.slug}/download`}
                              style={{ color: RED, fontWeight: 700, fontSize: 12, textDecoration: "none", whiteSpace: "nowrap" }}
                              title="Download this paper to send it yourself"
                            >
                              ↓ Download
                            </a>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function UpdatesSection() {
  const [updates, setUpdates] = useState<UpdateRow[]>([]);
  const [form, setForm] = useState({ title: "", bodyHtml: "", pinned: false });

  async function load() {
    const r = await api<{ updates: UpdateRow[] }>("/investor-admin/updates");
    setUpdates(r.updates);
  }
  useEffect(() => {
    load().catch(() => {});
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    await api("/investor-admin/updates", { method: "POST", body: JSON.stringify(form) });
    setForm({ title: "", bodyHtml: "", pinned: false });
    await load();
  }
  async function del(id: number) {
    if (!confirm("Delete update?")) return;
    await api(`/investor-admin/updates/${id}`, { method: "DELETE" });
    await load();
  }
  async function togglePin(u: UpdateRow) {
    await api(`/investor-admin/updates/${u.id}`, { method: "PATCH", body: JSON.stringify({ pinned: !u.pinned }) });
    await load();
  }

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div style={card}>
        <SubHead>Post an update</SubHead>
        <form onSubmit={create} style={{ display: "grid", gap: 8 }}>
          <input style={input} placeholder="Title" required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <textarea style={{ ...input, minHeight: 90, resize: "vertical" }} placeholder="Body (HTML allowed)" value={form.bodyHtml} onChange={(e) => setForm({ ...form, bodyHtml: e.target.value })} />
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={form.pinned} onChange={(e) => setForm({ ...form, pinned: e.target.checked })} /> Pin to top
          </label>
          <button type="submit" style={{ ...btn, justifySelf: "start" }}>Publish</button>
        </form>
      </div>
      <div style={card}>
        <SubHead>Published ({updates.length})</SubHead>
        <div style={{ display: "grid", gap: 10 }}>
          {updates.map((u) => (
            <div key={u.id} style={{ border: `1px solid ${BORDER}`, borderRadius: 10, padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <div style={{ fontWeight: 700, color: INK }}>{u.pinned ? "★ " : ""}{u.title}</div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button style={ghostBtn} onClick={() => togglePin(u)}>{u.pinned ? "Unpin" : "Pin"}</button>
                  <button style={{ ...ghostBtn, color: RED, borderColor: "#e8b0b0" }} onClick={() => del(u.id)}>Delete</button>
                </div>
              </div>
              <div style={{ fontSize: 12, color: "#999", marginTop: 2 }}>{fmt(u.publishedAt)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DocumentsSection() {
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [form, setForm] = useState({ title: "", description: "", externalUrl: "" });
  const [upload, setUpload] = useState<{ objectPath: string; name: string; sizeBytes: number; contentType: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function load() {
    const r = await api<{ documents: DocRow[] }>("/investor-admin/documents");
    setDocs(r.documents);
  }
  useEffect(() => {
    load().catch(() => {});
  }, []);

  async function uploadFile(file: File) {
    setErr(null);
    setUploading(true);
    try {
      const objectPath = await requestUpload(file);
      setUpload({
        objectPath,
        name: file.name,
        sizeBytes: file.size,
        contentType: file.type || "application/octet-stream",
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function clearUpload() {
    setUpload(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!upload && !form.externalUrl.trim()) {
      setErr("Upload a file or provide an external URL.");
      return;
    }
    try {
      await api("/investor-admin/documents", {
        method: "POST",
        body: JSON.stringify({
          title: form.title,
          description: form.description,
          externalUrl: form.externalUrl.trim() || undefined,
          objectPath: upload?.objectPath,
          sizeBytes: upload?.sizeBytes,
          contentType: upload?.contentType,
        }),
      });
      setForm({ title: "", description: "", externalUrl: "" });
      clearUpload();
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not add document");
    }
  }
  async function del(id: number) {
    if (!confirm("Delete document?")) return;
    await api(`/investor-admin/documents/${id}`, { method: "DELETE" });
    await load();
  }

  async function requestUpload(file: File): Promise<string> {
    const meta = await api<{ uploadURL: string; objectPath: string }>(
      "/storage/uploads/request-url",
      {
        method: "POST",
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
      },
    );
    if (!meta.uploadURL) throw new Error("Could not get an upload URL");
    const putRes = await fetch(meta.uploadURL, {
      method: "PUT",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    if (!putRes.ok) throw new Error("Upload failed");
    return meta.objectPath;
  }

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div style={card}>
        <SubHead>Add a data-room document</SubHead>
        <form onSubmit={create} style={{ display: "grid", gap: 8 }}>
          <input style={input} placeholder="Title" required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <input style={input} placeholder="Description (optional)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />

          <div style={{ display: "grid", gap: 6 }}>
            <input
              ref={fileRef}
              type="file"
              style={{ fontSize: 13 }}
              disabled={uploading}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadFile(f);
              }}
            />
            {uploading && <div style={{ fontSize: 12, color: "#888" }}>Uploading…</div>}
            {upload && (
              <div style={{ fontSize: 12, color: INK, display: "flex", gap: 8, alignItems: "center" }}>
                <span>📎 {upload.name}</span>
                {fileMetaLabel(upload) && (
                  <span style={{ color: "#888" }}>({fileMetaLabel(upload)})</span>
                )}
                <button type="button" style={{ ...ghostBtn, padding: "2px 8px", fontSize: 11 }} onClick={clearUpload}>Remove</button>
              </div>
            )}
          </div>

          <div style={{ fontSize: 12, color: "#999", textAlign: "center" }}>— or —</div>
          <input style={input} placeholder="External URL (https://…)" value={form.externalUrl} onChange={(e) => setForm({ ...form, externalUrl: e.target.value })} />

          {err && <div style={{ fontSize: 12, color: RED }}>{err}</div>}
          <button type="submit" disabled={uploading} style={{ ...btn, justifySelf: "start", opacity: uploading ? 0.6 : 1 }}>Add document</button>
        </form>
        <div style={{ fontSize: 12, color: "#999", marginTop: 8 }}>
          Upload a PDF/deck directly, or link to a Drive/Dropbox/Notion file.
        </div>
      </div>
      <div style={card}>
        <SubHead>Documents ({docs.length})</SubHead>
        <div style={{ display: "grid", gap: 8 }}>
          {docs.map((d) => (
            <DocRowItem
              key={d.id}
              doc={d}
              requestUpload={requestUpload}
              onChanged={load}
              onDelete={() => del(d.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function DocRowItem({
  doc,
  requestUpload,
  onChanged,
  onDelete,
}: {
  doc: DocRow;
  requestUpload: (file: File) => Promise<string>;
  onChanged: () => Promise<void>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(doc.title);
  const [description, setDescription] = useState(doc.description ?? "");
  const [externalUrl, setExternalUrl] = useState(doc.externalUrl ?? "");
  const [newUpload, setNewUpload] = useState<{ objectPath: string; name: string; sizeBytes: number; contentType: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const href = doc.externalUrl
    ? doc.externalUrl
    : doc.objectPath
      ? `/api/storage${doc.objectPath.startsWith("/") ? "" : "/"}${doc.objectPath}`
      : null;

  function startEdit() {
    setTitle(doc.title);
    setDescription(doc.description ?? "");
    setExternalUrl(doc.externalUrl ?? "");
    setNewUpload(null);
    setErr(null);
    setEditing(true);
  }

  async function replaceFile(file: File) {
    setErr(null);
    setUploading(true);
    try {
      const objectPath = await requestUpload(file);
      setNewUpload({
        objectPath,
        name: file.name,
        sizeBytes: file.size,
        contentType: file.type || "application/octet-stream",
      });
      setExternalUrl("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function save() {
    setErr(null);
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setErr("Title is required.");
      return;
    }
    const trimmedUrl = externalUrl.trim();
    // Make sure the document keeps at least one source after the edit.
    const willHaveSource = !!newUpload || !!trimmedUrl || (!!doc.objectPath && !trimmedUrl);
    if (!willHaveSource) {
      setErr("Provide an external URL or replace the file.");
      return;
    }
    const body: Record<string, unknown> = {
      title: trimmedTitle,
      description: trimmedDescription(description),
    };
    if (newUpload) {
      body.objectPath = newUpload.objectPath;
      body.sizeBytes = newUpload.sizeBytes;
      body.contentType = newUpload.contentType;
    } else if (trimmedUrl) {
      body.externalUrl = trimmedUrl;
    }
    setSaving(true);
    try {
      await api(`/investor-admin/documents/${doc.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setEditing(false);
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save changes");
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div style={{ border: `1px solid ${BORDER}`, borderRadius: 10, padding: 12, display: "flex", justifyContent: "space-between", gap: 8 }}>
        <div>
          <div style={{ fontWeight: 700, color: INK }}>{doc.title}</div>
          {doc.description && <div style={{ fontSize: 12, color: "#888" }}>{doc.description}</div>}
          {href && (
            <a href={href} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: RED }}>
              {doc.externalUrl ? doc.externalUrl : "Uploaded file — view / download"}
            </a>
          )}
          {!doc.externalUrl && fileMetaLabel(doc) && (
            <div style={{ fontSize: 12, color: "#999", marginTop: 2 }}>{fileMetaLabel(doc)}</div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          <button style={ghostBtn} onClick={startEdit}>Edit</button>
          <button style={{ ...ghostBtn, color: RED, borderColor: "#e8b0b0" }} onClick={onDelete}>Delete</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ border: `1px solid ${BORDER}`, borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
      <input style={input} placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <input style={input} placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />

      <div style={{ display: "grid", gap: 6 }}>
        <div style={{ fontSize: 12, color: "#888" }}>
          {newUpload
            ? `New file: ${newUpload.name}`
            : doc.objectPath
              ? "Current source: uploaded file"
              : doc.externalUrl
                ? "Current source: external link"
                : "No source"}
        </div>
        <input
          ref={fileRef}
          type="file"
          style={{ fontSize: 13 }}
          disabled={uploading}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) replaceFile(f);
          }}
        />
        {uploading && <div style={{ fontSize: 12, color: "#888" }}>Uploading…</div>}
        {newUpload && (
          <div style={{ fontSize: 12, color: INK, display: "flex", gap: 8, alignItems: "center" }}>
            <span>📎 {newUpload.name}</span>
            <button
              type="button"
              style={{ ...ghostBtn, padding: "2px 8px", fontSize: 11 }}
              onClick={() => {
                setNewUpload(null);
                if (fileRef.current) fileRef.current.value = "";
              }}
            >
              Undo
            </button>
          </div>
        )}
      </div>

      <div style={{ fontSize: 12, color: "#999", textAlign: "center" }}>— or —</div>
      <input
        style={input}
        placeholder="External URL (https://…)"
        value={externalUrl}
        disabled={!!newUpload}
        onChange={(e) => setExternalUrl(e.target.value)}
      />

      {err && <div style={{ fontSize: 12, color: RED }}>{err}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button style={{ ...btn, opacity: saving || uploading ? 0.6 : 1 }} disabled={saving || uploading} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button style={ghostBtn} disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
      </div>
    </div>
  );
}

function trimmedDescription(d: string): string | null {
  const t = d.trim();
  return t ? t : null;
}

function RequestsSection() {
  const [reqs, setReqs] = useState<ReqRow[]>([]);
  const [reply, setReply] = useState<Record<number, string>>({});

  async function load() {
    const r = await api<{ requests: ReqRow[] }>("/investor-admin/requests");
    setReqs(r.requests);
  }
  useEffect(() => {
    load().catch(() => {});
  }, []);

  async function respond(id: number) {
    const responseHtml = reply[id];
    await api(`/investor-admin/requests/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "answered", responseHtml }),
    });
    await load();
  }
  async function setStatus(id: number, status: string) {
    await api(`/investor-admin/requests/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
    await load();
  }

  return (
    <div style={card}>
      <SubHead>Requests ({reqs.length})</SubHead>
      {reqs.length === 0 && <div style={{ color: "#aaa", fontSize: 13 }}>No requests yet.</div>}
      <div style={{ display: "grid", gap: 12 }}>
        {reqs.map((r) => (
          <div key={r.id} style={{ border: `1px solid ${BORDER}`, borderRadius: 10, padding: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <div>
                <div style={{ fontWeight: 700, color: INK }}>{r.subject}</div>
                <div style={{ fontSize: 12, color: "#888" }}>{r.investorName} · {r.investorEmail} · {fmt(r.createdAt)}</div>
              </div>
              <select value={r.status} onChange={(e) => setStatus(r.id, e.target.value)} style={{ ...input, fontSize: 12 }}>
                {["open", "in_progress", "answered", "closed"].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            {r.body && <div style={{ fontSize: 13, color: "#555", marginTop: 6 }}>{r.body}</div>}
            {r.responseHtml ? (
              <div style={{ marginTop: 8, fontSize: 13, color: "#333", background: "#f5faf5", borderRadius: 6, padding: 8 }} dangerouslySetInnerHTML={{ __html: r.responseHtml }} />
            ) : (
              <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
                <input style={{ ...input, flex: 1 }} placeholder="Reply…" value={reply[r.id] ?? ""} onChange={(e) => setReply((m) => ({ ...m, [r.id]: e.target.value }))} />
                <button style={btn} onClick={() => respond(r.id)} disabled={!reply[r.id]}>Send</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function SettingsSection() {
  const [s, setS] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  const [resyncMsg, setResyncMsg] = useState<string | null>(null);

  async function load() {
    const r = await api<Settings>("/investor-admin/settings");
    setS(r);
  }
  useEffect(() => {
    load().catch(() => {});
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!s) return;
    await api("/investor-admin/settings", { method: "PUT", body: JSON.stringify(s) });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }
  async function resync() {
    setResyncMsg("Syncing…");
    const r = await api<{ synced?: number; withHtml?: number }>("/investor-admin/decks/resync", { method: "POST" });
    setResyncMsg(`Synced ${r.synced ?? "?"} decks (${r.withHtml ?? "?"} with HTML).`);
  }

  if (!s) return <div style={{ color: "#aaa" }}>Loading…</div>;

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div style={card}>
        <SubHead>Founder hotline</SubHead>
        <form onSubmit={save} style={{ display: "grid", gap: 8 }}>
          <label style={{ fontSize: 12, color: "#777" }}>Phone number (Karan's mobile — leave blank for placeholder)</label>
          <input style={input} placeholder="+1 …" value={s.hotlineNumber ?? ""} onChange={(e) => setS({ ...s, hotlineNumber: e.target.value })} />
          <label style={{ fontSize: 12, color: "#777" }}>Note shown above the number</label>
          <input style={input} value={s.hotlineNote} onChange={(e) => setS({ ...s, hotlineNote: e.target.value })} />
          <label style={{ fontSize: 12, color: "#777" }}>Cap-table faculty note</label>
          <textarea style={{ ...input, minHeight: 80, resize: "vertical" }} value={s.capTableNote} onChange={(e) => setS({ ...s, capTableNote: e.target.value })} />
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button type="submit" style={{ ...btn, justifySelf: "start" }}>Save</button>
            {saved && <span style={{ color: "#1f7a4d", fontSize: 13 }}>Saved ✓</span>}
          </div>
        </form>
      </div>
      <div style={card}>
        <SubHead>Decks</SubHead>
        <div style={{ fontSize: 13, color: "#888", marginBottom: 10 }}>
          Re-copy the canonical investor decks from the site's public folder into the gated store.
        </div>
        <button style={btn} onClick={resync}>Resync decks</button>
        {resyncMsg && <span style={{ marginLeft: 10, fontSize: 13, color: "#555" }}>{resyncMsg}</span>}
      </div>
    </div>
  );
}
