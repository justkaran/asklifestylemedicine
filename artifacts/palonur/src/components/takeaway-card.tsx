// ─── Printable takeaway sheet ────────────────────────────────────────────────
// A keepable "output" for ask surfaces: one button
// that opens a clean, large-type, print-ready sheet with the question, the
// answer, the practical step, and the source — dated and branded. Visitors
// can print it, save it as a PDF, or hand it to someone.
//
// Deliberately dependency-free: the sheet is a minimal HTML document written
// into a new window (no global print CSS to fight), and every text value is
// HTML-escaped before it is written.

import { useState } from "react";

export interface TakeawayBrand {
  /** Accent color for rules + eyebrow. */
  accent: string;
  /** Eyebrow line at the top of the sheet. */
  name: string;
  /** Honest footer line, e.g. grounding/disclaimer wording. */
  footer: string;
}

export interface TakeawaySections {
  answer?: string;
  finding?: string;
  /** The practical step — labeled prominently on the sheet. */
  action?: string;
}

export interface TakeawayLabels {
  button: string;
  hint: string;
  actionHeading: string;
  sourceHeading: string;
  /** Shown when the browser blocks the pop-up window. */
  blocked: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function TakeawayButton({
  question,
  sections,
  sourceLines,
  brand,
  labels,
  lang,
}: {
  question: string;
  sections: TakeawaySections;
  /** Pre-formatted source lines, e.g. "Author, 2024. Title · Journal". */
  sourceLines: string[];
  brand: TakeawayBrand;
  labels: TakeawayLabels;
  lang?: string;
}) {
  const [blocked, setBlocked] = useState(false);
  if (!sections.answer && !sections.finding) return null;

  const openSheet = () => {
    // NOTE: no "noopener" here — it makes window.open return null, and we
    // need the handle to write the sheet. The window only ever contains our
    // own escaped content.
    const w = window.open("", "_blank", "width=760,height=900");
    if (!w) {
      setBlocked(true);
      return;
    }
    // Sever the back-reference (can't pass "noopener" — it nulls the handle).
    try {
      w.opener = null;
    } catch {
      /* ignore */
    }
    const date = new Date().toLocaleDateString(
      lang === "de" ? "de-DE" : "en-US",
      {
        year: "numeric",
        month: "long",
        day: "numeric",
      },
    );
    const bodyParts: string[] = [];
    if (sections.answer)
      bodyParts.push(`<p class="answer">${esc(sections.answer)}</p>`);
    if (sections.finding)
      bodyParts.push(`<p class="finding">${esc(sections.finding)}</p>`);
    if (sections.action) {
      bodyParts.push(
        `<div class="action"><div class="label">${esc(labels.actionHeading)}</div><p>${esc(sections.action)}</p></div>`,
      );
    }
    if (sourceLines.length > 0) {
      bodyParts.push(
        `<div class="sources"><div class="label">${esc(labels.sourceHeading)}</div>${sourceLines
          .map((s) => `<p>${esc(s)}</p>`)
          .join("")}</div>`,
      );
    }
    w.document.write(`<!doctype html>
<html lang="${esc(lang || "en")}"><head><meta charset="utf-8">
<title>${esc(question)}</title>
<style>
  body { font-family: "Source Serif 4", serif; color: #1c1610;
         max-width: 640px; margin: 48px auto; padding: 0 28px; line-height: 1.6; }
  .eyebrow { font-family: "Source Sans 3", sans-serif; font-size: 12px;
             font-weight: 700; letter-spacing: .22em; text-transform: uppercase;
             color: ${esc(brand.accent)}; margin-bottom: 6px; }
  .date { font-family: "Source Sans 3", sans-serif; font-size: 12px;
          color: rgba(28,22,16,.55); margin-bottom: 28px; }
  h1 { font-size: 27px; font-weight: 500; line-height: 1.25; margin: 0 0 22px; }
  .answer { font-size: 19px; margin: 0 0 18px; }
  .finding { font-size: 16px; color: rgba(28,22,16,.78); margin: 0 0 18px; }
  .action { border: 2px solid ${esc(brand.accent)}; border-radius: 12px;
            padding: 16px 20px; margin: 26px 0; }
  .action p { font-size: 18px; margin: 0; }
  .label { font-family: "Source Sans 3", sans-serif; font-size: 11px;
           font-weight: 700; letter-spacing: .18em; text-transform: uppercase;
           color: ${esc(brand.accent)}; margin-bottom: 8px; }
  .sources { margin-top: 30px; border-top: 1px solid rgba(28,22,16,.15); padding-top: 16px; }
  .sources p { font-size: 13.5px; color: rgba(28,22,16,.7); margin: 0 0 6px; }
  .footer { margin-top: 36px; font-family: "Source Sans 3", sans-serif;
            font-size: 12px; color: rgba(28,22,16,.55); border-top: 1px solid rgba(28,22,16,.15);
            padding-top: 14px; }
  @media print { body { margin: 0 auto; } }
</style></head><body>
<div class="eyebrow">${esc(brand.name)}</div>
<div class="date">${esc(date)}</div>
<h1>&ldquo;${esc(question)}&rdquo;</h1>
${bodyParts.join("\n")}
<div class="footer">${esc(brand.footer)}</div>
<script>
  var printed = false;
  function go() { if (!printed) { printed = true; window.print(); } }
  window.onload = go;
  setTimeout(go, 600); // onload is unreliable on document-written blank windows
</script>
</body></html>`);
    w.document.close();
    w.focus();
  };

  return (
    <div
      style={{
        marginTop: 18,
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <button
        onClick={openSheet}
        data-testid="takeaway-print"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 18px",
          borderRadius: 999,
          border: `1.5px solid ${brand.accent}`,
          background: "transparent",
          color: brand.accent,
          fontWeight: 700,
          fontSize: 14,
          cursor: "pointer",
          fontFamily: "'Source Sans 3', sans-serif",
        }}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="6 9 6 2 18 2 18 9" />
          <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
          <rect x="6" y="14" width="12" height="8" />
        </svg>
        {labels.button}
      </button>
      <span
        style={{
          fontSize: 13,
          color: "rgba(28,22,16,0.55)",
          fontFamily: "'Source Sans 3', sans-serif",
        }}
      >
        {blocked ? labels.blocked : labels.hint}
      </span>
    </div>
  );
}
