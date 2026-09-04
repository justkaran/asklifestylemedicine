import { useEffect, useRef, useState } from "react";
import type { SlmCoachLesson } from "../lib/slm-articles";
import "./slm-coach.css";

export interface CoachSteward {
  pillarSlug: string;
  name: string;
  pillarName: string;
  photoUrl: string | null;
}

export interface VerifiedCoachVideo {
  title: string;
  url: string;
}

export interface SlmCoachProps {
  visitorName: string;
  stewards: CoachSteward[];
  lessons: SlmCoachLesson[];
  videos?: Partial<Record<SlmCoachLesson["id"], VerifiedCoachVideo>>;
  openCompanion?: boolean;
  onAskLesson: (lesson: SlmCoachLesson) => void;
  onBackToFaculty: () => void;
}

type PillarSlug = SlmCoachLesson["pillarSlug"];
type ReflectionValue = "supported" | "explore";
type PillarReflections = Partial<Record<PillarSlug, ReflectionValue>>;

const reflectionOptions: Array<{
  value: ReflectionValue;
  title: string;
  detail: string;
}> = [
  {
    value: "supported",
    title: "This already supports me",
    detail: "It feels like a steady part of my life right now.",
  },
  {
    value: "explore",
    title: "I would like to explore this",
    detail: "It is an area I want to understand or build on.",
  },
];

function displayPillarName(lesson: SlmCoachLesson): string {
  // The product name is the public-facing expression of the social-connection
  // pillar. The canonical slug remains social-connection everywhere else.
  return lesson.pillarName;
}

function reflectionLabel(value: ReflectionValue | undefined): string {
  if (value === "supported") return "A steady support";
  if (value === "explore") return "An area to explore";
  return "Not checked in";
}

const COACH_REFLECTION_KEY = "slm_coach_reflection";
const COACH_COMPANION_KEY = "slm_coach_companion_opt_in";

function readStoredReflections(lessons: SlmCoachLesson[]): PillarReflections {
  try {
    const raw = localStorage.getItem(COACH_REFLECTION_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const validSlugs = new Set(lessons.map((lesson) => lesson.pillarSlug));
    const next: PillarReflections = {};
    for (const [slug, value] of Object.entries(parsed)) {
      if (
        validSlugs.has(slug as PillarSlug) &&
        (value === "supported" || value === "explore")
      ) {
        next[slug as PillarSlug] = value;
      }
    }
    return next;
  } catch {
    return {};
  }
}

function readStoredCompanionChoice(lessons: SlmCoachLesson[]): boolean {
  try {
    return (
      localStorage.getItem(COACH_COMPANION_KEY) === "true" ||
      Object.keys(readStoredReflections(lessons)).length > 0
    );
  } catch {
    return false;
  }
}

function joinPillarNames(lessons: SlmCoachLesson[]): string {
  const names = lessons.map(displayPillarName);
  if (names.length <= 1) return names[0] ?? "these areas";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function polarPoint(
  index: number,
  total: number,
  radius: number,
  center = 150,
) {
  const angle = -Math.PI / 2 + (Math.PI * 2 * index) / total;
  return {
    x: center + Math.cos(angle) * radius,
    y: center + Math.sin(angle) * radius,
  };
}

function pointsForRadius(total: number, radius: number): string {
  return Array.from({ length: total }, (_, index) => {
    const point = polarPoint(index, total, radius);
    return `${point.x},${point.y}`;
  }).join(" ");
}

function StartingPicture({
  lessons,
  reflections,
  onExploreLesson,
  onReset,
}: {
  lessons: SlmCoachLesson[];
  reflections: PillarReflections;
  onExploreLesson: (lesson: SlmCoachLesson) => void;
  onReset: () => void;
}) {
  const completed = lessons.filter(
    (lesson) => reflections[lesson.pillarSlug] !== undefined,
  );
  const summary =
    completed.length === 0
      ? "Nothing has been added yet. Every pillar is unassessed."
      : `${completed.length} of ${lessons.length} pillars have a voluntary check-in.`;

  return (
    <section
      className="slm-coach-picture"
      aria-labelledby="coach-picture-title"
      data-testid="section-coach-starting-picture"
    >
      <div className="slm-coach-picture-heading">
        <div>
          <p className="slm-coach-eyebrow">Your personal reflection</p>
          <h2 id="coach-picture-title">Your starting picture</h2>
        </div>
        {completed.length > 0 && (
          <button
            type="button"
            className="slm-coach-text-button"
            onClick={onReset}
            data-testid="button-reset-coach-reflection"
          >
            Reset reflection
          </button>
        )}
      </div>
      <p className="slm-coach-picture-intro">
        This is a private picture of what you choose to share today. It is not a
        health score, a diagnosis, or a prediction. Pillars you skip stay
        unassessed.
      </p>

      <div className="slm-coach-radar-wrap">
        <figure className="slm-coach-radar">
          <svg
            viewBox="0 0 300 300"
            role="img"
            aria-labelledby="coach-radar-title coach-radar-description"
            data-testid="chart-seven-pillar-radar"
          >
            <title id="coach-radar-title">
              Seven-pillar personal reflection radar
            </title>
            <desc id="coach-radar-description">{summary}</desc>
            {[30, 57, 84, 108].map((radius) => (
              <polygon
                key={radius}
                className="slm-coach-radar-ring"
                points={pointsForRadius(lessons.length, radius)}
              />
            ))}
            {lessons.map((lesson, index) => {
              const outer = polarPoint(index, lessons.length, 108);
              const label = polarPoint(index, lessons.length, 132);
              const value = reflections[lesson.pillarSlug];
              // Every voluntary response has the same visual weight. Color and
              // the adjacent text distinguish the categorical reflection; a
              // radial distance must never imply a lifestyle or health ranking.
              const plotted =
                value === undefined
                  ? null
                  : polarPoint(index, lessons.length, 80);
              return (
                <g key={lesson.pillarSlug}>
                  <line
                    className={`slm-coach-radar-axis ${value === undefined ? "is-unassessed" : ""}`}
                    x1="150"
                    y1="150"
                    x2={outer.x}
                    y2={outer.y}
                  />
                  {plotted && (
                    <>
                      <line
                        className="slm-coach-radar-spoke"
                        x1="150"
                        y1="150"
                        x2={plotted.x}
                        y2={plotted.y}
                      />
                      <circle
                        className={`slm-coach-radar-point is-${value}`}
                        cx={plotted.x}
                        cy={plotted.y}
                        r="5"
                      />
                    </>
                  )}
                  <text
                    className="slm-coach-radar-label"
                    x={label.x}
                    y={label.y}
                    textAnchor={
                      label.x < 132 ? "end" : label.x > 168 ? "start" : "middle"
                    }
                    dominantBaseline="middle"
                  >
                    {displayPillarName(lesson)}
                  </text>
                </g>
              );
            })}
            <circle
              className="slm-coach-radar-center"
              cx="150"
              cy="150"
              r="4"
            />
          </svg>
          <figcaption>{summary}</figcaption>
        </figure>

        <div className="slm-coach-picture-summary" aria-live="polite">
          <p>What this picture reflects</p>
          <ul>
            {lessons.map((lesson) => {
              const value = reflections[lesson.pillarSlug];
              return (
                <li key={lesson.pillarSlug}>
                  <button
                    type="button"
                    onClick={() => onExploreLesson(lesson)}
                    data-testid={`button-picture-lesson-${lesson.pillarSlug}`}
                  >
                    <span>{displayPillarName(lesson)}</span>
                    <strong className={value ? `is-${value}` : ""}>
                      {reflectionLabel(value)}
                    </strong>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}

function ProgressCheckIn({
  visitorName,
  lessons,
  reflections,
}: {
  visitorName: string;
  lessons: SlmCoachLesson[];
  reflections: PillarReflections;
}) {
  const areasToExplore = lessons.filter(
    (lesson) => reflections[lesson.pillarSlug] === "explore",
  );
  const firstName = visitorName.trim().split(/\s+/)[0];
  const focus =
    areasToExplore.length > 0
      ? `You said ${joinPillarNames(areasToExplore)} were areas you wanted to explore. What progress have you noticed there?`
      : "You described all seven pillars as steady supports. What is helping you keep that progress going?";

  return (
    <div
      className="slm-coach-progress-checkin"
      data-testid="section-coach-progress-checkin"
    >
      <p className="slm-coach-eyebrow">Your next check-in</p>
      <h2 id="coach-reflection-title">
        {firstName
          ? `How is your progress going, ${firstName}?`
          : "How is your progress going?"}
      </h2>
      <p className="slm-coach-progress-question">{focus}</p>
      <p className="slm-coach-progress-note">
        There is no score to keep. Just notice what has shifted since your
        starting picture.
      </p>
    </div>
  );
}

function CoachLessonCard({
  lesson,
  video,
  onAsk,
  steward,
}: {
  lesson: SlmCoachLesson;
  video?: VerifiedCoachVideo;
  onAsk: (lesson: SlmCoachLesson) => void;
  steward?: CoachSteward;
}) {
  const [flipped, setFlipped] = useState(false);
  const frontToggleRef = useRef<HTMLElement>(null);
  const sourceRef = useRef<HTMLAnchorElement>(null);
  const previousFlipped = useRef(flipped);
  const titleId = `coach-lesson-${lesson.id}`;

  useEffect(() => {
    if (previousFlipped.current === flipped) return;
    previousFlipped.current = flipped;
    // Keep keyboard focus on the visible face. Without this, flipping from a
    // focused control leaves focus on the now-hidden side of the card.
    const nextFocus = flipped ? sourceRef.current : frontToggleRef.current;
    nextFocus?.focus();
  }, [flipped]);

  const flipWithKeyboard = (
    event: React.KeyboardEvent<HTMLElement>,
    next: boolean,
  ) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setFlipped(next);
    }
  };

  const openCard = () => {
    setFlipped(true);
  };

  return (
    <article
      className={`slm-coach-card ${flipped ? "is-flipped" : ""}`}
      id={`card-coach-lesson-${lesson.id}`}
      aria-labelledby={titleId}
      data-testid={`card-coach-lesson-${lesson.id}`}
    >
      <div className="slm-coach-card-inner">
        <section
          className="slm-coach-card-face slm-coach-card-front"
          aria-hidden={flipped}
          role="button"
          tabIndex={flipped ? -1 : 0}
          aria-label={`Explore ${lesson.title}`}
          onClick={openCard}
          onKeyDown={(event) => flipWithKeyboard(event, true)}
          ref={frontToggleRef}
          data-testid={`button-explore-lesson-${lesson.id}`}
        >
          <div>
            <p className="slm-coach-eyebrow">{lesson.eyebrow}</p>
            <img className="slm-coach-lesson-image" src={lesson.image} alt="" />
            <h3 id={titleId}>{lesson.title}</h3>
            <p>{lesson.front}</p>
          </div>
          <span className="slm-coach-card-toggle">
            Explore this bite of knowledge <span aria-hidden="true">→</span>
          </span>
        </section>

        <section
          className="slm-coach-card-face slm-coach-card-back"
          aria-hidden={!flipped}
        >
          <div>
            <p className="slm-coach-eyebrow">{lesson.pillarName}</p>
            <h3>{lesson.title}</h3>
            <p>{lesson.back}</p>
            {steward && (
              <p className="slm-coach-card-steward">
                Pillar faculty: <strong>{steward.name}</strong>
              </p>
            )}
            <div className="slm-coach-source-block">
              <span>Supporting Stanford Lifestyle Medicine article</span>
              <a
                href={lesson.source.url}
                target="_blank"
                rel="noopener noreferrer"
                ref={sourceRef}
                tabIndex={flipped ? 0 : -1}
                data-testid={`link-lesson-source-${lesson.id}`}
              >
                {lesson.source.title} <span aria-hidden="true">↗</span>
              </a>
            </div>
            {video && (
              <a
                href={video.url}
                target="_blank"
                rel="noopener noreferrer"
                className="slm-coach-video-link"
                tabIndex={flipped ? 0 : -1}
                data-testid={`link-lesson-video-${lesson.id}`}
              >
                Watch verified resource: {video.title}{" "}
                <span aria-hidden="true">↗</span>
              </a>
            )}
          </div>
          <div className="slm-coach-card-actions">
            <button
              type="button"
              className="slm-coach-card-ask"
              onClick={() => onAsk(lesson)}
              tabIndex={flipped ? 0 : -1}
              data-testid={`button-ask-lesson-${lesson.id}`}
            >
              Ask faculty about this
            </button>
            <button
              type="button"
              className="slm-coach-card-toggle ghost"
              onClick={() => setFlipped(false)}
              onKeyDown={(event) => flipWithKeyboard(event, false)}
              tabIndex={flipped ? 0 : -1}
              data-testid={`button-flip-back-${lesson.id}`}
            >
              Back to the bite
            </button>
          </div>
        </section>
      </div>
    </article>
  );
}

export function SlmCoach({
  visitorName,
  stewards,
  lessons,
  videos,
  openCompanion = false,
  onAskLesson,
  onBackToFaculty,
}: SlmCoachProps) {
  const [reflections, setReflections] = useState<PillarReflections>(() =>
    readStoredReflections(lessons),
  );
  const companionOptedIn = openCompanion || readStoredCompanionChoice(lessons);
  const [activeReflectionSlug, setActiveReflectionSlug] =
    useState<PillarSlug | null>(lessons[0]?.pillarSlug ?? null);
  const activeReflectionLesson =
    lessons.find((lesson) => lesson.pillarSlug === activeReflectionSlug) ??
    lessons[0] ??
    null;
  const [focusedLessonId, setFocusedLessonId] = useState<string | null>(null);
  const focusedLesson =
    lessons.find((lesson) => lesson.id === focusedLessonId) ?? null;
  const focusedSteward = focusedLesson
    ? stewards.find(
        (steward) => steward.pillarSlug === focusedLesson.pillarSlug,
      )
    : undefined;
  const reflectionCount = lessons.filter(
    (lesson) => reflections[lesson.pillarSlug] !== undefined,
  ).length;
  const activeReflectionIndex = activeReflectionLesson
    ? lessons.findIndex(
        (lesson) => lesson.pillarSlug === activeReflectionLesson.pillarSlug,
      ) + 1
    : 0;
  const assessmentComplete =
    lessons.length > 0 && reflectionCount === lessons.length;

  const chooseReflection = (value: ReflectionValue) => {
    if (!activeReflectionLesson) return;
    setReflections((current) => ({
      ...current,
      [activeReflectionLesson.pillarSlug]: value,
    }));
    const nextLesson = lessons.find(
      (lesson) =>
        lesson.pillarSlug !== activeReflectionLesson.pillarSlug &&
        reflections[lesson.pillarSlug] === undefined,
    );
    if (nextLesson) setActiveReflectionSlug(nextLesson.pillarSlug);
  };

  const skipReflection = () => {
    if (!activeReflectionLesson) return;
    setReflections((current) => {
      const next = { ...current };
      delete next[activeReflectionLesson.pillarSlug];
      return next;
    });
    const nextLesson = lessons.find(
      (lesson) =>
        lesson.pillarSlug !== activeReflectionLesson.pillarSlug &&
        reflections[lesson.pillarSlug] === undefined,
    );
    if (nextLesson) setActiveReflectionSlug(nextLesson.pillarSlug);
  };

  useEffect(() => {
    try {
      if (Object.keys(reflections).length === 0) {
        localStorage.removeItem(COACH_REFLECTION_KEY);
      } else {
        localStorage.setItem(COACH_REFLECTION_KEY, JSON.stringify(reflections));
      }
    } catch {
      // Private browsing can block localStorage; the current session still works.
    }
  }, [reflections]);

  const exploreLesson = (lesson: SlmCoachLesson) => {
    window.requestAnimationFrame(() => {
      const lessonCard = document.getElementById(
        `card-coach-lesson-${lesson.id}`,
      );
      if (typeof lessonCard?.scrollIntoView !== "function") return;
      lessonCard.scrollIntoView({
        behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)")
          .matches
          ? "auto"
          : "smooth",
        block: "center",
      });
    });
  };

  return (
    <section
      className="slm-coach"
      aria-labelledby="coach-title"
      data-testid="section-slm-coach"
    >
      <div className="slm-coach-topline">
        <button
          type="button"
          onClick={onBackToFaculty}
          className="slm-coach-return"
          data-testid="button-return-to-faculty"
        >
          <span aria-hidden="true">←</span> Ask faculty instead
        </button>
        <span>Stanford Lifestyle Medicine</span>
      </div>

      {false && (
        <div className="slm-coach-hero">
          <div>
            <p className="slm-coach-eyebrow">
              Faculty-reviewed bites of knowledge
            </p>
            <h1 id="coach-title">
              {visitorName
                ? `Explore at your own pace, ${visitorName}.`
                : "Explore Lifestyle Medicine."}
            </h1>
            <p className="slm-coach-intro">
              Browse short, source-backed bites of knowledge across the seven
              pillars. Ask faculty about any bite whenever you want to discuss
              it further.
            </p>
          </div>
          <aside
            className="slm-coach-steward"
            aria-label={
              focusedSteward
                ? `Faculty guide for ${focusedSteward!.pillarName}, ${focusedSteward!.name}`
                : "Faculty-reviewed across seven pillars"
            }
          >
            {focusedSteward?.photoUrl ? (
              <img
                src={focusedSteward!.photoUrl ?? undefined}
                alt={focusedSteward!.name}
              />
            ) : (
              <span className="slm-coach-steward-mark" aria-hidden="true">
                7
              </span>
            )}
            <p>{focusedSteward ? "Guided by" : "Faculty-reviewed"}</p>
            <strong>{focusedSteward?.name ?? "Seven pillars"}</strong>
            <span>
              {focusedSteward?.pillarName ?? "Stanford Lifestyle Medicine"}
            </span>
          </aside>
        </div>
      )}

      {false && companionOptedIn && (
        <>
          <section
            className="slm-coach-reflection"
            aria-labelledby="coach-reflection-title"
          >
            {assessmentComplete ? (
              <ProgressCheckIn
                visitorName={visitorName}
                lessons={lessons}
                reflections={reflections}
              />
            ) : (
              <>
                <div
                  className="slm-coach-reflection-progress"
                  aria-live="polite"
                  data-testid="text-reflection-current-step"
                >
                  <div className="slm-coach-reflection-step">
                    <p className="slm-coach-step">
                      PILLAR {activeReflectionIndex} OF {lessons.length}
                    </p>
                    {activeReflectionLesson && (
                      <strong>
                        Next, we will look at{" "}
                        {displayPillarName(activeReflectionLesson)}.
                      </strong>
                    )}
                  </div>
                  <span>
                    {reflectionCount === lessons.length
                      ? `All ${lessons.length} pillars checked in. You can revisit any pillar.`
                      : `${reflectionCount} / ${lessons.length} checked in. Choose any pillar to revisit.`}
                  </span>
                </div>
                <div className="slm-coach-reflection-layout">
                  <div>
                    <h2 id="coach-reflection-title">What feels true today?</h2>
                    <p>
                      These are your own words for your day, not a measure of
                      how well you are doing. You can revisit any answer.
                    </p>
                    <div
                      className="slm-coach-pillar-picker"
                      role="list"
                      aria-label="Choose a pillar for a voluntary reflection"
                    >
                      {lessons.map((lesson) => {
                        const selected =
                          lesson.pillarSlug ===
                          activeReflectionLesson?.pillarSlug;
                        const value = reflections[lesson.pillarSlug];
                        return (
                          <div key={lesson.pillarSlug} role="listitem">
                            <button
                              type="button"
                              className={`slm-coach-pillar-picker-item ${selected ? "is-active" : ""}`}
                              onClick={() =>
                                setActiveReflectionSlug(lesson.pillarSlug)
                              }
                              aria-pressed={selected}
                              data-testid={`button-reflection-pillar-${lesson.pillarSlug}`}
                            >
                              <span>{displayPillarName(lesson)}</span>
                              <i
                                className={value ? `is-${value}` : ""}
                                aria-label={reflectionLabel(value)}
                              />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {activeReflectionLesson && (
                    <fieldset className="slm-coach-reflection-question">
                      <legend>
                        <span className="slm-coach-reflection-question-kicker">
                          We are looking at
                        </span>
                        <strong>
                          {displayPillarName(activeReflectionLesson)}
                        </strong>
                        <span className="slm-coach-reflection-question-step">
                          Pillar {activeReflectionIndex} of {lessons.length}
                        </span>
                      </legend>
                      <div className="slm-coach-choice-grid">
                        {reflectionOptions.map((choice) => {
                          const selected =
                            reflections[activeReflectionLesson.pillarSlug] ===
                            choice.value;
                          return (
                            <button
                              type="button"
                              key={choice.value}
                              aria-pressed={selected}
                              onClick={() => chooseReflection(choice.value)}
                              className={`slm-coach-choice ${selected ? "is-selected" : ""}`}
                              data-testid={`button-reflection-${activeReflectionLesson.pillarSlug}-${choice.value}`}
                            >
                              <strong>{choice.title}</strong>
                              <span>{choice.detail}</span>
                            </button>
                          );
                        })}
                      </div>
                      <button
                        type="button"
                        className="slm-coach-text-button"
                        onClick={skipReflection}
                        data-testid={`button-reflection-${activeReflectionLesson.pillarSlug}-skip`}
                      >
                        Leave {displayPillarName(activeReflectionLesson)}{" "}
                        unassessed
                      </button>
                    </fieldset>
                  )}
                </div>
              </>
            )}
          </section>

          <StartingPicture
            lessons={lessons}
            reflections={reflections}
            onExploreLesson={exploreLesson}
            onReset={() => setReflections({})}
          />
        </>
      )}

      <section
        className="slm-coach-lessons"
        aria-labelledby="coach-lessons-title"
      >
        <div className="slm-coach-rail-heading">
          <div>
            <p className="slm-coach-eyebrow">
              Source-backed bites of knowledge
            </p>
            <h1 id="coach-title">
              Explore at your own pace{visitorName ? `, ${visitorName}` : ""}.
            </h1>
          </div>
          <p>
            Choose any pillar. Its focused bite of knowledge keeps the
            supporting source on the reverse.
          </p>
        </div>
        <div
          className="slm-coach-lesson-picker"
          aria-label="Lifestyle Medicine bites of knowledge"
        >
          {lessons.map((lesson) => {
            return (
              <div key={lesson.id} className="slm-coach-lesson-picker-item">
                <CoachLessonCard
                  lesson={lesson}
                  video={videos?.[lesson.id]}
                  onAsk={onAskLesson}
                  steward={stewards.find(
                    (steward) => steward.pillarSlug === lesson.pillarSlug,
                  )}
                />
              </div>
            );
          })}
        </div>
      </section>
    </section>
  );
}
