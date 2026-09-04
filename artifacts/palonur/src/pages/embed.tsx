/**
 * Public embed page — designed to be iframed onto a faculty member's
 * own website. No site nav, no footer, no hero. Reads `?pillar=<slug>`,
 * fetches `/api/embed/pillar/<slug>`, and renders the steward's curated
 * Q&A as a stack of expandable cards.
 *
 * Stanford-cardinal palette inherited from the faculty portal so the
 * widget reads as "the faculty member's Stanford-grounded answer
 * surface" regardless of the host site's brand.
 */
import { useEffect, useState } from "react";

interface Interpretation {
  id: number;
  answer: string;
  interpretation: string;
  action: string | null;
  tags: string[];
  sourceId: number;
  sourceTitle: string;
  sourceAuthors: string | null;
  sourceYear: number | null;
  sourceDoi: string | null;
  sourceUrl: string | null;
}

interface EmbedData {
  pillar: { slug: string; name: string };
  steward: { name: string | null } | null;
  interpretations: Interpretation[];
}

/** Only allow http(s) source links — defense in depth in case a bad
 * URL slipped past upstream validation. */
function safeHref(u: string | null): string | null {
  if (!u) return null;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? u
      : null;
  } catch {
    return null;
  }
}

const PAPER = "#FBF7F0";
const CARDINAL = "#8C1515";
const TEXT = "#572020";
const MUTED = "#8a6a5a";
const HAIRLINE = "#E8DDD0";

export default function Embed() {
  const [data, setData] = useState<EmbedData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);

  const params = new URLSearchParams(window.location.search);
  const pillar = params.get("pillar") || "communication";

  useEffect(() => {
    // Strip site chrome aggressively — this surface is meant to render
    // inside someone else's site. No body padding, no global cream
    // background bleed.
    const prevTitle = document.title;
    document.title = `Palonur embed · ${pillar}`;
    document.body.style.margin = "0";
    document.body.style.padding = "0";
    document.body.style.background = "transparent";
    document.documentElement.style.background = "transparent";
    return () => {
      document.title = prevTitle;
    };
  }, [pillar]);

  useEffect(() => {
    fetch(`/api/embed/pillar/${encodeURIComponent(pillar)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as EmbedData;
      })
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [pillar]);

  if (error) {
    return (
      <div style={{ padding: 24, fontFamily: "system-ui", color: MUTED }}>
        Could not load Palonur embed: {error}
      </div>
    );
  }
  if (!data) {
    return (
      <div style={{ padding: 24, fontFamily: "system-ui", color: MUTED }}>
        Loading…
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const filtered = q
    ? data.interpretations.filter(
        (it) =>
          it.answer.toLowerCase().includes(q) ||
          it.interpretation.toLowerCase().includes(q) ||
          it.sourceTitle.toLowerCase().includes(q) ||
          it.tags.some((t) => t.toLowerCase().includes(q)),
      )
    : data.interpretations;

  return (
    <div
      style={{
        fontFamily:
          "ui-serif, Georgia, 'Times New Roman', serif",
        background: PAPER,
        color: TEXT,
        minHeight: "100vh",
        padding: "24px clamp(16px, 4vw, 32px) 48px",
        boxSizing: "border-box",
      }}
      data-testid="embed-root"
    >
      <header style={{ marginBottom: 20 }}>
        <div
          style={{
            fontSize: 11,
            letterSpacing: "0.25em",
            color: CARDINAL,
            textTransform: "uppercase",
            marginBottom: 6,
          }}
        >
          Powered by Palonur · Stanford-grounded
        </div>
        <h1 style={{ margin: 0, fontSize: 28, fontWeight: 500 }}>
          {data.steward?.name
            ? `${data.steward.name} — ${data.pillar.name}`
            : data.pillar.name}
        </h1>
        <p
          style={{
            margin: "6px 0 0",
            color: MUTED,
            fontSize: 14,
            fontFamily: "system-ui, sans-serif",
          }}
        >
          {data.interpretations.length} approved answer
          {data.interpretations.length === 1 ? "" : "s"}, each grounded in a
          published source.
        </p>
      </header>

      <input
        type="search"
        placeholder="Search answers…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{
          width: "100%",
          padding: "10px 14px",
          fontSize: 14,
          fontFamily: "system-ui, sans-serif",
          border: `1px solid ${HAIRLINE}`,
          borderRadius: 8,
          background: "white",
          color: TEXT,
          marginBottom: 20,
          boxSizing: "border-box",
        }}
        data-testid="input-embed-search"
      />

      {filtered.length === 0 && (
        <p style={{ color: MUTED, fontFamily: "system-ui, sans-serif" }}>
          {data.interpretations.length === 0
            ? "No published answers yet."
            : "No answers match that search."}
        </p>
      )}

      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {filtered.map((it) => {
          const isOpen = openId === it.id;
          return (
            <li
              key={it.id}
              style={{
                border: `1px solid ${HAIRLINE}`,
                borderRadius: 10,
                marginBottom: 12,
                background: "white",
                overflow: "hidden",
              }}
              data-testid={`embed-card-${it.id}`}
            >
              <button
                type="button"
                onClick={() => setOpenId(isOpen ? null : it.id)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "14px 18px",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: TEXT,
                  fontFamily: "inherit",
                  fontSize: 16,
                  lineHeight: 1.4,
                }}
              >
                {it.answer}
              </button>
              {isOpen && (
                <div
                  style={{
                    padding: "0 18px 16px",
                    fontFamily: "system-ui, sans-serif",
                    fontSize: 14,
                    color: TEXT,
                  }}
                >
                  <p style={{ margin: "0 0 12px", lineHeight: 1.55 }}>
                    {it.interpretation}
                  </p>
                  {it.action && (
                    <p
                      style={{
                        margin: "0 0 12px",
                        padding: "10px 12px",
                        background: PAPER,
                        borderLeft: `3px solid ${CARDINAL}`,
                        borderRadius: 4,
                        lineHeight: 1.5,
                      }}
                    >
                      <strong>Try this:</strong> {it.action}
                    </p>
                  )}
                  <p
                    style={{
                      margin: 0,
                      fontSize: 12,
                      color: MUTED,
                    }}
                  >
                    Source:{" "}
                    {(() => {
                      const href = safeHref(it.sourceUrl);
                      return href ? (
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: CARDINAL }}
                        >
                          {it.sourceTitle}
                        </a>
                      ) : (
                        <>{it.sourceTitle}</>
                      );
                    })()}
                    {it.sourceAuthors ? ` — ${it.sourceAuthors}` : ""}
                    {it.sourceYear ? ` (${it.sourceYear})` : ""}
                  </p>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <footer
        style={{
          marginTop: 24,
          fontFamily: "system-ui, sans-serif",
          fontSize: 11,
          color: MUTED,
          textAlign: "center",
        }}
      >
        <a
          href="https://palonur.com"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: MUTED }}
        >
          palonur.com
        </a>
      </footer>
    </div>
  );
}
