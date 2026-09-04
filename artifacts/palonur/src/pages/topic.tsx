/**
 * Public topic entry point — /t/:slug, one page per ACTIVE pillar.
 *
 * A full editorial landing page: hero with imagery, why-the-pillar-matters,
 * what's-at-risk, sub-topic entry points into the ask surface, the lead
 * steward block, a "Meet the stewards" section (fed by the public topics
 * list API), and an other-pillars grid. Sleep is special-cased: its consumer
 * surface is the existing /sleep experience, so CTAs point there. Unknown or
 * retired pillars 404 into the themed not-found page.
 *
 * Editorial copy + imagery are hand-curated per canonical pillar in
 * lib/pillar-editorial.ts; admin-created pillars degrade gracefully to the
 * DB description and skip the hand-curated sections.
 *
 * Steward identity shown here is an explicit product decision of the topic
 * pages (the /p page already exposes the same identity publicly) — unlike the
 * deliberately steward-free /faculty/public/pillars endpoint.
 */
import { useEffect, useState } from "react";
import { useParams } from "wouter";
import NotFound from "./not-found";
import { CONSUMER_PILLARS, useVisiblePillars } from "../lib/pillars";
import { pillarEditorialFor } from "../lib/pillar-editorial";
import { StewardAchievementsPanel } from "../components/steward-achievements";

const BASE = import.meta.env.BASE_URL;
const SANS =
  "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif";
const SERIF = "'Georgia','Times New Roman',serif";
const RED = "#B3261E";
const INK = "#0A0A0F";
const PAPER = "#FAF8F4";
const RULE = "rgba(10,10,15,0.12)";
const MUTED = "rgba(10,10,15,0.64)";

interface TopicSteward {
  fullName: string | null;
  institution: string | null;
  photoUrl: string | null;
  achievements?: string[];
  publicationSlug: string | null;
  publicationName: string | null;
}

interface Topic {
  slug: string;
  name: string;
  description: string | null;
  steward: TopicSteward | null;
}

const italic = (s: string) => (
  <em style={{ fontStyle: "italic", fontFamily: SERIF }}>{s}</em>
);

const kicker: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: ".24em",
  textTransform: "uppercase",
  color: RED,
  marginBottom: 16,
};

const sectionPad = "clamp(48px, 7vh, 80px) clamp(24px, 6vw, 96px)";

const bodyPara: React.CSSProperties = {
  margin: "0 0 18px",
  fontFamily: SERIF,
  fontSize: "clamp(16.5px, 1.4vw, 18.5px)",
  lineHeight: 1.65,
  color: "rgba(10,10,15,0.75)",
};

const h2Style: React.CSSProperties = {
  margin: "0 0 20px",
  fontFamily: SERIF,
  fontWeight: 500,
  fontSize: "clamp(26px, 3.4vw, 38px)",
  lineHeight: 1.12,
  letterSpacing: "-0.015em",
  color: INK,
};

const initialsOf = (name: string | null | undefined): string =>
  (name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("") || "?";

/**
 * Editorial pillar Heads / Co-Heads, transcribed from Stanford Lifestyle
 * Medicine's public team page (lifestylemedicine.stanford.edu/lifestyle-team).
 * Display-only fallback for the "Meet the stewards" grid: a pillar whose
 * platform steward has onboarded (API steward present) always wins — this
 * fills the gap for announced Heads who haven't joined the platform yet.
 * Same editorial-constant precedent as the faculty landing page.
 */
const LM_PILLAR_HEADS: Record<string, string[]> = {
  movement: ["Anne Friedlander"],
  nutrition: ["Marily Oppezzo"],
  sleep: ["Cheri Mah", "Jamie Zeitzer"],
  "stress-management": ["Sarah Meyer Tapia"],
  "social-connection": ["Steven Crane"],
  "cognitive-enhancement": ["Shaliza Shorey"],
  "gratitude-purpose": ["Bruce Feldstein", "Barbara Waxman"],
};

/** Stanford Lifestyle Medicine program leadership (editorial, same source). */
const LM_LEADERSHIP: { name: string; title: string }[] = [
  { name: "Michael Fredericson", title: "Director" },
  { name: "Anne Friedlander", title: "Co-Director" },
];

export default function TopicPage() {
  const params = useParams();
  const slug = String(params.slug ?? "");
  const [topic, setTopic] = useState<Topic | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing">(
    "loading",
  );
  // All topics (for the "Meet the stewards" section); loads independently
  // and the section simply doesn't render until it arrives.
  const [allTopics, setAllTopics] = useState<Topic[] | null>(null);
  // Retired pillars auto-hide from the other-pillars grid.
  const visiblePillars = useVisiblePillars();
  // Achievements panel opened by clicking the steward's photo.
  const [stewardPanelOpen, setStewardPanelOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    fetch(`/api/topics/${encodeURIComponent(slug)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ topic: Topic }>;
      })
      .then((d) => {
        if (cancelled) return;
        setTopic(d.topic);
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("missing");
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/topics")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ topics: Topic[] }>;
      })
      .then((d) => {
        if (cancelled || !Array.isArray(d.topics)) return;
        // The "Meet the stewards" section introduces the Stanford Lifestyle
        // Medicine program specifically, so it shows only the canonical
        // pillars (in editorial order) — never test/admin-created ones.
        const order = new Map(CONSUMER_PILLARS.map((p, i) => [p.slug, i]));
        setAllTopics(
          d.topics
            .filter((t) => order.has(t.slug))
            .sort((a, b) => (order.get(a.slug) ?? 0) - (order.get(b.slug) ?? 0)),
        );
      })
      .catch(() => {
        /* section simply omitted */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    document.body.style.background = PAPER;
    const prevTitle = document.title;
    if (topic) document.title = `${topic.name} — Palonur`;
    return () => {
      document.body.style.background = "";
      document.title = prevTitle;
    };
  }, [topic]);

  if (state === "missing") return <NotFound />;

  if (state === "loading" || !topic) {
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

  // Hand-curated editorial for the seven canonical pillars; admin-created
  // pillars fall back to the DB description and skip curated sections.
  const consumer = CONSUMER_PILLARS.find((p) => p.slug === topic.slug);
  const editorial = pillarEditorialFor(topic.slug);
  const blurb = consumer?.description ?? topic.description ?? null;
  const isSleep = topic.slug === "sleep";
  const steward = topic.steward;
  const pubHref = steward?.publicationSlug
    ? `${BASE}p/${steward.publicationSlug}`
    : null;
  // Primary CTA: sleep keeps its existing consumer surface; every other
  // topic funnels to the steward's publication page and its Q&A.
  const primaryHref = isSleep ? `${BASE}sleep` : pubHref;
  const primaryLabel = isSleep
    ? "Ask a sleep question →"
    : steward?.fullName
      ? `Ask ${steward.fullName.split(/\s+/)[0]} a question →`
      : null;
  // Sub-topic cards funnel into the same ask surface. Sleep can pre-fill the
  // question; other pillars land on the steward's /p page; no steward → the
  // card renders without a link.
  const subTopicHref = (question: string): string | null => {
    if (isSleep) return `${BASE}sleep?q=${encodeURIComponent(question)}`;
    return pubHref;
  };

  const otherPillars = visiblePillars.filter((p) => p.slug !== topic.slug);
  const ctaButton: React.CSSProperties = {
    display: "inline-block",
    background: RED,
    color: "#fff",
    padding: "16px 30px",
    borderRadius: 999,
    fontFamily: SANS,
    fontSize: 14,
    fontWeight: 700,
    letterSpacing: "0.02em",
    textDecoration: "none",
  };

  return (
    <main
      style={{
        background: PAPER,
        color: INK,
        fontFamily: SANS,
        minHeight: "100vh",
      }}
    >
      {/* ─── Hero ─────────────────────────────────────────────────────── */}
      <div
        style={{
          padding:
            "clamp(72px, 12vh, 130px) clamp(24px, 6vw, 96px) clamp(48px, 7vh, 80px)",
          borderBottom: `1px solid ${RULE}`,
        }}
      >
        <div style={{ width: "100%", maxWidth: 1040, margin: "0 auto" }}>
          <div
            style={{
              display: "flex",
              gap: "clamp(28px, 5vw, 64px)",
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <div style={{ flex: "1 1 460px", minWidth: 0 }}>
              <div style={{ ...kicker, marginBottom: 28 }}>
                Science, signed · A pillar of lifestyle medicine
              </div>
              {consumer?.art && (
                <img
                  src={consumer.art}
                  alt=""
                  aria-hidden
                  style={{
                    width: 84,
                    height: 84,
                    objectFit: "contain",
                    marginBottom: 18,
                    display: "block",
                  }}
                />
              )}
              <h1
                style={{
                  margin: "0 0 18px",
                  fontFamily: SERIF,
                  fontWeight: 500,
                  fontSize: "clamp(34px, 5vw, 58px)",
                  lineHeight: 1.06,
                  letterSpacing: "-0.018em",
                  color: INK,
                  maxWidth: 780,
                }}
                data-testid="topic-title"
              >
                {topic.name}
              </h1>
              {editorial?.dek && (
                <p
                  style={{
                    margin: "0 0 16px",
                    maxWidth: 560,
                    fontFamily: SERIF,
                    fontStyle: "italic",
                    fontSize: "clamp(18px, 1.7vw, 21px)",
                    lineHeight: 1.5,
                    color: "rgba(10,10,15,0.82)",
                  }}
                >
                  {editorial.dek}
                </p>
              )}
              <p
                style={{
                  margin: "0 0 18px",
                  maxWidth: 620,
                  fontFamily: SERIF,
                  fontStyle: "italic",
                  fontSize: "clamp(16px, 1.4vw, 18px)",
                  lineHeight: 1.6,
                  color: "rgba(10,10,15,0.72)",
                }}
              >
                Stop searching. Ask the scientist: one answer written from a
                named researcher's own published work, with a citation you can
                check or show your doctor, and an honest "the research doesn't
                cover that yet" when it doesn't.
              </p>
              {blurb && (
                <p
                  style={{
                    margin: "0 0 28px",
                    maxWidth: 620,
                    fontFamily: SERIF,
                    fontSize: "clamp(16px, 1.4vw, 18px)",
                    lineHeight: 1.6,
                    color: "rgba(10,10,15,0.68)",
                  }}
                >
                  {blurb}
                </p>
              )}
              {primaryHref && primaryLabel && (
                <a
                  href={primaryHref}
                  data-testid="topic-primary-cta"
                  style={ctaButton}
                >
                  {primaryLabel}
                </a>
              )}
            </div>
            {editorial?.heroArt && (
              <div style={{ flex: "1 1 340px", minWidth: 280 }}>
                <img
                  src={editorial.heroArt}
                  alt=""
                  aria-hidden
                  data-testid="topic-hero-art"
                  style={{
                    width: "100%",
                    display: "block",
                    borderRadius: 14,
                    border: `1px solid ${RULE}`,
                    boxShadow: "0 18px 50px rgba(10,10,15,0.10)",
                  }}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ─── Why this matters ─────────────────────────────────────────── */}
      {editorial && editorial.whyItMatters.length > 0 && (
        <div
          style={{ padding: sectionPad, borderBottom: `1px solid ${RULE}` }}
          data-testid="topic-why-matters"
        >
          <div style={{ width: "100%", maxWidth: 900, margin: "0 auto" }}>
            <div style={kicker}>Why this matters</div>
            <h2 style={h2Style}>The health case, as the research tells it</h2>
            <div
              style={{
                display: "flex",
                gap: "clamp(24px, 4vw, 48px)",
                alignItems: "flex-start",
                flexWrap: "wrap",
              }}
            >
              <div style={{ flex: "1 1 420px", minWidth: 280, maxWidth: 680 }}>
                {editorial.whyItMatters.map((p, i) => (
                  <p key={i} style={bodyPara}>
                    {p}
                  </p>
                ))}
              </div>
              <img
                src={editorial.whyArt}
                alt=""
                aria-hidden
                data-testid="topic-why-art"
                style={{
                  flex: "1 1 260px",
                  minWidth: 240,
                  maxWidth: 340,
                  width: "100%",
                  borderRadius: 14,
                  border: `1px solid ${RULE}`,
                  boxShadow: "0 14px 40px rgba(10,10,15,0.08)",
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* ─── What's at risk ───────────────────────────────────────────── */}
      {editorial && editorial.atRisk.length > 0 && (
        <div
          style={{
            padding: sectionPad,
            borderBottom: `1px solid ${RULE}`,
            background: "rgba(10,10,15,0.025)",
          }}
          data-testid="topic-at-risk"
        >
          <div style={{ width: "100%", maxWidth: 900, margin: "0 auto" }}>
            <div style={kicker}>What's at risk</div>
            <h2 style={h2Style}>What the literature documents about neglect</h2>
            <div
              style={{
                display: "flex",
                gap: "clamp(24px, 4vw, 48px)",
                alignItems: "flex-start",
                flexWrap: "wrap-reverse",
              }}
            >
              <img
                src={editorial.riskArt}
                alt=""
                aria-hidden
                data-testid="topic-risk-art"
                style={{
                  flex: "1 1 260px",
                  minWidth: 240,
                  maxWidth: 340,
                  width: "100%",
                  borderRadius: 14,
                  border: `1px solid ${RULE}`,
                  boxShadow: "0 14px 40px rgba(10,10,15,0.08)",
                }}
              />
              <div style={{ flex: "1 1 420px", minWidth: 280, maxWidth: 680 }}>
                {editorial.atRisk.map((p, i) => (
                  <p key={i} style={bodyPara}>
                    {p}
                  </p>
                ))}
                <p
                  style={{
                    ...bodyPara,
                    fontSize: 13.5,
                    fontFamily: SANS,
                    color: MUTED,
                    marginBottom: 0,
                  }}
                >
                  Nothing here is medical advice — it's a summary of what
                  published research has documented, and every answer on this
                  topic carries its citation.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── Sub-topic entry points ───────────────────────────────────── */}
      {editorial && editorial.subTopics.length > 0 && (
        <div
          style={{ padding: sectionPad, borderBottom: `1px solid ${RULE}` }}
          data-testid="topic-subtopics"
        >
          <div style={{ width: "100%", maxWidth: 900, margin: "0 auto" }}>
            <div style={kicker}>Start with a question</div>
            <h2 style={h2Style}>Inside {topic.name.toLowerCase()}</h2>
            <img
              src={editorial.askArt}
              alt=""
              aria-hidden
              data-testid="topic-ask-art"
              style={{
                width: "100%",
                maxHeight: 300,
                objectFit: "cover",
                display: "block",
                borderRadius: 14,
                border: `1px solid ${RULE}`,
                boxShadow: "0 14px 40px rgba(10,10,15,0.08)",
                marginTop: 8,
              }}
            />
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
                gap: 16,
                marginTop: 28,
              }}
            >
              {editorial.subTopics.map((t) => {
                const href = subTopicHref(t.question);
                const card = (
                  <div
                    style={{
                      border: `1px solid ${RULE}`,
                      borderRadius: 14,
                      padding: "22px 24px",
                      background: "#fff",
                      height: "100%",
                      boxSizing: "border-box",
                    }}
                  >
                    <div
                      style={{
                        fontFamily: SANS,
                        fontSize: 12,
                        fontWeight: 700,
                        letterSpacing: ".08em",
                        textTransform: "uppercase",
                        color: RED,
                        marginBottom: 10,
                      }}
                    >
                      {t.label}
                    </div>
                    <div
                      style={{
                        fontFamily: SERIF,
                        fontSize: 16.5,
                        lineHeight: 1.5,
                        color: "rgba(10,10,15,0.8)",
                      }}
                    >
                      {t.question}
                    </div>
                    <div
                      style={{
                        marginTop: 14,
                        fontFamily: SANS,
                        fontSize: 13,
                        fontWeight: 700,
                        color: href ? RED : MUTED,
                      }}
                    >
                      {href ? "Ask this →" : "Steward coming soon"}
                    </div>
                  </div>
                );
                return href ? (
                  <a
                    key={t.label}
                    href={href}
                    data-testid={`topic-subtopic-${t.label}`}
                    style={{ textDecoration: "none", display: "block" }}
                  >
                    {card}
                  </a>
                ) : (
                  <div key={t.label} data-testid={`topic-subtopic-${t.label}`}>
                    {card}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Steward achievements panel — opened by clicking the photo */}
      {stewardPanelOpen && steward && (
        <StewardAchievementsPanel
          steward={{
            fullName: steward.fullName,
            institution: steward.institution,
            photoUrl: steward.photoUrl,
            achievements: steward.achievements ?? [],
          }}
          onClose={() => setStewardPanelOpen(false)}
        />
      )}

      {/* ─── The steward ──────────────────────────────────────────────── */}
      <div
        style={{
          padding: sectionPad,
          borderBottom: `1px solid ${RULE}`,
        }}
      >
        <div style={{ width: "100%", maxWidth: 900, margin: "0 auto" }}>
          {steward?.fullName ? (
            <div
              style={{
                display: "flex",
                gap: 24,
                alignItems: "flex-start",
                flexWrap: "wrap",
              }}
              data-testid="topic-steward"
            >
              {steward.photoUrl && (
                <button
                  type="button"
                  onClick={() => setStewardPanelOpen(true)}
                  data-testid="button-steward-avatar-topic"
                  title={`About ${steward.fullName}`}
                  aria-label={`About ${steward.fullName}`}
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                >
                  <img
                    src={steward.photoUrl}
                    alt={steward.fullName}
                    style={{
                      width: 96,
                      height: 96,
                      borderRadius: "50%",
                      objectFit: "cover",
                      border: `1px solid ${RULE}`,
                      display: "block",
                    }}
                  />
                </button>
              )}
              <div style={{ flex: "1 1 320px", minWidth: 0 }}>
                <div style={{ ...kicker, marginBottom: 12 }}>
                  Who stands behind the answers
                </div>
                <h2
                  style={{
                    margin: "0 0 8px",
                    fontFamily: SERIF,
                    fontWeight: 500,
                    fontSize: "clamp(24px, 3vw, 34px)",
                    color: INK,
                  }}
                >
                  {steward.fullName}
                </h2>
                {steward.institution && (
                  <p
                    style={{
                      margin: "0 0 16px",
                      fontFamily: SANS,
                      fontSize: 14,
                      color: MUTED,
                    }}
                  >
                    {steward.institution}
                  </p>
                )}
                <p
                  style={{
                    margin: "0 0 20px",
                    maxWidth: 560,
                    fontFamily: SERIF,
                    fontSize: 16.5,
                    lineHeight: 1.6,
                    color: "rgba(10,10,15,0.72)",
                  }}
                >
                  Every answer on this topic is grounded in the published,
                  approved research this steward stands behind — with a
                  citation you can check, {italic("never")} a feed or an
                  influencer.
                </p>
                {pubHref && (
                  <a
                    href={pubHref}
                    data-testid="topic-publication-link"
                    style={{
                      fontFamily: SANS,
                      fontSize: 14,
                      fontWeight: 700,
                      color: RED,
                      textDecoration: "none",
                    }}
                  >
                    {steward.publicationName
                      ? `Read ${steward.publicationName} →`
                      : "Visit the publication →"}
                  </a>
                )}
              </div>
            </div>
          ) : (
            <div style={{ maxWidth: 620 }}>
              <div style={{ ...kicker, marginBottom: 12 }}>Coming soon</div>
              <p
                style={{
                  margin: 0,
                  fontFamily: SERIF,
                  fontSize: 17,
                  lineHeight: 1.6,
                  color: "rgba(10,10,15,0.72)",
                }}
              >
                A named faculty steward for this pillar is on the way. The
                Palonur newsletter announces each pillar as it opens.
              </p>
              <a
                href={`${BASE}newsletter`}
                style={{
                  display: "inline-block",
                  marginTop: 20,
                  fontFamily: SANS,
                  fontSize: 14,
                  fontWeight: 700,
                  color: RED,
                  textDecoration: "none",
                }}
              >
                Join the newsletter →
              </a>
            </div>
          )}
        </div>
      </div>

      {/* ─── Meet the stewards ────────────────────────────────────────── */}
      {allTopics && allTopics.length > 0 && (
        <div
          style={{ padding: sectionPad, borderBottom: `1px solid ${RULE}` }}
          data-testid="topic-meet-stewards"
        >
          <div style={{ width: "100%", maxWidth: 900, margin: "0 auto" }}>
            <div style={kicker}>Meet the stewards</div>
            <h2 style={h2Style}>Stanford Lifestyle Medicine, by name</h2>
            <p style={{ ...bodyPara, maxWidth: 680 }}>
              Each pillar of lifestyle medicine is stewarded by a named
              Stanford Lifestyle Medicine faculty member who puts their own
              published research — and their name — behind every answer.
            </p>
            <div
              data-testid="topic-lm-leadership"
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "12px 36px",
                alignItems: "center",
                marginTop: 24,
                padding: "18px 22px",
                border: `1px solid ${RULE}`,
                borderRadius: 14,
                background: "#fff",
              }}
            >
              <div
                style={{
                  fontFamily: SANS,
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: ".18em",
                  textTransform: "uppercase",
                  color: MUTED,
                }}
              >
                Program leadership
              </div>
              {LM_LEADERSHIP.map((p) => (
                <div
                  key={p.name}
                  style={{ display: "flex", alignItems: "center", gap: 12 }}
                >
                  <div
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: "50%",
                      background: "linear-gradient(135deg, #8B1A1A, #5e0f0f)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "#fff",
                      fontSize: 15,
                      fontWeight: 600,
                      fontFamily: SERIF,
                      flexShrink: 0,
                    }}
                    aria-hidden
                  >
                    {initialsOf(p.name)}
                  </div>
                  <div>
                    <div
                      style={{
                        fontFamily: SERIF,
                        fontSize: 16,
                        fontWeight: 500,
                        color: INK,
                        lineHeight: 1.25,
                      }}
                    >
                      {p.name}
                    </div>
                    <div
                      style={{
                        fontFamily: SANS,
                        fontSize: 12,
                        color: MUTED,
                      }}
                    >
                      {p.title}, Stanford Lifestyle Medicine
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                gap: 16,
                marginTop: 28,
              }}
            >
              {allTopics.map((t) => {
                const s = t.steward;
                const editorialNames = LM_PILLAR_HEADS[t.slug];
                const displayName =
                  s?.fullName ?? editorialNames?.join(" & ") ?? null;
                return (
                  <a
                    key={t.slug}
                    href={`${BASE}t/${t.slug}`}
                    data-testid={`topic-steward-card-${t.slug}`}
                    style={{
                      textDecoration: "none",
                      border: `1px solid ${RULE}`,
                      borderRadius: 14,
                      padding: "22px 22px 20px",
                      background: t.slug === topic.slug ? "rgba(10,10,15,0.03)" : "#fff",
                      display: "block",
                    }}
                  >
                    {s?.photoUrl ? (
                      <img
                        src={s.photoUrl}
                        alt={s.fullName ?? ""}
                        style={{
                          width: 64,
                          height: 64,
                          borderRadius: "50%",
                          objectFit: "cover",
                          border: `1px solid ${RULE}`,
                          display: "block",
                          marginBottom: 14,
                        }}
                      />
                    ) : (
                      <div
                        style={{
                          width: 64,
                          height: 64,
                          borderRadius: "50%",
                          background: displayName
                            ? "linear-gradient(135deg, #8B1A1A, #5e0f0f)"
                            : "rgba(10,10,15,0.06)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: displayName ? "#fff" : MUTED,
                          fontSize: 22,
                          fontWeight: 600,
                          fontFamily: SERIF,
                          marginBottom: 14,
                        }}
                        aria-hidden
                      >
                        {displayName ? initialsOf(displayName) : "?"}
                      </div>
                    )}
                    <div
                      style={{
                        fontFamily: SERIF,
                        fontSize: 17,
                        fontWeight: 500,
                        color: INK,
                        marginBottom: 4,
                      }}
                    >
                      {displayName ?? "Steward coming soon"}
                    </div>
                    {(s?.institution || (!s && editorialNames)) && (
                      <div
                        style={{
                          fontFamily: SANS,
                          fontSize: 12.5,
                          color: MUTED,
                          marginBottom: 8,
                        }}
                      >
                        {s?.institution ?? "Stanford Lifestyle Medicine"}
                      </div>
                    )}
                    <div
                      style={{
                        fontFamily: SANS,
                        fontSize: 12,
                        fontWeight: 700,
                        letterSpacing: ".08em",
                        textTransform: "uppercase",
                        color: RED,
                      }}
                    >
                      {t.name}
                    </div>
                  </a>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ─── Explore the other pillars ────────────────────────────────── */}
      {otherPillars.length > 0 && (
        <div
          style={{ padding: sectionPad, borderBottom: `1px solid ${RULE}` }}
          data-testid="topic-other-pillars"
        >
          <div style={{ width: "100%", maxWidth: 900, margin: "0 auto" }}>
            <div style={kicker}>Keep exploring</div>
            <h2 style={h2Style}>The other pillars</h2>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
                gap: 16,
                marginTop: 28,
              }}
            >
              {otherPillars.map((p) => (
                <a
                  key={p.slug}
                  href={`${BASE}t/${p.slug}`}
                  data-testid={`topic-other-pillar-${p.slug}`}
                  style={{
                    textDecoration: "none",
                    border: `1px solid ${RULE}`,
                    borderRadius: 14,
                    padding: "24px 22px",
                    background: "#fff",
                    display: "block",
                    textAlign: "center",
                  }}
                >
                  <img
                    src={p.art}
                    alt=""
                    aria-hidden
                    style={{
                      width: 72,
                      height: 72,
                      objectFit: "contain",
                      display: "block",
                      margin: "0 auto 14px",
                    }}
                  />
                  <div
                    style={{
                      fontFamily: SERIF,
                      fontSize: 17,
                      fontWeight: 500,
                      color: INK,
                    }}
                  >
                    {p.name}
                  </div>
                  <div
                    style={{
                      marginTop: 8,
                      fontFamily: SANS,
                      fontSize: 12.5,
                      fontWeight: 700,
                      color: RED,
                    }}
                  >
                    Explore →
                  </div>
                </a>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ─── Footer ───────────────────────────────────────────────────── */}
      <footer
        style={{
          padding: "32px clamp(24px, 6vw, 96px) 28px",
          borderTop: `1px solid ${RULE}`,
          fontSize: 13,
          color: MUTED,
          display: "flex",
          flexWrap: "wrap",
          gap: 18,
          alignItems: "center",
          justifyContent: "space-between",
          letterSpacing: "0.02em",
        }}
      >
        <span>© Palonur</span>
        <a
          href={`${BASE}pillars`}
          style={{
            color: INK,
            textDecoration: "none",
            fontWeight: 600,
            letterSpacing: "0.04em",
          }}
        >
          ← All the pillars
        </a>
      </footer>
    </main>
  );
}
