import { useEffect, useState, useRef } from "react";

const RED = "#8B1A1A";
const INK = "#0a0a0f";
const PAPER = "#FAF8F4";
const MUTED = "rgba(10,10,15,0.62)";
const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "-apple-system, BlinkMacSystemFont, 'Inter', sans-serif";

type Draft = {
  id: number;
  status: string;
  firstName: string | null;
  email: string | null;
  anonymous: boolean;
  goal: string | null;
  hook: string | null;
  struggle: string | null;
  enablement: string | null;
  followUps: Record<string, string>;
  followUpAnswers: Record<string, string>;
  referrer: string | null;
  inviterNote: string | null;
};
type StoryImage = {
  id: number;
  objectPath: string;
  originalName: string | null;
  caption: string | null;
};

const SECTIONS = [
  {
    key: "goal" as const,
    label: "Goal",
    prompt: "What were you hoping to change about your sleep?",
    helper: "The outcome you wanted — better mornings, more energy, less anxiety.",
  },
  {
    key: "hook" as const,
    label: "Hook",
    prompt: "What was the moment you decided something had to give?",
    helper: "A specific night, a wake-up, a remark from someone you love.",
  },
  {
    key: "struggle" as const,
    label: "Struggle",
    prompt: "What got in the way?",
    helper: "Habits, doubts, schedules, the noise of advice that didn't fit.",
  },
  {
    key: "enablement" as const,
    label: "Enablement",
    prompt: "What helped you turn the corner?",
    helper: "A practice, a person, a piece of science that landed.",
  },
];

function setMeta() {
  document.title = "Share your sleep story · Palonur";
  document.body.style.background = PAPER;
}

export default function Share() {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [images, setImages] = useState<StoryImage[]>([]);
  const [step, setStep] = useState(0); // 0..3 PACE, 4 = images+consent
  const [loadingFollow, setLoadingFollow] = useState(false);
  const [consentCopyright, setConsentCopyright] = useState(false);
  const [consentPublish, setConsentPublish] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setMeta();
    return () => { document.body.style.background = ""; };
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const query = params.toString();
    fetch(`/api/stories/intake/draft${query ? `?${query}` : ""}`, { credentials: "include" })
      .then((r) => r.json())
      .then((d) => {
        if (d.draft) {
          setDraft(d.draft);
          setImages(d.images ?? []);
          setFirstName(d.draft.firstName ?? "");
          setEmail(d.draft.email ?? "");
          setAnonymous(!!d.draft.anonymous);
        }
      })
      .catch(() => {});
  }, []);

  function updateLocal(key: keyof Draft, value: any) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }

  async function saveDraft(patch: Partial<Draft>) {
    const r = await fetch("/api/stories/intake/draft", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(patch),
    });
    const d = await r.json();
    if (d.draft) setDraft(d.draft);
  }

  async function requestFollowUp(section: string, answer: string) {
    if (!answer.trim() || answer.trim().length < 25) return;
    if (draft?.followUps?.[section]) return;
    setLoadingFollow(true);
    try {
      const r = await fetch("/api/stories/intake/follow-up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ section, answer }),
      });
      const d = await r.json();
      if (d.followUp) {
        const next = { ...(draft?.followUps ?? {}), [section]: d.followUp };
        await saveDraft({ followUps: next });
      }
    } finally {
      setLoadingFollow(false);
    }
  }

  async function uploadImage(file: File) {
    if (images.length >= 3) return;
    setUploading(true);
    try {
      const meta = await fetch("/api/storage/uploads/request-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
      }).then((r) => r.json());
      if (!meta.uploadURL) throw new Error("no upload url");
      const putRes = await fetch(meta.uploadURL, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!putRes.ok) throw new Error("upload failed");
      const att = await fetch("/api/stories/intake/images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          objectPath: meta.objectPath,
          contentType: file.type,
          originalName: file.name,
        }),
      }).then((r) => r.json());
      if (att.image) setImages((cur) => [...cur, att.image]);
    } catch (e) {
      console.error(e);
      alert("Image upload failed. Please try a smaller file.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function removeImage(id: number) {
    await fetch(`/api/stories/intake/images/${id}`, { method: "DELETE", credentials: "include" });
    setImages((cur) => cur.filter((i) => i.id !== id));
  }

  async function submit() {
    if (!consentCopyright || !consentPublish) {
      setSubmitError("Please tick both consent boxes.");
      return;
    }
    setSubmitError(null);
    setSubmitting(true);
    try {
      const r = await fetch("/api/stories/intake/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          consentCopyright,
          consentPublish,
          anonymous,
          firstName,
          email,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        setSubmitError(d.error ?? "Something went wrong.");
      } else {
        setSubmitted(true);
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div style={{ minHeight: "100vh", background: PAPER, fontFamily: SANS, color: INK }}>
        <div style={{ maxWidth: 640, margin: "0 auto", padding: "120px 24px" }}>
          <div style={{ fontSize: 11, letterSpacing: ".18em", color: RED, fontWeight: 700, textTransform: "uppercase", marginBottom: 14 }}>
            Thank you
          </div>
          <h1 style={{ fontFamily: SERIF, fontSize: 38, fontWeight: 500, lineHeight: 1.2, margin: "0 0 18px" }}>
            Your story is with the editors.
          </h1>
          <p style={{ fontFamily: SERIF, fontSize: 18, lineHeight: 1.6, color: MUTED, margin: 0 }}>
            Amy and the Stanford Lifestyle Medicine team review every submission. If your story is selected for the newsletter, you'll hear from us first.
          </p>
          <p style={{ marginTop: 36 }}>
            <a href="/" style={{ color: RED, textDecoration: "none", fontWeight: 600 }}>← Back to Palonur</a>
          </p>
        </div>
      </div>
    );
  }

  if (!draft) {
    return (
      <div style={{ minHeight: "100vh", background: PAPER, fontFamily: SANS, color: INK, padding: 80, textAlign: "center" }}>
        Loading…
      </div>
    );
  }

  const isPaceStep = step < 4;
  const section = isPaceStep ? SECTIONS[step] : null;
  const value = section ? (draft as any)[section.key] ?? "" : "";
  const followUp = section ? draft.followUps?.[section.key] : undefined;
  const followUpAnswer = section ? draft.followUpAnswers?.[section.key] ?? "" : "";

  function canAdvance() {
    if (!section) return false;
    return (value as string).trim().length >= 25;
  }

  return (
    <div style={{ minHeight: "100vh", background: PAPER, fontFamily: SANS, color: INK }}>
      <div style={{ maxWidth: 680, margin: "0 auto", padding: "60px 22px 100px" }}>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 36 }}>
          <a href="/" style={{ textDecoration: "none", color: INK, fontWeight: 700, letterSpacing: "-0.01em", fontSize: 18 }}>
            Palonur
          </a>
          <div style={{ fontSize: 11, letterSpacing: ".14em", color: MUTED, textTransform: "uppercase" }}>
            Share your story
          </div>
        </div>

        {/* Progress */}
        <div style={{ display: "flex", gap: 6, marginBottom: 36 }}>
          {[0,1,2,3,4].map((i) => (
            <div key={i} style={{
              height: 3, flex: 1, borderRadius: 2,
              background: i <= step ? RED : "rgba(10,10,15,0.10)",
              transition: "background .2s",
            }} />
          ))}
        </div>

        {draft.inviterNote && step === 0 && (
          <div style={{
            background: "rgba(139,26,26,0.04)", border: `1px solid rgba(139,26,26,0.18)`,
            borderRadius: 14, padding: "14px 18px", marginBottom: 28, fontSize: 14, color: INK,
          }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".14em", color: RED, marginBottom: 4 }}>
              A NOTE FROM YOUR INVITER
            </div>
            {draft.inviterNote}
          </div>
        )}

        {isPaceStep && section && (
          <>
            <div style={{ fontSize: 11, letterSpacing: ".18em", color: RED, fontWeight: 700, textTransform: "uppercase", marginBottom: 12 }}>
              {String(step + 1).padStart(2, "0")} · {section.label}
            </div>
            <h1 style={{ fontFamily: SERIF, fontSize: 30, fontWeight: 500, lineHeight: 1.25, margin: "0 0 10px" }}>
              {section.prompt}
            </h1>
            <p style={{ fontFamily: SERIF, fontSize: 17, lineHeight: 1.55, color: MUTED, margin: "0 0 22px" }}>
              {section.helper}
            </p>

            <textarea
              value={value}
              onChange={(e) => updateLocal(section.key, e.target.value)}
              onBlur={() => { saveDraft({ [section.key]: value } as any); }}
              rows={6}
              placeholder="Take your time. A few sentences is plenty."
              style={{
                width: "100%", boxSizing: "border-box",
                fontFamily: SERIF, fontSize: 18, lineHeight: 1.6,
                color: INK, background: "#fff",
                border: "1px solid rgba(10,10,15,0.12)", borderRadius: 14,
                padding: "16px 18px", outline: "none", resize: "vertical",
              }}
            />

            {!followUp && (value as string).trim().length >= 25 && (
              <button
                onClick={() => requestFollowUp(section.key, value as string)}
                disabled={loadingFollow}
                style={{
                  marginTop: 14, background: "transparent", border: `1px solid ${RED}`,
                  color: RED, padding: "8px 14px", borderRadius: 999, fontSize: 13, fontWeight: 600,
                  cursor: loadingFollow ? "default" : "pointer",
                }}
              >
                {loadingFollow ? "Thinking…" : "Want a follow-up question?"}
              </button>
            )}

            {followUp && (
              <div style={{
                marginTop: 22, padding: "16px 18px", borderRadius: 14,
                background: "#fff", borderLeft: `3px solid ${RED}`,
              }}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".14em", color: RED, marginBottom: 6 }}>
                  A FOLLOW-UP
                </div>
                <div style={{ fontFamily: SERIF, fontSize: 17, lineHeight: 1.5, color: INK, marginBottom: 12 }}>
                  {followUp}
                </div>
                <textarea
                  value={followUpAnswer}
                  onChange={(e) => updateLocal("followUpAnswers", { ...(draft.followUpAnswers ?? {}), [section.key]: e.target.value })}
                  onBlur={() => saveDraft({ followUpAnswers: draft.followUpAnswers })}
                  rows={3}
                  placeholder="Optional — add the detail if it helps."
                  style={{
                    width: "100%", boxSizing: "border-box",
                    fontFamily: SERIF, fontSize: 16, lineHeight: 1.55,
                    color: INK, background: PAPER,
                    border: "1px solid rgba(10,10,15,0.10)", borderRadius: 10,
                    padding: "10px 12px", outline: "none", resize: "vertical",
                  }}
                />
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 36 }}>
              <button
                onClick={() => setStep((s) => Math.max(0, s - 1))}
                disabled={step === 0}
                style={{
                  background: "transparent", border: "none", color: step === 0 ? "rgba(0,0,0,0.25)" : INK,
                  fontSize: 14, cursor: step === 0 ? "default" : "pointer", fontWeight: 600,
                }}
              >← Back</button>
              <button
                onClick={() => setStep((s) => s + 1)}
                disabled={!canAdvance()}
                style={{
                  background: canAdvance() ? INK : "rgba(10,10,15,0.18)",
                  color: "#fff", border: "none", borderRadius: 999,
                  padding: "12px 22px", fontSize: 14, fontWeight: 700,
                  cursor: canAdvance() ? "pointer" : "default",
                }}
              >Continue →</button>
            </div>
          </>
        )}

        {!isPaceStep && (
          <>
            <div style={{ fontSize: 11, letterSpacing: ".18em", color: RED, fontWeight: 700, textTransform: "uppercase", marginBottom: 12 }}>
              05 · Images &amp; consent
            </div>
            <h1 style={{ fontFamily: SERIF, fontSize: 30, fontWeight: 500, lineHeight: 1.25, margin: "0 0 10px" }}>
              Add up to three images.
            </h1>
            <p style={{ fontFamily: SERIF, fontSize: 17, lineHeight: 1.55, color: MUTED, margin: "0 0 22px" }}>
              A face, a setting, a memento — anything that grounds the story. Optional.
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 12, marginBottom: 14 }}>
              {images.map((img) => (
                <div key={img.id} style={{ position: "relative", borderRadius: 12, overflow: "hidden", border: "1px solid rgba(10,10,15,0.10)", background: "#fff" }}>
                  <img src={`/api/storage${img.objectPath}`} alt="" style={{ width: "100%", height: 140, objectFit: "cover", display: "block" }} />
                  <button onClick={() => removeImage(img.id)} style={{
                    position: "absolute", top: 6, right: 6,
                    background: "rgba(0,0,0,0.65)", color: "#fff",
                    border: "none", borderRadius: 999, width: 24, height: 24,
                    fontSize: 12, cursor: "pointer",
                  }}>×</button>
                </div>
              ))}
              {images.length < 3 && (
                <label style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  height: 140, border: `1px dashed rgba(10,10,15,0.25)`,
                  borderRadius: 12, cursor: uploading ? "default" : "pointer",
                  color: MUTED, fontSize: 13, fontWeight: 600, background: "#fff",
                }}>
                  {uploading ? "Uploading…" : "+ Add image"}
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    onChange={(e) => e.target.files?.[0] && uploadImage(e.target.files[0])}
                    style={{ display: "none" }}
                    disabled={uploading}
                  />
                </label>
              )}
            </div>

            <div style={{ marginTop: 28, padding: "20px 22px", borderRadius: 14, background: "#fff", border: "1px solid rgba(10,10,15,0.10)" }}>
              <div style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 500, marginBottom: 14 }}>
                How would you like to be credited?
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, cursor: "pointer", fontSize: 14 }}>
                <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />
                Publish anonymously (no name shown)
              </label>
              {!anonymous && (
                <input
                  type="text"
                  placeholder="First name (e.g. Maria)"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  style={{
                    width: "100%", boxSizing: "border-box",
                    padding: "10px 12px", border: "1px solid rgba(10,10,15,0.12)",
                    borderRadius: 10, fontSize: 15, marginBottom: 10, fontFamily: SANS,
                  }}
                />
              )}
              <input
                type="email"
                placeholder="Email (so we can tell you if it runs)"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                style={{
                  width: "100%", boxSizing: "border-box",
                  padding: "10px 12px", border: "1px solid rgba(10,10,15,0.12)",
                  borderRadius: 10, fontSize: 15, fontFamily: SANS,
                }}
              />
            </div>

            <div style={{ marginTop: 22, padding: "20px 22px", borderRadius: 14, background: "rgba(139,26,26,0.04)", border: `1px solid rgba(139,26,26,0.18)` }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".14em", color: RED, marginBottom: 10, textTransform: "uppercase" }}>
                Consent — both required
              </div>
              <label style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 14, cursor: "pointer", fontSize: 14, lineHeight: 1.5 }}>
                <input type="checkbox" checked={consentCopyright} onChange={(e) => setConsentCopyright(e.target.checked)} style={{ marginTop: 4 }} />
                <span>I own the rights to the text and images I'm submitting, and I have permission from anyone identifiable in them.</span>
              </label>
              <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", fontSize: 14, lineHeight: 1.5 }}>
                <input type="checkbox" checked={consentPublish} onChange={(e) => setConsentPublish(e.target.checked)} style={{ marginTop: 4 }} />
                <span>I give Palonur and the Stanford Lifestyle Medicine newsletter permission to edit and publish my story{anonymous ? " anonymously" : firstName ? ` under "${firstName}"` : " under my first name"}.</span>
              </label>
            </div>

            {submitError && (
              <div style={{ marginTop: 14, color: RED, fontSize: 14 }}>{submitError}</div>
            )}

            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 36 }}>
              <button
                onClick={() => setStep((s) => Math.max(0, s - 1))}
                style={{ background: "transparent", border: "none", color: INK, fontSize: 14, cursor: "pointer", fontWeight: 600 }}
              >← Back</button>
              <button
                onClick={submit}
                disabled={submitting || !consentCopyright || !consentPublish}
                style={{
                  background: (consentCopyright && consentPublish && !submitting) ? RED : "rgba(10,10,15,0.18)",
                  color: "#fff", border: "none", borderRadius: 999,
                  padding: "14px 26px", fontSize: 14, fontWeight: 700,
                  cursor: (consentCopyright && consentPublish && !submitting) ? "pointer" : "default",
                }}
              >{submitting ? "Sending…" : "Submit story"}</button>
            </div>
          </>
        )}

      </div>
    </div>
  );
}
