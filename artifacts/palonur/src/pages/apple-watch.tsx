import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { SLMBrand } from "../components/SLMBrand";

const API_BASE = "/api";
const USER_ID_KEY  = "palonur_user_id";
const USER_NAME_KEY = "palonur_user_name";
const AUTH_KEY = "palonur_demo_authed";

function isAuthed() {
  try { return sessionStorage.getItem(AUTH_KEY) === "1"; } catch { return false; }
}

interface HealthRow {
  sleep_date: string;
  total_sleep_min: number | null;
  deep_sleep_min: number | null;
  rem_sleep_min: number | null;
  light_sleep_min: number | null;
  awake_min: number | null;
  sleep_start: string | null;
  sleep_end: string | null;
  hrv_avg: number | null;
  heart_rate_avg: number | null;
  heart_rate_min: number | null;
  respiratory_rate: number | null;
  blood_oxygen: number | null;
  wrist_temperature: number | null;
}

interface ParsedAnalysis {
  headline?: string;
  deep_sleep?: string;
  rem?: string;
  hrv?: string;
  heart_rate?: string;
  circadian?: string;
  action_tonight?: string;
  action_morning?: string;
  zeitzer_insight?: string;
  raw: string;
}

function parseAnalysis(text: string): ParsedAnalysis {
  const grab = (label: string, next?: string) => {
    const re = new RegExp(`${label}:\\s*([\\s\\S]*?)(?=${next ? next + ":" : "$"})`, "i");
    const m = text.match(re);
    return m ? m[1].trim() : undefined;
  };
  return {
    headline:        grab("HEADLINE", "DEEP_SLEEP"),
    deep_sleep:      grab("DEEP_SLEEP", "REM"),
    rem:             grab("REM", "HRV"),
    hrv:             grab("HRV", "HEART_RATE"),
    heart_rate:      grab("HEART_RATE", "CIRCADIAN"),
    circadian:       grab("CIRCADIAN", "ACTION_TONIGHT"),
    action_tonight:  grab("ACTION_TONIGHT", "ACTION_MORNING"),
    action_morning:  grab("ACTION_MORNING", "ZEITZER_INSIGHT"),
    zeitzer_insight: grab("ZEITZER_INSIGHT"),
    raw: text,
  };
}

function toNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmt(v: number | string | null | undefined, unit: string, decimals = 0) {
  const n = toNum(v);
  if (n == null) return "—";
  return n.toFixed(decimals) + unit;
}

function fmtMins(v: number | string | null | undefined) {
  const n = toNum(v);
  if (n == null) return "—";
  const total = Math.round(n);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtTime(t: string | null) {
  if (!t) return "—";
  return new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function MetricPill({
  label, value, sub, color,
}: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{
      background: "#fff", border: "1px solid #ede8e8", borderRadius: 12,
      padding: "14px 16px", minWidth: 110, flex: "1 1 110px",
    }}>
      <div style={{
        fontSize: 22, fontWeight: 700, color: color ?? "#8B1A1A",
        letterSpacing: "-0.02em", lineHeight: 1,
      }}>{value}</div>
      <div style={{ fontSize: 11, fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: ".06em", marginTop: 4 }}>{label}</div>
      {sub && <div style={{ fontSize: 10, color: "#bbb", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function StageBar({ label, min, total, color }: { label: string; min: number | string | null; total: number | string | null; color: string }) {
  const minN = toNum(min);
  const totalN = toNum(total);
  const pct = (minN != null && totalN != null && totalN > 0) ? Math.round(minN / totalN * 100) : null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
      <div style={{ width: 90, fontSize: 12, color: "#666", flexShrink: 0 }}>{label}</div>
      <div style={{ flex: 1, height: 8, background: "#f0eaea", borderRadius: 4, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct ?? 0}%`, background: color, borderRadius: 4, transition: "width .6s ease" }} />
      </div>
      <div style={{ width: 56, fontSize: 12, color: "#444", textAlign: "right", flexShrink: 0 }}>
        {fmtMins(min)} {pct != null ? <span style={{ color: "#aaa" }}>({pct}%)</span> : null}
      </div>
    </div>
  );
}

function AnalysisSection({ title, content }: { title: string; content?: string }) {
  if (!content) return null;
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase", color: "#8B1A1A", marginBottom: 6 }}>{title}</div>
      <p style={{ fontSize: 14, color: "#333", lineHeight: 1.65, margin: 0 }}>{content}</p>
    </div>
  );
}

const SHORTCUT_ACTIONS = [
  {
    step: "1",
    title: "Open Shortcuts on your iPhone",
    detail: "Tap the + button in the top right to create a new shortcut.",
  },
  {
    step: "2",
    title: "Add a Health action",
    detail: 'Search for "Find Health Samples" and add it. Set Type to "Sleep Analysis" and sort by "Start Date" descending. Limit to 1.',
  },
  {
    step: "3",
    title: "Add more Health samples",
    detail: 'Repeat for: HRV (Heart Rate Variability), Heart Rate, Respiratory Rate, Blood Oxygen. Each with "Find Health Samples", sorted descending, limited appropriately.',
  },
  {
    step: "4",
    title: "Add a Get Contents of URL action",
    detail: "Set Method to POST, URL to your personal webhook below. Add JSON body with the fields shown.",
  },
  {
    step: "5",
    title: "Set the automation to run daily",
    detail: 'Tap the shortcut name → "Add to Automation" → "Time of Day" → set to 7:00 AM daily. Enable "Run Automatically".',
  },
];

export default function AppleWatch() {
  const [, setLocation] = useLocation();
  const userId = (() => { try { return localStorage.getItem(USER_ID_KEY); } catch { return null; } })();
  const userName = (() => { try { return localStorage.getItem(USER_NAME_KEY); } catch { return null; } })();

  const [token, setToken] = useState<string | null>(null);
  const [tokenLoading, setTokenLoading] = useState(false);
  const [history, setHistory] = useState<HealthRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [analysis, setAnalysis] = useState<ParsedAnalysis | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisText, setAnalysisText] = useState("");
  const [activeDay, setActiveDay] = useState<HealthRow | null>(null);
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!isAuthed()) { setLocation("/"); return; }
    if (userId) {
      loadToken();
      loadHistory();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  async function loadToken() {
    setTokenLoading(true);
    try {
      const r = await fetch(`${API_BASE}/apple-health/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: parseInt(userId!, 10) }),
      });
      const d = await r.json();
      setToken(d.token);
    } catch { /* silent */ }
    setTokenLoading(false);
  }

  async function loadHistory() {
    if (!userId) return;
    setHistoryLoading(true);
    try {
      const r = await fetch(`${API_BASE}/apple-health/history/${userId}`);
      const d = await r.json();
      const rows: HealthRow[] = d.data ?? [];
      setHistory(rows);
      if (rows.length) setActiveDay(rows[0]);
    } catch { /* silent */ }
    setHistoryLoading(false);
  }

  async function runAnalysis() {
    if (!userId) return;
    setAnalysisLoading(true);
    setAnalysisText("");
    setAnalysis(null);
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    try {
      const r = await fetch(`${API_BASE}/apple-health/analysis/${userId}`, {
        signal: abortRef.current.signal,
      });
      const reader = r.body?.getReader();
      if (!reader) throw new Error("no stream");
      const dec = new TextDecoder();
      let buf = "", full = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.replace(/^data: /, "").trim();
          if (!line) continue;
          try {
            const ev = JSON.parse(line);
            if (ev.content) { full += ev.content; setAnalysisText(full); }
            if (ev.done)    { setAnalysis(parseAnalysis(full)); }
          } catch { /* partial */ }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setAnalysisText("Could not load analysis. Please try again.");
    }
    setAnalysisLoading(false);
  }

  function copyWebhook() {
    const url = webhookUrl();
    if (!url) return;
    navigator.clipboard.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  }

  const BASE_URL = window.location.origin;
  const webhookUrl = () => token ? `${BASE_URL}/api/apple-health?token=${token}` : null;

  const hasData = history.length > 0;

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(160deg, #0f0408 0%, #1a0808 45%, #0f0408 100%)",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Inter', sans-serif",
      color: "#fff",
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "20px 28px 0",
      }}>
        <SLMBrand size="sm" />
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <a href="/sleep" style={{ fontSize: 13, color: "rgba(255,255,255,0.5)", textDecoration: "none" }}>Sleep Agent</a>
          <a href="/journey" style={{ fontSize: 13, color: "rgba(255,255,255,0.5)", textDecoration: "none" }}>Journey</a>
        </div>
      </div>

      <div style={{ maxWidth: 760, margin: "0 auto", padding: "40px 24px 80px" }}>

        {/* Title */}
        <div style={{ marginBottom: 40 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".16em", textTransform: "uppercase", color: "#8B1A1A", marginBottom: 10 }}>
            Apple Watch · Sleep Intelligence
          </div>
          <h1 style={{
            fontSize: "clamp(26px, 4vw, 38px)", fontWeight: 400,
            fontFamily: "Georgia, serif", letterSpacing: "-0.02em",
            color: "#fff", margin: "0 0 12px",
          }}>
            {userName ? `${userName}'s` : "Your"} sleep, through Zeitzer's lens.
          </h1>
          <p style={{ fontSize: 15, color: "rgba(255,255,255,0.55)", lineHeight: 1.6, margin: 0, maxWidth: 520 }}>
            Your Apple Watch data, analyzed each morning against Prof. Jamie Zeitzer's published research at Stanford.
          </p>
        </div>

        {/* ── Setup / Webhook ── */}
        <div style={{
          background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: 16, padding: "24px 28px", marginBottom: 32,
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase", color: "#8B1A1A", marginBottom: 16 }}>
            Your Personal Webhook
          </div>

          {tokenLoading ? (
            <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 13 }}>Generating your token…</div>
          ) : token ? (
            <>
              <div style={{
                display: "flex", alignItems: "center", gap: 8, marginBottom: 16,
                background: "rgba(0,0,0,0.3)", borderRadius: 10, padding: "10px 14px",
              }}>
                <code style={{ flex: 1, fontSize: 11, color: "rgba(255,255,255,0.7)", wordBreak: "break-all", fontFamily: "monospace" }}>
                  {webhookUrl()}
                </code>
                <button onClick={copyWebhook} style={{
                  background: copied ? "#27AE60" : "#8B1A1A",
                  color: "#fff", border: "none", borderRadius: 7,
                  padding: "6px 12px", fontSize: 11, fontWeight: 600,
                  cursor: "pointer", flexShrink: 0, transition: "background .2s",
                }}>
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
              <p style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", margin: 0 }}>
                Paste this URL into your Apple Shortcut. It identifies you securely — keep it private.
              </p>
            </>
          ) : (
            <button onClick={loadToken} style={{
              background: "#8B1A1A", color: "#fff", border: "none",
              borderRadius: 10, padding: "10px 20px", fontSize: 14, fontWeight: 600,
              cursor: "pointer",
            }}>
              {userId ? "Generate my webhook URL" : "Sign in first to get your webhook"}
            </button>
          )}
        </div>

        {/* ── Shortcut Setup Guide ── */}
        <div style={{
          background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 16, padding: "24px 28px", marginBottom: 32,
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase", color: "#8B1A1A", marginBottom: 20 }}>
            Set Up Your Shortcut
          </div>
          {SHORTCUT_ACTIONS.map(s => (
            <div key={s.step} style={{ display: "flex", gap: 16, marginBottom: 20, alignItems: "flex-start" }}>
              <div style={{
                width: 28, height: 28, borderRadius: "50%",
                background: "rgba(139,26,26,0.25)", border: "1px solid rgba(139,26,26,0.4)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 12, fontWeight: 700, color: "#C0504A", flexShrink: 0,
              }}>{s.step}</div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#fff", marginBottom: 4 }}>{s.title}</div>
                <div style={{ fontSize: 13, color: "rgba(255,255,255,0.5)", lineHeight: 1.55 }}>{s.detail}</div>
              </div>
            </div>
          ))}

          {/* JSON payload reference */}
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "rgba(255,255,255,0.35)", marginBottom: 8 }}>
              Shortcut POST body (JSON)
            </div>
            <pre style={{
              background: "rgba(0,0,0,0.4)", borderRadius: 10, padding: "14px 16px",
              fontSize: 11, color: "rgba(255,255,255,0.65)", overflowX: "auto",
              margin: 0, lineHeight: 1.6, fontFamily: "monospace",
            }}>{`{
  "sleep_date":       "YYYY-MM-DD",
  "total_sleep_min":  <number>,
  "deep_sleep_min":   <number>,
  "rem_sleep_min":    <number>,
  "light_sleep_min":  <number>,
  "awake_min":        <number>,
  "sleep_start":      "ISO 8601 datetime",
  "sleep_end":        "ISO 8601 datetime",
  "hrv_avg":          <number>,
  "heart_rate_avg":   <number>,
  "heart_rate_min":   <number>,
  "respiratory_rate": <number>,
  "blood_oxygen":     <number>,
  "wrist_temperature":<number>
}`}</pre>
            <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginTop: 8, marginBottom: 0 }}>
              All fields except sleep_date are optional — send what your Watch has.
            </p>
          </div>
        </div>

        {/* ── Data & Analysis ── */}
        {historyLoading ? (
          <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 14, padding: "32px 0" }}>Loading your sleep data…</div>
        ) : !hasData ? (
          <div style={{
            background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)",
            borderRadius: 16, padding: "40px 28px", textAlign: "center",
          }}>
            <div style={{ fontSize: 32, marginBottom: 16 }}>⌚</div>
            <div style={{ fontSize: 16, fontWeight: 500, color: "rgba(255,255,255,0.7)", marginBottom: 8 }}>
              No Apple Watch data yet
            </div>
            <p style={{ fontSize: 14, color: "rgba(255,255,255,0.4)", margin: 0 }}>
              Once your Shortcut runs tonight, your data will appear here and analysis will be ready by morning.
            </p>
          </div>
        ) : (
          <>
            {/* Night selector */}
            {history.length > 1 && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 24 }}>
                {history.map(h => (
                  <button key={h.sleep_date} onClick={() => setActiveDay(h)} style={{
                    padding: "6px 14px", borderRadius: 20,
                    background: activeDay?.sleep_date === h.sleep_date ? "#8B1A1A" : "rgba(255,255,255,0.07)",
                    border: "1px solid " + (activeDay?.sleep_date === h.sleep_date ? "#8B1A1A" : "rgba(255,255,255,0.12)"),
                    color: activeDay?.sleep_date === h.sleep_date ? "#fff" : "rgba(255,255,255,0.55)",
                    fontSize: 12, fontWeight: 600, cursor: "pointer",
                  }}>
                    {new Date(h.sleep_date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                  </button>
                ))}
              </div>
            )}

            {activeDay && (
              <div style={{
                background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.09)",
                borderRadius: 16, padding: "24px 28px", marginBottom: 24,
              }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase", color: "#8B1A1A", marginBottom: 20 }}>
                  {new Date(activeDay.sleep_date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
                </div>

                {/* Metrics row */}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 24 }}>
                  <MetricPill label="Total Sleep" value={fmtMins(activeDay.total_sleep_min)} />
                  <MetricPill label="HRV" value={fmt(activeDay.hrv_avg, " ms")} sub="avg during sleep" color={activeDay.hrv_avg && activeDay.hrv_avg > 40 ? "#27AE60" : activeDay.hrv_avg && activeDay.hrv_avg < 25 ? "#C0392B" : "#C8A060"} />
                  <MetricPill label="Heart Rate" value={fmt(activeDay.heart_rate_avg, " bpm")} sub="avg during sleep" />
                  <MetricPill label="Resp. Rate" value={fmt(activeDay.respiratory_rate, "/min")} />
                  <MetricPill label="SpO2" value={fmt(activeDay.blood_oxygen, "%")} color={activeDay.blood_oxygen && activeDay.blood_oxygen >= 95 ? "#27AE60" : "#C0392B"} />
                </div>

                {/* Sleep stage bars */}
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "rgba(255,255,255,0.4)", marginBottom: 12 }}>Sleep Stages</div>
                  <StageBar label="Deep (SWS)" min={activeDay.deep_sleep_min} total={activeDay.total_sleep_min} color="#8B1A1A" />
                  <StageBar label="REM"        min={activeDay.rem_sleep_min}   total={activeDay.total_sleep_min} color="#6B4FA0" />
                  <StageBar label="Light"      min={activeDay.light_sleep_min} total={activeDay.total_sleep_min} color="#3A6898" />
                  <StageBar label="Awake"      min={activeDay.awake_min}       total={activeDay.total_sleep_min} color="#666" />
                </div>

                {/* Timing */}
                <div style={{ display: "flex", gap: 24 }}>
                  <div>
                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", textTransform: "uppercase", letterSpacing: ".1em" }}>Fell asleep</div>
                    <div style={{ fontSize: 16, fontWeight: 600, color: "#fff", marginTop: 2 }}>{fmtTime(activeDay.sleep_start)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", textTransform: "uppercase", letterSpacing: ".1em" }}>Woke up</div>
                    <div style={{ fontSize: 16, fontWeight: 600, color: "#fff", marginTop: 2 }}>{fmtTime(activeDay.sleep_end)}</div>
                  </div>
                  {(() => {
                    const wt = toNum(activeDay.wrist_temperature);
                    if (wt == null) return null;
                    return (
                      <div>
                        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", textTransform: "uppercase", letterSpacing: ".1em" }}>Wrist temp</div>
                        <div style={{ fontSize: 16, fontWeight: 600, color: wt > 0.5 ? "#E07030" : wt < -0.5 ? "#3080C0" : "#fff", marginTop: 2 }}>
                          {wt > 0 ? "+" : ""}{wt.toFixed(1)}°C
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </div>
            )}

            {/* Analysis panel */}
            <div style={{
              background: "rgba(139,26,26,0.08)", border: "1px solid rgba(139,26,26,0.25)",
              borderRadius: 16, padding: "24px 28px",
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase", color: "#8B1A1A" }}>
                  Zeitzer Analysis
                </div>
                <button
                  onClick={runAnalysis}
                  disabled={analysisLoading}
                  style={{
                    background: analysisLoading ? "rgba(139,26,26,0.3)" : "#8B1A1A",
                    color: "#fff", border: "none", borderRadius: 8,
                    padding: "8px 18px", fontSize: 12, fontWeight: 600,
                    cursor: analysisLoading ? "wait" : "pointer",
                    opacity: analysisLoading ? 0.7 : 1,
                  }}
                >
                  {analysisLoading ? "Analyzing…" : analysis ? "Refresh" : "Analyze my sleep"}
                </button>
              </div>

              {!analysis && !analysisLoading && !analysisText && (
                <p style={{ fontSize: 14, color: "rgba(255,255,255,0.4)", margin: 0 }}>
                  Hit "Analyze my sleep" to get a personalized breakdown grounded in Stanford sleep science — covering your sleep architecture, HRV, heart rate, and circadian timing.
                </p>
              )}

              {analysisLoading && analysisText && (
                <div style={{ fontSize: 14, color: "rgba(255,255,255,0.75)", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
                  {analysisText}
                  <span style={{ display: "inline-block", width: 8, height: 14, background: "#8B1A1A", marginLeft: 2, animation: "blink 1s step-end infinite", verticalAlign: "middle" }} />
                </div>
              )}

              {analysis && (
                <div>
                  {analysis.headline && (
                    <p style={{
                      fontSize: 17, fontWeight: 500, fontFamily: "Georgia, serif",
                      color: "#fff", lineHeight: 1.5, margin: "0 0 24px",
                      letterSpacing: "-0.01em",
                    }}>{analysis.headline}</p>
                  )}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 32px" }}>
                    <div>
                      <AnalysisSection title="Deep Sleep" content={analysis.deep_sleep} />
                      <AnalysisSection title="REM Sleep" content={analysis.rem} />
                      <AnalysisSection title="HRV" content={analysis.hrv} />
                    </div>
                    <div>
                      <AnalysisSection title="Heart Rate" content={analysis.heart_rate} />
                      <AnalysisSection title="Circadian Timing" content={analysis.circadian} />
                    </div>
                  </div>

                  {(analysis.action_tonight || analysis.action_morning) && (
                    <div style={{
                      display: "flex", gap: 12, marginTop: 20, flexWrap: "wrap",
                    }}>
                      {analysis.action_tonight && (
                        <div style={{
                          flex: "1 1 200px", background: "rgba(139,26,26,0.18)",
                          border: "1px solid rgba(139,26,26,0.35)", borderRadius: 12,
                          padding: "14px 16px",
                        }}>
                          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "#C0504A", marginBottom: 6 }}>Tonight</div>
                          <p style={{ fontSize: 13, color: "#fff", margin: 0, lineHeight: 1.55 }}>{analysis.action_tonight}</p>
                        </div>
                      )}
                      {analysis.action_morning && (
                        <div style={{
                          flex: "1 1 200px", background: "rgba(255,255,255,0.05)",
                          border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12,
                          padding: "14px 16px",
                        }}>
                          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "rgba(255,255,255,0.45)", marginBottom: 6 }}>Tomorrow morning</div>
                          <p style={{ fontSize: 13, color: "rgba(255,255,255,0.8)", margin: 0, lineHeight: 1.55 }}>{analysis.action_morning}</p>
                        </div>
                      )}
                    </div>
                  )}

                  {analysis.zeitzer_insight && (
                    <div style={{
                      marginTop: 20, background: "rgba(0,0,0,0.3)",
                      borderLeft: "3px solid #8B1A1A", borderRadius: "0 10px 10px 0",
                      padding: "14px 18px",
                    }}>
                      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "#8B1A1A", marginBottom: 6 }}>Zeitzer Research</div>
                      <p style={{ fontSize: 13, color: "rgba(255,255,255,0.7)", margin: 0, lineHeight: 1.6, fontStyle: "italic" }}>{analysis.zeitzer_insight}</p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Link to sleep agent */}
            <div style={{ marginTop: 24, textAlign: "center" }}>
              <a href="/sleep" style={{
                fontSize: 13, color: "rgba(255,255,255,0.45)", textDecoration: "none",
              }}>
                Have a question about your data? Ask the Sleep Agent →
              </a>
            </div>
          </>
        )}
      </div>

      <span style={{ position: "fixed", bottom: 20, right: 24, opacity: 0.5 }}>
        <SLMBrand size="sm" />
      </span>
      <style>{`@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }`}</style>
    </div>
  );
}
