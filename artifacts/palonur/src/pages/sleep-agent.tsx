import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import {
  findRelevantArticle,
  findRelevantArticleForPillar,
  type SlmArticle,
} from "../lib/slm-articles";
import { journeyInviteTopic } from "../lib/journey-invite-topic";
import { SLMBrand } from "../components/SLMBrand";
import { studyDesignLabel } from "@workspace/db/study-design";
import { PhoneCapture } from "../components/phone-capture";
import { type PublicReliability } from "@workspace/db/source-rigor";
import {
  savePendingQuestion,
  clearPendingQuestion,
} from "../lib/pending-question";
import { SLEEP_TESTIMONIALS } from "../lib/testimonials";
import { SaveAnswerCard } from "../components/save-answer-card";
import { MinicastButton } from "../components/MinicastButton";
import { StewardAchievementsPanel } from "../components/steward-achievements";
import {
  AnswerTrajectory,
  type TrajectoryLabels,
} from "../components/answer-trajectory";
import {
  AnswerLimitNotices,
  parseLimitNotices,
  type AnswerLimitNotice,
} from "../components/AnswerLimitNotices";
import { stewardPortraitUrl } from "../lib/stewards";
import TavusAvatarButton from "../components/TavusAvatar";
import { warmReturnGreeting } from "../lib/return-greeting";

const API_BASE = "/api";

interface ProvenanceEntry {
  source_id: number;
  interpretation_id: number | null;
  chunk_ids: number[];
  title: string;
  authors: string | null;
  year: number | null;
  journal: string | null;
  doi: string | null;
  source_url: string | null;
  study_design: string | null;
  pillar_slug: string;
  interpretation_author: string | null;
  interpretation_note?: string | null;
  reliability?: PublicReliability | null;
}

interface SourceInterpretation {
  id: number;
  answer: string;
  interpretation: string;
  not_proven: string | null;
  action: string | null;
  author_name: string | null;
}

interface SourceDetail {
  id: number;
  title: string;
  authors: string | null;
  year: number | null;
  journal: string | null;
  doi: string | null;
  source_url: string | null;
  abstract: string | null;
  kind: string;
  study_design: string | null;
  pillar_slug: string;
  pillar_name: string;
  interpretation: SourceInterpretation | null;
}

interface IntakeQuestion {
  id: string;
  question: string;
  options: string[];
}

interface ParsedAnswer {
  kind: "structured" | "refuse" | "uncovered" | "raw";
  answer?: string;
  citation?: string;
  paper?: string;
  finding?: string;
  interpretation?: string;
  action?: string;
  insight?: string;
  clarify?: string;
  advisorNote?: string;
  raw: string;
}

/**
 * Score each provenance entry against the citation/paper text the model
 * actually emitted, and return the best match. This makes the citation
 * "Source ↓" anchor jump to the *correct* card when the model cites a
 * source that isn't index 0. Falls back to provenance[0] when nothing
 * scores above zero.
 */
function matchProvenance(
  provenance: ProvenanceEntry[],
  citation?: string,
  paper?: string,
): ProvenanceEntry | undefined {
  if (provenance.length === 0) return undefined;
  if (provenance.length === 1) return provenance[0];
  const hay = `${citation ?? ""} ${paper ?? ""}`.toLowerCase();
  if (!hay.trim()) return provenance[0];

  let best: { entry: ProvenanceEntry; score: number } | null = null;
  for (const p of provenance) {
    let score = 0;
    if (p.doi && hay.includes(p.doi.toLowerCase())) score += 10;
    if (p.title) {
      const t = p.title.toLowerCase();
      if (hay.includes(t)) score += 8;
      else {
        // Match a distinctive run of title words (>=3 alpha tokens, len >= 5)
        const tokens = t.split(/[^a-z0-9]+/).filter((w) => w.length >= 5);
        for (const w of tokens) if (hay.includes(w)) score += 1;
      }
    }
    if (p.authors) {
      // First author surname is the most reliable handle ("Barwick et al.")
      const first = p.authors.split(/[,;&]| and /i)[0]?.trim() ?? "";
      const surname = first.split(/\s+/).pop()?.toLowerCase() ?? "";
      if (surname.length >= 3 && hay.includes(surname)) score += 4;
    }
    if (p.year != null && hay.includes(String(p.year))) score += 2;
    if (p.journal) {
      const j = p.journal.toLowerCase();
      if (j.length >= 4 && hay.includes(j)) score += 3;
    }
    if (!best || score > best.score) best = { entry: p, score };
  }
  return best && best.score > 0 ? best.entry : provenance[0];
}

export function normalizeSelectedExcerpt(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

export function parseAnswer(text: string): ParsedAnswer {
  // Model and copied text can contain zero-width or bidirectional formatting
  // controls. Remove them before checking the machine-readable boundary
  // marker so a visually corrupted line cannot fall through as raw text.
  const t = text
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gi, "")
    .trim();
  if (t.startsWith("REFUSE:")) {
    return { kind: "refuse", raw: t.replace(/^REFUSE:\s*/, "") };
  }
  if (t.startsWith("UNCOVERED:")) {
    return { kind: "uncovered", raw: t.replace(/^UNCOVERED:\s*/, "") };
  }

  // `next` is the list of section labels that may follow this one. The
  // lookahead accepts ANY of them or end-of-text, so answers with missing
  // sections still parse — the SLM AI Lab fallback emits only
  // ANSWER / FINDING / INTERPRETATION (no CITATION or PAPER), and it must
  // render as a structured answer, not a raw wall of labeled text.
  const grab = (label: string, next?: string | string[]) => {
    const stops = next == null ? [] : Array.isArray(next) ? next : [next];
    const lookahead = stops.length
      ? `(?=${stops.map((s) => `${s}:`).join("|")}|$)`
      : "(?=$)";
    const re = new RegExp(`${label}:\\s*([\\s\\S]*?)${lookahead}`, "i");
    const m = t.match(re);
    return m ? m[1].trim() : undefined;
  };

  // Em-dashes ("—") read as ugly "long dashes" in the rendered text. The model
  // is instructed not to emit them (see system prompts in api-server), but we
  // also strip any that slip through — replace " — " with ", " and a bare "—"
  // with ", " too. Applied to every section we surface to the user.
  const stripDash = (s: string | undefined) => s?.replace(/\s*—\s*/g, ", ");

  const answer = stripDash(
    grab("ANSWER", [
      "CITATION",
      "PAPER",
      "FINDING",
      "INTERPRETATION",
      "ACTION",
      "INSIGHT",
      "CLARIFY",
      "ADVISOR_NOTE",
    ]),
  );
  if (!answer) return { kind: "raw", raw: t.replace(/\s*—\s*/g, ", ") };

  // CLARIFY is optional — strip the parenthetical instruction the AI might echo
  const rawClarify = grab("CLARIFY");
  const clarify =
    rawClarify
      ?.replace(/^\(OPTIONAL[^)]*\)\s*/i, "")
      .replace(/^OPTIONAL[^—\n]*[—\n]\s*/i, "")
      .trim() || undefined;

  const rawInsight = grab("INSIGHT", ["CLARIFY", "ADVISOR_NOTE"]);
  const insight = rawInsight?.trim() || undefined;

  const rawAdvisor = grab("ADVISOR_NOTE");
  const advisorNote =
    rawAdvisor?.replace(/^\(OPTIONAL[^)]*\)\s*/i, "").trim() || undefined;

  return {
    kind: "structured",
    answer,
    citation: stripDash(
      grab("CITATION", [
        "PAPER",
        "FINDING",
        "INTERPRETATION",
        "ACTION",
        "INSIGHT",
        "CLARIFY",
        "ADVISOR_NOTE",
      ]),
    ),
    paper: stripDash(
      grab("PAPER", [
        "FINDING",
        "INTERPRETATION",
        "ACTION",
        "INSIGHT",
        "CLARIFY",
        "ADVISOR_NOTE",
      ]),
    ),
    finding: stripDash(
      grab("FINDING", [
        "INTERPRETATION",
        "ACTION",
        "INSIGHT",
        "CLARIFY",
        "ADVISOR_NOTE",
      ]),
    ),
    interpretation: stripDash(
      grab("INTERPRETATION", ["ACTION", "INSIGHT", "CLARIFY", "ADVISOR_NOTE"]),
    ),
    action: stripDash(grab("ACTION", ["INSIGHT", "CLARIFY", "ADVISOR_NOTE"])),
    insight: insight && insight.length > 5 ? stripDash(insight) : undefined,
    clarify: clarify && clarify.length > 5 ? stripDash(clarify) : undefined,
    advisorNote:
      advisorNote && advisorNote.length > 5
        ? stripDash(advisorNote)
        : undefined,
    raw: t,
  };
}

interface AlsoCoveredEntry {
  slug: string;
  name: string;
  steward: string | null;
  leadSteward?: {
    fullName: string | null;
    institution: string | null;
    photoUrl: string | null;
  } | null;
}

interface StewardInfo {
  fullName: string | null;
  institution: string | null;
  photoUrl: string | null;
  achievements?: string[];
}

/**
 * One completed Q&A turn in an ongoing conversation. Every governance field
 * is snapshotted PER TURN because /sleep routes each question independently:
 * a follow-up can land on a different pillar with a different steward, so
 * nothing here may be assumed constant across the thread.
 */
interface ConversationTurn {
  question: string;
  /** Reader-highlighted text that framed this follow-up. Display-only here;
   * the server already treated it as separately fenced untrusted context. */
  selectedExcerpt?: string;
  raw: string;
  queryId: string | null;
  provenance: ProvenanceEntry[];
  pillarNames: string[];
  winnerPillarName: string | null;
  alsoCovered: AlsoCoveredEntry[];
  steward: StewardInfo | null;
  facultyVerified: boolean;
  slmFallback: boolean;
  /** Citation-guard status from the done event; null when no check ran. */
  citationStatus: "verified" | "missing" | "unmatched" | null;
}

function SelectedExcerptQuote(props: {
  text: string;
  removable?: boolean;
  onRemove?: () => void;
  compact?: boolean;
}) {
  const { t } = useTranslation("common");
  return (
    <div
      data-testid="selected-excerpt"
      style={{
        marginBottom: props.compact ? 8 : 12,
        padding: props.compact ? "8px 10px" : "10px 12px",
        borderLeft: "3px solid rgba(139,26,26,.42)",
        borderRadius: "0 9px 9px 0",
        background: "rgba(139,26,26,.035)",
        color: "#5a4a42",
        fontSize: props.compact ? 12 : 13,
        lineHeight: 1.5,
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          marginBottom: 4,
        }}
      >
        <span
          style={{
            fontSize: 9.5,
            fontWeight: 700,
            letterSpacing: ".11em",
            textTransform: "uppercase",
            color: "#8B1A1A",
          }}
        >
          {t("sleepAgent.conversation.selectedExcerpt")}
        </span>
        {props.removable && (
          <button
            type="button"
            data-testid="button-remove-selected-excerpt"
            onClick={props.onRemove}
            aria-label={t("sleepAgent.conversation.removeSelectedExcerpt")}
            style={{
              border: "none",
              background: "none",
              color: "#8a7a72",
              cursor: "pointer",
              padding: 2,
              fontSize: 16,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        )}
      </div>
      <span>“{props.text}”</span>
    </div>
  );
}

type CoverageState =
  | "covered"
  | "fallback"
  | "boundary"
  | "refuse"
  | "unverified";

function coverageOf(turn: ConversationTurn): CoverageState {
  const parsed = parseAnswer(turn.raw);
  if (parsed.kind === "refuse") return "refuse";
  if (parsed.kind === "uncovered") return "boundary";
  if (turn.facultyVerified) return "covered";
  if (turn.slmFallback) return "fallback";
  return "unverified";
}

/**
 * Same-work collapse for provenance LISTS at display boundaries only: a
 * chapter-split book retrieves as several entries that are really one work.
 * Never applied before citation matching or logging.
 */
function collapseSameWork(entries: ProvenanceEntry[]): ProvenanceEntry[] {
  const seen = new Set<string>();
  const out: ProvenanceEntry[] = [];
  for (const p of entries) {
    const norm = (s: string | null) =>
      (s ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    const key = `${p.source_id}|${norm(p.title)}|${norm(p.authors)}|${p.year ?? ""}`;
    const workKey =
      norm(p.title) && norm(p.authors)
        ? `${norm(p.authors)}|${p.year ?? ""}|${norm(p.journal)}`
        : key;
    if (seen.has(key) || (norm(p.journal) && seen.has(workKey))) continue;
    seen.add(key);
    if (norm(p.journal)) seen.add(workKey);
    out.push(p);
  }
  return out;
}

/** Light markdown strip for plain-text previews of prior-turn answers. */
function stripMdInline(s: string): string {
  return s
    .replace(/\*\*\*(.*?)\*\*\*/g, "$1")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/^#+\s*/gm, "")
    .trim();
}

/**
 * Governance rail — binds to ONE turn's snapshot (steward, pillar, sources,
 * coverage). Rendered as a right-side desktop aside (>=1200px) or as the body
 * of the mobile bottom sheet. Every field comes from the bound turn, never
 * from live component state: follow-ups can route to a different pillar.
 */
/** Loose t-function shape so module-level helpers stay decoupled from i18next generics. */
type Translate = (key: string, opts?: Record<string, unknown>) => string;

/**
 * Share text for ONE turn's snapshot — same structure as the live-answer
 * share copy, but computed from the bound turn so the rail can offer sharing
 * for earlier answers too (a follow-up can route to a different steward).
 */
function buildShareTextFor(
  parsed: ParsedAnswer,
  info: {
    steward: StewardInfo | null;
    facultyVerified: boolean;
    winnerPillarName: string | null;
    pillarNames: string[];
  },
  t: Translate,
): string {
  const stripMd = (s: string) =>
    s
      .replace(/\*\*\*(.*?)\*\*\*/g, "$1")
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/\*(.*?)\*/g, "$1")
      .replace(/^#+\s*/gm, "")
      .trim();
  const attributionPillar =
    info.winnerPillarName ?? info.pillarNames[0] ?? null;
  const jamieFallbackOk =
    attributionPillar == null || /sleep/i.test(attributionPillar);
  const firstName = info.steward?.fullName?.trim().split(/\s+/)[0] || null;
  const takeKeySuffix =
    firstName && /[sßxz]$/i.test(firstName)
      ? "stewardsTakeApos"
      : "stewardsTake";
  const shareTakeLabel = firstName
    ? t(`sleepAgent.share.${takeKeySuffix}`, { name: firstName })
    : jamieFallbackOk
      ? t("sleepAgent.share.jamiesTake")
      : t("sleepAgent.share.expertsTake");
  const verifiedLine = info.steward?.fullName
    ? t("sleepAgent.share.verifiedByName", { name: info.steward.fullName }) +
      (info.steward.institution ? ` · ${info.steward.institution}` : "")
    : jamieFallbackOk
      ? t("sleepAgent.share.verifiedBy")
      : t("sleepAgent.share.verifiedGeneric");
  const lines: string[] = [];
  if (parsed.answer) lines.push(stripMd(parsed.answer));
  if (parsed.interpretation) {
    lines.push("");
    lines.push(stripMd(parsed.interpretation));
  }
  if (parsed.action) {
    lines.push("");
    lines.push(t("sleepAgent.share.tryThis", { text: stripMd(parsed.action) }));
  }
  if (parsed.insight) {
    lines.push("");
    lines.push(shareTakeLabel);
    lines.push(stripMd(parsed.insight).replace(/^[QA]:\s*/gm, ""));
  }
  if (parsed.citation || parsed.paper || parsed.finding) {
    lines.push("");
    lines.push(t("sleepAgent.share.source"));
    if (parsed.citation) lines.push(parsed.citation);
    if (parsed.paper) lines.push(parsed.paper);
    if (parsed.finding)
      lines.push(t("sleepAgent.share.finding", { text: parsed.finding }));
  }
  lines.push("");
  // Only claim expert verification when the answer is genuinely grounded +
  // citation-verified; ungrounded answers share unattributed.
  if (info.facultyVerified) {
    lines.push(verifiedLine);
  }
  lines.push(t("sleepAgent.share.viaPalonur"));
  return lines.join("\n");
}

/** Clipboard write with the textarea fallback for non-secure contexts. */
async function copyPlainText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      /* swallow */
    }
    document.body.removeChild(ta);
  }
}

const TRUST_VOTE_KEY_PREFIX = "palonur_trust_";

/**
 * "Do you feel you can trust this answer?" — Yes/No, one vote per answer per
 * visitor. Server enforces uniqueness by (queryId, visitor hash); the local
 * mirror in localStorage restores the voted state instantly, and a mount-time
 * GET /trust/mine restores it from the server when localStorage is empty
 * (cleared storage, another device on the same network hash). Mounted with
 * key={queryId} so state resets per answer. Exported for tests.
 */
export function TrustVoteCard(props: { queryId: string }) {
  const { t } = useTranslation("common");
  const [vote, setVote] = useState<boolean | null>(() => {
    try {
      const v = localStorage.getItem(TRUST_VOTE_KEY_PREFIX + props.queryId);
      return v === "yes" ? true : v === "no" ? false : null;
    } catch {
      return null;
    }
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // Only ask the server when the local mirror had nothing.
    if (vote !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `${API_BASE}/sleep-agent/trust/mine?queryId=${encodeURIComponent(props.queryId)}`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as { trusted?: boolean | null };
        if (!cancelled && typeof data.trusted === "boolean") {
          setVote(data.trusted);
          try {
            localStorage.setItem(
              TRUST_VOTE_KEY_PREFIX + props.queryId,
              data.trusted ? "yes" : "no",
            );
          } catch {
            /* noop */
          }
        }
      } catch {
        /* offline: keep buttons active */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.queryId]);

  async function cast(trusted: boolean) {
    if (saving || vote !== null) return;
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/sleep-agent/trust`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queryId: props.queryId, trusted }),
      });
      if (res.ok) {
        setVote(trusted);
        try {
          localStorage.setItem(
            TRUST_VOTE_KEY_PREFIX + props.queryId,
            trusted ? "yes" : "no",
          );
        } catch {
          /* noop */
        }
      }
    } catch {
      /* network failure: leave buttons active */
    } finally {
      setSaving(false);
    }
  }

  const btnStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: "7px 0",
    borderRadius: 8,
    border: `1px solid ${active ? "#8B1A1A" : "rgba(139,26,26,.25)"}`,
    background: active ? "#8B1A1A" : "#fff",
    color: active ? "#fff" : "#8B1A1A",
    fontSize: 12,
    fontWeight: 600,
    cursor: vote === null && !saving ? "pointer" : "default",
    opacity: saving ? 0.6 : 1,
    fontFamily: "-apple-system, system-ui, sans-serif",
  });

  return (
    <div
      data-testid="trust-vote-card"
      style={{
        paddingTop: 14,
        marginTop: 14,
        borderTop: "1px solid rgba(139,26,26,.10)",
      }}
    >
      <div
        style={{
          fontSize: 9.5,
          fontWeight: 700,
          letterSpacing: ".15em",
          color: "#8B1A1A",
          textTransform: "uppercase",
          marginBottom: 6,
        }}
      >
        {t("sleepAgent.conversation.rail.trust.title")}
      </div>
      {vote !== null ? (
        <div
          data-testid="trust-vote-thanks"
          style={{ fontSize: 11.5, color: "#8a7a72", lineHeight: 1.5 }}
        >
          {t("sleepAgent.conversation.rail.trust.thanks")}
        </div>
      ) : (
        <>
          <div
            style={{
              fontSize: 11.5,
              color: "#5a4a42",
              lineHeight: 1.5,
              marginBottom: 8,
            }}
          >
            {t("sleepAgent.conversation.rail.trust.question")}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              data-testid="button-trust-yes"
              onClick={() => void cast(true)}
              disabled={saving}
              style={btnStyle(false)}
            >
              {t("sleepAgent.conversation.rail.trust.yes")}
            </button>
            <button
              type="button"
              data-testid="button-trust-no"
              onClick={() => void cast(false)}
              disabled={saving}
              style={btnStyle(false)}
            >
              {t("sleepAgent.conversation.rail.trust.no")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * "Get personal help" contact form — name/email/message, emailed to the team
 * via the guarded send path on the server (POST /sleep-agent/contact). The
 * modal mounts fresh each open, so form state never leaks between opens.
 */
function ContactModal(props: { context: string | null; onClose: () => void }) {
  const { t } = useTranslation("common");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (state === "sending" || state === "sent") return;
    setState("sending");
    try {
      const res = await fetch(`${API_BASE}/sleep-agent/contact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          message,
          context: props.context ?? undefined,
        }),
      });
      setState(res.ok ? "sent" : "error");
    } catch {
      setState("error");
    }
  }

  const fieldStyle: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid rgba(139,26,26,.22)",
    fontSize: 14,
    color: "#1a0505",
    background: "#fff",
    fontFamily: "-apple-system, system-ui, sans-serif",
    outline: "none",
  };
  const labelStyle: React.CSSProperties = {
    display: "block",
    fontSize: 12,
    fontWeight: 600,
    color: "#5a4a42",
    marginBottom: 5,
  };

  return (
    <div
      data-testid="contact-modal-overlay"
      onClick={props.onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 95,
        background: "rgba(26,5,5,.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 18,
      }}
    >
      <div
        data-testid="contact-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t("sleepAgent.contact.title")}
        style={{
          width: "100%",
          maxWidth: 440,
          maxHeight: "88vh",
          overflowY: "auto",
          background: "#FDFBF7",
          borderRadius: 16,
          padding: "24px 26px 28px",
          boxSizing: "border-box",
          boxShadow: "0 18px 60px rgba(26,5,5,.3)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 6,
          }}
        >
          <div
            style={{
              fontSize: 17,
              color: "#1a0505",
              fontFamily: "'Georgia','Times New Roman',serif",
            }}
          >
            {t("sleepAgent.contact.title")}
          </div>
          <button
            type="button"
            data-testid="contact-modal-close"
            onClick={props.onClose}
            aria-label={t("sleepAgent.contact.close")}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: 22,
              lineHeight: 1,
              color: "#8a7a72",
              padding: 4,
            }}
          >
            ×
          </button>
        </div>

        {state === "sent" ? (
          <div data-testid="contact-sent">
            <div
              style={{
                fontSize: 14,
                color: "#1a6b3c",
                fontWeight: 600,
                margin: "14px 0 8px",
              }}
            >
              {t("sleepAgent.contact.sentTitle")}
            </div>
            <div
              style={{
                fontSize: 13.5,
                color: "#5a4a42",
                lineHeight: 1.55,
                marginBottom: 18,
              }}
            >
              {t("sleepAgent.contact.sentBody")}
            </div>
            <button
              type="button"
              onClick={props.onClose}
              style={{
                padding: "10px 20px",
                borderRadius: 10,
                border: "none",
                background: "#8B1A1A",
                color: "#fff",
                fontSize: 13.5,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {t("sleepAgent.contact.close")}
            </button>
          </div>
        ) : (
          <>
            <div
              style={{
                fontSize: 13,
                color: "#8a7a72",
                lineHeight: 1.55,
                marginBottom: 16,
              }}
            >
              {t("sleepAgent.contact.intro")}
            </div>
            <form onSubmit={submit}>
              <div style={{ marginBottom: 12 }}>
                <label style={labelStyle} htmlFor="contact-name">
                  {t("sleepAgent.contact.name")}
                </label>
                <input
                  id="contact-name"
                  data-testid="input-contact-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t("sleepAgent.contact.namePlaceholder")}
                  style={fieldStyle}
                />
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={labelStyle} htmlFor="contact-email">
                  {t("sleepAgent.contact.email")}
                </label>
                <input
                  id="contact-email"
                  data-testid="input-contact-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t("sleepAgent.contact.emailPlaceholder")}
                  style={fieldStyle}
                />
              </div>
              <div style={{ marginBottom: 16 }}>
                <label style={labelStyle} htmlFor="contact-message">
                  {t("sleepAgent.contact.message")}
                </label>
                <textarea
                  id="contact-message"
                  data-testid="input-contact-message"
                  required
                  minLength={5}
                  rows={4}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder={t("sleepAgent.contact.messagePlaceholder")}
                  style={{ ...fieldStyle, resize: "vertical" }}
                />
              </div>
              {state === "error" && (
                <div
                  data-testid="contact-error"
                  style={{
                    fontSize: 12.5,
                    color: "#b91c1c",
                    marginBottom: 12,
                  }}
                >
                  {t("sleepAgent.contact.error")}
                </div>
              )}
              <button
                type="submit"
                data-testid="button-contact-send"
                disabled={state === "sending"}
                style={{
                  padding: "11px 22px",
                  borderRadius: 10,
                  border: "none",
                  background:
                    state === "sending" ? "rgba(139,26,26,.5)" : "#8B1A1A",
                  color: "#fff",
                  fontSize: 13.5,
                  fontWeight: 600,
                  cursor: state === "sending" ? "wait" : "pointer",
                }}
              >
                {state === "sending"
                  ? t("sleepAgent.contact.sending")
                  : t("sleepAgent.contact.send")}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

function GovernanceRail(props: {
  turn: ConversationTurn;
  showsCurrent: boolean;
  variant: "desktop" | "sheet";
  onSelectLatest: () => void;
  onOpenSource: (id: number) => void;
  onAvatarClick: (steward: StewardInfo) => void;
  /** Live-answer engagement blocks (save, poll, journey, share, flag…) —
      only passed when the rail shows the CURRENT turn, so a prior-turn
      snapshot never carries live-answer state. */
  extras?: React.ReactNode;
  /** 7-night usage-guide invitation — live answer only, and only when the
      answer stayed on the sleep pillar (never for other-pillar routings). */
  journeyInvite?: React.ReactNode;
}) {
  const { t } = useTranslation("common");
  const { turn, showsCurrent, variant } = props;
  const [shareCopied, setShareCopied] = useState(false);
  // Desktop: everything beyond Steward / Sources / Share lives in a
  // slide-in-from-the-left details panel behind this toggle.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsCloseRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!detailsOpen) return;
    detailsCloseRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDetailsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailsOpen]);
  const cov = coverageOf(turn);
  const sources = collapseSameWork(turn.provenance);
  const covStyles: Record<
    CoverageState,
    { color: string; bg: string; border: string }
  > = {
    covered: {
      color: "#1a6b3c",
      bg: "rgba(26,107,60,.07)",
      border: "rgba(26,107,60,.25)",
    },
    fallback: {
      color: "#8a5a1a",
      bg: "rgba(138,90,26,.07)",
      border: "rgba(138,90,26,.28)",
    },
    boundary: {
      color: "#8B1A1A",
      bg: "rgba(139,26,26,.05)",
      border: "rgba(139,26,26,.22)",
    },
    refuse: {
      color: "#666666",
      bg: "rgba(0,0,0,.04)",
      border: "rgba(0,0,0,.14)",
    },
    unverified: {
      color: "#8a6a5a",
      bg: "rgba(138,106,90,.07)",
      border: "rgba(138,106,90,.25)",
    },
  };
  const cs = covStyles[cov];
  const eyebrowStyle: React.CSSProperties = {
    fontSize: 9.5,
    fontWeight: 700,
    letterSpacing: ".15em",
    color: "#8B1A1A",
    textTransform: "uppercase",
    marginBottom: 6,
  };
  /* Toggleable rail category — <summary> styled like the section eyebrows
     so collapsed categories read as part of the same column. */
  const railSummaryStyle: React.CSSProperties = {
    ...eyebrowStyle,
    cursor: "pointer",
    listStyle: "none",
    display: "flex",
    alignItems: "center",
    gap: 5,
    marginBottom: 0,
  };
  const railSectionStyle: React.CSSProperties = {
    paddingTop: 14,
    marginTop: 14,
    borderTop: "1px solid rgba(139,26,26,.10)",
  };
  const stewardInitials = (turn.steward?.fullName ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
  // Real portrait wherever we have one: API photo first, curated static
  // headshot by surname second, monogram last.
  const stewardPortrait =
    turn.steward?.photoUrl ?? stewardPortraitUrl(turn.steward?.fullName);

  // Engagement cards — both bound to THIS turn's snapshot. Share text is
  // rebuilt per turn (a follow-up can carry a different steward); the trust
  // vote only exists for real logged answers (blocked/errored turns never
  // get a queryId, refusals and bare boundary lines are not answers).
  const turnParsed = parseAnswer(turn.raw);
  const shareText =
    turnParsed.kind === "structured"
      ? buildShareTextFor(turnParsed, turn, t)
      : null;
  const voteable = !!turn.queryId && cov !== "refuse" && cov !== "boundary";

  const earlierNav = !showsCurrent ? (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          fontSize: 11,
          color: "#8a7a72",
          lineHeight: 1.5,
          marginBottom: 6,
        }}
      >
        {t("sleepAgent.conversation.rail.earlierTurn")}
      </div>
      <button
        type="button"
        data-testid="button-rail-latest"
        onClick={props.onSelectLatest}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 600,
          color: "#8B1A1A",
          textDecoration: "underline",
          textUnderlineOffset: 3,
        }}
      >
        {t("sleepAgent.conversation.rail.backToLatest")}
      </button>
    </div>
  ) : null;

  const coverageBlock = (
    <>
      <div
        data-testid="rail-coverage"
        style={{
          display: "inline-block",
          padding: "4px 10px",
          borderRadius: 999,
          fontSize: 9.5,
          fontWeight: 700,
          letterSpacing: ".12em",
          textTransform: "uppercase",
          color: cs.color,
          background: cs.bg,
          border: `1px solid ${cs.border}`,
          marginBottom: 8,
        }}
      >
        {t(`sleepAgent.conversation.rail.coverage.${cov}`)}
      </div>
      <div
        style={{
          fontSize: 11.5,
          color: "#8a7a72",
          lineHeight: 1.55,
          marginBottom: 18,
        }}
      >
        {t(`sleepAgent.conversation.rail.coverageNote.${cov}`)}
      </div>
    </>
  );

  const pillarBlock = turn.winnerPillarName ? (
    <div style={{ marginBottom: 18 }}>
      <div style={eyebrowStyle}>{t("sleepAgent.conversation.rail.pillar")}</div>
      <div
        data-testid="rail-pillar"
        style={{
          fontSize: 14.5,
          color: "#1a0505",
          fontFamily: "'Georgia','Times New Roman',serif",
        }}
      >
        {turn.winnerPillarName}
      </div>
    </div>
  ) : null;

  const stewardBlock = turn.steward?.fullName ? (
    <div style={{ marginBottom: 18 }}>
      <div style={eyebrowStyle}>{t("sleepAgent.answer.answerSteward")}</div>
      <button
        type="button"
        data-testid="button-steward-avatar-card"
        onClick={() => props.onAvatarClick(turn.steward!)}
        title={`About ${turn.steward.fullName}`}
        aria-label={`About ${turn.steward.fullName}`}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
          display: "block",
          marginBottom: 8,
        }}
      >
        {stewardPortrait ? (
          <img
            src={stewardPortrait}
            alt=""
            style={{
              width: 56,
              height: 56,
              borderRadius: "50%",
              objectFit: "cover",
              display: "block",
              border: "2px solid rgba(139,26,26,.18)",
              boxShadow: "0 4px 14px rgba(26,5,5,.10)",
            }}
          />
        ) : (
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: "50%",
              background: "linear-gradient(135deg, #8B1A1A, #5e0f0f)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
              fontSize: 20,
              fontWeight: 600,
              fontFamily: "'Georgia','Times New Roman',serif",
            }}
          >
            {stewardInitials}
          </div>
        )}
      </button>
      <div
        style={{
          fontSize: 15,
          lineHeight: 1.25,
          color: "#1a0505",
          fontFamily: "'Georgia','Times New Roman',serif",
          marginBottom: 3,
        }}
      >
        {turn.steward.fullName}
      </div>
      {turn.steward.institution && (
        <div style={{ fontSize: 11.5, color: "#8a7a72", lineHeight: 1.4 }}>
          {turn.steward.institution}
        </div>
      )}
    </div>
  ) : null;

  const tryThisBlock =
    turnParsed.kind === "structured" && turnParsed.action ? (
      <div
        style={{
          marginBottom: 18,
          paddingTop: 14,
          borderTop: "1px solid rgba(139,26,26,.10)",
        }}
      >
        <details open>
          <summary style={railSummaryStyle}>
            {t("sleepAgent.answer.tryThis")}
          </summary>
          <div
            style={{
              marginTop: 8,
              padding: "10px 12px",
              background: "rgba(139,26,26,0.05)",
              border: "1px solid rgba(139,26,26,0.13)",
              borderRadius: 10,
              fontSize: 12.5,
              color: "#2a1010",
              lineHeight: 1.5,
              fontWeight: 500,
              fontFamily:
                "-apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif",
            }}
          >
            {turnParsed.action}
          </div>
        </details>
      </div>
    ) : null;

  const alsoBlock =
    turn.alsoCovered.length > 0 ? (
      <div
        style={{
          marginBottom: 18,
          paddingTop: 14,
          borderTop: "1px solid rgba(139,26,26,.10)",
        }}
      >
        <div style={eyebrowStyle}>
          {t("sleepAgent.conversation.rail.alsoAnswered")}
        </div>
        {turn.alsoCovered.map((ac) => {
          const href = `/t/${ac.slug}`;
          const displayName = ac.name;
          return (
            <a
              key={ac.slug}
              href={href}
              data-testid={`also-covered-${ac.slug}`}
              style={{
                display: "block",
                marginBottom: 10,
                textDecoration: "none",
              }}
            >
              <div
                style={{
                  fontSize: 12.5,
                  lineHeight: 1.3,
                  color: "#1a0505",
                  fontFamily: "'Georgia','Times New Roman',serif",
                }}
              >
                {ac.leadSteward?.fullName ?? displayName}
              </div>
              {ac.leadSteward?.institution && (
                <div
                  style={{ fontSize: 10.5, color: "#8a7a72", lineHeight: 1.4 }}
                >
                  {ac.leadSteward.institution}
                </div>
              )}
              <div
                style={{
                  marginTop: 2,
                  fontSize: 10.5,
                  color: "#8B1A1A",
                  fontWeight: 600,
                  fontFamily: "-apple-system, system-ui, sans-serif",
                }}
              >
                {t("sleepAgent.answer.visitPillar", { name: displayName })}
              </div>
            </a>
          );
        })}
      </div>
    ) : null;

  const sourcesBlock =
    sources.length > 0 ? (
      <div
        style={{ paddingTop: 14, borderTop: "1px solid rgba(139,26,26,.10)" }}
      >
        <div style={eyebrowStyle}>
          {t("sleepAgent.conversation.rail.sources")}
        </div>
        {sources.map((p) => (
          <button
            key={`${p.source_id}-${p.interpretation_id ?? "x"}`}
            type="button"
            data-testid={`rail-source-${p.source_id}`}
            onClick={() => props.onOpenSource(p.source_id)}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              background: "none",
              border: "none",
              padding: "6px 0",
              cursor: "pointer",
              borderBottom: "1px solid rgba(139,26,26,.06)",
            }}
          >
            <div
              style={{
                fontSize: 11.5,
                lineHeight: 1.4,
                color: "#1a0505",
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {p.title}
            </div>
            <div style={{ fontSize: 10, color: "#8a7a72", marginTop: 2 }}>
              {[p.authors?.split(",")[0], p.year].filter(Boolean).join(" · ")}
            </div>
          </button>
        ))}
      </div>
    ) : null;

  const citationBlock =
    turnParsed.kind === "structured" && turnParsed.citation ? (
      <div style={railSectionStyle}>
        <details data-testid="answer-citation">
          <summary style={railSummaryStyle}>
            {t("sleepAgent.answer.source")}
          </summary>
          {(() => {
            const target = matchProvenance(
              turn.provenance,
              turnParsed.citation,
              turnParsed.paper,
            );
            const onJump = target
              ? () => props.onOpenSource(target.source_id)
              : undefined;
            return (
              <div
                onClick={onJump}
                title={
                  onJump ? t("sleepAgent.answer.seeFullSource") : undefined
                }
                style={{
                  marginTop: 8,
                  cursor: onJump ? "pointer" : "default",
                  borderRadius: 6,
                  transition: "background-color .15s",
                }}
                onMouseEnter={(e) => {
                  if (onJump)
                    e.currentTarget.style.backgroundColor =
                      "rgba(139,26,26,0.03)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "transparent";
                }}
              >
                <div
                  style={{
                    fontSize: 11.5,
                    color: "#8B1A1A",
                    fontWeight: 600,
                    marginBottom: 3,
                    letterSpacing: ".01em",
                    lineHeight: 1.4,
                  }}
                >
                  {turnParsed.citation}
                </div>
                {turnParsed.paper && (
                  <div
                    style={{
                      fontSize: 11,
                      fontStyle: "italic",
                      color: "#555",
                      lineHeight: 1.45,
                      marginBottom: 5,
                    }}
                  >
                    {turnParsed.paper}
                  </div>
                )}
                {turnParsed.finding && (
                  <div style={{ fontSize: 11, color: "#777", lineHeight: 1.5 }}>
                    {turnParsed.finding}
                  </div>
                )}
              </div>
            );
          })()}
        </details>
      </div>
    ) : null;

  const advisorBlock =
    turnParsed.kind === "structured" && turnParsed.advisorNote ? (
      <div style={railSectionStyle}>
        <details>
          <summary style={railSummaryStyle}>
            {t("sleepAgent.answer.advisorTip")}
          </summary>
          <div
            style={{
              marginTop: 8,
              padding: "10px 12px",
              background: "rgba(139,26,26,0.04)",
              borderLeft: "3px solid #8B1A1A",
              borderRadius: "0 8px 8px 0",
              fontSize: 12,
              color: "#2a1010",
              lineHeight: 1.55,
              fontFamily:
                "-apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif",
            }}
          >
            {turnParsed.advisorNote}
          </div>
        </details>
      </div>
    ) : null;

  const shareBlock = shareText ? (
    <div
      data-testid="rail-share-card"
      style={{
        paddingTop: 14,
        marginTop: 14,
        borderTop: "1px solid rgba(139,26,26,.10)",
      }}
    >
      <div style={eyebrowStyle}>
        {t("sleepAgent.conversation.rail.share.title")}
      </div>
      <div
        style={{
          fontSize: 11.5,
          color: "#5a4a42",
          lineHeight: 1.5,
          marginBottom: 8,
        }}
      >
        {t("sleepAgent.conversation.rail.share.body")}
      </div>
      <button
        type="button"
        data-testid="button-rail-share"
        onClick={() => {
          void copyPlainText(shareText).then(() => {
            setShareCopied(true);
            setTimeout(() => setShareCopied(false), 2000);
          });
        }}
        style={{
          width: "100%",
          padding: "7px 0",
          borderRadius: 8,
          border: `1px solid ${shareCopied ? "#8B1A1A" : "rgba(139,26,26,.25)"}`,
          background: shareCopied ? "#8B1A1A" : "#fff",
          color: shareCopied ? "#fff" : "#8B1A1A",
          fontSize: 12,
          fontWeight: 600,
          cursor: "pointer",
          fontFamily: "-apple-system, system-ui, sans-serif",
          transition: "background-color .15s, color .15s",
        }}
      >
        {shareCopied
          ? t("sleepAgent.conversation.rail.share.copied")
          : t("sleepAgent.conversation.rail.share.copy")}
      </button>
    </div>
  ) : null;

  const trustBlock =
    voteable && turn.queryId ? (
      <TrustVoteCard key={turn.queryId} queryId={turn.queryId} />
    ) : null;

  // Mobile sheet keeps the full governance content in one scroll.
  if (variant === "sheet") {
    return (
      <div data-testid="governance-rail-sheet">
        {earlierNav}
        {coverageBlock}
        {pillarBlock}
        {stewardBlock}
        {tryThisBlock}
        {alsoBlock}
        {sourcesBlock}
        {citationBlock}
        {advisorBlock}
        {shareBlock}
        {trustBlock}
        {props.journeyInvite}
        {props.extras}
      </div>
    );
  }

  // Desktop: minimal rail — key elements only (Steward · Sources · Share,
  // plus the 7-night usage guide for sleep answers). Everything else slides
  // in from the left behind the "All details" toggle.
  return (
    <aside
      className="gov-rail"
      style={{
        position: "absolute",
        left: "100%",
        top: 4,
        marginLeft: 32,
        width: 200,
        animation: "fadeInInvite 0.5s ease 0.15s both",
      }}
    >
      <div data-testid="governance-rail-desktop">
        {earlierNav}
        {/* Non-covered answers have no steward card — keep the coverage badge
            visible so the minimal rail is never blank. */}
        {!stewardBlock && coverageBlock}
        {stewardBlock}
        {sourcesBlock}
        {shareBlock}
        {props.journeyInvite}
        <div style={railSectionStyle}>
          <button
            type="button"
            data-testid="button-rail-details"
            onClick={() => setDetailsOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={detailsOpen}
            style={{
              width: "100%",
              padding: "7px 0",
              borderRadius: 8,
              border: "1px solid rgba(139,26,26,.25)",
              background: "none",
              color: "#8B1A1A",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: "-apple-system, system-ui, sans-serif",
            }}
          >
            {t("sleepAgent.conversation.rail.detailsOpen")}
          </button>
        </div>
      </div>
      {detailsOpen && (
        <div
          data-testid="rail-details-overlay"
          onClick={() => setDetailsOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 90,
            background: "rgba(26,5,5,.35)",
          }}
        >
          <div
            data-testid="rail-details-panel"
            role="dialog"
            aria-modal="true"
            aria-label={t("sleepAgent.conversation.rail.title")}
            onClick={(e) => e.stopPropagation()}
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: 360,
              maxWidth: "88vw",
              background: "#FDFBF7",
              boxShadow: "10px 0 44px rgba(26,5,5,.20)",
              padding: "20px 24px 34px",
              overflowY: "auto",
              boxSizing: "border-box",
              animation: "railSlideInLeft .28s ease both",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 16,
              }}
            >
              <div
                style={{
                  fontSize: 10.5,
                  fontWeight: 700,
                  letterSpacing: ".16em",
                  color: "#8B1A1A",
                  textTransform: "uppercase",
                }}
              >
                {t("sleepAgent.conversation.rail.title")}
              </div>
              <button
                type="button"
                ref={detailsCloseRef}
                data-testid="rail-details-close"
                onClick={() => setDetailsOpen(false)}
                aria-label={t("sleepAgent.conversation.rail.close")}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  fontSize: 22,
                  lineHeight: 1,
                  color: "#8a7a72",
                  padding: 4,
                }}
              >
                ×
              </button>
            </div>
            {coverageBlock}
            {pillarBlock}
            {tryThisBlock}
            {alsoBlock}
            {citationBlock}
            {advisorBlock}
            {trustBlock}
            {props.extras}
          </div>
        </div>
      )}
      <style>{`
        .gov-rail { display: none; }
        @media (min-width: 1200px) { .gov-rail { display: block; } }
        @keyframes railSlideInLeft {
          from { transform: translateX(-100%); }
          to { transform: translateX(0); }
        }
      `}</style>
    </aside>
  );
}

/** Best supported MediaRecorder mime for voice capture (Safari needs mp4). */
function pickRecorderMime(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg",
  ];
  try {
    for (const c of candidates) {
      if (
        typeof MediaRecorder !== "undefined" &&
        MediaRecorder.isTypeSupported(c)
      )
        return c;
    }
  } catch {
    /* noop */
  }
  return "";
}

const AUTH_KEY = "palonur_demo_authed";
const USER_ID_KEY = "palonur_user_id";
const USER_NAME_KEY = "palonur_user_name";
const USER_EMAIL_KEY = "palonur_user_email";

function isAuthed() {
  try {
    return sessionStorage.getItem(AUTH_KEY) === "1";
  } catch {
    return false;
  }
}
// Auto-create claim flag: set when an emailed "save this answer" magic link
// lands back here (?claimed=1). Deliberately separate from USER_ID_KEY — the
// journey profile id is minted only by the real onboarding flow.
const REGISTERED_KEY = "palonur_registered";

function isRegistered() {
  try {
    return (
      !!localStorage.getItem(USER_ID_KEY) ||
      localStorage.getItem(REGISTERED_KEY) === "1"
    );
  } catch {
    return false;
  }
}

function getGreetingKey(): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return "sleepAgent.greeting.morning";
  if (h >= 12 && h < 17) return "sleepAgent.greeting.afternoon";
  if (h >= 17 && h < 21) return "sleepAgent.greeting.evening";
  return "sleepAgent.greeting.night";
}

// ── Answer-format poll ──────────────────────────────────────────────────────
// "What do you like more: avatar, podcast, text?" One vote per visitor
// (server upserts by IP hash); the choice is also remembered locally so the
// widget shows your pick on return. Tallies feed the Votes tab in /admin.
const VOTE_STORAGE_KEY = "palonur_format_vote";
const VOTE_OPTION_KEYS = ["text", "podcast", "avatar"] as const;
type VoteOptionKey = (typeof VOTE_OPTION_KEYS)[number];

type StewardMeta = {
  fullName: string | null;
  institution: string | null;
  photoUrl: string | null;
} | null;

/** Same light markdown strip the Listen button applies before TTS. */
function stripMdLite(t: string): string {
  return t
    .replace(/\*\*\*(.*?)\*\*\*/g, "$1")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/^#+\s*/gm, "")
    .trim();
}

/** Live avatar demo — the steward's portrait "speaks" the answer aloud
 *  (voice via the existing TTS route) with pulse rings + a waveform while
 *  playing, so visitors experience the avatar format before voting on it. */
function AvatarDemo({
  steward,
  speakText,
}: {
  steward: StewardMeta;
  speakText: string;
}) {
  const { t } = useTranslation("common");
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  // Set at unmount so a TTS fetch that resolves afterwards neither plays
  // orphaned audio nor leaks its object URL.
  const cancelledRef = useRef(false);

  useEffect(
    () => () => {
      cancelledRef.current = true;
      audioRef.current?.pause();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  function stop() {
    audioRef.current?.pause();
    audioRef.current = null;
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    if (!cancelledRef.current) setState("idle");
  }

  async function toggle() {
    if (state === "playing") {
      stop();
      return;
    }
    if (state === "loading" || !speakText) return;
    setState("loading");
    try {
      const res = await fetch(`${API_BASE}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: stripMdLite(speakText) }),
      });
      if (!res.ok) throw new Error("TTS failed");
      const blob = await res.blob();
      if (cancelledRef.current) return;
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => stop();
      audio.onerror = () => stop();
      setState("playing");
      await audio.play();
    } catch {
      stop();
    }
  }

  // Named-expert gating: `steward` is null unless the answer is
  // facultyVerified. Unverified answers get a fully anonymous demo — no
  // name, no initials — matching every other attribution surface.
  const name = steward?.fullName ?? null;
  const initials = name
    ? name
        .split(/\s+/)
        .map((w) => w[0])
        .filter(Boolean)
        .slice(0, 2)
        .join("")
        .toUpperCase()
    : null;
  const avatarPortrait = steward?.photoUrl ?? stewardPortraitUrl(name);
  const playing = state === "playing";
  const loading = state === "loading";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 10,
      }}
    >
      <div
        style={{ position: "relative", width: 72, height: 72, flexShrink: 0 }}
      >
        {playing && (
          <>
            <span
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: "50%",
                border: "2px solid rgba(139,26,26,.45)",
                animation: "avatarRing 1.6s ease-out infinite",
              }}
            />
            <span
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: "50%",
                border: "2px solid rgba(139,26,26,.3)",
                animation: "avatarRing 1.6s ease-out .55s infinite",
              }}
            />
          </>
        )}
        {avatarPortrait ? (
          <img
            src={avatarPortrait}
            alt={name ?? "The expert"}
            style={{
              width: 72,
              height: 72,
              borderRadius: "50%",
              objectFit: "cover",
              border: playing
                ? "2.5px solid #8B1A1A"
                : "2.5px solid rgba(139,26,26,.25)",
              transition: "border-color .2s",
              display: "block",
            }}
          />
        ) : (
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: "50%",
              background: "rgba(139,26,26,.08)",
              border: playing
                ? "2.5px solid #8B1A1A"
                : "2.5px solid rgba(139,26,26,.25)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 22,
              fontWeight: 700,
              color: "#8B1A1A",
              fontFamily: "'Georgia', 'Times New Roman', serif",
              transition: "border-color .2s",
            }}
          >
            {initials ?? (
              <svg
                width="30"
                height="30"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            )}
          </div>
        )}
      </div>
      <div
        style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 16 }}
        aria-hidden
      >
        {[0, 1, 2, 3, 4].map((i) => (
          <span
            key={i}
            style={{
              width: 3,
              height: 16,
              borderRadius: 2,
              background: playing ? "#8B1A1A" : "rgba(139,26,26,.2)",
              transformOrigin: "bottom",
              transform: playing ? undefined : "scaleY(.3)",
              animation: playing
                ? `voteBar 1s ease-in-out ${i * 0.13}s infinite`
                : "none",
              transition: "background .2s",
            }}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={toggle}
        disabled={loading || !speakText}
        data-testid="avatar-demo-play"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          background: playing ? "rgba(139,26,26,0.12)" : "rgba(139,26,26,0.07)",
          border: `1.5px solid ${playing ? "rgba(139,26,26,0.45)" : "rgba(139,26,26,0.22)"}`,
          borderRadius: 22,
          padding: "7px 14px",
          cursor: loading ? "default" : "pointer",
          color: playing ? "#8B1A1A" : "#6b3030",
          fontSize: 12.5,
          fontWeight: 600,
          opacity: loading ? 0.6 : 1,
          transition: "background .15s, border-color .15s",
          whiteSpace: "nowrap",
        }}
      >
        {loading ? (
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ animation: "spin 1s linear infinite" }}
          >
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        ) : playing ? (
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="6" y="4" width="4" height="16" />
            <rect x="14" y="4" width="4" height="16" />
          </svg>
        ) : (
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="currentColor"
            stroke="none"
          >
            <polygon points="8 5 19 12 8 19 8 5" />
          </svg>
        )}
        <span>
          {loading
            ? t("sleepAgent.avatarDemo.preparing")
            : playing
              ? t("sleepAgent.avatarDemo.stop")
              : t("sleepAgent.avatarDemo.preview")}
        </span>
      </button>
      <div
        style={{
          fontSize: 10.5,
          color: "#a89a92",
          textAlign: "center",
          lineHeight: 1.4,
        }}
      >
        {t("sleepAgent.avatarDemo.blurb", { name: name ?? "the expert" })}
      </div>
    </div>
  );
}

function FormatVoteCard({
  steward,
  answerText,
  speakText,
  question,
  sections,
  ready,
  pillar,
}: {
  steward: StewardMeta;
  answerText: string;
  speakText: string;
  question: string;
  sections: { answer?: string; finding?: string; action?: string };
  ready: boolean;
  pillar?: string;
}) {
  const { t } = useTranslation("common");
  const [choice, setChoice] = useState<string | null>(() => {
    try {
      return localStorage.getItem(VOTE_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);

  async function vote(option: string) {
    if (busy) return;
    setBusy(true);
    setChoice(option);
    try {
      localStorage.setItem(VOTE_STORAGE_KEY, option);
    } catch {
      /* no-op */
    }
    try {
      const res = await fetch(`${API_BASE}/format-votes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ option }),
      });
      if (res.ok) {
        const d = await res.json();
        if (d?.counts) {
          setCounts(d.counts);
          setTotal(d.total ?? 0);
        }
      }
    } catch {
      /* local choice already shown */
    }
    setBusy(false);
  }

  const plainAnswer = stripMdLite(answerText);
  const excerpt =
    plainAnswer.length > 170
      ? `${plainAnswer.slice(0, 170).trimEnd()}…`
      : plainAnswer;

  return (
    <div
      style={{
        marginTop: 22,
        padding: "18px 20px 20px",
        borderRadius: 14,
        background: "rgba(139,26,26,0.02)",
        border: "1px solid rgba(139,26,26,.1)",
      }}
    >
      <style>{`
        @keyframes avatarRing { 0% { transform: scale(1); opacity: .55; } 100% { transform: scale(1.75); opacity: 0; } }
        @keyframes voteBar { 0%, 100% { transform: scaleY(.3); } 50% { transform: scaleY(1); } }
      `}</style>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: ".16em",
          color: "#8B1A1A",
          textTransform: "uppercase",
          marginBottom: 8,
        }}
      >
        {t("sleepAgent.voteCard.label")}
      </div>
      <div
        style={{
          fontSize: 15,
          lineHeight: 1.5,
          marginBottom: 14,
          fontFamily: "'Georgia', 'Times New Roman', serif",
          color: "#1a0505",
        }}
      >
        {t("sleepAgent.voteCard.body")}
      </div>
      <div
        style={{
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
          alignItems: "stretch",
        }}
      >
        {VOTE_OPTION_KEYS.map((key) => {
          const active = choice === key;
          const oLabel = t(`sleepAgent.voteCard.options.${key}.label`);
          const oDesc = t(`sleepAgent.voteCard.options.${key}.desc`);
          return (
            <div
              key={key}
              style={{
                flex: "1 1 190px",
                minWidth: 0,
                display: "flex",
                flexDirection: "column",
                borderRadius: 12,
                background: "#fff",
                border: active
                  ? "1.5px solid #8B1A1A"
                  : "1.5px solid rgba(139,26,26,.14)",
                padding: "14px 14px 12px",
                transition: "border-color .15s",
              }}
            >
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: active ? "#8B1A1A" : "#1a0505",
                  marginBottom: 2,
                }}
              >
                {oLabel}
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: "#8a7a72",
                  lineHeight: 1.35,
                  marginBottom: 12,
                }}
              >
                {oDesc}
              </div>
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center",
                  minHeight: 128,
                  marginBottom: 12,
                }}
              >
                {key === "text" && (
                  <div
                    style={{
                      fontSize: 13,
                      lineHeight: 1.5,
                      color: "#3a2020",
                      fontFamily: "'Georgia', 'Times New Roman', serif",
                      display: "-webkit-box",
                      WebkitLineClamp: 6,
                      WebkitBoxOrient: "vertical" as const,
                      overflow: "hidden",
                    }}
                  >
                    “{excerpt}”
                  </div>
                )}
                {key === "podcast" && (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 10,
                    }}
                  >
                    <MinicastButton
                      question={question}
                      sections={sections}
                      ready={ready}
                      pillar={pillar}
                      expert={steward?.fullName ?? undefined}
                    />
                    <div
                      style={{
                        fontSize: 10.5,
                        color: "#a89a92",
                        textAlign: "center",
                        lineHeight: 1.4,
                      }}
                    >
                      {t("sleepAgent.voteCard.podcastBlurb")}
                    </div>
                  </div>
                )}
                {key === "avatar" && (
                  <AvatarDemo steward={steward} speakText={speakText} />
                )}
              </div>
              <button
                onClick={() => vote(key)}
                disabled={busy}
                data-testid={`format-vote-${key}`}
                style={{
                  width: "100%",
                  cursor: "pointer",
                  padding: "8px 12px",
                  borderRadius: 9,
                  border: active
                    ? "1.5px solid #8B1A1A"
                    : "1.5px solid rgba(139,26,26,.22)",
                  background: active ? "#8B1A1A" : "rgba(139,26,26,0.04)",
                  color: active ? "#fff" : "#6b3030",
                  fontSize: 12.5,
                  fontWeight: 600,
                  transition: "background .15s, color .15s, border-color .15s",
                }}
              >
                {active
                  ? t("sleepAgent.voteCard.yourPick")
                  : t("sleepAgent.voteCard.voteFor", {
                      label: oLabel.toLowerCase(),
                    })}
              </button>
            </div>
          );
        })}
      </div>
      {choice && (
        <div style={{ marginTop: 12 }}>
          {counts && total > 0 && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 5,
                marginBottom: 8,
              }}
            >
              {VOTE_OPTION_KEYS.map((k) => {
                const n = counts[k] ?? 0;
                const pct = Math.round((n / total) * 100);
                return (
                  <div
                    key={k}
                    style={{ display: "flex", alignItems: "center", gap: 8 }}
                  >
                    <div
                      style={{ width: 58, fontSize: 11.5, color: "#8a7a72" }}
                    >
                      {t(`sleepAgent.voteCard.options.${k}.label`)}
                    </div>
                    <div
                      style={{
                        flex: 1,
                        height: 6,
                        borderRadius: 3,
                        background: "rgba(139,26,26,.08)",
                      }}
                    >
                      <div
                        style={{
                          width: `${pct}%`,
                          height: "100%",
                          borderRadius: 3,
                          background:
                            choice === k ? "#8B1A1A" : "rgba(139,26,26,.35)",
                          transition: "width .4s ease",
                        }}
                      />
                    </div>
                    <div
                      style={{
                        width: 34,
                        fontSize: 11.5,
                        color: "#8a7a72",
                        textAlign: "right",
                      }}
                    >
                      {pct}%
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div style={{ fontSize: 12, color: "#999" }}>
            {t("sleepAgent.voteCard.thanks")}
          </div>
        </div>
      )}
    </div>
  );
}

type RefusalEvidencePayload = {
  story: {
    question: string;
    pillarName: string;
    sourceTitle: string;
    queuedAt: string;
    approved: boolean;
  } | null;
  uncoveredCount30d: number | null;
};

/**
 * "A real case, not a promise" — shown on the boundary states (REFUSE /
 * UNCOVERED). Renders the latest REAL refusal story from the gap-discovery
 * pipeline (what triggered it, what happened next), or real 30-day edge
 * telemetry as a fallback. Renders nothing when no real data exists — the
 * evidence is never fabricated.
 */
function BoundaryEvidence({
  evidence,
}: {
  evidence: RefusalEvidencePayload | null;
}) {
  const { t, i18n } = useTranslation("common");
  if (!evidence) return null;
  const story = evidence.story;
  const count = evidence.uncoveredCount30d;
  if (!story && !(typeof count === "number" && count > 0)) return null;

  const labelStyle: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: ".16em",
    color: "#8a6a5a",
    textTransform: "uppercase",
    marginBottom: 4,
  };
  const bodyStyle: React.CSSProperties = {
    fontFamily: "'Georgia', 'Times New Roman', serif",
    fontSize: 14.5,
    lineHeight: 1.55,
    color: "#1a0505",
  };

  return (
    <div
      style={{
        marginTop: 14,
        padding: "20px 24px",
        borderRadius: 14,
        background: "rgba(139,26,26,0.02)",
        border: "1px solid rgba(139,26,26,0.1)",
        textAlign: "left",
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: ".16em",
          color: "#8B1A1A",
          textTransform: "uppercase",
          marginBottom: 12,
        }}
      >
        {t("boundaryEvidence.label")}
      </div>
      {story ? (
        <>
          <div style={{ marginBottom: 12 }}>
            <div style={labelStyle}>{t("boundaryEvidence.triggerLabel")}</div>
            <div style={bodyStyle}>
              {t("boundaryEvidence.trigger", {
                date: new Date(story.queuedAt).toLocaleDateString(
                  i18n.language === "de" ? "de-DE" : "en-US",
                  { year: "numeric", month: "long", day: "numeric" },
                ),
                question: story.question,
              })}
            </div>
          </div>
          <div>
            <div style={labelStyle}>{t("boundaryEvidence.nextLabel")}</div>
            <div style={bodyStyle}>
              {t(
                story.approved
                  ? "boundaryEvidence.nextApproved"
                  : "boundaryEvidence.nextPending",
                { title: story.sourceTitle, pillar: story.pillarName },
              )}
            </div>
          </div>
        </>
      ) : (
        <div style={bodyStyle}>
          {t("boundaryEvidence.aggregate", {
            n: (count as number).toLocaleString(
              i18n.language === "de" ? "de-DE" : "en-US",
            ),
          })}
        </div>
      )}
    </div>
  );
}

// hint: Logic changed on both sides. Requires understanding intent of each change.
export default function SleepAgent() {
  const { t, i18n } = useTranslation("common");
  const [location, setLocation] = useLocation();
  const registeredName = (() => {
    try {
      return localStorage.getItem(USER_NAME_KEY);
    } catch {
      return null;
    }
  })();
  const storedUserId = (() => {
    try {
      return localStorage.getItem(USER_ID_KEY);
    } catch {
      return null;
    }
  })();
  const initialQ = (() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      return sp.get("q") ?? "";
    } catch {
      return "";
    }
  })();
  // Doorway comp token (?dw=) from a reply-as-doorway magic link: the server
  // verified the sender's phone, so this visit skips the free-question
  // paywall for the prefilled question. Kept in a ref and sent with every
  // ask; the server enforces expiry + a small use budget.
  const doorwayTokenRef = useRef<string>(
    (() => {
      try {
        return new URLSearchParams(window.location.search).get("dw") ?? "";
      } catch {
        return "";
      }
    })(),
  );

  // Auto-create claim: an emailed magic link landed here (?claimed=1) after
  // the account page consumed the sign-in token. Mark this browser as
  // registered so it skips landing bounces from now on.
  useState(() => {
    try {
      if (new URLSearchParams(window.location.search).get("claimed") === "1") {
        localStorage.setItem(REGISTERED_KEY, "1");
      }
    } catch {
      /* noop */
    }
    return null;
  });

  // Guard: bounce unauthenticated visitors to the sleep landing.
  // A registered user (palonur_user_id in localStorage) counts as authed even
  // if the session-only demo flag has expired — otherwise returning users who
  // tap "Ask another sleep question" from /journey get bounced away
  // instead of landing on the sleep prompt-cards view.
  // A doorway link (?dw=) also passes: the sender texted from a verified
  // registered number, even though this browser may have no local state —
  // bouncing them away at 3am would break the promise the ack text just made.
  // Redirect target is a clean /sleep: SleepRoute in App.tsx re-evaluates
  // (no q/dw, not authed) and renders the sleep landing, so there's no loop.
  // A question in the URL (?q=) also passes: the near-zero-friction first ask
  // sends anonymous visitors here directly from any hero search — the answer
  // must never hide behind a gate.
  useEffect(() => {
    if (
      !isAuthed() &&
      !isRegistered() &&
      !doorwayTokenRef.current &&
      !initialQ
    ) {
      setLocation("/sleep");
    }
  }, [setLocation, initialQ]);

  const [query, setQuery] = useState(initialQ);
  const [submitted, setSubmitted] = useState(initialQ);
  const [speaking, setSpeaking] = useState(false);
  const [ttsLoading, setTtsLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [queryId, setQueryId] = useState<string | null>(null);
  const [provenance, setProvenance] = useState<ProvenanceEntry[]>([]);
  const [pillarNames, setPillarNames] = useState<string[]>([]);
  // Actual retrieval winner from the done event — pillarNames is routing
  // order, not winner-first, so attribution fallbacks must key on this.
  const [winnerPillarName, setWinnerPillarName] = useState<string | null>(null);
  // Other keyword-routed pillars whose approved corpus ALSO covered this
  // question. Rendered as a pointer card under
  // the sources strip — never blended into the signed answer itself.
  const [alsoCovered, setAlsoCovered] = useState<
    Array<{
      slug: string;
      name: string;
      steward: string | null;
      leadSteward?: {
        fullName: string | null;
        institution: string | null;
        photoUrl: string | null;
      } | null;
    }>
  >([]);
  // True only when the server confirms the answer is grounded in Jamie's
  // approved corpus AND the citation guard verified it. Gates every
  // named-expert attribution affordance so ungrounded fallback answers are
  // never stamped "Verified by Prof. Jamie Zeitzer."
  const [facultyVerified, setFacultyVerified] = useState(false);
  // Amber limit notices from the done event — honest-limitation signals for a
  // covered answer (few sources / drafts pending review / near threshold).
  // Empty on well-covered answers and every boundary path.
  const [limitNotices, setLimitNotices] = useState<AnswerLimitNotice[]>([]);
  // True when the answer came from the SLM AI Lab Stanford-wide fallback
  // (done event `slmFallback: true`): a real answer grounded in Stanford's
  // broader published body of work, but NOT steward-reviewed. Renders a
  // distinct eyebrow label and never a named-expert attribution.
  const [slmFallback, setSlmFallback] = useState(false);
  // Citation-guard status from the done event — feeds the "How this answer
  // was built" trajectory panel. null when no check ran.
  const [citationStatus, setCitationStatus] = useState<
    "verified" | "missing" | "unmatched" | null
  >(null);
  // Referral share nudge — shown after first verified answer for registered
  // users, localStorage-dismissible.
  const SHARE_NUDGE_KEY = "palonur_share_nudge_dismissed";
  const [shareNudgeDismissed, setShareNudgeDismissed] = useState(() => {
    try {
      return localStorage.getItem(SHARE_NUDGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [referralCode, setReferralCode] = useState<string | null>(null);
  const [referralCopied, setReferralCopied] = useState(false);
  const answeredCountRef = useRef(0);
  // Winning-pillar steward profile — populated from the SSE done event
  // (winnerSteward field) so the correct steward appears regardless of
  // which pillar answered. Rendered ONLY when facultyVerified is true.
  const [steward, setSteward] = useState<{
    fullName: string | null;
    institution: string | null;
    photoUrl: string | null;
    achievements?: string[];
  } | null>(null);
  // Achievements panel opened by clicking a steward avatar (governance rail
  // or credibility eyebrow). Holds the steward being viewed so a PRIOR turn's
  // steward opens their own panel, not the live turn's.
  const [panelSteward, setPanelSteward] = useState<StewardInfo | null>(null);
  // Track referral click when landing on /sleep?ref=CODE. Sets the ref_code
  // cookie server-side so it persists through sign-in to subscribe.
  useEffect(() => {
    const refCode = new URLSearchParams(window.location.search).get("ref");
    if (!refCode) return;
    fetch(`${API_BASE}/referral/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ code: refCode }),
    }).catch(() => {});
  }, []);
  const [contactOpen, setContactOpen] = useState(false);
  const [flagState, setFlagState] = useState<
    "idle" | "open" | "saving" | "done"
  >("idle");
  const [flagReason, setFlagReason] = useState("");
  const [openSourceId, setOpenSourceId] = useState<number | null>(null);
  const [sourceDetail, setSourceDetail] = useState<SourceDetail | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"" | "credential">("");
  const [logOptedOut, setLogOptedOut] = useState<boolean>(() => {
    try {
      return document.cookie
        .split("; ")
        .some((c) => c.startsWith("palonur_no_log=1"));
    } catch {
      return false;
    }
  });
  const abortRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const askedOnceRef = useRef(false);
  // Chat-style scroll: when a new answer starts rendering, put the reader at
  // the top of that turn (first turn → page top). Fires once per turn.
  const questionBubbleRef = useRef<HTMLDivElement | null>(null);
  const lastScrolledTurnRef = useRef<string | null>(null);

  // Tracks the full context of the current Q&A so we can persist it when done
  const interactionRef = useRef<{
    originalQuestion: string;
    clarifyQuestion?: string;
    clarifyAnswer?: string;
  }>({ originalQuestion: initialQ ?? "" });

  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingName, setOnboardingName] = useState("");
  const [onboardingEmail, setOnboardingEmail] = useState("");
  const [regLoading, setRegLoading] = useState(false);
  const [regSuccess, setRegSuccess] = useState(false);
  const onboardingShownRef = useRef(false);

  const [premiumOpen, setPremiumOpen] = useState(false);
  const [premiumName, setPremiumName] = useState("");
  const [premiumEmail, setPremiumEmail] = useState("");
  const [premiumLoading, setPremiumLoading] = useState(false);
  const [premiumDone, setPremiumDone] = useState(false);

  // Consumer paywall + subscription state. The pending question is captured
  // before the stream state is cleared so the paywall can show the reader
  // exactly what they're one step away from unlocking.
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [pendingPaywallQ, setPendingPaywallQ] = useState("");
  const [isPremium, setIsPremium] = useState(false);

  // Journey pass state
  const [journeyEmail, setJourneyEmail] = useState("");
  const [journeyLoading, setJourneyLoading] = useState(false);
  const [journeyDone, setJourneyDone] = useState(false);
  const [journeyError, setJourneyError] = useState("");
  const [activeJourney, setActiveJourney] = useState(false);
  const [journeyCompleted, setJourneyCompleted] = useState(false);

  // Uncovered escalation state
  const [escalateEmail, setEscalateEmail] = useState("");
  const [escalateState, setEscalateState] = useState<
    "idle" | "submitting" | "done" | "error"
  >("idle");
  const autoEscalateRef = useRef(false);
  const [refusalEvidence, setRefusalEvidence] =
    useState<RefusalEvidencePayload | null>(null);
  const evidenceFetchedRef = useRef(false);

  // ── Ongoing conversation ─────────────────────────────────────────────────
  // Completed turns of the current thread. Each turn carries its OWN
  // governance snapshot (winner pillar, steward, provenance, coverage) —
  // the router can hand any follow-up to a different pillar/steward.
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  // Server-side conversation id (null when logging is opted out — then the
  // client sends a transient history payload instead).
  const [conversationId, setConversationId] = useState<string | null>(null);
  // Free follow-ups left in this conversation (from the done event); null
  // until the server reports it or when the reader is entitled (unlimited).
  const [turnsRemaining, setTurnsRemaining] = useState<number | null>(null);
  // Which turn the governance rail is bound to: null = the live answer.
  const [activeTurnIndex, setActiveTurnIndex] = useState<number | null>(null);
  const [followUpDraft, setFollowUpDraft] = useState("");
  // Highlight-to-ask stays distinct from the reader's typed question. It is
  // shown as a quote in the composer and sent in a separate request field so
  // the server can fence it as untrusted context.
  const [selectedExcerptDraft, setSelectedExcerptDraft] = useState<
    string | null
  >(null);
  const [currentTurnExcerpt, setCurrentTurnExcerpt] = useState<string | null>(
    null,
  );
  const [selectionAction, setSelectionAction] = useState<{
    text: string;
    top: number;
    left: number;
  } | null>(null);
  const followUpInputRef = useRef<HTMLInputElement>(null);
  const selectionActionButtonRef = useRef<HTMLButtonElement>(null);
  // Inline follow-up paywall (never the full-screen modal): the thread stays
  // visible, a card takes the place of the next answer.
  const [followUpPaywall, setFollowUpPaywall] = useState(false);
  // Disambiguation: when the router detects a near-tie between pillars and
  // can't resolve it without user input, the server sends a disambiguate event
  // instead of starting the LLM stream. The client renders a one-tap picker;
  // on tap, `ask()` re-fires with an explicit `pillarLock` slug.
  const [disambig, setDisambig] = useState<Array<{
    slug: string;
    label: string;
  }> | null>(null);
  // Raw question + display label stored at ask() time so re-fires from the
  // disambiguation card always carry the full enriched question.
  const disambigQRef = useRef<string>("");
  const disambigDisplayRef = useRef<string>("");
  const disambigExcerptRef = useRef<string | null>(null);
  const disambigFollowUpRef = useRef(false);
  // Mobile governance sheet open state (<1200px the rail collapses to a pill).
  const [railOpen, setRailOpen] = useState(false);
  // Voice follow-up capture → /sleep-agent/transcribe → composer text.
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recChunksRef = useRef<Blob[]>([]);
  const recStreamRef = useRef<MediaStream | null>(null);
  // Per-turn playback for PRIOR turns (the live answer keeps speaking/ttsLoading).
  const [turnSpeaking, setTurnSpeaking] = useState<number | null>(null);
  const [turnTtsLoading, setTurnTtsLoading] = useState<number | null>(null);

  useEffect(() => {
    const dismissSelectionAction = () => setSelectionAction(null);
    window.addEventListener("resize", dismissSelectionAction);
    window.addEventListener("scroll", dismissSelectionAction, true);
    return () => {
      window.removeEventListener("resize", dismissSelectionAction);
      window.removeEventListener("scroll", dismissSelectionAction, true);
    };
  }, []);

  // Check whether the signed-in user already has an active journey pass.
  useEffect(() => {
    fetch("/api/journey/status", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.active) setActiveJourney(true);
      })
      .catch(() => {});
  }, []);

  // Handle the ?journey_session= param Stripe appends after a payment checkout.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("journey_session");
    if (!sessionId) return;
    // Strip the param from the URL so a refresh doesn't double-confirm.
    const clean =
      window.location.pathname +
      (window.location.search
        .replace(/[?&]journey_session=[^&]+/, "")
        .replace(/^&/, "?") || "");
    window.history.replaceState({}, "", clean);
    fetch("/api/journey/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ sessionId }),
    })
      .then((r) => r.json())
      .then(
        (data: { activated?: boolean; emailVerificationSent?: boolean }) => {
          if (data.activated) {
            setActiveJourney(true);
            setPaywallOpen(false);
          } else if (data.emailVerificationSent) setJourneyDone(true);
        },
      )
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleJourneyCheckout(e: React.FormEvent) {
    e.preventDefault();
    if (!journeyEmail.trim()) return;
    setJourneyLoading(true);
    setJourneyError("");
    try {
      const res = await fetch("/api/beta/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: journeyEmail.trim() }),
      });
      // The server may be mid-restart and answer with a non-JSON error page;
      // never let a parse exception (Safari: "The string did not match the
      // expected pattern.") leak into the UI.
      let data: { ok?: boolean; error?: string } = {};
      try {
        data = (await res.json()) as { ok?: boolean; error?: string };
      } catch {
        /* non-JSON body */
      }
      if (!res.ok) {
        setJourneyError(data.error || t("uncoveredCard.error"));
        return;
      }
      setJourneyDone(true);
    } catch {
      // Network-level failure — show friendly copy, not the raw browser message.
      setJourneyError(t("uncoveredCard.error"));
    } finally {
      setJourneyLoading(false);
    }
  }

  // Guided intake — 2-3 lifestyle-only follow-up questions asked BEFORE the
  // answer so the governed-RAG reply can be sharper. The answer itself still
  // flows through ask() → /sleep-agent, which keeps all REFUSE/UNCOVERED
  // governance, so the reader can always skip straight to an answer.
  const [intakePhase, setIntakePhase] = useState<"idle" | "loading" | "asking">(
    "idle",
  );
  const [intakeQuestions, setIntakeQuestions] = useState<IntakeQuestion[]>([]);
  const [intakeAnswers, setIntakeAnswers] = useState<Record<string, string>>(
    {},
  );
  const [intakeOriginal, setIntakeOriginal] = useState("");
  const intakeAbortRef = useRef<AbortController | null>(null);

  function startNewQuestion(q: string) {
    interactionRef.current = { originalQuestion: q.trim() };
    ask(q);
  }

  // Entry point for a fresh question from the search box / situation cards /
  // ?q= auto-fire. Runs the guided-intake step first; on refuse, skip, or any
  // failure it falls through to ask() so an answer is never blocked.
  async function beginQuestion(q: string) {
    const trimmed = q.trim();
    if (!trimmed) return;
    abortRef.current?.abort();
    intakeAbortRef.current?.abort();
    const ctrl = new AbortController();
    intakeAbortRef.current = ctrl;

    interactionRef.current = { originalQuestion: trimmed };
    setIntakeOriginal(trimmed);
    setIntakeAnswers({});
    setIntakeQuestions([]);
    // Hide any previous answer while we triage.
    setSubmitted("");
    setStreamText("");
    setStreaming(false);
    stopAudio();
    setIntakePhase("loading");

    try {
      const res = await fetch(`${API_BASE}/sleep-agent/intake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed }),
        signal: ctrl.signal,
      });
      const data = (await res.json()) as {
        kind?: string;
        questions?: IntakeQuestion[];
      };
      if (ctrl.signal.aborted) return;
      if (
        data?.kind === "questions" &&
        Array.isArray(data.questions) &&
        data.questions.length > 0
      ) {
        setIntakeQuestions(data.questions);
        setIntakePhase("asking");
        return;
      }
      // refuse / skip / anything unexpected → answer directly. The answer
      // step itself REFUSEs/UNCOVEREDs if appropriate (governance preserved).
      setIntakePhase("idle");
      ask(trimmed, { displayQuestion: trimmed });
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      // Never block the reader on an intake failure.
      setIntakePhase("idle");
      ask(trimmed, { displayQuestion: trimmed });
    }
  }

  // Build the enriched message from the original issue + answered follow-ups
  // and stream the answer. The enriched text is what gets embedded for
  // retrieval AND logged in agent_queries, so provenance reflects what the
  // answer was actually grounded against; the original issue stays as the
  // display/URL question.
  function submitIntake() {
    const original = intakeOriginal.trim();
    if (!original) return;
    const answered = intakeQuestions
      .map((q) => ({ q, a: (intakeAnswers[q.id] ?? "").trim() }))
      .filter((x) => x.a.length > 0);
    interactionRef.current = {
      originalQuestion: original,
      clarifyQuestion: answered.length
        ? answered.map((x) => x.q.question).join(" | ")
        : undefined,
      clarifyAnswer: answered.length
        ? answered.map((x) => x.a).join(" | ")
        : undefined,
    };
    const enriched = answered.length
      ? `${original}\n\nContext from follow-up questions:\n${answered
          .map((x) => `- ${x.q.question} ${x.a}`)
          .join("\n")}`
      : original;
    setIntakePhase("idle");
    ask(enriched, { displayQuestion: original });
  }

  function skipIntake() {
    const original = intakeOriginal.trim();
    if (!original) return;
    interactionRef.current = { originalQuestion: original };
    setIntakePhase("idle");
    ask(original, { displayQuestion: original });
  }

  async function ask(
    q: string,
    opts?: {
      displayQuestion?: string;
      followUp?: boolean;
      pillarLock?: string;
      selectedExcerpt?: string;
    },
  ) {
    const trimmed = q.trim();
    if (!trimmed) return;
    const display = (opts?.displayQuestion ?? q).trim() || trimmed;
    const isFollowUp = opts?.followUp === true;
    const excerpt = opts?.selectedExcerpt
      ? normalizeSelectedExcerpt(opts.selectedExcerpt)
      : null;
    // Store the raw question + display for potential disambiguation re-fires.
    disambigQRef.current = trimmed;
    disambigDisplayRef.current = display;
    disambigExcerptRef.current = excerpt;
    disambigFollowUpRef.current = isFollowUp;
    setDisambig(null);
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // Thread bookkeeping BEFORE the shared per-turn resets below. A follow-up
    // snapshots the just-finished answer (with its own governance fields —
    // the router may hand this next turn to a different pillar/steward); a
    // fresh question starts a brand-new thread.
    let threadTurns = turns;
    if (isFollowUp) {
      if (submitted && streamText) {
        threadTurns = [
          ...turns,
          {
            question: submitted,
            ...(currentTurnExcerpt
              ? { selectedExcerpt: currentTurnExcerpt }
              : {}),
            raw: streamText,
            queryId,
            provenance,
            pillarNames,
            winnerPillarName,
            alsoCovered,
            steward,
            facultyVerified,
            slmFallback,
            citationStatus,
          },
        ];
        setTurns(threadTurns);
      }
    } else {
      threadTurns = [];
      setTurns([]);
      setConversationId(null);
      setTurnsRemaining(null);
    }
    setActiveTurnIndex(null);
    setFollowUpPaywall(false);
    setRailOpen(false);
    setCurrentTurnExcerpt(excerpt);
    setSelectedExcerptDraft(null);
    setSelectionAction(null);

    setSubmitted(display);
    setStreamText("");
    setStreaming(true);
    setQueryId(null);
    setProvenance([]);
    setPillarNames([]);
    setWinnerPillarName(null);
    setAlsoCovered([]);
    setSteward(null);
    setFacultyVerified(false);
    setLimitNotices([]);
    setSlmFallback(false);
    setCitationStatus(null);
    setFlagState("idle");
    setEscalateState("idle");
    setEscalateEmail("");
    autoEscalateRef.current = false;
    setFlagReason("");
    stopAudio();

    // Update the URL query string without re-rendering routes. Follow-ups
    // deliberately keep the ORIGINAL question in ?q= — a reload re-fires the
    // thread opener, not a context-free follow-up fragment.
    if (!isFollowUp) {
      try {
        const url = new URL(window.location.href);
        url.searchParams.set("q", display);
        window.history.replaceState({}, "", url.toString());
      } catch {
        /* noop */
      }
    }

    // Opted-out readers have no server-side conversation row; follow-ups then
    // carry a transient history payload (last 10 messages) instead.
    const historyPayload =
      isFollowUp && !conversationId
        ? threadTurns
            .flatMap((tn) => [
              { role: "user" as const, content: tn.question },
              { role: "assistant" as const, content: tn.raw },
            ])
            .slice(-10)
        : undefined;

    try {
      const res = await fetch(`${API_BASE}/sleep-agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          message: trimmed,
          lang: i18n.language?.slice(0, 2) || "en",
          ...(doorwayTokenRef.current ? { dw: doorwayTokenRef.current } : {}),
          ...(isFollowUp && conversationId ? { conversationId } : {}),
          ...(historyPayload && historyPayload.length
            ? { history: historyPayload }
            : {}),
          ...(display !== trimmed ? { displayQuestion: display } : {}),
          ...(excerpt ? { selectedExcerpt: excerpt } : {}),
          ...(opts?.pillarLock ? { pillar: opts.pillarLock } : {}),
        }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let acc = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const obj = JSON.parse(line.slice(6));
            // Disambiguation: the router detected a near-tie between pillars
            // and can't resolve it without reader input. Show a one-tap picker
            // and stop streaming — no LLM answer will follow on this turn.
            if (obj.disambiguate === true && Array.isArray(obj.candidates)) {
              if (obj.queryId) setQueryId(obj.queryId as string);
              setDisambig(
                (obj.candidates as unknown[]).filter(
                  (c): c is { slug: string; label: string } =>
                    typeof c === "object" &&
                    c != null &&
                    typeof (c as { slug?: unknown }).slug === "string" &&
                    typeof (c as { label?: unknown }).label === "string",
                ),
              );
              continue;
            }
            if (obj.content) {
              acc += obj.content;
              setStreamText(acc);
            }
            if (obj.error) {
              acc += `\n\n[Error: ${obj.error}]`;
              setStreamText(acc);
            }
            if (obj.done && obj.suggest_premium) {
              setSubmitted("");
              setStreamText("");
              openPremiumModal();
            }
            if (obj.done && obj.paywall) {
              if (obj.followUp) {
                // Follow-up allowance exhausted: keep the whole thread on
                // screen and swap the would-be answer for an INLINE card —
                // never the full-screen modal mid-conversation.
                savePendingQuestion(display, "/sleep");
                setSubmitted("");
                setStreamText("");
                setTurnsRemaining(0);
                setFollowUpPaywall(true);
              } else {
                setPendingPaywallQ(display);
                // Persist the held question so it can auto-fire (?q=) the
                // moment the reader returns with an active subscription.
                savePendingQuestion(display, "/sleep");
                setSubmitted("");
                setStreamText("");
                setPaywallOpen(true);
              }
            }
            if (obj.queryId) {
              setQueryId(obj.queryId as string);
            }
            if (Array.isArray(obj.provenance)) {
              setProvenance(obj.provenance as ProvenanceEntry[]);
            }
            if (Array.isArray(obj.pillarNames)) {
              setPillarNames(
                (obj.pillarNames as unknown[]).filter(
                  (n): n is string => typeof n === "string" && n.length > 0,
                ),
              );
            }
            if (Array.isArray(obj.alsoCovered)) {
              setAlsoCovered(
                (obj.alsoCovered as unknown[]).filter(
                  (
                    e,
                  ): e is {
                    slug: string;
                    name: string;
                    steward: string | null;
                    leadSteward?: {
                      fullName: string | null;
                      institution: string | null;
                      photoUrl: string | null;
                    } | null;
                  } =>
                    typeof e === "object" &&
                    e != null &&
                    typeof (e as { slug?: unknown }).slug === "string" &&
                    typeof (e as { name?: unknown }).name === "string",
                ),
              );
            }
            if (obj.done) {
              // Citation-guard correction: the server caught a fabricated
              // citation after streaming — replace the streamed answer with
              // the honest boundary line instead of showing it.
              if (typeof obj.correction === "string" && obj.correction) {
                acc = obj.correction;
                setStreamText(acc);
              }
              if (
                typeof obj.conversationId === "string" &&
                obj.conversationId
              ) {
                setConversationId(obj.conversationId);
              }
              if (typeof obj.turnsRemaining === "number") {
                setTurnsRemaining(obj.turnsRemaining);
              }
              setFacultyVerified(obj.facultyVerified === true);
              setLimitNotices(parseLimitNotices(obj.limitNotices));
              setSlmFallback(obj.slmFallback === true);
              if (
                obj.citationVerification &&
                typeof obj.citationVerification === "object"
              ) {
                const st = (obj.citationVerification as { status?: unknown })
                  .status;
                if (
                  st === "verified" ||
                  st === "missing" ||
                  st === "unmatched"
                ) {
                  setCitationStatus(st);
                }
              }
              if (
                typeof obj.winnerPillarName === "string" &&
                obj.winnerPillarName
              ) {
                setWinnerPillarName(obj.winnerPillarName);
              }
              // Steward profile from the winning pillar — included in the
              // SSE done event so we show the correct steward, not always
              // the sleep steward.
              if (obj.winnerSteward && typeof obj.winnerSteward === "object") {
                const ws = obj.winnerSteward as {
                  fullName?: string | null;
                  institution?: string | null;
                  photoUrl?: string | null;
                  achievements?: string[];
                };
                // Only populate if we have a name — malformed/absent metadata
                // degrades to no attribution rather than an empty card.
                if (ws.fullName) {
                  setSteward({
                    fullName: ws.fullName,
                    institution: ws.institution ?? null,
                    photoUrl: ws.photoUrl ?? null,
                    achievements: Array.isArray(ws.achievements)
                      ? ws.achievements
                      : [],
                  });
                }
              }
              if (!obj.paywall && !obj.suggest_premium) {
                // A full answer landed — any previously held question is moot.
                clearPendingQuestion();
                answeredCountRef.current += 1;
                // Lazy-load referral code for registered/premium users after
                // they've gotten a verified answer, so the share nudge can show.
                if ((isRegistered() || isPremium) && !referralCode) {
                  fetch(`${API_BASE}/referral/code`, { credentials: "include" })
                    .then((r) => (r.ok ? r.json() : null))
                    .then((d: { code: string } | null) => {
                      if (d?.code) setReferralCode(d.code);
                    })
                    .catch(() => {});
                }
              }
            }
          } catch {
            /* ignore */
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setStreamText(
          t("sleepAgent.error.couldNotReach", {
            message: (e as Error).message,
          }),
        );
      }
    } finally {
      setStreaming(false);
    }
  }

  function openPremiumModal() {
    try {
      const storedName = localStorage.getItem(USER_NAME_KEY) ?? "";
      const storedEmail = localStorage.getItem(USER_EMAIL_KEY) ?? "";
      if (storedName) setPremiumName(storedName);
      if (storedEmail) setPremiumEmail(storedEmail);
    } catch {
      /* noop */
    }
    setPremiumOpen(true);
  }

  async function submitWaitlist(e: React.FormEvent) {
    e.preventDefault();
    if (!premiumName.trim() || !premiumEmail.trim()) return;
    setPremiumLoading(true);
    try {
      await fetch(`${API_BASE}/waitlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: premiumName.trim(),
          email: premiumEmail.trim(),
          source: "sleep-agent",
        }),
      });
      setPremiumDone(true);
    } catch {
      /* noop */
    } finally {
      setPremiumLoading(false);
    }
  }

  useEffect(() => {
    if (initialQ && !askedOnceRef.current) {
      askedOnceRef.current = true;
      beginQuestion(initialQ);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The global body background is the dark cosmic #01010A (for the home sky).
  // This page is cream; without overriding it here, the dark background shows
  // through below the content as a black band (overscroll / short pages).
  // index.css paints ALL THREE of html, body and #root dark, so all three
  // must be overridden — body alone leaves html/#root bleeding through.
  useEffect(() => {
    const root = document.getElementById("root");
    const prevBody = document.body.style.background;
    const prevHtml = document.documentElement.style.background;
    const prevRoot = root?.style.background ?? "";
    document.body.style.background = "#fafaf7";
    document.documentElement.style.background = "#fafaf7";
    if (root) root.style.background = "#fafaf7";
    return () => {
      document.body.style.background = prevBody;
      document.documentElement.style.background = prevHtml;
      if (root) root.style.background = prevRoot;
    };
  }, []);

  // Reflect consumer subscription state (premium badge + unlimited access).
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/consumer/me`, { credentials: "include" })
      .then(async (r) => (r.ok ? await r.json() : null))
      .then((d) => {
        if (!cancelled && d?.authenticated && d?.subscription?.active) {
          setIsPremium(true);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch source detail (citation + abstract) when a source sheet is opened.
  useEffect(() => {
    if (openSourceId == null) return;
    let cancelled = false;
    setSourceLoading(true);
    setSourceDetail(null);
    setSourceError(null);
    fetch(`${API_BASE}/sleep-agent/source/${openSourceId}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as SourceDetail;
      })
      .then((d) => {
        if (!cancelled) setSourceDetail(d);
      })
      .catch((e) => {
        if (!cancelled) setSourceError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setSourceLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [openSourceId]);

  // Close the source sheet on Escape.
  useEffect(() => {
    if (openSourceId == null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeSourceSheet();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openSourceId]);

  // Back-fill email for users registered before email storage was added
  useEffect(() => {
    const userId = localStorage.getItem(USER_ID_KEY);
    const stored = localStorage.getItem(USER_EMAIL_KEY);
    if (!userId || stored) return;
    fetch(`${API_BASE}/user/${userId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.email)
          localStorage.setItem(USER_EMAIL_KEY, d.email.toLowerCase());
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const parsed = streamText ? parseAnswer(streamText) : null;
  // Translated copy for the "How this answer was built" trajectory panel.
  const trajectoryLabels: TrajectoryLabels = {
    title: t("sleepAgent.trajectory.title"),
    whereWeLooked: t("sleepAgent.trajectory.whereWeLooked"),
    searchedOne: t("sleepAgent.trajectory.searchedOne"),
    searchedMany: t("sleepAgent.trajectory.searchedMany"),
    whatWeFound: t("sleepAgent.trajectory.whatWeFound"),
    foundSources: t("sleepAgent.trajectory.foundSources"),
    foundNone: t("sleepAgent.trajectory.foundNone"),
    foundSuppressed: t("sleepAgent.trajectory.foundSuppressed"),
    foundFallback: t("sleepAgent.trajectory.foundFallback"),
    checksWeRan: t("sleepAgent.trajectory.checksWeRan"),
    checkApproved: t("sleepAgent.trajectory.checkApproved"),
    checkCoveragePassed: t("sleepAgent.trajectory.checkCoveragePassed"),
    checkCoverageNotPassed: t("sleepAgent.trajectory.checkCoverageNotPassed"),
    checkCitationPassed: t("sleepAgent.trajectory.checkCitationPassed"),
    checkCitationFailed: t("sleepAgent.trajectory.checkCitationFailed"),
  };
  // Show a pillar-matched reading recommendation for every structured answer.
  // `findRelevantArticleForPillar` scopes to the winning pillar's article pool
  // (nutrition, stress-management, cognitive-enhancement, social-connection,
  // movement, sleep) so the suggestion is always on-topic.
  const answerPillar = winnerPillarName ?? pillarNames[0] ?? "";
  const recommendedArticle: SlmArticle | null =
    submitted && !streaming && parsed?.kind === "structured" && answerPillar
      ? findRelevantArticleForPillar(submitted, answerPillar)
      : null;

  // ── Governance rail binding ──────────────────────────────────────────────
  // The rail binds to exactly ONE turn's snapshot. Priority: an explicitly
  // selected prior turn → the completed live answer → the newest prior turn
  // (while the next answer streams, or when the inline paywall replaced it).
  // NEVER assume the thread stays on one pillar/steward: /sleep routes every
  // turn independently.
  const liveTurn: ConversationTurn | null =
    submitted && streamText
      ? {
          question: submitted,
          ...(currentTurnExcerpt
            ? { selectedExcerpt: currentTurnExcerpt }
            : {}),
          raw: streamText,
          queryId,
          provenance,
          pillarNames,
          winnerPillarName,
          alsoCovered,
          steward,
          facultyVerified,
          slmFallback,
          citationStatus,
        }
      : null;
  const selectedTurn =
    activeTurnIndex != null ? (turns[activeTurnIndex] ?? null) : null;
  const railTurn: ConversationTurn | null =
    selectedTurn ??
    (liveTurn && !streaming
      ? liveTurn
      : turns.length
        ? turns[turns.length - 1]
        : liveTurn);
  const railShowsCurrent = selectedTurn == null;
  const conversationActive = turns.length > 0 || !!liveTurn || followUpPaywall;
  // True when the follow-up composer is docked (fixed) at the viewport
  // bottom — the thread and the page footer both pad for it.
  const composerDocked =
    conversationActive &&
    intakePhase === "idle" &&
    !followUpPaywall &&
    !streaming &&
    (submitted ? !!parsed : turns.length > 0);

  // Save interaction to DB whenever a structured answer finishes streaming
  useEffect(() => {
    if (streaming || !submitted || parsed?.kind !== "structured" || !streamText)
      return;
    const ctx = interactionRef.current;
    const userId = localStorage.getItem(USER_ID_KEY);
    const article = findRelevantArticle(submitted);
    fetch(`${API_BASE}/interaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId ? parseInt(userId, 10) : undefined,
        original_question: ctx.originalQuestion,
        clarify_question: ctx.clarifyQuestion ?? undefined,
        clarify_answer: ctx.clarifyAnswer ?? undefined,
        final_question: submitted,
        ai_answer: streamText,
        article_url: article?.url ?? undefined,
      }),
    }).catch(() => {
      /* silent — saving is best-effort */
    });
  }, [streaming]); // eslint-disable-line react-hooks/exhaustive-deps

  // Chat-style scroll — once per turn, as soon as the answer starts
  // rendering: the FIRST turn puts the reader at the page top (the intake
  // skip can leave the page part-scrolled, which would expose the privacy
  // footer at the fold); follow-up turns align the new question bubble with
  // the top of the viewport, like any chat app.
  useEffect(() => {
    if (!submitted || !parsed) return;
    const turnKey = `${turns.length}:${submitted}`;
    if (lastScrolledTurnRef.current === turnKey) return;
    lastScrolledTurnRef.current = turnKey;
    if (turns.length === 0) {
      window.scrollTo({ top: 0 });
    } else {
      questionBubbleRef.current?.scrollIntoView({ block: "start" });
    }
  }, [submitted, parsed, turns.length]);

  // Fire a global event the first time a structured answer completes for an
  // unregistered visitor so the sign-up modal can appear exactly then.
  const signupEventFiredRef = useRef(false);
  useEffect(() => {
    if (
      streaming ||
      parsed?.kind !== "structured" ||
      signupEventFiredRef.current
    )
      return;
    try {
      if (localStorage.getItem(REGISTERED_KEY) === "1") return;
    } catch {
      return;
    }
    signupEventFiredRef.current = true;
    window.dispatchEvent(new CustomEvent("palonur:first-answer"));
  }, [streaming, parsed?.kind]);

  // Auto-fire escalation when UNCOVERED is detected — fire-and-forget, no email required.
  useEffect(() => {
    if (
      !streaming &&
      parsed?.kind === "uncovered" &&
      !autoEscalateRef.current
    ) {
      autoEscalateRef.current = true;
      const storedEmail = (() => {
        try {
          return localStorage.getItem(USER_EMAIL_KEY);
        } catch {
          return null;
        }
      })();
      fetch(`${API_BASE}/uncovered-escalation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: submitted,
          surface: "sleep",
          userEmail: storedEmail || null,
          sessionId: queryId ?? null,
        }),
      }).catch(() => {});
    }
  }, [streaming, parsed?.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  // Boundary states show a REAL past refusal case as evidence — fetch it once
  // the first time a refuse/uncovered answer lands (server caches ~5 min).
  useEffect(() => {
    if (
      !streaming &&
      (parsed?.kind === "refuse" || parsed?.kind === "uncovered") &&
      !evidenceFetchedRef.current
    ) {
      evidenceFetchedRef.current = true;
      fetch(`${API_BASE}/refusal-evidence`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data) setRefusalEvidence(data as RefusalEvidencePayload);
        })
        .catch(() => {
          /* silent — evidence block simply doesn't render */
        });
    }
  }, [streaming, parsed?.kind]);

  function stopAudio() {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    setSpeaking(false);
    setTtsLoading(false);
    setTurnSpeaking(null);
    setTurnTtsLoading(null);
  }

  // Steward-aware attribution labels — the winning pillar's steward (from the
  // SSE done event) brands the take card and the share/credential lines, so a
  // nutrition answer says "Maria's take", not "Jamie's take". Fallbacks when
  // no winnerSteward arrived:
  //   - winning pillar is sleep, or no pillar info (legacy Zeitzer-corpus
  //     path) → the original Jamie/Zeitzer strings, preserving the default;
  //   - a non-sleep pillar without a steward → neutral expert wording, so
  //     another pillar's answer is never misattributed to Jamie.
  // Keyed on the actual retrieval winner (winnerPillarName) when the server
  // sent it — pillarNames is routing order, not winner-first.
  const attributionPillar = winnerPillarName ?? pillarNames[0] ?? null;
  const jamieFallbackOk =
    attributionPillar == null || /sleep/i.test(attributionPillar);
  const credentialLine = steward?.fullName
    ? t("sleepAgent.share.credentialName", { name: steward.fullName }) +
      (steward.institution ? ` · ${steward.institution}` : "")
    : jamieFallbackOk
      ? t("sleepAgent.share.credential")
      : t("sleepAgent.share.credentialGeneric");

  async function copyToClipboard(text: string, kind: "credential") {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for non-secure contexts / older browsers
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* swallow */
      }
      document.body.removeChild(ta);
    }
    setCopied(kind);
    window.setTimeout(() => setCopied(""), 2200);
  }

  function copyCredential() {
    const stripMd = (t: string) =>
      t
        .replace(/\*\*\*(.*?)\*\*\*/g, "$1")
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/\*(.*?)\*/g, "$1")
        .trim();
    const lines = [credentialLine];
    if (parsed?.citation) lines.push(parsed.citation);
    if (parsed?.paper) lines.push(parsed.paper);
    if (parsed?.finding)
      lines.push(
        t("sleepAgent.share.finding", { text: stripMd(parsed.finding) }),
      );
    lines.push(t("sleepAgent.share.viaPalonur"));
    return copyToClipboard(lines.join("\n"), "credential");
  }

  async function toggleSpeak() {
    if (!parsed) return;
    if (speaking || ttsLoading) {
      stopAudio();
      return;
    }
    const p = parsed;
    const stripMd = (t: string) =>
      t
        .replace(/\*\*\*(.*?)\*\*\*/g, "$1")
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/\*(.*?)\*/g, "$1")
        .replace(/^#+\s*/gm, "")
        .trim();
    const text = [
      p.answer && stripMd(p.answer),
      p.interpretation && stripMd(p.interpretation),
      p.action && `Try this: ${p.action}`,
    ]
      .filter(Boolean)
      .join(". ");

    setTtsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error("TTS failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        setSpeaking(false);
        setTtsLoading(false);
        audioRef.current = null;
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        setSpeaking(false);
        setTtsLoading(false);
        audioRef.current = null;
      };
      setTtsLoading(false);
      setSpeaking(true);
      audio.play();
    } catch {
      setSpeaking(false);
      setTtsLoading(false);
    }
  }

  /** Speak a PRIOR turn's answer aloud (live turn keeps toggleSpeak). */
  async function speakTurnAloud(idx: number) {
    const turn = turns[idx];
    if (!turn) return;
    if (turnSpeaking === idx || turnTtsLoading === idx) {
      stopAudio();
      return;
    }
    stopAudio();
    const p = parseAnswer(turn.raw);
    const stripMd = (s: string) =>
      s
        .replace(/\*\*\*(.*?)\*\*\*/g, "$1")
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/\*(.*?)\*/g, "$1")
        .replace(/^#+\s*/gm, "")
        .trim();
    const text =
      p.kind === "structured"
        ? [
            p.answer && stripMd(p.answer),
            p.interpretation && stripMd(p.interpretation),
            p.action && `Try this: ${p.action}`,
          ]
            .filter(Boolean)
            .join(". ")
        : stripMd(p.raw);
    if (!text) return;
    setTurnTtsLoading(idx);
    try {
      const res = await fetch(`${API_BASE}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error("TTS failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      const cleanup = () => {
        URL.revokeObjectURL(url);
        setTurnSpeaking(null);
        setTurnTtsLoading(null);
        audioRef.current = null;
      };
      audio.onended = cleanup;
      audio.onerror = cleanup;
      setTurnTtsLoading(null);
      setTurnSpeaking(idx);
      audio.play();
    } catch {
      setTurnSpeaking(null);
      setTurnTtsLoading(null);
    }
  }

  /** Submit the follow-up composer. Skips intake — follow-ups go straight
   *  to ask(); the conversation context lives server-side (or in history). */
  function askFollowUp(e?: React.FormEvent) {
    e?.preventDefault();
    const q = followUpDraft.trim();
    if (!q || streaming || recording || transcribing) return;
    // Pending clarify: the composer doubles as the clarify answer box (the
    // inline pill input was removed — one input on the page). Same semantics
    // as the old inline form: combined re-ask for better retrieval.
    if (
      !selectedExcerptDraft &&
      parsed?.kind === "structured" &&
      parsed.clarify &&
      submitted
    ) {
      const combined = submitted + " — " + q;
      interactionRef.current = {
        ...interactionRef.current,
        clarifyQuestion: parsed.clarify,
        clarifyAnswer: q,
      };
      setFollowUpDraft("");
      setMicError(null);
      startNewQuestion(combined);
      return;
    }
    interactionRef.current = { originalQuestion: q };
    setFollowUpDraft("");
    setMicError(null);
    ask(q, {
      displayQuestion: q,
      followUp: true,
      ...(selectedExcerptDraft
        ? { selectedExcerpt: selectedExcerptDraft }
        : {}),
    });
  }

  function captureAnswerSelection(container: HTMLElement, focusAction = false) {
    if (streaming) return;
    const selection = window.getSelection();
    if (
      !selection ||
      selection.isCollapsed ||
      selection.rangeCount === 0 ||
      !selection.anchorNode ||
      !selection.focusNode ||
      !container.contains(selection.anchorNode) ||
      !container.contains(selection.focusNode)
    ) {
      setSelectionAction(null);
      return;
    }
    const text = normalizeSelectedExcerpt(selection.toString());
    if (text.length < 3) {
      setSelectionAction(null);
      return;
    }
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    setSelectionAction({
      text,
      top: Math.max(12, rect.top - 48),
      left: Math.min(
        window.innerWidth - 86,
        Math.max(86, rect.left + rect.width / 2),
      ),
    });
    if (focusAction) {
      requestAnimationFrame(() => selectionActionButtonRef.current?.focus());
    }
  }

  function handleAnswerSelectionShortcut(
    event: React.KeyboardEvent<HTMLElement>,
  ) {
    if (!event.altKey || event.key.toLowerCase() !== "a") return;
    event.preventDefault();
    captureAnswerSelection(event.currentTarget, true);
  }

  function askAboutSelectedText(text: string) {
    const excerpt = normalizeSelectedExcerpt(text);
    if (!excerpt) return;
    setSelectedExcerptDraft(excerpt);
    setFollowUpDraft((current) =>
      current.trim() ? current : t("sleepAgent.conversation.askAboutPrompt"),
    );
    setSelectionAction(null);
    window.getSelection()?.removeAllRanges();
    requestAnimationFrame(() => {
      followUpInputRef.current?.focus();
      followUpInputRef.current?.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    });
  }

  // ── Voice follow-up capture ────────────────────────────────────────────
  // Mic → MediaRecorder → POST raw audio to /sleep-agent/transcribe →
  // transcript fills the composer (never auto-sends: the reader confirms).
  async function startRecording() {
    setMicError(null);
    if (recording || transcribing) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recStreamRef.current = stream;
      const mime = pickRecorderMime();
      const rec = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
      recChunksRef.current = [];
      rec.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) recChunksRef.current.push(ev.data);
      };
      rec.onstop = () => {
        recStreamRef.current?.getTracks().forEach((tr) => tr.stop());
        recStreamRef.current = null;
        const type = rec.mimeType || mime || "audio/webm";
        const blob = new Blob(recChunksRef.current, { type });
        recChunksRef.current = [];
        setRecording(false);
        if (blob.size > 0) void transcribeBlob(blob);
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      setMicError(t("sleepAgent.conversation.micError"));
      setRecording(false);
    }
  }

  function stopRecording() {
    try {
      recorderRef.current?.stop();
    } catch {
      setRecording(false);
    }
    recorderRef.current = null;
  }

  async function transcribeBlob(blob: Blob) {
    setTranscribing(true);
    setMicError(null);
    try {
      const res = await fetch(`${API_BASE}/sleep-agent/transcribe`, {
        method: "POST",
        headers: { "Content-Type": blob.type.split(";")[0] || "audio/webm" },
        credentials: "include",
        body: blob,
      });
      const data = (await res.json().catch(() => ({}))) as {
        text?: string;
        error?: string;
      };
      if (!res.ok || !data.text?.trim()) {
        setMicError(t("sleepAgent.conversation.transcribeError"));
        return;
      }
      const text = data.text.trim();
      setFollowUpDraft((prev) =>
        prev.trim() ? `${prev.trim()} ${text}` : text,
      );
    } catch {
      setMicError(t("sleepAgent.conversation.transcribeError"));
    } finally {
      setTranscribing(false);
    }
  }

  function toggleLogOptOut() {
    const next = !logOptedOut;
    setLogOptedOut(next);
    try {
      if (next) {
        document.cookie = `palonur_no_log=1; max-age=${60 * 60 * 24 * 365}; path=/; samesite=lax`;
      } else {
        document.cookie = "palonur_no_log=; max-age=0; path=/; samesite=lax";
      }
    } catch {
      /* noop */
    }
  }

  function openSourceSheet(id: number) {
    setOpenSourceId(id);
  }
  function closeSourceSheet() {
    setOpenSourceId(null);
    setSourceDetail(null);
    setSourceError(null);
  }

  async function submitFlag() {
    if (!queryId) return;
    setFlagState("saving");
    try {
      await fetch(`${API_BASE}/sleep-agent/flag`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queryId,
          reason: flagReason.trim() || undefined,
        }),
      });
      setFlagState("done");
    } catch {
      setFlagState("open");
    }
  }

  async function register(e: React.FormEvent) {
    e.preventDefault();
    if (!onboardingEmail.trim()) return;
    setRegLoading(true);
    try {
      // Name is optional — the server derives a friendly one from the email
      // when it's omitted, so a single field is enough to start.
      const res = await fetch(`${API_BASE}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(onboardingName.trim()
            ? { first_name: onboardingName.trim() }
            : {}),
          email: onboardingEmail.trim(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      const data = await res.json();
      if (data.userId) {
        localStorage.setItem(USER_ID_KEY, String(data.userId));
        localStorage.setItem(USER_NAME_KEY, data.first_name);
        localStorage.setItem(
          USER_EMAIL_KEY,
          onboardingEmail.trim().toLowerCase(),
        );
        if (!onboardingName.trim() && data.first_name)
          setOnboardingName(data.first_name);
        setRegSuccess(true);
        setTimeout(() => {
          window.location.href = `${import.meta.env.BASE_URL}journey`;
        }, 2200);
      }
    } catch {
      /* noop */
    }
    setRegLoading(false);
  }

  /* ── Right-rail extras: engagement blocks moved out of the chat column
        (Gemini-style declutter). Bound to the LIVE answer state, so they're
        only handed to rails that show the current turn. ── */
  const xSection: React.CSSProperties = {
    paddingTop: 14,
    marginTop: 14,
    borderTop: "1px solid rgba(139,26,26,.10)",
  };
  const xSummary: React.CSSProperties = {
    fontSize: 9.5,
    fontWeight: 700,
    letterSpacing: ".15em",
    color: "#8B1A1A",
    textTransform: "uppercase",
    cursor: "pointer",
    listStyle: "none",
  };
  /* 7-night usage guide (journey invitation) — a KEY rail element, not an
     extra: stays visible in the minimal desktop rail. Shown only for sleep
     answers; when the answer routed to another pillar (attributionPillar is
     the retrieval winner) the guide is suppressed. */
  const railJourneyInvite: React.ReactNode =
    submitted &&
    parsed &&
    parsed.kind === "structured" &&
    !streaming &&
    !isRegistered() &&
    (!attributionPillar || /sleep/i.test(attributionPillar)) ? (
      <div data-testid="rail-journey-invite" style={xSection}>
        <div
          style={{
            fontSize: 13.5,
            fontWeight: 500,
            color: "#1a0505",
            fontFamily: "'Georgia', 'Times New Roman', serif",
            lineHeight: 1.45,
            marginBottom: 8,
          }}
        >
          {(() => {
            const topic = journeyInviteTopic(submitted);
            return topic
              ? t(`sleepAgent.answer.journey.inviteHeadingTopics.${topic}`)
              : t("sleepAgent.answer.journey.inviteHeading");
          })()}
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: "#888",
            lineHeight: 1.55,
            marginBottom: 12,
            fontFamily: "-apple-system, system-ui, sans-serif",
          }}
        >
          {t("sleepAgent.answer.journey.inviteSubtitle")}
        </div>
        <button
          onClick={() => setShowOnboarding(true)}
          style={{
            width: "100%",
            padding: "10px 14px",
            borderRadius: 10,
            border: "none",
            background: "#8B1A1A",
            color: "#fff",
            fontSize: 12.5,
            fontWeight: 600,
            cursor: "pointer",
            fontFamily: "-apple-system, system-ui, sans-serif",
            letterSpacing: ".01em",
            transition: "opacity .15s",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.88")}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
        >
          {t("sleepAgent.answer.journey.begin")}
        </button>
      </div>
    ) : null;

  const railExtras: React.ReactNode =
    submitted && parsed && parsed.kind === "structured" && !streaming ? (
      <div data-testid="rail-extras">
        {/* Listen + personal help — engagement actions moved out of the
            center answer column (Gemini-style declutter, round 4) */}
        <div style={xSection}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <MinicastButton
              question={submitted}
              sections={{
                answer: parsed.answer,
                finding: parsed.finding,
                action: parsed.action,
              }}
              ready={
                !streaming &&
                !!(parsed.answer || parsed.finding || parsed.action)
              }
              pillar={pillarNames[0]}
              expert={steward?.fullName ?? undefined}
            />
            <button
              type="button"
              data-testid="button-get-personal-help"
              onClick={() => setContactOpen(true)}
              title={t("sleepAgent.contact.button")}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                background: "none",
                border: "1px solid rgba(139,26,26,.22)",
                borderRadius: 999,
                padding: "5px 12px",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: ".04em",
                color: "#8B1A1A",
                cursor: "pointer",
                fontFamily:
                  "-apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif",
                whiteSpace: "nowrap",
              }}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              {t("sleepAgent.contact.button")}
            </button>
          </div>
        </div>
        {/* SMS/email support opt-in — moved out of the page bottom into the
            rail so the docked composer is the only block under the thread. */}
        <div style={xSection}>
          <PhoneCapture
            product="nightly"
            source="sleep-agent"
            accent="#8B1A1A"
            ink="#1a0505"
            muted="#777"
            border="rgba(139,26,26,.18)"
            sans="-apple-system, system-ui, sans-serif"
            serif="Georgia, serif"
            heading={t("sleepAgent.phoneCapture.heading")}
            blurb={t("sleepAgent.phoneCapture.blurb")}
            compact
            collapsible
          />
        </div>
        {/* Read more from SLM */}
        {recommendedArticle && (
          <div style={xSection}>
            <a
              href={recommendedArticle.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "inline-block",
                fontSize: 11.5,
                color: "#8B1A1A",
                textDecoration: "none",
                letterSpacing: ".01em",
                lineHeight: 1.5,
                borderBottom: "1px solid rgba(139,26,26,.25)",
                paddingBottom: 1,
              }}
            >
              {t("sleepAgent.answer.readMoreSlm")}{" "}
              <span style={{ fontStyle: "italic" }}>
                {recommendedArticle.title}
              </span>{" "}
              →
            </a>
          </div>
        )}

        {/* Journey pass — "I've found my answer" completion button */}
        {activeJourney && queryId && !journeyCompleted && (
          <div style={xSection}>
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: "#8B1A1A",
                marginBottom: 4,
                letterSpacing: ".08em",
                textTransform: "uppercase",
              }}
            >
              {t("sleepAgent.answer.journey.premiumLabel")}
            </div>
            <div
              style={{
                fontSize: 11.5,
                color: "#555",
                lineHeight: 1.55,
                marginBottom: 10,
              }}
            >
              {t("sleepAgent.answer.journey.premiumBody")}
            </div>
            <button
              onClick={async () => {
                try {
                  await fetch("/api/journey/complete", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    credentials: "include",
                    body: JSON.stringify({ product: "sleep" }),
                  });
                } finally {
                  setJourneyCompleted(true);
                }
              }}
              style={{
                background: "#8B1A1A",
                color: "#fff",
                border: "none",
                borderRadius: 10,
                padding: "9px 16px",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {t("sleepAgent.answer.foundAnswer")}
            </button>
          </div>
        )}

        {journeyCompleted && (
          <div style={{ ...xSection, textAlign: "center" }}>
            <div style={{ fontSize: 20, marginBottom: 6 }}>🎉</div>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "#1a4a1a",
                marginBottom: 4,
              }}
            >
              {t("sleepAgent.answer.journey.completeHeading")}
            </div>
            <div style={{ fontSize: 11.5, color: "#555", lineHeight: 1.5 }}>
              {t("sleepAgent.answer.journey.completeBody")}
            </div>
          </div>
        )}

        {/* Save-this-answer email ask — hidden for registered/premium */}
        {queryId && !isRegistered() && !isPremium && (
          <div style={xSection}>
            <details>
              <summary style={xSummary}>
                {t("sleepAgent.answer.saveAnswer.heading")}
              </summary>
              <div style={{ marginTop: 10 }}>
                <SaveAnswerCard
                  queryId={queryId}
                  palette={{
                    accent: "#8B1A1A",
                    ink: "#1a0505",
                    muted: "#888",
                    rule: "rgba(139,26,26,.14)",
                    cardBg: "#fff",
                    sans: "-apple-system, system-ui, sans-serif",
                    serif: "'Georgia', 'Times New Roman', serif",
                  }}
                />
              </div>
            </details>
          </div>
        )}

        {/* Answer-format poll — text / podcast / avatar */}
        <div style={xSection}>
          <details>
            <summary style={xSummary}>{t("sleepAgent.voteCard.label")}</summary>
            <div style={{ marginTop: 10 }}>
              <FormatVoteCard
                steward={facultyVerified ? steward : null}
                answerText={parsed.answer ?? ""}
                speakText={[
                  parsed.answer,
                  parsed.interpretation,
                  parsed.action &&
                    `${t("sleepAgent.answer.tryThis")}: ${parsed.action}`,
                ]
                  .filter(Boolean)
                  .join(". ")}
                question={submitted}
                sections={{
                  answer: parsed.answer,
                  finding: parsed.finding,
                  action: parsed.action,
                }}
                ready={!!(parsed.answer || parsed.finding || parsed.action)}
                pillar={pillarNames[0]}
              />
            </div>
          </details>
        </div>

        {/* Referral share nudge — registered/premium, dismissible */}
        {facultyVerified &&
          (isRegistered() || isPremium) &&
          answeredCountRef.current >= 2 &&
          referralCode &&
          !shareNudgeDismissed && (
            <div style={{ ...xSection, position: "relative" }}>
              <button
                onClick={() => {
                  try {
                    localStorage.setItem(SHARE_NUDGE_KEY, "1");
                  } catch {
                    /* noop */
                  }
                  setShareNudgeDismissed(true);
                }}
                style={{
                  position: "absolute",
                  top: 12,
                  right: 0,
                  background: "none",
                  border: "none",
                  color: "#bbb",
                  cursor: "pointer",
                  fontSize: 15,
                  padding: 0,
                  lineHeight: 1,
                }}
                aria-label={t("sleepAgent.answer.dismiss")}
              >
                ×
              </button>
              <div
                style={{
                  fontSize: 9.5,
                  fontWeight: 700,
                  letterSpacing: ".15em",
                  color: "#8B1A1A",
                  textTransform: "uppercase",
                  marginBottom: 6,
                }}
              >
                {t("sleepAgent.answer.shareNudge.label")}
              </div>
              <div
                style={{
                  fontSize: 12,
                  lineHeight: 1.5,
                  color: "#1a0505",
                  fontFamily: "'Georgia', 'Times New Roman', serif",
                  marginBottom: 10,
                }}
              >
                {t("sleepAgent.answer.shareNudge.body")}
              </div>
              <input
                readOnly
                value={`${window.location.origin}/sleep?ref=${referralCode}`}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "7px 10px",
                  border: "1px solid rgba(139,26,26,.2)",
                  borderRadius: 8,
                  fontSize: 10.5,
                  color: "#572020",
                  background: "rgba(255,255,255,0.7)",
                  fontFamily: "monospace",
                  marginBottom: 8,
                }}
                onClick={(e) => (e.target as HTMLInputElement).select()}
              />
              <button
                onClick={() => {
                  navigator.clipboard
                    .writeText(
                      `${window.location.origin}/sleep?ref=${referralCode}`,
                    )
                    .then(() => {
                      setReferralCopied(true);
                      setTimeout(() => setReferralCopied(false), 2000);
                    })
                    .catch(() => {});
                }}
                style={{
                  width: "100%",
                  background: "#8B1A1A",
                  color: "#fff",
                  border: "none",
                  borderRadius: 8,
                  padding: "8px 12px",
                  fontSize: 11.5,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                {referralCopied
                  ? t("sleepAgent.answer.shareNudge.copied")
                  : t("sleepAgent.answer.shareNudge.copyLink")}
              </button>
            </div>
          )}

        {/* Share your story — compact link */}
        <div style={xSection}>
          <a
            href={`/share?ref=sleep${queryId ? `&q=${encodeURIComponent(queryId)}` : ""}`}
            style={{
              display: "block",
              textDecoration: "none",
              color: "inherit",
            }}
          >
            <div
              style={{
                fontSize: 9.5,
                fontWeight: 700,
                letterSpacing: ".15em",
                color: "#8B1A1A",
                textTransform: "uppercase",
                marginBottom: 6,
              }}
            >
              {t("sleepAgent.answer.shareStory.label")}
            </div>
            <div
              style={{
                fontSize: 12,
                lineHeight: 1.5,
                fontFamily: "'Georgia', 'Times New Roman', serif",
                color: "#1a0505",
              }}
            >
              {t("sleepAgent.answer.shareStory.body")}{" "}
              <span style={{ color: "#8B1A1A" }}>
                {t("sleepAgent.answer.shareStory.ctaLink")}
              </span>
            </div>
          </a>
        </div>

        {/* Flag this answer */}
        {queryId && (
          <div style={xSection}>
            {flagState === "done" ? (
              <div style={{ fontSize: 11.5, color: "#666" }}>
                {t("sleepAgent.answer.flag.done")}
              </div>
            ) : flagState === "open" || flagState === "saving" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <label style={{ fontSize: 11.5, color: "#666" }}>
                  {t("sleepAgent.answer.flag.whatWrong")}
                </label>
                <textarea
                  value={flagReason}
                  onChange={(e) => setFlagReason(e.target.value)}
                  rows={2}
                  placeholder={t("sleepAgent.answer.flag.placeholder")}
                  style={{
                    border: "1px solid rgba(139,26,26,.18)",
                    borderRadius: 8,
                    padding: "8px 10px",
                    fontFamily: "inherit",
                    fontSize: 12,
                    color: "#1a0505",
                    background: "#fff",
                    outline: "none",
                    resize: "vertical",
                    width: "100%",
                    boxSizing: "border-box",
                  }}
                />
                <div style={{ display: "flex", gap: 10 }}>
                  <button
                    onClick={submitFlag}
                    disabled={flagState === "saving"}
                    style={{
                      background: "#8B1A1A",
                      color: "#fff",
                      border: "none",
                      borderRadius: 8,
                      padding: "7px 12px",
                      fontSize: 11.5,
                      fontWeight: 600,
                      cursor: flagState === "saving" ? "wait" : "pointer",
                    }}
                  >
                    {flagState === "saving"
                      ? t("sleepAgent.answer.flag.sending")
                      : t("sleepAgent.answer.flag.sendToFaculty")}
                  </button>
                  <button
                    onClick={() => setFlagState("idle")}
                    style={{
                      background: "none",
                      color: "#888",
                      border: "none",
                      fontSize: 11.5,
                      cursor: "pointer",
                    }}
                  >
                    {t("sleepAgent.answer.flag.cancel")}
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setFlagState("open")}
                data-testid="button-flag-answer"
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  color: "#888",
                  fontSize: 11.5,
                  cursor: "pointer",
                  textDecoration: "underline",
                  textDecorationColor: "rgba(139,26,26,.25)",
                  textUnderlineOffset: 3,
                }}
              >
                {t("sleepAgent.answer.flag.flagForReview")}
              </button>
            )}
          </div>
        )}
      </div>
    ) : null;

  return (
    <div
      style={{
        minHeight: "100dvh",
        background: "#fafaf7",
        fontFamily: "'Inter', -apple-system, system-ui, sans-serif",
        color: "#1a0505",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <style>{`
        @keyframes fadeInInvite {
          from { opacity: 0; transform: translateY(10px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        @media (max-width: 600px) {
          .sa-header { padding: 12px 16px !important; }
          .sa-brand  { display: none !important; }
          .sa-greeting-name { display: none !important; }
          .sa-main   { padding: 16px 16px 64px !important; }
          .sa-main.sa-main-docked { padding: 16px 16px 20px !important; }
        }
      `}</style>

      {selectionAction && (
        <button
          ref={selectionActionButtonRef}
          type="button"
          data-testid="button-ask-about-selection"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => askAboutSelectedText(selectionAction.text)}
          style={{
            position: "fixed",
            zIndex: 140,
            top: selectionAction.top,
            left: selectionAction.left,
            transform: "translateX(-50%)",
            border: "1px solid rgba(139,26,26,.24)",
            borderRadius: 999,
            padding: "9px 14px",
            background: "#fff",
            color: "#8B1A1A",
            boxShadow: "0 8px 28px rgba(36,10,10,.18)",
            fontSize: 12.5,
            fontWeight: 700,
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {t("sleepAgent.conversation.askAboutThis")}
        </button>
      )}

      {/* Header + main share one full-viewport flex column so the privacy
          footer (after it) always starts BELOW the fold — visible only when
          the reader scrolls past the end of the page / docked composer. */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          minHeight: "100dvh",
        }}
      >
        {/* Top bar — 3-column grid: nav · brand · greeting */}
        <header
          className="sa-header"
          style={{
            padding: "16px 28px",
            display: "grid",
            gridTemplateColumns: "1fr auto 1fr",
            alignItems: "center",
            borderBottom: "1px solid rgba(139,26,26,.06)",
          }}
        >
          <a
            href={import.meta.env.BASE_URL}
            style={{
              textDecoration: "none",
              color: "#8B1A1A",
              fontSize: 13,
              fontWeight: 600,
              letterSpacing: ".02em",
            }}
          >
            {t("nav.back")}
          </a>

          <span className="sa-brand">
            <SLMBrand />
          </span>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
            }}
          >
            {registeredName ? (
              <>
                <div
                  className="sa-greeting-name"
                  style={{
                    fontSize: 12.5,
                    color: "#1a0505",
                    fontWeight: 500,
                    fontFamily: "'Georgia', 'Times New Roman', serif",
                    letterSpacing: "-0.005em",
                  }}
                >
                  {t(getGreetingKey())}.{" "}
                  {warmReturnGreeting(registeredName, i18n.language)}
                </div>
                <a
                  href={`${import.meta.env.BASE_URL}journey`}
                  style={{
                    fontSize: 11,
                    color: "#8B1A1A",
                    textDecoration: "none",
                    letterSpacing: ".04em",
                    fontWeight: 500,
                  }}
                >
                  {t("sleepAgent.yourJourney")}
                </a>
              </>
            ) : null}
          </div>
        </header>

        {/* Main column */}
        <main
          className={`sa-main${composerDocked ? " sa-main-docked" : ""}`}
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            padding: composerDocked ? "20px 24px 28px" : "20px 24px 80px",
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: 720,
              /* Chat layout: the column fills the viewport so the sticky
             follow-up composer (last child) rests at the viewport bottom
             even when the answer is short. */
              ...(conversationActive && intakePhase === "idle"
                ? {
                    display: "flex" as const,
                    flexDirection: "column" as const,
                    flex: 1,
                  }
                : {}),
            }}
          >
            {/* Search field — hidden once a chat thread is active; the
              follow-up composer at the bottom continues the conversation
              (Gemini-style: one input, at the bottom). It returns when the
              follow-up paywall blocks the composer so a fresh question is
              still possible. */}
            {!(
              conversationActive &&
              intakePhase === "idle" &&
              !followUpPaywall
            ) && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  beginQuestion(query);
                }}
                className="pill-focus"
                style={{
                  display: "flex",
                  gap: 0,
                  alignItems: "stretch",
                  border: "1px solid rgba(139,26,26,.18)",
                  background: "#fff",
                  borderRadius: 999,
                  padding: 6,
                  paddingLeft: 22,
                  boxShadow: "0 4px 24px rgba(139,26,26,.06)",
                  marginTop: 8,
                }}
              >
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("sleepAgent.searchPlaceholder")}
                  autoFocus
                  style={{
                    flex: 1,
                    border: "none",
                    outline: "none",
                    fontSize: 16,
                    color: "#1a0505",
                    background: "transparent",
                    fontFamily: "inherit",
                  }}
                />
                <button
                  type="submit"
                  disabled={streaming || !query.trim()}
                  style={{
                    padding: "12px 24px",
                    borderRadius: 999,
                    border: "none",
                    background:
                      streaming || !query.trim() ? "#e5d5d2" : "#8B1A1A",
                    color: "#fff",
                    fontWeight: 600,
                    fontSize: 13,
                    letterSpacing: ".06em",
                    textTransform: "uppercase",
                    cursor: streaming || !query.trim() ? "default" : "pointer",
                    transition: "all .15s",
                  }}
                >
                  {streaming ? "…" : t("sleepAgent.askButton")}
                </button>
              </form>
            )}

            {/* Guided intake — loading the follow-up questions */}
            {intakePhase === "loading" && (
              <div
                style={{
                  marginTop: 56,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 14,
                  color: "#999",
                }}
              >
                <div
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: "50%",
                    border: "2px solid rgba(139,26,26,.15)",
                    borderTopColor: "#8B1A1A",
                    animation: "spin 0.8s linear infinite",
                  }}
                />
                <div style={{ fontSize: 13, letterSpacing: ".04em" }}>
                  {t("sleepAgent.loading.details")}
                </div>
                <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              </div>
            )}

            {/* Guided intake — the follow-up questions */}
            {intakePhase === "asking" && (
              <div style={{ marginTop: 40 }}>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: ".18em",
                    color: "#8B1A1A",
                    textTransform: "uppercase",
                    opacity: 0.7,
                    marginBottom: 10,
                  }}
                >
                  {t("sleepAgent.intake.label")}
                </div>
                <div
                  style={{
                    fontSize: "clamp(20px, 2.4vw, 26px)",
                    fontWeight: 500,
                    fontFamily: "'Georgia','Times New Roman',serif",
                    color: "#0f0505",
                    lineHeight: 1.3,
                    marginBottom: 8,
                    letterSpacing: "-0.01em",
                  }}
                >
                  {t("sleepAgent.intake.subheading")}
                </div>
                <div
                  style={{
                    fontSize: 13.5,
                    color: "#888",
                    lineHeight: 1.5,
                    marginBottom: 26,
                    fontFamily:
                      "-apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif",
                  }}
                >
                  {t("sleepAgent.intake.instruction")}
                </div>

                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitIntake();
                  }}
                >
                  {intakeQuestions.map((q) => (
                    <div
                      key={q.id}
                      style={{
                        marginBottom: 18,
                        padding: "18px 20px",
                        border: "1px solid rgba(139,26,26,.12)",
                        borderRadius: 14,
                        background: "#fff",
                        boxShadow: "0 2px 10px rgba(139,26,26,.04)",
                      }}
                    >
                      <div
                        style={{
                          fontSize: 16,
                          lineHeight: 1.4,
                          marginBottom: 14,
                          fontFamily: "'Georgia','Times New Roman',serif",
                          color: "#1a0505",
                        }}
                      >
                        {q.question}
                      </div>
                      {q.options.length > 0 && (
                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: 8,
                            marginBottom: 12,
                          }}
                        >
                          {q.options.map((opt) => {
                            const active = (intakeAnswers[q.id] ?? "") === opt;
                            return (
                              <button
                                key={opt}
                                type="button"
                                onClick={() =>
                                  setIntakeAnswers((prev) => ({
                                    ...prev,
                                    [q.id]: active ? "" : opt,
                                  }))
                                }
                                style={{
                                  padding: "8px 14px",
                                  borderRadius: 999,
                                  border: active
                                    ? "1.5px solid #8B1A1A"
                                    : "1px solid rgba(139,26,26,.2)",
                                  background: active ? "#8B1A1A" : "#fff",
                                  color: active ? "#fff" : "#6b2020",
                                  fontSize: 13.5,
                                  cursor: "pointer",
                                  fontFamily:
                                    "-apple-system, system-ui, sans-serif",
                                  transition: "all .12s",
                                }}
                              >
                                {opt}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      <input
                        value={intakeAnswers[q.id] ?? ""}
                        onChange={(e) =>
                          setIntakeAnswers((prev) => ({
                            ...prev,
                            [q.id]: e.target.value,
                          }))
                        }
                        placeholder={t("sleepAgent.intake.typeYourOwn")}
                        style={{
                          width: "100%",
                          padding: "10px 12px",
                          border: "1px solid rgba(139,26,26,.18)",
                          borderRadius: 8,
                          fontSize: 14,
                          color: "#1a0505",
                          background: "#fafaf7",
                          outline: "none",
                          boxSizing: "border-box",
                          fontFamily: "-apple-system, system-ui, sans-serif",
                        }}
                      />
                    </div>
                  ))}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 18,
                      marginTop: 6,
                    }}
                  >
                    <button
                      type="submit"
                      style={{
                        padding: "13px 28px",
                        borderRadius: 999,
                        border: "none",
                        background: "#8B1A1A",
                        color: "#fff",
                        fontWeight: 600,
                        fontSize: 13,
                        letterSpacing: ".06em",
                        textTransform: "uppercase",
                        cursor: "pointer",
                      }}
                    >
                      {t("sleepAgent.intake.getAnswer")}
                    </button>
                    <button
                      type="button"
                      onClick={skipIntake}
                      style={{
                        background: "none",
                        border: "none",
                        color: "#888",
                        fontSize: 13.5,
                        cursor: "pointer",
                        textDecoration: "underline",
                        fontFamily: "-apple-system, system-ui, sans-serif",
                      }}
                    >
                      {t("sleepAgent.intake.skip")}
                    </button>
                  </div>
                </form>
              </div>
            )}

            {/* Empty state — situation cards (browse) */}
            {!submitted &&
              intakePhase === "idle" &&
              turns.length === 0 &&
              !followUpPaywall && (
                <div style={{ marginTop: 44 }}>
                  <div
                    style={{
                      fontSize: 11,
                      color: "#aaa",
                      letterSpacing: ".16em",
                      textTransform: "uppercase",
                      marginBottom: 20,
                    }}
                  >
                    {t("sleepAgent.emptyState.whatsOnMind")}
                  </div>
                  <style>{`
                .slm-card {
                  transition: transform .18s, box-shadow .18s, border-color .18s;
                }
                .slm-card:hover {
                  transform: translateY(-3px);
                  box-shadow: 0 8px 28px rgba(139,26,26,.11);
                  border-color: rgba(139,26,26,.35) !important;
                }
              `}</style>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: 10,
                    }}
                  >
                    {(
                      t("sleepAgent.situationCards", {
                        returnObjects: true,
                      }) as Array<{ label: string; title: string; q: string }>
                    ).map(({ label, title, q }) => (
                      <button
                        key={q}
                        className="slm-card"
                        onClick={() => {
                          setQuery(q);
                          beginQuestion(q);
                        }}
                        style={{
                          textAlign: "left",
                          padding: "18px 16px",
                          border: "1px solid rgba(139,26,26,.12)",
                          borderRadius: 14,
                          background: "#fff",
                          cursor: "pointer",
                          fontFamily: "inherit",
                          boxShadow: "0 2px 10px rgba(139,26,26,.04)",
                        }}
                      >
                        <div
                          style={{
                            fontSize: 9,
                            fontWeight: 700,
                            letterSpacing: ".14em",
                            color: "#8B1A1A",
                            textTransform: "uppercase",
                            opacity: 0.65,
                            marginBottom: 8,
                          }}
                        >
                          {label}
                        </div>
                        <div
                          style={{
                            fontSize: 15,
                            fontFamily: "'Georgia','Times New Roman',serif",
                            color: "#1a0505",
                            lineHeight: 1.35,
                          }}
                        >
                          {title}
                        </div>
                      </button>
                    ))}
                  </div>

                  {/* Phone opt-in — surfaced on the empty state so it's discoverable
                  without scrolling past a full answer. */}
                  <div
                    style={{
                      marginTop: 20,
                      display: "flex",
                      justifyContent: "center",
                    }}
                  >
                    <PhoneCapture
                      product="nightly"
                      source="sleep-agent-idle"
                      accent="#8B1A1A"
                      ink="#1a0505"
                      muted="#777"
                      border="rgba(139,26,26,.18)"
                      sans="-apple-system, system-ui, sans-serif"
                      serif="Georgia, serif"
                      heading={t("sleepAgent.phoneCapture.heading")}
                      blurb={t("sleepAgent.phoneCapture.blurb")}
                      compact
                      collapsible
                    />
                  </div>

                  {/* Inline subscribe CTA — Nightly is its own subscription, so the
                  empty state invites it directly rather than relying only on the
                  mid-stream paywall modal. */}
                  <div
                    style={{
                      marginTop: 16,
                      background: "#fff",
                      border: "1px solid rgba(139,26,26,.16)",
                      borderRadius: 18,
                      padding: "24px 24px",
                      boxShadow: "0 6px 24px rgba(139,26,26,.05)",
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 16,
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 9,
                          fontWeight: 700,
                          letterSpacing: ".14em",
                          color: "#8B1A1A",
                          textTransform: "uppercase",
                          marginBottom: 8,
                        }}
                      >
                        {t("sleepAgent.emptyState.nightlyLabel")}
                      </div>
                      <div
                        style={{
                          fontSize: 18,
                          fontFamily: "'Georgia','Times New Roman',serif",
                          color: "#1a0505",
                          lineHeight: 1.3,
                          marginBottom: 6,
                        }}
                      >
                        {t("sleepAgent.emptyState.nightlyHeading")}
                      </div>
                      <div
                        style={{
                          fontSize: 13.5,
                          color: "#777",
                          lineHeight: 1.5,
                        }}
                      >
                        {t("sleepAgent.emptyState.nightlyBody")}
                      </div>
                    </div>
                    <a
                      href={`${import.meta.env.BASE_URL}subscribe`}
                      style={{
                        flexShrink: 0,
                        background: "#8B1A1A",
                        color: "#fff",
                        textDecoration: "none",
                        fontSize: 14.5,
                        fontWeight: 700,
                        padding: "13px 26px",
                        borderRadius: 12,
                      }}
                    >
                      {t("sleepAgent.emptyState.subscribeCta")}
                    </a>
                  </div>
                </div>
              )}

            {/* Loading state */}
            {submitted && streaming && !streamText && (
              <div
                style={{
                  marginTop: 64,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 16,
                  color: "#999",
                }}
              >
                <div
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: "50%",
                    border: "2px solid rgba(139,26,26,.15)",
                    borderTopColor: "#8B1A1A",
                    animation: "spin 0.8s linear infinite",
                  }}
                />
                <div style={{ fontSize: 13, letterSpacing: ".04em" }}>
                  {t("sleepAgent.loading.consulting")}
                </div>
                <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              </div>
            )}

            {/* Steward achievements panel — opened by clicking a steward avatar.
              Holds its own steward so prior-turn avatars open the RIGHT panel. */}
            {!!panelSteward?.fullName && (
              <StewardAchievementsPanel
                steward={{
                  fullName: panelSteward.fullName,
                  institution: panelSteward.institution ?? null,
                  photoUrl:
                    panelSteward.photoUrl ??
                    stewardPortraitUrl(panelSteward.fullName),
                  achievements: panelSteward.achievements ?? [],
                }}
                onClose={() => setPanelSteward(null)}
              />
            )}

            {/* Prior turns of this conversation. Each card renders from its OWN
              snapshot (question, coverage, steward) — clicking a card binds
              the governance rail to that turn. */}
            {turns.length > 0 && (
              <div data-testid="conversation-thread" style={{ marginTop: 48 }}>
                {turns.map((turn, i) => {
                  const p = parseAnswer(turn.raw);
                  const cov = coverageOf(turn);
                  const active = activeTurnIndex === i;
                  const preview =
                    p.kind === "structured"
                      ? stripMdInline(p.answer ?? "")
                      : cov === "refuse"
                        ? t("refuseCard.heading")
                        : t("uncoveredCard.heading");
                  return (
                    <article
                      key={i}
                      data-testid={`turn-card-${i}`}
                      onClick={() => {
                        if (window.getSelection()?.toString().trim()) return;
                        setActiveTurnIndex(active ? null : i);
                      }}
                      style={{
                        marginBottom: 36,
                        padding: "10px 12px",
                        borderRadius: 14,
                        cursor: "pointer",
                        background: active
                          ? "rgba(139,26,26,.035)"
                          : "transparent",
                        boxShadow: active
                          ? "inset 0 0 0 1px rgba(139,26,26,.28)"
                          : "none",
                        transition: "background .15s, box-shadow .15s",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "flex-end",
                          marginBottom: 14,
                        }}
                      >
                        <div
                          style={{
                            maxWidth: "82%",
                            padding: "10px 16px",
                            background: "rgba(139,26,26,0.06)",
                            borderRadius: "18px 18px 4px 18px",
                            fontSize: 15,
                            lineHeight: 1.5,
                            color: "#1a0505",
                            fontFamily:
                              "-apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif",
                          }}
                        >
                          {turn.selectedExcerpt && (
                            <SelectedExcerptQuote
                              text={turn.selectedExcerpt}
                              compact
                            />
                          )}
                          {turn.question}
                        </div>
                      </div>
                      <div
                        data-answer-selectable="true"
                        tabIndex={0}
                        aria-keyshortcuts="Alt+A"
                        aria-label={t(
                          "sleepAgent.conversation.answerSelectionHint",
                        )}
                        onKeyDown={handleAnswerSelectionShortcut}
                        onMouseUp={(e) =>
                          captureAnswerSelection(e.currentTarget)
                        }
                        onTouchEnd={(e) => {
                          const container = e.currentTarget;
                          window.setTimeout(
                            () => captureAnswerSelection(container),
                            0,
                          );
                        }}
                      >
                        <div
                          style={{
                            fontSize: 15,
                            lineHeight: 1.65,
                            color: "#2a1010",
                            whiteSpace: "pre-wrap",
                          }}
                        >
                          {preview}
                        </div>
                        {p.kind === "structured" && p.action && (
                          <div
                            style={{
                              marginTop: 10,
                              fontSize: 13.5,
                              lineHeight: 1.55,
                              color: "#3d2b24",
                            }}
                          >
                            <strong style={{ color: "#8B1A1A" }}>
                              {t("sleepAgent.conversation.tryThis")}
                            </strong>{" "}
                            {stripMdInline(p.action)}
                          </div>
                        )}
                      </div>
                      <div
                        style={{
                          marginTop: 14,
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                          flexWrap: "wrap",
                        }}
                      >
                        {turn.winnerPillarName && (
                          <span
                            style={{
                              fontSize: 10.5,
                              fontWeight: 600,
                              letterSpacing: ".06em",
                              color: "#8a6a5a",
                              textTransform: "uppercase",
                            }}
                          >
                            {turn.winnerPillarName}
                          </span>
                        )}
                        {turn.facultyVerified && turn.steward?.fullName && (
                          <span style={{ fontSize: 11.5, color: "#8a7a72" }}>
                            {turn.steward.fullName}
                          </span>
                        )}
                        <button
                          type="button"
                          data-testid={`button-turn-listen-${i}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            void speakTurnAloud(i);
                          }}
                          aria-label={
                            turnSpeaking === i
                              ? t("sleepAgent.conversation.stopListening")
                              : t("sleepAgent.conversation.listen")
                          }
                          style={{
                            marginLeft: "auto",
                            background: "none",
                            cursor: "pointer",
                            border: "1px solid rgba(139,26,26,.22)",
                            borderRadius: 999,
                            padding: "4px 12px",
                            fontSize: 11.5,
                            fontWeight: 600,
                            color: "#8B1A1A",
                          }}
                        >
                          {turnTtsLoading === i
                            ? "…"
                            : turnSpeaking === i
                              ? t("sleepAgent.conversation.stopListening")
                              : t("sleepAgent.conversation.listen")}
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}

            {/* Answer */}
            {submitted && (parsed || disambig) && (
              <div style={{ marginTop: 56, position: "relative" }}>
                {/* Governance rail — desktop aside bound to ONE turn's snapshot
                  (selected prior turn, else the live answer). */}
                {railTurn && (
                  <GovernanceRail
                    turn={railTurn}
                    showsCurrent={railShowsCurrent}
                    variant="desktop"
                    onSelectLatest={() => setActiveTurnIndex(null)}
                    onOpenSource={(id) => openSourceSheet(id)}
                    onAvatarClick={(s) => setPanelSteward(s)}
                    extras={railShowsCurrent ? railExtras : undefined}
                    journeyInvite={
                      railShowsCurrent ? railJourneyInvite : undefined
                    }
                  />
                )}
                {/* The visitor's question — chat-style right-aligned bubble,
                  mirroring the prior-turn cards above. */}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    marginBottom: 26,
                  }}
                >
                  <div
                    ref={questionBubbleRef}
                    data-testid="question-bubble"
                    style={{
                      maxWidth: "82%",
                      padding: "12px 18px",
                      background: "rgba(139,26,26,0.06)",
                      borderRadius: "18px 18px 4px 18px",
                      fontSize: 15.5,
                      lineHeight: 1.5,
                      color: "#1a0505",
                      fontFamily:
                        "-apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif",
                      scrollMarginTop: 16,
                    }}
                  >
                    {currentTurnExcerpt && (
                      <SelectedExcerptQuote text={currentTurnExcerpt} compact />
                    )}
                    {submitted}
                  </div>
                </div>
                {/* Disambiguation card — shown when the router detects a
                  near-tie between pillars and needs the reader to choose before
                  the LLM is invoked. Tapping a button re-fires ask() with an
                  explicit pillarLock so routing is bypassed on the next turn. */}
                {disambig && !streaming && (
                  <div
                    style={{
                      marginTop: 8,
                      padding: "28px 0 12px",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 14,
                        lineHeight: 1.55,
                        color: "#4a3828",
                        fontFamily: "'Georgia', 'Times New Roman', serif",
                        marginBottom: 20,
                      }}
                    >
                      This question touches a few areas — which one are you
                      asking about?
                    </div>
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 10,
                      }}
                    >
                      {disambig.map((c) => (
                        <button
                          key={c.slug}
                          type="button"
                          onClick={() => {
                            ask(disambigQRef.current, {
                              displayQuestion: disambigDisplayRef.current,
                              followUp: disambigFollowUpRef.current,
                              ...(disambigExcerptRef.current
                                ? {
                                    selectedExcerpt: disambigExcerptRef.current,
                                  }
                                : {}),
                              pillarLock: c.slug,
                            });
                          }}
                          style={{
                            background: "#fff",
                            border: "1px solid rgba(139,26,26,0.22)",
                            borderRadius: 10,
                            padding: "13px 18px",
                            textAlign: "left",
                            fontFamily: "'Georgia', 'Times New Roman', serif",
                            fontSize: 15,
                            color: "#1a0505",
                            cursor: "pointer",
                            lineHeight: 1.4,
                            transition: "border-color .12s, background .12s",
                          }}
                          onMouseEnter={(e) => {
                            (
                              e.currentTarget as HTMLButtonElement
                            ).style.background = "rgba(139,26,26,0.04)";
                            (
                              e.currentTarget as HTMLButtonElement
                            ).style.borderColor = "rgba(139,26,26,0.45)";
                          }}
                          onMouseLeave={(e) => {
                            (
                              e.currentTarget as HTMLButtonElement
                            ).style.background = "#fff";
                            (
                              e.currentTarget as HTMLButtonElement
                            ).style.borderColor = "rgba(139,26,26,0.22)";
                          }}
                        >
                          {c.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {!disambig && parsed && parsed.kind === "refuse" && (
                  /* Boundary framing, never the raw model refusal (owner
                   directive: "never show a refusal, only show boundaries"). */
                  <div>
                    <div
                      style={{
                        padding: "32px 0",
                        fontSize: 18,
                        color: "#666",
                        lineHeight: 1.5,
                        textAlign: "center",
                      }}
                    >
                      {t("refuseCard.heading")}
                      <div
                        style={{ fontSize: 13, color: "#aaa", marginTop: 12 }}
                      >
                        {t("refuseCard.subline")}
                      </div>
                    </div>
                    <BoundaryEvidence evidence={refusalEvidence} />
                  </div>
                )}

                {parsed && parsed.kind === "uncovered" && (
                  <div>
                    <div
                      style={{
                        padding: "32px 0 20px",
                        fontSize: 18,
                        color: "#666",
                        lineHeight: 1.5,
                        textAlign: "center",
                      }}
                    >
                      {t("uncoveredCard.heading")}
                      <div
                        style={{ fontSize: 13, color: "#aaa", marginTop: 12 }}
                      >
                        {t("uncoveredCard.subline")}
                      </div>
                    </div>
                    {/* Escalation card: auto-notified + optional personal email follow-up */}
                    <div
                      style={{
                        marginTop: 4,
                        padding: "22px 24px",
                        borderRadius: 14,
                        background: "rgba(139,26,26,0.03)",
                        border: "1px solid rgba(139,26,26,0.12)",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          marginBottom: 10,
                        }}
                      >
                        <span style={{ fontSize: 16 }}>✓</span>
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            letterSpacing: ".16em",
                            color: "#8B1A1A",
                            textTransform: "uppercase",
                          }}
                        >
                          {t("uncoveredCard.teamNotified")}
                        </span>
                      </div>
                      <div
                        style={{
                          fontFamily: "'Georgia', 'Times New Roman', serif",
                          fontSize: 15.5,
                          lineHeight: 1.55,
                          color: "#1a0505",
                          marginBottom: 14,
                        }}
                      >
                        {t("uncoveredCard.autoNotice")}
                      </div>
                      {escalateState !== "done" ? (
                        <>
                          {!(() => {
                            try {
                              return localStorage.getItem(USER_EMAIL_KEY);
                            } catch {
                              return null;
                            }
                          })() && (
                            <>
                              <div
                                style={{
                                  fontSize: 13,
                                  color: "#666",
                                  marginBottom: 8,
                                }}
                              >
                                {t("uncoveredCard.followUpPrompt")}
                              </div>
                              <input
                                type="email"
                                value={escalateEmail}
                                onChange={(e) =>
                                  setEscalateEmail(e.target.value)
                                }
                                placeholder={t("uncoveredCard.placeholder")}
                                style={{
                                  display: "block",
                                  width: "100%",
                                  boxSizing: "border-box",
                                  padding: "11px 14px",
                                  marginBottom: 10,
                                  fontFamily: "inherit",
                                  fontSize: 14,
                                  color: "#1a0505",
                                  background: "#fff",
                                  border: "1px solid rgba(139,26,26,0.2)",
                                  borderRadius: 10,
                                  outline: "none",
                                }}
                              />
                            </>
                          )}
                          {escalateState === "error" && (
                            <div
                              style={{
                                fontSize: 13,
                                color: "#b91c1c",
                                marginBottom: 8,
                              }}
                            >
                              {t("uncoveredCard.error")}
                            </div>
                          )}
                          {escalateEmail.trim() && (
                            <button
                              type="button"
                              disabled={escalateState === "submitting"}
                              onClick={async () => {
                                setEscalateState("submitting");
                                try {
                                  const r = await fetch(
                                    `${API_BASE}/uncovered-escalation`,
                                    {
                                      method: "POST",
                                      headers: {
                                        "Content-Type": "application/json",
                                      },
                                      body: JSON.stringify({
                                        question: submitted,
                                        surface: "sleep",
                                        userEmail: escalateEmail.trim(),
                                        sessionId: queryId ?? null,
                                      }),
                                    },
                                  );
                                  if (!r.ok) throw new Error("request failed");
                                  setEscalateState("done");
                                } catch {
                                  setEscalateState("error");
                                }
                              }}
                              style={{
                                padding: "9px 18px",
                                borderRadius: 10,
                                background:
                                  escalateState === "submitting"
                                    ? "rgba(139,26,26,0.4)"
                                    : "#8B1A1A",
                                color: "#fff",
                                border: "none",
                                fontFamily: "inherit",
                                fontSize: 13,
                                fontWeight: 600,
                                cursor:
                                  escalateState === "submitting"
                                    ? "default"
                                    : "pointer",
                                transition: "background .15s",
                              }}
                            >
                              {escalateState === "submitting"
                                ? t("uncoveredCard.sending")
                                : t("uncoveredCard.button")}
                            </button>
                          )}
                        </>
                      ) : (
                        <div style={{ fontSize: 14, color: "#1a3a1a" }}>
                          {t("uncoveredCard.emailSent")}
                        </div>
                      )}
                    </div>
                    <BoundaryEvidence evidence={refusalEvidence} />
                    {/* Trajectory panel for the boundary answer — shows which
                      pillars were searched and that the coverage check did
                      not pass (the honest reason for the boundary). */}
                    <AnswerTrajectory
                      pillarNames={pillarNames}
                      sources={[]}
                      citationStatus={null}
                      outcome="boundary"
                      labels={trajectoryLabels}
                      accent="#8B1A1A"
                    />
                  </div>
                )}

                {parsed && parsed.kind === "raw" && (
                  <div
                    style={{
                      padding: "8px 0",
                      fontSize: 17,
                      color: "#1a0505",
                      lineHeight: 1.55,
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {parsed.raw}
                    <BlinkCaret on={streaming} />
                  </div>
                )}

                {parsed && parsed.kind === "structured" && (
                  <article
                    data-answer-selectable="true"
                    tabIndex={0}
                    aria-keyshortcuts="Alt+A"
                    aria-label={t(
                      "sleepAgent.conversation.answerSelectionHint",
                    )}
                    onKeyDown={handleAnswerSelectionShortcut}
                    onMouseUp={(e) => captureAnswerSelection(e.currentTarget)}
                    onTouchEnd={(e) => {
                      const container = e.currentTarget;
                      window.setTimeout(
                        () => captureAnswerSelection(container),
                        0,
                      );
                    }}
                    style={{ paddingTop: 8 }}
                  >
                    {/* Attribution — slim single line above the reply, chat-style */}
                    {facultyVerified && !!steward?.fullName && (
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 9,
                          marginBottom: 14,
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => setPanelSteward(steward)}
                          data-testid="button-steward-avatar-eyebrow"
                          title={`About ${steward?.fullName ?? "the steward"}`}
                          aria-label={`About ${steward?.fullName ?? "the steward"}`}
                          style={{
                            background: "none",
                            border: "none",
                            padding: 0,
                            cursor: "pointer",
                            display: "flex",
                            flexShrink: 0,
                          }}
                        >
                          {(steward?.photoUrl ??
                          stewardPortraitUrl(steward?.fullName)) ? (
                            <img
                              src={
                                steward?.photoUrl ??
                                stewardPortraitUrl(steward?.fullName) ??
                                undefined
                              }
                              alt={steward?.fullName ?? "Pillar steward"}
                              style={{
                                width: 26,
                                height: 26,
                                borderRadius: "50%",
                                objectFit: "cover",
                                flexShrink: 0,
                                border: "1px solid rgba(139,26,26,.25)",
                              }}
                            />
                          ) : (
                            <div
                              style={{
                                width: 26,
                                height: 26,
                                borderRadius: "50%",
                                background: "#8B1A1A",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                flexShrink: 0,
                              }}
                            >
                              <svg
                                width="11"
                                height="11"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="#fff"
                                strokeWidth="3.2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <polyline points="20 6 9 17 4 12"></polyline>
                              </svg>
                            </div>
                          )}
                        </button>
                        <div
                          style={{
                            fontSize: 12.5,
                            color: "#6b2020",
                            lineHeight: 1.3,
                          }}
                        >
                          <span style={{ fontWeight: 600 }}>
                            {steward?.fullName}
                          </span>
                          {steward?.institution && (
                            <span style={{ color: "#999", marginLeft: 6 }}>
                              · {steward?.institution}
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                    {/* SLM AI Lab fallback — slim one-liner (no verified expert) */}
                    {slmFallback && !facultyVerified && (
                      <div
                        data-testid="label-slm-fallback"
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          marginBottom: 14,
                          fontSize: 12.5,
                          color: "#8a6a5a",
                          lineHeight: 1.4,
                        }}
                      >
                        <svg
                          width="13"
                          height="13"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="#8B1A1A"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          style={{ flexShrink: 0 }}
                        >
                          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                          <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                        </svg>
                        <span>
                          <span style={{ fontWeight: 600, color: "#6b2020" }}>
                            {t("sleepAgent.answer.slmFallbackTitle")}
                          </span>
                          <span style={{ margin: "0 5px", color: "#c9b8a8" }}>
                            ·
                          </span>
                          {t("sleepAgent.answer.slmFallbackNote")}
                        </span>
                      </div>
                    )}

                    {/* The answer lead — reads like the opening of a chat reply,
                      not a headline. Slightly larger + serif so it still
                      carries the steward's voice. */}
                    <div
                      style={{
                        fontSize: 17,
                        fontWeight: 400,
                        lineHeight: 1.7,
                        color: "#1a0505",
                        marginBottom: 18,
                        fontFamily:
                          "-apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif",
                      }}
                    >
                      {parsed.answer}
                      <BlinkCaret on={streaming && !parsed.finding} />
                    </div>

                    {/* Steward's take — quiet quote, no chrome */}
                    {!streaming && parsed.insight && (
                      <figure
                        style={{
                          margin: "0 0 20px",
                          padding: "2px 0 2px 16px",
                          borderLeft: "2px solid rgba(139,26,26,.35)",
                          animation: "fadeInInvite 0.5s ease 0.15s both",
                        }}
                      >
                        {parsed.insight
                          .split("\n")
                          .filter(Boolean)
                          .map((line, i) => {
                            const isQ = line.trimStart().startsWith("Q:");
                            const text = line.replace(/^[QA]:\s*/, "");
                            return (
                              <div
                                key={i}
                                style={{
                                  fontSize: isQ ? 13 : 15.5,
                                  fontStyle: isQ ? "italic" : "normal",
                                  color: isQ ? "#999" : "#2a1010",
                                  lineHeight: 1.65,
                                  marginBottom: isQ ? 8 : 0,
                                  fontFamily:
                                    "-apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif",
                                }}
                              >
                                {isQ ? `"${text}"` : text}
                              </div>
                            );
                          })}
                      </figure>
                    )}

                    {/* Interpretation — plain, warm, brief */}
                    {parsed.interpretation && (
                      <div
                        style={{
                          fontSize: 16,
                          color: "#2a1010",
                          lineHeight: 1.7,
                          marginBottom: 10,
                          fontFamily:
                            "-apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif",
                        }}
                      >
                        {parsed.interpretation}
                        <BlinkCaret on={streaming && !parsed.action} />
                      </div>
                    )}

                    {/* Amber limit notices — honest-limitation lines under the
                      answer; frames what is still under review, never
                      "this answer is unsafe". */}
                    {!streaming && (
                      <AnswerLimitNotices notices={limitNotices} />
                    )}

                    {/* Action row — quiet icon strip under the reply, Gemini-style */}
                    {!streaming && (
                      <div
                        data-testid="answer-action-bar"
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 2,
                          marginTop: 4,
                          marginBottom: 4,
                          flexWrap: "wrap",
                        }}
                      >
                        {/* TTS speaker — ElevenLabs Sarah voice */}
                        {parsed.answer && (
                          <button
                            onClick={toggleSpeak}
                            title={
                              ttsLoading
                                ? t("sleepAgent.answer.ttsLoading")
                                : speaking
                                  ? t("sleepAgent.answer.ttsStop")
                                  : t("sleepAgent.answer.ttsListen")
                            }
                            style={{
                              background: "none",
                              border: "none",
                              cursor: ttsLoading ? "default" : "pointer",
                              padding: "6px 7px",
                              borderRadius: 8,
                              color:
                                speaking || ttsLoading ? "#8B1A1A" : "#b5a89e",
                              display: "flex",
                              alignItems: "center",
                              transition: "color .15s",
                              opacity: ttsLoading ? 0.6 : 1,
                            }}
                          >
                            {ttsLoading ? (
                              <svg
                                width="17"
                                height="17"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                style={{ animation: "spin 1s linear infinite" }}
                              >
                                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                              </svg>
                            ) : speaking ? (
                              <svg
                                width="17"
                                height="17"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <rect x="6" y="4" width="4" height="16" />
                                <rect x="14" y="4" width="4" height="16" />
                              </svg>
                            ) : (
                              <svg
                                width="17"
                                height="17"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                                <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                              </svg>
                            )}
                          </button>
                        )}
                        {/* Copy credential — Stanford attribution + citation */}
                        {facultyVerified && parsed.citation && (
                          <button
                            type="button"
                            onClick={copyCredential}
                            data-testid="copy-credential"
                            title={t("sleepAgent.answer.copyCredentialTitle")}
                            aria-label={
                              copied === "credential"
                                ? t("sleepAgent.answer.credentialCopied")
                                : t("sleepAgent.answer.copyCredential")
                            }
                            style={{
                              background: "none",
                              border: "none",
                              cursor: "pointer",
                              padding: "6px 7px",
                              borderRadius: 8,
                              color:
                                copied === "credential" ? "#8B1A1A" : "#b5a89e",
                              display: "flex",
                              alignItems: "center",
                              transition: "color .15s",
                            }}
                            onMouseEnter={(e) => {
                              if (copied !== "credential")
                                e.currentTarget.style.color = "#8B1A1A";
                            }}
                            onMouseLeave={(e) => {
                              if (copied !== "credential")
                                e.currentTarget.style.color = "#b5a89e";
                            }}
                          >
                            {copied === "credential" ? (
                              <svg
                                width="15"
                                height="15"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="3"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            ) : (
                              <svg
                                width="15"
                                height="15"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <rect
                                  x="9"
                                  y="9"
                                  width="13"
                                  height="13"
                                  rx="2"
                                  ry="2"
                                />
                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                              </svg>
                            )}
                          </button>
                        )}
                      </div>
                    )}

                    {/* How this answer was built — collapsed trajectory panel
                      below the reply. Sources pass through the same-work
                      display collapse; no steward identity, no scores. */}
                    {!streaming && (
                      <AnswerTrajectory
                        pillarNames={pillarNames}
                        sources={collapseSameWork(provenance).map((p) => ({
                          title: p.title,
                          authors: p.authors,
                          year: p.year,
                        }))}
                        citationStatus={citationStatus}
                        outcome={slmFallback ? "fallback" : "covered"}
                        labels={trajectoryLabels}
                        accent="#8B1A1A"
                      />
                    )}

                    {/* Optional clarify — rendered as plain conversation text.
                      The bottom follow-up composer is the single input on
                      this page; while a clarify is pending it answers the
                      clarify question (see askFollowUp). */}
                    {!streaming && parsed.clarify && (
                      <div
                        data-testid="clarify-question"
                        style={{
                          marginTop: 22,
                          animation: "fadeInInvite 0.6s ease 0.3s both",
                          fontSize: 15.5,
                          color: "#2a1010",
                          lineHeight: 1.6,
                          fontFamily:
                            "-apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif",
                        }}
                      >
                        {parsed.clarify}
                      </div>
                    )}
                  </article>
                )}
              </div>
            )}

            {/* ── Conversation continuation — composer, inline paywall, and the
                 mobile governance sheet. Rendered whenever a thread exists. ── */}
            {conversationActive && intakePhase === "idle" && (
              <>
                <div style={{ position: "relative" }}>
                  {/* Desktop rail fallback: when no live answer block is on
                  screen (inline paywall, or viewing history while nothing
                  streams), the rail anchors here instead. */}
                  {!(submitted && parsed) && railTurn && (
                    <GovernanceRail
                      turn={railTurn}
                      showsCurrent={railShowsCurrent}
                      variant="desktop"
                      onSelectLatest={() => setActiveTurnIndex(null)}
                      onOpenSource={(id) => openSourceSheet(id)}
                      onAvatarClick={(s) => setPanelSteward(s)}
                    />
                  )}

                  {/* Inline follow-up paywall — takes the place of the next
                  answer; the thread above stays fully readable. */}
                  {followUpPaywall && (
                    <div
                      data-testid="followup-paywall-card"
                      style={{
                        marginTop: 40,
                        padding: "26px 28px",
                        borderRadius: 16,
                        background: "rgba(139,26,26,0.03)",
                        border: "1px solid rgba(139,26,26,0.16)",
                      }}
                    >
                      <div
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          letterSpacing: ".16em",
                          color: "#8B1A1A",
                          textTransform: "uppercase",
                          marginBottom: 10,
                        }}
                      >
                        {t("sleepAgent.conversation.paywall.eyebrow")}
                      </div>
                      <div
                        style={{
                          fontSize: 19,
                          lineHeight: 1.35,
                          color: "#1a0505",
                          fontFamily: "'Georgia','Times New Roman',serif",
                          marginBottom: 8,
                        }}
                      >
                        {t("sleepAgent.conversation.paywall.heading")}
                      </div>
                      <div
                        style={{
                          fontSize: 14,
                          lineHeight: 1.6,
                          color: "#5a4a42",
                          marginBottom: 18,
                        }}
                      >
                        {t("sleepAgent.conversation.paywall.body")}
                      </div>
                      <a
                        href={`${import.meta.env.BASE_URL}subscribe`}
                        data-testid="button-followup-paywall-cta"
                        style={{
                          display: "inline-block",
                          padding: "12px 24px",
                          borderRadius: 10,
                          background: "#8B1A1A",
                          color: "#fff",
                          textDecoration: "none",
                          fontSize: 14,
                          fontWeight: 600,
                          letterSpacing: ".01em",
                        }}
                      >
                        {t("sleepAgent.conversation.paywall.cta")}
                      </a>
                      <div
                        style={{
                          fontSize: 12,
                          color: "#8a7a72",
                          marginTop: 14,
                          lineHeight: 1.5,
                        }}
                      >
                        {t("sleepAgent.conversation.paywall.newQuestionHint")}
                      </div>
                    </div>
                  )}
                </div>

                {/* Follow-up composer — typed or spoken. Voice fills the field
                  via /sleep-agent/transcribe; the reader always confirms.
                  Docked: STICKY at the bottom of the viewport (chat-app
                  style) as the column's last in-flow child. The column is a
                  flex container filling the viewport, so marginTop:auto
                  rests the composer at the bottom even for short answers;
                  scrolling past the end of the thread lets it settle into
                  the flow, revealing the privacy footer BELOW it. */}
                {composerDocked && (
                  <div
                    style={{
                      position: "sticky",
                      bottom: 0,
                      zIndex: 40,
                      marginTop: "auto",
                      padding: "26px 0 18px",
                      background:
                        "linear-gradient(to top, #fafaf7 78%, rgba(250,250,247,0))",
                    }}
                  >
                    <form
                      onSubmit={askFollowUp}
                      data-testid="followup-composer"
                    >
                      {selectedExcerptDraft && (
                        <SelectedExcerptQuote
                          text={selectedExcerptDraft}
                          removable
                          onRemove={() => setSelectedExcerptDraft(null)}
                        />
                      )}
                      <div
                        style={{
                          display: "flex",
                          gap: 10,
                          alignItems: "stretch",
                        }}
                      >
                        <input
                          ref={followUpInputRef}
                          value={followUpDraft}
                          onChange={(e) => setFollowUpDraft(e.target.value)}
                          placeholder={
                            transcribing
                              ? t("sleepAgent.conversation.transcribing")
                              : recording
                                ? t("sleepAgent.conversation.recordingHint")
                                : parsed?.kind === "structured" &&
                                    parsed.clarify
                                  ? t("sleepAgent.answer.clarifyPlaceholder")
                                  : t("sleepAgent.conversation.placeholder")
                          }
                          data-testid="input-followup"
                          className="pill-field"
                          style={{
                            flex: 1,
                            minWidth: 0,
                            padding: "13px 16px",
                            fontFamily: "inherit",
                            fontSize: 15,
                            color: "#1a0505",
                            background: "#fff",
                            border: "1px solid rgba(139,26,26,0.2)",
                            borderRadius: 12,
                            outline: "none",
                            boxSizing: "border-box",
                          }}
                        />
                        <button
                          type="button"
                          data-testid="button-followup-mic"
                          onClick={() =>
                            recording ? stopRecording() : void startRecording()
                          }
                          disabled={transcribing}
                          aria-label={
                            recording
                              ? t("sleepAgent.conversation.stopRecording")
                              : t("sleepAgent.conversation.speakQuestion")
                          }
                          title={
                            recording
                              ? t("sleepAgent.conversation.stopRecording")
                              : t("sleepAgent.conversation.speakQuestion")
                          }
                          style={{
                            width: 48,
                            borderRadius: 12,
                            cursor: transcribing ? "default" : "pointer",
                            border: recording
                              ? "1px solid #8B1A1A"
                              : "1px solid rgba(139,26,26,0.2)",
                            background: recording ? "#8B1A1A" : "#fff",
                            color: recording ? "#fff" : "#8B1A1A",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            opacity: transcribing ? 0.55 : 1,
                            flexShrink: 0,
                          }}
                        >
                          {transcribing ? (
                            <span
                              style={{
                                display: "inline-block",
                                width: 14,
                                height: 14,
                                borderRadius: "50%",
                                border: "2px solid rgba(139,26,26,.25)",
                                borderTopColor: "#8B1A1A",
                                animation: "spin 0.8s linear infinite",
                              }}
                            />
                          ) : recording ? (
                            <span
                              style={{
                                display: "inline-block",
                                width: 12,
                                height: 12,
                                background: "#fff",
                                borderRadius: 2,
                              }}
                            />
                          ) : (
                            <svg
                              width="17"
                              height="17"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                              <line x1="12" y1="19" x2="12" y2="23" />
                            </svg>
                          )}
                        </button>
                        <button
                          type="submit"
                          data-testid="button-followup-send"
                          disabled={
                            !followUpDraft.trim() || recording || transcribing
                          }
                          style={{
                            padding: "0 22px",
                            borderRadius: 12,
                            border: "none",
                            background:
                              followUpDraft.trim() &&
                              !recording &&
                              !transcribing
                                ? "#8B1A1A"
                                : "rgba(139,26,26,.25)",
                            color: "#fff",
                            fontSize: 14,
                            fontWeight: 600,
                            cursor:
                              followUpDraft.trim() &&
                              !recording &&
                              !transcribing
                                ? "pointer"
                                : "default",
                            flexShrink: 0,
                          }}
                        >
                          {t("sleepAgent.conversation.send")}
                        </button>
                      </div>
                      {micError && (
                        <div
                          data-testid="followup-mic-error"
                          style={{
                            fontSize: 12.5,
                            color: "#b91c1c",
                            marginTop: 8,
                          }}
                        >
                          {micError}
                        </div>
                      )}
                      {turnsRemaining != null && turnsRemaining > 0 && (
                        <div
                          data-testid="followup-turns-left"
                          style={{
                            fontSize: 12,
                            color: "#8a7a72",
                            marginTop: 10,
                          }}
                        >
                          {t("sleepAgent.conversation.turnsLeft", {
                            count: turnsRemaining,
                          })}
                        </div>
                      )}
                    </form>
                  </div>
                )}

                {/* Mobile governance pill (<1200px) — opens the bottom sheet.
                  Lifted above the docked composer when it's visible so the
                  pill never covers the send button. */}
                {railTurn && (
                  <>
                    <button
                      type="button"
                      className="gov-pill"
                      data-testid="button-governance-pill"
                      onClick={() => setRailOpen(true)}
                      style={{
                        position: "fixed",
                        bottom: composerDocked ? 104 : 18,
                        // Keep the compact trust control tappable above the
                        // optional Tavus corner panel (z-index 9100).
                        right: 18,
                        zIndex: 9200,
                        alignItems: "center",
                        gap: 8,
                        padding: "10px 16px",
                        borderRadius: 999,
                        background: "#fff",
                        color: "#8B1A1A",
                        border: "1px solid rgba(139,26,26,.3)",
                        boxShadow: "0 6px 20px rgba(26,5,5,.14)",
                        fontSize: 12.5,
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                      </svg>
                      {t("sleepAgent.conversation.rail.open")}
                    </button>
                    <style>{`
                    .gov-pill { display: none; }
                    @media (max-width: 1199px) { .gov-pill { display: inline-flex; } }
                  `}</style>
                  </>
                )}

                {/* Mobile governance sheet — same rail content, bottom sheet.
                  zIndex below the source sheet (90) so tapping a source
                  opens the source detail ON TOP of this sheet's backdrop. */}
                {railOpen && railTurn && (
                  <div
                    data-testid="governance-sheet-overlay"
                    onClick={() => setRailOpen(false)}
                    style={{
                      position: "fixed",
                      inset: 0,
                      zIndex: 9200,
                      background: "rgba(26,5,5,.45)",
                      display: "flex",
                      alignItems: "flex-end",
                    }}
                  >
                    <div
                      data-testid="governance-sheet"
                      onClick={(e) => e.stopPropagation()}
                      role="dialog"
                      aria-modal="true"
                      aria-label={t("sleepAgent.conversation.rail.title")}
                      style={{
                        width: "100%",
                        maxHeight: "78vh",
                        overflowY: "auto",
                        background: "#FDFBF7",
                        borderRadius: "18px 18px 0 0",
                        padding: "20px 24px 34px",
                        boxSizing: "border-box",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          marginBottom: 16,
                        }}
                      >
                        <div
                          style={{
                            fontSize: 10.5,
                            fontWeight: 700,
                            letterSpacing: ".16em",
                            color: "#8B1A1A",
                            textTransform: "uppercase",
                          }}
                        >
                          {t("sleepAgent.conversation.rail.title")}
                        </div>
                        <button
                          type="button"
                          data-testid="governance-sheet-close"
                          onClick={() => setRailOpen(false)}
                          aria-label={t("sleepAgent.conversation.rail.close")}
                          style={{
                            background: "none",
                            border: "none",
                            cursor: "pointer",
                            fontSize: 22,
                            lineHeight: 1,
                            color: "#8a7a72",
                            padding: 4,
                          }}
                        >
                          ×
                        </button>
                      </div>
                      <GovernanceRail
                        turn={railTurn}
                        showsCurrent={railShowsCurrent}
                        variant="sheet"
                        extras={railShowsCurrent ? railExtras : undefined}
                        journeyInvite={
                          railShowsCurrent ? railJourneyInvite : undefined
                        }
                        onSelectLatest={() => setActiveTurnIndex(null)}
                        onOpenSource={(id) => {
                          setRailOpen(false);
                          openSourceSheet(id);
                        }}
                        onAvatarClick={(s) => {
                          setRailOpen(false);
                          setPanelSteward(s);
                        }}
                      />
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </main>
      </div>

      {/* Privacy footer — opt-in-by-default disclosure + opt-out toggle */}
      <footer
        data-testid="privacy-footer"
        style={{
          padding: "20px 24px 28px",
          borderTop: "1px solid rgba(139,26,26,.06)",
          fontSize: 11.5,
          color: "#888",
          lineHeight: 1.55,
          textAlign: "center",
          fontFamily: "-apple-system, system-ui, sans-serif",
        }}
      >
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          {t("sleepAgent.privacyFooter.body")}{" "}
          <button
            onClick={toggleLogOptOut}
            data-testid="button-toggle-log-optout"
            style={{
              background: "none",
              border: "none",
              padding: 0,
              color: "#8B1A1A",
              fontWeight: 600,
              cursor: "pointer",
              textDecoration: "underline",
              textUnderlineOffset: 2,
              fontFamily: "inherit",
              fontSize: "inherit",
            }}
          >
            {logOptedOut
              ? t("sleepAgent.privacyFooter.resumeSharing")
              : t("sleepAgent.privacyFooter.dontLog")}
          </button>
          {logOptedOut && (
            <span style={{ marginLeft: 8, color: "#3a9a4f" }}>
              {t("sleepAgent.privacyFooter.paused")}
            </span>
          )}
        </div>
      </footer>

      {/* ── Get personal help — contact form modal ────────────────────── */}
      {contactOpen && (
        <ContactModal
          context={submitted || null}
          onClose={() => setContactOpen(false)}
        />
      )}

      {/* ── Source citation & abstract sheet ──────────────────────────── */}
      {openSourceId != null && (
        <div
          data-testid="source-sheet-overlay"
          onClick={closeSourceSheet}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9300,
            background: "rgba(20,5,10,0.45)",
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "center",
            animation: "fadeInOverlay 0.2s ease forwards",
          }}
        >
          <style>{`
            @keyframes sheetUp { from { transform: translateY(24px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
            @media (min-width: 700px) {
              .source-sheet-card { align-self: center !important; max-height: 80vh !important; border-radius: 18px !important; }
            }
          `}</style>
          <div
            data-testid="source-sheet"
            className="source-sheet-card"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="source-sheet-title"
            style={{
              background: "#fff",
              width: "100%",
              maxWidth: 640,
              maxHeight: "88vh",
              overflowY: "auto",
              borderRadius: "18px 18px 0 0",
              padding: "28px 28px 32px",
              boxShadow: "0 -8px 40px rgba(0,0,0,0.18)",
              animation: "sheetUp 0.25s ease forwards",
              alignSelf: "stretch",
              fontFamily: "-apple-system, system-ui, sans-serif",
              color: "#1a0505",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: 14,
                marginBottom: 14,
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  color: "#8B1A1A",
                  letterSpacing: ".16em",
                  textTransform: "uppercase",
                  fontWeight: 700,
                  paddingTop: 4,
                }}
              >
                {t("sleepAgent.sourceSheet.header")}
              </div>
              <button
                onClick={closeSourceSheet}
                data-testid="source-sheet-close"
                aria-label={t("sleepAgent.answer.close")}
                style={{
                  background: "none",
                  border: "none",
                  padding: 4,
                  fontSize: 22,
                  lineHeight: 1,
                  color: "#888",
                  cursor: "pointer",
                }}
              >
                ×
              </button>
            </div>

            {sourceLoading && (
              <div style={{ fontSize: 14, color: "#888", padding: "20px 0" }}>
                {t("sleepAgent.sourceSheet.loading")}
              </div>
            )}

            {sourceError && !sourceLoading && (
              <div
                data-testid="source-sheet-error"
                style={{
                  fontSize: 14,
                  color: "#8B1A1A",
                  padding: "16px 0",
                }}
              >
                {t("sleepAgent.sourceSheet.loadError", { error: sourceError })}
              </div>
            )}

            {sourceDetail && !sourceLoading && (
              <>
                <h2
                  id="source-sheet-title"
                  data-testid="source-sheet-title"
                  style={{
                    fontFamily: "'Georgia','Times New Roman',serif",
                    fontSize: 22,
                    fontWeight: 600,
                    lineHeight: 1.3,
                    margin: "0 0 12px",
                    color: "#1a0505",
                  }}
                >
                  {sourceDetail.title}
                </h2>
                {studyDesignLabel(sourceDetail.study_design) && (
                  <span
                    style={{
                      display: "inline-block",
                      fontSize: 11.5,
                      fontWeight: 600,
                      color: "#6b5a3a",
                      background: "#F4ECDD",
                      border: "1px solid #E8DDC8",
                      borderRadius: 999,
                      padding: "2px 10px",
                      letterSpacing: ".01em",
                      marginBottom: 10,
                    }}
                  >
                    {studyDesignLabel(sourceDetail.study_design)}
                  </span>
                )}
                <div
                  data-testid="source-sheet-citation"
                  style={{
                    fontSize: 13.5,
                    color: "#555",
                    lineHeight: 1.55,
                    marginBottom: 18,
                  }}
                >
                  {[
                    sourceDetail.authors,
                    sourceDetail.year != null
                      ? String(sourceDetail.year)
                      : null,
                    sourceDetail.journal,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  {sourceDetail.doi && (
                    <>
                      {" · "}
                      <a
                        href={
                          sourceDetail.doi.startsWith("http")
                            ? sourceDetail.doi
                            : `https://doi.org/${sourceDetail.doi}`
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          color: "#8B1A1A",
                          textDecoration: "none",
                          borderBottom: "1px solid rgba(139,26,26,.3)",
                        }}
                      >
                        DOI: {sourceDetail.doi}
                      </a>
                    </>
                  )}
                </div>

                {sourceDetail.interpretation && (
                  <div
                    data-testid="source-sheet-interpretation"
                    style={{
                      marginBottom: 24,
                      padding: "16px 18px",
                      background:
                        "linear-gradient(180deg, rgba(232,53,42,.06), rgba(232,53,42,.02))",
                      borderLeft: "3px solid #8B1A1A",
                      borderRadius: 6,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 10.5,
                        color: "#8B1A1A",
                        letterSpacing: ".14em",
                        textTransform: "uppercase",
                        fontWeight: 700,
                        marginBottom: 10,
                      }}
                    >
                      {t("sleepAgent.sourceSheet.stanfordsTake")}
                      {sourceDetail.interpretation.author_name && (
                        <span
                          style={{
                            marginLeft: 8,
                            color: "#888",
                            fontWeight: 600,
                            letterSpacing: ".06em",
                            textTransform: "none",
                          }}
                        >
                          · {sourceDetail.interpretation.author_name}
                        </span>
                      )}
                    </div>
                    <div
                      data-testid="source-sheet-interp-answer"
                      style={{
                        fontFamily: "'Georgia','Times New Roman',serif",
                        fontSize: 17,
                        fontWeight: 500,
                        lineHeight: 1.4,
                        color: "#1a0505",
                        marginBottom: 10,
                      }}
                    >
                      {sourceDetail.interpretation.answer}
                    </div>
                    <div
                      data-testid="source-sheet-interp-interpretation"
                      style={{
                        fontSize: 14.5,
                        color: "#2a1010",
                        lineHeight: 1.6,
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {sourceDetail.interpretation.interpretation}
                    </div>
                    {sourceDetail.interpretation.not_proven &&
                      sourceDetail.interpretation.not_proven.trim() && (
                        <div
                          data-testid="source-sheet-interp-not-proven"
                          style={{
                            marginTop: 12,
                            fontSize: 13.5,
                            color: "#5a3030",
                            lineHeight: 1.55,
                            fontStyle: "italic",
                          }}
                        >
                          <span
                            style={{
                              fontWeight: 700,
                              fontStyle: "normal",
                              color: "#8B1A1A",
                            }}
                          >
                            {t("sleepAgent.sourceSheet.notProven")}
                          </span>{" "}
                          {sourceDetail.interpretation.not_proven}
                        </div>
                      )}
                    {sourceDetail.interpretation.action &&
                      sourceDetail.interpretation.action.trim() && (
                        <div
                          data-testid="source-sheet-interp-action"
                          style={{
                            marginTop: 12,
                            fontSize: 13.5,
                            color: "#1a0505",
                            lineHeight: 1.55,
                          }}
                        >
                          <span style={{ fontWeight: 700, color: "#8B1A1A" }}>
                            {t("sleepAgent.answer.tryThis")}:
                          </span>{" "}
                          {sourceDetail.interpretation.action}
                        </div>
                      )}
                  </div>
                )}

                <div
                  style={{
                    fontSize: 10.5,
                    color: "#aaa",
                    letterSpacing: ".14em",
                    textTransform: "uppercase",
                    fontWeight: 700,
                    marginBottom: 8,
                  }}
                >
                  {t("sleepAgent.sourceSheet.abstract")}
                </div>
                <div
                  data-testid="source-sheet-abstract"
                  style={{
                    fontSize: 14.5,
                    color: "#2a1010",
                    lineHeight: 1.65,
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {sourceDetail.abstract &&
                  sourceDetail.abstract.trim().length > 0
                    ? sourceDetail.abstract
                    : t("sleepAgent.sourceSheet.noAbstract")}
                </div>

                {(sourceDetail.doi || sourceDetail.source_url) && (
                  <div style={{ marginTop: 24 }}>
                    <a
                      href={
                        sourceDetail.doi
                          ? sourceDetail.doi.startsWith("http")
                            ? sourceDetail.doi
                            : `https://doi.org/${sourceDetail.doi}`
                          : (sourceDetail.source_url ?? "#")
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid="source-sheet-external-link"
                      style={{
                        display: "inline-block",
                        padding: "10px 18px",
                        background: "#8B1A1A",
                        color: "#fff",
                        borderRadius: 999,
                        fontSize: 13,
                        fontWeight: 600,
                        textDecoration: "none",
                        letterSpacing: ".02em",
                      }}
                    >
                      {sourceDetail.doi
                        ? t("sleepAgent.sourceSheet.openPaper")
                        : t("sleepAgent.sourceSheet.openSource")}
                    </a>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Onboarding Overlay ─────────────────────────────────────────── */}
      {showOnboarding && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 100,
            background:
              "linear-gradient(160deg, #0c0618 0%, #1a0c28 30%, #2a0a1a 60%, #3d1008 100%)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "32px 24px",
            animation: "fadeInOverlay 0.6s ease forwards",
          }}
        >
          <style>{`
            @keyframes fadeInOverlay { from { opacity: 0; } to { opacity: 1; } }
            @keyframes riseUp { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: translateY(0); } }
            .ob-field { background: rgba(255,255,255,0.08) !important; }
            .ob-field:focus { background: rgba(255,255,255,0.13) !important; outline: none !important; border-color: rgba(255,255,255,0.4) !important; }
            .ob-field::placeholder { color: rgba(255,255,255,0.32); }
          `}</style>

          {regSuccess ? (
            /* ── Celebration moment ── */
            <div
              style={{
                textAlign: "center",
                animation: "riseUp 0.5s ease forwards",
              }}
            >
              <div
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: "50%",
                  border: "2px solid rgba(255,255,255,0.3)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "0 auto 28px",
                }}
              >
                <svg
                  width="28"
                  height="28"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="rgba(255,255,255,0.9)"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <div
                style={{
                  fontSize: "clamp(28px, 4vw, 40px)",
                  fontWeight: 400,
                  letterSpacing: "-0.02em",
                  lineHeight: 1.2,
                  color: "rgba(255,255,255,0.95)",
                  fontFamily: "'Georgia', 'Times New Roman', serif",
                  marginBottom: 20,
                }}
              >
                {t("sleepAgent.onboarding.welcomeName", {
                  name: onboardingName,
                })}
              </div>
              <div
                style={{
                  fontSize: 18,
                  color: "rgba(255,255,255,0.75)",
                  fontFamily: "'Georgia', 'Times New Roman', serif",
                  lineHeight: 1.5,
                  marginBottom: 12,
                }}
              >
                {t("sleepAgent.onboarding.journeyBegins")}
              </div>
              <div
                style={{
                  fontSize: 15,
                  color: "rgba(255,255,255,0.42)",
                  fontFamily: "-apple-system, system-ui, sans-serif",
                  letterSpacing: ".01em",
                }}
              >
                {t("sleepAgent.onboarding.comeBackTomorrow")}
              </div>
            </div>
          ) : (
            /* ── Registration form ── */
            <div
              style={{
                width: "100%",
                maxWidth: 440,
                animation: "riseUp 0.5s ease 0.1s both",
              }}
            >
              {/* Mandala mark */}
              <div style={{ textAlign: "center", marginBottom: 32 }}>
                <svg
                  width="36"
                  height="36"
                  viewBox="0 0 48 48"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <circle
                    cx="24"
                    cy="24"
                    r="9"
                    stroke="rgba(255,255,255,0.5)"
                    strokeWidth="1.2"
                  />
                  <circle
                    cx="24"
                    cy="15"
                    r="9"
                    stroke="rgba(255,255,255,0.5)"
                    strokeWidth="1.2"
                  />
                  <circle
                    cx="31.8"
                    cy="19.5"
                    r="9"
                    stroke="rgba(255,255,255,0.5)"
                    strokeWidth="1.2"
                  />
                  <circle
                    cx="31.8"
                    cy="28.5"
                    r="9"
                    stroke="rgba(255,255,255,0.5)"
                    strokeWidth="1.2"
                  />
                  <circle
                    cx="24"
                    cy="33"
                    r="9"
                    stroke="rgba(255,255,255,0.5)"
                    strokeWidth="1.2"
                  />
                  <circle
                    cx="16.2"
                    cy="28.5"
                    r="9"
                    stroke="rgba(255,255,255,0.5)"
                    strokeWidth="1.2"
                  />
                  <circle
                    cx="16.2"
                    cy="19.5"
                    r="9"
                    stroke="rgba(255,255,255,0.5)"
                    strokeWidth="1.2"
                  />
                </svg>
              </div>

              <div
                style={{
                  fontSize: "clamp(28px, 4vw, 40px)",
                  fontWeight: 400,
                  letterSpacing: "-0.02em",
                  lineHeight: 1.2,
                  color: "rgba(255,255,255,0.95)",
                  fontFamily: "'Georgia', 'Times New Roman', serif",
                  textAlign: "center",
                  marginBottom: 16,
                }}
              >
                {t("sleepAgent.onboarding.firstStep")}
              </div>
              <div
                style={{
                  fontSize: 16,
                  color: "rgba(255,255,255,0.52)",
                  textAlign: "center",
                  lineHeight: 1.6,
                  marginBottom: 40,
                  fontFamily: "-apple-system, system-ui, sans-serif",
                }}
              >
                {t("sleepAgent.onboarding.tomorrowQuestion")}
              </div>

              <form
                onSubmit={register}
                style={{ display: "flex", flexDirection: "column", gap: 12 }}
              >
                <input
                  className="ob-field"
                  value={onboardingName}
                  onChange={(e) => setOnboardingName(e.target.value)}
                  placeholder={t("sleepAgent.onboarding.firstNamePlaceholder")}
                  autoFocus
                  style={{
                    border: "1.5px solid rgba(255,255,255,0.18)",
                    borderRadius: 12,
                    padding: "16px 20px",
                    fontSize: 16,
                    color: "#fff",
                    fontFamily: "-apple-system, system-ui, sans-serif",
                    width: "100%",
                    boxSizing: "border-box",
                    transition: "border-color .15s, background .15s",
                  }}
                />
                <input
                  className="ob-field"
                  type="email"
                  value={onboardingEmail}
                  onChange={(e) => setOnboardingEmail(e.target.value)}
                  placeholder={t("sleepAgent.onboarding.emailPlaceholder")}
                  style={{
                    border: "1.5px solid rgba(255,255,255,0.18)",
                    borderRadius: 12,
                    padding: "16px 20px",
                    fontSize: 16,
                    color: "#fff",
                    fontFamily: "-apple-system, system-ui, sans-serif",
                    width: "100%",
                    boxSizing: "border-box",
                    transition: "border-color .15s, background .15s",
                  }}
                />
                <button
                  type="submit"
                  disabled={regLoading || !onboardingEmail.trim()}
                  style={{
                    marginTop: 4,
                    padding: "18px",
                    borderRadius: 12,
                    border: "none",
                    background: onboardingEmail.trim()
                      ? "rgba(255,255,255,0.95)"
                      : "rgba(255,255,255,0.18)",
                    color: onboardingEmail.trim()
                      ? "#1a0505"
                      : "rgba(255,255,255,0.4)",
                    fontSize: 16,
                    fontWeight: 600,
                    cursor: onboardingEmail.trim() ? "pointer" : "default",
                    fontFamily: "-apple-system, system-ui, sans-serif",
                    transition: "background .2s, color .2s",
                  }}
                >
                  {regLoading
                    ? t("sleepAgent.onboarding.loading")
                    : t("sleepAgent.onboarding.startTonight")}
                </button>
              </form>

              <button
                onClick={() => setShowOnboarding(false)}
                style={{
                  display: "block",
                  margin: "20px auto 0",
                  background: "none",
                  border: "none",
                  color: "rgba(255,255,255,0.28)",
                  fontSize: 13,
                  cursor: "pointer",
                  fontFamily: "-apple-system, system-ui, sans-serif",
                  letterSpacing: ".02em",
                }}
              >
                {t("sleepAgent.onboarding.maybeLater")}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Premium waitlist modal */}
      {premiumOpen && (
        <div
          onClick={() => !premiumDone && setPremiumOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            background: "rgba(10,4,4,.55)",
            backdropFilter: "blur(6px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#fff",
              borderRadius: 20,
              maxWidth: 460,
              width: "100%",
              padding: "40px 40px 36px",
              boxShadow: "0 32px 80px rgba(0,0,0,.22)",
              position: "relative",
            }}
          >
            {!premiumDone ? (
              <>
                <button
                  onClick={() => setPremiumOpen(false)}
                  style={{
                    position: "absolute",
                    top: 16,
                    right: 18,
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "#bbb",
                    fontSize: 22,
                    lineHeight: 1,
                  }}
                >
                  ×
                </button>

                {/* Badge */}
                <div style={{ marginBottom: 20 }}>
                  <span
                    style={{
                      background: "#f5eded",
                      color: "#8B1A1A",
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: ".1em",
                      textTransform: "uppercase",
                      borderRadius: 20,
                      padding: "4px 12px",
                    }}
                  >
                    {t("sleepAgent.premiumModal.badge")}
                  </span>
                </div>

                <div
                  style={{
                    fontSize: 26,
                    fontWeight: 700,
                    color: "#1a0505",
                    lineHeight: 1.2,
                    marginBottom: 10,
                    fontFamily: "Georgia, serif",
                  }}
                >
                  {t("sleepAgent.premiumModal.heading")}
                </div>
                <div
                  style={{
                    fontSize: 14,
                    color: "#666",
                    lineHeight: 1.6,
                    marginBottom: 8,
                  }}
                >
                  {t("sleepAgent.premiumModal.body")}
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: "#8B1A1A",
                    fontWeight: 600,
                    marginBottom: 24,
                  }}
                >
                  {t("sleepAgent.premiumModal.subBody")}
                </div>

                <form
                  onSubmit={submitWaitlist}
                  style={{ display: "flex", flexDirection: "column", gap: 12 }}
                >
                  <input
                    value={premiumName}
                    onChange={(e) => setPremiumName(e.target.value)}
                    placeholder={t("sleepAgent.premiumModal.namePlaceholder")}
                    required
                    style={{
                      border: "1.5px solid #e8e0e0",
                      borderRadius: 10,
                      padding: "12px 16px",
                      fontSize: 14,
                      outline: "none",
                      fontFamily: "inherit",
                      background: "#fafaf7",
                    }}
                  />
                  <input
                    type="email"
                    value={premiumEmail}
                    onChange={(e) => setPremiumEmail(e.target.value)}
                    placeholder={t("sleepAgent.premiumModal.emailPlaceholder")}
                    required
                    style={{
                      border: "1.5px solid #e8e0e0",
                      borderRadius: 10,
                      padding: "12px 16px",
                      fontSize: 14,
                      outline: "none",
                      fontFamily: "inherit",
                      background: "#fafaf7",
                    }}
                  />
                  <button
                    type="submit"
                    disabled={premiumLoading}
                    style={{
                      background: "#8B1A1A",
                      color: "#fff",
                      border: "none",
                      borderRadius: 10,
                      padding: "14px 20px",
                      fontSize: 15,
                      fontWeight: 700,
                      cursor: premiumLoading ? "wait" : "pointer",
                      letterSpacing: ".01em",
                      marginTop: 4,
                      opacity: premiumLoading ? 0.7 : 1,
                    }}
                  >
                    {premiumLoading
                      ? t("sleepAgent.premiumModal.savingBtn")
                      : t("sleepAgent.premiumModal.reserveSpot")}
                  </button>
                </form>

                <div
                  style={{
                    marginTop: 16,
                    fontSize: 12,
                    color: "#bbb",
                    textAlign: "center",
                  }}
                >
                  {t("sleepAgent.premiumModal.noCharge")}
                </div>
              </>
            ) : (
              <>
                <div style={{ textAlign: "center", padding: "8px 0" }}>
                  <div style={{ fontSize: 40, marginBottom: 16 }}>🌙</div>
                  <div
                    style={{
                      fontSize: 22,
                      fontWeight: 700,
                      color: "#1a0505",
                      fontFamily: "Georgia, serif",
                      marginBottom: 10,
                    }}
                  >
                    {t("sleepAgent.premiumModal.waitlistHeading")}
                  </div>
                  <div
                    style={{
                      fontSize: 14,
                      color: "#666",
                      lineHeight: 1.6,
                      marginBottom: 28,
                    }}
                  >
                    {t("sleepAgent.premiumModal.waitlistBody")}
                  </div>
                  <button
                    onClick={() => setPremiumOpen(false)}
                    style={{
                      background: "#8B1A1A",
                      color: "#fff",
                      border: "none",
                      borderRadius: 10,
                      padding: "12px 28px",
                      fontSize: 14,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {t("sleepAgent.premiumModal.backToQuestions")}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Subscription paywall modal */}
      {paywallOpen && (
        <div
          onClick={() => setPaywallOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            background: "rgba(10,4,4,.55)",
            backdropFilter: "blur(6px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#fff",
              borderRadius: 20,
              maxWidth: 460,
              width: "100%",
              padding: "40px 40px 36px",
              boxShadow: "0 32px 80px rgba(0,0,0,.22)",
              position: "relative",
            }}
          >
            <button
              onClick={() => setPaywallOpen(false)}
              style={{
                position: "absolute",
                top: 16,
                right: 18,
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "#bbb",
                fontSize: 22,
                lineHeight: 1,
              }}
            >
              ×
            </button>

            <div style={{ marginBottom: 20 }}>
              <span
                style={{
                  background: "#f5eded",
                  color: "#8B1A1A",
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: ".1em",
                  textTransform: "uppercase",
                  borderRadius: 20,
                  padding: "4px 12px",
                }}
              >
                {t("sleepAgent.paywallModal.badge")}
              </span>
            </div>

            <div
              style={{
                fontSize: 26,
                fontWeight: 700,
                color: "#1a0505",
                lineHeight: 1.2,
                marginBottom: 10,
                fontFamily: "Georgia, serif",
              }}
            >
              {t("sleepAgent.paywallModal.heading")}
            </div>
            {pendingPaywallQ && (
              <div
                style={{
                  fontSize: 15,
                  color: "#1a0505",
                  fontFamily: "Georgia, serif",
                  fontStyle: "italic",
                  lineHeight: 1.5,
                  marginBottom: 14,
                  padding: "12px 16px",
                  background: "rgba(139,26,26,0.05)",
                  borderLeft: "3px solid #8B1A1A",
                  borderRadius: "0 8px 8px 0",
                }}
              >
                "{pendingPaywallQ}"
              </div>
            )}
            {journeyDone ? (
              <div style={{ textAlign: "center", padding: "16px 0" }}>
                <div style={{ fontSize: 28, marginBottom: 10 }}>🎉</div>
                <div
                  style={{
                    fontSize: 15,
                    color: "#1a0505",
                    fontWeight: 600,
                    marginBottom: 6,
                  }}
                >
                  {t("sleepAgent.paywallModal.waitlistDoneHeading")}
                </div>
                <div style={{ fontSize: 13.5, color: "#666", lineHeight: 1.6 }}>
                  {t("sleepAgent.paywallModal.waitlistDoneBody")}
                </div>
              </div>
            ) : (
              <>
                <div
                  style={{
                    padding: "18px 20px",
                    borderRadius: 14,
                    border: "2px solid #8B1A1A",
                    marginBottom: 14,
                    background: "#fdf7f7",
                  }}
                >
                  <div
                    style={{
                      fontSize: 13.5,
                      color: "#4a2020",
                      lineHeight: 1.6,
                      marginBottom: 14,
                    }}
                  >
                    {t("sleepAgent.paywallModal.waitlistBody")}
                  </div>
                  {journeyError && (
                    <div
                      style={{
                        fontSize: 12.5,
                        color: "#c0392b",
                        marginBottom: 8,
                      }}
                    >
                      {journeyError}
                    </div>
                  )}
                  <form
                    onSubmit={handleJourneyCheckout}
                    style={{ display: "flex", gap: 8 }}
                  >
                    <input
                      type="email"
                      required
                      placeholder="your@email.com"
                      value={journeyEmail}
                      onChange={(e) => setJourneyEmail(e.target.value)}
                      style={{
                        flex: 1,
                        padding: "10px 12px",
                        fontSize: 13.5,
                        borderRadius: 8,
                        border: "1px solid #ddd",
                        outline: "none",
                      }}
                    />
                    <button
                      type="submit"
                      disabled={journeyLoading}
                      style={{
                        background: "#8B1A1A",
                        color: "#fff",
                        border: "none",
                        borderRadius: 8,
                        padding: "10px 16px",
                        fontSize: 13.5,
                        fontWeight: 700,
                        cursor: journeyLoading ? "not-allowed" : "pointer",
                        whiteSpace: "nowrap",
                        opacity: journeyLoading ? 0.7 : 1,
                      }}
                    >
                      {journeyLoading
                        ? "…"
                        : t("sleepAgent.paywallModal.notifyMe")}
                    </button>
                  </form>
                </div>
              </>
            )}

            <button
              onClick={() => setPaywallOpen(false)}
              style={{
                width: "100%",
                marginTop: 6,
                background: "none",
                border: "none",
                color: "#999",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              {t("sleepAgent.paywallModal.maybeLater")}
            </button>
          </div>
        </div>
      )}

      {/* Pal Harford — "How does Palonur work?" invite + auto-start call */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 6,
          paddingTop: 4,
        }}
      >
        {!submitted && (
          <span
            style={{
              fontFamily: "-apple-system, system-ui, sans-serif",
              fontSize: 12,
              fontStyle: "italic",
              fontWeight: 500,
              color: "rgba(26,5,5,0.52)",
              letterSpacing: "0.01em",
            }}
          >
            How does Palonur work?
          </span>
        )}
        <TavusAvatarButton
          autoStart
          question={submitted || undefined}
          isEnglish
          answered={!streaming && !!parsed}
          answerSummary={
            !streaming && parsed?.kind === "structured" && parsed.answer
              ? parsed.answer.slice(0, 200)
              : undefined
          }
          liveText={query || undefined}
        />
      </div>
    </div>
  );
}

function BlinkCaret({ on }: { on: boolean }) {
  if (!on) return null;
  return (
    <span
      style={{
        display: "inline-block",
        width: 8,
        height: "1em",
        background: "#8B1A1A",
        marginLeft: 4,
        verticalAlign: "text-bottom",
        borderRadius: 1,
        animation: "blink 1s steps(2) infinite",
      }}
    >
      <style>{`@keyframes blink { 50% { opacity: 0; } }`}</style>
    </span>
  );
}
