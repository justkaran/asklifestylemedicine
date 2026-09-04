/**
 * "Ask the steward" panel for public publication pages (/p/:slug and
 * /p/:slug/:issueId). A single-question / single-answer surface that streams a
 * voice-matched, pillar-locked answer from the EXISTING /api/embed-agent
 * endpoint — the same engine, steward-voice logic and citation discipline the
 * white-label expert widget uses. No history/threading.
 *
 * Rendered only when the publication's owning steward is ask-eligible (a
 * published voice profile + approved content in their primary pillar); the
 * server decides eligibility and hands us the pillar slug.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { studyDesignLabel } from "@workspace/db/study-design";
import { RED, INK, MUTED, SERIF, SANS } from "@/components/newsletter-subscribe";
import { savePendingQuestion } from "@/lib/pending-question";

const ENDPOINT = "/api/embed-agent";

/** The $9/mo steward plan shipped with the publication payload. */
export interface AskPlan {
  lookupKey: string;
  unitAmount: number | null;
  currency: string;
  interval: string;
  subscribed: boolean;
}

function formatPrice(unitAmount: number | null, interval: string): string {
  if (unitAmount == null) return `per ${interval}`;
  const dollars = unitAmount / 100;
  const s = Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
  return `${s}/${interval === "month" ? "mo" : interval}`;
}

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

/** Parse the labelled streaming response into its sections. Mirrors the parser
 * on /sleep and the embed agent so the same server output renders here. */
function parseAnswer(raw: string): ParsedAnswer {
  const text = raw.trim();
  if (!text) return {};
  const refuse = text.match(/^REFUSE:\s*([\s\S]*)/i);
  if (refuse) return { refuse: refuse[1].trim() };
  const uncovered = text.match(/^UNCOVERED:\s*([\s\S]*)/i);
  if (uncovered) return { uncovered: uncovered[1].trim() };

  const grab = (label: string, stops: string[]): string | undefined => {
    const stopAlt = stops.join("|");
    const re = new RegExp(
      `${label}:\\s*([\\s\\S]*?)(?=\\n(?:${stopAlt}):|$)`,
      "i",
    );
    const m = text.match(re);
    return m ? m[1].trim() : undefined;
  };
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
  return {
    answer: grab("ANSWER", ALL),
    citation: grab("CITATION", ALL),
    paper: grab("PAPER", ALL),
    finding: grab("FINDING", ALL),
    interpretation: grab("INTERPRETATION", ALL),
    action: grab("ACTION", ALL),
    insight: grab("INSIGHT", ALL),
  };
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

function tint(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  if (h.length !== 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function firstName(full: string | null | undefined): string | null {
  if (!full) return null;
  const t = full.trim().split(/\s+/)[0];
  return t || null;
}

export function AskSteward({
  pillarSlug,
  stewardName,
  accent = RED,
  publicationSlug,
  plan,
  initialQuestion,
}: {
  pillarSlug: string;
  stewardName: string | null;
  accent?: string;
  /** Publication context: enables the per-publication free-question paywall. */
  publicationSlug?: string;
  plan?: AskPlan | null;
  /** Auto-fires once on mount (post-checkout pending-question return). */
  initialQuestion?: string | null;
}) {
  const [q, setQ] = useState("");
  const [out, setOut] = useState("");
  const [provenance, setProvenance] = useState<ProvenanceEntry[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);
  const [paywall, setPaywall] = useState<{
    freeLimit: number;
    plan: AskPlan | null;
    heldQuestion: string;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const who = firstName(stewardName);
  const titleName = stewardName || "the author";

  const run = useCallback(
    async (message: string) => {
      if (!message.trim() || streaming) return;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setOut("");
      setProvenance([]);
      setErr(null);
      setPaywall(null);
      setAsked(true);
      setStreaming(true);
      try {
        const r = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            message,
            pillar: pillarSlug,
            ...(publicationSlug ? { publication: publicationSlug } : {}),
          }),
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
              if (j.paywall) {
                // Free allowance for this publication is used up. Hold the
                // question (so it auto-fires after checkout) and swap the
                // answer surface for the subscribe panel.
                if (publicationSlug) {
                  savePendingQuestion(message, `/p/${publicationSlug}`);
                }
                setPaywall({
                  freeLimit: typeof j.freeLimit === "number" ? j.freeLimit : 0,
                  plan: j.plan
                    ? {
                        lookupKey: String(j.plan.lookupKey ?? ""),
                        unitAmount:
                          typeof j.plan.unitAmount === "number"
                            ? j.plan.unitAmount
                            : null,
                        currency: String(j.plan.currency ?? "usd"),
                        interval: String(j.plan.interval ?? "month"),
                        subscribed: false,
                      }
                    : (plan ?? null),
                  heldQuestion: message,
                });
                continue;
              }
              if (j.content) setOut((p) => p + j.content);
              if (j.error) setErr(String(j.error));
              if (Array.isArray(j.provenance)) setProvenance(j.provenance);
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
    [streaming, pillarSlug, publicationSlug, plan],
  );

  // Post-checkout return: the question the paywall held rides back as ?q= and
  // fires exactly once.
  const firedRef = useRef(false);
  useEffect(() => {
    if (firedRef.current) return;
    const iq = initialQuestion?.trim();
    if (iq) {
      firedRef.current = true;
      setQ(iq);
      void run(iq);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuestion]);

  const parsed = useMemo(() => parseAnswer(out), [out]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    run(q);
  };

  const softBg = tint(accent, 0.05);
  const border = tint(accent, 0.22);

  return (
    <section
      id="ask"
      data-testid="ask-steward"
      style={{
        marginTop: 56,
        padding: "28px 26px",
        borderRadius: 18,
        background: softBg,
        border: `1px solid ${border}`,
        scrollMarginTop: 24,
        fontFamily: SANS,
      }}
    >
      <p
        style={{
          fontSize: 12,
          letterSpacing: ".16em",
          textTransform: "uppercase",
          color: accent,
          fontWeight: 600,
          margin: "0 0 8px",
        }}
      >
        Ask {who ?? "the author"}
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
        Have a question for {titleName}?
      </h2>
      <p
        style={{
          fontSize: 14.5,
          lineHeight: 1.55,
          color: MUTED,
          margin: "0 0 18px",
          maxWidth: 600,
        }}
      >
        {who
          ? `Ask and get an answer in ${who}'s own words, grounded in their published research. One question at a time.`
          : `Ask and get an answer grounded in the author's published research. One question at a time.`}
        {publicationSlug &&
          " Your first two questions each day are free; a subscription unlocks unlimited answers."}
      </p>

      <form
        onSubmit={onSubmit}
        style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={who ? `Ask ${who} anything…` : "Ask anything…"}
          disabled={streaming}
          data-testid="ask-steward-input"
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
          data-testid="ask-steward-submit"
          style={{
            padding: "0 22px",
            background: streaming || !q.trim() ? tint(accent, 0.45) : accent,
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

      {/* Paywall panel: free allowance used up. Finish the step in place —
          one email field into the standard anonymous checkout (payment never
          grants a session; magic-link confirm is unchanged). */}
      {paywall ? (
        <StewardSubscribePanel
          paywall={paywall}
          who={who}
          titleName={titleName}
          accent={accent}
          border={border}
          publicationSlug={publicationSlug}
        />
      ) : null}

      {/* Answer surface */}
      {paywall || !asked ? null : err ? (
        <div style={{ fontSize: 14, color: "#b91c1c", marginTop: 18 }}>
          Something went wrong. Please try again.
        </div>
      ) : parsed.refuse ? (
        <p style={{ fontSize: 15, color: INK, lineHeight: 1.6, marginTop: 18 }}>
          {parsed.refuse}
        </p>
      ) : parsed.uncovered ? (
        <p style={{ fontSize: 15, color: INK, lineHeight: 1.6, marginTop: 18 }}>
          {parsed.uncovered}
        </p>
      ) : (
        <article style={{ marginTop: 20 }}>
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
              {streaming && <span style={{ color: accent }}>▍</span>}
            </p>
          ) : (
            <p style={{ fontSize: 14, color: MUTED, margin: 0 }}>
              {streaming ? "Thinking…" : out}
              {streaming && <span style={{ color: accent }}>▍</span>}
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
                  color: accent,
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
                          style={{ color: accent, textDecoration: "none" }}
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

/** In-place subscribe panel shown when the free-question paywall fires. */
function StewardSubscribePanel({
  paywall,
  who,
  titleName,
  accent,
  border,
  publicationSlug,
}: {
  paywall: { freeLimit: number; plan: AskPlan | null; heldQuestion: string };
  who: string | null;
  titleName: string;
  accent: string;
  border: string;
  publicationSlug?: string;
}) {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const priceLabel = paywall.plan
    ? formatPrice(paywall.plan.unitAmount, paywall.plan.interval)
    : null;

  async function handleCheckout(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !paywall.plan?.lookupKey) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          lookupKey: paywall.plan.lookupKey,
          ...(publicationSlug ? { returnPath: `/p/${publicationSlug}` } : {}),
        }),
      });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        throw new Error(data.error ?? "Could not start checkout.");
      }
      window.location.href = data.url;
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not start checkout.",
      );
      setSubmitting(false);
    }
  }

  return (
    <div
      data-testid="steward-paywall"
      style={{
        marginTop: 20,
        padding: "22px 22px",
        borderRadius: 14,
        background: "#fff",
        border: `1px solid ${border}`,
      }}
    >
      <p
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: accent,
          margin: "0 0 8px",
        }}
      >
        {priceLabel
          ? `Unlimited questions · ${priceLabel}`
          : "Unlimited questions"}
      </p>
      <h3
        style={{
          fontFamily: SERIF,
          fontWeight: 500,
          fontSize: 21,
          lineHeight: 1.3,
          color: INK,
          margin: "0 0 8px",
        }}
      >
        Your question is waiting for {who ?? "the author"}.
      </h3>
      <p
        style={{
          fontSize: 14.5,
          lineHeight: 1.6,
          color: MUTED,
          margin: "0 0 16px",
          maxWidth: 560,
        }}
      >
        {`You've used your free question${paywall.freeLimit === 1 ? "" : "s"} for today. Subscribe for unlimited answers in ${titleName}'s own words, grounded in their published research${priceLabel ? ` — ${priceLabel}, cancel anytime` : ""}. The question you just asked is answered the moment you return.`}
      </p>
      {paywall.plan?.lookupKey ? (
        <form
          onSubmit={handleCheckout}
          style={{ display: "flex", gap: 8, flexWrap: "wrap", maxWidth: 560 }}
        >
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Your email"
            data-testid="steward-paywall-email"
            style={{
              flex: "1 1 220px",
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
            disabled={submitting || !email.trim()}
            data-testid="steward-paywall-subscribe"
            style={{
              padding: "0 22px",
              background:
                submitting || !email.trim() ? tint(accent, 0.45) : accent,
              color: "#fff",
              border: "none",
              borderRadius: 10,
              fontWeight: 600,
              fontSize: 14,
              cursor: submitting || !email.trim() ? "default" : "pointer",
            }}
          >
            {submitting ? "…" : "Subscribe"}
          </button>
        </form>
      ) : (
        <p style={{ fontSize: 14, color: MUTED, margin: 0 }}>
          Subscriptions open soon — come back tomorrow for another free
          question.
        </p>
      )}
      {error && (
        <p style={{ fontSize: 13, color: "#b91c1c", margin: "10px 0 0" }}>
          {error}
        </p>
      )}
    </div>
  );
}
