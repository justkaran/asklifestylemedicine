import { useEffect } from "react";

const PAPER = "#FAF8F4";
const INK = "#1a0505";
const CARDINAL = "#8B1A1A";

export default function AgentLicense() {
  useEffect(() => {
    const prev = document.body.style.background;
    document.body.style.background = PAPER;
    const prevTitle = document.title;
    document.title = "Agent Usage License — Palonur";

    const meta = document.createElement("meta");
    meta.name = "description";
    meta.content =
      "Usage license for programmatic and external-agent access to Palonur's governed expert agents. No-training policy, attribution required.";
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
        fontFamily:
          "ui-serif, Georgia, 'Times New Roman', serif",
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
            fontFamily: "ui-sans-serif, system-ui, sans-serif",
          }}
        >
          Palonur · Agent Usage License
        </div>
        <h1 style={{ fontSize: 38, lineHeight: 1.1, margin: "0 0 18px", fontWeight: 700 }}>
          Terms for programmatic &amp; agent access
        </h1>
        <p style={{ fontSize: 17, lineHeight: 1.6, color: "#3a2020", margin: "0 0 28px" }}>
          These terms govern access to Palonur's governed expert agents through a
          partner API key — including any AI agent, MCP client, or automated
          system that queries our endpoints. By using a partner key you agree to
          the terms below. Answers returned to keyed requests carry a
          machine-readable <code>license</code> field and{" "}
          <code>X-Palonur-Usage-Policy</code>,{" "}
          <code>X-Palonur-License</code>, and{" "}
          <code>X-Palonur-Attribution</code> response headers that point back to
          this page.
        </p>

        <Section title="1. No training on our outputs">
          You may not use answers, citations, or interpretations returned by
          Palonur's agents to train, fine-tune, distill, or otherwise improve any
          machine-learning model. This is a contractual restriction on how you
          use the outputs.
        </Section>

        <Section title="2. Attribution required">
          When you surface a Palonur answer to an end user, you must attribute it
          to Palonur and preserve the cited source. The attribution string we
          send is: <em>“Source: Palonur — governed expert science. Attribution
          required; outputs may not be used to train AI models.”</em>
        </Section>

        <Section title="3. Keyed access &amp; payment">
          Programmatic access requires an active partner key. Keys are granted by
          Palonur; some keys additionally require an active payment (a monthly
          subscription or one-time request credits) to remain usable. First-party
          visitors on palonur.com are governed by the consumer subscription and
          our general{" "}
          <a href="terms" style={{ color: CARDINAL, textDecoration: "underline" }}>
            Terms of Use
          </a>{" "}
          instead.
        </Section>

        <Section title="4. What we do — and do not — promise">
          <p style={{ margin: "0 0 12px" }}>
            This license is a <strong>policy and contractual commitment</strong>,
            not a technical guarantee. To be clear and honest about what happens
            to data:
          </p>
          <ul style={{ margin: "0 0 12px", paddingLeft: 22, lineHeight: 1.6 }}>
            <li>
              We do <strong>not</strong> claim a technical “no-training”
              enforcement mechanism — the no-training term is a rule we impose on
              you, not something we can technically prevent downstream.
            </li>
            <li>
              We do not send the corpus as a whole to our model provider. To
              answer a question, only the few short excerpts relevant to that
              question are sent for inference, never for training. We do{" "}
              <strong>not</strong> claim zero retention by that provider.
            </li>
            <li>
              We log keyed requests for metering, abuse prevention, and billing.
            </li>
          </ul>
          <p style={{ margin: 0 }}>
            We make these limits explicit on purpose: a license you can rely on
            is one that doesn't overclaim.
          </p>
        </Section>

        <Section title="5. Fair use &amp; revocation">
          Per-key rate limits apply (requests per minute, per day, and concurrent
          streams). We may revoke a key at any time for abuse, non-payment, or
          breach of these terms.
        </Section>

        <p
          style={{
            fontSize: 13,
            color: "#8a6a5a",
            marginTop: 44,
            fontFamily: "ui-sans-serif, system-ui, sans-serif",
          }}
        >
          Questions about a partner key or these terms? Contact the Palonur team
          through the partner channel that issued your key.
        </p>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 30 }}>
      <h2 style={{ fontSize: 21, fontWeight: 700, margin: "0 0 10px" }}>{title}</h2>
      <div style={{ fontSize: 16, lineHeight: 1.6, color: "#3a2020" }}>{children}</div>
    </section>
  );
}
