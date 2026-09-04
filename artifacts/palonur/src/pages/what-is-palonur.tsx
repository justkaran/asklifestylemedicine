import { useEffect } from "react";
import { Link } from "wouter";
import { SiteFooter } from "@/components/site-footer";

const SANS  = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif";
const SERIF = "'Georgia','Times New Roman',serif";
const RED   = "#B3261E";
const INK   = "#0A0A0F";
const PAPER = "#FAF8F4";
const RULE  = "rgba(10,10,15,0.12)";
const MUTED = "rgba(10,10,15,0.64)";

const italic = (s: string) => (
  <em style={{ fontStyle: "italic", fontFamily: SERIF }}>{s}</em>
);

const chapter: React.CSSProperties = {
  padding: "clamp(72px, 10vh, 120px) clamp(24px, 6vw, 96px)",
  borderBottom: `1px solid ${RULE}`,
  background: PAPER,
};
const inner: React.CSSProperties = {
  width: "100%", maxWidth: 1100, margin: "0 auto",
};
const innerSplit: React.CSSProperties = {
  ...inner,
  display: "grid",
  gridTemplateColumns: "minmax(0, 7fr) minmax(0, 3fr)",
  gap: "clamp(32px, 5vw, 80px)",
  alignItems: "start",
};
const eyebrow: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, letterSpacing: ".24em",
  textTransform: "uppercase", color: RED, marginBottom: 28,
};
const headline: React.CSSProperties = {
  margin: "0 0 28px",
  fontFamily: SERIF, fontWeight: 500,
  fontSize: "clamp(34px, 5vw, 56px)",
  lineHeight: 1.06, letterSpacing: "-0.018em",
  color: INK, maxWidth: 820,
};
const h3: React.CSSProperties = {
  margin: "0 0 16px",
  fontFamily: SERIF, fontWeight: 500,
  fontSize: "clamp(24px, 3vw, 32px)",
  lineHeight: 1.15, letterSpacing: "-0.01em",
  color: INK, maxWidth: 820,
};
const body: React.CSSProperties = {
  margin: "0 0 24px", maxWidth: 640,
  fontFamily: SERIF,
  fontSize: "clamp(17px, 1.5vw, 19px)",
  lineHeight: 1.6, color: "rgba(10,10,15,0.76)",
};
const aside: React.CSSProperties = {
  paddingTop: 8, borderLeft: `1px solid ${RULE}`, paddingLeft: 28,
  fontFamily: SERIF, fontStyle: "italic", lineHeight: 1.55,
  fontSize: "clamp(15px, 1.3vw, 17px)",
  color: "rgba(10,10,15,0.66)",
};

const faqQ: React.CSSProperties = {
  fontFamily: SANS, fontSize: 16, fontWeight: 700, color: INK, marginBottom: 8,
};
const faqA: React.CSSProperties = {
  fontFamily: SERIF, fontSize: 16, lineHeight: 1.6, color: "rgba(10,10,15,0.72)", marginBottom: 32,
  maxWidth: 640,
};

export default function WhatIsPalonur() {
  useEffect(() => {
    const prevTitle = document.title;
    document.title = "What is Palonur? | Governed knowledge for AI";
    const prevBg = document.body.style.background;
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
      setMeta("description", "Palonur is the governed knowledge layer for AI: trusted expertise can reach AI applications with source identity, attribution, governance, and access control intact."),
      setMeta("og:title", "What is Palonur? | Governed knowledge for AI", "property"),
      setMeta("og:description", "Palonur connects approved expert knowledge with AI applications while preserving governance, attribution, and access control.", "property"),
      setMeta("twitter:title", "What is Palonur? | Governed knowledge for AI"),
      setMeta("twitter:description", "Trusted expertise can reach AI applications without losing its source identity, attribution, governance, or access control."),
    ];

    return () => {
      document.title = prevTitle;
      document.body.style.background = prevBg;
      restorers.forEach((restore) => restore());
    };
  }, []);

  return (
    <div style={{ background: PAPER, color: INK, fontFamily: SANS, minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <style>{`
        @media (max-width: 760px) {
          .palonur-explainer-split { grid-template-columns: 1fr !important; }
          .palonur-explainer-aside { border-left: 0 !important; border-top: 1px solid ${RULE}; padding-left: 0 !important; padding-top: 20px !important; }
        }
        @media (max-width: 380px) {
          .palonur-explainer-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
      {/* ─── Hero ──────────────────────────────────────────────────────── */}
      <div style={{ ...chapter, minHeight: "85vh", display: "flex", alignItems: "center" }}>
        <div style={innerSplit} className="palonur-explainer-split">
          <div>
            <div style={eyebrow}>What is Palonur</div>
            <h1 style={headline} data-testid="heading-what-is-palonur">
              Palonur is the {italic("governed knowledge layer")} for AI.
            </h1>
            <p style={body}>
              Palonur lets universities, faculty, and expert organizations make authoritative knowledge available to AI systems while maintaining control over how that knowledge is accessed, attributed, updated, licensed, and used.
            </p>
            <p style={body}>
              Palonur separates <strong>AI access to knowledge</strong> from <strong>AI training on knowledge</strong>.
            </p>
            <p style={body}>
              An AI system can use approved Palonur knowledge to answer a question without receiving permission to train on the underlying corpus. This allows trusted expertise to become useful inside AI systems without requiring experts or institutions to give up control of their intellectual work.
            </p>
            
            <div style={{ marginTop: 48, padding: "24px 32px", border: `1px solid ${RED}`, borderRadius: 12, background: "#fff", maxWidth: 640 }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".24em", textTransform: "uppercase", color: RED, marginBottom: 12 }}>
                In one sentence
              </div>
              <div style={{ fontFamily: SERIF, fontSize: "clamp(18px, 1.8vw, 22px)", fontWeight: 500, lineHeight: 1.4, color: INK }}>
                Palonur lets trusted expertise flow into AI systems without requiring the people and institutions behind that expertise to give up control of it.
              </div>
            </div>
          </div>
          <aside style={aside} className="palonur-explainer-aside">
            “The AI is not the authority. The expert is.”
          </aside>
        </div>
      </div>

      {/* ─── How it works & Flow ───────────────────────────────────────── */}
      <div style={chapter}>
        <div style={inner}>
          <div style={eyebrow}>End-to-end flow</div>
          <h2 style={h3}>How Palonur works</h2>
          
          <div style={{ 
            display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16, 
            fontFamily: SANS, fontSize: 13, fontWeight: 700, letterSpacing: ".05em", color: MUTED,
            marginBottom: 40, marginTop: 20
          }}>
            <div style={{ background: "#fff", border: `1px solid ${RULE}`, padding: "12px 20px", borderRadius: 8, color: INK }}>Expert knowledge</div>
            <div>→</div>
            <div style={{ background: "#fff", border: `1px solid ${RULE}`, padding: "12px 20px", borderRadius: 8, color: INK }}>Governed corpus</div>
            <div>→</div>
            <div style={{ background: "#fff", border: `1.5px solid ${RED}`, padding: "12px 20px", borderRadius: 8, color: RED }}>Palonur knowledge layer</div>
            <div>→</div>
            <div style={{ background: "#fff", border: `1px solid ${RULE}`, padding: "12px 20px", borderRadius: 8, color: INK }}>AI applications</div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 48, maxWidth: 960 }} className="palonur-explainer-grid">
            <div>
              <p style={body}>
                Palonur sits between authoritative knowledge and the AI systems that want to use it. The underlying knowledge can include published research, expert guidance, protocols, books, educational material, and other approved sources.
              </p>
              <p style={body}>
                The knowledge owner determines what belongs in the governed corpus.
              </p>
            </div>
            <div>
              <p style={body}>
                Palonur then makes that approved knowledge available to interfaces such as AI assistants, AI agents, MCPs, APIs, search and answer experiences, and institution-specific applications. 
              </p>
              <p style={body}>
                The source material remains governed independently from the AI model using it.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* ─── Faculty and experts remain the source of truth ────────────── */}
      <div style={chapter}>
        <div style={innerSplit} className="palonur-explainer-split">
          <div>
            <div style={eyebrow}>Owner Responsibilities</div>
            <h2 style={h3}>Faculty and experts remain the source of truth</h2>
            <p style={body}>
              Knowledge remains connected to its responsible source rather than being absorbed into an anonymous model. Depending on the implementation, experts and institutions can control:
            </p>
            <ul style={{ ...body, margin: "0 0 24px 24px", padding: 0 }}>
              <li style={{ marginBottom: 8 }}>Which sources are available</li>
              <li style={{ marginBottom: 8 }}>Which experts are responsible for the knowledge</li>
              <li style={{ marginBottom: 8 }}>How sources are attributed</li>
              <li style={{ marginBottom: 8 }}>When knowledge is updated</li>
              <li style={{ marginBottom: 8 }}>Which applications may access it</li>
              <li style={{ marginBottom: 8 }}>What licensing conditions apply</li>
              <li style={{ marginBottom: 8 }}>When knowledge should be withdrawn or replaced</li>
            </ul>
            <p style={body}>
              This creates a governed knowledge layer between expert institutions and artificial intelligence.
            </p>
          </div>
          <aside style={aside} className="palonur-explainer-aside">
            Expert knowledge is a governed resource, not simply a collection of documents to retrieve.
          </aside>
        </div>
      </div>

      {/* ─── Palonur vs AI / Beyond RAG ────────────────────────────────── */}
      <div style={chapter}>
        <div style={inner}>
          <div style={eyebrow}>Distinctions</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "clamp(48px, 8vw, 96px)" }} className="palonur-explainer-grid">
            
            <div>
              <h2 style={{ ...h3, fontSize: "clamp(22px, 2.5vw, 28px)" }}>Palonur is not an AI model</h2>
              <p style={body}>
                Palonur does not replace ChatGPT, Claude, Gemini, or other AI models. It provides trusted knowledge <strong>to</strong> AI systems.
              </p>
              <p style={body}>
                A general-purpose model supplies the language and reasoning capabilities. Palonur supplies the governed expert knowledge that the model is allowed to use. This separation allows different AI models and applications to access the same authoritative source of truth without requiring that source material to become part of the models themselves.
              </p>
            </div>

            <div>
              <h2 style={{ ...h3, fontSize: "clamp(22px, 2.5vw, 28px)" }}>Palonur is more than RAG</h2>
              <p style={body}>
                Retrieval-augmented generation, or RAG, allows an AI system to retrieve information before producing an answer. Palonur adds a governance layer around the knowledge itself.
              </p>
              <p style={body}>
                Who has authority over this knowledge? Which material has been approved? Who should receive attribution? Which version is current? Where may the knowledge be used? Can it be licensed? Palonur treats expert knowledge as a governed resource rather than simply a collection of documents to retrieve.
              </p>
            </div>

          </div>
        </div>
      </div>

      {/* ─── AI access does not mean AI training ───────────────────────── */}
      <div style={chapter}>
        <div style={{ ...inner, maxWidth: 820 }}>
          <div style={eyebrow}>Inference Policy</div>
          <h2 style={h3}>AI access does not mean AI training</h2>
          <p style={body}>
              One of Palonur's core distinctions is between <strong>using knowledge to answer a question</strong> and <strong>using knowledge to train an AI model</strong>. Palonur supports the first, not the second.
          </p>
          <p style={body}>
            With Palonur, an AI application can receive the relevant approved information needed to answer a specific question while the underlying corpus remains governed by its owner.
          </p>
          <div style={{ background: "#fff", borderLeft: `3px solid ${RED}`, padding: "20px 24px", margin: "32px 0" }} data-testid="text-what-is-inference-only-policy">
            <p style={{ ...body, margin: 0, color: INK }}>
              Approved excerpts are sent to the model provider for <strong>inference only</strong> under a contractual no-training policy. The policy is contractual, not a technical mechanism that can prevent every downstream use.
            </p>
          </div>
          <p style={body}>
            This clear distinction allows experts and institutions to participate in AI distribution without automatically surrendering their knowledge to model training.
          </p>
            <p style={{ ...body, fontSize: 14, color: MUTED, marginTop: 16 }}>
             For details on usage, provider boundaries, and permissions, review our <Link href="/agent-license" style={{ color: INK, textDecoration: "underline" }} data-testid="link-agent-license">Agent License</Link> and <Link href="/privacy" style={{ color: INK, textDecoration: "underline" }} data-testid="link-privacy-policy">Privacy Policy</Link>.
          </p>
        </div>
      </div>

      {/* ─── Audience & Example ────────────────────────────────────────── */}
      <div style={chapter}>
        <div style={inner}>
          <div style={eyebrow}>Use Cases</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "clamp(48px, 8vw, 96px)" }} className="palonur-explainer-grid">
            
            <div>
              <h2 style={h3}>Who is Palonur for?</h2>
              <p style={body}>
                Palonur is designed for organizations and individuals whose knowledge has value because its source matters. Examples include:
              </p>
              <ul style={{ ...body, margin: "0 0 24px 24px", padding: 0 }}>
                <li style={{ marginBottom: 12 }}><strong>Universities and research institutions</strong><br/><span style={{ color: MUTED }}>Make institutional expertise available through AI while retaining governance.</span></li>
                <li style={{ marginBottom: 12 }}><strong>Faculty and researchers</strong><br/><span style={{ color: MUTED }}>Extend access to their work while preserving attribution and control.</span></li>
                <li style={{ marginBottom: 12 }}><strong>Expert organizations</strong><br/><span style={{ color: MUTED }}>Create AI experiences grounded in approved professional knowledge.</span></li>
                <li style={{ marginBottom: 12 }}><strong>Authors and knowledge owners</strong><br/><span style={{ color: MUTED }}>Make proprietary expertise usable through AI under defined permissions.</span></li>
                <li style={{ marginBottom: 12 }}><strong>AI developers and agents</strong><br/><span style={{ color: MUTED }}>Access governed expert knowledge rather than relying exclusively on information learned during model training or retrieved from the open web.</span></li>
              </ul>
            </div>

            <div>
              <h2 style={h3}>Example: Ask Lifestyle Medicine</h2>
              <p style={body}>
                Ask Lifestyle Medicine is an application built on the Palonur knowledge layer. It allows people to ask questions using a governed body of published research and expert knowledge from Stanford Lifestyle Medicine faculty.
              </p>
              <p style={body}>
                The application demonstrates the distinction between the two layers:
              </p>
              <ul style={{ ...body, margin: "0 0 24px 24px", padding: 0 }}>
                <li style={{ marginBottom: 12 }}>Stanford Lifestyle Medicine faculty and their published work provide the expertise.</li>
                <li style={{ marginBottom: 12 }}>Palonur governs and delivers that expertise to the AI experience.</li>
                <li style={{ marginBottom: 12 }}>The AI provides the interface through which people can ask questions.</li>
              </ul>
              <p style={body}>
                Palonur itself is not limited to lifestyle medicine or healthcare. The same infrastructure can be used wherever authoritative knowledge needs to be made available to AI systems under explicit governance.
              </p>
            </div>

          </div>
        </div>
      </div>

      {/* ─── Why Palonur exists ────────────────────────────────────────── */}
      <div style={{ ...chapter, background: INK, color: "#fff", borderBottom: "none" }}>
        <div style={inner}>
          <div style={{ ...eyebrow, color: RED }}>Our Purpose</div>
          <h2 style={{ ...h3, color: "#fff" }}>Why Palonur exists</h2>
          <p style={{ ...body, color: "rgba(255,255,255,0.85)" }}>
            AI has made access to information nearly unlimited. It has not solved a more difficult problem: <strong>Who should an AI system trust?</strong>
          </p>
          <p style={{ ...body, color: "rgba(255,255,255,0.85)" }}>
            The most valuable knowledge in many fields does not belong anonymously to the internet. It belongs to researchers, universities, authors, institutions, and experts who created it.
          </p>
          <p style={{ ...body, color: "rgba(255,255,255,0.85)" }}>
            Palonur provides infrastructure for that knowledge to participate in the AI ecosystem without losing its identity, governance, or ownership conditions.
          </p>
          <p style={{ ...body, color: "rgba(255,255,255,0.85)", fontStyle: "italic", fontSize: "clamp(20px, 2vw, 24px)", margin: "40px 0 0" }}>
            The goal is not to put every piece of expert knowledge inside an AI model. The goal is to let AI systems reach trusted knowledge when they need it.
          </p>
        </div>
      </div>

      {/* ─── FAQ ───────────────────────────────────────────────────────── */}
      <div style={chapter}>
        <div style={inner}>
          <div style={eyebrow}>Frequently Asked Questions</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "24px 64px" }} className="palonur-explainer-grid">
            
            <div>
              <div style={faqQ}>What is Palonur?</div>
              <div style={faqA}>
                Palonur is a governed knowledge layer that lets universities, experts, and other knowledge owners make authoritative information available to AI systems while maintaining control over attribution, access, licensing, and updates.
              </div>
            </div>

            <div>
              <div style={faqQ}>Does Palonur train AI models on expert knowledge?</div>
              <div style={faqA}>
                No. Approved excerpts are sent to the model provider for inference only under a contractual no-training policy, separating permission to use knowledge for answering questions from permission to use it for model training.
              </div>
            </div>

            <div>
              <div style={faqQ}>Is Palonur an AI model?</div>
              <div style={faqA}>
                No. Palonur is infrastructure connecting governed expert knowledge with AI models, agents, APIs, and applications.
              </div>
            </div>

            <div>
              <div style={faqQ}>How is Palonur different from RAG?</div>
              <div style={faqA}>
                RAG focuses primarily on retrieving information for an AI model. Palonur adds governance around the knowledge itself, including authority, attribution, permissions, licensing, and versions.
              </div>
            </div>

            <div>
              <div style={faqQ}>Who controls knowledge in Palonur?</div>
              <div style={faqA}>
                The relevant knowledge owner or steward controls which material is approved and how it may be used.
              </div>
            </div>

            <div>
              <div style={faqQ}>Can Palonur work with different AI models?</div>
              <div style={faqA}>
                Yes. Palonur is designed as a knowledge layer rather than as a replacement for the underlying AI model.
              </div>
            </div>

            <div>
              <div style={faqQ}>Can Palonur be used outside healthcare?</div>
              <div style={faqA}>
                Yes. Palonur is designed for any field in which the identity, authority, provenance, and governance of knowledge matter.
              </div>
            </div>

          </div>
        </div>
      </div>

      <div style={{ flexGrow: 1 }} />
      <SiteFooter />
    </div>
  );
}
