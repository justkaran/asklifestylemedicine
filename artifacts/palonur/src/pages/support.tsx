import { useCallback, useEffect, useState } from "react";
import {
  RED,
  INK,
  PAPER,
  MUTED,
  SERIF,
  SANS,
} from "@/components/newsletter-subscribe";

/**
 * Support Concierge inbox. A single calm queue that merges:
 *   - reader questions the AI agents returned UNCOVERED (anonymous), and
 *   - new public "Ask Palonur" submissions (with an asker email).
 *
 * Each item arrives pre-triaged (suggested steward/pillar + a draft reply +
 * source context). Support resolves it two ways: reply AS Palonur, or route to
 * the steward who sends it in their own voice. Auth is the isolated
 * `support_session` cookie (see routes/support.ts); a 401 sends to
 * /support-login. This surface NEVER shows money or destructive controls.
 */

interface SourceEntry {
  marker?: string;
  citation?: string;
  title?: string;
  authors?: string | null;
  year?: number | null;
}

interface InboxItem {
  id: number;
  source: "ask" | "uncovered";
  status: "new" | "pending_steward" | "answered" | "closed";
  askerName: string | null;
  askerEmail: string | null;
  message: string;
  suggestedPillarName: string | null;
  suggestedStewardUserId: number | null;
  suggestedStewardName: string | null;
  draftReply: string | null;
  draftMode: "palonur" | "steward";
  sourceContext: SourceEntry[] | null;
  assignedStewardUserId: number | null;
  replyMode: "palonur" | "steward" | null;
  sentReply: string | null;
  answeredBy: string | null;
  createdAt: string;
}

function tint(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  if (h.length !== 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const STATUS_LABEL: Record<InboxItem["status"], string> = {
  new: "Needs reply",
  pending_steward: "With steward",
  answered: "Answered",
  closed: "Closed",
};

function Badge({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: ".08em",
        textTransform: "uppercase",
        color,
        border: `1px solid ${color}`,
        borderRadius: 999,
        padding: "2px 9px",
      }}
    >
      {children}
    </span>
  );
}

function ItemCard({
  item,
  onResolved,
}: {
  item: InboxItem;
  onResolved: (next: InboxItem) => void;
}) {
  const [draft, setDraft] = useState(item.draftReply ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const border = tint(RED, 0.18);
  const resolved = item.status === "answered" || item.status === "closed";

  async function act(
    path: string,
    body: Record<string, unknown>,
    optimistic: (n: InboxItem) => InboxItem,
  ) {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/support/questions/${item.id}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(d.error ?? "Could not complete that.");
        return;
      }
      onResolved(optimistic(d.item ?? item));
    } catch {
      setErr("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article
      style={{
        background: "#fff",
        border: `1px solid ${border}`,
        borderRadius: 16,
        padding: "22px 22px",
        opacity: resolved ? 0.62 : 1,
      }}
    >
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Badge color={item.source === "ask" ? RED : "#8a6a2a"}>
          {item.source === "ask" ? "Ask Palonur" : "Uncovered"}
        </Badge>
        <Badge color={resolved ? MUTED : INK}>{STATUS_LABEL[item.status]}</Badge>
        {item.suggestedPillarName && (
          <span style={{ fontSize: 12.5, color: MUTED }}>
            Suggested pillar: <strong style={{ color: INK }}>{item.suggestedPillarName}</strong>
          </span>
        )}
      </div>

      <p
        style={{
          fontFamily: SERIF,
          fontSize: 19,
          lineHeight: 1.45,
          color: INK,
          margin: "14px 0 6px",
        }}
      >
        {item.message}
      </p>
      <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 6 }}>
        {item.askerEmail
          ? `From ${item.askerName ? `${item.askerName} · ` : ""}${item.askerEmail}`
          : "Anonymous (asked an AI agent)"}
      </div>

      {item.sourceContext && item.sourceContext.length > 0 && (
        <div
          style={{
            background: tint(RED, 0.05),
            border: `1px solid ${border}`,
            borderRadius: 10,
            padding: "10px 12px",
            margin: "8px 0 12px",
            fontSize: 12.5,
            color: INK,
          }}
        >
          <div style={{ color: MUTED, fontWeight: 700, marginBottom: 4, letterSpacing: ".1em", textTransform: "uppercase", fontSize: 11 }}>
            Source context
          </div>
          {item.sourceContext.map((s, i) => (
            <div key={i} style={{ marginBottom: 2 }}>
              {s.citation ?? s.title ?? s.marker ?? "—"}
            </div>
          ))}
        </div>
      )}

      {resolved ? (
        <div
          style={{
            marginTop: 8,
            fontSize: 14,
            lineHeight: 1.6,
            color: tint(INK, 0.82),
            whiteSpace: "pre-wrap",
          }}
        >
          {item.status === "answered" ? (
            <>
              <span style={{ color: RED, fontWeight: 700, fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase" }}>
                {item.replyMode === "steward"
                  ? `Sent by ${item.answeredBy ?? "steward"}`
                  : "Sent as Palonur"}
              </span>
              <div style={{ marginTop: 6 }}>{item.sentReply}</div>
            </>
          ) : (
            <span style={{ color: MUTED }}>Closed without a reply.</span>
          )}
        </div>
      ) : item.status === "pending_steward" ? (
        <div style={{ fontSize: 13.5, color: MUTED, marginTop: 8 }}>
          Routed to{" "}
          <strong style={{ color: INK }}>
            {item.suggestedStewardName ?? "the steward"}
          </strong>{" "}
          — waiting for them to send it in their voice.
        </div>
      ) : (
        <>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Write or edit the reply…"
            rows={4}
            style={{
              width: "100%",
              boxSizing: "border-box",
              marginTop: 8,
              padding: "12px 14px",
              border: `1px solid ${border}`,
              borderRadius: 10,
              fontFamily: SANS,
              fontSize: 14.5,
              lineHeight: 1.55,
              color: INK,
              background: "#fff",
              resize: "vertical",
            }}
          />
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
            {item.askerEmail && (
              <button
                disabled={busy || !draft.trim()}
                onClick={() =>
                  act("send-palonur", { reply: draft.trim() }, (n) => ({
                    ...item,
                    ...n,
                    status: "answered",
                    replyMode: "palonur",
                    sentReply: draft.trim(),
                  }))
                }
                style={{
                  background: busy || !draft.trim() ? tint(RED, 0.4) : RED,
                  color: "#fff",
                  border: "none",
                  borderRadius: 999,
                  padding: "10px 18px",
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: busy || !draft.trim() ? "default" : "pointer",
                }}
              >
                Send as Palonur
              </button>
            )}
            <button
              disabled={busy || item.suggestedStewardUserId == null}
              title={
                item.suggestedStewardUserId == null
                  ? "No steward was suggested for this question"
                  : ""
              }
              onClick={() =>
                act(
                  "route-steward",
                  { draftReply: draft.trim() || undefined },
                  (n) => ({
                    ...item,
                    ...n,
                    status: "pending_steward",
                  }),
                )
              }
              style={{
                background: "#fff",
                color: RED,
                border: `1.5px solid ${RED}`,
                borderRadius: 999,
                padding: "10px 18px",
                fontSize: 14,
                fontWeight: 700,
                cursor: busy || item.suggestedStewardUserId == null ? "default" : "pointer",
                opacity: item.suggestedStewardUserId == null ? 0.5 : 1,
              }}
            >
              Hand to {item.suggestedStewardName ?? "steward"}
            </button>
            <button
              disabled={busy}
              onClick={() =>
                act("dismiss", {}, (n) => ({ ...item, ...n, status: "closed" }))
              }
              style={{
                background: "none",
                color: MUTED,
                border: "none",
                fontSize: 13.5,
                cursor: busy ? "default" : "pointer",
              }}
            >
              Dismiss
            </button>
          </div>
          {err && (
            <div style={{ color: "#b91c1c", fontSize: 13, marginTop: 8 }}>{err}</div>
          )}
        </>
      )}
    </article>
  );
}

export default function Support() {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"open" | "all">("open");

  useEffect(() => {
    document.title = "Concierge · Palonur Support";
    document.body.style.background = PAPER;
    return () => {
      document.body.style.background = "";
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const meR = await fetch("/api/support-auth/me", { credentials: "include" });
      if (meR.status === 401) {
        window.location.href = "/support-login";
        return;
      }
      const me = await meR.json().catch(() => ({}));
      setEmail(me.email ?? null);
      const r = await fetch("/api/support/inbox", { credentials: "include" });
      if (r.status === 401) {
        window.location.href = "/support-login";
        return;
      }
      const d = await r.json().catch(() => ({}));
      setItems(Array.isArray(d.items) ? d.items : []);
    } catch {
      setError("Could not load the inbox.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function onResolved(next: InboxItem) {
    setItems((prev) =>
      prev ? prev.map((i) => (i.id === next.id ? next : i)) : prev,
    );
  }

  async function logout() {
    await fetch("/api/support-auth/logout", {
      method: "POST",
      credentials: "include",
    });
    window.location.href = "/support-login";
  }

  const shown = (items ?? []).filter((i) =>
    filter === "open" ? i.status === "new" || i.status === "pending_steward" : true,
  );
  const openCount = (items ?? []).filter((i) => i.status === "new").length;

  return (
    <div style={{ minHeight: "100vh", background: PAPER, fontFamily: SANS, color: INK }}>
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "72px 24px 120px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <a href="/" style={{ textDecoration: "none", color: INK, fontWeight: 700, fontSize: 18 }}>
            Palonur
          </a>
          {email && (
            <button
              onClick={logout}
              style={{ background: "none", border: "none", color: MUTED, fontSize: 13, cursor: "pointer" }}
            >
              {email} · Sign out
            </button>
          )}
        </div>

        <div
          style={{
            fontSize: 11,
            letterSpacing: ".18em",
            color: RED,
            fontWeight: 700,
            textTransform: "uppercase",
            marginTop: 36,
          }}
        >
          Concierge inbox
        </div>
        <h1
          style={{
            fontFamily: SERIF,
            fontSize: 34,
            fontWeight: 500,
            lineHeight: 1.2,
            margin: "8px 0 6px",
            color: INK,
          }}
        >
          The questions nobody answered yet.
        </h1>
        <p style={{ fontFamily: SERIF, fontSize: 17, color: MUTED, lineHeight: 1.55, margin: "0 0 22px" }}>
          {openCount > 0
            ? `${openCount} ${openCount === 1 ? "question is" : "questions are"} waiting for a reply.`
            : "You're all caught up."}
        </p>

        <div style={{ display: "flex", gap: 10, marginBottom: 22 }}>
          {(["open", "all"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                background: filter === f ? RED : "#fff",
                color: filter === f ? "#fff" : INK,
                border: `1px solid ${tint(RED, 0.3)}`,
                borderRadius: 999,
                padding: "7px 16px",
                fontSize: 13,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              {f === "open" ? "Open" : "All"}
            </button>
          ))}
        </div>

        {error ? (
          <p style={{ color: "#b91c1c" }}>{error}</p>
        ) : items === null ? (
          <p style={{ color: MUTED }}>Loading…</p>
        ) : shown.length === 0 ? (
          <p style={{ color: MUTED, fontFamily: SERIF, fontSize: 17 }}>
            Nothing here right now.
          </p>
        ) : (
          <div style={{ display: "grid", gap: 16 }}>
            {shown.map((i) => (
              <ItemCard key={i.id} item={i} onResolved={onResolved} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
