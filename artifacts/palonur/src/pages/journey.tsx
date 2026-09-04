import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { SLMBrand } from "../components/SLMBrand";

const API_BASE = "/api";
const USER_ID_KEY = "palonur_user_id";
const USER_NAME_KEY = "palonur_user_name";

interface SleepLog {
  log_date: string;
  quality: number;
  note: string | null;
}

interface JourneyData {
  user: { id: number; first_name: string; created_at: string };
  logs: SleepLog[];
}

interface JourneyStats {
  totalNights: number;
  avgQuality: number | null;
  trend: {
    direction: "up" | "down" | "steady";
    recentAvg: number;
    earlierAvg: number;
  } | null;
}

interface JourneyHistory {
  logs: SleepLog[];
  stats: JourneyStats;
}

interface Commitment {
  id: number;
  action_text: string;
  sleep_question: string | null;
  created_at: string;
  followupOutcome: "helped" | "no_change" | "not_tried" | null;
  followupOutcomeAt: string | null;
}

interface Checkin {
  checkin_date: string;
  did_it: boolean;
}

interface WeeklyReflectionNote {
  answer: string;
  finding: string | null;
  citation: string;
  paper: string | null;
  sourceUrl: string | null;
  pillarName: string | null;
}

interface WeeklyReflection {
  weekStart: string;
  nights: { count: number; avgQuality: number | null };
  commitments: Array<{
    id: number;
    actionText: string;
    didCount: number;
    totalCheckins: number;
  }>;
  hasData: boolean;
  emptyPrompt: string | null;
  groundedNote: WeeklyReflectionNote | null;
}

const QUALITY_LABELS: Record<number, string> = {
  1: "Difficult",
  2: "Restless",
  3: "Fair",
  4: "Good",
  5: "Excellent",
};

const QUALITY_COLORS: Record<number, string> = {
  1: "#9a9a9a",
  2: "#7B8DB0",
  3: "#C8A060",
  4: "#7B9E72",
  5: "#8B1A1A",
};

// User-local YYYY-MM-DD. We must NOT use toISOString() here — that returns the
// UTC date, so a user logging at 9pm PST (= 04:00 UTC next day) would have
// log_date stored as "tomorrow" and the N1/N2/etc. cards (which walk forward
// from created_at) would never match it. Using local-time getters keeps the
// "sleep night" notion aligned with the user's wall clock.
function localDateStr(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Which experiment the user chose to lead tonight. Persisted per-day both
// server-side (so the pick follows the user across devices, via
// POST /tonights-focus + the active-commitment GET) and in localStorage (the
// offline fallback). Scoped per day so the choice resets to the default
// (newest leads) each night, keeping the calm one-thing-leads hierarchy.
const FOCUS_KEY = "palonur_tonights_focus";

function readFocusId(today: string): number | null {
  try {
    const raw = localStorage.getItem(FOCUS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.date === today && typeof parsed.commitmentId === "number") {
      return parsed.commitmentId;
    }
  } catch { /* noop */ }
  return null;
}

function MoonIcon({ filled, quality }: { filled: boolean; quality?: number }) {
  const color = quality ? QUALITY_COLORS[quality] : "rgba(139,26,26,0.18)";
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill={filled ? color : "none"}
      stroke={filled ? color : "rgba(139,26,26,0.35)"} strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

// Parse a "YYYY-MM-DD" log_date into a local Date (avoids the UTC shift that
// new Date("YYYY-MM-DD") applies, which can roll a night back a calendar day).
function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.slice(0, 10).split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

const TREND_COPY: Record<"up" | "down" | "steady", string> = {
  up: "Trending up",
  down: "Easing down",
  steady: "Holding steady",
};
const TREND_COLOR: Record<"up" | "down" | "steady", string> = {
  up: "#7B9E72",
  down: "#7B8DB0",
  steady: "#a98c7a",
};

function TrendArrow({ direction }: { direction: "up" | "down" | "steady" }) {
  const color = TREND_COLOR[direction];
  const d =
    direction === "up" ? "M5 12l7-7 7 7" :
    direction === "down" ? "M5 12l7 7 7-7" :
    "M5 12h14";
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color}
      strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

// The lifetime "so far" view. Deliberately restrained: one focal idea at a time,
// generous whitespace, the same quality-color language as the weekly grid.
function HistoryView({
  history, loading, error, onBack,
}: {
  history: JourneyHistory | null;
  loading: boolean;
  error: boolean;
  onBack: () => void;
}) {
  // Group nights by month for a calm, scannable timeline. logs arrive newest
  // first, so both the month groups and the nights within them stay newest-first.
  const groups: Array<{ key: string; label: string; logs: SleepLog[] }> = [];
  if (history) {
    for (const log of history.logs) {
      const key = log.log_date.slice(0, 7);
      let g = groups[groups.length - 1];
      if (!g || g.key !== key) {
        g = {
          key,
          label: parseLocalDate(log.log_date).toLocaleDateString(undefined, {
            month: "long", year: "numeric",
          }),
          logs: [],
        };
        groups.push(g);
      }
      g.logs.push(log);
    }
  }

  // Per-month average quality, rounded to the nearest band so the summary can
  // borrow the same QUALITY_COLORS language as the nights below it. Kept local
  // and dependency-free — just the count and average for each month group.
  function monthSummary(logs: SleepLog[]) {
    const avg = logs.reduce((sum, l) => sum + l.quality, 0) / logs.length;
    const band = Math.min(5, Math.max(1, Math.round(avg)));
    return { count: logs.length, avg, color: QUALITY_COLORS[band] };
  }

  const empty = !loading && !error && (!history || history.stats.totalNights === 0);

  return (
    <div>
      <button
        onClick={onBack}
        style={{
          background: "none", border: "none", padding: 0, cursor: "pointer",
          color: "#8B1A1A", fontSize: 13, fontWeight: 600, letterSpacing: ".02em",
          display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 28,
        }}
      >
        ← This week
      </button>

      <div style={{
        fontSize: "clamp(28px, 3.5vw, 38px)",
        fontWeight: 500, letterSpacing: "-0.02em", lineHeight: 1.2,
        fontFamily: "'Georgia', 'Times New Roman', serif",
        color: "#0f0505", marginBottom: 10,
      }}>
        Your journey so far
      </div>
      <div style={{ fontSize: 16, color: "#666", lineHeight: 1.5, marginBottom: 48 }}>
        Every night you've logged, gathered in one place.
      </div>

      {loading && (
        <div style={{ display: "flex", justifyContent: "center", padding: "48px 0" }}>
          <div style={{ width: 22, height: 22, borderRadius: "50%", border: "2px solid rgba(139,26,26,.15)", borderTopColor: "#8B1A1A", animation: "spin 0.8s linear infinite" }} />
        </div>
      )}

      {error && (
        <div style={{ fontSize: 15, color: "#888", lineHeight: 1.6, padding: "32px 0" }}>
          Couldn't load your full history just now. Please try again in a moment.
        </div>
      )}

      {empty && (
        <div style={{
          textAlign: "center", padding: "56px 24px",
          border: "1px solid rgba(139,26,26,.1)", borderRadius: 16,
          background: "#fff",
        }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
            <MoonIcon filled={false} />
          </div>
          <div style={{
            fontSize: 18, fontWeight: 500, color: "#1a0505", marginBottom: 8,
            fontFamily: "'Georgia', 'Times New Roman', serif",
          }}>
            Your story starts with one night
          </div>
          <div style={{ fontSize: 14, color: "#888", lineHeight: 1.6 }}>
            Log a night's sleep and it will appear here, building over time.
          </div>
        </div>
      )}

      {history && history.stats.totalNights > 0 && (
        <>
          {/* At-a-glance stats — three honest figures, lots of breathing room */}
          <div style={{
            display: "flex", gap: 40, flexWrap: "wrap",
            paddingBottom: 36, marginBottom: 40,
            borderBottom: "1px solid rgba(139,26,26,.08)",
          }}>
            <div>
              <div style={{ fontSize: 34, fontWeight: 700, color: "#8B1A1A", letterSpacing: "-0.02em", lineHeight: 1 }}>
                {history.stats.totalNights}
              </div>
              <div style={{ fontSize: 11, color: "#999", letterSpacing: ".08em", textTransform: "uppercase", marginTop: 8 }}>
                nights logged
              </div>
            </div>
            {history.stats.avgQuality != null && (
              <div>
                <div style={{ fontSize: 34, fontWeight: 700, color: "#8B1A1A", letterSpacing: "-0.02em", lineHeight: 1 }}>
                  {history.stats.avgQuality.toFixed(1)}
                </div>
                <div style={{ fontSize: 11, color: "#999", letterSpacing: ".08em", textTransform: "uppercase", marginTop: 8 }}>
                  avg quality
                </div>
              </div>
            )}
            {history.stats.trend && (
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, height: 34 }}>
                  <TrendArrow direction={history.stats.trend.direction} />
                  <span style={{ fontSize: 17, fontWeight: 600, color: TREND_COLOR[history.stats.trend.direction] }}>
                    {TREND_COPY[history.stats.trend.direction]}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: "#999", letterSpacing: ".08em", textTransform: "uppercase", marginTop: 8 }}>
                  recent {history.stats.trend.recentAvg.toFixed(1)} · earlier {history.stats.trend.earlierAvg.toFixed(1)}
                </div>
              </div>
            )}
          </div>

          {/* Timeline — every night, grouped by month */}
          {groups.map(group => {
            const summary = monthSummary(group.logs);
            return (
            <div key={group.key} style={{ marginBottom: 36 }}>
              <div style={{
                display: "flex", alignItems: "baseline", flexWrap: "wrap",
                gap: "8px 14px", marginBottom: 16,
              }}>
                <div style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: ".16em",
                  color: "#a98c7a", textTransform: "uppercase",
                }}>
                  {group.label}
                </div>
                <div style={{
                  display: "inline-flex", alignItems: "center", gap: 8,
                  fontSize: 12, color: "#999",
                }}>
                  <span>{summary.count} {summary.count === 1 ? "night" : "nights"}</span>
                  <span aria-hidden style={{ color: "rgba(139,26,26,.18)" }}>·</span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span style={{
                      width: 8, height: 8, borderRadius: "50%",
                      background: summary.color, flexShrink: 0,
                    }} />
                    <span style={{ fontWeight: 600, color: "#777" }}>
                      {summary.avg.toFixed(1)}
                    </span>
                    <span>avg</span>
                  </span>
                </div>
              </div>
              {group.logs.map(log => (
                <div key={log.log_date} style={{
                  display: "flex", alignItems: "flex-start", gap: 16,
                  padding: "14px 0",
                  borderTop: "1px solid rgba(139,26,26,.06)",
                }}>
                  <div style={{
                    width: 38, height: 38, borderRadius: 10, flexShrink: 0,
                    background: QUALITY_COLORS[log.quality],
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    <span style={{ fontSize: 16, fontWeight: 700, color: "#fff" }}>
                      {log.quality}
                    </span>
                  </div>
                  <div style={{ minWidth: 0, flex: 1, paddingTop: 1 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 15, fontWeight: 600, color: "#1a0505" }}>
                        {parseLocalDate(log.log_date).toLocaleDateString(undefined, {
                          weekday: "short", month: "short", day: "numeric",
                        })}
                      </span>
                      <span style={{ fontSize: 13, color: QUALITY_COLORS[log.quality], fontWeight: 600 }}>
                        {QUALITY_LABELS[log.quality]}
                      </span>
                    </div>
                    {log.note && (
                      <div style={{ fontSize: 14, color: "#777", lineHeight: 1.55, marginTop: 5 }}>
                        {log.note}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            );
          })}
        </>
      )}
    </div>
  );
}

export default function Journey() {
  const [, setLocation] = useLocation();
  const [data, setData] = useState<JourneyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [logging, setLogging] = useState(false);
  const [quality, setQuality] = useState(0);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [hoverQ, setHoverQ] = useState(0);

  // Each commitment carries its own checkin history + today's status, so the
  // journey page can render every active experiment instead of just the most
  // recent one. The `commitment` / `checkins` / `todayCheckin` legacy fields
  // from the API are ignored here in favor of the per-commitment array.
  type CommitmentWithCheckins = Commitment & {
    checkins: Checkin[];
    todayCheckin: { did_it: boolean } | null;
  };
  const [commitments, setCommitments] = useState<CommitmentWithCheckins[]>([]);
  const [checkingIn, setCheckingIn] = useState<{ id: number; choice: "yes" | "no" } | null>(null);
  const [showAllAlsoRunning, setShowAllAlsoRunning] = useState(false);
  const [focusId, setFocusId] = useState<number | null>(() => readFocusId(localDateStr()));

  const userId = localStorage.getItem(USER_ID_KEY);
  const userName = localStorage.getItem(USER_NAME_KEY);

  const [reflection, setReflection] = useState<WeeklyReflection | null>(null);

  // "So far" lifetime history — fetched lazily the first time the user opens it
  // so the default weekly view stays lean. `showHistory` switches the main
  // surface to the full-history view (one idea at a time, never both at once).
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<JourneyHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(false);

  const openHistory = useCallback(() => {
    setShowHistory(true);
    if (history || !userId) return;
    setHistoryLoading(true);
    setHistoryError(false);
    fetch(`${API_BASE}/journey/${userId}?range=all`)
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then((d: JourneyData & { stats?: JourneyStats }) => {
        setHistory({
          logs: d.logs ?? [],
          stats: d.stats ?? { totalNights: 0, avgQuality: null, trend: null },
        });
        setHistoryLoading(false);
      })
      .catch(() => { setHistoryError(true); setHistoryLoading(false); });
  }, [history, userId]);

  // Holds a commitmentId the user just picked locally while its POST is still
  // in flight. A background re-fetch (on tab focus/visibility) must not clobber
  // that pick with a stale server value before the write lands.
  const pendingFocusRef = useRef<number | null>(null);

  // True while a local sleep-log save is in flight. A background journey
  // re-fetch (on tab focus/visibility) checks this so it can't overwrite the
  // user's just-saved edit with a snapshot taken before the write landed.
  const savingRef = useRef(false);

  // Re-fetch the journey data (user + sleep logs, which drive the greeting,
  // progress counts, and 7-night grid). Called on first load and whenever the
  // tab regains focus/visibility so a night logged on another device shows up
  // live. Never toggles `loading` (that would flash the spinner) and skips the
  // re-apply while a local sleep-log save is in flight, so a background fetch
  // can't clobber the user's just-saved edit with a stale snapshot.
  const loadJourney = useCallback(() => {
    if (!userId) return;
    fetch(`${API_BASE}/journey/${userId}`)
      .then(r => r.json())
      .then(d => {
        if (savingRef.current) return;
        setData(d);
      })
      .catch(() => { /* silent — keep the data we already have */ });
  }, [userId]);

  // Re-fetch the active commitments + server-persisted focus. Called on first
  // load and whenever the tab regains focus/visibility, so a focus changed on
  // another device shows up live without a manual refresh.
  const loadActiveCommitment = useCallback(() => {
    if (!userId) return;
    fetch(`${API_BASE}/active-commitment/${userId}`)
      .then(r => r.json())
      .then(d => {
        setCommitments(d.commitments ?? []);
        // Don't overwrite an in-flight local pick — once its POST resolves the
        // next re-fetch will carry the server's value anyway.
        if (pendingFocusRef.current != null) return;
        // Server-persisted focus follows the user across devices. Apply it when
        // it's for today, and mirror it into localStorage as the offline cache.
        const sf = d.tonightsFocus;
        const today = localDateStr();
        if (sf && sf.date === today && typeof sf.commitmentId === "number") {
          setFocusId(sf.commitmentId);
          try {
            localStorage.setItem(
              FOCUS_KEY,
              JSON.stringify({ date: today, commitmentId: sf.commitmentId }),
            );
          } catch { /* noop */ }
        }
      })
      .catch(() => { /* silent */ });
  }, [userId]);

  useEffect(() => {
    if (!userId) { setLocation("/"); return; }
    fetch(`${API_BASE}/journey/${userId}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => { setError("Couldn't load your journey."); setLoading(false); });

    loadActiveCommitment();
  }, [userId, setLocation, loadActiveCommitment]);

  // Weekly coaching loop — the same grounded reflection the weekly email sends.
  // Fetched once on load; it's the heavier endpoint (governed RAG note cached
  // server-side per week), so it doesn't ride the focus/visibility re-fetch.
  useEffect(() => {
    if (!userId) return;
    fetch(`${API_BASE}/weekly-reflection/${userId}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d) setReflection(d); })
      .catch(() => { /* silent — the card just stays hidden */ });
  }, [userId]);

  // Live cross-device sync: re-fetch the active experiments AND the journey
  // data (sleep logs + progress) when this tab regains focus or becomes visible
  // again (e.g. the user logged a night or changed their pick on their phone
  // while this laptop tab sat in the background).
  useEffect(() => {
    if (!userId) return;
    const refetch = () => {
      loadActiveCommitment();
      loadJourney();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refetch();
    };
    window.addEventListener("focus", refetch);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", refetch);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [userId, loadActiveCommitment, loadJourney]);

  async function handleCheckin(commitmentId: number, didIt: boolean) {
    if (!userId) return;
    setCheckingIn({ id: commitmentId, choice: didIt ? "yes" : "no" });
    try {
      await fetch(`${API_BASE}/checkin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: parseInt(userId, 10),
          commitment_id: commitmentId,
          did_it: didIt,
        }),
      });
      const today = localDateStr();
      setCommitments(prev => prev.map(c => {
        if (c.id !== commitmentId) return c;
        const filtered = c.checkins.filter(ck => ck.checkin_date.slice(0, 10) !== today);
        return {
          ...c,
          checkins: [...filtered, { checkin_date: today, did_it: didIt }],
          todayCheckin: { did_it: didIt },
        };
      }));
    } catch { /* noop */ }
    setCheckingIn(null);
  }

  function setTonightsFocus(commitmentId: number) {
    setFocusId(commitmentId);
    // Mark the pick as in-flight so a background re-fetch doesn't revert it.
    pendingFocusRef.current = commitmentId;
    const today = localDateStr();
    try {
      localStorage.setItem(
        FOCUS_KEY,
        JSON.stringify({ date: today, commitmentId }),
      );
    } catch { /* noop */ }
    // Persist server-side so the pick follows the user across devices. The
    // localStorage write above remains the offline fallback if this fails.
    if (userId) {
      fetch(`${API_BASE}/tonights-focus`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: parseInt(userId, 10),
          commitment_id: commitmentId,
          focus_date: today,
        }),
      })
        .catch(() => { /* offline — localStorage still holds the pick */ })
        .finally(() => {
          // Clear the in-flight guard only for this pick. If the user picked
          // again in the meantime, leave that newer pick's guard intact.
          if (pendingFocusRef.current === commitmentId) {
            pendingFocusRef.current = null;
          }
        });
    } else {
      pendingFocusRef.current = null;
    }
  }

  // Order experiments so the user's chosen focus leads. Default (no choice, or
  // a stale id that no longer matches an active experiment) keeps the API order
  // where the newest leads.
  const orderedCommitments = (() => {
    if (focusId == null) return commitments;
    const idx = commitments.findIndex(c => c.id === focusId);
    if (idx <= 0) return commitments;
    const copy = [...commitments];
    const [pick] = copy.splice(idx, 1);
    return [pick, ...copy];
  })();
  const newestLeads =
    orderedCommitments.length === 0 ||
    orderedCommitments[0]?.id === commitments[0]?.id;

  const today = localDateStr();
  const todayLog = data?.logs.find(l => l.log_date.slice(0, 10) === today);

  // Rolling 7-night window ending today (i=0 → 6 days ago, i=6 → today), so
  // "today" is always in the grid and a freshly logged night always shows and
  // counts. Mirrors the server-side "This week" reflection window
  // (CURRENT_DATE - 6 .. CURRENT_DATE). The grid uses the viewer's LOCAL date
  // (what they perceive as "tonight"); the server uses DB/UTC CURRENT_DATE, so
  // the two can differ by a day right at the UTC midnight boundary.
  const todayDate = new Date();
  const nights = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(todayDate);
    d.setDate(d.getDate() - (6 - i));
    const dateStr = localDateStr(d);
    const log = data?.logs.find(l => l.log_date.slice(0, 10) === dateStr);
    const isPast = dateStr <= today;
    const label = d.toLocaleDateString(undefined, { weekday: "short" });
    return { dateStr, log, isPast, isToday: dateStr === today, index: i, label };
  });

  const loggedCount = nights.filter(n => n.log).length;
  const avgQuality = loggedCount > 0
    ? (nights.filter(n => n.log).reduce((s, n) => s + (n.log?.quality ?? 0), 0) / loggedCount).toFixed(1)
    : null;

  async function saveLog() {
    if (!quality || !userId) return;
    setSaving(true);
    savingRef.current = true;
    try {
      await fetch(`${API_BASE}/sleep-log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: parseInt(userId), quality, note, log_date: today }),
      });
      setSaved(true);
      setLogging(false);
      // Drop the cached lifetime history so reopening "so far" re-fetches and
      // reflects the night just logged (counts, avg, trend) instead of a stale
      // snapshot taken before this save.
      setHistory(null);
      const r = await fetch(`${API_BASE}/journey/${userId}`);
      setData(await r.json());
    } catch { /* noop */ }
    savingRef.current = false;
    setSaving(false);
  }

  if (loading) return (
    <div style={{
      minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "#fafaf7", fontFamily: "-apple-system, system-ui, sans-serif",
    }}>
      <div style={{ width: 24, height: 24, borderRadius: "50%", border: "2px solid rgba(139,26,26,.15)", borderTopColor: "#8B1A1A", animation: "spin 0.8s linear infinite" }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );

  if (error) return (
    <div style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", background: "#fafaf7" }}>
      <div style={{ color: "#888", fontSize: 16 }}>{error}</div>
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
          .j-header  { padding: 12px 16px !important; }
          .j-brand   { display: none !important; }
          .j-settings-label { display: none !important; }
          .j-main    { padding: 32px 16px 64px !important; }
          .j-nightgrid { gap: 5px !important; }
        }
      `}</style>

      <header className="j-header" style={{
        padding: "16px 28px",
        display: "grid",
        gridTemplateColumns: "1fr auto 1fr",
        alignItems: "center",
        borderBottom: "1px solid rgba(139,26,26,.08)",
      }}>
        <a href={import.meta.env.BASE_URL} style={{
          textDecoration: "none", color: "#8B1A1A",
          fontSize: 13, fontWeight: 600, letterSpacing: ".02em",
        }}>← palonur</a>
        <span className="j-brand"><SLMBrand /></span>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <a href={`${import.meta.env.BASE_URL}settings`} style={{
            textDecoration: "none", color: "#888",
            fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", gap: 5,
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
            <span className="j-settings-label">Settings</span>
          </a>
        </div>
      </header>

      <main className="j-main" style={{ maxWidth: 600, margin: "0 auto", padding: "48px 24px 80px" }}>

        {showHistory ? (
          <HistoryView
            history={history}
            loading={historyLoading}
            error={historyError}
            onBack={() => setShowHistory(false)}
          />
        ) : (
        <>

        {/* Greeting */}
        <div style={{ marginBottom: 48 }}>
          <div style={{
            fontSize: "clamp(28px, 3.5vw, 38px)",
            fontWeight: 500, letterSpacing: "-0.02em", lineHeight: 1.2,
            fontFamily: "'Georgia', 'Times New Roman', serif",
            color: "#0f0505", marginBottom: 10,
          }}>
            {userName ? `Good to see you, ${userName}.` : "Your sleep journey."}
          </div>
          <div style={{ fontSize: 16, color: "#666", lineHeight: 1.5 }}>
            {loggedCount === 0
              ? "Your 7-night sleep journey begins tonight."
              : loggedCount < 7
              ? `${loggedCount} of 7 nights logged. You're building something real.`
              : "You completed your 7-night journey. That's remarkable."}
          </div>
        </div>

        {/* Weekly coaching loop — ties this week's experiments + check-ins to
            the nights logged, with a grounded, cited reflection (governed RAG).
            Empty-data users see a gentle prompt, never a fabricated summary. */}
        {reflection && (
          <div style={{
            border: "1px solid rgba(139,26,26,.14)",
            borderRadius: 16, padding: "24px 26px", marginBottom: 32,
            background: "#fff",
          }}>
            <div style={{
              fontSize: 10, fontWeight: 700, letterSpacing: ".16em",
              color: "#8B1A1A", textTransform: "uppercase", marginBottom: 14,
            }}>
              This week
            </div>

            {!reflection.hasData ? (
              <div style={{ fontSize: 15, color: "#555", lineHeight: 1.6 }}>
                {reflection.emptyPrompt}
              </div>
            ) : (
              <>
                <div style={{ display: "flex", gap: 24, marginBottom: reflection.groundedNote || reflection.commitments.length ? 20 : 0 }}>
                  <div>
                    <div style={{ fontSize: 26, fontWeight: 700, color: "#8B1A1A", lineHeight: 1 }}>
                      {reflection.nights.avgQuality != null ? reflection.nights.avgQuality.toFixed(1) : "–"}
                    </div>
                    <div style={{ fontSize: 10, color: "#999", letterSpacing: ".06em", textTransform: "uppercase", marginTop: 4 }}>
                      sleep avg
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 26, fontWeight: 700, color: "#8B1A1A", lineHeight: 1 }}>
                      {reflection.nights.count}
                    </div>
                    <div style={{ fontSize: 10, color: "#999", letterSpacing: ".06em", textTransform: "uppercase", marginTop: 4 }}>
                      nights logged
                    </div>
                  </div>
                </div>

                {reflection.commitments.slice(0, 3).map((c) => (
                  <div key={c.id} style={{
                    fontSize: 13, color: "#666", lineHeight: 1.5,
                    paddingLeft: 12, borderLeft: "2px solid rgba(139,26,26,.2)",
                    marginBottom: 10,
                  }}>
                    <span style={{ color: "#1a0505", fontWeight: 500 }}>{c.actionText}</span>
                    {" — "}{c.didCount} of {c.totalCheckins} check-ins
                  </div>
                ))}

                {reflection.groundedNote && (
                  <div style={{
                    marginTop: 20, paddingTop: 20,
                    borderTop: "1px solid rgba(139,26,26,.1)",
                  }}>
                    <div style={{
                      fontSize: 10, fontWeight: 700, letterSpacing: ".12em",
                      color: "#8B1A1A", textTransform: "uppercase", marginBottom: 10,
                    }}>
                      Grounded in Stanford research
                    </div>
                    <div style={{ fontSize: 16, color: "#1a0505", lineHeight: 1.6, marginBottom: reflection.groundedNote.finding ? 10 : 12 }}>
                      {reflection.groundedNote.answer}
                    </div>
                    {reflection.groundedNote.finding && (
                      <div style={{ fontSize: 14, color: "#555", lineHeight: 1.6, marginBottom: 12 }}>
                        {reflection.groundedNote.finding}
                      </div>
                    )}
                    <div style={{ fontSize: 12, color: "#999", lineHeight: 1.5 }}>
                      {reflection.groundedNote.sourceUrl ? (
                        <a href={reflection.groundedNote.sourceUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#8B1A1A", textDecoration: "none" }}>
                          {reflection.groundedNote.citation}
                        </a>
                      ) : reflection.groundedNote.citation}
                      {reflection.groundedNote.paper ? ` · ${reflection.groundedNote.paper.replace(/^["'\u201C\u201D]+|["'\u201C\u201D]+$/g, "")}` : ""}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Tonight's focus — one prominent primary experiment (newest by
            default, or whichever the user pinned for today) */}
        {orderedCommitments.length > 0 && (() => {
          const c = orderedCommitments[0];
          const didCount = c.checkins.filter(ck => ck.did_it).length;
          const totalCheckins = c.checkins.length;
          const isMine = checkingIn?.id === c.id;
          // Per-card lockout: only the card whose check-in is in flight is
          // disabled. A slow request for one experiment must not freeze the
          // user's ability to log other experiments on the same night.
          const disabled = isMine;
          const multiple = commitments.length > 1;
          return (
            <div key={c.id} style={{
              background: "#8B1A1A",
              borderRadius: 16, padding: "24px 28px",
              marginBottom: multiple ? 28 : 20,
              boxShadow: "0 8px 28px rgba(139,26,26,.16)",
            }}>
              <div style={{
                display: "flex", justifyContent: "space-between", alignItems: "baseline",
                marginBottom: 8,
              }}>
                <div style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: ".16em",
                  color: "rgba(255,255,255,0.6)", textTransform: "uppercase",
                }}>
                  {multiple ? "Tonight's focus" : "Your experiment"}
                </div>
                {multiple && (
                  <div style={{
                    fontSize: 10, fontWeight: 500, letterSpacing: ".08em",
                    color: "rgba(255,255,255,0.45)", textTransform: "uppercase",
                  }}>
                    {newestLeads ? "Newest" : "Your pick"}
                  </div>
                )}
              </div>
              <div style={{
                fontSize: 16, color: "#fff", lineHeight: 1.55,
                fontWeight: 500, marginBottom: 20,
                fontFamily: "-apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif",
              }}>{c.action_text}</div>

              {/* Check-in dots */}
              {totalCheckins > 0 && (
                <div style={{ display: "flex", gap: 6, marginBottom: 20 }}>
                  {c.checkins.map((ck, i) => (
                    <div key={i} style={{
                      width: 10, height: 10, borderRadius: "50%",
                      background: ck.did_it ? "#fff" : "rgba(255,255,255,0.25)",
                      flexShrink: 0,
                    }} />
                  ))}
                  {totalCheckins >= 3 && (
                    <div style={{
                      fontSize: 12, color: "rgba(255,255,255,0.65)",
                      alignSelf: "center", marginLeft: 6,
                    }}>
                      {didCount} of {totalCheckins} {totalCheckins === 1 ? "night" : "nights"} done
                    </div>
                  )}
                </div>
              )}

              {/* Check-in prompt */}
              {c.todayCheckin ? (
                <div style={{
                  fontSize: 14, color: "rgba(255,255,255,0.7)",
                  fontStyle: "italic",
                }}>
                  {c.todayCheckin.did_it
                    ? "Logged for today. See you tomorrow."
                    : "No worries. Small steps still count."}
                </div>
              ) : (
                <div>
                  <div style={{
                    fontSize: 14, fontWeight: 600,
                    color: "rgba(255,255,255,0.85)", marginBottom: 12,
                  }}>Did you do it?</div>
                  <div style={{ display: "flex", gap: 10 }}>
                    <button
                      onClick={() => handleCheckin(c.id, true)}
                      disabled={disabled}
                      style={{
                        flex: 1, padding: "10px 0",
                        borderRadius: 10, border: "1.5px solid rgba(255,255,255,0.5)",
                        background: isMine && checkingIn?.choice === "yes" ? "rgba(255,255,255,0.2)" : "transparent",
                        color: "#fff", fontSize: 14, fontWeight: 600,
                        cursor: disabled ? "wait" : "pointer",
                        transition: "all .15s",
                      }}
                    >Yes</button>
                    <button
                      onClick={() => handleCheckin(c.id, false)}
                      disabled={disabled}
                      style={{
                        flex: 1, padding: "10px 0",
                        borderRadius: 10, border: "1.5px solid rgba(255,255,255,0.25)",
                        background: "transparent",
                        color: "rgba(255,255,255,0.6)", fontSize: 14, fontWeight: 500,
                        cursor: disabled ? "wait" : "pointer",
                        transition: "all .15s",
                      }}
                    >Not yet</button>
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        {/* Also running — remaining experiments, quieted to compact rows */}
        {orderedCommitments.length > 1 && (() => {
          const alsoRunning = orderedCommitments.slice(1);
          const COLLAPSE_THRESHOLD = 3;
          const canCollapse = alsoRunning.length > COLLAPSE_THRESHOLD;
          const visible = canCollapse && !showAllAlsoRunning
            ? alsoRunning.slice(0, COLLAPSE_THRESHOLD)
            : alsoRunning;
          const hiddenCount = alsoRunning.length - COLLAPSE_THRESHOLD;
          return (
          <div style={{ marginBottom: 20 }}>
            <div style={{
              fontSize: 10, fontWeight: 700, letterSpacing: ".16em",
              color: "#a98c7a", textTransform: "uppercase", marginBottom: 12,
              paddingLeft: 2,
            }}>
              Also running
            </div>
            {visible.map(c => {
              const didCount = c.checkins.filter(ck => ck.did_it).length;
              const totalCheckins = c.checkins.length;
              const isMine = checkingIn?.id === c.id;
              const disabled = isMine;
              return (
                <div key={c.id} style={{
                  background: "#fff",
                  border: "1px solid rgba(139,26,26,.12)",
                  borderLeft: "3px solid rgba(139,26,26,.35)",
                  borderRadius: 12, padding: "16px 18px",
                  marginBottom: 10,
                }}>
                  <div style={{
                    fontSize: 15, color: "#3a1515", lineHeight: 1.5,
                    fontWeight: 500, marginBottom: 12,
                  }}>{c.action_text}</div>

                  <div style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    gap: 12, flexWrap: "wrap",
                  }}>
                    {/* Progress + start date */}
                    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      {totalCheckins > 0 && (
                        <div style={{ display: "flex", gap: 4 }}>
                          {c.checkins.map((ck, i) => (
                            <div key={i} style={{
                              width: 8, height: 8, borderRadius: "50%",
                              background: ck.did_it ? "#8B1A1A" : "rgba(139,26,26,0.18)",
                              flexShrink: 0,
                            }} />
                          ))}
                        </div>
                      )}
                      <span style={{ fontSize: 12, color: "#8a6a5a" }}>
                        {totalCheckins > 0 ? `${didCount} of ${totalCheckins} done · ` : ""}
                        Started {new Date(c.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                      </span>
                    </div>

                    {/* Compact check-in affordance */}
                    {c.todayCheckin ? (
                      <span style={{
                        fontSize: 13, fontWeight: 600, whiteSpace: "nowrap",
                        color: c.todayCheckin.did_it ? "#8B1A1A" : "#a98c7a",
                      }}>
                        {c.todayCheckin.did_it ? "✓ Done tonight" : "Not tonight"}
                      </span>
                    ) : (
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <button
                          onClick={() => handleCheckin(c.id, true)}
                          disabled={disabled}
                          style={{
                            padding: "6px 14px", borderRadius: 8,
                            border: "1.5px solid rgba(139,26,26,0.4)",
                            background: isMine && checkingIn?.choice === "yes" ? "rgba(139,26,26,0.08)" : "transparent",
                            color: "#8B1A1A", fontSize: 13, fontWeight: 600,
                            cursor: disabled ? "wait" : "pointer",
                            transition: "all .15s", whiteSpace: "nowrap",
                          }}
                        >Yes</button>
                        <button
                          onClick={() => handleCheckin(c.id, false)}
                          disabled={disabled}
                          style={{
                            padding: "6px 14px", borderRadius: 8,
                            border: "1px solid rgba(0,0,0,0.12)",
                            background: "transparent",
                            color: "#999", fontSize: 13, fontWeight: 500,
                            cursor: disabled ? "wait" : "pointer",
                            transition: "all .15s", whiteSpace: "nowrap",
                          }}
                        >Not yet</button>
                      </div>
                    )}
                  </div>

                  {/* Promote this experiment to the prominent card for tonight */}
                  <button
                    onClick={() => setTonightsFocus(c.id)}
                    style={{
                      marginTop: 12, padding: 0,
                      background: "none", border: "none",
                      color: "#a98c7a", fontSize: 12, fontWeight: 600,
                      cursor: "pointer", letterSpacing: ".01em",
                      display: "inline-flex", alignItems: "center", gap: 5,
                    }}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 19V5" /><path d="M5 12l7-7 7 7" />
                    </svg>
                    Make this tonight's focus
                  </button>
                </div>
              );
            })}
            {canCollapse && (
              <button
                onClick={() => setShowAllAlsoRunning(v => !v)}
                style={{
                  display: "block", width: "100%",
                  padding: "10px 0", marginTop: 2,
                  borderRadius: 10, border: "1px dashed rgba(139,26,26,.25)",
                  background: "transparent",
                  color: "#8B1A1A", fontSize: 13, fontWeight: 600,
                  cursor: "pointer", transition: "all .15s",
                }}
              >
                {showAllAlsoRunning ? "Show less" : `Show ${hiddenCount} more`}
              </button>
            )}
          </div>
          );
        })()}

        {/* Commitments — all experiments in reverse-chronological order.
            Shows an empty state until the user makes their first commitment. */}
        {(() => {
          const OUTCOME_LABEL: Record<string, { label: string; color: string; bg: string }> = {
            helped:    { label: "Helped",      color: "#4a7c59", bg: "rgba(74,124,89,0.1)" },
            no_change: { label: "Didn't work", color: "#8B1A1A", bg: "rgba(139,26,26,0.07)" },
            not_tried: { label: "Didn't try",  color: "#a98c7a", bg: "rgba(169,140,122,0.12)" },
          };
          const sorted = [...commitments].sort(
            (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
          );
          return (
            <div style={{ marginBottom: 36 }}>
              <div style={{
                fontSize: 10, fontWeight: 700, letterSpacing: ".16em",
                color: "#a98c7a", textTransform: "uppercase",
                marginBottom: 14, paddingLeft: 2,
              }}>
                Commitments
              </div>
              {sorted.length === 0 ? (
                <div style={{
                  fontSize: 14, color: "#b0907a", fontStyle: "italic",
                  padding: "14px 0 4px", paddingLeft: 2,
                }}>
                  Your commitments will appear here.
                </div>
              ) : sorted.map(c => {
                const o = c.followupOutcome ? OUTCOME_LABEL[c.followupOutcome] : null;
                return (
                  <div key={c.id} style={{
                    background: "#fff",
                    border: "1px solid rgba(139,26,26,.1)",
                    borderRadius: 12,
                    padding: "14px 16px",
                    marginBottom: 10,
                    display: "flex", alignItems: "flex-start",
                    justifyContent: "space-between", gap: 12,
                  }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{
                        fontSize: 14, color: "#3a1515", lineHeight: 1.5,
                        fontWeight: 500, marginBottom: 4,
                      }}>
                        {c.action_text}
                      </div>
                      <div style={{ fontSize: 12, color: "#b0907a" }}>
                        {new Date(c.created_at).toLocaleDateString(undefined, {
                          month: "short", day: "numeric",
                        })}
                      </div>
                    </div>
                    {o && (
                      <div style={{
                        flexShrink: 0,
                        padding: "4px 10px", borderRadius: 20,
                        background: o.bg,
                        fontSize: 12, fontWeight: 600, color: o.color,
                        whiteSpace: "nowrap",
                      }}>
                        {o.label}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })()}

        {/* 7-night grid */}
        <div className="j-nightgrid" style={{
          display: "grid", gridTemplateColumns: "repeat(7, 1fr)",
          gap: 8, marginBottom: 40,
        }}>
          {nights.map(({ dateStr, log, isPast, isToday, label }) => (
            <div key={dateStr} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
              <div style={{
                width: "100%", aspectRatio: "1",
                borderRadius: 12,
                background: log
                  ? QUALITY_COLORS[log.quality]
                  : isToday
                  ? "rgba(139,26,26,0.06)"
                  : isPast
                  ? "rgba(0,0,0,0.04)"
                  : "rgba(0,0,0,0.02)",
                border: isToday && !log
                  ? "1.5px dashed rgba(139,26,26,0.4)"
                  : "1.5px solid transparent",
                display: "flex", alignItems: "center", justifyContent: "center",
                transition: "all .2s",
              }}>
                {log ? (
                  <span style={{ fontSize: "clamp(14px,2vw,20px)", color: "#fff", fontWeight: 700 }}>
                    {log.quality}
                  </span>
                ) : isToday ? (
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: "rgba(139,26,26,0.4)" }} />
                ) : isPast ? (
                  <div style={{ width: 6, height: 6, borderRadius: "50%", background: "rgba(0,0,0,0.15)" }} />
                ) : null}
              </div>
              <div style={{ fontSize: 10, color: "#aaa", letterSpacing: ".04em" }}>
                {isToday ? "Today" : label}
              </div>
            </div>
          ))}
        </div>

        {/* Average quality */}
        {avgQuality && (
          <div style={{
            display: "flex", alignItems: "center", gap: 16,
            padding: "16px 20px", borderRadius: 12,
            background: "rgba(139,26,26,0.04)",
            border: "1px solid rgba(139,26,26,.08)",
            marginBottom: 36,
          }}>
            <div>
              <div style={{ fontSize: 28, fontWeight: 700, color: "#8B1A1A", letterSpacing: "-0.02em" }}>
                {avgQuality}
              </div>
              <div style={{ fontSize: 11, color: "#888", letterSpacing: ".08em", textTransform: "uppercase" }}>
                avg quality
              </div>
            </div>
            <div style={{ width: 1, height: 36, background: "rgba(139,26,26,.12)" }} />
            <div style={{ display: "flex", gap: 4 }}>
              {Array.from({ length: 5 }, (_, i) => (
                <MoonIcon key={i} filled={i < Math.round(parseFloat(avgQuality))} quality={Math.round(parseFloat(avgQuality))} />
              ))}
            </div>
          </div>
        )}

        {/* Quiet affordance into the lifetime "so far" history. Gated on ANY
            logged history (not the 7-night window) so a returning user who has
            paused for more than a week can still look back over everything. */}
        {(data?.logs.length ?? 0) > 0 && (
          <button
            onClick={openHistory}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
              width: "100%", padding: "12px 0", marginBottom: 36,
              background: "none", border: "none", cursor: "pointer",
              color: "#8B1A1A", fontSize: 13, fontWeight: 600, letterSpacing: ".02em",
            }}
          >
            See your whole journey so far →
          </button>
        )}

        {/* Log tonight */}
        {!todayLog && !saved && (
          <div>
            {!logging ? (
              <button
                onClick={() => setLogging(true)}
                style={{
                  width: "100%", padding: "18px", borderRadius: 14, border: "none",
                  background: "#8B1A1A", color: "#fff",
                  fontSize: 16, fontWeight: 600, cursor: "pointer",
                  letterSpacing: ".01em",
                  transition: "opacity .15s",
                }}
                onMouseEnter={e => e.currentTarget.style.opacity = "0.88"}
                onMouseLeave={e => e.currentTarget.style.opacity = "1"}
              >
                Log tonight's sleep
              </button>
            ) : (
              <div style={{
                borderRadius: 16, border: "1px solid rgba(139,26,26,.15)",
                background: "#fff", padding: "28px 24px",
                boxShadow: "0 4px 24px rgba(139,26,26,.06)",
              }}>
                <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 6, color: "#0f0505" }}>
                  How did you sleep last night?
                </div>
                <div style={{ fontSize: 14, color: "#888", marginBottom: 24 }}>
                  Rate the quality of your sleep from 1 to 5.
                </div>

                {/* Star/moon quality picker */}
                <div style={{ display: "flex", gap: 10, marginBottom: 24 }}>
                  {[1, 2, 3, 4, 5].map(q => (
                    <button
                      key={q}
                      onClick={() => setQuality(q)}
                      onMouseEnter={() => setHoverQ(q)}
                      onMouseLeave={() => setHoverQ(0)}
                      style={{
                        flex: 1, padding: "14px 0", borderRadius: 10,
                        border: "1.5px solid",
                        borderColor: quality >= q || hoverQ >= q ? QUALITY_COLORS[q] : "rgba(0,0,0,0.1)",
                        background: quality >= q ? QUALITY_COLORS[q] : "transparent",
                        cursor: "pointer", transition: "all .15s",
                        display: "flex", flexDirection: "column",
                        alignItems: "center", gap: 4,
                      }}
                    >
                      <span style={{
                        fontSize: 16, fontWeight: 700,
                        color: quality >= q ? "#fff" : "#999",
                      }}>{q}</span>
                      <span style={{
                        fontSize: 9, letterSpacing: ".08em", textTransform: "uppercase",
                        color: quality >= q ? "rgba(255,255,255,0.7)" : "#bbb",
                      }}>{QUALITY_LABELS[q]}</span>
                    </button>
                  ))}
                </div>

                {/* Note */}
                <textarea
                  value={note}
                  onChange={e => setNote(e.target.value)}
                  placeholder="Anything you noticed? (optional)"
                  rows={2}
                  style={{
                    width: "100%", border: "1px solid rgba(0,0,0,0.1)",
                    borderRadius: 10, padding: "12px 14px",
                    fontSize: 15, fontFamily: "inherit", color: "#1a0505",
                    background: "#fafaf7", resize: "none", outline: "none",
                    boxSizing: "border-box", marginBottom: 16,
                  }}
                />

                <div style={{ display: "flex", gap: 10 }}>
                  <button
                    onClick={saveLog}
                    disabled={!quality || saving}
                    style={{
                      flex: 1, padding: "14px", borderRadius: 10, border: "none",
                      background: quality && !saving ? "#8B1A1A" : "rgba(139,26,26,0.25)",
                      color: "#fff", fontSize: 15, fontWeight: 600,
                      cursor: quality && !saving ? "pointer" : "default",
                      transition: "background .15s",
                    }}
                  >{saving ? "Saving…" : "Save"}</button>
                  <button
                    onClick={() => setLogging(false)}
                    style={{
                      padding: "14px 20px", borderRadius: 10,
                      border: "1px solid rgba(0,0,0,0.1)",
                      background: "transparent", color: "#888",
                      fontSize: 15, cursor: "pointer",
                    }}
                  >Cancel</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Saved confirmation */}
        {(saved || todayLog) && (
          <div style={{
            padding: "20px 24px", borderRadius: 14,
            background: "rgba(139,26,26,0.04)",
            border: "1px solid rgba(139,26,26,.1)",
            display: "flex", alignItems: "center", gap: 14,
          }}>
            <div style={{
              width: 32, height: 32, borderRadius: "50%", background: "#8B1A1A",
              display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, color: "#0f0505" }}>
                Tonight logged — {todayLog ? QUALITY_LABELS[todayLog.quality] : quality ? QUALITY_LABELS[quality] : ""}
              </div>
              <div style={{ fontSize: 13, color: "#888", marginTop: 2 }}>
                Come back tomorrow and keep the streak going.
              </div>
            </div>
          </div>
        )}

        {/* CTAs */}
        <div style={{ marginTop: 48, paddingTop: 32, borderTop: "1px solid rgba(139,26,26,.08)", display: "flex", flexDirection: "column", gap: 10 }}>
          <a
            href={`${import.meta.env.BASE_URL}sleep`}
            style={{
              display: "block", textAlign: "center",
              padding: "16px", borderRadius: 12,
              border: "1px solid rgba(139,26,26,.2)",
              color: "#8B1A1A", textDecoration: "none",
              fontSize: 14, fontWeight: 600, letterSpacing: ".01em",
              transition: "background .15s",
            }}
            onMouseEnter={e => (e.currentTarget.style.background = "rgba(139,26,26,0.04)")}
            onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
          >
            Ask another sleep question →
          </a>

          {/* Share your story — lead CTA after 7 nights, quiet card otherwise */}
          {loggedCount >= 7 ? (
            <a
              href={`/share?ref=journey&nights=${loggedCount}`}
              style={{
                display: "block",
                padding: "20px 22px", borderRadius: 14,
                background: "#8B1A1A", color: "#fff", textDecoration: "none",
                transition: "background .15s",
              }}
              onMouseEnter={e => (e.currentTarget.style.background = "#7a1717")}
              onMouseLeave={e => (e.currentTarget.style.background = "#8B1A1A")}
            >
              <div style={{
                fontSize: 10, fontWeight: 700, letterSpacing: ".16em",
                color: "rgba(255,255,255,0.7)", textTransform: "uppercase", marginBottom: 8,
              }}>
                For the Stanford Lifestyle Medicine newsletter
              </div>
              <div style={{
                fontSize: 16, lineHeight: 1.45, fontWeight: 600,
                fontFamily: "'Georgia', 'Times New Roman', serif",
              }}>
                You finished 7 nights. Tell us what changed →
              </div>
            </a>
          ) : (
            <a
              href={`/share?ref=journey&nights=${loggedCount}`}
              style={{
                display: "block",
                padding: "16px 18px", borderRadius: 12,
                background: "rgba(139,26,26,0.03)",
                border: "1px solid rgba(139,26,26,.12)",
                color: "#1a0505", textDecoration: "none",
                transition: "background .15s, border-color .15s",
              }}
              onMouseEnter={e => {
                e.currentTarget.style.background = "rgba(139,26,26,0.06)";
                e.currentTarget.style.borderColor = "rgba(139,26,26,.22)";
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = "rgba(139,26,26,0.03)";
                e.currentTarget.style.borderColor = "rgba(139,26,26,.12)";
              }}
            >
              <div style={{
                fontSize: 10, fontWeight: 700, letterSpacing: ".16em",
                color: "#8B1A1A", textTransform: "uppercase", marginBottom: 6,
              }}>
                For the Stanford Lifestyle Medicine newsletter
              </div>
              <div style={{
                fontSize: 14, lineHeight: 1.45,
                fontFamily: "'Georgia', 'Times New Roman', serif",
              }}>
                Sharing your sleep story? <span style={{ color: "#8B1A1A", fontWeight: 600 }}>Tell us what's working →</span>
              </div>
            </a>
          )}
          <a
            href={`${import.meta.env.BASE_URL}apple-watch`}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              textAlign: "center", padding: "14px", borderRadius: 12,
              border: "1px solid rgba(0,0,0,0.07)",
              color: "#666", textDecoration: "none",
              fontSize: 13, fontWeight: 500, letterSpacing: ".01em",
              transition: "background .15s",
            }}
            onMouseEnter={e => (e.currentTarget.style.background = "rgba(0,0,0,0.02)")}
            onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
          >
            ⌚ Connect Apple Watch for deeper analysis
          </a>
        </div>

        </>
        )}

      </main>
    </div>
  );
}
