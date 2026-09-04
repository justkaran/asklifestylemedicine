import { useEffect } from "react";
import { Link } from "wouter";
import { SiteFooter } from "@/components/site-footer";

const SANS = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif";
const SERIF = "'Georgia','Times New Roman',serif";
const PAPER = "#FAF8F4";
const INK = "#0A0A0F";
const RED = "#B3261E";
const RULE = "rgba(10,10,15,0.12)";
const MUTED = "rgba(10,10,15,0.66)";

const section: React.CSSProperties = {
  background: PAPER,
  borderBottom: `1px solid ${RULE}`,
  padding: "clamp(72px, 10vh, 120px) clamp(24px, 6vw, 96px)",
};
const inner: React.CSSProperties = { maxWidth: 1100, margin: "0 auto" };
const eyebrow: React.CSSProperties = {
  color: RED, fontSize: 11, fontWeight: 700, letterSpacing: ".24em",
  textTransform: "uppercase", marginBottom: 22,
};
const title: React.CSSProperties = {
  color: INK, fontFamily: SERIF, fontSize: "clamp(36px, 5.8vw, 68px)",
  fontWeight: 500, letterSpacing: "-0.025em", lineHeight: 1.03, margin: "0 0 26px",
};
const heading: React.CSSProperties = {
  color: INK, fontFamily: SERIF, fontSize: "clamp(28px, 4vw, 46px)",
  fontWeight: 500, letterSpacing: "-0.018em", lineHeight: 1.1, margin: "0 0 18px",
};
const body: React.CSSProperties = {
  color: "rgba(10,10,15,0.76)", fontFamily: SERIF, fontSize: "clamp(17px, 1.5vw, 19px)",
  lineHeight: 1.62, margin: "0 0 20px", maxWidth: 700,
};

function usePageMeta() {
  useEffect(() => {
    const previousTitle = document.title;
    const previousBackground = document.body.style.background;
    document.title = "AI without training | Palonur";
    document.body.style.background = PAPER;
    window.scrollTo(0, 0);

    const setMeta = (name: string, content: string, attr: "name" | "property" = "name") => {
      let el = document.querySelector<HTMLMetaElement>(`meta[${attr}="${name}"]`);
      const created = !el;
      if (!el) {
        el = document.createElement("meta");
        el.setAttribute(attr, name);
        document.head.appendChild(el);
      }
      const previous = el.getAttribute("content");
      el.setAttribute("content", content);
      return () => {
        if (created) el?.remove();
        else el?.setAttribute("content", previous ?? "");
      };
    };

    const restorers = [
      setMeta("description", "AI can use governed expert excerpts to answer questions without treating the underlying corpus as model-training data. See the problem Palonur solves."),
      setMeta("og:title", "AI without training | Palonur", "property"),
      setMeta("og:description", "Make trusted expertise useful to AI without collapsing access, attribution, and governance into model training.", "property"),
      setMeta("twitter:title", "AI without training | Palonur"),
      setMeta("twitter:description", "A governed layer between expert knowledge and AI applications."),
    ];

    return () => {
      document.title = previousTitle;
      document.body.style.background = previousBackground;
      restorers.forEach((restore) => restore());
    };
  }, []);
}

export default function AiWithoutTraining() {
  usePageMeta();

  return (
    <main style={{ background: PAPER, color: INK, fontFamily: SANS, minHeight: "100vh" }}>
      <style>{`
        .ai-without-training-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; }
        .ai-without-training-compare { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px; }
        @media (max-width: 760px) {
          .ai-without-training-grid, .ai-without-training-compare { grid-template-columns: 1fr !important; }
        }
      `}</style>

      <section style={{ ...section, minHeight: "82vh", display: "flex", alignItems: "center" }}>
        <div style={{ ...inner, display: "grid", gridTemplateColumns: "minmax(0, 7fr) minmax(0, 3fr)", gap: "clamp(32px, 6vw, 88px)", alignItems: "end" }} className="ai-without-training-compare">
          <div>
            <div style={eyebrow}>The problem Palonur solves</div>
            <h1 style={title} data-testid="heading-ai-without-training">
              AI needs trusted knowledge. Knowledge owners need more than a promise.
            </h1>
            <p style={body}>
              When expert material is made useful to AI, access and training are too often treated as the same thing. That leaves universities, researchers, authors, and institutions with a false choice: stay out of AI, or lose track of how their work is used.
            </p>
            <p style={body}>
              Palonur creates a governed path between those two extremes. AI applications can receive the few approved excerpts relevant to a question, while the knowledge stays connected to its source, attribution, rules, and current version.
            </p>
          </div>
          <aside style={{ borderLeft: `1px solid ${RULE}`, paddingLeft: 26, color: MUTED, fontFamily: SERIF, fontSize: "clamp(16px, 1.5vw, 19px)", fontStyle: "italic", lineHeight: 1.55 }}>
            The question is not whether AI can generate an answer. It is whether the knowledge behind that answer can remain identifiable, accountable, and governable.
          </aside>
        </div>
      </section>

      <section style={section}>
        <div style={inner}>
          <div style={eyebrow}>Why the old choice fails</div>
          <h2 style={heading}>Access is not the same as training.</h2>
          <div className="ai-without-training-compare">
            <article style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 16, padding: "clamp(24px, 4vw, 38px)" }}>
              <div style={{ color: RED, fontSize: 11, fontWeight: 700, letterSpacing: ".18em", textTransform: "uppercase", marginBottom: 14 }}>The ungoverned path</div>
              <h3 style={{ fontFamily: SERIF, fontSize: 28, fontWeight: 500, lineHeight: 1.15, margin: "0 0 16px" }}>Expert work becomes anonymous input.</h3>
              <p style={{ ...body, fontSize: 17, marginBottom: 0 }}>
                A document collection can be retrieved, copied, or absorbed without a durable connection to the person or institution responsible for it. Attribution, versioning, licensing, and withdrawal become afterthoughts.
              </p>
            </article>
            <article style={{ background: INK, borderRadius: 16, padding: "clamp(24px, 4vw, 38px)", color: "#fff" }}>
              <div style={{ color: "#F78D82", fontSize: 11, fontWeight: 700, letterSpacing: ".18em", textTransform: "uppercase", marginBottom: 14 }}>The Palonur path</div>
              <h3 style={{ fontFamily: SERIF, fontSize: 28, fontWeight: 500, lineHeight: 1.15, margin: "0 0 16px" }}>Expert work remains a governed resource.</h3>
              <p style={{ ...body, color: "rgba(255,255,255,0.8)", fontSize: 17, marginBottom: 0 }}>
                Relevant, approved excerpts can support a specific answer while the knowledge owner retains a clear source of truth and the application carries the required context forward.
              </p>
            </article>
          </div>
        </div>
      </section>

      <section style={section}>
        <div style={inner}>
          <div style={eyebrow}>A practical separation</div>
          <h2 style={heading}>What “AI without training” means here</h2>
          <div className="ai-without-training-grid">
            {[
              ["1. Approve", "A steward or knowledge owner decides which sources belong in the governed corpus."],
              ["2. Retrieve", "Palonur finds the relevant approved material for a particular question or application request."],
              ["3. Infer", "Only the few excerpts relevant to that request are sent to the model provider for inference."],
            ].map(([step, copy]) => (
              <article key={step} style={{ borderTop: `2px solid ${RED}`, paddingTop: 18 }}>
                <div style={{ color: RED, fontSize: 12, fontWeight: 800, letterSpacing: ".12em", textTransform: "uppercase", marginBottom: 12 }}>{step}</div>
                <p style={{ ...body, fontSize: 17, marginBottom: 0 }}>{copy}</p>
              </article>
            ))}
          </div>
          <div style={{ marginTop: 38, borderLeft: `3px solid ${RED}`, background: "#fff", maxWidth: 820, padding: "20px 24px" }} data-testid="text-inference-only-policy">
            <p style={{ ...body, color: INK, margin: 0 }}>
              Those excerpts are used <strong>for inference only</strong>, under a contractual no-training policy. That is a policy and license obligation, not a claim that Palonur can technically prevent every downstream use or guarantee provider retention.
            </p>
          </div>
        </div>
      </section>

      <section style={{ ...section, background: "#F1EDE6" }}>
        <div style={inner}>
          <div style={eyebrow}>What owners keep</div>
          <h2 style={heading}>A useful AI layer should not erase the source of truth.</h2>
          <div className="ai-without-training-grid">
            {[
              ["Authority", "A named expert, steward, or institution remains responsible for the approved knowledge."],
              ["Attribution", "The source can stay visible wherever the governed knowledge is used."],
              ["Governance", "Knowledge can be updated, replaced, licensed, or withdrawn as the underlying work changes."],
            ].map(([label, copy]) => (
              <article key={label} style={{ background: PAPER, border: `1px solid ${RULE}`, borderRadius: 14, padding: 24 }}>
                <h3 style={{ color: INK, fontFamily: SERIF, fontSize: 25, fontWeight: 500, margin: "0 0 10px" }}>{label}</h3>
                <p style={{ ...body, fontSize: 16, margin: 0 }}>{copy}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section style={{ ...section, background: INK, borderBottom: "none" }}>
        <div style={{ ...inner, maxWidth: 780 }}>
          <div style={{ ...eyebrow, color: "#F78D82" }}>The point</div>
          <h2 style={{ ...heading, color: "#fff" }}>AI does not need to own knowledge to make it useful.</h2>
          <p style={{ ...body, color: "rgba(255,255,255,0.82)" }}>
            Palonur gives AI systems a way to reach trusted expertise when it is needed, instead of treating every expert corpus as raw material for a model.
          </p>
          <p style={{ ...body, color: "rgba(255,255,255,0.82)" }}>
            Read <Link href="/what-is-palonur" style={{ color: "#fff", textDecoration: "underline" }} data-testid="link-what-is-palonur">what Palonur is</Link>, then consult the <Link href="/agent-license" style={{ color: "#fff", textDecoration: "underline" }} data-testid="link-ai-without-training-license">Agent License</Link> and <Link href="/privacy" style={{ color: "#fff", textDecoration: "underline" }} data-testid="link-ai-without-training-privacy">Privacy Policy</Link> for the full terms and data-handling details.
          </p>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}