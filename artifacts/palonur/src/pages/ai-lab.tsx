import { useEffect } from "react";
import { Link } from "wouter";

/**
 * /ai-lab — public page for the Stanford Lifestyle Medicine AI Lab.
 *
 * Linked from the "From … · Stanford Lifestyle Medicine AI Lab" credit line
 * on /slm answers. Jobs:
 *   1. Introduce the AI Lab as a stewarded expertise area in its own right —
 *      steward Karan Dehghani (faculty ambassador at Stanford GSB, AI expert
 *      for global NGOs, inaugural MasterClass AI Native cohort).
 *   2. Explain what the AI Lab helps with: AI in education, AI in career
 *      transition, and AI judgment (when to use AI, when not to).
 *   3. Explain honestly what the AI Lab label means on an answer.
 *
 * Same paper/cardinal editorial style as /terms.
 */

const PAPER = "#FAF8F4";
const INK = "#1a0505";
const CARDINAL = "#8B1A1A";
const BODY = "#3a2020";
const MUTED = "#8a6a5a";
const SERIF = "ui-serif, Georgia, 'Times New Roman', serif";
const SANS = "ui-sans-serif, system-ui, sans-serif";

export default function AiLab() {
  useEffect(() => {
    const prev = document.body.style.background;
    document.body.style.background = PAPER;
    const prevTitle = document.title;
    document.title = "AI Lab — Palonur";

    const meta = document.createElement("meta");
    meta.name = "description";
    meta.content =
      "The Stanford Lifestyle Medicine AI Lab on Palonur — stewarded guidance on AI in education, AI in career transitions, and the judgment of when to use AI and when not to.";
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
      }}
    >
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "72px 24px 96px" }}>
        <div
          style={{
            fontSize: 12,
            letterSpacing: ".18em",
            textTransform: "uppercase",
            color: CARDINAL,
            marginBottom: 14,
            fontFamily: SANS,
          }}
        >
          Palonur · Stanford Lifestyle Medicine AI Lab
        </div>
        <h1 style={{ fontSize: 38, lineHeight: 1.1, margin: "0 0 10px", fontWeight: 700 }}>
          The AI Lab
        </h1>
        <p style={{ fontSize: 13, color: MUTED, margin: "0 0 26px", fontFamily: SANS }}>
          Steward: Karan Dehghani
        </p>

        <p style={{ fontSize: 17, lineHeight: 1.6, color: BODY, margin: "0 0 18px" }}>
          Every pillar on Palonur has a steward — a named expert who stands
          behind its answers. The AI Lab is the pillar for a question that now
          touches every other one: <em>how should we work, learn, and decide in
          an age of artificial intelligence?</em>
        </p>
        <p style={{ fontSize: 17, lineHeight: 1.6, color: BODY, margin: "0 0 30px" }}>
          Its steward is Karan Dehghani, who built Palonur. He is an ambassador
          at the Stanford Graduate School of Business, an advisory board member
          of the Stanford Lifestyle Medicine Group, a GSB Fellow and HBS
          Foundry Fellow, advises global NGOs on artificial intelligence, and
          was part of the inaugural <em>AI Native</em> MasterClass at the
          University of Chicago. The AI Lab also answers when
          your question lands outside the faculty pillars — drawing on wider
          Stanford research, clearly labeled, under the same rules as
          everywhere else on Palonur: no invented sources, no pretended
          certainty.
        </p>

        <Section title="What the AI Lab helps with">
          <Numbered
            items={[
              {
                title: "AI in education.",
                body: "How to use AI to learn faster without letting it learn instead of you. The Lab designs AI-readiness training — for example, an orientation course for medical students on working with AI while keeping their own clinical reasoning central: think first, then bring in the machine, then verify against real evidence.",
              },
              {
                title: "AI in career transitions.",
                body: "What AI means for your work and what to do about it — whether you are entering the workforce, changing fields, or in the second half of a career. AI takes over tasks, not whole people; the ones who thrive hand over the repetitive parts and reinvest in judgment, relationships, and provable experience.",
              },
              {
                title: "AI strategy and judgment.",
                body: "The hardest skill is not using AI — it is knowing when. A practical rule: lean on AI freely where a decision is reversible and cheap to undo; keep human judgment firmly in charge where it is not. Confidence is not correctness, and the final call — with your name on it — never transfers to a machine.",
              },
            ]}
          />
        </Section>

        <Section title="From the Lab: AI readiness for medical students">
          <P>
            An example of the education work: a short pre-lecture course the
            AI Lab designed to prepare medical students for working with AI —
            without letting it replace their own clinical reasoning.
          </P>
          <Numbered
            items={[
              {
                title: "The new cognitive landscape.",
                body: "Fast intuition, slow deliberation — and now a third system: artificial cognition operating outside the brain. Students learn the two traps that come with it: cognitive surrender (adopting AI outputs with minimal scrutiny) and automation bias (deferring to a confident machine under time pressure). The evidence cuts both ways: when AI is right, accuracy rises sharply; when it is wrong, people do worse than with no AI at all.",
              },
              {
                title: "Working with AI, not for AI.",
                body: "Writing precise prompts, asking AI to critique its own reasoning, requesting evidence and uncertainty, comparing across models and trusted sources — and recognizing when independent human judgment should take precedence, which is almost always.",
              },
              {
                title: "Evidence, hallucinations, and verification.",
                body: "Why AI hallucinates — prediction, not knowledge. Students practice spotting fabricated citations and verifying claims against clinical guidelines and primary literature. Core principle: trust evidence, not confidence.",
              },
              {
                title: "Where AI genuinely amplifies learning.",
                body: "After thinking a case through yourself: what did I miss? AI as tutor for physiology, flashcards refined after checking correctness, lecture notes turned into study guides — always with the student's own reasoning central.",
              },
              {
                title: "Professional responsibility.",
                body: "What never transfers to a machine: privacy, confidentiality, accountability. Clinicians remain responsible for every clinical decision. AI is a collaborator — not a decision maker.",
              },
            ]}
          />
          <P>
            The course closes with a three-pass exercise: students solve the
            same case first alone, then with AI support, then watching AI work
            alone — and compare how the decisions were actually made in each
            pass.
          </P>
        </Section>

        <Section title="The automation bias trap">
          <P>
            The single biggest risk in AI-augmented decisions is seeing the
            AI&apos;s answer before forming your own. Once a confident machine
            has spoken, review quietly turns into theater: the human starts
            from the AI&apos;s answer, nods along, and errors sail through
            unchecked.
          </P>
          <img
            src={`${import.meta.env.BASE_URL}automation-bias-trap.png`}
            alt="The automation bias trap: in the common failure pattern, the human starts with the AI's answer and approves it, letting errors through. In the correct pattern, the human reviews first, draws an independent conclusion, then reconciles it with the AI's work."
            style={{
              width: "100%",
              borderRadius: 8,
              border: "1px solid #e8e0d4",
              margin: "0 0 16px",
            }}
          />
          <P>
            The fix is a habit, not a tool: draw your own conclusion first,
            then look at the AI&apos;s, then reconcile the gaps. Where the two
            disagree is exactly where your attention is worth the most. This is
            also how Palonur itself is built — faculty judgment first, machine
            assistance second.
          </P>
        </Section>

        <Section title="Six decisions worth making now">
          <Numbered
            items={[
              {
                title: "Decide to be the person who uses it, not the person it replaces.",
                body: "In most fields, AI does not take over a job whole; it takes over tasks. Start with your own week: which three tasks would you gladly hand over? Hand them over first, and reinvest the time in work that needs judgment, relationships, and taste.",
              },
              {
                title: "Keep your judgment in the loop — always.",
                body: "AI is confident even when it is wrong. Whatever it drafts, calculates, or recommends, the final call stays yours. The skill that appreciates fastest in an AI-heavy workplace is knowing when the machine is off — and that skill only grows from real expertise.",
              },
              {
                title: "Match the tool to the stakes.",
                body: "Ask one question before delegating anything to AI: if this goes wrong, how expensive is it to undo? Reversible and cheap — experiment freely. Irreversible or costly — slow down, think independently first, and verify before you act.",
              },
              {
                title: "Invest in what AI is worst at.",
                body: "Trust, care, negotiation, mentoring, showing up for a colleague, reading a room. These have quietly become the scarcest professional skills, and they compound with age and experience — which means the second half of a career can be an advantage, not a liability.",
              },
              {
                title: "Be careful what you feed it.",
                body: "Anything you paste into a public AI tool may leave your control. Keep client data, colleagues' personal information, and your employer's confidential material out. This is the fastest way careers get hurt by AI today — not replacement, but a preventable breach of trust.",
              },
              {
                title: "Make your experience legible.",
                body: "As AI floods the world with competent-sounding text, provable experience becomes more valuable, not less. Keep a record of decisions you made and what happened next. In an age of generated everything, a track record with your name on it is the credential that cannot be faked.",
              },
            ]}
          />
        </Section>

        <Section title="What the AI Lab label means on an answer">
          <P>
            When a question reaches Palonur that no faculty pillar covers yet,
            the AI Lab answers it — drawn from the wider body of Stanford
            research and labeled so you always know which kind of answer you
            are reading. Each of those questions also tells the faculty where
            the platform should grow next.
          </P>
        </Section>

        <Section title="Where to go from here">
          <P>
            Have a question of your own — about work, health, or aging well?{" "}
            <Link href="/pal" style={{ color: CARDINAL }}>
              Ask it on Palonur
            </Link>
            . If a faculty pillar covers it, a named Stanford expert answers
            with sources. If not, the AI Lab will tell you honestly what the
            wider research says — and what it doesn&apos;t.
          </P>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ margin: "0 0 34px" }}>
      <h2 style={{ fontSize: 24, lineHeight: 1.25, margin: "0 0 12px", fontWeight: 700 }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ fontSize: 17, lineHeight: 1.6, color: BODY, margin: "0 0 16px" }}>
      {children}
    </p>
  );
}

function Numbered({ items }: { items: { title: string; body: string }[] }) {
  return (
    <ol style={{ margin: "0 0 16px", padding: 0, listStyle: "none" }}>
      {items.map((it, i) => (
        <li key={it.title} style={{ margin: "0 0 18px", display: "flex", gap: 14 }}>
          <span
            style={{
              fontFamily: SANS,
              fontSize: 13,
              fontWeight: 700,
              color: CARDINAL,
              lineHeight: 1.6,
              minWidth: 22,
              paddingTop: 2,
            }}
          >
            {i + 1}.
          </span>
          <span>
            <strong style={{ display: "block", fontSize: 17, lineHeight: 1.4, marginBottom: 4 }}>
              {it.title}
            </strong>
            <span style={{ fontSize: 16.5, lineHeight: 1.6, color: BODY }}>{it.body}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
