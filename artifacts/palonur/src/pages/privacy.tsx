import { useEffect } from "react";

const PAPER = "#FAF8F4";
const INK = "#1a0505";
const CARDINAL = "#8B1A1A";
const BODY = "#3a2020";
const MUTED = "#8a6a5a";

const EFFECTIVE = "August 13, 2026";

export default function Privacy() {
  useEffect(() => {
    const prev = document.body.style.background;
    document.body.style.background = PAPER;
    const prevTitle = document.title;
    document.title = "Privacy Policy — Palonur";

    const meta = document.createElement("meta");
    meta.name = "description";
    meta.content =
      "Palonur Privacy Policy — a plain-language description of what data Palonur collects from consumers, how it is processed, what is sent to AI providers, and how payments, emails, and phone numbers are handled.";
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
          Palonur · Privacy Policy
        </div>
        <h1
          style={{
            fontSize: 38,
            lineHeight: 1.1,
            margin: "0 0 10px",
            fontWeight: 700,
          }}
        >
          Privacy Policy
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
          This policy explains, in plain language, what information Palonur
          collects when you use our consumer services — including the sleep
          agent, newsletters, and paid subscriptions — and how we use it. It
          covers what we collect, why, who processes it, and the choices you
          have. We collect only what we need to run the service, and{" "}
          <strong>we don't sell your personal information</strong>.
        </p>
        <p
          style={{
            fontSize: 17,
            lineHeight: 1.6,
            color: BODY,
            margin: "0 0 30px",
          }}
        >
          For the rules governing how you may use Palonur, see our{" "}
          <a
            href="terms"
            style={{ color: CARDINAL, textDecoration: "underline" }}
          >
            Terms of Use
          </a>
          .
        </p>

        <Section title="1. What we collect">
          <p style={{ margin: "0 0 12px" }}>
            Depending on which features you use:
          </p>
          <ul style={{ margin: 0, paddingLeft: 22, lineHeight: 1.6 }}>
            <li>
              <strong>Email address</strong> — when you sign in with a magic
              link, subscribe to a newsletter, join a waitlist, or start a paid
              subscription. Email is our primary account identifier; we don't
              use passwords for consumer accounts.
            </li>
            <li>
              <strong>Questions you ask</strong> — questions submitted to our
              agents are logged, along with operational details (timestamps,
              which sources were retrieved, and token counts) so we can run,
              improve, and meter the service.
            </li>
            <li>
              <strong>Cookies and sessions</strong> — signing in sets a session
              cookie so you stay signed in. We use cookies for sign-in and basic
              site function, not for cross-site advertising.
            </li>
            <li>
              <strong>Usage analytics</strong> — we record page views and
              similar aggregate usage so we understand what's working. This is
              our own operational analytics, not a third-party ad network.
            </li>
            <li>
              <strong>Phone number</strong> — only if you explicitly opt in to
              text check-ins or reminders. See{" "}
              <em>"Phone numbers and texts"</em> below.
            </li>
            <li>
              <strong>Payment details</strong> — handled by Stripe. See{" "}
              <em>"Payments"</em> below.
            </li>
          </ul>
        </Section>

        <Section title="2. How your questions are processed by AI providers">
          <p style={{ margin: "0 0 12px" }}>
            To answer a question, your question and the small set of research
            passages most relevant to it are sent to our AI model provider{" "}
            <strong>for inference only — never for training</strong>. The
            provider drafts the answer; retention of that transient text is
            governed by the provider's API terms.
          </p>
          <p style={{ margin: 0 }}>
            The research corpus itself never leaves our systems — it is stored
            and indexed entirely in-house, and approved research text is not
            sent to any third-party service to build that index. The only
            outbound crossing is the per-answer one described above: your
            question plus the few excerpts relevant to it, for inference, never
            for training, and never the corpus as a whole.
          </p>
        </Section>

        <Section title="3. Payments">
          <p style={{ margin: 0 }}>
            Paid subscriptions are processed by <strong>Stripe</strong>. Your
            card number goes directly to Stripe and never touches our servers;
            we store only customer and subscription references (for example,
            which plan you're on and whether it's active) so we can grant you
            the features you paid for. Stripe's own privacy policy governs its
            handling of your payment data.
          </p>
        </Section>

        <Section title="4. Emails and newsletters">
          <p style={{ margin: "0 0 12px" }}>
            We use your email to send you sign-in magic links you request, and —
            only if you subscribed — newsletters. Public newsletter signups use
            double opt-in: you confirm by clicking a link before you receive
            anything. Every newsletter includes a one-click unsubscribe link.
          </p>
          <p style={{ margin: 0 }}>
            We don't send marketing email you didn't ask for, and we don't share
            your email with third parties for their marketing.
          </p>
        </Section>

        <Section title="5. Phone numbers and texts">
          <p style={{ margin: 0 }}>
            If you opt in, we store your phone number to send the check-ins or
            reminders you asked for — for example, sleep-experiment check-ins.
            We text you only for the purpose you opted into. Reply{" "}
            <strong>STOP</strong> at any time to opt out of texts entirely;
            texting is always optional and never required to use the service.
          </p>
        </Section>

        <Section title="7. How long we keep data">
          <p style={{ margin: "0 0 12px" }}>
            We keep personal data on a fixed schedule, enforced automatically
            every day:
          </p>
          <ul style={{ margin: "0 0 12px", paddingLeft: 22, lineHeight: 1.6 }}>
            <li>
              <strong>Sign-in links</strong> — magic-link tokens expire within
              30 minutes; the records are deleted 30 days later.
            </li>
            <li>
              <strong>Texts you send us</strong> — your phone number is stored
              only in scrambled (hashed) form in our text logs; any stored
              message text is erased within about a day for ordinary messages
              and within 90 days for safety-flagged ones. The bare event record
              (that a text happened, and when) is kept for accountability.
            </li>
            <li>
              <strong>Questions and conversations</strong> — question logs are
              kept tied only to a random session identifier, never your IP
              address; the link between old sessions and your account is removed
              after 24 months of inactivity. Conversation threads (including
              everything you typed) are deleted entirely after 24 months of
              inactivity — and immediately if you delete your account.
            </li>
            <li>
              <strong>Usage analytics</strong> — IP addresses are removed from
              page-view records after 90 days; the raw records themselves are
              deleted after about 13 months. Only non-personal aggregates are
              kept longer.
            </li>
            <li>
              <strong>Email logs</strong> — our record of emails we sent stores
              only a scrambled (hashed) version of the address and is deleted
              after about 13 months.
            </li>
            <li>
              <strong>Accounts</strong> — kept while your account exists.
              Long-inactive accounts (no sign-in and no active subscription for
              36 months) are reviewed and anonymized. Billing records we must
              keep for financial record-keeping are retained in anonymized form,
              never with your personal details attached.
            </li>
          </ul>
          <p style={{ margin: 0 }}>
            One deliberate exception: the scientific governance record — which
            sources our faculty approved, when, and every version of every
            interpretation — is kept indefinitely. That record is about faculty
            accountability for what the service says, not about you, and it
            contains no consumer personal data.
          </p>
        </Section>

        <Section title="7a. Download or delete your data">
          <p style={{ margin: 0 }}>
            From your{" "}
            <a
              href="account"
              style={{ color: CARDINAL, textDecoration: "underline" }}
            >
              account page
            </a>
            , after signing in with a magic link, you can request an emailed
            copy of everything we store about you (profile, subscriptions,
            question history) or delete your account entirely. Deletion removes
            or anonymizes your email, name, phone number, and session history;
            you'll get a confirmation email when it's done. Prefer email? The
            address below works too.
          </p>
        </Section>

        <Section title="8. Who we share data with">
          <p style={{ margin: "0 0 12px" }}>
            We share personal data only with the service providers needed to run
            Palonur:
          </p>
          <ul style={{ margin: "0 0 12px", paddingLeft: 22, lineHeight: 1.6 }}>
            <li>AI model providers (inference only, as described above);</li>
            <li>Stripe (payments);</li>
            <li>
              our email delivery provider (magic links and newsletters you asked
              for);
            </li>
            <li>our hosting and database infrastructure.</li>
          </ul>
          <p style={{ margin: 0 }}>
            We don't sell personal information, and we don't share it with
            advertisers or data brokers. We may disclose information if the law
            requires it.
          </p>
        </Section>

        <Section title="9. Your choices">
          <ul style={{ margin: 0, paddingLeft: 22, lineHeight: 1.6 }}>
            <li>Unsubscribe from any newsletter with the link in the email.</li>
            <li>Reply STOP to opt out of texts.</li>
            <li>Cancel a paid subscription any time from your account page.</li>
            <li>
              Email us to ask what we hold about you, or to request deletion.
            </li>
          </ul>
        </Section>

        <Section title="10. Changes to this policy">
          If we make a material change to this policy, we'll update the
          "Effective" date above and, where appropriate, give notice.
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
          Questions about privacy? Reach us at{" "}
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
