import { useEffect, useState } from "react";
import { Link, useParams } from "wouter";
import {
  NewsletterSubscribe,
  applyPageMeta,
  formatIssueDate,
  RED,
  INK,
  PAPER,
  MUTED,
  SERIF,
  SANS,
} from "@/components/newsletter-subscribe";
import { ReliabilityBadge } from "@/components/reliability-badge";
import { AskSteward, type AskPlan } from "@/components/ask-steward";
import { destinationWithPendingQuestion } from "@/lib/pending-question";
import { SLMBrand } from "@/components/SLMBrand";
import { studyDesignLabel } from "@workspace/db/study-design";
import type { PublicReliability } from "@workspace/db/source-rigor";
import { StewardAchievementsPanel } from "@/components/steward-achievements";

interface LandingSection {
  heading: string;
  body: string;
  imageUrl: string | null;
}

interface LandingContent {
  heroEyebrow: string;
  heroHeadline: string;
  heroSubhead: string;
  aboutLead: string;
  sections: LandingSection[];
  benefits: string[];
}

interface Publication {
  id: number;
  name: string;
  slug: string;
  tagline: string | null;
  description: string | null;
  bylineName: string | null;
  bylineInstitution: string | null;
  accentColor: string | null;
  isHouse: boolean;
  // Steward-tailored fields joined read-only from existing data. All nullable;
  // sections that depend on them are omitted cleanly when absent.
  photoUrl: string | null;
  bio: string | null;
  topicDescription: string | null;
  stewardFullName?: string | null;
  stewardInstitution?: string | null;
  achievements?: string[];
  // "Ask the steward" eligibility, decided server-side. The panel only renders
  // when the owning steward has a published voice profile AND approved content
  // in their primary pillar, so readers never hit a dead-end answer.
  ask?: {
    eligible: boolean;
    pillarSlug: string | null;
    stewardName: string | null;
  } | null;
  // Paid steward Q&A plan (null when Stripe is absent or the pub is house).
  askPlan?: AskPlan | null;
  // Auto-generated, then fully editable, editorial landing page. Null when the
  // owner hasn't generated one yet — the page falls back to the original layout.
  landing: LandingContent | null;
  heroImageUrl: string | null;
}

interface IssueSummary {
  id: number;
  title: string;
  previewText: string | null;
  heroImageUrl: string | null;
  sentAt: string | null;
}

interface ScienceSource {
  id: number;
  kind: string;
  title: string;
  authors: string | null;
  year: number | null;
  journal: string | null;
  doi: string | null;
  sourceUrl: string | null;
  studyDesign: string | null;
}

interface ScienceItem {
  interpretationId: number;
  finding: string;
  interpretation: string;
  practicalStep: string | null;
  limitations: string | null;
  stewardName: string | null;
  pillarSlug: string;
  pillarName: string;
  source: ScienceSource;
  reliability: PublicReliability | null;
}

interface SciencePillar {
  slug: string;
  name: string;
}

/** Build "Author et al., Year, Journal" from the loosely-populated citation
 * fields, gracefully dropping whatever is missing. */
function formatCitation(s: ScienceSource): string {
  const parts: string[] = [];
  if (s.authors) {
    const first = s.authors.split(/[,;&]| and /i)[0]?.trim() ?? "";
    const surname = first.split(/\s+/).pop() ?? first;
    const multi = /[,;&]| and /i.test(s.authors);
    if (surname) parts.push(multi ? `${surname} et al.` : surname);
  }
  if (s.year != null) parts.push(String(s.year));
  if (s.journal) parts.push(s.journal);
  return parts.join(", ");
}

/** A single governed science card: the finding (what the research found), an
 * optional practical step, the limitation guardrail, the citation, and the
 * steward-approved reliability badge. Read-only — no live ask box. */
function ScienceCard({
  item,
  accent,
  accentTintSoft,
  accentBorder,
}: {
  item: ScienceItem;
  accent: string;
  accentTintSoft: string;
  accentBorder: string;
}) {
  const s = item.source;
  const citation = formatCitation(s);
  const href = s.doi
    ? `https://doi.org/${s.doi.replace(/^doi:\s*/i, "")}`
    : s.sourceUrl || null;
  const design = studyDesignLabel(s.studyDesign);
  return (
    <article
      data-testid={`science-card-${item.interpretationId}`}
      style={{
        padding: "20px 22px",
        borderRadius: 16,
        background: "#fff",
        border: `1px solid ${accentBorder}`,
      }}
    >
      <p
        style={{
          fontFamily: SERIF,
          fontSize: 19,
          lineHeight: 1.4,
          color: INK,
          margin: "0 0 10px",
        }}
      >
        {item.finding}
      </p>
      {item.interpretation && (
        <p
          style={{
            fontSize: 15.5,
            lineHeight: 1.65,
            color: INK,
            opacity: 0.82,
            margin: "0 0 12px",
          }}
        >
          {item.interpretation}
        </p>
      )}
      {item.practicalStep && (
        <div
          style={{
            padding: "12px 14px",
            borderRadius: 12,
            background: accentTintSoft,
            margin: "0 0 12px",
          }}
        >
          <p
            style={{
              fontSize: 11,
              letterSpacing: ".12em",
              textTransform: "uppercase",
              color: accent,
              fontWeight: 700,
              margin: "0 0 4px",
            }}
          >
            Practical step
          </p>
          <p
            style={{
              fontSize: 15,
              lineHeight: 1.55,
              color: INK,
              opacity: 0.9,
              margin: 0,
            }}
          >
            {item.practicalStep}
          </p>
        </div>
      )}
      {item.limitations && (
        <p
          style={{
            fontSize: 13.5,
            lineHeight: 1.55,
            color: MUTED,
            fontStyle: "italic",
            margin: "0 0 12px",
          }}
        >
          What this doesn't prove: {item.limitations}
        </p>
      )}
      <div
        style={{
          paddingTop: 12,
          borderTop: `1px solid ${accentBorder}`,
        }}
      >
        <p style={{ fontSize: 13.5, color: INK, margin: 0, opacity: 0.78 }}>
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: accent, textDecoration: "none", fontWeight: 600 }}
            >
              {s.title}
            </a>
          ) : (
            <span style={{ fontWeight: 600 }}>{s.title}</span>
          )}
          {citation && (
            <span style={{ color: MUTED }}>
              {" "}
              · {citation}
            </span>
          )}
          {design && <span style={{ color: MUTED }}> · {design}</span>}
        </p>
        {item.stewardName && (
          <p style={{ fontSize: 12.5, color: MUTED, margin: "4px 0 0" }}>
            Reviewed by {item.stewardName}
            {item.pillarName ? ` · ${item.pillarName}` : ""}
          </p>
        )}
        {item.reliability && (
          <ReliabilityBadge reliability={item.reliability} sourceId={s.id} />
        )}
      </div>
    </article>
  );
}

/** Parse a #rgb / #rrggbb hex string to an `rgba(r,g,b,a)` string, or null. */
function hexToRgba(hex: string | null | undefined, alpha: number): string | null {
  if (!hex) return null;
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
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

export default function NewsletterPub() {
  const params = useParams();
  const slug = String(params.slug ?? "");

  const [pub, setPub] = useState<Publication | null>(null);
  const [issues, setIssues] = useState<IssueSummary[]>([]);
  const [science, setScience] = useState<ScienceItem[]>([]);
  const [sciencePillars, setSciencePillars] = useState<SciencePillar[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "missing">(
    "loading",
  );
  // The paywall-held question riding back as ?q= (post-checkout return or a
  // magic-link landing); fired once by AskSteward.
  const [initialQuestion, setInitialQuestion] = useState<string | null>(null);

  // Checkout return: ?checkout=success&session_id=… → confirm the purchase.
  // Payment never grants a session — a new buyer gets a magic-link email and
  // a notice; an already-signed-in buyer continues straight into the held
  // question (appended as ?q= by the pending-question helper).
  const [checkoutNotice, setCheckoutNotice] = useState<string | null>(null);
  // Achievements panel opened by clicking the steward's photo in the hero.
  const [stewardPanelOpen, setStewardPanelOpen] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get("q");
    if (q?.trim()) setInitialQuestion(q.trim());
    const checkout = params.get("checkout");
    const sessionId = params.get("session_id");
    if (!checkout) return;
    const path = window.location.pathname;
    function clearQuery() {
      window.history.replaceState({}, "", path);
    }
    if (checkout === "cancelled") {
      clearQuery();
      return;
    }
    if (checkout !== "success" || !sessionId) {
      clearQuery();
      return;
    }
    void (async () => {
      try {
        const res = await fetch("/api/billing/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ sessionId }),
        });
        if (!res.ok) {
          clearQuery();
          return;
        }
        const data = (await res.json()) as {
          emailVerificationSent?: boolean;
          email?: string;
        };
        clearQuery();
        if (data.emailVerificationSent) {
          setCheckoutNotice(
            `You're in — check ${data.email ?? "your email"} for a sign-in link. Your question will be answered the moment you arrive.`,
          );
        } else {
          // Already signed in: consume the held question in place.
          const dest = destinationWithPendingQuestion(path);
          if (dest !== path) {
            const held = new URL(dest, window.location.origin).searchParams.get(
              "q",
            );
            if (held) setInitialQuestion(held);
          }
        }
      } catch {
        clearQuery();
      }
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(
          `/api/newsletter/p/${encodeURIComponent(slug)}/issues`,
        );
        if (!res.ok) {
          if (!cancelled) setLoadState("missing");
          return;
        }
        const data = (await res.json()) as {
          publication: Publication;
          issues: IssueSummary[];
          science?: ScienceItem[];
          sciencePillars?: SciencePillar[];
        };
        if (!cancelled) {
          setPub(data.publication);
          setIssues(data.issues ?? []);
          setScience(data.science ?? []);
          setSciencePillars(data.sciencePillars ?? []);
          setLoadState("ready");
        }
      } catch {
        if (!cancelled) setLoadState("missing");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    if (!pub) {
      document.body.style.background = PAPER;
      return () => {
        document.body.style.background = "";
      };
    }
    const description =
      pub.landing?.heroSubhead ||
      pub.tagline ||
      pub.topicDescription ||
      pub.description ||
      `Read ${pub.name} on Palonur.`;
    const cleanupMeta = applyPageMeta({
      title: pub.bylineName
        ? `${pub.name} · ${pub.bylineName}`
        : `${pub.name} · Newsletter`,
      description,
      // Prefer the generated landing hero, then the steward's face, then the
      // latest issue image.
      image:
        pub.heroImageUrl ??
        pub.photoUrl ??
        issues.find((i) => i.heroImageUrl)?.heroImageUrl ??
        null,
    });
    document.body.style.background = PAPER;
    return () => {
      cleanupMeta();
      document.body.style.background = "";
    };
  }, [pub, issues]);

  // Lightweight machine-readable discovery hook. An AI agent landing on the
  // page can read this JSON block to learn the publication's name, topic
  // pillar(s), and the anonymous, idempotent, CORS-open subscribe call —
  // without scraping the rendered HTML.
  useEffect(() => {
    if (!pub) return;
    const el = document.createElement("script");
    el.type = "application/json";
    el.id = "palonur-publication-discovery";
    el.textContent = JSON.stringify({
      type: "palonur.publication",
      name: pub.name,
      slug: pub.slug,
      isHouse: pub.isHouse,
      topic: pub.topicDescription ?? pub.tagline ?? null,
      pillars: sciencePillars.map((p) => p.slug),
      subscribe: {
        method: "POST",
        url: `/api/newsletter/p/${pub.slug}/subscribe`,
        body: { email: "string", name: "string?", source: "string?" },
        idempotent: true,
        auth: "none",
      },
    });
    document.head.appendChild(el);
    return () => {
      el.remove();
    };
  }, [pub, sciencePillars]);

  const accent = pub?.accentColor || RED;
  const accentTintStrong = hexToRgba(accent, 0.12) ?? "rgba(139,26,26,0.10)";
  const accentTintSoft = hexToRgba(accent, 0.05) ?? "rgba(139,26,26,0.04)";
  const accentBorder = hexToRgba(accent, 0.22) ?? "rgba(139,26,26,0.2)";

  if (loadState === "loading") {
    return (
      <div
        style={{
          minHeight: "100dvh",
          background: PAPER,
          color: MUTED,
          fontFamily: SANS,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        Loading…
      </div>
    );
  }

  if (loadState === "missing" || !pub) {
    return (
      <div
        style={{
          minHeight: "100dvh",
          background: PAPER,
          color: INK,
          fontFamily: SANS,
        }}
      >
        <div style={{ maxWidth: 560, margin: "0 auto", padding: "96px 24px" }}>
          <a
            href="/"
            style={{ fontSize: 13, color: MUTED, textDecoration: "none" }}
          >
            ← Palonur
          </a>
          <h1
            style={{
              fontFamily: SERIF,
              fontWeight: 500,
              fontSize: 32,
              marginTop: 32,
            }}
          >
            Newsletter not found
          </h1>
          <p style={{ color: MUTED, fontSize: 16, lineHeight: 1.6 }}>
            We couldn't find a newsletter at this address. Please check the link.
          </p>
        </div>
      </div>
    );
  }

  const byline = [pub.bylineName, pub.bylineInstitution]
    .filter(Boolean)
    .join(" · ");
  const steward = firstName(pub.bylineName);
  const hasIssues = issues.length > 0;
  const latest = hasIssues ? issues[0] : null;
  const rest = hasIssues ? issues.slice(1) : [];

  // An auto-generated, then editable, editorial landing page. When present it
  // drives the hero copy/image, the "about this topic" lead, the editorial
  // sections and the "what you'll get" band. When absent everything below falls
  // back to the original derived layout.
  const landing = pub.landing;
  const landingSections = (landing?.sections ?? []).filter(
    (s) => (s.heading && s.heading.trim()) || (s.body && s.body.trim()),
  );

  const heroEyebrow = landing?.heroEyebrow?.trim() || byline || null;
  const heroHeadline = landing?.heroHeadline?.trim() || pub.name;
  const heroSubhead = landing?.heroSubhead?.trim() || pub.tagline || null;
  const aboutLead = landing?.aboutLead?.trim() || pub.topicDescription || null;

  // Tailored, honest "what you'll get" points. Prefer the generated/edited
  // benefits; otherwise derive honest defaults. No cadence promises (we don't
  // know the schedule), no payment language — subscribing is free.
  const generatedBenefits = (landing?.benefits ?? [])
    .map((b) => b.trim())
    .filter(Boolean);
  const benefits: string[] =
    generatedBenefits.length > 0
      ? generatedBenefits
      : [
          steward
            ? `${steward}'s own take, in their words — not generic, algorithm-chosen content.`
            : `Original writing straight from the author — not generic, algorithm-chosen content.`,
          pub.topicDescription
            ? `Science, signed: grounded thinking from a named expert you can quote — and check.`
            : `Science, signed: thoughtful writing from a named expert you can quote — and check.`,
          `Free to read. Delivered to your inbox, with one-click unsubscribe — always.`,
        ];

  return (
    <div
      style={{
        minHeight: "100dvh",
        background: PAPER,
        color: INK,
        fontFamily: SANS,
      }}
    >
      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <header
        style={{
          background: `linear-gradient(180deg, ${accentTintStrong}, ${accentTintSoft})`,
          borderBottom: `1px solid ${accentBorder}`,
        }}
      >
        <div
          style={{
            maxWidth: 880,
            margin: "0 auto",
            padding: "28px 24px 56px",
          }}
        >
          <a
            href="/"
            style={{
              fontSize: 13,
              letterSpacing: ".04em",
              color: MUTED,
              textDecoration: "none",
            }}
          >
            ← Palonur
          </a>

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 24,
              marginTop: 36,
            }}
          >
            {pub.photoUrl && (
              <button
                type="button"
                onClick={() => setStewardPanelOpen(true)}
                data-testid="button-steward-avatar-pub"
                title={`About ${pub.stewardFullName ?? pub.bylineName ?? pub.name}`}
                aria-label={`About ${pub.stewardFullName ?? pub.bylineName ?? pub.name}`}
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                <img
                  src={pub.photoUrl}
                  alt={pub.bylineName ?? pub.name}
                  style={{
                    width: 104,
                    height: 104,
                    borderRadius: "50%",
                    objectFit: "cover",
                    display: "block",
                    border: `3px solid ${accent}`,
                    boxShadow: "0 6px 20px rgba(10,10,15,0.12)",
                  }}
                />
              </button>
            )}
            {stewardPanelOpen && (
              <StewardAchievementsPanel
                steward={{
                  fullName: pub.stewardFullName ?? pub.bylineName ?? pub.name,
                  institution:
                    pub.stewardInstitution ?? pub.bylineInstitution,
                  photoUrl: pub.photoUrl,
                  achievements: pub.achievements ?? [],
                  bio: pub.bio,
                }}
                onClose={() => setStewardPanelOpen(false)}
              />
            )}
            <div style={{ minWidth: 240, flex: 1 }}>
              {/* "Science, signed" category badge — always present so the
                  category phrase is never lost even when no custom landing
                  content has been generated for this publication. */}
              <p
                style={{
                  margin: "0 0 10px",
                  fontSize: 11,
                  letterSpacing: ".22em",
                  textTransform: "uppercase",
                  color: accent,
                  fontWeight: 700,
                  opacity: 0.7,
                }}
              >
                Science, signed
              </p>
              {heroEyebrow && (
                <p
                  style={{
                    margin: 0,
                    fontSize: 12,
                    letterSpacing: ".18em",
                    textTransform: "uppercase",
                    color: accent,
                    fontWeight: 600,
                  }}
                >
                  {heroEyebrow}
                </p>
              )}
              <h1
                style={{
                  fontFamily: SERIF,
                  fontWeight: 500,
                  fontSize: "clamp(34px, 6vw, 56px)",
                  lineHeight: 1.06,
                  letterSpacing: "-0.01em",
                  margin: "10px 0 0",
                }}
              >
                {heroHeadline}
              </h1>
              {/* When generated copy supplies a distinct headline, still show the
                  publication name as a small kicker so the brand stays clear. */}
              {landing && heroHeadline !== pub.name && (
                <p
                  style={{
                    margin: "8px 0 0",
                    fontSize: 14,
                    color: MUTED,
                    fontWeight: 600,
                  }}
                >
                  {pub.name}
                </p>
              )}
              {heroSubhead && (
                <p
                  style={{
                    fontFamily: SERIF,
                    fontSize: "clamp(18px, 2.4vw, 22px)",
                    lineHeight: 1.5,
                    color: INK,
                    opacity: 0.78,
                    margin: "16px 0 0",
                    maxWidth: 620,
                  }}
                >
                  {heroSubhead}
                </p>
              )}
            </div>
          </div>

          {/* Generated hero image — a wide editorial banner. */}
          {pub.heroImageUrl && (
            <img
              src={pub.heroImageUrl}
              alt=""
              style={{
                width: "100%",
                display: "block",
                marginTop: 32,
                borderRadius: 18,
                aspectRatio: "16 / 9",
                objectFit: "cover",
                border: `1px solid ${accentBorder}`,
                boxShadow: "0 10px 30px rgba(10,10,15,0.1)",
              }}
            />
          )}

          {/* Primary subscribe CTA */}
          <div
            style={{
              marginTop: 36,
              padding: "26px 26px 28px",
              borderRadius: 16,
              background: "#fff",
              border: `1px solid ${accentBorder}`,
              boxShadow: "0 8px 28px rgba(10,10,15,0.07)",
              maxWidth: 520,
            }}
          >
            <h2
              style={{
                fontFamily: SERIF,
                fontWeight: 500,
                fontSize: 22,
                margin: "0 0 4px",
              }}
            >
              Subscribe free
            </h2>
            <p
              style={{
                fontSize: 14.5,
                lineHeight: 1.55,
                color: MUTED,
                margin: "0 0 16px",
              }}
            >
              {steward
                ? `Done sifting contradictory advice? Get ${steward}'s next issue — from the source — in your inbox.`
                : `Done sifting contradictory advice? Get the next issue — from the source — in your inbox.`}{" "}
              No cost, no spam.
            </p>
            <NewsletterSubscribe
              slug={pub.slug}
              accent={accent}
              source="publication-page"
            />
          </div>
        </div>
      </header>

      <div style={{ maxWidth: 880, margin: "0 auto", padding: "8px 24px 96px" }}>
        {/* ── About this topic ────────────────────────────────────────────── */}
        {aboutLead && (
          <section style={{ marginTop: 56 }}>
            <p
              style={{
                fontSize: 12,
                letterSpacing: ".16em",
                textTransform: "uppercase",
                color: accent,
                fontWeight: 600,
                margin: "0 0 12px",
              }}
            >
              About this topic
            </p>
            <p
              style={{
                fontFamily: SERIF,
                fontSize: "clamp(19px, 2.6vw, 24px)",
                lineHeight: 1.6,
                color: INK,
                margin: 0,
                maxWidth: 720,
                whiteSpace: "pre-wrap",
              }}
            >
              {aboutLead}
            </p>
          </section>
        )}

        {/* ── Editorial sections (generated, then editable) ────────────────── */}
        {landingSections.length > 0 && (
          <div style={{ marginTop: 8 }}>
            {landingSections.map((s, i) => (
              <section
                key={i}
                style={{
                  marginTop: 56,
                  display: "grid",
                  gridTemplateColumns: s.imageUrl
                    ? "minmax(0, 1fr) minmax(0, 1fr)"
                    : "1fr",
                  gap: 32,
                  alignItems: "center",
                }}
              >
                {/* Alternate image side for rhythm on wide screens. */}
                {s.imageUrl && i % 2 === 1 && (
                  <img
                    src={s.imageUrl}
                    alt=""
                    style={{
                      width: "100%",
                      borderRadius: 16,
                      aspectRatio: "4 / 3",
                      objectFit: "cover",
                      border: "1px solid rgba(10,10,15,0.1)",
                      order: 0,
                    }}
                  />
                )}
                <div>
                  {s.heading && (
                    <h2
                      style={{
                        fontFamily: SERIF,
                        fontWeight: 500,
                        fontSize: "clamp(24px, 3.2vw, 32px)",
                        lineHeight: 1.18,
                        margin: 0,
                      }}
                    >
                      {s.heading}
                    </h2>
                  )}
                  {s.body && (
                    <p
                      style={{
                        fontSize: 17,
                        lineHeight: 1.7,
                        color: INK,
                        opacity: 0.84,
                        margin: "14px 0 0",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {s.body}
                    </p>
                  )}
                </div>
                {s.imageUrl && i % 2 === 0 && (
                  <img
                    src={s.imageUrl}
                    alt=""
                    style={{
                      width: "100%",
                      borderRadius: 16,
                      aspectRatio: "4 / 3",
                      objectFit: "cover",
                      border: "1px solid rgba(10,10,15,0.1)",
                    }}
                  />
                )}
              </section>
            ))}
          </div>
        )}

        {/* ── Steward bio (distinct from the publication description) ──────── */}
        {pub.bio && (
          <section
            style={{
              marginTop: 44,
              display: "flex",
              gap: 18,
              alignItems: "flex-start",
              padding: "22px 24px",
              borderRadius: 16,
              background: accentTintSoft,
              border: `1px solid ${accentBorder}`,
            }}
          >
            {pub.photoUrl && (
              <img
                src={pub.photoUrl}
                alt=""
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: "50%",
                  objectFit: "cover",
                  flexShrink: 0,
                }}
              />
            )}
            <div>
              <p
                style={{
                  fontSize: 12,
                  letterSpacing: ".14em",
                  textTransform: "uppercase",
                  color: accent,
                  fontWeight: 600,
                  margin: "0 0 6px",
                }}
              >
                {pub.bylineName ? `About ${pub.bylineName}` : "About the author"}
              </p>
              <p
                style={{
                  fontSize: 16.5,
                  lineHeight: 1.65,
                  color: INK,
                  opacity: 0.86,
                  margin: 0,
                }}
              >
                {pub.bio}
              </p>
            </div>
          </section>
        )}

        {/* Post-checkout notice for new buyers awaiting their magic link. */}
        {checkoutNotice && (
          <div
            data-testid="checkout-notice"
            style={{
              marginTop: 32,
              padding: "16px 18px",
              borderRadius: 12,
              background: accentTintSoft,
              border: `1px solid ${accentBorder}`,
              fontSize: 15,
              lineHeight: 1.55,
              color: INK,
              fontFamily: SANS,
            }}
          >
            {checkoutNotice}
          </div>
        )}

        {/* ── Ask the steward (live, voice-matched, pillar-locked) ────────── */}
        {pub.ask?.eligible && pub.ask.pillarSlug && (
          <AskSteward
            pillarSlug={pub.ask.pillarSlug}
            stewardName={pub.ask.stewardName ?? pub.bylineName}
            accent={accent}
            publicationSlug={pub.slug}
            plan={pub.askPlan ?? null}
            initialQuestion={initialQuestion}
          />
        )}

        {/* ── What the science says (governed, read-only) ─────────────────── */}
        {science.length > 0 && (
          <section style={{ marginTop: 56 }} data-testid="science-home">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: 12,
                marginBottom: 6,
              }}
            >
              <p
                style={{
                  fontSize: 12,
                  letterSpacing: ".16em",
                  textTransform: "uppercase",
                  color: accent,
                  fontWeight: 600,
                  margin: 0,
                }}
              >
                What the science says
              </p>
              <SLMBrand size="sm" />
            </div>
            <p
              style={{
                fontSize: 15.5,
                lineHeight: 1.6,
                color: INK,
                opacity: 0.7,
                margin: "0 0 22px",
                maxWidth: 620,
              }}
            >
              Findings a Stanford steward has reviewed and approved — each tied to
              a citation and a reliability score. This is the governed science
              behind {pub.isHouse ? "the newsletter" : pub.name}.
            </p>
            {(pub.isHouse && sciencePillars.length > 0
              ? sciencePillars
              : [{ slug: "__all__", name: "" }]
            ).map((grp) => {
              const items =
                grp.slug === "__all__"
                  ? science
                  : science.filter((s) => s.pillarSlug === grp.slug);
              if (items.length === 0) return null;
              return (
                <div key={grp.slug} style={{ marginBottom: 28 }}>
                  {pub.isHouse && grp.name && (
                    <h3
                      style={{
                        fontFamily: SERIF,
                        fontSize: 21,
                        color: INK,
                        margin: "0 0 14px",
                        paddingBottom: 8,
                        borderBottom: `1px solid ${accentBorder}`,
                      }}
                    >
                      {grp.name}
                    </h3>
                  )}
                  <div style={{ display: "grid", gap: 16 }}>
                    {items.map((item) => (
                      <ScienceCard
                        key={item.interpretationId}
                        item={item}
                        accent={accent}
                        accentTintSoft={accentTintSoft}
                        accentBorder={accentBorder}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </section>
        )}

        {/* ── What you'll get ─────────────────────────────────────────────── */}
        <section style={{ marginTop: 52 }}>
          <p
            style={{
              fontSize: 12,
              letterSpacing: ".16em",
              textTransform: "uppercase",
              color: accent,
              fontWeight: 600,
              margin: "0 0 16px",
            }}
          >
            What you'll get when you subscribe
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 16,
            }}
          >
            {benefits.map((b, i) => (
              <div
                key={i}
                style={{
                  padding: "20px 20px 22px",
                  borderRadius: 14,
                  background: "#fff",
                  border: "1px solid rgba(10,10,15,0.08)",
                }}
              >
                <div
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    background: accentTintStrong,
                    color: accent,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 700,
                    fontSize: 14,
                    marginBottom: 12,
                  }}
                >
                  {i + 1}
                </div>
                <p
                  style={{
                    fontSize: 15.5,
                    lineHeight: 1.55,
                    color: INK,
                    opacity: 0.85,
                    margin: 0,
                  }}
                >
                  {b}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* ── Featured latest issue ───────────────────────────────────────── */}
        {latest && (
          <section style={{ marginTop: 60 }}>
            <p
              style={{
                fontSize: 12,
                letterSpacing: ".16em",
                textTransform: "uppercase",
                color: accent,
                fontWeight: 600,
                margin: "0 0 16px",
              }}
            >
              Latest issue
            </p>
            <Link
              href={`/p/${pub.slug}/${latest.id}`}
              style={{
                display: "block",
                textDecoration: "none",
                color: INK,
                border: "1px solid rgba(10,10,15,0.1)",
                borderRadius: 18,
                overflow: "hidden",
                background: "#fff",
                boxShadow: "0 2px 10px rgba(10,10,15,0.05)",
              }}
              data-testid={`link-issue-${latest.id}`}
            >
              {latest.heroImageUrl && (
                <img
                  src={latest.heroImageUrl}
                  alt=""
                  style={{
                    width: "100%",
                    display: "block",
                    aspectRatio: "16 / 9",
                    objectFit: "cover",
                  }}
                />
              )}
              <div style={{ padding: "26px 28px 30px" }}>
                {latest.sentAt && (
                  <p
                    style={{
                      fontSize: 13,
                      color: MUTED,
                      margin: 0,
                    }}
                  >
                    {formatIssueDate(latest.sentAt)}
                  </p>
                )}
                <h3
                  style={{
                    fontFamily: SERIF,
                    fontWeight: 500,
                    fontSize: "clamp(24px, 3.6vw, 34px)",
                    lineHeight: 1.16,
                    margin: "8px 0 0",
                  }}
                >
                  {latest.title}
                </h3>
                {latest.previewText && (
                  <p
                    style={{
                      fontSize: 16.5,
                      lineHeight: 1.65,
                      color: MUTED,
                      margin: "12px 0 0",
                    }}
                  >
                    {latest.previewText}
                  </p>
                )}
                <span
                  style={{
                    display: "inline-block",
                    marginTop: 18,
                    fontSize: 15,
                    fontWeight: 600,
                    color: accent,
                  }}
                >
                  Read issue →
                </span>
              </div>
            </Link>
          </section>
        )}

        {/* ── Archive ─────────────────────────────────────────────────────── */}
        {rest.length > 0 && (
          <section style={{ marginTop: 56 }}>
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
              Past issues
            </p>
            <div>
              {rest.map((i) => (
                <Link
                  key={i.id}
                  href={`/p/${pub.slug}/${i.id}`}
                  style={{
                    display: "flex",
                    gap: 18,
                    alignItems: "center",
                    padding: "18px 0",
                    borderTop: "1px solid rgba(10,10,15,0.1)",
                    textDecoration: "none",
                    color: INK,
                  }}
                  data-testid={`link-issue-${i.id}`}
                >
                  {i.heroImageUrl && (
                    <img
                      src={i.heroImageUrl}
                      alt=""
                      style={{
                        width: 96,
                        height: 64,
                        borderRadius: 10,
                        objectFit: "cover",
                        flexShrink: 0,
                      }}
                    />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {i.sentAt && (
                      <p
                        style={{
                          fontSize: 12,
                          letterSpacing: ".06em",
                          color: MUTED,
                          margin: 0,
                        }}
                      >
                        {formatIssueDate(i.sentAt)}
                      </p>
                    )}
                    <h4
                      style={{
                        fontFamily: SERIF,
                        fontWeight: 500,
                        fontSize: 20,
                        lineHeight: 1.25,
                        margin: "4px 0 0",
                      }}
                    >
                      {i.title}
                    </h4>
                    {i.previewText && (
                      <p
                        style={{
                          fontSize: 14.5,
                          lineHeight: 1.55,
                          color: MUTED,
                          margin: "4px 0 0",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          display: "-webkit-box",
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical",
                        }}
                      >
                        {i.previewText}
                      </p>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* ── Zero-issues note ────────────────────────────────────────────── */}
        {!hasIssues && (
          <section
            style={{
              marginTop: 56,
              padding: "28px 26px",
              borderRadius: 16,
              background: accentTintSoft,
              border: `1px solid ${accentBorder}`,
              textAlign: "center",
            }}
          >
            <p
              style={{
                fontFamily: SERIF,
                fontSize: 20,
                lineHeight: 1.5,
                color: INK,
                opacity: 0.82,
                margin: 0,
              }}
            >
              The first issue is on its way.
            </p>
            <p
              style={{
                fontSize: 15,
                lineHeight: 1.6,
                color: MUTED,
                margin: "8px 0 0",
              }}
            >
              Subscribe now and you'll be among the first to read it.
            </p>
          </section>
        )}

        {/* ── Closing subscribe band ──────────────────────────────────────── */}
        <section
          style={{
            marginTop: 56,
            padding: "30px 28px 32px",
            borderRadius: 18,
            background: accentTintStrong,
            border: `1px solid ${accentBorder}`,
          }}
        >
          <h3
            style={{
              fontFamily: SERIF,
              fontWeight: 500,
              fontSize: 24,
              margin: 0,
            }}
          >
            {steward ? `Read along with ${steward}` : `Subscribe to ${pub.name}`}
          </h3>
          <p
            style={{
              fontSize: 15.5,
              lineHeight: 1.6,
              color: INK,
              opacity: 0.78,
              margin: "8px 0 18px",
              maxWidth: 480,
            }}
          >
            Every new issue, free, in your inbox. We never share your email, and
            every issue has a one-click unsubscribe.
          </p>
          <NewsletterSubscribe
            slug={pub.slug}
            accent={accent}
            source="publication-page"
          />
        </section>

        {/* ── Publication description (footer, distinct from bio) ──────────── */}
        {pub.description && (
          <>
            <hr
              style={{
                border: "none",
                borderTop: "1px solid rgba(10,10,15,0.1)",
                margin: "52px 0 28px",
              }}
            />
            <p
              style={{
                color: MUTED,
                fontSize: 15,
                lineHeight: 1.7,
                whiteSpace: "pre-wrap",
              }}
            >
              {pub.description}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
