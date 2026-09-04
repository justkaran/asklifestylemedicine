import { useState, useEffect, useCallback, Fragment } from "react";
import InvestorsPanel from "@/pages/admin-investors";
import AgentAccessPanel from "@/pages/admin-agent-access";
import IpProtectionPanel from "@/pages/admin-ip-protection";

const API_BASE = "/api";
const STORAGE_KEY = "palonur_admin_authed";

interface AnalyticsTotals {
  total_pageviews: number;
  total_sessions: number;
  avg_duration_sec: string | null;
}
interface DailyRow {
  date: string;
  sessions: number;
  pageviews: number;
}
interface PageRow {
  page: string;
  views: number;
  avg_duration_sec: string | null;
}
interface RefRow {
  domain: string;
  visits: number;
}
interface DeviceRow {
  device: string;
  count: number;
}
interface SessionRow {
  session_id: string;
  first_seen: string;
  pages_viewed: number;
  journey: string;
  referrer_domain: string;
  device: string;
  country: string | null;
  city: string | null;
}
interface CountryRow {
  country: string;
  country_code: string;
  sessions: number;
  pageviews: number;
}
interface WaitlistEntry {
  id: number;
  name: string;
  email: string;
  source: string;
  created_at: string;
}
interface PhoneEntry {
  id: number;
  phone: string;
  product: string;
  status: string;
  source: string | null;
  consentAt: string | null;
  confirmedAt: string | null;
  optedOutAt: string | null;
  createdAt: string;
}

interface StripeMode {
  status: "test" | "live" | "unknown" | "not_connected" | "unavailable";
  accountId: string | null;
}

interface EmailLabelRow {
  label: string;
  sentToday: number;
  sentThisMonth: number;
}
interface EmailVolume {
  day: string;
  month: string;
  sentToday: number;
  sentThisMonth: number;
  dailyCap: number;
  monthlyCap: number;
  byLabel: EmailLabelRow[];
}
interface Analytics {
  totals: AnalyticsTotals;
  daily: DailyRow[];
  pages: PageRow[];
  referrers: RefRow[];
  devices: DeviceRow[];
  countries: CountryRow[];
  recentSessions: SessionRow[];
}

interface Overview {
  totalUsers: number;
  totalQuestions: number;
  totalCommitments: number;
  avgQuestionsPerUser: number;
  checkinUsers: number;
  commitUsers: number;
  retained7d: number;
  eligible7d: number;
}

interface UserRow {
  id: number;
  first_name: string;
  email: string;
  created_at: string;
  question_count: number;
  sleep_log_count: number;
  commitment_count: number;
  checkin_count: number;
  last_active: string | null;
}

interface Question {
  id: number;
  original_question: string;
  clarify_question: string | null;
  clarify_answer: string | null;
  ai_answer: string;
  article_url: string | null;
  created_at: string;
}

interface SleepLog {
  id: number;
  log_date: string;
  quality: number;
  note: string | null;
  created_at: string;
}

interface Commitment {
  id: number;
  action_text: string;
  sleep_question: string | null;
  created_at: string;
}

interface Checkin {
  id: number;
  checkin_date: string;
  did_it: boolean;
  commitment_id: number;
  created_at: string;
}

interface UserDetail {
  user: UserRow;
  questions: Question[];
  sleepLogs: SleepLog[];
  commitments: Commitment[];
  checkins: Checkin[];
}

type PersonSourceType =
  | "account"
  | "billing"
  | "newsletter"
  | "waitlist"
  | "beta"
  | "investor"
  | "story"
  | "partner";

interface PersonSource {
  type: PersonSourceType;
  status: string | null;
  detail: string | null;
}

interface Person {
  email: string;
  name: string | null;
  sources: PersonSource[];
  palonurUserId: number | null;
  consumerAccountId: number | null;
  createdAt: string | null;
}

interface PeopleResponse {
  people: Person[];
  total: number;
  totalPeople: number;
  counts: Record<PersonSourceType, number>;
  generatedAt: string;
}

const PEOPLE_LIMIT = 100;

const SOURCE_OPTIONS: PersonSourceType[] = [
  "account",
  "billing",
  "newsletter",
  "waitlist",
  "beta",
  "investor",
  "story",
  "partner",
];

const SOURCE_LABEL: Record<PersonSourceType, string> = {
  account: "Account",
  billing: "Billing",
  newsletter: "Newsletter",
  waitlist: "Waitlist",
  beta: "Beta",
  investor: "Investor",
  story: "Story",
  partner: "Partner",
};

const SOURCE_COLOR: Record<PersonSourceType, { bg: string; fg: string }> = {
  account: { bg: "#eef3ff", fg: "#2952cc" },
  billing: { bg: "#eafaf0", fg: "#1a8c4a" },
  newsletter: { bg: "#fdeef6", fg: "#b3236f" },
  waitlist: { bg: "#fff5e6", fg: "#9c6406" },
  beta: { bg: "#f0f7ff", fg: "#0066cc" },
  investor: { bg: "#f0ecff", fg: "#5b34c4" },
  story: { bg: "#fdeeea", fg: "#b5391a" },
  partner: { bg: "#e7f6f8", fg: "#0f7f93" },
};

// Curated status values across all sources, for the status filter dropdown.
const STATUS_OPTIONS = [
  "active",
  "pending",
  "unsubscribed",
  "bounced",
  "waiting",
  "lead",
  "committed",
  "passed",
  "new",
  "in_edit",
  "approved",
  "archived",
  "revoked",
  "stripe-linked",
  "registered",
  "booked",
  "cancelled",
];

function SourceBadge({ source }: { source: PersonSource }) {
  const c = SOURCE_COLOR[source.type] ?? { bg: "#eee", fg: "#555" };
  const label = SOURCE_LABEL[source.type] ?? source.type;
  const title = [label, source.status, source.detail]
    .filter(Boolean)
    .join(" · ");
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        borderRadius: 20,
        background: c.bg,
        color: c.fg,
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {label}
      {source.status ? (
        <span style={{ opacity: 0.75, fontWeight: 500 }}>
          · {source.status}
        </span>
      ) : null}
    </span>
  );
}

function CountChip({
  label,
  value,
  active,
  onClick,
}: {
  label: string;
  value: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        border: active ? "1px solid #8B1A1A" : "1px solid #e8dede",
        background: active ? "#8B1A1A" : "#fff",
        color: active ? "#fff" : "#666",
        borderRadius: 20,
        padding: "4px 12px",
        fontSize: 12,
        fontWeight: 600,
        cursor: "pointer",
        display: "inline-flex",
        gap: 6,
        alignItems: "center",
      }}
    >
      {label}
      <span style={{ opacity: active ? 0.85 : 0.6 }}>{value}</span>
    </button>
  );
}

const QUALITY_LABEL: Record<number, string> = {
  1: "Difficult",
  2: "Restless",
  3: "Fair",
  4: "Good",
  5: "Excellent",
};

function fmt(dateStr: string | null) {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function fmtTime(dateStr: string | null) {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function headers() {
  return {} as Record<string, string>;
}

// Read-only badge: shows whether Stripe is in TEST (sandbox) or LIVE
// (real-payments) mode for this environment. The mode follows the connected
// Stripe account/environment — there is no runtime toggle (mixing test + live
// against the single synced data mirror would corrupt who counts as paying).
function StripeModeBadge({ info }: { info: StripeMode | null }) {
  let bg = "rgba(255,255,255,0.10)";
  let border = "1px solid rgba(255,255,255,0.25)";
  let dot = "rgba(255,255,255,0.6)";
  let label: string;
  let title: string;
  if (!info) {
    label = "Stripe · checking…";
    title = "Checking Stripe mode…";
  } else if (info.status === "live") {
    bg = "rgba(34,197,94,0.20)";
    border = "1px solid rgba(74,222,128,0.6)";
    dot = "#4ade80";
    label = "Live · real payments";
    title = `LIVE mode — real cards are charged.${info.accountId ? ` Account ${info.accountId}.` : ""}`;
  } else if (info.status === "test") {
    bg = "rgba(251,191,36,0.20)";
    border = "1px solid rgba(251,191,36,0.6)";
    dot = "#fbbf24";
    label = "Test · sandbox";
    title = `TEST/sandbox mode — no real charges.${info.accountId ? ` Account ${info.accountId}.` : ""}`;
  } else if (info.status === "not_connected") {
    label = "Stripe not connected";
    title = "No Stripe integration is connected to this environment.";
  } else if (info.status === "unavailable") {
    label = "Stripe mode unavailable";
    title = "Couldn't reach Stripe to determine the mode. Try refreshing.";
  } else {
    label = "Stripe: unknown mode";
    title = "Stripe is connected, but the key prefix wasn't recognized.";
  }
  return (
    <div
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        background: bg,
        border,
        color: "#fff",
        borderRadius: 999,
        padding: "4px 12px",
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: ".04em",
        textTransform: "uppercase",
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: dot,
          display: "inline-block",
        }}
      />
      {label}
    </div>
  );
}

function MetricCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #e8e0e0",
        borderRadius: 12,
        padding: "20px 24px",
        minWidth: 140,
      }}
    >
      <div
        style={{
          fontSize: 28,
          fontWeight: 700,
          color: "#8B1A1A",
          letterSpacing: "-0.02em",
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: "#666",
          letterSpacing: ".06em",
          textTransform: "uppercase",
          marginTop: 4,
        }}
      >
        {label}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: "#aaa", marginTop: 2 }}>{sub}</div>
      )}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: ".14em",
          textTransform: "uppercase",
          color: "#8B1A1A",
          marginBottom: 12,
          paddingBottom: 8,
          borderBottom: "1px solid rgba(139,26,26,.15)",
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function Bar({
  value,
  max,
  color = "#8B1A1A",
}: {
  value: number;
  max: number;
  color?: string;
}) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div
      style={{
        flex: 1,
        height: 6,
        background: "#f0e8e8",
        borderRadius: 3,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: `${pct}%`,
          height: "100%",
          background: color,
          borderRadius: 3,
          transition: "width .3s",
        }}
      />
    </div>
  );
}

function TrafficPanel({
  analytics,
  loading,
  onSendDigest,
  digestSending,
  digestMsg,
  includeBots,
  onToggleBots,
}: {
  analytics: Analytics | null;
  loading: boolean;
  onSendDigest: () => void;
  digestSending: boolean;
  digestMsg: { ok: boolean; text: string } | null;
  includeBots: boolean;
  onToggleBots: (v: boolean) => void;
}) {
  const digestBar = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        flexWrap: "wrap",
        marginBottom: 24,
      }}
    >
      <button
        onClick={onSendDigest}
        disabled={digestSending}
        style={{
          background: digestSending ? "#c98a8a" : "#8B1A1A",
          color: "#fff",
          border: "none",
          borderRadius: 8,
          padding: "10px 18px",
          fontSize: 14,
          fontWeight: 600,
          cursor: digestSending ? "default" : "pointer",
        }}
      >
        {digestSending ? "Sending…" : "Email me the daily digest now"}
      </button>
      {digestMsg && (
        <span
          style={{ fontSize: 13, color: digestMsg.ok ? "#2e7d32" : "#b3261e" }}
        >
          {digestMsg.text}
        </span>
      )}
      <span style={{ fontSize: 12, color: "#aaa" }}>
        Sends the same report that goes out automatically at 7am Pacific.
      </span>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 13,
          color: "#555",
          cursor: "pointer",
          marginLeft: "auto",
        }}
      >
        <input
          type="checkbox"
          checked={includeBots}
          onChange={(e) => onToggleBots(e.target.checked)}
        />
        Include bots &amp; crawlers
      </label>
    </div>
  );

  if (loading)
    return (
      <div style={{ color: "#aaa", padding: "48px 0" }}>
        Loading traffic data…
      </div>
    );
  if (!analytics)
    return (
      <div>
        {digestBar}
        <div style={{ color: "#aaa", padding: "24px 0" }}>No data yet.</div>
      </div>
    );

  const {
    totals,
    daily,
    pages,
    referrers,
    devices,
    countries,
    recentSessions,
  } = analytics;
  const maxSessions = Math.max(...daily.map((d) => d.sessions), 1);
  const maxPageViews = Math.max(...pages.map((p) => p.views), 1);
  const maxRef = Math.max(...referrers.map((r) => r.visits), 1);
  const maxCountry = Math.max(...(countries ?? []).map((c) => c.sessions), 1);
  const totalDev = devices.reduce((s, d) => s + d.count, 0);

  const pageLabel: Record<string, string> = {
    home: "Home",
    "sleep-agent": "Sleep Agent",
    journey: "Journey",
    settings: "Settings",
    admin: "Admin",
  };

  function fmtDur(sec: string | null) {
    if (!sec) return "—";
    const s = parseFloat(sec);
    if (isNaN(s)) return "—";
    if (s < 60) return `${Math.round(s)}s`;
    return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  }

  return (
    <div>
      {digestBar}
      {/* Top metrics */}
      <div
        style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 36 }}
      >
        <MetricCard label="Sessions (30d)" value={totals.total_sessions} />
        <MetricCard label="Page views (30d)" value={totals.total_pageviews} />
        <MetricCard
          label="Avg time on page"
          value={fmtDur(totals.avg_duration_sec)}
        />
        <MetricCard
          label="Pages / session"
          value={
            totals.total_sessions > 0
              ? (totals.total_pageviews / totals.total_sessions).toFixed(1)
              : "—"
          }
        />
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 20,
          marginBottom: 24,
        }}
      >
        {/* Daily sessions chart */}
        <div
          style={{
            background: "#fff",
            borderRadius: 14,
            border: "1px solid #e8e0e0",
            padding: "20px 24px",
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: ".12em",
              textTransform: "uppercase",
              color: "#8B1A1A",
              marginBottom: 16,
            }}
          >
            Daily Sessions — last 30 days
          </div>
          {daily.length === 0 ? (
            <div style={{ color: "#ccc", fontSize: 13 }}>No data yet</div>
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "flex-end",
                gap: 3,
                height: 80,
              }}
            >
              {daily.map((d) => {
                const h =
                  maxSessions > 0
                    ? Math.max(4, Math.round((d.sessions / maxSessions) * 80))
                    : 4;
                return (
                  <div
                    key={d.date}
                    title={`${d.date}: ${d.sessions} sessions`}
                    style={{
                      flex: 1,
                      height: h,
                      background: "#8B1A1A",
                      borderRadius: "2px 2px 0 0",
                      minWidth: 4,
                      opacity: 0.8,
                    }}
                  />
                );
              })}
            </div>
          )}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 10,
              color: "#bbb",
              marginTop: 4,
            }}
          >
            <span>{daily[0]?.date?.slice(5) ?? ""}</span>
            <span>{daily[daily.length - 1]?.date?.slice(5) ?? ""}</span>
          </div>
        </div>

        {/* Device breakdown */}
        <div
          style={{
            background: "#fff",
            borderRadius: 14,
            border: "1px solid #e8e0e0",
            padding: "20px 24px",
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: ".12em",
              textTransform: "uppercase",
              color: "#8B1A1A",
              marginBottom: 16,
            }}
          >
            Devices
          </div>
          {devices.map((d) => (
            <div key={d.device} style={{ marginBottom: 10 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 13,
                  marginBottom: 4,
                }}
              >
                <span>{d.device}</span>
                <span style={{ color: "#888" }}>
                  {d.count} (
                  {totalDev > 0 ? Math.round((d.count / totalDev) * 100) : 0}%)
                </span>
              </div>
              <Bar value={d.count} max={totalDev} />
            </div>
          ))}
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 20,
          marginBottom: 24,
        }}
      >
        {/* Pages */}
        <div
          style={{
            background: "#fff",
            borderRadius: 14,
            border: "1px solid #e8e0e0",
            padding: "20px 24px",
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: ".12em",
              textTransform: "uppercase",
              color: "#8B1A1A",
              marginBottom: 16,
            }}
          >
            Pages
          </div>
          {pages.map((p) => (
            <div key={p.page} style={{ marginBottom: 12 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 13,
                  marginBottom: 4,
                }}
              >
                <span style={{ fontWeight: 500 }}>
                  {pageLabel[p.page] ?? p.page}
                </span>
                <span style={{ color: "#888" }}>
                  {p.views} views · {fmtDur(p.avg_duration_sec)}
                </span>
              </div>
              <Bar value={p.views} max={maxPageViews} />
            </div>
          ))}
        </div>

        {/* Referrers */}
        <div
          style={{
            background: "#fff",
            borderRadius: 14,
            border: "1px solid #e8e0e0",
            padding: "20px 24px",
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: ".12em",
              textTransform: "uppercase",
              color: "#8B1A1A",
              marginBottom: 16,
            }}
          >
            Where visitors came from
          </div>
          {referrers.map((r) => (
            <div key={r.domain} style={{ marginBottom: 12 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 13,
                  marginBottom: 4,
                }}
              >
                <span style={{ fontWeight: 500 }}>{r.domain}</span>
                <span style={{ color: "#888" }}>{r.visits}</span>
              </div>
              <Bar value={r.visits} max={maxRef} color="#5a6b8c" />
            </div>
          ))}
        </div>
      </div>

      {/* Countries */}
      <div
        style={{
          background: "#fff",
          borderRadius: 14,
          border: "1px solid #e8e0e0",
          padding: "20px 24px",
          marginBottom: 24,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: ".12em",
            textTransform: "uppercase",
            color: "#8B1A1A",
            marginBottom: 16,
          }}
        >
          Locations
        </div>
        {!countries || countries.length === 0 ? (
          <div style={{ color: "#ccc", fontSize: 13 }}>
            No location data yet — enriched as visitors arrive
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
              gap: "10px 32px",
            }}
          >
            {countries.map((c) => (
              <div key={c.country} style={{ marginBottom: 4 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 13,
                    marginBottom: 4,
                  }}
                >
                  <span style={{ fontWeight: 500 }}>
                    {c.country_code && (
                      <img
                        src={`https://flagcdn.com/20x15/${c.country_code.toLowerCase()}.png`}
                        alt=""
                        style={{
                          marginRight: 8,
                          verticalAlign: "middle",
                          borderRadius: 2,
                        }}
                      />
                    )}
                    {c.country}
                  </span>
                  <span style={{ color: "#888" }}>
                    {c.sessions} session{c.sessions !== 1 ? "s" : ""}
                    <span style={{ color: "#ccc", margin: "0 4px" }}>·</span>
                    {c.pageviews} views
                  </span>
                </div>
                <Bar value={c.sessions} max={maxCountry} color="#4a7c59" />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent sessions */}
      <div
        style={{
          background: "#fff",
          borderRadius: 14,
          border: "1px solid #e8e0e0",
          overflow: "hidden",
          marginBottom: 24,
        }}
      >
        <div
          style={{
            padding: "16px 24px",
            borderBottom: "1px solid #f0e8e8",
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: ".12em",
            textTransform: "uppercase",
            color: "#8B1A1A",
          }}
        >
          Recent sessions (last 7 days)
        </div>
        <div style={{ overflowX: "auto" }}>
          <table
            style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}
          >
            <thead>
              <tr style={{ background: "#faf7f7" }}>
                {["Time", "Location", "Device", "From", "Pages", "Journey"].map(
                  (h) => (
                    <th
                      key={h}
                      style={{
                        padding: "10px 16px",
                        textAlign: "left",
                        color: "#888",
                        fontWeight: 600,
                        fontSize: 11,
                        letterSpacing: ".04em",
                      }}
                    >
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {recentSessions.map((s) => (
                <tr
                  key={s.session_id}
                  style={{ borderTop: "1px solid #f5f0f0" }}
                >
                  <td
                    style={{
                      padding: "10px 16px",
                      whiteSpace: "nowrap",
                      color: "#555",
                    }}
                  >
                    {new Date(s.first_seen).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </td>
                  <td
                    style={{
                      padding: "10px 16px",
                      color: "#555",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {s.city && s.country
                      ? `${s.city}, ${s.country}`
                      : (s.country ?? "—")}
                  </td>
                  <td style={{ padding: "10px 16px", color: "#555" }}>
                    {s.device}
                  </td>
                  <td style={{ padding: "10px 16px", color: "#555" }}>
                    {s.referrer_domain}
                  </td>
                  <td
                    style={{
                      padding: "10px 16px",
                      color: "#8B1A1A",
                      fontWeight: 600,
                    }}
                  >
                    {s.pages_viewed}
                  </td>
                  <td
                    style={{
                      padding: "10px 16px",
                      color: "#888",
                      maxWidth: 260,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {s.journey}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Pilot audit trail ─────────────────────────────────────────────────

type AuditOutcome = "answered" | "refused" | "uncovered";

interface AuditCitation {
  sourceId: number;
  title: string;
  authors: string | null;
  year: number | null;
}

interface AuditRowData {
  id: string;
  createdAt: string;
  source: string;
  question: string;
  outcome: AuditOutcome;
  topScore: number;
  citationVerification: "verified" | "unmatched" | "missing" | null;
  citationLine: string | null;
  citations: AuditCitation[];
  userFlagged: boolean;
  flagReason: string | null;
}

interface AuditSummary {
  total: number;
  answered: number;
  refused: number;
  uncovered: number;
  flagged: number;
  answeredVerified: number;
  answeredUnmatched: number;
  answeredMissing: number;
}

interface AuditResponse {
  summary: AuditSummary;
  rows: AuditRowData[];
  filteredTotal: number;
  truncated: boolean;
  generatedAt: string;
}

const OUTCOME_BADGE: Record<
  AuditOutcome,
  { label: string; bg: string; fg: string }
> = {
  answered: { label: "Answered", bg: "rgba(34,139,76,0.10)", fg: "#1f7a44" },
  refused: {
    label: "Refused · off-topic",
    bg: "rgba(139,26,26,0.08)",
    fg: "#8B1A1A",
  },
  uncovered: {
    label: "Refused · out of scope",
    bg: "rgba(180,120,20,0.10)",
    fg: "#9a6a12",
  },
};

const VERIFY_BADGE: Record<string, { label: string; bg: string; fg: string }> =
  {
    verified: {
      label: "Citation verified",
      bg: "rgba(34,139,76,0.10)",
      fg: "#1f7a44",
    },
    unmatched: {
      label: "Citation unmatched",
      bg: "rgba(192,57,43,0.10)",
      fg: "#c0392b",
    },
    missing: { label: "No citation", bg: "rgba(0,0,0,0.05)", fg: "#888" },
  };

interface EditorRow {
  id: number;
  email: string;
  addedBy: string | null;
  createdAt: string;
}

function EditorAllowlistPanel() {
  const [editors, setEditors] = useState<EditorRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/stories-editors`, {
        credentials: "include",
        headers: headers(),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setEditors(d.editors as EditorRow[]);
    } catch (e: any) {
      setError(String(e.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const email = newEmail.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      setError("Enter a valid email.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/stories-editors`, {
        method: "POST",
        credentials: "include",
        headers: { ...headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setNewEmail("");
      await load();
    } catch (e: any) {
      setError(String(e.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number, email: string) {
    if (
      !window.confirm(
        `Remove ${email} from the editor list? They will no longer be able to sign in at /stories-login.`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/stories-editors/${id}`, {
        method: "DELETE",
        credentials: "include",
        headers: headers(),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await load();
    } catch (e: any) {
      setError(String(e.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        marginTop: 28,
        background: "#fff",
        border: "1px solid #e8e0e0",
        borderRadius: 12,
        padding: "18px 20px",
        maxWidth: 560,
      }}
    >
      <div
        style={{
          fontSize: 15,
          fontWeight: 700,
          color: "#1a0505",
          marginBottom: 4,
        }}
      >
        Editor access
      </div>
      <div
        style={{
          fontSize: 12,
          color: "#888",
          marginBottom: 14,
          lineHeight: 1.5,
        }}
      >
        Who may sign in as a Stories &amp; Newsletter editor at{" "}
        <span style={{ color: "#8B1A1A" }}>/stories-login</span>. Changes take
        effect immediately — no settings change needed. Removing an editor does
        not affect admin access.
      </div>

      <form
        onSubmit={add}
        style={{ display: "flex", gap: 8, marginBottom: 14 }}
      >
        <input
          type="email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          placeholder="editor@example.com"
          style={{
            flex: 1,
            padding: "9px 12px",
            borderRadius: 8,
            border: "1px solid #e0d8d8",
            fontSize: 13,
          }}
        />
        <button
          type="submit"
          disabled={busy}
          style={{
            background: "#8B1A1A",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            padding: "9px 16px",
            fontSize: 13,
            fontWeight: 600,
            cursor: busy ? "default" : "pointer",
            opacity: busy ? 0.6 : 1,
          }}
        >
          Add editor
        </button>
      </form>

      {error && (
        <div style={{ color: "#c0392b", fontSize: 12, marginBottom: 10 }}>
          {error}
        </div>
      )}

      {loading && !editors ? (
        <div style={{ color: "#aaa", fontSize: 13, padding: "12px 0" }}>
          Loading…
        </div>
      ) : !editors || editors.length === 0 ? (
        <div style={{ color: "#aaa", fontSize: 13, padding: "12px 0" }}>
          No editors yet.
        </div>
      ) : (
        <div>
          {editors.map((ed) => (
            <div
              key={ed.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "9px 0",
                borderTop: "1px solid #f3eded",
              }}
            >
              <div>
                <span
                  style={{ fontSize: 13, color: "#1a0505", fontWeight: 500 }}
                >
                  {ed.email}
                </span>
                {ed.addedBy === "seed" && (
                  <span style={{ fontSize: 11, color: "#aaa", marginLeft: 8 }}>
                    default
                  </span>
                )}
              </div>
              <button
                onClick={() => remove(ed.id, ed.email)}
                disabled={busy}
                style={{
                  background: "transparent",
                  color: "#c0392b",
                  border: "1px solid #e8cfcf",
                  borderRadius: 6,
                  padding: "5px 12px",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: busy ? "default" : "pointer",
                }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AuditPanel() {
  // Default window: trailing 30 days, inclusive of today.
  const today = new Date();
  const monthAgo = new Date(today.getTime() - 29 * 24 * 60 * 60 * 1000);
  const isoDay = (d: Date) => d.toISOString().slice(0, 10);

  const [from, setFrom] = useState(isoDay(monthAgo));
  const [to, setTo] = useState(isoDay(today));
  const [filter, setFilter] = useState<"all" | "answered" | "refused">("all");
  const [data, setData] = useState<AuditResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function buildParams(extra?: Record<string, string>) {
    const p = new URLSearchParams();
    if (from) p.set("from", `${from}T00:00:00.000Z`);
    if (to) p.set("to", `${to}T23:59:59.999Z`);
    if (filter !== "all") p.set("filter", filter);
    for (const [k, v] of Object.entries(extra ?? {})) p.set(k, v);
    return p;
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(
      `${API_BASE}/admin/audit?${buildParams({ limit: "500" }).toString()}`,
      {
        credentials: "include",
        headers: headers(),
      },
    )
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<AuditResponse>;
      })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e.message ?? e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, filter]);

  const summary = data?.summary;

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <div
          style={{
            fontSize: 20,
            fontWeight: 700,
            color: "#1a0505",
            marginBottom: 4,
          }}
        >
          Answer & Refusal Audit Trail
        </div>
        <div
          style={{
            fontSize: 13,
            color: "#888",
            maxWidth: 720,
            lineHeight: 1.5,
          }}
        >
          Every public agent interaction, with its grounding receipts. Answers
          are drawn only from approved Stanford sleep-science sources; questions
          outside that scope are cleanly refused — a deliberate governance
          signal, not a gap. No personal data is shown or exported.
        </div>
      </div>

      {/* Controls */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          alignItems: "flex-end",
          marginBottom: 24,
          background: "#fff",
          border: "1px solid #e8e0e0",
          borderRadius: 12,
          padding: "16px 20px",
        }}
      >
        <label style={{ fontSize: 12, color: "#666", fontWeight: 600 }}>
          <div style={{ marginBottom: 4 }}>From</div>
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
            style={{
              padding: "8px 10px",
              borderRadius: 8,
              border: "1px solid #e0d8d8",
              fontSize: 13,
            }}
          />
        </label>
        <label style={{ fontSize: 12, color: "#666", fontWeight: 600 }}>
          <div style={{ marginBottom: 4 }}>To</div>
          <input
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
            style={{
              padding: "8px 10px",
              borderRadius: 8,
              border: "1px solid #e0d8d8",
              fontSize: 13,
            }}
          />
        </label>
        <label style={{ fontSize: 12, color: "#666", fontWeight: 600 }}>
          <div style={{ marginBottom: 4 }}>Show</div>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as typeof filter)}
            style={{
              padding: "8px 10px",
              borderRadius: 8,
              border: "1px solid #e0d8d8",
              fontSize: 13,
              background: "#fff",
            }}
          >
            <option value="all">All interactions</option>
            <option value="answered">Answered only</option>
            <option value="refused">Refusals only</option>
          </select>
        </label>
        <div style={{ flex: 1 }} />
        <a
          href={`${API_BASE}/admin/audit/export?${buildParams().toString()}`}
          style={{
            background: "#8B1A1A",
            color: "#fff",
            textDecoration: "none",
            borderRadius: 8,
            padding: "9px 16px",
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          ↓ Export CSV
        </a>
        <button
          onClick={() => window.print()}
          style={{
            background: "#fff",
            color: "#8B1A1A",
            border: "1px solid #d9c8c8",
            borderRadius: 8,
            padding: "9px 16px",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          ⎙ Print / PDF
        </button>
      </div>

      {/* Summary */}
      {summary && (
        <div
          style={{
            marginBottom: 14,
            fontSize: 14,
            color: "#444",
            lineHeight: 1.6,
          }}
        >
          <strong style={{ color: "#1a0505" }}>
            {summary.answeredVerified}
          </strong>{" "}
          answered with verified citations
          {summary.answeredUnmatched > 0 && (
            <>
              {" "}
              ·{" "}
              <strong style={{ color: "#c0392b" }}>
                {summary.answeredUnmatched}
              </strong>{" "}
              with an unverified citation
            </>
          )}
          {" · "}
          <strong style={{ color: "#1a0505" }}>
            {summary.refused + summary.uncovered}
          </strong>{" "}
          cleanly refused as out-of-scope
          {summary.flagged > 0 && (
            <>
              {" "}
              · <strong style={{ color: "#9a6a12" }}>
                {summary.flagged}
              </strong>{" "}
              user-flagged
            </>
          )}
          {" · "}
          <span style={{ color: "#888" }}>{summary.total} total in window</span>
        </div>
      )}
      {summary && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 12,
            marginBottom: 28,
          }}
        >
          <MetricCard label="Total" value={summary.total} />
          <MetricCard
            label="Answered"
            value={summary.answered}
            sub={`${summary.answeredVerified} verified`}
          />
          <MetricCard label="Refused (off-topic)" value={summary.refused} />
          <MetricCard label="Out of coverage" value={summary.uncovered} />
          <MetricCard label="User-flagged" value={summary.flagged} />
        </div>
      )}

      {data?.truncated && (
        <div style={{ fontSize: 12, color: "#9a6a12", marginBottom: 12 }}>
          Showing the most recent {summary?.total} interactions — narrow the
          date range for the full picture.
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div style={{ color: "#aaa", padding: "48px 0" }}>
          Loading audit trail…
        </div>
      ) : error ? (
        <div style={{ color: "#c0392b", padding: "32px 0" }}>
          Couldn't load the audit trail: {error}
        </div>
      ) : !data || data.rows.length === 0 ? (
        <div style={{ color: "#aaa", padding: "48px 0" }}>
          No interactions in this window yet.
        </div>
      ) : (
        <div
          style={{
            background: "#fff",
            borderRadius: 14,
            border: "1px solid #e8e0e0",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "12px 20px",
              background: "#faf7f7",
              borderBottom: "1px solid #f0e8e8",
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: ".12em",
                textTransform: "uppercase",
                color: "#8B1A1A",
              }}
            >
              {data.filteredTotal} interaction
              {data.filteredTotal === 1 ? "" : "s"}
            </span>
          </div>
          {data.rows.map((r) => {
            const badge = OUTCOME_BADGE[r.outcome];
            const vb =
              r.outcome === "answered" && r.citationVerification
                ? VERIFY_BADGE[r.citationVerification]
                : null;
            return (
              <div
                key={r.id}
                style={{
                  padding: "16px 20px",
                  borderTop: "1px solid #f5f0f0",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    flexWrap: "wrap",
                    marginBottom: 8,
                  }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      padding: "3px 9px",
                      borderRadius: 6,
                      background: badge.bg,
                      color: badge.fg,
                    }}
                  >
                    {badge.label}
                  </span>
                  {vb && (
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        padding: "3px 9px",
                        borderRadius: 6,
                        background: vb.bg,
                        color: vb.fg,
                      }}
                    >
                      {vb.label}
                    </span>
                  )}
                  {r.userFlagged && (
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        padding: "3px 9px",
                        borderRadius: 6,
                        background: "rgba(180,120,20,0.10)",
                        color: "#9a6a12",
                      }}
                    >
                      ⚑ Flagged{r.flagReason ? `: ${r.flagReason}` : ""}
                    </span>
                  )}
                  <span
                    style={{ fontSize: 11, color: "#aaa", marginLeft: "auto" }}
                  >
                    {r.source} · {fmtTime(r.createdAt)} · confidence{" "}
                    {r.topScore ? r.topScore.toFixed(2) : "—"}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: "#1a0505",
                    marginBottom: 6,
                  }}
                >
                  {r.question}
                </div>
                {r.citationLine && (
                  <div
                    style={{
                      fontSize: 12,
                      color: "#777",
                      marginBottom: 6,
                      fontStyle: "italic",
                    }}
                  >
                    Cited: {r.citationLine}
                  </div>
                )}
                {r.citations.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {r.citations.map((c) => (
                      <span
                        key={c.sourceId}
                        style={{
                          fontSize: 11,
                          color: "#555",
                          background: "#faf6f6",
                          border: "1px solid #f0e8e8",
                          borderRadius: 6,
                          padding: "3px 8px",
                        }}
                      >
                        {c.title}
                        {c.year ? ` (${c.year})` : ""}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CapBar({ used, cap }: { used: number; cap: number }) {
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  const color = pct >= 90 ? "#c0392b" : pct >= 70 ? "#9a6a12" : "#8B1A1A";
  return (
    <div style={{ marginTop: 10 }}>
      <div
        style={{
          height: 8,
          background: "#f0e8e8",
          borderRadius: 6,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: color,
            transition: "width .2s",
          }}
        />
      </div>
      <div style={{ fontSize: 11, color: "#888", marginTop: 6 }}>
        {used} of {cap} ({pct}%)
      </div>
    </div>
  );
}

function EmailVolumePanel() {
  const [data, setData] = useState<EmailVolume | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/admin/email-volume`, {
      credentials: "include",
      headers: headers(),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<EmailVolume>;
      })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e.message ?? e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <div
          style={{
            fontSize: 20,
            fontWeight: 700,
            color: "#1a0505",
            marginBottom: 4,
          }}
        >
          Email Volume
        </div>
        <div
          style={{
            fontSize: 13,
            color: "#888",
            maxWidth: 720,
            lineHeight: 1.5,
          }}
        >
          Successful transactional sends against the configured Resend caps,
          broken down by feature. Counts cover the current UTC day and month.
          Recipient addresses are never stored — only a one-way hash — so
          nothing here exposes who was emailed.
        </div>
      </div>

      {loading ? (
        <div style={{ color: "#aaa", padding: "48px 0" }}>Loading…</div>
      ) : error ? (
        <div style={{ color: "#c0392b", padding: "32px 0" }}>
          Couldn't load email volume: {error}
        </div>
      ) : !data ? null : (
        <>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 14,
              marginBottom: 28,
            }}
          >
            <div
              style={{
                background: "#fff",
                border: "1px solid #e8e0e0",
                borderRadius: 12,
                padding: "20px 24px",
                minWidth: 240,
                flex: 1,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: "#666",
                  letterSpacing: ".06em",
                  textTransform: "uppercase",
                }}
              >
                Today ({data.day})
              </div>
              <div
                style={{
                  fontSize: 28,
                  fontWeight: 700,
                  color: "#8B1A1A",
                  letterSpacing: "-0.02em",
                  marginTop: 6,
                }}
              >
                {data.sentToday}
              </div>
              <CapBar used={data.sentToday} cap={data.dailyCap} />
            </div>
            <div
              style={{
                background: "#fff",
                border: "1px solid #e8e0e0",
                borderRadius: 12,
                padding: "20px 24px",
                minWidth: 240,
                flex: 1,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: "#666",
                  letterSpacing: ".06em",
                  textTransform: "uppercase",
                }}
              >
                This month ({data.month})
              </div>
              <div
                style={{
                  fontSize: 28,
                  fontWeight: 700,
                  color: "#8B1A1A",
                  letterSpacing: "-0.02em",
                  marginTop: 6,
                }}
              >
                {data.sentThisMonth}
              </div>
              <CapBar used={data.sentThisMonth} cap={data.monthlyCap} />
            </div>
          </div>

          <div
            style={{
              background: "#fff",
              borderRadius: 14,
              border: "1px solid #e8e0e0",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "12px 20px",
                background: "#faf7f7",
                borderBottom: "1px solid #f0e8e8",
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: ".12em",
                  textTransform: "uppercase",
                  color: "#8B1A1A",
                }}
              >
                By feature
              </span>
            </div>
            {data.byLabel.length === 0 ? (
              <div style={{ color: "#aaa", padding: "40px 20px" }}>
                No sends recorded this month yet.
              </div>
            ) : (
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 13,
                }}
              >
                <thead>
                  <tr
                    style={{
                      textAlign: "left",
                      color: "#888",
                      fontSize: 11,
                      textTransform: "uppercase",
                      letterSpacing: ".06em",
                    }}
                  >
                    <th style={{ padding: "10px 20px", fontWeight: 600 }}>
                      Label
                    </th>
                    <th
                      style={{
                        padding: "10px 20px",
                        fontWeight: 600,
                        textAlign: "right",
                      }}
                    >
                      Today
                    </th>
                    <th
                      style={{
                        padding: "10px 20px",
                        fontWeight: 600,
                        textAlign: "right",
                      }}
                    >
                      This month
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.byLabel.map((r) => (
                    <tr
                      key={r.label}
                      style={{ borderTop: "1px solid #f5f0f0" }}
                    >
                      <td
                        style={{
                          padding: "10px 20px",
                          color: "#1a0505",
                          fontWeight: 600,
                        }}
                      >
                        {r.label}
                      </td>
                      <td
                        style={{
                          padding: "10px 20px",
                          textAlign: "right",
                          color: "#444",
                        }}
                      >
                        {r.sentToday}
                      </td>
                      <td
                        style={{
                          padding: "10px 20px",
                          textAlign: "right",
                          color: "#444",
                        }}
                      >
                        {r.sentThisMonth}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}

interface OtlLoginEvent {
  id: number;
  createdAt: string;
  via: string;
  ip: string | null;
  country: string | null;
  countryCode: string | null;
  city: string | null;
  userAgent: string | null;
}

function otlDevice(ua: string | null): string {
  if (!ua) return "Unknown device";
  if (/tablet|ipad/i.test(ua)) return "Tablet";
  if (/mobile|android|iphone|ipod|blackberry|opera mini|iemobile/i.test(ua))
    return "Mobile";
  let os = "";
  if (/windows/i.test(ua)) os = "Windows";
  else if (/mac os x|macintosh/i.test(ua)) os = "Mac";
  else if (/linux/i.test(ua)) os = "Linux";
  let browser = "";
  if (/edg\//i.test(ua)) browser = "Edge";
  else if (/chrome\//i.test(ua)) browser = "Chrome";
  else if (/safari\//i.test(ua)) browser = "Safari";
  else if (/firefox\//i.test(ua)) browser = "Firefox";
  return [browser, os].filter(Boolean).join(" · ") || "Desktop";
}

function otlPlace(e: OtlLoginEvent): string {
  const parts = [e.city, e.country].filter(Boolean) as string[];
  if (parts.length) return parts.join(", ");
  if (
    e.ip &&
    /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|::1$)/.test(e.ip)
  ) {
    return "Local / private network";
  }
  return "Unknown location";
}

interface GovernanceData {
  stewards: { total: number; onboarded: number };
  pillars: { active: number; retired: number };
  content: {
    sourcesTotal: number;
    sourcesApproved: number;
    interpretationsTotal: number;
    interpretationsApproved: number;
    interpretationsPending: number;
  };
  citationHealth: {
    verified: number;
    unmatched: number;
    missing: number;
    verifiedRate: number | null;
  };
  audit: {
    otlLogins: number;
    otlLastAccessAt: string | null;
    questionsLogged: number;
    questionsCovered: number;
  };
  generatedAt: string;
}

// The Governance & Accountability statement — mirrored VERBATIM in the OTL
// brief (otl.html, "Governance & accountability" page). Edit both together.
const GOVERNANCE_STATEMENT: Array<{ title: string; points: string[] }> = [
  {
    title: "Authority source",
    points: [
      "Named faculty stewards are the sole source of authority: nothing is served unless a steward approved both the source and the interpretation of it.",
      "Approval is recorded per item — who approved it, and when — and is revocable; unapproved or retired material drops out of retrieval immediately.",
      "Palonur engineering has no editorial override: the company cannot add or alter claims.",
    ],
  },
  {
    title: "Allowed claims",
    points: [
      "The system may state only what appears in steward-approved material; each covered answer carries a citation to the underlying work.",
      "A citation guard checks every cited answer against the retrieved provenance; an unverifiable citation is flagged and its source strip is suppressed.",
      "Outside the approved corpus the system says so plainly or refuses — it never improvises an answer.",
    ],
  },
  {
    title: "Information control",
    points: [
      "The governed corpus lives in Palonur's database; only the minimal excerpts needed for one answer cross to the model provider, under no-training inference terms.",
      "Private surfaces — the OTL brief, the dashboards — are gated on the server, and the gates fail closed when unconfigured.",
      "User data is never sold and never used to train models.",
    ],
  },
  {
    title: "Accountability",
    points: [
      "Every question, answer, citation-check outcome, and steward approval is logged, so any answer can be reconstructed after the fact.",
      "Access to governance surfaces is audited — including who opened the OTL brief, and when.",
      "A named human answers for each layer: the steward for content, Palonur for operating the platform (karan@palonur.com).",
    ],
  },
];

function GovStat({
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
        background: "#fff",
        border: "1px solid #e8e0e0",
        borderRadius: 12,
        padding: "16px 20px",
        minWidth: 170,
        flex: "1 1 170px",
      }}
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: "#666",
          letterSpacing: ".06em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 26,
          fontWeight: 700,
          color: "#8B1A1A",
          letterSpacing: "-0.02em",
          marginTop: 6,
        }}
      >
        {value}
      </div>
      {sub && (
        <div
          style={{ fontSize: 12, color: "#999", marginTop: 4, lineHeight: 1.4 }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

// ── FDA / Advice review ─────────────────────────────────────────────────────
// Surfaces every recent agent answer containing language a regulator (e.g. an
// FDA reviewer) could read as medical advice — diagnosis labels, dosing
// language, or prescriptive treatment directives. The scan runs server-side at
// READ time against the admin-editable boundary list below, so adding or
// removing a phrase instantly re-classifies past answers.

type AdviceHit = {
  termId: number;
  category: string;
  phrase: string;
  excerpt: string;
};
type AdviceFlaggedRow = {
  id: string;
  question: string;
  answerText: string;
  source: string;
  createdAt: string;
  hits: AdviceHit[];
};
type AdviceTermRow = {
  id: number;
  category: string;
  phrase: string;
  addedBy: string;
};
type AdviceReview = {
  days: number;
  scanned: number;
  scanCap: number;
  flaggedCount: number;
  countsByCategory: Record<string, number>;
  flagged: AdviceFlaggedRow[];
  terms: AdviceTermRow[];
  categories: string[];
};

const ADVICE_CAT_META: Record<
  string,
  { label: string; color: string; bg: string; hint: string }
> = {
  diagnosis: {
    label: "Diagnosis",
    color: "#8B1A1A",
    bg: "#fceaea",
    hint: "labels the person or their condition",
  },
  dosage: {
    label: "Dosage",
    color: "#b45309",
    bg: "#fdf1e0",
    hint: "dose / mg-style medication quantities",
  },
  treatment: {
    label: "Treatment",
    color: "#2952cc",
    bg: "#eef3ff",
    hint: "prescriptive treatment or medication directives",
  },
};

function escapeAdviceRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Render answer text with every matched boundary phrase highlighted. */
function highlightAdvice(text: string, hits: AdviceHit[]): React.ReactNode {
  const phrases = Array.from(
    new Set(hits.map((h) => h.phrase.trim()).filter(Boolean)),
  );
  if (phrases.length === 0) return text;
  let re: RegExp;
  try {
    re = new RegExp(
      `(?<![A-Za-z0-9])(${phrases.map((p) => escapeAdviceRegex(p).replace(/\s+/g, "\\s+")).join("|")})(?![A-Za-z0-9])`,
      "gi",
    );
  } catch {
    return text;
  }
  const parts = text.split(re);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark
        key={i}
        style={{
          background: "#ffe28a",
          color: "#5c3a00",
          borderRadius: 3,
          padding: "0 2px",
          fontWeight: 700,
        }}
      >
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function AdvicePanel() {
  const [data, setData] = useState<AdviceReview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [newCategory, setNewCategory] = useState("diagnosis");
  const [newPhrase, setNewPhrase] = useState("");
  const [termBusy, setTermBusy] = useState(false);
  const [termMsg, setTermMsg] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback((d: number) => {
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/admin/advice-review?days=${d}`, {
      credentials: "include",
      headers: headers(),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<AdviceReview>;
      })
      .then((d2) => setData(d2))
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load(days);
  }, [days, load]);

  async function addTerm(e: React.FormEvent) {
    e.preventDefault();
    const phrase = newPhrase.trim();
    if (!phrase || termBusy) return;
    setTermBusy(true);
    setTermMsg(null);
    try {
      const r = await fetch(`${API_BASE}/admin/advice-terms`, {
        method: "POST",
        credentials: "include",
        headers: { ...headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ category: newCategory, phrase }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error ?? `HTTP ${r.status}`);
      setTermMsg(
        d.alreadyExists ? "Already on the list." : `Added "${phrase}".`,
      );
      setNewPhrase("");
      load(days);
    } catch (err) {
      setTermMsg(`Couldn't add: ${String((err as Error).message)}`);
    } finally {
      setTermBusy(false);
      setTimeout(() => setTermMsg(null), 4000);
    }
  }

  async function removeTerm(id: number, phrase: string) {
    if (termBusy) return;
    setTermBusy(true);
    setTermMsg(null);
    try {
      const r = await fetch(`${API_BASE}/admin/advice-terms/${id}`, {
        method: "DELETE",
        credentials: "include",
        headers: headers(),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => null);
        throw new Error(d?.error ?? `HTTP ${r.status}`);
      }
      setTermMsg(`Removed "${phrase}".`);
      load(days);
    } catch (err) {
      setTermMsg(`Couldn't remove: ${String((err as Error).message)}`);
    } finally {
      setTermBusy(false);
      setTimeout(() => setTermMsg(null), 4000);
    }
  }

  const cats = ["diagnosis", "dosage", "treatment"];

  return (
    <div>
      <div
        style={{
          marginBottom: 18,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 16,
          flexWrap: "wrap",
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
            FDA / Advice Review
          </div>
          <div
            style={{
              fontSize: 13,
              color: "#888",
              maxWidth: 720,
              lineHeight: 1.5,
            }}
          >
            Every recent agent answer (sleep, embedded expert widgets,
            newsletter Q&amp;A) scanned for language a regulator could read as{" "}
            <strong>medical advice</strong> — diagnosis labels, dosing language,
            or treatment directives. Matches are highlighted below. Adjust the
            boundaries by adding or removing phrases; the list below
            re-classifies <em>all</em> past answers instantly. Refusals and
            uncovered responses are never flagged.
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              style={{
                background: days === d ? "#8B1A1A" : "#fff",
                color: days === d ? "#fff" : "#8B1A1A",
                border: "1px solid #e0c8c8",
                borderRadius: 8,
                padding: "6px 14px",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {d} days
            </button>
          ))}
        </div>
      </div>

      {loading && !data ? (
        <div style={{ color: "#aaa", padding: "48px 0" }}>
          Scanning answers…
        </div>
      ) : error ? (
        <div style={{ color: "#c0392b", padding: "32px 0" }}>
          Couldn't load advice review: {error}
        </div>
      ) : !data ? null : (
        <>
          {/* Summary cards */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 14,
              marginBottom: 24,
            }}
          >
            <div
              style={{
                background: "#fff",
                border: "1px solid #e8e0e0",
                borderRadius: 12,
                padding: "20px 24px",
                minWidth: 170,
                flex: 1,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: "#666",
                  letterSpacing: ".06em",
                  textTransform: "uppercase",
                }}
              >
                Answers scanned
              </div>
              <div
                style={{
                  fontSize: 28,
                  fontWeight: 700,
                  color: "#1a0505",
                  letterSpacing: "-0.02em",
                  marginTop: 6,
                }}
              >
                {data.scanned}
                {data.scanned >= data.scanCap ? (
                  <span
                    style={{
                      fontSize: 12,
                      color: "#b45309",
                      fontWeight: 600,
                      marginLeft: 8,
                    }}
                  >
                    cap reached
                  </span>
                ) : null}
              </div>
            </div>
            <div
              style={{
                background: "#fff",
                border: "1px solid #e8e0e0",
                borderRadius: 12,
                padding: "20px 24px",
                minWidth: 170,
                flex: 1,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: "#666",
                  letterSpacing: ".06em",
                  textTransform: "uppercase",
                }}
              >
                Flagged
              </div>
              <div
                style={{
                  fontSize: 28,
                  fontWeight: 700,
                  color: data.flaggedCount > 0 ? "#8B1A1A" : "#1e7e34",
                  letterSpacing: "-0.02em",
                  marginTop: 6,
                }}
              >
                {data.flaggedCount}
              </div>
            </div>
            {cats.map((c) => (
              <div
                key={c}
                style={{
                  background: "#fff",
                  border: "1px solid #e8e0e0",
                  borderRadius: 12,
                  padding: "20px 24px",
                  minWidth: 150,
                  flex: 1,
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: ADVICE_CAT_META[c].color,
                    letterSpacing: ".06em",
                    textTransform: "uppercase",
                  }}
                >
                  {ADVICE_CAT_META[c].label}
                </div>
                <div
                  style={{
                    fontSize: 28,
                    fontWeight: 700,
                    color: "#1a0505",
                    letterSpacing: "-0.02em",
                    marginTop: 6,
                  }}
                >
                  {data.countsByCategory?.[c] ?? 0}
                </div>
              </div>
            ))}
          </div>

          {/* Boundary editor */}
          <div
            style={{
              background: "#fff",
              borderRadius: 14,
              border: "1px solid #e8e0e0",
              marginBottom: 24,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "12px 20px",
                background: "#faf7f7",
                borderBottom: "1px solid #f0e8e8",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 8,
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: ".12em",
                  textTransform: "uppercase",
                  color: "#8B1A1A",
                }}
              >
                Boundaries — flagged phrases
              </span>
              {termMsg ? (
                <span style={{ fontSize: 12, color: "#666" }}>{termMsg}</span>
              ) : null}
            </div>
            <div style={{ padding: "16px 20px" }}>
              {cats.map((c) => {
                const terms = (data.terms ?? []).filter(
                  (t) => t.category === c,
                );
                return (
                  <div key={c} style={{ marginBottom: 14 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: ADVICE_CAT_META[c].color,
                        marginBottom: 6,
                      }}
                    >
                      {ADVICE_CAT_META[c].label}
                      <span
                        style={{
                          color: "#aaa",
                          fontWeight: 400,
                          marginLeft: 8,
                        }}
                      >
                        {ADVICE_CAT_META[c].hint}
                      </span>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {terms.length === 0 ? (
                        <span style={{ fontSize: 12, color: "#aaa" }}>
                          No phrases in this category.
                        </span>
                      ) : (
                        terms.map((t) => (
                          <span
                            key={t.id}
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 6,
                              background: ADVICE_CAT_META[c].bg,
                              color: ADVICE_CAT_META[c].color,
                              border: `1px solid ${ADVICE_CAT_META[c].color}22`,
                              borderRadius: 999,
                              padding: "3px 6px 3px 12px",
                              fontSize: 12,
                              fontWeight: 600,
                            }}
                          >
                            {t.phrase}
                            {t.id > 0 ? (
                              <button
                                onClick={() => removeTerm(t.id, t.phrase)}
                                disabled={termBusy}
                                title="Remove this boundary"
                                style={{
                                  background: "transparent",
                                  border: "none",
                                  cursor: "pointer",
                                  color: ADVICE_CAT_META[c].color,
                                  fontSize: 13,
                                  fontWeight: 700,
                                  lineHeight: 1,
                                  padding: "2px 4px",
                                  borderRadius: 999,
                                }}
                              >
                                ×
                              </button>
                            ) : null}
                          </span>
                        ))
                      )}
                    </div>
                  </div>
                );
              })}
              <form
                onSubmit={addTerm}
                style={{
                  display: "flex",
                  gap: 8,
                  marginTop: 12,
                  flexWrap: "wrap",
                  alignItems: "center",
                }}
              >
                <select
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  style={{
                    border: "1px solid #ddd",
                    borderRadius: 8,
                    padding: "8px 10px",
                    fontSize: 13,
                    background: "#fff",
                  }}
                >
                  {cats.map((c) => (
                    <option key={c} value={c}>
                      {ADVICE_CAT_META[c].label}
                    </option>
                  ))}
                </select>
                <input
                  value={newPhrase}
                  onChange={(e) => setNewPhrase(e.target.value)}
                  placeholder="Add a phrase to flag, e.g. “take a supplement”"
                  style={{
                    flex: 1,
                    minWidth: 220,
                    border: "1px solid #ddd",
                    borderRadius: 8,
                    padding: "8px 12px",
                    fontSize: 13,
                  }}
                />
                <button
                  type="submit"
                  disabled={termBusy || newPhrase.trim().length < 2}
                  style={{
                    background: "#8B1A1A",
                    color: "#fff",
                    border: "none",
                    borderRadius: 8,
                    padding: "8px 18px",
                    fontSize: 13,
                    fontWeight: 600,
                    cursor:
                      termBusy || newPhrase.trim().length < 2
                        ? "default"
                        : "pointer",
                    opacity: termBusy || newPhrase.trim().length < 2 ? 0.5 : 1,
                  }}
                >
                  Add boundary
                </button>
              </form>
              <div style={{ fontSize: 11, color: "#aaa", marginTop: 8 }}>
                Phrases match whole words, case-insensitively. Removing every
                phrase restores the built-in defaults.
              </div>
            </div>
          </div>

          {/* Flagged answers */}
          <div
            style={{
              background: "#fff",
              borderRadius: 14,
              border: "1px solid #e8e0e0",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "12px 20px",
                background: "#faf7f7",
                borderBottom: "1px solid #f0e8e8",
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: ".12em",
                  textTransform: "uppercase",
                  color: "#8B1A1A",
                }}
              >
                Flagged answers — last {data.days} days
              </span>
            </div>
            {data.flagged.length === 0 ? (
              <div
                style={{ color: "#1e7e34", padding: "40px 20px", fontSize: 14 }}
              >
                No agent answers in the last {data.days} days crossed the
                current boundaries.
              </div>
            ) : (
              data.flagged.map((row) => {
                const isOpen = expanded === row.id;
                const catSet = Array.from(
                  new Set(row.hits.map((h) => h.category)),
                );
                return (
                  <div
                    key={row.id}
                    style={{
                      borderTop: "1px solid #f5f0f0",
                      padding: "14px 20px",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 12,
                        flexWrap: "wrap",
                        marginBottom: 6,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          gap: 6,
                          alignItems: "center",
                          flexWrap: "wrap",
                        }}
                      >
                        {catSet.map((c) => (
                          <span
                            key={c}
                            style={{
                              fontSize: 11,
                              fontWeight: 700,
                              color: ADVICE_CAT_META[c]?.color ?? "#666",
                              background: ADVICE_CAT_META[c]?.bg ?? "#f2f2f2",
                              borderRadius: 6,
                              padding: "2px 8px",
                            }}
                          >
                            {ADVICE_CAT_META[c]?.label ?? c}
                          </span>
                        ))}
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 600,
                            color: "#666",
                            background: "#f4f0f0",
                            borderRadius: 6,
                            padding: "2px 8px",
                          }}
                        >
                          {row.source}
                        </span>
                      </div>
                      <span
                        style={{
                          fontSize: 12,
                          color: "#aaa",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {fmtTime(row.createdAt)}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        color: "#1a0505",
                        marginBottom: 6,
                      }}
                    >
                      Q: {row.question}
                    </div>
                    {isOpen ? (
                      <div
                        style={{
                          fontSize: 13,
                          color: "#444",
                          lineHeight: 1.6,
                          whiteSpace: "pre-wrap",
                          background: "#faf9f7",
                          border: "1px solid #f0ece6",
                          borderRadius: 10,
                          padding: "12px 14px",
                        }}
                      >
                        {highlightAdvice(row.answerText, row.hits)}
                      </div>
                    ) : (
                      <div
                        style={{ fontSize: 13, color: "#555", lineHeight: 1.6 }}
                      >
                        {row.hits.slice(0, 3).map((h, i) => (
                          <div key={i} style={{ marginBottom: 4 }}>
                            <span
                              style={{
                                fontSize: 10,
                                fontWeight: 700,
                                color:
                                  ADVICE_CAT_META[h.category]?.color ?? "#666",
                                textTransform: "uppercase",
                                letterSpacing: ".06em",
                                marginRight: 8,
                              }}
                            >
                              {h.category}
                            </span>
                            {highlightAdvice(h.excerpt, [h])}
                          </div>
                        ))}
                        {row.hits.length > 3 ? (
                          <div style={{ fontSize: 12, color: "#aaa" }}>
                            +{row.hits.length - 3} more match
                            {row.hits.length - 3 === 1 ? "" : "es"}
                          </div>
                        ) : null}
                      </div>
                    )}
                    <button
                      onClick={() => setExpanded(isOpen ? null : row.id)}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: "#8B1A1A",
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: "pointer",
                        padding: 0,
                        marginTop: 6,
                      }}
                    >
                      {isOpen
                        ? "Hide full answer"
                        : "Show full answer with highlights"}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── Reply-as-doorway review ─────────────────────────────────────────────────
// The despair-moment text channel: outcome counts, crisis-flagged inbound
// messages (the only events whose text is stored), and the admin-editable
// crisis phrase list that gates every inbound message before any reply.

type DoorwayCrisisEvent = {
  id: number;
  fromPhoneHash: string;
  product: string;
  bodyExcerpt: string | null;
  createdAt: string;
};
type DoorwayTermRow = { id: number; phrase: string; addedBy: string };
type DoorwayReview = {
  days: number;
  countsByOutcome: Record<string, number>;
  crisisEvents: DoorwayCrisisEvent[];
  terms: DoorwayTermRow[];
};

function DoorwayPanel() {
  const [data, setData] = useState<DoorwayReview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [newPhrase, setNewPhrase] = useState("");
  const [termBusy, setTermBusy] = useState(false);
  const [termMsg, setTermMsg] = useState<string | null>(null);

  const load = useCallback((d: number) => {
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/admin/doorway-review?days=${d}`, {
      credentials: "include",
      headers: headers(),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<DoorwayReview>;
      })
      .then((d2) => setData(d2))
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load(days);
  }, [days, load]);

  async function addTerm(e: React.FormEvent) {
    e.preventDefault();
    const phrase = newPhrase.trim();
    if (!phrase || termBusy) return;
    setTermBusy(true);
    setTermMsg(null);
    try {
      const r = await fetch(`${API_BASE}/admin/crisis-terms`, {
        method: "POST",
        credentials: "include",
        headers: { ...headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ phrase }),
      });
      const body = (await r.json()) as {
        alreadyExists?: boolean;
        error?: string;
      };
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      setTermMsg(body.alreadyExists ? "Already on the list." : "Phrase added.");
      setNewPhrase("");
      load(days);
    } catch (err) {
      setTermMsg(`Couldn't add: ${String((err as Error).message)}`);
    } finally {
      setTermBusy(false);
      setTimeout(() => setTermMsg(null), 4000);
    }
  }

  async function removeTerm(id: number) {
    if (termBusy) return;
    setTermBusy(true);
    setTermMsg(null);
    try {
      const r = await fetch(`${API_BASE}/admin/crisis-terms/${id}`, {
        method: "DELETE",
        credentials: "include",
        headers: headers(),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      setTermMsg("Phrase removed.");
      load(days);
    } catch (err) {
      setTermMsg(`Couldn't remove: ${String((err as Error).message)}`);
    } finally {
      setTermBusy(false);
      setTimeout(() => setTermMsg(null), 4000);
    }
  }

  const OUTCOME_LABELS: Record<string, string> = {
    ack: "Doorway sent",
    crisis: "Crisis-flagged",
    capped: "Night cap reached",
    ignored: "Ignored (unknown sender)",
  };

  return (
    <div>
      <div
        style={{
          marginBottom: 18,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 16,
          flexWrap: "wrap",
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
            Doorway Texts
          </div>
          <div
            style={{
              fontSize: 13,
              color: "#888",
              maxWidth: 720,
              lineHeight: 1.5,
            }}
          >
            Registered users who text our number get a short canned reply with a
            link that opens their answer on the site — the thread itself never
            answers. Every inbound message is screened against the{" "}
            <strong>crisis phrase list</strong> below first (a match gets crisis
            resources, no link). Crisis-flagged messages are the only ones whose
            text is kept, shown here for review. Phone numbers are hashed —
            nothing here identifies a sender.
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              style={{
                background: days === d ? "#8B1A1A" : "#fff",
                color: days === d ? "#fff" : "#8B1A1A",
                border: "1px solid #e0c8c8",
                borderRadius: 8,
                padding: "6px 14px",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {d} days
            </button>
          ))}
        </div>
      </div>

      {loading && !data ? (
        <div style={{ color: "#aaa", padding: "48px 0" }}>
          Loading doorway activity…
        </div>
      ) : error ? (
        <div style={{ color: "#c0392b", padding: "32px 0" }}>
          Couldn't load doorway review: {error}
        </div>
      ) : data ? (
        <>
          <div
            style={{
              display: "flex",
              gap: 12,
              flexWrap: "wrap",
              marginBottom: 24,
            }}
          >
            {(["ack", "crisis", "capped", "ignored"] as const).map((k) => (
              <div
                key={k}
                style={{
                  background:
                    k === "crisis" && (data.countsByOutcome[k] ?? 0) > 0
                      ? "#fdf0ef"
                      : "#fff",
                  border: `1px solid ${k === "crisis" && (data.countsByOutcome[k] ?? 0) > 0 ? "#e8b4b0" : "#eee"}`,
                  borderRadius: 10,
                  padding: "14px 20px",
                  minWidth: 150,
                }}
              >
                <div
                  style={{
                    fontSize: 26,
                    fontWeight: 700,
                    color: k === "crisis" ? "#8B1A1A" : "#1a0505",
                  }}
                >
                  {data.countsByOutcome[k] ?? 0}
                </div>
                <div style={{ fontSize: 12, color: "#888" }}>
                  {OUTCOME_LABELS[k]}
                </div>
              </div>
            ))}
          </div>

          <div
            style={{
              fontSize: 15,
              fontWeight: 700,
              color: "#1a0505",
              marginBottom: 8,
            }}
          >
            Crisis-flagged messages
          </div>
          {data.crisisEvents.length === 0 ? (
            <div
              style={{ color: "#888", fontSize: 13, padding: "12px 0 28px" }}
            >
              None in the last {data.days} days.
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 10,
                marginBottom: 28,
              }}
            >
              {data.crisisEvents.map((ev) => (
                <div
                  key={ev.id}
                  style={{
                    background: "#fdf0ef",
                    border: "1px solid #e8b4b0",
                    borderRadius: 10,
                    padding: "12px 16px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      gap: 12,
                      flexWrap: "wrap",
                      fontSize: 12,
                      color: "#8a5a55",
                      marginBottom: 6,
                    }}
                  >
                    <span>{new Date(ev.createdAt).toLocaleString()}</span>
                    <span>sender {ev.fromPhoneHash}…</span>
                    <span style={{ textTransform: "capitalize" }}>
                      {ev.product}
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: 14,
                      color: "#3a1210",
                      lineHeight: 1.5,
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {ev.bodyExcerpt ?? "(no text stored)"}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div
            style={{
              fontSize: 15,
              fontWeight: 700,
              color: "#1a0505",
              marginBottom: 8,
            }}
          >
            Crisis phrase list
          </div>
          <div
            style={{
              fontSize: 12,
              color: "#888",
              marginBottom: 10,
              maxWidth: 680,
              lineHeight: 1.5,
            }}
          >
            Matched case-insensitively on word boundaries against every inbound
            text before any reply. Deleting every phrase restores the built-in
            defaults — the screen can never end up empty.
          </div>
          <form
            onSubmit={addTerm}
            style={{
              display: "flex",
              gap: 8,
              marginBottom: 12,
              flexWrap: "wrap",
            }}
          >
            <input
              value={newPhrase}
              onChange={(e) => setNewPhrase(e.target.value)}
              placeholder="Add a phrase…"
              style={{
                border: "1px solid #ddd",
                borderRadius: 8,
                padding: "8px 12px",
                fontSize: 13,
                minWidth: 260,
              }}
            />
            <button
              type="submit"
              disabled={termBusy || !newPhrase.trim()}
              style={{
                background: "#8B1A1A",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                padding: "8px 18px",
                fontSize: 13,
                fontWeight: 600,
                cursor: termBusy ? "default" : "pointer",
                opacity: termBusy ? 0.6 : 1,
              }}
            >
              Add
            </button>
            {termMsg && (
              <span
                style={{ fontSize: 12, color: "#8a5a55", alignSelf: "center" }}
              >
                {termMsg}
              </span>
            )}
          </form>
          <div
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              marginBottom: 40,
            }}
          >
            {data.terms.map((t) => (
              <span
                key={t.id}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  background: "#fff",
                  border: "1px solid #e0c8c8",
                  borderRadius: 999,
                  padding: "5px 12px",
                  fontSize: 12,
                  color: "#5a1a15",
                }}
              >
                {t.phrase}
                {t.id > 0 && (
                  <button
                    onClick={() => removeTerm(t.id)}
                    disabled={termBusy}
                    title="Remove phrase"
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "#b08a85",
                      cursor: "pointer",
                      fontSize: 13,
                      lineHeight: 1,
                      padding: 0,
                    }}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

interface StewardEarningsData {
  sharePercent: number;
  totals: {
    grossCents: number;
    stewardCents: number;
    palonurCents: number;
    invoiceCount: number;
  };
  publications: Array<{
    publicationId: number;
    publicationName: string | null;
    publicationSlug: string | null;
    stewardName: string | null;
    invoiceCount: number;
    grossCents: number;
    stewardCents: number;
    palonurCents: number;
    currency: string;
    activeSubscribers: number;
  }>;
}

const centsFmt = (c: number) => `$${(c / 100).toFixed(2)}`;

function EarningsPanel() {
  const [data, setData] = useState<StewardEarningsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/admin/steward-earnings`, {
      credentials: "include",
      headers: headers(),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<StewardEarningsData>;
      })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e.message ?? e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <div
        style={{
          marginBottom: 18,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 16,
          flexWrap: "wrap",
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
            Steward earnings
          </div>
          <div
            style={{
              fontSize: 13,
              color: "#888",
              maxWidth: 720,
              lineHeight: 1.5,
            }}
          >
            Paid steward Q&amp;A subscriptions, split{" "}
            {data ? `${data.sharePercent}/${100 - data.sharePercent}` : "80/20"}{" "}
            steward/Palonur per paid invoice. Reimbursement ledger only — no
            money moves here.
          </div>
        </div>
        <a
          href={`${API_BASE}/admin/steward-earnings.csv`}
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: "#8B1A1A",
            border: "1.5px solid #e2d8d8",
            borderRadius: 10,
            padding: "9px 16px",
            textDecoration: "none",
            background: "#fff",
          }}
        >
          Export CSV
        </a>
      </div>
      {loading ? (
        <div style={{ color: "#aaa", padding: "32px 0" }}>Loading…</div>
      ) : error ? (
        <div style={{ color: "#c0392b", padding: "24px 0" }}>
          Couldn't load earnings: {error}
        </div>
      ) : !data ? null : (
        <>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 14,
              marginBottom: 24,
            }}
          >
            <GovStat
              label="Gross"
              value={centsFmt(data.totals.grossCents)}
              sub={`${data.totals.invoiceCount} paid invoices`}
            />
            <GovStat
              label="Owed to stewards"
              value={centsFmt(data.totals.stewardCents)}
              sub={`${data.sharePercent}% share`}
            />
            <GovStat
              label="Palonur"
              value={centsFmt(data.totals.palonurCents)}
              sub={`${100 - data.sharePercent}% share`}
            />
          </div>
          {data.publications.length === 0 ? (
            <div style={{ color: "#888", fontSize: 14, padding: "16px 0" }}>
              No steward Q&amp;A revenue yet.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  borderCollapse: "collapse",
                  width: "100%",
                  fontSize: 13.5,
                }}
              >
                <thead>
                  <tr style={{ textAlign: "left", color: "#888" }}>
                    {[
                      "Publication",
                      "Steward",
                      "Subscribers",
                      "Invoices",
                      "Gross",
                      "Steward share",
                      "Palonur",
                    ].map((h) => (
                      <th
                        key={h}
                        style={{
                          padding: "8px 12px",
                          borderBottom: "1px solid #e8e0e0",
                          fontWeight: 600,
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.publications.map((p) => (
                    <tr key={p.publicationId}>
                      <td
                        style={{
                          padding: "10px 12px",
                          borderBottom: "1px solid #f0eaea",
                          fontWeight: 600,
                          color: "#1a0505",
                        }}
                      >
                        {p.publicationSlug ? (
                          <a
                            href={`/p/${p.publicationSlug}`}
                            style={{ color: "#8B1A1A", textDecoration: "none" }}
                          >
                            {p.publicationName ?? p.publicationSlug}
                          </a>
                        ) : (
                          (p.publicationName ?? "—")
                        )}
                      </td>
                      <td
                        style={{
                          padding: "10px 12px",
                          borderBottom: "1px solid #f0eaea",
                        }}
                      >
                        {p.stewardName ?? "—"}
                      </td>
                      <td
                        style={{
                          padding: "10px 12px",
                          borderBottom: "1px solid #f0eaea",
                        }}
                      >
                        {p.activeSubscribers}
                      </td>
                      <td
                        style={{
                          padding: "10px 12px",
                          borderBottom: "1px solid #f0eaea",
                        }}
                      >
                        {p.invoiceCount}
                      </td>
                      <td
                        style={{
                          padding: "10px 12px",
                          borderBottom: "1px solid #f0eaea",
                        }}
                      >
                        {centsFmt(p.grossCents)}
                      </td>
                      <td
                        style={{
                          padding: "10px 12px",
                          borderBottom: "1px solid #f0eaea",
                          fontWeight: 600,
                        }}
                      >
                        {centsFmt(p.stewardCents)}
                      </td>
                      <td
                        style={{
                          padding: "10px 12px",
                          borderBottom: "1px solid #f0eaea",
                        }}
                      >
                        {centsFmt(p.palonurCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Ingestion Health (Task #475) ─────────────────────────────────────────

interface IngestionPillarSummary {
  pillarId: number;
  slug: string;
  name: string;
  retired: boolean;
  sourceCount: number;
  approvedSourceCount: number;
  draftSourceCount: number;
  inReviewSourceCount: number;
  archivedSourceCount: number;
  healthy: boolean;
  sourceChunkCount: number;
  sourceChunksMissingEmbedding: number;
  sourceChunksModelMismatch: number;
  interpretationChunkCount: number;
  interpretationChunksMissingEmbedding: number;
  interpretationChunksModelMismatch: number;
  offTopicSuspectCount: number;
  topicFitUnscoredCount: number;
}

interface IngestionOverview {
  pillars: IngestionPillarSummary[];
  embeddingModel: string;
  retrievalThreshold: number;
  topicFitThreshold: number;
}

interface IngestionDocument {
  sourceId: number;
  title: string;
  kind: string;
  status: string;
  version: number;
  createdAt: string;
  uploaderName: string | null;
  uploaderEmail: string | null;
  embeddingModels: string[];
  chunkCount: number;
  chunksMissingEmbedding: number;
  chunksModelMismatch: number;
  interpretationChunkCount: number;
  interpretationChunksMissingEmbedding: number;
  interpretationChunksModelMismatch: number;
  topicFitScore: number | null;
  offTopicSuspect: boolean;
  topicFitCheckedAt: string | null;
}

interface SelfRetrievalReport {
  threshold: number;
  probed: number;
  passed: number;
  results: Array<{
    sourceId: number;
    title: string;
    status: string;
    probedChunkIndex: number;
    topScore: number;
    selfHit: boolean;
    ok: boolean;
  }>;
}

function healthPct(n: number, bad: number): string {
  if (n === 0) return "—";
  return `${Math.round(((n - bad) / n) * 1000) / 10}%`;
}

function IngestionHealthPanel() {
  const [data, setData] = useState<IngestionOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openPillar, setOpenPillar] = useState<number | null>(null);
  const [docs, setDocs] = useState<Record<number, IngestionDocument[]>>({});
  const [docsLoading, setDocsLoading] = useState(false);
  const [verify, setVerify] = useState<
    Record<number, SelfRetrievalReport | "running" | string>
  >({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/admin/ingestion-health`, {
      credentials: "include",
      headers: headers(),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<IngestionOverview>;
      })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e.message ?? e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function openDrilldown(pillarId: number) {
    if (openPillar === pillarId) {
      setOpenPillar(null);
      return;
    }
    setOpenPillar(pillarId);
    if (docs[pillarId]) return;
    setDocsLoading(true);
    fetch(`${API_BASE}/admin/ingestion-health/pillars/${pillarId}/documents`, {
      credentials: "include",
      headers: headers(),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ documents: IngestionDocument[] }>;
      })
      .then((d) => setDocs((m) => ({ ...m, [pillarId]: d.documents })))
      .catch(() => setDocs((m) => ({ ...m, [pillarId]: [] })))
      .finally(() => setDocsLoading(false));
  }

  function runVerify(pillarId: number) {
    setVerify((m) => ({ ...m, [pillarId]: "running" }));
    fetch(`${API_BASE}/admin/ingestion-health/pillars/${pillarId}/verify`, {
      method: "POST",
      credentials: "include",
      headers: headers(),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<SelfRetrievalReport>;
      })
      .then((rep) => setVerify((m) => ({ ...m, [pillarId]: rep })))
      .catch((e) =>
        setVerify((m) => ({
          ...m,
          [pillarId]: `Error: ${String(e.message ?? e)}`,
        })),
      );
  }

  const cell: React.CSSProperties = {
    padding: "8px 10px",
    verticalAlign: "top",
    fontSize: 13,
  };
  const head: React.CSSProperties = {
    padding: "8px 10px",
    textAlign: "left",
    fontSize: 11,
    letterSpacing: ".06em",
    textTransform: "uppercase",
    color: "#888",
    borderBottom: "1px solid #e8e0e0",
  };
  const warn = (n: number) => ({
    color: n > 0 ? "#c0392b" : "#2e7d32",
    fontWeight: 600,
  });

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <div
          style={{
            fontSize: 20,
            fontWeight: 700,
            color: "#1a0505",
            marginBottom: 4,
          }}
        >
          Ingestion Health
        </div>
        <div
          style={{
            fontSize: 13,
            color: "#888",
            maxWidth: 760,
            lineHeight: 1.5,
          }}
        >
          Per-pillar ingestion &amp; embedding health: chunk counts, embedding
          coverage, model-mismatch flags for source and interpretation chunks,
          and the topic-fit guardrail (observe-and-flag only — uploads are never
          blocked).
          {data && (
            <>
              {" "}
              Current model <code>{data.embeddingModel}</code> · retrieval
              threshold {data.retrievalThreshold} · topic-fit threshold{" "}
              {data.topicFitThreshold}.
            </>
          )}
        </div>
      </div>

      {loading ? (
        <div style={{ color: "#aaa", padding: "32px 0" }}>Loading…</div>
      ) : error ? (
        <div style={{ color: "#c0392b", padding: "24px 0" }}>
          Couldn't load ingestion health: {error}
        </div>
      ) : !data ? null : (
        <div
          style={{
            background: "#fff",
            border: "1px solid #e8e0e0",
            borderRadius: 12,
            overflow: "hidden",
          }}
        >
          <table
            style={{ width: "100%", borderCollapse: "collapse" }}
            data-testid="table-ingestion-pillars"
          >
            <thead>
              <tr>
                <th style={head}>Pillar</th>
                <th style={head}>Health</th>
                <th style={head}>Sources</th>
                <th style={head}>Source chunks</th>
                <th style={head}>Embedded</th>
                <th style={head}>Model mismatch</th>
                <th style={head}>Interp. chunks</th>
                <th style={head}>Interp. embedded</th>
                <th style={head}>Off-topic flags</th>
                <th style={head}></th>
              </tr>
            </thead>
            <tbody>
              {data.pillars.map((p) => {
                const rep = verify[p.pillarId];
                return (
                  <Fragment key={p.pillarId}>
                    <tr
                      style={{
                        borderTop: "1px solid #f0eaea",
                        cursor: "pointer",
                        opacity: p.retired ? 0.55 : 1,
                      }}
                      onClick={() => openDrilldown(p.pillarId)}
                      data-testid={`row-ingestion-pillar-${p.slug}`}
                    >
                      <td
                        style={{ ...cell, fontWeight: 600, color: "#1a0505" }}
                      >
                        {p.name}
                        {p.retired ? " (retired)" : ""}
                      </td>
                      <td style={cell}>
                        <span
                          data-testid={`badge-health-${p.slug}`}
                          style={{
                            display: "inline-block",
                            padding: "2px 8px",
                            borderRadius: 999,
                            fontSize: 11,
                            fontWeight: 700,
                            background: p.healthy ? "#e6f4ea" : "#fdecea",
                            color: p.healthy ? "#2e7d32" : "#c0392b",
                          }}
                        >
                          {p.healthy ? "Healthy" : "Issues found"}
                        </span>
                      </td>
                      <td style={cell}>
                        {p.sourceCount} total
                        <div style={{ color: "#999", fontSize: 12 }}>
                          {p.approvedSourceCount} approved ·{" "}
                          {p.inReviewSourceCount} in review ·{" "}
                          {p.draftSourceCount} draft
                          {p.archivedSourceCount > 0
                            ? ` · ${p.archivedSourceCount} archived`
                            : ""}
                        </div>
                      </td>
                      <td style={cell}>{p.sourceChunkCount}</td>
                      <td style={cell}>
                        <span style={warn(p.sourceChunksMissingEmbedding)}>
                          {healthPct(
                            p.sourceChunkCount,
                            p.sourceChunksMissingEmbedding,
                          )}
                        </span>
                        {p.sourceChunksMissingEmbedding > 0 &&
                          ` (${p.sourceChunksMissingEmbedding} missing)`}
                      </td>
                      <td style={cell}>
                        <span style={warn(p.sourceChunksModelMismatch)}>
                          {p.sourceChunksModelMismatch}
                        </span>
                      </td>
                      <td style={cell}>{p.interpretationChunkCount}</td>
                      <td style={cell}>
                        <span
                          style={warn(
                            p.interpretationChunksMissingEmbedding +
                              p.interpretationChunksModelMismatch,
                          )}
                        >
                          {healthPct(
                            p.interpretationChunkCount,
                            p.interpretationChunksMissingEmbedding,
                          )}
                        </span>
                        {p.interpretationChunksModelMismatch > 0 &&
                          ` (${p.interpretationChunksModelMismatch} mismatched)`}
                      </td>
                      <td style={cell}>
                        <span style={warn(p.offTopicSuspectCount)}>
                          {p.offTopicSuspectCount}
                        </span>
                        {p.topicFitUnscoredCount > 0 && (
                          <span style={{ color: "#999" }}>
                            {" "}
                            · {p.topicFitUnscoredCount} unscored
                          </span>
                        )}
                      </td>
                      <td style={cell}>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            runVerify(p.pillarId);
                          }}
                          disabled={
                            rep === "running" || p.sourceChunkCount === 0
                          }
                          style={{
                            padding: "4px 10px",
                            borderRadius: 8,
                            border: "1px solid #d8cfcf",
                            background: "#faf6f6",
                            color: "#4a3535",
                            fontSize: 12,
                            cursor: "pointer",
                          }}
                          data-testid={`button-verify-${p.slug}`}
                        >
                          {rep === "running"
                            ? "Verifying…"
                            : "Verify retrieval"}
                        </button>
                      </td>
                    </tr>
                    {rep && rep !== "running" && (
                      <tr>
                        <td
                          colSpan={10}
                          style={{ ...cell, background: "#faf8f4" }}
                        >
                          {typeof rep === "string" ? (
                            <span style={{ color: "#c0392b" }}>{rep}</span>
                          ) : (
                            <div data-testid={`verify-report-${p.slug}`}>
                              <strong
                                style={{
                                  color:
                                    rep.passed === rep.probed
                                      ? "#2e7d32"
                                      : "#c0392b",
                                }}
                              >
                                {rep.passed} / {rep.probed} documents
                                self-retrieved above {rep.threshold}
                              </strong>
                              {rep.results
                                .filter((r) => !r.ok)
                                .map((r) => (
                                  <div
                                    key={r.sourceId}
                                    style={{
                                      color: "#c0392b",
                                      fontSize: 12,
                                      marginTop: 4,
                                    }}
                                  >
                                    ✗ {r.title} — top score{" "}
                                    {Math.round(r.topScore * 1000) / 1000}
                                    {r.selfHit
                                      ? " (below threshold)"
                                      : " (retrieved a different document)"}
                                  </div>
                                ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                    {openPillar === p.pillarId && (
                      <tr>
                        <td
                          colSpan={10}
                          style={{ padding: 0, background: "#fcfaf7" }}
                        >
                          {docsLoading && !docs[p.pillarId] ? (
                            <div style={{ color: "#aaa", padding: 16 }}>
                              Loading documents…
                            </div>
                          ) : (docs[p.pillarId] ?? []).length === 0 ? (
                            <div style={{ color: "#aaa", padding: 16 }}>
                              No documents in this pillar.
                            </div>
                          ) : (
                            <table
                              style={{
                                width: "100%",
                                borderCollapse: "collapse",
                              }}
                            >
                              <thead>
                                <tr>
                                  <th style={head}>Document</th>
                                  <th style={head}>Uploader</th>
                                  <th style={head}>Status</th>
                                  <th style={head}>Chunks</th>
                                  <th style={head}>Model</th>
                                  <th style={head}>Embedded</th>
                                  <th style={head}>Mismatch</th>
                                  <th style={head}>Interp. chunks</th>
                                  <th style={head}>Topic fit</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(docs[p.pillarId] ?? []).map((d) => (
                                  <tr
                                    key={d.sourceId}
                                    style={{ borderTop: "1px solid #f0eaea" }}
                                    data-testid={`row-ingestion-doc-${d.sourceId}`}
                                  >
                                    <td style={{ ...cell, maxWidth: 340 }}>
                                      <span style={{ color: "#1a0505" }}>
                                        {d.title}
                                      </span>
                                      <span style={{ color: "#999" }}>
                                        {" "}
                                        · {d.kind}
                                        {d.version > 1 ? ` v${d.version}` : ""}
                                      </span>
                                    </td>
                                    <td style={cell}>
                                      {d.uploaderName ?? d.uploaderEmail ?? (
                                        <span style={{ color: "#999" }}>—</span>
                                      )}
                                      {d.uploaderName && d.uploaderEmail && (
                                        <div
                                          style={{
                                            color: "#999",
                                            fontSize: 11,
                                          }}
                                        >
                                          {d.uploaderEmail}
                                        </div>
                                      )}
                                    </td>
                                    <td style={cell}>{d.status}</td>
                                    <td style={cell}>{d.chunkCount}</td>
                                    <td style={{ ...cell, fontSize: 11 }}>
                                      {d.embeddingModels.length === 0 ? (
                                        <span style={{ color: "#999" }}>—</span>
                                      ) : (
                                        d.embeddingModels.map((m) => (
                                          <div
                                            key={m}
                                            style={{
                                              color:
                                                m === data.embeddingModel
                                                  ? "#2e7d32"
                                                  : "#c0392b",
                                              fontWeight:
                                                m === data.embeddingModel
                                                  ? 400
                                                  : 600,
                                            }}
                                          >
                                            {m}
                                            {m !== data.embeddingModel
                                              ? " (stale)"
                                              : ""}
                                          </div>
                                        ))
                                      )}
                                    </td>
                                    <td style={cell}>
                                      <span
                                        style={warn(d.chunksMissingEmbedding)}
                                      >
                                        {d.chunkCount -
                                          d.chunksMissingEmbedding}{" "}
                                        / {d.chunkCount}
                                      </span>
                                    </td>
                                    <td style={cell}>
                                      <span style={warn(d.chunksModelMismatch)}>
                                        {d.chunksModelMismatch}
                                      </span>
                                    </td>
                                    <td style={cell}>
                                      {d.interpretationChunkCount}
                                      {(d.interpretationChunksMissingEmbedding >
                                        0 ||
                                        d.interpretationChunksModelMismatch >
                                          0) && (
                                        <span style={{ color: "#c0392b" }}>
                                          {" "}
                                          (
                                          {
                                            d.interpretationChunksMissingEmbedding
                                          }{" "}
                                          missing,{" "}
                                          {d.interpretationChunksModelMismatch}{" "}
                                          mismatched)
                                        </span>
                                      )}
                                    </td>
                                    <td style={cell}>
                                      {d.topicFitScore == null ? (
                                        <span style={{ color: "#999" }}>
                                          not scored
                                        </span>
                                      ) : d.offTopicSuspect ? (
                                        <span
                                          style={{
                                            color: "#c0392b",
                                            fontWeight: 600,
                                          }}
                                        >
                                          ⚠{" "}
                                          {Math.round(d.topicFitScore * 1000) /
                                            1000}{" "}
                                          off-topic suspect
                                        </span>
                                      ) : (
                                        <span style={{ color: "#2e7d32" }}>
                                          {Math.round(d.topicFitScore * 1000) /
                                            1000}
                                        </span>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function GovernancePanel() {
  const [data, setData] = useState<GovernanceData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/admin/governance`, {
      credentials: "include",
      headers: headers(),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<GovernanceData>;
      })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e.message ?? e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pctFmt = (x: number | null) =>
    x == null ? "—" : `${Math.round(x * 1000) / 10}%`;

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <div
          style={{
            fontSize: 20,
            fontWeight: 700,
            color: "#1a0505",
            marginBottom: 4,
          }}
        >
          Governance &amp; Accountability
        </div>
        <div
          style={{
            fontSize: 13,
            color: "#888",
            maxWidth: 720,
            lineHeight: 1.5,
          }}
        >
          The standing statement of where authority comes from, what the system
          may claim, how information is controlled, and who is accountable —
          mirrored verbatim in the Stanford OTL brief — with the live numbers
          behind each commitment.
        </div>
      </div>

      {/* The statement */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: 14,
          marginBottom: 28,
        }}
      >
        {GOVERNANCE_STATEMENT.map((s) => (
          <div
            key={s.title}
            style={{
              background: "#fff",
              border: "1px solid #e8e0e0",
              borderRadius: 12,
              padding: "18px 22px",
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: "#8B1A1A",
                letterSpacing: ".08em",
                textTransform: "uppercase",
                marginBottom: 10,
              }}
            >
              {s.title}
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 8 }}>
              {s.points.map((p, i) => (
                <li
                  key={i}
                  style={{ fontSize: 13, color: "#4a3535", lineHeight: 1.55 }}
                >
                  {p}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {/* Live numbers */}
      <div
        style={{
          fontSize: 13,
          fontWeight: 700,
          color: "#1a0505",
          marginBottom: 10,
          letterSpacing: ".04em",
          textTransform: "uppercase",
        }}
      >
        Live accountability numbers
      </div>
      {loading ? (
        <div style={{ color: "#aaa", padding: "32px 0" }}>Loading…</div>
      ) : error ? (
        <div style={{ color: "#c0392b", padding: "24px 0" }}>
          Couldn't load governance data: {error}
        </div>
      ) : !data ? null : (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
            <GovStat
              label="Stewards"
              value={String(data.stewards.total)}
              sub={`${data.stewards.onboarded} onboarded · ${data.pillars.active} active pillars`}
            />
            <GovStat
              label="Approved sources"
              value={`${data.content.sourcesApproved} / ${data.content.sourcesTotal}`}
              sub="only approved sources are retrievable"
            />
            <GovStat
              label="Approved interpretations"
              value={`${data.content.interpretationsApproved} / ${data.content.interpretationsTotal}`}
              sub={`${data.content.interpretationsPending} awaiting steward review`}
            />
            <GovStat
              label="Citation guard"
              value={pctFmt(data.citationHealth.verifiedRate)}
              sub={`latest eval run: ${data.citationHealth.verified} verified · ${data.citationHealth.unmatched} unmatched · ${data.citationHealth.missing} missing`}
            />
            <GovStat
              label="Questions logged"
              value={String(data.audit.questionsLogged)}
              sub={`${data.audit.questionsCovered} answered from the governed corpus`}
            />
            <GovStat
              label="OTL brief opens"
              value={String(data.audit.otlLogins)}
              sub={
                data.audit.otlLastAccessAt
                  ? `last access ${new Date(data.audit.otlLastAccessAt).toLocaleString()}`
                  : "no access recorded yet"
              }
            />
          </div>
          <div style={{ marginTop: 16, fontSize: 12, color: "#999" }}>
            Live data · generated {new Date(data.generatedAt).toLocaleString()}
          </div>
        </>
      )}
    </div>
  );
}

function OtlLoginsPanel() {
  const [events, setEvents] = useState<OtlLoginEvent[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/admin/otl-logins`, {
      credentials: "include",
      headers: headers(),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ events: OtlLoginEvent[] }>;
      })
      .then((d) => {
        if (!cancelled) setEvents(d.events);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e.message ?? e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <div
          style={{
            fontSize: 20,
            fontWeight: 700,
            color: "#1a0505",
            marginBottom: 4,
          }}
        >
          OTL Dashboard Logins
        </div>
        <div
          style={{
            fontSize: 13,
            color: "#888",
            maxWidth: 720,
            lineHeight: 1.5,
          }}
        >
          Every time the Stanford OTL governance dashboard is opened, newest
          first.
          <strong> Password</strong> means the shared password was entered for a
          fresh sign-in; <strong>Session</strong> means the dashboard was
          re-opened while still signed in (deduplicated to once per hour per
          location). Each row shows the time, approximate location (from IP),
          the IP address, and the device.
        </div>
      </div>

      {loading ? (
        <div style={{ color: "#aaa", padding: "48px 0" }}>Loading…</div>
      ) : error ? (
        <div style={{ color: "#c0392b", padding: "32px 0" }}>
          Couldn't load OTL logins: {error}
        </div>
      ) : !events ? null : (
        <>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 14,
              marginBottom: 24,
            }}
          >
            <div
              style={{
                background: "#fff",
                border: "1px solid #e8e0e0",
                borderRadius: 12,
                padding: "20px 24px",
                minWidth: 220,
                flex: 1,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: "#666",
                  letterSpacing: ".06em",
                  textTransform: "uppercase",
                }}
              >
                Total logins
              </div>
              <div
                style={{
                  fontSize: 28,
                  fontWeight: 700,
                  color: "#8B1A1A",
                  letterSpacing: "-0.02em",
                  marginTop: 6,
                }}
              >
                {events.length}
              </div>
            </div>
            <div
              style={{
                background: "#fff",
                border: "1px solid #e8e0e0",
                borderRadius: 12,
                padding: "20px 24px",
                minWidth: 220,
                flex: 2,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: "#666",
                  letterSpacing: ".06em",
                  textTransform: "uppercase",
                }}
              >
                Most recent
              </div>
              <div
                style={{
                  fontSize: 16,
                  fontWeight: 700,
                  color: "#1a0505",
                  marginTop: 8,
                }}
              >
                {events[0]
                  ? `${new Date(events[0].createdAt).toLocaleString("en-US")} — ${otlPlace(events[0])}`
                  : "No logins recorded yet"}
              </div>
            </div>
          </div>

          <div
            style={{
              background: "#fff",
              borderRadius: 14,
              border: "1px solid #e8e0e0",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "12px 20px",
                background: "#faf7f7",
                borderBottom: "1px solid #f0e8e8",
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: ".12em",
                  textTransform: "uppercase",
                  color: "#8B1A1A",
                }}
              >
                Login history
              </span>
            </div>
            {events.length === 0 ? (
              <div style={{ color: "#aaa", padding: "40px 20px" }}>
                No one has logged into the OTL dashboard yet.
              </div>
            ) : (
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 13,
                }}
              >
                <thead>
                  <tr
                    style={{
                      textAlign: "left",
                      color: "#888",
                      fontSize: 11,
                      textTransform: "uppercase",
                      letterSpacing: ".06em",
                    }}
                  >
                    <th style={{ padding: "10px 20px", fontWeight: 600 }}>
                      When
                    </th>
                    <th style={{ padding: "10px 20px", fontWeight: 600 }}>
                      How
                    </th>
                    <th style={{ padding: "10px 20px", fontWeight: 600 }}>
                      Location
                    </th>
                    <th style={{ padding: "10px 20px", fontWeight: 600 }}>
                      IP address
                    </th>
                    <th style={{ padding: "10px 20px", fontWeight: 600 }}>
                      Device
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e) => (
                    <tr key={e.id} style={{ borderTop: "1px solid #f5f0f0" }}>
                      <td
                        style={{
                          padding: "10px 20px",
                          color: "#1a0505",
                          fontWeight: 600,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {new Date(e.createdAt).toLocaleString("en-US")}
                      </td>
                      <td
                        style={{ padding: "10px 20px", whiteSpace: "nowrap" }}
                      >
                        {e.via === "session" ? (
                          <span
                            style={{
                              fontSize: 11,
                              fontWeight: 700,
                              color: "#2952cc",
                              background: "#eef3ff",
                              borderRadius: 6,
                              padding: "2px 8px",
                            }}
                          >
                            Session
                          </span>
                        ) : (
                          <span
                            style={{
                              fontSize: 11,
                              fontWeight: 700,
                              color: "#8B1A1A",
                              background: "#fceaea",
                              borderRadius: 6,
                              padding: "2px 8px",
                            }}
                          >
                            Password
                          </span>
                        )}
                      </td>
                      <td style={{ padding: "10px 20px", color: "#444" }}>
                        {otlPlace(e)}
                        {e.countryCode ? (
                          <span
                            style={{
                              color: "#aaa",
                              marginLeft: 6,
                              fontSize: 11,
                            }}
                          >
                            {e.countryCode}
                          </span>
                        ) : null}
                      </td>
                      <td
                        style={{
                          padding: "10px 20px",
                          color: "#666",
                          fontFamily: "ui-monospace, monospace",
                          fontSize: 12,
                        }}
                      >
                        {e.ip || "—"}
                      </td>
                      <td style={{ padding: "10px 20px", color: "#444" }}>
                        {otlDevice(e.userAgent)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}

interface AdminPillarRow {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  retiredAt: string | null;
  facultyCount: number;
  sourceCount: number;
  interpretationCount: number;
  pendingInviteCount: number;
}
interface AdminFacultyMembershipRow {
  pillarId: number;
  pillarSlug: string;
  pillarName: string;
  role: string;
}
interface AdminFacultyMemberRow {
  id: number;
  fullName: string | null;
  email: string;
  institution: string | null;
  photoUrl: string | null;
  isPlatformAdmin: boolean;
  registered: boolean;
  onboardedAt: string | null;
  memberships: AdminFacultyMembershipRow[];
}
interface AdminFacultyOverview {
  members: AdminFacultyMemberRow[];
  pillars: AdminPillarRow[];
}

const ROLE_BADGE: Record<string, { bg: string; fg: string }> = {
  steward: { bg: "#8B1A1A", fg: "#fff" },
  contributor: { bg: "#e8d9d9", fg: "#7a2020" },
  advisor: { bg: "#dde6ec", fg: "#1f4e6e" },
  viewer: { bg: "#ececec", fg: "#666" },
};

// Read-only Stewards & Pillars view. Management (invite, rename, retire) lives
// in the Clerk-gated faculty portal; this panel only surfaces the data.
function FacultyPanel() {
  const [data, setData] = useState<AdminFacultyOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`${API_BASE}/admin/faculty`, {
      credentials: "include",
      headers: headers(),
    })
      .then((r) => {
        if (!r.ok) throw new Error("failed");
        return r.json() as Promise<AdminFacultyOverview>;
      })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div style={{ color: "#888", fontSize: 14 }}>
        Loading stewards &amp; pillars…
      </div>
    );
  }
  if (error || !data) {
    return (
      <div style={{ color: "#c0392b", fontSize: 14 }}>
        Couldn&apos;t load stewards &amp; pillars.
      </div>
    );
  }

  const { members, pillars } = data;

  // Steward names per pillar, derived from the roster.
  const stewardsByPillar = new Map<number, string[]>();
  for (const m of members) {
    for (const mem of m.memberships) {
      if (mem.role === "steward") {
        const arr = stewardsByPillar.get(mem.pillarId) ?? [];
        arr.push(m.fullName ?? m.email);
        stewardsByPillar.set(mem.pillarId, arr);
      }
    }
  }

  const activePillars = pillars.filter((p) => !p.retiredAt).length;
  const stewardCount = members.filter((m) =>
    m.memberships.some((x) => x.role === "steward"),
  ).length;

  const cardStyle: React.CSSProperties = {
    background: "#fff",
    borderRadius: 12,
    padding: "16px 18px",
    boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
  };
  const th: React.CSSProperties = {
    padding: "8px 10px",
    fontSize: 11,
    color: "#999",
    textTransform: "uppercase",
    letterSpacing: ".05em",
    fontWeight: 600,
  };
  const td: React.CSSProperties = { padding: "10px", verticalAlign: "top" };

  function Stat({ label, value }: { label: string; value: number }) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
        }}
      >
        <span
          style={{
            fontSize: 17,
            fontWeight: 700,
            color: "#1a0505",
            lineHeight: 1,
          }}
        >
          {value}
        </span>
        <span
          style={{
            fontSize: 10.5,
            color: "#999",
            textTransform: "uppercase",
            letterSpacing: ".04em",
            marginTop: 2,
          }}
        >
          {label}
        </span>
      </div>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <div
          style={{
            fontSize: 20,
            fontWeight: 700,
            color: "#1a0505",
            marginBottom: 4,
          }}
        >
          Stewards &amp; Pillars
        </div>
        <div style={{ fontSize: 13, color: "#888" }}>
          Read-only view of the faculty coverage areas and who stewards them.
          Editing lives in the faculty portal — {pillars.length} pillars (
          {activePillars} active), {members.length} faculty, {stewardCount}{" "}
          stewards.
        </div>
      </div>

      {/* Pillars */}
      <div
        style={{
          fontSize: 13,
          fontWeight: 700,
          color: "#8B1A1A",
          textTransform: "uppercase",
          letterSpacing: ".06em",
          marginBottom: 10,
        }}
      >
        Pillars
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 14,
          marginBottom: 32,
        }}
      >
        {pillars.map((p) => {
          const stewards = stewardsByPillar.get(p.id) ?? [];
          return (
            <div
              key={p.id}
              style={{ ...cardStyle, opacity: p.retiredAt ? 0.6 : 1 }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <div
                  style={{ fontSize: 15, fontWeight: 700, color: "#1a0505" }}
                >
                  {p.name}
                </div>
                {p.retiredAt && (
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      color: "#999",
                      background: "#f0eaea",
                      borderRadius: 5,
                      padding: "2px 7px",
                      textTransform: "uppercase",
                      letterSpacing: ".05em",
                    }}
                  >
                    Retired
                  </span>
                )}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "#b08a8a",
                  marginTop: 2,
                  fontFamily: "monospace",
                }}
              >
                {p.slug}
              </div>
              {p.description && (
                <div
                  style={{
                    fontSize: 12.5,
                    color: "#666",
                    marginTop: 8,
                    lineHeight: 1.45,
                  }}
                >
                  {p.description}
                </div>
              )}
              <div style={{ fontSize: 12.5, color: "#555", marginTop: 10 }}>
                <span style={{ fontWeight: 600, color: "#1a0505" }}>
                  Stewards:{" "}
                </span>
                {stewards.length ? (
                  stewards.join(", ")
                ) : (
                  <span style={{ color: "#bbb" }}>none assigned</span>
                )}
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 18,
                  marginTop: 14,
                  flexWrap: "wrap",
                }}
              >
                <Stat label="Faculty" value={p.facultyCount} />
                <Stat label="Sources" value={p.sourceCount} />
                <Stat label="Interps" value={p.interpretationCount} />
                {p.pendingInviteCount > 0 && (
                  <Stat label="Pending" value={p.pendingInviteCount} />
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Roster */}
      <div
        style={{
          fontSize: 13,
          fontWeight: 700,
          color: "#8B1A1A",
          textTransform: "uppercase",
          letterSpacing: ".06em",
          marginBottom: 10,
        }}
      >
        Stewards &amp; faculty
      </div>
      <div style={{ ...cardStyle, padding: 0, overflow: "hidden" }}>
        <table
          style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}
        >
          <thead>
            <tr style={{ textAlign: "left", background: "#faf7f7" }}>
              <th style={th}>Name</th>
              <th style={th}>Institution</th>
              <th style={th}>Pillars &amp; roles</th>
              <th style={th}>Status</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} style={{ borderTop: "1px solid #f0eaea" }}>
                <td style={td}>
                  <div
                    style={{
                      fontWeight: 600,
                      color: "#1a0505",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    {m.fullName ?? "—"}
                    {m.isPlatformAdmin && (
                      <span
                        style={{
                          fontSize: 9.5,
                          fontWeight: 700,
                          color: "#fff",
                          background: "#8B1A1A",
                          borderRadius: 4,
                          padding: "1px 5px",
                          textTransform: "uppercase",
                          letterSpacing: ".04em",
                        }}
                      >
                        Admin
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: "#999" }}>{m.email}</div>
                </td>
                <td style={{ ...td, color: m.institution ? "#555" : "#bbb" }}>
                  {m.institution ?? "—"}
                </td>
                <td style={td}>
                  {m.memberships.length === 0 ? (
                    <span style={{ color: "#bbb" }}>—</span>
                  ) : (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                      {m.memberships.map((mem) => {
                        const b = ROLE_BADGE[mem.role] ?? ROLE_BADGE.viewer;
                        return (
                          <span
                            key={mem.pillarId}
                            style={{
                              background: b.bg,
                              color: b.fg,
                              borderRadius: 5,
                              padding: "2px 8px",
                              fontSize: 11,
                              fontWeight: 500,
                            }}
                          >
                            {mem.pillarName} · {mem.role}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </td>
                <td style={td}>
                  {m.onboardedAt ? (
                    <span style={{ color: "#2e7d32", fontWeight: 600 }}>
                      Onboarded
                    </span>
                  ) : m.registered ? (
                    <span style={{ color: "#1f4e8c", fontWeight: 600 }}>
                      User
                    </span>
                  ) : (
                    <span style={{ color: "#b8860b", fontWeight: 600 }}>
                      Invited
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Answer-format votes (avatar / podcast / text) ───────────────────────────
// Graphs the visitor poll shown under /sleep answers. One vote per visitor
// (server upserts by IP hash), so counts are distinct visitors, not clicks.
function FormatVotesPanel() {
  const [data, setData] = useState<{
    counts: { avatar: number; podcast: number; text: number };
    total: number;
    lastVoteAt: string | null;
  } | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/admin/format-votes`, {
      headers: headers(),
      credentials: "include",
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const OPTS: {
    key: "avatar" | "podcast" | "text";
    label: string;
    desc: string;
  }[] = [
    {
      key: "avatar",
      label: "Avatar",
      desc: "A video presenter delivers the answer",
    },
    { key: "podcast", label: "Podcast", desc: "Listen to the answer as audio" },
    { key: "text", label: "Text", desc: "Read the answer as text (current)" },
  ];
  const max = data
    ? Math.max(data.counts.avatar, data.counts.podcast, data.counts.text, 1)
    : 1;

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <div
          style={{
            fontSize: 20,
            fontWeight: 700,
            color: "#1a0505",
            marginBottom: 4,
          }}
        >
          Answer format votes
        </div>
        <div style={{ fontSize: 13, color: "#888" }}>
          Visitor poll under /sleep answers: avatar vs podcast vs text. One vote
          per visitor — re-voting changes the choice instead of adding a click.
        </div>
      </div>
      <div
        style={{
          background: "#fff",
          borderRadius: 14,
          padding: "26px 28px",
          border: "1px solid #eee2e2",
          maxWidth: 640,
        }}
      >
        {loading && <div style={{ fontSize: 13, color: "#999" }}>Loading…</div>}
        {error && (
          <div style={{ fontSize: 13, color: "#a33" }}>
            Could not load votes.
          </div>
        )}
        {data && data.total === 0 && (
          <div style={{ fontSize: 13, color: "#999" }}>No votes yet.</div>
        )}
        {data && data.total > 0 && (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              {OPTS.map((o) => {
                const n = data.counts[o.key];
                const pct = Math.round((n / data.total) * 100);
                return (
                  <div key={o.key}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "baseline",
                        marginBottom: 6,
                      }}
                    >
                      <div>
                        <span
                          style={{
                            fontSize: 14,
                            fontWeight: 600,
                            color: "#1a0505",
                          }}
                        >
                          {o.label}
                        </span>
                        <span
                          style={{ fontSize: 12, color: "#999", marginLeft: 8 }}
                        >
                          {o.desc}
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: 13,
                          color: "#6b2020",
                          fontWeight: 600,
                        }}
                      >
                        {n} · {pct}%
                      </div>
                    </div>
                    <div
                      style={{
                        height: 14,
                        borderRadius: 7,
                        background: "#f4eaea",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          width: `${Math.round((n / max) * 100)}%`,
                          height: "100%",
                          background: "#8B1A1A",
                          borderRadius: 7,
                          transition: "width .4s ease",
                          minWidth: n > 0 ? 8 : 0,
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            <div
              style={{
                marginTop: 20,
                paddingTop: 14,
                borderTop: "1px solid #f0e6e6",
                fontSize: 12,
                color: "#999",
                display: "flex",
                justifyContent: "space-between",
              }}
            >
              <span>
                {data.total} voter{data.total === 1 ? "" : "s"}
              </span>
              {data.lastVoteAt && (
                <span>Last vote {fmtTime(data.lastVoteAt)}</span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Referral program aggregate stats ────────────────────────────────────────
function ReferralStatsPanel() {
  const [data, setData] = useState<{
    totalCodes: number;
    totalClicks: number;
    totalSignups: number;
    totalConversions: number;
    totalCreditsCents: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/referral-stats", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <div
        style={{
          fontSize: 20,
          fontWeight: 700,
          color: "#1a0505",
          marginBottom: 4,
        }}
      >
        Referral Program
      </div>
      <div style={{ fontSize: 13, color: "#888", marginBottom: 24 }}>
        Aggregate stats for the double-sided referral program.
      </div>
      {loading && <div style={{ color: "#888", fontSize: 13 }}>Loading...</div>}
      {error && (
        <div style={{ color: "#c0392b", fontSize: 13 }}>
          Could not load referral stats.
        </div>
      )}
      {data && (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(5, 1fr)",
              gap: 16,
            }}
          >
            {(
              [
                { label: "Codes issued", value: data.totalCodes },
                { label: "Clicks", value: data.totalClicks },
                { label: "Signups", value: data.totalSignups },
                { label: "Conversions", value: data.totalConversions },
                {
                  label: "Credits issued",
                  value: `$${(data.totalCreditsCents / 100).toFixed(0)}`,
                },
              ] as const
            ).map(({ label, value }) => (
              <div
                key={label}
                style={{
                  background: "#fff",
                  border: "1px solid #e0d8d8",
                  borderRadius: 10,
                  padding: "16px 18px",
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: ".1em",
                    color: "#aaa",
                    textTransform: "uppercase",
                    marginBottom: 6,
                  }}
                >
                  {label}
                </div>
                <div
                  style={{ fontSize: 28, fontWeight: 700, color: "#8B1A1A" }}
                >
                  {value}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Pillar Resource Links admin panel ─────────────────────────────────────────

interface PillarResourceRow {
  id: number;
  title: string;
  url: string;
  description: string | null;
  category: string | null;
  displayOrder: number;
}

interface PillarForResources {
  id: number;
  slug: string;
  name: string;
  retiredAt: string | null;
  resources: PillarResourceRow[];
}

const RES_INPUT: React.CSSProperties = {
  border: "1px solid #ddd",
  borderRadius: 6,
  padding: "5px 8px",
  fontSize: 12,
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

function ResourceEditor({
  pillar,
  onDone,
}: {
  pillar: PillarForResources;
  onDone: () => void;
}) {
  const [resources, setResources] = useState<PillarResourceRow[]>(
    pillar.resources,
  );
  const [saving, setSaving] = useState<
    Partial<Record<number | "new", boolean>>
  >({});
  const [errors, setErrors] = useState<Partial<Record<number | "new", string>>>(
    {},
  );
  const [newRow, setNewRow] = useState({
    title: "",
    url: "",
    description: "",
    category: "",
  });
  const [addOpen, setAddOpen] = useState(false);

  function base() {
    return `/api/admin/pillars/${pillar.slug}/resources`;
  }

  async function saveEdit(r: PillarResourceRow) {
    setSaving((s) => ({ ...s, [r.id]: true }));
    setErrors((e) => {
      const n = { ...e };
      delete n[r.id];
      return n;
    });
    try {
      const resp = await fetch(`${base()}/${r.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: r.title,
          url: r.url,
          description: r.description,
          category: r.category,
          displayOrder: r.displayOrder,
        }),
      });
      if (!resp.ok) {
        const d = (await resp.json().catch(() => ({}))) as { error?: string };
        setErrors((e) => ({
          ...e,
          [r.id]:
            d.error === "url_already_exists"
              ? "URL already used by another resource"
              : "Save failed",
        }));
      }
    } catch {
      setErrors((e) => ({ ...e, [r.id]: "Network error" }));
    } finally {
      setSaving((s) => {
        const n = { ...s };
        delete n[r.id];
        return n;
      });
    }
  }

  async function deleteResource(id: number) {
    if (!confirm("Delete this resource link?")) return;
    const resp = await fetch(`${base()}/${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (resp.ok) {
      setResources((rs) => rs.filter((r) => r.id !== id));
    }
  }

  async function moveRow(idx: number, dir: -1 | 1) {
    const next = [...resources];
    const swap = idx + dir;
    if (swap < 0 || swap >= next.length) return;
    [next[idx], next[swap]] = [next[swap], next[idx]];
    const reordered = next.map((r, i) => ({ ...r, displayOrder: i }));
    setResources(reordered);
    await fetch(`${base()}/reorder`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: reordered.map((r) => r.id) }),
    });
  }

  async function addResource() {
    if (!newRow.title.trim() || !newRow.url.trim()) {
      setErrors((e) => ({ ...e, new: "Title and URL are required" }));
      return;
    }
    setSaving((s) => ({ ...s, new: true }));
    setErrors((e) => {
      const n = { ...e };
      delete n["new" as unknown as number];
      return n;
    });
    try {
      const resp = await fetch(base(), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newRow.title.trim(),
          url: newRow.url.trim(),
          description: newRow.description.trim() || null,
          category: newRow.category.trim() || null,
          displayOrder: resources.length,
        }),
      });
      const d = (await resp.json()) as {
        resource?: PillarResourceRow;
        error?: string;
      };
      if (!resp.ok) {
        setErrors((e) => ({
          ...e,
          new:
            d.error === "url_already_exists"
              ? "URL already used by another resource"
              : "Add failed",
        }));
        return;
      }
      if (d.resource) {
        setResources((rs) => [...rs, d.resource!]);
        setNewRow({ title: "", url: "", description: "", category: "" });
        setAddOpen(false);
      }
    } catch {
      setErrors((e) => ({ ...e, new: "Network error" }));
    } finally {
      setSaving((s) => {
        const n = { ...s };
        delete n["new" as unknown as number];
        return n;
      });
    }
  }

  const tdStyle: React.CSSProperties = {
    padding: "8px 6px",
    verticalAlign: "middle",
  };

  return (
    <div style={{ marginBottom: 32 }}>
      <div
        style={{
          background: "#fff",
          border: "1px solid #e8ddd0",
          borderRadius: 10,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "12px 16px",
            background: "#f9f5ee",
            borderBottom:
              resources.length > 0 || addOpen ? "1px solid #e8ddd0" : undefined,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div>
            <span style={{ fontWeight: 700, fontSize: 14, color: "#1a0505" }}>
              {pillar.name}
            </span>
            {pillar.retiredAt && (
              <span
                style={{
                  marginLeft: 8,
                  fontSize: 10,
                  background: "#f0ebe0",
                  color: "#999",
                  borderRadius: 4,
                  padding: "2px 6px",
                  fontWeight: 600,
                }}
              >
                RETIRED
              </span>
            )}
            <span style={{ marginLeft: 8, fontSize: 12, color: "#999" }}>
              {resources.length} link{resources.length !== 1 ? "s" : ""}
            </span>
          </div>
          <button
            onClick={() => setAddOpen((o) => !o)}
            style={{
              background: "#8B1A1A",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              padding: "5px 12px",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {addOpen ? "Cancel" : "+ Add link"}
          </button>
        </div>

        {(resources.length > 0 || addOpen) && (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#f9f5ee" }}>
                <th
                  style={{
                    ...tdStyle,
                    fontSize: 10,
                    color: "#aaa",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: ".06em",
                    width: 60,
                  }}
                >
                  Order
                </th>
                <th
                  style={{
                    ...tdStyle,
                    fontSize: 10,
                    color: "#aaa",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: ".06em",
                  }}
                >
                  Title
                </th>
                <th
                  style={{
                    ...tdStyle,
                    fontSize: 10,
                    color: "#aaa",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: ".06em",
                  }}
                >
                  URL
                </th>
                <th
                  style={{
                    ...tdStyle,
                    fontSize: 10,
                    color: "#aaa",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: ".06em",
                  }}
                >
                  Description
                </th>
                <th
                  style={{
                    ...tdStyle,
                    fontSize: 10,
                    color: "#aaa",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: ".06em",
                  }}
                >
                  Category
                </th>
                <th
                  style={{
                    ...tdStyle,
                    fontSize: 10,
                    color: "#aaa",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: ".06em",
                    width: 80,
                  }}
                ></th>
              </tr>
            </thead>
            <tbody>
              {resources.map((r, idx) => (
                <ResourceRow
                  key={r.id}
                  resource={r}
                  idx={idx}
                  total={resources.length}
                  saving={!!saving[r.id]}
                  error={errors[r.id]}
                  onChange={(updated) =>
                    setResources((rs) =>
                      rs.map((x) => (x.id === r.id ? updated : x)),
                    )
                  }
                  onSave={() => saveEdit(r)}
                  onDelete={() => deleteResource(r.id)}
                  onMove={(dir) => moveRow(idx, dir)}
                />
              ))}
              {addOpen && (
                <tr style={{ background: "#fffdf8" }}>
                  <td style={tdStyle} />
                  <td style={tdStyle}>
                    <input
                      style={RES_INPUT}
                      placeholder="Title"
                      value={newRow.title}
                      onChange={(e) =>
                        setNewRow((n) => ({ ...n, title: e.target.value }))
                      }
                    />
                  </td>
                  <td style={tdStyle}>
                    <input
                      style={RES_INPUT}
                      placeholder="https://..."
                      value={newRow.url}
                      onChange={(e) =>
                        setNewRow((n) => ({ ...n, url: e.target.value }))
                      }
                    />
                  </td>
                  <td style={tdStyle}>
                    <input
                      style={RES_INPUT}
                      placeholder="Optional description"
                      value={newRow.description}
                      onChange={(e) =>
                        setNewRow((n) => ({
                          ...n,
                          description: e.target.value,
                        }))
                      }
                    />
                  </td>
                  <td style={tdStyle}>
                    <input
                      style={RES_INPUT}
                      placeholder="Optional category"
                      value={newRow.category}
                      onChange={(e) =>
                        setNewRow((n) => ({ ...n, category: e.target.value }))
                      }
                    />
                  </td>
                  <td style={tdStyle}>
                    <button
                      onClick={addResource}
                      disabled={!!saving["new" as unknown as number]}
                      style={{
                        background: "#8B1A1A",
                        color: "#fff",
                        border: "none",
                        borderRadius: 6,
                        padding: "5px 10px",
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                    >
                      {saving["new" as unknown as number] ? "Adding…" : "Add"}
                    </button>
                    {errors["new" as unknown as number] && (
                      <div
                        style={{ fontSize: 11, color: "#c0392b", marginTop: 3 }}
                      >
                        {errors["new" as unknown as number]}
                      </div>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        {resources.length === 0 && !addOpen && (
          <div style={{ padding: "16px 18px", fontSize: 13, color: "#bbb" }}>
            No resource links yet.
          </div>
        )}
      </div>
      <div
        style={{
          cursor: "pointer",
          fontSize: 12,
          color: "#8B1A1A",
          marginTop: 6,
          textAlign: "right",
        }}
        onClick={onDone}
      >
        Done editing
      </div>
    </div>
  );
}

function ResourceRow({
  resource,
  idx,
  total,
  saving,
  error,
  onChange,
  onSave,
  onDelete,
  onMove,
}: {
  resource: PillarResourceRow;
  idx: number;
  total: number;
  saving: boolean;
  error?: string;
  onChange: (r: PillarResourceRow) => void;
  onSave: () => void;
  onDelete: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const tdStyle: React.CSSProperties = {
    padding: "8px 6px",
    verticalAlign: "middle",
  };

  return (
    <tr style={{ borderTop: "1px solid #f0ebe6" }}>
      <td style={{ ...tdStyle, textAlign: "center" }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 1,
          }}
        >
          <button
            onClick={() => onMove(-1)}
            disabled={idx === 0}
            style={{
              background: "none",
              border: "none",
              cursor: idx === 0 ? "default" : "pointer",
              color: idx === 0 ? "#ddd" : "#8B1A1A",
              fontSize: 14,
              padding: "1px 4px",
            }}
          >
            ↑
          </button>
          <span style={{ fontSize: 11, color: "#bbb" }}>{idx + 1}</span>
          <button
            onClick={() => onMove(1)}
            disabled={idx === total - 1}
            style={{
              background: "none",
              border: "none",
              cursor: idx === total - 1 ? "default" : "pointer",
              color: idx === total - 1 ? "#ddd" : "#8B1A1A",
              fontSize: 14,
              padding: "1px 4px",
            }}
          >
            ↓
          </button>
        </div>
      </td>
      <td style={tdStyle}>
        <input
          style={RES_INPUT}
          value={resource.title}
          onChange={(e) => onChange({ ...resource, title: e.target.value })}
        />
      </td>
      <td style={tdStyle}>
        <input
          style={RES_INPUT}
          value={resource.url}
          onChange={(e) => onChange({ ...resource, url: e.target.value })}
        />
      </td>
      <td style={tdStyle}>
        <input
          style={RES_INPUT}
          value={resource.description ?? ""}
          placeholder="Optional"
          onChange={(e) =>
            onChange({ ...resource, description: e.target.value || null })
          }
        />
      </td>
      <td style={tdStyle}>
        <input
          style={RES_INPUT}
          value={resource.category ?? ""}
          placeholder="Optional"
          onChange={(e) =>
            onChange({ ...resource, category: e.target.value || null })
          }
        />
      </td>
      <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
        <button
          onClick={onSave}
          disabled={saving}
          style={{
            background: "#8B1A1A",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            padding: "4px 10px",
            fontSize: 12,
            fontWeight: 600,
            cursor: saving ? "default" : "pointer",
            marginRight: 4,
          }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          onClick={onDelete}
          style={{
            background: "#fff",
            color: "#c0392b",
            border: "1px solid #e8d0d0",
            borderRadius: 6,
            padding: "4px 8px",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          Delete
        </button>
        {error && (
          <div style={{ fontSize: 11, color: "#c0392b", marginTop: 2 }}>
            {error}
          </div>
        )}
      </td>
    </tr>
  );
}

function PillarResourcesPanel() {
  const [pillars, setPillars] = useState<PillarForResources[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    fetch("/api/admin/faculty", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(
        async (overview: {
          pillars: {
            id: number;
            slug: string;
            name: string;
            retiredAt: string | null;
          }[];
        }) => {
          const withResources: PillarForResources[] = await Promise.all(
            overview.pillars.map(async (p) => {
              try {
                const r = await fetch(
                  `/api/admin/pillars/${p.slug}/resources`,
                  { credentials: "include" },
                );
                const d = (await r.json()) as {
                  resources: PillarResourceRow[];
                };
                return { ...p, resources: d.resources ?? [] };
              } catch {
                return { ...p, resources: [] };
              }
            }),
          );
          if (!cancelled) {
            setPillars(withResources);
            setLoading(false);
          }
        },
      )
      .catch(() => {
        if (!cancelled) {
          setError(true);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (loading)
    return <div style={{ color: "#888", fontSize: 14 }}>Loading pillars…</div>;
  if (error || !pillars)
    return (
      <div style={{ color: "#c0392b", fontSize: 14 }}>
        Could not load pillars.
      </div>
    );

  const activePillars = pillars.filter((p) => !p.retiredAt);
  const retiredPillars = pillars.filter((p) => p.retiredAt);

  function renderPillar(p: PillarForResources) {
    if (editing === p.id) {
      return (
        <ResourceEditor
          key={p.id}
          pillar={p}
          onDone={() => {
            setEditing(null);
            setLoading(true);
            fetch("/api/admin/faculty", { credentials: "include" })
              .then((r) => (r.ok ? r.json() : Promise.reject()))
              .then(
                async (overview: {
                  pillars: {
                    id: number;
                    slug: string;
                    name: string;
                    retiredAt: string | null;
                  }[];
                }) => {
                  const withResources: PillarForResources[] = await Promise.all(
                    overview.pillars.map(async (pl) => {
                      try {
                        const r = await fetch(
                          `/api/admin/pillars/${pl.slug}/resources`,
                          { credentials: "include" },
                        );
                        const d = (await r.json()) as {
                          resources: PillarResourceRow[];
                        };
                        return { ...pl, resources: d.resources ?? [] };
                      } catch {
                        return { ...pl, resources: [] };
                      }
                    }),
                  );
                  setPillars(withResources);
                },
              )
              .catch(() => setError(true))
              .finally(() => setLoading(false));
          }}
        />
      );
    }

    const total = p.resources.length;
    return (
      <div
        key={p.id}
        style={{
          background: "#fff",
          border: "1px solid #e8ddd0",
          borderRadius: 10,
          padding: "12px 16px",
          marginBottom: 10,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div>
          <span style={{ fontWeight: 600, fontSize: 14, color: "#1a0505" }}>
            {p.name}
          </span>
          {p.retiredAt && (
            <span
              style={{
                marginLeft: 8,
                fontSize: 10,
                background: "#f0ebe0",
                color: "#999",
                borderRadius: 4,
                padding: "2px 6px",
                fontWeight: 600,
              }}
            >
              RETIRED
            </span>
          )}
          <span style={{ marginLeft: 10, fontSize: 12, color: "#999" }}>
            {total === 0
              ? "No links"
              : `${total} link${total !== 1 ? "s" : ""}`}
          </span>
          {total > 0 && (
            <div
              style={{
                marginTop: 4,
                display: "flex",
                flexWrap: "wrap",
                gap: 4,
              }}
            >
              {p.resources.map((r) => (
                <span
                  key={r.id}
                  style={{
                    fontSize: 11,
                    background: "#f4f0eb",
                    color: "#666",
                    borderRadius: 4,
                    padding: "2px 6px",
                  }}
                >
                  {r.title}
                </span>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={() => setEditing(p.id)}
          style={{
            background: "#fff",
            color: "#8B1A1A",
            border: "1px solid #e0d0d0",
            borderRadius: 6,
            padding: "5px 12px",
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
            flexShrink: 0,
            marginLeft: 12,
          }}
        >
          Edit links
        </button>
      </div>
    );
  }

  return (
    <div>
      <div
        style={{
          fontSize: 20,
          fontWeight: 700,
          color: "#1a0505",
          marginBottom: 4,
        }}
      >
        Pillar Resource Links
      </div>
      <div style={{ fontSize: 13, color: "#888", marginBottom: 24 }}>
        Curated external links shown in the "Learn more" panel when a pillar has
        no answered corpus. Changes are live immediately.
      </div>

      {activePillars.length > 0 && (
        <div style={{ marginBottom: 28 }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: "#aaa",
              letterSpacing: ".08em",
              textTransform: "uppercase",
              marginBottom: 10,
            }}
          >
            Active pillars
          </div>
          {activePillars.map(renderPillar)}
        </div>
      )}

      {retiredPillars.length > 0 && (
        <div>
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: "#aaa",
              letterSpacing: ".08em",
              textTransform: "uppercase",
              marginBottom: 10,
            }}
          >
            Retired pillars
          </div>
          {retiredPillars.map(renderPillar)}
        </div>
      )}
    </div>
  );
}

export default function Admin() {
  const [authed, setAuthed] = useState(() => {
    try {
      return sessionStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [pw, setPw] = useState("");
  const [pwError, setPwError] = useState(false);
  const [pwLoading, setPwLoading] = useState(false);

  const [tab, setTab] = useState<
    | "users"
    | "traffic"
    | "waitlist"
    | "phone"
    | "doorway"
    | "stories"
    | "investors"
    | "audit"
    | "advice"
    | "email"
    | "faculty"
    | "agent"
    | "otl"
    | "governance"
    | "earnings"
    | "ingestion"
    | "votes"
    | "referral"
    | "resources"
    | "ipshield"
  >(() => {
    // Allow deep-linking to a specific tab, e.g. the command-center hub opens
    // /admin?tab=investors for the Investor Relations card.
    try {
      const t = new URLSearchParams(window.location.search).get("tab");
      if (
        t === "users" ||
        t === "traffic" ||
        t === "waitlist" ||
        t === "phone" ||
        t === "doorway" ||
        t === "stories" ||
        t === "investors" ||
        t === "audit" ||
        t === "advice" ||
        t === "email" ||
        t === "faculty" ||
        t === "agent" ||
        t === "otl" ||
        t === "governance" ||
        t === "earnings" ||
        t === "ingestion" ||
        t === "votes" ||
        t === "referral" ||
        t === "resources" ||
        t === "ipshield"
      ) {
        return t;
      }
    } catch {
      /* no-op */
    }
    return "users";
  });
  const [overview, setOverview] = useState<Overview | null>(null);
  const [peopleResp, setPeopleResp] = useState<PeopleResponse | null>(null);
  const [loadingPeople, setLoadingPeople] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [peopleOffset, setPeopleOffset] = useState(0);
  const [loadingOverview, setLoadingOverview] = useState(false);
  const [expandedUser, setExpandedUser] = useState<number | null>(null);
  const [userDetail, setUserDetail] = useState<UserDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [search, setSearch] = useState("");
  const [jobStatus, setJobStatus] = useState<Record<string, string>>({});
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [loadingAnalytics, setLoadingAnalytics] = useState(false);
  const [digestSending, setDigestSending] = useState(false);
  const [digestMsg, setDigestMsg] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [includeBots, setIncludeBots] = useState(false);
  const [waitlist, setWaitlist] = useState<WaitlistEntry[] | null>(null);
  const [loadingWaitlist, setLoadingWaitlist] = useState(false);
  const [betaAbStats, setBetaAbStats] = useState<{
    total: number;
    byVariant: Record<string, number>;
    foundingCount: number;
    notifyCount: number;
  } | null>(null);
  const [phoneEntries, setPhoneEntries] = useState<PhoneEntry[] | null>(null);
  const [loadingPhone, setLoadingPhone] = useState(false);
  const [phoneProductFilter, setPhoneProductFilter] = useState<string>("");
  const [phoneStatusFilter, setPhoneStatusFilter] = useState<string>("");
  const [stripeMode, setStripeMode] = useState<StripeMode | null>(null);

  async function triggerJob(endpoint: string, label: string) {
    setJobStatus((s) => ({ ...s, [endpoint]: "running…" }));
    try {
      const res = await fetch(`${API_BASE}/${endpoint}`, {
        method: "POST",
        headers: headers(),
      });
      const data = await res.json();
      setJobStatus((s) => ({ ...s, [endpoint]: `sent ${data.sent ?? 0}` }));
      setTimeout(
        () =>
          setJobStatus((s) => {
            const n = { ...s };
            delete n[endpoint];
            return n;
          }),
        4000,
      );
    } catch {
      setJobStatus((s) => ({ ...s, [endpoint]: "error" }));
      setTimeout(
        () =>
          setJobStatus((s) => {
            const n = { ...s };
            delete n[endpoint];
            return n;
          }),
        3000,
      );
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!pw.trim()) return;
    setPwLoading(true);
    try {
      const res = await fetch(`${API_BASE}/admin-auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw.trim() }),
      });
      if (res.ok) {
        sessionStorage.setItem(STORAGE_KEY, "1");
        setAuthed(true);
      } else {
        setPwError(true);
        setTimeout(() => setPwError(false), 1800);
      }
    } catch {
      setPwError(true);
      setTimeout(() => setPwError(false), 1800);
    } finally {
      setPwLoading(false);
    }
  }

  // Seamless bridge: if a valid `palonur_admin` cookie is already present
  // (e.g. minted by the command-center hub after verifying Karan via Clerk),
  // skip the password prompt entirely. This does NOT change the shared-password
  // login — teammates without the cookie still get the form below.
  useEffect(() => {
    if (authed) return;
    let cancelled = false;
    fetch(`${API_BASE}/admin/session`, { credentials: "include" })
      .then((r) => {
        if (!cancelled && r.ok) {
          try {
            sessionStorage.setItem(STORAGE_KEY, "1");
          } catch {
            /* no-op */
          }
          setAuthed(true);
        }
      })
      .catch(() => {
        /* not bridged — show password form */
      });
    return () => {
      cancelled = true;
    };
  }, [authed]);

  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    fetch(`${API_BASE}/admin/stripe-mode`, { headers: headers() })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setStripeMode(d as StripeMode);
      })
      .catch(() => {
        /* leave null — badge stays hidden */
      });
    return () => {
      cancelled = true;
    };
  }, [authed]);

  useEffect(() => {
    if (!authed) return;
    setLoadingOverview(true);
    fetch(`${API_BASE}/admin/overview`, { headers: headers() })
      .then((r) => r.json())
      .then((ov) => setOverview(ov))
      .catch(() => {})
      .finally(() => setLoadingOverview(false));
  }, [authed]);

  // People directory — server-side search / source / status filtering +
  // pagination. Debounced so typing in the search box doesn't spam the API.
  useEffect(() => {
    if (!authed || tab !== "users") return;
    let cancelled = false;
    setLoadingPeople(true);
    const params = new URLSearchParams();
    if (search.trim()) params.set("q", search.trim());
    if (sourceFilter) params.set("source", sourceFilter);
    if (statusFilter) params.set("status", statusFilter);
    params.set("limit", String(PEOPLE_LIMIT));
    params.set("offset", String(peopleOffset));
    const t = setTimeout(() => {
      fetch(`${API_BASE}/admin/people?${params.toString()}`, {
        headers: headers(),
      })
        .then((r) => r.json())
        .then((d) => {
          if (!cancelled) setPeopleResp(d as PeopleResponse);
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setLoadingPeople(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [authed, tab, search, sourceFilter, statusFilter, peopleOffset]);

  useEffect(() => {
    if (expandedUser == null) {
      setUserDetail(null);
      return;
    }
    setLoadingDetail(true);
    fetch(`${API_BASE}/admin/user/${expandedUser}`, { headers: headers() })
      .then((r) => r.json())
      .then((d) => setUserDetail(d))
      .catch(() => {})
      .finally(() => setLoadingDetail(false));
  }, [expandedUser]);

  useEffect(() => {
    if (!authed || tab !== "traffic" || analytics) return;
    setLoadingAnalytics(true);
    fetch(
      `${API_BASE}/admin/analytics${includeBots ? "?include_bots=1" : ""}`,
      { headers: headers() },
    )
      .then((r) => r.json())
      .then((d) => setAnalytics(d))
      .catch(() => {})
      .finally(() => setLoadingAnalytics(false));
  }, [authed, tab, analytics, includeBots]);

  async function sendAnalyticsDigest() {
    setDigestSending(true);
    setDigestMsg(null);
    try {
      const r = await fetch(`${API_BASE}/admin/analytics/send-digest`, {
        method: "POST",
        headers: headers(),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok) {
        setDigestMsg({
          ok: true,
          text: `Sent to ${d.recipients} recipient${d.recipients === 1 ? "" : "s"}. Check your inbox.`,
        });
      } else if (d.reason === "resend_unconfigured") {
        setDigestMsg({
          ok: false,
          text: "Email isn't configured on this server — nothing sent.",
        });
      } else if (d.reason === "no_recipients") {
        setDigestMsg({ ok: false, text: "No recipients are configured." });
      } else {
        setDigestMsg({ ok: false, text: "Send failed — check server logs." });
      }
    } catch {
      setDigestMsg({ ok: false, text: "Send failed — network error." });
    } finally {
      setDigestSending(false);
    }
  }

  useEffect(() => {
    if (!authed || tab !== "waitlist" || waitlist) return;
    setLoadingWaitlist(true);
    fetch(`${API_BASE}/admin/waitlist`, { headers: headers() })
      .then((r) => r.json())
      .then((d) => setWaitlist(d.entries ?? []))
      .catch(() => {})
      .finally(() => setLoadingWaitlist(false));
  }, [authed, tab, waitlist]);

  useEffect(() => {
    if (!authed || tab !== "waitlist" || betaAbStats) return;
    fetch(`${API_BASE}/admin/beta-ab-stats`, { credentials: "include" })
      .then((r) => r.json())
      .then((d) => {
        if (d.total !== undefined) setBetaAbStats(d);
      })
      .catch(() => {});
  }, [authed, tab, betaAbStats]);

  // Phone subscribers — refetch whenever the product/status filters change.
  useEffect(() => {
    if (!authed || tab !== "phone") return;
    setLoadingPhone(true);
    const qs = new URLSearchParams();
    if (phoneProductFilter) qs.set("product", phoneProductFilter);
    if (phoneStatusFilter) qs.set("status", phoneStatusFilter);
    fetch(`${API_BASE}/admin/phone-numbers?${qs.toString()}`, {
      headers: headers(),
    })
      .then((r) => r.json())
      .then((d) => setPhoneEntries(d.entries ?? []))
      .catch(() => {})
      .finally(() => setLoadingPhone(false));
  }, [authed, tab, phoneProductFilter, phoneStatusFilter]);

  if (!authed) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "#f8f4f4",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <form
          onSubmit={handleLogin}
          style={{
            background: "#fff",
            borderRadius: 16,
            padding: "48px 40px",
            boxShadow: "0 4px 32px rgba(0,0,0,0.08)",
            width: 340,
          }}
        >
          <div
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: "#8B1A1A",
              marginBottom: 8,
              letterSpacing: "-0.02em",
            }}
          >
            Palonur Admin
          </div>
          <div style={{ fontSize: 13, color: "#888", marginBottom: 28 }}>
            Research dashboard — restricted access
          </div>
          <input
            type="password"
            placeholder="Admin password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            autoFocus
            style={{
              width: "100%",
              padding: "12px 14px",
              borderRadius: 10,
              border: pwError ? "1.5px solid #c0392b" : "1.5px solid #ddd",
              fontSize: 15,
              outline: "none",
              boxSizing: "border-box",
              transition: "border .15s",
            }}
          />
          {pwError && (
            <div style={{ fontSize: 12, color: "#c0392b", marginTop: 6 }}>
              Incorrect password
            </div>
          )}
          <button
            type="submit"
            disabled={pwLoading}
            style={{
              marginTop: 16,
              width: "100%",
              padding: "13px 0",
              background: "#8B1A1A",
              color: "#fff",
              border: "none",
              borderRadius: 10,
              fontSize: 15,
              fontWeight: 600,
              cursor: pwLoading ? "wait" : "pointer",
              opacity: pwLoading ? 0.7 : 1,
            }}
          >
            {pwLoading ? "Checking…" : "Enter"}
          </button>
        </form>
      </div>
    );
  }

  const peopleExportParams = (() => {
    const p = new URLSearchParams();
    if (search.trim()) p.set("q", search.trim());
    if (sourceFilter) p.set("source", sourceFilter);
    if (statusFilter) p.set("status", statusFilter);
    return p.toString();
  })();

  const retention7d =
    overview && overview.eligible7d > 0
      ? Math.round((overview.retained7d / overview.eligible7d) * 100)
      : null;

  const checkinRate =
    overview && overview.commitUsers > 0
      ? Math.round((overview.checkinUsers / overview.commitUsers) * 100)
      : null;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#f8f4f4",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Inter', sans-serif",
      }}
    >
      {/* Header */}
      <div style={{ background: "#8B1A1A" }}>
        <div
          style={{
            padding: "16px 32px 12px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: "#fff",
                letterSpacing: "-0.01em",
              }}
            >
              Palonur
            </div>
            <div
              style={{
                fontSize: 11,
                color: "rgba(255,255,255,0.55)",
                letterSpacing: ".1em",
                textTransform: "uppercase",
              }}
            >
              Admin Dashboard
            </div>
            <StripeModeBadge info={stripeMode} />
          </div>
          <button
            onClick={() => {
              sessionStorage.removeItem(STORAGE_KEY);
              fetch(`${API_BASE}/admin-auth`, { method: "DELETE" }).catch(
                () => {},
              );
              setAuthed(false);
            }}
            style={{
              background: "transparent",
              border: "1px solid rgba(255,255,255,0.3)",
              color: "rgba(255,255,255,0.7)",
              borderRadius: 8,
              padding: "6px 14px",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            Sign out
          </button>
        </div>
        {/* Grouped navigation */}
        <div
          style={{
            padding: "0 32px 14px",
            display: "flex",
            flexWrap: "wrap",
            gap: "10px 28px",
            alignItems: "flex-end",
          }}
        >
          {(
            [
              {
                group: "Audience",
                tabs: [
                  ["users", "Users"],
                  ["traffic", "Traffic"],
                  ["waitlist", "Waitlist"],
                  ["referral", "Referral"],
                  ["phone", "Phone"],
                ],
              },
              {
                group: "Content",
                tabs: [
                  ["stories", "Stories"],
                  ["email", "Email"],
                  ["advice", "Advice"],
                  ["doorway", "Doorway"],
                  ["resources", "Resources"],
                  ["votes", "Votes"],
                ],
              },
              {
                group: "Faculty",
                tabs: [
                  ["faculty", "Stewards"],
                  ["governance", "Governance"],
                  ["ingestion", "Ingestion"],
                  ["audit", "Audit"],
                  ["otl", "OTL"],
                ],
              },
              {
                group: "Business",
                tabs: [
                  ["investors", "Investors"],
                  ["earnings", "Earnings"],
                  ["agent", "Agent Access"],
                  ["ipshield", "IP Protection"],
                ],
              },
            ] as const
          ).map(({ group, tabs }) => (
            <div key={group}>
              <div
                style={{
                  fontSize: 9.5,
                  fontWeight: 700,
                  letterSpacing: ".14em",
                  textTransform: "uppercase",
                  color: "rgba(255,255,255,0.4)",
                  marginBottom: 5,
                  paddingLeft: 4,
                }}
              >
                {group}
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 2,
                  background: "rgba(0,0,0,0.2)",
                  borderRadius: 8,
                  padding: 3,
                }}
              >
                {tabs.map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setTab(key)}
                    style={{
                      background:
                        tab === key ? "rgba(255,255,255,0.18)" : "transparent",
                      border: "none",
                      color: tab === key ? "#fff" : "rgba(255,255,255,0.55)",
                      borderRadius: 6,
                      padding: "4px 12px",
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: "pointer",
                      letterSpacing: ".02em",
                      whiteSpace: "nowrap",
                      transition: "all .15s",
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "36px 24px" }}>
        {tab === "traffic" && (
          <TrafficPanel
            analytics={analytics}
            loading={loadingAnalytics}
            onSendDigest={sendAnalyticsDigest}
            digestSending={digestSending}
            digestMsg={digestMsg}
            includeBots={includeBots}
            onToggleBots={(v) => {
              setIncludeBots(v);
              setAnalytics(null);
            }}
          />
        )}

        {tab === "stories" && (
          <div>
            <div style={{ marginBottom: 18 }}>
              <div
                style={{
                  fontSize: 20,
                  fontWeight: 700,
                  color: "#1a0505",
                  marginBottom: 4,
                }}
              >
                Sleep Stories
              </div>
              <div style={{ fontSize: 13, color: "#888" }}>
                Reader-submitted PACE stories for the Stanford Lifestyle
                Medicine newsletter.
              </div>
            </div>
            <a
              href="/stories"
              style={{
                display: "inline-block",
                background: "#8B1A1A",
                color: "#fff",
                textDecoration: "none",
                borderRadius: 8,
                padding: "10px 18px",
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              Open Stories editor →
            </a>
            <div style={{ marginTop: 14, fontSize: 12, color: "#888" }}>
              Admins are signed in automatically. Amy &amp; other editors use
              the magic-link page at{" "}
              <a href="/stories-login" style={{ color: "#8B1A1A" }}>
                /stories-login
              </a>
              .
            </div>
            <EditorAllowlistPanel />
          </div>
        )}

        {tab === "investors" && <InvestorsPanel />}

        {tab === "audit" && <AuditPanel />}

        {tab === "advice" && <AdvicePanel />}

        {tab === "doorway" && <DoorwayPanel />}

        {tab === "email" && (
          <>
            {/* Manual email jobs */}
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
                marginBottom: 16,
              }}
            >
              {(
                [
                  "admin/send-morning-emails",
                  "admin/send-weekly-portraits",
                  "admin/send-nudge-emails",
                ] as const
              ).map((ep) => {
                const labels: Record<string, string> = {
                  "admin/send-morning-emails": "▷ Send check-ins",
                  "admin/send-weekly-portraits": "▷ Send portraits",
                  "admin/send-nudge-emails": "▷ Send nudges",
                };
                const status = jobStatus[ep];
                return (
                  <button
                    key={ep}
                    onClick={() => triggerJob(ep, labels[ep])}
                    disabled={!!status}
                    style={{
                      background: "#fff",
                      border: "1px solid #e0d4d4",
                      color: status ? "#b9a8a8" : "#8B1A1A",
                      borderRadius: 8,
                      padding: "6px 14px",
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: status ? "default" : "pointer",
                      minWidth: 120,
                    }}
                  >
                    {status ?? labels[ep]}
                  </button>
                );
              })}
            </div>
            <EmailVolumePanel />
          </>
        )}

        {tab === "faculty" && <FacultyPanel />}

        {tab === "agent" && <AgentAccessPanel />}
        {tab === "ipshield" && <IpProtectionPanel />}

        {tab === "otl" && <OtlLoginsPanel />}

        {tab === "governance" && <GovernancePanel />}
        {tab === "ingestion" && <IngestionHealthPanel />}

        {tab === "earnings" && <EarningsPanel />}

        {tab === "votes" && <FormatVotesPanel />}

        {tab === "referral" && <ReferralStatsPanel />}

        {tab === "resources" && <PillarResourcesPanel />}

        {tab === "waitlist" && (
          <div>
            {/* ── Beta /apply A/B Test Results ── */}
            <div style={{ marginBottom: 32 }}>
              <div
                style={{
                  fontSize: 20,
                  fontWeight: 700,
                  color: "#1a0505",
                  marginBottom: 4,
                }}
              >
                Beta Pre-Registration — A/B Test
              </div>
              <div style={{ fontSize: 13, color: "#888", marginBottom: 20 }}>
                Variant A shows all seven pillars. Variant B focuses on sleep
                and the world-famous sleep expert. Assigned randomly 50/50 on
                the <code>/apply</code> page.
              </div>
              {betaAbStats === null ? (
                <div style={{ color: "#aaa", fontSize: 13 }}>
                  Loading A/B stats...
                </div>
              ) : betaAbStats.total === 0 ? (
                <div style={{ color: "#aaa", fontSize: 13 }}>
                  No beta registrations yet.
                </div>
              ) : (
                (() => {
                  const a = betaAbStats.byVariant["all-pillars"] ?? 0;
                  const s = betaAbStats.byVariant["sleep"] ?? 0;
                  const other = betaAbStats.total - a - s;
                  const pct = (n: number) =>
                    betaAbStats.total > 0
                      ? Math.round((n / betaAbStats.total) * 100)
                      : 0;
                  const leader = a > s ? "all-pillars" : s > a ? "sleep" : null;
                  return (
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 12,
                      }}
                    >
                      {leader && (
                        <div
                          style={{
                            fontSize: 12,
                            fontWeight: 700,
                            letterSpacing: ".1em",
                            textTransform: "uppercase",
                            color: "#8C1515",
                            marginBottom: 4,
                          }}
                        >
                          {leader === "sleep"
                            ? "Variant B (Sleep) is winning"
                            : "Variant A (All pillars) is winning"}
                        </div>
                      )}
                      {[
                        {
                          key: "all-pillars",
                          label: "Variant A",
                          desc: "All 7 pillars",
                          count: a,
                        },
                        {
                          key: "sleep",
                          label: "Variant B",
                          desc: "Sleep expert focus",
                          count: s,
                        },
                        ...(other > 0
                          ? [
                              {
                                key: "other",
                                label: "Other / Legacy",
                                desc: "No variant recorded",
                                count: other,
                              },
                            ]
                          : []),
                      ].map(({ key, label, desc, count }) => (
                        <div
                          key={key}
                          style={{
                            background: "#fff",
                            borderRadius: 12,
                            border: "1px solid #E8DDD0",
                            padding: "14px 18px",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "baseline",
                              marginBottom: 6,
                            }}
                          >
                            <div>
                              <span
                                style={{
                                  fontWeight: 700,
                                  color: "#1a0505",
                                  fontSize: 14,
                                }}
                              >
                                {label}
                              </span>
                              <span
                                style={{
                                  color: "#888",
                                  fontSize: 12,
                                  marginLeft: 8,
                                }}
                              >
                                {desc}
                              </span>
                            </div>
                            <div
                              style={{
                                fontWeight: 700,
                                fontSize: 18,
                                color: "#8C1515",
                              }}
                            >
                              {count}{" "}
                              <span
                                style={{
                                  fontSize: 12,
                                  color: "#aaa",
                                  fontWeight: 400,
                                }}
                              >
                                ({pct(count)}%)
                              </span>
                            </div>
                          </div>
                          <div
                            style={{
                              height: 6,
                              background: "#F4ECDD",
                              borderRadius: 4,
                              overflow: "hidden",
                            }}
                          >
                            <div
                              style={{
                                height: "100%",
                                width: `${pct(count)}%`,
                                background: "#8C1515",
                                borderRadius: 4,
                                transition: "width .4s",
                              }}
                            />
                          </div>
                        </div>
                      ))}
                      <div
                        style={{
                          fontSize: 12,
                          color: "#aaa",
                          textAlign: "right",
                          marginTop: 2,
                        }}
                      >
                        {betaAbStats.total} total{" "}
                        {betaAbStats.total === 1
                          ? "registration"
                          : "registrations"}
                      </div>
                    </div>
                  );
                })()
              )}
            </div>

            {/* ── Founding Member intent ── */}
            {betaAbStats && betaAbStats.total > 0 && (
              <div style={{ marginBottom: 28 }}>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: "#1a0505",
                    marginBottom: 12,
                  }}
                >
                  Founding Member intent
                </div>
                <div style={{ display: "flex", gap: 12 }}>
                  {[
                    {
                      label: "Founding Member ($12/mo)",
                      count: betaAbStats.foundingCount,
                      highlight: true,
                    },
                    {
                      label: "Notify only",
                      count: betaAbStats.notifyCount,
                      highlight: false,
                    },
                  ].map(({ label, count, highlight }) => (
                    <div
                      key={label}
                      style={{
                        flex: 1,
                        background: "#fff",
                        borderRadius: 12,
                        border: `1.5px solid ${highlight && count > 0 ? "#8C1515" : "#E8DDD0"}`,
                        padding: "14px 16px",
                      }}
                    >
                      <div
                        style={{
                          fontSize: 24,
                          fontWeight: 800,
                          color: highlight && count > 0 ? "#8C1515" : "#555",
                        }}
                      >
                        {count}
                      </div>
                      <div
                        style={{ fontSize: 12, color: "#888", marginTop: 2 }}
                      >
                        {label}
                      </div>
                    </div>
                  ))}
                </div>
                {betaAbStats.foundingCount > 0 && betaAbStats.total > 0 && (
                  <div
                    style={{
                      fontSize: 12,
                      color: "#8C1515",
                      marginTop: 8,
                      fontWeight: 600,
                    }}
                  >
                    {Math.round(
                      (betaAbStats.foundingCount / betaAbStats.total) * 100,
                    )}
                    % indicated founding-member intent
                  </div>
                )}
              </div>
            )}

            <div style={{ borderTop: "1px solid #E8DDD0", marginBottom: 24 }} />

            <div style={{ marginBottom: 24 }}>
              <div
                style={{
                  fontSize: 20,
                  fontWeight: 700,
                  color: "#1a0505",
                  marginBottom: 4,
                }}
              >
                Sleep Program Waitlist
              </div>
              <div style={{ fontSize: 13, color: "#888" }}>
                Everyone who reserved a spot for the $49/mo personal sleep
                program.
              </div>
            </div>
            {loadingWaitlist ? (
              <div style={{ color: "#aaa", padding: "48px 0" }}>Loading…</div>
            ) : !waitlist || waitlist.length === 0 ? (
              <div style={{ color: "#aaa", padding: "48px 0" }}>
                No signups yet — the modal appears automatically when someone
                asks for personal help, or via the "Want personal support?"
                button after any answer.
              </div>
            ) : (
              <div
                style={{
                  background: "#fff",
                  borderRadius: 14,
                  border: "1px solid #e8e0e0",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    padding: "12px 20px",
                    background: "#faf7f7",
                    borderBottom: "1px solid #f0e8e8",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: ".12em",
                      textTransform: "uppercase",
                      color: "#8B1A1A",
                    }}
                  >
                    {waitlist.length}{" "}
                    {waitlist.length === 1 ? "person" : "people"}
                  </span>
                  <a
                    href={`/api/admin/waitlist`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      fontSize: 11,
                      color: "#8B1A1A",
                      fontWeight: 600,
                      textDecoration: "none",
                    }}
                  >
                    Export JSON ↗
                  </a>
                </div>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: 13,
                  }}
                >
                  <thead>
                    <tr style={{ background: "#fafaf7" }}>
                      {["Name", "Email", "Source", "Signed up"].map((h) => (
                        <th
                          key={h}
                          style={{
                            padding: "10px 20px",
                            textAlign: "left",
                            color: "#888",
                            fontWeight: 600,
                            fontSize: 11,
                            letterSpacing: ".04em",
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {waitlist.map((w) => (
                      <tr key={w.id} style={{ borderTop: "1px solid #f5f0f0" }}>
                        <td
                          style={{
                            padding: "12px 20px",
                            fontWeight: 600,
                            color: "#1a0505",
                          }}
                        >
                          {w.name}
                        </td>
                        <td style={{ padding: "12px 20px", color: "#555" }}>
                          <a
                            href={`mailto:${w.email}`}
                            style={{ color: "#8B1A1A", textDecoration: "none" }}
                          >
                            {w.email}
                          </a>
                        </td>
                        <td style={{ padding: "12px 20px", color: "#888" }}>
                          {w.source}
                        </td>
                        <td
                          style={{
                            padding: "12px 20px",
                            color: "#888",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {new Date(w.created_at).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {tab === "phone" && (
          <div>
            <div style={{ marginBottom: 20 }}>
              <div
                style={{
                  fontSize: 20,
                  fontWeight: 700,
                  color: "#1a0505",
                  marginBottom: 4,
                }}
              >
                Text Subscribers
              </div>
              <div style={{ fontSize: 13, color: "#888" }}>
                Phone opt-ins captured on the Nightly sleep surface. Confirmed
                numbers are <strong>active</strong>; STOP replies become{" "}
                <strong>opted out</strong>.
              </div>
            </div>

            {/* Filters */}
            <div
              style={{
                display: "flex",
                gap: 10,
                marginBottom: 16,
                flexWrap: "wrap",
              }}
            >
              <select
                value={phoneProductFilter}
                onChange={(e) => {
                  setPhoneProductFilter(e.target.value);
                  setPhoneEntries(null);
                }}
                style={{
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: "1px solid #e0d6d6",
                  fontSize: 13,
                  background: "#fff",
                  color: "#1a0505",
                }}
              >
                <option value="">All products</option>
                <option value="nightly">Nightly</option>
              </select>
              <select
                value={phoneStatusFilter}
                onChange={(e) => {
                  setPhoneStatusFilter(e.target.value);
                  setPhoneEntries(null);
                }}
                style={{
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: "1px solid #e0d6d6",
                  fontSize: 13,
                  background: "#fff",
                  color: "#1a0505",
                }}
              >
                <option value="">All statuses</option>
                <option value="pending">Pending</option>
                <option value="active">Active</option>
                <option value="opted_out">Opted out</option>
              </select>
            </div>

            {loadingPhone ? (
              <div style={{ color: "#aaa", padding: "48px 0" }}>Loading…</div>
            ) : !phoneEntries || phoneEntries.length === 0 ? (
              <div style={{ color: "#aaa", padding: "48px 0" }}>
                No phone numbers captured yet for this filter.
              </div>
            ) : (
              <div
                style={{
                  background: "#fff",
                  borderRadius: 14,
                  border: "1px solid #e8e0e0",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    padding: "12px 20px",
                    background: "#faf7f7",
                    borderBottom: "1px solid #f0e8e8",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: ".12em",
                      textTransform: "uppercase",
                      color: "#8B1A1A",
                    }}
                  >
                    {phoneEntries.length}{" "}
                    {phoneEntries.length === 1 ? "number" : "numbers"}
                  </span>
                  <a
                    href={`/api/admin/phone-numbers.csv${(() => {
                      const q = new URLSearchParams();
                      if (phoneProductFilter)
                        q.set("product", phoneProductFilter);
                      if (phoneStatusFilter) q.set("status", phoneStatusFilter);
                      const s = q.toString();
                      return s ? `?${s}` : "";
                    })()}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      fontSize: 11,
                      color: "#8B1A1A",
                      fontWeight: 600,
                      textDecoration: "none",
                    }}
                  >
                    Export CSV ↗
                  </a>
                </div>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: 13,
                  }}
                >
                  <thead>
                    <tr style={{ background: "#fafaf7" }}>
                      {["Phone", "Product", "Status", "Source", "Captured"].map(
                        (h) => (
                          <th
                            key={h}
                            style={{
                              padding: "10px 20px",
                              textAlign: "left",
                              color: "#888",
                              fontWeight: 600,
                              fontSize: 11,
                              letterSpacing: ".04em",
                            }}
                          >
                            {h}
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {phoneEntries.map((p) => (
                      <tr key={p.id} style={{ borderTop: "1px solid #f5f0f0" }}>
                        <td
                          style={{
                            padding: "12px 20px",
                            fontWeight: 600,
                            color: "#1a0505",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {p.phone}
                        </td>
                        <td
                          style={{
                            padding: "12px 20px",
                            color: "#555",
                            textTransform: "capitalize",
                          }}
                        >
                          {p.product}
                        </td>
                        <td style={{ padding: "12px 20px" }}>
                          <span
                            style={{
                              fontSize: 11,
                              fontWeight: 700,
                              padding: "3px 9px",
                              borderRadius: 20,
                              background:
                                p.status === "active"
                                  ? "#e6f5e9"
                                  : p.status === "pending"
                                    ? "#fff5e6"
                                    : "#f5e6e6",
                              color:
                                p.status === "active"
                                  ? "#2e7d32"
                                  : p.status === "pending"
                                    ? "#9c6406"
                                    : "#a33",
                            }}
                          >
                            {p.status === "opted_out" ? "opted out" : p.status}
                          </span>
                        </td>
                        <td style={{ padding: "12px 20px", color: "#888" }}>
                          {p.source ?? "—"}
                        </td>
                        <td
                          style={{
                            padding: "12px 20px",
                            color: "#888",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {new Date(p.createdAt).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {tab === "users" && (
          <>
            {/* Data exports */}
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
                marginBottom: 16,
              }}
            >
              {(
                [
                  ["jsonl", "↓ JSONL (AI training)"],
                  ["csv", "↓ CSV"],
                ] as const
              ).map(([fmt, label]) => (
                <a
                  key={fmt}
                  href={`${API_BASE}/admin/export?format=${fmt}`}
                  download
                  style={{
                    background: "#fff",
                    border: "1px solid #e0d4d4",
                    color: "#8B1A1A",
                    borderRadius: 8,
                    padding: "6px 14px",
                    fontSize: 12,
                    fontWeight: 600,
                    textDecoration: "none",
                  }}
                >
                  {label}
                </a>
              ))}
            </div>

            {/* Overview metrics */}
            {loadingOverview ? (
              <div style={{ color: "#aaa", marginBottom: 32 }}>
                Loading metrics…
              </div>
            ) : (
              overview && (
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 12,
                    marginBottom: 36,
                  }}
                >
                  <MetricCard
                    label="Registered users"
                    value={overview.totalUsers}
                    sub="created an account — see Traffic for visitors"
                  />
                  <MetricCard
                    label="Questions asked"
                    value={overview.totalQuestions}
                  />
                  <MetricCard
                    label="Avg questions / user"
                    value={overview.avgQuestionsPerUser}
                  />
                  <MetricCard
                    label="Commitments"
                    value={overview.totalCommitments}
                  />
                  <MetricCard
                    label="Check-in rate"
                    value={checkinRate != null ? `${checkinRate}%` : "—"}
                    sub="of users who committed"
                  />
                  <MetricCard
                    label="7-day retention"
                    value={retention7d != null ? `${retention7d}%` : "—"}
                    sub={
                      overview.eligible7d > 0
                        ? `${overview.retained7d} of ${overview.eligible7d} eligible`
                        : "not enough data yet"
                    }
                  />
                </div>
              )
            )}

            {/* People directory */}
            <div
              style={{
                background: "#fff",
                borderRadius: 14,
                border: "1px solid #e8e0e0",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  padding: "20px 24px",
                  borderBottom: "1px solid #f0e8e8",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <div
                  style={{ fontSize: 15, fontWeight: 600, color: "#1a0505" }}
                >
                  People Directory{" "}
                  <span style={{ color: "#aaa", fontWeight: 400 }}>
                    ({peopleResp?.total ?? 0})
                  </span>
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    flexWrap: "wrap",
                    alignItems: "center",
                  }}
                >
                  <input
                    placeholder="Search name or email…"
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setExpandedUser(null);
                      setPeopleOffset(0);
                    }}
                    style={{
                      padding: "8px 14px",
                      borderRadius: 8,
                      border: "1px solid #e0d8d8",
                      fontSize: 13,
                      outline: "none",
                      width: 220,
                    }}
                  />
                  <select
                    value={sourceFilter}
                    onChange={(e) => {
                      setSourceFilter(e.target.value);
                      setExpandedUser(null);
                      setPeopleOffset(0);
                    }}
                    style={{
                      padding: "8px 10px",
                      borderRadius: 8,
                      border: "1px solid #e0d8d8",
                      fontSize: 13,
                      outline: "none",
                      background: "#fff",
                      color: "#444",
                    }}
                  >
                    <option value="">All sources</option>
                    {SOURCE_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {SOURCE_LABEL[s]}
                      </option>
                    ))}
                  </select>
                  <select
                    value={statusFilter}
                    onChange={(e) => {
                      setStatusFilter(e.target.value);
                      setExpandedUser(null);
                      setPeopleOffset(0);
                    }}
                    style={{
                      padding: "8px 10px",
                      borderRadius: 8,
                      border: "1px solid #e0d8d8",
                      fontSize: 13,
                      outline: "none",
                      background: "#fff",
                      color: "#444",
                    }}
                  >
                    <option value="">All statuses</option>
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  <a
                    href={`${API_BASE}/admin/people/export${peopleExportParams ? `?${peopleExportParams}` : ""}`}
                    download
                    style={{
                      background: "#8B1A1A",
                      color: "#fff",
                      borderRadius: 8,
                      padding: "8px 14px",
                      fontSize: 12,
                      fontWeight: 600,
                      textDecoration: "none",
                      whiteSpace: "nowrap",
                    }}
                  >
                    ↓ CSV
                  </a>
                </div>
              </div>

              {/* Per-source count chips (double as source filters) */}
              {peopleResp && (
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    flexWrap: "wrap",
                    padding: "12px 24px",
                    background: "#fdf8f8",
                    borderBottom: "1px solid #f0e8e8",
                  }}
                >
                  <CountChip
                    label="All people"
                    value={peopleResp.totalPeople}
                    active={!sourceFilter}
                    onClick={() => {
                      setSourceFilter("");
                      setExpandedUser(null);
                      setPeopleOffset(0);
                    }}
                  />
                  {SOURCE_OPTIONS.map((s) => (
                    <CountChip
                      key={s}
                      label={SOURCE_LABEL[s]}
                      value={peopleResp.counts?.[s] ?? 0}
                      active={sourceFilter === s}
                      onClick={() => {
                        setSourceFilter(sourceFilter === s ? "" : s);
                        setExpandedUser(null);
                        setPeopleOffset(0);
                      }}
                    />
                  ))}
                </div>
              )}

              {/* Table header */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1.4fr 2fr 2.6fr 120px",
                  padding: "10px 24px",
                  background: "#fdf8f8",
                  borderBottom: "1px solid #f0e8e8",
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: ".08em",
                  textTransform: "uppercase",
                  color: "#999",
                }}
              >
                <span>Name</span>
                <span>Email</span>
                <span>Sources</span>
                <span>First seen</span>
              </div>

              {loadingPeople && !peopleResp ? (
                <div
                  style={{ padding: "32px 24px", color: "#aaa", fontSize: 14 }}
                >
                  Loading…
                </div>
              ) : !peopleResp || peopleResp.people.length === 0 ? (
                <div
                  style={{ padding: "32px 24px", color: "#bbb", fontSize: 14 }}
                >
                  No people match.
                </div>
              ) : (
                peopleResp.people.map((p) => {
                  const expandable = p.palonurUserId != null;
                  const isOpen = expandable && expandedUser === p.palonurUserId;
                  return (
                    <div key={p.email}>
                      <div
                        onClick={() => {
                          if (!expandable) return;
                          setExpandedUser(isOpen ? null : p.palonurUserId);
                        }}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "1.4fr 2fr 2.6fr 120px",
                          padding: "14px 24px",
                          cursor: expandable ? "pointer" : "default",
                          borderBottom: "1px solid #f8f0f0",
                          background: isOpen ? "#fdf0f0" : "#fff",
                          transition: "background .1s",
                          alignItems: "center",
                        }}
                      >
                        <span
                          style={{
                            fontSize: 14,
                            fontWeight: 600,
                            color: "#1a0505",
                          }}
                        >
                          {p.name ?? "—"}
                          {expandable && (
                            <span
                              style={{
                                marginLeft: 6,
                                fontSize: 11,
                                color: "#bbb",
                                fontWeight: 400,
                              }}
                            >
                              {isOpen ? "▾" : "▸"}
                            </span>
                          )}
                        </span>
                        <span
                          style={{
                            fontSize: 13,
                            color: "#666",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {p.email}
                        </span>
                        <span
                          style={{ display: "flex", flexWrap: "wrap", gap: 6 }}
                        >
                          {p.sources.map((s, i) => (
                            <SourceBadge key={i} source={s} />
                          ))}
                        </span>
                        <span style={{ fontSize: 12, color: "#888" }}>
                          {fmt(p.createdAt)}
                        </span>
                      </div>

                      {/* Expanded consumer-journey detail (preserved drill-down) */}
                      {isOpen && (
                        <div
                          style={{
                            background: "#fdf8f8",
                            padding: "28px 32px",
                            borderBottom: "2px solid rgba(139,26,26,.1)",
                          }}
                        >
                          {loadingDetail ? (
                            <div style={{ color: "#aaa" }}>Loading…</div>
                          ) : (
                            userDetail && (
                              <div
                                style={{
                                  display: "grid",
                                  gridTemplateColumns: "1fr 1fr",
                                  gap: 32,
                                }}
                              >
                                {/* Questions */}
                                <div style={{ gridColumn: "1 / -1" }}>
                                  <Section
                                    title={`Questions (${userDetail.questions.length})`}
                                  >
                                    {userDetail.questions.length === 0 ? (
                                      <div
                                        style={{ color: "#bbb", fontSize: 13 }}
                                      >
                                        None yet.
                                      </div>
                                    ) : (
                                      userDetail.questions.map((q) => (
                                        <div
                                          key={q.id}
                                          style={{
                                            padding: "14px 16px",
                                            background: "#fff",
                                            borderRadius: 10,
                                            marginBottom: 10,
                                            border: "1px solid #f0e8e8",
                                          }}
                                        >
                                          <div
                                            style={{
                                              fontSize: 11,
                                              color: "#aaa",
                                              marginBottom: 6,
                                            }}
                                          >
                                            {fmtTime(q.created_at)}
                                            {q.article_url && (
                                              <a
                                                href={q.article_url}
                                                target="_blank"
                                                rel="noreferrer"
                                                style={{
                                                  marginLeft: 10,
                                                  color: "#8B1A1A",
                                                  textDecoration: "none",
                                                }}
                                              >
                                                Source →
                                              </a>
                                            )}
                                          </div>
                                          <div
                                            style={{
                                              fontSize: 14,
                                              fontWeight: 600,
                                              color: "#1a0505",
                                              marginBottom: 6,
                                            }}
                                          >
                                            {q.original_question}
                                          </div>
                                          {q.clarify_question && (
                                            <div
                                              style={{
                                                fontSize: 13,
                                                color: "#666",
                                                marginBottom: 4,
                                                fontStyle: "italic",
                                              }}
                                            >
                                              Clarify: {q.clarify_question} →{" "}
                                              {q.clarify_answer}
                                            </div>
                                          )}
                                          <div
                                            style={{
                                              fontSize: 13,
                                              color: "#444",
                                              lineHeight: 1.55,
                                              maxHeight: 120,
                                              overflow: "hidden",
                                              WebkitMaskImage:
                                                "linear-gradient(to bottom, black 70%, transparent)",
                                            }}
                                          >
                                            {q.ai_answer}
                                          </div>
                                        </div>
                                      ))
                                    )}
                                  </Section>
                                </div>

                                {/* Sleep logs */}
                                <div>
                                  <Section
                                    title={`Sleep logs (${userDetail.sleepLogs.length})`}
                                  >
                                    {userDetail.sleepLogs.length === 0 ? (
                                      <div
                                        style={{ color: "#bbb", fontSize: 13 }}
                                      >
                                        None yet.
                                      </div>
                                    ) : (
                                      userDetail.sleepLogs.map((sl) => (
                                        <div
                                          key={sl.id}
                                          style={{
                                            display: "flex",
                                            alignItems: "center",
                                            gap: 12,
                                            padding: "10px 14px",
                                            background: "#fff",
                                            borderRadius: 8,
                                            marginBottom: 8,
                                            border: "1px solid #f0e8e8",
                                          }}
                                        >
                                          <div
                                            style={{
                                              width: 36,
                                              height: 36,
                                              borderRadius: 8,
                                              background: "#8B1A1A",
                                              display: "flex",
                                              alignItems: "center",
                                              justifyContent: "center",
                                              color: "#fff",
                                              fontWeight: 700,
                                              fontSize: 16,
                                              flexShrink: 0,
                                            }}
                                          >
                                            {sl.quality}
                                          </div>
                                          <div>
                                            <div
                                              style={{
                                                fontSize: 13,
                                                fontWeight: 600,
                                                color: "#333",
                                              }}
                                            >
                                              {QUALITY_LABEL[sl.quality]} —{" "}
                                              {fmt(sl.log_date)}
                                            </div>
                                            {sl.note && (
                                              <div
                                                style={{
                                                  fontSize: 12,
                                                  color: "#888",
                                                  marginTop: 2,
                                                }}
                                              >
                                                {sl.note}
                                              </div>
                                            )}
                                          </div>
                                        </div>
                                      ))
                                    )}
                                  </Section>
                                </div>

                                {/* Commitments + check-ins */}
                                <div>
                                  <Section
                                    title={`Commitments (${userDetail.commitments.length})`}
                                  >
                                    {userDetail.commitments.length === 0 ? (
                                      <div
                                        style={{ color: "#bbb", fontSize: 13 }}
                                      >
                                        None yet.
                                      </div>
                                    ) : (
                                      userDetail.commitments.map((c) => {
                                        const cCheckins =
                                          userDetail.checkins.filter(
                                            (ck) => ck.commitment_id === c.id,
                                          );
                                        const didCount = cCheckins.filter(
                                          (ck) => ck.did_it,
                                        ).length;
                                        return (
                                          <div
                                            key={c.id}
                                            style={{
                                              padding: "12px 14px",
                                              background: "#fff",
                                              borderRadius: 10,
                                              marginBottom: 10,
                                              border: "1px solid #f0e8e8",
                                            }}
                                          >
                                            <div
                                              style={{
                                                fontSize: 11,
                                                color: "#aaa",
                                                marginBottom: 4,
                                              }}
                                            >
                                              {fmtTime(c.created_at)}
                                            </div>
                                            <div
                                              style={{
                                                fontSize: 13,
                                                fontWeight: 600,
                                                color: "#1a0505",
                                                marginBottom: 6,
                                              }}
                                            >
                                              {c.action_text}
                                            </div>
                                            {c.sleep_question && (
                                              <div
                                                style={{
                                                  fontSize: 12,
                                                  color: "#888",
                                                  marginBottom: 8,
                                                  fontStyle: "italic",
                                                }}
                                              >
                                                From: "{c.sleep_question}"
                                              </div>
                                            )}
                                            {cCheckins.length > 0 && (
                                              <div>
                                                <div
                                                  style={{
                                                    display: "flex",
                                                    gap: 4,
                                                    flexWrap: "wrap",
                                                  }}
                                                >
                                                  {cCheckins.map((ck) => (
                                                    <div
                                                      key={ck.id}
                                                      style={{
                                                        padding: "3px 8px",
                                                        borderRadius: 6,
                                                        fontSize: 11,
                                                        fontWeight: 600,
                                                        background: ck.did_it
                                                          ? "rgba(139,26,26,0.08)"
                                                          : "rgba(0,0,0,0.04)",
                                                        color: ck.did_it
                                                          ? "#8B1A1A"
                                                          : "#aaa",
                                                      }}
                                                    >
                                                      {ck.did_it ? "✓" : "✗"}{" "}
                                                      {fmt(ck.checkin_date)}
                                                    </div>
                                                  ))}
                                                </div>
                                                <div
                                                  style={{
                                                    fontSize: 11,
                                                    color: "#888",
                                                    marginTop: 6,
                                                  }}
                                                >
                                                  {didCount} of{" "}
                                                  {cCheckins.length} nights done
                                                </div>
                                              </div>
                                            )}
                                          </div>
                                        );
                                      })
                                    )}
                                  </Section>
                                </div>
                              </div>
                            )
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}

              {/* Pagination */}
              {peopleResp && peopleResp.total > PEOPLE_LIMIT && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "14px 24px",
                    borderTop: "1px solid #f0e8e8",
                    fontSize: 13,
                    color: "#888",
                  }}
                >
                  <button
                    disabled={peopleOffset === 0}
                    onClick={() => {
                      setExpandedUser(null);
                      setPeopleOffset(Math.max(0, peopleOffset - PEOPLE_LIMIT));
                    }}
                    style={{
                      background: peopleOffset === 0 ? "#f4eeee" : "#fff",
                      border: "1px solid #e0d8d8",
                      borderRadius: 8,
                      padding: "6px 14px",
                      fontSize: 12,
                      color: peopleOffset === 0 ? "#ccc" : "#8B1A1A",
                      cursor: peopleOffset === 0 ? "default" : "pointer",
                      fontWeight: 600,
                    }}
                  >
                    ← Prev
                  </button>
                  <span>
                    {peopleOffset + 1}–
                    {Math.min(peopleOffset + PEOPLE_LIMIT, peopleResp.total)} of{" "}
                    {peopleResp.total}
                  </span>
                  <button
                    disabled={peopleOffset + PEOPLE_LIMIT >= peopleResp.total}
                    onClick={() => {
                      setExpandedUser(null);
                      setPeopleOffset(peopleOffset + PEOPLE_LIMIT);
                    }}
                    style={{
                      background:
                        peopleOffset + PEOPLE_LIMIT >= peopleResp.total
                          ? "#f4eeee"
                          : "#fff",
                      border: "1px solid #e0d8d8",
                      borderRadius: 8,
                      padding: "6px 14px",
                      fontSize: 12,
                      color:
                        peopleOffset + PEOPLE_LIMIT >= peopleResp.total
                          ? "#ccc"
                          : "#8B1A1A",
                      cursor:
                        peopleOffset + PEOPLE_LIMIT >= peopleResp.total
                          ? "default"
                          : "pointer",
                      fontWeight: 600,
                    }}
                  >
                    Next →
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
