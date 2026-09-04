import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Redirect } from "wouter";
import { fetchJson, useMe, StewardAvatar, PortalShell } from "../App";

interface PillarSteward {
  id: number;
  name: string | null;
  email: string;
  photoUrl: string | null;
  role: string;
}

interface Source {
  id: number;
  title: string;
  kind: "paper" | "slm_article" | "note" | "talk";
  year: number | null;
  journal: string | null;
  doi: string | null;
  sourceUrl: string | null;
  status: "draft" | "in_review" | "approved" | "archived";
  retentionStatus: string;
  assessmentStatus: string | null;
  chunkCount: number;
  uploadedBy: {
    id: number;
    name: string | null;
    email: string;
  } | null;
  updatedAt: string;
}

interface PillarData {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  retiredAt: string | null;
  stewards: PillarSteward[];
  sources: Source[];
}

interface StewardData {
  id: number;
  name: string | null;
  email: string;
  institution: string | null;
  photoUrl: string | null;
  archivedAt: string | null;
  pillars: Array<{
    id: number;
    slug: string;
    name: string;
    role: string;
  }>;
}

interface AdminPillarDataResponse {
  generatedAt: string;
  totals: {
    pillarCount: number;
    stewardCount: number;
    sourceCount: number;
    availableSourceCount: number;
  };
  stewards: StewardData[];
  pillars: PillarData[];
}

export function AdminPillarData() {
  const { data: me, isLoading: meLoading } = useMe();
  const isAdmin = me?.user.isPlatformAdmin;
  const isDataAdmin = me?.user.pillarDataAdmin;
  
  const { data, isLoading: dataLoading, error } = useQuery<AdminPillarDataResponse>({
    queryKey: ["admin-pillar-data"],
    queryFn: () => fetchJson("/api/faculty/admin/pillar-data"),
    enabled: !!me && (isAdmin || isDataAdmin),
  });

  const [search, setSearch] = useState("");

  const filteredPillars = useMemo(() => {
    if (!data) return [];
    if (!search.trim()) return data.pillars;
    const q = search.toLowerCase();
    
    return data.pillars.map(p => {
      const pMatch = p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q);
      const sMatch = p.stewards.some(s =>
        `${s.name ?? ""} ${s.email}`.toLowerCase().includes(q),
      );
      
      const filteredSources = p.sources.filter(s => s.title.toLowerCase().includes(q));
      
      if (pMatch || sMatch) {
        return { ...p, sources: p.sources };
      }
      
      // If only sources match
      if (filteredSources.length > 0) {
        return { ...p, sources: filteredSources };
      }
      
      return null;
    }).filter(Boolean) as PillarData[];
  }, [data, search]);

  const filteredStewardsWithoutPillar = useMemo(() => {
    if (!data) return [];
    return data.stewards.filter(s =>
      s.pillars.length === 0 &&
      (!search.trim() ||
        `${s.name ?? ""} ${s.email}`
          .toLowerCase()
          .includes(search.toLowerCase())),
    );
  }, [data, search]);

  if (meLoading) return null;
  if (!me) return <Redirect to="/sign-in" />;
  if (!isAdmin && !isDataAdmin) return <Redirect to="/dashboard" />;

  return (
    <PortalShell>
      <div data-testid="route-admin-data">
        <div className="mb-8">
          <h1 className="text-3xl font-serif text-[#2E2D29] mb-2">Pillar Data Overview</h1>
          <p className="text-[#5F574F]">
            Knowledge map showing how content is organized, which real sources are currently in the system, and who stewards each pillar.
          </p>
          {me.user.isPlatformAdmin && (
            <a
              href="/admin"
              className="mt-4 inline-flex items-center border border-[#8C1515] px-4 py-2 text-sm font-medium text-[#8C1515] hover:bg-[#8C1515] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8C1515] focus-visible:ring-offset-2"
              data-testid="link-admin-data-manage"
            >
              Manage directory and pillar assignments
            </a>
          )}
        </div>

        {dataLoading ? (
            <div className="animate-pulse flex flex-col gap-6">
              <div className="h-24 bg-[#F4ECDD]"></div>
              <div className="h-64 bg-white border border-[#D5D0C8]"></div>
          </div>
        ) : error ? (
            <div className="bg-[#F8E5E5] border border-[#E8352A] p-6 text-[#E8352A]">
            <h3 className="font-semibold mb-1">Failed to load data</h3>
            <p className="text-sm opacity-90">{error instanceof Error ? error.message : "Unknown error"}</p>
          </div>
        ) : data ? (
          <div className="flex flex-col gap-8">
            {/* Totals */}
            <div 
              className="grid grid-cols-2 md:grid-cols-4 gap-4"
              data-testid="admin-data-totals"
            >
              <div className="bg-[#FBF7F0] border border-[#E8DDD0] p-5">
                <div className="text-sm font-semibold tracking-wider text-[#8C1515] uppercase mb-1">Pillars</div>
                <div className="text-3xl font-serif text-[#2E2D29]">{data.totals.pillarCount}</div>
              </div>
              <div className="bg-[#FBF7F0] border border-[#E8DDD0] p-5">
                <div className="text-sm font-semibold tracking-wider text-[#8C1515] uppercase mb-1">Stewards</div>
                <div className="text-3xl font-serif text-[#2E2D29]">{data.totals.stewardCount}</div>
              </div>
              <div className="bg-white border border-[#D5D0C8] p-5">
                <div className="text-sm font-semibold tracking-wider text-[#5F574F] uppercase mb-1">Total Stored Sources</div>
                <div className="text-3xl font-serif text-[#2E2D29]">{data.totals.sourceCount}</div>
                <p className="text-xs text-[#5F574F] mt-2">Every non-canary source, in every status</p>
              </div>
              <div className="bg-[#F4ECDD] border border-[#D5D0C8] p-5">
                <div className="text-sm font-semibold tracking-wider text-[#2E2D29] uppercase mb-1">Currently Available</div>
                <div className="text-3xl font-serif text-[#2E2D29]">{data.totals.availableSourceCount}</div>
                <p className="text-xs text-[#5F574F] mt-2">Approved for the answer system</p>
              </div>
            </div>

            <section aria-labelledby="steward-directory-heading">
              <div className="mb-4">
                <p className="text-[10px] tracking-[0.3em] text-[#8C1515] uppercase mb-2">
                  People responsible for the knowledge
                </p>
                <h2
                  id="steward-directory-heading"
                  className="font-serif text-2xl text-[#2E2D29]"
                >
                  Steward directory
                </h2>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {data.stewards.map((steward) => (
                  <div
                    key={steward.id}
                    className="flex items-start gap-4 border border-[#D5D0C8] bg-white p-4"
                    data-testid={`admin-data-steward-card-${steward.id}`}
                  >
                    <StewardAvatar
                      name={steward.name}
                      photoUrl={steward.photoUrl}
                      size={48}
                    />
                    <div className="min-w-0">
                      <h3 className="font-medium text-[#2E2D29]">
                        {steward.name || steward.email}
                      </h3>
                      <p className="text-sm text-[#5F574F] break-all">
                        {steward.email}
                      </p>
                      {steward.institution && (
                        <p className="text-sm text-[#5F574F]">
                          {steward.institution}
                        </p>
                      )}
                      <p className="text-xs text-[#8a6a5a] mt-2">
                        {steward.pillars.length > 0
                          ? steward.pillars.map((p) => p.name).join(" · ")
                          : "No pillar currently assigned"}
                        {steward.archivedAt ? " · On leave" : ""}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* Search */}
            <div className="relative">
              <svg className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-[#8a6a5a]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                placeholder="Filter by pillar, steward, or source title..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-12 pr-4 py-3 bg-white border border-[#D5D0C8] text-[#2E2D29] focus:outline-none focus:ring-2 focus:ring-[#8C1515] focus:border-transparent transition placeholder-[#8a6a5a]"
                data-testid="admin-data-search"
              />
            </div>

            {/* Content */}
            <div className="flex flex-col gap-8">
              {filteredPillars.length === 0 && filteredStewardsWithoutPillar.length === 0 ? (
                <div className="text-center py-16 bg-[#FBF7F0] border border-[#E8DDD0]">
                  <p className="text-[#5F574F] font-medium">No results found for "{search}"</p>
                </div>
              ) : (
                <>
                  {filteredPillars.map(pillar => (
                    <section 
                      key={pillar.id}
                      className="bg-white border border-[#D5D0C8] overflow-hidden shadow-sm"
                      data-testid={`admin-data-pillar-section-${pillar.slug}`}
                    >
                      {/* Pillar Header */}
                      <div className="bg-[#FBF7F0] px-6 py-5 border-b border-[#D5D0C8] flex flex-col md:flex-row md:items-start justify-between gap-4">
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <h2 className="text-xl font-serif text-[#2E2D29]">{pillar.name}</h2>
                            {pillar.retiredAt && (
                              <span className="px-2 py-0.5 bg-[#E8DDD0] text-[#5F574F] text-xs font-semibold uppercase tracking-wider rounded">Retired</span>
                            )}
                          </div>
                          <p className="text-sm text-[#8a6a5a]">{pillar.description || "No description available."}</p>
                           {isAdmin && (
                             <a
                               href={`/pillars/${pillar.slug}/library`}
                               className="mt-3 inline-flex items-center border border-[#8C1515] px-3 py-2 text-sm font-medium text-[#8C1515] hover:bg-[#8C1515] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8C1515] focus-visible:ring-offset-2"
                               data-testid={`admin-data-upload-${pillar.slug}`}
                             >
                               Open library and upload
                             </a>
                           )}
                        </div>
                        <div className="flex flex-col gap-2 shrink-0">
                          {pillar.stewards.length === 0 ? (
                            <div className="text-sm text-[#8a6a5a] italic">No active stewards</div>
                          ) : (
                            pillar.stewards.map(st => (
                              <div key={st.id} className="flex items-center gap-3 bg-white px-3 py-2 border border-[#E8DDD0]" data-testid="admin-data-steward-card">
                                <StewardAvatar name={st.name} photoUrl={st.photoUrl} size={32} />
                                <div className="text-sm">
                                  <div className="font-medium text-[#2E2D29]">{st.name || st.email}</div>
                                  <div className="text-[#8a6a5a] text-xs capitalize">{st.role}</div>
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      </div>

                      {/* Source List */}
                      <div className="px-6 py-4">
                        <div className="text-sm font-semibold tracking-wider text-[#5F574F] uppercase mb-4 flex justify-between items-end">
                          <span>Knowledge Sources ({pillar.sources.length})</span>
                          <span className="text-xs text-[#8a6a5a] font-normal normal-case">
                            {pillar.sources.filter(s => s.status === 'approved').length} currently available
                          </span>
                        </div>
                        
                        {pillar.sources.length === 0 ? (
                            <div className="py-8 text-center text-[#8a6a5a] text-sm border-2 border-dashed border-[#E8DDD0]">
                            No sources uploaded for this pillar yet.
                          </div>
                        ) : (
                          <div className="overflow-x-auto">
                            <table className="w-full text-left border-collapse">
                              <thead>
                                <tr className="border-b border-[#D5D0C8] text-xs text-[#8a6a5a] uppercase tracking-wider">
                                  <th className="pb-2 font-medium font-sans">Title</th>
                                  <th className="pb-2 font-medium font-sans w-24">Kind</th>
                                  <th className="pb-2 font-medium font-sans w-20">Year</th>
                                  <th className="pb-2 font-medium font-sans w-28">Status</th>
                                  <th className="pb-2 font-medium font-sans w-24 text-right">Chunks</th>
                                  <th className="pb-2 font-medium font-sans pl-4">Uploaded By</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-[#E8DDD0]/50">
                                {pillar.sources.map(source => (
                                  <tr key={source.id} className="group hover:bg-[#FBF7F0]/50 transition" data-testid="admin-data-source-row">
                                    <td className="py-3 pr-4">
                                      <div className="font-medium text-[#2E2D29] line-clamp-2">
                                        {source.sourceUrl ? (
                                          <a
                                            href={source.sourceUrl}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="underline decoration-[#D5D0C8] underline-offset-2 hover:text-[#8C1515] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8C1515]"
                                          >
                                            {source.title}
                                          </a>
                                        ) : (
                                          source.title
                                        )}
                                      </div>
                                      {source.journal && (
                                        <div className="text-xs text-[#8a6a5a] mt-0.5 truncate">{source.journal}</div>
                                      )}
                                    </td>
                                    <td className="py-3 pr-4">
                                      <span className="inline-block px-2 py-1 bg-[#E8DDD0]/50 text-[#5F574F] text-xs rounded uppercase tracking-wider">
                                        {source.kind.replace('_', ' ')}
                                      </span>
                                    </td>
                                    <td className="py-3 pr-4 text-sm text-[#5F574F]">
                                      {source.year || '—'}
                                    </td>
                                    <td className="py-3 pr-4">
                                      {source.status === 'approved' ? (
                                        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#006600]">
                                          <span className="w-1.5 h-1.5 rounded-full bg-[#006600]"></span>
                                          Available
                                        </span>
                                      ) : source.status === 'draft' ? (
                                        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#8a6a5a]">
                                          <span className="w-1.5 h-1.5 rounded-full bg-[#8a6a5a]"></span>
                                          Draft
                                        </span>
                                      ) : source.status === 'in_review' ? (
                                        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#D47100]">
                                          <span className="w-1.5 h-1.5 rounded-full bg-[#D47100]"></span>
                                          In Review
                                        </span>
                                      ) : (
                                        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#E8352A]">
                                          <span className="w-1.5 h-1.5 rounded-full bg-[#E8352A]"></span>
                                          Archived
                                        </span>
                                      )}
                                    </td>
                                    <td className="py-3 pr-4 text-sm text-[#5F574F] text-right">
                                      {source.chunkCount}
                                    </td>
                                    <td className="py-3 pl-4 text-sm text-[#5F574F]">
                                      {source.uploadedBy ? (
                                        <span title={source.uploadedBy.email}>{source.uploadedBy.name || source.uploadedBy.email}</span>
                                      ) : (
                                        '—'
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    </section>
                  ))}

                  {filteredStewardsWithoutPillar.length > 0 && (
                    <section className="bg-white border border-[#D5D0C8] overflow-hidden shadow-sm p-6">
                      <h2 className="text-xl font-serif text-[#2E2D29] mb-4">Unassigned Stewards</h2>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {filteredStewardsWithoutPillar.map(st => (
                          <div key={st.id} className="flex items-center gap-3 bg-[#FBF7F0] px-4 py-3 border border-[#E8DDD0]" data-testid="admin-data-steward-card">
                            <StewardAvatar name={st.name} photoUrl={st.photoUrl} size={40} />
                            <div className="min-w-0">
                              <div className="font-medium text-[#2E2D29] truncate">{st.name || st.email}</div>
                              {st.institution && <div className="text-[#8a6a5a] text-xs truncate">{st.institution}</div>}
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}
                </>
              )}
            </div>
            
            <div className="text-center text-xs text-[#8a6a5a] mt-4">
              Data generated at {new Date(data.generatedAt).toLocaleString()}
            </div>
          </div>
        ) : null}
      </div>
    </PortalShell>
  );
}
