import { useState } from "react";
import {
  RELIABILITY_AXES,
  reliabilityBandLabel,
  type PublicReliability,
  type ReliabilityBand,
  type ReliabilityAnswer,
} from "@workspace/db/source-rigor";

/**
 * Per-band hues for the three-axis reliability chips and rubric answers.
 * Shared so every governed surface (sleep agent, newsletter science home, …)
 * renders identical colours rather than re-deriving them.
 */
export const RELIABILITY_BAND_HUES: Record<
  ReliabilityBand,
  { fg: string; bg: string; border: string }
> = {
  strong: { fg: "#2f7d41", bg: "#EAF3EC", border: "#CBE3D1" },
  moderate: { fg: "#8a6b14", bg: "#F6EFD9", border: "#E7D9AE" },
  limited: { fg: "#9a3325", bg: "#F6E6E2", border: "#E8CFC8" },
  unknown: { fg: "#8a6a5a", bg: "#F4ECDD", border: "#E8DDC8" },
};

export const ANSWER_TEXT: Record<ReliabilityAnswer, string> = {
  yes: "Yes",
  partial: "Partial",
  no: "No",
  unclear: "Unclear",
};

/**
 * Public, steward-approved reliability badge shown next to a citation. Three
 * independent axes (Rigor / Reproducibility / Open Science), never collapsed
 * into one number, with an expandable rubric. Describes the PAPER, never the
 * steward (no PII). Rendered only when `reliability` is present, which the
 * server gates on steward approval.
 */
export function ReliabilityBadge({
  reliability,
  sourceId,
}: {
  reliability: PublicReliability;
  sourceId: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{ marginTop: 10 }}
      data-testid={`reliability-badge-${sourceId}`}
    >
      <div
        style={{
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: ".1em",
            textTransform: "uppercase",
            color: "#999",
          }}
        >
          Reliability
        </span>
        {reliability.axes.map((a) => {
          const c = RELIABILITY_BAND_HUES[a.band];
          return (
            <span
              key={a.key}
              title={`${a.label}: ${reliabilityBandLabel(a.band)}${
                a.score != null ? ` (${a.score}%)` : ""
              } · ${a.assessed}/${a.total} items scored`}
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: c.fg,
                background: c.bg,
                border: `1px solid ${c.border}`,
                borderRadius: 999,
                padding: "2px 9px",
              }}
            >
              {a.label} {a.score == null ? "n/a" : a.score}
            </span>
          );
        })}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          data-testid={`reliability-expand-${sourceId}`}
          style={{
            fontSize: 11.5,
            color: "#8B1A1A",
            fontWeight: 600,
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: 0,
            borderBottom: "1px solid rgba(139,26,26,.3)",
          }}
        >
          {open ? "Hide rubric" : "How we scored this"}
        </button>
      </div>
      {open && (
        <div
          style={{
            marginTop: 8,
            padding: "10px 12px",
            background: "#FBF7F0",
            border: "1px solid #E8DDC8",
            borderRadius: 10,
          }}
          data-testid={`reliability-rubric-${sourceId}`}
        >
          {RELIABILITY_AXES.map((axis) => (
            <div key={axis.key} style={{ marginBottom: 10 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: "#572020",
                  marginBottom: 4,
                }}
              >
                {axis.label}
              </div>
              <div style={{ display: "grid", gap: 4 }}>
                {axis.items.map((itemDef) => {
                  const ans = reliability.rubric[axis.key]?.items.find(
                    (i) => i.id === itemDef.id,
                  );
                  const answer: ReliabilityAnswer = ans?.answer ?? "unclear";
                  const c = RELIABILITY_BAND_HUES[
                    answer === "yes"
                      ? "strong"
                      : answer === "partial"
                        ? "moderate"
                        : answer === "no"
                          ? "limited"
                          : "unknown"
                  ];
                  return (
                    <div key={itemDef.id} style={{ fontSize: 12 }}>
                      <span style={{ color: "#572020" }}>{itemDef.label}</span>
                      <span style={{ color: "#bbb" }}> · </span>
                      <span style={{ color: c.fg, fontWeight: 600 }}>
                        {ANSWER_TEXT[answer]}
                      </span>
                      {ans?.rationale && (
                        <div
                          style={{
                            color: "#777",
                            fontStyle: "italic",
                            marginTop: 1,
                          }}
                        >
                          {ans.rationale}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          <p style={{ fontSize: 11, color: "#999", margin: "2px 0 0" }}>
            Scored by a Stanford steward against a fixed rubric. Scores describe
            the paper.
          </p>
        </div>
      )}
    </div>
  );
}
