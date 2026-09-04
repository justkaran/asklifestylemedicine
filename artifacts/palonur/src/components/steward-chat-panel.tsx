import { useEffect, useRef, useState } from "react";
import i18n from "../i18n";
import TavusAvatarButton from "./TavusAvatar";

// ---------------------------------------------------------------------------
// Faculty avatar chat panel — the per-steward "AI avatar" card with pill tabs
// to switch faculty, a grounded follow-up thread, suggested-question chips,
// and the Tavus face-to-face video call. Shared by the palonur.com /slm ask
// page and the standalone asklifestylemedicine.com chat.
//
// Grounding is unchanged: follow-ups go through POST /api/slm-agent with
// chat:true scoped to the active steward's pillar, so the avatar only speaks
// from approved research (REFUSE/UNCOVERED are softened for chat display).
// ---------------------------------------------------------------------------

const BASE = import.meta.env.BASE_URL;
const SANS = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif";
const RED = "#B3261E";
const INK = "#0A0A0F";
const PAPER = "#FAF8F4";
const CARD = "#FFFFFF";
const MUTED = "rgba(10,10,15,0.64)";
const RULE = "rgba(10,10,15,0.10)";

/** Minimal steward shape the panel needs — both the /slm ask page's
 *  StewardInfo and the standalone chat's SlmSteward satisfy it. */
export interface PanelSteward {
  pillarSlug: string;
  pillarName: string;
  stewardName: string | null;
  institution: string | null;
  photoUrl: string | null;
}

/** The slices of a parsed governed answer the panel reads. */
export interface PanelAnswer {
  raw: string;
  answer: string;
  finding: string;
  interpretation: string;
}

function initials(name: string | null): string {
  if (!name) return "?";
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function StewardAvatar({
  steward,
  size = 52,
}: {
  steward: PanelSteward;
  size?: number;
}) {
  const [imgError, setImgError] = useState(false);

  // Object-storage headshots are stored as "/objects/..." paths; the API
  // serves them at ${BASE}api/storage/objects/... Absolute URLs pass through.
  const photoSrc = steward.photoUrl
    ? steward.photoUrl.startsWith("/objects/")
      ? `${BASE}api/storage${steward.photoUrl}`
      : steward.photoUrl
    : null;

  if (photoSrc && !imgError) {
    return (
      <img
        src={photoSrc}
        alt={steward.stewardName ?? steward.pillarName}
        onError={() => setImgError(true)}
        style={{
          width: size, height: size, borderRadius: "50%",
          objectFit: "cover", flexShrink: 0,
          border: `1.5px solid ${RULE}`,
        }}
      />
    );
  }

  const bg = [
    "#D4E6F0", "#D5E8D4", "#FFE6CC", "#F8D7DA",
    "#E8D5F5", "#FFF3CD", "#D1ECF1",
  ];
  const idx = steward.pillarSlug.length % bg.length;

  return (
    <div style={{
      width: size, height: size, borderRadius: "50%",
      background: bg[idx],
      display: "flex", alignItems: "center", justifyContent: "center",
      flexShrink: 0,
      fontFamily: SANS, fontSize: size * 0.32, fontWeight: 700,
      color: "rgba(10,10,15,0.6)",
      border: `1.5px solid ${RULE}`,
    }}>
      {initials(steward.stewardName)}
    </div>
  );
}

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

function chatDisplayText(raw: string): string {
  const t = raw.trim();
  if (t.startsWith("REFUSE:")) {
    return "That one is outside lifestyle medicine, so I'll pass on it. Happy to talk about the research on this page though.";
  }
  if (t.startsWith("UNCOVERED:")) {
    return "I don't have approved research on that yet, so I won't guess. Try asking it in the main search above, or ask me something about this answer.";
  }
  return t;
}

function openingReply(steward: PanelSteward, parsed: PanelAnswer): string {
  const first = steward.stewardName?.split(" ")[0] ?? "I";
  const core = parsed.finding || parsed.interpretation || parsed.answer;
  const trimmedCore = core.length > 260 ? core.slice(0, 257).trimEnd() + "…" : core;
  return `Hi, I'm an AI avatar of the work of ${steward.stewardName ?? steward.pillarName}. The short version of what ${first === "I" ? "the research" : `${first}'s research`} shows here: ${trimmedCore} Ask me anything about it.`;
}

export function StewardChatPanel({
  stewards,
  question,
  parsed,
  isFallback,
  initialSuggestions,
  standalone = false,
  composerBridge,
  visitorName,
  hideAvatar = false,
}: {
  stewards: PanelSteward[];
  question: string;
  parsed: PanelAnswer;
  isFallback: boolean;
  /** Suggested follow-up chips from the main answer's done event. */
  initialSuggestions: string[];
  /** True on the standalone SLM domain chat — forwarded to the API so the
   *  dev `?slmHost=1` preview exercises the same gate/pacing as production. */
  standalone?: boolean;
  /** Lets the page route its MAIN composer into this panel while it is open:
   *  the panel registers a send function in `ref` (last opened panel wins)
   *  and reports the active steward's first name via `onCapture` so the page
   *  can adjust its composer placeholder. Cleared on unmount. */
  composerBridge?: {
    /** The registered fn returns true if the panel ACCEPTED the question
     *  (false while a reply is already streaming) — callers must keep the
     *  typed text on rejection so nothing the user wrote is lost. */
    ref: React.MutableRefObject<((q: string) => boolean) | null>;
    onCapture?: (firstName: string | null) => void;
  };
  /** Browser-local or account name, passed into Daily so the avatar never
   * shows a second name-entry screen. */
  visitorName?: string | null;
  /** Hide the video-avatar action while keeping the steward's face and text
   * conversation available on a branded standalone surface. */
  hideAvatar?: boolean;
}) {
  const [activeIdx, setActiveIdx] = useState(0);
  const active = stewards[Math.min(activeIdx, stewards.length - 1)];

  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  // Tappable follow-up chips above the composer — seeded from the main
  // answer, refreshed from each chat reply's done event.
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const threadRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const genRef = useRef(0);

  // Reset the thread when the answer or active steward changes; abort any
  // in-flight stream so late chunks can't leak into the new thread.
  // NOTE: keyed on the suggestions' CONTENT, not array identity — callers
  // often rebuild the array every render, and identity-keying would abort an
  // in-flight panel stream on any unrelated parent re-render.
  const suggestionsKey = initialSuggestions.join("\n");
  useEffect(() => {
    genRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setSending(false);
    setSuggestions(isFallback ? [] : initialSuggestions);
    setMessages([{ role: "assistant", content: openingReply(active, parsed) }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.pillarSlug, parsed.raw, suggestionsKey]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Main-composer bridge: while this panel is open, the page's main composer
  // sends into this chat. Latest send() via ref so the bridge fn is stable.
  const sendFnRef = useRef<(q: string) => boolean>(() => false);
  useEffect(() => {
    // Reassigned every render so `sending` is always fresh. Reject (instead
    // of silently dropping) while a reply is in flight so the page keeps
    // the visitor's typed text.
    sendFnRef.current = (q: string) => {
      if (sending) return false;
      void send(q);
      return true;
    };
  });
  useEffect(() => {
    if (!composerBridge) return;
    const fn = (q: string) => sendFnRef.current(q);
    composerBridge.ref.current = fn;
    composerBridge.onCapture?.(active?.stewardName?.split(" ")[0] ?? null);
    return () => {
      if (composerBridge.ref.current === fn) {
        composerBridge.ref.current = null;
        composerBridge.onCapture?.(null);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.pillarSlug, active?.stewardName]);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function send(chipText?: string) {
    const q = (chipText ?? input).trim();
    if (!q || sending || !active) return;
    setInput("");
    setSending(true);
    setSuggestions([]);
    const gen = genRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    const guard = (fn: () => void) => {
      if (genRef.current === gen) fn();
    };
    const history: ChatMsg[] = [
      { role: "user", content: question },
      { role: "assistant", content: parsed.raw },
      ...messages.slice(1),
    ];
    setMessages((m) => [...m, { role: "user", content: q }, { role: "assistant", content: "" }]);
    try {
      const res = await fetch(`${BASE}api/slm-agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
        signal: controller.signal,
        body: JSON.stringify({
          message: q,
          history,
          chat: true,
          stewardName: active.stewardName ?? undefined,
          pillarName: active.pillarName,
          ...(isFallback ? {} : { pillarSlugs: [active.pillarSlug] }),
          ...(standalone ? { standalone: true } : {}),
          lang: i18n.language?.slice(0, 2) || "en",
        }),
      });
      if (!res.ok || !res.body) {
        // Deliberate server messages (e.g. the 15-second pacing or daily
        // question limit) must reach the reader, not a generic error.
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        if (typeof d.error === "string" && d.error) {
          guard(() => setMessages((m) => {
            const next = [...m];
            next[next.length - 1] = { role: "assistant", content: d.error as string };
            return next;
          }));
          return;
        }
        throw new Error("chat failed");
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let acc = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;
          let evt: Record<string, unknown>;
          try { evt = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }
          if (typeof evt.content === "string") {
            acc += evt.content;
            const shown = acc;
            guard(() => setMessages((m) => {
              const next = [...m];
              next[next.length - 1] = { role: "assistant", content: shown };
              return next;
            }));
          }
          // Fresh follow-up chips (covered replies only — the server omits
          // the field on boundary, refused, or corrected answers).
          if (evt.done && Array.isArray(evt.suggestedQuestions)) {
            const chips = (evt.suggestedQuestions as unknown[])
              .filter((s): s is string => typeof s === "string")
              .slice(0, 2);
            guard(() => setSuggestions(chips));
          }
          if (typeof evt.error === "string") throw new Error(evt.error);
        }
      }
      const finalText = chatDisplayText(acc);
      guard(() => setMessages((m) => {
        const next = [...m];
        next[next.length - 1] = { role: "assistant", content: finalText || "Sorry, I couldn't answer that one. Try rephrasing?" };
        return next;
      }));
    } catch {
      guard(() => setMessages((m) => {
        const next = [...m];
        next[next.length - 1] = { role: "assistant", content: "Something went wrong. Please try again." };
        return next;
      }));
    } finally {
      guard(() => setSending(false));
    }
  }

  if (!active) return null;

  return (
    <div style={{
      background: CARD, border: `1px solid ${RULE}`, borderRadius: 18,
      display: "flex", flexDirection: "column", overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{ padding: "18px 20px 14px", borderBottom: `1px solid ${RULE}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <StewardAvatar steward={active} size={64} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: SANS, fontWeight: 600, fontSize: 14.5, color: INK }}>
              {active.stewardName ?? active.pillarName}
            </div>
            {active.institution && (
              <div style={{ fontFamily: SANS, fontSize: 12, color: MUTED, lineHeight: 1.4 }}>
                {active.institution}
              </div>
            )}
            <div style={{ fontFamily: SANS, fontSize: 11, color: "rgba(10,10,15,0.4)" }}>
              {active.pillarName}
            </div>
          </div>
        </div>

        {stewards.length > 1 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}>
            {stewards.map((s, i) => (
              <button
                key={s.pillarSlug}
                onClick={() => setActiveIdx(i)}
                style={{
                  fontFamily: SANS, fontSize: 11.5, fontWeight: 600,
                  padding: "4px 12px 4px 4px", borderRadius: 999, cursor: "pointer",
                  display: "inline-flex", alignItems: "center", gap: 7,
                  background: i === activeIdx ? INK : "transparent",
                  color: i === activeIdx ? "#fff" : MUTED,
                  border: `1px solid ${i === activeIdx ? INK : RULE}`,
                }}
              >
                <StewardAvatar steward={s} size={24} />
                {(s.stewardName ?? s.pillarName).split(" ").slice(-1)[0]}
              </button>
            ))}
          </div>
        )}
      </div>

       {/* The grounded text thread remains available alongside the spoken
           avatar: visitors can move naturally between talking and typing
           without a provider-controlled pre-join step. */}
       <div ref={threadRef} style={{
          flex: 1, overflowY: "auto", padding: "16px 20px",
          display: "flex", flexDirection: "column", gap: 12,
          maxHeight: 520, minHeight: 320,
        }}>
          {messages.map((m, i) => (
            <div key={i} style={{
              alignSelf: m.role === "user" ? "flex-end" : "flex-start",
              maxWidth: "88%",
              background: m.role === "user" ? INK : PAPER,
              color: m.role === "user" ? "#fff" : INK,
              border: m.role === "user" ? "none" : `1px solid ${RULE}`,
              borderRadius: 14,
              padding: "10px 14px",
              fontFamily: SANS, fontSize: 13.5, lineHeight: 1.55,
              whiteSpace: "pre-wrap",
            }}>
              {m.content || (
                <span style={{ color: MUTED }}>…</span>
              )}
            </div>
          ))}
       </div>

       {/* Composer + voice-avatar CTA */}
      <div style={{ borderTop: `1px solid ${RULE}`, padding: "12px 16px" }}>
        {/* Suggested follow-up chips — tap one to ask it, or type your own. */}
        {!sending && suggestions.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => void send(s)}
                style={{
                  padding: "7px 13px", fontFamily: SANS, fontSize: 12.5,
                  color: INK, background: PAPER,
                  border: `1px solid ${RULE}`, borderRadius: 999,
                  cursor: "pointer", textAlign: "left", lineHeight: 1.4,
                }}
              >
                {s}
              </button>
            ))}
          </div>
        )}
        <form
          onSubmit={(e) => { e.preventDefault(); void send(); }}
          style={{ display: "flex", gap: 8 }}
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.currentTarget.value)}
            placeholder={`Ask ${active.stewardName?.split(" ")[0] ?? "a"} a follow-up…`}
            disabled={sending}
            className="pill-field"
            style={{
              flex: 1, minWidth: 0, fontFamily: SANS, fontSize: 13.5,
              padding: "10px 14px", border: `1px solid ${RULE}`,
              borderRadius: 999, background: PAPER, color: INK, outline: "none",
              opacity: sending ? 0.6 : 1,
            }}
          />
          <button
            type="submit"
            disabled={!input.trim() || sending}
            style={{
              background: RED, color: "#fff", border: "none", borderRadius: 999,
              padding: "10px 16px", fontFamily: SANS, fontSize: 13, fontWeight: 700,
              cursor: !input.trim() || sending ? "not-allowed" : "pointer",
              opacity: !input.trim() || sending ? 0.5 : 1,
            }}
          >
            {sending ? "…" : "Send"}
          </button>
        </form>
        {!hideAvatar && (
          <TavusAvatarButton
            persona="steward"
            steward={active}
            visitorName={visitorName ?? undefined}
            question={question}
            answered
            answerSummary={parsed.answer.slice(0, 300)}
            triggerVariant="inline"
            triggerLabel={`🎙 Start a voice conversation with ${active.stewardName?.split(" ")[0] ?? "this avatar"} (camera off)`}
          />
        )}
      </div>
    </div>
  );
}
