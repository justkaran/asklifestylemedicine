import { useState } from "react";
import { ConsentLine } from "./consent-line";

export const RED = "#8B1A1A";
export const INK = "#0a0a0f";
export const PAPER = "#FAF8F4";
export const MUTED = "rgba(10,10,15,0.62)";
export const SERIF = "Georgia, 'Times New Roman', serif";
export const SANS = "-apple-system, BlinkMacSystemFont, 'Inter', sans-serif";

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "14px 16px",
  fontSize: 16,
  borderRadius: 10,
  border: "1.5px solid rgba(10,10,15,0.16)",
  background: "#fff",
  color: INK,
  fontFamily: SANS,
};

/**
 * Shared subscribe form for a faculty publication's public surfaces. Posts to
 * the anonymous per-publication subscribe endpoint. Used on both the
 * publication home and each issue reading page (as a secondary call-to-action).
 */
const REFERRAL_OPTIONS = [
  { value: "", label: "How did you hear about us? (optional)" },
  { value: "Search engine", label: "Search engine" },
  { value: "Social media", label: "Social media" },
  { value: "A friend or colleague", label: "A friend or colleague" },
  { value: "Stanford / academic", label: "Stanford / academic" },
  { value: "Other", label: "Other" },
];

export function NewsletterSubscribe({
  slug,
  accent,
  source,
}: {
  slug: string;
  accent: string;
  source: string;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [referralSource, setReferralSource] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">(
    "idle",
  );
  const [pending, setPending] = useState(false);
  const [msg, setMsg] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setState("loading");
    setMsg("");
    try {
      const r = await fetch(
        `/api/newsletter/p/${encodeURIComponent(slug)}/subscribe`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: email.trim(),
            name: name.trim() || undefined,
            source,
            referralSource: referralSource || undefined,
          }),
        },
      );
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setState("error");
        setMsg(d.error ?? "Something went wrong. Please try again.");
        return;
      }
      setState("done");
      setPending(Boolean(d.pending) && !d.alreadySubscribed);
      setMsg(
        d.alreadySubscribed
          ? "You're already on the list — welcome back."
          : d.pending
            ? "Almost there — check your inbox for a confirmation link. We won't send anything until you confirm."
            : "You're in. Watch your inbox for the next issue.",
      );
    } catch {
      setState("error");
      setMsg("Network error. Please try again.");
    }
  }

  return (
    <form
      onSubmit={submit}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        maxWidth: 440,
      }}
    >
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="First name (optional)"
        disabled={state === "loading" || state === "done"}
        style={inputStyle}
      />
      <input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@email.com"
        disabled={state === "loading" || state === "done"}
        style={inputStyle}
      />
      <select
        value={referralSource}
        onChange={(e) => setReferralSource(e.target.value)}
        disabled={state === "loading" || state === "done"}
        style={{
          ...inputStyle,
          color: referralSource ? INK : "rgba(10,10,15,0.45)",
          appearance: "auto",
        }}
      >
        {REFERRAL_OPTIONS.map((o) => (
          <option key={o.value} value={o.value} disabled={o.value === "" ? true : undefined}>
            {o.label}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={state === "loading" || state === "done"}
        style={{
          background: state === "done" ? "#2e7d32" : accent,
          color: "#fff",
          border: "none",
          borderRadius: 10,
          padding: "14px 18px",
          fontSize: 16,
          fontWeight: 600,
          cursor: state === "done" ? "default" : "pointer",
          fontFamily: SANS,
          opacity: state === "loading" ? 0.7 : 1,
          transition: "background .2s",
        }}
      >
        {state === "loading"
          ? "Subscribing…"
          : state === "done"
            ? pending
              ? "Check your email ✉"
              : "Subscribed ✓"
            : "Subscribe free"}
      </button>
      <ConsentLine
        action="subscribing"
        color={MUTED}
        fontFamily={SANS}
        align="left"
      />
      {msg && (
        <p
          style={{
            fontSize: 14,
            color: state === "error" ? RED : "#2e7d32",
            margin: "4px 0 0",
          }}
        >
          {msg}
        </p>
      )}
    </form>
  );
}

/**
 * Set per-page document title + og/twitter social-preview meta, restoring the
 * previous values on unmount so other routes keep their own meta. Mirrors the
 * existing per-page useEffect-with-cleanup pattern used across the app.
 */
export function applyPageMeta(args: {
  title: string;
  description?: string | null;
  image?: string | null;
}) {
  const prevTitle = document.title;
  document.title = args.title;

  const ensure = (selector: string, create: () => HTMLMetaElement) => {
    let el = document.head.querySelector<HTMLMetaElement>(selector);
    let created = false;
    if (!el) {
      el = create();
      document.head.appendChild(el);
      created = true;
    }
    return { el, created };
  };

  const setMeta = (
    attr: "name" | "property",
    key: string,
    value: string | null | undefined,
  ): (() => void) => {
    if (!value) return () => {};
    const { el, created } = ensure(`meta[${attr}="${key}"]`, () => {
      const m = document.createElement("meta");
      m.setAttribute(attr, key);
      return m;
    });
    const prev = el.getAttribute("content");
    el.setAttribute("content", value);
    return () => {
      if (created) {
        el.remove();
      } else if (prev !== null) {
        el.setAttribute("content", prev);
      }
    };
  };

  const cleanups = [
    setMeta("name", "description", args.description),
    setMeta("property", "og:title", args.title),
    setMeta("property", "og:description", args.description),
    setMeta("property", "og:image", args.image),
    setMeta("property", "og:type", "article"),
    setMeta("name", "twitter:card", args.image ? "summary_large_image" : "summary"),
    setMeta("name", "twitter:title", args.title),
    setMeta("name", "twitter:description", args.description),
    setMeta("name", "twitter:image", args.image),
  ];

  return () => {
    document.title = prevTitle;
    for (const c of cleanups) c();
  };
}

export function formatIssueDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}
