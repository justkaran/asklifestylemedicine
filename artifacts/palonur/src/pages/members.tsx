import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { studyDesignLabel } from "@workspace/db/study-design";
import {
  RED,
  INK,
  PAPER,
  MUTED,
  SERIF,
  SANS,
  formatIssueDate,
} from "@/components/newsletter-subscribe";

/**
 * Members reading room. A signed-in newsletter subscriber sees only the
 * publications they're subscribed to, reads their past issues (the same content
 * their emails contained), and uses an auto-routing "ask anything" box that
 * answers in the best-matching Stanford expert's voice with citations and an
 * "Answered by …" label.
 *
 * Auth is the isolated `members_session` cookie (see routes/members.ts). On a
 * 401 we send the visitor to /members-login. Issue reading reuses the existing
 * public publication/issue endpoints; the gating that matters (which
 * publications appear) comes from /api/members/portal.
 */

interface Subscription {
  id: number;
  name: string;
  slug: string;
  tagline: string | null;
  accentColor: string | null;
  isHouse: boolean;
  subscribedAt: string | null;
}

interface IssueSummary {
  id: number;
  title: string;
  previewText: string | null;
  heroImageUrl: string | null;
  sentAt: string | null;
}

interface Post {
  id: number;
  kind: string;
  title: string | null;
  authorName: string | null;
  authorInstitution: string | null;
  bodyHtml: string | null;
  pullQuote: string | null;
  imageUrl: string | null;
}

interface IssueDetail {
  id: number;
  title: string;
  previewText: string | null;
  introHtml: string | null;
  heroImageUrl: string | null;
  sentAt: string | null;
}

function tint(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  if (h.length !== 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function safeHref(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const p = new URL(u);
    return p.protocol === "https:" || p.protocol === "http:" ? u : null;
  } catch {
    return null;
  }
}

// ── Auto-routing ask box (consumes /api/newsletter-qa) ──────────────────────

interface ProvenanceEntry {
  source_id: number;
  interpretation_id: number | null;
  title: string;
  authors: string | null;
  year: number | null;
  journal: string | null;
  doi: string | null;
  source_url: string | null;
  study_design: string | null;
  pillar_slug: string;
}

interface ParsedAnswer {
  answer?: string;
  citation?: string;
  paper?: string;
  finding?: string;
  interpretation?: string;
  action?: string;
  insight?: string;
  refuse?: string;
  uncovered?: string;
}

/** Parse the labelled streaming response into sections (mirrors /sleep). */
function parseAnswer(raw: string): ParsedAnswer {
  const text = raw.trim();
  if (!text) return {};
  const refuse = text.match(/^REFUSE:\s*([\s\S]*)/i);
  if (refuse) return { refuse: refuse[1].trim() };
  const uncovered = text.match(/^UNCOVERED:\s*([\s\S]*)/i);
  if (uncovered) return { uncovered: uncovered[1].trim() };

  const ALL = [
    "ANSWER",
    "CITATION",
    "PAPER",
    "FINDING",
    "INTERPRETATION",
    "ACTION",
    "INSIGHT",
    "CLARIFY",
    "ADVISOR_NOTE",
  ];
  const grab = (label: string): string | undefined => {
    const re = new RegExp(
      `${label}:\\s*([\\s\\S]*?)(?=\\n(?:${ALL.join("|")}):|$)`,
      "i",
    );
    const m = text.match(re);
    return m ? m[1].trim() : undefined;
  };
  return {
    answer: grab("ANSWER"),
    citation: grab("CITATION"),
    paper: grab("PAPER"),
    finding: grab("FINDING"),
    interpretation: grab("INTERPRETATION"),
    action: grab("ACTION"),
    insight: grab("INSIGHT"),
  };
}

function AskBox() {
  const [q, setQ] = useState("");
  const [out, setOut] = useState("");
  const [provenance, setProvenance] = useState<ProvenanceEntry[]>([]);
  const [expertName, setExpertName] = useState<string | null>(null);
  const [pillarName, setPillarName] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (message: string) => {
      if (!message.trim() || streaming) return;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setOut("");
      setProvenance([]);
      setExpertName(null);
      setPillarName(null);
      setErr(null);
      setAsked(true);
      setStreaming(true);
      try {
        const r = await fetch("/api/newsletter-qa", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ message, lang: navigator.language?.slice(0, 2) || "en" }),
          signal: ac.signal,
        });
        if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const s of parts) {
            if (!s.startsWith("data:")) continue;
            try {
              const j = JSON.parse(s.slice(5).trim());
              if (j.routed) {
                setExpertName(j.expertName ?? null);
                setPillarName(j.pillarName ?? null);
              }
              if (j.content) setOut((p) => p + j.content);
              if (j.error) setErr(String(j.error));
              if (Array.isArray(j.provenance)) setProvenance(j.provenance);
              if (j.done && j.expertName) setExpertName(j.expertName);
            } catch {
              /* swallow partial frames */
            }
          }
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") setErr((e as Error).message);
      } finally {
        setStreaming(false);
      }
    },
    [streaming],
  );

  const parsed = useMemo(() => parseAnswer(out), [out]);
  const border = tint(RED, 0.22);
  const showAnsweredBy =
    !!expertName && !parsed.refuse && !parsed.uncovered && !err;

  return (
    <section
      data-testid="members-ask"
      style={{
        marginTop: 8,
        padding: "28px 26px",
        borderRadius: 18,
        background: tint(RED, 0.05),
        border: `1px solid ${border}`,
        fontFamily: SANS,
      }}
    >
      <p
        style={{
          fontSize: 12,
          letterSpacing: ".16em",
          textTransform: "uppercase",
          color: RED,
          fontWeight: 600,
          margin: "0 0 8px",
        }}
      >
        Ask the experts
      </p>
      <h2
        style={{
          fontFamily: SERIF,
          fontWeight: 500,
          fontSize: "clamp(22px, 3vw, 28px)",
          lineHeight: 1.25,
          color: INK,
          margin: "0 0 8px",
        }}
      >
        Ask anything about lifestyle medicine.
      </h2>
      <p
        style={{
          fontSize: 14.5,
          lineHeight: 1.55,
          color: MUTED,
          margin: "0 0 18px",
          maxWidth: 620,
        }}
      >
        Your question is routed to the Stanford expert who knows it best, and
        answered in their own words — grounded in their published research, with
        the source cited. One question at a time.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(q);
        }}
        style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ask anything…"
          disabled={streaming}
          data-testid="members-ask-input"
          style={{
            flex: "1 1 240px",
            padding: "13px 16px",
            background: "#fff",
            border: `1px solid ${border}`,
            borderRadius: 10,
            color: INK,
            fontFamily: SANS,
            fontSize: 15,
            outline: "none",
          }}
        />
        <button
          type="submit"
          disabled={streaming || !q.trim()}
          data-testid="members-ask-submit"
          style={{
            padding: "0 22px",
            background: streaming || !q.trim() ? tint(RED, 0.45) : RED,
            color: "#fff",
            border: "none",
            borderRadius: 10,
            fontWeight: 600,
            fontSize: 14,
            cursor: streaming || !q.trim() ? "default" : "pointer",
          }}
        >
          {streaming ? "…" : "Ask"}
        </button>
      </form>

      {showAnsweredBy && (
        <div
          data-testid="members-answered-by"
          style={{
            marginTop: 18,
            fontSize: 12.5,
            letterSpacing: ".06em",
            textTransform: "uppercase",
            fontWeight: 700,
            color: RED,
          }}
        >
          Answered by {expertName}
          {pillarName && (
            <span style={{ color: MUTED, fontWeight: 500 }}> · {pillarName}</span>
          )}
        </div>
      )}

      {!asked ? null : err ? (
        <div style={{ fontSize: 14, color: "#b91c1c", marginTop: 14 }}>
          Something went wrong. Please try again.
        </div>
      ) : parsed.refuse ? (
        <p style={{ fontSize: 15, color: INK, lineHeight: 1.6, marginTop: 14 }}>
          {parsed.refuse}
        </p>
      ) : parsed.uncovered ? (
        <p style={{ fontSize: 15, color: INK, lineHeight: 1.6, marginTop: 14 }}>
          {parsed.uncovered}
        </p>
      ) : (
        <article style={{ marginTop: 14 }}>
          {parsed.answer ? (
            <p
              style={{
                fontFamily: SERIF,
                fontSize: 21,
                lineHeight: 1.45,
                margin: "0 0 14px",
                color: INK,
              }}
            >
              {parsed.answer}
              {streaming && <span style={{ color: RED }}>▍</span>}
            </p>
          ) : (
            <p style={{ fontSize: 14, color: MUTED, margin: "0 0 8px" }}>
              {streaming ? "Thinking…" : out}
              {streaming && <span style={{ color: RED }}>▍</span>}
            </p>
          )}

          {parsed.interpretation && (
            <p
              style={{
                fontSize: 15,
                lineHeight: 1.65,
                color: tint(INK, 0.82),
                margin: "0 0 14px",
              }}
            >
              {parsed.interpretation}
            </p>
          )}

          {parsed.action && (
            <div
              style={{
                background: "#fff",
                border: `1px solid ${border}`,
                borderRadius: 10,
                padding: "12px 14px",
                fontSize: 14,
                lineHeight: 1.55,
                color: INK,
                marginBottom: 14,
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  color: RED,
                  display: "block",
                  marginBottom: 4,
                }}
              >
                Try this
              </span>
              {parsed.action}
            </div>
          )}

          {(parsed.citation || provenance.length > 0) && (
            <div
              style={{
                borderTop: `1px solid ${border}`,
                paddingTop: 12,
                marginTop: 4,
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  color: MUTED,
                  marginBottom: 6,
                }}
              >
                Source
              </div>
              {provenance.length > 0 ? (
                provenance.map((p) => {
                  const href =
                    safeHref(p.source_url) ||
                    (p.doi ? `https://doi.org/${p.doi}` : null);
                  const label = `${p.title}${p.year ? ` (${p.year})` : ""}`;
                  const studyType = studyDesignLabel(p.study_design);
                  return (
                    <div
                      key={p.source_id}
                      style={{ fontSize: 13, marginBottom: 4, color: INK }}
                    >
                      {href ? (
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: RED, textDecoration: "none" }}
                        >
                          {label}
                        </a>
                      ) : (
                        label
                      )}
                      {p.authors && (
                        <span style={{ color: MUTED }}> · {p.authors}</span>
                      )}
                      {studyType && (
                        <span
                          style={{
                            display: "inline-block",
                            marginLeft: 6,
                            fontSize: 10.5,
                            fontWeight: 600,
                            color: MUTED,
                            border: `1px solid ${MUTED}`,
                            borderRadius: 999,
                            padding: "1px 7px",
                            verticalAlign: "middle",
                          }}
                        >
                          {studyType}
                        </span>
                      )}
                    </div>
                  );
                })
              ) : (
                <div style={{ fontSize: 13, color: INK }}>
                  {parsed.citation}
                  {parsed.paper && (
                    <div style={{ color: MUTED, marginTop: 2 }}>
                      {parsed.paper}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </article>
      )}
    </section>
  );
}

// ── Issue reader (reuses public publication/issue endpoints) ────────────────

function IssueReader({
  slug,
  issueId,
  onBack,
}: {
  slug: string;
  issueId: number;
  onBack: () => void;
}) {
  const [issue, setIssue] = useState<IssueDetail | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(false);
    fetch(`/api/newsletter/p/${encodeURIComponent(slug)}/issues/${issueId}`, {
      credentials: "include",
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        if (!alive) return;
        setIssue(d.issue);
        setPosts(Array.isArray(d.posts) ? d.posts : []);
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setError(true);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [slug, issueId]);

  return (
    <div>
      <button
        onClick={onBack}
        style={{
          background: "none",
          border: "none",
          color: RED,
          fontFamily: SANS,
          fontSize: 14,
          fontWeight: 600,
          cursor: "pointer",
          padding: 0,
          marginBottom: 20,
        }}
      >
        ← All issues
      </button>
      {loading ? (
        <p style={{ color: MUTED, fontFamily: SANS }}>Loading…</p>
      ) : error || !issue ? (
        <p style={{ color: MUTED, fontFamily: SANS }}>
          This issue could not be loaded.
        </p>
      ) : (
        <article>
          {issue.sentAt && (
            <div
              style={{
                fontSize: 12,
                letterSpacing: ".08em",
                textTransform: "uppercase",
                color: MUTED,
                fontFamily: SANS,
                marginBottom: 8,
              }}
            >
              {formatIssueDate(issue.sentAt)}
            </div>
          )}
          <h1
            style={{
              fontFamily: SERIF,
              fontSize: "clamp(28px, 4vw, 40px)",
              fontWeight: 500,
              lineHeight: 1.18,
              color: INK,
              margin: "0 0 18px",
            }}
          >
            {issue.title}
          </h1>
          {issue.heroImageUrl && (
            <img
              src={issue.heroImageUrl}
              alt=""
              style={{
                width: "100%",
                borderRadius: 14,
                marginBottom: 22,
                display: "block",
              }}
            />
          )}
          {issue.introHtml && (
            <div
              style={{
                fontFamily: SERIF,
                fontSize: 18,
                lineHeight: 1.7,
                color: tint(INK, 0.85),
                marginBottom: 28,
              }}
              dangerouslySetInnerHTML={{ __html: issue.introHtml }}
            />
          )}
          {posts.map((p) => (
            <section key={p.id} style={{ marginBottom: 36 }}>
              {p.title && (
                <h2
                  style={{
                    fontFamily: SERIF,
                    fontSize: 24,
                    fontWeight: 500,
                    color: INK,
                    margin: "0 0 6px",
                  }}
                >
                  {p.title}
                </h2>
              )}
              {p.authorName && (
                <div
                  style={{
                    fontSize: 13,
                    color: MUTED,
                    fontFamily: SANS,
                    marginBottom: 12,
                  }}
                >
                  By {p.authorName}
                  {p.authorInstitution ? ` · ${p.authorInstitution}` : ""}
                </div>
              )}
              {p.imageUrl && (
                <img
                  src={p.imageUrl}
                  alt=""
                  style={{
                    width: "100%",
                    borderRadius: 12,
                    marginBottom: 16,
                    display: "block",
                  }}
                />
              )}
              {p.pullQuote && (
                <blockquote
                  style={{
                    borderLeft: `3px solid ${RED}`,
                    paddingLeft: 16,
                    margin: "0 0 16px",
                    fontFamily: SERIF,
                    fontSize: 20,
                    fontStyle: "italic",
                    color: INK,
                  }}
                >
                  {p.pullQuote}
                </blockquote>
              )}
              {p.bodyHtml && (
                <div
                  style={{
                    fontFamily: SERIF,
                    fontSize: 17,
                    lineHeight: 1.75,
                    color: tint(INK, 0.88),
                  }}
                  dangerouslySetInnerHTML={{ __html: p.bodyHtml }}
                />
              )}
            </section>
          ))}
        </article>
      )}
    </div>
  );
}

function IssueList({ slug }: { slug: string }) {
  const [issues, setIssues] = useState<IssueSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setOpenId(null);
    fetch(`/api/newsletter/p/${encodeURIComponent(slug)}/issues`, {
      credentials: "include",
    })
      .then(async (r) => (r.ok ? r.json() : { issues: [] }))
      .then((d) => {
        if (!alive) return;
        setIssues(Array.isArray(d.issues) ? d.issues : []);
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setIssues([]);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [slug]);

  if (openId != null) {
    return (
      <IssueReader slug={slug} issueId={openId} onBack={() => setOpenId(null)} />
    );
  }

  if (loading) {
    return <p style={{ color: MUTED, fontFamily: SANS }}>Loading issues…</p>;
  }
  if (issues.length === 0) {
    return (
      <p style={{ color: MUTED, fontFamily: SANS }}>
        No issues have been published here yet — they'll appear as soon as
        they're sent.
      </p>
    );
  }
  return (
    <div style={{ display: "grid", gap: 14 }}>
      {issues.map((i) => (
        <button
          key={i.id}
          onClick={() => setOpenId(i.id)}
          data-testid="members-issue-card"
          style={{
            display: "flex",
            gap: 16,
            textAlign: "left",
            background: "#fff",
            border: "1px solid rgba(10,10,15,0.10)",
            borderRadius: 14,
            padding: 16,
            cursor: "pointer",
            alignItems: "center",
          }}
        >
          {i.heroImageUrl && (
            <img
              src={i.heroImageUrl}
              alt=""
              style={{
                width: 96,
                height: 96,
                objectFit: "cover",
                borderRadius: 10,
                flexShrink: 0,
              }}
            />
          )}
          <div>
            {i.sentAt && (
              <div
                style={{
                  fontSize: 11.5,
                  letterSpacing: ".07em",
                  textTransform: "uppercase",
                  color: MUTED,
                  fontFamily: SANS,
                  marginBottom: 5,
                }}
              >
                {formatIssueDate(i.sentAt)}
              </div>
            )}
            <div
              style={{
                fontFamily: SERIF,
                fontSize: 20,
                fontWeight: 500,
                color: INK,
                lineHeight: 1.25,
                marginBottom: 4,
              }}
            >
              {i.title}
            </div>
            {i.previewText && (
              <div
                style={{
                  fontSize: 14,
                  color: MUTED,
                  fontFamily: SANS,
                  lineHeight: 1.5,
                }}
              >
                {i.previewText}
              </div>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function Members() {
  const [email, setEmail] = useState<string | null>(null);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    document.title = "Reading room · Palonur";
    document.body.style.background = PAPER;
    return () => {
      document.body.style.background = "";
    };
  }, []);

  useEffect(() => {
    let alive = true;
    fetch("/api/members/portal", { credentials: "include" })
      .then(async (r) => {
        if (r.status === 401) {
          window.location.href = "/members-login";
          return null;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        if (!alive || !d) return;
        setEmail(d.email ?? null);
        const list: Subscription[] = Array.isArray(d.subscriptions)
          ? d.subscriptions
          : [];
        setSubs(list);
        setActiveSlug((prev) => prev ?? list[0]?.slug ?? null);
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function logout() {
    await fetch("/api/members-auth/logout", {
      method: "POST",
      credentials: "include",
    }).catch(() => {});
    window.location.href = "/";
  }

  const activePub = useMemo(
    () => subs.find((s) => s.slug === activeSlug) ?? null,
    [subs, activeSlug],
  );

  return (
    <div style={{ minHeight: "100vh", background: PAPER, color: INK }}>
      <header
        style={{
          maxWidth: 1100,
          margin: "0 auto",
          padding: "26px 24px 0",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <a
          href="/"
          style={{
            textDecoration: "none",
            color: INK,
            fontWeight: 700,
            fontSize: 18,
            fontFamily: SANS,
          }}
        >
          Palonur
        </a>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            fontFamily: SANS,
            fontSize: 13.5,
          }}
        >
          {email && <span style={{ color: MUTED }}>{email}</span>}
          <button
            onClick={logout}
            style={{
              background: "none",
              border: "1px solid rgba(10,10,15,0.18)",
              borderRadius: 999,
              padding: "6px 14px",
              fontFamily: SANS,
              fontSize: 13,
              color: INK,
              cursor: "pointer",
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      <main style={{ maxWidth: 1100, margin: "0 auto", padding: "32px 24px 80px" }}>
        <div
          style={{
            fontSize: 11,
            letterSpacing: ".18em",
            color: RED,
            fontWeight: 700,
            textTransform: "uppercase",
          }}
        >
          Your reading room
        </div>
        <h1
          style={{
            fontFamily: SERIF,
            fontSize: "clamp(30px, 5vw, 46px)",
            fontWeight: 500,
            lineHeight: 1.12,
            margin: "10px 0 28px",
            color: INK,
          }}
        >
          Welcome back.
        </h1>

        <AskBox />

        <div style={{ marginTop: 48 }}>
          {loading ? (
            <p style={{ color: MUTED, fontFamily: SANS }}>Loading…</p>
          ) : subs.length === 0 ? (
            <div
              style={{
                background: "#fff",
                border: "1px solid rgba(10,10,15,0.10)",
                borderRadius: 14,
                padding: "28px 24px",
                fontFamily: SANS,
              }}
            >
              <p
                style={{
                  fontFamily: SERIF,
                  fontSize: 20,
                  color: INK,
                  margin: "0 0 8px",
                }}
              >
                You're not subscribed to any publications yet.
              </p>
              <p style={{ color: MUTED, fontSize: 15, margin: 0 }}>
                Subscribe to a Palonur newsletter and its issues will appear
                here.
              </p>
            </div>
          ) : (
            <>
              <h2
                style={{
                  fontFamily: SERIF,
                  fontSize: 24,
                  fontWeight: 500,
                  color: INK,
                  margin: "0 0 16px",
                }}
              >
                Your newsletters
              </h2>
              {subs.length > 1 && (
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 8,
                    marginBottom: 22,
                  }}
                >
                  {subs.map((s) => {
                    const active = s.slug === activeSlug;
                    return (
                      <button
                        key={s.id}
                        onClick={() => setActiveSlug(s.slug)}
                        style={{
                          background: active ? RED : "#fff",
                          color: active ? "#fff" : INK,
                          border: `1px solid ${active ? RED : "rgba(10,10,15,0.16)"}`,
                          borderRadius: 999,
                          padding: "8px 16px",
                          fontFamily: SANS,
                          fontSize: 13.5,
                          fontWeight: 600,
                          cursor: "pointer",
                        }}
                      >
                        {s.name}
                      </button>
                    );
                  })}
                </div>
              )}
              {activePub && (
                <div style={{ marginBottom: 18 }}>
                  <div
                    style={{
                      fontFamily: SERIF,
                      fontSize: 22,
                      color: INK,
                      fontWeight: 500,
                    }}
                  >
                    {activePub.name}
                  </div>
                  {activePub.tagline && (
                    <div
                      style={{
                        fontSize: 14.5,
                        color: MUTED,
                        fontFamily: SANS,
                        marginTop: 4,
                      }}
                    >
                      {activePub.tagline}
                    </div>
                  )}
                </div>
              )}
              {activeSlug && <IssueList key={activeSlug} slug={activeSlug} />}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
