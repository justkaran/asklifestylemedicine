import { useEffect } from "react";

const PAPER = "#FAF8F4";
const INK = "#1a0505";
const CARDINAL = "#8B1A1A";
const BODY = "#3a2020";
const MUTED = "#8a6a5a";

const EFFECTIVE = "June 21, 2026";

export default function Terms() {
  useEffect(() => {
    const prev = document.body.style.background;
    document.body.style.background = PAPER;
    const prevTitle = document.title;
    document.title = "Terms of Use — Palonur";

    const meta = document.createElement("meta");
    meta.name = "description";
    meta.content =
      "Palonur Terms of Use — how anyone may use Palonur's governed expert answers. Plain-language terms on attribution, research ownership, the no-training data policy, and the limits of what Palonur provides.";
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
        fontFamily: "ui-serif, Georgia, 'Times New Roman', serif",
      }}
    >
      <div
        style={{ maxWidth: 760, margin: "0 auto", padding: "72px 24px 96px" }}
      >
        <div
          style={{
            fontSize: 12,
            letterSpacing: ".18em",
            textTransform: "uppercase",
            color: CARDINAL,
            marginBottom: 14,
            fontFamily: "ui-sans-serif, system-ui, sans-serif",
          }}
        >
          Palonur · Terms of Use
        </div>
        <h1
          style={{
            fontSize: 38,
            lineHeight: 1.1,
            margin: "0 0 10px",
            fontWeight: 700,
          }}
        >
          Terms of Use
        </h1>
        <p
          style={{
            fontSize: 13,
            color: MUTED,
            margin: "0 0 26px",
            fontFamily: "ui-sans-serif, system-ui, sans-serif",
          }}
        >
          Effective {EFFECTIVE}
        </p>

        <p
          style={{
            fontSize: 17,
            lineHeight: 1.6,
            color: BODY,
            margin: "0 0 18px",
          }}
        >
          Welcome to Palonur. We turn peer-reviewed research and the firsthand
          expertise of named scientists into clear, cited answers — for people
          asking a question, for AI agents, and for the platforms that surface
          them. These terms explain, in plain language, what you can expect from
          us and what we ask of you. They apply to everyone who uses Palonur:
          visitors to our site, subscribers, and anyone reading a Palonur answer
          wherever it appears.
        </p>
        <p
          style={{
            fontSize: 17,
            lineHeight: 1.6,
            color: BODY,
            margin: "0 0 30px",
          }}
        >
          By using Palonur, you agree to these terms. If you don't agree, please
          don't use the service.
        </p>

        <Section title="1. What Palonur is — and isn't">
          <p style={{ margin: "0 0 12px" }}>
            Palonur is an independent company. We organize, retrieve, and cite
            published research and expert interpretations to compose answers
            that stay grounded in real sources, with attribution back to the
            people and papers behind them.
          </p>
          <p style={{ margin: 0 }}>
            Palonur is an information tool. It is{" "}
            <strong>
              not professional, medical, clinical, legal, or financial advice
            </strong>
            , and using it does not create a professional or doctor–patient
            relationship. See <em>“This is not medical advice”</em> below.
          </p>
        </Section>

        <Section title="2. Independence and affiliation">
          <p style={{ margin: "0 0 12px" }}>
            Palonur works alongside scientists and academic programs, and our
            answers cite research that originated at universities and research
            institutions. Where we name an institution, a program, or an
            individual's academic title, we do so to{" "}
            <strong>
              describe affiliation and credit the origin of cited work
            </strong>{" "}
            — for accuracy and attribution.
          </p>
          <p style={{ margin: 0 }}>
            Naming an institution or person does <strong>not</strong> mean that
            institution sponsors, endorses, reviews, or is responsible for
            Palonur, the service, or any answer it produces. Scientists who
            contribute do so in their individual capacity. Palonur alone is
            responsible for operating the service. Please don't use any
            institution's or person's name, logo, or marks in a way that implies
            their endorsement of you or of Palonur.
          </p>
        </Section>

        <Section title="3. The research belongs to its authors">
          <p style={{ margin: "0 0 12px" }}>
            Palonur does not claim ownership of the underlying papers, data,
            talks, or research it cites. Those remain the property of their
            respective authors, rights-holders, and institutions. We retrieve
            and cite material that contributors have approved, and we compose
            answers on top of it.
          </p>
          <p style={{ margin: 0 }}>
            Contributors keep ownership and control of what they bring to
            Palonur. They decide what is shared, what stays private, and what is
            withdrawn — and they can withdraw it. Nothing a contributor adds is
            published or made citable until they approve it.
          </p>
        </Section>

        <Section title="4. How you may use Palonur's answers">
          <p style={{ margin: "0 0 12px" }}>
            We grant you a limited, personal, non-exclusive, revocable license
            to read and use Palonur's answers for your own information. When you
            share, quote, or display a Palonur answer, you must{" "}
            <strong>keep the attribution and the cited source intact</strong>{" "}
            and not present the answer as your own original research or as an
            individual expert's personalized advice.
          </p>
          <p style={{ margin: 0 }}>
            Automated, high-volume, or commercial access — for example an AI
            agent, MCP client, or platform integration — additionally requires a
            partner key and is governed by our{" "}
            <a
              href="agent-license"
              style={{ color: CARDINAL, textDecoration: "underline" }}
            >
              Agent Usage License
            </a>
            .
          </p>
        </Section>

        <Section title="5. We don't train on our outputs">
          You may not use answers, citations, or interpretations from Palonur to
          train, fine-tune, distill, or otherwise build or improve any
          machine-learning model. This is a rule we impose on how the outputs
          are used; it is a policy and contractual commitment rather than a
          technical control.
        </Section>

        <Section title="6. How your data and the research are handled">
          <p style={{ margin: "0 0 12px" }}>
            <strong>
              Raw research data is never used to train any AI model.
            </strong>{" "}
            Contributors' material is only ever retrieved to help answer a
            question, and cited back to its source.
          </p>
          <p style={{ margin: "0 0 12px" }}>
            We want to be precise rather than overclaim about what happens
            behind the scenes:
          </p>
          <ul style={{ margin: "0 0 12px", paddingLeft: 22, lineHeight: 1.6 }}>
            <li>
              The search index that lets us find relevant passages is computed{" "}
              <strong>in-house</strong>. Approved text is not sent to a
              third-party service to build that index.
            </li>
            <li>
              To draft a single answer, the small set of passages most relevant
              to your question is sent to our AI model provider{" "}
              <strong>for inference only — never for training</strong>.
              Retention of that transient text is governed by the provider's API
              terms.
            </li>
            <li>
              We keep operational logs (for reliability, abuse prevention, and —
              for keyed access — metering and billing).
            </li>
          </ul>
          <p style={{ margin: 0 }}>
            We collect only what we need to run the service and to contact you
            if you've asked us to. We don't sell your personal information.
          </p>
        </Section>

        <Section title="7. This is not medical advice">
          <p style={{ margin: "0 0 12px" }}>
            Palonur covers health, sleep, lifestyle, and related science. Its
            answers are for general information and education only. They are{" "}
            <strong>not</strong> a diagnosis, treatment, or a substitute for the
            judgment of a qualified health professional who knows your
            situation.
          </p>
          <p style={{ margin: 0 }}>
            Always seek the advice of your physician or another qualified
            provider with any questions about a medical condition, and never
            disregard or delay professional advice because of something you read
            on Palonur. If you may be experiencing a medical emergency, call
            your local emergency number.
          </p>
        </Section>

        <Section title="8. Accuracy, and what we can't promise">
          Palonur is built to stay grounded in cited sources, and we work hard
          to keep it that way. Even so, science evolves, sources can be
          incomplete, and AI systems can make mistakes. The service and its
          answers are provided{" "}
          <strong>“as is,” without warranties of any kind</strong>, express or
          implied, including accuracy, completeness, or fitness for a particular
          purpose. You are responsible for how you act on what you read.
        </Section>

        <Section title="9. Limitation of liability">
          To the fullest extent permitted by law, Palonur and the scientists,
          contributors, and institutions whose work it cites are not liable for
          any indirect, incidental, special, or consequential damages, or for
          any loss arising from your use of — or inability to use — the service
          or its answers. Where liability cannot be excluded, it is limited to
          the amount you paid Palonur, if any, in the twelve months before the
          claim.
        </Section>

        <Section title="10. Acceptable use">
          <p style={{ margin: "0 0 12px" }}>Please don't:</p>
          <ul style={{ margin: 0, paddingLeft: 22, lineHeight: 1.6 }}>
            <li>
              present a Palonur answer as a named expert's individualized
              advice, or imply that any institution or person endorses you;
            </li>
            <li>strip citations or attribution from an answer you share;</li>
            <li>
              use the outputs to train or improve a machine-learning model;
            </li>
            <li>
              access the service through scraping or automation that bypasses
              rate limits or a required partner key;
            </li>
            <li>
              misuse the service to mislead, harm, or infringe others' rights.
            </li>
          </ul>
        </Section>

        <Section title="11. Consumer access: free limits, subscriptions, and calls">
          <p style={{ margin: "0 0 12px" }}>
            <strong>Free questions.</strong> Some of our consumer agents let you
            ask a limited number of questions for free before asking you to
            subscribe. Free limits may vary by product and may change; when you
            hit one, we tell you plainly rather than degrading the answer.
          </p>
          <p style={{ margin: "0 0 12px" }}>
            <strong>Paid subscriptions.</strong> Paid plans (for example paid
            plans grant the features described on the plan's page at the time
            you subscribe — such as unlimited questions in a given area or
            access across all areas. Subscriptions are billed through Stripe on
            the monthly or annual cycle you choose and renew automatically until
            you cancel.
          </p>
          <p style={{ margin: "0 0 12px" }}>
            <strong>Weekly calls.</strong> Where a plan includes a weekly call
            with a person, booking on our site records your reservation for that
            week; the actual call is scheduled on an external scheduling
            service. One call is included per calendar week, and unused weeks
            don't roll over.
          </p>
          <p style={{ margin: 0 }}>
            <strong>Accounts and cancellation.</strong> Consumer accounts are
            keyed to your email address and use email sign-in links. You can
            manage or cancel a subscription any time from your{" "}
            <a
              href="account"
              style={{ color: CARDINAL, textDecoration: "underline" }}
            >
              account page
            </a>
            ; cancelling stops future renewals, and your access continues
            through the period you've already paid for.
          </p>
        </Section>

        <Section title="12. Changes to these terms">
          We may update these terms as Palonur evolves. When we make a material
          change, we'll update the “Effective” date above and, where
          appropriate, give notice. Continuing to use Palonur after a change
          means you accept the updated terms.
        </Section>

        <Section title="13. Governing law">
          These terms are governed by the laws of the State of California,
          United States, without regard to its conflict-of-laws rules.
        </Section>

        <p
          style={{
            fontSize: 13,
            color: MUTED,
            marginTop: 44,
            lineHeight: 1.6,
            fontFamily: "ui-sans-serif, system-ui, sans-serif",
          }}
        >
          Curious what data we collect and how it's handled? See our{" "}
          <a
            href="privacy"
            style={{ color: CARDINAL, textDecoration: "underline" }}
          >
            Privacy Policy
          </a>
          . Questions about these terms? Reach us at{" "}
          <a
            href="mailto:hello@palonur.com"
            style={{ color: CARDINAL, textDecoration: "underline" }}
          >
            hello@palonur.com
          </a>
          .
        </p>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginBottom: 30 }}>
      <h2 style={{ fontSize: 21, fontWeight: 700, margin: "0 0 10px" }}>
        {title}
      </h2>
      <div style={{ fontSize: 16, lineHeight: 1.6, color: BODY }}>
        {children}
      </div>
    </section>
  );
}
