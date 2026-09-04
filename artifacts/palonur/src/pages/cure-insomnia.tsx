import { useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "palonur_cure_insomnia_progress";

type Lesson = {
  day: number;
  title: string;
  badge: string;
  why: string;
  practice: string;
  whatToExpect: string;
};

const LESSONS: Lesson[] = [
  {
    day: 1,
    title: "Sleep is not broken — it's overridden",
    badge: "The three systems",
    why:
      "Three biological systems carry sleep: your circadian rhythm (when you should sleep), your sleep drive (how much pressure to sleep has built up), and your stress-management capacity (whether your nervous system can let go). Stanford's Dr. Fiona Barwick teaches that in most people with insomnia these systems are intact — but worry about sleep overrides them. The first move is not a technique. It is a reframe: your body knows how to sleep. Your job this week is to stop fighting it.",
    practice:
      "Tonight, write one sentence in a notebook: 'Which of the three systems — rhythm, drive, or stress — feels most out of balance for me right now?' Don't answer yet. Just ask.",
    whatToExpect:
      "Many people feel a small relief just naming this. The pressure of 'something is wrong with me' eases.",
  },
  {
    day: 2,
    title: "The bed is for sleep — and nothing else",
    badge: "Bed re-association (stimulus control)",
    why:
      "CBT-I borrows from Pavlov: dogs learned to salivate at a bell because the bell reliably preceded food. Your brain learns the same way. If you spend hours in bed scrolling, watching, working, or lying awake worrying, your brain learns the bed means alertness — not sleep. The single most powerful CBT-I intervention is to retrain that association: bed becomes a cue for sleepiness because nothing else happens there.",
    practice:
      "Tonight: no phone, no laptop, no TV in bed. Reading is the one exception, and only if you're already drowsy. Get into bed only when you feel sleepy — not just because it's bedtime.",
    whatToExpect:
      "The first 2-3 nights can feel awkward. By night 4-5 the bed itself starts to feel sleep-inducing again.",
  },
  {
    day: 3,
    title: "Don't hit snooze",
    badge: "Anchoring the wake signal",
    why:
      "Snoozing fragments the most chemically active sleep of the night. It also weakens your circadian signal — the body learns 'wake time is fuzzy,' which makes it harder to feel sleepy at the right hour the next night. Dr. Barwick is direct: when the alarm goes off, get out of bed. Regardless of how you slept. The disciplined wake time is the single strongest zeitgeber you control.",
    practice:
      "Move your alarm across the room tonight so you have to stand up to silence it. Wake at the same time tomorrow even if last night was bad.",
    whatToExpect:
      "Day 3-4 will likely feel rough. Don't compensate by going to bed earlier — that undermines lesson 4.",
  },
  {
    day: 4,
    title: "Build sleep drive — spend less time in bed",
    badge: "Sleep consolidation (sleep restriction)",
    why:
      "Most people with insomnia spend more time in bed than they actually sleep. The result: thin, fragmented sleep across a long window. CBT-I does the counter-intuitive thing: it shrinks your time in bed for two to three weeks. Less time in bed → more sleep pressure → faster sleep onset → fewer awakenings. Once sleep quality is solid, the window is gradually extended again. This is the technique most people skip and most people benefit from most.",
    practice:
      "Pick a 7-hour window for this week (e.g. 11:30pm-6:30am). Don't get into bed before the start. Get out at the end. Hold the window for 7 nights.",
    whatToExpect:
      "First 3 nights you may feel tired during the day. By night 5-6 you should be falling asleep faster and waking less.",
  },
  {
    day: 5,
    title: "What to do when you're awake at 3am",
    badge: "The middle-of-night protocol",
    why:
      "Sleep drive is high at the start of the night — high enough to overcome stress. By 3-4am, drive has discharged. If you wake up then and your stress system fires, the rational brain is offline and emotional thoughts run unchecked. The protocol is precise: do not check the time. Take slow breaths. Notice the softness of the pillow, the weight of the blanket. If you've been awake more than 20-30 minutes, get out of bed, sit somewhere dimly lit, read until sleepy, then return.",
    practice:
      "Tonight before bed, mentally rehearse the protocol once: 'If I wake, I won't check the time. I'll breathe. After 20 minutes I'll get up.' Decide which room and which book in advance.",
    whatToExpect:
      "Rehearsing reduces the panic of the first wake-up. Most people only have to use the get-up step once or twice before the brain re-learns.",
  },
  {
    day: 6,
    title: "Sleep is a 24-hour endeavor",
    badge: "Daytime stress regulation",
    why:
      "If you only manage stress in the hour before bed, you're managing the wrong hour. Stanford's view: people who sleep poorly are usually under-regulated all day. The cortisol you bank during the day is what shows up to argue with you at 3am. Movement, breath, mindfulness, sunlight, and ordinary recovery practices throughout the day are sleep practices — even though they happen 12 hours before bed.",
    practice:
      "Schedule one 5-minute breath break in your calendar today, ideally mid-afternoon. Four seconds in, six seconds out, repeated for five minutes. Then do it again tomorrow.",
    whatToExpect:
      "The midday break has an outsized effect on sleep onset that night. Notice the difference.",
  },
  {
    day: 7,
    title: "Process the day so the night doesn't have to",
    badge: "Evening practice: journaling + loving-kindness",
    why:
      "Dr. Barwick gives two specific evening practices. First, journal: write down what's unresolved from the day, and a single next step for each. This closes open loops the brain would otherwise reopen at 3am. Second, if you're carrying resentment toward someone, do a brief loving-kindness meditation toward them. You're not excusing anyone — you're shifting your own emotional state from anger to ease, which directly affects sleep architecture.",
    practice:
      "Tonight, 30 minutes before bed: 5 minutes of journaling (worries + one next step each), then 2 minutes of silent loving-kindness toward one specific person — even, especially, someone you're frustrated with.",
    whatToExpect:
      "Many people sleep more deeply on journaling nights. The first loving-kindness session may feel forced; do it anyway.",
  },
];

function loadProgress(): Record<number, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveProgress(p: Record<number, boolean>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* noop */
  }
}

export default function CureInsomnia() {
  const [progress, setProgress] = useState<Record<number, boolean>>({});
  const [openDay, setOpenDay] = useState<number | null>(1);

  useEffect(() => {
    const loaded = loadProgress();
    setProgress(loaded);
    const next = LESSONS.find((l) => !loaded[l.day]);
    if (next) setOpenDay(next.day);
  }, []);

  const completed = useMemo(
    () => LESSONS.filter((l) => progress[l.day]).length,
    [progress]
  );
  const pct = Math.round((completed / LESSONS.length) * 100);

  function toggleDone(day: number) {
    const next = { ...progress, [day]: !progress[day] };
    setProgress(next);
    saveProgress(next);
  }

  function reset() {
    setProgress({});
    saveProgress({});
    setOpenDay(1);
  }

  const base = import.meta.env.BASE_URL;

  return (
    <div
      style={{
        minHeight: "100dvh",
        background:
          "radial-gradient(ellipse at top, #1a1a2e 0%, #0a0612 55%, #000000 100%)",
        color: "#fff",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif",
        padding: "48px 20px 80px",
      }}
    >
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        {/* Top nav */}
        <div style={{ marginBottom: 32 }}>
          <a
            href={base}
            style={{
              fontSize: 13,
              color: "rgba(255,255,255,0.55)",
              textDecoration: "none",
              letterSpacing: "0.02em",
            }}
          >
            ← palonur
          </a>
        </div>

        {/* Hero */}
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: ".22em",
            textTransform: "uppercase",
            color: "rgba(201,168,124,0.9)",
            marginBottom: 14,
          }}
        >
          A Free 7-Day Course · Stanford Lifestyle Medicine
        </div>
        <h1
          style={{
            fontSize: "clamp(34px, 5vw, 52px)",
            fontWeight: 700,
            lineHeight: 1.08,
            margin: "0 0 18px",
            fontFamily: "'Georgia','Times New Roman',serif",
            letterSpacing: "-0.015em",
          }}
        >
          Cure Insomnia
        </h1>
        <p
          style={{
            fontSize: "clamp(17px, 1.7vw, 19px)",
            color: "rgba(255,255,255,0.82)",
            lineHeight: 1.6,
            margin: "0 0 22px",
            maxWidth: 640,
          }}
        >
          Seven evenings, seven small practices. Built directly on the
          cognitive-behavioral therapy for insomnia (CBT-I) curriculum taught
          at Stanford by Dr. Fiona Barwick, PhD, DBSM — Clinical Associate
          Professor, Psychiatry & Behavioral Sciences, Sleep Medicine.
        </p>
        <div
          style={{
            fontSize: 13,
            color: "rgba(255,255,255,0.55)",
            lineHeight: 1.6,
            marginBottom: 36,
          }}
        >
          Source:{" "}
          <a
            href="https://lifestylemedicine.stanford.edu/how-to-cure-insomnia/"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#C9A87C", textDecoration: "none" }}
          >
            Stanford Lifestyle Medicine — "How to Cure Insomnia"
          </a>
          . Educational use only. Not medical advice.
        </div>

        {/* Progress */}
        <div
          style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 14,
            padding: "18px 20px",
            marginBottom: 32,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              marginBottom: 10,
            }}
          >
            <div style={{ fontSize: 14, color: "rgba(255,255,255,0.85)" }}>
              {completed} of {LESSONS.length} days complete
            </div>
            {completed > 0 && (
              <button
                onClick={reset}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "rgba(255,255,255,0.4)",
                  fontSize: 12,
                  cursor: "pointer",
                  padding: 0,
                  textDecoration: "underline",
                }}
              >
                Reset
              </button>
            )}
          </div>
          <div
            style={{
              height: 6,
              background: "rgba(255,255,255,0.08)",
              borderRadius: 999,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${pct}%`,
                height: "100%",
                background:
                  "linear-gradient(90deg, #C9A87C 0%, #E8C8A0 100%)",
                transition: "width .35s ease",
              }}
            />
          </div>
        </div>

        {/* Lessons */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {LESSONS.map((lesson) => {
            const isOpen = openDay === lesson.day;
            const isDone = !!progress[lesson.day];
            return (
              <div
                key={lesson.day}
                style={{
                  background: isDone
                    ? "rgba(201,168,124,0.06)"
                    : "rgba(255,255,255,0.03)",
                  border: isDone
                    ? "1px solid rgba(201,168,124,0.35)"
                    : "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 16,
                  overflow: "hidden",
                  transition: "border-color .2s, background .2s",
                }}
              >
                <button
                  onClick={() => setOpenDay(isOpen ? null : lesson.day)}
                  style={{
                    width: "100%",
                    background: "transparent",
                    border: "none",
                    color: "#fff",
                    cursor: "pointer",
                    padding: "20px 22px",
                    display: "flex",
                    alignItems: "center",
                    gap: 16,
                    textAlign: "left",
                    fontFamily: "inherit",
                  }}
                >
                  <div
                    aria-hidden
                    style={{
                      flexShrink: 0,
                      width: 38,
                      height: 38,
                      borderRadius: "50%",
                      border: isDone
                        ? "1.5px solid #C9A87C"
                        : "1.5px solid rgba(255,255,255,0.25)",
                      background: isDone ? "#C9A87C" : "transparent",
                      color: isDone ? "#1a0808" : "rgba(255,255,255,0.7)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontWeight: 700,
                      fontSize: 15,
                    }}
                  >
                    {isDone ? "✓" : lesson.day}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 11,
                        letterSpacing: ".14em",
                        textTransform: "uppercase",
                        color: "rgba(201,168,124,0.85)",
                        marginBottom: 4,
                        fontWeight: 600,
                      }}
                    >
                      Day {lesson.day} · {lesson.badge}
                    </div>
                    <div
                      style={{
                        fontSize: 18,
                        fontWeight: 600,
                        color: "#fff",
                        lineHeight: 1.3,
                      }}
                    >
                      {lesson.title}
                    </div>
                  </div>
                  <div
                    aria-hidden
                    style={{
                      color: "rgba(255,255,255,0.45)",
                      fontSize: 20,
                      transform: isOpen ? "rotate(180deg)" : "rotate(0)",
                      transition: "transform .2s",
                    }}
                  >
                    ⌄
                  </div>
                </button>

                {isOpen && (
                  <div style={{ padding: "0 22px 24px 22px" }}>
                    <Section label="Why">{lesson.why}</Section>
                    <Section label="Practice tonight" gold>
                      {lesson.practice}
                    </Section>
                    <Section label="What to expect">
                      {lesson.whatToExpect}
                    </Section>

                    <button
                      onClick={() => toggleDone(lesson.day)}
                      style={{
                        marginTop: 18,
                        width: "100%",
                        background: isDone
                          ? "rgba(255,255,255,0.06)"
                          : "#C9A87C",
                        color: isDone ? "rgba(255,255,255,0.7)" : "#1a0808",
                        border: isDone
                          ? "1px solid rgba(255,255,255,0.18)"
                          : "none",
                        borderRadius: 10,
                        padding: "14px 18px",
                        fontSize: 15,
                        fontWeight: 600,
                        cursor: "pointer",
                        fontFamily: "inherit",
                      }}
                    >
                      {isDone
                        ? "✓ Marked done — tap to undo"
                        : "Mark Day " + lesson.day + " complete"}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Closing */}
        <div
          style={{
            marginTop: 48,
            padding: "28px 24px",
            background: "rgba(201,168,124,0.07)",
            border: "1px solid rgba(201,168,124,0.3)",
            borderRadius: 16,
          }}
        >
          <div
            style={{
              fontSize: 11,
              letterSpacing: ".16em",
              textTransform: "uppercase",
              color: "rgba(201,168,124,0.9)",
              fontWeight: 700,
              marginBottom: 10,
            }}
          >
            After Day 7
          </div>
          <div
            style={{
              fontSize: 17,
              color: "rgba(255,255,255,0.92)",
              lineHeight: 1.55,
              marginBottom: 18,
            }}
          >
            The course is the foundation. Two ways to keep going:
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <a
              href={`${base}sleep`}
              style={{
                display: "block",
                padding: "14px 18px",
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.18)",
                borderRadius: 10,
                color: "#fff",
                textDecoration: "none",
                fontSize: 15,
              }}
            >
              <strong>Ask a personal question</strong>
              <div
                style={{
                  fontSize: 13,
                  color: "rgba(255,255,255,0.6)",
                  marginTop: 3,
                }}
              >
                Get a Stanford-grounded answer to your specific situation.
              </div>
            </a>
            <a
              href={`${base}journey`}
              style={{
                display: "block",
                padding: "14px 18px",
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.18)",
                borderRadius: 10,
                color: "#fff",
                textDecoration: "none",
                fontSize: 15,
              }}
            >
              <strong>Run a 7-night experiment</strong>
              <div
                style={{
                  fontSize: 13,
                  color: "rgba(255,255,255,0.6)",
                  marginTop: 3,
                }}
              >
                Pick one change and track whether it actually moved your sleep.
              </div>
            </a>
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            marginTop: 36,
            fontSize: 12,
            color: "rgba(255,255,255,0.4)",
            textAlign: "center",
            lineHeight: 1.6,
          }}
        >
          Adapted with attribution from Stanford Lifestyle Medicine. Practices
          attributed to Dr. Fiona Barwick. Palonur · Grounded in Stanford
          sleep science.
        </div>
      </div>
    </div>
  );
}

function Section({
  label,
  children,
  gold,
}: {
  label: string;
  children: React.ReactNode;
  gold?: boolean;
}) {
  return (
    <div style={{ marginTop: 16 }}>
      <div
        style={{
          fontSize: 11,
          letterSpacing: ".14em",
          textTransform: "uppercase",
          color: gold ? "#C9A87C" : "rgba(255,255,255,0.55)",
          fontWeight: 700,
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 16,
          lineHeight: 1.62,
          color: gold ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.82)",
          background: gold ? "rgba(201,168,124,0.08)" : "transparent",
          border: gold ? "1px solid rgba(201,168,124,0.25)" : "none",
          borderRadius: gold ? 10 : 0,
          padding: gold ? "12px 14px" : 0,
        }}
      >
        {children}
      </div>
    </div>
  );
}
