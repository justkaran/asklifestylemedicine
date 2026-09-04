import { useCallback, useEffect, useState } from "react";

const TEAL = "#0E7C7B";
const TEAL_DK = "#0a5c5b";
const INK = "#0a0a0f";
const PAPER = "#FAF8F4";
const MUTED = "rgba(10,10,15,0.62)";
const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "-apple-system, BlinkMacSystemFont, 'Inter', sans-serif";

type Status = "offered" | "accepted" | "declined";

type ParentDataOffer = {
  id: number;
  facultyUserId: number;
  authorName: string | null;
  authorEmail: string | null;
  authorInstitution: string | null;
  title: string;
  summary: string | null;
  bodyHtml: string | null;
  callId: number | null;
  status: Status;
  reviewerNote: string | null;
  paymentCents: number | null;
  createdAt: string;
};

type CallStatus = "open" | "closed";

type ParentDataCall = {
  id: number;
  title: string;
  brief: string | null;
  budgetCents: number | null;
  status: CallStatus;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

type OfferMessage = {
  id: number;
  offerId: number;
  senderRole: "faculty" | "reviewer";
  senderName: string | null;
  senderEmail: string | null;
  body: string;
  createdAt: string;
};

// The editor thinks in Pending / Approved / Declined; storage stays
// offered / accepted / declined.
const STATUS_LABEL: Record<Status, string> = {
  offered: "Pending",
  accepted: "Approved",
  declined: "Declined",
};

const statusPill: Record<Status, { bg: string; fg: string }> = {
  offered: { bg: "#F3E9D8", fg: "#8a6a5a" },
  accepted: { bg: "#DCEFEC", fg: TEAL_DK },
  declined: { bg: "#F3E0DE", fg: "#8C1515" },
};

const card: React.CSSProperties = {
  background: "#fff",
  border: "1px solid rgba(10,10,15,0.1)",
  borderRadius: 12,
  padding: 16,
};

const primaryBtn: React.CSSProperties = {
  background: TEAL,
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

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Payment is record-only — never a real charge. Cents → "$1,250".
function formatMoney(cents: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

// A dollars string from a text input → integer cents, or an error.
// Empty string means "leave undecided" (null).
function dollarsToCents(
  raw: string,
): { ok: true; cents: number | undefined } | { ok: false; error: string } {
  const trimmed = raw.trim().replace(/^\$/, "").replace(/,/g, "");
  if (trimmed === "") return { ok: true, cents: undefined };
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, error: "Enter a dollar amount of 0 or more." };
  }
  return { ok: true, cents: Math.round(value * 100) };
}

// Faculty stewards may paste rich HTML drafts. The body is rendered into the
// editor's browser, so it is a stored-XSS vector — sanitize to a small
// formatting whitelist before rendering.
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

function StatusBadge({ status }: { status: Status }) {
  const p = statusPill[status];
  return (
    <span
      style={{
        fontSize: 11,
        textTransform: "uppercase",
        letterSpacing: ".1em",
        padding: "3px 8px",
        borderRadius: 6,
        background: p.bg,
        color: p.fg,
        fontWeight: 700,
        whiteSpace: "nowrap",
      }}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

// ── Conversation panel ────────────────────────────────────────────────────────

function Conversation({ offer }: { offer: ParentDataOffer }) {
  const [messages, setMessages] = useState<OfferMessage[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    api(`/api/parentdata/offers/${offer.id}/messages`)
      .then((d) => setMessages(d.messages))
      .catch(() => setMessages([]));
  }, [offer.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function send() {
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    setErr(null);
    try {
      await api(`/api/parentdata/offers/${offer.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      setDraft("");
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={{ marginTop: 8 }}>
      <div
        style={{
          fontSize: 11,
          letterSpacing: ".14em",
          textTransform: "uppercase",
          color: TEAL_DK,
          fontWeight: 700,
          marginBottom: 10,
        }}
      >
        Conversation
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          maxHeight: 320,
          overflowY: "auto",
          paddingRight: 4,
        }}
        data-testid="conversation-thread"
      >
        {messages === null ? (
          <p style={{ color: MUTED, fontSize: 13 }}>Loading…</p>
        ) : messages.length === 0 ? (
          <p style={{ color: MUTED, fontSize: 13 }}>
            No messages yet. Start the conversation with the author below.
          </p>
        ) : (
          messages.map((m) => {
            const mine = m.senderRole === "reviewer";
            return (
              <div
                key={m.id}
                style={{
                  alignSelf: mine ? "flex-end" : "flex-start",
                  maxWidth: "82%",
                  background: mine ? TEAL : "#F1EEE8",
                  color: mine ? "#fff" : INK,
                  borderRadius: 12,
                  padding: "9px 12px",
                }}
                data-testid={`message-${m.id}`}
              >
                <div
                  style={{
                    fontSize: 11,
                    opacity: 0.8,
                    marginBottom: 3,
                    fontWeight: 600,
                  }}
                >
                  {mine ? "You" : m.senderName ?? "Author"} ·{" "}
                  {formatDateTime(m.createdAt)}
                </div>
                <div
                  style={{
                    fontSize: 14,
                    lineHeight: 1.5,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {m.body}
                </div>
              </div>
            );
          })
        )}
      </div>
      <div style={{ marginTop: 10 }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Write a message to the author…"
          rows={2}
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "10px 12px",
            border: "1px solid rgba(10,10,15,0.15)",
            borderRadius: 10,
            fontSize: 14,
            fontFamily: SANS,
            background: "#fff",
            resize: "vertical",
          }}
          data-testid="message-input"
        />
        {err && (
          <div style={{ color: "#8C1515", fontSize: 13, marginTop: 6 }}>
            {err}
          </div>
        )}
        <button
          onClick={send}
          disabled={sending || !draft.trim()}
          style={{
            ...primaryBtn,
            marginTop: 8,
            opacity: sending || !draft.trim() ? 0.5 : 1,
          }}
          data-testid="message-send"
        >
          {sending ? "Sending…" : "Send message"}
        </button>
      </div>
    </div>
  );
}

export default function ParentData() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [offers, setOffers] = useState<ParentDataOffer[]>([]);
  const [calls, setCalls] = useState<ParentDataCall[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [reading, setReading] = useState<ParentDataOffer | null>(null);
  const [accepting, setAccepting] = useState<ParentDataOffer | null>(null);
  const [acceptNote, setAcceptNote] = useState("");
  const [acceptPay, setAcceptPay] = useState("");
  const [acceptErr, setAcceptErr] = useState<string | null>(null);
  const [callTitle, setCallTitle] = useState("");
  const [callBrief, setCallBrief] = useState("");
  const [callBudget, setCallBudget] = useState("");
  const [callBusy, setCallBusy] = useState(false);
  const [callErr, setCallErr] = useState<string | null>(null);
  const [callPatchBusy, setCallPatchBusy] = useState<number | null>(null);
  const [banner, setBanner] = useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);

  useEffect(() => {
    document.title = "ParentData proposals · Palonur";
    document.body.style.background = PAPER;
    return () => {
      document.body.style.background = "";
    };
  }, []);

  const load = useCallback(() => {
    api("/api/parentdata/offers")
      .then((d) => setOffers(d.offers))
      .catch(() => {});
  }, []);

  const loadCalls = useCallback(() => {
    api("/api/parentdata/calls")
      .then((d) => setCalls(d.calls))
      .catch(() => {});
  }, []);

  useEffect(() => {
    api("/api/parentdata-auth/me")
      .then((d) => {
        setAuthed(true);
        setEmail(d.email ?? null);
        load();
        loadCalls();
      })
      .catch(() => {
        setAuthed(false);
        window.location.href = "/parentdata-login";
      });
  }, [load, loadCalls]);

  // The title → call map lets the queue label which solicitation a proposal answers.
  const callTitleById = new Map(calls.map((c) => [c.id, c.title]));

  function openAccept(o: ParentDataOffer) {
    setAccepting(o);
    setAcceptNote("");
    // Pre-fill the payment field with the advertised budget of the call it answers.
    const call = o.callId != null ? calls.find((c) => c.id === o.callId) : null;
    setAcceptPay(
      call?.budgetCents != null ? String(call.budgetCents / 100) : "",
    );
    setAcceptErr(null);
  }

  async function confirmAccept() {
    if (!accepting) return;
    const parsed = dollarsToCents(acceptPay);
    if (!parsed.ok) {
      setAcceptErr(parsed.error);
      return;
    }
    const o = accepting;
    setBusy(o.id);
    setAcceptErr(null);
    try {
      const body: {
        note: string;
        paymentCents?: number;
      } = { note: acceptNote };
      if (parsed.cents !== undefined) body.paymentCents = parsed.cents;
      await api(`/api/parentdata/offers/${o.id}/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payText =
        parsed.cents === undefined
          ? "payment undecided"
          : parsed.cents === 0
            ? "no payment"
            : formatMoney(parsed.cents);
      setBanner({
        kind: "ok",
        text: `Approved "${o.title}" · ${payText}.`,
      });
      setReading((cur) =>
        cur && cur.id === o.id
          ? {
              ...cur,
              status: "accepted",
              paymentCents: parsed.cents ?? null,
            }
          : cur,
      );
      setAccepting(null);
      load();
    } catch (e) {
      setAcceptErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function decline(o: ParentDataOffer) {
    const note = window.prompt(
      "Reason for declining (optional, shared with the author):",
      "",
    );
    if (note === null) return;
    setBusy(o.id);
    try {
      await api(`/api/parentdata/offers/${o.id}/decline`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note }),
      });
      setBanner({ kind: "ok", text: `Declined "${o.title}".` });
      setReading((cur) =>
        cur && cur.id === o.id ? { ...cur, status: "declined" } : cur,
      );
      load();
    } catch (e) {
      setBanner({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function createCall() {
    const title = callTitle.trim();
    if (!title) {
      setCallErr("Give the call a title.");
      return;
    }
    const parsed = dollarsToCents(callBudget);
    if (!parsed.ok) {
      setCallErr(parsed.error);
      return;
    }
    setCallBusy(true);
    setCallErr(null);
    try {
      const body: {
        title: string;
        brief?: string;
        budgetCents?: number;
      } = { title };
      const brief = callBrief.trim();
      if (brief) body.brief = brief;
      if (parsed.cents !== undefined) body.budgetCents = parsed.cents;
      await api("/api/parentdata/calls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      setCallTitle("");
      setCallBrief("");
      setCallBudget("");
      setBanner({ kind: "ok", text: `Call posted: "${title}".` });
      loadCalls();
    } catch (e) {
      setCallErr((e as Error).message);
    } finally {
      setCallBusy(false);
    }
  }

  async function toggleCall(c: ParentDataCall) {
    const next: CallStatus = c.status === "open" ? "closed" : "open";
    setCallPatchBusy(c.id);
    try {
      await api(`/api/parentdata/calls/${c.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      loadCalls();
    } catch (e) {
      setBanner({ kind: "err", text: (e as Error).message });
    } finally {
      setCallPatchBusy(null);
    }
  }

  async function logout() {
    await api("/api/parentdata-auth/logout", { method: "POST" }).catch(
      () => {},
    );
    window.location.href = "/parentdata-login";
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

  function authorLine(o: ParentDataOffer) {
    return (
      o.authorName ?? o.authorEmail ?? `Faculty #${o.facultyUserId}`
    );
  }

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
                color: TEAL,
                fontWeight: 700,
                textTransform: "uppercase",
                marginTop: 12,
              }}
            >
              ParentData · article proposals
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            {email && <div style={{ fontSize: 13, color: MUTED }}>{email}</div>}
            <button
              onClick={logout}
              style={{
                marginTop: 6,
                background: "none",
                border: "none",
                color: TEAL,
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
          Proposals for ParentData.
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
          Stanford faculty stewards propose articles here. Review each one,
          approve or decline it, and message the author directly. This queue is
          yours alone.
        </p>

        {banner && (
          <div
            style={{
              margin: "20px 0 0",
              padding: "10px 14px",
              borderRadius: 8,
              fontSize: 14,
              background: banner.kind === "ok" ? "#DCEFEC" : "#F3E0DE",
              color: banner.kind === "ok" ? TEAL_DK : "#8C1515",
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
          Calls for articles
        </h2>
        <p style={{ color: MUTED, fontSize: 14, margin: "0 0 14px" }}>
          Post a topic you want written. Every active faculty steward is
          emailed once; they can answer it with a proposal. Budgets are
          advertised amounts — nothing is charged automatically.
        </p>
        <div style={{ ...card, display: "grid", gap: 10 }}>
          <input
            value={callTitle}
            onChange={(e) => setCallTitle(e.target.value)}
            placeholder="Call title — e.g. “Toddler sleep regressions”"
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "10px 12px",
              border: "1px solid rgba(10,10,15,0.15)",
              borderRadius: 10,
              fontSize: 14,
              fontFamily: SANS,
              background: "#fff",
            }}
            data-testid="call-title"
          />
          <textarea
            value={callBrief}
            onChange={(e) => setCallBrief(e.target.value)}
            placeholder="Brief (optional) — what you're looking for, length, angle…"
            rows={2}
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "10px 12px",
              border: "1px solid rgba(10,10,15,0.15)",
              borderRadius: 10,
              fontSize: 14,
              fontFamily: SANS,
              background: "#fff",
              resize: "vertical",
            }}
            data-testid="call-brief"
          />
          <div
            style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
          >
            <div style={{ position: "relative" }}>
              <span
                style={{
                  position: "absolute",
                  left: 12,
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: MUTED,
                  fontSize: 14,
                }}
                aria-hidden
              >
                $
              </span>
              <input
                value={callBudget}
                onChange={(e) => setCallBudget(e.target.value)}
                placeholder="Budget (optional)"
                inputMode="decimal"
                style={{
                  width: 200,
                  boxSizing: "border-box",
                  padding: "10px 12px 10px 24px",
                  border: "1px solid rgba(10,10,15,0.15)",
                  borderRadius: 10,
                  fontSize: 14,
                  fontFamily: SANS,
                  background: "#fff",
                }}
                data-testid="call-budget"
              />
            </div>
            <button
              onClick={createCall}
              disabled={callBusy || !callTitle.trim()}
              style={{
                ...primaryBtn,
                opacity: callBusy || !callTitle.trim() ? 0.5 : 1,
              }}
              data-testid="call-create"
            >
              {callBusy ? "Posting…" : "Post call & notify faculty"}
            </button>
          </div>
          {callErr && (
            <div style={{ color: "#8C1515", fontSize: 13 }}>{callErr}</div>
          )}
        </div>

        {calls.length > 0 && (
          <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
            {calls.map((c) => (
              <div
                key={c.id}
                style={{
                  ...card,
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  alignItems: "baseline",
                  opacity: c.status === "closed" ? 0.6 : 1,
                }}
                data-testid={`call-${c.id}`}
              >
                <div>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{c.title}</div>
                  {c.brief && (
                    <div
                      style={{
                        color: MUTED,
                        fontSize: 13,
                        marginTop: 4,
                        lineHeight: 1.5,
                      }}
                    >
                      {c.brief}
                    </div>
                  )}
                  <div style={{ color: MUTED, fontSize: 12, marginTop: 4 }}>
                    {c.budgetCents != null
                      ? `Budget ${formatMoney(c.budgetCents)}`
                      : "No budget set"}{" "}
                    · Posted {formatDate(c.createdAt)}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <span
                    style={{
                      fontSize: 11,
                      textTransform: "uppercase",
                      letterSpacing: ".1em",
                      padding: "3px 8px",
                      borderRadius: 6,
                      background: c.status === "open" ? "#DCEFEC" : "#F1EEE8",
                      color: c.status === "open" ? TEAL_DK : MUTED,
                      fontWeight: 700,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {c.status === "open" ? "Open" : "Closed"}
                  </span>
                  <button
                    onClick={() => toggleCall(c)}
                    disabled={callPatchBusy === c.id}
                    style={{
                      background: "none",
                      border: "none",
                      color: TEAL,
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: "pointer",
                      padding: 0,
                      opacity: callPatchBusy === c.id ? 0.5 : 1,
                    }}
                    data-testid={`call-toggle-${c.id}`}
                  >
                    {c.status === "open" ? "Close" : "Reopen"}
                  </button>
                </div>
              </div>
            ))}
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
          Pending review
        </h2>
        {pending.length === 0 ? (
          <p style={{ color: MUTED, fontSize: 14 }}>
            No proposals awaiting review.
          </p>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {pending.map((o) => (
              <div key={o.id} style={card} data-testid={`offer-${o.id}`}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                    alignItems: "baseline",
                  }}
                >
                  <div style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 600 }}>
                    {o.title}
                  </div>
                  <StatusBadge status={o.status} />
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
                    {authorLine(o)}
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
                {o.callId != null && callTitleById.has(o.callId) && (
                  <div
                    style={{
                      display: "inline-block",
                      marginTop: 8,
                      fontSize: 12,
                      fontWeight: 600,
                      color: TEAL_DK,
                      background: "#DCEFEC",
                      borderRadius: 6,
                      padding: "3px 8px",
                    }}
                    data-testid={`offer-call-${o.id}`}
                  >
                    Answers: {callTitleById.get(o.callId)}
                  </div>
                )}
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
                    onClick={() => openAccept(o)}
                    disabled={busy === o.id}
                    style={{ ...primaryBtn, opacity: busy === o.id ? 0.5 : 1 }}
                    data-testid={`offer-accept-${o.id}`}
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => decline(o)}
                    disabled={busy === o.id}
                    style={secondaryBtn}
                    data-testid={`offer-decline-${o.id}`}
                  >
                    Decline
                  </button>
                  <button
                    onClick={() => setReading(o)}
                    style={{
                      ...secondaryBtn,
                      border: "none",
                      color: TEAL,
                      padding: "9px 10px",
                    }}
                    data-testid={`offer-open-${o.id}`}
                  >
                    Open & message →
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
              {resolved.map((o) => (
                <div
                  key={o.id}
                  style={{
                    ...card,
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    alignItems: "baseline",
                  }}
                  data-testid={`offer-${o.id}`}
                >
                  <div>
                    <button
                      onClick={() => setReading(o)}
                      style={{
                        background: "none",
                        border: "none",
                        padding: 0,
                        fontWeight: 600,
                        fontSize: 15,
                        color: INK,
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                      data-testid={`offer-open-${o.id}`}
                    >
                      {o.title}
                    </button>
                    <span style={{ color: MUTED, fontSize: 13, marginLeft: 8 }}>
                      {authorLine(o)}
                      {o.authorInstitution ? ` · ${o.authorInstitution}` : ""}
                    </span>
                    <div style={{ color: MUTED, fontSize: 12, marginTop: 4 }}>
                      Submitted {formatDate(o.createdAt)}
                      {o.callId != null && callTitleById.has(o.callId)
                        ? ` · answers “${callTitleById.get(o.callId)}”`
                        : ""}
                    </div>
                    {o.status === "accepted" && (
                      <div
                        style={{
                          color: o.paymentCents ? TEAL_DK : MUTED,
                          fontSize: 12,
                          fontWeight: o.paymentCents ? 600 : 400,
                          marginTop: 4,
                        }}
                        data-testid={`offer-payment-${o.id}`}
                      >
                        {o.paymentCents == null
                          ? "Payment: undecided"
                          : o.paymentCents === 0
                            ? "Payment: none"
                            : `Payment: ${formatMoney(o.paymentCents)}`}
                      </div>
                    )}
                    {o.reviewerNote && (
                      <div style={{ color: MUTED, fontSize: 12, marginTop: 4 }}>
                        Note: {o.reviewerNote}
                      </div>
                    )}
                  </div>
                  <StatusBadge status={o.status} />
                </div>
              ))}
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
                {authorLine(reading)}
              </span>
              {reading.authorInstitution && (
                <>
                  <span aria-hidden>·</span>
                  <span>{reading.authorInstitution}</span>
                </>
              )}
              <span aria-hidden>·</span>
              <span>Submitted {formatDate(reading.createdAt)}</span>
              {reading.callId != null && callTitleById.has(reading.callId) && (
                <>
                  <span aria-hidden>·</span>
                  <span>answers “{callTitleById.get(reading.callId)}”</span>
                </>
              )}
              <StatusBadge status={reading.status} />
              {reading.status === "accepted" && (
                <span
                  style={{
                    fontWeight: 600,
                    color: reading.paymentCents ? TEAL_DK : MUTED,
                  }}
                  data-testid="reading-payment"
                >
                  {reading.paymentCents == null
                    ? "Payment undecided"
                    : reading.paymentCents === 0
                      ? "No payment"
                      : `Payment ${formatMoney(reading.paymentCents)}`}
                </span>
              )}
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

            {reading.status === "offered" && (
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  marginTop: 24,
                  flexWrap: "wrap",
                }}
              >
                <button
                  onClick={() => openAccept(reading)}
                  disabled={busy === reading.id}
                  style={{
                    ...primaryBtn,
                    opacity: busy === reading.id ? 0.5 : 1,
                  }}
                  data-testid="reading-accept"
                >
                  Approve
                </button>
                <button
                  onClick={() => decline(reading)}
                  disabled={busy === reading.id}
                  style={secondaryBtn}
                  data-testid="reading-decline"
                >
                  Decline
                </button>
              </div>
            )}

            <hr
              style={{
                border: "none",
                borderTop: "1px solid rgba(10,10,15,0.1)",
                margin: "24px 0 16px",
              }}
            />
            <Conversation offer={reading} />
          </div>
        </div>
      )}

      {accepting && (
        <div
          onClick={() => setAccepting(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(10,10,15,0.64)",
            display: "flex",
            justifyContent: "center",
            alignItems: "flex-start",
            padding: "60px 16px",
            overflowY: "auto",
            zIndex: 60,
          }}
          data-testid="accept-modal"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#fff",
              borderRadius: 14,
              maxWidth: 460,
              width: "100%",
              padding: "28px 30px",
              boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
            }}
          >
            <h2
              style={{
                fontFamily: SERIF,
                fontSize: 22,
                fontWeight: 600,
                margin: 0,
              }}
            >
              Approve “{accepting.title}”
            </h2>
            <p style={{ color: MUTED, fontSize: 14, margin: "8px 0 0", lineHeight: 1.5 }}>
              Decide whether to pay the author and how much. This is a recorded
              amount only — nothing is charged. Leave it blank to decide later;
              enter <strong>0</strong> to record “no payment”.
            </p>

            <label
              style={{
                display: "block",
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: ".08em",
                textTransform: "uppercase",
                color: TEAL_DK,
                margin: "20px 0 6px",
              }}
            >
              Payment (USD)
            </label>
            <div style={{ position: "relative" }}>
              <span
                style={{
                  position: "absolute",
                  left: 12,
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: MUTED,
                  fontSize: 15,
                }}
                aria-hidden
              >
                $
              </span>
              <input
                value={acceptPay}
                onChange={(e) => setAcceptPay(e.target.value)}
                placeholder="Leave blank to decide later"
                inputMode="decimal"
                autoFocus
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "11px 12px 11px 24px",
                  border: "1px solid rgba(10,10,15,0.15)",
                  borderRadius: 10,
                  fontSize: 15,
                  fontFamily: SANS,
                  background: "#fff",
                }}
                data-testid="accept-payment"
              />
            </div>

            <label
              style={{
                display: "block",
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: ".08em",
                textTransform: "uppercase",
                color: TEAL_DK,
                margin: "16px 0 6px",
              }}
            >
              Note to author (optional)
            </label>
            <textarea
              value={acceptNote}
              onChange={(e) => setAcceptNote(e.target.value)}
              placeholder="Shared with the author…"
              rows={3}
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "10px 12px",
                border: "1px solid rgba(10,10,15,0.15)",
                borderRadius: 10,
                fontSize: 14,
                fontFamily: SANS,
                background: "#fff",
                resize: "vertical",
              }}
              data-testid="accept-note"
            />

            {acceptErr && (
              <div style={{ color: "#8C1515", fontSize: 13, marginTop: 10 }}>
                {acceptErr}
              </div>
            )}

            <div
              style={{
                display: "flex",
                gap: 8,
                marginTop: 20,
                justifyContent: "flex-end",
              }}
            >
              <button
                onClick={() => setAccepting(null)}
                style={secondaryBtn}
                data-testid="accept-cancel"
              >
                Cancel
              </button>
              <button
                onClick={confirmAccept}
                disabled={busy === accepting.id}
                style={{
                  ...primaryBtn,
                  opacity: busy === accepting.id ? 0.5 : 1,
                }}
                data-testid="accept-confirm"
              >
                {busy === accepting.id ? "Approving…" : "Approve proposal"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
