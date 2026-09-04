// ─── Save-answer card ─────────────────────────────────────────────────────────
// Post-answer email ask for the consumer agent surfaces (/sleep and
//). Near-zero-friction onboarding: the visitor already got their
// answer with NO gate; this card offers ONE input — their email — with
// explicit copy about what will be sent ("this answer and your sources").
// The newsletter is a SEPARATE, clearly-labeled, UNCHECKED checkbox that only
// starts a double opt-in — never silent marketing. Dismissable; continuing
// without saving stays effortless.
import { useState } from "react";
import { useTranslation } from "react-i18next";

export interface SaveAnswerPalette {
  accent: string; // buttons / links
  ink: string; // primary text
  muted: string; // secondary text
  rule: string; // borders
  cardBg: string; // card background
  sans: string; // sans font stack
  serif: string; // serif font stack
}

export function SaveAnswerCard({
  queryId,
  palette,
  apiBase = "/api",
}: {
  queryId: string;
  palette: SaveAnswerPalette;
  apiBase?: string;
}) {
  const { t } = useTranslation("common");
  const [email, setEmail] = useState("");
  const [newsletterOptIn, setNewsletterOptIn] = useState(false);
  const [status, setStatus] = useState<"idle" | "saving" | "sent" | "error">(
    "idle",
  );
  // Either a translation key (fallback copy) or a literal server-provided
  // message (409 retry text) — resolved at render time so language switches
  // stay consistent.
  const [error, setError] = useState<
    { kind: "key"; key: string } | { kind: "server"; message: string } | null
  >(null);
  const [newsletterPending, setNewsletterPending] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  const { accent, ink, muted, rule, cardBg, sans, serif } = palette;
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!emailValid || status === "saving") return;
    setStatus("saving");
    setError(null);
    try {
      const res = await fetch(`${apiBase}/save-answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queryId,
          email: email.trim(),
          ...(newsletterOptIn ? { newsletterOptIn: true } : {}),
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        setNewsletterPending(d.newsletterPending === true);
        setStatus("sent");
        return;
      }
      setStatus("error");
      if (res.status === 409) {
        setError(
          typeof d.error === "string"
            ? { kind: "server", message: d.error }
            : {
                kind: "key",
                key: "sleepAgent.answer.saveAnswer.errorStillSaving",
              },
        );
      } else if (res.status === 429) {
        setError({
          kind: "key",
          key: "sleepAgent.answer.saveAnswer.errorTooMany",
        });
      } else {
        setError({
          kind: "key",
          key: "sleepAgent.answer.saveAnswer.errorGeneric",
        });
      }
    } catch {
      setStatus("error");
      setError({
        kind: "key",
        key: "sleepAgent.answer.saveAnswer.errorConnection",
      });
    }
  };

  if (status === "sent") {
    return (
      <div
        data-testid="save-answer-sent"
        style={{
          marginTop: 32,
          padding: "20px 22px",
          borderRadius: 14,
          background: cardBg,
          border: `1px solid ${rule}`,
        }}
      >
        <div
          style={{
            fontFamily: serif,
            fontSize: 17,
            color: ink,
            lineHeight: 1.45,
            marginBottom: 6,
          }}
        >
          {t("sleepAgent.answer.saveAnswer.sentHeading")}
        </div>
        <div
          style={{
            fontFamily: sans,
            fontSize: 13.5,
            color: muted,
            lineHeight: 1.55,
          }}
        >
          {t("sleepAgent.answer.saveAnswer.sentBody")}
          {newsletterPending && (
            <> {t("sleepAgent.answer.saveAnswer.sentNewsletterPending")}</>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="save-answer-card"
      style={{
        marginTop: 32,
        padding: "20px 22px",
        borderRadius: 14,
        background: cardBg,
        border: `1px solid ${rule}`,
        position: "relative",
      }}
    >
      <button
        aria-label={t("sleepAgent.answer.saveAnswer.dismiss")}
        data-testid="save-answer-dismiss"
        onClick={() => setDismissed(true)}
        style={{
          position: "absolute",
          top: 10,
          right: 12,
          background: "none",
          border: "none",
          cursor: "pointer",
          color: muted,
          fontSize: 16,
          lineHeight: 1,
          padding: 4,
        }}
      >
        ×
      </button>
      <div
        style={{
          fontFamily: serif,
          fontSize: 17,
          color: ink,
          lineHeight: 1.45,
          marginBottom: 4,
        }}
      >
        {t("sleepAgent.answer.saveAnswer.heading")}
      </div>
      <div
        style={{
          fontFamily: sans,
          fontSize: 13.5,
          color: muted,
          lineHeight: 1.55,
          marginBottom: 14,
        }}
      >
        {t("sleepAgent.answer.saveAnswer.body")}
      </div>
      <form onSubmit={submit}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (status === "error") setStatus("idle");
            }}
            placeholder={t("sleepAgent.answer.saveAnswer.placeholder")}
            data-testid="input-save-answer-email"
            style={{
              flex: "1 1 200px",
              padding: "11px 14px",
              borderRadius: 10,
              border: `1.5px solid ${rule}`,
              fontFamily: sans,
              fontSize: 15,
              color: ink,
              background: "#fff",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
          <button
            type="submit"
            disabled={!emailValid || status === "saving"}
            data-testid="button-save-answer"
            style={{
              padding: "11px 20px",
              borderRadius: 10,
              border: "none",
              background: emailValid ? accent : rule,
              color: emailValid ? "#fff" : muted,
              fontFamily: sans,
              fontSize: 14.5,
              fontWeight: 600,
              cursor: emailValid && status !== "saving" ? "pointer" : "default",
              transition: "background .15s ease",
            }}
          >
            {status === "saving"
              ? t("sleepAgent.answer.saveAnswer.sending")
              : t("sleepAgent.answer.saveAnswer.button")}
          </button>
        </div>
        {error && (
          <div
            data-testid="text-save-answer-error"
            style={{
              fontFamily: sans,
              fontSize: 13,
              color: "#C0392B",
              marginTop: 10,
              lineHeight: 1.45,
            }}
          >
            {error.kind === "server" ? error.message : t(error.key)}
          </div>
        )}
        {/* Newsletter: separate, explicit, UNCHECKED by default. */}
        <label
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            marginTop: 12,
            cursor: "pointer",
            fontFamily: sans,
            fontSize: 13,
            color: muted,
            lineHeight: 1.5,
          }}
        >
          <input
            type="checkbox"
            checked={newsletterOptIn}
            onChange={(e) => setNewsletterOptIn(e.target.checked)}
            data-testid="checkbox-save-answer-newsletter"
            style={{ marginTop: 2, accentColor: accent }}
          />
          <span>{t("sleepAgent.answer.saveAnswer.newsletterLabel")}</span>
        </label>
      </form>
    </div>
  );
}
