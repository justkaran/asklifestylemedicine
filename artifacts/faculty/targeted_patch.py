import re
import sys

def patch_file(filepath):
    with open(filepath, "r") as f:
        content = f.read()

    # 1. LandingLivePillars
    content = content.replace(
        'className="px-6 py-20 border-t border-[#E8DDD0]"',
        'className="px-6 py-20 border-t border-gray-200 bg-white"'
    )
    content = content.replace(
        '<p className="text-[10px] tracking-[0.3em] text-[#8C1515] uppercase mb-4 text-center">',
        '<p className="text-xs font-semibold tracking-wider text-[#8C1515] uppercase mb-4 text-center">'
    )
    content = content.replace(
        '<p className="text-lg text-[#8a6a5a] leading-relaxed text-center max-w-2xl mx-auto mb-14">',
        '<p className="text-lg text-[#544948] leading-relaxed text-center max-w-2xl mx-auto mb-14">'
    )
    content = content.replace(
        'className={`group overflow-hidden rounded-2xl border border-[#E8DDD0] bg-white/50 flex flex-col transition ${',
        'className={`group overflow-hidden border border-gray-200 bg-white flex flex-col transition ${'
    )
    content = content.replace(
        'className="relative h-32 overflow-hidden bg-[#F4ECDD]"',
        'className="relative h-32 overflow-hidden bg-gray-100"'
    )
    content = content.replace(
        'bg-white/85 text-[#8a6a5a]',
        'bg-white text-[#544948] border border-gray-200'
    )
    content = content.replace(
        'text-[10px] tracking-[0.16em] uppercase text-[#8C1515] mb-0.5',
        'text-[11px] font-semibold tracking-wider uppercase text-[#8C1515] mb-1'
    )
    # The text-xl text-[#572020] inside LandingLivePillars
    content = re.sub(
        r'<h3 className="font-serif text-xl text-\[\#572020\]">\s*\{pillar\.name\}\s*</h3>',
        r'<h3 className="font-serif text-xl text-[#2e2d29]">\n                    {pillar.name}\n                  </h3>',
        content
    )
    content = re.sub(
        r'className="text-xs text-\[\#8a6a5a\] mt-1"\s*data-testid={`pillar-steward-\$\{pillar\.slug\}`}',
        r'className="text-xs text-[#544948] mt-1"\n                      data-testid={`pillar-steward-${pillar.slug}`}',
        content
    )

    # 2. Landing
    content = content.replace(
        '<div className="min-h-screen bg-[#FBF7F0] text-[#572020]">',
        '<div className="min-h-screen bg-white text-[#2e2d29]">'
    )
    content = content.replace(
        '<header className="border-b border-[#E8DDD0] px-6 py-4">',
        '<header className="border-b border-gray-200 px-6 py-4">'
    )
    content = content.replace(
        '<img\n              src={FACULTY_LOGO_SRC}\n              alt="Stanford Lifestyle Medicine"\n              className="h-10 w-auto"\n            />',
        '<img\n              src={FACULTY_LOGO_SRC}\n              alt="Stanford Lifestyle Medicine"\n              className="h-12 w-auto"\n            />'
    )
    content = content.replace(
        '<span className="text-[10px] tracking-[0.25em] text-[#8C1515]">\n              FACULTY\n            </span>',
        '<span className="text-xs font-semibold tracking-widest text-[#8C1515] uppercase">\n              FACULTY\n            </span>'
    )
    content = content.replace(
        '<section className="px-6 py-20 md:py-28 bg-gradient-to-b from-[#F9F5EE] to-[#F4ECDD]">',
        '<section className="px-6 py-20 md:py-28 bg-white">'
    )
    content = content.replace(
        '<p className="text-[10px] tracking-[0.3em] text-[#8C1515] uppercase mb-5">\n            Palonur · Faculty Portal\n          </p>',
        '<p className="text-xs font-semibold tracking-widest text-[#8C1515] uppercase mb-5">\n            Stanford Lifestyle Medicine · Faculty Portal\n          </p>'
    )
    content = content.replace(
        'Palonur makes the research you spent a career building the answer\n            people get everywhere they ask: in AI systems',
        'We make the research you spent a career building the answer\n            people get everywhere they ask: in AI systems'
    )
    content = content.replace(
        '<p className="text-lg text-[#8a6a5a] mb-10 leading-relaxed max-w-2xl mx-auto">',
        '<p className="text-lg text-[#544948] mb-10 leading-relaxed max-w-2xl mx-auto">'
    )
    content = content.replace(
        '<p className="mt-4 text-sm text-[#8a6a5a]">',
        '<p className="mt-4 text-sm text-[#544948]">'
    )
    
    # The source of truth
    content = content.replace(
        '<p className="text-[10px] tracking-[0.3em] text-[#8C1515] uppercase mb-4 text-center">\n            The source of truth\n          </p>',
        '<p className="text-xs font-semibold tracking-wider text-[#8C1515] uppercase mb-4 text-center">\n            The source of truth\n          </p>'
    )
    content = content.replace(
        'Those become the canonical answer Palonur gives, so what people and',
        'Those become the canonical answers given, so what people and'
    )
    content = content.replace(
        '<p className="text-lg text-[#8a6a5a] leading-relaxed text-center max-w-2xl mx-auto">',
        '<p className="text-lg text-[#544948] leading-relaxed text-center max-w-2xl mx-auto">'
    )
    content = content.replace(
        'className="rounded-xl border border-[#E8DDD0] bg-[#FBF7F0] p-6"',
        'className="border border-gray-200 bg-gray-50 p-6"'
    )
    content = content.replace(
        '<p className="text-[#8a6a5a] leading-relaxed text-sm">',
        '<p className="text-[#544948] leading-relaxed text-sm">'
    )

    # Reach
    content = content.replace(
        '<p className="text-[10px] tracking-[0.3em] text-[#8C1515] uppercase mb-4 text-center">\n            Your reach\n          </p>',
        '<p className="text-xs font-semibold tracking-wider text-[#8C1515] uppercase mb-4 text-center">\n            Your reach\n          </p>'
    )
    content = content.replace(
        '<p className="text-lg text-[#8a6a5a] leading-relaxed text-center max-w-2xl mx-auto mb-14">',
        '<p className="text-lg text-[#544948] leading-relaxed text-center max-w-2xl mx-auto mb-14">'
    )
    content = content.replace(
        'className="rounded-xl border border-[#E8DDD0] bg-[#FBF7F0] p-7 flex flex-col"',
        'className="border border-gray-200 bg-gray-50 p-7 flex flex-col"'
    )

    # 3. PortalShell visual treatment
    content = content.replace(
        '<header className="border-b border-[#D5D0C8] bg-white px-6 py-4 flex flex-wrap items-center justify-between gap-y-2">',
        '<header className="border-b border-gray-200 bg-white px-6 py-4 flex flex-wrap items-center justify-between gap-y-2">'
    )
    content = content.replace(
        '<span className="text-[11px] font-semibold tracking-[0.2em] text-[#8C1515]">\n            FACULTY\n          </span>',
        '<span className="text-xs font-semibold tracking-widest text-[#8C1515] uppercase">\n            FACULTY\n          </span>'
    )
    # Portal shell image size
    content = re.sub(
        r'<Link href="/dashboard" className="flex items-center gap-3">\n\s*<img\n\s*src=\{FACULTY_LOGO_SRC\}\n\s*alt="Stanford Lifestyle Medicine"\n\s*className="h-10 w-auto"\n\s*/>',
        r'<Link href="/dashboard" className="flex items-center gap-3">\n          <img\n            src={FACULTY_LOGO_SRC}\n            alt="Stanford Lifestyle Medicine"\n            className="h-12 w-auto"\n          />',
        content
    )

    # 4. Remove Palonur as narrator in Dashboard/Onboarding/Welcome
    content = content.replace(
        'Palonur began inside Stanford, and from here we’re inviting experts',
        'This portal began at Stanford, and we’re inviting experts'
    )
    content = content.replace(
        'className="mb-8 rounded-2xl border border-[#E8DDD0] bg-gradient-to-br from-[#F9F5EE] to-[#F4ECDD] px-8 py-7"',
        'className="mb-8 border border-[#8C1515] bg-[#F4ECDD] px-8 py-7"'
    )
    
    # 5. TwoPathsPanel rewrite
    # Using regex to replace the entire TwoPathsPanel component
    two_paths_regex = re.compile(r'function TwoPathsPanel\(\{(.*?)\}\) \{.*?\n\s+return \(\n\s+<section(.*?)</section>\n\s+\);\n\}', re.DOTALL)
    replacement_two_paths = """function TwoPathsPanel({
  pillarSlug,
  multiPillar,
}: {
  pillarSlug: string | null;
  multiPillar: boolean;
}) {
  return (
    <section className="mb-12" data-testid="two-paths-panel">
      <div className="flex items-baseline justify-between border-b border-[#8C1515] pb-2 mb-6">
        <h2 className="font-serif text-2xl text-[#8C1515]">Your Workspace</h2>
      </div>
      
      <div className="grid gap-0 md:grid-cols-2 border-l border-t border-gray-200">
        
        {/* Pillar Management */}
        <Link 
          href={pillarSlug ? `/pillars/${pillarSlug}` : "#your-pillars"}
          className="group flex flex-col justify-between border-r border-b border-gray-200 bg-white p-8 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-[#8C1515] focus:ring-inset"
          data-testid="link-path-knowledge"
        >
          <div>
            <p className="text-[10px] tracking-[0.2em] font-bold text-[#8C1515] uppercase mb-3">Your Pillar</p>
            <h3 className="font-serif text-2xl text-[#2E2D29] mb-3">Manage your knowledge</h3>
            <p className="text-[#544948] leading-relaxed mb-4">
              Curate the sources and approved answers in your pillar — the library the AI draws from.
            </p>
            <p className="text-sm text-[#544948] leading-relaxed mb-6">
              <span className="font-semibold text-[#2E2D29]">Why it matters:</span> you hold the keys. Nothing reaches the public until it is approved, and every answer cites you.
            </p>
          </div>
          <span className="inline-flex items-center text-sm font-bold text-[#8C1515] uppercase tracking-wide group-hover:underline">
            {multiPillar ? "Choose a pillar" : "Open pillar dashboard"} &rarr;
          </span>
        </Link>

        {/* Distribution Channels */}
        <Link 
          href="/newsletter"
          className="group flex flex-col justify-between border-r border-b border-gray-200 bg-white p-8 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-[#8C1515] focus:ring-inset"
          data-testid="link-path-distribution"
        >
          <div>
            <p className="text-[10px] tracking-[0.2em] font-bold text-[#8C1515] uppercase mb-3">Distribution Channels</p>
            <h3 className="font-serif text-2xl text-[#2E2D29] mb-3">Reach readers everywhere</h3>
            <p className="text-[#544948] leading-relaxed mb-4">
              See every place your vetted voice can land — the newsletter, social, and channels coming soon.
            </p>
            <p className="text-sm text-[#544948] leading-relaxed mb-6">
              <span className="font-semibold text-[#2E2D29]">Your reach:</span> distribution is governed by the same approvals. Only what you sign off on is shared.
            </p>
          </div>
          <span className="inline-flex items-center text-sm font-bold text-[#8C1515] uppercase tracking-wide group-hover:underline">
            Open distribution &rarr;
          </span>
        </Link>
        
      </div>
    </section>
  );
}"""
    content = two_paths_regex.sub(replacement_two_paths, content)
    
    # 6. StewardProcesses rewrite
    steward_processes_regex = re.compile(r'function StewardProcesses\(\{(.*?)\}\) \{.*?\n\s+return \(\n\s+<section(.*?)</section>\n\s+\);\n\}', re.DOTALL)
    replacement_steward = """function StewardProcesses({
  slug,
  pillarName,
  isLM,
  aslm = false,
}: {
  slug: string;
  pillarName: string;
  isLM: boolean;
  aslm?: boolean;
}) {
  const uncoveredQuery = useQuery<CoverageDashboardData>({
    queryKey: ["faculty-coverage", slug],
    queryFn: () => fetchJson(`/api/faculty/pillars/${slug}/dashboard`),
    enabled: !aslm,
  });
  const uncoveredCount = uncoveredQuery.data?.totals?.uncovered ?? 0;
  const inboxCount = uncoveredQuery.data?.totals?.flagged ?? 0;

  return (
    <section className="mb-12" data-testid="steward-processes">
      <div className="flex items-baseline justify-between border-b border-[#8C1515] pb-2 mb-6">
        <h2 className="font-serif text-2xl text-[#8C1515]">Your Next Actions</h2>
        <span className="text-sm font-medium tracking-wide text-[#544948] uppercase">{pillarName}</span>
      </div>
      <div className="grid gap-0 border-l border-t border-gray-200">
        
        {/* Review Inbox - Made much easier to discover */}
        {!aslm && (
        <Link 
          href={`/pillars/${slug}/inbox`}
          className="group flex flex-col md:flex-row md:items-center justify-between border-r border-b border-gray-200 bg-white p-6 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-[#8C1515] focus:ring-inset"
          data-testid="link-process-inbox"
        >
          <div className="max-w-2xl">
            <p className="text-[10px] tracking-[0.2em] font-bold text-[#8C1515] uppercase mb-2">Review & Approve</p>
            <h3 className="font-serif text-xl text-[#2E2D29] mb-1">Answer Inbox</h3>
            <p className="text-sm text-[#544948] leading-relaxed">
              Review drafted answers (from colleagues or AI) waiting for your sign-off. You hold the keys: nothing reaches the public without your approval.
            </p>
          </div>
          <div className="mt-4 md:mt-0 md:pl-6 flex items-center md:flex-col md:items-end gap-3 md:gap-1">
            {inboxCount > 0 ? (
              <span className="bg-[#8C1515] text-white text-xs font-bold px-3 py-1 uppercase tracking-wider">{inboxCount} to review</span>
            ) : (
              <span className="text-[#544948] text-xs font-bold px-3 py-1 uppercase tracking-wider bg-gray-200">Up to date</span>
            )}
            <span className="text-[#8C1515] font-medium text-sm group-hover:underline">Open Inbox &rarr;</span>
          </div>
        </Link>
        )}

        {/* Knowledge Base */}
        <Link 
          href={`/pillars/${slug}/library`}
          className="group flex flex-col md:flex-row md:items-center justify-between border-r border-b border-gray-200 bg-white p-6 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-[#8C1515] focus:ring-inset"
          data-testid="link-process-library"
        >
          <div className="max-w-2xl">
            <p className="text-[10px] tracking-[0.2em] font-bold text-[#8C1515] uppercase mb-2">Build your knowledge</p>
            <h3 className="font-serif text-xl text-[#2E2D29] mb-1">Source Library</h3>
            <p className="text-sm text-[#544948] leading-relaxed">
              Upload papers and articles to {pillarName}, then assess each one for rigor and reproducibility. Collaborate with colleagues and postdocs you invite.
            </p>
          </div>
          <div className="mt-4 md:mt-0 md:pl-6 flex items-center md:flex-col md:items-end gap-3 md:gap-1">
             <span className="text-[#8C1515] font-medium text-sm group-hover:underline">Open Workspace &rarr;</span>
          </div>
        </Link>

        {/* Answer Questions */}
        {!aslm && uncoveredCount > 0 && (
          <Link 
            href={`/answer?slug=${slug}`}
            className="group flex flex-col md:flex-row md:items-center justify-between border-r border-b border-gray-200 bg-white p-6 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-[#8C1515] focus:ring-inset"
            data-testid="link-process-answer"
          >
            <div className="max-w-2xl">
              <p className="text-[10px] tracking-[0.2em] font-bold text-[#8C1515] uppercase mb-2">Serve your readers</p>
              <h3 className="font-serif text-xl text-[#2E2D29] mb-1">Unanswered Questions</h3>
              <p className="text-sm text-[#544948] leading-relaxed">
                See real questions asked by readers that your agent couldn't answer yet — then draft and approve answers in your voice.
              </p>
            </div>
            <div className="mt-4 md:mt-0 md:pl-6 flex items-center md:flex-col md:items-end gap-3 md:gap-1">
              <span className="bg-[#8C1515] text-white text-xs font-bold px-3 py-1 uppercase tracking-wider">{uncoveredCount} questions</span>
              <span className="text-[#8C1515] font-medium text-sm group-hover:underline">Answer &rarr;</span>
            </div>
          </Link>
        )}

        {/* Distribution */}
        {!aslm && (
          <Link 
            href={isLM ? "/newsletter" : "/my-newsletter"}
            className="group flex flex-col md:flex-row md:items-center justify-between border-r border-b border-gray-200 bg-white p-6 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-[#8C1515] focus:ring-inset"
            data-testid="link-process-distribution"
          >
            <div className="max-w-2xl">
              <p className="text-[10px] tracking-[0.2em] font-bold text-[#8C1515] uppercase mb-2">Share your work</p>
              <h3 className="font-serif text-xl text-[#2E2D29] mb-1">Distribution & Newsletter</h3>
              <p className="text-sm text-[#544948] leading-relaxed">
                {distributionDesc}
              </p>
            </div>
            <div className="mt-4 md:mt-0 md:pl-6 flex items-center md:flex-col md:items-end gap-3 md:gap-1">
               <span className="text-[#8C1515] font-medium text-sm group-hover:underline">Open distribution &rarr;</span>
            </div>
          </Link>
        )}
      </div>
    </section>
  );
}"""
    content = steward_processes_regex.sub(replacement_steward, content)
    
    # Update Welcome text
    # Note: WELCOME_CHAPTERS were heavily modified. I'll replace the text in WELCOME_CHAPTERS completely
    welcome_chapters_regex = re.compile(r'const WELCOME_CHAPTERS: WelcomeChapter\[\] = \[.*?\];', re.DOTALL)
    replacement_welcome_chapters = """const WELCOME_CHAPTERS: WelcomeChapter[] = [
  {
    eyebrow: "Stanford Lifestyle Medicine Program",
    title: "Lifestyle medicine begins with what we know.",
    body: "The Stanford Lifestyle Medicine Program brings together research, clinical experience, and practical wisdom to help people live healthier lives. Your faculty expertise is part of that shared foundation.",
    illustration: "chapter-gathering",
    image: "welcome-gathering",
    takeaway:
      "The program connects rigorous evidence with the people looking for a healthier way forward.",
  },
  {
    eyebrow: "Why it matters",
    title: "Health questions deserve a thoughtful answer.",
    body: "People look for guidance about sleep, movement, nutrition, stress, connection, and purpose every day. The Stanford Lifestyle Medicine Program makes it easier for people to find clear, evidence-based guidance from the faculty who understand it.",
    illustration: "chapter-machine",
    image: "welcome-machine",
    takeaway:
      "The goal: make trustworthy lifestyle medicine easier to understand and use.",
  },
  {
    eyebrow: "Your work, reaching further",
    title: "Your expertise can help people turn evidence into action.",
    body: "Your research already serves students, clinicians, and colleagues. Through the Stanford Lifestyle Medicine Program, it can also reach the person searching for one practical, trustworthy next step.",
    illustration: "chapter-reach",
    image: "welcome-reach",
    takeaway:
      "Your work can move from the academic conversation into everyday decisions.",
  },
  {
    eyebrow: "Trust and stewardship",
    title: "Careful review keeps health guidance worthy of trust.",
    body: "Lifestyle medicine asks us to connect science with the realities of people's lives. Faculty review helps the Stanford Lifestyle Medicine Program keep its guidance accurate, useful, and grounded in the evidence.",
    illustration: "chapter-trust",
    image: "welcome-trust",
    takeaway: "Faculty judgment sets the standard for what the program shares.",
  },
  {
    eyebrow: "Your role",
    title: "You help shape what the program shares.",
    body: "You decide which research and interpretations are ready to share, and you can update them as the evidence develops. Your name and faculty perspective remain connected to the work you contribute.",
    illustration: "chapter-keys",
    image: "welcome-keys",
    takeaway:
      "Your contribution stays connected to your expertise, your review, and your voice.",
  },
];"""
    content = welcome_chapters_regex.sub(replacement_welcome_chapters, content)

    welcome_how_it_works_regex = re.compile(r'const WELCOME_HOW_IT_WORKS: Array<\{.*?\}> = \[.*?\];', re.DOTALL)
    replacement_welcome_how = """const WELCOME_HOW_IT_WORKS: Array<{
  step: string;
  title: string;
  body: string;
  illustration: string;
}> = [
  {
    step: "01",
    title: "You add your research",
    body: "Upload papers, sources, and notes to your Faculty workspace so your work is organized in one place.",
    illustration: "move-add",
  },
  {
    step: "02",
    title: "Your sources become ready to share",
    body: "The program organizes what you add so faculty-reviewed guidance can be clear, grounded, and useful to readers.",
    illustration: "move-ready",
  },
  {
    step: "03",
    title: "You interpret the science",
    body: "Review what is covered, identify important gaps, and add interpretations grounded in your sources and expertise.",
    illustration: "move-interpret",
  },
  {
    step: "04",
    title: "You contribute and are credited",
    body: "Share pieces with the Stanford Lifestyle Medicine Program and keep track of the work you contribute.",
    illustration: "move-credit",
  },
];"""
    content = welcome_how_it_works_regex.sub(replacement_welcome_how, content)
    
    # Remove Palonur mentions from dashboard
    content = content.replace(
        'Contact Palonur',
        'Contact the Stanford team'
    )
    content = content.replace(
        'Ask Palonur',
        'Ask Stanford'
    )
    content = content.replace(
        'mailto:karan@palonur.com',
        'mailto:karan@stanford.edu'
    )
    
    # Emojis shouldn't be here, but let's replace the one from dashboard
    content = content.replace(
        '<span className="text-3xl">📭</span>',
        '<IconInbox />'
    )
    # the fun greetings
    content = content.replace('(n) => `Oh wow, ${n} is here!`,', '(n) => `Welcome, ${n}.`,')
    content = content.replace('(n) => `Welcome, ${n} — it\'s so nice to see you.`,', '(n) => `Good to see you, ${n}.`,')
    content = content.replace('(n) => `${n}! The day just got better.`,', '(n) => `${n}, your workspace is ready.`,')
    content = content.replace('(n) => `Look who it is — ${n}!`,', '(n) => `Welcome back, ${n}.`,')
    content = content.replace('(n) => `Hey ${n}, so good to have you back.`,', '(n) => `Hello ${n}.`,')
    content = content.replace('(n) => `${n} in the building. Let\'s make something great.`,', '(n) => `Welcome to the faculty portal, ${n}.`,')

    with open(filepath, "w") as f:
        f.write(content)

patch_file("src/App.tsx")
