/**
 * Public stewards directory — /stewards.
 *
 * One page with every steward behind Palonur: the lead steward of each
 * canonical Stanford Lifestyle Medicine pillar (from the public /api/topics
 * API, same identity-bearing source the topic pages use), editorial
 * pillar-head fallbacks for announced Heads who haven't onboarded yet, and
 * the AI Lab steward. Linked from the landing page footer and the home
 * steward spotlight.
 *
 * Steward identity here is the same explicit product decision as /t/:slug —
 * never source this from the deliberately steward-free
 * /api/faculty/public/pillars endpoint.
 */
import { useEffect, useState } from "react";
import { CONSUMER_PILLARS } from "../lib/pillars";
import { stewardPortraitUrl, STEWARD_SPOTLIGHT } from "../lib/stewards";
import { SiteFooter } from "../components/site-footer";

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

/**
 * Editorial pillar Heads (Stanford LM public team page) — display-only
 * fallback when a pillar's platform steward hasn't onboarded yet. Same
 * constants and precedent as /t/:slug's "Meet the stewards" grid.
 */
const LM_PILLAR_HEADS: Record<string, string[]> = {
  movement: ["Michael Fredericson", "Anne Friedlander"],
  nutrition: ["Marily Oppezzo"],
  sleep: ["Cheri Mah", "Jamie Zeitzer"],
  "stress-management": ["Sarah Meyer Tapia"],
  "social-connection": ["Steven Crane"],
  "cognitive-enhancement": ["Shaliza Shorey"],
  "gratitude-purpose": ["Bruce Feldstein", "Barbara Waxman"],
};

const initialsOf = (name: string | null | undefined): string =>
  (name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("") || "?";

export default function StewardsPage() {
  const [topics, setTopics] = useState<Topic[] | null>(null);

  useEffect(() => {
    document.body.style.background = PAPER;
    const prevTitle = document.title;
    document.title = "The Stewards — Palonur";
    return () => {
      document.body.style.background = "";
      document.title = prevTitle;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/topics")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ topics: Topic[] }>;
      })
      .then((d) => {
        if (cancelled || !Array.isArray(d.topics)) return;
        const order = new Map(CONSUMER_PILLARS.map((p, i) => [p.slug, i]));
        setTopics(
          d.topics
            .filter((t) => order.has(t.slug))
            .sort(
              (a, b) => (order.get(a.slug) ?? 0) - (order.get(b.slug) ?? 0),
            ),
        );
      })
      .catch(() => {
        if (!cancelled) setTopics([]); // editorial fallbacks still render
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Per canonical pillar: the onboarded platform steward (if named) plus any
  // editorial pillar Heads who aren't that same person — co-heads like
  // Fredericson & Friedlander both appear even when one has onboarded.
  const cards = CONSUMER_PILLARS.map((p) => {
    const topic = topics?.find((t) => t.slug === p.slug) ?? null;
    // A platform steward is only usable with a real name; otherwise fall
    // back to the editorial pillar Heads (a blank card would defeat the page).
    const raw = topic?.steward ?? null;
    const s = raw && (raw.fullName ?? "").trim() ? raw : null;
    const stewardLower = (s?.fullName ?? "").toLowerCase();
    const editorialNames = (LM_PILLAR_HEADS[p.slug] ?? []).filter((n) => {
      if (!s) return true;
      const surname = n.trim().split(/\s+/).pop()?.toLowerCase() ?? "";
      return surname ? !stewardLower.includes(surname) : true;
    });
    return {
      slug: p.slug,
      pillarName: topic?.name ?? p.name,
      steward: s,
      editorialNames,
    };
  });

  /** Spotlight entry for an editorial name (title/blurb reuse), if curated. */
  const spotlightFor = (name: string | null) => {
    if (!name) return null;
    const lower = name.toLowerCase();
    return (
      STEWARD_SPOTLIGHT.find((sp) =>
        lower.includes(sp.surname.toLowerCase()),
      ) ?? null
    );
  };

  return (
    <div style={{ minHeight: "100dvh", background: PAPER, color: INK }}>
      <div
        style={{
          maxWidth: 880,
          margin: "0 auto",
          padding: "72px clamp(24px, 6vw, 48px) 40px",
        }}
      >
        <a
          href={BASE}
          style={{
            fontFamily: SANS,
            fontSize: 13,
            fontWeight: 600,
            color: MUTED,
            textDecoration: "none",
          }}
        >
          ← Palonur
        </a>

        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: ".24em",
            textTransform: "uppercase",
            color: RED,
            margin: "36px 0 16px",
            fontFamily: SANS,
          }}
        >
          The people behind the answers
        </div>
        <h1
          style={{
            margin: "0 0 18px",
            fontFamily: SERIF,
            fontWeight: 500,
            fontSize: "clamp(32px, 4.4vw, 48px)",
            lineHeight: 1.1,
            letterSpacing: "-0.015em",
          }}
        >
          The Stewards
        </h1>
        <p
          style={{
            margin: "0 0 8px",
            fontFamily: SERIF,
            maxWidth: 640,
            fontSize: "clamp(16.5px, 1.4vw, 18.5px)",
            lineHeight: 1.65,
            color: "rgba(10,10,15,0.75)",
          }}
        >
          Every pillar on Palonur has a steward — a named expert who selects the
          research behind it and stands behind every answer with their name.
          These are the people whose judgment you are asking when you ask
          Palonur.
        </p>
      </div>

      <div
        style={{
          maxWidth: 880,
          margin: "0 auto",
          padding: "0 clamp(24px, 6vw, 48px) 72px",
        }}
      >
        {cards.map(({ slug, pillarName, steward, editorialNames }) => {
          const people = [
            ...(steward
              ? [{ name: steward.fullName, isPlatform: true as const }]
              : []),
            ...editorialNames.map((n) => ({
              name: n as string | null,
              isPlatform: false as const,
            })),
          ];
          if (people.length === 0) return null;
          return people.map(({ name, isPlatform }, idx) => {
            const photo =
              (isPlatform && steward?.photoUrl) ||
              stewardPortraitUrl(name) ||
              null;
            const spotlight = isPlatform ? null : spotlightFor(name);
            return (
              <div
                key={`${slug}-${idx}`}
                data-testid={`card-steward-${slug}-${idx}`}
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "22px 30px",
                  alignItems: "flex-start",
                  padding: "32px 0",
                  borderTop: `1px solid ${RULE}`,
                }}
              >
                {photo ? (
                  <img
                    src={photo}
                    alt={name ?? pillarName}
                    loading="lazy"
                    style={{
                      width: 110,
                      height: 110,
                      borderRadius: "50%",
                      objectFit: "cover",
                      border: `1px solid ${RULE}`,
                      display: "block",
                      flexShrink: 0,
                    }}
                  />
                ) : (
                  <div
                    aria-hidden
                    style={{
                      width: 110,
                      height: 110,
                      borderRadius: "50%",
                      border: `1px solid ${RULE}`,
                      background: "rgba(232,53,42,0.08)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontFamily: SERIF,
                      fontSize: 32,
                      fontWeight: 600,
                      color: "rgba(10,10,15,0.6)",
                      flexShrink: 0,
                    }}
                  >
                    {initialsOf(name)}
                  </div>
                )}
                <div style={{ flex: 1, minWidth: 260 }}>
                  <div
                    style={{
                      fontFamily: SANS,
                      fontSize: 12,
                      fontWeight: 700,
                      letterSpacing: ".14em",
                      textTransform: "uppercase",
                      color: RED,
                      marginBottom: 8,
                    }}
                  >
                    {pillarName}
                  </div>
                  <div
                    style={{
                      fontFamily: SERIF,
                      fontSize: "clamp(22px, 2vw, 27px)",
                      fontWeight: 600,
                      lineHeight: 1.2,
                      marginBottom: 6,
                    }}
                  >
                    {name}
                  </div>
                  {!isPlatform && spotlight?.title && (
                    <div
                      style={{
                        fontFamily: SANS,
                        fontSize: 13.5,
                        color: MUTED,
                        lineHeight: 1.5,
                        marginBottom: 10,
                      }}
                    >
                      {spotlight.title}
                    </div>
                  )}
                  {!isPlatform && spotlight?.blurb && (
                    <p
                      style={{
                        margin: "0 0 14px",
                        fontFamily: SERIF,
                        fontSize: 15.5,
                        lineHeight: 1.6,
                        color: "rgba(10,10,15,0.7)",
                        maxWidth: 620,
                      }}
                    >
                      {spotlight.blurb}
                    </p>
                  )}
                  {isPlatform && steward?.institution && (
                    <div
                      style={{
                        fontFamily: SANS,
                        fontSize: 13.5,
                        color: MUTED,
                        lineHeight: 1.5,
                        marginBottom: 10,
                      }}
                    >
                      {steward.institution}
                    </div>
                  )}
                  {isPlatform && (steward?.achievements?.length ?? 0) > 0 && (
                    <p
                      style={{
                        margin: "0 0 14px",
                        fontFamily: SERIF,
                        fontSize: 15.5,
                        lineHeight: 1.6,
                        color: "rgba(10,10,15,0.7)",
                        maxWidth: 620,
                      }}
                    >
                      {steward!.achievements!.slice(0, 3).join(" · ")}
                    </p>
                  )}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 18 }}>
                    <a
                      href={`${BASE}t/${slug}`}
                      style={{
                        fontFamily: SANS,
                        fontSize: 13,
                        fontWeight: 700,
                        letterSpacing: ".03em",
                        color: INK,
                        textDecoration: "none",
                        borderBottom: `2px solid ${RED}`,
                        paddingBottom: 2,
                      }}
                    >
                      Explore {pillarName}
                    </a>
                    {isPlatform && steward?.publicationSlug && (
                      <a
                        href={`${BASE}p/${steward.publicationSlug}`}
                        style={{
                          fontFamily: SANS,
                          fontSize: 13,
                          fontWeight: 600,
                          color: MUTED,
                          textDecoration: "none",
                          borderBottom: `1px solid ${RULE}`,
                          paddingBottom: 2,
                        }}
                      >
                        {steward.publicationName ?? "Read their newsletter"}
                      </a>
                    )}
                  </div>
                </div>
              </div>
            );
          });
        })}

        {/* AI Lab steward — the pillar that spans the others */}
        <div
          data-testid="card-steward-ai-lab"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "22px 30px",
            alignItems: "flex-start",
            padding: "32px 0",
            borderTop: `1px solid ${RULE}`,
            borderBottom: `1px solid ${RULE}`,
          }}
        >
          <div
            aria-hidden
            style={{
              width: 110,
              height: 110,
              borderRadius: "50%",
              border: `1px solid ${RULE}`,
              background: "rgba(232,53,42,0.08)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: SERIF,
              fontSize: 32,
              fontWeight: 600,
              color: "rgba(10,10,15,0.6)",
              flexShrink: 0,
            }}
          >
            KD
          </div>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div
              style={{
                fontFamily: SANS,
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: ".14em",
                textTransform: "uppercase",
                color: RED,
                marginBottom: 8,
              }}
            >
              AI Lab
            </div>
            <div
              style={{
                fontFamily: SERIF,
                fontSize: "clamp(22px, 2vw, 27px)",
                fontWeight: 600,
                lineHeight: 1.2,
                marginBottom: 6,
              }}
            >
              Karan Dehghani
            </div>
            <div
              style={{
                fontFamily: SANS,
                fontSize: 13.5,
                color: MUTED,
                lineHeight: 1.5,
                marginBottom: 10,
              }}
            >
              Founder of Palonur · Ambassador @ Stanford Graduate School of
              Business · Advisory Board Member, Stanford Lifestyle Medicine
              Group
            </div>
            <p
              style={{
                margin: "0 0 14px",
                fontFamily: SERIF,
                fontSize: 15.5,
                lineHeight: 1.6,
                color: "rgba(10,10,15,0.7)",
                maxWidth: 620,
              }}
            >
              GSB Fellow, HBS Foundry Fellow, and part of the inaugural{" "}
              <em>AI Native</em> MasterClass at the University of Chicago. AI
              advisor to global NGOs. Stewards the pillar on working, learning,
              and deciding in an age of artificial intelligence.
            </p>
            <a
              href={`${BASE}ai-lab`}
              style={{
                fontFamily: SANS,
                fontSize: 13,
                fontWeight: 700,
                letterSpacing: ".03em",
                color: INK,
                textDecoration: "none",
                borderBottom: `2px solid ${RED}`,
                paddingBottom: 2,
              }}
            >
              Explore the AI Lab
            </a>
          </div>
        </div>

        {/* In preparation — announced stewards whose pillars aren't live yet */}
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: ".24em",
            textTransform: "uppercase",
            color: RED,
            margin: "56px 0 4px",
            fontFamily: SANS,
          }}
        >
          In preparation
        </div>
        <div
          data-testid="card-steward-parker"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "22px 30px",
            alignItems: "flex-start",
            padding: "32px 0",
            borderTop: `1px solid ${RULE}`,
            borderBottom: `1px solid ${RULE}`,
          }}
        >
          <img
            src={`${BASE}stewards/parker.jpg`}
            alt="Karen Parker"
            loading="lazy"
            style={{
              width: 110,
              height: 110,
              borderRadius: "50%",
              objectFit: "cover",
              border: `1px solid ${RULE}`,
              display: "block",
              flexShrink: 0,
            }}
          />
          <div style={{ flex: 1, minWidth: 260 }}>
            <div
              style={{
                fontFamily: SERIF,
                fontSize: "clamp(22px, 2vw, 27px)",
                fontWeight: 600,
                lineHeight: 1.2,
                marginBottom: 6,
              }}
            >
              Karen Parker
            </div>
            <div
              style={{
                fontFamily: SANS,
                fontSize: 13.5,
                color: MUTED,
                lineHeight: 1.5,
                marginBottom: 10,
              }}
            >
              Psychiatry & Behavioral Sciences researcher
            </div>
            <p
              style={{
                margin: "0 0 14px",
                fontFamily: SERIF,
                fontSize: 15.5,
                lineHeight: 1.6,
                color: "rgba(10,10,15,0.7)",
                maxWidth: 620,
              }}
            >
              A Stanford lab director, Kavli Fellow, and Simons Foundation and
              Department of Defense–backed neuroscientist studying the social
              brain. Her pillar is being prepared with the same care as the
              rest.
            </p>
            <span
              style={{
                fontFamily: SANS,
                fontSize: 12.5,
                fontWeight: 700,
                letterSpacing: ".06em",
                color: MUTED,
              }}
            >
              Her pillar opens soon
            </span>
          </div>
        </div>

        <p
          data-testid="text-more-to-come"
          style={{
            margin: "28px 0 0",
            fontFamily: SERIF,
            fontSize: 15.5,
            lineHeight: 1.6,
            color: MUTED,
            fontStyle: "italic",
          }}
        >
          More stewards are joining. This page grows as they do.
        </p>
      </div>

      <SiteFooter />
    </div>
  );
}
