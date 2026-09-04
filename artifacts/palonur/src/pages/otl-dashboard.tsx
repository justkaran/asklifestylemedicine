import { useState, useEffect } from "react";

const API_BASE = "/api";
const BRIEF_URL = `${import.meta.env.BASE_URL}otl.html`;
const UIT_URL = `${import.meta.env.BASE_URL}uit.html`;

// Stanford brand palette
const CARDINAL = "#8C1515";
const CARDINAL_HOVER = "#a01a1a";
const INK = "#2e2326";
const PAPER = "#FAF8F4";
const CARD = "#ffffff";
const RULE = "#e8e0e0";
const MUTED = "#6b6168";

interface OtlOverview {
  generatedAt: string;
  kpis: {
    activePillars: number;
    retiredPillars: number;
    onboardedStewards: number;
    totalFaculty: number;
    approvedSources: number;
    approvedInterpretations: number;
    questionsAnswered: number;
    coverageRatePct: number | null;
    citationVerifiedRate: number | null;
  };
  pillars: Array<{
    slug: string;
    name: string;
    description: string | null;
    retired: boolean;
    stewards: string[];
    facultyCount: number;
    approvedSources: number;
    approvedInterpretations: number;
    questionVolume: number;
  }>;
  stewards: Array<{
    name: string;
    institution: string | null;
    isPlatformAdmin: boolean;
    onboarded: boolean;
    voiceProfile: "approved" | "draft" | "none";
    roles: Array<{ pillar: string; role: string }>;
    interpretationsAuthored: number;
    interpretationsApproved: number;
  }>;
  governance: {
    sourcesByStatus: Record<string, number>;
    sourcesByKind: Record<string, number>;
    reliability: {
      rigor: { avg: number | null; scored: number };
      reproducibility: { avg: number | null; scored: number };
      openness: { avg: number | null; scored: number };
      assessed: number;
      approvedAssessments: number;
    };
    draftAcceptance: {
      total: number;
      withDraft: number;
      unedited: number;
      light: number;
      rewritten: number;
      noDraft: number;
    };
    interpretationsByStatus: Record<string, number>;
    citationHealth: {
      verified: number;
      unmatched: number;
      missing: number;
      verifiedRate: number | null;
    };
    coverageGaps: {
      windowDays: number;
      totalUncovered: number;
      distinctQuestions: number;
    };
    crossPillarAdoptions: {
      proposed: number;
      approved: number;
      declined: number;
    };
    evalQuality: {
      runName: string | null;
      completedAt: string | null;
      citationVerifiedRate: number | null;
      coverageRate: number | null;
      refusalComplianceRate: number | null;
      uncoveredHonestyRate: number | null;
      medianLatencyMs: number | null;
    } | null;
  };
  demand: {
    signups: number;
    waitlist: number;
    newsletterSubscribers: { active: number; total: number };
    willingnessToPay: {
      total: number;
      wouldPay: number;
      byPrice: Array<{ label: string; count: number }>;
    };
    queryVolume: Array<{ date: string; count: number }>;
  };
  revenue: {
    activeSubscriptions: number;
    payingCustomers: number;
    mrrCents: number;
    currency: string;
    byProduct: Array<{ product: string; subscriptions: number; mrrCents: number }>;
    lifetimeRevenueCents: number | null;
    newsletterMrrCents: number;
    newsletterPayingCustomers: number;
    consumerPlanPriceCents: number;
  };
}

// ── Formatting helpers ────────────────────────────────────────────────────────
function money(cents: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}
function pct(rate: number | null, digits = 0) {
  if (rate == null) return "—";
  return `${(rate * 100).toFixed(digits)}%`;
}
function num(n: number) {
  return n.toLocaleString("en-US");
}
function titleCase(s: string) {
  return s
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Snapshot export (CSV of the live aggregates) ──────────────────────────────
function csvField(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildSnapshotCsv(data: OtlOverview): string {
  const { kpis, governance: g, demand, revenue } = data;
  const rows: Array<[string, string, string]> = [];
  const add = (section: string, metric: string, value: string | number) =>
    rows.push([section, metric, String(value)]);

  // Overview KPIs
  add("Overview", "Active pillars", kpis.activePillars);
  add("Overview", "Retired pillars", kpis.retiredPillars);
  add("Overview", "Onboarded stewards", kpis.onboardedStewards);
  add("Overview", "Total faculty", kpis.totalFaculty);
  add("Overview", "Approved sources", kpis.approvedSources);
  add("Overview", "Approved interpretations", kpis.approvedInterpretations);
  add("Overview", "Questions answered", kpis.questionsAnswered);
  add("Overview", "Coverage rate", kpis.coverageRatePct == null ? "—" : `${kpis.coverageRatePct}%`);
  add("Overview", "Citation-verified rate", pct(kpis.citationVerifiedRate));

  // Provenance & governance integrity
  add("Governance", "Citation verified", g.citationHealth.verified);
  add("Governance", "Citation unmatched", g.citationHealth.unmatched);
  add("Governance", "Citation missing", g.citationHealth.missing);
  add("Governance", "Citation verified rate", pct(g.citationHealth.verifiedRate));
  add("Governance", `Coverage gaps — uncovered questions (last ${g.coverageGaps.windowDays}d)`, g.coverageGaps.totalUncovered);
  add("Governance", `Coverage gaps — distinct topics (last ${g.coverageGaps.windowDays}d)`, g.coverageGaps.distinctQuestions);
  add("Governance", "Cross-pillar adoptions approved", g.crossPillarAdoptions.approved);
  add("Governance", "Cross-pillar adoptions proposed", g.crossPillarAdoptions.proposed);
  add("Governance", "Cross-pillar adoptions declined", g.crossPillarAdoptions.declined);

  // Demand & traction
  add("Demand & Traction", "Signups", demand.signups);
  add("Demand & Traction", "Waitlist", demand.waitlist);
  add("Demand & Traction", "Newsletter subscribers (active)", demand.newsletterSubscribers.active);
  add("Demand & Traction", "Newsletter subscribers (all-time)", demand.newsletterSubscribers.total);
  add("Demand & Traction", "Would pay", demand.willingnessToPay.wouldPay);
  add("Demand & Traction", "Surveyed on price", demand.willingnessToPay.total);

  // Revenue & subscriptions
  add("Revenue & Subscriptions", "Active subscriptions", revenue.activeSubscriptions);
  add("Revenue & Subscriptions", "Paying customers", revenue.payingCustomers);
  add("Revenue & Subscriptions", "Monthly recurring (MRR)", money(revenue.mrrCents, revenue.currency));
  add("Revenue & Subscriptions", "Lifetime revenue", revenue.lifetimeRevenueCents == null ? "—" : money(revenue.lifetimeRevenueCents, revenue.currency));
  add("Revenue & Subscriptions", "Newsletter MRR", money(revenue.newsletterMrrCents, revenue.currency));
  add("Revenue & Subscriptions", "Newsletter paying customers", revenue.newsletterPayingCustomers);

  const header = ["Section", "Metric", "Value"].map(csvField).join(",");
  const body = rows.map((r) => r.map(csvField).join(",")).join("\n");
  const meta = `Palonur Governance Snapshot,Generated,${csvField(new Date(data.generatedAt).toLocaleString("en-US"))}`;
  return `${meta}\n\n${header}\n${body}\n`;
}

function downloadSnapshot(data: OtlOverview) {
  const csv = buildSnapshotCsv(data);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date(data.generatedAt).toISOString().slice(0, 10);
  const a = document.createElement("a");
  a.href = url;
  a.download = `palonur-governance-snapshot-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Small presentational components ───────────────────────────────────────────
function MetricCard({
  label,
  value,
  sub,
  emptyHint = "No data yet",
}: {
  label: string;
  value: string | number;
  sub?: string;
  emptyHint?: string;
}) {
  const isEmpty = value === "—" || value === "" || value == null;
  return (
    <div
      style={{
        background: CARD,
        border: `1px solid ${RULE}`,
        borderRadius: 12,
        padding: "18px 20px",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        boxSizing: "border-box",
      }}
    >
      {isEmpty ? (
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "#b3aaa6",
            lineHeight: 1.25,
            minHeight: 28,
            display: "flex",
            alignItems: "center",
          }}
        >
          {emptyHint}
        </div>
      ) : (
        <div
          style={{
            fontSize: 26,
            fontWeight: 700,
            color: CARDINAL,
            letterSpacing: "-0.02em",
            lineHeight: 1.1,
            minHeight: 28,
          }}
        >
          {value}
        </div>
      )}
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: MUTED,
          letterSpacing: ".06em",
          textTransform: "uppercase",
          lineHeight: 1.3,
          minHeight: 28,
          marginTop: 6,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 11, color: "#aaa", marginTop: "auto", paddingTop: 4, minHeight: 15 }}>
        {!isEmpty && sub ? sub : "\u00A0"}
      </div>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 40 }}>
      <div
        style={{
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: ".14em",
          textTransform: "uppercase",
          color: CARDINAL,
          marginBottom: subtitle ? 4 : 14,
          paddingBottom: 8,
          borderBottom: `1px solid rgba(140,21,21,.15)`,
        }}
      >
        {title}
      </div>
      {subtitle && (
        <div style={{ fontSize: 13, color: MUTED, marginBottom: 16 }}>{subtitle}</div>
      )}
      {children}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: CARD,
        border: `1px solid ${RULE}`,
        borderRadius: 12,
        padding: "18px 20px",
      }}
    >
      {children}
    </div>
  );
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 13,
        fontWeight: 700,
        color: INK,
        marginBottom: 14,
      }}
    >
      {children}
    </div>
  );
}

function StatRow({
  label,
  value,
  max,
  color = CARDINAL,
}: {
  label: string;
  value: number;
  max: number;
  color?: string;
}) {
  const w = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 12.5,
          color: INK,
          marginBottom: 4,
        }}
      >
        <span>{label}</span>
        <span style={{ fontWeight: 600 }}>{num(value)}</span>
      </div>
      <div
        style={{
          height: 6,
          background: "#f0e8e8",
          borderRadius: 3,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${w}%`,
            height: "100%",
            background: color,
            borderRadius: 3,
          }}
        />
      </div>
    </div>
  );
}

function Sparkline({ data }: { data: Array<{ date: string; count: number }> }) {
  if (data.length === 0)
    return <div style={{ color: "#aaa", fontSize: 13 }}>No queries in this window.</div>;
  const W = 520;
  const H = 90;
  const max = Math.max(...data.map((d) => d.count), 1);
  const step = data.length > 1 ? W / (data.length - 1) : W;
  const pts = data
    .map((d, i) => `${(i * step).toFixed(1)},${(H - (d.count / max) * (H - 8)).toFixed(1)}`)
    .join(" ");
  const total = data.reduce((a, b) => a + b.count, 0);
  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height: 90, display: "block" }}
      >
        <polyline points={pts} fill="none" stroke={CARDINAL} strokeWidth={2} />
        {data.map((d, i) => (
          <circle
            key={d.date}
            cx={(i * step).toFixed(1)}
            cy={(H - (d.count / max) * (H - 8)).toFixed(1)}
            r={1.6}
            fill={CARDINAL}
          />
        ))}
      </svg>
      <div style={{ fontSize: 11.5, color: MUTED, marginTop: 6 }}>
        {num(total)} questions over the last {data.length} active day
        {data.length === 1 ? "" : "s"} · peak {num(max)}/day
      </div>
    </div>
  );
}

function Badge({ kind }: { kind: "approved" | "draft" | "none" | "yes" | "no" }) {
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    approved: { bg: "#e6f4ea", fg: "#2f7d4f", label: "Approved" },
    draft: { bg: "#fdf2e0", fg: "#a9710d", label: "Draft" },
    none: { bg: "#f3f0ee", fg: "#9a9098", label: "None" },
    yes: { bg: "#e6f4ea", fg: "#2f7d4f", label: "Yes" },
    no: { bg: "#f3f0ee", fg: "#9a9098", label: "No" },
  };
  const s = map[kind];
  return (
    <span
      style={{
        background: s.bg,
        color: s.fg,
        fontSize: 11,
        fontWeight: 600,
        padding: "2px 8px",
        borderRadius: 20,
        whiteSpace: "nowrap",
      }}
    >
      {s.label}
    </span>
  );
}

const GRID2: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
  gap: 16,
};

// Even, responsive metric grid: cards keep a consistent size and never
// stretch to fill a partial last row (auto-fill leaves empty tracks).
const METRIC_GRID: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
  gap: 12,
};

// Load the UIT review package once and prepare it for inline embedding:
// strip scripts + editor chrome, and apply the server-side edited pages from
// /api/uit-doc (the DB snapshot is authoritative, same as uit.html itself).
async function loadUitDoc(): Promise<Document> {
  const res = await fetch(UIT_URL, { credentials: "include" });
  if (!res.ok) throw new Error("package unavailable");
  const doc = new DOMParser().parseFromString(await res.text(), "text/html");

  try {
    const api = await fetch(`${API_BASE}/uit-doc`, {
      headers: { Accept: "application/json" },
    });
    if (api.ok) {
      const payload = (await api.json()) as { content?: unknown };
      // Only apply the server snapshot when it actually contains the track
      // pages — a junk/partial snapshot (e.g. a test row) would otherwise
      // blank out the inline view. The static file stays the safe baseline.
      const snapshotHasTracks =
        Array.isArray(payload.content) &&
        (payload.content as string[]).some((h) =>
          typeof h === "string" && /Track \d/.test(h),
        );
      if (snapshotHasTracks && Array.isArray(payload.content) && payload.content.length > 0) {
        const existing = Array.from(doc.querySelectorAll(".page[data-card]"));
        const parent = existing[0]?.parentNode;
        const anchor = existing.length
          ? existing[existing.length - 1].nextSibling
          : null;
        if (parent) {
          existing.forEach((p) => p.remove());
          for (const html of payload.content as string[]) {
            const wrap = doc.createElement("div");
            wrap.innerHTML = html;
            const node = wrap.firstElementChild;
            if (node) parent.insertBefore(node, anchor);
          }
        }
      }
    }
  } catch {
    // Snapshot fetch failed — the static package is still a valid baseline.
  }

  doc.querySelectorAll("script").forEach((s) => s.remove());
  // Strip ALL editor chrome — the inline view is read-only, so the dark
  // editing toolbar and per-page delete buttons must not appear.
  doc
    .querySelectorAll(".toolbar, .delete-btn, #save-indicator, #edit-mode-btn, #pdf-btn")
    .forEach((el) => el.remove());
  return doc;
}

/** srcDoc HTML containing only the pages whose header starts with `track`. */
function uitTrackHtml(doc: Document, track: string): string {
  const clone = doc.cloneNode(true) as Document;
  clone.querySelectorAll(".page").forEach((page) => {
    const label =
      page.querySelector(".page-header span")?.textContent?.trim() ?? "";
    if (!label.startsWith(track)) page.remove();
  });
  return `<!DOCTYPE html>${clone.documentElement.outerHTML}`;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
function Dashboard({ data }: { data: OtlOverview }) {
  const { kpis, pillars, stewards, governance, demand, revenue } = data;

  // Inline review-track detail: clicking a card loads the UIT package once and
  // shows only that track's pages in an embedded, read-only view.
  const [openTrack, setOpenTrack] = useState<string | null>(null);
  const [uitDoc, setUitDoc] = useState<Document | null>(null);
  const [uitError, setUitError] = useState(false);
  const toggleTrack = async (track: string) => {
    if (openTrack === track) {
      setOpenTrack(null);
      return;
    }
    setOpenTrack(track);
    if (!uitDoc) {
      try {
        setUitError(false);
        setUitDoc(await loadUitDoc());
      } catch {
        setUitError(true);
      }
    }
  };
  const g = governance;

  const sourceStatusMax = Math.max(...Object.values(g.sourcesByStatus), 1);
  const sourceKindMax = Math.max(...Object.values(g.sourcesByKind), 1);
  const interpStatusMax = Math.max(...Object.values(g.interpretationsByStatus), 1);
  const pillarQMax = Math.max(...pillars.map((p) => p.questionVolume), 1);
  const wtpMax = Math.max(...demand.willingnessToPay.byPrice.map((b) => b.count), 1);
  const activePillars = pillars.filter((p) => !p.retired);
  const retiredPillars = pillars.filter((p) => p.retired);

  return (
    <div>
      {/* Welcome greeting + snapshot export */}
      <div
        style={{
          marginBottom: 24,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          flexWrap: "wrap",
          gap: 16,
        }}
      >
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, color: INK, letterSpacing: "-0.01em" }}>
            Welcome, Stanford Medicine
          </div>
          <div style={{ fontSize: 13.5, color: MUTED, marginTop: 4, lineHeight: 1.5 }}>
            A live, read-only view of how the governed Palonur corpus is performing.
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, flexShrink: 0 }}>
          <button
            type="button"
            onClick={() => downloadSnapshot(data)}
            style={{
              padding: "9px 16px",
              background: CARDINAL,
              color: "#fff",
              border: "none",
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: "inherit",
              whiteSpace: "nowrap",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = CARDINAL_HOVER; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = CARDINAL; }}
            title="Download the live aggregates as a CSV"
          >
            ↓ Download snapshot (CSV)
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            style={{
              padding: "9px 16px",
              background: "transparent",
              color: CARDINAL,
              border: `1px solid ${CARDINAL}`,
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: "inherit",
              whiteSpace: "nowrap",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "#f7eced"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            title="Print or save the dashboard as a PDF"
          >
            Print / PDF
          </button>
        </div>
      </div>

      {/* Review tracks — one card per Stanford review track, replacing the
          former long text banners to keep the top of the page uncluttered. */}
      <div style={{ marginBottom: 32 }}>
        <div style={{ ...GRID2, marginBottom: 12 }}>
          {[
            {
              title: "University IT",
              track: "Track 1",
              desc: "Data risk classification and vendor security review. Every data element is inventoried with a proposed risk classification.",
            },
            {
              title: "Procurement",
              track: "Track 2",
              desc: "Vendor agreement and data terms. Every third-party service is listed with exactly what reaches it.",
            },
            {
              title: "UIT web governance",
              track: "Track 3",
              desc: "Site placement and accessibility. Each raised concern is answered directly.",
            },
          ].map((c) => {
            const isOpen = openTrack === c.track;
            return (
            <button
              key={c.title}
              type="button"
              onClick={() => void toggleTrack(c.track)}
              aria-expanded={isOpen}
              style={{
                background: "#fff",
                border: `1px solid ${isOpen ? CARDINAL : RULE}`,
                borderTop: `3px solid ${CARDINAL}`,
                borderRadius: 10,
                padding: "16px 20px",
                textAlign: "left",
                cursor: "pointer",
                fontFamily: "inherit",
                boxShadow: isOpen ? "0 2px 10px rgba(140,21,21,0.12)" : "none",
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 700, color: INK, marginBottom: 4 }}>
                {c.title}{" "}
                <span style={{ color: CARDINAL, fontWeight: 600, fontSize: 12 }}>
                  {isOpen ? "▴ Hide" : "▾ View"}
                </span>
              </div>
              <div style={{ fontSize: 13, color: MUTED, lineHeight: 1.55 }}>
                {c.desc}
              </div>
            </button>
          );
          })}
        </div>
        {openTrack && (
          <div
            style={{
              background: "#fff",
              border: `1px solid ${RULE}`,
              borderRadius: 10,
              marginBottom: 12,
              overflow: "hidden",
            }}
          >
            {uitError ? (
              <div style={{ padding: "14px 20px", fontSize: 13.5, color: MUTED }}>
                Could not load the review package right now.{" "}
                <a href={UIT_URL} target="_blank" rel="noreferrer" style={{ color: CARDINAL, fontWeight: 600 }}>
                  Open it directly →
                </a>
              </div>
            ) : !uitDoc ? (
              <div style={{ padding: "14px 20px", fontSize: 13.5, color: MUTED }}>
                Loading the review package…
              </div>
            ) : (
              <iframe
                title="Review track detail"
                srcDoc={uitTrackHtml(uitDoc, openTrack)}
                style={{ width: "100%", height: "75vh", border: "none", display: "block", background: "#fff" }}
                sandbox=""
              />
            )}
          </div>
        )}
        <div style={{ fontSize: 13.5, color: MUTED, lineHeight: 1.55 }}>
          The companion package for all three review tracks:{" "}
          <a
            href={UIT_URL}
            style={{ color: CARDINAL, fontWeight: 600 }}
            target="_blank"
            rel="noreferrer"
          >
            Read the UIT review package →
          </a>{" "}
          <button
            onClick={async () => {
              try {
                const res = await fetch(UIT_URL, { credentials: "include" });
                if (!res.ok || res.redirected) throw new Error("unavailable");
                const html = await res.text();
                const blob = new Blob([html], { type: "text/html" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = "palonur_uit_review.html";
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
              } catch {
                window.open(UIT_URL, "_blank");
              }
            }}
            style={{
              background: "transparent",
              border: "none",
              padding: 0,
              color: CARDINAL,
              fontWeight: 600,
              fontSize: 13.5,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
            title="Download the package as a self-contained HTML file (printable to PDF)"
          >
            Download ↓
          </button>
        </div>
      </div>

      {/* KPI strip */}
      <Section title="Overview">
        <div style={METRIC_GRID}>
          <MetricCard label="Active pillars" value={kpis.activePillars} sub={kpis.retiredPillars ? `${kpis.retiredPillars} retired` : undefined} />
          <MetricCard label="Onboarded stewards" value={kpis.onboardedStewards} sub={`${kpis.totalFaculty} faculty total`} />
          <MetricCard label="Approved sources" value={num(kpis.approvedSources)} />
          <MetricCard label="Approved interpretations" value={num(kpis.approvedInterpretations)} />
          <MetricCard label="Questions answered" value={num(kpis.questionsAnswered)} />
          <MetricCard label="Coverage rate" value={kpis.coverageRatePct == null ? "—" : `${kpis.coverageRatePct}%`} sub="answered in-corpus" emptyHint="No questions yet" />
          <MetricCard label="Citation-verified" value={pct(kpis.citationVerifiedRate)} sub="latest eval run" emptyHint="No eval run yet" />
        </div>
      </Section>

      {/* Pillars */}
      <Section title="Pillars" subtitle="Each governed knowledge area, its steward(s), and the approved material behind it.">
        <div style={{ display: "grid", gap: 12 }}>
          {activePillars.map((p) => (
            <Card key={p.slug}>
              <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
                <div style={{ flex: "1 1 220px" }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: INK }}>{p.name}</div>
                  <div style={{ fontSize: 12.5, color: MUTED, marginTop: 4 }}>
                    {p.stewards.length > 0 ? `Steward${p.stewards.length > 1 ? "s" : ""}: ${p.stewards.join(", ")}` : "No steward assigned"}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 22, alignItems: "center" }}>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: CARDINAL }}>{num(p.approvedSources)}</div>
                    <div style={{ fontSize: 10.5, color: MUTED, textTransform: "uppercase", letterSpacing: ".05em" }}>Sources</div>
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: CARDINAL }}>{num(p.approvedInterpretations)}</div>
                    <div style={{ fontSize: 10.5, color: MUTED, textTransform: "uppercase", letterSpacing: ".05em" }}>Interps</div>
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: CARDINAL }}>{num(p.questionVolume)}</div>
                    <div style={{ fontSize: 10.5, color: MUTED, textTransform: "uppercase", letterSpacing: ".05em" }}>Questions</div>
                  </div>
                </div>
              </div>
              {pillarQMax > 0 && (
                <div style={{ marginTop: 12, height: 4, background: "#f0e8e8", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ width: `${Math.round((p.questionVolume / pillarQMax) * 100)}%`, height: "100%", background: CARDINAL }} />
                </div>
              )}
            </Card>
          ))}
          {retiredPillars.length > 0 && (
            <div style={{ fontSize: 12.5, color: MUTED, marginTop: 4 }}>
              Retired (no longer offered, content preserved): {retiredPillars.map((p) => p.name).join(", ")}
            </div>
          )}
        </div>
      </Section>

      {/* Stewards */}
      <Section title="Stewards & Faculty" subtitle="Who governs each pillar, their onboarding and voice-profile status, and their approval activity.">
        <Card>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", color: MUTED, fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em" }}>
                  <th style={{ padding: "6px 8px" }}>Name</th>
                  <th style={{ padding: "6px 8px" }}>Institution</th>
                  <th style={{ padding: "6px 8px" }}>Pillar roles</th>
                  <th style={{ padding: "6px 8px" }}>Onboarded</th>
                  <th style={{ padding: "6px 8px" }}>Voice</th>
                  <th style={{ padding: "6px 8px", textAlign: "right" }}>Authored</th>
                  <th style={{ padding: "6px 8px", textAlign: "right" }}>Approved</th>
                </tr>
              </thead>
              <tbody>
                {stewards.map((s, i) => (
                  <tr key={i} style={{ borderTop: `1px solid ${RULE}` }}>
                    <td style={{ padding: "8px", fontWeight: 600, color: INK }}>
                      {s.name}
                      {s.isPlatformAdmin && (
                        <span style={{ marginLeft: 6, fontSize: 10, color: CARDINAL, fontWeight: 600 }}>· admin</span>
                      )}
                    </td>
                    <td style={{ padding: "8px", color: MUTED }}>{s.institution ?? "—"}</td>
                    <td style={{ padding: "8px", color: INK }}>
                      {s.roles.length > 0
                        ? s.roles.map((r) => `${r.pillar} (${r.role})`).join(", ")
                        : "—"}
                    </td>
                    <td style={{ padding: "8px" }}><Badge kind={s.onboarded ? "yes" : "no"} /></td>
                    <td style={{ padding: "8px" }}><Badge kind={s.voiceProfile} /></td>
                    <td style={{ padding: "8px", textAlign: "right", fontWeight: 600 }}>{num(s.interpretationsAuthored)}</td>
                    <td style={{ padding: "8px", textAlign: "right", fontWeight: 600 }}>{num(s.interpretationsApproved)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </Section>

      {/* Provenance & governance integrity */}
      <Section title="Provenance & Governance Integrity" subtitle="How the human-in-the-loop approval and provenance machinery is performing.">
        <div style={GRID2}>
          <Card>
            <CardTitle>Sources by status</CardTitle>
            {Object.entries(g.sourcesByStatus).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
              <StatRow key={k} label={titleCase(k)} value={v} max={sourceStatusMax} />
            ))}
            {Object.keys(g.sourcesByStatus).length === 0 && <div style={{ color: "#aaa", fontSize: 13 }}>No sources yet.</div>}
          </Card>

          <Card>
            <CardTitle>Sources by kind</CardTitle>
            {Object.entries(g.sourcesByKind).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
              <StatRow key={k} label={titleCase(k)} value={v} max={sourceKindMax} color="#2f5d8a" />
            ))}
            {Object.keys(g.sourcesByKind).length === 0 && <div style={{ color: "#aaa", fontSize: 13 }}>No sources yet.</div>}
          </Card>

          <Card>
            <CardTitle>Reliability scores (avg / 5)</CardTitle>
            {([
              ["Rigor", g.reliability.rigor],
              ["Reproducibility", g.reliability.reproducibility],
              ["Openness", g.reliability.openness],
            ] as const).map(([label, r]) => (
              <div key={label} style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: INK, marginBottom: 4 }}>
                  <span>{label}</span>
                  <span style={{ fontWeight: 600 }}>{r.avg == null ? "—" : r.avg.toFixed(1)} <span style={{ color: MUTED, fontWeight: 400 }}>({r.scored} scored)</span></span>
                </div>
                <div style={{ height: 6, background: "#f0e8e8", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ width: `${r.avg == null ? 0 : Math.round((r.avg / 5) * 100)}%`, height: "100%", background: "#b88a2d", borderRadius: 3 }} />
                </div>
              </div>
            ))}
            <div style={{ fontSize: 11.5, color: MUTED, marginTop: 8 }}>
              {g.reliability.approvedAssessments} of {g.reliability.assessed} assessments approved
            </div>
          </Card>

          <Card>
            <CardTitle>AI-draft acceptance (approved interpretations)</CardTitle>
            {g.draftAcceptance.withDraft > 0 ? (
              <>
                <StatRow label="Kept unedited" value={g.draftAcceptance.unedited} max={g.draftAcceptance.withDraft} color="#2f7d4f" />
                <StatRow label="Lightly edited" value={g.draftAcceptance.light} max={g.draftAcceptance.withDraft} color="#b88a2d" />
                <StatRow label="Rewritten" value={g.draftAcceptance.rewritten} max={g.draftAcceptance.withDraft} color={CARDINAL} />
                <div style={{ fontSize: 11.5, color: MUTED, marginTop: 8 }}>
                  {g.draftAcceptance.withDraft} AI-assisted · {g.draftAcceptance.noDraft} written from scratch
                </div>
              </>
            ) : (
              <div style={{ color: "#aaa", fontSize: 13 }}>No AI-assisted interpretations yet.</div>
            )}
          </Card>

          <Card>
            <CardTitle>Citation verification health</CardTitle>
            {g.citationHealth.verified + g.citationHealth.unmatched + g.citationHealth.missing > 0 ? (
              <>
                <StatRow label="Verified" value={g.citationHealth.verified} max={g.citationHealth.verified + g.citationHealth.unmatched + g.citationHealth.missing} color="#2f7d4f" />
                <StatRow label="Unmatched" value={g.citationHealth.unmatched} max={g.citationHealth.verified + g.citationHealth.unmatched + g.citationHealth.missing} color={CARDINAL} />
                <StatRow label="Missing" value={g.citationHealth.missing} max={g.citationHealth.verified + g.citationHealth.unmatched + g.citationHealth.missing} color="#9a9098" />
                <div style={{ fontSize: 11.5, color: MUTED, marginTop: 8 }}>
                  {pct(g.citationHealth.verifiedRate)} verified · latest eval run
                </div>
              </>
            ) : (
              <div style={{ color: "#aaa", fontSize: 13 }}>No eval run with citation data yet.</div>
            )}
          </Card>

          <Card>
            <CardTitle>Interpretations by status</CardTitle>
            {Object.entries(g.interpretationsByStatus).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
              <StatRow key={k} label={titleCase(k)} value={v} max={interpStatusMax} />
            ))}
            {Object.keys(g.interpretationsByStatus).length === 0 && <div style={{ color: "#aaa", fontSize: 13 }}>No interpretations yet.</div>}
          </Card>

          <Card>
            <CardTitle>Cross-pillar adoptions</CardTitle>
            <StatRow label="Approved" value={g.crossPillarAdoptions.approved} max={Math.max(g.crossPillarAdoptions.approved, g.crossPillarAdoptions.proposed, g.crossPillarAdoptions.declined, 1)} color="#2f7d4f" />
            <StatRow label="Proposed" value={g.crossPillarAdoptions.proposed} max={Math.max(g.crossPillarAdoptions.approved, g.crossPillarAdoptions.proposed, g.crossPillarAdoptions.declined, 1)} color="#b88a2d" />
            <StatRow label="Declined" value={g.crossPillarAdoptions.declined} max={Math.max(g.crossPillarAdoptions.approved, g.crossPillarAdoptions.proposed, g.crossPillarAdoptions.declined, 1)} color="#9a9098" />
          </Card>

          <Card>
            <CardTitle>Coverage gaps (last {g.coverageGaps.windowDays}d)</CardTitle>
            <div style={{ display: "flex", gap: 28, marginTop: 4 }}>
              <div>
                <div style={{ fontSize: 24, fontWeight: 700, color: CARDINAL }}>{num(g.coverageGaps.totalUncovered)}</div>
                <div style={{ fontSize: 11, color: MUTED }}>uncovered questions</div>
              </div>
              <div>
                <div style={{ fontSize: 24, fontWeight: 700, color: INK }}>{num(g.coverageGaps.distinctQuestions)}</div>
                <div style={{ fontSize: 11, color: MUTED }}>distinct topics</div>
              </div>
            </div>
            <div style={{ fontSize: 11.5, color: MUTED, marginTop: 10 }}>
              Demand the corpus could not yet answer — feeds the stewards' priority queue.
            </div>
          </Card>
        </div>

        {g.evalQuality && (
          <div style={{ marginTop: 16 }}>
            <Card>
              <CardTitle>
                Eval quality{g.evalQuality.runName ? ` · ${g.evalQuality.runName}` : ""}
              </CardTitle>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
                {([
                  ["Citation verified", g.evalQuality.citationVerifiedRate],
                  ["Coverage", g.evalQuality.coverageRate],
                  ["Refusal compliance", g.evalQuality.refusalComplianceRate],
                  ["Uncovered honesty", g.evalQuality.uncoveredHonestyRate],
                ] as const).map(([label, rate]) => (
                  <div key={label}>
                    <div style={{ fontSize: 20, fontWeight: 700, color: CARDINAL }}>{pct(rate)}</div>
                    <div style={{ fontSize: 11, color: MUTED }}>{label}</div>
                  </div>
                ))}
                {g.evalQuality.medianLatencyMs != null && (
                  <div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: INK }}>{(g.evalQuality.medianLatencyMs / 1000).toFixed(1)}s</div>
                    <div style={{ fontSize: 11, color: MUTED }}>Median latency</div>
                  </div>
                )}
              </div>
            </Card>
          </div>
        )}
      </Section>

      {/* Demand & traction */}
      <Section title="Demand & Traction" subtitle="End-user interest across the funnel.">
        <div style={{ ...METRIC_GRID, marginBottom: 16 }}>
          <MetricCard label="Signups" value={num(demand.signups)} />
          <MetricCard label="Waitlist" value={num(demand.waitlist)} />
          <MetricCard label="Newsletter subscribers" value={num(demand.newsletterSubscribers.active)} sub={`${num(demand.newsletterSubscribers.total)} all-time`} />
          <MetricCard label="Would pay" value={num(demand.willingnessToPay.wouldPay)} sub={`of ${num(demand.willingnessToPay.total)} surveyed`} />
        </div>
        <div style={GRID2}>
          <Card>
            <CardTitle>Question volume (last 30 days)</CardTitle>
            <Sparkline data={demand.queryVolume} />
          </Card>
          <Card>
            <CardTitle>Willingness to pay</CardTitle>
            {demand.willingnessToPay.byPrice.length > 0 ? (
              demand.willingnessToPay.byPrice.map((b) => (
                <StatRow key={b.label} label={b.label} value={b.count} max={wtpMax} color="#2f7d4f" />
              ))
            ) : (
              <div style={{ color: "#aaa", fontSize: 13 }}>No pricing-intent responses yet.</div>
            )}
          </Card>
        </div>
      </Section>

      {/* Revenue & subscription */}
      <Section title="Revenue & Subscriptions" subtitle="Commercial traction. Palonur Pal is priced at $49/mo.">
        <div style={{ ...METRIC_GRID, marginBottom: 16 }}>
          <MetricCard label="Active subscriptions" value={num(revenue.activeSubscriptions)} />
          <MetricCard label="Paying customers" value={num(revenue.payingCustomers)} />
          <MetricCard label="Monthly recurring" value={money(revenue.mrrCents, revenue.currency)} sub="MRR" />
          <MetricCard label="Lifetime revenue" value={revenue.lifetimeRevenueCents == null ? "—" : money(revenue.lifetimeRevenueCents, revenue.currency)} sub="paid invoices" emptyHint="No paid invoices yet" />
          <MetricCard label="Newsletter MRR" value={money(revenue.newsletterMrrCents, revenue.currency)} sub={`${num(revenue.newsletterPayingCustomers)} subscribers`} />
        </div>
        {revenue.byProduct.length > 0 && (
          <Card>
            <CardTitle>By product</CardTitle>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: MUTED, fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em" }}>
                    <th style={{ padding: "6px 8px" }}>Product</th>
                    <th style={{ padding: "6px 8px", textAlign: "right" }}>Subscriptions</th>
                    <th style={{ padding: "6px 8px", textAlign: "right" }}>MRR</th>
                  </tr>
                </thead>
                <tbody>
                  {revenue.byProduct.map((p) => (
                    <tr key={p.product} style={{ borderTop: `1px solid ${RULE}` }}>
                      <td style={{ padding: "8px", fontWeight: 600, color: INK }}>{p.product}</td>
                      <td style={{ padding: "8px", textAlign: "right" }}>{num(p.subscriptions)}</td>
                      <td style={{ padding: "8px", textAlign: "right", fontWeight: 600, color: CARDINAL }}>{money(p.mrrCents, revenue.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
        {revenue.byProduct.length === 0 && (
          <Card>
            <div style={{ color: "#aaa", fontSize: 13 }}>
              No active subscriptions recorded yet (Stripe not connected or no live subscribers).
            </div>
          </Card>
        )}
      </Section>

      <div style={{ fontSize: 11.5, color: "#b3aaa6", marginTop: 8, textAlign: "center" }}>
        Live aggregates · generated {new Date(data.generatedAt).toLocaleString("en-US")}
      </div>
    </div>
  );
}

// ── Page (password gate + data load) ──────────────────────────────────────────
export default function OTLDashboard() {
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [pw, setPw] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwLoading, setPwLoading] = useState(false);

  const [data, setData] = useState<OtlOverview | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    document.title = "Stanford OTL · Governance Dashboard · Palonur";
    document.body.style.background = PAPER;
    return () => {
      document.body.style.background = "";
    };
  }, []);

  // Bridge: skip the prompt if an OTL or platform-admin cookie is already set.
  useEffect(() => {
    fetch(`${API_BASE}/otl-auth/session`, { credentials: "include" })
      .then((r) => r.json())
      .then((j) => {
        if (j?.authed) setAuthed(true);
      })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    if (!authed) return;
    fetch(`${API_BASE}/otl/overview`, { credentials: "include" })
      .then((r) => {
        if (!r.ok) throw new Error("load failed");
        return r.json();
      })
      .then((j: OtlOverview) => setData(j))
      .catch(() => setLoadError(true));
  }, [authed]);

  async function submitPw(e: React.FormEvent) {
    e.preventDefault();
    if (!pw.trim()) return;
    setPwLoading(true);
    setPwError(null);
    try {
      const res = await fetch(`${API_BASE}/otl-auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ password: pw.trim() }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.ok) {
        setAuthed(true);
      } else {
        setPwError(j?.error ?? "Incorrect password");
      }
    } catch {
      setPwError("Something went wrong. Try again.");
    } finally {
      setPwLoading(false);
    }
  }

  const shell = (children: React.ReactNode) => (
    <div style={{ minHeight: "100vh", background: PAPER, color: INK, fontFamily: "Georgia, 'Times New Roman', serif" }}>
      <div style={{ background: CARDINAL, color: "#fff", padding: "22px 0" }}>
        <div style={{ maxWidth: 1080, margin: "0 auto", padding: "0 28px" }}>
          <div style={{ fontSize: 12, letterSpacing: ".22em", textTransform: "uppercase", opacity: 0.85 }}>
            Stanford Office of Technology Licensing
          </div>
          <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>Palonur Governance Dashboard</div>
        </div>
      </div>
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "32px 28px 80px" }}>{children}</div>
    </div>
  );

  if (checking) {
    return shell(<div style={{ color: MUTED, padding: "60px 0", textAlign: "center" }}>Loading…</div>);
  }

  if (!authed) {
    return shell(
      <div style={{ maxWidth: 380, margin: "40px auto" }}>
        <form
          onSubmit={submitPw}
          style={{ background: CARD, border: `1px solid ${RULE}`, borderRadius: 12, padding: "28px 26px" }}
        >
          <div style={{ fontSize: 16, fontWeight: 700, color: INK, marginBottom: 6 }}>Enter access password</div>
          <div style={{ fontSize: 13, color: MUTED, marginBottom: 18, lineHeight: 1.5 }}>
            This is a private, read-only governance view for Stanford OTL.
          </div>
          <input
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder="Password"
            autoFocus
            style={{
              width: "100%",
              padding: "11px 13px",
              fontSize: 14,
              border: `1px solid ${RULE}`,
              borderRadius: 8,
              fontFamily: "inherit",
              boxSizing: "border-box",
            }}
          />
          {pwError && <div style={{ fontSize: 12.5, color: "#c0392b", marginTop: 8 }}>{pwError}</div>}
          <button
            type="submit"
            disabled={pwLoading}
            style={{
              marginTop: 16,
              width: "100%",
              padding: "11px 0",
              background: CARDINAL,
              color: "#fff",
              border: "none",
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 600,
              cursor: pwLoading ? "default" : "pointer",
              fontFamily: "inherit",
              opacity: pwLoading ? 0.7 : 1,
            }}
            onMouseEnter={(e) => { if (!pwLoading) e.currentTarget.style.background = CARDINAL_HOVER; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = CARDINAL; }}
          >
            {pwLoading ? "Checking…" : "View dashboard"}
          </button>
        </form>
      </div>,
    );
  }

  if (loadError) {
    return shell(
      <div style={{ color: "#c0392b", padding: "60px 0", textAlign: "center" }}>
        Could not load dashboard data. Please refresh.
      </div>,
    );
  }

  if (!data) {
    return shell(<div style={{ color: MUTED, padding: "60px 0", textAlign: "center" }}>Loading live aggregates…</div>);
  }

  return shell(<Dashboard data={data} />);
}
