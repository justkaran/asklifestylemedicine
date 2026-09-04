import { useMemo, useState, type ComponentType, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "wouter";

type FetchJson = <T>(path: string, init?: RequestInit) => Promise<T>;
type Shell = ComponentType<{ children: ReactNode }>;

type Claim = {
  id: number;
  status: "proposed" | "approved" | "archived";
  version: number;
  answer: string;
  interpretation: string;
  tags: string[];
  sourceTitle: string;
  sourceAuthors: string | null;
  sourceYear: number | null;
  authorName: string | null;
  updatedAt: string;
};

type Relationship = {
  id: number;
  fromInterpretationId: number;
  toInterpretationId: number;
  relation: "supports" | "refines" | "qualifies" | "contradicts";
  note: string | null;
};

type KnowledgeVersion = {
  id: number;
  version: number;
  label: string;
  claimCount: number;
  relationCount: number;
  note: string | null;
  publishedAt: string;
};

type KnowledgeData = {
  pillar: { id: number; slug: string; name: string };
  role: string | null;
  canPublish: boolean;
  claims: Claim[];
  relationships: Relationship[];
  versions: KnowledgeVersion[];
};

type AnswerReplay = {
  id: string;
  question: string;
  answerText: string;
  retrievedSourceIds: number[];
  retrievedInterpretationIds: number[];
  topScore: number;
  createdAt: string;
  knowledgeVersionId: number;
  knowledgeVersion: number;
  knowledgeLabel: string;
};

type Snapshot = {
  knowledgeVersion: KnowledgeVersion & {
    snapshot: {
      claims?: Array<{
        interpretationId: number;
        answer: string;
        interpretation: string;
        source?: { title?: string };
      }>;
      relationships?: Array<{
        fromInterpretationId: number;
        toInterpretationId: number;
        relation: string;
      }>;
    };
  };
};

const relationCopy: Record<Relationship["relation"], string> = {
  supports: "supports",
  refines: "refines",
  qualifies: "adds a boundary to",
  contradicts: "contradicts",
};

function statusClass(status: Claim["status"]): string {
  if (status === "approved") return "bg-[#EAF3EC] text-[#2f7d41]";
  if (status === "archived") return "bg-[#F2F0EC] text-[#726B62]";
  return "bg-[#FBF1D7] text-[#84620D]";
}

export function KnowledgeWorkspace({
  fetchJson,
  Shell,
}: {
  fetchJson: FetchJson;
  Shell: Shell;
}) {
  const { slug } = useParams<{ slug: string }>();
  const qc = useQueryClient();
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [relation, setRelation] = useState<Relationship["relation"]>("supports");
  const [note, setNote] = useState("");
  const [versionLabel, setVersionLabel] = useState("");
  const [versionNote, setVersionNote] = useState("");
  const [openVersion, setOpenVersion] = useState<number | null>(null);

  const dataQuery = useQuery<KnowledgeData>({
    queryKey: ["faculty-knowledge", slug],
    queryFn: () => fetchJson(`/api/faculty/pillars/${slug}/knowledge`),
    enabled: !!slug,
  });
  const snapshotQuery = useQuery<Snapshot>({
    queryKey: ["faculty-knowledge-version", slug, openVersion],
    queryFn: () =>
      fetchJson(`/api/faculty/pillars/${slug}/knowledge/versions/${openVersion}`),
    enabled: !!slug && openVersion != null,
  });
  const answersQuery = useQuery<{ answers: AnswerReplay[] }>({
    queryKey: ["faculty-knowledge-answers", slug],
    queryFn: () => fetchJson(`/api/faculty/pillars/${slug}/knowledge/answers`),
    enabled: !!slug,
  });

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["faculty-knowledge", slug] });
  const relationshipMutation = useMutation({
    mutationFn: () =>
      fetchJson(`/api/faculty/pillars/${slug}/knowledge/relationships`, {
        method: "POST",
        body: JSON.stringify({
          fromInterpretationId: Number(fromId),
          toInterpretationId: Number(toId),
          relation,
          note: note.trim() || null,
        }),
      }),
    onSuccess: () => {
      setFromId("");
      setToId("");
      setNote("");
      invalidate();
    },
  });
  const removeMutation = useMutation({
    mutationFn: (id: number) =>
      fetchJson(`/api/faculty/pillars/${slug}/knowledge/relationships/${id}`, {
        method: "DELETE",
      }),
    onSuccess: invalidate,
  });
  const publishMutation = useMutation({
    mutationFn: () =>
      fetchJson(`/api/faculty/pillars/${slug}/knowledge/publish`, {
        method: "POST",
        body: JSON.stringify({
          label: versionLabel.trim() || undefined,
          note: versionNote.trim() || null,
        }),
      }),
    onSuccess: () => {
      setVersionLabel("");
      setVersionNote("");
      invalidate();
    },
  });

  const approvedClaims = useMemo(
    () => (dataQuery.data?.claims ?? []).filter((claim) => claim.status === "approved"),
    [dataQuery.data?.claims],
  );
  const claimById = useMemo(
    () => new Map((dataQuery.data?.claims ?? []).map((claim) => [claim.id, claim])),
    [dataQuery.data?.claims],
  );

  if (dataQuery.isLoading) {
    return <Shell><p className="text-[#8a6a5a]">Loading knowledge workspace…</p></Shell>;
  }
  if (dataQuery.error || !dataQuery.data) {
    return (
      <Shell>
        <p className="text-[#E8352A]">
          {(dataQuery.error as Error | undefined)?.message ?? "Could not load this workspace."}
        </p>
      </Shell>
    );
  }

  const data = dataQuery.data;
  return (
    <Shell>
      <div className="max-w-6xl mx-auto pb-16">
        <Link
          href={`/pillars/${slug}/library`}
          className="text-sm text-[#8C1515] hover:underline"
        >
          ← Back to knowledge library
        </Link>
        <div className="mt-5 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[10px] tracking-[0.24em] uppercase text-[#8C1515] font-semibold">
              Governed knowledge
            </p>
            <h1 className="font-serif text-4xl text-[#572020] mt-2">
              {data.pillar.name} claims
            </h1>
            <p className="mt-3 max-w-2xl text-[#8a6a5a] leading-relaxed">
              Approved interpretations are the atomic claims. Each remains tied to
              its source and faculty review trail; relationships explain how the
              claims fit together.
            </p>
          </div>
          <div className="rounded-xl border border-[#E8DDD0] bg-white/70 px-4 py-3 text-sm">
            <span className="font-medium text-[#572020]">{approvedClaims.length}</span>
            <span className="text-[#8a6a5a]"> approved claims · </span>
            <span className="font-medium text-[#572020]">{data.versions.length}</span>
            <span className="text-[#8a6a5a]"> published versions</span>
          </div>
        </div>

        <section className="mt-10 grid gap-5 lg:grid-cols-[1.35fr_.65fr]">
          <div className="rounded-2xl border border-[#E8DDD0] bg-white/70 p-5">
            <div className="flex items-baseline justify-between gap-4">
              <div>
                <h2 className="font-serif text-2xl">Claims under review</h2>
                <p className="mt-1 text-sm text-[#8a6a5a]">
                  Drafts remain out of every published knowledge version.
                </p>
              </div>
            </div>
            <div className="mt-5 space-y-3">
              {data.claims.map((claim) => (
                <article
                  key={claim.id}
                  className="rounded-xl border border-[#E8DDD0] bg-white p-4"
                  data-testid={`knowledge-claim-${claim.id}`}
                >
                  <div className="flex gap-3 justify-between">
                    <span className={`rounded-full px-2 py-1 text-[10px] uppercase tracking-[.14em] font-semibold ${statusClass(claim.status)}`}>
                      {claim.status}
                    </span>
                    <span className="text-xs text-[#8a6a5a]">claim v{claim.version}</span>
                  </div>
                  <h3 className="mt-3 font-serif text-lg leading-snug text-[#572020]">
                    {claim.answer}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-[#5d5048] line-clamp-3">
                    {claim.interpretation}
                  </p>
                  <p className="mt-3 text-xs text-[#8a6a5a]">
                    Source: <span className="text-[#572020]">{claim.sourceTitle}</span>
                    {claim.sourceYear ? ` (${claim.sourceYear})` : ""}
                    {claim.authorName ? ` · ${claim.authorName}` : ""}
                  </p>
                </article>
              ))}
              {data.claims.length === 0 && (
                <p className="rounded-xl bg-[#FBF1D7] p-4 text-sm text-[#725B37]">
                  This pillar has no claims yet. Approve an interpretation in the
                  knowledge library to make it available here.
                </p>
              )}
            </div>
          </div>

          <aside className="space-y-5">
            <section className="rounded-2xl border border-[#E8DDD0] bg-[#F7F0E5] p-5">
              <h2 className="font-serif text-xl">Publish a version</h2>
              <p className="mt-2 text-sm leading-relaxed text-[#8a6a5a]">
                Publishing takes an immutable snapshot of today’s approved claims
                and mapped relationships. It never changes an earlier version.
              </p>
              {data.canPublish ? (
                <form
                  className="mt-4 space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    publishMutation.mutate();
                  }}
                >
                  <input
                    value={versionLabel}
                    onChange={(event) => setVersionLabel(event.target.value)}
                    placeholder={`e.g. ${data.pillar.name} review`}
                    className="w-full rounded-lg border border-[#DCCDBB] bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#8C1515]/30"
                    aria-label="Knowledge version label"
                  />
                  <textarea
                    value={versionNote}
                    onChange={(event) => setVersionNote(event.target.value)}
                    placeholder="What changed or was reviewed? (optional)"
                    rows={3}
                    className="w-full rounded-lg border border-[#DCCDBB] bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#8C1515]/30"
                  />
                  <button
                    type="submit"
                    disabled={publishMutation.isPending || approvedClaims.length === 0}
                    className="w-full rounded-lg bg-[#8C1515] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#A01A1A] disabled:opacity-50"
                    data-testid="button-publish-knowledge-version"
                  >
                    {publishMutation.isPending ? "Publishing…" : "Publish immutable version"}
                  </button>
                  {publishMutation.error && <p className="text-xs text-[#C33426]">{(publishMutation.error as Error).message}</p>}
                </form>
              ) : (
                <p className="mt-4 rounded-lg bg-white p-3 text-sm text-[#725B37]">
                  You can inspect the evidence and versions. Only this pillar’s
                  steward can publish or edit the claim map.
                </p>
              )}
            </section>

            <section className="rounded-2xl border border-[#E8DDD0] bg-white/70 p-5">
              <h2 className="font-serif text-xl">Published history</h2>
              <div className="mt-3 space-y-2">
                {data.versions.map((version) => (
                  <button
                    type="button"
                    key={version.id}
                    onClick={() => setOpenVersion(version.version)}
                    className="w-full rounded-lg border border-[#E8DDD0] bg-white p-3 text-left hover:border-[#8C1515] focus:outline-none focus:ring-2 focus:ring-[#8C1515]/30"
                    data-testid={`button-open-knowledge-version-${version.version}`}
                  >
                    <span className="block text-sm font-semibold text-[#572020]">{version.label}</span>
                    <span className="mt-1 block text-xs text-[#8a6a5a]">
                      v{version.version} · {version.claimCount} claims · {new Date(version.publishedAt).toLocaleDateString()}
                    </span>
                  </button>
                ))}
                {!data.versions.length && <p className="text-sm text-[#8a6a5a]">No immutable version has been published yet.</p>}
              </div>
            </section>
          </aside>
        </section>

        <section className="mt-5 rounded-2xl border border-[#E8DDD0] bg-white/70 p-5">
          <h2 className="font-serif text-2xl">Relationship map</h2>
          <p className="mt-1 text-sm text-[#8a6a5a]">
            Capture only relationships that help a reviewer understand the
            evidence. Links do not approve a claim or change its source.
          </p>
          {data.canPublish && (
            <form
              className="mt-5 grid gap-3 md:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                relationshipMutation.mutate();
              }}
            >
              <select
                value={fromId}
                onChange={(event) => setFromId(event.target.value)}
                required
                className="rounded-lg border border-[#DCCDBB] bg-white px-3 py-2 text-sm"
                aria-label="First claim"
              >
                <option value="">First approved claim…</option>
                {approvedClaims.map((claim) => <option key={claim.id} value={claim.id}>{claim.answer}</option>)}
              </select>
              <select
                value={toId}
                onChange={(event) => setToId(event.target.value)}
                required
                className="rounded-lg border border-[#DCCDBB] bg-white px-3 py-2 text-sm"
                aria-label="Second claim"
              >
                <option value="">Second approved claim…</option>
                {approvedClaims.map((claim) => <option key={claim.id} value={claim.id}>{claim.answer}</option>)}
              </select>
              <div className="md:col-span-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {(Object.keys(relationCopy) as Relationship["relation"][]).map((type) => (
                  <button
                    type="button"
                    key={type}
                    onClick={() => setRelation(type)}
                    className={`rounded-lg border px-3 py-2 text-sm text-left ${relation === type ? "border-[#8C1515] bg-[#F9E9E8] text-[#8C1515]" : "border-[#E8DDD0] bg-white text-[#5D5048]"}`}
                  >
                    {relationCopy[type]}
                  </button>
                ))}
              </div>
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Why does this relationship matter? (optional)"
                rows={2}
                className="md:col-span-2 rounded-lg border border-[#DCCDBB] bg-white px-3 py-2 text-sm"
              />
              <button
                type="submit"
                disabled={relationshipMutation.isPending || !fromId || !toId || fromId === toId}
                className="md:col-span-2 justify-self-start rounded-lg bg-[#572020] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#6C2929] disabled:opacity-50"
                data-testid="button-save-knowledge-relationship"
              >
                {relationshipMutation.isPending ? "Saving link…" : "Save relationship"}
              </button>
              {relationshipMutation.error && <p className="md:col-span-2 text-xs text-[#C33426]">{(relationshipMutation.error as Error).message}</p>}
            </form>
          )}
          <div className="mt-5 space-y-2">
            {data.relationships.map((edge) => (
              <div key={edge.id} className="flex flex-col gap-2 rounded-xl border border-[#E8DDD0] bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-[#5D5048]">
                  <span className="font-medium text-[#572020]">{claimById.get(edge.fromInterpretationId)?.answer ?? `Claim #${edge.fromInterpretationId}`}</span>
                  {" "}<span className="text-[#8C1515]">{relationCopy[edge.relation]}</span>{" "}
                  <span className="font-medium text-[#572020]">{claimById.get(edge.toInterpretationId)?.answer ?? `Claim #${edge.toInterpretationId}`}</span>
                  {edge.note ? <span className="block mt-1 text-xs text-[#8a6a5a]">{edge.note}</span> : null}
                </p>
                {data.canPublish && (
                  <button
                    type="button"
                    onClick={() => removeMutation.mutate(edge.id)}
                    className="text-xs font-medium text-[#8C1515] hover:underline"
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
            {!data.relationships.length && <p className="text-sm text-[#8a6a5a]">No relationships mapped yet.</p>}
          </div>
        </section>

        <section className="mt-5 rounded-2xl border border-[#E8DDD0] bg-white/70 p-5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-[10px] tracking-[.2em] uppercase text-[#8C1515]">Answer reconstruction</p>
              <h2 className="mt-1 font-serif text-2xl">Version-bound answers</h2>
              <p className="mt-1 text-sm text-[#8a6a5a]">
                Stored outputs are shown as they were delivered. Replaying never calls the model again.
              </p>
            </div>
          </div>
          {answersQuery.isLoading ? <p className="mt-4 text-sm text-[#8a6a5a]">Loading answer history…</p> : null}
          {answersQuery.error ? <p className="mt-4 text-sm text-[#C33426]">{(answersQuery.error as Error).message}</p> : null}
          <div className="mt-4 space-y-3">
            {answersQuery.data?.answers.map((answer) => (
              <article key={answer.id} className="rounded-xl border border-[#E8DDD0] bg-white p-4" data-testid={`knowledge-answer-${answer.id}`}>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs font-semibold uppercase tracking-[.12em] text-[#8C1515]">
                    {answer.knowledgeLabel} · v{answer.knowledgeVersion}
                  </p>
                  <p className="text-xs text-[#8a6a5a]">{new Date(answer.createdAt).toLocaleString()}</p>
                </div>
                <p className="mt-3 font-medium text-[#572020]">Q: {answer.question}</p>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-[#5D5048]">{answer.answerText}</p>
                <p className="mt-3 text-xs text-[#8a6a5a]">
                  Claims #{answer.retrievedInterpretationIds.join(", ") || "none"} · Sources #{answer.retrievedSourceIds.join(", ") || "none"} · Retrieval score {Number(answer.topScore).toFixed(2)}
                </p>
              </article>
            ))}
            {answersQuery.data && answersQuery.data.answers.length === 0 ? (
              <p className="rounded-xl bg-[#F7F0E5] p-4 text-sm text-[#725B37]">
                No answer has used a published version of this pillar yet.
              </p>
            ) : null}
          </div>
        </section>

        {openVersion != null && (
          <section className="mt-5 rounded-2xl border border-[#8C1515]/25 bg-[#FFFDFC] p-5" data-testid="knowledge-version-snapshot">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[10px] tracking-[.2em] uppercase text-[#8C1515]">Immutable snapshot</p>
                <h2 className="mt-1 font-serif text-2xl">
                  {snapshotQuery.data?.knowledgeVersion.label ?? `Version ${openVersion}`}
                </h2>
              </div>
              <button type="button" onClick={() => setOpenVersion(null)} className="text-sm text-[#8C1515] hover:underline">Close</button>
            </div>
            {snapshotQuery.isLoading ? <p className="mt-4 text-sm text-[#8a6a5a]">Loading historical record…</p> : null}
            {snapshotQuery.error ? <p className="mt-4 text-sm text-[#C33426]">{(snapshotQuery.error as Error).message}</p> : null}
            {snapshotQuery.data?.knowledgeVersion.snapshot.claims && (
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {snapshotQuery.data.knowledgeVersion.snapshot.claims.map((claim) => (
                  <article key={claim.interpretationId} className="rounded-xl border border-[#E8DDD0] bg-white p-4">
                    <p className="font-medium text-[#572020]">{claim.answer}</p>
                    <p className="mt-2 text-sm text-[#5D5048] line-clamp-3">{claim.interpretation}</p>
                    {claim.source?.title && <p className="mt-3 text-xs text-[#8a6a5a]">Source snapshot: {claim.source.title}</p>}
                  </article>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </Shell>
  );
}
