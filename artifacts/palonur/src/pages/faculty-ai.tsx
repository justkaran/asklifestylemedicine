import { useEffect, useState } from "react";
import TavusAvatarButton from "@/components/TavusAvatar";

const PAPER = "#FAF8F4";
const INK = "#1a0505";
const CARDINAL = "#8B1A1A";
const BODY = "#3a2020";
const MUTED = "#8a6a5a";
const SERIF = "ui-serif, Georgia, 'Times New Roman', serif";
const SANS = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif";

export default function FacultyAI() {
  const [visitorName, setVisitorName] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const name =
        localStorage.getItem("palonur_user_name") ||
        localStorage.getItem("slm_standalone_visitor_name") ||
        undefined;
      setVisitorName(name);
    }
  }, []);

  useEffect(() => {
    const prev = document.body.style.background;
    document.body.style.background = PAPER;
    const prevTitle = document.title;
    document.title = "The University's Last Monopoly — Palonur";

    const meta = document.createElement("meta");
    meta.name = "description";
    meta.content =
      "Who decides what, when expertise scales to millions? Karan Dehghani on AI, governance, and leadership as underwriting.";
    document.head.appendChild(meta);

    return () => {
      document.body.style.background = prev;
      document.title = prevTitle;
      meta.remove();
    };
  }, []);

  return (
    <div
      style={{
        background: PAPER,
        minHeight: "100vh",
        color: INK,
        fontFamily: SERIF,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <style>{`
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        .animate-up {
          animation: fadeUp 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards;
          opacity: 0;
        }
        @media (prefers-reduced-motion: reduce) {
          .animate-up {
            animation: fadeIn 0.8s ease forwards;
          }
        }
      `}</style>

      {/* Navbar space / Logo */}
      <div
        style={{
          padding: "32px 24px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          maxWidth: 1000,
          margin: "0 auto",
          width: "100%",
        }}
      >
        <a
          href={import.meta.env.BASE_URL}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            textDecoration: "none",
          }}
        >
          <img
            src={`${import.meta.env.BASE_URL}palonur-flower-red.svg`}
            alt=""
            aria-hidden
            style={{ width: 24, height: 24 }}
          />
          <span
            style={{
              fontFamily: SERIF,
              fontSize: 22,
              color: INK,
              letterSpacing: "0.01em",
            }}
          >
            Palonur
          </span>
        </a>
      </div>

      <main
        style={{
          flex: 1,
          padding: "48px 24px 120px",
          maxWidth: 720,
          margin: "0 auto",
          width: "100%",
        }}
      >
        <div
          className="animate-up"
          style={{
            fontSize: 12,
            letterSpacing: ".18em",
            textTransform: "uppercase",
            color: CARDINAL,
            marginBottom: 20,
            fontFamily: SANS,
            fontWeight: 700,
            animationDelay: "100ms",
          }}
        >
          AI Lab for Education and Leadership
        </div>

        <h1
          className="animate-up"
          style={{
            fontSize: "clamp(36px, 6vw, 48px)",
            lineHeight: 1.15,
            margin: "0 0 16px",
            fontWeight: 700,
            letterSpacing: "-0.01em",
            color: INK,
            animationDelay: "150ms",
          }}
        >
          The University's Last Monopoly
        </h1>

        <h2
          className="animate-up"
          style={{
            fontSize: "clamp(20px, 3vw, 26px)",
            lineHeight: 1.4,
            margin: "0 0 40px",
            fontWeight: 400,
            color: MUTED,
            fontStyle: "italic",
            animationDelay: "200ms",
          }}
        >
          Who decides what, when expertise scales to millions?
        </h2>

        <div
          className="animate-up"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            marginBottom: 64,
            paddingBottom: 32,
            borderBottom: `1px solid rgba(0,0,0,0.08)`,
            animationDelay: "250ms",
          }}
        >
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: "50%",
              background: "#e8e0d4",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: SANS,
              fontSize: 16,
              color: CARDINAL,
              fontWeight: 600,
            }}
          >
            KD
          </div>
          <div>
            <div
              style={{
                fontFamily: SANS,
                fontSize: 15,
                fontWeight: 700,
                color: INK,
              }}
            >
              Karan Dehghani
            </div>
            <div style={{ fontFamily: SANS, fontSize: 13, color: MUTED }}>
              Steward, AI Lab for Education and Leadership
            </div>
          </div>
        </div>

        <article
          className="animate-up"
          style={{
            fontSize: "clamp(18px, 2.5vw, 20px)",
            lineHeight: 1.65,
            color: BODY,
            animationDelay: "300ms",
          }}
        >
          <P>
            Universities were built on a quiet bargain. The institution lends the expert legitimacy; the expert lends the institution authority. Deans, senates, and review boards decide who speaks for the university: slowly, deliberately, and mostly invisibly. For a century, this worked because expertise was scarce. A professor could teach a few hundred students a year. A clinician could advise the patients in front of her. Scarcity made governance simple: control access, and you control influence.
          </P>
          <P>
            AI has broken that scarcity. Today, one expert's judgment, her frameworks, her clinical intuition, her way of weighing evidence, can reach millions of people overnight. It was doable before but now replace the expert human with the expert machine without scrutiny. People will not change. So we need to change for the people. The bottleneck is no longer knowledge. It is governance.
          </P>
          <P>
            And here the hard questions begin. Who signs off when a professor's scaled advice reaches ten million people? Who is accountable when it goes wrong? What does peer review mean when the "publication" is a living system that answers questions at 2 a.m.? Our institutions have committees for laboratory safety and human subjects research. They have nothing for scaled judgment.
          </P>

          <H3>The money question nobody names</H3>
          <P>
            There is a second question, more awkward, that university leaders prefer to leave unspoken: revenue.
          </P>
          <P>
            Universities already monetize expertise: tuition, licensing, executive education, clinical income. But every one of those models assumes scarcity. When an expert's judgment scales to millions, the economics invert. Who owns that stream: the professor, the university, the platform in between? Faculty contracts written in the twentieth century never anticipated the question. Technology licensing offices exist precisely because intellectual property disputes get ugly; scaled human judgment will make software patents look simple.
          </P>
          <P>
            Let us be honest about our own view: monetization is not a corruption of the trust bargain. It is what funds it. Peer review, tenure, libraries, labs: the entire apparatus of credibility costs money. The real question is whether universities become passive royalty collectors on their experts' influence, or genuine partners in governing it. That choice, more than any technology decision, will determine their legitimacy in the next decade.
          </P>

          <H3>What happens if they don't act</H3>
          <P>
            We have watched this movie before. One of us sold one of Germany's first e-commerce companies in the late 1990s, and remembers what incumbents said then: our customers value the relationship; the internet is a channel, not a threat. The newspaper industry said the same. Institutions that owned both distribution and credibility watched both migrate elsewhere, slowly, then suddenly.
          </P>
          <P>
            For universities, the pattern is already visible. Their best experts go direct: podcasts, newsletters, AI platforms. The individual keeps the audience and the revenue; the university keeps the pension liability. Star faculty become brands who happen to hold an affiliation. Meanwhile, unverified AI floods the space universities vacate: confident, fluent, and accountable to no one. Public trust erodes, and universities lose the single asset that justified their cost: being the arbiter of credible knowledge.
          </P>
          <P>
            The endgame is selling degrees the way newspapers sold print ads: to a shrinking, aging market.
          </P>

          <H3>Leadership as underwriting</H3>
          <P>
            But there is another path, and it requires reimagining what university leadership is for.
          </P>
          <P>
            The old job was gatekeeping: deciding who gets in, who gets tenure, who speaks for the institution. The new job is underwriting: putting the institution's name, its review processes, and its accountability behind experts whose judgment now travels far beyond campus. Not controlling the signal, but signing it.
          </P>
          <P>
            This is a governance innovation as much as a technological one. It means faculty senates debating not just curriculum but the terms under which scaled judgment carries the university's seal. It means provosts negotiating revenue models that fund verification rather than merely extract rent. It means accepting that accountability at scale requires infrastructure (audit trails, provenance, human review) that no committee meeting can improvise.
          </P>
          <P>
            Human agency is preserved not by slowing the technology down, but by making sure a human expert, named, credentialed, and accountable, stands behind every answer that carries institutional weight. Legitimacy has never come from scarcity. It comes from someone willing to put their name on the line.
          </P>

          <H3>A practical step: name the owner</H3>
          <P>
            Here is where we challenge our own argument. It is easy to call for "governance" in the abstract; committees love the word precisely because it assigns responsibility to no one. So let us be concrete.
          </P>
          <P>
            At most universities today, no single person is accountable for a decision that touches faculty behavior, procurement, and IT at once. Faculty conduct reports to the Provost, purchasing to the CFO, systems to the CIO, and the three meet only at the President's cabinet. Scaled expertise crosses all three lines on day one. That is not a technology gap. It is an org chart gap.
          </P>
          <P>
            The practical step is to create the role: call it a Chief Verification Officer, or a Vice Provost for Scaled Expertise. One named person, reporting to the Provost, accountable for what carries the university's seal beyond campus. Their mandate has four parts: a review protocol for scaled judgment (an IRB for advice, not just research), an audit trail showing which expert approved what and when, a recourse process for when signed guidance fails, and transparent revenue terms among expert, department, and institution.
          </P>
          <P>
            The obvious objection: another administrator? Universities are drowning in them. Fair. But the alternative is worse: distributed non-accountability, where everyone touches the decision and no one owns the outcome. And the role need not mean a new bureaucracy. The infrastructure it runs on, signing, provenance, audit, revenue rails, can be built once and shared, just as no university writes its own payroll software. What cannot be outsourced is the accountability itself. That must have a name, an office, and a door someone can knock on.
          </P>
          <P>
            Universities still have that possibility. Their last monopoly is worth defending, and the only one worth scaling. But monopolies are not defended by consensus. They are defended by someone whose job it is.
          </P>
        </article>

        <div
          className="animate-up"
          style={{
            marginTop: 64,
            padding: "36px 32px",
            background: "#fff",
            border: `1px solid rgba(0,0,0,0.06)`,
            borderRadius: 20,
            boxShadow: "0 12px 40px rgba(0,0,0,0.04)",
            animationDelay: "400ms",
          }}
        >
          <div
            style={{
              fontFamily: SANS,
              fontSize: 14,
              fontWeight: 700,
              letterSpacing: ".1em",
              textTransform: "uppercase",
              color: CARDINAL,
              marginBottom: 12,
            }}
          >
            Discuss this essay
          </div>
          <p
            style={{
              fontFamily: SERIF,
              fontSize: 20,
              color: INK,
              lineHeight: 1.4,
              margin: "0 0 24px",
            }}
          >
            This is an AI avatar of Karan's published perspective on AI and leadership, not Karan himself. Discuss the ideas in this essay with it directly.
          </p>

          <TavusAvatarButton
            persona="ai-lab-education-leadership"
            visitorName={visitorName}
            triggerVariant="inline"
            triggerLabel="Talk with Karan's AI (camera off)"
          />
        </div>
      </main>
    </div>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p style={{ margin: "0 0 24px" }}>{children}</p>;
}

function H3({ children }: { children: React.ReactNode }) {
  return (
    <h3
      style={{
        fontSize: "clamp(22px, 3.5vw, 28px)",
        fontWeight: 700,
        margin: "48px 0 20px",
        color: INK,
        lineHeight: 1.3,
      }}
    >
      {children}
    </h3>
  );
}
