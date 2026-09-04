/**
 * Amber limit notices — small honest-limitation lines under a covered
 * answer ("This answer draws on 2 approved sources; one more relevant
 * draft is awaiting faculty review."). Structured codes come from the
 * server done event; wording is localized here (EN + DE).
 *
 * Principles (mirror lib/answerLimits.ts on the server):
 *   - Renders nothing when there are no notices — a well-covered answer
 *     stays clean.
 *   - Tone frames what is still under review; it must never read as
 *     "this answer is unsafe".
 */
import { useTranslation } from "react-i18next";

export interface AnswerLimitNotice {
  code: "few_sources" | "near_threshold" | "pending_review";
  sourceCount?: number;
  pendingCount?: number;
}

/** Narrowing helper for done-event payloads. */
export function parseLimitNotices(v: unknown): AnswerLimitNotice[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (n): n is AnswerLimitNotice =>
      typeof n === "object" &&
      n != null &&
      ["few_sources", "near_threshold", "pending_review"].includes(
        (n as { code?: unknown }).code as string,
      ),
  );
}

export function AnswerLimitNotices({
  notices,
}: {
  notices: AnswerLimitNotice[];
}) {
  const { t } = useTranslation("common");
  if (notices.length === 0) return null;

  const parts: string[] = [];
  for (const n of notices) {
    if (n.code === "few_sources") {
      parts.push(t("limitNotices.fewSources", { count: n.sourceCount ?? 1 }));
    } else if (n.code === "pending_review") {
      parts.push(
        t("limitNotices.pendingReview", { count: n.pendingCount ?? 1 }),
      );
    } else if (n.code === "near_threshold") {
      parts.push(t("limitNotices.nearThreshold"));
    }
  }
  if (parts.length === 0) return null;

  return (
    <div
      data-testid="answer-limit-notice"
      role="note"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        margin: "14px 0 6px",
        padding: "9px 12px",
        borderRadius: 10,
        background: "rgba(214, 158, 46, 0.08)",
        border: "1px solid rgba(214, 158, 46, 0.30)",
        fontSize: 12.5,
        lineHeight: 1.5,
        color: "#7a5a1e",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif",
      }}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#b8860b"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flexShrink: 0, marginTop: 2 }}
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <span>{parts.join(" ")}</span>
    </div>
  );
}
