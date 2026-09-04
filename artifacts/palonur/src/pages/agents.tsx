import { useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";

const ENDPOINT = "/api/sleep-agent";
const TOOL_ENDPOINT = "/api/agent/query";
const SPEC_PATH = "/api/agent/spec";
const MONO =
  "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";
const SANS =
  "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif";
const SERIF = "'Georgia','Times New Roman',serif";
const RED = "#B3261E";
const INK = "#0A0A0F";
const PAPER = "#FAF8F4";
const RULE = "rgba(10,10,15,0.12)";
const MUTED = "rgba(10,10,15,0.64)";

const SAMPLE_PROMPTS = [
  "Does scrolling my phone in bed actually wreck my sleep?",
  "Is evening exercise bad for sleep?",
  "What is sleep inertia?",
  "Does melatonin work?",
];

const CURL_EXAMPLE = `curl -N -X POST https://palonur.replit.app/api/sleep-agent \\
  -H "Content-Type: application/json" \\
  -H "X-Palonur-Key: $PALONUR_KEY" \\
  -d '{
    "message": "Does evening light affect sleep?",
    "history": []
  }'

# During the open pilot window, the X-Palonur-Key header is optional
# (rate-limited by IP). Production traffic must send a partner key —
# request one from partners@palonur.com.`;

const TOOL_CURL_EXAMPLE = `# Synchronous JSON — for ChatGPT/Claude tool calls, cron jobs,
# anything that wants one structured object back, not a token stream.
curl -X POST https://palonur.replit.app/api/agent/query \\
  -H "Content-Type: application/json" \\
  -d '{"query": "Why do I wake up at 3am?"}'

# Returns:
# { "answer": "...", "citation": "...", "paper": "...",
#   "finding": "...", "interpretation": "...", "action": "...",
#   "insight": "...", "source": "Palonur Sleep AI · ..." }`;

const SUBSCRIBE_CURL_EXAMPLE = `# Sign a reader up for a steward's newsletter (or the SLM house list).
# Anonymous, idempotent, CORS-open — no key required.
curl -X POST https://palonur.replit.app/api/newsletter/p/sleep/subscribe \\
  -H "Content-Type: application/json" \\
  -d '{"email": "reader@example.com", "name": "Reader"}'

# Returns: { "ok": true } whether the address is new or already subscribed.`;

const RESPONSE_SHAPE = `// Server-Sent Events stream. Each event:
data: {"content": "<text delta>"}

// On completion (provenance lists every approved source the answer
// is grounded in — empty array when the legacy hardcoded corpus is in
// use or when the question was UNCOVERED):
data: {
  "provenance": [
    {
      "source_id": 42,
      "interpretation_id": 17,         // null if grounded in raw paper only
      "chunk_ids": [128, 129],
      "title": "Sensitivity of the human circadian pacemaker…",
      "authors": "Zeitzer JM, Dijk DJ, Kronauer RE, Brown EN, Czeisler CA",
      "year": 2000,
      "journal": "J Physiol",
      "doi": "10.1111/j.1469-7793.2000.t01-1-00695.x",
      "source_url": null,
      "pillar_slug": "sleep"
    }
  ],
  "done": true
}

// On error:
data: {"error": "<message>"}

// On personal-help intent (no AI call made):
data: {"suggest_premium": true, "done": true}`;

const MCP_ENDPOINT = "/api/mcp";
const MCP_MANIFEST_PATH = "/.well-known/mcp.json";
const LLMS_TXT_PATH = "/llms.txt";

const MCP_CALL_EXAMPLE = `# Model Context Protocol — JSON-RPC 2.0 over Streamable HTTP.
# List the tools:
curl -X POST https://palonur.replit.app/api/mcp \\
  -H "Content-Type: application/json" \\
  -H "X-Palonur-Key: $PALONUR_KEY" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Ask a governed question (full citations + provenance come back):
curl -X POST https://palonur.replit.app/api/mcp \\
  -H "Content-Type: application/json" \\
  -H "X-Palonur-Key: $PALONUR_KEY" \\
  -d '{
    "jsonrpc": "2.0", "id": 2, "method": "tools/call",
    "params": {
      "name": "ask_palonur",
      "arguments": { "question": "Does morning light shift my circadian phase?" }
    }
  }'

# Without a valid key the server refuses with 401 (or 402 if unpaid).`;

const STRUCTURED_OUTPUT = `ANSWER:        <one-sentence answer>
CITATION:      <author> et al. <year> · <journal>
PAPER:         <full paper title>
FINDING:       <specific finding the answer rests on>
INTERPRETATION:<plain-language reading for the user>

// Refusal modes (instead of the above):
REFUSE: <off-topic — not a sleep question>
UNCOVERED: <sleep question, but outside the Stanford corpus>`;

export default function Agents() {
  const { t } = useTranslation("agents");
  const [q, setQ] = useState("");
  const [out, setOut] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (message: string) => {
      if (!message.trim() || streaming) return;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setOut("");
      setErr(null);
      setStreaming(true);
      try {
        const r = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, history: [] }),
          signal: ac.signal,
        });
        if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const s of parts) {
            if (!s.startsWith("data:")) continue;
            try {
              const j = JSON.parse(s.slice(5).trim());
              if (j.content) setOut((p) => p + j.content);
              if (j.error) setErr(String(j.error));
              if (j.suggest_premium) {
                setOut(
                  (p) =>
                    p +
                    "\n[server returned suggest_premium=true — no model call made]",
                );
              }
            } catch {
              /* swallow */
            }
          }
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          setErr((e as Error).message);
        }
      } finally {
        setStreaming(false);
      }
    },
    [streaming],
  );

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    run(q);
  };

  return (
    <main
      style={{
        minHeight: "100vh",
        background: PAPER,
        color: INK,
        fontFamily: SANS,
        padding: "60px 20px 100px",
      }}
    >
      <div style={{ maxWidth: 880, margin: "0 auto" }}>
        <a
          href={import.meta.env.BASE_URL}
          style={{
            color: RED,
            textDecoration: "none",
            fontSize: 12,
            letterSpacing: ".18em",
            textTransform: "uppercase",
            fontWeight: 700,
          }}
        >
          ← Palonur
        </a>

        {/* Headline */}
        <div
          style={{
            marginTop: 36,
            marginBottom: 8,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: ".22em",
            textTransform: "uppercase",
            color: RED,
          }}
        >
          {t("title")}
        </div>
        <h1
          style={{
            margin: "0 0 18px",
            fontFamily: SERIF,
            fontWeight: 500,
            fontSize: "clamp(36px, 5.4vw, 56px)",
            lineHeight: 1.1,
            letterSpacing: "-0.018em",
            color: INK,
          }}
        >
          {t("headline")}
        </h1>
        <p
          style={{
            margin: "0 0 16px",
            maxWidth: 640,
            fontFamily: SERIF,
            fontSize: 18,
            lineHeight: 1.6,
            color: "rgba(10,10,15,0.72)",
          }}
        >
          {t("body1")}
        </p>
        <p
          style={{
            margin: "0 0 16px",
            maxWidth: 640,
            fontFamily: SERIF,
            fontSize: 14,
            lineHeight: 1.6,
            color: MUTED,
          }}
        >
          {t("body2")}{" "}
          <a
            href={`${import.meta.env.BASE_URL}platforms#integration`}
            style={{
              color: RED,
              textDecoration: "none",
              borderBottom: `1px solid ${RED}`,
            }}
          >
            {t("body2Link")}
          </a>
          .
        </p>

        {/* Two endpoints */}
        <div
          style={{
            margin: "0 0 48px",
            padding: "20px 22px",
            border: `1px solid ${RULE}`,
            borderRadius: 14,
            background: "#fff",
            fontFamily: SANS,
            fontSize: 14,
            color: INK,
            lineHeight: 1.55,
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: ".22em",
              textTransform: "uppercase",
              color: RED,
              marginBottom: 10,
            }}
          >
            {t("endpoints.label")}
          </div>
          <div style={{ marginBottom: 8 }}>
            <code style={{ fontFamily: MONO, fontSize: 13, color: INK }}>
              POST {ENDPOINT}
            </code>{" "}
            {t("endpoints.streaming")} <code>provenance</code>{" "}
            {t("endpoints.provenanceTail")}
          </div>
          <div>
            <code style={{ fontFamily: MONO, fontSize: 13, color: INK }}>
              POST {TOOL_ENDPOINT}
            </code>{" "}
            {t("endpoints.sync")}{" "}
            <a
              href={SPEC_PATH}
              style={{
                color: RED,
                textDecoration: "none",
                borderBottom: `1px solid ${RED}`,
              }}
            >
              <code>{SPEC_PATH}</code>
            </a>
            . <strong style={{ color: INK }}>{t("endpoints.headsUp")}</strong>{" "}
            {t("endpoints.syncWarning")} <em>{t("endpoints.notReturn")}</em>{" "}
            {t("endpoints.returnProvenance")}{" "}
            <code>{t("endpoints.provenanceGraph")}</code>{" "}
            {t("endpoints.graphReceipts")} <code>{ENDPOINT}</code>.
          </div>
        </div>

        {/* Live test */}
        <Section label={t("sections.tryIt")}>
          <form
            onSubmit={onSubmit}
            style={{
              display: "flex",
              gap: 8,
              marginBottom: 12,
            }}
          >
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("tryIt.placeholder")}
              disabled={streaming}
              style={{
                flex: 1,
                padding: "14px 18px",
                background: "#fff",
                border: `1px solid ${RULE}`,
                borderRadius: 999,
                color: INK,
                fontFamily: SANS,
                fontSize: 15,
                outline: "none",
              }}
            />
            <button
              type="submit"
              disabled={streaming || !q.trim()}
              style={{
                padding: "0 22px",
                background:
                  streaming || !q.trim() ? "rgba(10,10,15,0.12)" : INK,
                color: streaming || !q.trim() ? "rgba(10,10,15,0.4)" : "#fff",
                border: "none",
                borderRadius: 999,
                fontWeight: 700,
                fontSize: 14,
                cursor: streaming ? "default" : "pointer",
                letterSpacing: "0.01em",
              }}
            >
              {streaming ? t("tryIt.streaming") : t("tryIt.post")}
            </button>
          </form>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              marginBottom: 18,
            }}
          >
            {SAMPLE_PROMPTS.map((p) => (
              <button
                key={p}
                onClick={() => {
                  setQ(p);
                  run(p);
                }}
                disabled={streaming}
                style={{
                  background: "transparent",
                  border: `1px solid ${RULE}`,
                  color: INK,
                  padding: "6px 12px",
                  borderRadius: 999,
                  fontSize: 12,
                  cursor: streaming ? "default" : "pointer",
                  fontFamily: SANS,
                }}
              >
                {p}
              </button>
            ))}
          </div>
          <pre
            style={{
              margin: 0,
              minHeight: 180,
              background: "#fff",
              border: `1px solid ${RULE}`,
              borderRadius: 14,
              padding: 18,
              fontFamily: MONO,
              fontSize: 13,
              lineHeight: 1.55,
              color: "rgba(10,10,15,0.82)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              overflow: "auto",
            }}
          >
            {err
              ? t("tryIt.error", { err })
              : out ||
                (streaming ? t("tryIt.awaiting") : t("tryIt.responseWill"))}
            {streaming && <span style={{ color: RED }}>▍</span>}
          </pre>
        </Section>

        {/* Endpoint */}
        <Section label={t("sections.endpoint")}>
          <Code>{`POST  ${ENDPOINT}\nContent-Type: application/json`}</Code>
        </Section>

        {/* Request */}
        <Section label={t("sections.requestBody")}>
          <Code>{`{
  "message": "Does evening light affect sleep?",
  "history": [
    { "role": "user",      "content": "..." },
    { "role": "assistant", "content": "..." }
  ]
}`}</Code>
          <Note>
            <code>history</code> {t("notes.historyOptional")}
          </Note>
        </Section>

        {/* Response */}
        <Section label={t("sections.response")}>
          <Code>{RESPONSE_SHAPE}</Code>
        </Section>

        {/* Structured output */}
        <Section label={t("sections.structuredOutput")}>
          <p
            style={{
              margin: "0 0 12px",
              fontSize: 14,
              fontFamily: SERIF,
              color: "rgba(10,10,15,0.72)",
              lineHeight: 1.6,
            }}
          >
            {t("notes.structuredBody")}
          </p>
          <Code>{STRUCTURED_OUTPUT}</Code>
        </Section>

        {/* Curl */}
        <Section label={t("sections.curl")}>
          <Code>{CURL_EXAMPLE}</Code>
        </Section>

        {/* Graph receipts */}
        <Section label={t("sections.graphReceipts")}>
          <p
            style={{
              margin: "0 0 12px",
              fontSize: 14,
              fontFamily: SERIF,
              color: "rgba(10,10,15,0.72)",
              lineHeight: 1.6,
            }}
          >
            {t("notes.graphReceiptsIntro")} <code>provenance</code>{" "}
            {t("notes.graphReceiptsMid")} <code>source_id</code>,{" "}
            <code>interpretation_id</code>, <code>chunk_ids</code>,{" "}
            {t("notes.graphReceiptsTail")} <code>pillar_slug</code>{" "}
            {t("notes.graphReceiptsEnd")}
          </p>
          <Code>{`// Final SSE event (after all content deltas):
data: {
  "provenance": [
    {
      "source_id": 42,
      "interpretation_id": 17,         // null = grounded in raw paper only
      "chunk_ids": [128, 129],
      "title": "Sensitivity of the human circadian pacemaker…",
      "authors": "Zeitzer JM, Dijk DJ, Kronauer RE, Brown EN, Czeisler CA",
      "year": 2000, "journal": "J Physiol",
      "doi": "10.1111/j.1469-7793.2000.t01-1-00695.x",
      "pillar_slug": "sleep"
    }
  ],
  // Optional: present when another keyword-routed pillar's approved
  // corpus also cleared the retrieval threshold for this question.
  "done": true
}`}</Code>
          <Note>
            <code>interpretation_id</code> {t("notes.interpretationId")}
          </Note>
        </Section>

        {/* Drop into ChatGPT / Claude */}
        <Section label={t("sections.dropInto")}>
          <p
            style={{
              margin: "0 0 12px",
              fontSize: 14,
              fontFamily: SERIF,
              color: "rgba(10,10,15,0.72)",
              lineHeight: 1.6,
            }}
          >
            {t("notes.dropIntoBody")}
          </p>
          <Code>{`POST  ${TOOL_ENDPOINT}
GET   ${TOOL_ENDPOINT}?q=<question>
GET   ${SPEC_PATH}              // OpenAPI 3.0 spec — paste this URL into ChatGPT/Claude`}</Code>
          <div style={{ height: 10 }} />
          <Code>{TOOL_CURL_EXAMPLE}</Code>
          <Note>
            {t("notes.syncGrounded")} <code>{t("notes.noProvenance")}</code>{" "}
            {t("notes.syncWarning2")} <code>POST {ENDPOINT}</code> {t("and")}.
          </Note>
        </Section>

        {/* MCP server */}
        <Section label={t("sections.mcp")}>
          <p
            style={{
              margin: "0 0 12px",
              fontSize: 14,
              fontFamily: SERIF,
              color: "rgba(10,10,15,0.72)",
              lineHeight: 1.6,
            }}
          >
            {t("notes.mcpIntro")}{" "}
            <strong style={{ color: INK }}>
              JSON-RPC 2.0 over Streamable HTTP
            </strong>{" "}
            {t("notes.mcpExposes")}
          </p>
          <Code>{`POST  ${MCP_ENDPOINT}              // MCP endpoint (JSON-RPC 2.0)
GET   ${MCP_MANIFEST_PATH}   // machine-readable server manifest
GET   ${LLMS_TXT_PATH}                // LLM-readable index of all surfaces

// Tools:
//   ask_palonur(question, pillar?)  — governed answer with full citations + provenance
//   list_pillars()                  — active knowledge pillars (slug + name)`}</Code>
          <div style={{ height: 10 }} />
          <Code>{MCP_CALL_EXAMPLE}</Code>
          <Note>
            <strong style={{ color: INK }}>{t("notes.mcpKey")}</strong>{" "}
            {t("notes.mcpKeyBody")} <code>X-Palonur-Key</code>{" "}
            {t("notes.mcpKeyTail")} <code>401</code> / <code>402</code>.{" "}
            {t("notes.mcpEachTool")}{" "}
            <strong style={{ color: INK }}>{t("notes.noTraining")}</strong>{" "}
            {t("notes.noTrainingTail")} <em>{t("notes.notTechnical")}</em>{" "}
            {t("notes.techGuarantee")} <code>{MCP_MANIFEST_PATH}</code>{" "}
            {t("notes.and")} <code>{LLMS_TXT_PATH}</code>.
          </Note>
        </Section>

        {/* Subscribe a reader */}
        <Section label={t("sections.subscribe")}>
          <p
            style={{
              margin: "0 0 12px",
              fontSize: 14,
              fontFamily: SERIF,
              color: "rgba(10,10,15,0.72)",
              lineHeight: 1.6,
            }}
          >
            {t("subscribeNote.body1")} (<code>/p/&lt;slug&gt;</code>){" "}
            {t("subscribeNote.body2")}
          </p>
          <Code>{`POST  /api/newsletter/p/<slug>/subscribe
Content-Type: application/json

{ "email": "reader@example.com", "name": "Optional Name", "source": "optional-tag" }`}</Code>
          <div style={{ height: 10 }} />
          <Code>{SUBSCRIBE_CURL_EXAMPLE}</Code>
          <Note>
            <strong style={{ color: INK }}>
              {t("subscribeNote.noteIdempotent")}
            </strong>{" "}
            {t("subscribeNote.noteIdempotentBody")}{" "}
            <strong style={{ color: INK }}>
              {t("subscribeNote.noteAnon")}
            </strong>{" "}
            {t("subscribeNote.noteAnonBody")}{" "}
            <strong style={{ color: INK }}>
              {t("subscribeNote.noteRate")}
            </strong>{" "}
            {t("subscribeNote.noteDiscovery")} (
            <code>#palonur-publication-discovery</code>){" "}
            {t("subscribeNote.noteDiscoveryTail")} <code>GET {SPEC_PATH}</code>.
          </Note>
        </Section>

        {/* Footer */}
        <div
          style={{
            marginTop: 64,
            paddingTop: 28,
            borderTop: `1px solid ${RULE}`,
            display: "flex",
            gap: 18,
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 13,
            color: MUTED,
            fontFamily: SANS,
          }}
        >
          <span>{t("footer.tagline")}</span>
          <a
            href="mailto:partners@palonur.com?subject=Palonur%20for%20AI%20agents"
            style={{
              color: INK,
              textDecoration: "none",
              letterSpacing: "0.04em",
              fontWeight: 700,
            }}
          >
            {t("footer.cta")}
          </a>
        </div>
      </div>
    </main>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginBottom: 36 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: ".22em",
          textTransform: "uppercase",
          color: RED,
          marginBottom: 12,
        }}
      >
        {label}
      </div>
      {children}
    </section>
  );
}

function Code({ children }: { children: string }) {
  return (
    <pre
      style={{
        margin: 0,
        background: "#fff",
        border: `1px solid ${RULE}`,
        borderRadius: 14,
        padding: 18,
        fontFamily: MONO,
        fontSize: 13,
        lineHeight: 1.55,
        color: "rgba(10,10,15,0.82)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        overflow: "auto",
      }}
    >
      {children}
    </pre>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        marginTop: 8,
        fontSize: 12,
        fontFamily: SANS,
        color: MUTED,
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}
