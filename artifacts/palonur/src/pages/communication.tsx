import { useCallback, useEffect, useState } from "react";

const RED = "#8B1A1A";
const INK = "#0a0a0f";
const PAPER = "#FAF8F4";
const MUTED = "rgba(10,10,15,0.62)";
const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "-apple-system, BlinkMacSystemFont, 'Inter', sans-serif";

type CommunicationOffer = {
  id: number;
  facultyUserId: number;
  authorName: string | null;
  authorEmail: string | null;
  authorInstitution: string | null;
  title: string;
  summary: string | null;
  bodyHtml: string | null;
  status: "offered" | "accepted" | "declined";
  reviewerNote: string | null;
  createdAt: string;
};

const offerPill: Record<
  CommunicationOffer["status"],
  { bg: string; fg: string }
> = {
  offered: { bg: "#F3E9D8", fg: "#8a6a5a" },
  accepted: { bg: "#E3F0E3", fg: "#2f6b3a" },
  declined: { bg: "#F3E0DE", fg: RED },
};

const card: React.CSSProperties = {
  background: "#fff",
  border: "1px solid rgba(10,10,15,0.1)",
  borderRadius: 12,
  padding: 16,
};

const primaryBtn: React.CSSProperties = {
  background: RED,
  color: "#fff",
  border: "none",
  borderRadius: 999,
  padding: "9px 18px",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};

const secondaryBtn: React.CSSProperties = {
  background: "transparent",
  color: INK,
  border: "1px solid rgba(10,10,15,0.2)",
  borderRadius: 999,
  padding: "9px 18px",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};

async function api(path: string, init?: RequestInit) {
  const r = await fetch(path, { credentials: "include", ...init });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? "Request failed");
  return d;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// Faculty stewards may paste rich HTML drafts. The body is rendered into Matt's
// browser, so it is a stored-XSS vector — sanitize to a small formatting
// whitelist before rendering. Falls back to escaped plain text when DOMParser
// is unavailable.
const ALLOWED_TAGS = new Set([
  "P", "BR", "B", "STRONG", "I", "EM", "U", "A", "UL", "OL", "LI",
  "BLOCKQUOTE", "CODE", "PRE", "SPAN", "HR", "H1", "H2", "H3", "H4", "H5", "H6",
]);

function sanitizeHtml(html: string): string {
  if (typeof window === "undefined" || typeof window.DOMParser === "undefined") {
    return html.replace(/[&<>]/g, (c) =>
      c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;",
    );
  }
  const doc = new DOMParser().parseFromString(html, "text/html");

  const clean = (node: Node) => {
    const children = Array.from(node.childNodes);
    for (const child of children) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element;
        const tag = el.tagName.toUpperCase();
        if (!ALLOWED_TAGS.has(tag)) {
          // Drop the element but keep its (cleaned) text content.
          clean(el);
          while (el.firstChild) el.parentNode?.insertBefore(el.firstChild, el);
          el.remove();
          continue;
        }
        for (const attr of Array.from(el.attributes)) {
          const name = attr.name.toLowerCase();
          if (tag === "A" && name === "href") {
            const val = attr.value.trim();
            if (/^(https?:|mailto:)/i.test(val)) {
              el.setAttribute("target", "_blank");
              el.setAttribute("rel", "noopener noreferrer");
            } else {
              el.removeAttribute("href");
            }
          } else {
            el.removeAttribute(attr.name);
          }
        }
        clean(el);
      } else if (
        child.nodeType !== Node.TEXT_NODE &&
        child.nodeType !== Node.CDATA_SECTION_NODE
      ) {
        child.parentNode?.removeChild(child);
      }
    }
  };

  clean(doc.body);
  return doc.body.innerHTML;
}

const articleBody: React.CSSProperties = {
  color: INK,
  fontFamily: SERIF,
  fontSize: 15,
  lineHeight: 1.7,
  wordBreak: "break-word",
};

export default function Communication() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [offers, setOffers] = useState<CommunicationOffer[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [reading, setReading] = useState<CommunicationOffer | null>(null);
  const [banner, setBanner] = useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);

  useEffect(() => {
    document.title = "Article offers · Palonur";
    document.body.style.background = PAPER;
    return () => {
      document.body.style.background = "";
    };
  }, []);

  const load = useCallback(() => {
    api("/api/communication/offers")
      .then((d) => setOffers(d.offers))
      .catch(() => {});
  }, []);

  useEffect(() => {
    api("/api/communication-auth/me")
      .then((d) => {
        setAuthed(true);
        setEmail(d.email ?? null);
        load();
      })
      .catch(() => {
        setAuthed(false);
        window.location.href = "/communication-login";
      });
  }, [load]);

  async function accept(o: CommunicationOffer) {
    const note = window.prompt(
      "Optional note to the author (visible to them):",
      "",
    );
    if (note === null) return;
    setBusy(o.id);
    try {
      await api(`/api/communication/offers/${o.id}/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note }),
      });
      setBanner({ kind: "ok", text: `Accepted "${o.title}".` });
      load();
    } catch (e) {
      setBanner({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function decline(o: CommunicationOffer) {
    const note = window.prompt(
      "Reason for declining (optional, shared with the author):",
      "",
    );
    if (note === null) return;
    setBusy(o.id);
    try {
      await api(`/api/communication/offers/${o.id}/decline`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note }),
      });
      setBanner({ kind: "ok", text: `Declined "${o.title}".` });
      load();
    } catch (e) {
      setBanner({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function logout() {
    await api("/api/communication-auth/logout", { method: "POST" }).catch(
      () => {},
    );
    window.location.href = "/communication-login";
  }

  if (authed === null) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: PAPER,
          fontFamily: SANS,
          color: INK,
          display: "grid",
          placeItems: "center",
        }}
      >
        <p style={{ color: MUTED }}>Loading…</p>
      </div>
    );
  }

  const pending = offers.filter((o) => o.status === "offered");
  const resolved = offers.filter((o) => o.status !== "offered");

  return (
    <div
      style={{ minHeight: "100vh", background: PAPER, fontFamily: SANS, color: INK }}
    >
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "64px 24px" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: 12,
          }}
        >
          <div>
            <a
              href="/"
              style={{
                textDecoration: "none",
                color: INK,
                fontWeight: 700,
                fontSize: 18,
              }}
            >
              Palonur
            </a>
            <div
              style={{
                fontSize: 11,
                letterSpacing: ".18em",
                color: RED,
                fontWeight: 700,
                textTransform: "uppercase",
                marginTop: 12,
              }}
            >
              Article offers
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            {email && (
              <div style={{ fontSize: 13, color: MUTED }}>{email}</div>
            )}
            <button
              onClick={logout}
              style={{
                marginTop: 6,
                background: "none",
                border: "none",
                color: RED,
                fontSize: 13,
                cursor: "pointer",
                padding: 0,
              }}
              data-testid="button-logout"
            >
              Sign out
            </button>
          </div>
        </div>

        <h1
          style={{
            fontFamily: SERIF,
            fontSize: 32,
            fontWeight: 500,
            lineHeight: 1.2,
            margin: "28px 0 8px",
          }}
        >
          Articles offered to you.
        </h1>
        <p
          style={{
            fontFamily: SERIF,
            fontSize: 17,
            color: MUTED,
            lineHeight: 1.55,
            margin: 0,
          }}
        >
          Faculty stewards send communication-focused articles here. This queue
          is yours alone — separate from the SLM newsletter.
        </p>

        {banner && (
          <div
            style={{
              margin: "20px 0 0",
              padding: "10px 14px",
              borderRadius: 8,
              fontSize: 14,
              background: banner.kind === "ok" ? "#E3F0E3" : "#F3E0DE",
              color: banner.kind === "ok" ? "#2f6b3a" : RED,
            }}
          >
            {banner.text}
          </div>
        )}

        <h2
          style={{
            fontFamily: SERIF,
            fontWeight: 500,
            fontSize: 20,
            margin: "32px 0 12px",
          }}
        >
          Pending offers
        </h2>
        {pending.length === 0 ? (
          <p style={{ color: MUTED, fontSize: 14 }}>No offers awaiting review.</p>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {pending.map((o) => (
              <div key={o.id} style={card} data-testid={`offer-${o.id}`}>
                <div style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 600 }}>
                  {o.title}
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    flexWrap: "wrap",
                    alignItems: "center",
                    fontSize: 12,
                    color: MUTED,
                    marginTop: 6,
                  }}
                >
                  <span style={{ fontWeight: 600, color: INK }}>
                    {o.authorName ??
                      o.authorEmail ??
                      `Faculty #${o.facultyUserId}`}
                  </span>
                  {o.authorInstitution && (
                    <>
                      <span aria-hidden>·</span>
                      <span>{o.authorInstitution}</span>
                    </>
                  )}
                  <span aria-hidden>·</span>
                  <span>Submitted {formatDate(o.createdAt)}</span>
                </div>
                {o.summary && (
                  <p
                    style={{
                      color: INK,
                      fontFamily: SERIF,
                      fontSize: 15,
                      lineHeight: 1.55,
                      margin: "10px 0 0",
                    }}
                  >
                    {o.summary}
                  </p>
                )}
                {o.bodyHtml && (
                  <>
                    <div
                      style={{
                        ...articleBody,
                        marginTop: 12,
                        maxHeight: 200,
                        overflow: "hidden",
                        position: "relative",
                        WebkitMaskImage:
                          "linear-gradient(180deg, #000 70%, transparent)",
                        maskImage:
                          "linear-gradient(180deg, #000 70%, transparent)",
                      }}
                      dangerouslySetInnerHTML={{
                        __html: sanitizeHtml(o.bodyHtml),
                      }}
                    />
                    <button
                      onClick={() => setReading(o)}
                      style={{
                        ...secondaryBtn,
                        marginTop: 10,
                        padding: "7px 14px",
                        fontSize: 13,
                      }}
                      data-testid={`offer-read-${o.id}`}
                    >
                      Read full article
                    </button>
                  </>
                )}
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    marginTop: 14,
                    flexWrap: "wrap",
                  }}
                >
                  <button
                    onClick={() => accept(o)}
                    disabled={busy === o.id}
                    style={{ ...primaryBtn, opacity: busy === o.id ? 0.5 : 1 }}
                    data-testid={`offer-accept-${o.id}`}
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => decline(o)}
                    disabled={busy === o.id}
                    style={secondaryBtn}
                    data-testid={`offer-decline-${o.id}`}
                  >
                    Decline
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {resolved.length > 0 && (
          <>
            <h2
              style={{
                fontFamily: SERIF,
                fontWeight: 500,
                fontSize: 20,
                margin: "28px 0 12px",
              }}
            >
              Reviewed
            </h2>
            <div style={{ display: "grid", gap: 8 }}>
              {resolved.map((o) => {
                const p = offerPill[o.status];
                return (
                  <div
                    key={o.id}
                    style={{
                      ...card,
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 12,
                      alignItems: "baseline",
                    }}
                  >
                    <div>
                      <span style={{ fontWeight: 600 }}>{o.title}</span>
                      <span
                        style={{ color: MUTED, fontSize: 13, marginLeft: 8 }}
                      >
                        {o.authorName ??
                          o.authorEmail ??
                          `#${o.facultyUserId}`}
                        {o.authorInstitution ? ` · ${o.authorInstitution}` : ""}
                      </span>
                      <div style={{ color: MUTED, fontSize: 12, marginTop: 4 }}>
                        Submitted {formatDate(o.createdAt)}
                      </div>
                      {o.reviewerNote && (
                        <div
                          style={{ color: MUTED, fontSize: 12, marginTop: 4 }}
                        >
                          Note: {o.reviewerNote}
                        </div>
                      )}
                    </div>
                    <span
                      style={{
                        fontSize: 11,
                        textTransform: "uppercase",
                        letterSpacing: ".1em",
                        padding: "3px 8px",
                        borderRadius: 6,
                        background: p.bg,
                        color: p.fg,
                      }}
                    >
                      {o.status}
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {reading && (
        <div
          onClick={() => setReading(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(10,10,15,0.64)",
            display: "flex",
            justifyContent: "center",
            alignItems: "flex-start",
            padding: "40px 16px",
            overflowY: "auto",
            zIndex: 50,
          }}
          data-testid="reading-modal"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#fff",
              borderRadius: 14,
              maxWidth: 720,
              width: "100%",
              padding: "32px 36px",
              boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: 16,
              }}
            >
              <h2
                style={{
                  fontFamily: SERIF,
                  fontSize: 26,
                  fontWeight: 600,
                  lineHeight: 1.25,
                  margin: 0,
                }}
              >
                {reading.title}
              </h2>
              <button
                onClick={() => setReading(null)}
                style={{
                  background: "none",
                  border: "none",
                  color: MUTED,
                  fontSize: 22,
                  cursor: "pointer",
                  lineHeight: 1,
                  padding: 0,
                }}
                aria-label="Close"
                data-testid="reading-close"
              >
                ×
              </button>
            </div>
            <div
              style={{
                fontSize: 13,
                color: MUTED,
                marginTop: 8,
                display: "flex",
                gap: 6,
                flexWrap: "wrap",
                alignItems: "center",
              }}
            >
              <span style={{ fontWeight: 600, color: INK }}>
                {reading.authorName ??
                  reading.authorEmail ??
                  `Faculty #${reading.facultyUserId}`}
              </span>
              {reading.authorInstitution && (
                <>
                  <span aria-hidden>·</span>
                  <span>{reading.authorInstitution}</span>
                </>
              )}
              <span aria-hidden>·</span>
              <span>Submitted {formatDate(reading.createdAt)}</span>
            </div>
            {reading.summary && (
              <p
                style={{
                  fontFamily: SERIF,
                  fontSize: 16,
                  fontStyle: "italic",
                  color: MUTED,
                  lineHeight: 1.55,
                  margin: "16px 0 0",
                }}
              >
                {reading.summary}
              </p>
            )}
            <hr
              style={{
                border: "none",
                borderTop: "1px solid rgba(10,10,15,0.1)",
                margin: "20px 0",
              }}
            />
            {reading.bodyHtml ? (
              <div
                style={{ ...articleBody, fontSize: 16 }}
                dangerouslySetInnerHTML={{
                  __html: sanitizeHtml(reading.bodyHtml),
                }}
              />
            ) : (
              <p style={{ color: MUTED }}>No article body was provided.</p>
            )}
            <div
              style={{
                display: "flex",
                gap: 8,
                marginTop: 28,
                flexWrap: "wrap",
              }}
            >
              <button
                onClick={() => {
                  const o = reading;
                  setReading(null);
                  accept(o);
                }}
                disabled={busy === reading.id}
                style={{ ...primaryBtn, opacity: busy === reading.id ? 0.5 : 1 }}
                data-testid="reading-accept"
              >
                Accept
              </button>
              <button
                onClick={() => {
                  const o = reading;
                  setReading(null);
                  decline(o);
                }}
                disabled={busy === reading.id}
                style={secondaryBtn}
                data-testid="reading-decline"
              >
                Decline
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
