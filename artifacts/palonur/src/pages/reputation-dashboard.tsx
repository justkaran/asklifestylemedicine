import { useEffect, useState, useCallback, useMemo } from "react";
import { Link } from "wouter";

const PAPER = "#FAF8F4";
const INK = "#0E1116";
const RED = "#B3261E";
const SLATE = "#5B6470";
const BORDER = "rgba(14,17,22,0.10)";

const TOPIC_SLUG = "sleep-stanford";

type RunSummary = {
  id: number;
  topicId: number;
  status: string;
  engines: string[];
  triggeredBy: string | null;
  startedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
  totals: Record<string, number>;
};

type TopicDetail = {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  signalKeywords: string[];
  seedDomains: string[];
  prompts: Array<{ id: number; prompt: string; category: string | null }>;
  latestRun: RunSummary | null;
  recentRuns: RunSummary[];
};

type AnswerItem = {
  id: number;
  promptId: number;
  promptText: string | null;
  engine: string;
  model: string;
  status: string;
  answerText: string | null;
  errorMessage: string | null;
  latencyMs: number | null;
  mentionsStanford: boolean;
  mentionsZeitzer: boolean;
  mentionsPalonur: boolean;
  signalHits: string[];
  citedUrls: string[];
  citedDomains: string[];
  createdAt: string;
};

type RunDetail = { run: RunSummary; answers: AnswerItem[] };

const apiBase = `${import.meta.env.BASE_URL}api`.replace(/\/+$/, "");

function fmtDate(s: string | null) {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleString();
  } catch {
    return s;
  }
}

function StatusPill({ status }: { status: string }) {
  const color =
    status === "completed"
      ? "#1F7A3A"
      : status === "running"
        ? "#0B6E8C"
        : status === "failed"
          ? RED
          : SLATE;
  return (
    <span
      style={{
        fontSize: 11,
        textTransform: "uppercase",
        letterSpacing: 0.4,
        color,
        border: `1px solid ${color}33`,
        background: `${color}10`,
        borderRadius: 999,
        padding: "2px 8px",
        fontWeight: 600,
      }}
    >
      {status}
    </span>
  );
}

function MentionDot({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      title={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 11,
        color: on ? INK : SLATE,
        opacity: on ? 1 : 0.45,
      }}
    >
      <span
        style={{
          display: "inline-block",
          width: 8,
          height: 8,
          borderRadius: 999,
          background: on ? RED : "transparent",
          border: `1px solid ${on ? RED : SLATE}`,
        }}
      />
      {label}
    </span>
  );
}

export default function ReputationDashboard() {
  const [topic, setTopic] = useState<TopicDetail | null>(null);
  const [topicErr, setTopicErr] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [runErr, setRunErr] = useState<string | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  useEffect(() => {
    document.title = "Reputation Dashboard · Palonur";
    document.body.style.background = PAPER;
    return () => {
      document.body.style.background = "";
    };
  }, []);

  const loadTopic = useCallback(async () => {
    try {
      const r = await fetch(`${apiBase}/reputation/topics/${TOPIC_SLUG}`);
      if (!r.ok) {
        setTopicErr(`Topic load failed (${r.status})`);
        return;
      }
      const data = (await r.json()) as TopicDetail;
      setTopic(data);
      setTopicErr(null);
      if (selectedRunId == null && data.latestRun) {
        setSelectedRunId(data.latestRun.id);
      }
    } catch (e) {
      setTopicErr(e instanceof Error ? e.message : String(e));
    }
  }, [selectedRunId]);

  const loadRun = useCallback(async (id: number) => {
    try {
      const r = await fetch(`${apiBase}/reputation/runs/${id}`);
      if (!r.ok) {
        setRunErr(`Run load failed (${r.status})`);
        return;
      }
      const data = (await r.json()) as RunDetail;
      setRun(data);
      setRunErr(null);
    } catch (e) {
      setRunErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void loadTopic();
  }, [loadTopic]);

  useEffect(() => {
    if (selectedRunId != null) void loadRun(selectedRunId);
  }, [selectedRunId, loadRun]);

  // Auto-poll if the selected run is running.
  useEffect(() => {
    if (!run || run.run.status !== "running") return;
    const t = window.setInterval(() => {
      void loadRun(run.run.id);
      void loadTopic();
    }, 4000);
    return () => window.clearInterval(t);
  }, [run, loadRun, loadTopic]);

  async function trigger() {
    setTriggering(true);
    try {
      const r = await fetch(`${apiBase}/reputation/topics/${TOPIC_SLUG}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!r.ok) {
        alert(`Trigger failed (${r.status})`);
        return;
      }
      const data = (await r.json()) as RunSummary;
      setSelectedRunId(data.id);
      await loadTopic();
    } finally {
      setTriggering(false);
    }
  }

  const totalsRow = run?.run.totals ?? {};

  const aggregates = useMemo(() => {
    if (!run) return null;
    const total = run.answers.length || 1;
    const ok = run.answers.filter((a) => a.status === "ok").length;
    const stanford = run.answers.filter((a) => a.mentionsStanford).length;
    const zeitzer = run.answers.filter((a) => a.mentionsZeitzer).length;
    const palonur = run.answers.filter((a) => a.mentionsPalonur).length;
    return {
      total,
      ok,
      stanford,
      zeitzer,
      palonur,
      stanfordPct: Math.round((stanford / total) * 100),
      zeitzerPct: Math.round((zeitzer / total) * 100),
      palonurPct: Math.round((palonur / total) * 100),
    };
  }, [run]);

  function toggle(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div
      style={{
        background: PAPER,
        color: INK,
        minHeight: "100vh",
        fontFamily:
          'ui-sans-serif, -apple-system, "Inter", system-ui, sans-serif',
        padding: "32px 28px 64px",
      }}
    >
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginBottom: 24,
            flexWrap: "wrap",
            gap: 12,
          }}
        >
          <div>
            <div
              style={{
                fontSize: 11,
                letterSpacing: 1.5,
                textTransform: "uppercase",
                color: SLATE,
                fontWeight: 600,
              }}
            >
              Palonur · Reputation Tracker · v1
            </div>
            <h1
              style={{
                fontFamily: 'Georgia, "Times New Roman", serif',
                fontSize: 34,
                fontWeight: 500,
                margin: "6px 0 4px",
                letterSpacing: -0.5,
              }}
            >
              {topic ? topic.name : "Loading…"}
            </h1>
            {topic?.description && (
              <p style={{ color: SLATE, margin: 0, maxWidth: 680, fontSize: 14 }}>
                {topic.description}
              </p>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Link
              href="/reputation"
              style={{ color: SLATE, fontSize: 13, textDecoration: "none" }}
            >
              ← back to /reputation
            </Link>
            <button
              onClick={() => void trigger()}
              disabled={triggering || !topic}
              style={{
                background: INK,
                color: "white",
                border: "none",
                borderRadius: 999,
                padding: "10px 18px",
                fontSize: 13,
                fontWeight: 600,
                cursor: triggering ? "not-allowed" : "pointer",
                opacity: triggering ? 0.5 : 1,
              }}
            >
              {triggering ? "Starting…" : "Run now ↻"}
            </button>
          </div>
        </div>

        {topicErr && (
          <div
            style={{
              background: "#FFF0EE",
              color: RED,
              border: `1px solid ${RED}40`,
              padding: 12,
              borderRadius: 10,
              marginBottom: 16,
              fontSize: 13,
            }}
          >
            {topicErr}
          </div>
        )}

        {topic && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "260px 1fr",
              gap: 20,
              marginTop: 8,
            }}
          >
            {/* Sidebar — recent runs */}
            <aside>
              <h3
                style={{
                  fontSize: 11,
                  letterSpacing: 1.4,
                  textTransform: "uppercase",
                  color: SLATE,
                  margin: "8px 0 10px",
                }}
              >
                Recent runs
              </h3>
              {topic.recentRuns.length === 0 && (
                <p style={{ fontSize: 13, color: SLATE }}>
                  No runs yet. Click "Run now" to start.
                </p>
              )}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {topic.recentRuns.map((r) => {
                  const active = r.id === selectedRunId;
                  return (
                    <button
                      key={r.id}
                      onClick={() => setSelectedRunId(r.id)}
                      style={{
                        textAlign: "left",
                        background: active ? "white" : "transparent",
                        border: `1px solid ${active ? BORDER : "transparent"}`,
                        borderRadius: 10,
                        padding: "10px 12px",
                        cursor: "pointer",
                        fontSize: 13,
                        color: INK,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          marginBottom: 4,
                        }}
                      >
                        <strong>#{r.id}</strong>
                        <StatusPill status={r.status} />
                      </div>
                      <div style={{ color: SLATE, fontSize: 11 }}>
                        {fmtDate(r.startedAt)}
                      </div>
                      <div style={{ color: SLATE, fontSize: 11 }}>
                        {r.engines.join(" · ")}
                      </div>
                    </button>
                  );
                })}
              </div>
              <h3
                style={{
                  fontSize: 11,
                  letterSpacing: 1.4,
                  textTransform: "uppercase",
                  color: SLATE,
                  margin: "20px 0 10px",
                }}
              >
                Topic
              </h3>
              <div style={{ fontSize: 12, color: SLATE, lineHeight: 1.6 }}>
                <div>
                  <strong style={{ color: INK }}>Slug:</strong> {topic.slug}
                </div>
                <div>
                  <strong style={{ color: INK }}>Prompts:</strong>{" "}
                  {topic.prompts.length}
                </div>
                <div style={{ marginTop: 6 }}>
                  <strong style={{ color: INK }}>Signals:</strong>{" "}
                  {topic.signalKeywords.join(", ")}
                </div>
              </div>
            </aside>

            {/* Main */}
            <main>
              {!selectedRunId && (
                <div
                  style={{
                    background: "white",
                    border: `1px solid ${BORDER}`,
                    borderRadius: 14,
                    padding: 32,
                    textAlign: "center",
                    color: SLATE,
                  }}
                >
                  Click "Run now" to ask the configured AI engines all{" "}
                  {topic.prompts.length} prompts and see how often Stanford,
                  Zeitzer, or Palonur appear.
                </div>
              )}

              {selectedRunId && runErr && (
                <div
                  style={{
                    background: "#FFF0EE",
                    color: RED,
                    border: `1px solid ${RED}40`,
                    padding: 12,
                    borderRadius: 10,
                    fontSize: 13,
                  }}
                >
                  {runErr}
                </div>
              )}

              {run && (
                <>
                  {/* Run header */}
                  <div
                    style={{
                      background: "white",
                      border: `1px solid ${BORDER}`,
                      borderRadius: 14,
                      padding: 18,
                      marginBottom: 16,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: 10,
                        flexWrap: "wrap",
                        gap: 8,
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 12, color: SLATE }}>
                          Run #{run.run.id} · {run.run.engines.join(" · ")} ·{" "}
                          {fmtDate(run.run.startedAt)}
                          {run.run.completedAt
                            ? ` → ${fmtDate(run.run.completedAt)}`
                            : ""}
                        </div>
                        {run.run.errorMessage && (
                          <div style={{ color: RED, fontSize: 12, marginTop: 4 }}>
                            {run.run.errorMessage}
                          </div>
                        )}
                      </div>
                      <StatusPill status={run.run.status} />
                    </div>

                    {aggregates && (
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(4, 1fr)",
                          gap: 10,
                          marginTop: 12,
                        }}
                      >
                        <Stat
                          label="Answers"
                          big={`${aggregates.ok}/${aggregates.total}`}
                          sub="ok"
                        />
                        <Stat
                          label="Stanford"
                          big={`${aggregates.stanfordPct}%`}
                          sub={`${aggregates.stanford} answers`}
                          accent={aggregates.stanford > 0}
                        />
                        <Stat
                          label="Zeitzer"
                          big={`${aggregates.zeitzerPct}%`}
                          sub={`${aggregates.zeitzer} answers`}
                          accent={aggregates.zeitzer > 0}
                        />
                        <Stat
                          label="Palonur"
                          big={`${aggregates.palonurPct}%`}
                          sub={`${aggregates.palonur} answers`}
                          accent={aggregates.palonur > 0}
                        />
                      </div>
                    )}

                    {Object.keys(totalsRow).length > 0 && (
                      <details style={{ marginTop: 10, fontSize: 12, color: SLATE }}>
                        <summary style={{ cursor: "pointer" }}>raw totals</summary>
                        <pre
                          style={{
                            background: PAPER,
                            padding: 8,
                            borderRadius: 6,
                            overflow: "auto",
                          }}
                        >
                          {JSON.stringify(totalsRow, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>

                  {/* Answers grouped by prompt */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {(() => {
                      const byPrompt = new Map<number, AnswerItem[]>();
                      for (const a of run.answers) {
                        const arr = byPrompt.get(a.promptId) ?? [];
                        arr.push(a);
                        byPrompt.set(a.promptId, arr);
                      }
                      return Array.from(byPrompt.entries()).map(
                        ([promptId, answers]) => {
                          const promptText =
                            answers[0]?.promptText ?? `prompt #${promptId}`;
                          return (
                            <div
                              key={promptId}
                              style={{
                                background: "white",
                                border: `1px solid ${BORDER}`,
                                borderRadius: 12,
                                padding: 14,
                              }}
                            >
                              <div
                                style={{
                                  fontFamily:
                                    'Georgia, "Times New Roman", serif',
                                  fontSize: 16,
                                  fontWeight: 500,
                                  marginBottom: 10,
                                }}
                              >
                                {promptText}
                              </div>
                              {answers.map((a) => (
                                <div
                                  key={a.id}
                                  style={{
                                    borderTop: `1px solid ${BORDER}`,
                                    padding: "10px 0 6px",
                                  }}
                                >
                                  <div
                                    style={{
                                      display: "flex",
                                      gap: 10,
                                      alignItems: "center",
                                      flexWrap: "wrap",
                                    }}
                                  >
                                    <strong style={{ fontSize: 13 }}>
                                      {a.engine}
                                    </strong>
                                    <span style={{ fontSize: 11, color: SLATE }}>
                                      {a.model}
                                    </span>
                                    <span style={{ fontSize: 11, color: SLATE }}>
                                      {a.latencyMs != null
                                        ? `${a.latencyMs} ms`
                                        : "—"}
                                    </span>
                                    {a.status !== "ok" && (
                                      <StatusPill status={a.status} />
                                    )}
                                    <div style={{ flex: 1 }} />
                                    <div style={{ display: "flex", gap: 10 }}>
                                      <MentionDot
                                        on={a.mentionsStanford}
                                        label="Stanford"
                                      />
                                      <MentionDot
                                        on={a.mentionsZeitzer}
                                        label="Zeitzer"
                                      />
                                      <MentionDot
                                        on={a.mentionsPalonur}
                                        label="Palonur"
                                      />
                                    </div>
                                  </div>
                                  {a.errorMessage && (
                                    <div
                                      style={{
                                        color: RED,
                                        fontSize: 12,
                                        marginTop: 6,
                                      }}
                                    >
                                      {a.errorMessage}
                                    </div>
                                  )}
                                  {a.answerText && (
                                    <div style={{ marginTop: 6 }}>
                                      <button
                                        onClick={() => toggle(a.id)}
                                        style={{
                                          background: "transparent",
                                          border: "none",
                                          color: SLATE,
                                          fontSize: 12,
                                          cursor: "pointer",
                                          padding: 0,
                                        }}
                                      >
                                        {expanded.has(a.id)
                                          ? "▼ hide answer"
                                          : "▶ show answer"}
                                      </button>
                                      {expanded.has(a.id) && (
                                        <div
                                          style={{
                                            marginTop: 6,
                                            background: PAPER,
                                            border: `1px solid ${BORDER}`,
                                            borderRadius: 8,
                                            padding: 12,
                                            fontSize: 13,
                                            lineHeight: 1.5,
                                            whiteSpace: "pre-wrap",
                                            color: INK,
                                          }}
                                        >
                                          {a.answerText}
                                        </div>
                                      )}
                                    </div>
                                  )}
                                  {(a.signalHits.length > 0 ||
                                    a.citedDomains.length > 0) && (
                                    <div
                                      style={{
                                        marginTop: 6,
                                        fontSize: 11,
                                        color: SLATE,
                                        display: "flex",
                                        gap: 14,
                                        flexWrap: "wrap",
                                      }}
                                    >
                                      {a.signalHits.length > 0 && (
                                        <span>
                                          <strong style={{ color: INK }}>
                                            signals:
                                          </strong>{" "}
                                          {a.signalHits.join(", ")}
                                        </span>
                                      )}
                                      {a.citedDomains.length > 0 && (
                                        <span>
                                          <strong style={{ color: INK }}>
                                            cited:
                                          </strong>{" "}
                                          {a.citedDomains.join(", ")}
                                        </span>
                                      )}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          );
                        },
                      );
                    })()}
                  </div>
                </>
              )}
            </main>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  big,
  sub,
  accent,
}: {
  label: string;
  big: string;
  sub: string;
  accent?: boolean;
}) {
  return (
    <div
      style={{
        background: PAPER,
        border: `1px solid ${BORDER}`,
        borderRadius: 10,
        padding: 12,
      }}
    >
      <div
        style={{
          fontSize: 10,
          letterSpacing: 1.2,
          textTransform: "uppercase",
          color: SLATE,
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 24,
          fontWeight: 600,
          fontFamily: 'Georgia, "Times New Roman", serif',
          color: accent ? RED : INK,
        }}
      >
        {big}
      </div>
      <div style={{ fontSize: 11, color: SLATE }}>{sub}</div>
    </div>
  );
}
