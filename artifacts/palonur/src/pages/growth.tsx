import { useState, useEffect } from "react";

const API_BASE = "/api";

// Palonur dark cosmic palette (matches the consumer brand)
const BG = "#01010A";
const CARD = "#0B0B1A";
const CARD_ACTIVE = "#12122A";
const RULE = "#22223A";
const RULE_ACTIVE = "#7C6FF0";
const INK = "#EDEBFF";
const MUTED = "#8B89A8";
const ACCENT = "#7C6FF0";
const GOOD = "#4ADE80";

interface GrowthOverview {
  stage: {
    current: "alpha" | "beta" | "scale";
    metric: number;
    metricLabel: string;
  };
  users: {
    registered: number;
    registeredLast30: number;
    newsletterSubscribers: number;
    uniqueVisitorsAllTime: number;
    monthly: Array<{
      month: string;
      visitors: number;
      pageviews: number;
      signups: number;
    }>;
  };
  revenue: {
    mrrCents: number;
    activeSubscriptions: number;
    payingCustomers: number;
    currency: string;
    byProduct: Array<{
      product: string;
      subscriptions: number;
      mrrCents: number;
    }>;
    lifetimeCents: number | null;
    cacNote: string;
  };
  tokens: {
    allTime: {
      inputTokens: number;
      outputTokens: number;
      trackedQuestions: number;
      totalQuestions: number;
    };
    last30Days: {
      inputTokens: number;
      outputTokens: number;
      trackedQuestions: number;
      totalQuestions: number;
    };
    bySource: Array<{
      source: string;
      inputTokens: number;
      outputTokens: number;
      questions: number;
    }>;
    note: string;
  };
  retention: {
    dau: number;
    wau: number;
    mau: number;
    dauOverMau: number | null;
    wauOverMau: number | null;
    weekOverWeekReturn: number | null;
    repeatVisitorShare: number | null;
    basis: string;
  };
  generatedAt: string;
}

// ── Stage definitions (verbatim) ─────────────────────────────────────────────
const STAGES: Array<{
  key: "alpha" | "beta" | "scale";
  title: string;
  range: string;
  goal: string;
  gate: string;
}> = [
  {
    key: "alpha",
    title: "Alpha",
    range: "10–100 users",
    goal: "Prove the product solves a real problem for a hand-picked group.",
    gate: "Users can describe the value in their own words, and they come back to use it again.",
  },
  {
    key: "beta",
    title: "Beta",
    range: "100–1,000 users",
    goal: "Prove you can acquire and retain customers with workable economics.",
    gate: "CAC and retention look healthy, and the retention curve starts to level off.",
  },
  {
    key: "scale",
    title: "Scale",
    range: "1,000+ users",
    goal: "Invest aggressively in the channel that Beta proved.",
    gate: "You\u2019re scaling what\u2019s already working, not \u201Ctesting\u201D at full spend.",
  },
];

function money(cents: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}
function num(n: number) {
  return new Intl.NumberFormat("en-US").format(n);
}
function pct(x: number | null) {
  if (x == null) return "—";
  return `${Math.round(x * 1000) / 10}%`;
}
function monthLabel(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString("en-US", {
    month: "short",
    year: "numeric",
  });
}

// ── Small building blocks ────────────────────────────────────────────────────
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12,
        letterSpacing: ".2em",
        textTransform: "uppercase",
        color: MUTED,
        margin: "42px 0 14px",
      }}
    >
      {children}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div
      style={{
        background: CARD,
        border: `1px solid ${RULE}`,
        borderRadius: 12,
        padding: "16px 18px",
        flex: "1 1 160px",
        minWidth: 150,
      }}
    >
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: INK }}>{value}</div>
      {sub && (
        <div style={{ fontSize: 12, color: MUTED, marginTop: 4, lineHeight: 1.4 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function StageCard({
  stage,
  active,
}: {
  stage: (typeof STAGES)[number];
  active: boolean;
}) {
  return (
    <div
      style={{
        flex: "1 1 260px",
        minWidth: 240,
        background: active ? CARD_ACTIVE : CARD,
        border: `1px solid ${active ? RULE_ACTIVE : RULE}`,
        borderRadius: 14,
        padding: "20px 22px",
        position: "relative",
        opacity: active ? 1 : 0.75,
      }}
    >
      {active && (
        <div
          style={{
            position: "absolute",
            top: 14,
            right: 16,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: ".12em",
            textTransform: "uppercase",
            color: ACCENT,
          }}
        >
          You are here
        </div>
      )}
      <div style={{ fontSize: 18, fontWeight: 700, color: INK }}>
        {stage.title}{" "}
        <span style={{ fontSize: 13, fontWeight: 400, color: MUTED }}>
          ({stage.range})
        </span>
      </div>
      <div style={{ marginTop: 12, fontSize: 13.5, lineHeight: 1.55, color: INK }}>
        <span style={{ color: MUTED, fontWeight: 600 }}>Goal:</span> {stage.goal}
      </div>
      <div style={{ marginTop: 8, fontSize: 13.5, lineHeight: 1.55, color: INK }}>
        <span style={{ color: MUTED, fontWeight: 600 }}>Gate:</span> {stage.gate}
      </div>
    </div>
  );
}

const th: React.CSSProperties = {
  textAlign: "right",
  padding: "8px 12px",
  fontSize: 12,
  color: MUTED,
  fontWeight: 600,
  borderBottom: `1px solid ${RULE}`,
};
const td: React.CSSProperties = {
  textAlign: "right",
  padding: "8px 12px",
  fontSize: 13.5,
  color: INK,
  borderBottom: `1px solid ${RULE}`,
};

// ── Dashboard ────────────────────────────────────────────────────────────────
function Dashboard({ data }: { data: GrowthOverview }) {
  const { stage, users, revenue, tokens, retention } = data;
  return (
    <>
      <div
        style={{
          background: CARD,
          border: `1px solid ${RULE}`,
          borderRadius: 14,
          padding: "18px 22px",
          marginBottom: 24,
          display: "flex",
          alignItems: "baseline",
          gap: 14,
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontSize: 34, fontWeight: 800, color: INK }}>
          {num(stage.metric)}
        </div>
        <div style={{ fontSize: 13.5, color: MUTED, lineHeight: 1.5 }}>
          {stage.metricLabel}
        </div>
      </div>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        {STAGES.map((s) => (
          <StageCard key={s.key} stage={s} active={s.key === stage.current} />
        ))}
      </div>

      <SectionTitle>User growth</SectionTitle>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <Stat label="Registered users" value={num(users.registered)} sub={`${num(users.registeredLast30)} in the last 30 days`} />
        <Stat label="Unique visitors (all-time)" value={num(users.uniqueVisitorsAllTime)} />
        <Stat label="Newsletter subscribers" value={num(users.newsletterSubscribers)} sub="active (confirmed) subscribers" />
      </div>
      {users.monthly.length > 0 && (
        <div style={{ marginTop: 14, background: CARD, border: `1px solid ${RULE}`, borderRadius: 12, padding: "8px 10px", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: "left" }}>Month</th>
                <th style={th}>Unique visitors</th>
                <th style={th}>Pageviews</th>
                <th style={th}>New signups</th>
              </tr>
            </thead>
            <tbody>
              {users.monthly.map((m, i) => (
                <tr key={m.month}>
                  <td style={{ ...td, textAlign: "left", borderBottom: i === users.monthly.length - 1 ? "none" : td.borderBottom }}>{monthLabel(m.month)}</td>
                  <td style={{ ...td, borderBottom: i === users.monthly.length - 1 ? "none" : td.borderBottom }}>{num(m.visitors)}</td>
                  <td style={{ ...td, borderBottom: i === users.monthly.length - 1 ? "none" : td.borderBottom }}>{num(m.pageviews)}</td>
                  <td style={{ ...td, borderBottom: i === users.monthly.length - 1 ? "none" : td.borderBottom }}>{num(m.signups)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SectionTitle>Revenue</SectionTitle>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <Stat label="MRR" value={money(revenue.mrrCents, revenue.currency)} sub="monthly-normalized recurring revenue" />
        <Stat label="Active subscriptions" value={num(revenue.activeSubscriptions)} />
        <Stat label="Paying customers" value={num(revenue.payingCustomers)} />
        <Stat label="Lifetime revenue" value={revenue.lifetimeCents == null ? "—" : money(revenue.lifetimeCents, revenue.currency)} sub="all paid invoices" />
      </div>
      {revenue.byProduct.length > 0 && (
        <div style={{ marginTop: 14, background: CARD, border: `1px solid ${RULE}`, borderRadius: 12, padding: "14px 18px" }}>
          {revenue.byProduct.map((p) => (
            <div key={p.product} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 13.5, color: INK }}>
              <span>{p.product}</span>
              <span style={{ color: MUTED }}>
                {num(p.subscriptions)} sub{p.subscriptions === 1 ? "" : "s"} ·{" "}
                <span style={{ color: GOOD }}>{money(p.mrrCents, revenue.currency)}/mo</span>
              </span>
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop: 12, fontSize: 13, color: MUTED, lineHeight: 1.5 }}>
        <span style={{ fontWeight: 600, color: INK }}>CAC:</span> {revenue.cacNote}
      </div>

      <SectionTitle>Tokens used</SectionTitle>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <Stat label="Input tokens (30d)" value={num(tokens.last30Days.inputTokens)} sub={`${num(tokens.last30Days.trackedQuestions)} of ${num(tokens.last30Days.totalQuestions)} questions tracked`} />
        <Stat label="Output tokens (30d)" value={num(tokens.last30Days.outputTokens)} />
        <Stat label="Input tokens (all-time)" value={num(tokens.allTime.inputTokens)} sub={`${num(tokens.allTime.trackedQuestions)} of ${num(tokens.allTime.totalQuestions)} questions tracked`} />
        <Stat label="Output tokens (all-time)" value={num(tokens.allTime.outputTokens)} />
      </div>
      {tokens.bySource.length > 0 && (
        <div style={{ marginTop: 14, background: CARD, border: `1px solid ${RULE}`, borderRadius: 12, padding: "8px 10px", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: "left" }}>Agent surface</th>
                <th style={th}>Questions</th>
                <th style={th}>Input tokens</th>
                <th style={th}>Output tokens</th>
              </tr>
            </thead>
            <tbody>
              {tokens.bySource.map((s, i) => (
                <tr key={s.source}>
                  <td style={{ ...td, textAlign: "left", borderBottom: i === tokens.bySource.length - 1 ? "none" : td.borderBottom }}>{s.source}</td>
                  <td style={{ ...td, borderBottom: i === tokens.bySource.length - 1 ? "none" : td.borderBottom }}>{num(s.questions)}</td>
                  <td style={{ ...td, borderBottom: i === tokens.bySource.length - 1 ? "none" : td.borderBottom }}>{num(s.inputTokens)}</td>
                  <td style={{ ...td, borderBottom: i === tokens.bySource.length - 1 ? "none" : td.borderBottom }}>{num(s.outputTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ marginTop: 12, fontSize: 12.5, color: MUTED }}>{tokens.note}</div>

      <SectionTitle>Retention</SectionTitle>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <Stat label="Daily active" value={num(retention.dau)} sub="unique visitors, last 24h" />
        <Stat label="Weekly active" value={num(retention.wau)} sub="unique visitors, last 7 days" />
        <Stat label="Monthly active" value={num(retention.mau)} sub="unique visitors, last 30 days" />
        <Stat label="DAU / MAU" value={pct(retention.dauOverMau)} sub="stickiness" />
        <Stat label="Week-over-week return" value={pct(retention.weekOverWeekReturn)} sub="last week's visitors seen again this week" />
        <Stat label="Repeat visitor share" value={pct(retention.repeatVisitorShare)} sub="visitors active on 2+ distinct days" />
      </div>
      <div style={{ marginTop: 12, fontSize: 12.5, color: MUTED, lineHeight: 1.5 }}>{retention.basis}</div>

      <div style={{ marginTop: 40, fontSize: 12, color: MUTED }}>
        Live data · generated {new Date(data.generatedAt).toLocaleString()}
      </div>
    </>
  );
}

// ── Page (password gate + data load) ─────────────────────────────────────────
export default function Growth() {
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [pw, setPw] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwLoading, setPwLoading] = useState(false);

  const [data, setData] = useState<GrowthOverview | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    document.title = "Growth · Palonur";
    document.body.style.background = BG;
    return () => {
      document.body.style.background = "";
    };
  }, []);

  // Bridge: skip the prompt if a growth or platform-admin cookie is already set.
  useEffect(() => {
    fetch(`${API_BASE}/growth-auth/session`, { credentials: "include" })
      .then((r) => r.json())
      .then((j) => {
        if (j?.authed) setAuthed(true);
      })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    if (!authed) return;
    fetch(`${API_BASE}/growth/overview`, { credentials: "include" })
      .then((r) => {
        if (!r.ok) throw new Error("load failed");
        return r.json();
      })
      .then((j: GrowthOverview) => setData(j))
      .catch(() => setLoadError(true));
  }, [authed]);

  async function submitPw(e: React.FormEvent) {
    e.preventDefault();
    if (!pw.trim()) return;
    setPwLoading(true);
    setPwError(null);
    try {
      const res = await fetch(`${API_BASE}/growth-auth`, {
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
    <div
      style={{
        minHeight: "100vh",
        background: BG,
        color: INK,
        fontFamily:
          "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}
    >
      <div style={{ borderBottom: `1px solid ${RULE}`, padding: "22px 0" }}>
        <div style={{ maxWidth: 1080, margin: "0 auto", padding: "0 28px" }}>
          <div
            style={{
              fontSize: 12,
              letterSpacing: ".22em",
              textTransform: "uppercase",
              color: MUTED,
            }}
          >
            Palonur · Growth team
          </div>
          <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>
            Alpha → Beta → Scale
          </div>
        </div>
      </div>
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "32px 28px 80px" }}>
        {children}
      </div>
    </div>
  );

  if (checking) {
    return shell(
      <div style={{ color: MUTED, padding: "60px 0", textAlign: "center" }}>
        Loading…
      </div>,
    );
  }

  if (!authed) {
    return shell(
      <div style={{ maxWidth: 380, margin: "40px auto" }}>
        <form
          onSubmit={submitPw}
          style={{
            background: CARD,
            border: `1px solid ${RULE}`,
            borderRadius: 12,
            padding: "28px 26px",
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 700, color: INK, marginBottom: 6 }}>
            Enter access password
          </div>
          <div style={{ fontSize: 13, color: MUTED, marginBottom: 18, lineHeight: 1.5 }}>
            This is a private, read-only growth dashboard for the team.
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
              background: BG,
              color: INK,
              border: `1px solid ${RULE}`,
              borderRadius: 8,
              fontFamily: "inherit",
              boxSizing: "border-box",
            }}
          />
          {pwError && (
            <div style={{ fontSize: 12.5, color: "#f87171", marginTop: 8 }}>
              {pwError}
            </div>
          )}
          <button
            type="submit"
            disabled={pwLoading}
            style={{
              marginTop: 16,
              width: "100%",
              padding: "11px 0",
              background: ACCENT,
              color: "#fff",
              border: "none",
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 600,
              cursor: pwLoading ? "default" : "pointer",
              fontFamily: "inherit",
              opacity: pwLoading ? 0.7 : 1,
            }}
          >
            {pwLoading ? "Checking…" : "View dashboard"}
          </button>
        </form>
      </div>,
    );
  }

  if (loadError) {
    return shell(
      <div style={{ color: "#f87171", padding: "60px 0", textAlign: "center" }}>
        Could not load growth data. Please refresh.
      </div>,
    );
  }

  if (!data) {
    return shell(
      <div style={{ color: MUTED, padding: "60px 0", textAlign: "center" }}>
        Loading live metrics…
      </div>,
    );
  }

  return shell(<Dashboard data={data} />);
}
