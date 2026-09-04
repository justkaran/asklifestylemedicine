import { useState } from "react";

/**
 * "How this answer was built" — an expandable, plain-language trajectory
 * panel shown under governed agent answers (/sleep, /slm). Read-only
 * presentation of data the pipeline already returns with the SSE `done`
 * event: which pillar(s) were searched, which steward-approved sources were
 * used, and which checks passed (coverage gate, citation verification,
 * steward approval).
 *
 * Display rules honored by CALLERS, not here:
 *  - pass provenance AFTER same-work collapse (display boundary);
 *  - never pass steward identity (this component has no steward fields);
 *  - never pass internal scores (none are accepted).
 * Collapsed by default; copy is written for 50+ readers.
 */

export interface TrajectorySource {
  title: string;
  authors: string | null;
  year: number | null;
}

export type TrajectoryOutcome = "covered" | "fallback" | "boundary";

export interface TrajectoryLabels {
  title: string;
  whereWeLooked: string;
  searchedOne: string; // {pillar}
  searchedMany: string; // {pillars}
  whatWeFound: string;
  foundSources: string; // {count}
  foundNone: string;
  foundSuppressed: string;
  foundFallback: string;
  checksWeRan: string;
  checkApproved: string;
  checkCoveragePassed: string;
  checkCoverageNotPassed: string;
  checkCitationPassed: string;
  checkCitationFailed: string;
}

const EN_LABELS: TrajectoryLabels = {
  title: "How this answer was built",
  whereWeLooked: "Where we looked",
  searchedOne:
    "We searched the {pillar} pillar — a collection of research that faculty stewards approved in advance.",
  searchedMany:
    "We searched these pillars — collections of research that faculty stewards approved in advance: {pillars}.",
  whatWeFound: "What we found",
  foundSources:
    "{count} approved source(s) matched your question closely enough to build this answer:",
  foundNone:
    "No approved source matched your question closely enough. Rather than guess, we told you what we don't yet cover.",
  foundSuppressed:
    "Approved sources supported this answer, but our automatic citation check couldn't confirm the exact match, so the list isn't shown here.",
  foundFallback:
    "No approved source matched closely enough, so this answer draws on wider Stanford Lifestyle Medicine research and is labeled that way.",
  checksWeRan: "Checks we ran",
  checkApproved:
    "Every source used was approved by a faculty steward before the answer could use it.",
  checkCoveragePassed:
    "Coverage check passed — the research matched your question closely enough to answer.",
  checkCoverageNotPassed:
    "Coverage check not passed — so we said so instead of answering without support.",
  checkCitationPassed:
    "Citation check passed — the study cited in the answer matches a source on this list.",
  checkCitationFailed:
    "Citation check couldn't automatically confirm the cited study against the approved list.",
};

function fill(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

function CheckIcon({ ok, color }: { ok: boolean; color: string }) {
  return ok ? (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#1a6b3c" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }} aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" style={{ flexShrink: 0, marginTop: 2 }} aria-hidden="true">
      <circle cx="12" cy="12" r="9" strokeWidth="2" />
      <line x1="12" y1="8" x2="12" y2="13" />
      <line x1="12" y1="16" x2="12" y2="16.01" />
    </svg>
  );
}

export function AnswerTrajectory(props: {
  /** Pillars searched, in routing order (from the SSE done event). */
  pillarNames: string[];
  /** Sources used — pass AFTER same-work collapse. Empty on boundary/fallback. */
  sources: TrajectorySource[];
  /** Citation-guard status from the done event; null when no check ran. */
  citationStatus: "verified" | "missing" | "unmatched" | null;
  outcome: TrajectoryOutcome;
  /** Copy overrides (i18n). Defaults to plain English. */
  labels?: Partial<TrajectoryLabels>;
  /** Accent color for the toggle + rules; defaults to a neutral ink. */
  accent?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const L: TrajectoryLabels = { ...EN_LABELS, ...(props.labels ?? {}) };
  const accent = props.accent ?? "#555555";
  const pillars = props.pillarNames.filter(Boolean);
  const covered = props.outcome === "covered";
  const hasSources = props.sources.length > 0;

  if (pillars.length === 0 && !hasSources) return null;

  const stepLabel: React.CSSProperties = {
    fontSize: 10.5,
    fontWeight: 700,
    letterSpacing: ".14em",
    textTransform: "uppercase",
    color: accent,
    marginBottom: 5,
  };
  const bodyText: React.CSSProperties = {
    fontSize: 13.5,
    lineHeight: 1.6,
    color: "rgba(20,10,10,0.78)",
    margin: 0,
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif",
  };

  const checks: { ok: boolean; text: string }[] = [];
  if (hasSources) checks.push({ ok: true, text: L.checkApproved });
  checks.push(
    covered || props.outcome === "fallback"
      ? props.outcome === "covered"
        ? { ok: true, text: L.checkCoveragePassed }
        : { ok: false, text: L.checkCoverageNotPassed }
      : { ok: false, text: L.checkCoverageNotPassed },
  );
  if (props.citationStatus === "verified") {
    checks.push({ ok: true, text: L.checkCitationPassed });
  } else if (props.citationStatus === "unmatched") {
    checks.push({ ok: false, text: L.checkCitationFailed });
  }

  return (
    <div data-testid={props.testId ?? "answer-trajectory"} style={{ marginTop: 18 }}>
      <button
        type="button"
        data-testid="button-trajectory-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          background: "none",
          border: "none",
          padding: "4px 0",
          cursor: "pointer",
          fontSize: 12.5,
          fontWeight: 600,
          color: accent,
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif",
        }}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }}
          aria-hidden="true"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        {L.title}
      </button>

      {open && (
        <div
          data-testid="trajectory-panel"
          style={{
            marginTop: 8,
            padding: "16px 18px",
            border: "1px solid rgba(20,10,10,0.12)",
            borderRadius: 12,
            background: "rgba(20,10,10,0.02)",
          }}
        >
          {/* Step 1 — where we looked */}
          {pillars.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={stepLabel}>{L.whereWeLooked}</div>
              <p style={bodyText}>
                {pillars.length === 1
                  ? fill(L.searchedOne, { pillar: pillars[0] })
                  : fill(L.searchedMany, { pillars: pillars.join(", ") })}
              </p>
            </div>
          )}

          {/* Step 2 — what we found */}
          <div style={{ marginBottom: 14 }}>
            <div style={stepLabel}>{L.whatWeFound}</div>
            {hasSources ? (
              <>
                <p style={{ ...bodyText, marginBottom: 6 }}>
                  {fill(L.foundSources, { count: String(props.sources.length) })}
                </p>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {props.sources.map((s, i) => (
                    <li key={i} style={{ ...bodyText, marginBottom: 4 }}>
                      <span style={{ fontStyle: "italic" }}>{s.title}</span>
                      {(s.authors || s.year) && (
                        <span style={{ color: "rgba(20,10,10,0.55)" }}>
                          {" — "}
                          {[s.authors?.split(",")[0], s.year].filter(Boolean).join(", ")}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p style={bodyText}>
                {props.outcome === "fallback"
                  ? L.foundFallback
                  : covered
                    ? L.foundSuppressed
                    : L.foundNone}
              </p>
            )}
          </div>

          {/* Step 3 — checks */}
          <div>
            <div style={stepLabel}>{L.checksWeRan}</div>
            {checks.map((c, i) => (
              <div key={i} style={{ display: "flex", gap: 8, marginBottom: 5 }}>
                <CheckIcon ok={c.ok} color={accent} />
                <span style={bodyText}>{c.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
