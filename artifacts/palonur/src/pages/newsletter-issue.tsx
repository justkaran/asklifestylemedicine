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
import { AskSteward } from "@/components/ask-steward";

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
  // Steward-tailored fields joined read-only from existing data; all nullable.
  photoUrl: string | null;
  bio: string | null;
  topicDescription: string | null;
  // "Ask the steward" eligibility, decided server-side (published voice profile
  // + approved primary-pillar content). The panel is omitted otherwise.
  ask?: {
    eligible: boolean;
    pillarSlug: string | null;
    stewardName: string | null;
  } | null;
}

interface IssueDetail {
  id: number;
  title: string;
  previewText: string | null;
  introHtml: string | null;
  heroImageUrl: string | null;
  sentAt: string | null;
}

interface PublicPost {
  id: number;
  kind: "article" | "story";
  title: string | null;
  authorName: string | null;
  authorInstitution: string | null;
  bodyHtml: string | null;
  pullQuote: string | null;
  imageUrl: string | null;
}

function plainText(html: string | null, max = 200): string {
  if (!html) return "";
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export default function NewsletterIssue() {
  const params = useParams();
  const slug = String(params.slug ?? "");
  const issueId = String(params.issueId ?? "");

  const [pub, setPub] = useState<Publication | null>(null);
  const [issue, setIssue] = useState<IssueDetail | null>(null);
  const [posts, setPosts] = useState<PublicPost[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "missing">(
    "loading",
  );

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(
          `/api/newsletter/p/${encodeURIComponent(slug)}/issues/${encodeURIComponent(
            issueId,
          )}`,
        );
        if (!res.ok) {
          if (!cancelled) setLoadState("missing");
          return;
        }
        const data = (await res.json()) as {
          publication: Publication;
          issue: IssueDetail;
          posts: PublicPost[];
        };
        if (!cancelled) {
          setPub(data.publication);
          setIssue(data.issue);
          setPosts(data.posts ?? []);
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
  }, [slug, issueId]);

  useEffect(() => {
    if (!pub || !issue) {
      document.body.style.background = PAPER;
      return () => {
        document.body.style.background = "";
      };
    }
    const description =
      issue.previewText ||
      plainText(issue.introHtml) ||
      plainText(posts[0]?.bodyHtml ?? null) ||
      pub.tagline ||
      `Read ${issue.title} from ${pub.name} on Palonur.`;
    const cleanupMeta = applyPageMeta({
      title: `${issue.title} · ${pub.name}`,
      description,
      image:
        issue.heroImageUrl ??
        posts.find((p) => p.imageUrl)?.imageUrl ??
        pub.photoUrl ??
        null,
    });
    document.body.style.background = PAPER;
    return () => {
      cleanupMeta();
      document.body.style.background = "";
    };
  }, [pub, issue, posts]);

  const accent = pub?.accentColor || RED;

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

  if (loadState === "missing" || !pub || !issue) {
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
            Issue not found
          </h1>
          <p style={{ color: MUTED, fontSize: 16, lineHeight: 1.6 }}>
            We couldn't find this issue. It may have been removed, or the link is
            incorrect.
          </p>
        </div>
      </div>
    );
  }

  const byline = [pub.bylineName, pub.bylineInstitution]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      style={{
        minHeight: "100dvh",
        background: PAPER,
        color: INK,
        fontFamily: SANS,
      }}
    >
      <article
        style={{ maxWidth: 680, margin: "0 auto", padding: "44px 24px 96px" }}
      >
        <Link
          href={`/p/${pub.slug}`}
          style={{
            fontSize: 13,
            letterSpacing: ".04em",
            color: MUTED,
            textDecoration: "none",
          }}
          data-testid="link-back-publication"
        >
          ← {pub.name}
        </Link>

        <header style={{ marginTop: 36 }}>
          <p
            style={{
              fontSize: 11,
              letterSpacing: ".16em",
              textTransform: "uppercase",
              color: accent,
              margin: 0,
            }}
          >
            {byline || pub.name}
            {issue.sentAt ? ` · ${formatIssueDate(issue.sentAt)}` : ""}
          </p>
          <h1
            style={{
              fontFamily: SERIF,
              fontWeight: 500,
              fontSize: "clamp(30px, 5.5vw, 46px)",
              lineHeight: 1.12,
              margin: "12px 0 0",
              letterSpacing: "-0.01em",
            }}
          >
            {issue.title}
          </h1>
        </header>

        {issue.heroImageUrl && (
          <img
            src={issue.heroImageUrl}
            alt=""
            style={{
              width: "100%",
              display: "block",
              borderRadius: 14,
              margin: "30px 0 0",
            }}
          />
        )}

        {issue.introHtml && (
          <div
            className="nl-prose"
            style={{
              fontSize: 18,
              lineHeight: 1.75,
              color: INK,
              marginTop: 30,
            }}
            dangerouslySetInnerHTML={{ __html: issue.introHtml }}
          />
        )}

        {posts.map((p) => (
          <section
            key={p.id}
            style={{ marginTop: 44 }}
            data-testid={`post-${p.id}`}
          >
            {p.imageUrl && (
              <img
                src={p.imageUrl}
                alt=""
                style={{
                  width: "100%",
                  display: "block",
                  borderRadius: 12,
                  margin: "0 0 18px",
                }}
              />
            )}
            {p.kind === "story" ? (
              <p
                style={{
                  fontSize: 11,
                  letterSpacing: ".16em",
                  textTransform: "uppercase",
                  color: accent,
                  margin: "0 0 8px",
                }}
              >
                A reader's story
              </p>
            ) : (
              p.authorName && (
                <p
                  style={{
                    fontSize: 11,
                    letterSpacing: ".16em",
                    textTransform: "uppercase",
                    color: accent,
                    margin: "0 0 8px",
                  }}
                >
                  By {p.authorName}
                  {p.authorInstitution ? ` · ${p.authorInstitution}` : ""}
                </p>
              )
            )}
            {p.title && (
              <h2
                style={{
                  fontFamily: SERIF,
                  fontWeight: 500,
                  fontSize: "clamp(24px, 3.6vw, 30px)",
                  lineHeight: 1.22,
                  margin: "0 0 14px",
                }}
              >
                {p.title}
              </h2>
            )}
            {p.pullQuote && (
              <blockquote
                style={{
                  fontFamily: SERIF,
                  fontStyle: "italic",
                  fontSize: 22,
                  lineHeight: 1.45,
                  borderLeft: `3px solid ${accent}`,
                  padding: "4px 20px",
                  margin: "18px 0",
                  color: INK,
                }}
              >
                {p.pullQuote}
              </blockquote>
            )}
            {p.bodyHtml && (
              <div
                className="nl-prose"
                style={{ fontSize: 18, lineHeight: 1.75, color: INK }}
                dangerouslySetInnerHTML={{ __html: p.bodyHtml }}
              />
            )}
          </section>
        ))}

        {/* Ask the steward (live, voice-matched, pillar-locked) */}
        {pub.ask?.eligible && pub.ask.pillarSlug && (
          <AskSteward
            pillarSlug={pub.ask.pillarSlug}
            stewardName={pub.ask.stewardName ?? pub.bylineName}
            accent={accent}
          />
        )}

        {/* Subscribe call-to-action (secondary) */}
        <section
          style={{
            marginTop: 56,
            padding: "28px 28px 30px",
            borderRadius: 16,
            background: "rgba(10,10,15,0.03)",
            border: "1px solid rgba(10,10,15,0.07)",
          }}
        >
          <h3
            style={{
              fontFamily: SERIF,
              fontWeight: 500,
              fontSize: 22,
              margin: 0,
            }}
          >
            Subscribe to {pub.name}
          </h3>
          <p
            style={{
              fontSize: 15,
              lineHeight: 1.6,
              color: MUTED,
              margin: "8px 0 18px",
              maxWidth: 460,
            }}
          >
            Get every new issue in your inbox. We never share your email, and
            every issue has a one-click unsubscribe.
          </p>
          <NewsletterSubscribe
            slug={pub.slug}
            accent={accent}
            source="issue-page"
          />
        </section>

        <p style={{ marginTop: 40 }}>
          <Link
            href={`/p/${pub.slug}`}
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: accent,
              textDecoration: "none",
            }}
          >
            ← All issues
          </Link>
        </p>
      </article>
    </div>
  );
}
