import { useEffect, useState } from "react";

const INK = "#0a0a0f";
const NIGHT = "#0a0a2a";
const PAPER = "#FAF8F4";
const CARD = "#fff";
const GOLD = "#8a6d28";
const GOLD_BG = "#C8A24B";
const TEXT = "#1a1a22";
const MUTED = "#6b6b76";
const BORDER = "#e8e2d6";
const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "-apple-system, BlinkMacSystemFont, 'Inter', sans-serif";

interface SelfInvestor {
  id: number;
  name: string;
  email: string;
  role: string | null;
  status: string;
  newsletterAccess: boolean;
}
interface Update {
  id: number;
  title: string;
  bodyHtml: string | null;
  pinned: boolean;
  publishedAt: string;
}
interface CapRow {
  holder: string;
  role: string;
  percent: number;
}
interface CapTable {
  rows: CapRow[];
  faculty: string[];
  facultyNote: string;
}
interface RosterEntry {
  id: number;
  name: string;
  role: string | null;
  status: string;
}
interface Deck {
  slug: string;
  title: string;
  description: string | null;
}
interface DocItem {
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
interface ReqItem {
  id: number;
  subject: string;
  body: string | null;
  status: string;
  responseHtml: string | null;
  respondedAt: string | null;
  createdAt: string;
}
interface CashFlowPlan {
  deckSlug: string;
  deckTitle: string | null;
  targetDate: string;
  totalCommittedCents: number;
  planText: string;
  updatedAt: string;
}
interface LeadSummary {
  totalCommittedCents: number;
  decks: Deck[];
  plan: CashFlowPlan | null;
}

function fmtUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}
interface Hotline {
  number: string | null;
  note: string;
}
interface Portal {
  investor: SelfInvestor;
  updates: Update[];
  capTable: CapTable;
  roster: RosterEntry[];
  decks: Deck[];
  documents: DocItem[];
  hotline: Hotline;
  newsletterAccess: boolean;
  requests: ReqItem[];
}

const STATUS_LABEL: Record<string, string> = {
  lead: "Lead",
  committed: "Committed",
  pending: "In conversation",
  passed: "Passed",
};
const STATUS_COLOR: Record<string, string> = {
  lead: "#1f7a4d",
  committed: "#1f7a4d",
  pending: "#8a6d28",
  passed: "#9a4a4a",
};

function fmtDate(s: string | null) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        background: CARD,
        border: `1px solid ${BORDER}`,
        borderRadius: 16,
        padding: 28,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        letterSpacing: ".16em",
        textTransform: "uppercase",
        color: GOLD,
        fontWeight: 700,
        marginBottom: 14,
      }}
    >
      {children}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 700,
        color: STATUS_COLOR[status] ?? MUTED,
        background: `${STATUS_COLOR[status] ?? MUTED}14`,
        borderRadius: 999,
        padding: "3px 10px",
        whiteSpace: "nowrap",
      }}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export default function Investor() {
  const [portal, setPortal] = useState<Portal | null>(null);
  const [loading, setLoading] = useState(true);
  const [authed, setAuthed] = useState<boolean | null>(null);

  // request form
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // lead-only (platform admin) panel
  const [lead, setLead] = useState<LeadSummary | null>(null);
  const [planDeck, setPlanDeck] = useState("");
  const [planDate, setPlanDate] = useState("");
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Investor portal · Palonur";
    document.body.style.background = PAPER;
    return () => {
      document.body.style.background = "";
    };
  }, []);

  async function load() {
    setLoading(true);
    try {
      const r = await fetch("/api/investor/portal", { credentials: "include" });
      if (r.status === 401) {
        setAuthed(false);
        setLoading(false);
        return;
      }
      const d = (await r.json()) as Portal;
      setPortal(d);
      setAuthed(true);
      // Lead-only panel: a 403 here just means this investor isn't the lead.
      const ls = await fetch("/api/investor/lead-summary", {
        credentials: "include",
      });
      if (ls.ok) {
        const summary = (await ls.json()) as LeadSummary;
        setLead(summary);
        if (summary.plan) {
          setPlanDeck(summary.plan.deckSlug);
          setPlanDate(summary.plan.targetDate);
        } else if (summary.decks[0]) {
          setPlanDeck(summary.decks[0].slug);
        }
      } else {
        setLead(null);
      }
    } finally {
      setLoading(false);
    }
  }

  async function generatePlan() {
    if (!planDeck || !planDate) return;
    setPlanning(true);
    setPlanError(null);
    try {
      const r = await fetch("/api/investor/cash-flow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ deckSlug: planDeck, targetDate: planDate }),
      });
      const d = await r.json();
      if (!r.ok) {
        setPlanError(d.error ?? "Could not generate the plan.");
        return;
      }
      setLead((prev) =>
        prev
          ? { ...prev, totalCommittedCents: d.totalCommittedCents, plan: d.plan }
          : prev,
      );
    } catch {
      setPlanError("Could not generate the plan.");
    } finally {
      setPlanning(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (authed === false) {
      const t = setTimeout(() => {
        window.location.href = "/investor-login";
      }, 1200);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [authed]);

  async function submitRequest(e: React.FormEvent) {
    e.preventDefault();
    if (!subject.trim()) return;
    setSubmitting(true);
    try {
      const r = await fetch("/api/investor/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ subject: subject.trim(), body: body.trim() }),
      });
      if (r.ok) {
        setSubject("");
        setBody("");
        await load();
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function logout() {
    await fetch("/api/investor-auth/logout", {
      method: "POST",
      credentials: "include",
    }).catch(() => {});
    window.location.href = "/investor-login";
  }

  if (loading || authed === null) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: PAPER,
          fontFamily: SANS,
          display: "grid",
          placeItems: "center",
          color: MUTED,
        }}
      >
        Loading…
      </div>
    );
  }

  if (authed === false || !portal) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: PAPER,
          fontFamily: SANS,
          display: "grid",
          placeItems: "center",
          color: MUTED,
        }}
      >
        Redirecting to sign-in…
      </div>
    );
  }

  const p = portal;

  return (
    <div style={{ minHeight: "100vh", background: PAPER, fontFamily: SANS, color: TEXT }}>
      {/* Header */}
      <div
        style={{
          background: `radial-gradient(120% 200% at 80% -40%, ${NIGHT} 0%, ${INK} 70%)`,
          color: "#fff",
          padding: "40px 24px 56px",
        }}
      >
        <div
          style={{
            maxWidth: 1000,
            margin: "0 auto",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 16,
          }}
        >
          <div>
            <div style={{ fontWeight: 700, fontSize: 18 }}>Palonur</div>
            <div
              style={{
                fontSize: 11,
                letterSpacing: ".18em",
                textTransform: "uppercase",
                color: GOLD_BG,
                fontWeight: 700,
                marginTop: 4,
              }}
            >
              Investor portal
            </div>
          </div>
          <button
            onClick={logout}
            style={{
              background: "transparent",
              border: "1px solid rgba(255,255,255,0.3)",
              color: "rgba(255,255,255,0.8)",
              borderRadius: 999,
              padding: "7px 16px",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            Sign out
          </button>
        </div>
        <div style={{ maxWidth: 1000, margin: "28px auto 0" }}>
          <h1
            style={{
              fontFamily: SERIF,
              fontSize: 36,
              fontWeight: 500,
              lineHeight: 1.15,
              margin: 0,
              color: PAPER,
            }}
          >
            Welcome, {p.investor.name}.
          </h1>
          <p
            style={{
              fontFamily: SERIF,
              fontSize: 18,
              color: "rgba(255,255,255,0.7)",
              marginTop: 10,
              maxWidth: 620,
            }}
          >
            Everything we're building, and where things stand — kept current for
            the people backing us.
          </p>
          <div style={{ marginTop: 14 }}>
            <StatusPill status={p.investor.status} />
          </div>
        </div>
      </div>

      <div
        style={{
          maxWidth: 1000,
          margin: "-32px auto 0",
          padding: "0 24px 80px",
          display: "grid",
          gridTemplateColumns: "1fr",
          gap: 20,
        }}
      >
        {/* Lead-only: committed total + AI cash-flow planner (platform admin) */}
        {lead && (
          <Card style={{ borderColor: GOLD_BG }}>
            <SectionLabel>Lead view · committed capital</SectionLabel>
            <div
              style={{
                fontFamily: SERIF,
                fontSize: 38,
                fontWeight: 700,
                color: TEXT,
                lineHeight: 1.1,
              }}
            >
              {fmtUsd(lead.totalCommittedCents)}
            </div>
            <div style={{ fontSize: 13, color: MUTED, marginTop: 4 }}>
              Total committed across lead &amp; committed investors. Visible to you only.
            </div>

            <div
              style={{
                marginTop: 22,
                paddingTop: 20,
                borderTop: `1px solid ${BORDER}`,
              }}
            >
              <SectionLabel>AI cash-flow planner</SectionLabel>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 12,
                  alignItems: "flex-end",
                }}
              >
                <label style={{ display: "grid", gap: 4, flex: "1 1 200px" }}>
                  <span style={{ fontSize: 12, color: MUTED }}>Connect a deck</span>
                  <select
                    value={planDeck}
                    onChange={(e) => setPlanDeck(e.target.value)}
                    style={{
                      padding: "9px 10px",
                      borderRadius: 8,
                      border: `1px solid ${BORDER}`,
                      background: PAPER,
                      color: TEXT,
                      fontSize: 14,
                    }}
                  >
                    {lead.decks.length === 0 && (
                      <option value="">No decks available</option>
                    )}
                    {lead.decks.map((d) => (
                      <option key={d.slug} value={d.slug}>
                        {d.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ display: "grid", gap: 4, flex: "0 1 180px" }}>
                  <span style={{ fontSize: 12, color: MUTED }}>Target date</span>
                  <input
                    type="date"
                    value={planDate}
                    onChange={(e) => setPlanDate(e.target.value)}
                    style={{
                      padding: "9px 10px",
                      borderRadius: 8,
                      border: `1px solid ${BORDER}`,
                      background: PAPER,
                      color: TEXT,
                      fontSize: 14,
                    }}
                  />
                </label>
                <button
                  onClick={generatePlan}
                  disabled={planning || !planDeck || !planDate}
                  style={{
                    padding: "10px 18px",
                    borderRadius: 8,
                    border: "none",
                    background: GOLD_BG,
                    color: "#fff",
                    fontSize: 14,
                    fontWeight: 700,
                    cursor: planning ? "default" : "pointer",
                    opacity: planning || !planDeck || !planDate ? 0.6 : 1,
                  }}
                >
                  {planning ? "Generating…" : "Generate plan"}
                </button>
              </div>
              {planError && (
                <div style={{ color: "#9a4a4a", fontSize: 13, marginTop: 10 }}>
                  {planError}
                </div>
              )}

              {lead.plan && (
                <div style={{ marginTop: 18 }}>
                  <div style={{ fontSize: 13, color: MUTED, marginBottom: 8 }}>
                    {lead.plan.deckTitle ?? lead.plan.deckSlug} ·{" "}
                    {fmtUsd(lead.plan.totalCommittedCents)} · through{" "}
                    {fmtDate(lead.plan.targetDate)} · updated{" "}
                    {fmtDate(lead.plan.updatedAt)}
                  </div>
                  <div
                    style={{
                      whiteSpace: "pre-wrap",
                      fontSize: 14,
                      lineHeight: 1.6,
                      color: "#3a3a44",
                      background: PAPER,
                      border: `1px solid ${BORDER}`,
                      borderRadius: 10,
                      padding: 16,
                      maxHeight: 420,
                      overflowY: "auto",
                    }}
                  >
                    {lead.plan.planText}
                  </div>
                </div>
              )}
            </div>
          </Card>
        )}

        {/* Updates */}
        <Card>
          <SectionLabel>Latest updates</SectionLabel>
          {p.updates.length === 0 ? (
            <div style={{ color: MUTED, fontSize: 15 }}>
              No updates yet — we'll post progress here as it happens.
            </div>
          ) : (
            <div style={{ display: "grid", gap: 18 }}>
              {p.updates.map((u) => (
                <div
                  key={u.id}
                  style={{
                    borderLeft: u.pinned ? `3px solid ${GOLD_BG}` : "3px solid #eee",
                    paddingLeft: 16,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {u.pinned && (
                      <span style={{ fontSize: 11, color: GOLD, fontWeight: 700 }}>
                        ★ Pinned
                      </span>
                    )}
                    <span style={{ fontSize: 12, color: MUTED }}>
                      {fmtDate(u.publishedAt)}
                    </span>
                  </div>
                  <div
                    style={{
                      fontFamily: SERIF,
                      fontSize: 20,
                      fontWeight: 600,
                      margin: "4px 0 6px",
                    }}
                  >
                    {u.title}
                  </div>
                  {u.bodyHtml && (
                    <div
                      style={{ fontSize: 15, lineHeight: 1.6, color: "#3a3a44" }}
                      dangerouslySetInnerHTML={{ __html: u.bodyHtml }}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: 20,
          }}
        >
          {/* Cap table */}
          <Card>
            <SectionLabel>Cap table</SectionLabel>
            <div style={{ display: "grid", gap: 10 }}>
              {p.capTable.rows.map((r) => (
                <div key={r.holder}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "baseline",
                      gap: 10,
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{r.holder}</span>
                    <span style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700 }}>
                      {r.percent}%
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: MUTED }}>{r.role}</div>
                  <div
                    style={{
                      height: 6,
                      borderRadius: 999,
                      background: "#f0ebe0",
                      marginTop: 6,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${r.percent}%`,
                        background: GOLD_BG,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <div
              style={{
                marginTop: 16,
                paddingTop: 14,
                borderTop: `1px solid ${BORDER}`,
                fontSize: 13,
                color: MUTED,
                lineHeight: 1.55,
              }}
            >
              <strong style={{ color: TEXT }}>
                Faculty: {p.capTable.faculty.join(", ")}
              </strong>
              <div style={{ marginTop: 4 }}>{p.capTable.facultyNote}</div>
            </div>
          </Card>

          {/* Hotline */}
          <Card
            style={{
              background: `radial-gradient(120% 140% at 100% 0%, ${NIGHT} 0%, ${INK} 80%)`,
              color: "#fff",
              border: "none",
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
            }}
          >
            <SectionLabel>Founder hotline</SectionLabel>
            <div style={{ fontFamily: SERIF, fontSize: 26, color: PAPER, marginBottom: 8 }}>
              {p.hotline.note}
            </div>
            {p.hotline.number ? (
              <a
                href={`tel:${p.hotline.number.replace(/\s/g, "")}`}
                style={{
                  display: "inline-block",
                  marginTop: 6,
                  color: INK,
                  background: GOLD_BG,
                  borderRadius: 999,
                  padding: "12px 22px",
                  fontWeight: 700,
                  textDecoration: "none",
                  fontSize: 16,
                  width: "fit-content",
                }}
              >
                📞 {p.hotline.number}
              </a>
            ) : (
              <div style={{ color: "rgba(255,255,255,0.55)", fontSize: 14 }}>
                Karan's number is being added — check back shortly.
              </div>
            )}
          </Card>
        </div>

        {/* Decks */}
        <Card>
          <SectionLabel>Your decks &amp; documents</SectionLabel>
          {p.decks.length === 0 ? (
            <div style={{ color: MUTED, fontSize: 15 }}>
              No decks have been shared with you yet.
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                gap: 14,
              }}
            >
              {p.decks.map((d) => (
                <div
                  key={d.slug}
                  style={{
                    border: `1px solid ${BORDER}`,
                    borderRadius: 12,
                    padding: 18,
                    color: TEXT,
                    background: "#fcfaf5",
                  }}
                >
                  <div style={{ fontFamily: SERIF, fontSize: 17, fontWeight: 600 }}>
                    {d.title}
                  </div>
                  {d.description && (
                    <div style={{ fontSize: 13, color: MUTED, marginTop: 4 }}>
                      {d.description}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 16, marginTop: 12 }}>
                    <a
                      href={`/api/investor/decks/${d.slug}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ fontSize: 12, color: GOLD, fontWeight: 700, textDecoration: "none" }}
                    >
                      Open →
                    </a>
                    <a
                      href={`/api/investor/decks/${d.slug}?download`}
                      style={{ fontSize: 12, color: GOLD, fontWeight: 700, textDecoration: "none" }}
                    >
                      ↓ Download
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Data room */}
        {p.documents.length > 0 && (
          <Card>
            <SectionLabel>Data room</SectionLabel>
            <div style={{ display: "grid", gap: 10 }}>
              {p.documents.map((d) => {
                const href = d.externalUrl
                  ? d.externalUrl
                  : d.objectPath
                    ? `/api/storage${d.objectPath.startsWith("/") ? "" : "/"}${d.objectPath}`
                    : "#";
                return (
                  <a
                    key={d.id}
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 12,
                      border: `1px solid ${BORDER}`,
                      borderRadius: 10,
                      padding: "12px 16px",
                      textDecoration: "none",
                      color: TEXT,
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 600 }}>{d.title}</div>
                      {d.description && (
                        <div style={{ fontSize: 13, color: MUTED }}>{d.description}</div>
                      )}
                      {!d.externalUrl && fileMetaLabel(d) && (
                        <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{fileMetaLabel(d)}</div>
                      )}
                    </div>
                    <span style={{ color: GOLD, fontWeight: 700 }}>↓</span>
                  </a>
                );
              })}
            </div>
          </Card>
        )}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: 20,
          }}
        >
          {/* Roster */}
          <Card>
            <SectionLabel>Who's around the table</SectionLabel>
            <div style={{ display: "grid", gap: 8 }}>
              {p.roster.map((r) => (
                <div
                  key={r.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "8px 0",
                    borderBottom: `1px solid ${BORDER}`,
                  }}
                >
                  <div>
                    <span style={{ fontWeight: 600 }}>{r.name}</span>
                    {r.role && (
                      <span style={{ fontSize: 13, color: MUTED }}> · {r.role}</span>
                    )}
                  </div>
                  <StatusPill status={r.status} />
                </div>
              ))}
            </div>
          </Card>

          {/* Newsletter */}
          {p.newsletterAccess && (
            <Card>
              <SectionLabel>Newsletter</SectionLabel>
              <div style={{ fontSize: 15, color: "#3a3a44", lineHeight: 1.6 }}>
                Get the same Stanford Lifestyle Medicine newsletter our readers
                receive — the science, in plain language.
              </div>
              <a
                href="/newsletter"
                style={{
                  display: "inline-block",
                  marginTop: 14,
                  background: INK,
                  color: "#fff",
                  borderRadius: 999,
                  padding: "11px 20px",
                  fontWeight: 700,
                  textDecoration: "none",
                  fontSize: 14,
                }}
              >
                Subscribe →
              </a>
            </Card>
          )}
        </div>

        {/* Request info */}
        <Card>
          <SectionLabel>Request information</SectionLabel>
          <div style={{ fontSize: 15, color: "#3a3a44", marginBottom: 14 }}>
            Want a specific document, metric, or a call? Ask here and we'll
            follow up.
          </div>
          <form onSubmit={submitRequest} style={{ display: "grid", gap: 10 }}>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="What do you need?"
              required
              style={{
                padding: "12px 14px",
                border: `1px solid ${BORDER}`,
                borderRadius: 10,
                fontSize: 15,
                fontFamily: SANS,
              }}
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Any detail (optional)"
              rows={3}
              style={{
                padding: "12px 14px",
                border: `1px solid ${BORDER}`,
                borderRadius: 10,
                fontSize: 15,
                fontFamily: SANS,
                resize: "vertical",
              }}
            />
            <button
              type="submit"
              disabled={submitting}
              style={{
                justifySelf: "start",
                background: GOLD_BG,
                color: INK,
                border: "none",
                borderRadius: 999,
                padding: "11px 22px",
                fontWeight: 700,
                cursor: submitting ? "default" : "pointer",
                fontSize: 14,
                opacity: submitting ? 0.6 : 1,
              }}
            >
              {submitting ? "Sending…" : "Send request"}
            </button>
          </form>

          {p.requests.length > 0 && (
            <div style={{ marginTop: 22, display: "grid", gap: 12 }}>
              {p.requests.map((r) => (
                <div
                  key={r.id}
                  style={{
                    border: `1px solid ${BORDER}`,
                    borderRadius: 10,
                    padding: 14,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 10,
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{r.subject}</span>
                    <StatusPill status={r.status} />
                  </div>
                  {r.body && (
                    <div style={{ fontSize: 14, color: MUTED, marginTop: 4 }}>
                      {r.body}
                    </div>
                  )}
                  {r.responseHtml && (
                    <div
                      style={{
                        fontSize: 14,
                        lineHeight: 1.6,
                        color: "#3a3a44",
                        marginTop: 10,
                        paddingTop: 10,
                        borderTop: `1px solid ${BORDER}`,
                      }}
                      dangerouslySetInnerHTML={{ __html: r.responseHtml }}
                    />
                  )}
                  <div style={{ fontSize: 11, color: MUTED, marginTop: 8 }}>
                    {fmtDate(r.createdAt)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
