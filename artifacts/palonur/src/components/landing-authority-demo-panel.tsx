import { useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  LandingAuthorityDemo,
  LandingFollowUp,
} from "@/lib/landing-authority-demo";

type LandingDemoStatus = "searching" | "analyzing" | "complete" | "error";

export function LandingAuthorityDemoPanel({
  status,
  question,
  result,
  error,
  followUps,
  followUpStatus,
  followUpError,
  onFollowUp,
  onReset,
}: {
  status: LandingDemoStatus;
  searchIndex: number;
  question: string;
  result: LandingAuthorityDemo | null;
  error: string;
  followUps: LandingFollowUp[];
  followUpStatus: "idle" | "loading";
  followUpError: string;
  onFollowUp: (question: string) => Promise<void>;
  onReset: () => void;
}) {
  const { t } = useTranslation("home");
  const [followUpQuestion, setFollowUpQuestion] = useState("");
  const SANS =
    "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif";
  const SERIF = "'Georgia','Times New Roman',serif";
  const RED = "#B3261E";
  const INK = "#15111B";
  const PAPER = "#FFFDF9";
  const isComplete = status === "complete" && result !== null;

  const submitFollowUp = (event: React.FormEvent) => {
    event.preventDefault();
    const nextQuestion = followUpQuestion.trim();
    if (!nextQuestion || followUpStatus === "loading") return;
    setFollowUpQuestion("");
    void onFollowUp(nextQuestion);
  };

  return (
    <section
      aria-live="polite"
      aria-label={t("landingDemo.ariaLabel")}
      data-testid="landing-authority-demo"
      style={{
        width: "min(920px, 100%)",
        maxHeight: "min(72vh, 680px)",
        overflowY: "auto",
        boxSizing: "border-box",
        background: PAPER,
        color: INK,
        borderRadius: 20,
        padding: "clamp(22px, 4vw, 38px)",
        boxShadow: "0 18px 48px rgba(0,0,0,0.32)",
        textAlign: "left",
      }}
    >
      <style>{`
        .landing-demo-chat-grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 210px;
          gap: clamp(28px, 5vw, 54px);
        }
        .landing-demo-side {
          border-left: 1px solid rgba(21,17,27,0.12);
          padding-left: clamp(20px, 3vw, 30px);
        }
        @media (max-width: 680px) {
          .landing-demo-chat-grid {
            grid-template-columns: minmax(0, 1fr);
            gap: 28px;
          }
          .landing-demo-side {
            border-left: 0;
            border-top: 1px solid rgba(21,17,27,0.12);
            padding-left: 0;
            padding-top: 22px;
          }
        }
      `}</style>

      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          marginBottom: 22,
        }}
      >
        <button
          type="button"
          onClick={onReset}
          data-testid="button-landing-demo-reset"
          style={{
            border: 0,
            padding: 0,
            background: "transparent",
            color: "rgba(21,17,27,0.62)",
            fontFamily: SANS,
            fontSize: 13,
            fontWeight: 700,
            textDecoration: "underline",
            textUnderlineOffset: 4,
            cursor: "pointer",
          }}
        >
          {t("landingDemo.startOver")}
        </button>
      </div>

      {!isComplete && (
        <div style={{ maxWidth: 620 }}>
          <ChatMessage
            label={t("landingDemo.you")}
            text={question}
            serif={SERIF}
            sans={SANS}
            color={INK}
          />
          <ChatMessage
            label="Palonur"
            text={
              status === "error"
                ? error || t("landingDemo.genericError")
                : t("landingDemo.routing")
            }
            serif={SERIF}
            sans={SANS}
            color={status === "error" ? RED : INK}
          />
        </div>
      )}

      {isComplete && result && (
        <div className="landing-demo-chat-grid">
          <div style={{ minWidth: 0 }}>
            <ChatMessage
              label={t("landingDemo.you")}
              text={result.question}
              serif={SERIF}
              sans={SANS}
              color={INK}
            />
            <ChatMessage
              label="Palonur"
              text={result.response}
              serif={SERIF}
              sans={SANS}
              color={INK}
            />

            {followUps.map((followUp, index) => (
              <div key={`${followUp.question}-${index}`}>
                <ChatMessage
                  label={t("landingDemo.you")}
                  text={followUp.question}
                  serif={SERIF}
                  sans={SANS}
                  color={INK}
                />
                <ChatMessage
                  label="Palonur"
                  text={followUp.answer}
                  serif={SERIF}
                  sans={SANS}
                  color={INK}
                />
              </div>
            ))}

            {followUpStatus === "loading" && (
              <ChatMessage
                label="Palonur"
                text={t("landingDemo.thinking")}
                serif={SERIF}
                sans={SANS}
                color={INK}
              />
            )}

            {followUpError && (
              <p
                role="alert"
                style={{
                  margin: "0 0 18px",
                  fontFamily: SANS,
                  fontSize: 13,
                  lineHeight: 1.45,
                  color: RED,
                }}
              >
                {followUpError}
              </p>
            )}

            {result.authority && (
              <form
                onSubmit={submitFollowUp}
                data-testid="form-landing-demo-follow-up"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  borderTop: "1px solid rgba(21,17,27,0.12)",
                  paddingTop: 18,
                }}
              >
                <input
                  value={followUpQuestion}
                  onChange={(event) => setFollowUpQuestion(event.target.value)}
                  placeholder={t("landingDemo.followUpPlaceholder", {
                    topic: result.topic,
                  })}
                  aria-label={t("landingDemo.followUpLabel")}
                  maxLength={500}
                  disabled={followUpStatus === "loading"}
                  data-testid="input-landing-demo-follow-up"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    border: 0,
                    outline: 0,
                    padding: "8px 0",
                    background: "transparent",
                    color: INK,
                    fontFamily: SANS,
                    fontSize: 15,
                  }}
                />
                <button
                  type="submit"
                  disabled={
                    !followUpQuestion.trim() || followUpStatus === "loading"
                  }
                  data-testid="button-landing-demo-follow-up"
                  style={{
                    border: 0,
                    padding: "8px 0",
                    background: "transparent",
                    color: followUpQuestion.trim()
                      ? RED
                      : "rgba(21,17,27,0.34)",
                    fontFamily: SANS,
                    fontSize: 13,
                    fontWeight: 800,
                    cursor: followUpQuestion.trim()
                      ? "pointer"
                      : "not-allowed",
                  }}
                >
                  {t("landingDemo.ask")}
                </button>
              </form>
            )}
          </div>

          <aside className="landing-demo-side">
            {result.authority ? (
              <>
                <div
                  style={{
                    fontFamily: SANS,
                    fontSize: 10,
                    fontWeight: 800,
                    letterSpacing: ".12em",
                    textTransform: "uppercase",
                    color: RED,
                    marginBottom: 8,
                  }}
                >
                  {t("landingDemo.stewardLabel")}
                </div>
                <div
                  style={{
                    fontFamily: SERIF,
                    fontSize: 20,
                    lineHeight: 1.2,
                    marginBottom: 8,
                  }}
                >
                  {result.authority.name}
                </div>
                <p
                  style={{
                    margin: "0 0 14px",
                    fontFamily: SANS,
                    fontSize: 12.5,
                    lineHeight: 1.45,
                    color: "rgba(21,17,27,0.64)",
                  }}
                >
                  {result.authority.institution}
                  <br />
                  {result.authority.expertise}
                </p>
                <a
                  href={result.authority.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    fontFamily: SANS,
                    fontSize: 12.5,
                    lineHeight: 1.4,
                    color: INK,
                    fontWeight: 700,
                    textDecorationColor: "rgba(179,38,30,0.44)",
                    textUnderlineOffset: 3,
                  }}
                >
                  {result.authority.sourceLabel}
                </a>
                <p
                  style={{
                    margin: "18px 0 0",
                    fontFamily: SANS,
                    fontSize: 11.5,
                    lineHeight: 1.5,
                    color: "rgba(21,17,27,0.55)",
                  }}
                >
                  {result.designationClaim}
                </p>
              </>
            ) : (
              <p
                style={{
                  margin: 0,
                  fontFamily: SANS,
                  fontSize: 12.5,
                  lineHeight: 1.5,
                  color: "rgba(21,17,27,0.62)",
                }}
              >
                {t("landingDemo.noMatch")}
              </p>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}

function ChatMessage({
  label,
  text,
  serif,
  sans,
  color,
}: {
  label: string;
  text: string;
  serif: string;
  sans: string;
  color: string;
}) {
  return (
    <div style={{ marginBottom: 26 }}>
      <div
        style={{
          fontFamily: sans,
          fontSize: 10,
          fontWeight: 800,
          letterSpacing: ".12em",
          textTransform: "uppercase",
          color: "rgba(21,17,27,0.48)",
          marginBottom: 7,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: serif,
          fontSize: "clamp(17px, 2.2vw, 20px)",
          lineHeight: 1.5,
          color,
          whiteSpace: "pre-wrap",
        }}
      >
        {text}
      </div>
    </div>
  );
}