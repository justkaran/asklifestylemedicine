import { useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

type CoachLesson = { id: string; title: string; pillarSlug: string };
type Resource = {
  id: number;
  title: string;
  url: string;
  category: string | null;
  coachLessonId: string | null;
};

const COACH_LESSONS: CoachLesson[] = [
  { id: "sleep-daylight", title: "Notice your mornings", pillarSlug: "sleep" },
  { id: "nutrition-pattern", title: "Start with the pattern", pillarSlug: "nutrition" },
  { id: "movement-walk", title: "Make movement approachable", pillarSlug: "movement" },
  { id: "stress-mindfulness", title: "Make room for a pause", pillarSlug: "stress-management" },
  { id: "connection-relationships", title: "Relationships count", pillarSlug: "social-connection" },
  { id: "cognition-brain-health", title: "Think in connected habits", pillarSlug: "cognitive-enhancement" },
  { id: "purpose-giving-back", title: "Make space for meaning", pillarSlug: "gratitude-purpose" },
];

function isVideo(resource: Resource): boolean {
  return /video/i.test(resource.category ?? "");
}

export function CoachVideoManager({
  fetchJson,
}: {
  fetchJson: <T>(path: string, init?: RequestInit) => Promise<T>;
}) {
  const { slug } = useParams<{ slug: string }>();
  const queryClient = useQueryClient();
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const resourcesQuery = useQuery<{ resources: Resource[] }>({
    queryKey: ["faculty-coach-videos", slug],
    queryFn: () => fetchJson(`/api/faculty/pillars/${slug}/resources`),
  });
  const lessons = useMemo(
    () => COACH_LESSONS.filter((lesson) => lesson.pillarSlug === slug),
    [slug],
  );
  const videos = (resourcesQuery.data?.resources ?? []).filter(isVideo);
  const saveSelection = useMutation({
    mutationFn: ({ lessonId, resourceId }: { lessonId: string; resourceId: number | null }) =>
      fetchJson<{ video: { title: string } | null }>(
        `/api/faculty/pillars/${slug}/coach-lessons/${lessonId}/video`,
        { method: "PUT", body: JSON.stringify({ resourceId }) },
      ),
    onSuccess: (result, variables) => {
      setMessage(
        result.video
          ? `"${result.video.title}" will appear with this lesson.`
          : "The coach video has been cleared.",
      );
      setChoices((current) => {
        const next = { ...current };
        delete next[variables.lessonId];
        return next;
      });
      queryClient.invalidateQueries({ queryKey: ["faculty-coach-videos", slug] });
    },
    onError: (error: Error) => setMessage(`Could not save this choice: ${error.message}`),
  });

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link
        href={`/pillars/${slug}`}
        className="text-sm text-[#8a6a5a] hover:text-[#8C1515]"
      >
        ← Back to pillar
      </Link>
      <p className="mt-6 text-xs font-medium uppercase tracking-[0.2em] text-[#8C1515]">
        Standalone coach
      </p>
      <h1 className="mt-2 font-serif text-4xl text-[#572020]">Coach videos</h1>
      <p className="mt-3 max-w-2xl text-[#8a6a5a]">
        Choose one public resource categorized as Video for each lesson. The
        coach shows only the video selected here. Reclassifying or removing a
        resource takes it out of the coach automatically.
      </p>

      {resourcesQuery.isLoading ? (
        <p className="mt-8 text-[#8a6a5a]">Loading videos…</p>
      ) : resourcesQuery.error ? (
        <p className="mt-8 text-[#E8352A]">{(resourcesQuery.error as Error).message}</p>
      ) : lessons.length === 0 ? (
        <p className="mt-8 rounded-xl border border-[#E8DDD0] bg-white p-5 text-[#8a6a5a]">
          This pillar does not have a standalone coach lesson yet.
        </p>
      ) : (
        <div className="mt-8 space-y-4">
          {lessons.map((lesson) => {
            const assigned = resourcesQuery.data?.resources.find(
              (resource) => resource.coachLessonId === lesson.id,
            );
            const selected = choices[lesson.id] ?? String(assigned?.id ?? "");
            return (
              <section
                key={lesson.id}
                className="rounded-xl border border-[#E8DDD0] bg-white p-5"
                data-testid={`coach-video-lesson-${lesson.id}`}
              >
                <h2 className="font-serif text-xl text-[#572020]">{lesson.title}</h2>
                <label className="mt-4 block text-sm font-medium text-[#572020]">
                  Verified public video
                  <select
                    className="mt-2 block w-full rounded-lg border border-[#D9CBBE] bg-white px-3 py-2 text-[#572020]"
                    value={selected}
                    onChange={(event) =>
                      setChoices((current) => ({
                        ...current,
                        [lesson.id]: event.target.value,
                      }))
                    }
                    data-testid={`select-coach-video-${lesson.id}`}
                  >
                    <option value="">No video action</option>
                    {videos.map((resource) => (
                      <option key={resource.id} value={resource.id}>
                        {resource.title}
                      </option>
                    ))}
                  </select>
                </label>
                {videos.length === 0 && (
                  <p className="mt-2 text-sm text-[#8a6a5a]">
                    Add a public resource categorized as Video before selecting one.
                  </p>
                )}
                <button
                  type="button"
                  className="mt-4 rounded-lg bg-[#8C1515] px-4 py-2 text-sm font-medium text-white hover:bg-[#a01a1a] disabled:opacity-60"
                  disabled={saveSelection.isPending}
                  onClick={() =>
                    saveSelection.mutate({
                      lessonId: lesson.id,
                      resourceId: selected ? Number(selected) : null,
                    })
                  }
                  data-testid={`button-save-coach-video-${lesson.id}`}
                >
                  {saveSelection.isPending ? "Saving…" : "Save video choice"}
                </button>
              </section>
            );
          })}
        </div>
      )}
      {message && (
        <p className="mt-5 text-sm text-[#572020]" role="status">
          {message}
        </p>
      )}
    </main>
  );
}